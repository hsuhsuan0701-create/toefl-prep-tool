import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AttemptDetailVM, TranscriptionJobVM } from "@toefl-prep/shared";
import AttemptReview from "../src/pages/AttemptReview";
import { getAttempt, getSet, retryTranscription } from "../src/lib/api";
import { deferred } from "./deferred";

// Retry transcription on Attempt review is single-flight until the refreshed Attempt has arrived:
// between the POST being accepted and the refreshed job reaching the page, the panel still shows the
// job as failed, and a second click there would only be refused by the server.

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

function transcriptionJob(over: Partial<TranscriptionJobVM>): TranscriptionJobVM {
  return {
    jobId: "tj-1",
    status: "failed",
    automaticAttempts: 3,
    nextRetryAt: null,
    failureKind: "network",
    error: "Ears did not answer.",
    scoreJobId: null,
    ...over,
  };
}

function speakingDetail(job: TranscriptionJobVM): AttemptDetailVM {
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
    items: [
      {
        attemptId: "att-1",
        itemId: "lr-1",
        taskType: "listen_repeat",
        responseText: null,
        responseAudioPath: "responses/att-1/lr-1.webm",
        transcript: null,
        score: null,
        scoreJson: null,
        scoringStatus: "transcription_pending",
        deliveryReport: null,
        createdAt: "2026-08-01T10:00:00.000Z",
        transcriptionJob: job,
      },
    ],
    judgeReports: [],
    estimate: null,
    bandStatus: { status: "incomplete", unscored: [], absent: [] },
    activeJobs: [],
  };
}

beforeEach(() => {
  vi.mocked(getAttempt).mockReset();
  vi.mocked(getSet).mockReset().mockRejectedValue(new Error("404: not found"));
  vi.mocked(retryTranscription).mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("Retry transcription", () => {
  it("stays busy until the refreshed Attempt arrives, so a second click sends nothing", async () => {
    const refreshed = deferred<AttemptDetailVM>();
    const queued = speakingDetail(transcriptionJob({ status: "queued", error: null, failureKind: null }));
    vi.mocked(getAttempt)
      .mockResolvedValueOnce(speakingDetail(transcriptionJob({})))
      .mockReturnValueOnce(refreshed.promise)
      .mockResolvedValue(queued);
    vi.mocked(retryTranscription).mockResolvedValue(transcriptionJob({ status: "queued", error: null, failureKind: null }));
    render(
      <MemoryRouter initialEntries={["/attempts/att-1"]}>
        <Routes>
          <Route path="/attempts/:id" element={<AttemptReview />} />
        </Routes>
      </MemoryRouter>,
    );

    const retry = await screen.findByRole("button", { name: "Retry transcription" });
    await userEvent.click(retry);
    await waitFor(() => expect(vi.mocked(getAttempt)).toHaveBeenCalledTimes(2));

    // The POST was accepted; the refreshed Attempt has not arrived.
    const button = screen.getByRole("button", { name: "Retrying…" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(button);
    expect(vi.mocked(retryTranscription)).toHaveBeenCalledTimes(1);

    await act(async () => {
      refreshed.resolve(queued);
    });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull());
    expect(screen.getAllByText("Waiting to transcribe").length).toBeGreaterThan(0);
    expect(vi.mocked(retryTranscription)).toHaveBeenCalledTimes(1);
  });
});
