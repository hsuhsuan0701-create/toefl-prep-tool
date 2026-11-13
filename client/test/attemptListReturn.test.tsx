import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import type { AttemptDetailVM, AttemptListItemVM, FullTestRunVM, StatsSummaryVM } from "@toefl-prep/shared";
import * as api from "../src/lib/api";
import { appRoutes } from "../src/App";

// Coming back to an Attempt list from an Attempt review (issue #44): the browser's Back, or the
// review's own back link, brings the list back with as many rows as it had and the opened row where
// it sat in the window; "See all N Attempts" lands on the list; the back link names the page the
// review was opened from. Mounted through the app's real route table in a memory router.
//
// jsdom lays nothing out, so a row's place in the window is stood in for: `rowTop` says where each
// row's link sits, and the restoration is asserted as the scroll it asks for once the rows exist.

vi.mock("../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...real,
    getStatsSummary: vi.fn(),
    getStatsSettings: vi.fn(async () => ({ targets: { reading: 5.5, listening: 5.5, writing: 5.5, speaking: 5.5 } })),
    putStatsSettings: vi.fn(),
    getSetupStatus: vi.fn(() => new Promise(() => {})),
    recheckSetupStatus: vi.fn(),
    getReasoningStatus: vi.fn(async () => ({ providers: [], operationalProviders: [] })),
    getTrends: vi.fn(async () => new Map()),
    listSets: vi.fn(async () => []),
    listAttempts: vi.fn(),
    listFullTests: vi.fn(async () => []),
    listActiveGeneration: vi.fn(async () => ({ active: [] })),
    getAttempt: vi.fn(),
    getSet: vi.fn(() => new Promise(() => {})),
    getFullTest: vi.fn(),
    completeAttempt: vi.fn(),
    abortAttempt: vi.fn(),
  };
});

const mocked = vi.mocked(api);

const TOTAL = 30;

function listItem(n: number): AttemptListItemVM {
  return {
    id: `att-${n}`,
    kind: "reading",
    mode: "drill",
    setId: `rd-${n}`,
    setTitle: `Reading Set ${n}`,
    isRepeat: false,
    status: "completed",
    startedAt: "2026-11-10T09:30:00.000Z",
    completedAt: "2026-11-10T10:00:00.000Z",
    captureFinishedAt: null,
    flagged: false,
    estimate: null,
    missingBand: null,
    fullTestRun: null,
  };
}

const LOG = Array.from({ length: TOTAL }, (_, i) => listItem(i + 1));

const SUMMARY: StatsSummaryVM = {
  sections: [],
  overall: { band: null, missingSections: ["reading", "listening", "writing", "speaking"] },
  weaknesses: [],
  judgeAgreement: { avgDelta: null, sampleSize: 0 },
  skillItems: [],
  skillItemsLimit: 300,
};

function detail(id: string): AttemptDetailVM {
  return {
    attempt: {
      id,
      kind: "reading",
      mode: "drill",
      setId: "rd-1",
      setTitle: "Reading Set",
      isRepeat: false,
      status: "completed",
      startedAt: "2026-11-10T09:30:00.000Z",
      completedAt: "2026-11-10T10:00:00.000Z",
      captureFinishedAt: null,
      flagged: false,
      modulePath: null,
      routerRaw: null,
    },
    items: [],
    judgeReports: [],
    estimate: null,
    bandStatus: { status: "not-applicable", reason: "drill" },
    activeJobs: [],
  };
}

// Where each row's link sits in the window, by its href; anything else sits at 0.
let rowTop: Record<string, number> = {};
const realRect = HTMLElement.prototype.getBoundingClientRect;
let scrollTo: ReturnType<typeof vi.fn>;
const realScrollTo = window.scrollTo;

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  rowTop = {};
  mocked.getStatsSummary.mockResolvedValue(SUMMARY);
  mocked.listAttempts.mockImplementation(async (opts = {}) => {
    const offset = opts.offset ?? 0;
    return { items: LOG.slice(offset, offset + (opts.limit ?? 25)), total: TOTAL };
  });
  mocked.getAttempt.mockImplementation(async (id: string) => detail(id));
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const top = rowTop[this.getAttribute("href") ?? ""] ?? 0;
    return { top, bottom: top + 40, left: 0, right: 0, width: 0, height: 40, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  };
  scrollTo = vi.fn();
  window.scrollTo = scrollTo as unknown as typeof window.scrollTo;
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = realRect;
  window.scrollTo = realScrollTo;
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  vi.unstubAllGlobals();
});

