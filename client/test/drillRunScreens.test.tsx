import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServedReadingStimulus } from "@toefl-prep/shared";
import StimulusQueueRun, { StimulusQueueResults } from "../src/pages/drill/StimulusQueueRun";
import { afterFeedbackHold } from "./feedbackHold";

// The Reading and Listening Drill's run body as the User meets it: immediate feedback that says
// right or wrong in words and a glyph (and "No Response" when nothing was chosen), focus that moves
// to the next Stimulus, and a results screen that breaks the tally down by Task Type.
// StimulusQueueRun.test.tsx owns the queue's order and its requests; this file owns what the screen
// says. Leaving a Drill is the Drill shell's, asserted in drillLeaveGuard.test.tsx.

vi.mock("../src/lib/api", () => ({
  scoreDeterministicTask: vi.fn(),
  getAttempt: vi.fn(),
  DeterministicAlreadyScoredError: class DeterministicAlreadyScoredError extends Error {},
}));

const dailyLife = {
  id: "dl-1",
  taskType: "daily_life",
  genre: "notice",
  text: "The library closes at six.",
  questions: [
    { id: "dl-1-q1", stem: "When does the library close?", options: [{ id: "o1", text: "At five" }, { id: "o2", text: "At six" }] },
    { id: "dl-1-q2", stem: "Who wrote the notice?", options: [{ id: "o1", text: "A student" }, { id: "o2", text: "The librarian" }] },
  ],
} as unknown as ServedReadingStimulus;

const academic = {
  id: "ap-1",
  taskType: "academic_passage",
  title: "Salmon",
  discipline: "biology",
  text: "Salmon spawn in gravel.",
  questions: [{ id: "ap-1-q1", stem: "Where do salmon spawn?", options: [{ id: "o1", text: "In gravel" }, { id: "o2", text: "In sand" }] }],
} as unknown as ServedReadingStimulus;

afterEach(() => {
  vi.clearAllMocks();
});

describe("Drill feedback", () => {
  it("says Correct, Incorrect or No Response for each Item, marks the key, and shows the Explanation", async () => {
    const api = await import("../src/lib/api");
    (api.scoreDeterministicTask as ReturnType<typeof vi.fn>).mockResolvedValue({
      items: [
        { itemId: "dl-1-q1", correct: false, key: "o2", explanationZh: "通知寫的是六點。" },
        { itemId: "dl-1-q2", correct: false, key: "o2", explanationZh: "署名是館員。" },
      ],
    });
    const user = userEvent.setup();
    render(<StimulusQueueRun stimuli={[dailyLife]} attemptId="att-1" onComplete={vi.fn()} />);

    await user.click(screen.getByRole("radio", { name: "At five" }));
    await user.click(screen.getByRole("button", { name: "Check Responses" }));

    const first = await screen.findByRole("group", { name: "When does the library close?" });
    expect(within(first).getByText("Incorrect")).toBeInTheDocument();
    expect(within(first).getByText("Your Response")).toBeInTheDocument();
    expect(within(first).getByText("Correct answer")).toBeInTheDocument();
    const explanation = within(first).getByText("通知寫的是六點。");
    expect(explanation.closest("[lang]")).toHaveAttribute("lang", "zh-Hant");

    // Nothing was chosen for the second question: that is said, and the key is still shown.
    const second = screen.getByRole("group", { name: "Who wrote the notice?" });
    expect(within(second).getByText("No Response")).toBeInTheDocument();
    expect(within(second).getByText("Correct answer")).toBeInTheDocument();
    expect(within(second).queryByText("Your Response")).toBeNull();

    // And the tally is said once, for a User not looking at the marks.
    expect(screen.getByRole("status")).toHaveTextContent("0 of 2 correct.");
  });

  it("moves focus to the next Stimulus's first question", async () => {
    const api = await import("../src/lib/api");
    (api.scoreDeterministicTask as ReturnType<typeof vi.fn>).mockImplementation(async (_id: string, req: { items: { itemId: string }[] }) => ({
      items: req.items.map((i) => ({ itemId: i.itemId, correct: true, key: "o1" })),
    }));
    const user = userEvent.setup();
    render(<StimulusQueueRun stimuli={[dailyLife, academic]} attemptId="att-1" onComplete={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Check Responses" }));
    // Feedback arriving keeps focus on the one button, now "Next Stimulus".
    const next = await screen.findByRole("button", { name: "Next Stimulus" });
    expect(next).toHaveFocus();
    await afterFeedbackHold();
    await user.click(next);

    const question = await screen.findByRole("group", { name: "Where do salmon spawn?" });
    expect(question.contains(document.activeElement)).toBe(true);
  });
});

describe("the Drill's results", () => {
  it("gives the tally overall and by Task Type, and offers the Attempt's report", async () => {
    const onReview = vi.fn();
    const onFinish = vi.fn();
    const user = userEvent.setup();
    render(
      <StimulusQueueResults
        stimuli={[dailyLife, academic]}
        results={[
          { itemId: "dl-1-q1", correct: true },
          { itemId: "dl-1-q2", correct: false },
          { itemId: "ap-1-q1", correct: true },
        ]}
        isRepeat={false}
        onFinish={onFinish}
        completion={{ status: "idle", error: null, retry: () => {} }}
        onReview={onReview}
      />,
    );

    expect(screen.getByRole("heading", { name: "Results" })).toBeInTheDocument();
    expect(screen.getByText(/Items correct · 66%/)).toBeInTheDocument();
    expect(screen.getByText("Read in Daily Life").closest("li")).toHaveTextContent("1 of 2 correct");
    expect(screen.getByText("Read an Academic Passage").closest("li")).toHaveTextContent("1 of 1 correct");

    await user.click(screen.getByRole("button", { name: "Review every Item" }));
    expect(onReview).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Back to Practice" }));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
