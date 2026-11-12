import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAudioElement, endAudio } from "./fakeAudio";
import type { ReactElement } from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderRoutes, unload } from "./dataRouter";
import { useFakeTimersInTest } from "./fakeTimers";
import ReadingDrill from "../src/pages/ReadingDrill";
import ListeningDrill from "../src/pages/ListeningDrill";
import WritingDrill from "../src/pages/WritingDrill";
import SpeakingDrill from "../src/pages/SpeakingDrill";

// The Drill shell, asserted for all four Drills from one table of cases, each run through its real
// page from the URL to the Dashboard. The shell (pages/drill/drillShell.ts and DrillScreens.tsx)
// owns Set loading, the error screen, Attempt creation with its Repeat tag, and finishing, so "all
// four Drills behave alike" is checked here page by page. The shell's leave guard is asserted in
// drillLeaveGuard.test.tsx.
//
// The pages are mounted rather than a harness around useDrillShell: the shell's job is what those
// pages render and call, and a hook harness would pass whether or not a page used it.

vi.mock("../src/lib/api", () => ({
  getSet: vi.fn(),
  // Every Drill looks its Set up in the listing for its title, best-effort.
  listSets: vi.fn(async () => []),
  createAttempt: vi.fn(async () => ({ attemptId: "att-1", isRepeat: true })),
  completeAttempt: vi.fn(async () => ({})),
  scoreDeterministicTask: vi.fn(async (_attemptId: string, req: any) => ({
    taskType: req.taskType,
    items: req.items.map((i: any) => ({ itemId: i.itemId, correct: true, key: "A", explanationZh: "因為 A 是對的。" })),
  })),
  scoreTask: vi.fn(async (_attemptId: string, body: any) =>
    body.taskType === "build_sentence"
      ? { items: body.items.map((i: any) => ({ itemId: i.itemId, correct: true, matchedAnswer: i.tileOrder, correctAnswers: [i.tileOrder] })) }
      : { jobId: "job-1" },
  ),
  uploadItemAudio: vi.fn(async () => ({ ok: true, data: { transcript: "a transcript" } })),
  getAttempt: vi.fn(),
  DeterministicAlreadyScoredError: class DeterministicAlreadyScoredError extends Error {},
}));

// The Writing and Speaking Drills start a scoring job for a judged Task once it is handed in. This
// suite is about the shell around them, so the job is stubbed as already done: both pages disable
// "Back to Practice" while anything is still scoring, and that button is where the Attempt is
// completed.
vi.mock("../src/hooks/useScoringJob", () => ({
  useScoringJob: () => ({
    status: "done",
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
  }),
}));

// The microphone check and the recorder's stimulus, beep, record and countdown sequence have their
// own suites (MicCheck.test.tsx, ItemRecorder.test.tsx). Here they are two clicks that carry the
// shell from the picker to the results screen.
vi.mock("../src/components/MicCheck", () => ({
  default: ({ onPass }: { onPass: () => void }) => (
    <button type="button" onClick={onPass}>
      mic ok
    </button>
  ),
}));
vi.mock("../src/components/ItemRecorder", () => ({
  default: ({ onFinished }: { onFinished: (blob: Blob) => void }) => (
    <button type="button" onClick={() => onFinished(new Blob(["x"]))}>
      finish item
    </button>
  ),
}));

// window.Audio is stubbed per file with fakeAudio.ts, never in client/test/setup.ts, which would
// change every other test's global. Nothing plays on its own here: a test dispatches "ended" itself,
// so the Listening Drill's options appear only once a test says the Stimulus audio has finished.

type User = ReturnType<typeof userEvent.setup>;

// `kind` is what the shell narrows the served Set on (shared's expectServedSet). Every Set the
// server sends carries it, on disk and through stripAnswers.

const mcq = (id: string) => ({
  id,
  stem: `${id} stem?`,
  options: [
    { id: "o1", text: `${id} option one` },
    { id: "o2", text: `${id} option two` },
  ],
});

const readingSet = {
  id: "rdg-1",
  kind: "reading",
  source: "generated",
  createdAt: "2026-01-01T00:00:00Z",
  router: {
    ctwPassages: [
      { id: "ctw-1", taskType: "complete_words", topic: "Bicycles", segments: ["Ride a b"], gaps: [{ id: "g-1", prefix: "b", boxes: 3 }] },
    ],
    dailyLife: [{ id: "dl-1", taskType: "daily_life", genre: "notice", text: "The library closes at six.", questions: [mcq("dl-1-q1")] }],
    academic: [{ id: "ap-1", taskType: "academic_passage", discipline: "biology", text: "Cells divide.", questions: [mcq("ap-1-q1")] }],
  },
};

