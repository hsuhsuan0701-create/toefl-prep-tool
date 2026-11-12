import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import WeaknessPanel from "../src/components/WeaknessPanel";
import type { SkillAccuracy } from "../src/pages/weaknessCategories";

// computeSkillAccuracy's own suite checks the aggregation; this checks the other half, that the
// Reading & Listening pane renders any skill value as readable English, including the
// academic-passage categories (figurative_language, grammatical_complexity, rhetorical_structure).
// `skillLabel` is a plain formatter with no lookup table on purpose (see its own comment), so what
// has to hold is that the formatter's output is a sensible label, not that some table was updated.
const NO_JUDGE_AGREEMENT = { avgDelta: null, sampleSize: 0 };

function accuracy(skill: string, correct: number, total: number): SkillAccuracy {
  return { section: "reading", skill, correct, total, accuracy: correct / total };
}

describe("WeaknessPanel — Reading & Listening skill accuracy", () => {
  it("renders the academic-passage skill categories as readable labels, underscores and all", () => {
    render(
      <WeaknessPanel
        weaknesses={[]}
        judgeAgreement={NO_JUDGE_AGREEMENT}
        skillAccuracy={[
          accuracy("figurative_language", 1, 5),
          accuracy("grammatical_complexity", 2, 5),
          accuracy("rhetorical_structure", 5, 5),
        ]}
      />,
    );
    expect(screen.getByText("Reading · Figurative language")).toBeTruthy();
    expect(screen.getByText("Reading · Grammatical complexity")).toBeTruthy();
    expect(screen.getByText("Reading · Rhetorical structure")).toBeTruthy();
    // No raw enum spelling leaks through as a label.
    expect(screen.queryByText(/figurative_language/u)).toBeNull();
  });

  it("still renders the other skill categories, and the empty state", () => {
    const { rerender } = render(
      <WeaknessPanel
        weaknesses={[]}
        judgeAgreement={NO_JUDGE_AGREEMENT}
        skillAccuracy={[accuracy("main_idea", 3, 5)]}
      />,
    );
    expect(screen.getByText("Reading · Main idea")).toBeTruthy();

    rerender(
      <WeaknessPanel weaknesses={[]} judgeAgreement={NO_JUDGE_AGREEMENT} skillAccuracy={[]} />,
    );
    expect(screen.getByText(/Not enough scored Items yet/u)).toBeTruthy();
  });
});
