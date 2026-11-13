import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FakeAudioElement, audioBySrc, dispatchAudio, endAudio } from "./fakeAudio";
import { useFakeTimersInTest } from "./fakeTimers";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { findLeavePrompt, renderRoutes, unload } from "./dataRouter";
import type { ServedListeningSet } from "@toefl-prep/shared";
import ListeningSimulation from "../src/pages/simulation/ListeningSimulation";
import { START_TIMEOUT_MS } from "../src/components/StimulusPlayer";

// The Listening Simulation, mounted directly behind a mocked api client, as
// WritingSimulation.test.tsx does.
//
// The reducer's transitions are asserted without rendering anything in listeningSimulation.test.ts,
// and the gate that keeps options out of the DOM until the audio ends (components/
// StimulusQuestions.tsx, shared with the Drill) in StimulusQuestions.test.tsx. What is worth
// asserting here is what the wiring can get wrong: the lockstep beat (avatar settles -> the Stimulus
// plays once -> only then its Question) reaching the DOM, a whole routed Attempt running end to end,
// and leaving the tab still flagging the Attempt.

vi.mock("../src/lib/api", () => ({
  // Imported by simulationShell.ts for the Full-Test hand-off. A standalone run never calls it, but
  // the mock must carry every export the module graph pulls in.
  advanceFullTest: vi.fn(async () => ({})),
  listSets: vi.fn(async () => [{ id: "lsn-sim-1" }]),
  listAttempts: vi.fn(async () => []),
  getSet: vi.fn(),
  createAttempt: vi.fn(async () => ({ attemptId: "att-1", isRepeat: false })),
  completeAttempt: vi.fn(async () => ({})),
  flagAttempt: vi.fn(async () => ({})),
  scoreTask: vi.fn(async () => ({ jobId: "job-1" })),
  getScoreJob: vi.fn(async () => ({ status: "done" })),
  scoreDeterministicTask: vi.fn(async () => ({ items: [] })),
  routeAttempt: vi.fn(async () => ({ path: "upper" })),
  finishSpeakingCapture: vi.fn(async () => ({})),
  uploadItemAudio: vi.fn(async () => ({})),
  DeterministicAlreadyScoredError: class DeterministicAlreadyScoredError extends Error {},
}));

// window.Audio is stubbed per file with fakeAudio.ts (never in client/test/setup.ts, where it would
// change every other test's global): play() resolves, and the test itself dispatches "ended" to end
// a Stimulus.

// AVATAR_SETTLE_MS in components/StimulusQuestions.tsx. The section has no Module clock: the audio
// paces it.
const AVATAR_SETTLE_MS = 1500;

const set: ServedListeningSet = {
  id: "lsn-sim-1",
  kind: "listening",
  source: "generated",
  createdAt: "2026-01-01T00:00:00.000Z",
  router: {
    timeLimitSec: 1700,
    listenChoose: [
      {
        id: "lc-r1",
        taskType: "listen_choose",
        audio: "stimuli/lsn-sim-1/lc-r1.mp3",
        speaker: { id: "sp-1", role: "student", gender: "male", accent: "north-american" },
        options: [
          { id: "a", text: "Router LCR option A" },
          { id: "b", text: "Router LCR option B" },
        ],
      },
    ],
    conversations: [
      {
        id: "cv-r1",
        taskType: "conversation",
        audio: "stimuli/lsn-sim-1/cv-r1.mp3",
        setting: "campus bookstore",
        speakers: [
          { id: "sp-2", role: "student", gender: "female", accent: "british" },
          { id: "sp-3", role: "clerk", gender: "male", accent: "australian" },
        ],
        questions: [
          {
            id: "cv-r1-q1",
            stem: "What does the student want?",
            options: [
              { id: "a", text: "A refund" },
              { id: "b", text: "A textbook" },
            ],
          },
          {
            id: "cv-r1-q2",
            stem: "What will the clerk do next?",
            options: [
              { id: "a", text: "Check the stockroom" },
              { id: "b", text: "Close the shop" },
            ],
          },
        ],
      },
    ],
    announcements: [],
    academicTalks: [],
  },
  lowerModule: { timeLimitSec: 900, listenChoose: [], conversations: [], announcements: [], academicTalks: [] },
  upperModule: {
    timeLimitSec: 900,
    listenChoose: [
      {
        id: "lc-u1",
        taskType: "listen_choose",
        audio: "stimuli/lsn-sim-1/lc-u1.mp3",
        speaker: { id: "sp-4", role: "professor", gender: "male", accent: "british" },
        options: [
          { id: "a", text: "Upper LCR option A" },
          { id: "b", text: "Upper LCR option B" },
        ],
      },
    ],
    conversations: [],
    announcements: [],
    academicTalks: [],
  },
};