const speaker = { id: "sp-1", role: "student", gender: "female", accent: "north-american" };

const listeningSet = {
  id: "lsn-1",
  kind: "listening",
  source: "generated",
  createdAt: "2026-01-01T00:00:00Z",
  router: {
    listenChoose: [
      {
        id: "lc-1",
        taskType: "listen_choose",
        audio: "stimuli/lsn-1/lc-1.mp3",
        speaker,
        options: [
          { id: "o1", text: "lc-1 option one" },
          { id: "o2", text: "lc-1 option two" },
        ],
      },
    ],
    conversations: [{ id: "cv-1", taskType: "conversation", audio: "stimuli/lsn-1/cv-1.mp3", setting: "bookstore", speakers: [speaker], questions: [mcq("cv-1-q1")] }],
    announcements: [{ id: "an-1", taskType: "announcement", audio: "stimuli/lsn-1/an-1.mp3", setting: "housing office", speaker, questions: [mcq("an-1-q1")] }],
    academicTalks: [{ id: "at-1", taskType: "academic_talk", audio: "stimuli/lsn-1/at-1.mp3", discipline: "geology", speaker, questions: [mcq("at-1-q1")] }],
  },
};

const writingSet = {
  id: "wri-1",
  kind: "writing",
  source: "generated",
  createdAt: "2026-01-01T00:00:00Z",
  buildASentence: { items: [{ id: "bs-1", prompt: "Arrange it.", tiles: ["a", "b"] }] },
  email: {
    id: "em-1",
    scenario: "Ask for an extension.",
    to: "prof@uni.edu",
    subject: "Extension",
    bullets: ["say why"],
    timeLimitSec: 420,
    wordGuidance: { min: 80, max: 120 },
  },
  academicDiscussion: {
    id: "ad-1",
    courseTitle: "Econ 101",
    professorName: "Dr. Lin",
    professorPost: "Discuss.",
    studentPosts: [{ name: "Ana", post: "Subsidies distort prices." }],
    timeLimitSec: 600,
    minWords: 100,
  },
};

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
    questions: [{ id: "iv-1", audio: "stimuli/spk-1/iv-1.mp3", responseWindowSec: 45 }],
  },
};

type DrillCase = {
  name: string;
  /** What POST /api/attempts must be told this Attempt is. */
  kind: string;
  routePath: string;
  entry: string;
  setId: string;
  fixture: unknown;
  element: ReactElement;
  /** The subtitle line the picker draws under its title — each Drill's own wording. */
  pickerSubtitle: string;
  /** The picker option this case drives, and the Drill's own word for starting. */
  option: string;
  /** How the Drill's results screen says this Attempt is a Repeat. */
  repeatText: RegExp;
  /** The results screen's button that completes the Attempt and goes back to Practice. */
  finishLabel: string;
  /** Picker → the Drill's own results screen, through whatever that Drill's run body demands. */
  driveToDone: (user: User) => Promise<void>;
};

