import { describe, expect, it, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { FakeAudioElement, audioBySrc } from "./fakeAudio";
import { useFakeTimersInTest } from "./fakeTimers";
import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { findLeavePrompt, renderRoutes, unload } from "./dataRouter";
import { deferred } from "./deferred";
import { RESPONSE_WINDOW_RAMP, SpeakingSetSchema, stripAnswers } from "@toefl-prep/shared";
import SpeakingSimulation from "../src/pages/simulation/SpeakingSimulation";

// The Speaking Simulation is its own module, mounted directly behind a mocked api client, as
// WritingSimulation.test.tsx does.
//
// SpeakingInterviewIntro.test.tsx drives this same flow through SimulationRun to check the
// intro-in-print rule, so it also covers SimulationRun's speaking fork. This file asserts the
// section's own continuous shape: the gates before the exam clock starts, the L&R -> interview
// pipelining fire, and the finishing sequence's capture marker and hand-off to the report. It
// checks only the sequence's observable outcome, so a restructure that keeps the outcome keeps
// this test.

vi.mock("../src/lib/api", () => ({
  // Imported by the shared simulationShell.ts and never called by a standalone Speaking
  // Simulation, but the mock must still carry every export the module graph pulls in.
  advanceFullTest: vi.fn(async () => ({})),
  listSets: vi.fn(async () => [{ id: "spk-sim-1" }]),
  listAttempts: vi.fn(async () => []),
  getSet: vi.fn(),
  createAttempt: vi.fn(async () => ({ attemptId: "att-1", isRepeat: false })),
  completeAttempt: vi.fn(async () => ({})),
  flagAttempt: vi.fn(async () => ({})),
  scoreTask: vi.fn(async () => ({ jobId: "job-1" })),
  getScoreJob: vi.fn(async () => ({ status: "done" })),
  scoreDeterministicTask: vi.fn(async () => ({ items: [] })),
  routeAttempt: vi.fn(async () => ({ path: "lower" })),
  finishSpeakingCapture: vi.fn(async () => ({})),
  uploadItemAudio: vi.fn(async () => ({ ok: true, data: { transcript: "a transcript" } })),
  DeterministicAlreadyScoredError: class DeterministicAlreadyScoredError extends Error {},
  HttpError: class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

// The mic check needs a real microphone; these tests only need its gate to open.
vi.mock("../src/components/MicCheck", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ onPass }: { onPass: () => void }) =>
      createElement("button", { type: "button", onClick: onPass }, "pass mic check"),
  };
});

// ItemRecorder owns stimulus playback + recording mechanics (ItemRecorder.test.tsx runs it for
// real). Here it is a click-through so the section can run continuously without a recorder, plus a
// button per callback the section hands it, so the section's answers to a failed prompt and a skip
// can be driven.
vi.mock("../src/components/ItemRecorder", async () => {
  const { createElement } = await import("react");
  return {
    default: ({
      item,
      onFinished,
      onStimulusGate,
      onSkip,
      stimulusAutoRetries,
    }: {
      item: { id: string };
      onFinished: (blob: Blob) => void;
      onStimulusGate?: () => void;
      onSkip?: () => void;
      stimulusAutoRetries?: number;
    }) =>
      createElement(
        "div",
        null,
        createElement(
          "button",
          { type: "button", onClick: () => onFinished(new Blob(["audio"], { type: "audio/webm" })) },
          `finish item ${item.id}`,
        ),
        onStimulusGate && createElement("button", { type: "button", onClick: onStimulusGate }, `prompt fails for ${item.id}`),
        onSkip && createElement("button", { type: "button", onClick: onSkip }, `skip item ${item.id}`),
        createElement("span", null, `prompt retries: ${stimulusAutoRetries ?? 0}`),
      ),
  };
});

// window.Audio is stubbed per file with fakeAudio.ts (never in client/test/setup.ts): play()
// resolves, and the test itself dispatches "ended" to end a listen-only beat.

