import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AttemptDetailVM, ItemVM, SetupStatusVM } from "@toefl-prep/shared";
import { renderRoutes } from "./dataRouter";
import { SetupStatusProvider } from "../src/components/setup/SetupStatusProvider";
import WritingDrill from "../src/pages/WritingDrill";
import SpeakingDrill from "../src/pages/SpeakingDrill";
import AttemptReview from "../src/pages/AttemptReview";
import SimulationRun from "../src/pages/SimulationRun";

// On a machine that cannot score Speaking or Writing (the setup status says so), the User is told
// before starting, on the first screens of those Drills and Simulations, and a scoring failure says
// why and points to Setup instead of repeating the server's error. Each screen here is the real
// page, under the same SetupStatusProvider App.tsx mounts, with GET /api/setup-status stubbed.

vi.mock("../src/lib/api", () => ({
  getSet: vi.fn(),
  getSetupStatus: vi.fn(),
  getAttempt: vi.fn(),
  getScoreJob: vi.fn(),
  retryTranscription: vi.fn(),
  createAttempt: vi.fn(),
  completeAttempt: vi.fn(async () => ({})),
  listSets: vi.fn(async (kind?: string) => [{ id: kind === "speaking" ? "spk-1" : "wri-test" }]),
  listAttempts: vi.fn(async () => []),
  scoreTask: vi.fn(async () => ({ jobId: "job-1" })),
  uploadItemAudio: vi.fn(),
  HttpError: class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

// The essay's scoring job, as the Drill's results read it: failed, as it ends on a machine with
// nothing to score with. `itemIds` is what a job the server reported on carries.
vi.mock("../src/hooks/useScoringJob", async () => {
  const { useEffect, useRef } = await import("react");
  return {
    useScoringJob: (_attemptId: string, args?: { start?: () => Promise<{ jobId: string }> }) => {
      const begun = useRef(false);
      const startRef = useRef(args?.start);
      startRef.current = args?.start;
      useEffect(() => {
        if (begun.current) return;
        begun.current = true;
        void startRef.current?.();
      }, []);
      return {
        status: "failed",
        itemIds: ["em-1"],
        stage: null,
        judgesDone: [],
        judgesFailed: ["gemini", "openai"],
        openaiJudgeProvider: null,
        arbiterProvider: null,
        fallbackFrom: null,
        queuePosition: null,
        elapsedMs: 0,
        result: null,
        error: "Both judges failed.",
        cancellationRequestedAt: null,
        terminalAt: null,
        cancellationReason: null,
        retry: () => {},
      };
    },
  };
});

const NOTHING_CONFIGURED: SetupStatusVM = {
  claudeCli: "not-installed",
  codexCli: "not-installed",
  geminiApiKey: false,
  openaiApiKey: false,
  geminiJudgeModel: false,
  openaiJudgeModel: false,
  ffmpeg: true,
  ffprobe: true,
  capabilities: {
    "reading-writing-generation": false,
    "speaking-listening-generation": false,
    "writing-scoring": false,
    "speaking-scoring": false,
    "speaking-uploads": true,
  },
  missing: [
    { piece: "claude-cli", disables: ["reading-writing-generation", "speaking-listening-generation", "writing-scoring", "speaking-scoring"] },
    { piece: "gemini-api-key", disables: ["speaking-listening-generation", "writing-scoring", "speaking-scoring"] },
  ],
  rubrics: { source: "rewritten" },
} as SetupStatusVM;

const ALL_SET_UP: SetupStatusVM = {
  ...NOTHING_CONFIGURED,
  claudeCli: "ready",
  geminiApiKey: true,
  capabilities: {
    "reading-writing-generation": true,
    "speaking-listening-generation": true,
    "writing-scoring": true,
    "speaking-scoring": true,
    "speaking-uploads": true,
  },
  missing: [],
} as SetupStatusVM;

const writingSet = {
  id: "wri-test",
  kind: "writing",
  source: "generated",
  createdAt: "2026-01-01T00:00:00Z",
  buildASentence: {
    items: [{ id: "bs-1", prompt: "Arrange the sentence.", tiles: ["a", "b"], correctAnswers: [["a", "b"]] }],
  },
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
    professorPost: "Discuss the incentive effects.",
    studentPosts: [{ name: "Ana", post: "I think subsidies distort prices." }],
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

// The provider sits where App.tsx puts it, around the page.
function mount(path: string, routes: { path: string; element: React.ReactNode }[]) {
  return renderRoutes(
    routes.map((r) => ({ ...r, element: <SetupStatusProvider>{r.element}</SetupStatusProvider> })),
    path,
  );
}

const NOT_SET_UP = "Scoring isn't set up on this machine";

let attemptSeq = 0;

beforeEach(async () => {
  const api = await import("../src/lib/api");
  (api.getSet as any).mockImplementation(async (id: string) => (id.startsWith("spk") ? speakingSet : writingSet));
  (api.createAttempt as any).mockResolvedValue({ attemptId: `att-setup-${++attemptSeq}`, isRepeat: false });
  (api.getSetupStatus as any).mockResolvedValue(NOTHING_CONFIGURED);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("before a Speaking or Writing run starts", () => {
  it("the Writing Drill's picker says the essays can't be scored here, links to Setup, and leaves Build a Sentence alone", async () => {
    mount("/writing/wri-test", [{ path: "/writing/:setId", element: <WritingDrill /> }]);
    const notice = (await screen.findByText(NOT_SET_UP)).closest("div.flex") as HTMLElement;
    expect(notice).toHaveTextContent("Your essays will be saved, but they can't be scored here until Setup is complete.");
    expect(notice).toHaveTextContent("Build a Sentence is scored as usual.");
    expect(within(notice).getByRole("link", { name: "See what's missing" })).toHaveAttribute("href", "/#setup");
    // It names a capability, never a provider.
    expect(notice.textContent).not.toMatch(/Claude|Codex|Gemini|OpenAI/);
    // It never blocks starting.
    expect(screen.getByRole("button", { name: /^Write an Email/ })).toBeEnabled();
  });

  it("the Writing Drill's intro carries it for an essay, and not for Build a Sentence alone", async () => {
    const user = userEvent.setup();
    mount("/writing/wri-test", [{ path: "/writing/:setId", element: <WritingDrill /> }]);
    await screen.findByText(NOT_SET_UP);

    await user.click(screen.getByRole("button", { name: /^Build a Sentence/ }));
    await screen.findByRole("button", { name: "Start Writing Drill" });
    expect(screen.queryByText(NOT_SET_UP)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Change Task Type" }));
    await user.click(await screen.findByRole("button", { name: /^Write an Email/ }));
    await screen.findByRole("button", { name: "Start Writing Drill" });
    expect(await screen.findByText(NOT_SET_UP)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Writing Drill" })).toBeEnabled();
  });

  it("the Speaking Drill's picker says the recordings can't be scored here", async () => {
    mount("/speaking/spk-1", [{ path: "/speaking/:setId", element: <SpeakingDrill /> }]);
    const notice = (await screen.findByText(NOT_SET_UP)).closest("div.flex") as HTMLElement;
    expect(notice).toHaveTextContent("Your recordings will be saved, but they can't be scored here until Setup is complete.");
    expect(within(notice).getByRole("link", { name: "See what's missing" })).toHaveAttribute("href", "/#setup");
  });

  it("the Writing and Speaking Simulations' first screens carry it", async () => {
    const writing = mount("/simulate/writing", [{ path: "/simulate/:kind", element: <SimulationRun /> }]);
    await screen.findByRole("button", { name: "Start Writing Simulation" });
    const writingNotice = (await screen.findByText(NOT_SET_UP)).closest("div.flex") as HTMLElement;
    expect(writingNotice).toHaveTextContent("Build a Sentence is scored as usual.");
    writing.unmount();
    mount("/simulate/speaking", [{ path: "/simulate/:kind", element: <SimulationRun /> }]);
    await screen.findByRole("button", { name: "Check your microphone" });
    const speakingNotice = (await screen.findByText(NOT_SET_UP)).closest("div.flex") as HTMLElement;
    expect(speakingNotice).toHaveTextContent("Your recordings will be saved");
  });

  it("says nothing new on a machine that can score", async () => {
    const api = await import("../src/lib/api");
    (api.getSetupStatus as any).mockResolvedValue(ALL_SET_UP);
    mount("/writing/wri-test", [{ path: "/writing/:setId", element: <WritingDrill /> }]);
    await screen.findByRole("button", { name: /^Write an Email/ });
    await waitFor(() => expect(api.getSetupStatus).toHaveBeenCalled());
    // Let the answer land before looking for its absence.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(NOT_SET_UP)).not.toBeInTheDocument();
  });
});

describe("after scoring fails on a machine that is not set up", () => {
  async function writeAndSubmitEmail(user: ReturnType<typeof userEvent.setup>) {
    mount("/writing/wri-test", [
      { path: "/writing/:setId", element: <WritingDrill /> },
      { path: "/attempts/:id", element: <p>attempt report</p> },
    ]);
    await user.click(await screen.findByRole("button", { name: /^Write an Email/ }));
    await user.click(await screen.findByRole("button", { name: "Start Writing Drill" }));
    await user.type(await screen.findByRole("textbox"), "Dear Professor, please grant me an extension.");
    await user.click(screen.getByRole("button", { name: /^Submit/ }));
    await screen.findByRole("heading", { name: "Results" });
  }

  it("the Writing Drill's results say why, link to Setup, and open the saved essay's report", async () => {
    const user = userEvent.setup();
    await writeAndSubmitEmail(user);
    const alert = await screen.findByRole("alert");
    await within(alert).findByText(/Scoring isn't set up on this machine, so this Response couldn't be scored/);
    expect(alert).not.toHaveTextContent("Both judges failed.");
    expect(within(alert).getByRole("link", { name: "See what's missing" })).toHaveAttribute("href", "/#setup");
    expect(screen.getByText(/Your Response is saved with this Attempt/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Finish and open the report" }));
    expect(await screen.findByText("attempt report")).toBeInTheDocument();
  });

  it("keeps the server's words when the machine is set up", async () => {
    const api = await import("../src/lib/api");
    (api.getSetupStatus as any).mockResolvedValue(ALL_SET_UP);
    const user = userEvent.setup();
    await writeAndSubmitEmail(user);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Both judges failed.");
    expect(within(alert).queryByRole("link", { name: "See what's missing" })).toBeNull();
  });

  it("Attempt review says why a failed essay has no score and links to Setup", async () => {
    const api = await import("../src/lib/api");
    const failed: ItemVM = {
      attemptId: "att-1",
      itemId: "email-1",
      taskType: "email",
      responseText: "Dear team, please fix the date.",
      responseAudioPath: null,
      transcript: null,
      score: null,
      scoreJson: { error: "Both judges failed." },
      scoringStatus: "failed",
      deliveryReport: null,
      createdAt: "2026-08-01T10:00:00.000Z",
    } as ItemVM;
    const detail = {
      attempt: {
        id: "att-1",
        kind: "writing",
        mode: "drill",
        setId: "wri-1",
        setTitle: "Wrong date on a tour confirmation",
        isRepeat: false,
        status: "completed",
        startedAt: "2026-08-01T10:00:00.000Z",
        completedAt: "2026-08-01T10:30:00.000Z",
        captureFinishedAt: null,
        flagged: false,
      },
      items: [failed],
      judgeReports: [],
      estimate: null,
      bandStatus: { status: "incomplete", unscored: [], absent: [] },
      activeJobs: [],
    } as unknown as AttemptDetailVM;
    (api.getAttempt as any).mockResolvedValue(detail);
    (api.getSet as any).mockRejectedValue(new Error("404: not found"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mount("/attempts/att-1", [{ path: "/attempts/:id", element: <AttemptReview /> }]);

    const card = await screen.findByTestId("item-email-1");
    await within(card).findByText(/Scoring isn't set up on this machine, so this Response couldn't be scored/);
    // In place of the bare summary; the server's own words stay behind "What the server reported".
    expect(card).not.toHaveTextContent("Scoring did not finish.");
    expect(within(card).getByRole("link", { name: "See what's missing" })).toHaveAttribute("href", "/#setup");
    // The way to score it once set up is still there.
    expect(within(card).getByRole("button", { name: "Re-score" })).toBeInTheDocument();
  });
});