function renderSimulation() {
  return renderRoutes(
    [
      { path: "/", element: <p>home</p> },
      { path: "/simulate/listening", element: <ListeningSimulation /> },
      { path: "/attempts/:id", element: <p>attempt report</p> },
    ],
    ["/", "/simulate/listening"],
  );
}

/**
 * Clicks Start and lets everything it sets in motion land inside one act(). The click's handler
 * awaits createAttempt before it renders the first avatar beat, so outside act() that render, and the
 * effect that arms the beat's settle timer, run on React's own scheduler. On a loaded machine that
 * can be after the test has already moved the clock past AVATAR_SETTLE_MS: the advance then passes a
 * timer that does not exist yet, and the Stimulus never starts playing. An async act() keeps flushing
 * work scheduled from microtasks, so the beat is on screen with its timer armed when this returns.
 *
 * fireEvent rather than user-event: user-event switches React's act environment off while it runs,
 * so a user-event click inside act() draws "not configured to support act" warnings.
 */
async function startSimulation() {
  const start = await screen.findByRole("button", { name: "Start Listening Simulation" });
  await act(async () => {
    fireEvent.click(start);
  });
}

/** Lets the avatar beat settle, then ends the named Stimulus's playback — the whole lockstep unit. */
async function playThrough(file: string) {
  await act(async () => {
    vi.advanceTimersByTime(AVATAR_SETTLE_MS);
  });
  await endAudio(file);
}

/** Both Modules, straight through on the Upper path, up to the wrap-up's first completion request. */
async function runToWrapUp(user: ReturnType<typeof userEvent.setup>) {
  const api = await import("../src/lib/api");
  await startSimulation();
  await screen.findByText("Stimulus 1 of 2");
  await playThrough("lc-r1.mp3");
  await user.click(await screen.findByLabelText("Router LCR option B"));
  await user.click(screen.getByRole("button", { name: "Next" }));
  await screen.findByText("Stimulus 2 of 2");
  await playThrough("cv-r1.mp3");
  await user.click(await screen.findByLabelText("A textbook"));
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.click(await screen.findByLabelText("Check the stockroom"));
  await user.click(screen.getByRole("button", { name: "Next" }));
  await user.click(await screen.findByRole("button", { name: "Start the Upper Module" }));
  await screen.findByText("Stimulus 1 of 1");
  await playThrough("lc-u1.mp3");
  await user.click(await screen.findByLabelText("Upper LCR option A"));
  await user.click(screen.getByRole("button", { name: "Next" }));
  await waitFor(() => expect(api.completeAttempt).toHaveBeenCalledTimes(1));
}

/** What fetch rejects with when nothing answers. */
const noAnswer = () => new TypeError("Failed to fetch");
/** A refusal shaped as lib/api.ts's HttpError, which this file's mock of it leaves out. */
const refused = (status: number, reason: string) =>
  Object.assign(new Error(`${status}: ${JSON.stringify({ error: reason })}`), { status });

