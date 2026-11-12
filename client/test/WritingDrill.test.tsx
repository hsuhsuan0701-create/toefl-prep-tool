import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useFakeTimersInTest } from "./fakeTimers";
import { screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderRoutes } from "./dataRouter";
import WritingDrill from "../src/pages/WritingDrill";
import { dragTile, dragTilesIntoBlanks, finishBuildSentence, installTileDragLayout } from "./buildSentenceDrag";

// A full Writing Drill runs Build a Sentence → Email → Academic Discussion, and the last two share
// one `essay-running` stage. Both render a `TimedEditor` from the same ternary slot, so without
// distinct keys React reconciles them as a single instance and the Discussion inherits the Email's
// state: a clock already part-way down, the Email's draft still in the box, and a latched
// `submittedRef` that makes the Discussion unsubmittable.

vi.mock("../src/lib/api", () => ({
  getSet: vi.fn(),
  createAttempt: vi.fn(async () => ({ attemptId: "att-1", isRepeat: false })),
  completeAttempt: vi.fn(async () => ({})),
  scoreTask: vi.fn(async (_attemptId: string, body: any) =>
    body.taskType === "build_sentence"
      ? {
          items: body.items.map((i: any) => ({
            itemId: i.itemId,
            correct: true,
            matchedAnswer: i.tileOrder,
            correctAnswers: [i.tileOrder],
          })),
        }
      : { jobId: "job-1" },
  ),
}));

// Essay scoring is pipelined into a background job; this drill test only cares that a slot exists
// and stays in flight, never about the Score Report itself.
//
// The mock fires `start` once per mount, exactly as the real hook does (usePolledJob's `hasBegunRef`
// guard inside a `[]`-deps effect). That is the whole point for the duplicate-scoring test below:
// the real hook cannot re-fire on a prop change, so a second POST can only mean a remounted slot got
// past the one-job registry, and this mock reproduces that property without pulling in the poll
// loop.
vi.mock("../src/hooks/useScoringJob", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    useScoringJob: (_attemptId: string, args?: { start?: () => Promise<{ jobId: string }> }) => {
      const begun = useRef(false);
      // Read through a ref, as the real hook does, so the once-per-mount effect needs no deps.
      const startRef = useRef(args?.start);
      startRef.current = args?.start;
      useEffect(() => {
        if (begun.current) return;
        begun.current = true;
        void startRef.current?.();
      }, []);
      return {
        status: "running",
        stage: null,
        judgesDone: [],
        judgesFailed: [],
        openaiJudgeProvider: null,
        arbiterProvider: null,
        fallbackFrom: null,
        queuePosition: null,
        elapsedMs: 0,
        result: null,
        error: null,
        cancellationRequestedAt: null,
        terminalAt: null,
        cancellationReason: null,
        retry: () => {},
      };
    },
  };
});

// Build a Sentence runs on one pooled budget for the whole Task; no Item carries a clock of its own
// for the Drill to read.
const BUDGET_SECONDS = 410;
const EMAIL_SECONDS = 420;
const DISCUSSION_SECONDS = 600;

// `kind` is what the Drill narrows the served Set on (shared's expectServedSet). Every real Set
// carries it, on disk and through stripAnswers, so a fixture without one is not a Set the server
// could send.
const set = {
  id: "wri-test",
  kind: "writing",
  source: "generated",
  createdAt: "2026-01-01T00:00:00Z",
  buildASentence: {
    items: [
      { id: "bs-1", prompt: "Arrange the first sentence.", tiles: ["a", "b"], correctAnswers: [["a", "b"]] },
      { id: "bs-2", prompt: "Arrange the second sentence.", tiles: ["c", "d"], correctAnswers: [["c", "d"]] },
    ],
  },
  email: {
    id: "em-1",
    scenario: "Ask for an extension.",
    to: "prof@uni.edu",
    subject: "Extension",
    bullets: ["say why"],
    timeLimitSec: EMAIL_SECONDS,
    wordGuidance: { min: 80, max: 120 },
  },
  academicDiscussion: {
    id: "ad-1",
    courseTitle: "Econ 101",
    professorName: "Dr. Lin",
    professorPost: "Discuss the incentive effects.",
    studentPosts: [{ name: "Ana", post: "I think subsidies distort prices." }],
    timeLimitSec: DISCUSSION_SECONDS,
    minWords: 100,
  },
};

