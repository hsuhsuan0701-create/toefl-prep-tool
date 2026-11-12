import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { useFakeTimersInTest } from "./fakeTimers";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { findLeavePrompt, renderRoutes, unload } from "./dataRouter";
import { deferred } from "./deferred";
import SimulationRun from "../src/pages/SimulationRun";
import WritingSimulation from "../src/pages/simulation/WritingSimulation";
import { readWritingSession } from "../src/pages/simulation/writingDrafts";
import { dragTile, finishBuildSentence as finishTask, installTileDragLayout } from "./buildSentenceDrag";

// The Writing Simulation mounted for real behind a mocked api client. Build a Sentence is the same
// BuildSentenceTask module the Writing Drill mounts; its pooled budget, navigation and both ways the
// Task ends are asserted at that module (BuildSentenceTask.test.tsx). What is asserted here is the
// section's own: the intro copy, that every Task's Responses reach the server when the Task ends and
// survive a failed request, a reload or the User walking away, and the tab-leave flag.

vi.mock("../src/lib/api", () => {
  class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    HttpError,
    advanceFullTest: vi.fn(async () => ({})),
    listSets: vi.fn(async () => [{ id: "wri-sim-1" }]),
    listAttempts: vi.fn(async () => []),
    getSet: vi.fn(),
    getAttempt: vi.fn(async (id: string) => ({ attempt: { id, status: "in_progress" }, items: [] })),
    createAttempt: vi.fn(async () => ({ attemptId: "att-1", isRepeat: false })),
    completeAttempt: vi.fn(async () => ({})),
    flagAttempt: vi.fn(async () => ({})),
    scoreTask: vi.fn(),
    getScoreJob: vi.fn(async () => ({ status: "done" })),
    scoreDeterministicTask: vi.fn(async () => ({ items: [] })),
    routeAttempt: vi.fn(async () => ({ path: "lower" })),
    finishSpeakingCapture: vi.fn(async () => ({})),
    uploadItemAudio: vi.fn(async () => ({})),
    DeterministicAlreadyScoredError: class DeterministicAlreadyScoredError extends Error {},
  };
});

const EMAIL_SECONDS = 420;
const DISCUSSION_SECONDS = 600;

