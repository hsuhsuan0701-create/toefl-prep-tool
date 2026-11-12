import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { useFakeTimersInTest } from "./fakeTimers";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { findLeavePrompt, renderRoutes, unload } from "./dataRouter";
import { deferred } from "./deferred";
import type { ServedReadingSet } from "@toefl-prep/shared";
import ReadingSimulation from "../src/pages/simulation/ReadingSimulation";

// The Reading Simulation, mounted directly behind a mocked api client, as
// WritingSimulation.test.tsx does.
//
// The reducer's own transitions are asserted without rendering anything in readingSimulation.test.ts.
// What is worth asserting here is what the wiring can get wrong: that a whole routed Attempt
// (Router Module -> score -> route -> path reveal -> the routed Module -> complete -> report) runs
// end to end, that leaving the tab still flags the Attempt, and that the Module clock expires at its
// real budget however often the screen re-renders.

vi.mock("../src/lib/api", () => ({
  listSets: vi.fn(async () => [{ id: "rd-sim-1" }]),
  listAttempts: vi.fn(async () => []),
  getSet: vi.fn(),
  createAttempt: vi.fn(async () => ({ attemptId: "att-1", isRepeat: false })),
  completeAttempt: vi.fn(async () => ({})),
  // Imported through simulationShell.ts for the Full-Test Run hand-off, and called only when the
  // Simulation was given a `fullTest` context. A mock that omits an export the module graph imports
  // fails at access time with a confusing "no export defined on the mock".
  advanceFullTest: vi.fn(async () => ({})),
  flagAttempt: vi.fn(async () => ({})),
  scoreTask: vi.fn(async () => ({ jobId: "job-1" })),
  getScoreJob: vi.fn(async () => ({ status: "done" })),
  scoreDeterministicTask: vi.fn(async () => ({ items: [] })),
  routeAttempt: vi.fn(async () => ({ path: "lower" })),
  finishSpeakingCapture: vi.fn(async () => ({})),
  uploadItemAudio: vi.fn(async () => ({})),
  DeterministicAlreadyScoredError: class DeterministicAlreadyScoredError extends Error {},
}));

// The Router Module's own budget, as readingSimulation.ts's MODULE_TIME_LIMIT_SEC fixes it (the
// served `timeLimitSec` below matches, but the reducer is what actually decides).
const ROUTER_SECONDS = 1200;

const set: ServedReadingSet = {
  id: "rd-sim-1",
  kind: "reading",
  source: "generated",
  createdAt: "2026-01-01T00:00:00.000Z",
  router: {
    timeLimitSec: ROUTER_SECONDS,
    ctwPassages: [
      {
        id: "ctw-r1",
        taskType: "complete_words",
        topic: "Router passage",
        segments: [
          { type: "text", text: "The " },
          { type: "gap", gapId: "ctw-r1-g1" },
          { type: "text", text: " sat." },
        ],
        gaps: [{ id: "ctw-r1-g1", prefix: "ca", blankLength: 1 }],
      },
    ],
    dailyLife: [
      {
        id: "dl-r1",
        taskType: "daily_life",
        genre: "notice",
        text: "The library closes at six.",
        questions: [
          {
            id: "dl-r1-q1",
            stem: "When does the library close?",
            options: [
              { id: "a", text: "At five" },
              { id: "b", text: "At six" },
              { id: "c", text: "At seven" },
            ],
          },
        ],
      },
    ],
    academic: [],
  },
  lowerModule: {
    timeLimitSec: 540,
    ctwPassages: [],
    dailyLife: [
      {
        id: "dl-l1",
        taskType: "daily_life",
        genre: "email",
        text: "The lower-module text.",
        questions: [
          {
            id: "dl-l1-q1",
            stem: "What is the lower question?",
            options: [
              { id: "a", text: "Lower option A" },
              { id: "b", text: "Lower option B" },
            ],
          },
        ],
      },
    ],
    academic: [],
  },
  // The Upper Module carries Complete the Words and Read an Academic Passage and no Read in Daily
  // Life text: ETS's composition for the hard path (RR-25-12 Table 1, ADR 0005). An empty
  // `dailyLife` has to flow through serving, this screen and the Module submit without a crash or a
  // phantom empty score request; the upper-path test below runs it end to end.
  upperModule: {
    timeLimitSec: 540,
    ctwPassages: [
      {
        id: "ctw-u1",
        taskType: "complete_words",
        topic: "Upper passage",
        segments: [
          { type: "text", text: "A " },
          { type: "gap", gapId: "ctw-u1-g1" },
          { type: "text", text: " ran." },
        ],
        gaps: [{ id: "ctw-u1-g1", prefix: "do", blankLength: 1 }],
      },
    ],
    dailyLife: [],
    academic: [
      {
        id: "ap-u1",
        taskType: "academic_passage",
        title: "The Upper Passage",
        discipline: "life science",
        text: "Two hundred words of expository prose, abbreviated for the test.",
        questions: [
          {
            id: "ap-u1-q1",
            stem: "What is the upper question?",
            options: [
              { id: "a", text: "Upper option A" },
              { id: "b", text: "Upper option B" },
            ],
          },
        ],
      },
    ],
  },
};

