import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./fakeTimers";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ServedReadingSet } from "@toefl-prep/shared";
import { findLeavePrompt, renderRoutes } from "./dataRouter";
import ReadingSimulation from "../src/pages/simulation/ReadingSimulation";

// The Reading Simulation's Module screen, as the User works it: one screen per Complete the Words
// passage and per question, Back and Next between them, a navigator that shows which Items have a
// Response by shape and in words, the Module clock in the header, and a submit that says how many
// Items would score 0 before it locks the Module. ReadingSimulation.test.tsx runs whole routed
// Attempts; this file pins the screen itself.

vi.mock("../src/lib/api", () => ({
  advanceFullTest: vi.fn(async () => ({})),
  listSets: vi.fn(async () => [{ id: "rd-screen-1", title: "Bicycles on Campus", attempted: false }]),
  listAttempts: vi.fn(async () => ({ attempts: [], total: 0 })),
  getSet: vi.fn(),
  createAttempt: vi.fn(async () => ({ attemptId: "att-1", isRepeat: false })),
  completeAttempt: vi.fn(async () => ({})),
  flagAttempt: vi.fn(async () => ({})),
  scoreDeterministicTask: vi.fn(async () => ({ items: [] })),
  routeAttempt: vi.fn(async () => ({ path: "lower" })),
  finishSpeakingCapture: vi.fn(async () => ({})),
  DeterministicAlreadyScoredError: class DeterministicAlreadyScoredError extends Error {},
}));

const set: ServedReadingSet = {
  id: "rd-screen-1",
  kind: "reading",
  source: "generated",
  createdAt: "2026-09-01T10:00:00.000Z",
  router: {
    timeLimitSec: 1200,
    ctwPassages: [
      {
        id: "ctw-1",
        taskType: "complete_words",
        topic: "t",
        segments: [
          { type: "text", text: "The " },
          { type: "gap", gapId: "g1" },
          { type: "text", text: " chased the " },
          { type: "gap", gapId: "g2" },
          { type: "text", text: "." },
        ],
        gaps: [
          { id: "g1", prefix: "ca", blankLength: 1 },
          { id: "g2", prefix: "mo", blankLength: 3 },
        ],
      },
    ],
    dailyLife: [
      {
        id: "dl-1",
        taskType: "daily_life",
        genre: "notice",
        text: "The bike room closes at nine.\nKeys are at the front desk.",
        questions: [
          { id: "dl-1-q1", stem: "When does the bike room close?", options: [{ id: "a", text: "At eight" }, { id: "b", text: "At nine" }] },
          { id: "dl-1-q2", stem: "Where are the keys?", options: [{ id: "a", text: "At the front desk" }, { id: "b", text: "In the bike room" }] },
        ],
      },
    ],
    academic: [],
  },
  lowerModule: { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] },
  upperModule: { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] },
};

async function begin(user: ReturnType<typeof userEvent.setup>) {
  renderRoutes(
    [
      { path: "/", element: <p>home</p> },
      { path: "/simulate/reading", element: <ReadingSimulation /> },
      { path: "/attempts/:id", element: <p>attempt report</p> },
    ],
    ["/", "/simulate/reading"],
  );
  await user.click(await screen.findByRole("button", { name: "Start Reading Simulation" }));
  await screen.findByRole("navigation", { name: "Questions in this Module" });
}

const navigator = () => screen.getByRole("navigation", { name: "Questions in this Module" });