/** The displayed clock as whole seconds, so assertions can tolerate sub-second scheduler drift. */
function remainingSeconds(): number {
  const [mm, ss] = (screen.getByRole("timer").textContent ?? "").split(":");
  return Number(mm) * 60 + Number(ss);
}

/** Asserts the clock is at (essentially) a full `seconds` — i.e. this task started its own timer. */
function expectFreshClock(seconds: number) {
  expect(remainingSeconds()).toBeGreaterThan(seconds - 3);
  expect(remainingSeconds()).toBeLessThanOrEqual(seconds);
}

// Each test sits its own Attempt, as two real Attempts would: the Drills' one-job-per-Task-Type
// registry (lib/scoringJobOnce.ts) is module-level and keyed by Attempt id, so a shared id would
// hand the second test the first test's Email job instead of a POST of its own.
let attemptSeq = 0;

describe("WritingDrill full drill: every task gets a fresh editor and a fresh clock", () => {
  beforeEach(async () => {
    const api = await import("../src/lib/api");
    (api.getSet as any).mockResolvedValue(set);
    (api.createAttempt as any).mockResolvedValue({ attemptId: `att-essay-${++attemptSeq}`, isRepeat: false });
    useFakeTimersInTest({ shouldAdvanceTime: true });
  });
  // The Email-and-Discussion test below counts `scoreTask` calls, so each test starts from an empty
  // call history; vi.restoreAllMocks() no longer clears a vi.fn()'s calls.
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("resets the timer and the draft at every essay boundary", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRoutes([{ path: "/writing/:setId", element: <WritingDrill /> }], "/writing/wri-test");

    await user.click(await screen.findByText("All three Task Types"));
    await user.click(screen.getByRole("button", { name: "Start Writing Drill" }));

    // Wait for item 1 to be on screen before touching the clock: handleStart awaits createAttempt,
    // so advancing first would measure a clock that has not started yet.
    await screen.findByText("Arrange the first sentence.");

    // The pooled budget itself belongs to the BuildSentenceTask module and is asserted there, once
    // (BuildSentenceTask.test.tsx). Here it is only the road to the essays: letting it expire ends
    // the Task and lands the Attempt on Write an Email.
    await act(async () => {
      vi.advanceTimersByTime((BUDGET_SECONDS + 1) * 1000);
    });

    // The Email starts from its own clock, not the Build a Sentence remainder.
    await screen.findByRole("heading", { name: "Write an Email" });
    expectFreshClock(EMAIL_SECONDS);

    // Spend two minutes on the Email, write something, submit.
    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    await user.type(screen.getByRole("textbox"), "Dear Professor, please grant me an extension.");
    await user.click(screen.getByRole("button", { name: /^Submit/ }));

    await screen.findByRole("heading", { name: "Academic Discussion" });

    // An empty box and a full 10:00, not the Email's draft on an 8:00 clock.
    expect(screen.getByRole("textbox")).toHaveValue("");
    expectFreshClock(DISCUSSION_SECONDS);

    // …and it is actually submittable — the Email's submit latch must not carry over either.
    await user.type(screen.getByRole("textbox"), "I agree with Ana because incentives matter.");
    await user.click(screen.getByRole("button", { name: /^Submit/ }));
    expect(await screen.findByRole("heading", { name: "Results" })).toBeInTheDocument();
  });

  // The stages replace one another inside one route, so without a scroll of its own each would open
  // at the offset the stage before was left at, its start under the sticky header (issue #22).
  it("opens every stage at the top of the window, and leaves the page put between Items", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    const toTop = expect.objectContaining({ top: 0 });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRoutes([{ path: "/writing/:setId", element: <WritingDrill /> }], "/writing/wri-test");

    await user.click(await screen.findByText("All three Task Types"));
    await screen.findByRole("button", { name: "Start Writing Drill" });
    expect(scrollTo).toHaveBeenLastCalledWith(toTop);

    scrollTo.mockClear();
    await user.click(screen.getByRole("button", { name: "Start Writing Drill" }));
    await screen.findByText("Arrange the first sentence.");
    expect(scrollTo).toHaveBeenCalledWith(toTop);

    // Next is a move between the Items of one stage, not a new stage.
    scrollTo.mockClear();
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Arrange the second sentence.");
    expect(scrollTo).not.toHaveBeenCalled();

    await finishBuildSentence(user);
    await screen.findByRole("heading", { name: "Write an Email" });
    expect(scrollTo).toHaveBeenLastCalledWith(toTop);

    scrollTo.mockClear();
    await user.type(screen.getByRole("textbox"), "Dear Professor, please grant me an extension.");
    await user.click(screen.getByRole("button", { name: /^Submit/ }));
    await screen.findByRole("heading", { name: "Academic Discussion" });
    expect(scrollTo).toHaveBeenCalledWith(toTop);

    scrollTo.mockClear();
    await user.click(screen.getByRole("button", { name: /^Submit/ }));
    await screen.findByRole("heading", { name: "Results" });
    expect(scrollTo).toHaveBeenCalledWith(toTop);
  });

  // Each essay's scoring job is fired when its slot mounts, and re-fired only by an explicit Retry.
  // The Email's slot is drawn as one line above the Discussion and again on the results screen, a
  // different place in the tree, so it mounts twice. lib/scoringJobOnce.ts keeps the second mount
  // from posting the Email again, which would supersede its job and overwrite its scores.
  it("does not re-score the Email when the Discussion finishes the drill", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRoutes([{ path: "/writing/:setId", element: <WritingDrill /> }], "/writing/wri-test");

    await user.click(await screen.findByText("All three Task Types"));
    await user.click(screen.getByRole("button", { name: "Start Writing Drill" }));

    await screen.findByText("Arrange the first sentence.");
    // One pooled budget for the whole Task: let it expire to get to the essays.
    await act(async () => { vi.advanceTimersByTime(BUDGET_SECONDS * 1000 + 1_000); });

    await screen.findByRole("heading", { name: "Write an Email" });
    await user.type(screen.getByRole("textbox"), "Dear Professor, please grant me an extension.");
    await user.click(screen.getByRole("button", { name: /^Submit/ }));

    await screen.findByRole("heading", { name: "Academic Discussion" });
    const emailScoresBeforeDiscussion = (api.scoreTask as any).mock.calls
      .filter(([, body]: [string, any]) => body.taskType === "email").length;
    expect(emailScoresBeforeDiscussion).toBe(1);

    await user.type(screen.getByRole("textbox"), "I agree with Ana because incentives matter.");
    await user.click(screen.getByRole("button", { name: /^Submit/ }));
    await screen.findByRole("heading", { name: "Results" });

    const scoreCallsByType = (api.scoreTask as any).mock.calls
      .map(([, body]: [string, any]) => body.taskType);
    // The Email is scored once for the whole Drill, not again on the way to Results.
    expect(scoreCallsByType.filter((t: string) => t === "email")).toHaveLength(1);
    expect(scoreCallsByType.filter((t: string) => t === "discussion")).toHaveLength(1);
  });
});