/** The displayed clock as whole seconds, so assertions tolerate sub-second scheduler drift. */
function remainingSeconds(): number {
  const [mm, ss] = (screen.getByRole("timer").textContent ?? "").split(":");
  return Number(mm) * 60 + Number(ss);
}

function renderSimulation() {
  return renderRoutes(
    [
      { path: "/", element: <p>home</p> },
      { path: "/simulate/reading", element: <ReadingSimulation /> },
      { path: "/attempts/:id", element: <p>attempt report</p> },
    ],
    ["/", "/simulate/reading"],
  );
}

/** Intro → the Router Module, with both of its Stimuli reachable and the Module clock running. */
async function beginSimulation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Start Reading Simulation" }));
  await screen.findByText("Router Module");
}

/** The confirm-then-submit pair a manual Module submit deliberately requires. */
async function submitModule(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Submit Module…" }));
  await user.click(await screen.findByRole("button", { name: "Submit Module" }));
}

/** A stop on the Module's question navigator, by its Item number. */
function questionStop(n: number) {
  return within(screen.getByRole("navigation", { name: "Questions in this Module" })).getByRole("button", {
    name: new RegExp(`^Question ${n},`),
  });
}

/** Both Modules, straight through on the Lower path, up to the wrap-up's first completion request. */
async function runToWrapUp(user: ReturnType<typeof userEvent.setup>) {
  const api = await import("../src/lib/api");
  await beginSimulation(user);
  await submitModule(user);
  await user.click(await screen.findByRole("button", { name: "Start the Lower Module" }));
  await screen.findByText("Lower Module");
  await submitModule(user);
  await waitFor(() => expect(api.completeAttempt).toHaveBeenCalledTimes(1));
}

/** What fetch rejects with when nothing answers. */
const noAnswer = () => new TypeError("Failed to fetch");
/** A refusal shaped as lib/api.ts's HttpError, which this file's mock of it leaves out. */
const refused = (status: number, reason: string) =>
  Object.assign(new Error(`${status}: ${JSON.stringify({ error: reason })}`), { status });

