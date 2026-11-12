// =================================================================================================
// Novelty's text metric: turning raw source text into comparable tokens, and the one score the
// Catalog compares two token sets by.
//
// Imports nothing and reads no file. Nothing here knows what a Set, a Plan or a Task Type is, so
// every score is reproducible with no bank and no model call.
// =================================================================================================

const STOP_WORDS = new Set([
  "a", "about", "an", "and", "are", "as", "at", "be", "because", "been", "but",
  "by", "can", "d", "do", "does", "for", "from", "great", "good", "had", "has",
  "have", "he", "her", "his", "i", "id", "if", "in", "into", "is", "it",
  "its", "like", "me", "more", "my", "next", "of", "ok", "on", "or", "our",
  "points", "she", "should", "speaking", "than", "thank", "that", "the",
  "their", "them", "there", "these", "they", "this", "to", "today", "us",
  "versus", "was", "we", "were", "what", "when", "which", "who", "why",
  "will", "with", "would", "you", "your",
  // Fixed task language and grammar terminology are not semantic novelty signals.
  "ask", "answer", "discussion", "email", "factual", "interview", "listen",
  "opinion", "question", "repeat", "reply", "sentence", "speaker", "speaks",
  "student", "students", "tile", "tiles", "word", "words", "clause",
  "relative", "grammar",
]);

/**
 * A crude English stemmer for one lowercase token: strips a plural or `-ing`/`-ed` ending (undoing a
 * doubled final consonant). Not idempotent — "buildings" becomes "building", and a second pass makes
 * that "build" — so it must run exactly once per raw token.
 */
export function suffixNormalize(token: string): string {
  let result = token;
  if (result.length >= 6 && result.endsWith("ies")) {
    return `${result.slice(0, -3)}y`;
  }
  if (result.length >= 6 && result.endsWith("ing")) {
    result = result.slice(0, -3);
    if (
      result.length >= 4 &&
      result.at(-1) === result.at(-2) &&
      !/[aeiou]/u.test(result.at(-1) ?? "")
    ) {
      result = result.slice(0, -1);
    }
    return result;
  }
  if (result.length >= 5 && result.endsWith("ed")) {
    result = result.slice(0, -2);
    if (
      result.length >= 4 &&
      result.at(-1) === result.at(-2) &&
      !/[aeiou]/u.test(result.at(-1) ?? "")
    ) {
      result = result.slice(0, -1);
    }
    return result;
  }
  if (
    result.length >= 5 &&
    result.endsWith("es") &&
    /(s|x|z|ch|sh)es$/u.test(result)
  ) {
    return result.slice(0, -2);
  }
  if (
    result.length >= 5 &&
    result.endsWith("s") &&
    !result.endsWith("ss")
  ) {
    return result.slice(0, -1);
  }
  return result;
}

/**
 * The lowercased letter-and-digit runs of raw text, with `&` read as "and". Uses toLowerCase, not
 * toLocaleLowerCase, so the Catalog does not depend on the host's default locale.
 */
export function rawTokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
}

/** Single-pass normalization of RAW source text. Never call this on an already-normalized string. */
export function normalizeNoveltyText(value: string): string {
  const normalized: string[] = [];
  for (const rawToken of rawTokens(value)) {
    const token = suffixNormalize(rawToken);
    if (!token || STOP_WORDS.has(rawToken) || STOP_WORDS.has(token)) continue;
    normalized.push(token);
  }
  return normalized.join(" ");
}

/** Unique content tokens of RAW source text. Never call this on an already-normalized string. */
export function contentTokens(value: string): string[] {
  return [...new Set(normalizeNoveltyText(value).split(" ").filter(Boolean))];
}

function setIntersectionSize(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  let size = 0;
  for (const value of left) {
    if (right.has(value)) size += 1;
  }
  return size;
}

/** How much of the smaller token set appears in the larger: 1 when one side is wholly inside the other. */
export function containmentScore(
  left: readonly string[],
  right: readonly string[],
): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const smaller = leftSet.size <= rightSet.size ? leftSet : rightSet;
  const larger = smaller === leftSet ? rightSet : leftSet;
  if (smaller.size === 0) return 0;
  return setIntersectionSize(smaller, larger) / smaller.size;
}
