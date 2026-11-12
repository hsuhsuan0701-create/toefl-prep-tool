import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ReadingDrill from "../src/pages/ReadingDrill";
import WritingDrill from "../src/pages/WritingDrill";
import { findLeavePrompt, renderRoutes, unload } from "./dataRouter";
import { afterFeedbackHold } from "./feedbackHold";

// Leaving a Drill works the way leaving a Simulation does: once its Attempt exists, the screen's
// Exit, the browser's Back and a reload all ask first, in LeaveGuardHost's one dialog, and the
// Drill's own finish leaves without asking. Before the Attempt exists there is nothing to lose and
// nothing asks.

vi.mock("../src/lib/api", () => ({
  getSet: vi.fn(),
  listSets: vi.fn(async () => []),
  createAttempt: vi.fn(async () => ({ attemptId: "att-1", isRepeat: false })),
  completeAttempt: vi.fn(async () => ({})),
  scoreDeterministicTask: vi.fn(async (_attemptId: string, req: { taskType: string; items: { itemId: string }[] }) => ({
    taskType: req.taskType,
    items: req.items.map((i) => ({ itemId: i.itemId, correct: true, key: "o1", explanationZh: "因為 A 是對的。" })),
  })),
  scoreTask: vi.fn(async (_attemptId: string, body: { items: { itemId: string; tileOrder: string[] }[] }) => ({
    items: body.items.map((i) => ({ itemId: i.itemId, correct: true, matchedAnswer: i.tileOrder, correctAnswers: [i.tileOrder] })),
  })),
  getAttempt: vi.fn(),
  DeterministicAlreadyScoredError: class DeterministicAlreadyScoredError extends Error {},
}));

const readingSet = {
  id: "rdg-1",
  kind: "reading",
  source: "generated",
  createdAt: "2026-01-01T00:00:00Z",
  router: {
    ctwPassages: [],
    dailyLife: [
      {
        id: "dl-1",
        taskType: "daily_life",
        genre: "notice",
        text: "The library closes at six.",
        questions: [{ id: "dl-1-q1", stem: "When does it close?", options: [{ id: "o1", text: "At six" }, { id: "o2", text: "At five" }] }],
      },
    ],
    academic: [],
  },
};

const writingSet = {
  id: "wri-1",
  kind: "writing",
  source: "generated",
  createdAt: "2026-01-01T00:00:00Z",
  buildASentence: { items: [{ id: "bs-1", prompt: "Arrange it.", tiles: ["a", "b"] }] },
  email: { id: "em-1", scenario: "Ask.", to: "a@b.edu", subject: "Hi", bullets: ["x"], timeLimitSec: 420, wordGuidance: { min: 80, max: 120 } },
  academicDiscussion: { id: "ad-1", courseTitle: "Econ", professorName: "Dr. Lin", professorPost: "Discuss.", studentPosts: [], timeLimitSec: 600, minWords: 100 },
};

function renderDrill(path: string, element: React.ReactElement, entry: string) {
  return renderRoutes(
    [
      { path: "/", element: <p>dashboard</p> },
      { path, element },
    ],
    ["/", entry],
  );
}

beforeEach(async () => {
  const api = await import("../src/lib/api");
  vi.mocked(api.getSet).mockImplementation(async (id: string) => (id === "rdg-1" ? readingSet : writingSet) as never);
});

afterEach(() => vi.clearAllMocks());

describe("leaving a Drill", () => {
  it("leaves without asking before the Attempt exists", async () => {
    const user = userEvent.setup();
    renderDrill("/reading/:setId", <ReadingDrill />, "/reading/rdg-1");
    await user.click(await screen.findByText("Read in Daily Life"));
    expect(unload()).toBe(false);
    await user.click(screen.getByRole("link", { name: "Exit" }));
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks once the run has started, stays on Stay and leaves on Leave", async () => {
    const user = userEvent.setup();
    renderDrill("/reading/:setId", <ReadingDrill />, "/reading/rdg-1");
    await user.click(await screen.findByText("Read in Daily Life"));
    await user.click(screen.getByRole("button", { name: "Start Reading Drill" }));
    await screen.findByRole("button", { name: "Check Response" });

    await user.click(screen.getByRole("button", { name: "Exit…" }));
    const dialog = await findLeavePrompt();
    expect(within(dialog).getByRole("heading", { name: "Leave this Drill?" })).toBeInTheDocument();
    expect(dialog).toHaveTextContent("left Unfinished");
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(screen.getByRole("button", { name: "Check Response" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Exit…" }));
    await user.click(within(await findLeavePrompt()).getByRole("button", { name: "Leave" }));
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
  });

  it("asks before a reload while the run is open", async () => {
    const user = userEvent.setup();
    renderDrill("/writing/:setId", <WritingDrill />, "/writing/wri-1");
    await user.click(await screen.findByText("Build a Sentence"));
    expect(unload()).toBe(false);
    await user.click(screen.getByRole("button", { name: "Start Writing Drill" }));
    await screen.findByRole("button", { name: "Finish Build a Sentence" });
    expect(unload()).toBe(true);
  });

  it("asks on the browser's Back as on the screen's Exit", async () => {
    const user = userEvent.setup();
    const { router } = renderDrill("/writing/:setId", <WritingDrill />, "/writing/wri-1");
    await user.click(await screen.findByText("Build a Sentence"));
    await user.click(screen.getByRole("button", { name: "Start Writing Drill" }));
    await screen.findByRole("button", { name: "Finish Build a Sentence" });

    await router.navigate(-1);
    const dialog = await findLeavePrompt();
    expect(within(dialog).getByRole("heading", { name: "Leave this Drill?" })).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Stay" }));
    expect(screen.getByRole("button", { name: "Finish Build a Sentence" })).toBeInTheDocument();
  });

  it("finishes without asking", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup();
    renderDrill("/reading/:setId", <ReadingDrill />, "/reading/rdg-1");
    await user.click(await screen.findByText("Read in Daily Life"));
    await user.click(screen.getByRole("button", { name: "Start Reading Drill" }));
    await user.click(await screen.findByRole("button", { name: "Check Response" }));
    const seeResults = await screen.findByRole("button", { name: "See results" });
    await afterFeedbackHold();
    await user.click(seeResults);
    await user.click(await screen.findByRole("button", { name: "Back to Practice" }));

    expect(await screen.findByText("dashboard")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /^Leave/ })).toBeNull();
    await waitFor(() => expect(vi.mocked(api.completeAttempt)).toHaveBeenCalledWith("att-1"));
  });

  it("does not ask on the way out of a Drill that has failed", async () => {
    const api = await import("../src/lib/api");
    vi.mocked(api.scoreTask).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const user = userEvent.setup();
    renderDrill("/writing/:setId", <WritingDrill />, "/writing/wri-1");
    await user.click(await screen.findByText("Build a Sentence"));
    await user.click(screen.getByRole("button", { name: "Start Writing Drill" }));
    await user.click(await screen.findByRole("button", { name: "Finish Build a Sentence" }));
    // Finishing early asks first; confirm it, and the commit fails.
    const confirm = screen.queryByRole("dialog", { name: /Finish Build a Sentence/ });
    if (confirm) await user.click(within(confirm).getByRole("button", { name: /^Finish/ }));

    expect(await screen.findByText("Can't reach the server. Is it running?")).toBeInTheDocument();
    expect(unload()).toBe(false);
    await user.click(screen.getByRole("link", { name: "Back to Practice" }));
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: /^Leave/ })).toBeNull();
  });
});
