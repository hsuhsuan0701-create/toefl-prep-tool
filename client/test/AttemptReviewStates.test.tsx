import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AttemptDetailVM, ItemVM } from "@toefl-prep/shared";
import AttemptReview from "../src/pages/AttemptReview";
import ScoringProgress from "../src/components/ScoringProgress";
import { getAttempt, getScoreJob, getSet, scoreTask } from "../src/lib/api";

// The states real practice data puts on the Attempt review, each read the way the User needs it:
// what happened, whether it counts, and what (if anything) can be done.

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

function detail(kind: "speaking" | "writing", items: ItemVM[], over: Partial<AttemptDetailVM> = {}): AttemptDetailVM {
  return {
    attempt: {
      id: "att-1",
      kind,
      mode: "simulation",
      setId: kind === "speaking" ? "spk-1" : "wri-1",
      setTitle: kind === "speaking" ? "At the Campus Library" : "Ad-free plan still shows ads",
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
    activeJobs: [],
    ...over,
  };
}

const report = (itemId: string, over: Record<string, unknown> = {}) => ({
  itemId,
  ownScore: 4,
  finalScore: 4,
  maxScore: 5,
  dimensions: [{ name: "grammar & vocabulary", note: "Mostly accurate." }],
  deductions: [],
  reconciliationNote: "Both Judges gave 4.",
  feedbackZh: "整體表現穩定。",
  ...over,
});

async function renderReview(body: AttemptDetailVM) {
  vi.mocked(getAttempt).mockResolvedValue(body);
  render(
    <MemoryRouter initialEntries={["/attempts/att-1"]}>
      <Routes>
        <Route path="/attempts/:id" element={<AttemptReview />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(vi.mocked(getSet)).toHaveBeenCalled());
  await act(async () => {});
}

beforeEach(() => {
  vi.mocked(getAttempt).mockReset();
  vi.mocked(getSet).mockReset();
  vi.mocked(scoreTask).mockReset();
  vi.mocked(getScoreJob).mockReset();
  vi.mocked(getSet).mockRejectedValue(new Error("404: not found"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a spoken Response with no words in it", () => {
  it("offers a Re-score for a failed recording whose transcript is empty, which the server scores as no speech", async () => {
    vi.mocked(scoreTask).mockResolvedValue({ jobId: "job-1" });
    vi.mocked(getScoreJob).mockResolvedValue({ jobId: "job-1", taskType: "listen_repeat", itemIds: ["lr-4"], stage: "judging", status: "running", progress: null });
    await renderReview(
      detail("speaking", [
        item({ itemId: "lr-4", taskType: "listen_repeat", transcript: "", scoringStatus: "failed", scoreJson: { error: "scoring request did not arrive" } }),
      ]),
    );
    const card = screen.getByTestId("item-lr-4");
    await userEvent.click(within(card).getByRole("button", { name: "Re-score" }));
    await waitFor(() => expect(vi.mocked(scoreTask)).toHaveBeenCalledWith("att-1", { taskType: "listen_repeat", items: [{ itemId: "lr-4" }] }));
  });

  it("offers nothing for a recording that never reached the server, and says only a new Attempt can score it", async () => {
    await renderReview(
      detail("speaking", [
        item({ itemId: "lr-2", taskType: "listen_repeat", transcript: null, scoringStatus: "failed", scoreJson: { error: "recording upload did not arrive" } }),
      ]),
    );
    const card = screen.getByTestId("item-lr-2");
    expect(within(card).queryByRole("button", { name: "Re-score" })).toBeNull();
    expect(within(card).getByText("The recording never reached the server. It is not in the band.")).toBeInTheDocument();
    expect(within(card).getByText(/Only a new Attempt can score it/)).toBeInTheDocument();
  });

  it("reads a no-speech 0 as 'No speech detected' with its summary, and raises no Judge caution", async () => {
    await renderReview(
      detail("speaking", [
        item({
          itemId: "int-2",
          taskType: "interview",
          transcript: "",
          score: 0,
          scoringStatus: "scored",
          scoreJson: {
            ...report("int-2", { ownScore: 0, finalScore: 0, dimensions: [], feedbackZh: "這段錄音中沒有偵測到語音。" }),
            reconciliationNote: "No speech was detected in this recording, so it was scored 0 without being sent to the Judges.",
            noSpeechDetected: true,
            meta: { question: "What do you do on weekends?" },
          },
        }),
      ]),
    );
    const card = screen.getByTestId("item-int-2");
    expect(within(card).getByTestId("no-speech-note")).toHaveTextContent("No speech detected");
    expect(within(card).getByText("這段錄音中沒有偵測到語音。")).toHaveAttribute("lang", "zh-Hant");
    expect(within(card).queryByText("One Judge")).toBeNull();
    expect(within(card).queryByText(/Judge warning/)).toBeNull();
  });
});

describe("a judged Response's Deductions", () => {
  it("lists a Deduction whose quote is not in the Response with its number, unmarked, instead of dropping it", async () => {
    const text = "I would like to request a refund for this month.";
    await renderReview(
      detail("writing", [
        item({
          itemId: "email-1",
          taskType: "email",
          responseText: text,
          score: 4,
          scoringStatus: "scored",
          scoreJson: report("email-1", {
            deductions: [
              { quote: "request a refund", issue: "Abrupt.", fix: "ask for a refund", category: "register" },
              { quote: "a sentence that was never written", issue: "Invented.", fix: "—", category: "vocab" },
            ],
          }),
        }),
      ]),
    );
    const card = screen.getByTestId("item-email-1");
    const marks = card.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0]).toHaveTextContent("request a refund1");
    expect(within(card).getByLabelText("Deduction 2")).toBeInTheDocument();
    expect(within(card).getByText("a sentence that was never written")).toBeInTheDocument();
    expect(within(card).getByText(/Not marked/)).toBeInTheDocument();
    // Categories read as words, not as codes.
    expect(within(card).getByText("Vocabulary")).toBeInTheDocument();
  });
});

describe("work that will not finish by itself", () => {
  it("does not promise scoring for a recording saved but never transcribed on a finished Attempt", async () => {
    await renderReview(detail("speaking", [item({ itemId: "lr-1", taskType: "listen_repeat", scoringStatus: "transcription_pending" })]));
    const card = screen.getByTestId("item-lr-1");
    expect(within(card).getByText(/saved but never transcribed/)).toBeInTheDocument();
    expect(within(card).queryByText(/Scoring starts/)).toBeNull();
    expect(within(card).getByText("Not transcribed")).toBeInTheDocument();
    expect(within(card).queryByText("Transcribing")).toBeNull();
  });
});

describe("why there is no band", () => {
  it("names the failed Items and the Task Type with no Item, and promises no band a Re-score cannot bring", async () => {
    await renderReview(
      detail(
        "writing",
        [
          item({ itemId: "bas-1", taskType: "build_sentence", responseText: '["a"]', score: 1, scoringStatus: "scored", scoreJson: { correct: true, correctAnswers: [["a"]] } }),
          item({ itemId: "email-1", taskType: "email", responseText: "Hello.", scoringStatus: "failed", scoreJson: { error: "scoring interrupted" } }),
        ],
        { bandStatus: { status: "incomplete", unscored: [{ taskType: "email", failed: 1, pending: 0, notCaptured: 0 }], absent: ["discussion"] } },
      ),
    );
    const band = screen.getByTestId("band-summary");
    expect(within(band).getByText("No band")).toBeInTheDocument();
    expect(within(band).getByTestId("band-missing")).toHaveTextContent(
      "1 Write an Email Item failed scoring. No Academic Discussion Response was recorded.",
    );
    expect(within(band).getByTestId("band-missing")).toHaveTextContent(
      "Re-scoring the failed Items below still shows their Score Reports, but only a new Attempt can have a band.",
    );
  });

  it("says a discarded Attempt counts toward nothing, and offers nothing", async () => {
    await renderReview(detail("writing", [], { attempt: { ...detail("writing", []).attempt, status: "aborted", completedAt: null }, bandStatus: { status: "discarded" } }));
    expect(screen.getByTestId("band-missing")).toHaveTextContent("This Attempt was discarded, so it counts toward nothing.");
    // No band is coming, so the figure does not say "yet".
    expect(screen.getByText("No band")).toBeInTheDocument();
    expect(screen.getByText("Discarded")).toBeInTheDocument();
  });

  it("says scoring is still running and over what", async () => {
    await renderReview(detail("writing", [], { bandStatus: { status: "scoring", outstanding: [{ taskType: "discussion", itemCount: 1 }] } }));
    expect(screen.getByTestId("band-missing")).toHaveTextContent("Still scoring 1 Item of Academic Discussion.");
  });
});

describe("Reduced model independence", () => {
  it("is a caution chip with its one-line explanation, and leaves the score standing", async () => {
    await renderReview(
      detail("writing", [
        item({
          itemId: "disc-1",
          taskType: "discussion",
          responseText: "I agree with Ana.",
          score: 4,
          scoringStatus: "scored",
          scoreJson: report("disc-1", { selfArbitrated: true }),
        }),
      ]),
    );
    const card = screen.getByTestId("item-disc-1");
    expect(within(card).getAllByText("Reduced model independence").length).toBeGreaterThan(0);
    expect(within(card).getByText(/acted as Arbiter/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Re-score" })).toBeInTheDocument();
  });
});

describe("live scoring progress", () => {
  const base = {
    status: "running" as const,
    stage: "aggregating",
    judgesDone: ["gemini", "openai"],
    judgesFailed: [],
    openaiJudgeProvider: null,
    arbiterProvider: "claude" as const,
    fallbackFrom: null,
    elapsedMs: 42_000,
    error: null,
  };

  it("says a job with nothing ahead of it is waiting for a slot, not that zero requests are ahead", () => {
    render(<ScoringProgress job={{ ...base, queuePosition: 0 }} onRetry={vi.fn()} />);
    expect(screen.getByText("Waiting for a slot with Claude")).toBeInTheDocument();
    expect(screen.queryByText(/0 requests ahead/)).toBeNull();
  });

  it("counts the requests ahead when there are some", () => {
    render(<ScoringProgress job={{ ...base, queuePosition: 2 }} onRetry={vi.fn()} />);
    expect(screen.getByText("2 requests ahead in Claude's queue")).toBeInTheDocument();
  });

  it("announces the current checkpoint through a live region", () => {
    render(<ScoringProgress job={{ ...base, queuePosition: null }} onRetry={vi.fn()} />);
    const live = document.querySelectorAll('[aria-live="polite"]');
    expect([...live].map((el) => el.textContent).join(" ")).toMatch(/Scoring: step 2 of 3, Arbiter, in progress/);
  });
});