// The results view prints a Build a Sentence Response inside its frame. A frame keeps "The" and
// "wonderful." out of the tiles, so the tile texts joined by spaces would read as a fragment.
const REFERENCE_ANSWER = ["volunteers", "who", "led us through", "the", "new wing", "were"];
const framedSet = {
  ...set,
  buildASentence: {
    items: [
      {
        id: "bas-1",
        prompt: "How did the museum visit go?",
        frame: "The ___ ___ ___ ___ ___ ___ wonderful.",
        tiles: ["were", "the", "was", "new wing", "led us through", "who", "volunteers"],
      },
      {
        id: "bas-2",
        prompt: "Describe the museum.",
        frame: "The museum ___ ___ ___ crowded.",
        tiles: ["was", "not", "very", "were"],
      },
    ],
  },
};
const ANSWER_KEYS: Record<string, string[]> = { "bas-1": REFERENCE_ANSWER, "bas-2": ["was", "not", "very"] };

// Tiles are placed by dragging and by nothing else; these two describes arrange theirs with a real
// drag over the synthetic layout this installs (test/buildSentenceDrag.ts).
installTileDragLayout();

describe("WritingDrill results: a Build a Sentence Response reads back as its whole sentence", () => {
  beforeEach(async () => {
    const api = await import("../src/lib/api");
    (api.getSet as any).mockResolvedValue(framedSet);
    // A fixed key per Item rather than the echo the mock above uses: a key that just repeats what
    // was submitted could not tell a framed key from a fragment.
    (api.scoreTask as any).mockImplementation(async (_attemptId: string, body: any) => ({
      items: body.items.map((i: any) => ({
        itemId: i.itemId,
        correct: false,
        matchedAnswer: null,
        correctAnswers: [ANSWER_KEYS[i.itemId]],
      })),
    }));
  });

  it("frames the submitted Response and the key, and keeps a partial Response's blanks visible", async () => {
    const user = userEvent.setup();
    renderRoutes([{ path: "/writing/:setId", element: <WritingDrill /> }], "/writing/wri-test");

    await user.click(await screen.findByText("Build a Sentence"));
    await user.click(screen.getByRole("button", { name: "Start Writing Drill" }));

    // Item 1: the reference arrangement, every blank filled. On the pooled budget Next means "done with
    // this Item" and moves on; nothing is handed to the server until the Task ends.
    await screen.findByText("How did the museum visit go?");
    await dragTilesIntoBlanks(user, REFERENCE_ANSWER);
    await user.click(screen.getByRole("button", { name: "Next" }));

    // Item 2: one tile placed, then the Task finished early with two blanks still empty.
    await screen.findByText("Describe the museum.");
    await dragTile(user, "was", { blank: 0 });
    await finishBuildSentence(user);

    await screen.findByRole("heading", { name: "Results" });

    expect(screen.getByTestId("bas-answer-bas-1")).toHaveTextContent(
      "Your Response: The volunteers who led us through the new wing were wonderful.",
    );
    expect(screen.getByTestId("bas-key-bas-1")).toHaveTextContent(
      "Key: The volunteers who led us through the new wing were wonderful.",
    );
    // The gap the User left stays a gap; the sentence does not close up over it.
    expect(screen.getByTestId("bas-answer-bas-2")).toHaveTextContent("Your Response: The museum was ___ ___ crowded.");
    expect(screen.getByTestId("bas-key-bas-2")).toHaveTextContent("Key: The museum was not very crowded.");
  });
});