describe("Reading Simulation", () => {
  let clock: ReturnType<typeof useFakeTimersInTest>;

  beforeEach(async () => {
    const api = await import("../src/lib/api");
    (api.getSet as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(set);
    // Re-stated per test rather than left to the factory default above: `vi.clearAllMocks()` clears
    // recorded calls but not implementations, so the upper-path test's own `mockResolvedValue` would
    // otherwise leak into every test declared after it.
    (api.routeAttempt as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ path: "lower" });
    (api.scoreDeterministicTask as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [] });
    vi.mocked(api.completeAttempt).mockResolvedValue({});
    vi.mocked(api.advanceFullTest).mockResolvedValue({} as Awaited<ReturnType<typeof api.advanceFullTest>>);
    clock = useFakeTimersInTest({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  // The intro, the Modules, their scoring and the path reveal replace one another inside one route,
  // so each scrolls itself to the top; moving between a Module's screens does not (issue #22).
  it("opens every stage at the top of the window, and leaves the page put between a Module's screens", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo");
    const toTop = expect.objectContaining({ top: 0 });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();
    await screen.findByRole("button", { name: "Start Reading Simulation" });
    // The first screen is where the route change already put the User: it is neither scrolled nor
    // given focus, so a reload does not draw a focus ring round its heading.
    expect(scrollTo).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(document.body);

    scrollTo.mockClear();
    await beginSimulation(user);
    expect(scrollTo).toHaveBeenCalledWith(toTop);

    await user.click(questionStop(2));
    scrollTo.mockClear();
    await user.click(questionStop(1));
    expect(screen.getByLabelText('Gap starting with "ca"')).toBeInTheDocument();
    expect(scrollTo).not.toHaveBeenCalled();

    await submitModule(user);
    await screen.findByRole("heading", { name: "Module Path: Lower Module" });
    expect(scrollTo).toHaveBeenCalledWith(toTop);

    scrollTo.mockClear();
    await user.click(screen.getByRole("button", { name: "Start the Lower Module" }));
    await screen.findByText("Lower Module");
    expect(scrollTo).toHaveBeenCalledWith(toTop);
    scrollTo.mockRestore();
  });

  // A new text inside a Module opens at its top with its question focused in place (issue #23).
  it("opens a new text at the top of the window, with focus on its question head", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();
    await beginSimulation(user);

    const scrollTo = vi.spyOn(window, "scrollTo");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    await user.click(questionStop(2));
    expect(screen.getByText("The library closes at six.")).toBeInTheDocument();
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    expect(document.activeElement?.textContent).toContain("When does the library close?");
    scrollTo.mockRestore();
    focus.mockRestore();
  });

  // Coming back to the first question of the text already on screen is not a new text: the User was
  // reading it, so the question head is focused and brought into view as before, and the window is
  // not sent to the top, a whole text's length above the question at phone width.
  describe("on a text with two questions", () => {
    // The Router Module's Read in Daily Life text, given a second question: Question 2 and 3 of the
    // Module are its two screens.
    const twoQuestionSet: ServedReadingSet = structuredClone(set);
    twoQuestionSet.router.dailyLife[0].questions.push({
      id: "dl-r1-q2",
      stem: "Who wrote the notice?",
      options: [
        { id: "a", text: "The librarian" },
        { id: "b", text: "A student" },
      ],
    });

    beforeEach(async () => {
      const api = await import("../src/lib/api");
      vi.mocked(api.getSet).mockResolvedValue(twoQuestionSet);
    });
    // Puts back window.scrollTo and focus; the api mocks are vi.fn()s, which this leaves alone.
    afterEach(() => vi.restoreAllMocks());

    async function onSecondQuestion(user: ReturnType<typeof userEvent.setup>) {
      renderSimulation();
      await beginSimulation(user);
      await user.click(questionStop(2));
      await user.click(questionStop(3));
      expect(document.activeElement?.textContent).toContain("Who wrote the notice?");
      return { scrollTo: vi.spyOn(window, "scrollTo"), focus: vi.spyOn(HTMLElement.prototype, "focus") };
    }

    function expectReturnedInPlace(scrollTo: { mock: { calls: unknown[][] } }, focus: { mock: { calls: unknown[][] } }) {
      expect(document.activeElement?.textContent).toContain("When does the library close?");
      expect(scrollTo.mock.calls).not.toContainEqual([expect.objectContaining({ top: 0 })]);
      expect(focus).toHaveBeenLastCalledWith(undefined);
    }

    it("Back to the text's first question focuses it in view and leaves the window where it is", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { scrollTo, focus } = await onSecondQuestion(user);
      await user.click(screen.getByRole("button", { name: "Back" }));
      expectReturnedInPlace(scrollTo, focus);
    });

    it("the navigator from the text's second question to its first behaves like Back", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { scrollTo, focus } = await onSecondQuestion(user);
      await user.click(questionStop(2));
      expectReturnedInPlace(scrollTo, focus);
    });

    it("arriving at that first question from the previous Stimulus still opens the text at its top", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await onSecondQuestion(user);
      await user.click(questionStop(1));
      const scrollTo = vi.spyOn(window, "scrollTo");
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      await user.click(screen.getByRole("button", { name: /Next/ }));
      expect(document.activeElement?.textContent).toContain("When does the library close?");
      expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
      expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });
    });
  });

  it("runs the whole routed Attempt: Router Module → route → path reveal → Lower Module → report", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();
    await beginSimulation(user);

    // The Router Module opens on its first Stimulus, with free navigation across both of them.
    expect(remainingSeconds()).toBeGreaterThan(ROUTER_SECONDS - 5);
    expect(screen.getByLabelText('Gap starting with "ca"')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Gap starting with "ca"'), "t");
    await user.click(questionStop(2));
    await user.click(screen.getByLabelText("At six"));

    await submitModule(user);

    // Every Task Type in the Module is scored, then the Attempt is routed.
    await screen.findByRole("heading", { name: "Module Path: Lower Module" });
    const scored = (api.scoreDeterministicTask as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(scored.map(([, req]) => req.taskType)).toEqual(["complete_words", "daily_life"]);
    expect(scored[0][1].items).toEqual([{ itemId: "ctw-r1-g1", typed: "t" }]);
    expect(scored[1][1].items).toEqual([{ itemId: "dl-r1-q1", selectedOptionId: "b" }]);
    expect(api.routeAttempt).toHaveBeenCalledTimes(1);

    // Feedback stays deferred: the key and its 錯題解析 are never rendered mid-Attempt.
    expect(screen.queryByText("Correct answer")).toBeNull();

    // Starting the routed Module starts a genuinely new Module, on its own clock.
    await user.click(screen.getByRole("button", { name: "Start the Lower Module" }));
    await screen.findByText("Lower Module");
    expect(remainingSeconds()).toBeGreaterThan(535);
    await user.click(screen.getByLabelText("Lower option B"));
    await submitModule(user);

    // Module 2 completes the Attempt and hands off to the report.
    expect(await screen.findByText("attempt report")).toBeInTheDocument();
    expect(api.completeAttempt).toHaveBeenCalledWith("att-1");
    expect(
      (api.scoreDeterministicTask as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1].items,
    ).toEqual([{ itemId: "dl-l1-q1", selectedOptionId: "b" }]);
  });

  // On the Upper path a Module's `dailyLife` is legitimately empty. The navigator must show only the
  // two Stimuli that exist, and buildScoreRequests must send complete_words and academic_passage
  // and no empty daily_life request (an empty items array would be a score request for nothing,
  // which the server has no reason to accept).
  it("runs the Upper Module path, whose Module carries no Daily Life text at all", async () => {
    const api = await import("../src/lib/api");
    (api.routeAttempt as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ path: "upper" });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();
    await beginSimulation(user);
    await submitModule(user);

    await screen.findByRole("heading", { name: "Module Path: Upper Module" });
    await user.click(screen.getByRole("button", { name: "Start the Upper Module" }));
    await screen.findByText("Upper Module");

    // Two Stimuli, not three: the CtW passage and the academic passage.
    const stops = within(screen.getByRole("navigation", { name: "Questions in this Module" })).getAllByRole("button");
    expect(stops.map((b) => b.textContent)).toEqual(["1", "2"]);
    await user.type(screen.getByLabelText('Gap starting with "do"'), "g");
    await user.click(questionStop(2));
    await user.click(screen.getByLabelText("Upper option B"));
    await submitModule(user);

    expect(await screen.findByText("attempt report")).toBeInTheDocument();
    expect(api.completeAttempt).toHaveBeenCalledWith("att-1");
    const scored = (api.scoreDeterministicTask as unknown as ReturnType<typeof vi.fn>).mock.calls;
    // Router's two Task Types, then the Upper Module's two — daily_life never appears for the upper.
    expect(scored.map(([, req]) => req.taskType)).toEqual([
      "complete_words", "daily_life", "complete_words", "academic_passage",
    ]);
    expect(scored[2]![1].items).toEqual([{ itemId: "ctw-u1-g1", typed: "g" }]);
    expect(scored[3]![1].items).toEqual([{ itemId: "ap-u1-q1", selectedOptionId: "b" }]);
  });

  it("asks before leaving mid-Module — reload and browser Back alike — and stays put when declined", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { router } = renderSimulation();

    // The intro has nothing to lose yet.
    await screen.findByRole("button", { name: "Start Reading Simulation" });
    expect(unload()).toBe(false);

    await beginSimulation(user);
    expect(unload()).toBe(true);

    await act(async () => {
      await router.navigate(-1);
    });
    const prompt = await findLeavePrompt();
    expect(prompt).toHaveTextContent(/starts .* again from the beginning/);
    await user.click(within(prompt).getByRole("button", { name: "Stay" }));
    expect(screen.getByText("Router Module")).toBeInTheDocument();

    await act(async () => {
      await router.navigate(-1);
    });
    await user.click(within(await findLeavePrompt()).getByRole("button", { name: "Leave" }));
    expect(await screen.findByText("home")).toBeInTheDocument();
  });

  // Leaving while the Module submit is still legitimately retrying abandons an Attempt that could
  // then never be routed or banded. The way out appears only once the submit has actually failed.
  it("offers no way out while the Module submit is still retrying, only once it has failed", async () => {
    const api = await import("../src/lib/api");
    (api.scoreDeterministicTask as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError("Failed to fetch"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();
    await beginSimulation(user);
    await submitModule(user);

    await screen.findByRole("heading", { name: /Scoring the Router Module/ });
    await act(async () => {
      vi.advanceTimersByTime(25_000);
    });
    expect(screen.getByRole("heading", { name: /Scoring the Router Module/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /open my report|View this Attempt/ })).toBeNull();

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(16_000);
      });
    }
    expect(await screen.findByRole("heading", { name: /Couldn't submit the Router Module/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry submit" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View this Attempt instead" })).toBeInTheDocument();
    (api.scoreDeterministicTask as unknown as ReturnType<typeof vi.fn>).mockReset();
    (api.scoreDeterministicTask as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [] });
  });

  it("inside a Full-Test Run, the way out after a failed submit goes back to the Run", async () => {
    const api = await import("../src/lib/api");
    (api.scoreDeterministicTask as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(new TypeError("Failed to fetch"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderRoutes(
      [
        { path: "/full-test/:runId", element: <p>run page</p> },
        {
          path: "/full-test/:runId/reading",
          element: <ReadingSimulation fullTest={{ runId: "run-1", setId: "rd-sim-1", attemptId: null }} />,
        },
      ],
      ["/full-test/run-1", "/full-test/run-1/reading"],
    );
    await beginSimulation(user);
    await submitModule(user);
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(16_000);
      });
    }

    await user.click(await screen.findByRole("button", { name: "Back to the Full-Test Run" }));
    expect(await screen.findByText("run page")).toBeInTheDocument();
    (api.scoreDeterministicTask as unknown as ReturnType<typeof vi.fn>).mockReset();
    (api.scoreDeterministicTask as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ items: [] });
  });

  it("still flags the Attempt when the tab is left mid-Module", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();
    await beginSimulation(user);

    // jsdom's own visibilityState lives on Document.prototype, so this shadows it with an own
    // property and removes it again rather than leaving the whole document "hidden" behind.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    Reflect.deleteProperty(document, "visibilityState");
    expect(document.visibilityState).toBe("visible");

    expect(api.flagAttempt).toHaveBeenCalledWith("att-1");
  });

  // The Module screen re-renders on every keystroke and every move between Stimuli while its clock
  // counts down. The clock reads the deadline the Module started with on every tick, so those
  // re-renders cannot shorten it: the Module expires once, at its real budget, and not before.
  it("does not force-expire the Router Module early despite many re-renders, and submits once at the real budget", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();
    await beginSimulation(user);

    // Advance to 700s of real elapsed time, re-rendering the Module screen repeatedly along the way
    // with the same `navigate` dispatches a User moving between Stimuli produces. A clock that
    // counted elapsed time twice would force-submit at 600s, before this loop finishes.
    for (let i = 0; i < 7; i++) {
      await act(async () => {
        vi.advanceTimersByTime(100_000); // 100s of real time
      });
      await user.click(questionStop(i % 2 === 0 ? 2 : 1));
    }
    expect(screen.getByText("Router Module")).toBeInTheDocument();
    expect(remainingSeconds()).toBeGreaterThan(ROUTER_SECONDS - 715);
    expect(remainingSeconds()).toBeLessThan(ROUTER_SECONDS - 685);
    expect(api.scoreDeterministicTask).not.toHaveBeenCalled();

    // …and it does still expire, at its true budget, submitting the Module exactly once.
    await act(async () => {
      vi.advanceTimersByTime(600_000);
    });
    await screen.findByRole("heading", { name: "Module Path: Lower Module" });
    expect(api.routeAttempt).toHaveBeenCalledTimes(1);
    expect((api.scoreDeterministicTask as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  // Completing is what gives the Attempt its Band Estimate and its key review, so a completion that
  // fails is retried like a Module submit, and never passed over on the way to the report.
  describe("completing the Attempt", () => {
    it("retries a completion that fails once, then opens the report without the User doing anything", async () => {
      const api = await import("../src/lib/api");
      vi.mocked(api.completeAttempt).mockRejectedValueOnce(noAnswer());
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSimulation();
      await runToWrapUp(user);

      expect(screen.getByRole("heading", { name: "Wrapping up…" })).toBeInTheDocument();
      await act(async () => {
        await clock.advanceBy(2_000);
      });
      expect(await screen.findByText("attempt report")).toBeInTheDocument();
      expect(api.completeAttempt).toHaveBeenCalledTimes(2);
    });

    it("shows a completion that keeps failing, stays put with the guard up, and Retry completes it", async () => {
      const api = await import("../src/lib/api");
      vi.mocked(api.completeAttempt).mockRejectedValue(noAnswer());
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { router } = renderSimulation();
      await runToWrapUp(user);

      // Still inside the retry budget: still wrapping up.
      await act(async () => {
        await clock.advanceBy(20_000);
      });
      expect(screen.getByRole("heading", { name: "Wrapping up…" })).toBeInTheDocument();

      await act(async () => {
        await clock.advanceBy(20_000);
      });
      expect(await screen.findByRole("heading", { name: "Couldn't finish this Attempt" })).toBeInTheDocument();
      expect(screen.getByText("Can't reach the server. Is it running?")).toBeInTheDocument();
      expect(screen.getByText(/Both Modules are scored, and your Responses are safe/)).toBeInTheDocument();
      expect(screen.queryByText("attempt report")).toBeNull();

      // The Attempt is still unfinished, so leaving still asks, in the wrap-up's own words.
      expect(unload()).toBe(true);
      await act(async () => {
        await router.navigate(-1);
      });
      const prompt = await findLeavePrompt();
      expect(prompt).toHaveTextContent(/Leave before the Reading Attempt is finished\?/);
      await user.click(within(prompt).getByRole("button", { name: "Stay" }));

      const callsSoFar = vi.mocked(api.completeAttempt).mock.calls.length;
      vi.mocked(api.completeAttempt).mockResolvedValue({});
      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("attempt report")).toBeInTheDocument();
      expect(api.completeAttempt).toHaveBeenCalledTimes(callsSoFar + 1);
    });

    it("counts a refusal saying the Attempt is already completed as done", async () => {
      const api = await import("../src/lib/api");
      vi.mocked(api.completeAttempt).mockRejectedValueOnce(refused(409, "attempt is already completed"));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSimulation();
      await runToWrapUp(user);

      expect(await screen.findByText("attempt report")).toBeInTheDocument();
      expect(api.completeAttempt).toHaveBeenCalledTimes(1);
    });

    // Any other refusal cannot be fixed by sending again: it is shown at once, and the report as it
    // stands is the way out.
    it("shows any other refusal at once, without retrying, and opens the report as it stands on request", async () => {
      const api = await import("../src/lib/api");
      vi.mocked(api.completeAttempt).mockRejectedValue(refused(409, "attempt is aborted"));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSimulation();
      await runToWrapUp(user);

      expect(await screen.findByRole("heading", { name: "Couldn't finish this Attempt" })).toBeInTheDocument();
      expect(screen.getByText("The request was refused: attempt is aborted.")).toBeInTheDocument();
      expect(api.completeAttempt).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole("button", { name: "Open the report as it stands" }));
      expect(await screen.findByText("attempt report")).toBeInTheDocument();
      expect(api.completeAttempt).toHaveBeenCalledTimes(1);
    });

    it("inside a Full-Test Run, advances the Run only once the completion has succeeded", async () => {
      const api = await import("../src/lib/api");
      vi.mocked(api.completeAttempt).mockRejectedValue(noAnswer());
      const advance = deferred<Awaited<ReturnType<typeof api.advanceFullTest>>>();
      vi.mocked(api.advanceFullTest).mockReturnValue(advance.promise);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderRoutes(
        [
          { path: "/full-test/:runId", element: <p>run page</p> },
          {
            path: "/full-test/:runId/reading",
            element: <ReadingSimulation fullTest={{ runId: "run-1", setId: "rd-sim-1", attemptId: null }} />,
          },
          { path: "/attempts/:id", element: <p>attempt report</p> },
        ],
        ["/full-test/run-1", "/full-test/run-1/reading"],
      );
      await runToWrapUp(user);
      await act(async () => {
        await clock.advanceBy(40_000);
      });

      expect(await screen.findByRole("heading", { name: "Couldn't finish this Attempt" })).toBeInTheDocument();
      expect(screen.getByText(/what lets the Full-Test Run go on to the next section/)).toBeInTheDocument();
      expect(api.advanceFullTest).not.toHaveBeenCalled();
      expect(screen.queryByText("run page")).toBeNull();

      vi.mocked(api.completeAttempt).mockResolvedValue({});
      await user.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(api.advanceFullTest).toHaveBeenCalledWith("run-1"));
      const lastCompletion = vi.mocked(api.completeAttempt).mock.invocationCallOrder.at(-1)!;
      expect(vi.mocked(api.advanceFullTest).mock.invocationCallOrder[0]).toBeGreaterThan(lastCompletion);
      // Completed: the guard is down while the Run is told, before the hand-off itself.
      expect(unload()).toBe(false);

      await act(async () => {
        advance.resolve({} as Awaited<ReturnType<typeof api.advanceFullTest>>);
      });
      expect(await screen.findByText("run page")).toBeInTheDocument();
    });
  });
});
