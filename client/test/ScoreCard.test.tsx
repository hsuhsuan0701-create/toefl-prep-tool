import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import ScoreCard, { type EssayScoreResult } from "../src/components/ScoreCard";

// The red pen's note beside a Deduction says why its quote is not marked, and only says the words
// are not in the Response when they are not.

function result(deductions: Array<{ quote: string }>): EssayScoreResult {
  return {
    taskType: "listen_repeat",
    report: {
      taskType: "listen_repeat",
      items: [
        {
          itemId: "lr-5",
          ownScore: 3,
          finalScore: 3,
          maxScore: 5,
          dimensions: [],
          deductions: deductions.map((d) => ({ ...d, issue: "Dropped a word.", fix: "—", category: "grammar" })),
          reconciliationNote: "",
          feedbackZh: "",
        },
      ],
    },
    judges: [],
    judgesFailed: [],
  };
}

const deductionRow = (n: number) => screen.getByLabelText(`Deduction ${n}`, { selector: "ol span" }).closest("li")!;

describe("ScoreCard", () => {
  it("does not call a quote that overlaps another Deduction's mark missing from the Response", () => {
    render(<ScoreCard result={result([{ quote: "point to" }, { quote: "to shelf." }])} userText="When a student asks, point to shelf." />);

    expect(screen.queryByText(/not in your Response/)).toBeNull();
    expect(within(deductionRow(2)).getByText("Not marked separately: these words overlap the mark of Deduction 1")).toBeInTheDocument();
    expect(within(deductionRow(1)).queryByText(/Not marked/)).toBeNull();
  });

  it("still says a quote that is absent from the Response is not in it", () => {
    render(<ScoreCard result={result([{ quote: "point to" }, { quote: "the reference desk" }])} userText="When a student asks, point to shelf." />);

    expect(within(deductionRow(2)).getByText("Not marked: these words are not in your Response")).toBeInTheDocument();
    expect(screen.queryByText(/overlap the mark/)).toBeNull();
  });
});
