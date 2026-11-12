// The official ETS band to CEFR concordance (Technical Manual RR-25-12 Table 9; also recorded in
// docs/adr/0005-two-stage-adaptive-sets.md, "Band to CEFR level"): 6 = C2, 5-5.5 = C1, 4-4.5 = B2,
// 3-3.5 = B1, 2-2.5 = A2, 1-1.5 = A1. ETS publishes one mapping for all four sections and the
// overall band, so this takes a band and nothing else.
//
// Applied where a band renders rather than shipped as a `cefr` field beside every `band`, for two
// reasons. Not every band on screen comes from the server: Targets are numbers the client holds from
// GET /api/stats/settings, so the client needs this function anyway. And a `band`/`cefr` pair is a
// state a route can get wrong (band 4.5 labelled C2); deriving the level from the band on screen
// makes that unrepresentable.
//
// A level derived from an estimated band is itself an estimate (CONTEXT.md, "CEFR Level"), so it
// renders only through client/src/components/CefrLevelNote.tsx, inside the band's own estimate
// labeling and never as a standalone certification.
export type CefrLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";

// Rows in DESCENDING minBand order: cefrForBand takes the first row a band clears. A lookup rather
// than a formula, because the bands are a half-step grid.
const TABLE9: ReadonlyArray<{ minBand: number; level: CefrLevel }> = [
  { minBand: 6, level: "C2" },
  { minBand: 5, level: "C1" },
  { minBand: 4, level: "B2" },
  { minBand: 3, level: "B1" },
  { minBand: 2, level: "A2" },
  { minBand: 1, level: "A1" },
];

/**
 * The CEFR level a band maps to. Real bands sit on the half-step 1-6 grid (estimates are rounded to
 * the half band and clamped; Targets are validated to the same grid by routes/stats.ts), and all
 * eleven values are covered by TABLE9.
 *
 * Anything off the grid is still answered, monotonically and without throwing, so a display path
 * has no second failure mode to guard: above 6 reads C2, and anything below 1, NaN included, reads
 * A1. A slightly wrong label is better than a blank page for an odd persisted value.
 */
export function cefrForBand(band: number): CefrLevel {
  return (TABLE9.find((row) => band >= row.minBand) ?? TABLE9[TABLE9.length - 1]).level;
}
