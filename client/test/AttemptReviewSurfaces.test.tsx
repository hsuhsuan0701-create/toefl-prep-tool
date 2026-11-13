import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./fakeTimers";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AttemptDetailVM, ItemVM, ScoringJobDetailVM } from "@toefl-prep/shared";
import AttemptReview from "../src/pages/AttemptReview";
import { getAttempt, getScoreJob, getSet, scoreTask } from "../src/lib/api";

// Attempt review, the page the User reads most: one scoring job's state is drawn only over the
// Items that job covers, a Build a Sentence Response is never composed with a frame it was not
// answered against, and nothing on the page promises what will not happen.

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

function baseItem(over: Partial<ItemVM> & Pick<ItemVM, "itemId" | "taskType">): ItemVM {
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

function detail(over: Partial<AttemptDetailVM> & { items: ItemVM[] }): AttemptDetailVM {
  return {
    attempt: {
      id: "att-1",
      kind: "writing",
      mode: "simulation",
      setId: "wri-1",
      setTitle: "Protective gloves for the biology workshop",
      isRepeat: false,
      status: "completed",
      startedAt: "2026-08-01T10:00:00.000Z",
      completedAt: "2026-08-01T10:30:00.000Z",
      captureFinishedAt: null,
      flagged: false,
    },
    judgeReports: [],
    estimate: null,
    bandStatus: { status: "incomplete", unscored: [], absent: [] },
    activeJobs: [],
    ...over,
  };
}

function renderReview() {
  render(
    <MemoryRouter initialEntries={["/attempts/att-1"]}>
      <Routes>
        <Route path="/attempts/:id" element={<AttemptReview />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function renderSettled(setId: string) {
  renderReview();
  await waitFor(() => expect(vi.mocked(getSet)).toHaveBeenCalledWith(setId));
  await act(async () => {});
}

beforeEach(() => {
  vi.mocked(getAttempt).mockReset();
  vi.mocked(getSet).mockReset();
  vi.mocked(getScoreJob).mockReset();
  vi.mocked(scoreTask).mockReset();
});

// Build a Sentence against a Set edited after the Attempt: Items answered as frameless arrangements
// that carry a frame in the Set as GET /api/sets/:id serves it. The fixtures copy real Attempts
// (the hex ids in the test names), with a healthy one as the control. A Response whose tiles are
// not drawn from the Item's current tiles is shown as its tiles in order, with a note, never
// composed with a frame it was not answered against.

function basItem(itemId: string, tiles: string[], scoreJson: Record<string, unknown>): ItemVM {
  return baseItem({ itemId, taskType: "build_sentence", responseText: JSON.stringify(tiles), score: scoreJson.correct ? 1 : 0, scoreJson, scoringStatus: "scored" });
}

const REVISED_SET = {
  id: "wri-2936d16f",
  kind: "writing",
  buildASentence: {
    items: [
      {
        id: "bas-1",
        prompt: "Why can’t I use the upstairs office doors yet?",
        frame: "The yellow temporary badge ___ ___ ___ ___ ___ tomorrow.",
        tiles: ["will be ready", "and", "provide", "lobby-only access,", "your photo badge", "provides"],
      },
      {
        id: "bas-2",
        prompt: "Why was my balcony seat changed for tonight’s performance?",
        frame: "Because ___ ___ ___ ___ ___ at the same ticket price.",
        tiles: ["are unsafe,", "replacement seat", "the loose balcony handrail", "we moved you", "is unsafe,", "to a main-floor"],
      },
    ],
  },
};

const OLD_BAS_1 = ["The yellow temporary badge", "provides lobby-only access,", "and", "your photo badge will be ready tomorrow."];
const OLD_BAS_2 = ["Because the loose balcony handrail", "is unsafe,", "we moved you", "to a main-floor replacement seat"];

describe("Attempt review — a Build a Sentence Response against a Set revised after the Attempt", () => {
  it("shows the Response as its tiles in order, with a note, instead of composing it with today's frame", async () => {
    vi.mocked(getAttempt).mockResolvedValue(detail({
      attempt: { ...detail({ items: [] }).attempt, setId: "wri-2936d16f" },
      items: [
        basItem("bas-1", OLD_BAS_1, { correct: true, correctAnswers: [OLD_BAS_1] }),
        basItem("bas-2", OLD_BAS_2, { correct: false, correctAnswers: [[...OLD_BAS_2, "at the same ticket price."]] }),
      ],
    }));
    vi.mocked(getSet).mockResolvedValue(REVISED_SET as never);
    await renderSettled("wri-2936d16f");

    expect(screen.getByTestId("bas-answer-bas-1")).toHaveTextContent(
      "Your Response: The yellow temporary badge provides lobby-only access, and your photo badge will be ready tomorrow.",
    );
    expect(screen.getByTestId("bas-answer-bas-1")).not.toHaveTextContent("___");
    expect(screen.getByTestId("bas-key-bas-1")).toHaveTextContent(
      "Key: The yellow temporary badge provides lobby-only access, and your photo badge will be ready tomorrow.",
    );
    expect(screen.getByTestId("bas-revised-bas-1")).toHaveTextContent(/revised after this Attempt/);

    // Four tiles against a five-tile key: a partly filled Response, so its tiles are listed in
    // order and the empty blank counted (#40), and today's frame is not drawn around them.
    const partial = screen.getByTestId("bas-answer-bas-2");
    expect(partial).toHaveTextContent("Your Response: 1 of 5 blanks left empty.");
    expect(Array.from(partial.querySelectorAll("[data-placed-tiles] [data-placed]")).map((el) => el.textContent)).toEqual(OLD_BAS_2);
    expect(partial).not.toHaveTextContent("___");
    expect(screen.getByTestId("bas-key-bas-2")).not.toHaveTextContent("Because Because");
  });

  it("does the same for a Response whose tiles were capitalised differently (6f0eb861)", async () => {
    const tiles = ["The equipment inspection", "takes place", "then."];
    vi.mocked(getAttempt).mockResolvedValue(detail({
      attempt: { ...detail({ items: [] }).attempt, setId: "wri-bdbdd45c" },
      items: [basItem("bas-1", tiles, { correct: true, correctAnswers: [tiles] })],
    }));
    vi.mocked(getSet).mockResolvedValue({
      id: "wri-bdbdd45c",
      kind: "writing",
      buildASentence: {
        items: [{ id: "bas-1", prompt: "Manager: Why does the loading dock close early every Friday?", frame: "The ___ ___ ___ ___ then.", tiles: ["take", "place", "takes", "inspection", "equipment"] }],
      },
    } as never);
    await renderSettled("wri-bdbdd45c");

    expect(screen.getByTestId("bas-answer-bas-1")).toHaveTextContent("Your Response: The equipment inspection takes place then.");
    expect(screen.getByTestId("bas-revised-bas-1")).toBeInTheDocument();
  });

  it("does the same where the old Response carried the frame's own words in its tiles (0c183660)", async () => {
    const tiles = ["The placement exam retake", "is only offered", "once per semester."];
    vi.mocked(getAttempt).mockResolvedValue(detail({
      attempt: { ...detail({ items: [] }).attempt, setId: "wri-550947bf" },
      items: [basItem("bas-2", tiles, { correct: true, correctAnswers: [tiles] })],
    }));
    vi.mocked(getSet).mockResolvedValue({
      id: "wri-550947bf",
      kind: "writing",
      buildASentence: {
        items: [{
          id: "bas-2",
          prompt: "Can I retake the placement exam this month if I'm not happy with my score?",
          frame: "The placement exam retake ___ ___ ___ ___.",
          tiles: ["only", "once per semester", "are", "offered", "is"],
        }],
      },
    } as never);
    await renderSettled("wri-550947bf");

    expect(screen.getByTestId("bas-answer-bas-2")).toHaveTextContent(
      "Your Response: The placement exam retake is only offered once per semester.",
    );
    expect(screen.getByTestId("bas-answer-bas-2")).not.toHaveTextContent("retake The placement");
    expect(screen.getByTestId("bas-revised-bas-2")).toBeInTheDocument();
  });

  it("composes a Response that fits today's Item with its frame, as before, and adds no note (ecc1d69c)", async () => {
    const tiles = ["don't", "have", "a", "backup part"];
    vi.mocked(getAttempt).mockResolvedValue(detail({
      attempt: { ...detail({ items: [] }).attempt, setId: "wri-1da7837a" },
      items: [basItem("bas-1", tiles, { correct: true, correctAnswers: [tiles] })],
    }));
    vi.mocked(getSet).mockResolvedValue({
      id: "wri-1da7837a",
      kind: "writing",
      buildASentence: {
        items: [{ id: "bas-1", prompt: "Our robot just failed its final weight check.", frame: "We ___ ___ ___ ___ on hand.", tiles: ["backup part", "doesn't", "a", "have", "don't"] }],
      },
    } as never);
    await renderSettled("wri-1da7837a");

    expect(screen.getByTestId("bas-answer-bas-1")).toHaveTextContent("Your Response: We don't have a backup part on hand.");
    expect(screen.queryByTestId("bas-revised-bas-1")).toBeNull();
  });

  it("prefers the frame persisted with the Response over the Set's current one", async () => {
    const tiles = ["don't", "have", "a", "backup part"];
    vi.mocked(getAttempt).mockResolvedValue(detail({
      attempt: { ...detail({ items: [] }).attempt, setId: "wri-1da7837a" },
      items: [basItem("bas-1", tiles, { correct: true, correctAnswers: [tiles], frame: "Sadly we ___ ___ ___ ___ today." })],
    }));
    vi.mocked(getSet).mockResolvedValue({
      id: "wri-1da7837a",
      kind: "writing",
      buildASentence: { items: [{ id: "bas-1", prompt: "p", frame: "Something ___ else ___ entirely.", tiles: ["x", "y"] }] },
    } as never);
    await renderSettled("wri-1da7837a");

    expect(screen.getByTestId("bas-answer-bas-1")).toHaveTextContent("Your Response: Sadly we don't have a backup part today.");
    expect(screen.queryByTestId("bas-revised-bas-1")).toBeNull();
  });
});

// One scoring job's state is drawn over the Items it covers and no others.

function scoredSpeakingItem(itemId: string, feedbackZh: string): ItemVM {
  return baseItem({
    itemId,
    taskType: "listen_repeat",
    transcript: "a transcript",
    score: 4,
    scoringStatus: "scored",
    scoreJson: {
      itemId,
      ownScore: 4,
      finalScore: 4,
      maxScore: 5,
      dimensions: [{ name: "Accuracy", note: "Mostly accurate." }],
      deductions: [],
      reconciliationNote: "Judges agreed.",
      feedbackZh,
    },
  });
}

function failedSpeakingItem(itemId: string): ItemVM {
  return baseItem({ itemId, taskType: "listen_repeat", transcript: "a transcript", scoringStatus: "failed", scoreJson: { error: "Scoring failed earlier." } });
}

function speakingDetail(items: ItemVM[], activeJobs: AttemptDetailVM["activeJobs"]): AttemptDetailVM {
  const base = detail({ items });
  return { ...base, attempt: { ...base.attempt, kind: "speaking", mode: "drill", setId: "spk-1", setTitle: "Roommate Move-In Walkthrough" }, activeJobs };
}

function job(over: Partial<ScoringJobDetailVM>): ScoringJobDetailVM {
  return { jobId: "job-1", taskType: "listen_repeat", itemIds: ["lr-3"], stage: "judging", status: "running", progress: null, ...over };
}

describe("Attempt review — a scoring job covers only its own Items", () => {
  beforeEach(() => {
    vi.mocked(getSet).mockRejectedValue(new Error("404: not found"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("draws a failed re-score of one Item over that Item only, leaving the other scores on screen", async () => {
    vi.mocked(getAttempt).mockResolvedValue(speakingDetail(
      [scoredSpeakingItem("lr-1", "第一句表現良好"), scoredSpeakingItem("lr-2", "第二句表現良好"), failedSpeakingItem("lr-3")],
      [{ jobId: "job-1", taskType: "listen_repeat", itemIds: ["lr-3"], stage: "judging", status: "running" }],
    ));
    vi.mocked(getScoreJob).mockResolvedValue(job({ status: "failed", stage: null, error: "arbiter failed" }));
    renderReview();

    // The job's own failure is announced (role alert); the persisted failure beside it is not.
    const covered = await screen.findByTestId("item-lr-3");
    expect(await within(covered).findByRole("alert")).toHaveTextContent("Scoring failed");
    for (const [id, feedback] of [["lr-1", "第一句表現良好"], ["lr-2", "第二句表現良好"]]) {
      const card = screen.getByTestId(`item-${id}`);
      expect(within(card).queryByText("Scoring failed")).toBeNull();
      expect(within(card).getByText(feedback)).toBeInTheDocument();
    }
  });

  it("lets an Item the failed job did not cover start a fresh re-score of the Task Type's failed Items", async () => {
    vi.mocked(getAttempt).mockResolvedValue(speakingDetail(
      [scoredSpeakingItem("lr-1", "第一句表現良好"), failedSpeakingItem("lr-3"), failedSpeakingItem("lr-5")],
      [{ jobId: "job-1", taskType: "listen_repeat", itemIds: ["lr-3"], stage: "judging", status: "running" }],
    ));
    vi.mocked(getScoreJob).mockResolvedValue(job({ status: "failed", stage: null, error: "arbiter failed" }));
    vi.mocked(scoreTask).mockResolvedValue({ jobId: "job-2" });
    renderReview();

    await within(await screen.findByTestId("item-lr-3")).findByRole("alert");
    // Two Items of the Task Type need a Re-score, so the one button is the group's.
    await userEvent.click(within(screen.getByRole("region", { name: "Listen and Repeat" })).getByRole("button", { name: "Re-score 2 Items" }));

    await waitFor(() => expect(vi.mocked(scoreTask)).toHaveBeenCalledTimes(1));
    expect(vi.mocked(scoreTask)).toHaveBeenCalledWith("att-1", {
      taskType: "listen_repeat",
      items: [{ itemId: "lr-3" }, { itemId: "lr-5" }],
    });
  });

  it("follows the job that replaced a cancelled one, instead of staying on the cancellation", async () => {
    const items = [scoredSpeakingItem("lr-1", "第一句表現良好"), failedSpeakingItem("lr-3")];
    vi.mocked(getAttempt)
      .mockResolvedValueOnce(speakingDetail(items, [{ jobId: "job-1", taskType: "listen_repeat", itemIds: ["lr-3"], stage: "judging", status: "running" }]))
      .mockResolvedValue(speakingDetail(items, [{ jobId: "job-2", taskType: "listen_repeat", itemIds: ["lr-3"], stage: "judging", status: "running" }]));
    vi.mocked(getScoreJob).mockImplementation(async (_attemptId, jobId) =>
      jobId === "job-1"
        ? job({ status: "cancelled", stage: null, cancellationReason: "superseded" })
        : job({ jobId: "job-2", status: "running" }),
    );
    renderReview();

    // The replaced job ends the first view; the refreshed Attempt names job-2, whose progress shows.
    await waitFor(() => expect(vi.mocked(getScoreJob)).toHaveBeenCalledWith("att-1", "job-2"));
    const covered = screen.getByTestId("item-lr-3");
    expect(await within(covered).findByRole("list", { name: "Scoring" })).toBeInTheDocument();
    expect(within(covered).queryByText("Cancelled by a newer Response")).toBeNull();
  });

  it("while a job is still running, an Item it does not cover says so instead of offering a Re-score that would do nothing", async () => {
    vi.mocked(getAttempt).mockResolvedValue(speakingDetail(
      [failedSpeakingItem("lr-3"), failedSpeakingItem("lr-5")],
      [{ jobId: "job-1", taskType: "listen_repeat", itemIds: ["lr-3"], stage: "judging", status: "running" }],
    ));
    vi.mocked(getScoreJob).mockResolvedValue(job({ status: "running" }));
    renderReview();

    const covered = await screen.findByTestId("item-lr-3");
    expect(await within(covered).findByRole("list", { name: "Scoring" })).toBeInTheDocument();
    expect(within(covered).queryByText("Scoring failed earlier.")).toBeNull();

    const uncovered = screen.getByTestId("item-lr-5");
    expect(within(uncovered).getByText(/once the scoring run in progress finishes/)).toBeInTheDocument();
    expect(within(uncovered).getByText("Scoring failed earlier.")).toBeInTheDocument();
    expect(within(uncovered).queryByRole("button", { name: "Re-score" })).toBeNull();
  });
});

// Nothing on the page promises what will not happen, and the header names the Set rather than only
// its id.

describe("Attempt review — what the page promises", () => {
  it("is titled by section and mode, and names the Set by its title with the id beside it", async () => {
    vi.mocked(getAttempt).mockResolvedValue(detail({ items: [] }));
    vi.mocked(getSet).mockResolvedValue({ id: "wri-1", kind: "writing", buildASentence: { items: [] } } as never);
    await renderSettled("wri-1");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Writing Simulation");
    expect(screen.getByText("Protective gloves for the biology workshop")).toBeInTheDocument();
    expect(screen.getByText("wri-1")).toBeInTheDocument();
  });

  it("does not promise a key on a completed Attempt whose Set could not be read", async () => {
    const base = detail({
      items: [baseItem({ itemId: "q1", taskType: "daily_life", score: 1, scoringStatus: "scored", scoreJson: { correct: true, module: "router", answer: "a" } })],
    });
    vi.mocked(getAttempt).mockResolvedValue({ ...base, attempt: { ...base.attempt, kind: "reading", setId: "rd-1" } });
    vi.mocked(getSet).mockRejectedValue(new Error("404: not found"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await renderSettled("rd-1");

    expect(screen.queryByText(/appear once this Attempt is complete/)).toBeNull();
    expect(screen.getByText(/aren't available/)).toBeInTheDocument();
  });

  it("still says the key arrives at completion while the Attempt is in progress", async () => {
    const base = detail({
      items: [baseItem({ itemId: "q1", taskType: "daily_life", score: 1, scoringStatus: "scored", scoreJson: { correct: true, module: "router", answer: "a" } })],
    });
    vi.mocked(getAttempt).mockResolvedValue({ ...base, attempt: { ...base.attempt, kind: "reading", setId: "rd-1", status: "in_progress", completedAt: null } });
    vi.mocked(getSet).mockRejectedValue(new Error("404: not found"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await renderSettled("rd-1");
    expect(screen.getByText(/appear once this Attempt is complete/)).toBeInTheDocument();
  });

  it("stops saying the page updates itself once it has stopped polling a stuck finalization", async () => {
    const clock = useFakeTimersInTest({ shouldAdvanceTime: false });
    const base = detail({ items: [] });
    vi.mocked(getAttempt).mockImplementation(async () => ({
      ...base,
      attempt: { ...base.attempt, kind: "speaking", setId: "spk-1", status: "in_progress", completedAt: null, captureFinishedAt: "2026-08-01T10:20:00.000Z" },
    }));
    vi.mocked(getSet).mockRejectedValue(new Error("404: not found"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    renderReview();
    await act(async () => {
      await clock.advanceBy(0);
    });
    expect(screen.getByText(/This page updates itself/)).toBeInTheDocument();

    for (let i = 0; i < 70; i++) {
      await act(async () => {
        await clock.advanceBy(2_000);
      });
    }
    expect(screen.queryByText(/This page updates itself/)).toBeNull();
    expect(screen.getByText(/Reload this page to check again/)).toBeInTheDocument();
  });
});