// See WritingDrill.test.tsx's own note: `kind` is what the page narrows the served Set on, and
// every Set the server can actually send carries one.
const set = {
  id: "wri-sim-1",
  kind: "writing",
  source: "generated",
  createdAt: "2026-01-01T00:00:00Z",
  buildASentence: {
    items: [
      {
        id: "bs-1",
        prompt: "Describe the museum visit.",
        frame: "The ___ ___ wonderful.",
        tiles: ["volunteers", "were", "was"],
      },
      {
        id: "bs-2",
        prompt: "Describe the museum.",
        frame: "The museum ___ ___ crowded.",
        tiles: ["was", "not", "were"],
      },
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

type Api = typeof import("../src/lib/api");
type Mock = ReturnType<typeof vi.fn>;
const mocked = (fn: unknown) => fn as Mock;

/** The displayed clock as whole seconds, so assertions tolerate sub-second scheduler drift. */
function remainingSeconds(): number {
  const [mm, ss] = (screen.getByRole("timer").textContent ?? "").split(":");
  return Number(mm) * 60 + Number(ss);
}

function renderSimulation() {
  return renderRoutes(
    [
      { path: "/", element: <p>home</p> },
      { path: "/simulate/:kind", element: <SimulationRun /> },
      { path: "/attempts/:id", element: <p>attempt report</p> },
    ],
    ["/", "/simulate/writing"],
  );
}

/** Intro → the Build a Sentence screen, with Item 1 on screen and the pooled clock running. */
async function beginSimulation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Start Writing Simulation" }));
  await screen.findByText("Describe the museum visit.");
}

/** Arranges Item 1 only and ends the Task — the email opens. */
async function finishBuildSentence(user: ReturnType<typeof userEvent.setup>) {
  await dragTile(user, "volunteers", { blank: 0 });
  await finishTask(user);
  await screen.findByRole("heading", { name: "Write an Email" });
}

async function writeAndSubmit(user: ReturnType<typeof userEvent.setup>, heading: string, text: string) {
  await screen.findByRole("heading", { name: heading });
  await user.type(screen.getByRole("textbox"), text);
  await user.click(screen.getByRole("button", { name: /^Submit/ }));
}

const sentTaskTypes = (api: Api) => mocked(api.scoreTask).mock.calls.map(([, body]) => body.taskType);

/** All three Tasks handed in and accepted, up to the wrap-up's first completion request. */
async function runToWrapUp(user: ReturnType<typeof userEvent.setup>) {
  const api = await import("../src/lib/api");
  await beginSimulation(user);
  await finishBuildSentence(user);
  await writeAndSubmit(user, "Write an Email", "Dear Professor.");
  await writeAndSubmit(user, "Academic Discussion", "Incentives matter.");
  await waitFor(() => expect(api.completeAttempt).toHaveBeenCalledTimes(1));
}

/** What fetch rejects with when nothing answers. */
const noAnswer = () => new TypeError("Failed to fetch");
/** A refusal shaped as lib/api.ts's HttpError. */
const refused = (status: number, reason: string) =>
  Object.assign(new Error(`${status}: ${JSON.stringify({ error: reason })}`), { status });

// Tiles are placed by dragging and by nothing else — see test/buildSentenceDrag.ts for the layout a
// drag needs in jsdom.
installTileDragLayout();

// The route loads its section Simulation as a lazy chunk. Loading it once up front keeps that
// first import out of the first test's findBy timeout.
beforeAll(async () => {
  await import("../src/pages/simulation/WritingSimulation");
});

describe("Writing Simulation", () => {
  let clock: ReturnType<typeof useFakeTimersInTest>;

  beforeEach(async () => {
    const api = await import("../src/lib/api");
    mocked(api.getSet).mockResolvedValue(set);
    mocked(api.scoreTask).mockImplementation(async (_id: string, body: { taskType: string }) =>
      body.taskType === "build_sentence" ? { items: [] } : { jobId: "job-1" },
    );
    // Re-stated per test: clearing a mock keeps its implementation, so one test's failing
    // completion would otherwise leak into every test after it.
    mocked(api.completeAttempt).mockResolvedValue({});
    mocked(api.advanceFullTest).mockResolvedValue({});
    window.sessionStorage.clear();
    clock = useFakeTimersInTest({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("describes the pooled budget on the intro screen, with no 40 seconds and no auto-advancing", async () => {
    renderSimulation();

    expect(
      await screen.findByText(/one shared 6:50 budget for all 2 Build a Sentence Items together/),
    ).toBeInTheDocument();
    expect(screen.getByText(/finish the Task early/)).toBeInTheDocument();
    expect(screen.getByText(/Items you never reached are left empty rather than marched through/)).toBeInTheDocument();

    const intro = document.body.textContent ?? "";
    expect(intro).not.toMatch(/40s|40 s|auto-advanc/i);
    // The budget is 410 s, so rounding it to minutes would promise a seventh minute that does not
    // exist. The intro states the clock reading the User will actually be racing.
    expect(intro).not.toMatch(/7-minute budget|6-minute budget/);
  });

  it("sends each Task's Responses as that Task ends, then completes and opens the report", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();
    await beginSimulation(user);
    await finishBuildSentence(user);

    // Build a Sentence is on the server before the email has a single word in it: every Item, in
    // Set order, the one never reached as empty.
    await waitFor(() => expect(sentTaskTypes(api)).toEqual(["build_sentence"]));
    expect(mocked(api.scoreTask).mock.calls[0][1].items).toEqual([
      { itemId: "bs-1", tileOrder: ["volunteers"] },
      { itemId: "bs-2", tileOrder: [] },
    ]);
    // The email gets its own full 7:00 — the Build a Sentence budget is not carried over.
    expect(remainingSeconds()).toBeGreaterThan(EMAIL_SECONDS - 5);

    await writeAndSubmit(user, "Write an Email", "Dear Professor, please grant me an extension.");
    await waitFor(() => expect(sentTaskTypes(api)).toEqual(["build_sentence", "email"]));
    expect(mocked(api.scoreTask).mock.calls[1][1].items[0]).toMatchObject({
      itemId: "em-1",
      text: "Dear Professor, please grant me an extension.",
    });

    await writeAndSubmit(user, "Academic Discussion", "I agree with Ana because incentives matter.");
    expect(await screen.findByText("attempt report")).toBeInTheDocument();
    expect(sentTaskTypes(api)).toEqual(["build_sentence", "email", "discussion"]);
    expect(api.completeAttempt).toHaveBeenCalledWith("att-1");
  });

  // The section's leave guard is the one reload prompt: Build a Sentence and the essay editor carry
  // none of their own, so it must be up on each Task's screen, with or without work on it yet.
  it("asks before a reload on every Task screen, from the first one on", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();
    await screen.findByRole("button", { name: "Start Writing Simulation" });
    expect(unload()).toBe(false);

    await beginSimulation(user);
    expect(unload()).toBe(true);

    await finishBuildSentence(user);
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(unload()).toBe(true);
  });

  it("retries a send that fails in transit, within its budget, without the User noticing", async () => {
    const api = await import("../src/lib/api");
    let emailFailures = 2;
    mocked(api.scoreTask).mockImplementation(async (_id: string, body: { taskType: string }) => {
      if (body.taskType === "email" && emailFailures > 0) {
        emailFailures -= 1;
        throw new TypeError("Failed to fetch");
      }
      return body.taskType === "build_sentence" ? { items: [] } : { jobId: "job-1" };
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();
    await beginSimulation(user);
    await finishBuildSentence(user);
    await writeAndSubmit(user, "Write an Email", "Dear Professor.");
    await screen.findByRole("heading", { name: "Academic Discussion" });

    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
    }
    await waitFor(() => expect(sentTaskTypes(api).filter((t) => t === "email")).toHaveLength(3));
    expect(screen.queryByText(/haven't reached the server/)).toBeNull();
  });

  it("never completes ahead of a Response the server has not accepted: it says which, and sends it on Retry", async () => {
    const api = await import("../src/lib/api");
    const { HttpError } = api;
    let discussionAccepted = false;
    mocked(api.scoreTask).mockImplementation(async (_id: string, body: { taskType: string }) => {
      if (body.taskType === "discussion" && !discussionAccepted) throw new HttpError(500, "500: boom");
      return body.taskType === "build_sentence" ? { items: [] } : { jobId: "job-1" };
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();
    await beginSimulation(user);
    await finishBuildSentence(user);
    await writeAndSubmit(user, "Write an Email", "Dear Professor.");
    await writeAndSubmit(user, "Academic Discussion", "Incentives matter.");

    // The whole retry budget runs out on the discussion.
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(16_000);
      });
    }

    expect(await screen.findByRole("heading", { name: /haven't reached the server/ })).toBeInTheDocument();
    expect(screen.getByText("Academic Discussion")).toBeInTheDocument();
    expect(api.completeAttempt).not.toHaveBeenCalled();
    // Still something to lose: a reload is asked about.
    expect(unload()).toBe(true);

    discussionAccepted = true;
    await user.click(screen.getByRole("button", { name: "Retry sending" }));
    expect(await screen.findByText("attempt report")).toBeInTheDocument();
    expect(api.completeAttempt).toHaveBeenCalledTimes(1);
    expect(mocked(api.scoreTask).mock.calls.at(-1)?.[1]).toMatchObject({
      taskType: "discussion",
      items: [{ itemId: "ad-1", text: "Incentives matter." }],
    });
  });

  it("tells the User mid-section when a finished Task's Responses could not be sent", async () => {
    const api = await import("../src/lib/api");
    const { HttpError } = api;
    mocked(api.scoreTask).mockImplementation(async (_id: string, body: { taskType: string }) => {
      if (body.taskType === "build_sentence") throw new HttpError(404, "404: unknown attempt");
      return { jobId: "job-1" };
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();
    await beginSimulation(user);
    await finishBuildSentence(user);

    expect(await screen.findByText(/Build a Sentence .* haven't reached the server/)).toBeInTheDocument();
    // The email's clock keeps running regardless.
    expect(remainingSeconds()).toBeGreaterThan(EMAIL_SECONDS - 5);
  });

  it("keeps sending, and completes, after the User leaves the wrap-up screen", async () => {
    const api = await import("../src/lib/api");
    let landDiscussion!: () => void;
    mocked(api.scoreTask).mockImplementation(async (_id: string, body: { taskType: string }) => {
      if (body.taskType === "discussion") {
        await new Promise<void>((resolve) => {
          landDiscussion = resolve;
        });
      }
      return body.taskType === "build_sentence" ? { items: [] } : { jobId: "job-1" };
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { router } = renderSimulation();
    await beginSimulation(user);
    await finishBuildSentence(user);
    await writeAndSubmit(user, "Write an Email", "Dear Professor.");
    await writeAndSubmit(user, "Academic Discussion", "Incentives matter.");
    await screen.findByRole("heading", { name: "Wrapping up…" });

    await act(async () => {
      await router.navigate(-1);
    });
    await user.click(within(await findLeavePrompt()).getByRole("button", { name: "Leave" }));
    expect(await screen.findByText("home")).toBeInTheDocument();
    expect(api.completeAttempt).not.toHaveBeenCalled();

    await act(async () => {
      landDiscussion();
    });
    await waitFor(() => expect(api.completeAttempt).toHaveBeenCalledWith("att-1"));
  });

  it("retries a completion that fails in transit before it opens the report", async () => {
    const api = await import("../src/lib/api");
    mocked(api.completeAttempt).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();
    await beginSimulation(user);
    await finishBuildSentence(user);
    await writeAndSubmit(user, "Write an Email", "Dear Professor.");
    await writeAndSubmit(user, "Academic Discussion", "Incentives matter.");
    await waitFor(() => expect(api.completeAttempt).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(await screen.findByText("attempt report")).toBeInTheDocument();
    expect(api.completeAttempt).toHaveBeenCalledTimes(2);
  });

  // Completing is what gives the Attempt its Band Estimate and, inside a Full-Test Run, what makes
  // the section finished: a completion that cannot be made is shown, never passed over.
  describe("completing the Attempt", () => {
    it("stays on the wrap-up when the completion keeps failing, keeps the draft and the guard, and Retry completes it", async () => {
      const api = await import("../src/lib/api");
      mocked(api.completeAttempt).mockRejectedValue(noAnswer());
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
      expect(screen.getByText(/Every Response reached the server and is safe/)).toBeInTheDocument();
      expect(screen.queryByText("attempt report")).toBeNull();
      // The draft session still holds the wrap-up, so coming back to this page finishes it.
      expect(readWritingSession("standalone")).toMatchObject({ attemptId: "att-1", task: "finishing" });

      // The Attempt is still unfinished, so leaving still asks, in this screen's own words.
      expect(unload()).toBe(true);
      await act(async () => {
        await router.navigate(-1);
      });
      const prompt = await findLeavePrompt();
      expect(prompt).toHaveTextContent(/Leave before the Writing Attempt is finished\?/);
      await user.click(within(prompt).getByRole("button", { name: "Stay" }));

      const callsSoFar = mocked(api.completeAttempt).mock.calls.length;
      mocked(api.completeAttempt).mockResolvedValue({});
      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("attempt report")).toBeInTheDocument();
      expect(api.completeAttempt).toHaveBeenCalledTimes(callsSoFar + 1);
      // No Response was sent twice: the Retry re-ran only the completion.
      expect(sentTaskTypes(api)).toEqual(["build_sentence", "email", "discussion"]);
      expect(readWritingSession("standalone")).toBeNull();
    });

    it("counts a refusal saying the Attempt is already completed as done", async () => {
      const api = await import("../src/lib/api");
      mocked(api.completeAttempt).mockRejectedValueOnce(refused(409, "attempt is already completed"));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSimulation();
      await runToWrapUp(user);

      expect(await screen.findByText("attempt report")).toBeInTheDocument();
      expect(api.completeAttempt).toHaveBeenCalledTimes(1);
      expect(readWritingSession("standalone")).toBeNull();
    });

    // Any other refusal cannot be fixed by sending again: it is shown at once, and the report as it
    // stands is the way out, which lets the draft session go.
    it("shows any other refusal at once and opens the report as it stands on request", async () => {
      const api = await import("../src/lib/api");
      mocked(api.completeAttempt).mockRejectedValue(refused(409, "attempt is aborted"));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSimulation();
      await runToWrapUp(user);

      expect(await screen.findByRole("heading", { name: "Couldn't finish this Attempt" })).toBeInTheDocument();
      expect(screen.getByText("The request was refused: attempt is aborted.")).toBeInTheDocument();
      expect(api.completeAttempt).toHaveBeenCalledTimes(1);

      await user.click(screen.getByRole("button", { name: "Open the report as it stands" }));
      expect(await screen.findByText("attempt report")).toBeInTheDocument();
      expect(api.completeAttempt).toHaveBeenCalledTimes(1);
      expect(readWritingSession("standalone")).toBeNull();
    });

    it("inside a Full-Test Run, advances the Run only once the completion has succeeded", async () => {
      const api = await import("../src/lib/api");
      mocked(api.completeAttempt).mockRejectedValue(noAnswer());
      const advance = deferred<Awaited<ReturnType<Api["advanceFullTest"]>>>();
      mocked(api.advanceFullTest).mockReturnValue(advance.promise);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderRoutes(
        [
          { path: "/full-test/:runId", element: <p>run page</p> },
          {
            path: "/full-test/:runId/writing",
            element: <WritingSimulation fullTest={{ runId: "run-1", setId: "wri-sim-1", attemptId: null }} />,
          },
          { path: "/attempts/:id", element: <p>attempt report</p> },
        ],
        ["/full-test/run-1", "/full-test/run-1/writing"],
      );
      await runToWrapUp(user);
      await act(async () => {
        await clock.advanceBy(40_000);
      });

      expect(await screen.findByRole("heading", { name: "Couldn't finish this Attempt" })).toBeInTheDocument();
      expect(screen.getByText(/what lets the Full-Test Run go on to the next section/)).toBeInTheDocument();
      expect(api.advanceFullTest).not.toHaveBeenCalled();
      expect(screen.queryByText("run page")).toBeNull();
      expect(readWritingSession("run-1")).toMatchObject({ attemptId: "att-1", task: "finishing" });

      mocked(api.completeAttempt).mockResolvedValue({});
      await user.click(screen.getByRole("button", { name: "Retry" }));
      await waitFor(() => expect(api.advanceFullTest).toHaveBeenCalledWith("run-1"));
      const lastCompletion = mocked(api.completeAttempt).mock.invocationCallOrder.at(-1)!;
      expect(mocked(api.advanceFullTest).mock.invocationCallOrder[0]).toBeGreaterThan(lastCompletion);

      await act(async () => {
        advance.resolve({} as Awaited<ReturnType<Api["advanceFullTest"]>>);
      });
      expect(await screen.findByText("run page")).toBeInTheDocument();
    });
  });

  it("picks the same Attempt back up after a reload, with the email draft and its clock", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const first = renderSimulation();
    await beginSimulation(user);
    await finishBuildSentence(user);
    await user.type(screen.getByRole("textbox"), "Dear Professor, I am writing");
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    first.unmount();

    renderSimulation();
    expect(await screen.findByRole("heading", { name: "Write an Email" })).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Dear Professor, I am writing");
    expect(remainingSeconds()).toBeLessThan(EMAIL_SECONDS - 55);
    expect(api.createAttempt).toHaveBeenCalledTimes(1);
    // Coming back is leaving the section, as far as the Attempt's record is concerned.
    expect(api.flagAttempt).toHaveBeenCalledWith("att-1");
  });

  it("hands in a Task whose clock ran out while the page was away, and opens the next one", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const first = renderSimulation();
    await beginSimulation(user);
    await finishBuildSentence(user);
    await user.type(screen.getByRole("textbox"), "Dear Professor.");
    first.unmount();

    vi.setSystemTime(Date.now() + (EMAIL_SECONDS + 60) * 1000);
    renderSimulation();

    expect(await screen.findByRole("heading", { name: "Academic Discussion" })).toBeInTheDocument();
    expect(remainingSeconds()).toBeGreaterThan(DISCUSSION_SECONDS - 5);
    await waitFor(() => expect(sentTaskTypes(api)).toContain("email"));
    expect(mocked(api.scoreTask).mock.calls.find(([, body]) => body.taskType === "email")?.[1].items).toEqual([
      { itemId: "em-1", text: "Dear Professor.", secondsUsed: EMAIL_SECONDS },
    ]);
  });

  it("restores Build a Sentence by tile text, though the tray comes back in a new order", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const first = renderSimulation();
    await beginSimulation(user);
    await dragTile(user, "volunteers", { blank: 0 });
    first.unmount();

    // GET /api/sets/:id serves the tiles in a fresh order on every request.
    const reserved = structuredClone(set);
    reserved.buildASentence.items[0].tiles = ["was", "were", "volunteers"];
    mocked(api.getSet).mockResolvedValue(reserved);
    renderSimulation();

    expect(await screen.findByLabelText('Blank 1, filled with "volunteers"')).toBeInTheDocument();
    await finishTask(user);
    await waitFor(() =>
      expect(mocked(api.scoreTask).mock.calls[0]?.[1].items[0]).toEqual({ itemId: "bs-1", tileOrder: ["volunteers"] }),
    );
  });

  it("guards the Start button against a second click while the Attempt is being created", async () => {
    const api = await import("../src/lib/api");
    let created!: (value: { attemptId: string; isRepeat: boolean }) => void;
    mocked(api.createAttempt).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          created = resolve;
        }),
    );
    renderSimulation();
    const begin = await screen.findByRole("button", { name: "Start Writing Simulation" });
    fireEvent.click(begin);
    fireEvent.click(begin);
    expect(api.createAttempt).toHaveBeenCalledTimes(1);
    await act(async () => {
      created({ attemptId: "att-1", isRepeat: false });
    });
    await screen.findByText("Describe the museum visit.");
  });

  it("still flags the Attempt when the tab is left mid-Task", async () => {
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
});
