import type { PublicCtwSegment } from "@toefl-prep/shared";

// Derives a Complete the Words (C-test) passage's gaps from its paragraph in code, so the answer
// key is correct by construction. Pure: no DB, no model call.
export type CtwSegment = PublicCtwSegment;
export type DerivedGap = { id: string; prefix: string; completion: string; blankLength: number };

/** Thrown when a paragraph yields fewer than 10 gaps; `gapCount` is how many it did yield. */
export class CtwDerivationError extends Error {
  gapCount: number;
  constructor(gapCount: number) {
    super(`deriveCtwGaps: expected exactly 10 gaps, derived ${gapCount}`);
    this.name = "CtwDerivationError";
    this.gapCount = gapCount;
  }
}

const SENTENCE_ONE_BOUNDARY = /[.!?]\s+(?=[A-Z])/;
const TOKEN_RE = /[A-Za-z']+/g;
const REQUIRED_GAP_COUNT = 10;

/**
 * Applies the ETS C-test rule. The first sentence (up to the first `.!?` followed by whitespace and
 * a capital letter) stays intact. After it, tokens (maximal runs of `[A-Za-z']`, so a hyphen splits
 * a word in two) are counted continuously across sentences, and every second token is gapped until
 * 10 gaps exist: the first `floor(n/2)` characters stay as `prefix`, the last `ceil(n/2)` become
 * `completion`. A one-letter token on an even count is left whole, since prefix and completion each
 * need a character; the count still advances past it, so the next gap falls on the next
 * even-numbered token.
 *
 * @throws CtwDerivationError when the paragraph runs out of tokens before the tenth gap.
 */
export function deriveCtwGaps(
  passageId: string,
  paragraph: string
): { segments: CtwSegment[]; gaps: DerivedGap[] } {
  const boundary = SENTENCE_ONE_BOUNDARY.exec(paragraph);
  const splitIndex = boundary ? boundary.index + boundary[0].length : paragraph.length;
  const remainder = paragraph.slice(splitIndex);

  const segments: CtwSegment[] = [];
  const gaps: DerivedGap[] = [];
  let textBuffer = paragraph.slice(0, splitIndex);
  let cursor = 0;
  let tokenCount = 0;

  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(remainder)) !== null) {
    const token = match[0];
    const start = match.index;
    // Punctuation, digits and whitespace between tokens join the pending text run uncounted.
    textBuffer += remainder.slice(cursor, start);
    cursor = start + token.length;

    tokenCount += 1;
    const shouldGap = gaps.length < REQUIRED_GAP_COUNT && tokenCount % 2 === 0 && token.length > 1;
    if (shouldGap) {
      const keep = Math.floor(token.length / 2);
      const gapId = `${passageId}-g${gaps.length + 1}`;
      segments.push({ type: "text", text: textBuffer });
      textBuffer = "";
      segments.push({ type: "gap", gapId });
      gaps.push({
        id: gapId,
        prefix: token.slice(0, keep),
        completion: token.slice(keep),
        blankLength: token.length - keep,
      });
    } else {
      textBuffer += token;
    }
  }
  textBuffer += remainder.slice(cursor);
  segments.push({ type: "text", text: textBuffer });

  if (gaps.length !== REQUIRED_GAP_COUNT) {
    throw new CtwDerivationError(gaps.length);
  }

  return { segments, gaps };
}
