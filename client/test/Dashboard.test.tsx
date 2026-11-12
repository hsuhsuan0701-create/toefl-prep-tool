import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AttemptListVM, Section, SetListEntryVM, StatsSectionVM, StatsSettingsVM, StatsSummaryVM } from "@toefl-prep/shared";
import type { SetupStatus } from "../src/lib/api";
import * as api from "../src/lib/api";
import Dashboard from "../src/pages/Dashboard";
import { renderRoutes } from "./dataRouter";

// The Dashboard mounted for real behind a mocked api client: a first run leads with "Start here" and
// the Setup checklist; afterwards it leads with the Overall and the one suggested next step, chosen
// by the rule in suggestNext.ts and never offering a run this machine could not score.

vi.mock("../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...real,
    getStatsSummary: vi.fn(),
    getStatsSettings: vi.fn(),
    putStatsSettings: vi.fn(),
    getSetupStatus: vi.fn(),
    recheckSetupStatus: vi.fn(),
    getReasoningStatus: vi.fn(async () => ({ providers: [], operationalProviders: [] })),
    listSets: vi.fn(async () => []),
    listAttempts: vi.fn(),
    completeAttempt: vi.fn(),
    abortAttempt: vi.fn(),
    listFullTests: vi.fn(async () => []),
    listActiveGeneration: vi.fn(async () => ({ active: [] })),
    createFullTest: vi.fn(),
    startGenerate: vi.fn(async () => ({ jobId: "job-1" })),
    startGenerateBatch: vi.fn(async () => ({ jobId: "batch-1" })),
    getGenerateJob: vi.fn(async () => ({ jobId: "job-1", kind: "writing", status: "running", stage: "planning", progress: null })),
    getGenerateBatchJob: vi.fn(),
  };
});

const mocked = vi.mocked(api);

const TARGETS: StatsSettingsVM = { targets: { reading: 5.5, listening: 5.5, writing: 5.5, speaking: 5.5 } };

function band(section: Section, value: number, over: Partial<StatsSectionVM> = {}): StatsSectionVM {
  return {
    section,
    band: value,
    method: section === "reading" || section === "listening" ? "table3-v1" : "linear-v2",
    attemptId: `att-${section}`,
    mode: "simulation",
    attemptedAt: "2026-11-10T10:00:00.000Z",
    target: 5.5,
    ...over,
  };
}

function summary(sections: StatsSectionVM[], overallBand: number | null): StatsSummaryVM {
  const have = new Set(sections.map((s) => s.section));
  return {
    sections,
    overall: { band: overallBand, missingSections: (["reading", "listening", "writing", "speaking"] as const).filter((s) => !have.has(s)) },
    weaknesses: [],
    judgeAgreement: { avgDelta: null, sampleSize: 0 },
    skillItems: [],
    skillItemsLimit: 300,
  };
}

const READY: SetupStatus = {
  rubrics: { source: "rewritten" },
  claudeCli: "ready",
  codexCli: "ready",
  geminiApiKey: true,
  openaiApiKey: true,
  geminiJudgeModel: true,
  openaiJudgeModel: true,
  ffmpeg: true,
  ffprobe: true,
  capabilities: {
    "reading-writing-generation": true,
    "speaking-listening-generation": true,
    "writing-scoring": true,
    "speaking-scoring": true,
    "speaking-uploads": true,
  },
  missing: [],
};

/** A fresh clone: no keys, no CLI. */
const FRESH: SetupStatus = {
  ...READY,
  claudeCli: "not-installed",
  codexCli: "not-installed",
  geminiApiKey: false,
  openaiApiKey: false,
  capabilities: {
    "reading-writing-generation": false,
    "speaking-listening-generation": false,
    "writing-scoring": false,
    "speaking-scoring": false,
    "speaking-uploads": true,
  },
  missing: [
    { piece: "claude-cli", disables: ["reading-writing-generation", "speaking-listening-generation", "writing-scoring", "speaking-scoring"] },
    { piece: "codex-cli", disables: ["reading-writing-generation", "speaking-listening-generation", "writing-scoring", "speaking-scoring"] },
    { piece: "gemini-api-key", disables: ["speaking-listening-generation", "writing-scoring", "speaking-scoring"] },
    { piece: "openai-api-key", disables: ["writing-scoring"] },
  ],
};

