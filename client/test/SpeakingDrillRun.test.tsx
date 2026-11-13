import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAudioElement, endAudio } from "./fakeAudio";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderRoutes } from "./dataRouter";
import SpeakingDrill from "../src/pages/SpeakingDrill";

// The Speaking Drill's own run body, the part that stays with the page because it genuinely differs
// from the other three Drills: record each Item, upload it, and only once every upload has settled
// hand the Task to scoring.
//
// The shell around it (loading, the picker, the Attempt and its Repeat tag, finish-and-navigate) is
// covered once for all four Drills in drillShell.test.tsx. This file only covers what that one
// cannot: which recordings reach the server, and which Items reach the scorer.
//
// The recorder itself is stubbed. `ItemRecorder`'s stimulus -> beep -> auto-record -> countdown
// choreography is its own component's business (and needs a real microphone and AudioContext to
// mean anything); what this file drives is the hand-off it makes, `onFinished(blob)`.

vi.mock("../src/lib/api", () => ({
  getSet: vi.fn(),
  createAttempt: vi.fn(async () => ({ attemptId: "att-1", isRepeat: false })),
  completeAttempt: vi.fn(async () => ({})),
  scoreTask: vi.fn(async () => ({ jobId: "job-1" })),
  uploadItemAudio: vi.fn(async () => ({ ok: true, data: { transcript: "a transcript" } })),
}));

// What the mocked job ends with: done with no result unless a test sets one.
const scoringJobEnd = vi.hoisted(() => ({ status: "done" as string, result: null as unknown }));