const CASES: DrillCase[] = [
  {
    name: "ReadingDrill",
    kind: "reading",
    routePath: "/reading/:setId",
    entry: "/reading/rdg-1",
    setId: "rdg-1",
    fixture: readingSet,
    element: <ReadingDrill />,
    pickerSubtitle: "Choose what to practise. After each Stimulus you see what you got right, the key and the Explanation.",
    option: "Read in Daily Life",
    repeatText: /This Attempt is a Repeat: you have practised this Set before\./,
    finishLabel: "Back to Practice",
    driveToDone: async (user) => {
      await user.click(await screen.findByText("Read in Daily Life"));
      await user.click(screen.getByRole("button", { name: "Start Reading Drill" }));
      await user.click(await screen.findByRole("button", { name: "Check Response" }));
      await user.click(await screen.findByRole("button", { name: "See results" }));
    },
  },
  {
    name: "ListeningDrill",
    kind: "listening",
    routePath: "/listening/:setId",
    entry: "/listening/lsn-1",
    setId: "lsn-1",
    fixture: listeningSet,
    element: <ListeningDrill />,
    pickerSubtitle: "Choose what to practise. After each Stimulus you see what you got right, the key and the Explanation.",
    option: "Listen and Choose a Response",
    repeatText: /This Attempt is a Repeat: you have practised this Set before\./,
    finishLabel: "Back to Practice",
    driveToDone: async (user) => {
      await user.click(await screen.findByText("Listen and Choose a Response"));
      await user.click(screen.getByRole("button", { name: "Start Listening Drill" }));
      // Nothing answerable exists until the Stimulus audio ends, so the run waits for it.
      await endAudio("lc-1.mp3");
      await user.click(await screen.findByRole("button", { name: "Check Response" }));
      await user.click(await screen.findByRole("button", { name: "See results" }));
    },
  },
  {
    name: "WritingDrill",
    kind: "writing",
    routePath: "/writing/:setId",
    entry: "/writing/wri-1",
    setId: "wri-1",
    fixture: writingSet,
    element: <WritingDrill />,
    pickerSubtitle: "Choose what to practise. Each Task is scored as you hand it in.",
    option: "Build a Sentence",
    repeatText: /This Attempt is a Repeat: you have practised this Set before\./,
    finishLabel: "Back to Practice",
    driveToDone: async (user) => {
      await user.click(await screen.findByText("Build a Sentence"));
      await user.click(screen.getByRole("button", { name: "Start Writing Drill" }));
      await user.click(await screen.findByRole("button", { name: "Finish Build a Sentence" }));
    },
  },
  {
    name: "SpeakingDrill",
    kind: "speaking",
    routePath: "/speaking/:setId",
    entry: "/speaking/spk-1",
    setId: "spk-1",
    fixture: speakingSet,
    element: <SpeakingDrill />,
    pickerSubtitle: "Choose what to practise. You check your microphone first, and each Task is scored as soon as its recordings are sent.",
    option: "Interview",
    repeatText: /This Attempt is a Repeat: you have practised this Set before\./,
    finishLabel: "Back to Practice",
    driveToDone: async (user) => {
      await user.click(await screen.findByText("Interview"));
      await user.click(await screen.findByRole("button", { name: "mic ok" }));
      await user.click(await screen.findByRole("button", { name: "Start Speaking Drill" }));
      // The interview intro beat plays before the first Item.
      await endAudio("int-intro.mp3");
      await user.click(await screen.findByRole("button", { name: "finish item" }));
    },
  },
];

// A data router under LeaveGuardHost, as App.tsx mounts every Drill: the shell's leave guard needs both.
function renderCase(c: DrillCase) {
  return renderRoutes(
    [
      { path: "/", element: <p>dashboard</p> },
      { path: c.routePath, element: c.element },
    ],
    c.entry,
  );
}

beforeEach(() => {
  FakeAudioElement.instances = [];
  vi.stubGlobal("Audio", FakeAudioElement);
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Reset, not just clear: an implementation one Drill's test installs (a rejecting
  // completeAttempt, say) goes back to the module mock's default before the next test.
  vi.resetAllMocks();
});

// Each Drill is its own test from here on rather than one test looping over the table: a whole
// Drill flow is a dozen user events, four of them do not fit one test's time budget on a loaded
// machine, and a failure should name the Drill it happened in.

