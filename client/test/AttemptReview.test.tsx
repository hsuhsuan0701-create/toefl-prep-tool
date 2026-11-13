import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { AttemptDetailVM, ItemVM, ServedWritingSet } from "@toefl-prep/shared";
import AttemptReview from "../src/pages/AttemptReview";
import { getAttempt, getSet } from "../src/lib/api";

// Attempt review shows a Build a Sentence Response, and its key, as a whole sentence: the Item's
// frame with the tiles in its blanks. A frame Item's fixed words are kept out of its tiles, so the
// tiles joined by spaces would read as a fragment; for a frameless Item the tiles are the sentence.
//
// The composition is covered at its own seam (sentenceAnswerText.test.ts) and the Set-to-frame
// reduction at its own (attemptSetSnapshot.test.ts). This file tests what neither can see: that the
// frame travels from the Set this page fetches to the Build a Sentence review, matched to the right
// Item, and that every way of not having one still renders the page.

vi.mock("../src/lib/api", () => ({
  getAttempt: vi.fn(),
  getSet: vi.fn(),
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

const REFERENCE_FRAME = "The ___ ___ ___ ___ ___ ___ wonderful.";
const REFERENCE_ANSWER = ["volunteers", "who", "led us through", "the", "new wing", "were"];
const REFERENCE_SENTENCE = "The volunteers who led us through the new wing were wonderful.";

const LEGACY_ANSWER = ["I", "think", "it's mine."];

function basItem(itemId: string, tileOrder: string[], correctAnswers: string[][]): ItemVM {
  return {
    attemptId: "att-1",
    itemId,
    taskType: "build_sentence",
    responseText: JSON.stringify(tileOrder),
    responseAudioPath: null,
    transcript: null,
    score: 1,
    scoreJson: { correct: true, correctAnswers },
    scoringStatus: "scored",
    deliveryReport: null,
    createdAt: "2026-01-01T00:01:00Z",
  };
}

function detailWith(items: ItemVM[]): AttemptDetailVM {
  return {
    attempt: {
      id: "att-1",
      kind: "writing",
      mode: "drill",
      setId: "wri-ref",
      setTitle: null,
      isRepeat: false,
      status: "completed",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:05:00Z",
      captureFinishedAt: null,
      flagged: false,
    },
    items,
    judgeReports: [],
    estimate: null,
    bandStatus: { status: "incomplete", unscored: [], absent: [] },
    activeJobs: [],
  };
}

// The Set as GET /api/sets/:id serves it: stripAnswers drops `answers`, keeps `frame` and the tiles
// (in a fresh order per request). A Response is composed with the frame only when its tiles are
// drawn from these; AttemptReviewSurfaces.test.tsx covers a Set edited after the Attempt.
const REFERENCE_TILES = ["were", "the", "was", "new wing", "led us through", "who", "volunteers"];
const servedSet: ServedWritingSet = {
  id: "wri-ref",
  kind: "writing",
  source: "generated",
  createdAt: "2026-01-01T00:00:00Z",
  buildASentence: {
    items: [
      { id: "bas-framed", prompt: "How did the museum visit go?", frame: REFERENCE_FRAME, tiles: REFERENCE_TILES },
      { id: "bas-partial", prompt: "How did the museum visit go?", frame: REFERENCE_FRAME, tiles: REFERENCE_TILES },
      { id: "bas-legacy", prompt: "Whose notebook is this?", tiles: [...LEGACY_ANSWER, "thinks"] },
    ],
  },
  // Not read by the review; present because every served writing Set carries them.
  email: {
    id: "email-1",
    scenario: "Ask for an extension.",
    to: "prof@uni.edu",
    subject: "Extension",
    bullets: ["say why"],
    timeLimitSec: 420,
    wordGuidance: { min: 80, max: 120 },
  },
  academicDiscussion: {
    id: "disc-1",
    courseTitle: "Econ 101",
    professorName: "Dr. Lin",
    professorPost: "Discuss.",
    studentPosts: [{ name: "Ana", post: "Subsidies distort prices." }],
    timeLimitSec: 600,
    minWords: 100,
  },
};

function renderReview() {
  return render(
    <MemoryRouter initialEntries={["/attempts/att-1"]}>
      <Routes>
        <Route path="/attempts/:id" element={<AttemptReview />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Renders and waits until the Set fetch has settled, not merely until the page has content.
 *
 * The two fetches land in sequence: the Attempt paints the review, and only then does the Set
 * arrive and supply the frames. A `findBy*` that resolves the moment an answer appears is often
 * reading the render from before the Set arrived. In a test that expects the space-joined fallback
 * that render is indistinguishable from the fallback, so the test would pass without exercising
 * what it names.
 */
async function renderSettledReview() {
  renderReview();
  await waitFor(() => expect(vi.mocked(getSet)).toHaveBeenCalledWith("wri-ref"));
  // The mocked fetch is already settled by now; this drains its `.then`/`.catch` and the state
  // update either one queues.
  await act(async () => {});
}

/** The tiles a partly filled Response lists, in the order it lists them. */
function placedTiles(answer: HTMLElement): (string | null)[] {
  const list = answer.querySelector("[data-placed-tiles]");
  return list ? Array.from(list.querySelectorAll("[data-placed]")).map((el) => el.textContent) : [];
}

beforeEach(() => {
  vi.mocked(getAttempt).mockReset();
  vi.mocked(getSet).mockReset();
});

describe("Attempt review — a Build a Sentence Response against a framed Set", () => {
  beforeEach(() => {
    vi.mocked(getAttempt).mockResolvedValue(
      detailWith([
        basItem("bas-framed", REFERENCE_ANSWER, [REFERENCE_ANSWER]),
        basItem("bas-partial", REFERENCE_ANSWER.slice(0, 3), [REFERENCE_ANSWER]),
        basItem("bas-legacy", LEGACY_ANSWER, [LEGACY_ANSWER]),
      ]),
    );
    vi.mocked(getSet).mockResolvedValue(servedSet);
  });

  it("renders the submitted Response as the complete sentence", async () => {
    await renderSettledReview();
    expect(screen.getByTestId("bas-answer-bas-framed")).toHaveTextContent(`Your Response: ${REFERENCE_SENTENCE}`);
  });

  it("renders the key as a complete sentence too", async () => {
    await renderSettledReview();
    expect(screen.getByTestId("bas-key-bas-framed")).toHaveTextContent(`Key: ${REFERENCE_SENTENCE}`);
  });

  it("lists a partly filled Item's tiles and its empty blanks, and never puts the tiles in the first blanks", async () => {
    // A Response is stored with its empty blanks dropped, so which blanks these three tiles were in
    // is gone. Composing them from the first blank would show an arrangement the User may never
    // have made (issue #40).
    await renderSettledReview();
    const answer = screen.getByTestId("bas-answer-bas-partial");
    expect(answer).toHaveTextContent("Your Response: 3 of 6 blanks left empty.");
    expect(answer).not.toHaveTextContent("The volunteers who led us through");
    // The frame is drawn as the frame, every blank a blank.
    expect(answer).toHaveTextContent("The ___ ___ ___ ___ ___ ___ wonderful.");
    expect(placedTiles(answer)).toEqual(REFERENCE_ANSWER.slice(0, 3));
    expect(answer).toHaveTextContent("Which blank each tile was in is not recorded");
  });

  it("lists every tile the Item offered, A to Z, and marks the one no key arrangement uses", async () => {
    await renderSettledReview();
    const tiles = within(screen.getByTestId("bas-tiles-bas-framed")).getAllByRole("listitem");
    // Sorted, never the served order: the tray is re-drawn per request.
    expect(tiles.map((li) => li.textContent)).toEqual([
      "led us through",
      "new wing",
      "the",
      "volunteers",
      "was · not in the sentence",
      "were",
      "who",
    ]);
    expect(tiles.filter((li) => li.hasAttribute("data-extra")).map((li) => li.textContent)).toEqual(["was · not in the sentence"]);
  });

  it("sets the tiles the User placed apart from the words the frame prints, in the Response and the key", async () => {
    await renderSettledReview();
    const placed = (testId: string) =>
      Array.from(screen.getByTestId(testId).querySelectorAll("[data-placed]")).map((el) => el.textContent);
    expect(placed("bas-answer-bas-framed")).toEqual(REFERENCE_ANSWER);
    expect(placed("bas-key-bas-framed")).toEqual(REFERENCE_ANSWER);
    // An empty blank is not a placed tile, and the frame's own words never are.
    expect(placed("bas-answer-bas-partial")).toEqual(REFERENCE_ANSWER.slice(0, 3));
    expect(screen.getByText(/Boxed words are tiles placed in the blanks/)).toBeInTheDocument();
  });

  it("matches each frame to its own Item, never to the Item beside it", async () => {
    // The frame arrives keyed by Item id; the third Item of the same Set has none, and must not
    // inherit the frame the first two carry.
    await renderSettledReview();
    expect(screen.getByTestId("bas-answer-bas-legacy")).toHaveTextContent("Your Response: I think it's mine.");
    expect(screen.getByTestId("bas-key-bas-legacy")).toHaveTextContent("Key: I think it's mine.");
  });
});

describe("Attempt review — a Build a Sentence Item handed in with blanks empty", () => {
  const incomplete = (itemId: string, tileOrder: string[], key: string[][]): ItemVM => ({
    ...basItem(itemId, tileOrder, key),
    score: 0,
    scoreJson: { correct: false, correctAnswers: key },
  });

  it("lists a partly filled frameless Item's tiles and counts its empty blanks from the key", async () => {
    vi.mocked(getAttempt).mockResolvedValue(detailWith([incomplete("bas-legacy", ["think", "it's mine."], [LEGACY_ANSWER])]));
    vi.mocked(getSet).mockResolvedValue(servedSet);

    await renderSettledReview();
    const answer = screen.getByTestId("bas-answer-bas-legacy");
    expect(answer).toHaveTextContent("Your Response: 1 of 3 blanks left empty.");
    expect(placedTiles(answer)).toEqual(["think", "it's mine."]);
    expect(answer).not.toHaveTextContent("think it's mine.");
    expect(screen.getByTestId("bas-key-bas-legacy")).toHaveTextContent("Key: I think it's mine.");
  });

  it("still says an Item with no tile placed has no Response", async () => {
    vi.mocked(getAttempt).mockResolvedValue(detailWith([incomplete("bas-partial", [], [REFERENCE_ANSWER])]));
    vi.mocked(getSet).mockResolvedValue(servedSet);

    await renderSettledReview();
    const answer = screen.getByTestId("bas-answer-bas-partial");
    expect(answer).toHaveTextContent("Your Response: (no Response submitted)");
    expect(answer).not.toHaveTextContent("blanks left empty");
  });
});

describe("Attempt review — a Build a Sentence Response with no frame to be had", () => {
  it("renders a frameless Set's Items exactly as before", async () => {
    vi.mocked(getAttempt).mockResolvedValue(detailWith([basItem("bas-legacy", LEGACY_ANSWER, [LEGACY_ANSWER])]));
    vi.mocked(getSet).mockResolvedValue({
      ...servedSet,
      buildASentence: { items: [{ id: "bas-legacy", prompt: "Whose notebook is this?", tiles: [...LEGACY_ANSWER, "thinks"] }] },
    });

    await renderSettledReview();
    expect(screen.getByTestId("bas-answer-bas-legacy")).toHaveTextContent("Your Response: I think it's mine.");
  });

  it("still renders the review when the Set cannot be read at all", async () => {
    // Retired Sets stay readable so past Attempts remain reviewable, but the Set fetch is
    // best-effort (the page logs and continues): a review whose Set is gone renders the Response it
    // has rather than becoming a broken page.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getAttempt).mockResolvedValue(detailWith([basItem("bas-framed", REFERENCE_ANSWER, [REFERENCE_ANSWER])]));
    vi.mocked(getSet).mockRejectedValue(new Error("404: not found"));

    await renderSettledReview();
    expect(screen.getByTestId("bas-answer-bas-framed")).toHaveTextContent(`Your Response: ${REFERENCE_ANSWER.join(" ")}`);
    expect(screen.getByTestId("bas-key-bas-framed")).toHaveTextContent(`Key: ${REFERENCE_ANSWER.join(" ")}`);
    warn.mockRestore();
  });

  it("falls back for an Item the fetched Set no longer carries", async () => {
    // A Set changed on disk under the same id can leave the Attempt naming Items the Set has no
    // frame for. With nothing to compose with, the Response renders as its tiles joined by spaces.
    vi.mocked(getAttempt).mockResolvedValue(detailWith([basItem("bas-gone", REFERENCE_ANSWER, [REFERENCE_ANSWER])]));
    vi.mocked(getSet).mockResolvedValue(servedSet);

    await renderSettledReview();
    expect(screen.getByTestId("bas-answer-bas-gone")).toHaveTextContent(
      `Your Response: ${REFERENCE_ANSWER.join(" ")}`,
    );
    // Nor any tiles: the Set cannot say what this Item offered.
    expect(screen.queryByTestId("bas-tiles-bas-gone")).not.toBeInTheDocument();
  });
});

// A Simulation's keys reach the client only once the Attempt is completed, and its marks with them:
// until then the server sends each Build a Sentence Item's frame with neither its `correctAnswers`
// nor its `correct`, and says the marks are withheld. The review shows each Response with no key
// line, no Correct or Incorrect mark and no count of correct Items.
describe("Attempt review — a Simulation's Build a Sentence Items before the key is shown", () => {
  it("shows each Response with no mark, no count and no key", async () => {
    const keyless = (itemId: string, tileOrder: string[]): ItemVM => ({
      ...basItem(itemId, tileOrder, []),
      score: null,
      scoreJson: { frame: REFERENCE_FRAME },
    });
    const base = detailWith([keyless("bas-framed", REFERENCE_ANSWER), keyless("bas-partial", REFERENCE_ANSWER.slice(0, 3))]);
    vi.mocked(getAttempt).mockResolvedValue({
      ...base,
      attempt: { ...base.attempt, mode: "simulation", status: "in_progress", completedAt: null },
      bandStatus: { status: "unfinished" },
      marksWithheld: "attempt-in-progress",
    });
    vi.mocked(getSet).mockResolvedValue(servedSet);

    await renderSettledReview();
    expect(screen.getByTestId("bas-answer-bas-framed")).toHaveTextContent(`Your Response: ${REFERENCE_SENTENCE}`);
    expect(screen.getByTestId("item-bas-framed")).toHaveTextContent("Not marked yet");
    expect(screen.getByTestId("item-bas-partial")).toHaveTextContent("Not marked yet");
    expect(document.body.textContent).not.toMatch(/\bCorrect\b|\bIncorrect\b|\d+ of \d+ correct/);
    // Without the key the frame still counts the blanks, so the partial Item is listed, not composed.
    const partial = screen.getByTestId("bas-answer-bas-partial");
    expect(partial).toHaveTextContent("Your Response: 3 of 6 blanks left empty.");
    expect(partial).not.toHaveTextContent("The volunteers who led us through");
    expect(placedTiles(partial)).toEqual(REFERENCE_ANSWER.slice(0, 3));
    expect(screen.queryByText(/^Key/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("bas-key-bas-framed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("bas-key-bas-partial")).not.toBeInTheDocument();
  });

  it("lists the tiles the Item offered without marking which one is extra", async () => {
    // The tiles are what the run showed; which of them belongs in no accepted sentence is the key.
    const keyless = { ...basItem("bas-framed", REFERENCE_ANSWER, []), score: null, scoreJson: { frame: REFERENCE_FRAME } };
    const base = detailWith([keyless]);
    vi.mocked(getAttempt).mockResolvedValue({
      ...base,
      attempt: { ...base.attempt, mode: "simulation", status: "in_progress", completedAt: null },
      bandStatus: { status: "unfinished" },
      marksWithheld: "attempt-in-progress",
    });
    vi.mocked(getSet).mockResolvedValue(servedSet);

    await renderSettledReview();
    const tiles = within(screen.getByTestId("bas-tiles-bas-framed")).getAllByRole("listitem");
    expect(tiles.map((li) => li.textContent)).toEqual(["led us through", "new wing", "the", "volunteers", "was", "were", "who"]);
    expect(tiles.some((li) => li.hasAttribute("data-extra"))).toBe(false);
    expect(screen.queryByText(/not in the sentence/)).not.toBeInTheDocument();
  });
});

// The band carries the CEFR level it maps to on the band's own pencilled figure, never as a
// free-standing level, with the method in plain words and its internal name behind a disclosure.
describe("Attempt review — the band and its CEFR level", () => {
  beforeEach(() => {
    vi.mocked(getSet).mockResolvedValue(servedSet);
  });

  it("marks the band an estimate, attaches the level to it, and keeps the method and raw score in the disclosure", async () => {
    vi.mocked(getAttempt).mockResolvedValue({
      ...detailWith([basItem("bas-legacy", LEGACY_ANSWER, [LEGACY_ANSWER])]),
      estimate: {
        section: "writing",
        band: 4.5,
        raw: 0.71,
        method: "linear-v2",
        coverage: [{ taskType: "build_sentence", itemCount: 1 }],
      },
      bandStatus: { status: "estimated" },
    });

    await renderSettledReview();
    const band = screen.getByTestId("band-summary");
    expect(band).toHaveTextContent(/4\.5\/6 out of 6 · B2\s*estimate/);
    expect(screen.getByTestId("cefr-level").textContent).toBe(" · B2");
    expect(band).toHaveTextContent("Weighted average of your scored Items, over:");
    expect(band).toHaveTextContent("Build a Sentence · 1 Item");
    expect(band).toHaveTextContent(/Method linear-v2 · raw 0\.71/);
  });

  it("shows no level when the attempt has no estimate at all", async () => {
    vi.mocked(getAttempt).mockResolvedValue(detailWith([basItem("bas-legacy", LEGACY_ANSWER, [LEGACY_ANSWER])]));

    await renderSettledReview();
    expect(screen.queryByTestId("cefr-level")).not.toBeInTheDocument();
    expect(screen.getByText(/^No band( yet)?$/)).toBeInTheDocument();
  });
});

// A deliberately skipped Speaking Simulation Item is scored with a real 0 and no Score Report
// behind it. Two disclosures keep that honest: the Item says why it is 0, and the estimate surface
// says the band includes Items nobody answered. Without them the card would read as scored with
// nothing on it.
const SKIP_REASON =
  "No recording was made for this item, so it scores 0 — the same as leaving a question unanswered on the real test.";

function skippedSpeakingItem(itemId: string): ItemVM {
  return {
    attemptId: "att-1",
    itemId,
    taskType: "interview",
    responseText: null,
    responseAudioPath: null,
    transcript: null,
    score: 0,
    scoreJson: { skipped: true, reason: SKIP_REASON },
    scoringStatus: "scored",
    deliveryReport: null,
    createdAt: "2026-01-01T00:01:00Z",
  };
}

function speakingDetail(items: ItemVM[], estimate: AttemptDetailVM["estimate"]): AttemptDetailVM {
  return {
    attempt: {
      id: "att-1",
      kind: "speaking",
      mode: "simulation",
      setId: "spk-1",
      setTitle: null,
      isRepeat: false,
      status: "completed",
      startedAt: "2026-01-01T00:00:00Z",
      completedAt: "2026-01-01T00:05:00Z",
      captureFinishedAt: "2026-01-01T00:04:00Z",
      flagged: false,
    },
    items,
    judgeReports: [],
    estimate,
    bandStatus: { status: "incomplete", unscored: [], absent: [] },
    activeJobs: [],
  };
}

describe("Attempt review — a deliberately skipped Speaking Simulation Item", () => {
  beforeEach(() => {
    vi.mocked(getSet).mockRejectedValue(new Error("404: not found"));
  });

  it("explains the 0 instead of rendering an empty scored card", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getAttempt).mockResolvedValue(speakingDetail([skippedSpeakingItem("int-4")], null));

    renderReview();
    const note = await screen.findByTestId("skipped-item-note");
    expect(note).toHaveTextContent("Skipped, scored 0");
    expect(note).toHaveTextContent(SKIP_REASON);
    // Not a failure, so none of the failure affordances may appear: there is no recording to
    // re-score and nothing server-side to recover.
    expect(screen.queryByRole("button", { name: "Re-score" })).toBeNull();
    warn.mockRestore();
  });

  it("discloses on the estimate surface that skipped items are counted in the band", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getAttempt).mockResolvedValue(
      speakingDetail([skippedSpeakingItem("int-4")], {
        section: "speaking",
        band: 4.5,
        raw: 0.72,
        method: "linear-v2",
        coverage: [
          { taskType: "listen_repeat", itemCount: 7, skippedCount: 0 },
          { taskType: "interview", itemCount: 4, skippedCount: 1 },
        ],
      }),
    );

    renderReview();
    expect(await screen.findByText("Interview · 4 Items (1 skipped)")).toBeInTheDocument();
    expect(screen.getByText(/Includes 1 skipped Item scored 0/)).toBeInTheDocument();
    // The Task Type with nothing skipped keeps its plain label.
    expect(screen.getByText("Listen and Repeat · 7 Items")).toBeInTheDocument();
    warn.mockRestore();
  });

  it("says nothing about skips for an estimate whose coverage does not count them", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getAttempt).mockResolvedValue(
      speakingDetail([], {
        section: "speaking",
        band: 5,
        raw: 0.8,
        method: "linear-v1",
        coverage: [{ taskType: "listen_repeat", itemCount: 7 }],
      }),
    );

    renderReview();
    expect(await screen.findByText("Listen and Repeat · 7 Items")).toBeInTheDocument();
    expect(screen.queryByText(/skipped/)).toBeNull();
    warn.mockRestore();
  });
});
