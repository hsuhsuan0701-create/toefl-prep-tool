// How two Build a Sentence tiles are compared, everywhere: trimmed, inner whitespace collapsed,
// case-sensitive. The serve-time tile scramble (tileScramble.ts) and the generation gates reuse it,
// so no gate can disagree with the scorer about when two tiles are the same. Case-sensitive because
// every tile is lowercase, and an accepted answer must reproduce the tiles verbatim (ADR 0009).
export const normalizeTile = (t: string) => t.trim().replace(/\s+/g, " ");

/**
 * Scores one Build a Sentence Response: correct when the tile order equals one of the Item's
 * accepted answers tile for tile, under normalizeTile. Returns the answer it matched.
 */
export function scoreSentence(tileOrder: string[], answers: string[][]): { correct: boolean; matchedAnswer: string[] | null } {
  const got = tileOrder.map(normalizeTile);
  for (const answer of answers) {
    const want = answer.map(normalizeTile);
    if (want.length === got.length && want.every((w, i) => w === got[i])) {
      return { correct: true, matchedAnswer: answer };
    }
  }
  return { correct: false, matchedAnswer: null };
}

/**
 * True when `order` uses no tile more often than `tiles` offers it, under normalizeTile. Generation
 * uses it to check that an accepted answer can be built from the Item's own tiles.
 */
export function isTileSubset(order: string[], tiles: string[]): boolean {
  const pool = new Map<string, number>();
  for (const t of tiles.map(normalizeTile)) pool.set(t, (pool.get(t) ?? 0) + 1);
  for (const t of order.map(normalizeTile)) {
    const n = pool.get(t) ?? 0;
    if (n === 0) return false;
    pool.set(t, n - 1);
  }
  return true;
}