function mount(path: string) {
  const router = createMemoryRouter(appRoutes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

function rowLinks(): string[] {
  return [...document.querySelectorAll("main li a[href^='/attempts/']")].map((a) => a.getAttribute("href")!);
}

function rowLink(id: string): HTMLElement {
  const link = document.querySelector<HTMLElement>(`main li a[href="/attempts/${id}"]`);
  if (!link) throw new Error(`no row for ${id}`);
  return link;
}

async function openReview(id: string) {
  await userEvent.click(rowLink(id));
  await screen.findByText("No Items were recorded for this Attempt.");
}

/** The review's own back link, in its page header (the nav above it has links of the same names). */
function backLink(name: string): HTMLElement {
  const links = screen.getAllByRole("link", { name }).filter((link) => !link.closest("nav"));
  expect(links).toHaveLength(1);
  return links[0];
}

/** The scroll that puts a row back where it sat: the window moved by how far the row now sits from there. */
const restoredTo = (top: number) => expect(scrollTo).toHaveBeenCalledWith({ top, behavior: "instant" });

describe("Back from an Attempt review opened from Progress", () => {
  async function progressWithSecondPage() {
    const router = mount("/progress");
    await waitFor(() => expect(rowLinks()).toHaveLength(25));
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(rowLinks()).toHaveLength(TOTAL));
    return router;
  }

  it("brings back every row it had and puts the opened row where it sat", async () => {
    const router = await progressWithSecondPage();
    // The row sits 300px down the window when it is opened.
    rowTop["/attempts/att-27"] = 300;
    await openReview("att-27");

    // Back on Progress, before any scrolling, the row lies 2900px down the page.
    rowTop["/attempts/att-27"] = 2900;
    mocked.listAttempts.mockClear();
    await act(() => router.navigate(-1));
    await waitFor(() => expect(rowLinks()).toHaveLength(TOTAL));
    // One request for all thirty rows, not the first page alone.
    expect(mocked.listAttempts).toHaveBeenCalledWith({ limit: TOTAL, offset: 0 });
    await waitFor(() => restoredTo(2600));
  });

  it("does the same through the review's own back link, which says Progress", async () => {
    await progressWithSecondPage();
    rowTop["/attempts/att-27"] = 300;
    await openReview("att-27");

    const back = backLink("Progress");
    expect(back).toHaveAttribute("href", "/progress");
    rowTop["/attempts/att-27"] = 2900;
    await userEvent.click(back);
    await waitFor(() => expect(rowLinks()).toHaveLength(TOTAL));
    await waitFor(() => restoredTo(2600));
  });

  it("lands on the list when the opened row is no longer among those loaded", async () => {
    const router = await progressWithSecondPage();
    await openReview("att-27");
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    // Meanwhile the log lost its older rows: att-27 is not listed any more.
    mocked.listAttempts.mockImplementation(async () => ({ items: LOG.slice(0, 20), total: 20 }));
    await act(() => router.navigate(-1));
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.contexts[0]).toHaveAttribute("id", "attempts");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("starts at the top, with the first page, on a fresh visit to Progress by a link", async () => {
    const router = await progressWithSecondPage();
    rowTop["/attempts/att-27"] = 300;
    await openReview("att-27");
    mocked.listAttempts.mockClear();
    await act(() => router.navigate("/progress"));
    await waitFor(() => expect(rowLinks()).toHaveLength(25));
    expect(mocked.listAttempts).toHaveBeenCalledWith({ limit: 25, offset: 0 });
    expect(scrollTo).not.toHaveBeenCalled();
  });

  // The follow that keeps the row in place while the page loads ends with the page, so it can never
  // scroll the next one (a Drill or Simulation opens each stage at the top: useStageEntry).
  it("stops keeping the row in place once the page is left", async () => {
    const observers: { grow: () => void; disconnected: boolean; target: Element | null }[] = [];
    class GrowingPage {
      disconnected = false;
      target: Element | null = null;
      readonly onResize: () => void;
      constructor(onResize: () => void) {
        this.onResize = onResize;
        observers.push(this);
      }
      grow() {
        if (!this.disconnected) this.onResize();
      }
      observe(target: Element) {
        this.target = target;
      }
      unobserve() {}
      disconnect() {
        this.disconnected = true;
      }
    }
    vi.stubGlobal("ResizeObserver", GrowingPage);
    const router = await progressWithSecondPage();
    rowTop["/attempts/att-27"] = 300;
    await openReview("att-27");
    rowTop["/attempts/att-27"] = 2900;
    await act(() => router.navigate(-1));
    await waitFor(() => restoredTo(2600));

    // The trends above the list land and push it down: the row is put back again.
    const follow = observers.filter((o) => o.target?.tagName === "MAIN").at(-1)!;
    rowTop["/attempts/att-27"] = 3400;
    follow.grow();
    restoredTo(3100);

    await act(() => router.navigate("/nope"));
    await screen.findByRole("heading", { level: 1, name: "Page not found" });
    expect(follow.disconnected).toBe(true);
    scrollTo.mockClear();
    follow.grow();
    expect(scrollTo).not.toHaveBeenCalled();
  });
});

describe("Back from an Attempt review opened from the Dashboard", () => {
  it("puts the opened Recent Attempts row where it sat, and the back link says Practice", async () => {
    const router = mount("/");
    await waitFor(() => expect(rowLinks()).toHaveLength(5));
    rowTop["/attempts/att-4"] = 420;
    await openReview("att-4");
    const back = backLink("Practice");
    expect(back).toHaveAttribute("href", "/");

    rowTop["/attempts/att-4"] = 2500;
    await act(() => router.navigate(-1));
    await waitFor(() => expect(rowLinks()).toHaveLength(5));
    await waitFor(() => restoredTo(2080));
  });

  it("opens Progress at the Attempt list from See all", async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const router = mount("/");
    await userEvent.click(await screen.findByRole("link", { name: `See all ${TOTAL} Attempts` }));
    await screen.findByRole("heading", { level: 1, name: "Progress" });
    expect(router.state.location.hash).toBe("#attempts");
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    expect(scrollIntoView.mock.contexts[0]).toHaveAttribute("id", "attempts");
    expect(screen.getByRole("heading", { name: "All Attempts" }).closest("section")).toHaveAttribute("id", "attempts");
  });
});

describe("the Attempt review's back link", () => {
  it("leads back to the Full-Test Run whose report opened it", async () => {
    const run: FullTestRunVM = {
      id: "ftr-1",
      status: "in-progress",
      currentSection: "listening",
      createdAt: "2026-11-10T09:00:00.000Z",
      completedAt: null,
      overall: { band: null, method: "mean-of-sections-v1", scoredSections: 1, pendingSections: ["listening", "writing", "speaking"] },
      sections: (["reading", "listening", "writing", "speaking"] as const).map((section, i) => ({
        section,
        order: i + 1,
        setId: `set-${section}`,
        attemptId: section === "reading" ? "att-ftr-reading" : null,
        state: section === "reading" ? "completed" : "pending",
        runnable: true,
        launchable: section === "listening",
        estimate: section === "reading" ? { section, band: 5, method: "table3-v1", raw: 0.6, coverage: [] } : null,
        modulePath: section === "reading" ? "lower" : null,
        bandStatus: section === "reading" ? { status: "estimated" } : { status: "not-finished" },
      })),
    };
    mocked.getFullTest.mockResolvedValue(run);
    mount("/full-test/ftr-1");
    await userEvent.click(await screen.findByRole("link", { name: "View this section's report" }));
    await screen.findByText("No Items were recorded for this Attempt.");
    expect(backLink("Full-Test Run")).toHaveAttribute("href", "/full-test/ftr-1");
  });

  it("says Progress on a direct visit", async () => {
    mount("/attempts/att-9");
    await screen.findByText("No Items were recorded for this Attempt.");
    expect(backLink("Progress")).toHaveAttribute("href", "/progress");
  });
});

// Which row an entry brings back is the row the User last left that entry by. Each list page is
// walked through the same trails: its own list and its back link's name.
const LIST_PAGES = [
  { page: "Progress", path: "/progress", heading: "Progress", rows: 25, back: "Progress", a: "att-5", b: "att-15" },
  { page: "the Dashboard", path: "/", heading: "Practice", rows: 5, back: "Practice", a: "att-2", b: "att-4" },
] as const;

describe.each(LIST_PAGES)("the row $page brings back", ({ path, heading, rows, back, a, b }) => {
  async function listPage() {
    const router = mount(path);
    await waitFor(() => expect(rowLinks()).toHaveLength(rows));
    return router;
  }

  /** Arrives back on the list page by `go`, its rows loaded, with no scroll asked for before it. */
  async function backOnList(go: () => Promise<unknown>) {
    scrollTo.mockClear();
    await act(go);
    await screen.findByRole("heading", { level: 1, name: heading });
    await waitFor(() => expect(rowLinks()).toHaveLength(rows));
  }

  // The back link pushes a new entry that names the one the row was opened from; a row opened from
  // the new entry is the one a Back to it brings back, not the row the back link was named after.
  it("is the row last opened from the entry a Back lands on, even one the back link pushed", async () => {
    const router = await listPage();
    rowTop[`/attempts/${a}`] = 300;
    await openReview(a);
    rowTop[`/attempts/${a}`] = 900;
    await backOnList(() => userEvent.click(backLink(back)));
    await waitFor(() => restoredTo(600));

    rowTop[`/attempts/${b}`] = 200;
    await openReview(b);
    rowTop[`/attempts/${b}`] = 1500;
    await backOnList(() => router.navigate(-1));
    await waitFor(() => restoredTo(1300));
    expect(scrollTo).not.toHaveBeenCalledWith({ top: 600, behavior: "instant" });
  });
});
