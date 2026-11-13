import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { buildupSteps, type BuildupItemVM, type BuildupRepVM } from "@toefl-prep/shared";
import DrillLab from "../src/pages/DrillLab";
import type * as api from "../src/lib/api";

// The Drill Lab, mounted for real behind a mocked api client, the same idiom the section
// Simulation suites use. The server suite (routes.drillLab.test.ts) owns what the routes will and
// will not reveal; what is worth asserting here is what only a mounted page can get wrong: that the
// unattempted-Set warning actually gates the reveal, that the drill's three stages run in the order
// the method requires, and that the buildup stepper does not silently send the User back to the
// start of a sentence when they stumble.
//
// The recorder is the real useRecorder over fakes at the device boundary (getUserMedia calls and
// track.stop() calls, the same seam useRecorder.test.ts and SpeakingDrillRun.test.tsx sit on),
// because the run's microphone claims live exactly there: one acquisition for a whole run, reps
// that do not cycle the device, release on every way out. The hook's own lifecycles are pinned in
// useRecorder.test.ts and are not re-asserted here.

const SENTENCE = "The visitor whose badge you print today will remember how you treat them.";

const getBuildupQueue = vi.fn<typeof api.getBuildupQueue>();
const getBuildupBank = vi.fn<typeof api.getBuildupBank>();
const getBuildupItem = vi.fn<typeof api.getBuildupItem>();
const postBuildupRep = vi.fn<typeof api.postBuildupRep>();

vi.mock("../src/lib/api", () => ({
  getBuildupQueue: (...a: Parameters<typeof api.getBuildupQueue>) => getBuildupQueue(...a),
  getBuildupBank: (...a: Parameters<typeof api.getBuildupBank>) => getBuildupBank(...a),
  getBuildupItem: (...a: Parameters<typeof api.getBuildupItem>) => getBuildupItem(...a),
  postBuildupRep: (...a: Parameters<typeof api.postBuildupRep>) => postBuildupRep(...a),
}));

// The stimulus clip is a `new Audio(...)` that never enters the DOM, so the overlap-gate tests
// need a handle on it — to end it, and to see it silenced on a stage jump.
class FakeAudioElement {
  static instances: FakeAudioElement[] = [];
  currentTime = 0;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  src: string;
  constructor(src: string) {
    this.src = src;
    FakeAudioElement.instances.push(this);
  }
  play(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported() {
    return true;
  }
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: { error: unknown }) => void) | null = null;
  stream: MediaStream;
  constructor(stream: MediaStream) {
    this.stream = stream;
    FakeMediaRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    // The real sequence useRecorder's stop() awaits: final dataavailable, then stop.
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["chunk"]) });
    this.onstop?.();
  }
}

let openedTracks: Array<{ stop: ReturnType<typeof vi.fn> }>;
let getUserMedia: ReturnType<typeof vi.fn>;

function item(overrides: Partial<BuildupItemVM> = {}): BuildupItemVM {
  return {
    setId: "spk-1",
    itemId: "lr-7",
    scenarioTitle: "Front Office Check-In",
    sentence: SENTENCE,
    audio: "stimuli/spk-1/lr-7.mp3",
    chunks: [],
    steps: buildupSteps(SENTENCE),
    pastScores: [2],
    reps: [],
    ...overrides,
  };
}

function rep(overrides: Partial<BuildupRepVM> = {}): BuildupRepVM {
  return {
    id: "rep-1",
    phase: "baseline",
    createdAt: "2026-08-23T12:00:00.000Z",
    transcript: "The visitor whose badge",
    transcriptionError: null,
    breakdownIndex: 4,
    targetWordCount: 13,
    matchedWordCount: 4,
    diff: [
      { op: "match", targetWord: "The", saidWord: "The" },
      { op: "omission", targetWord: "visitor" },
    ],
    audioPath: "responses/drill-lab/spk-1/lr-7/rep-1.webm",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  FakeAudioElement.instances = [];
  FakeMediaRecorder.instances = [];
  vi.stubGlobal("Audio", FakeAudioElement);
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
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
  // The take's <audio controls> is in the DOM, and BlindRep's stage-leave cleanup calls pause() on
  // it, which jsdom does not implement, so stub it (play() alike, defensively).
  window.HTMLMediaElement.prototype.play = vi.fn(async () => {});
  window.HTMLMediaElement.prototype.pause = vi.fn();
  getBuildupQueue.mockResolvedValue([
    {
      setId: "spk-1",
      itemId: "lr-7",
      scenarioTitle: "Front Office Check-In",
      wordCount: 13,
      worstScore: 2,
      latestScore: 2,
      repCount: 0,
      latestHeldWords: null,
    },
  ]);
  getBuildupBank.mockResolvedValue([
    {
      setId: "spk-1",
      scenarioTitle: "Front Office Check-In",
      attempted: true,
      items: [{ itemId: "lr-7", wordCount: 13, preview: SENTENCE }],
    },
    {
      setId: "spk-2",
      scenarioTitle: "Unsat Scenario",
      attempted: false,
      items: [{ itemId: "lr-1", wordCount: 9, preview: null }],
    },
  ]);
  getBuildupItem.mockResolvedValue(item());
  postBuildupRep.mockResolvedValue(rep());
});

