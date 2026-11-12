import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AttemptDetailVM, ItemVM } from "@toefl-prep/shared";
import AttemptReview from "../src/pages/AttemptReview";
import { getAttempt, getScoreJob, getSet, scoreTask } from "../src/lib/api";

// What a Task Type's group in Attempt review says once rather than on every card: the Listen and
// Repeat scene, and the Re-score that sends every failed Item of the Task Type together. Each card
// keeps what is its own: its reason.

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

const failed = (itemId: string, taskType: "listen_repeat" | "interview", error = "scoring request did not arrive") =>
  item({ itemId, taskType, transcript: "we open at six", responseAudioPath: `responses/att-1/${itemId}.webm`, scoringStatus: "failed", scoreJson: { error } });

function speaking(items: ItemVM[]): AttemptDetailVM {
  return {
    attempt: {
      id: "att-1",
      kind: "speaking",
      mode: "simulation",
      setId: "spk-1",
      setTitle: "At the Campus Library",
      isRepeat: false,
      status: "completed",
      startedAt: "2026-08-23T16:00:00.000Z",
      completedAt: "2026-08-23T16:30:04.000Z",
      captureFinishedAt: "2026-08-23T16:20:00.000Z",
      flagged: false,
      modulePath: null,
      routerRaw: null,
    },
    items,
    judgeReports: [],
    estimate: null,
    bandStatus: { status: "incomplete", unscored: [{ taskType: "interview", failed: 3, pending: 0, notCaptured: 0 }], absent: [] },
    activeJobs: [],
  };
}

const SERVED_SPEAKING = {
  id: "spk-1",
  kind: "speaking",
  source: "generated",
  createdAt: "2026-08-01T00:00:00.000Z",
  listenAndRepeat: {
    scenarioTitle: "At the Campus Library",
    scenarioDescription: "A tour.",
    image: { file: "images/scenarios/spk-1.webp" },
    items: [1, 2, 3].map((n) => ({ id: `lr-${n}`, audio: `lr-${n}.mp3`, responseWindowSec: 8, focusRegion: { x: 0.1 * n, y: 0.1, w: 0.2, h: 0.2 } })),
  },
  interview: { scenarioTitle: "Study habits", intro: "Hello.", questions: [] },
};

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
  vi.mocked(getSet).mockResolvedValue(SERVED_SPEAKING as never);
});

describe("a Task Type's failed Items in Attempt review", () => {
  it("puts one Re-score at the group and keeps each card's reason", async () => {
    vi.mocked(scoreTask).mockResolvedValue({ jobId: "job-1" });
    vi.mocked(getScoreJob).mockResolvedValue({ jobId: "job-1", taskType: "interview", itemIds: [], stage: "judging", status: "running", progress: null });
    await renderReview(speaking([failed("int-1", "interview"), failed("int-2", "interview", "scoring interrupted"), failed("int-3", "interview")]));

    const group = screen.getByRole("region", { name: "Interview" });
    for (const id of ["int-1", "int-2", "int-3"]) {
      const card = within(group).getByTestId(`item-${id}`);
      expect(within(card).queryByRole("button", { name: /Re-score/ })).toBeNull();
      // The chip and the Notice both say it; the Notice also says why, and how to re-score.
      expect(within(card).getAllByText("Scoring failed").length).toBeGreaterThan(0);
      expect(within(card).getByText(/from the top of this group/)).toBeInTheDocument();
    }
    expect(within(screen.getByTestId("item-int-2")).getByText(/Scoring was interrupted when the server stopped\./)).toBeInTheDocument();

    const buttons = within(group).getAllByRole("button", { name: "Re-score 3 Items" });
    expect(buttons).toHaveLength(1);
    await userEvent.click(buttons[0]);
    await waitFor(() =>
      expect(vi.mocked(scoreTask)).toHaveBeenCalledWith("att-1", {
        taskType: "interview",
        items: [{ itemId: "int-1" }, { itemId: "int-2" }, { itemId: "int-3" }],
      }),
    );
  });

  it("keeps the Re-score on the card when it is the only Item of its Task Type that needs one", async () => {
    await renderReview(speaking([failed("int-1", "interview"), item({ itemId: "int-2", taskType: "interview", scoringStatus: "pending" })]));
    expect(within(screen.getByTestId("item-int-1")).getByRole("button", { name: "Re-score" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Re-score \d+ Items/ })).toBeNull();
  });
});

describe("the Listen and Repeat scene in Attempt review", () => {
  it("is shown once for the group, not on every sentence", async () => {
    await renderReview(speaking([failed("lr-1", "listen_repeat"), failed("lr-2", "listen_repeat"), failed("lr-3", "listen_repeat")]));
    await screen.findAllByRole("img", { name: "Scene illustration", hidden: true });
    const group = screen.getByRole("region", { name: "Listen and Repeat" });
    expect(within(group).getAllByRole("img", { name: "Scene illustration", hidden: true })).toHaveLength(1);
    for (const id of ["lr-1", "lr-2", "lr-3"]) {
      expect(within(screen.getByTestId(`item-${id}`)).queryByRole("img", { name: "Scene illustration", hidden: true })).toBeNull();
    }
  });
});