const SOME_ATTEMPTS: AttemptListVM = {
  items: [
    {
      id: "att-reading",
      kind: "reading",
      mode: "simulation",
      setId: "rd-1",
      setTitle: "How Gravel Beds Shelter Young Salmon",
      isRepeat: false,
      status: "completed",
      startedAt: "2026-11-10T09:30:00.000Z",
      completedAt: "2026-11-10T10:00:00.000Z",
      captureFinishedAt: null,
      flagged: false,
      estimate: { band: 6, method: "table3-v1" },
      bandExpected: true,
      fullTestRun: null,
    },
  ],
  total: 1,
};

function setUp(opts: { summary: StatsSummaryVM; setup?: SetupStatus; attempts?: AttemptListVM; settings?: StatsSettingsVM }) {
  mocked.getStatsSummary.mockResolvedValue(opts.summary);
  mocked.getStatsSettings.mockResolvedValue(opts.settings ?? TARGETS);
  mocked.getSetupStatus.mockResolvedValue(opts.setup ?? READY);
  mocked.listAttempts.mockResolvedValue(opts.attempts ?? SOME_ATTEMPTS);
}

function renderDashboard(at = "/") {
  return renderRoutes(
    [
      { path: "/", element: <Dashboard /> },
      { path: "/full-test/:runId", element: <p>Full-Test Run page</p> },
    ],
    at,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dashboard — first run", () => {
  beforeEach(() => setUp({ summary: summary([], null), setup: FRESH, attempts: { items: [], total: 0 } }));

  it("leads with Start here, whose first step is the one primary action: a Reading Simulation", async () => {
    renderDashboard();
    const start = await screen.findByRole("region", { name: "Start here" });
    expect(within(start).getByRole("link", { name: "Start Reading Simulation" })).toHaveAttribute("href", "/simulate/reading");
    // The Listening warm-up opens the Set list on its Listening tab, not on Reading.
    expect(within(start).getByRole("link", { name: "Choose a Listening Set" })).toHaveAttribute("href", "/sets?section=listening");
    // No Overall on a first run, and no second primary from the suggestion block.
    expect(screen.queryByText("Overall")).toBeNull();
    expect(screen.queryByText("Suggested next")).toBeNull();
  });

  it("shows the Setup checklist open, with Reading and Listening usable right away", async () => {
    renderDashboard();
    const checks = await screen.findByRole("list", { name: "Setup checks" });
    const first = within(checks).getAllByRole("listitem")[0];
    expect(first).toHaveTextContent("Reading and Listening");
    expect(first).toHaveTextContent("Ready");
    expect(within(checks).getByText("GEMINI_API_KEY")).toBeInTheDocument();
  });

  it("says Writing and Speaking need setting up, rather than offering runs that cannot be scored", async () => {
    renderDashboard();
    const start = await screen.findByRole("region", { name: "Start here" });
    expect(await within(start).findByText("Set up scoring for Writing and Speaking")).toBeInTheDocument();
    expect(within(start).queryByRole("link", { name: /Writing Simulation/ })).toBeNull();
  });

  it("gives every section a 5.5 Target and no band, saying what gets one", async () => {
    renderDashboard();
    const reading = await screen.findByRole("region", { name: "Reading band" });
    expect(await within(reading).findByText("No band yet")).toBeInTheDocument();
    expect(within(reading).getByText(/Take a Reading Simulation/)).toBeInTheDocument();
    for (const name of ["Reading", "Listening", "Writing", "Speaking"]) {
      expect(await screen.findByRole("button", { name: `Edit ${name} Target` })).toBeInTheDocument();
    }
    const writing = screen.getByRole("region", { name: "Writing band" });
    expect(within(writing).getByText(/This machine can't score Writing yet/)).toBeInTheDocument();
  });

  it("says there are no Attempts yet", async () => {
    renderDashboard();
    expect(await screen.findByText("No Attempts yet")).toBeInTheDocument();
  });
});

describe("Dashboard — after the first Attempt", () => {
  it("shows the Overall and suggests the section furthest below its Target", async () => {
    setUp({ summary: summary([band("reading", 6), band("listening", 5.5), band("writing", 5), band("speaking", 4.5)], 5.5) });
    renderDashboard();
    const link = await screen.findByRole("link", { name: "Start Speaking Simulation" });
    expect(link).toHaveAttribute("href", "/simulate/speaking");
    expect(screen.getByText(/Speaking is furthest from its Target: 1 band below it/)).toBeInTheDocument();
    expect(screen.getByText("Overall")).toBeInTheDocument();
  });

  it("suggests the first section in test order with no band", async () => {
    setUp({ summary: summary([band("reading", 6), band("speaking", 3)], null) });
    renderDashboard();
    expect(await screen.findByRole("link", { name: "Start Listening Simulation" })).toBeInTheDocument();
    expect(screen.getByText(/Listening and Writing have none yet/)).toBeInTheDocument();
  });

  it("suggests a Full-Test Run when every section is at or above its Target, and starts one", async () => {
    setUp({ summary: summary([band("reading", 6), band("listening", 5.5), band("writing", 5.5), band("speaking", 6)], 6) });
    mocked.createFullTest.mockResolvedValue({ id: "run-9" } as Awaited<ReturnType<typeof api.createFullTest>>);
    const { router } = renderDashboard();
    const suggested = await screen.findByText("Suggested next");
    const block = suggested.parentElement!;
    await userEvent.click(within(block).getByRole("button", { name: "Start a Full-Test Run" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/full-test/run-9"));
  });

  it("names what is missing instead of offering a run this machine cannot score, and opens Setup", async () => {
    setUp({
      summary: summary([band("reading", 6), band("listening", 5.5)], null),
      setup: { ...FRESH },
    });
    renderDashboard();
    const button = await screen.findByRole("button", { name: "See what's missing" });
    expect(screen.queryByRole("link", { name: "Start Writing Simulation" })).toBeNull();
    expect(screen.getByText(/Not set up: Claude Code, the Codex CLI, a Gemini key and an OpenAI key/)).toBeInTheDocument();

    // Collapsed after the first Attempt; the suggestion opens it.
    expect(screen.queryByRole("list", { name: "Setup checks" })).not.toBeVisible();
    await userEvent.click(button);
    expect(screen.getByRole("list", { name: "Setup checks" })).toBeVisible();
  });

  it("scrolls to Setup only once its checklist has opened, so the page is tall enough to bring the heading to the top", async () => {
    setUp({ summary: summary([band("reading", 6), band("listening", 5.5)], null), setup: { ...FRESH } });
    // jsdom has no layout, so record what the page looked like at the moment the scroll was asked for.
    const openWhenScrolled: boolean[] = [];
    const scrollIntoView = vi.fn(function (this: Element) {
      openWhenScrolled.push(this.querySelector("details")?.open ?? false);
    });
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderDashboard();
      await userEvent.click(await screen.findByRole("button", { name: "See what's missing" }));
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      expect(scrollIntoView.mock.contexts[0]).toHaveAttribute("id", "setup");
      expect(openWhenScrolled).toEqual([true]);
      expect(document.activeElement).toHaveAttribute("id", "setup");
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  // The notice before a run this machine can't score links to /#setup from another page.
  it("opens Setup and scrolls to it when the page is reached at /#setup", async () => {
    setUp({ summary: summary([band("reading", 6), band("listening", 5.5)], null), setup: { ...FRESH } });
    const openWhenScrolled: boolean[] = [];
    const scrollIntoView = vi.fn(function (this: Element) {
      openWhenScrolled.push(this.querySelector("details")?.open ?? false);
    });
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderDashboard("/#setup");
      await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
      expect(scrollIntoView.mock.contexts[0]).toHaveAttribute("id", "setup");
      expect(openWhenScrolled).toEqual([true]);
      expect(screen.getByRole("list", { name: "Setup checks" })).toBeVisible();
      expect(document.activeElement).toHaveAttribute("id", "setup");
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  // The rest of the page is still loading above Setup when the link arrives; jsdom has no layout, so
  // a stand-in ResizeObserver reports the page growing.
  it("puts Setup back at the top when the page grows after an arrival at /#setup, until the User scrolls", async () => {
    setUp({ summary: summary([band("reading", 6), band("listening", 5.5)], null), setup: { ...FRESH } });
    const observers: { grow: () => void; disconnected: boolean }[] = [];
    class GrowingPage {
      disconnected = false;
      readonly onResize: () => void;
      constructor(onResize: () => void) {
        this.onResize = onResize;
        observers.push(this);
      }
      grow() {
        if (!this.disconnected) this.onResize();
      }
      observe() {}
      unobserve() {}
      disconnect() {
        this.disconnected = true;
      }
    }
    vi.stubGlobal("ResizeObserver", GrowingPage);
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    try {
      renderDashboard("/#setup");
      await waitFor(() => expect(observers).toHaveLength(1));
      const arrived = scrollIntoView.mock.calls.length;
      observers[0].grow();
      expect(scrollIntoView).toHaveBeenCalledTimes(arrived + 1);
      expect(scrollIntoView.mock.contexts.at(-1)).toHaveAttribute("id", "setup");

      window.dispatchEvent(new Event("wheel"));
      observers[0].grow();
      expect(observers[0].disconnected).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledTimes(arrived + 1);
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
      vi.unstubAllGlobals();
    }
  });

  it("keeps Setup reachable but collapsed, behind what this machine can't do yet", async () => {
    setUp({ summary: summary([band("reading", 6)], null), setup: FRESH });
    renderDashboard();
    expect(await screen.findByText(/Not available on this machine yet: Writing scoring/)).toBeInTheDocument();
    expect(screen.getByText("Show the checklist")).toBeInTheDocument();
  });

  it("saves a Target and re-reads the bands", async () => {
    setUp({ summary: summary([band("reading", 5)], null) });
    mocked.putStatsSettings.mockResolvedValue({ targets: { ...TARGETS.targets, reading: 6 } });
    renderDashboard();
    await userEvent.click(await screen.findByRole("button", { name: "Edit Reading Target" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Reading Target" }), "6");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(mocked.putStatsSettings).toHaveBeenCalledWith({ targets: { reading: 6 } });
    await waitFor(() => expect(mocked.getStatsSummary).toHaveBeenCalledTimes(2));
  });

  it("re-runs the setup checks on Check again", async () => {
    setUp({ summary: summary([band("reading", 6)], null), setup: FRESH });
    mocked.recheckSetupStatus.mockResolvedValue(READY);
    renderDashboard();
    await screen.findByText(/Not available on this machine yet/);
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(mocked.recheckSetupStatus).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Everything is set up.")).toBeInTheDocument();
  });
});

describe("Dashboard — when the bands or the Targets fail to load", () => {
  const ALL_FOUR = summary([band("reading", 6), band("listening", 5.5), band("writing", 5), band("speaking", 4.5)], 5.5);

  it("says the Overall and the next step could not load, stops reading as busy, and loads both on Try again", async () => {
    setUp({ summary: ALL_FOUR });
    mocked.getStatsSummary.mockRejectedValueOnce(new api.HttpError(500, "500: boom"));
    renderDashboard();

    const overall = (await screen.findByText("Couldn't load your Overall band")).parentElement!;
    expect(screen.getByText("Couldn't work out what to practise next")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());

    await userEvent.click(within(overall).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Start Speaking Simulation" })).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load your Overall band")).toBeNull();
    expect(screen.getByText("Overall")).toBeInTheDocument();
  });

  it("says the next step could not load when the Targets fail, and loads it on Try again", async () => {
    setUp({ summary: ALL_FOUR });
    mocked.getStatsSettings.mockRejectedValueOnce(new api.HttpError(500, "500: boom"));
    renderDashboard();

    const next = (await screen.findByText("Couldn't work out what to practise next")).parentElement!;
    expect(screen.getByText("Overall")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull());

    await userEvent.click(within(next).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Start Speaking Simulation" })).toBeInTheDocument();
    expect(mocked.getStatsSettings).toHaveBeenCalledTimes(2);
  });
});

describe("Dashboard — acting on an unfinished Attempt in Recent Attempts", () => {
  const UNFINISHED_WRITING: AttemptListVM = {
    items: [
      ...SOME_ATTEMPTS.items,
      {
        ...SOME_ATTEMPTS.items[0],
        id: "att-writing",
        kind: "writing",
        setId: "wri-1",
        setTitle: "Protective gloves for the biology workshop",
        status: "in_progress",
        completedAt: null,
        estimate: null,
      },
    ],
    total: 2,
  };
  const THREE_BANDS = summary([band("reading", 6), band("listening", 5.5), band("speaking", 5)], null);

  it("re-reads the bands after Finish and score, so the Writing card and the Overall agree with the row", async () => {
    setUp({ summary: THREE_BANDS, attempts: UNFINISHED_WRITING });
    mocked.completeAttempt.mockResolvedValue({ status: "completed" });
    renderDashboard();
    const writing = await screen.findByRole("region", { name: "Writing band" });
    expect(await within(writing).findByText("No band yet")).toBeInTheDocument();

    mocked.getStatsSummary.mockResolvedValue(summary([band("reading", 6), band("listening", 5.5), band("writing", 5), band("speaking", 5)], 5.5));
    await userEvent.click(screen.getByRole("button", { name: "Finish and score…" }));
    await userEvent.click(screen.getByRole("button", { name: "Finish and score" }));

    expect(mocked.completeAttempt).toHaveBeenCalledWith("att-writing");
    await waitFor(() => expect(within(writing).queryByText("No band yet")).toBeNull());
    expect(screen.queryByText(/It appears once all four sections have a band/)).toBeNull();
  });

  it("re-reads the bands after a Discard too", async () => {
    setUp({ summary: THREE_BANDS, attempts: UNFINISHED_WRITING });
    mocked.abortAttempt.mockResolvedValue({ status: "aborted" });
    renderDashboard();
    await screen.findByRole("button", { name: "Discard…" });
    await waitFor(() => expect(mocked.getStatsSummary).toHaveBeenCalledTimes(1));

    await userEvent.click(screen.getByRole("button", { name: "Discard…" }));
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(mocked.abortAttempt).toHaveBeenCalledWith("att-writing");
    await waitFor(() => expect(mocked.getStatsSummary).toHaveBeenCalledTimes(2));
  });
});

describe("Dashboard — generating Sets", () => {
  const LISTENING: SetListEntryVM = {
    id: "lsn-1",
    kind: "listening",
    source: "generated",
    createdAt: "2026-11-01T00:00:00.000Z",
    title: "Neuroscience Talk",
    summary: null,
    attempted: false,
  };

  it("starts one Set straight away from the dialog", async () => {
    setUp({ summary: summary([], null) });
    renderDashboard();
    await userEvent.click(await screen.findByRole("button", { name: "Generate Sets" }));
    const dialog = screen.getByRole("dialog", { name: "Generate Sets" });
    expect(within(dialog).getByText(/1 Set · about 3 AI calls/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Generate 1 Set" }));
    expect(mocked.startGenerate).toHaveBeenCalledWith("writing", {});
    expect(await screen.findByText("Generating a Writing Set")).toBeInTheDocument();
  });

  it("asks before a batch, with what it costs", async () => {
    setUp({ summary: summary([], null) });
    renderDashboard();
    await userEvent.click(await screen.findByRole("button", { name: "Generate Sets" }));
    await userEvent.click(screen.getByRole("button", { name: "More Speaking Sets" }));
    await userEvent.click(screen.getByRole("button", { name: "Generate 2 Sets…" }));
    const confirm = screen.getByRole("dialog", { name: "Generate 2 Sets?" });
    expect(confirm).toHaveTextContent("Normally about 5 AI calls");
    expect(confirm).toHaveTextContent("Speaking: 13 text-to-speech clips, which are paid Gemini calls — at most 26");
    expect(mocked.startGenerateBatch).not.toHaveBeenCalled();
    await userEvent.click(within(confirm).getByRole("button", { name: "Generate 2 Sets" }));
    expect(mocked.startGenerateBatch).toHaveBeenCalledWith([
      { kind: "writing", count: 1 },
      { kind: "speaking", count: 1 },
    ]);
  });

  it("says a Listening Set records one clip per Stimulus, a Conversation being one clip for the whole dialogue", async () => {
    setUp({ summary: summary([], null) });
    renderDashboard();
    await userEvent.click(await screen.findByRole("button", { name: "Generate Sets" }));
    await userEvent.click(screen.getByRole("button", { name: "More Listening Sets" }));
    await userEvent.click(screen.getByRole("button", { name: "Generate 2 Sets…" }));
    const confirm = screen.getByRole("dialog", { name: "Generate 2 Sets?" });
    expect(confirm).toHaveTextContent("one audio clip per Stimulus (a Conversation is one clip for the whole dialogue)");
    expect(confirm).not.toHaveTextContent(/per turn/);
  });

  it("offers to replace the newest Listening Set, by its title, and keeps it on request", async () => {
    setUp({ summary: summary([], null) });
    mocked.listSets.mockImplementation(async (kind?: string) => (kind === "listening" ? [LISTENING] : []));
    renderDashboard();
    await userEvent.click(await screen.findByRole("button", { name: "Generate Sets" }));
    await userEvent.click(screen.getByRole("button", { name: "Fewer Writing Sets" }));
    await userEvent.click(screen.getByRole("button", { name: "More Listening Sets" }));
    expect(await screen.findByText(/Replaces “Neuroscience Talk”/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Generate 1 Set" }));
    expect(mocked.startGenerate).toHaveBeenCalledWith("listening", { supersedesSetId: "lsn-1" });
  });

  it("does not offer a section this machine cannot generate", async () => {
    setUp({ summary: summary([], null), setup: FRESH });
    renderDashboard();
    await userEvent.click(await screen.findByRole("button", { name: "Generate Sets" }));
    const dialog = screen.getByRole("dialog", { name: "Generate Sets" });
    expect(within(dialog).getByText(/This machine can't generate Sets yet/)).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "More Reading Sets" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Generate Sets" })).toBeDisabled();
  });
});
