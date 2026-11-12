import { describe, expect, it } from "vitest";
import { cefrForBand, type CefrLevel } from "@toefl-prep/shared";

// The band -> CEFR mapping exists once (shared/src/cefr.ts) and every band-bearing surface derives
// its level from it, so this suite is the only place the ETS table is pinned. It lives beside
// bandEstimator.test.ts rather than in the client suite because it is band math, not rendering; the
// client suite covers the display side (client/test/BandCard.test.tsx, for one).
//
// Bands exist only on the half-step 1-6 grid, so every range and edge can be checked: all eleven
// bands are asserted below, both as a table and range by range.

// ETS Technical Manual RR-25-12 Table 9, also recorded in docs/adr/0005-two-stage-adaptive-sets.md,
// "Band to CEFR level". Written out as a literal band -> level list, not as thresholds, so an edit to
// cefr.ts's own descending-threshold table cannot be confirmed by a test that shares its shape.
const TABLE9: ReadonlyArray<[number, CefrLevel]> = [
  [1, "A1"],
  [1.5, "A1"],
  [2, "A2"],
  [2.5, "A2"],
  [3, "B1"],
  [3.5, "B1"],
  [4, "B2"],
  [4.5, "B2"],
  [5, "C1"],
  [5.5, "C1"],
  [6, "C2"],
];

describe("cefrForBand (ETS Table 9)", () => {
  it("maps every band on the 1-6 half-step grid to its published CEFR level", () => {
    expect(TABLE9.map(([band]) => cefrForBand(band))).toEqual(TABLE9.map(([, level]) => level));
  });

  // One case per range, naming both edges, so a failure says which range moved, which the
  // whole-table assertion above cannot.
  it.each([
    ["A1", 1, 1.5],
    ["A2", 2, 2.5],
    ["B1", 3, 3.5],
    ["B2", 4, 4.5],
    ["C1", 5, 5.5],
    // C2 is a single-band range: 6 is both its floor and the top of the scale.
    ["C2", 6, 6],
  ] as const)("%s spans bands %s through %s inclusive", (level, low, high) => {
    expect(cefrForBand(low)).toBe(level);
    expect(cefrForBand(high)).toBe(level);
  });

  it("keeps the six levels contiguous — every band advances to the next level or stays put", () => {
    const order: CefrLevel[] = ["A1", "A2", "B1", "B2", "C1", "C2"];
    const ranks = TABLE9.map(([band]) => order.indexOf(cefrForBand(band)));
    expect(ranks.every((rank, i) => i === 0 || rank === ranks[i - 1] || rank === ranks[i - 1] + 1)).toBe(true);
    expect(new Set(ranks).size).toBe(6);
  });

  // Off-grid inputs are not reachable from the estimator (clamped to 1-6) or from Targets
  // (validated against the same grid), but this function is called from render paths that must not
  // throw or blank on a corrupt persisted band (see its doc comment).
  it("clamps off-grid bands to the ends of the scale instead of throwing", () => {
    expect(cefrForBand(6.5)).toBe("C2");
    expect(cefrForBand(0.5)).toBe("A1");
    expect(cefrForBand(0)).toBe("A1");
    expect(cefrForBand(-1)).toBe("A1");
    expect(cefrForBand(Number.NaN)).toBe("A1");
  });

  // Not part of the published table, but a persisted band is read back as a plain number, so a value
  // between steps lands in the range it sits in rather than falling off the lookup.
  it("resolves between-grid values to the range they fall in", () => {
    expect(cefrForBand(4.75)).toBe("B2");
    expect(cefrForBand(5.25)).toBe("C1");
  });
});
