/**
 * The Build a Sentence Frame: the partial sentence an Item's tiles complete. ETS's 2026 Test
 * Blueprint and Specifications describes the task as "completing partial sentences using provided
 * vocabulary": in its one published sample Item the Frame supplies the opening article and the
 * closing adjective, six blanks take six of the seven tiles, and the seventh is a distractor.
 *
 * This module owns how a blank is written and the parse that turns a Frame into segments. It lives
 * in `shared/` because the client renders from these segments and the server validates generated
 * Sets from them. It knows nothing about tiles or answers: the blank and tile arithmetic is a
 * Set-conformance rule.
 *
 * How much a Frame fixes is not this module's business either. A Frame may start with a blank, or be
 * nothing but blanks and the final punctuation (docs/adr/0009); both parse, with no empty literal
 * ahead of a leading blank, which server/test/sentenceFrame.test.ts pins.
 */

/**
 * How a blank is written in a frame: three underscores. Longer runs mean the same single blank —
 * ETS's own overview draws each blank as six underscores, and a transcription that copies that
 * rendering must not silently become a frame with fewer blanks.
 */
export const FRAME_BLANK_MARKER = "___";

/** The shortest underscore run that reads as a blank. A shorter run is a typo, not literal text. */
const MIN_BLANK_UNDERSCORES = FRAME_BLANK_MARKER.length;

/**
 * One piece of a parsed frame, in document order.
 *
 * `index` is the blank's ordinal among the blanks, counting from 0 — a render-local identity (which
 * box is this?), never something to persist. Answer keys are tile TEXT, never blank indices: the
 * served `tiles` array is permuted per request, so an index-keyed answer would decay into a
 * different answer on every serve.
 *
 * Shaped like Reading's `PublicCtwSegment` on purpose — both are "a document with holes punched in
 * it", and a reader who knows one already knows the other.
 */
export type SentenceFrameSegment =
  | { type: "text"; text: string }
  | { type: "blank"; index: number };

/** A frame that cannot be rendered as blanks. Thrown by {@link parseSentenceFrame}. */
export class SentenceFrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SentenceFrameError";
  }
}

/**
 * Splits a frame into its literal runs and its blanks, in order.
 *
 * Literal text survives verbatim, whitespace included, so concatenating the segments (with each
 * blank rendered back as a marker) reproduces the input — a renderer never has to guess whether a
 * space belonged to the frame. Empty literals are not emitted, so a frame that opens or closes on a
 * blank yields no leading or trailing blank-string segment.
 *
 * Throws {@link SentenceFrameError} when the frame has no blanks at all, is blank itself, or writes
 * a blank as one or two underscores. That last case is the one judgement call: a short run is
 * almost always a mistyped blank, and reading it as literal text would produce a frame with one
 * blank fewer than its author meant — a defect that surfaces far from the typo, as failing
 * blank/tile arithmetic on an otherwise plausible Item.
 *
 * Error messages quote no part of the frame. They travel into zod issues and logs, and a frame is
 * Item content: the same rule setStore.ts's `safeSetErrorDescriptor` follows.
 */
export function parseSentenceFrame(frame: string): SentenceFrameSegment[] {
  if (frame.trim() === "") {
    throw new SentenceFrameError("frame is empty");
  }

  const segments: SentenceFrameSegment[] = [];
  let cursor = 0;
  let blanks = 0;

  for (const match of frame.matchAll(/_+/g)) {
    const run = match[0];
    const at = match.index;
    if (run.length < MIN_BLANK_UNDERSCORES) {
      throw new SentenceFrameError(
        `frame has a run of ${run.length} underscore(s) at character ${at}; ` +
          `write every blank with at least ${MIN_BLANK_UNDERSCORES} underscores ("${FRAME_BLANK_MARKER}")`,
      );
    }
    const literal = frame.slice(cursor, at);
    if (literal !== "") segments.push({ type: "text", text: literal });
    segments.push({ type: "blank", index: blanks });
    blanks += 1;
    cursor = at + run.length;
  }

  if (blanks === 0) {
    throw new SentenceFrameError(
      `frame has no blanks; mark each one with "${FRAME_BLANK_MARKER}"`,
    );
  }

  const tail = frame.slice(cursor);
  if (tail !== "") segments.push({ type: "text", text: tail });
  return segments;
}