// The pooled budget, free navigation, the arrangement that survives navigating away and both ways
// the Task ends are the BuildSentenceTask module's, and are asserted there exactly once
// (BuildSentenceTask.test.tsx) rather than a second time here and a third time against the Writing
// Simulation. What is the Drill's own business, and all this describe checks, is the hand-off: it
// describes the pooled budget in its own Task picker, hands the Set's Items to the module, and
// scores the Responses the module hands back.
describe("WritingDrill Build a Sentence: the Items in, the Responses out", () => {
  beforeEach(async () => {
    const api = await import("../src/lib/api");
    (api.getSet as any).mockResolvedValue(framedSet);
    (api.scoreTask as any).mockClear();
    (api.scoreTask as any).mockImplementation(async (_attemptId: string, body: any) => ({
      items: body.items.map((i: any) => ({
        itemId: i.itemId,
        correct: false,
        matchedAnswer: null,
        correctAnswers: [ANSWER_KEYS[i.itemId]],
      })),
    }));
  });

  it("scores the module's Responses in ONE commit for the whole Task, in Set order", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup();
    renderRoutes([{ path: "/writing/:setId", element: <WritingDrill /> }], "/writing/wri-test");

    // The summary line the User picks the Task from describes the pooled budget, not "40s each",
    // and as the reading the exam clock will show, not as rounded minutes: 410 s is 6:50, and
    // "7 minutes" would be 10 seconds the User does not have.
    expect(
      await screen.findByText(/2 Items · one 6:50 clock for all of them/),
    ).toBeInTheDocument();

    await user.click(screen.getByText("Build a Sentence"));
    await user.click(screen.getByRole("button", { name: "Start Writing Drill" }));

    // The Items the Drill hands in are the Set's own, in Set order.
    await screen.findByText("How did the museum visit go?");
    await dragTile(user, "volunteers", { blank: 0 });
    await finishBuildSentence(user);

    await screen.findByRole("heading", { name: "Results" });

    // One Build a Sentence commit for the whole Task, carrying every Item in Set order — not one
    // commit per Item, and not ten empty Responses fired off in the same instant. Item 2 was never
    // reached and rides along as an empty Response.
    const bsCalls = (api.scoreTask as any).mock.calls.filter(
      ([, body]: [string, any]) => body.taskType === "build_sentence",
    );
    expect(bsCalls).toHaveLength(1);
    expect(bsCalls[0][1].items).toEqual([
      { itemId: "bas-1", tileOrder: ["volunteers"] },
      { itemId: "bas-2", tileOrder: [] },
    ]);

    // …and the Responses that came back out are what the results view reads.
    expect(screen.getByTestId("bas-answer-bas-1")).toHaveTextContent(
      "Your Response: The volunteers ___ ___ ___ ___ ___ wonderful.",
    );
    expect(screen.getByTestId("bas-answer-bas-2")).toHaveTextContent("Your Response: (no Response submitted)");
  });
});

