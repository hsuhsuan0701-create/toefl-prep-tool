import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AttemptDetailVM, AttemptBandStatusVM, ItemVM } from "@toefl-prep/shared";
import AttemptReview from "../src/pages/AttemptReview";
import { getAttempt, getSet, scoreTask } from "../src/lib/api";

// Attempt review over a band that needs the whole sitting scored: why there is none, in counts the
// User can act on, and what can be done from this page — a promise of a band only where re-scoring
// can close the gap. A discarded Attempt offers no Re-score at all.

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

const report = (itemId: string, over: Record<string, unknown> = {}) => ({
  itemId,
  ownScore: 3,
  finalScore: 3,
  maxScore: 5,
  dimensions: [{ name: "delivery", note: "Clear." }],
  deductions: [],
  reconciliationNote: "Both Judges gave 3.",
  feedbackZh: "表現穩定。",
  ...over,
});

const failedLr = (n: number) =>
  item({ itemId: `lr-${n}`, taskType: "listen_repeat", transcript: "we open at six", scoringStatus: "failed", scoreJson: { error: "scoring interrupted" } });
const skippedInterview = (n: number) =>
  item({ itemId: `int-${n}`, taskType: "interview", score: 0, scoringStatus: "scored", scoreJson: { skipped: true, reason: "No recording was made for this item." } });