// Terminal from the start: the job's own lifecycle is useScoringJob's business, and a job stuck
// "running" would only gate the Finish button.
//
// The mock fires `start` once per mount, exactly as the real hook does (usePolledJob's `hasBegunRef`
// guard inside a `[]`-deps effect). That is what makes the POST /score assertions below mean
// anything, and it reproduces the property without pulling in the poll loop.
vi.mock("../src/hooks/useScoringJob", async () => {
  const { useEffect, useRef } = await import("react");
  return {
  useScoringJob: (_attemptId: string, args?: { start?: () => Promise<{ jobId: string }> }) => {
    const begun = useRef(false);
    useEffect(() => {
      if (begun.current) return;
      begun.current = true;
      void args?.start?.();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return {
    status: scoringJobEnd.status,
    stage: null,
    judgesDone: [],
    judgesFailed: [],
    openaiJudgeProvider: null,
    arbiterProvider: null,
    fallbackFrom: null,
    queuePosition: null,
    elapsedMs: 0,
    result: scoringJobEnd.result,
    error: null,
    cancellationRequestedAt: null,
    terminalAt: null,
    cancellationReason: null,
    retry: () => {},
    };
  },
  };
});

vi.mock("../src/components/MicCheck", () => ({
  default: ({ onPass }: { onPass: () => void }) => (
    <button type="button" onClick={onPass}>
      mic ok
    </button>
  ),
}));

// Faithful to the real component in the one way this file depends on: it is keyed by Item id at the
// call site, so each Item gets its own instance and hands back its own Blob.
vi.mock("../src/components/ItemRecorder", () => ({
  default: ({ item, onFinished }: { item: { id: string }; onFinished: (blob: Blob) => void }) => (
    <button type="button" onClick={() => onFinished(new Blob([item.id]))}>
      finish {item.id}
    </button>
  ),
}));

const speakingSet = {
  id: "spk-1",
  kind: "speaking",
  source: "generated",
  createdAt: "2026-01-01T00:00:00Z",
  listenAndRepeat: {
    scenarioTitle: "At the campus café",
    scenarioDescription: "You are ordering coffee.",
    introAudio: "stimuli/spk-1/intro.mp3",
    items: [{ id: "lr-1", audio: "stimuli/spk-1/lr-1.mp3", responseWindowSec: 10 }],
  },
  interview: {
    scenarioTitle: "Student services interview",
    intro: "A few questions about campus life.",
    introAudio: "stimuli/spk-1/int-intro.mp3",
    questions: [
      { id: "iv-1", audio: "stimuli/spk-1/iv-1.mp3", responseWindowSec: 45 },
      { id: "iv-2", audio: "stimuli/spk-1/iv-2.mp3", responseWindowSec: 45 },
    ],
  },
};

/** Picker → the interview's first Item, which is where every test below starts. */
async function startInterview(user: ReturnType<typeof userEvent.setup>) {
  const view = renderRoutes(
    [
      { path: "/", element: <p>dashboard</p> },
      { path: "/attempts/:id", element: <p>attempt report</p> },
      { path: "/speaking/:setId", element: <SpeakingDrill /> },
    ],
    "/speaking/spk-1",
  );
  await user.click(await screen.findByText("Interview"));
  await user.click(await screen.findByRole("button", { name: "mic ok" }));
  await user.click(await screen.findByRole("button", { name: "Start Speaking Drill" }));
  // The interview intro beat plays before the first Item.
  await endAudio("int-intro.mp3");
  return view;
}

/**
 * The body of the task's one scoring request, once it has been sent. The results screen's slot sends
 * it from a mount effect, and React can run that effect a task after the "Results" heading is in the
 * DOM, later still on a loaded machine. Reading `scoreTask`'s calls as soon as the heading shows can
 * therefore find none yet, and a request that only fires as the test is torn down lands in the next
 * test's calls instead.
 */
/** Every player in `root`, as its accessible name and its source. */
function players(root: HTMLElement) {
  return Array.from(root.querySelectorAll("audio")).map((a) => [a.getAttribute("aria-label"), a.getAttribute("src")]);
}

async function sentScoreRequest(api: typeof import("../src/lib/api")) {
  await waitFor(() => expect(api.scoreTask).toHaveBeenCalledTimes(1));
  return (api.scoreTask as any).mock.calls[0][1];
}

// The Speaking Drill's duplicate-POST backstop (the registry in lib/scoringJobOnce.ts) is
// module-level and keyed by `${attemptId}:${taskType}`, and only a page reload clears it. Every test
// here therefore sits its own Attempt, exactly as two real Attempts would, rather than replaying the
// previous one's promise.
let attemptSeq = 0;
let attemptId = "";

// The Drill drives the mic lifecycle itself, one acquire() for the whole run and release() at run
// end and on unmount, through the real useRecorder (ItemRecorder stays mocked; per-Item recording
// needs a real microphone and is that component's business). These fakes sit at the device
// boundary so the tests below can read the two observables that matter: how many times the device
// was opened, and whether its tracks were ended.
let openedTracks: Array<{ stop: ReturnType<typeof vi.fn> }>;
let getUserMedia: ReturnType<typeof vi.fn>;

beforeEach(async () => {
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
  vi.stubGlobal("MediaRecorder", class {
    static isTypeSupported() {
      return true;
    }
  });
  const api = await import("../src/lib/api");
  attemptId = `att-${++attemptSeq}`;
  (api.getSet as any).mockResolvedValue(speakingSet);
  (api.createAttempt as any).mockResolvedValue({ attemptId, isRepeat: false });
  // Re-primed every test, like getSet/createAttempt above: vi.clearAllMocks() clears calls but
  // not implementations, so without this a per-test mockImplementation (e.g. the failed-upload
  // test's) would leak into whichever test happens to run next.
  (api.uploadItemAudio as any).mockImplementation(async () => ({ ok: true, data: { transcript: "a transcript" } }));
});

afterEach(() => {
  scoringJobEnd.status = "done";
  scoringJobEnd.result = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the Speaking Drill run body: recordings out, one scoring job back", () => {
  it("uploads each Item's own recording, then scores the task once every upload has settled", async () => {
    const api = await import("../src/lib/api");
    const user = userEvent.setup();
    await startInterview(user);

    await user.click(await screen.findByRole("button", { name: "finish iv-1" }));
    // The queue moves Item by Item; nothing is scored yet.
    await user.click(await screen.findByRole("button", { name: "finish iv-2" }));

    await screen.findByRole("heading", { name: "Results" });

    // Each recording goes to its own Item id under this Attempt, in the order they were recorded.
    const uploads = (api.uploadItemAudio as any).mock.calls.map(([attemptId, itemId]: [string, string]) => [attemptId, itemId]);
    expect(uploads).toEqual([
      [attemptId, "iv-1"],
      [attemptId, "iv-2"],
    ]);

    // One scoring job for the Task, carrying both Items — not one job per Item, and not a job
    // fired before the second upload landed.
    expect(await sentScoreRequest(api)).toEqual({ taskType: "interview", items: [{ itemId: "iv-1" }, { itemId: "iv-2" }] });
  });

  it("leaves a recording taken for background recovery out of the score request, and says so", async () => {
    const api = await import("../src/lib/api");
    // The server accepted and durably stored this recording (202) but has not transcribed it yet.
    // It is settled — the queue must not wait on it — and it is not scoreable.
    (api.uploadItemAudio as any).mockImplementation(async (_attemptId: string, itemId: string) =>
      itemId === "iv-2"
        ? { ok: false, kind: "recovery-pending", message: "still transcribing", job: { status: "running" } }
        : { ok: true, data: { transcript: "a transcript" } },
    );
    const user = userEvent.setup();
    await startInterview(user);

    await user.click(await screen.findByRole("button", { name: "finish iv-1" }));
    await user.click(await screen.findByRole("button", { name: "finish iv-2" }));

    await screen.findByRole("heading", { name: "Results" });

    // Only the Item that actually has a transcript is scored: sending the other one would make the
    // server reject the whole request, taking its transcribed sibling down with it.
    expect(await sentScoreRequest(api)).toEqual({ taskType: "interview", items: [{ itemId: "iv-1" }] });

    // …and the excluded recording is disclosed rather than silently missing from the results.
    expect(screen.getByText(/1 recording was saved but not transcribed in time/)).toBeInTheDocument();
    // The way out points at the one screen that renders those Items.
    await user.click(screen.getByRole("button", { name: "Finish and open the report" }));
    expect(await screen.findByText("attempt report")).toBeInTheDocument();
  });

  it("says a recording whose transcription has failed needs a Retry, not that it keeps retrying", async () => {
    const api = await import("../src/lib/api");
    // What a machine with no transcription key answers: the recording is stored, and its job ended
    // `failed` / `configuration` on its first run. Nothing retries it until the User does.
    (api.uploadItemAudio as any).mockImplementation(async () => ({
      ok: false,
      kind: "recovery-pending",
      message: "failed",
      job: { jobId: "tj", status: "failed", automaticAttempts: 1, nextRetryAt: null, failureKind: "configuration", error: null, scoreJobId: null },
    }));
    const user = userEvent.setup();
    await startInterview(user);
    await user.click(await screen.findByRole("button", { name: "finish iv-1" }));
    await user.click(await screen.findByRole("button", { name: "finish iv-2" }));
    await screen.findByRole("heading", { name: "Results" });

    expect(screen.queryByText(/keeps retrying/)).not.toBeInTheDocument();
    expect(screen.queryByText(/went to background transcription/)).not.toBeInTheDocument();
    expect(screen.getByText(/2 recordings were saved, but their transcription failed/)).toHaveTextContent(
      /Nothing retries them by itself\. Finish to open your Attempt report, and use Retry transcription there\./,
    );
    expect(screen.getByText(/Every recording was saved, but none could be transcribed/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finish and open the report" }));
    expect(await screen.findByText("attempt report")).toBeInTheDocument();
  });

  it("counts still-retrying, failed and untranscribable recordings apart", async () => {
    const api = await import("../src/lib/api");
    const job = (status: string, failureKind: string | null) => ({
      jobId: `tj-${status}`,
      status,
      automaticAttempts: 1,
      nextRetryAt: null,
      failureKind,
      error: null,
      scoreJobId: null,
    });
    const byItem: Record<string, unknown> = {
      "iv-1": { ok: false, kind: "recovery-pending", message: "", job: job("retry_wait", "transient") },
      "iv-2": { ok: false, kind: "recovery-pending", message: "", job: job("failed", "configuration") },
    };
    const lrByItem: Record<string, unknown> = {
      "lr-1": { ok: false, kind: "recovery-pending", message: "", job: job("failed", "missing-recording") },
    };
    (api.uploadItemAudio as any).mockImplementation(async (_a: string, itemId: string) => byItem[itemId] ?? lrByItem[itemId]);
    const user = userEvent.setup();
    renderRoutes(
      [
        { path: "/", element: <p>dashboard</p> },
        { path: "/attempts/:id", element: <p>attempt report</p> },
        { path: "/speaking/:setId", element: <SpeakingDrill /> },
      ],
      "/speaking/spk-1",
    );
    await user.click(await screen.findByText("Both Task Types"));
    await user.click(await screen.findByRole("button", { name: "mic ok" }));
    await user.click(await screen.findByRole("button", { name: "Start Speaking Drill" }));
    await endAudio("spk-1/intro.mp3");
    await user.click(await screen.findByRole("button", { name: "finish lr-1" }));
    await endAudio("int-intro.mp3");
    await user.click(await screen.findByRole("button", { name: "finish iv-1" }));
    await user.click(await screen.findByRole("button", { name: "finish iv-2" }));
    await screen.findByRole("heading", { name: "Results" });

    // Each recording is described by what is true of it, across both Tasks.
    expect(screen.getByText(/1 recording was saved but not transcribed in time/)).toHaveTextContent(/keeps retrying in the background/);
    expect(screen.getByText(/1 recording was saved, but its transcription failed/)).toHaveTextContent(/Nothing retries it by itself/);
    expect(screen.getByText(/1 recording can't be transcribed/)).toHaveTextContent(/in a new Attempt is the only way/);
    expect(screen.getByText("Every recording went to background transcription. Your Attempt report shows them.")).toBeInTheDocument();
  });

  it("offers each failed recording's prompt beside it on the results, and no text of it", async () => {
    const api = await import("../src/lib/api");
    (api.uploadItemAudio as any).mockImplementation(async () => ({
      ok: false,
      kind: "recovery-pending",
      message: "failed",
      job: { jobId: "tj", status: "failed", automaticAttempts: 1, nextRetryAt: null, failureKind: "configuration", error: null, scoreJobId: null },
    }));
    const user = userEvent.setup();
    await startInterview(user);
    await user.click(await screen.findByRole("button", { name: "finish iv-1" }));
    await user.click(await screen.findByRole("button", { name: "finish iv-2" }));
    await screen.findByRole("heading", { name: "Results" });

    const unscored = screen.getByRole("region", { name: "Not scored in this Drill" });
    expect(players(unscored)).toEqual([
      ["The question you heard, Question 1", "/api/audio/stimuli/spk-1/iv-1.mp3"],
      [`Your recording, Question 1`, `/api/audio/responses/${attemptId}/iv-1.webm`],
      ["The question you heard, Question 2", "/api/audio/stimuli/spk-1/iv-2.mp3"],
      [`Your recording, Question 2`, `/api/audio/responses/${attemptId}/iv-2.webm`],
    ]);
    // Never the introduction, which is not any Item's prompt.
    expect(players(unscored).flat()).not.toContain("/api/audio/stimuli/spk-1/int-intro.mp3");
    expect(within(unscored).getAllByText("Transcription failed")).toHaveLength(2);
  });

  it("offers the prompt of a scored Item and of an Item its scoring left out", async () => {
    const reportItem = { itemId: "iv-1", ownScore: 4, finalScore: 4, maxScore: 5, dimensions: [], deductions: [], reconciliationNote: "", feedbackZh: "好" };
    scoringJobEnd.result = {
      taskType: "interview",
      report: { taskType: "interview", items: [reportItem] },
      judges: [],
      judgesFailed: [],
      items: [{ itemId: "iv-1", question: "What do you study?" }],
    };
    const user = userEvent.setup();
    await startInterview(user);
    await user.click(await screen.findByRole("button", { name: "finish iv-1" }));
    await user.click(await screen.findByRole("button", { name: "finish iv-2" }));
    await screen.findByRole("heading", { name: "Results" });

    const scoredCard = await screen.findByTestId("item-iv-1");
    expect(players(scoredCard)).toEqual([
      ["The question you heard, Question 1", "/api/audio/stimuli/spk-1/iv-1.mp3"],
      [`Your recording, Question 1`, `/api/audio/responses/${attemptId}/iv-1.webm`],
    ]);
    const leftOut = screen.getByTestId("item-iv-2");
    expect(within(leftOut).getByText("Question 2: scoring failed")).toBeInTheDocument();
    expect(players(leftOut)).toEqual([
      ["The question you heard, Question 2", "/api/audio/stimuli/spk-1/iv-2.mp3"],
      [`Your recording, Question 2`, `/api/audio/responses/${attemptId}/iv-2.webm`],
    ]);
  });

  it("offers each Item's prompt when the Task's scoring failed", async () => {
    scoringJobEnd.status = "failed";
    const user = userEvent.setup();
    await startInterview(user);
    await user.click(await screen.findByRole("button", { name: "finish iv-1" }));
    await user.click(await screen.findByRole("button", { name: "finish iv-2" }));
    await screen.findByRole("heading", { name: "Results" });

    const task = screen.getByRole("region", { name: "Interview" });
    expect(players(task).map(([name]) => name)).toEqual([
      "The question you heard, Question 1",
      "Your recording, Question 1",
      "The question you heard, Question 2",
      "Your recording, Question 2",
    ]);
  });

  it("holds the queue on a failed upload and offers a retry for that Item alone", async () => {
    const api = await import("../src/lib/api");
    (api.uploadItemAudio as any).mockImplementation(async (_attemptId: string, itemId: string) =>
      itemId === "iv-2" && (api.uploadItemAudio as any).mock.calls.length === 2
        ? { ok: false, kind: "retryable", message: "network error" }
        : { ok: true, data: { transcript: "a transcript" } },
    );
    const user = userEvent.setup();
    await startInterview(user);

    await user.click(await screen.findByRole("button", { name: "finish iv-1" }));
    await user.click(await screen.findByRole("button", { name: "finish iv-2" }));

    // A pure network failure is not settled: nothing was persisted, the same Blob is worth
    // resending, and the task must not be scored without it.
    expect(await screen.findByText("Upload failed")).toBeInTheDocument();
    expect((api.scoreTask as any).mock.calls).toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Retry" }));

    await screen.findByRole("heading", { name: "Results" });
    expect(await sentScoreRequest(api)).toEqual({
      taskType: "interview",
      items: [{ itemId: "iv-1" }, { itemId: "iv-2" }],
    });
  });

  // Opening and closing the device per Item engages macOS's deferred Voice Processing teardown,
  // which glitches the next Item's stimulus about a second in, so the Drill holds one stream for the
  // whole run and only lets go when the run is over.
  it("acquires the mic once for the whole run and releases it when the run ends", async () => {
    const user = userEvent.setup();
    await startInterview(user);

    // Entering the item-running phase acquired the device exactly once, up front.
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    await user.click(await screen.findByRole("button", { name: "finish iv-1" }));
    // Advancing to the next Item neither re-opens nor closes the device.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(openedTracks[0].stop).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: "finish iv-2" }));
    await screen.findByRole("heading", { name: "Results" });

    // Run over: still that one acquisition, and the held stream is released (recording
    // indicator off while results/scoring are on screen).
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(openedTracks[0].stop).toHaveBeenCalled();
  });

  it("releases the held mic stream when the user leaves mid-run", async () => {
    const user = userEvent.setup();
    const view = await startInterview(user);

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(openedTracks[0].stop).not.toHaveBeenCalled();

    // Unmount without ever finishing — navigation away, closing the flow. The page's cleanup
    // must end the held tracks or the mic stays on with nothing left to release it.
    view.unmount();
    expect(openedTracks[0].stop).toHaveBeenCalled();
  });
});