describe("the Reading Module screen", () => {
  beforeEach(async () => {
    const api = await import("../src/lib/api");
    (api.getSet as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(set);
    useFakeTimersInTest({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows one screen per passage and per question, with Back and Next between them", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await begin(user);

    // Screen 1: the whole Complete the Words passage.
    expect(screen.getByLabelText('Gap starting with "ca"')).toBeInTheDocument();
    expect(screen.getByText("Questions 1–2 of 4")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("When does the bike room close?")).toBeInTheDocument();
    expect(screen.queryByText("Where are the keys?")).toBeNull();
    // The text stays beside the question, with its own line breaks.
    expect(screen.getByText(/The bike room closes at nine/)).toBeInTheDocument();
    expect(screen.getByText("Question 3 of 4")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Where are the keys?")).toBeInTheDocument();
    // The last screen offers the submit in Next's place.
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("When does the bike room close?")).toBeInTheDocument();
  });

  it("moves focus to the question that just came into view", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await begin(user);
    await user.click(screen.getByRole("button", { name: "Next" }));

    const question = screen.getByRole("group", { name: "When does the bike room close?" });
    expect(question.contains(document.activeElement)).toBe(true);
  });

  it("keeps typed letters when the User leaves a passage and comes back", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await begin(user);
    await user.type(screen.getByLabelText('Gap starting with "ca"'), "t");
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(screen.getByRole("button", { name: "Back" }));
    expect((screen.getByLabelText('Gap starting with "ca"') as HTMLInputElement).value).toBe("t");
  });

  it("shows which Items have a Response, by shape and in words, and jumps to any of them", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await begin(user);

    expect(within(navigator()).getByText("0")).toBeInTheDocument();
    expect(within(navigator()).getByRole("button", { name: "Questions 1 to 2, not answered, on screen" })).toHaveAttribute(
      "aria-current",
      "step",
    );

    await user.type(screen.getByLabelText('Gap starting with "ca"'), "t");
    expect(within(navigator()).getByRole("button", { name: "Questions 1 to 2, 1 of 2 answered, on screen" })).toBeInTheDocument();

    await user.click(within(navigator()).getByRole("button", { name: "Question 4, not answered" }));
    expect(screen.getByText("Where are the keys?")).toBeInTheDocument();
    await user.click(screen.getByLabelText("At the front desk"));
    expect(within(navigator()).getByRole("button", { name: "Question 4, answered, on screen" })).toBeInTheDocument();
    expect(navigator()).toHaveTextContent("2 of 4 Items answered");
  });

  it("says how many Items have no Response before it submits the Module, and does nothing if the User keeps working", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await begin(user);
    await user.type(screen.getByLabelText('Gap starting with "ca"'), "t");

    await user.click(screen.getByRole("button", { name: "Submit Module…" }));
    const dialog = await screen.findByRole("dialog", { name: "Submit the Router Module?" });
    expect(dialog).toHaveTextContent("3 of 4 Items have no Response. As on the test, they will score 0.");
    expect(dialog).toHaveTextContent("you can't change any Response in this Module");

    await user.click(within(dialog).getByRole("button", { name: "Keep working" }));
    expect(screen.queryByRole("dialog", { name: "Submit the Router Module?" })).toBeNull();
    expect(api.scoreDeterministicTask).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Submit Module…" }));
    await user.click(within(await screen.findByRole("dialog", { name: "Submit the Router Module?" })).getByRole("button", { name: "Submit Module" }));
    expect(await screen.findByRole("heading", { name: "Module Path: Lower Module" })).toBeInTheDocument();
  });

  it("runs the Module clock in the header and says in words when time runs low", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await begin(user);

    const clock = screen.getByRole("timer", { name: "Time remaining in this Module" });
    expect(clock).toHaveTextContent(/^(20:00|19:5\d)$/);
    await act(async () => {
      vi.advanceTimersByTime(15 * 60_000 + 30_000);
    });
    expect(screen.getByText("Under 5 min")).toBeInTheDocument();
  });

  it("leaves through Exit only after the leave prompt", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await begin(user);

    await user.click(screen.getByRole("button", { name: "Exit…" }));
    const prompt = await findLeavePrompt();
    expect(prompt).toHaveTextContent(/starts the Reading section again from the beginning/);
    await user.click(within(prompt).getByRole("button", { name: "Leave" }));
    expect(await screen.findByText("home")).toBeInTheDocument();
  });
});
