import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AttemptDetailVM, ItemVM, ScoringJobDetailVM } from "@toefl-prep/shared";
import AttemptReview from "../src/pages/AttemptReview";
import { getAttempt, getScoreJob, getSet, scoreTask } from "../src/lib/api";

// A Re-score keeps the committed score until the new one commits: when the new scoring fails, the
// server leaves the Item scored, and the review keeps its Score Report on screen with the failure
// and a Retry beside it. Only an Item with no score is replaced by the failure.

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

function item(over: Partial<ItemVM> & Pick<ItemVM, "itemId" | "taskType">): ItemVM {
  return {
    attemptId: "att-1",
    responseText: null,
    responseAudioPath: null,
    transcript: null,
    score: null,
    scoreJson: null,
    scoringStatus: "pending",
    deliveryReport: null,
    createdAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

function detail(kind: "speaking" | "writing", items: ItemVM[], activeJobs: AttemptDetailVM["activeJobs"] = []): AttemptDetailVM {
  return {
    attempt: {
      id: "att-1",
      kind,
      mode: "simulation",
      setId: kind === "speaking" ? "spk-1" : "wri-1",
      setTitle: kind === "speaking" ? "At the Campus Library" : "Wrong date on a tour confirmation",
      isRepeat: false,
      status: "completed",
      startedAt: "2026-08-01T10:00:00.000Z",
      completedAt: "2026-08-01T10:30:00.000Z",
      captureFinishedAt: null,
      flagged: false,
    },
    items,
    judgeReports: [],
    estimate: null,
    bandStatus: { status: "incomplete", unscored: [], absent: [] },
    activeJobs,
  };
}

function failedJob(over: Partial<ScoringJobDetailVM>): ScoringJobDetailVM {
  return {
    jobId: "job-1",
    taskType: "email",
    itemIds: ["email-1"],
    stage: null,
    status: "failed",
    progress: null,
    error: "Both judges failed.",
    ...over,
  };
}

const report = (itemId: string, over: Record<string, unknown> = {}) => ({
  itemId,
  ownScore: 3.5,
  finalScore: 3.5,
  maxScore: 5,
  dimensions: [{ name: "organization", note: "Clear order." }],
  deductions: [{ quote: "I want you fix", issue: "Missing 'to'.", fix: "I want you to fix", category: "grammar" }],
  reconciliationNote: "Both Judges gave 3.5.",
  feedbackZh: "整體清楚，語法小錯。",
  modelRewrite: "I would appreciate it if you could correct the date.",
  selfArbitrated: true,
  ...over,
});

function renderReview() {
  render(
    <MemoryRouter initialEntries={["/attempts/att-1"]}>
      <Routes>
        <Route path="/attempts/:id" element={<AttemptReview />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(getAttempt).mockReset();
  vi.mocked(getSet).mockReset().mockRejectedValue(new Error("404: not found"));
  vi.mocked(getScoreJob).mockReset();
  vi.mocked(scoreTask).mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("Attempt review — a Re-score that fails", () => {
  it("keeps an essay's Score Report on screen, says the Re-score failed, and offers a Retry", async () => {
    const scored = item({
      itemId: "email-1",
      taskType: "email",
      responseText: "Dear team, I want you fix the date of my tour.",
      score: 3.5,
      scoringStatus: "scored",
      scoreJson: report("email-1"),
    });
    // The server keeps the committed score through a failed re-score, before and after it.
    vi.mocked(getAttempt).mockResolvedValue(detail("writing", [scored]));
    vi.mocked(scoreTask).mockResolvedValue({ jobId: "job-1" });
    vi.mocked(getScoreJob).mockResolvedValue(failedJob({}));
    renderReview();

    const card = await screen.findByTestId("item-email-1");
    await userEvent.click(within(card).getByRole("button", { name: "Re-score" }));

    const notice = await within(card).findByRole("alert");
    expect(notice).toHaveTextContent("Re-score failed");
    expect(notice).toHaveTextContent("Both judges failed.");
    expect(notice).toHaveTextContent("The score below still stands");
    expect(within(notice).getByRole("button", { name: "Retry scoring" })).toBeInTheDocument();

    expect(within(card).getByText("Scored")).toBeInTheDocument();
    expect(within(card).queryByText("Scoring failed")).toBeNull();
    expect(within(card).getByText("整體清楚，語法小錯。")).toBeInTheDocument();
    expect(within(card).getByRole("heading", { name: /Deductions/ })).toBeInTheDocument();
    expect(within(card).getByText("I want you to fix")).toBeInTheDocument();
    expect(within(card).getByText("I would appreciate it if you could correct the date.")).toBeInTheDocument();
    expect(within(card).getAllByText("3.5").length).toBeGreaterThan(0);

    await userEvent.click(within(notice).getByRole("button", { name: "Retry scoring" }));
    await waitFor(() => expect(vi.mocked(scoreTask)).toHaveBeenCalledTimes(2));
  });

  it("keeps a spoken Item's Score Report on screen under the failed Re-score", async () => {
    const scored = item({
      itemId: "lr-3",
      taskType: "listen_repeat",
      responseAudioPath: "responses/att-1/lr-3.webm",
      transcript: "please return the books to the shelf",
      score: 4,
      scoringStatus: "scored",
      scoreJson: report("lr-3", {
        finalScore: 4,
        ownScore: 4,
        deductions: [{ quote: "to the shelf", issue: "Dropped a word.", fix: "to the top shelf", category: "accuracy" }],
        feedbackZh: "整體重複得很好。",
        modelRewrite: undefined,
      }),
    });
    vi.mocked(getAttempt)
      .mockResolvedValueOnce(detail("speaking", [scored], [{ jobId: "job-1", taskType: "listen_repeat", itemIds: ["lr-3"], stage: "judging", status: "running" }]))
      .mockResolvedValue(detail("speaking", [scored]));
    vi.mocked(getScoreJob).mockResolvedValue(failedJob({ taskType: "listen_repeat", itemIds: ["lr-3"] }));
    renderReview();

    const card = await screen.findByTestId("item-lr-3");
    expect(await within(card).findByRole("alert")).toHaveTextContent("Re-score failed");
    expect(within(card).getByText("Scored")).toBeInTheDocument();
    expect(within(card).getByText("整體重複得很好。")).toBeInTheDocument();
    expect(within(card).getByText("to the top shelf")).toBeInTheDocument();
  });

  it("still shows the failure in place of the report when a first scoring fails", async () => {
    const unscored = item({ itemId: "email-1", taskType: "email", responseText: "Dear team, please fix the date." });
    vi.mocked(getAttempt)
      .mockResolvedValueOnce(detail("writing", [unscored], [{ jobId: "job-1", taskType: "email", itemIds: ["email-1"], stage: "judging", status: "running" }]))
      .mockResolvedValue(detail("writing", [{ ...unscored, scoringStatus: "failed", scoreJson: { error: "Both judges failed." } }]));
    vi.mocked(getScoreJob).mockResolvedValue(failedJob({}));
    renderReview();

    const card = await screen.findByTestId("item-email-1");
    const notice = await within(card).findByRole("alert");
    expect(notice).toHaveTextContent("Scoring failed");
    expect(notice).not.toHaveTextContent("Re-score failed");
    expect(within(card).queryByRole("heading", { name: /Deductions/ })).toBeNull();
  });
});