const fullSet = SpeakingSetSchema.parse({
  id: "spk-sim-1",
  kind: "speaking",
  source: "generated",
  createdAt: "2026-01-01T00:00:00Z",
  listenAndRepeat: {
    scenarioTitle: "Garden tour",
    scenarioDescription: "A coordinator walks new volunteers through the community garden.",
    introAudio: "stimuli/spk-sim-1/lr-intro.mp3",
    items: RESPONSE_WINDOW_RAMP.map((responseWindowSec, i) => ({
      id: `lr-${i + 1}`,
      sentence: `Secret target sentence number ${i + 1}.`,
      audio: `stimuli/spk-sim-1/lr-${i + 1}.mp3`,
      responseWindowSec,
    })),
  },
  interview: {
    scenarioTitle: "Community garden interview",
    intro: "A local reporter wants to hear about your volunteering.",
    introAudio: "stimuli/spk-sim-1/int-intro.mp3",
    questions: (["factual", "experience", "opinion", "opinion"] as const).map((type, i) => ({
      id: `q-${i + 1}`,
      type,
      question: `Secret interview question ${i + 1}?`,
      audio: `stimuli/spk-sim-1/q-${i + 1}.mp3`,
      responseWindowSec: 45,
    })),
  },
});
// What GET /api/sets/:id actually serves pre-scoring — the page under test only ever sees this.
const servedSet = stripAnswers(fullSet);

function renderSimulation() {
  return renderRoutes(
    [
      { path: "/", element: <p>home</p> },
      { path: "/simulate/speaking", element: <SpeakingSimulation /> },
      { path: "/attempts/:id", element: <p>attempt report</p> },
    ],
    ["/", "/simulate/speaking"],
  );
}

/** Intro → mic check → Ready → the scenario briefing's own intro audio → the first L&R Item. */
async function beginSimulation(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Check your microphone" }));
  await user.click(screen.getByRole("button", { name: "pass mic check" }));
  await user.click(screen.getByRole("button", { name: "Start Speaking Simulation" }));
  await screen.findByText("Garden tour");
  await act(async () => {
    audioBySrc("lr-intro").dispatch("ended");
  });
  await screen.findByRole("button", { name: "finish item lr-1" });
}

const scoreTaskCalls = (api: typeof import("../src/lib/api")) =>
  (api.scoreTask as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([, body]) => body.taskType);

// The section drives the mic lifecycle itself, one acquire() for the whole section and release()
// at section end and on unmount, through the real useRecorder (ItemRecorder stays mocked; per-Item
// recording needs a real microphone and is that component's business). Same device-boundary fakes
// as SpeakingDrillRun.test.tsx: the two observables that matter are how many times the device was
// opened and whether its tracks were ended.
let openedTracks: Array<{ stop: ReturnType<typeof vi.fn> }>;
let getUserMedia: ReturnType<typeof vi.fn>;

// The route loads its section Simulation as a lazy chunk. Loading it once up front keeps that
// first import out of the first test's findBy timeout.
beforeAll(async () => {
  await import("../src/pages/simulation/SpeakingSimulation");
});