afterEach(() => vi.unstubAllGlobals());

/**
 * The open sentence's stimulus clip, found by its src rather than as whichever element was made last,
 * and failing by name when the run has not created it.
 */
function stimulusClip(): FakeAudioElement {
  const clip = FakeAudioElement.instances.filter((a) => a.src.endsWith("lr-7.mp3")).at(-1);
  if (!clip) throw new Error("the run has not created the stimulus clip for lr-7");
  return clip;
}

const renderLab = () => render(<MemoryRouter><DrillLab /></MemoryRouter>);

/** Picker → an opened sentence's run — where every run-body test below starts. */
async function openDrill() {
  const user = userEvent.setup();
  renderLab();
  await user.click(await screen.findByRole("button", { name: /^Practise Front Office Check-In/ }));
  await screen.findByRole("heading", { name: "Front Office Check-In" });
  return user;
}

describe("picker", () => {
  it("keeps loading the bank when the queue fails, and the other way round", async () => {
    // Per-source error isolation, the rule usePracticeData follows too: one failed fetch must not
    // blank the half of the page the User actually came for.
    getBuildupQueue.mockRejectedValue(new Error("boom"));
    renderLab();
    expect(await screen.findByText("The practice queue didn't load.")).toBeTruthy();
    expect(await screen.findByText("Unsat Scenario")).toBeTruthy();
  });

  it("opens a queued sentence straight into the drill", async () => {
    const user = userEvent.setup();
    renderLab();
    await user.click(await screen.findByRole("button", { name: /^Practise Front Office Check-In/ }));
    expect(await screen.findByRole("heading", { name: "Front Office Check-In" })).toBeTruthy();
    expect(getBuildupItem).toHaveBeenCalledWith("spk-1", "lr-7");
  });

  it("will not reveal an unattempted Set's sentence until the warning is confirmed", async () => {
    // Opening a sentence permanently costs the ability to sit that Set blind. The first click has to
    // be a warning, not the reveal.
    const user = userEvent.setup();
    renderLab();
    await user.click(await screen.findByText("Unsat Scenario"));
    await user.click(within(screen.getByText("Unsat Scenario").closest("li")!).getByRole("button", { name: "Practise…" }));
    expect(getBuildupItem).not.toHaveBeenCalled();
    const dialog = screen.getAllByRole("dialog", { hidden: true }).find((d) => d.hasAttribute("open"))!;
    expect(dialog).toHaveTextContent("Reveal this sentence?");
    await user.click(within(dialog).getByRole("button", { name: "Reveal and practise", hidden: true }));
    expect(getBuildupItem).toHaveBeenCalledWith("spk-2", "lr-1");
  });

  it("in a partly answered Set, opens a sentence already shown at once and asks only before revealing a hidden one", async () => {
    // The Set-level `attempted` needs every sentence answered, so a sat Set with one skipped
    // sentence still carries false. What the page can spoil is decided sentence by sentence.
    getBuildupBank.mockResolvedValue([
      {
        setId: "spk-3",
        scenarioTitle: "Writing Center Tutor",
        attempted: false,
        items: [
          { itemId: "lr-1", wordCount: 13, preview: SENTENCE },
          { itemId: "lr-2", wordCount: null, preview: null },
          { itemId: "lr-3", wordCount: 9, preview: "Bring your draft and the assignment sheet." },
        ],
      },
      { setId: "spk-2", scenarioTitle: "Unsat Scenario", attempted: false, items: [{ itemId: "lr-1", wordCount: null, preview: null }] },
    ]);
    const user = userEvent.setup();
    renderLab();
    const header = await screen.findByRole("button", { name: /Writing Center Tutor/ });
    expect(header).toHaveTextContent("2 of 3 sentences answered");
    expect(header).not.toHaveTextContent("Not attempted");
    // A Set with nothing answered still says so.
    expect(screen.getByRole("button", { name: /Unsat Scenario/ })).toHaveTextContent("Not attempted");

    await user.click(header);
    const rows = within(header.closest("li")!).getAllByRole("listitem");
    expect(within(rows[0]).getByRole("button", { name: "Practise" })).toBeTruthy();
    expect(within(rows[1]).getByRole("button", { name: "Practise…" })).toBeTruthy();

    // The hidden sentence asks first, and does not claim the Set was never attempted.
    await user.click(within(rows[1]).getByRole("button", { name: "Practise…" }));
    const dialog = screen.getAllByRole("dialog", { hidden: true }).find((d) => d.hasAttribute("open"))!;
    expect(dialog).toHaveTextContent("Sentence 2 of Writing Center Tutor has no scored recording yet");
    expect(dialog).not.toHaveTextContent(/haven't attempted/);
    await user.click(within(dialog).getByRole("button", { name: "Keep it hidden", hidden: true }));
    expect(getBuildupItem).not.toHaveBeenCalled();

    // A sentence already on screen opens straight into its run, with no question.
    await user.click(within(rows[0]).getByRole("button", { name: "Practise" }));
    expect(getBuildupItem).toHaveBeenCalledWith("spk-3", "lr-1");
    expect(screen.queryAllByRole("dialog", { hidden: true }).some((d) => d.hasAttribute("open"))).toBe(false);
  });
});

describe("the run", () => {
  it("starts at the blind baseline and does not show the sentence yet", async () => {
    // The baseline has to be recorded before the sentence is read: once it has been read there is no
    // way back to a first-hearing measurement, and the closing rep would compare against nothing.
    await openDrill();
    expect(screen.getByText("Step 1: Blind baseline")).toBeTruthy();
    expect(screen.queryByText(SENTENCE)).toBeNull();
  });

  it("records a baseline and waits for the learner before moving on", async () => {
    // The result stays on screen until they advance: the baseline exists to be looked at, and
    // auto-advancing on upload would hide it behind a stage transition.
    const user = await openDrill();
    await user.click(screen.getByRole("button", { name: "Record" }));
    await user.click(await screen.findByRole("button", { name: /Stop and compare/ }));
    await waitFor(() => expect(postBuildupRep).toHaveBeenCalled());
    expect(postBuildupRep.mock.calls[0]![2]).toBe("baseline");
    expect(screen.queryByText("Step 2: Backward buildup")).toBeNull();
    await user.click(await screen.findByRole("button", { name: /Start the backward buildup/ }));
    expect(await screen.findByText("Step 2: Backward buildup")).toBeTruthy();
  });

  it("shows the shortest tail first and advances only after two clean reps", async () => {
    getBuildupItem.mockResolvedValue(item({ reps: [rep()] })); // baseline already on file
    const user = await openDrill();
    const steps = buildupSteps(SENTENCE);
    expect(screen.getByText(`Step 1 of ${steps.length}`)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clean rep (0 of 2)" }));
    expect(screen.getByText(`Step 1 of ${steps.length}`)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Clean rep (1 of 2)" }));
    expect(screen.getByText(`Step 2 of ${steps.length}`)).toBeTruthy();
  });

  it("drops back exactly one step on a stumble, never to the start", async () => {
    // Restarting from the full sentence re-rehearses the opening — already the strong part — and
    // leaves the tail with the single rep it had when it collapsed. That is the distribution this
    // whole drill exists to invert, so the control must not offer it.
    getBuildupItem.mockResolvedValue(item({ reps: [rep()] }));
    const user = await openDrill();
    const steps = buildupSteps(SENTENCE);
    for (let i = 0; i < 4; i++) await user.click(screen.getByRole("button", { name: /Clean rep/ }));
    expect(screen.getByText(`Step 3 of ${steps.length}`)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /Stumbled/ }));
    expect(screen.getByText(`Step 2 of ${steps.length}`)).toBeTruthy();
  });

  it("compares the closing rep against the baseline in words held", async () => {
    getBuildupItem.mockResolvedValue(item({ reps: [rep({ breakdownIndex: 4, matchedWordCount: 4 })] }));
    postBuildupRep.mockResolvedValue(rep({ id: "rep-2", phase: "post", breakdownIndex: 9, matchedWordCount: 9 }));
    const user = await openDrill();
    await user.click(screen.getByRole("button", { name: /Skip to the re-test/ }));
    await user.click(await screen.findByRole("button", { name: "Record" }));
    await user.click(await screen.findByRole("button", { name: /Stop and compare/ }));
    expect(await screen.findByText(/5 words later/)).toBeTruthy();
  });

  it("plays the clip once and then locks the control", async () => {
    // The stage measures what survives one hearing. A replay button would make reps incomparable,
    // with nothing recording how many listens each took.
    const user = await openDrill();
    const play = screen.getByRole("button", { name: /Play once/ });
    await user.click(play);
    const locked = await screen.findByRole("button", { name: "Played" });
    expect(locked).toBeDisabled();
  });

  it("refuses to compare against the baseline when a rep was never measured", async () => {
    // heldWordCount is null for an unmeasured rep; treating it as a number would render a failed
    // transcription as the largest gain the drill can show.
    getBuildupItem.mockResolvedValue(item({ reps: [rep({ breakdownIndex: 4, matchedWordCount: 4 })] }));
    postBuildupRep.mockResolvedValue(
      rep({
        id: "rep-2", phase: "post", transcript: null, transcriptionError: "provider down",
        breakdownIndex: null, matchedWordCount: null, diff: null,
      }),
    );
    const user = await openDrill();
    await user.click(screen.getByRole("button", { name: /Skip to the re-test/ }));
    await user.click(await screen.findByRole("button", { name: "Record" }));
    await user.click(await screen.findByRole("button", { name: /Stop and compare/ }));
    expect(await screen.findByText(/can't be compared with the baseline/)).toBeTruthy();
    expect(screen.queryByText(/words later/)).toBeNull();
  });

  it("keeps an unmeasured rep out of the history rather than plotting it as perfect", async () => {
    getBuildupItem.mockResolvedValue(
      item({
        reps: [
          rep({ id: "r1", breakdownIndex: 4, matchedWordCount: 4 }),
          rep({ id: "r2", transcript: null, transcriptionError: "x", breakdownIndex: null, matchedWordCount: null }),
        ],
      }),
    );
    await openDrill();
    expect(screen.getByText(/held to word 4 of 13/)).toBeTruthy();
    expect(screen.queryByText(/held to word 13 of 13/)).toBeNull();
  });

  it("keeps the recording usable when transcription failed", async () => {
    postBuildupRep.mockResolvedValue(
      rep({
        transcript: null, transcriptionError: "provider unavailable", diff: null,
        breakdownIndex: null, matchedWordCount: null,
      }),
    );
    const user = await openDrill();
    await user.click(screen.getByRole("button", { name: "Record" }));
    await user.click(await screen.findByRole("button", { name: /Stop and compare/ }));
    // Scoped to the <p> itself: a bare text-content predicate also matches every ancestor.
    expect(
      await screen.findByText(
        (_t, el) => el?.tagName === "P" && el.textContent?.includes("Couldn't transcribe") === true,
      ),
    ).toBeTruthy();
    expect(document.querySelector("audio")).toBeTruthy();
  });

  it("renders the alignment with omissions marked", async () => {
    const user = await openDrill();
    await user.click(screen.getByRole("button", { name: "Record" }));
    await user.click(await screen.findByRole("button", { name: /Stop and compare/ }));
    // The baseline result must still be on screen: recording it does not advance the stage.
    expect(await screen.findByRole("button", { name: /Start the backward buildup/ })).toBeTruthy();
    expect(screen.getByText("visitor").className).toContain("line-through");
  });
});

describe("the held mic stream", () => {
  // Asserted at the device boundary: a per-rep getUserMedia/track-stop cycle lets macOS's deferred
  // Voice Processing I/O teardown land about 1 s into whatever clip plays next. The run must open
  // the device once, record every rep off that one stream, and only end its tracks on the way out.

  it("opens the device once for the whole run, records every rep off it, and releases on exit", async () => {
    postBuildupRep
      .mockResolvedValueOnce(rep({ id: "rep-a" }))
      .mockResolvedValueOnce(rep({ id: "rep-b", phase: "post" }));
    const user = await openDrill();
    // Mounting the run acquires the device up front — before any record click.
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(1));

    // Baseline rep.
    await user.click(screen.getByRole("button", { name: "Record" }));
    await user.click(await screen.findByRole("button", { name: /Stop and compare/ }));
    await waitFor(() => expect(postBuildupRep).toHaveBeenCalledTimes(1));

    // Straight to the closing rep — a second rep in the same run.
    await user.click(screen.getByRole("button", { name: "3. Blind re-test" }));
    await user.click(await screen.findByRole("button", { name: "Record" }));
    await user.click(await screen.findByRole("button", { name: /Stop and compare/ }));
    await waitFor(() => expect(postBuildupRep).toHaveBeenCalledTimes(2));

    // Two reps, one acquisition, zero teardowns in between, and both recordings came off the one
    // held stream.
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(openedTracks[0].stop).not.toHaveBeenCalled();
    const held = await getUserMedia.mock.results[0]!.value;
    expect(FakeMediaRecorder.instances.map((r) => r.stream)).toEqual([held, held]);

    // Leaving the run is what finally releases it: recording indicator off at the picker.
    await user.click(screen.getByRole("button", { name: "Back to the sentences" }));
    expect(openedTracks[0].stop).toHaveBeenCalled();
    await screen.findByText("Practice queue");
  });

  it("releases the held stream when the learner leaves the lab mid-rep", async () => {
    const user = userEvent.setup();
    const view = renderLab();
    await user.click(await screen.findByRole("button", { name: /^Practise Front Office Check-In/ }));
    await screen.findByRole("heading", { name: "Front Office Check-In" });
    await user.click(screen.getByRole("button", { name: "Record" }));
    await screen.findByRole("button", { name: /Stop and compare/ });
    expect(openedTracks[0].stop).not.toHaveBeenCalled();

    // Navigating away mid-recording: unmount must end the held tracks, or the mic stays on with
    // nothing left to release it.
    view.unmount();
    expect(openedTracks[0].stop).toHaveBeenCalled();
  });
});

describe("the overlap gate", () => {
  // With echo cancellation off (useRecorder), any overlap of playback and capture leaks that audio
  // verbatim into the take, so listen-then-record has to be a state the controls enforce, not a
  // convention the User happens to follow.

  it("keeps recording un-startable while the stimulus clip is sounding", async () => {
    const user = await openDrill();
    await user.click(screen.getByRole("button", { name: /Play once/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toBeDisabled());

    // The clip finishing is what re-arms it.
    act(() => stimulusClip().onended?.());
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toBeEnabled());
  });

  it("silences a clip that is still sounding when the learner jumps stages", async () => {
    // The next stage's gate cannot see this stage's clip, and a detached Audio keeps sounding by
    // spec — so the stage exit itself must silence it, or "nothing is audible while recording"
    // would only hold within a single stage.
    const user = await openDrill();
    await user.click(screen.getByRole("button", { name: /Play once/ }));
    const clip = stimulusClip();
    expect(clip.pause).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "2. Backward buildup" }));
    expect(clip.pause).toHaveBeenCalled();
  });

  it("gates recording on a sounding take, and removes the take's player while recording", async () => {
    postBuildupRep
      .mockResolvedValueOnce(rep({ id: "rep-a" }))
      .mockResolvedValueOnce(rep({ id: "rep-b" }));
    const user = await openDrill();
    await user.click(screen.getByRole("button", { name: "Record" }));
    await user.click(await screen.findByRole("button", { name: /Stop and compare/ }));
    const take = await waitFor(() => {
      const el = document.querySelector("audio");
      expect(el).toBeTruthy();
      return el!;
    });

    // While the take is sounding, record is gated…
    fireEvent.play(take);
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toBeDisabled());
    // …until it stops sounding.
    fireEvent.pause(take);
    await waitFor(() => expect(screen.getByRole("button", { name: "Record" })).toBeEnabled());

    // And while a new recording runs, the prior take's player does not exist at all, so playback
    // cannot be started mid-recording.
    await user.click(screen.getByRole("button", { name: "Record" }));
    expect(document.querySelector("audio")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Stop and compare/ }));
    await waitFor(() => expect(document.querySelector("audio")).toBeTruthy());
  });
});
