import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import type { ServedListeningSet, ServedReadingSet } from "@toefl-prep/shared";
import { renderRoutes } from "./dataRouter";
import ReadingSimulation from "../src/pages/simulation/ReadingSimulation";
import ListeningSimulation from "../src/pages/simulation/ListeningSimulation";

// The Reading and Listening Simulation intros: what the User is told before committing about half an
// hour. Two things are checked here.
//
// The Repeat notice follows the attempted rule: a Set counts as attempted only through an Attempt
// that has a scored Item, or is completed and holds at least one Item, which the Set listing answers
// as `attempted`. An Attempt that was opened and abandoned does not make the next one a Repeat,
// however many of those the Attempt log holds.
//
// The intro names the Set by its title and says how long, how many Items and when feedback comes, in
// words.

vi.mock("../src/lib/api", () => ({
  advanceFullTest: vi.fn(async () => ({})),
  listSets: vi.fn(),
  // Abandoned Attempts exist on every Set below. The intro must not read them as a Repeat.
  listAttempts: vi.fn(async () => ({ attempts: [], total: 3 })),
  getSet: vi.fn(),
  createAttempt: vi.fn(async () => ({ attemptId: "att-1", isRepeat: false })),
  completeAttempt: vi.fn(async () => ({})),
  flagAttempt: vi.fn(async () => ({})),
  scoreDeterministicTask: vi.fn(async () => ({ items: [] })),
  routeAttempt: vi.fn(async () => ({ path: "lower" })),
  finishSpeakingCapture: vi.fn(async () => ({})),
  DeterministicAlreadyScoredError: class DeterministicAlreadyScoredError extends Error {},
}));

const mcq = (id: string) => ({
  id,
  stem: `${id} stem?`,
  options: [
    { id: "a", text: `${id} A` },
    { id: "b", text: `${id} B` },
  ],
});

const readingSet: ServedReadingSet = {
  id: "rd-intro-1",
  kind: "reading",
  source: "generated",
  createdAt: "2026-09-01T10:00:00.000Z",
  router: {
    timeLimitSec: 1200,
    ctwPassages: [
      {
        id: "ctw-1",
        taskType: "complete_words",
        topic: "t",
        segments: [
          { type: "text", text: "The " },
          { type: "gap", gapId: "g1" },
          { type: "text", text: " and " },
          { type: "gap", gapId: "g2" },
        ],
        gaps: [
          { id: "g1", prefix: "ca", blankLength: 1 },
          { id: "g2", prefix: "do", blankLength: 1 },
        ],
      },
    ],
    dailyLife: [{ id: "dl-1", taskType: "daily_life", genre: "notice", text: "Closed at six.", questions: [mcq("dl-1-q1")] }],
    academic: [],
  },
  lowerModule: {
    timeLimitSec: 540,
    ctwPassages: [],
    dailyLife: [{ id: "dl-2", taskType: "daily_life", genre: "email", text: "Hi.", questions: [mcq("dl-2-q1")] }],
    academic: [],
  },
  upperModule: {
    timeLimitSec: 540,
    ctwPassages: [],
    dailyLife: [],
    academic: [
      { id: "ap-1", taskType: "academic_passage", title: "Salmon", discipline: "biology", text: "Prose.", questions: [mcq("ap-1-q1"), mcq("ap-1-q2")] },
    ],
  },
};

const speaker = { id: "sp", role: "student", gender: "male" as const, accent: "british" as const };
const listeningSet: ServedListeningSet = {
  id: "lsn-intro-1",
  kind: "listening",
  source: "generated",
  createdAt: "2026-09-01T10:00:00.000Z",
  router: {
    timeLimitSec: 1080,
    listenChoose: [{ id: "lc-1", taskType: "listen_choose", audio: "a.mp3", speaker, options: mcq("x").options }],
    conversations: [
      { id: "cv-1", taskType: "conversation", audio: "b.mp3", setting: "bookstore", speakers: [speaker], questions: [mcq("cv-1-q1"), mcq("cv-1-q2")] },
    ],
    announcements: [],
    academicTalks: [],
  },
  lowerModule: { timeLimitSec: 420, listenChoose: [], conversations: [], announcements: [], academicTalks: [] },
  upperModule: { timeLimitSec: 660, listenChoose: [], conversations: [], announcements: [], academicTalks: [] },
};

function listing(id: string, title: string, attempted: boolean, kind: "reading" | "listening") {
  return { id, kind, source: "generated", createdAt: "2026-09-01T10:00:00.000Z", title, summary: null, attempted };
}

async function api() {
  const mod = await import("../src/lib/api");
  return mod as unknown as Record<string, ReturnType<typeof vi.fn>>;
}

function renderStandalone(kind: "reading" | "listening") {
  return renderRoutes(
    [
      { path: "/", element: <p>home</p> },
      { path: `/simulate/${kind}`, element: kind === "reading" ? <ReadingSimulation /> : <ListeningSimulation /> },
    ],
    ["/", `/simulate/${kind}`],
  );
}