describe("the Drill shell: loading and error", () => {
  it("draws the same loading screen in all four Drills, from the same markup", async () => {
    const api = await import("../src/lib/api");
    (api.getSet as any).mockReturnValue(new Promise(() => {}));

    const rendered = CASES.map((c) => {
      const { container, unmount } = renderCase(c);
      // The screen itself: LeaveGuardHost's closed dialog beside it carries a per-render id.
      const html = container.querySelector("main")?.outerHTML ?? "";
      unmount();
      return { name: c.name, html };
    });

    expect(rendered[0].html).toContain("Loading the Set…");
    // Byte-identical: one component (DrillLoadingScreen in pages/drill/DrillScreens.tsx) draws it.
    // Comparing the four renders makes a divergence (a stray wrapper, a different class list, a
    // reworded label in one page) fail here rather than only show on screen.
    for (const r of rendered) expect(r.html).toBe(rendered[0].html);
  });

  it.each(CASES)("funnels a failed Set load into the shared error screen — $name", async (c) => {
    const api = await import("../src/lib/api");
    (api.getSet as any).mockRejectedValue(new Error("set 404"));

    renderCase(c);
    // The rejection's own message, and the way back to Practice.
    expect(await screen.findByText("set 404")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to Practice" })).toHaveAttribute("href", "/");
  });

  it("keeps a wrong-section Set out of the run body instead of crashing mid-render", async () => {
    const api = await import("../src/lib/api");
    // The shell narrows with shared's expectServedSet inside the load, so a mis-routed Set fails
    // the same way a 404 does rather than reaching a page that reads `router.dailyLife` off it.
    (api.getSet as any).mockResolvedValue(listeningSet);
    renderCase(CASES[0]);
    expect(await screen.findByText(/served Set is not a reading Set \(got listening\)/)).toBeInTheDocument();
  });
});

describe("the Drill shell: the picker and the Attempt", () => {
  it.each(CASES)("names the Set on the picker and creates a drill Attempt for its own section — $name", async (c) => {
    const api = await import("../src/lib/api");
    (api.getSet as any).mockResolvedValue(c.fixture);
    const user = userEvent.setup();
    renderCase(c);

    expect(await screen.findByText(c.pickerSubtitle)).toBeInTheDocument();

    await c.driveToDone(user);
    await screen.findByRole("heading", { name: "Results" });

    // The one call every Drill makes, with the one body every Drill sends.
    expect((api.createAttempt as any).mock.calls).toHaveLength(1);
    expect((api.createAttempt as any).mock.calls[0][0]).toEqual({ kind: c.kind, mode: "drill", setId: c.setId });
  });
});

describe("the Drill shell: Repeat tagging and finish-and-navigate", () => {
  it.each(CASES)("tags the Repeat, completes the Attempt and returns home — $name", async (c) => {
    const api = await import("../src/lib/api");
    (api.getSet as any).mockResolvedValue(c.fixture);
    // A Repeat is allowed and tagged (CONTEXT.md). The server decides it, and every Drill reads the
    // same tag off the createAttempt response.
    (api.createAttempt as any).mockResolvedValue({ attemptId: "att-1", isRepeat: true });
    const user = userEvent.setup();
    renderCase(c);

    await c.driveToDone(user);
    await screen.findByRole("heading", { name: "Results" });

    // Each Drill's results screen words it its own way; what is asserted is the tagging itself.
    expect(screen.getByText(c.repeatText)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: c.finishLabel }));

    expect((api.completeAttempt as any).mock.calls).toEqual([["att-1"]]);
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
  });

  it.each(CASES)("says nothing about a Repeat when the Attempt is not one — $name", async (c) => {
    const api = await import("../src/lib/api");
    (api.getSet as any).mockResolvedValue(c.fixture);
    (api.createAttempt as any).mockResolvedValue({ attemptId: "att-2", isRepeat: false });
    const user = userEvent.setup();
    renderCase(c);

    await c.driveToDone(user);
    await screen.findByRole("heading", { name: "Results" });

    expect(screen.queryByText(c.repeatText)).not.toBeInTheDocument();
  });

});

/** What fetch rejects with when nothing answers. */
const noAnswer = () => new TypeError("Failed to fetch");
/** A refusal shaped as lib/api.ts's HttpError, which this file's mock of it leaves out. */
const refused = (status: number, reason: string) =>
  Object.assign(new Error(`${status}: ${JSON.stringify({ error: reason })}`), { status });

