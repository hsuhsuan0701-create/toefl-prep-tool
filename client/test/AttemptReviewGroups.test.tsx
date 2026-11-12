import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

async function renderReview(body: AttemptDetailVM, entry = "/attempts/att-1") {
  vi.mocked(getAttempt).mockResolvedValue(body);
  render(
    <MemoryRouter initialEntries={[entry]}>
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

// A spoken Item is numbered by its place in the Set, not among the rows the Attempt has: a prompt
// that would not play and was skipped leaves no row, and the recordings after it must keep their own
// numbers, or "Sentence 1" plays the second sentence's recording.
describe("spoken Item numbers in Attempt review", () => {
  const recorded = (itemId: string, taskType: "listen_repeat" | "interview") =>
    item({ itemId, taskType, transcript: "we open at six", responseAudioPath: `responses/att-1/${itemId}.webm`, scoringStatus: "pending" });
  const titles = (group: HTMLElement) => within(group).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
  const players = (group: HTMLElement) =>
    Array.from(group.querySelectorAll("audio")).map((a) => [a.getAttribute("aria-label"), a.getAttribute("src")]);
  const withInterview = {
    ...SERVED_SPEAKING,
    interview: { ...SERVED_SPEAKING.interview, questions: [1, 2, 3, 4].map((n) => ({ id: `int-${n}`, audio: `int-${n}.mp3`, responseWindowSec: 45 })) },
  };

  it("keeps each recording's number in the Set when an earlier Item has no row", async () => {
    vi.mocked(getSet).mockResolvedValue(withInterview as never);
    await renderReview(speaking([recorded("lr-2", "listen_repeat"), recorded("lr-3", "listen_repeat"), recorded("int-1", "interview"), recorded("int-3", "interview")]));

    const sentences = screen.getByRole("region", { name: "Listen and Repeat" });
    await waitFor(() => expect(titles(sentences)).toEqual(["Sentence 2", "Sentence 3"]));
    expect(players(sentences)).toEqual([
      ["The sentence you heard, Sentence 2", "/api/audio/lr-2.mp3"],
      ["Your recording, Listen and Repeat 2", "/api/audio/responses/att-1/lr-2.webm"],
      ["The sentence you heard, Sentence 3", "/api/audio/lr-3.mp3"],
      ["Your recording, Listen and Repeat 3", "/api/audio/responses/att-1/lr-3.webm"],
    ]);
    expect(titles(screen.getByRole("region", { name: "Interview" }))).toEqual(["Question 1", "Question 3"]);
  });

  it("numbers an Attempt with every Item present as it always has", async () => {
    vi.mocked(getSet).mockResolvedValue(withInterview as never);
    await renderReview(speaking([1, 2, 3].map((n) => recorded(`lr-${n}`, "listen_repeat")).concat([1, 2, 3, 4].map((n) => recorded(`int-${n}`, "interview")))));
    expect(titles(screen.getByRole("region", { name: "Listen and Repeat" }))).toEqual(["Sentence 1", "Sentence 2", "Sentence 3"]);
    expect(titles(screen.getByRole("region", { name: "Interview" }))).toEqual(["Question 1", "Question 2", "Question 3", "Question 4"]);
  });

  it("falls back to the order of the rows when the Set cannot be read", async () => {
    vi.mocked(getSet).mockRejectedValue(new Error("404: not found"));
    await renderReview(speaking([recorded("lr-2", "listen_repeat"), recorded("lr-3", "listen_repeat")]));
    const sentences = screen.getByRole("region", { name: "Listen and Repeat" });
    expect(titles(sentences)).toEqual(["Sentence 1", "Sentence 2"]);
    expect(players(sentences).map(([name]) => name)).toEqual(["Your recording, Listen and Repeat 1", "Your recording, Listen and Repeat 2"]);
  });
});

// A spoken Item's prompt, played again beside the recording once the Attempt is over, whether or not
// the Item was scored. Audio only: the served Set carries neither the sentence nor the question.
describe("a spoken Item's prompt audio in Attempt review", () => {
  const players = (card: HTMLElement) =>
    Array.from(card.querySelectorAll("audio")).map((a) => [a.getAttribute("aria-label"), a.getAttribute("src")]);
  const withInterview = {
    ...SERVED_SPEAKING,
    interview: {
      ...SERVED_SPEAKING.interview,
      introAudio: "int-intro.mp3",
      questions: [1, 2, 3, 4].map((n) => ({ id: `int-${n}`, audio: `int-${n}.mp3`, responseWindowSec: 45 })),
    },
  };
  const scored = (itemId: string, taskType: "listen_repeat" | "interview", meta: Record<string, unknown>) =>
    item({
      itemId,
      taskType,
      transcript: "we open at six",
      responseAudioPath: `responses/att-1/${itemId}.webm`,
      scoringStatus: "scored",
      score: 4,
      scoreJson: { itemId, taskType, finalScore: 4, maxScore: 5, dimensions: [], deductions: [], feedbackZh: "好", meta },
    });
  const untranscribed = item({
    itemId: "int-2",
    taskType: "interview",
    responseAudioPath: "responses/att-1/int-2.webm",
    scoringStatus: "failed",
    scoreJson: { error: "transcription failed" },
    transcriptionJob: { jobId: "tj-1", status: "failed", automaticAttempts: 1, nextRetryAt: null, failureKind: "configuration", error: null, scoreJobId: null },
  });

  it("offers a scored sentence's and a scored question's prompt beside the recording, labelled apart", async () => {
    vi.mocked(getSet).mockResolvedValue(withInterview as never);
    await renderReview(speaking([scored("lr-1", "listen_repeat", { target: "We open at six." }), scored("int-1", "interview", { question: "What do you study?" })]));
    await waitFor(() => expect(players(screen.getByTestId("item-lr-1"))[0]).toEqual(["The sentence you heard, Sentence 1", "/api/audio/lr-1.mp3"]));
    expect(players(screen.getByTestId("item-lr-1"))).toEqual([
      ["The sentence you heard, Sentence 1", "/api/audio/lr-1.mp3"],
      ["Your recording, Listen and Repeat 1", "/api/audio/responses/att-1/lr-1.webm"],
    ]);
    expect(players(screen.getByTestId("item-int-1"))).toEqual([
      ["The question you heard, Question 1", "/api/audio/int-1.mp3"],
      ["Your recording, Interview 1", "/api/audio/responses/att-1/int-1.webm"],
    ]);
    expect(within(screen.getByTestId("item-int-1")).getByText("The question you heard")).toBeInTheDocument();
  });

  it("offers the question of an Item whose transcription failed, and adds no text of it", async () => {
    vi.mocked(getSet).mockResolvedValue(withInterview as never);
    await renderReview(speaking([untranscribed]));
    const card = screen.getByTestId("item-int-2");
    await waitFor(() => expect(players(card)).toEqual([
      ["The question you heard, Question 2", "/api/audio/int-2.mp3"],
      ["Your recording, Interview 2", "/api/audio/responses/att-1/int-2.webm"],
    ]));
    // The served Set has no question text to add, and the card shows no heading for one.
    expect(within(card).queryByText("The question")).not.toBeInTheDocument();
  });

  it("offers no prompt before the Attempt completes", async () => {
    vi.mocked(getSet).mockResolvedValue(withInterview as never);
    const body = speaking([scored("lr-1", "listen_repeat", { target: "We open at six." }), untranscribed]);
    await renderReview({ ...body, attempt: { ...body.attempt, status: "in_progress", completedAt: null } });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Question 2" })).toBeInTheDocument());
    expect(players(screen.getByTestId("item-lr-1")).map(([name]) => name)).toEqual(["Your recording, Listen and Repeat 1"]);
    expect(players(screen.getByTestId("item-int-2")).map(([name]) => name)).toEqual(["Your recording, Interview 2"]);
  });

  it("renders as before when the Set cannot be read", async () => {
    vi.mocked(getSet).mockRejectedValue(new Error("404: not found"));
    await renderReview(speaking([untranscribed]));
    expect(players(screen.getByTestId("item-int-2"))).toEqual([["Your recording, Interview 1", "/api/audio/responses/att-1/int-2.webm"]]);
  });
});

// A Speaking Simulation is flagged when a prompt would not play as well as when the tab is left, and
// the flag does not say which: the notice says the Simulation was interrupted, never that the User left.
describe("a flagged Simulation in Attempt review", () => {
  it("says the Simulation was interrupted and why its timing may differ", async () => {
    const body = speaking([failed("lr-2", "listen_repeat")]);
    await renderReview({ ...body, attempt: { ...body.attempt, flagged: true } });
    expect(
      screen.getByText("This Simulation was interrupted (the tab was left, or a prompt would not play), so its timing may not match the test."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/You left/)).toBeNull();
  });
});

// A link to a place in the review names an element that exists only once the Attempt has loaded, so
// the page scrolls to it then; the browser looked for it before anything rendered.
describe("a link to a place in Attempt review", () => {
  const scrolledTo: string[] = [];
  beforeEach(() => {
    scrolledTo.length = 0;
    // jsdom has no layout, so no scrollIntoView of its own; record which element was asked.
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolledTo.push(this.id);
    };
  });
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });
  const attempt = () => speaking([failed("lr-1", "listen_repeat"), failed("lr-2", "listen_repeat"), failed("int-1", "interview")]);

  it("scrolls to the group the fragment names once the Items have rendered", async () => {
    await renderReview(attempt(), "/attempts/att-1#group-type-interview");
    await waitFor(() => expect(scrolledTo).toContain("group-type-interview"));
    expect(new Set(scrolledTo)).toEqual(new Set(["group-type-interview"]));
  });

  it("scrolls to an Item the fragment names", async () => {
    await renderReview(attempt(), "/attempts/att-1#item-lr-2");
    await waitFor(() => expect(scrolledTo).toContain("item-lr-2"));
  });

  it("scrolls nowhere for a fragment that names nothing", async () => {
    await renderReview(attempt(), "/attempts/att-1#nothing-here");
    expect(screen.getByTestId("item-lr-2")).toBeInTheDocument();
    expect(scrolledTo).toEqual([]);
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
