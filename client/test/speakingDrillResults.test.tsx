import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SpeakingResultSlot from "../src/pages/speakingDrill/SpeakingResultSlot";
import type { SpeakingScoreResult, SpeakingSlotSpec } from "../src/pages/speakingDrill/speakingDrillModel";

// A Speaking Drill's results read like Attempt review: the Listen and Repeat scene once for the
// Task, and each Item one card with its Score Report in it, not a card laid inside a card.

const result: SpeakingScoreResult = {
  taskType: "listen_repeat",
  judgesFailed: [],
  judges: [],
  items: ["lr-1", "lr-2"].map((itemId, i) => ({ itemId, target: `Target sentence ${i + 1}.` })),
  report: {
    taskType: "listen_repeat",
    items: ["lr-1", "lr-2"].map((itemId) => ({
      itemId,
      ownScore: 4,
      finalScore: 4,
      maxScore: 5,
      dimensions: [{ name: "Accuracy", note: "Every word is there." }],
      deductions: [],
      reconciliationNote: "Both Judges gave 4.",
      feedbackZh: "整體重複得很好。",
    })),
  },
} as unknown as SpeakingScoreResult;

vi.mock("../src/hooks/useScoringJob", () => ({
  useScoringJob: () => ({ status: "done", result, retry: () => {} }),
}));
vi.mock("../src/lib/api", () => ({ scoreTask: vi.fn() }));

const spec: SpeakingSlotSpec = {
  kind: "listen_repeat",
  items: [
    { id: "lr-1", audio: "lr-1.mp3", responseWindowSec: 8 },
    { id: "lr-2", audio: "lr-2.mp3", responseWindowSec: 8 },
  ],
  transcripts: { "lr-1": "Target sentence one.", "lr-2": "Target sentence two." },
  numberByItemId: { "lr-1": 1, "lr-2": 2 },
  scene: { file: "images/scenarios/spk-1.webp", focusRegionsByItemId: { "lr-1": undefined, "lr-2": undefined } },
};

describe("a Speaking Drill's results", () => {
  it("draws the scene once for the Task and each Item as one card", () => {
    const { container } = render(
      <MemoryRouter>
        <SpeakingResultSlot attemptId="att-1" spec={spec} compact={false} onStatusChange={() => {}} />
      </MemoryRouter>,
    );
    const task = screen.getByRole("region", { name: "Listen and Repeat" });
    expect(within(task).getAllByRole("img", { name: "Scene illustration", hidden: true })).toHaveLength(1);

    const cards = within(task).getAllByRole("article");
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(within(card).queryByRole("img", { name: "Scene illustration", hidden: true })).toBeNull();
      expect(within(card).getByText("Summary")).toBeInTheDocument();
    }
    const nested = [...container.querySelectorAll(".bg-sheet")].filter((el) => el.parentElement?.closest(".bg-sheet"));
    expect(nested).toEqual([]);
  });
});
