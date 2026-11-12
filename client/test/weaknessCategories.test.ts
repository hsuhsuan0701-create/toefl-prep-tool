import { describe, expect, it } from "vitest";
import { computeSkillAccuracy, type SkillItemResult } from "../src/pages/weaknessCategories";

// computeSkillAccuracy is the pure aggregation helper WeaknessPanel's Reading & Listening pane is
// built on. It buckets Item results by (section, skill): Reading's and Listening's skill categories
// partially share names ("detail" and "inference" appear in both ReadingSkillCategory and
// ListeningSkillCategory, in shared/src/schemas/), so bucketing by skill alone would silently merge
// two genuinely different weaknesses. It filters out any bucket with fewer than 5 samples (not
// statistically meaningful yet), and sorts the survivors by ascending accuracy (worst first).
//
// Each test below is built so its assertion fails if the guard it covers is missing.

function item(section: "reading" | "listening", skill: string, correct: boolean): SkillItemResult {
  return { section, skill, correct };
}

describe("computeSkillAccuracy", () => {
  it("buckets by (section, skill), computing correct/total/accuracy", () => {
    const items: SkillItemResult[] = [
      ...Array.from({ length: 3 }, () => item("reading", "detail", true)),
      ...Array.from({ length: 2 }, () => item("reading", "detail", false)),
    ];
    const result = computeSkillAccuracy(items);
    expect(result).toEqual([{ section: "reading", skill: "detail", correct: 3, total: 5, accuracy: 0.6 }]);
  });

  // "detail" appears in both ReadingSkillCategory and ListeningSkillCategory — a bucket keyed on
  // skill alone would merge these two into one (correct 6/10), hiding that Listening's "detail" is
  // actually a much bigger weakness (2/5 = 0.4) than Reading's (4/5 = 0.8).
  it("keeps a same-named skill from Reading and Listening in SEPARATE buckets", () => {
    const items: SkillItemResult[] = [
      ...Array.from({ length: 4 }, () => item("reading", "detail", true)),
      item("reading", "detail", false),
      ...Array.from({ length: 2 }, () => item("listening", "detail", true)),
      ...Array.from({ length: 3 }, () => item("listening", "detail", false)),
    ];
    const result = computeSkillAccuracy(items);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.section === "reading")).toEqual({ section: "reading", skill: "detail", correct: 4, total: 5, accuracy: 0.8 });
    expect(result.find((r) => r.section === "listening")).toEqual({
      section: "listening",
      skill: "detail",
      correct: 2,
      total: 5,
      accuracy: 0.4,
    });
  });

  it("filters out any (section, skill) bucket with fewer than 5 samples (min-N)", () => {
    const items: SkillItemResult[] = [
      // Only 4 samples — below the min-N-5 floor, must be excluded even though its accuracy (0)
      // would otherwise sort first (worst).
      ...Array.from({ length: 4 }, () => item("reading", "vocabulary", false)),
      // Exactly 5 samples — the floor itself must be included (>=5, not >5).
      ...Array.from({ length: 3 }, () => item("listening", "gist", true)),
      ...Array.from({ length: 2 }, () => item("listening", "gist", false)),
    ];
    const result = computeSkillAccuracy(items);
    expect(result).toEqual([{ section: "listening", skill: "gist", correct: 3, total: 5, accuracy: 0.6 }]);
  });

  it("sorts buckets by ASCENDING accuracy — the worst (lowest-accuracy) skill first", () => {
    // Deliberately constructed so the accuracy order does not match insertion/iteration order —
    // this is what actually exercises the sort rather than passing by coincidence.
    const items: SkillItemResult[] = [
      ...Array.from({ length: 5 }, () => item("reading", "main_idea", true)), // 1.0 — best, inserted first
      ...Array.from({ length: 1 }, () => item("reading", "purpose", true)),
      ...Array.from({ length: 4 }, () => item("reading", "purpose", false)), // 0.2 — worst
      ...Array.from({ length: 3 }, () => item("listening", "attitude", true)),
      ...Array.from({ length: 2 }, () => item("listening", "attitude", false)), // 0.6 — middle
    ];
    const result = computeSkillAccuracy(items);
    expect(result.map((r) => `${r.section}:${r.skill}`)).toEqual(["reading:purpose", "listening:attitude", "reading:main_idea"]);
    expect(result.map((r) => r.accuracy)).toEqual([0.2, 0.6, 1]);
  });

  it("breaks an accuracy tie by skill name ascending", () => {
    const items: SkillItemResult[] = [
      ...Array.from({ length: 3 }, () => item("reading", "vocabulary", true)),
      ...Array.from({ length: 2 }, () => item("reading", "vocabulary", false)),
      ...Array.from({ length: 3 }, () => item("reading", "inference", true)),
      ...Array.from({ length: 2 }, () => item("reading", "inference", false)),
    ];
    const result = computeSkillAccuracy(items);
    expect(result.map((r) => r.skill)).toEqual(["inference", "vocabulary"]);
  });

  it("returns an empty array for no items, and never divides by zero", () => {
    expect(computeSkillAccuracy([])).toEqual([]);
  });

  // `skill` is a plain string end to end: routes/stats.ts passes it through without an allowlist and
  // this helper buckets whatever arrives, so the three academic-passage categories
  // (figurative_language, grammatical_complexity, rhetorical_structure) need no code here to appear
  // in the pane. A hardcoded category list anywhere on the path would drop these buckets silently,
  // and the User would never learn which of these skills they are weak at.
  it("buckets the academic-passage skill categories like any other, with no allowlist to update", () => {
    const items: SkillItemResult[] = [
      ...Array.from({ length: 5 }, () => item("reading", "rhetorical_structure", true)),
      ...Array.from({ length: 2 }, () => item("reading", "grammatical_complexity", true)),
      ...Array.from({ length: 3 }, () => item("reading", "grammatical_complexity", false)),
      ...Array.from({ length: 1 }, () => item("reading", "figurative_language", true)),
      ...Array.from({ length: 4 }, () => item("reading", "figurative_language", false)),
    ];
    const result = computeSkillAccuracy(items);
    expect(result).toEqual([
      { section: "reading", skill: "figurative_language", correct: 1, total: 5, accuracy: 0.2 },
      { section: "reading", skill: "grammatical_complexity", correct: 2, total: 5, accuracy: 0.4 },
      { section: "reading", skill: "rhetorical_structure", correct: 5, total: 5, accuracy: 1 },
    ]);
  });
});