function speaking(items: ItemVM[], bandStatus: AttemptBandStatusVM, status: "completed" | "aborted" = "completed"): AttemptDetailVM {
  return {
    attempt: {
      id: "att-1",
      kind: "speaking",
      mode: "simulation",
      setId: "spk-1",
      setTitle: "At the Campus Library",
      isRepeat: false,
      status,
      startedAt: "2026-08-23T16:00:00.000Z",
      completedAt: status === "completed" ? "2026-08-23T16:30:04.000Z" : null,
      captureFinishedAt: "2026-08-23T16:20:00.000Z",
      flagged: false,
      modulePath: null,
      routerRaw: null,
    },
    items,
    judgeReports: [],
    estimate: null,
    bandStatus,
    activeJobs: [],
  };
}

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
  vi.mocked(getSet).mockRejectedValue(new Error("404: not found"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("why a settled Attempt has no band", () => {
  it("counts the failed Items and promises a band from re-scoring them", async () => {
    await renderReview(
      speaking(
        [
          item({ itemId: "lr-1", taskType: "listen_repeat", transcript: "", score: 0, scoringStatus: "scored", scoreJson: report("lr-1", { finalScore: 0, noSpeechDetected: true }) }),
          ...[2, 3, 4, 5, 6, 7].map(failedLr),
          item({ itemId: "int-1", taskType: "interview", transcript: "I like it.", score: 3, scoringStatus: "scored", scoreJson: report("int-1") }),
          ...[2, 3, 4].map(skippedInterview),
        ],
        { status: "incomplete", unscored: [{ taskType: "listen_repeat", failed: 6, pending: 0, notCaptured: 0 }], absent: [] },
      ),
    );
    const band = screen.getByTestId("band-summary");
    expect(within(band).getByText("No band yet")).toBeInTheDocument();
    expect(within(band).getByTestId("band-missing")).toHaveTextContent(
      "6 Listen and Repeat Items failed scoring. Re-score them below to get a band.",
    );
  });

  it("says only a new Attempt can have a band when a recording never reached the server", async () => {
    await renderReview(
      speaking(
        [
          failedLr(1),
          item({ itemId: "int-4", taskType: "interview", scoringStatus: "failed", scoreJson: { error: "recording upload did not arrive" } }),
        ],
        {
          status: "incomplete",
          unscored: [
            { taskType: "listen_repeat", failed: 1, pending: 0, notCaptured: 0 },
            { taskType: "interview", failed: 0, pending: 0, notCaptured: 1 },
          ],
          absent: [],
        },
      ),
    );
    const band = screen.getByTestId("band-summary");
    expect(within(band).getByText("No band")).toBeInTheDocument();
    const why = within(band).getByTestId("band-missing");
    expect(why).toHaveTextContent("1 Listen and Repeat Item failed scoring. 1 Interview recording never reached the server.");
    expect(why).toHaveTextContent("only a new Attempt can have a band.");
    expect(why).not.toHaveTextContent("to get a band");
  });

  it("names Responses never scored and Task Types never recorded", async () => {
    await renderReview(
      speaking(
        [item({ itemId: "lr-1", taskType: "listen_repeat", scoringStatus: "transcription_pending" })],
        { status: "incomplete", unscored: [{ taskType: "listen_repeat", failed: 0, pending: 1, notCaptured: 0 }], absent: ["interview"] },
      ),
    );
    expect(screen.getByTestId("band-missing")).toHaveTextContent(
      "1 Listen and Repeat Response was never scored. No Interview Response was recorded. Only a new Attempt can have a band.",
    );
  });
});

// A routed Reading or Listening Simulation's band needs Items of both Modules it took, so one finished
// after its Router Module says which Module stands in the way, and that no Re-score can supply it.
describe("a routed Simulation short of a Module's Items", () => {
  function reading(bandStatus: AttemptBandStatusVM): AttemptDetailVM {
    const base = speaking([item({ itemId: "dl-1-q1", taskType: "daily_life", score: 1, scoringStatus: "scored", scoreJson: { correct: true, module: "router", answer: "a" } })], bandStatus);
    return { ...base, attempt: { ...base.attempt, kind: "reading", setId: "rd-1", captureFinishedAt: null, modulePath: "upper", routerRaw: 0.8 } };
  }

  it("names the Module it was routed to and never answered, and offers only a new Attempt", async () => {
    await renderReview(reading({
      status: "incomplete",
      unscored: [],
      absent: [],
      moduleShortfalls: [{ module: "upper", sat: false, absent: ["complete_words", "academic_passage"] }],
    }));
    const band = screen.getByTestId("band-summary");
    expect(within(band).getByText("No band")).toBeInTheDocument();
    expect(within(band).getByTestId("band-missing")).toHaveTextContent(
      "This Simulation was routed to the Upper Module and ended before any of it was answered. Only a new Attempt can have a band.",
    );
  });

  it("names the Task Types a Module it did answer has no Response of, in that Module", async () => {
    await renderReview(reading({
      status: "incomplete",
      unscored: [],
      absent: [],
      moduleShortfalls: [{ module: "upper", sat: true, absent: ["academic_passage"] }],
    }));
    expect(screen.getByTestId("band-missing")).toHaveTextContent(
      "No Read an Academic Passage Response was recorded in the Upper Module. Only a new Attempt can have a band.",
    );
  });
});

describe("one failed Item", () => {
  it("is re-scored as it, not them", async () => {
    await renderReview(
      speaking(
        [
          ...[1, 2, 3, 4, 5, 6, 7].map((n) => item({ itemId: `lr-${n}`, taskType: "listen_repeat", transcript: "we open at six", score: 4, scoringStatus: "scored", scoreJson: report(`lr-${n}`) })),
          item({ itemId: "int-1", taskType: "interview", transcript: "I like it.", scoringStatus: "failed", scoreJson: { error: "scoring request did not arrive" } }),
        ],
        { status: "incomplete", unscored: [{ taskType: "interview", failed: 1, pending: 0, notCaptured: 0 }], absent: [] },
      ),
    );
    expect(screen.getByTestId("band-missing")).toHaveTextContent("1 Interview Item failed scoring. Re-score it below to get a band.");
  });
});

describe("a discarded Attempt", () => {
  it("offers no Re-score, on a failed Item or a self-arbitrated one, and says why", async () => {
    await renderReview(
      speaking(
        [
          failedLr(1),
          item({ itemId: "int-1", taskType: "interview", transcript: "I like it.", score: 3, scoringStatus: "scored", scoreJson: report("int-1", { selfArbitrated: true }) }),
        ],
        { status: "discarded" },
        "aborted",
      ),
    );
    expect(screen.queryByRole("button", { name: "Re-score" })).toBeNull();
    expect(within(screen.getByTestId("item-lr-1")).getByText("This Attempt was discarded, so it cannot be scored.")).toBeInTheDocument();
    expect(within(screen.getByTestId("item-int-1")).getByText("This Attempt was discarded, so it cannot be scored.")).toBeInTheDocument();
    expect(vi.mocked(scoreTask)).not.toHaveBeenCalled();
  });

  it("still offers the Re-score on the same Items of a completed Attempt", async () => {
    await renderReview(speaking([failedLr(1)], { status: "incomplete", unscored: [{ taskType: "listen_repeat", failed: 1, pending: 0, notCaptured: 0 }], absent: ["interview"] }));
    expect(within(screen.getByTestId("item-lr-1")).getByRole("button", { name: "Re-score" })).toBeInTheDocument();
  });
});
