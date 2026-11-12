import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AttemptDetailVM, ItemVM } from "@toefl-prep/shared";
import AttemptReview from "../src/pages/AttemptReview";
import { getAttempt, getSet } from "../src/lib/api";

// A Reading or Listening review reads as the test did: Items under the Stimulus they were answered
// against, in test order, each with the option the User picked written out, the key when it
// differs, and the Explanation open on the ones they missed.

vi.mock("../src/lib/api", () => ({
  getAttempt: vi.fn(),
  getSet: vi.fn(),
  getScoreJob: vi.fn(),
  retryTranscription: vi.fn(),
  scoreTask: vi.fn(),
  HttpError: class HttpError extends Error {},
}));

const OPTIONS = [
  { id: "a", text: "To sell a bicycle" },
  { id: "b", text: "To ask for a ride" },
  { id: "c", text: "To cancel a meeting" },
  { id: "d", text: "To book a room" },
];

const SERVED_READING = {
  id: "rd-1",
  kind: "reading",
  router: {
    timeLimitSec: 1200,
    ctwPassages: [{ id: "ctw-1", taskType: "complete_words", topic: "river restoration", segments: [], gaps: [{ id: "g1", prefix: "mon", blankLength: 2 }, { id: "g2", prefix: "gr", blankLength: 3 }] }],
    dailyLife: [{ id: "dl-1", taskType: "daily_life", genre: "text-message chain", text: "…", questions: [{ id: "q1", stem: "Why does Mia write?", options: OPTIONS }] }],
    academic: [],
  },
  lowerModule: { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] },
  upperModule: { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] },
};

function scored(itemId: string, taskType: string, correct: boolean, answer: string): ItemVM {
  return {
    attemptId: "att-1",
    itemId,
    taskType,
    responseText: null,
    responseAudioPath: null,
    transcript: null,
    score: correct ? 1 : 0,
    scoreJson: { correct, module: "router", answer },
    scoringStatus: "scored",
    deliveryReport: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  };
}

function readingDetail(over: Partial<AttemptDetailVM> = {}): AttemptDetailVM {
  return {
    attempt: {
      id: "att-1",
      kind: "reading",
      mode: "drill",
      setId: "rd-1",
      setTitle: "River restoration",
      isRepeat: false,
      status: "completed",
      startedAt: "2026-08-01T10:00:00.000Z",
      completedAt: "2026-08-01T10:20:00.000Z",
      captureFinishedAt: null,
      flagged: false,
    },
    items: [scored("g1", "complete_words", true, "th"), scored("g2", "complete_words", false, "ass"), scored("q1", "daily_life", false, "a")],
    judgeReports: [],
    estimate: null,
    bandStatus: { status: "not-applicable", reason: "drill" },
    activeJobs: [],
    deterministicReview: [
      { itemId: "g1", taskType: "complete_words", correct: true, key: "th", explanationZh: "月份。" },
      { itemId: "g2", taskType: "complete_words", correct: false, key: "avel", explanationZh: "礫石。" },
      { itemId: "q1", taskType: "daily_life", correct: false, key: "b", explanationZh: "她想搭便車。" },
    ],
    ...over,
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
  await waitFor(() => expect(vi.mocked(getSet)).toHaveBeenCalledWith("rd-1"));
  await act(async () => {});
}

beforeEach(() => {
  vi.mocked(getAttempt).mockReset();
  vi.mocked(getSet).mockReset();
  vi.mocked(getSet).mockResolvedValue(SERVED_READING as never);
});

describe("a completed Reading Attempt", () => {
  it("groups Items under the Stimulus they were answered against", async () => {
    await renderReview(readingDetail());
    const passage = screen.getByRole("region", { name: "River restoration" });
    expect(within(passage).getByTestId("item-g1")).toBeInTheDocument();
    expect(within(passage).getByTestId("item-g2")).toBeInTheDocument();
    const text = screen.getByRole("region", { name: "Text-message chain" });
    expect(within(text).getByTestId("item-q1")).toBeInTheDocument();
  });

  it("writes out the option picked and the key, with the Explanation open on a miss", async () => {
    await renderReview(readingDetail());
    const row = screen.getByTestId("item-q1");
    expect(row).toHaveTextContent("Why does Mia write?");
    expect(row).toHaveTextContent("Your Response: A. To sell a bicycle");
    expect(row).toHaveTextContent("Key: B. To ask for a ride");
    expect(within(row).getByText("Incorrect")).toBeInTheDocument();
    expect(within(row).getByText("她想搭便車。")).toHaveAttribute("lang", "zh-Hant");
    expect(row.querySelector("details")).toHaveAttribute("open");
  });

  it("completes a gap with its visible prefix, and keeps a correct Item's Explanation closed", async () => {
    await renderReview(readingDetail());
    const wrong = screen.getByTestId("item-g2");
    expect(wrong).toHaveTextContent("Your Response: grass");
    expect(wrong).toHaveTextContent("Correct completion: gravel");
    const right = screen.getByTestId("item-g1");
    expect(right).toHaveTextContent("Your Response: month");
    expect(right).not.toHaveTextContent("Correct completion");
    expect(right.querySelector("details")).not.toHaveAttribute("open");
  });

  it("says the Drill has no band and how to get one", async () => {
    await renderReview(readingDetail());
    expect(screen.getByTestId("band-missing")).toHaveTextContent("Reading Drills do not produce a band. Take a Reading Simulation for one.");
  });
});

describe("a Reading Attempt still in progress", () => {
  it("puts no question or option text on the page before the Attempt is complete", async () => {
    const base = readingDetail();
    await renderReview({
      ...base,
      attempt: { ...base.attempt, status: "in_progress", completedAt: null },
      bandStatus: { status: "unfinished" },
      deterministicReview: undefined,
    });
    const row = screen.getByTestId("item-q1");
    expect(row).toHaveTextContent("Your Response: Option A");
    expect(row).not.toHaveTextContent("Why does Mia write?");
    expect(screen.queryByText(/To sell a bicycle/)).toBeNull();
    expect(screen.getByText(/appear once this Attempt is complete/)).toBeInTheDocument();
  });

  // The prefix was printed in the paragraph the User read, so it is no key: a gap's Response reads
  // as the word they produced either way. The correct completion still waits for completion.
  it("writes out a gap's Response with its visible prefix, and no correct completion", async () => {
    const base = readingDetail();
    await renderReview({
      ...base,
      attempt: { ...base.attempt, status: "in_progress", completedAt: null },
      bandStatus: { status: "unfinished" },
      deterministicReview: undefined,
    });
    expect(screen.getByTestId("item-g1")).toHaveTextContent("Your Response: month");
    const wrong = screen.getByTestId("item-g2");
    expect(wrong).toHaveTextContent("Your Response: grass");
    expect(wrong).not.toHaveTextContent("Correct completion");
    expect(screen.queryByText(/gravel/)).toBeNull();
  });
});

describe("a discarded Reading Attempt", () => {
  // The server builds the key review only for a completed Attempt, and a discard is never undone.
  it("says its key and Explanations are not shown, rather than promising them", async () => {
    const base = readingDetail();
    await renderReview({
      ...base,
      attempt: { ...base.attempt, status: "aborted", completedAt: null },
      bandStatus: { status: "discarded" },
      deterministicReview: undefined,
    });
    expect(screen.getByText("This Attempt was discarded, so its key and Explanations are not shown.")).toBeInTheDocument();
    expect(screen.queryByText(/appear once this Attempt is complete/)).toBeNull();
    expect(screen.queryByText(/To sell a bicycle/)).toBeNull();
  });
});