// A Build a Sentence commit that fails lands on the error screen with a Retry. A Retry that then
// succeeds carries the Drill on to what comes next, here the results, rather than leaving it on the
// error screen.
describe("WritingDrill Build a Sentence: a failed commit, then a Retry that succeeds", () => {
  beforeEach(async () => {
    const api = await import("../src/lib/api");
    (api.getSet as any).mockResolvedValue(framedSet);
    (api.scoreTask as any).mockClear();
    (api.scoreTask as any).mockImplementation(async (_attemptId: string, body: any) => ({
      items: body.items.map((i: any) => ({
        itemId: i.itemId,
        correct: false,
        matchedAnswer: null,
        correctAnswers: [ANSWER_KEYS[i.itemId]],
      })),
    }));
    (api.scoreTask as any).mockRejectedValueOnce(new Error("The score request did not go through."));
  });

  it("returns to the run and shows the results", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup();
    renderRoutes([{ path: "/writing/:setId", element: <WritingDrill /> }], "/writing/wri-test");

    await user.click(await screen.findByText("Build a Sentence"));
    await user.click(screen.getByRole("button", { name: "Start Writing Drill" }));
    await screen.findByText("How did the museum visit go?");
    await finishBuildSentence(user);

    expect(await screen.findByText("The score request did not go through.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { name: "Results" })).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).toBeNull();
    // The same commit, sent twice: once failed, once scored.
    const bsCalls = (api.scoreTask as any).mock.calls.filter(([, body]: [string, any]) => body.taskType === "build_sentence");
    expect(bsCalls).toHaveLength(2);
    expect(bsCalls[1][1]).toEqual(bsCalls[0][1]);
  });
});
