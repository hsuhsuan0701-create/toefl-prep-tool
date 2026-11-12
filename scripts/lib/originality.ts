/**
 * How much of one text's wording reappears in another: the measure behind
 * scripts/check-rubric-originality.ts, which compares a shipped rubric or sample file with the
 * official ETS copy a user installed beside it.
 *
 * Both texts are reduced to a stream of lowercase words first. URLs and inline code spans are
 * dropped (a citation link, a file path or a schema name is a reference, not prose), and so are
 * bare numbers (a page number, a timing or a score is a fact both texts must state the same way).
 * Curly quotes and apostrophes are straightened, and markdown punctuation disappears because only
 * letters, digits and in-word apostrophes form words. What is left is what a reader would recognise
 * as the same sentence.
 */

const URL = /<?https?:\/\/[^\s>)]+>?/g;
const CODE_SPAN = /`[^`\n]*`/g;
const WORD = /[a-z0-9]+(?:'[a-z]+)*/g;

export function words(text: string): string[] {
  return (
    text
      .replace(URL, " ")
      .replace(CODE_SPAN, " ")
      .replace(/[‘’ʼ]/g, "'")
      .toLowerCase()
      .match(WORD) ?? []
  ).filter((word) => /[a-z]/.test(word));
}

/** The longest run of consecutive words that appears, in the same order, in both texts. */
export function longestSharedRun(shipped: readonly string[], official: readonly string[]): string[] {
  // Longest common substring over words, one row of the table at a time.
  let previous = new Uint32Array(official.length + 1);
  let current = new Uint32Array(official.length + 1);
  let bestLength = 0;
  let bestEnd = 0;
  for (let i = 1; i <= shipped.length; i += 1) {
    for (let j = 1; j <= official.length; j += 1) {
      current[j] = shipped[i - 1] === official[j - 1] ? previous[j - 1] + 1 : 0;
      if (current[j] > bestLength) {
        bestLength = current[j];
        bestEnd = i;
      }
    }
    [previous, current] = [current, previous];
    current.fill(0);
  }
  return shipped.slice(bestEnd - bestLength, bestEnd);
}

export function nGrams(tokens: readonly string[], n: number): string[] {
  const grams: string[] = [];
  for (let i = 0; i + n <= tokens.length; i += 1) grams.push(tokens.slice(i, i + n).join(" "));
  return grams;
}

/**
 * The share of the shipped text's word n-grams (counted with repeats, by position) that occur
 * anywhere in the official text. 0 when the shipped text is shorter than n words.
 */
export function sharedNGramShare(shipped: readonly string[], official: readonly string[], n: number): number {
  const shippedGrams = nGrams(shipped, n);
  if (shippedGrams.length === 0) return 0;
  const officialGrams = new Set(nGrams(official, n));
  return shippedGrams.filter((gram) => officialGrams.has(gram)).length / shippedGrams.length;
}

/**
 * The limits a shipped file must stay under to count as a rewrite rather than a copy.
 *
 * MAX_SHARED_RUN: the longest stretch of identical consecutive words allowed. The words both
 * versions must share are short: dimension names ("communicative goal & social conventions" is
 * five words), the task's own name, a document title ("updated toefl ibt test overview" is five),
 * and function-word joins between them. A stretch of nine or more identical words is a clause, and a
 * shared clause is a copied sentence.
 *
 * MAX_SIX_GRAM_SHARE: the share of the shipped file's six-word sequences that also occur in the
 * official one. Two independent descriptions of the same criteria share a few six-word sequences
 * where a term of art meets a common phrase; text that follows the original sentence by sentence,
 * swapping some words for synonyms, keeps far more, because every unchanged stretch between the
 * swaps still matches. 3% leaves room for the first and none for the second.
 */
export const MAX_SHARED_RUN = 8;
export const MAX_SIX_GRAM_SHARE = 0.03;

export type OriginalityResult = {
  sharedRun: string[];
  sixGramShare: number;
  passes: boolean;
};

export function compareOriginality(shippedText: string, officialText: string): OriginalityResult {
  const shipped = words(shippedText);
  const official = words(officialText);
  const sharedRun = longestSharedRun(shipped, official);
  const sixGramShare = sharedNGramShare(shipped, official, 6);
  return {
    sharedRun,
    sixGramShare,
    passes: sharedRun.length <= MAX_SHARED_RUN && sixGramShare <= MAX_SIX_GRAM_SHARE,
  };
}
