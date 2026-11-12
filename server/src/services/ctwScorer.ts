const norm = (s: string) => s.normalize("NFKC").trim();

/**
 * Scores one Complete the Words gap: correct only when the typed letters equal the gap's deleted
 * letters exactly, case included, after NFKC normalisation and trimming.
 */
export function scoreCtwGap(completion: string, typed: string): boolean {
  return norm(typed) === norm(completion);
}
