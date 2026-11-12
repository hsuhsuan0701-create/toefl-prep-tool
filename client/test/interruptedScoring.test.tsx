import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AttemptDetailVM, ItemVM, ScoringJobDetailVM } from "@toefl-prep/shared";
import AttemptReview from "../src/pages/AttemptReview";
import SpeakingResultSlot from "../src/pages/speakingDrill/SpeakingResultSlot";
import type { SpeakingSlotSpec } from "../src/pages/speakingDrill/speakingDrillModel";
import { CompletedStageView } from "../src/pages/WritingDrillResults";
import { getAttempt, getScoreJob, getSet, scoreTask } from "../src/lib/api";

// A scoring job cancelled for any reason but supersession (here, the server stopping mid-scoring)
// has nothing to carry its work on: the server marks its Items failed. Wherever the job is drawn,
// it ends as a failed job does: it says scoring was interrupted, in the cancellation's own words,
// and offers a Retry that starts a new job.

vi.mock("../src/lib/api", () => ({
  getAttempt: vi.fn(),
  getSet: vi.fn(),
  getScoreJob: vi.fn(),
  retryTranscription: vi.fn(),
  scoreTask: vi.fn(),
  HttpError: class HttpError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

function shutdownJob(over: Partial<ScoringJobDetailVM> = {}): ScoringJobDetailVM {
  return {
    jobId: "job-1",
    taskType: "listen_repeat",
    itemIds: ["lr-3"],
    stage: null,
    status: "cancelled",
    progress: null,
    cancellationReason: "shutdown",
    terminalAt: "2026-08-01T10:31:00.000Z",
    ...over,
  };
}

function speakingItem(over: Partial<ItemVM>): ItemVM {
  return {
    attemptId: "att-1",
    itemId: "lr-3",
    taskType: "listen_repeat",
    responseText: null,
    responseAudioPath: "responses/att-1/lr-3.webm",
    transcript: "a transcript",
    score: null,
    scoreJson: null,
    scoringStatus: "pending",
    deliveryReport: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

function speakingDetail(item: ItemVM, activeJobs: AttemptDetailVM["activeJobs"]): AttemptDetailVM {
  return {
    attempt: {
      id: "att-1",
      kind: "speaking",
      mode: "drill",
      setId: "spk-1",
      setTitle: "Roommate Move-In Walkthrough",
      isRepeat: false,
      status: "completed",
      startedAt: "2026-08-01T10:00:00.000Z",
      completedAt: "2026-08-01T10:30:00.000Z",
      captureFinishedAt: null,
      flagged: false,
    },
    items: [item],
    judgeReports: [],
    estimate: null,
    bandStatus: { status: "incomplete", unscored: [], absent: [] },
    activeJobs,
  };
}

beforeEach(() => {
  vi.mocked(getAttempt).mockReset();
  vi.mocked(getSet).mockReset().mockRejectedValue(new Error("404: not found"));
  vi.mocked(getScoreJob).mockReset();
  vi.mocked(scoreTask).mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("Attempt review — a scoring job interrupted by a server shutdown", () => {
  it("refreshes the Attempt, says scoring was interrupted, and offers a Retry that re-scores the Item", async () => {
    vi.mocked(getAttempt)
      .mockResolvedValueOnce(
        speakingDetail(speakingItem({ scoringStatus: "pending" }), [
          { jobId: "job-1", taskType: "listen_repeat", itemIds: ["lr-3"], stage: "judging", status: "running" },
        ]),
      )
      // The server has marked the Item failed and the job is no longer active.
      .mockResolvedValue(speakingDetail(speakingItem({ scoringStatus: "failed", scoreJson: { error: "scoring interrupted" } }), []));
    vi.mocked(getScoreJob).mockResolvedValue(shutdownJob());
    vi.mocked(scoreTask).mockResolvedValue({ jobId: "job-2" });
    render(
      <MemoryRouter initialEntries={["/attempts/att-1"]}>
        <Routes>
          <Route path="/attempts/:id" element={<AttemptReview />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(vi.mocked(getAttempt)).toHaveBeenCalledTimes(2));
    const card = screen.getByTestId("item-lr-3");
    const notice = await within(card).findByRole("alert");
    expect(notice).toHaveTextContent("Scoring was interrupted");
    expect(notice).toHaveTextContent("Cancelled during server shutdown.");
    // The Item's own state, which the server set: failed, not the job's "Cancelled".
    await waitFor(() => expect(within(card).getByText("Scoring failed")).toBeInTheDocument());
    expect(within(card).queryByText("Cancelled")).toBeNull();

    await userEvent.click(within(card).getByRole("button", { name: "Retry scoring" }));
    await waitFor(() => expect(vi.mocked(scoreTask)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(scoreTask)).toHaveBeenCalledWith("att-1", { taskType: "listen_repeat", items: [{ itemId: "lr-3" }] });
  });

  // An interrupted re-score commits nothing, so an Item scored under Self-Arbitration keeps the score
  // it had: its Score Report stays on the page beneath the interruption.
  it("keeps showing the Score Report of an Item whose re-score was interrupted", async () => {
    const scored = speakingItem({
      scoringStatus: "scored",
      score: 4,
      scoreJson: {
        itemId: "lr-3",
        ownScore: 4,
        finalScore: 4,
        maxScore: 5,
        dimensions: [{ name: "Accuracy", note: "Mostly accurate." }],
        deductions: [],
        reconciliationNote: "Judges agreed.",
        feedbackZh: "整體重複得很好。",
        selfArbitrated: true,
      },
    });
    vi.mocked(getAttempt)
      .mockResolvedValueOnce(
        speakingDetail(scored, [{ jobId: "job-1", taskType: "listen_repeat", itemIds: ["lr-3"], stage: "judging", status: "running" }]),
      )
      .mockResolvedValue(speakingDetail(scored, []));
    vi.mocked(getScoreJob).mockResolvedValue(shutdownJob());
    render(
      <MemoryRouter initialEntries={["/attempts/att-1"]}>
        <Routes>
          <Route path="/attempts/:id" element={<AttemptReview />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(vi.mocked(getAttempt)).toHaveBeenCalledTimes(2));
    const card = screen.getByTestId("item-lr-3");
    expect(await within(card).findByRole("alert")).toHaveTextContent("Scoring was interrupted");
    expect(within(card).getByText("整體重複得很好。")).toBeInTheDocument();
    expect(within(card).getByText("Scored")).toBeInTheDocument();
  });
});

const speakingSpec: SpeakingSlotSpec = {
  kind: "listen_repeat",
  items: [{ id: "lr-3", audio: "lr-3.mp3", responseWindowSec: 8 }],
  transcripts: { "lr-3": "a transcript" },
  numberByItemId: { "lr-3": 3 },
  scene: null,
} as unknown as SpeakingSlotSpec;

// Each Drill's result slot, drawn as the one status line the run shows and as its results screen.
const slots = [
  {
    name: "a Speaking Drill's Listen and Repeat",
    render: (attemptId: string, compact: boolean) => (
      <SpeakingResultSlot attemptId={attemptId} spec={speakingSpec} compact={compact} onStatusChange={() => {}} />
    ),
  },
  {
    name: "a Writing Drill's Email",
    render: (attemptId: string, compact: boolean) => (
      <CompletedStageView
        stage={{ kind: "email", userText: "Dear Ms. Lee, …", itemId: "email-1", secondsUsed: 400 }}
        attemptId={attemptId}
        compact={compact}
        onEssayStatusChange={() => {}}
      />
    ),
  },
];

describe.each(slots)("$name result slot, after a server shutdown cancelled its scoring", ({ render: slot }) => {
  beforeEach(() => {
    vi.mocked(scoreTask).mockResolvedValue({ jobId: "job-1" });
    vi.mocked(getScoreJob).mockResolvedValue(shutdownJob());
  });

  it("no longer says the Task is being scored while the Drill runs", async () => {
    render(<MemoryRouter>{slot("att-compact", true)}</MemoryRouter>);
    expect(await screen.findByText(/scoring was interrupted\. You can retry it at the end of the Drill\./)).toBeInTheDocument();
    expect(screen.queryByText(/being scored while you go on/)).toBeNull();
  });

  it("offers a Retry on the results screen that starts a new scoring job", async () => {
    render(<MemoryRouter>{slot("att-results", false)}</MemoryRouter>);
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("Scoring was interrupted");
    expect(notice).toHaveTextContent("Cancelled during server shutdown.");
    expect(vi.mocked(scoreTask)).toHaveBeenCalledTimes(1);

    vi.mocked(getScoreJob).mockResolvedValue(shutdownJob({ jobId: "job-2", status: "running", cancellationReason: null, terminalAt: null }));
    await userEvent.click(within(notice).getByRole("button", { name: "Retry scoring" }));
    await waitFor(() => expect(vi.mocked(scoreTask)).toHaveBeenCalledTimes(2));
  });
});
