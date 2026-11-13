import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { MCQ_UNANSWERED_SENTINEL, type AttemptDetailVM, type ItemVM } from "@toefl-prep/shared";
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

describe("a Reading Simulation still in progress", () => {
  // The Response is named as the run showed it, by letter and text: the User picked that option, so
  // it is no key. The stem, the other options, the key and the Explanation still wait for completion.
  it("names the Response by its letter and text, and shows nothing the review withholds", async () => {
    const base = readingDetail();
    await renderReview({
      ...base,
      attempt: { ...base.attempt, mode: "simulation", status: "in_progress", completedAt: null },
      bandStatus: { status: "unfinished" },
      deterministicReview: undefined,
    });
    const row = screen.getByTestId("item-q1");
    expect(row).toHaveTextContent("Your Response: A. To sell a bicycle");
    expect(row).not.toHaveTextContent("Why does Mia write?");
    expect(row).not.toHaveTextContent("Key:");
    expect(screen.queryByText(/To ask for a ride|To cancel a meeting|To book a room/)).toBeNull();
    expect(screen.queryByText("她想搭便車。")).toBeNull();
    expect(screen.getByText(/appear once this Attempt is complete/)).toBeInTheDocument();
    expect(screen.queryByText(/its Set could not be read/)).toBeNull();
  });

  // Option ids are internal ("o3", "lcr-r1-a"); the letter comes from the option's place in the
  // question, never from its id.
  it("takes the letter from the option's place, not from its id", async () => {
    const options = OPTIONS.map((o, i) => ({ ...o, id: `lcr-r1-${"wxyz"[i]}` }));
    vi.mocked(getSet).mockResolvedValue({
      ...SERVED_READING,
      router: { ...SERVED_READING.router, dailyLife: [{ ...SERVED_READING.router.dailyLife[0], questions: [{ id: "q1", stem: "Why does Mia write?", options }] }] },
    } as never);
    const base = readingDetail();
    await renderReview({
      ...base,
      attempt: { ...base.attempt, mode: "simulation", status: "in_progress", completedAt: null },
      items: [scored("q1", "daily_life", false, "lcr-r1-y")],
      bandStatus: { status: "unfinished" },
      deterministicReview: undefined,
    });
    expect(screen.getByTestId("item-q1")).toHaveTextContent("Your Response: C. To cancel a meeting");
    expect(screen.queryByText(/LCR-R1|lcr-r1/)).toBeNull();
  });

  // The Set is best-effort: without it the row still renders, and an internal id is no name.
  it("still renders a Response whose Set cannot be read, without its option id", async () => {
    vi.mocked(getSet).mockRejectedValue(new Error("gone"));
    const base = readingDetail();
    await renderReview({
      ...base,
      attempt: { ...base.attempt, mode: "simulation", status: "in_progress", completedAt: null },
      items: [scored("q1", "daily_life", false, "o3")],
      bandStatus: { status: "unfinished" },
      deterministicReview: undefined,
    });
    const row = screen.getByTestId("item-q1");
    expect(row).toHaveTextContent("Your Response: An option that can no longer be shown");
    expect(row).not.toHaveTextContent(/o3/i);
  });

  // The prefix was printed in the paragraph the User read, so it is no key: a gap's Response reads
  // as the word they produced either way. The correct completion still waits for completion.
  it("writes out a gap's Response with its visible prefix, and no correct completion", async () => {
    const base = readingDetail();
    await renderReview({
      ...base,
      attempt: { ...base.attempt, mode: "simulation", status: "in_progress", completedAt: null },
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

const SERVED_LISTENING = {
  id: "lsn-1",
  kind: "listening",
  router: {
    timeLimitSec: 600,
    listenChoose: [],
    conversations: [
      {
        id: "conv-1",
        taskType: "conversation",
        setting: "a campus mailroom",
        questions: [{ id: "cq1", stem: "What does the student want?", options: OPTIONS.map((o, i) => ({ ...o, id: `o${i + 1}` })) }],
      },
    ],
    announcements: [],
    academicTalks: [],
  },
  lowerModule: { timeLimitSec: 400, listenChoose: [], conversations: [], announcements: [], academicTalks: [] },
  upperModule: { timeLimitSec: 400, listenChoose: [], conversations: [], announcements: [], academicTalks: [] },
};

describe("a Listening Simulation still in progress", () => {
  it("names the Response by its letter and text, not as its option id", async () => {
    vi.mocked(getSet).mockResolvedValue(SERVED_LISTENING as never);
    vi.mocked(getAttempt).mockResolvedValue({
      ...readingDetail(),
      attempt: { ...readingDetail().attempt, kind: "listening", mode: "simulation", setId: "lsn-1", status: "in_progress", completedAt: null },
      items: [scored("cq1", "conversation", true, "o3")],
      bandStatus: { status: "unfinished" },
      deterministicReview: undefined,
    });
    render(
      <MemoryRouter initialEntries={["/attempts/att-1"]}>
        <Routes>
          <Route path="/attempts/:id" element={<AttemptReview />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(vi.mocked(getSet)).toHaveBeenCalledWith("lsn-1"));
    await act(async () => {});
    const row = screen.getByTestId("item-cq1");
    expect(row).toHaveTextContent("Your Response: C. To cancel a meeting");
    expect(row).not.toHaveTextContent("Option O3");
    expect(row).not.toHaveTextContent("What does the student want?");
  });
});

describe("a discarded Reading Simulation", () => {
  // The server builds a Simulation's key review only once it is completed, and a discard is never
  // undone.
  it("says its key and Explanations are not shown, rather than promising them", async () => {
    const base = readingDetail();
    await renderReview({
      ...base,
      attempt: { ...base.attempt, mode: "simulation", status: "aborted", completedAt: null },
      bandStatus: { status: "discarded" },
      deterministicReview: undefined,
    });
    expect(screen.getByText("This Attempt was discarded, so its key and Explanations are not shown.")).toBeInTheDocument();
    expect(screen.queryByText(/appear once this Attempt is complete|its Set could not be read/)).toBeNull();
    // The option the User picked is theirs to see; the key (B) is not.
    expect(screen.getByTestId("item-q1")).toHaveTextContent("Your Response: A. To sell a bicycle");
    expect(screen.queryByText(/To ask for a ride/)).toBeNull();
    expect(screen.queryByText("她想搭便車。")).toBeNull();
  });
});

// Issue #42: a completed Reading Attempt's review shows each Stimulus's own text under its heading,
// so a Response can be checked against what the User read. Nothing of it before completion.
const SERVED_READING_TEXTS = {
  ...SERVED_READING,
  router: {
    timeLimitSec: 1200,
    ctwPassages: [
      {
        id: "ctw-1",
        taskType: "complete_words",
        topic: "river restoration",
        segments: [
          { type: "text", text: "Every " },
          { type: "gap", gapId: "g1" },
          { type: "text", text: ", crews haul " },
          { type: "gap", gapId: "g2" },
          { type: "text", text: " to the bank and " },
          { type: "gap", gapId: "g3" },
          { type: "text", text: " the old weir." },
        ],
        gaps: [
          { id: "g1", prefix: "mon", blankLength: 2 },
          { id: "g2", prefix: "gr", blankLength: 4 },
          { id: "g3", prefix: "rem", blankLength: 3 },
        ],
      },
    ],
    dailyLife: [
      { id: "dl-1", taskType: "daily_life", genre: "text-message chain", text: "Mia: Can you drive me to the fair?\nSam: Sure, at nine.", questions: [{ id: "q1", stem: "Why does Mia write?", options: OPTIONS }] },
    ],
    academic: [
      {
        id: "ac-1",
        taskType: "academic_passage",
        title: "Beavers as engineers",
        discipline: "ecology",
        text: "Beavers build dams that slow a river.\n\nThe ponds behind them store sediment.",
        questions: [
          { id: "q2", stem: "What do the ponds store?", options: OPTIONS.map((o, i) => ({ ...o, id: `p${i}` })) },
          { id: "q3", stem: "What do beavers build?", options: OPTIONS.map((o, i) => ({ ...o, id: `r${i}` })) },
        ],
      },
    ],
  },
};

function textsDetail(over: Partial<AttemptDetailVM> = {}): AttemptDetailVM {
  return readingDetail({
    items: [
      scored("g1", "complete_words", true, "th"),
      scored("g2", "complete_words", false, "ass"),
      scored("g3", "complete_words", false, ""),
      scored("q1", "daily_life", false, "a"),
      scored("q2", "academic_passage", true, "p2"),
      scored("q3", "academic_passage", false, MCQ_UNANSWERED_SENTINEL),
    ],
    deterministicReview: [
      { itemId: "g1", taskType: "complete_words", correct: true, key: "th", explanationZh: "月份。" },
      { itemId: "g2", taskType: "complete_words", correct: false, key: "avel", explanationZh: "礫石。" },
      { itemId: "g3", taskType: "complete_words", correct: false, key: "ove", explanationZh: "移除。" },
      { itemId: "q1", taskType: "daily_life", correct: false, key: "b", explanationZh: "她想搭便車。" },
      { itemId: "q2", taskType: "academic_passage", correct: true, key: "p2", explanationZh: "沉積物。" },
      { itemId: "q3", taskType: "academic_passage", correct: false, key: "r0", explanationZh: "水壩。" },
    ],
    ...over,
  });
}

describe("a completed Reading Attempt's Stimuli", () => {
  beforeEach(() => {
    vi.mocked(getSet).mockResolvedValue(SERVED_READING_TEXTS as never);
  });

  it("sets the Complete the Words passage out in full, each gap numbered by its Item, filled and marked", async () => {
    await renderReview(textsDetail());
    const card = screen.getByRole("region", { name: "River restoration" });
    const right = within(card).getByTestId("gap-g1");
    const passage = right.closest("p")!;
    // Shown, not behind a Disclosure, in the run's monospace face, with the words around the gaps.
    expect(passage.closest("details")).toBeNull();
    expect(passage).toHaveClass("font-mono");
    expect(passage).toHaveTextContent(/Every .*, crews haul .* to the bank and .* the old weir\./);

    expect(right).toHaveTextContent("Item 1: month Correct,");
    expect(right).not.toHaveTextContent("The word is");
    // A wrong gap: what was typed, Incorrect, and the correct word beside it.
    expect(within(card).getByTestId("gap-g2")).toHaveTextContent("Item 2: grass Incorrect The word is gravel");
    // An empty gap reads as no Response, then the word: no empty box, no input at all.
    expect(within(card).getByTestId("gap-g3")).toHaveTextContent("Item 3: rem No Response The word is remove");
    expect(passage.querySelector("input")).toBeNull();
    // The list under it numbers the same Items.
    expect(within(card).getByTestId("item-g2")).toHaveTextContent("Item 2");
  });

  it("shows a Read in Daily Life text and an Academic passage open under their headings", async () => {
    await renderReview(textsDetail());
    const daily = screen.getByRole("region", { name: "Text-message chain" });
    const dailyToggle = within(daily).getByText("The text").closest("details")!;
    // Open to begin with: the questions below are checked against it.
    expect(dailyToggle).toHaveAttribute("open");
    // The text's own line breaks are kept, as the run keeps them.
    expect(within(dailyToggle).getByText(/Mia: Can you drive me/).textContent).toBe("Mia: Can you drive me to the fair?\nSam: Sure, at nine.");

    const academic = screen.getByRole("region", { name: "Beavers as engineers" });
    const academicToggle = within(academic).getByText("The passage").closest("details")!;
    expect(academicToggle).toHaveAttribute("open");
    expect(within(academicToggle).getByText("ecology")).toBeInTheDocument();
    expect(within(academicToggle).getByText("Beavers build dams that slow a river.").tagName).toBe("P");
    expect(within(academicToggle).getByText("The ponds behind them store sediment.").tagName).toBe("P");
  });

  it("lists every option of a question with the key and the Response marked, right, wrong or unanswered", async () => {
    await renderReview(textsDetail());
    const group = (row: HTMLElement) => within(row).getByRole("radiogroup", { name: "Options" });

    const wrong = screen.getByTestId("item-q1");
    expect(within(group(wrong)).getAllByRole("radio")).toHaveLength(4);
    expect(within(wrong).getByRole("radio", { name: "To sell a bicycle" })).toBeChecked();
    expect(group(wrong)).toHaveTextContent(/To sell a bicycle.*Your Response.*To ask for a ride.*Key/);

    const right = screen.getByTestId("item-q2");
    expect(right).toHaveTextContent("What do the ponds store?");
    expect(within(group(right)).getAllByRole("radio")).toHaveLength(4);
    expect(within(right).getByRole("radio", { name: "To cancel a meeting" })).toBeChecked();
    expect(group(right)).toHaveTextContent(/To cancel a meeting.*Key/);
    expect(within(right).getByText("沉積物。")).toBeInTheDocument();

    const none = screen.getByTestId("item-q3");
    expect(none).toHaveTextContent("Your Response: No Response");
    expect(none).toHaveTextContent("Key: A. To sell a bicycle");
    expect(within(group(none)).getAllByRole("radio").some((r) => (r as HTMLInputElement).checked)).toBe(false);
  });

  it("shows none of it while the Attempt is unfinished", async () => {
    const base = textsDetail();
    await renderReview({ ...base, attempt: { ...base.attempt, mode: "simulation", status: "in_progress", completedAt: null }, bandStatus: { status: "unfinished" }, deterministicReview: undefined });
    expect(screen.getByTestId("item-g2")).toHaveTextContent("Your Response: grass");
    expect(screen.queryByTestId("gap-g2")).toBeNull();
    expect(screen.queryByText(/crews haul/)).toBeNull();
    expect(screen.queryByText("The text")).toBeNull();
    expect(screen.queryByText(/Can you drive me|Beavers build dams/)).toBeNull();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("shows none of it for a discarded Attempt", async () => {
    const base = textsDetail();
    await renderReview({ ...base, attempt: { ...base.attempt, mode: "simulation", status: "aborted", completedAt: null }, bandStatus: { status: "discarded" }, deterministicReview: undefined });
    expect(screen.queryByTestId("gap-g1")).toBeNull();
    expect(screen.queryByText(/crews haul/)).toBeNull();
    expect(screen.queryByText(/Can you drive me|Beavers build dams/)).toBeNull();
  });

  it("renders as before, without the texts and without an error, when the Set cannot be read", async () => {
    vi.mocked(getSet).mockRejectedValue(new Error("gone"));
    await renderReview(textsDetail());
    expect(screen.getByTestId("item-g2")).toHaveTextContent("Your Response: ass");
    expect(screen.getByTestId("item-g2")).toHaveTextContent("Correct completion: avel");
    expect(screen.queryByTestId("gap-g2")).toBeNull();
    expect(screen.queryByText("The text")).toBeNull();
    expect(screen.queryByText("The passage")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("leaves out a passage whose runs no longer read, and keeps its Items", async () => {
    const ctw = SERVED_READING_TEXTS.router.ctwPassages[0];
    vi.mocked(getSet).mockResolvedValue({
      ...SERVED_READING_TEXTS,
      router: { ...SERVED_READING_TEXTS.router, ctwPassages: [{ ...ctw, segments: [...ctw.segments, { type: "gap", gapId: "g9" }] }] },
    } as never);
    await renderReview(textsDetail());
    expect(screen.queryByTestId("gap-g1")).toBeNull();
    expect(screen.getByTestId("item-g2")).toHaveTextContent("Correct completion: gravel");
  });
});

// Issue #51: a completed Listening Attempt's review can play each Stimulus again (a Listen and
// Choose a Response from its own row, each being its own Stimulus) and lists every option of an
// opened Item. A Listen and Choose a Response utterance is never text; an unfinished or discarded
// Attempt gains none of this.
const LISTENING_OPTIONS = (prefix: string) => OPTIONS.map((o, i) => ({ ...o, id: `${prefix}${i + 1}` }));
const SERVED_LISTENING_AUDIO = {
  id: "lsn-1",
  kind: "listening",
  router: {
    timeLimitSec: 600,
    listenChoose: [
      { id: "lc-1", taskType: "listen_choose", audio: "stimuli/lsn-1/lc-1.mp3", options: LISTENING_OPTIONS("l") },
      { id: "lc-2", taskType: "listen_choose", audio: "stimuli/lsn-1/lc-2.mp3", options: LISTENING_OPTIONS("m") },
    ],
    conversations: [
      {
        id: "conv-1",
        taskType: "conversation",
        audio: "stimuli/lsn-1/conv-1.mp3",
        setting: "a campus mailroom",
        questions: [{ id: "cq1", stem: "What does the student want?", options: LISTENING_OPTIONS("o") }],
      },
    ],
    announcements: [
      { id: "ann-1", taskType: "announcement", audio: "stimuli/lsn-1/ann-1.mp3", setting: "a dormitory", questions: [{ id: "aq1", stem: "What is closing?", options: LISTENING_OPTIONS("a") }] },
    ],
    academicTalks: [],
  },
  lowerModule: { timeLimitSec: 400, listenChoose: [], conversations: [], announcements: [], academicTalks: [] },
  upperModule: { timeLimitSec: 400, listenChoose: [], conversations: [], announcements: [], academicTalks: [] },
};

function listeningDetail(over: Partial<AttemptDetailVM> = {}): AttemptDetailVM {
  const base = readingDetail();
  return {
    ...base,
    attempt: { ...base.attempt, kind: "listening", setId: "lsn-1" },
    items: [
      scored("lc-1", "listen_choose", false, "l2"),
      scored("lc-2", "listen_choose", true, "m3"),
      scored("cq1", "conversation", false, "o1"),
      scored("aq1", "announcement", true, "a4"),
    ],
    deterministicReview: [
      // The server never sends a transcript for a Listen and Choose a Response; one is here to show
      // it would not be drawn if it did.
      { itemId: "lc-1", taskType: "listen_choose", correct: false, key: "l1", explanationZh: "室友詢問咖啡。", transcript: "Did we run out of coffee?" },
      { itemId: "lc-2", taskType: "listen_choose", correct: true, key: "m3", explanationZh: "回應邀請。" },
      { itemId: "cq1", taskType: "conversation", correct: false, key: "o2", explanationZh: "學生想搭便車。", transcript: "student: Could I get a ride?\nclerk: Sure." },
      { itemId: "aq1", taskType: "announcement", correct: true, key: "a4", explanationZh: "電梯關閉。", transcript: "The east elevator is closed." },
    ],
    ...over,
  };
}

async function renderListeningReview(body: AttemptDetailVM) {
  vi.mocked(getSet).mockResolvedValue(SERVED_LISTENING_AUDIO as never);
  vi.mocked(getAttempt).mockResolvedValue(body);
  const view = render(
    <MemoryRouter initialEntries={["/attempts/att-1"]}>
      <Routes>
        <Route path="/attempts/:id" element={<AttemptReview />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(vi.mocked(getSet)).toHaveBeenCalledWith("lsn-1"));
  await act(async () => {});
  return view;
}

const srcOf = (scope: HTMLElement) => [...scope.querySelectorAll("audio")].map((a) => a.getAttribute("src"));

describe("a completed Listening Attempt's Stimuli", () => {
  it("plays each Stimulus again from its heading, and each Listen and Choose a Response from its own row", async () => {
    const { container } = await renderListeningReview(listeningDetail());
    const conversation = screen.getByRole("region", { name: "A campus mailroom" });
    expect(srcOf(conversation)).toEqual(["/api/audio/stimuli/lsn-1/conv-1.mp3"]);
    expect(conversation.querySelector("audio")!.controls).toBe(true);
    expect(srcOf(screen.getByRole("region", { name: "A dormitory" }))).toEqual(["/api/audio/stimuli/lsn-1/ann-1.mp3"]);
    expect(srcOf(screen.getByTestId("item-lc-1"))).toEqual(["/api/audio/stimuli/lsn-1/lc-1.mp3"]);
    expect(srcOf(screen.getByTestId("item-lc-2"))).toEqual(["/api/audio/stimuli/lsn-1/lc-2.mp3"]);
    expect(container.querySelectorAll("audio")).toHaveLength(4);
  });

  it("lists every option of an opened Item with the Response and the key marked", async () => {
    await renderListeningReview(listeningDetail());
    for (const itemId of ["lc-1", "cq1"]) {
      const group = within(screen.getByTestId(`item-${itemId}`)).getByRole("radiogroup", { name: "Options" });
      expect(within(group).getAllByRole("radio")).toHaveLength(4);
      expect(group).toHaveTextContent(/To sell a bicycle.*To ask for a ride.*To cancel a meeting.*To book a room/);
      expect(group).toHaveTextContent(/Your Response/);
      expect(group).toHaveTextContent(/Key/);
    }
  });

  it("never shows a Listen and Choose a Response utterance as text, and keeps the others' transcripts", async () => {
    const { container } = await renderListeningReview(listeningDetail());
    expect(container.textContent).not.toContain("Did we run out of coffee?");
    expect(within(screen.getByRole("region", { name: "A campus mailroom" })).getByText("Transcript")).toBeInTheDocument();
  });

  const unfinished: [string, Partial<AttemptDetailVM>][] = [
    ["an unfinished Simulation", { attempt: { ...listeningDetail().attempt, mode: "simulation", status: "in_progress", completedAt: null }, bandStatus: { status: "unfinished" } }],
    ["a discarded Simulation", { attempt: { ...listeningDetail().attempt, mode: "simulation", status: "aborted", completedAt: null }, bandStatus: { status: "discarded" } }],
  ];
  for (const [label, over] of unfinished) {
    it(`gains nothing for ${label}`, async () => {
      const { container } = await renderListeningReview(listeningDetail({ ...over, deterministicReview: undefined }));
      expect(container.querySelectorAll("audio")).toHaveLength(0);
      expect(screen.queryByRole("radiogroup")).toBeNull();
      expect(screen.queryByText("Listen again")).toBeNull();
      expect(screen.getByTestId("item-cq1")).toHaveTextContent("Your Response: A. To sell a bicycle");
    });
  }
});

// Issue #52: an unfinished or discarded Drill's review shows, for each Item it scored, what the
// Drill already showed when it was checked: the stem, every option, the key and the Explanation,
// and the Stimulus with them. The server sends the review for those Items only, so an Item never
// scored shows nothing more than before.
function unscored(itemId: string, taskType: string): ItemVM {
  return { ...scored(itemId, taskType, false, ""), score: null, scoreJson: null, scoringStatus: "pending" };
}

describe("an unfinished or discarded Drill's scored Items", () => {
  beforeEach(() => {
    vi.mocked(getSet).mockResolvedValue(SERVED_READING_TEXTS as never);
  });

  const states: [string, "in_progress" | "aborted", "unfinished" | "discarded"][] = [
    ["unfinished", "in_progress", "unfinished"],
    ["discarded", "aborted", "discarded"],
  ];
  for (const [label, status, band] of states) {
    it(`a ${label} Reading Drill shows stem, options, key and Explanation for a scored Item, and nothing for one never scored`, async () => {
      const base = textsDetail();
      await renderReview({
        ...base,
        attempt: { ...base.attempt, mode: "drill", status, completedAt: null },
        bandStatus: { status: band },
        items: [
          scored("g1", "complete_words", true, "th"),
          scored("g2", "complete_words", false, "ass"),
          scored("g3", "complete_words", false, ""),
          scored("q1", "daily_life", false, "a"),
          unscored("q2", "academic_passage"),
          unscored("q3", "academic_passage"),
        ],
        deterministicReview: base.deterministicReview!.filter((r) => ["g1", "g2", "g3", "q1"].includes(r.itemId)),
      });

      const q1 = screen.getByTestId("item-q1");
      expect(q1).toHaveTextContent("Why does Mia write?");
      expect(q1).toHaveTextContent("Key: B. To ask for a ride");
      expect(within(within(q1).getByRole("radiogroup", { name: "Options" })).getAllByRole("radio")).toHaveLength(4);
      expect(within(q1).getByText("她想搭便車。")).toBeInTheDocument();
      // The text it was asked about, and the filled-in passage, as a completed review shows them.
      expect(within(screen.getByRole("region", { name: "Text-message chain" })).getByText("The text")).toBeInTheDocument();
      expect(screen.getByTestId("gap-g2")).toHaveTextContent("Item 2: grass Incorrect The word is gravel");

      // The passage nobody checked: no text, no stem, no key, no Explanation, no options.
      const academic = screen.getByRole("region", { name: "Beavers as engineers" });
      expect(within(academic).queryByText("The passage")).toBeNull();
      expect(academic).not.toHaveTextContent(/What do the ponds store\?|Key:|沉積物。|水壩。/);
      expect(within(academic).queryByRole("radiogroup")).toBeNull();
      // The review is there, so the page does not say it is withheld.
      expect(screen.queryByText(/appear once this Attempt is complete|so its key and Explanations are not shown/)).toBeNull();
    });
  }

  // A Drill's scored Items are owed their review whatever its status, so when it is absent the Set
  // could not be read (or two of its Items share an id): neither completion nor the discard is why.
  for (const [label, status, band] of states) {
    it(`says the Set could not be read when the review is absent (${label} Drill)`, async () => {
      const base = readingDetail();
      await renderReview({ ...base, attempt: { ...base.attempt, mode: "drill", status, completedAt: null }, bandStatus: { status: band }, deterministicReview: undefined });
      expect(screen.getByText("The key and Explanations aren't available for this Attempt: its Set could not be read.")).toBeInTheDocument();
      expect(screen.queryByText(/appear once this Attempt is complete|so its key and Explanations are not shown/)).toBeNull();
    });
  }

  // With no scored Item there is no review owed yet: completion is still what brings it.
  it("an unfinished Drill with no scored Item still says the review comes with completion", async () => {
    const base = readingDetail();
    await renderReview({
      ...base,
      attempt: { ...base.attempt, mode: "drill", status: "in_progress", completedAt: null },
      bandStatus: { status: "unfinished" },
      items: [unscored("q1", "daily_life")],
      deterministicReview: undefined,
    });
    expect(screen.getByText("The key and Explanations appear once this Attempt is complete.")).toBeInTheDocument();
    expect(screen.queryByText(/its Set could not be read/)).toBeNull();
  });

  it("an unfinished Listening Drill can replay a scored Stimulus, and nothing it did not score", async () => {
    const { container } = await renderListeningReview(
      listeningDetail({
        attempt: { ...listeningDetail().attempt, mode: "drill", status: "in_progress", completedAt: null },
        bandStatus: { status: "unfinished" },
        items: [scored("lc-1", "listen_choose", false, "l2"), unscored("lc-2", "listen_choose"), scored("cq1", "conversation", false, "o1"), unscored("aq1", "announcement")],
        deterministicReview: listeningDetail().deterministicReview!.filter((r) => r.itemId === "lc-1" || r.itemId === "cq1"),
      }),
    );
    expect(srcOf(screen.getByTestId("item-lc-1"))).toEqual(["/api/audio/stimuli/lsn-1/lc-1.mp3"]);
    expect(srcOf(screen.getByRole("region", { name: "A campus mailroom" }))).toEqual(["/api/audio/stimuli/lsn-1/conv-1.mp3"]);
    expect(container.querySelectorAll("audio")).toHaveLength(2);
    expect(srcOf(screen.getByTestId("item-lc-2"))).toEqual([]);
    expect(srcOf(screen.getByRole("region", { name: "A dormitory" }))).toEqual([]);
    expect(within(screen.getByTestId("item-cq1")).getByRole("radiogroup", { name: "Options" })).toBeInTheDocument();
    expect(container.textContent).not.toContain("Did we run out of coffee?");
  });
});

// Issue #56: scoring stores what was answered in words (the chosen option's text and place, a gap's
// prefix), so with the Set unreadable the review still says what the User answered. Rows scored
// before that have none of it and keep the fallback.
describe("a Reading Attempt whose Set can no longer be read", () => {
  const withWords = (itemId: string, taskType: string, correct: boolean, answer: string, words: Record<string, unknown>): ItemVM => {
    const item = scored(itemId, taskType, correct, answer);
    return { ...item, scoreJson: { ...(item.scoreJson as object), ...words } };
  };

  it("names a stored Response by its letter and text, and a gap by the whole word", async () => {
    vi.mocked(getSet).mockRejectedValue(new Error("gone"));
    await renderReview(
      readingDetail({
        items: [
          withWords("g2", "complete_words", false, "klt", { prefix: "wee" }),
          withWords("q1", "daily_life", false, "o3", { selectedOptionText: "To cancel a meeting", selectedOptionIndex: 2 }),
        ],
        deterministicReview: undefined,
      }),
    );
    expect(screen.getByTestId("item-q1")).toHaveTextContent("Your Response: C. To cancel a meeting");
    expect(screen.getByTestId("item-g2")).toHaveTextContent("Your Response: weeklt");
    expect(screen.queryByText(/An option that can no longer be shown/)).toBeNull();
    expect(screen.getByText(/its Set could not be read/)).toBeInTheDocument();
  });

  it("keeps the fallback for rows scored before the words were stored", async () => {
    vi.mocked(getSet).mockRejectedValue(new Error("gone"));
    await renderReview(readingDetail({ items: [scored("g2", "complete_words", false, "klt"), scored("q1", "daily_life", false, "o3")], deterministicReview: undefined }));
    expect(screen.getByTestId("item-q1")).toHaveTextContent("Your Response: An option that can no longer be shown");
    expect(screen.getByTestId("item-g2")).toHaveTextContent("Your Response: klt");
    expect(screen.getByTestId("item-g2")).not.toHaveTextContent("weeklt");
  });
});

// Issue #48: a Simulation defers its feedback. While it can still be answered or finished, its review
// shows each Response with no Correct or Incorrect mark and no "n of m correct" tally, until the
// Attempt completes. A Drill shows its marks as soon as an Item is scored.
describe("the marks of a Simulation still in progress", () => {
  const MARKS = /\bCorrect\b|\bIncorrect\b|\d+ of \d+ correct/;

  function inProgressSimulation(kind: "reading" | "listening", over: Partial<AttemptDetailVM> = {}): AttemptDetailVM {
    const base = readingDetail();
    return {
      ...base,
      attempt: { ...base.attempt, kind, mode: "simulation", setId: kind === "reading" ? "rd-1" : "lsn-1", status: "in_progress", completedAt: null },
      bandStatus: { status: "unfinished" },
      deterministicReview: undefined,
      ...over,
    };
  }

  async function renderFor(body: AttemptDetailVM) {
    vi.mocked(getAttempt).mockResolvedValue(body);
    render(
      <MemoryRouter initialEntries={["/attempts/att-1"]}>
        <Routes>
          <Route path="/attempts/:id" element={<AttemptReview />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(vi.mocked(getSet)).toHaveBeenCalledWith(body.attempt.setId));
    await act(async () => {});
  }

  it("a Reading Simulation shows its Router Module Responses with no mark and no tally", async () => {
    await renderFor(inProgressSimulation("reading"));
    expect(screen.getByTestId("item-q1")).toHaveTextContent("Your Response: A. To sell a bicycle");
    expect(screen.getByTestId("item-g2")).toHaveTextContent("Your Response: grass");
    expect(document.body.textContent).not.toMatch(MARKS);
    expect(screen.getAllByText("Submitted")).toHaveLength(3);
    expect(screen.getByText("Whether each Response is correct, the key and the Explanations appear once this Attempt is complete.")).toBeInTheDocument();
  });

  it("a Listening Simulation shows its Router Module Responses with no mark and no tally", async () => {
    vi.mocked(getSet).mockResolvedValue(SERVED_LISTENING as never);
    const pending: ItemVM = { ...scored("cq2", "conversation", true, "o2"), scoringStatus: "pending", scoreJson: null, score: null };
    await renderFor(inProgressSimulation("listening", { items: [scored("cq1", "conversation", false, "o1"), pending] }));
    expect(screen.getByTestId("item-cq1")).toHaveTextContent("Your Response: A. To sell a bicycle");
    expect(document.body.textContent).not.toMatch(MARKS);
    // How many Items are not scored yet is no verdict, so it stays.
    expect(screen.getAllByText(/2 Items · 1 not scored/).length).toBeGreaterThan(0);
  });

  it("the same Attempt, once completed, shows its marks and tallies", async () => {
    vi.mocked(getSet).mockResolvedValue(SERVED_LISTENING as never);
    await renderFor(
      inProgressSimulation("listening", {
        attempt: { ...readingDetail().attempt, kind: "listening", mode: "simulation", setId: "lsn-1", status: "completed" },
        items: [scored("cq1", "conversation", false, "o1")],
        bandStatus: { status: "incomplete", unscored: [], absent: [] },
        deterministicReview: [{ itemId: "cq1", taskType: "conversation", correct: false, key: "o2", explanationZh: "他要拿包裹。" }],
      }),
    );
    expect(within(screen.getByTestId("item-cq1")).getByText("Incorrect")).toBeInTheDocument();
    expect(screen.getAllByText(/0 of 1 correct/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Submitted")).toBeNull();
  });

  it("an unfinished Drill still shows its marks and tallies", async () => {
    const base = readingDetail();
    await renderFor({ ...base, attempt: { ...base.attempt, status: "in_progress", completedAt: null }, bandStatus: { status: "unfinished" } });
    expect(within(screen.getByTestId("item-q1")).getByText("Incorrect")).toBeInTheDocument();
    expect(within(screen.getByTestId("item-g1")).getByText("Correct")).toBeInTheDocument();
    expect(screen.getAllByText(/\d of \d correct/).length).toBeGreaterThan(0);
    expect(screen.queryByText("Submitted")).toBeNull();
  });

  it("a Writing Simulation's Build a Sentence Items show no mark and no tally until it completes", async () => {
    vi.mocked(getSet).mockResolvedValue({
      id: "wri-1",
      kind: "writing",
      source: "generated",
      createdAt: "2026-01-01T00:00:00Z",
      buildASentence: { items: [{ id: "bas-1", prompt: "Where is it?", tiles: ["it", "is", "here"] }, { id: "bas-2", prompt: "Who came?", tiles: ["she", "came"] }] },
    } as never);
    const bas = (itemId: string, correct: boolean): ItemVM => ({
      ...scored(itemId, "build_sentence", correct, ""),
      responseText: JSON.stringify(["it", "is", "here"]),
      scoreJson: { correct },
    });
    const essay: ItemVM = { ...scored("email-1", "email", false, ""), scoringStatus: "pending", scoreJson: null, score: null };
    const base = readingDetail();
    await renderFor({
      ...base,
      attempt: { ...base.attempt, kind: "writing", mode: "simulation", setId: "wri-1", status: "in_progress", completedAt: null },
      items: [bas("bas-1", true), bas("bas-2", false), essay],
      bandStatus: { status: "unfinished" },
      deterministicReview: undefined,
    });
    expect(document.body.textContent).not.toMatch(MARKS);
    expect(within(screen.getByTestId("item-bas-1")).getByText("Submitted")).toBeInTheDocument();
  });
});