describe("Speaking Simulation", () => {
  beforeEach(async () => {
    const api = await import("../src/lib/api");
    (api.getSet as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(servedSet);
    // Re-stated per test: clearAllMocks keeps implementations, so one test's failing server would
    // otherwise leak into every test after it.
    (api.uploadItemAudio as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      ok: true,
      data: { transcript: "a transcript" },
    }));
    (api.finishSpeakingCapture as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (api.advanceFullTest as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    FakeAudioElement.instances = [];
    vi.stubGlobal("Audio", FakeAudioElement);
    openedTracks = [];
    getUserMedia = vi.fn(async () => {
      const tracks = [{ stop: vi.fn() }];
      openedTracks.push(...tracks);
      return { getTracks: () => tracks } as unknown as MediaStream;
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      writable: true,
      value: { getUserMedia },
    });
    // Just enough for useRecorder's support check — acquire() never constructs a MediaRecorder.
    vi.stubGlobal(
      "MediaRecorder",
      class {
        static isTypeSupported() {
          return true;
        }
      },
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("does not create the Attempt until the mic check and the Ready gate have both been passed", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup();
    renderSimulation();

    expect(await screen.findByText("Speaking Simulation")).toBeInTheDocument();
    expect(api.createAttempt).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Check your microphone" }));
    expect(api.createAttempt).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "pass mic check" }));
    expect(await screen.findByRole("button", { name: "Start Speaking Simulation" })).toBeInTheDocument();
    expect(api.createAttempt).not.toHaveBeenCalled();
    expect(FakeAudioElement.instances).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Start Speaking Simulation" }));
    expect(api.createAttempt).toHaveBeenCalledWith({ kind: "speaking", mode: "simulation", setId: "spk-sim-1" });
  });

  // Each step replaces the button that moved the section on; focus goes into the new step rather
  // than falling back to the page body (issue #24).
  it("moves keyboard focus into every new stage up to the first Item", async () => {
    const user = userEvent.setup();
    renderSimulation();
    const focusInStage = () => {
      expect(document.activeElement).not.toBe(document.body);
      expect(screen.getByRole("main").contains(document.activeElement)).toBe(true);
    };

    await user.click(await screen.findByRole("button", { name: "Check your microphone" }));
    await screen.findByRole("button", { name: "pass mic check" });
    focusInStage();

    await user.click(screen.getByRole("button", { name: "pass mic check" }));
    await screen.findByRole("button", { name: "Start Speaking Simulation" });
    expect(document.activeElement?.tagName).toBe("H1");
    focusInStage();

    await user.click(screen.getByRole("button", { name: "Start Speaking Simulation" }));
    expect(await screen.findByRole("heading", { name: "Garden tour" })).toBe(document.activeElement);

    await act(async () => {
      audioBySrc("lr-intro").dispatch("ended");
    });
    await screen.findByRole("button", { name: "finish item lr-1" });
    focusInStage();
  });

  it("runs the section continuously and pipelines the Listen and Repeat scoring job into the interview", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup();
    renderSimulation();
    await beginSimulation(user);

    // The seven L&R Items run back to back — nothing is scored while the section is still running.
    for (let i = 1; i <= 7; i += 1) {
      await user.click(await screen.findByRole("button", { name: `finish item lr-${i}` }));
      if (i < 7) expect(scoreTaskCalls(api)).toEqual([]);
    }

    // The L&R -> interview transition fires L&R's own scoring job, so it runs server-side for the
    // whole interview instead of waiting for section end.
    expect(await screen.findByText("A local reporter wants to hear about your volunteering.")).toBeInTheDocument();
    await vi.waitFor(() => expect(scoreTaskCalls(api)).toEqual(["listen_repeat"]));
    expect((api.scoreTask as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].items).toEqual(
      Array.from({ length: 7 }, (_, i) => ({ itemId: `lr-${i + 1}` })),
    );
    expect(api.finishSpeakingCapture).not.toHaveBeenCalled();
  });

  it("finishes by submitting the interview score, marking capture finished once, and opening the report", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup();
    renderSimulation();
    await beginSimulation(user);

    for (let i = 1; i <= 7; i += 1) {
      await user.click(await screen.findByRole("button", { name: `finish item lr-${i}` }));
    }
    await act(async () => {
      audioBySrc("int-intro").dispatch("ended");
    });
    for (let i = 1; i <= 4; i += 1) {
      await user.click(await screen.findByRole("button", { name: `finish item q-${i}` }));
    }

    expect(await screen.findByText("attempt report")).toBeInTheDocument();
    expect(scoreTaskCalls(api)).toEqual(["listen_repeat", "interview"]);
    // Nothing was lost, so the capture marker carries an empty failed-Item list, and the POST is
    // single-flighted no matter which branch of the finishing sequence reached it.
    expect(api.finishSpeakingCapture).toHaveBeenCalledTimes(1);
    expect(api.finishSpeakingCapture).toHaveBeenCalledWith("att-1", []);
    // Durable server-side reconciliation owns completion: this page never completes the Attempt.
    expect(api.completeAttempt).not.toHaveBeenCalled();
  });

  it("asks before leaving mid-section — reload and browser Back alike — and stays put when declined", async () => {
    const user = userEvent.setup();
    const { router } = renderSimulation();

    await screen.findByRole("button", { name: "Check your microphone" });
    expect(unload()).toBe(false);

    await beginSimulation(user);
    expect(unload()).toBe(true);

    await act(async () => {
      await router.navigate(-1);
    });
    const prompt = await findLeavePrompt();
    expect(prompt).toHaveTextContent(/starts the Speaking section again from the beginning/);
    await user.click(within(prompt).getByRole("button", { name: "Stay" }));
    expect(screen.getByRole("button", { name: "finish item lr-1" })).toBeInTheDocument();

    await act(async () => {
      await router.navigate(-1);
    });
    await user.click(within(await findLeavePrompt()).getByRole("button", { name: "Leave" }));
    expect(await screen.findByText("home")).toBeInTheDocument();
  });

  describe("a recording the server cannot take yet", () => {
    beforeEach(() => {
      useFakeTimersInTest({ shouldAdvanceTime: true });
    });

    async function runSection(user: ReturnType<typeof userEvent.setup>, whileInInterview: () => Promise<void>) {
      for (let i = 1; i <= 7; i += 1) {
        await user.click(await screen.findByRole("button", { name: `finish item lr-${i}` }));
      }
      await whileInInterview();
      await act(async () => {
        audioBySrc("int-intro").dispatch("ended");
      });
      for (let i = 1; i <= 4; i += 1) {
        await user.click(await screen.findByRole("button", { name: `finish item q-${i}` }));
      }
    }

    async function advance(ms: number) {
      for (let spent = 0; spent < ms; spent += 16_000) {
        await act(async () => {
          vi.advanceTimersByTime(16_000);
        });
      }
    }

    it("is kept for the whole section and sent before capture is marked finished", async () => {
      const api = await import("../src/lib/api");
      let serverUp = false;
      (api.uploadItemAudio as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        async (_attemptId: string, itemId: string) =>
          itemId === "lr-2" && !serverUp
            ? { ok: false, kind: "retryable", message: "upload failed (502)" }
            : { ok: true, data: { transcript: "a transcript" } },
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSimulation();
      await beginSimulation(user);

      await runSection(user, async () => {
        // Two minutes into the interview, far past one 30 s retry budget, and still refused.
        await advance(120_000);
        serverUp = true;
      });

      expect(await screen.findByText("attempt report")).toBeInTheDocument();
      expect(api.finishSpeakingCapture).toHaveBeenCalledWith("att-1", []);
      const listenRepeat = (api.scoreTask as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
        ([, body]) => body.taskType === "listen_repeat",
      );
      expect(listenRepeat?.[1].items).toContainEqual({ itemId: "lr-2" });
    });

    it("is reported as lost only once a last attempt after the section has also failed", async () => {
      const api = await import("../src/lib/api");
      (api.uploadItemAudio as unknown as ReturnType<typeof vi.fn>).mockImplementation(
        async (_attemptId: string, itemId: string) =>
          itemId === "lr-2"
            ? { ok: false, kind: "retryable", message: "upload failed (502)" }
            : { ok: true, data: { transcript: "a transcript" } },
      );
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSimulation();
      await beginSimulation(user);
      // A minute of interview: lr-2's first budget is long spent before the section ends.
      await runSection(user, () => advance(64_000));

      await screen.findByRole("heading", { name: "Wrapping up…" });
      const lr2Uploads = () =>
        (api.uploadItemAudio as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([, id]) => id === "lr-2").length;
      const triesBeforeWrapUp = lr2Uploads();
      // Not reported yet: it gets one more budget now that the section is over.
      expect(api.finishSpeakingCapture).not.toHaveBeenCalled();
      await advance(64_000);
      expect(lr2Uploads()).toBeGreaterThan(triesBeforeWrapUp);

      expect(await screen.findByText("attempt report")).toBeInTheDocument();
      expect(api.finishSpeakingCapture).toHaveBeenCalledWith("att-1", ["lr-2"]);
    });
  });

  // Without the capture marker the server never completes the Attempt, so a marker that cannot be
  // written is a failure of the wrap-up: shown, with Retry, and never handed off past.
  describe("closing the section", () => {
    let clock: ReturnType<typeof useFakeTimersInTest>;
    beforeEach(() => {
      clock = useFakeTimersInTest({ shouldAdvanceTime: true });
    });

    const noAnswer = () => new TypeError("Failed to fetch");
    const refused = (status: number, reason: string) =>
      Object.assign(new Error(`${status}: ${JSON.stringify({ error: reason })}`), { status });
    const markerCalls = (api: typeof import("../src/lib/api")) =>
      (api.finishSpeakingCapture as unknown as ReturnType<typeof vi.fn>).mock.calls;

    /** Every Item, straight through, up to the wrap-up's first capture marker. `skip` is skipped. */
    async function runToWrapUp(user: ReturnType<typeof userEvent.setup>, skip?: string) {
      const api = await import("../src/lib/api");
      await beginSimulation(user);
      for (let i = 1; i <= 7; i += 1) {
        const id = `lr-${i}`;
        await user.click(await screen.findByRole("button", { name: id === skip ? `skip item ${id}` : `finish item ${id}` }));
      }
      await act(async () => {
        audioBySrc("int-intro").dispatch("ended");
      });
      for (let i = 1; i <= 4; i += 1) {
        await user.click(await screen.findByRole("button", { name: `finish item q-${i}` }));
      }
      await vi.waitFor(() => expect(api.finishSpeakingCapture).toHaveBeenCalledTimes(1));
    }

    // A score request that never answers must not hold the wrap-up until its overall time runs out.
    it("gives a score request that never answers its own limit, then sends it again", async () => {
      const api = await import("../src/lib/api");
      let interviewSends = 0;
      (api.scoreTask as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (_attemptId: string, body: { taskType: string }) => {
        if (body.taskType === "interview" && (interviewSends += 1) === 1) return new Promise(() => {});
        return { jobId: "job-1" };
      });
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSimulation();
      await beginSimulation(user);
      for (let i = 1; i <= 7; i += 1) {
        await user.click(await screen.findByRole("button", { name: `finish item lr-${i}` }));
      }
      await act(async () => {
        audioBySrc("int-intro").dispatch("ended");
      });
      for (let i = 1; i <= 4; i += 1) {
        await user.click(await screen.findByRole("button", { name: `finish item q-${i}` }));
      }
      await vi.waitFor(() => expect(scoreTaskCalls(api)).toEqual(["listen_repeat", "interview"]));
      expect(api.finishSpeakingCapture).not.toHaveBeenCalled();

      await act(async () => {
        await clock.advanceBy(20_000);
      });
      expect(await screen.findByText("attempt report")).toBeInTheDocument();
      expect(scoreTaskCalls(api)).toEqual(["listen_repeat", "interview", "interview"]);
      expect(api.finishSpeakingCapture).toHaveBeenCalledTimes(1);

      (api.scoreTask as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => ({ jobId: "job-1" }));
    });

    it("stays on the wrap-up when the marker keeps failing, and Retry writes it with nothing sent twice", async () => {
      const api = await import("../src/lib/api");
      (api.finishSpeakingCapture as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(noAnswer());
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
      expect(await screen.findByRole("heading", { name: "Couldn't close the Speaking section" })).toBeInTheDocument();
      expect(screen.getByText("Can't reach the server. Is it running?")).toBeInTheDocument();
      expect(screen.getByText(/Every recording reached the server and is safe/)).toBeInTheDocument();
      expect(screen.queryByText("attempt report")).toBeNull();

      expect(unload()).toBe(true);
      await act(async () => {
        await router.navigate(-1);
      });
      const prompt = await findLeavePrompt();
      expect(prompt).toHaveTextContent(/Leave before the Speaking section is closed\?/);
      await user.click(within(prompt).getByRole("button", { name: "Stay" }));

      const uploadsSoFar = (api.uploadItemAudio as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
      const markersSoFar = markerCalls(api).length;
      (api.finishSpeakingCapture as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("attempt report")).toBeInTheDocument();
      expect(markerCalls(api)).toHaveLength(markersSoFar + 1);
      expect(markerCalls(api).at(-1)).toEqual(["att-1", []]);
      // The Retry re-sent only the marker: no recording again, no second score request.
      expect((api.uploadItemAudio as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(uploadsSoFar);
      expect(scoreTaskCalls(api)).toEqual(["listen_repeat", "interview"]);
    });

    // An Item with no recording on the server keeps today's handling: the marker names it, every
    // time. The screen says so rather than calling every recording safe, and does not send the User
    // to Finish and score as if it were the same: that closes the section without the marker's list,
    // so the server would count the Item as a skip scored 0.
    it("says when an Item has no recording on the server, and names it again on Retry", async () => {
      const api = await import("../src/lib/api");
      (api.finishSpeakingCapture as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(refused(409, "attempt is aborted"));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { router } = renderSimulation();
      await runToWrapUp(user, "lr-1");

      expect(await screen.findByRole("heading", { name: "Couldn't close the Speaking section" })).toBeInTheDocument();
      expect(screen.getByText("The request was refused: attempt is aborted.")).toBeInTheDocument();
      expect(screen.getByText(/The recordings that reached the server are safe\. 1 Item has no recording there\./)).toBeInTheDocument();
      expect(screen.queryByText(/Every recording reached the server/)).toBeNull();
      expect(
        screen.getByText(
          "The report as it stands shows the Attempt unfinished. Retry closes it with the Item with no recording marked as never received. Finish and score, on the Progress page, would count it as skipped and score it 0.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Finish and score, on the Progress page, finishes it later/)).toBeNull();

      await act(async () => {
        await router.navigate(-1);
      });
      const prompt = await findLeavePrompt();
      expect(prompt).toHaveTextContent(/would count it as skipped and score it 0/);
      expect(prompt).not.toHaveTextContent(/finishes it later/);
      await user.click(within(prompt).getByRole("button", { name: "Stay" }));

      (api.finishSpeakingCapture as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
      await user.click(screen.getByRole("button", { name: "Retry" }));
      expect(await screen.findByText("attempt report")).toBeInTheDocument();
      expect(markerCalls(api)).toEqual([
        ["att-1", ["lr-1"]],
        ["att-1", ["lr-1"]],
      ]);
    });

    it("opens the report as it stands on request, without writing the marker again", async () => {
      const api = await import("../src/lib/api");
      (api.finishSpeakingCapture as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(refused(409, "attempt is aborted"));
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderSimulation();
      await runToWrapUp(user);

      await user.click(await screen.findByRole("button", { name: "Open the report as it stands" }));
      expect(await screen.findByText("attempt report")).toBeInTheDocument();
      expect(markerCalls(api)).toHaveLength(1);
    });

    it("inside a Full-Test Run, advances the Run only once the marker is written", async () => {
      const api = await import("../src/lib/api");
      (api.finishSpeakingCapture as unknown as ReturnType<typeof vi.fn>).mockRejectedValue(noAnswer());
      const advance = deferred<Awaited<ReturnType<typeof api.advanceFullTest>>>();
      (api.advanceFullTest as unknown as ReturnType<typeof vi.fn>).mockReturnValue(advance.promise);
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      renderRoutes(
        [
          { path: "/full-test/:runId", element: <p>run page</p> },
          {
            path: "/full-test/:runId/speaking",
            element: <SpeakingSimulation fullTest={{ runId: "run-1", setId: "spk-sim-1", attemptId: null }} />,
          },
          { path: "/attempts/:id", element: <p>attempt report</p> },
        ],
        ["/full-test/run-1", "/full-test/run-1/speaking"],
      );
      await runToWrapUp(user);
      await act(async () => {
        await clock.advanceBy(40_000);
      });

      expect(await screen.findByRole("heading", { name: "Couldn't close the Speaking section" })).toBeInTheDocument();
      expect(screen.getByText(/what lets the Full-Test Run go on to the next section/)).toBeInTheDocument();
      expect(api.advanceFullTest).not.toHaveBeenCalled();
      expect(screen.queryByText("run page")).toBeNull();

      (api.finishSpeakingCapture as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
      await user.click(screen.getByRole("button", { name: "Retry" }));
      await vi.waitFor(() => expect(api.advanceFullTest).toHaveBeenCalledWith("run-1"));
      const lastMarker = (api.finishSpeakingCapture as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder.at(-1)!;
      expect((api.advanceFullTest as unknown as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeGreaterThan(lastMarker);

      await act(async () => {
        advance.resolve({} as Awaited<ReturnType<typeof api.advanceFullTest>>);
      });
      expect(await screen.findByText("run page")).toBeInTheDocument();
    });
  });

  // A prompt that will not play is the app's failure, never the User's: the Item retries it before
  // gating, the gate flags the Attempt as a tab switch would, and an Item skipped from there is
  // reported with the recordings that could not be captured: labeled failed, not scored 0.
  it("treats a prompt that will not play as the app's failure, not the User's", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup();
    renderSimulation();
    await beginSimulation(user);

    expect(screen.getByText(/prompt retries: [1-9]/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "prompt fails for lr-1" }));
    expect(api.flagAttempt).toHaveBeenCalledWith("att-1");

    await user.click(screen.getByRole("button", { name: "skip item lr-1" }));
    for (let i = 2; i <= 7; i += 1) {
      await user.click(await screen.findByRole("button", { name: `finish item lr-${i}` }));
    }
    await act(async () => {
      audioBySrc("int-intro").dispatch("ended");
    });
    for (let i = 1; i <= 4; i += 1) {
      await user.click(await screen.findByRole("button", { name: `finish item q-${i}` }));
    }

    expect(await screen.findByText("attempt report")).toBeInTheDocument();
    expect(api.finishSpeakingCapture).toHaveBeenCalledWith("att-1", ["lr-1"]);
    expect(api.uploadItemAudio).not.toHaveBeenCalledWith("att-1", "lr-1", expect.anything());
    const listenRepeat = (api.scoreTask as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      ([, body]) => body.taskType === "listen_repeat",
    );
    expect(listenRepeat?.[1].items).not.toContainEqual({ itemId: "lr-1" });
  });

  // During the wrap-up nothing restarts: the uploads and the capture marker keep going after the
  // page is left. The leave prompt must say that, not that the section starts over.
  it("says during the wrap-up that leaving does not stop the sending", async () => {
    const api = await import("../src/lib/api");
    (api.uploadItemAudio as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (_attemptId: string, itemId: string) =>
        itemId === "q-4" ? new Promise(() => {}) : { ok: true, data: { transcript: "a transcript" } },
    );
    const user = userEvent.setup();
    const { router } = renderSimulation();
    await beginSimulation(user);
    for (let i = 1; i <= 7; i += 1) {
      await user.click(await screen.findByRole("button", { name: `finish item lr-${i}` }));
    }
    await act(async () => {
      audioBySrc("int-intro").dispatch("ended");
    });
    for (let i = 1; i <= 4; i += 1) {
      await user.click(await screen.findByRole("button", { name: `finish item q-${i}` }));
    }
    await screen.findByRole("heading", { name: "Wrapping up…" });

    await act(async () => {
      await router.navigate(-1);
    });
    const prompt = await findLeavePrompt();
    expect(prompt).toHaveTextContent(/still being sent/);
    expect(prompt).not.toHaveTextContent(/starts the Speaking section again/);
  });

  it("still flags the Attempt when the tab is left mid-section", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup();
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

  // Opening and closing the device per Item engages macOS's deferred Voice Processing teardown,
  // which glitches the next Item's stimulus about a second in, so the section holds one stream for
  // the whole run, L&R and interview alike, and only lets go once nothing records any more.
  it("acquires the mic once for the whole section and releases it when the section finishes", async () => {
    const user = userEvent.setup();
    renderSimulation();
    await beginSimulation(user);

    // Entering the Item phase acquired the device exactly once, up front.
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    for (let i = 1; i <= 7; i += 1) {
      await user.click(await screen.findByRole("button", { name: `finish item lr-${i}` }));
      // Advancing between Items neither re-opens nor closes the device, the L&R->interview
      // transition included.
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(openedTracks[0].stop).not.toHaveBeenCalled();
    }
    await act(async () => {
      audioBySrc("int-intro").dispatch("ended");
    });
    for (let i = 1; i <= 4; i += 1) {
      await user.click(await screen.findByRole("button", { name: `finish item q-${i}` }));
    }

    // Section over: still that one acquisition, and the held stream was released (recording
    // indicator off through the finishing wait and on the report).
    expect(await screen.findByText("attempt report")).toBeInTheDocument();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(openedTracks[0].stop).toHaveBeenCalled();
  });

  it("releases the held mic stream when the section is abandoned mid-run", async () => {
    const user = userEvent.setup();
    const view = renderSimulation();
    await beginSimulation(user);

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await user.click(await screen.findByRole("button", { name: "finish item lr-1" }));
    expect(openedTracks[0].stop).not.toHaveBeenCalled();

    // Unmount without ever finishing — navigating away, closing the flow. The page's cleanup must
    // end the held tracks or the mic stays on with nothing left to release it.
    view.unmount();
    expect(openedTracks[0].stop).toHaveBeenCalled();
  });
});