describe("Listening Simulation", () => {
  let clock: ReturnType<typeof useFakeTimersInTest>;

  beforeEach(async () => {
    const api = await import("../src/lib/api");
    (api.getSet as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(set);
    // `vi.clearAllMocks()` keeps implementations, so a test's own completion failure is undone here.
    vi.mocked(api.completeAttempt).mockResolvedValue({});
    vi.mocked(api.advanceFullTest).mockResolvedValue({} as Awaited<ReturnType<typeof api.advanceFullTest>>);
    FakeAudioElement.instances = [];
    FakeAudioElement.nextPlayResult = "resolve";
    vi.stubGlobal("Audio", FakeAudioElement);
    clock = useFakeTimersInTest({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("runs a Stimulus in lockstep: avatar, then one play, then its Question — never earlier", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();

    await startSimulation();

    // Avatar beat: who is about to speak, and nothing of the Item itself.
    expect(await screen.findByTestId("avatar-card")).toBeInTheDocument();
    expect(FakeAudioElement.instances).toHaveLength(0);
    expect(screen.queryByText("Router LCR option A")).toBeNull();

    // The beat settles into playback — still no options on screen.
    await act(async () => {
      vi.advanceTimersByTime(AVATAR_SETTLE_MS);
    });
    expect(audioBySrc("lc-r1").src).toBe("/api/audio/stimuli/lsn-sim-1/lc-r1.mp3");
    expect(screen.queryByText("Router LCR option A")).toBeNull();

    // Only once the audio has ended does the Question appear — and the Stimulus played exactly once.
    await act(async () => {
      audioBySrc("lc-r1").dispatch("ended");
    });
    expect(await screen.findByText("Choose the best response.")).toBeInTheDocument();
    expect(screen.getByText("Router LCR option A")).toBeInTheDocument();
    expect(FakeAudioElement.instances.filter((a) => a.src.includes("lc-r1"))).toHaveLength(1);

    // No going back, and no advancing without a Response.
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    await user.click(screen.getByLabelText("Router LCR option B"));
    expect(screen.getByRole("button", { name: "Next" })).toBeEnabled();
  });

  it("runs the whole routed Attempt: Router Module → route → path reveal → Upper Module → report", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();

    await startSimulation();
    expect(await screen.findByText("Stimulus 1 of 2")).toBeInTheDocument();
    expect(screen.getByText("Router Module")).toBeInTheDocument();

    // Stimulus 1: Listen and Choose, one Item.
    await playThrough("lc-r1.mp3");
    await user.click(await screen.findByLabelText("Router LCR option B"));
    await user.click(screen.getByRole("button", { name: "Next" }));

    // Stimulus 2: a Conversation, two Items one at a time.
    await screen.findByText("Stimulus 2 of 2");
    await playThrough("cv-r1.mp3");
    await user.click(await screen.findByLabelText("A textbook"));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await user.click(await screen.findByLabelText("Check the stockroom"));
    await user.click(screen.getByRole("button", { name: "Next" }));

    // The Module's last Question submits it: every Task Type is scored, then the Attempt is routed.
    await screen.findByRole("heading", { name: "Module Path: Upper Module" });
    const scored = (api.scoreDeterministicTask as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(scored.map(([, req]) => req.taskType)).toEqual(["listen_choose", "conversation"]);
    expect(scored[0][1].items).toEqual([{ itemId: "lc-r1", selectedOptionId: "b" }]);
    expect(scored[1][1].items).toEqual([
      { itemId: "cv-r1-q1", selectedOptionId: "b" },
      { itemId: "cv-r1-q2", selectedOptionId: "a" },
    ]);
    expect(api.routeAttempt).toHaveBeenCalledTimes(1);

    // Continue starts the routed Module, which completes the Attempt and hands off to the report.
    await user.click(screen.getByRole("button", { name: "Start the Upper Module" }));
    await screen.findByText("Stimulus 1 of 1");
    expect(screen.getByText("Upper Module")).toBeInTheDocument();
    await playThrough("lc-u1.mp3");
    await user.click(await screen.findByLabelText("Upper LCR option A"));
    await user.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText("attempt report")).toBeInTheDocument();
    expect(api.completeAttempt).toHaveBeenCalledWith("att-1");
  });

  it("asks before leaving mid-section — reload and browser Back alike — and stays put when declined", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { router } = renderSimulation();

    await screen.findByRole("button", { name: "Start Listening Simulation" });
    expect(unload()).toBe(false);

    await startSimulation();
    await screen.findByTestId("avatar-card");
    expect(unload()).toBe(true);

    await act(async () => {
      await router.navigate(-1);
    });
    const prompt = await findLeavePrompt();
    expect(prompt).toHaveTextContent(/starts the Listening section again from the beginning/);
    await user.click(within(prompt).getByRole("button", { name: "Stay" }));
    expect(screen.getByTestId("avatar-card")).toBeInTheDocument();

    await act(async () => {
      await router.navigate(-1);
    });
    await user.click(within(await findLeavePrompt()).getByRole("button", { name: "Leave" }));
    expect(await screen.findByText("home")).toBeInTheDocument();
  });

  // A clip that will not play is the app's failure: it is reloaded, then the Stimulus waits on a
  // gate. Never skipped on its own, never scored as wrong, and the Attempt is flagged as interrupted.
  it("retries a Stimulus whose audio fails, then waits on a gate instead of skipping it", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderSimulation();
    await startSimulation();
    await act(async () => {
      vi.advanceTimersByTime(AVATAR_SETTLE_MS);
    });

    // The first failure and its automatic reloads, each on a fresh player: every error goes to the
    // element the latest reload created, never back to one that has already failed.
    for (let load = 1; load <= 3; load += 1) {
      await dispatchAudio("lc-r1.mp3", "error", load);
    }
    expect(FakeAudioElement.instances.filter((a) => a.src.includes("lc-r1"))).toHaveLength(3);

    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.getByText("Stimulus 1 of 2")).toBeInTheDocument();
    expect(screen.queryByText("Router LCR option A")).toBeNull();
    expect(api.flagAttempt).toHaveBeenCalledWith("att-1");
    expect(api.scoreDeterministicTask).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    await dispatchAudio("lc-r1.mp3", "ended", 4);
    expect(FakeAudioElement.instances.filter((a) => a.src.includes("lc-r1"))).toHaveLength(4);
    expect(await screen.findByText("Router LCR option A")).toBeInTheDocument();
  });

  // A request that is neither answered nor failed fires no error, so the player's start bound is what
  // turns it into a failed load: the same reloads, then the same gate.
  it("treats a Stimulus whose audio never starts as failed audio, after the start bound", async () => {
    FakeAudioElement.nextPlayResult = "pending";
    renderSimulation();
    await startSimulation();
    await act(async () => {
      vi.advanceTimersByTime(AVATAR_SETTLE_MS);
    });

    for (let load = 1; load <= 3; load += 1) {
      await waitFor(() => expect(FakeAudioElement.instances.filter((a) => a.src.includes("lc-r1"))).toHaveLength(load));
      await clock.advanceBy(START_TIMEOUT_MS - 100);
      expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
      await clock.advanceBy(100);
    }

    expect(await screen.findByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("Router LCR option A")).toBeNull();
    // Each held load was given up, so none of them can start playing over the gate later.
    expect(FakeAudioElement.instances.every((a) => a.sourceDropped)).toBe(true);
  });

  it("still flags the Attempt when the tab is left mid-Stimulus", async () => {
    const api = await import("../src/lib/api");
    renderSimulation();

    await startSimulation();
    await screen.findByTestId("avatar-card");

    // jsdom's own visibilityState lives on Document.prototype, so this shadows it with an own
    // property and removes it again rather than leaving the whole document "hidden" behind.
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    Reflect.deleteProperty(document, "visibilityState");
    expect(document.visibilityState).toBe("visible");

    expect(api.flagAttempt).toHaveBeenCalledWith("att-1");
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
      renderSimulation();
      await runToWrapUp(user);
      await act(async () => {
        await clock.advanceBy(40_000);
      });

      expect(await screen.findByRole("heading", { name: "Couldn't finish this Attempt" })).toBeInTheDocument();
      expect(screen.getByText("Can't reach the server. Is it running?")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Open the report as it stands" })).toBeInTheDocument();
      expect(screen.queryByText("attempt report")).toBeNull();
      expect(unload()).toBe(true);

      vi.mocked(api.completeAttempt).mockResolvedValue({});
      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("attempt report")).toBeInTheDocument();
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

    it("inside a Full-Test Run, advances the Run only once the completion has succeeded", async () => {
      const api = await import("../src/lib/api");
      vi.mocked(api.completeAttempt).mockRejectedValue(noAnswer());
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderRoutes(
        [
          { path: "/full-test/:runId", element: <p>run page</p> },
          {
            path: "/full-test/:runId/listening",
            element: <ListeningSimulation fullTest={{ runId: "run-1", setId: "lsn-sim-1", attemptId: null }} />,
          },
          { path: "/attempts/:id", element: <p>attempt report</p> },
        ],
        ["/full-test/run-1", "/full-test/run-1/listening"],
      );
      await runToWrapUp(user);
      await act(async () => {
        await clock.advanceBy(40_000);
      });

      expect(await screen.findByRole("heading", { name: "Couldn't finish this Attempt" })).toBeInTheDocument();
      expect(api.advanceFullTest).not.toHaveBeenCalled();
      expect(screen.queryByText("run page")).toBeNull();

      vi.mocked(api.completeAttempt).mockResolvedValue({});
      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("run page")).toBeInTheDocument();
      expect(api.advanceFullTest).toHaveBeenCalledWith("run-1");
      const lastCompletion = vi.mocked(api.completeAttempt).mock.invocationCallOrder.at(-1)!;
      expect(vi.mocked(api.advanceFullTest).mock.invocationCallOrder[0]).toBeGreaterThan(lastCompletion);
    });
  });
});