// Finishing is what marks the Attempt finished; one left in progress shows as Unfinished in the
// Attempt log. So the finish retries its completion as a Simulation does, and a completion that
// still fails is said on the results screen with Retry. A Drill has no Band Estimate to lose, so
// the finish button still leaves.
describe("the Drill shell: a completion that fails", () => {
  let clock: ReturnType<typeof useFakeTimersInTest>;
  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    clock = useFakeTimersInTest({ shouldAdvanceTime: true });
    // Each failed request is logged; that is the retry's business, not this suite's.
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errors.mockRestore();
  });

  async function toResults(c: DrillCase) {
    const api = await import("../src/lib/api");
    (api.getSet as any).mockResolvedValue(c.fixture);
    (api.createAttempt as any).mockResolvedValue({ attemptId: "att-1", isRepeat: false });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderCase(c);
    await c.driveToDone(user);
    await screen.findByRole("heading", { name: "Results" });
    return { api, user };
  }

  it.each(CASES)("retries a completion that fails in transit, then leaves — $name", async (c) => {
    const { api, user } = await toResults(c);
    (api.completeAttempt as any).mockRejectedValueOnce(noAnswer());

    await user.click(screen.getByRole("button", { name: c.finishLabel }));
    await act(async () => {
      await clock.advanceBy(2_000);
    });

    expect(await screen.findByText("dashboard")).toBeInTheDocument();
    expect((api.completeAttempt as any).mock.calls).toEqual([["att-1"], ["att-1"]]);
  });

  it.each(CASES)("says when the Attempt could not be marked finished, and the finish button still leaves — $name", async (c) => {
    const { api, user } = await toResults(c);
    (api.completeAttempt as any).mockRejectedValue(noAnswer());

    const finishButton = screen.getByRole("button", { name: c.finishLabel });
    await user.click(finishButton);
    // Still inside the retry budget: the press is busy, and nothing is said yet.
    await act(async () => {
      await clock.advanceBy(20_000);
    });
    expect(finishButton).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(/couldn't be marked finished/)).toBeNull();

    await act(async () => {
      await clock.advanceBy(20_000);
    });
    expect(
      await screen.findByText("This Attempt couldn't be marked finished. Can't reach the server. Is it running?"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(screen.queryByText("dashboard")).toBeNull();
    // The Attempt is still open, so leaving any other way still asks.
    expect(unload()).toBe(true);

    const calls = (api.completeAttempt as any).mock.calls.length;
    await user.click(screen.getByRole("button", { name: c.finishLabel }));
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
    expect((api.completeAttempt as any).mock.calls).toHaveLength(calls);
  });

  it.each(CASES)("completes on Retry, then goes where the finish was going — $name", async (c) => {
    const { api, user } = await toResults(c);
    // A refusal is not retried: it is said at once.
    (api.completeAttempt as any).mockRejectedValueOnce(refused(409, "attempt is aborted"));

    await user.click(screen.getByRole("button", { name: c.finishLabel }));
    expect(
      await screen.findByText("This Attempt couldn't be marked finished. The request was refused: attempt is aborted."),
    ).toBeInTheDocument();
    expect((api.completeAttempt as any).mock.calls).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
    expect((api.completeAttempt as any).mock.calls).toEqual([["att-1"], ["att-1"]]);
  });

  it.each(CASES)("counts a refusal saying the Attempt is already completed as done — $name", async (c) => {
    const { api, user } = await toResults(c);
    (api.completeAttempt as any).mockRejectedValueOnce(refused(409, "attempt is already completed"));

    await user.click(screen.getByRole("button", { name: c.finishLabel }));
    expect(await screen.findByText("dashboard")).toBeInTheDocument();
    expect((api.completeAttempt as any).mock.calls).toHaveLength(1);
  });
});

describe("the Drill shell: starting the Attempt", () => {
  // Reading, Listening and Writing start from the shared intro screen straight after the picker
  // (Speaking reaches it after its mic check). A second click while POST /api/attempts is in flight
  // must not create a second Attempt.
  const INTRO_CASES: Array<[DrillCase, string]> = [
    [CASES[0], "Start Reading Drill"],
    [CASES[1], "Start Listening Drill"],
    [CASES[2], "Start Writing Drill"],
  ];

  it("creates one Attempt however often Start is clicked while the request is in flight", async () => {
    const api = await import("../src/lib/api");

    for (const [c, startLabel] of INTRO_CASES) {
      (api.getSet as any).mockResolvedValue(c.fixture);
      let created!: (value: { attemptId: string; isRepeat: boolean }) => void;
      (api.createAttempt as any).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            created = resolve;
          }),
      );
      const user = userEvent.setup();
      const { unmount } = renderCase(c);
      await user.click(await screen.findByText(c.option));

      const start = screen.getByRole("button", { name: startLabel });
      fireEvent.click(start);
      fireEvent.click(start);
      expect((api.createAttempt as any).mock.calls).toHaveLength(1);
      // Busy, not disabled: it keeps keyboard focus while the request is in flight.
      expect(start).toHaveAttribute("aria-disabled", "true");

      await act(async () => {
        created({ attemptId: "att-1", isRepeat: false });
      });
      unmount();
      vi.clearAllMocks();
    }
  });
});
