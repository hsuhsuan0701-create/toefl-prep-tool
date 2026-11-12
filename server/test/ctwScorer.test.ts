import { describe, expect, it } from "vitest";
import { scoreCtwGap } from "../src/services/ctwScorer.js";

// A Complete the Words gap is scored by exact match on the letters typed: NFKC normalisation and
// surrounding whitespace are forgiven, case is not.
describe("scoreCtwGap", () => {
  it("matches exactly after NFKC + trim", () => {
    expect(scoreCtwGap("ght", " ght ")).toBe(true);
    expect(scoreCtwGap("ght", "ght")).toBe(true);
    expect(scoreCtwGap("ght", "ｇｈｔ")).toBe(true); // fullwidth normalizes via NFKC
  });
  it("is case-sensitive — no mercy, the ETS rule", () => {
    expect(scoreCtwGap("ght", "Ght")).toBe(false);
  });
  it("rejects near-misses and empties", () => {
    expect(scoreCtwGap("ght", "gth")).toBe(false);
    expect(scoreCtwGap("ght", "")).toBe(false);
  });
});