beforeEach(async () => {
  const m = await api();
  m.getSet.mockImplementation(async (id: string) => (id === readingSet.id ? readingSet : listeningSet));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("the Repeat notice follows the attempted rule", () => {
  it.each([
    ["reading", readingSet.id, "Start Reading Simulation", "Reading"],
    ["listening", listeningSet.id, "Start Listening Simulation", "Listening"],
  ] as const)("%s: abandoned Attempts alone do not make the next one a Repeat", async (kind, id, start, _section) => {
    const m = await api();
    m.listSets.mockResolvedValue([listing(id, "A Set nobody finished", false, kind)]);
    renderStandalone(kind);

    await screen.findByRole("button", { name: start });
    expect(screen.queryByText(/this Attempt is a Repeat/)).toBeNull();
  });

  it.each([
    ["reading", readingSet.id, "Start Reading Simulation", "Reading"],
    ["listening", listeningSet.id, "Start Listening Simulation", "Listening"],
  ] as const)("%s: a Set the listing marks attempted is announced as a Repeat", async (kind, id, start, section) => {
    const m = await api();
    m.listSets.mockResolvedValue([listing(id, "A Set already practised", true, kind)]);
    renderStandalone(kind);

    await screen.findByRole("button", { name: start });
    expect(screen.getByText(new RegExp(`this Attempt is a Repeat. It will not change your ${section} Band Estimate`))).toBeInTheDocument();
  });

  it("inside a Full-Test Run, looks the Run's own Set up in the bank without choosing one", async () => {
    const m = await api();
    m.listSets.mockResolvedValue([listing("rd-other", "Another Set", false, "reading"), listing(readingSet.id, "The Run's Set", true, "reading")]);
    renderRoutes(
      [
        { path: "/full-test/:runId", element: <p>run page</p> },
        {
          path: "/full-test/:runId/reading",
          element: <ReadingSimulation fullTest={{ runId: "run-1", setId: readingSet.id, attemptId: null }} />,
        },
      ],
      ["/full-test/run-1", "/full-test/run-1/reading"],
    );

    // The section leads inside a Run; its Set is named right under it.
    expect(await screen.findByRole("heading", { level: 1, name: "Reading section" })).toBeInTheDocument();
    expect(screen.getByText("The Run's Set")).toBeInTheDocument();
    expect(screen.getByText(/this Attempt is a Repeat/)).toBeInTheDocument();
    // The listing is read for this Set's entry only — never filtered to a section, the picker's query.
    expect(m.listSets.mock.calls).toEqual([[]]);
    expect(m.getSet).toHaveBeenCalledWith(readingSet.id);
  });

  it("inside a Full-Test Run, still starts when the listing cannot be read", async () => {
    const m = await api();
    m.listSets.mockRejectedValue(new TypeError("Failed to fetch"));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      renderRoutes(
        [{ path: "/full-test/:runId/reading", element: <ReadingSimulation fullTest={{ runId: "run-1", setId: readingSet.id }} /> }],
        "/full-test/run-1/reading",
      );
      expect(await screen.findByRole("button", { name: "Start Reading Simulation" })).toBeInTheDocument();
      expect(screen.getByText("Reading Set · Sep 1")).toBeInTheDocument();
      expect(screen.queryByText(/this Attempt is a Repeat/)).toBeNull();
    } finally {
      errors.mockRestore();
    }
  });
});

describe("the intro says what is about to happen", () => {
  it("Reading: names the Set, and gives the time and Item counts in words", async () => {
    const m = await api();
    m.listSets.mockResolvedValue([listing(readingSet.id, "How Gravel Beds Shelter Young Salmon", false, "reading")]);
    renderStandalone("reading");

    expect(await screen.findByRole("heading", { level: 1, name: "How Gravel Beds Shelter Young Salmon" })).toBeInTheDocument();
    const facts = screen.getAllByRole("definition")[0].closest("dl")!;
    expect(within(facts).getByText(/29 min in all/)).toBeInTheDocument();
    expect(within(facts).getByText(/20 min for the Router Module, then 9 min/)).toBeInTheDocument();
    // Router: two gaps and one question; Lower: one question; Upper: two questions.
    expect(within(facts).getByText(/3 Items in the Router Module, then 1 in the Lower Module or 2 in the Upper Module/)).toBeInTheDocument();
    expect(within(facts).getByText(/key and the Explanation/)).toBeInTheDocument();
    expect(facts.textContent).not.toMatch(/\d+s\b/);
  });

  it("Listening: says the audio sets the pace and each Stimulus plays once", async () => {
    const m = await api();
    m.listSets.mockResolvedValue([listing(listeningSet.id, "Campus bookstore", false, "listening")]);
    renderStandalone("listening");

    expect(await screen.findByRole("heading", { level: 1, name: "Campus bookstore" })).toBeInTheDocument();
    const facts = screen.getAllByRole("definition")[0].closest("dl")!;
    expect(facts.textContent).toMatch(/paced by the audio/);
    expect(facts.textContent).toMatch(/plays once/);
    expect(facts.textContent).toMatch(/3 Items in the Router Module/);
  });
});
