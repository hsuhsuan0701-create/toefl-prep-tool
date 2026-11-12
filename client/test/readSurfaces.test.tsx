import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { AttemptListItemVM, AttemptListVM, SetListEntryVM } from "@toefl-prep/shared";
import Sets from "../src/pages/Sets";
import Progress from "../src/pages/Progress";
import AttemptsFeed from "../src/components/AttemptsFeed";
import SetSection from "../src/components/SetSection";
import { pickSimulationSet } from "../src/pages/simulation/simulationShell";

// What the User reads on the list surfaces: which Sets exist and whether they have been practised
// (from the Set listing's own `attempted`, never from a page of the Attempt log), what each Set is
// called, and the whole Attempt log with its true size.

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function stubFetch(routes: [string, Handler][]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const route = routes.find(([pattern]) => url.includes(pattern));
    if (!route) throw new Error(`unhandled fetch in test: ${url}`);
    return Promise.resolve(route[1](url, init));
  });
  vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function entry(over: Partial<SetListEntryVM> & Pick<SetListEntryVM, "id">): SetListEntryVM {
  return {
    kind: "writing",
    source: "generated",
    createdAt: "2026-08-01T00:00:00.000Z",
    title: `Title of ${over.id}`,
    summary: null,
    attempted: false,
    ...over,
  };
}

function attempt(over: Partial<AttemptListItemVM> & Pick<AttemptListItemVM, "id">): AttemptListItemVM {
  return {
    kind: "writing",
    mode: "drill",
    setId: "wri-1",
    setTitle: "Order #4127 - damaged panel",
    isRepeat: false,
    status: "completed",
    startedAt: "2026-08-01T10:00:00.000Z",
    completedAt: "2026-08-01T10:20:00.000Z",
    captureFinishedAt: null,
    flagged: false,
    estimate: null,
    fullTestRun: null,
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("/sets — every Set by its title, attempted read off the listing", () => {
  function stubBank(writing: SetListEntryVM[]) {
    return stubFetch([
      ["/api/sets/unloadable", () => json({ count: 0, failures: [] })],
      ["/api/sets?kind=writing", () => json(writing)],
      ["/api/sets?kind=", () => json([])],
    ]);
  }

  it("labels each Set by its title with the id beside it, and reads attempted off the listing", async () => {
    const calls = stubBank([
      entry({ id: "wri-787b9d66", title: "Order #4127 - damaged panel", summary: "Academic Discussion · Urban Studies 210", attempted: true }),
      entry({ id: "wri-5c3e81b2", title: "Booking page will not load" }),
    ]);
    render(<MemoryRouter><Sets /></MemoryRouter>);

    const titled = await screen.findByRole("link", { name: "Order #4127 - damaged panel" });
    expect(titled).toHaveAttribute("href", "/writing/wri-787b9d66");
    const row = titled.closest("li")!;
    expect(within(row).getByText(/wri-787b9d66/)).toBeInTheDocument();
    expect(within(row).getByText("Academic Discussion · Urban Studies 210")).toBeInTheDocument();
    expect(within(row).getByText("Attempted")).toBeInTheDocument();

    const fresh = screen.getByRole("link", { name: "Booking page will not load" }).closest("li")!;
    expect(within(fresh).getByText("New")).toBeInTheDocument();

    // The bank page never needs the Attempt log to know what has been practised.
    expect(calls.some((c) => c.url.includes("/api/attempts"))).toBe(false);
  });

  it("hides attempted Sets by the listing's own flag", async () => {
    stubBank([entry({ id: "wri-done", attempted: true }), entry({ id: "wri-new" })]);
    render(<MemoryRouter><Sets /></MemoryRouter>);
    await screen.findByRole("link", { name: "Title of wri-done" });

    await userEvent.click(screen.getAllByRole("checkbox", { name: "Hide attempted" })[0]);
    expect(screen.queryByRole("link", { name: "Title of wri-done" })).toBeNull();
    expect(screen.getByRole("link", { name: "Title of wri-new" })).toBeInTheDocument();
  });
});

describe("SetSection — a failed load never reads as data", () => {
  it("still says the load failed while showing Sets loaded earlier", () => {
    render(
      <MemoryRouter>
        <SetSection
          title="Writing sets"
          linkBase="/writing"
          simulateHref="/simulate/writing"
          sets={[entry({ id: "wri-1" })]}
          error="Can't reach the server. Is it running?"
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("Couldn't refresh this list")).toBeInTheDocument();
    expect(screen.getByText(/Can't reach the server\. Is it running\?/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Title of wri-1" })).toBeInTheDocument();
  });
});

describe("the Simulation picker", () => {
  it("chooses the first unattempted Set by the listing's flag, without reading the Attempt log", async () => {
    const calls = stubFetch([
      ["/api/sets?kind=writing", () => json([
        entry({ id: "wri-newest", attempted: true }),
        entry({ id: "wri-unseen" }),
        entry({ id: "wri-older-unseen" }),
      ])],
    ]);
    await expect(pickSimulationSet("writing")).resolves.toMatchObject({ id: "wri-unseen" });
    expect(calls.map((c) => c.url)).toEqual(["/api/sets?kind=writing"]);
  });

  it("falls back to the newest Set once every Set has been attempted", async () => {
    stubFetch([["/api/sets?kind=writing", () => json([entry({ id: "wri-a", attempted: true }), entry({ id: "wri-b", attempted: true })])]]);
    await expect(pickSimulationSet("writing")).resolves.toMatchObject({ id: "wri-a" });
  });
});

describe("the Attempt log", () => {
  it("names each Attempt by its Set's title, and the home feed states the true total", () => {
    const page: AttemptListVM = {
      items: Array.from({ length: 5 }, (_, i) => attempt({ id: `att-${i}` })),
      total: 56,
    };
    render(<MemoryRouter><AttemptsFeed attempts={page} onChanged={() => {}} limit={5} seeAllHref="/progress" /></MemoryRouter>);
    expect(screen.getAllByText("Order #4127 - damaged panel")).toHaveLength(5);
    expect(screen.getByRole("link", { name: "See all 56 Attempts" })).toHaveAttribute("href", "/progress");
  });

  it("falls back to the Set id for an Attempt whose Set can no longer be read", () => {
    render(
      <MemoryRouter>
        <AttemptsFeed attempts={{ items: [attempt({ id: "a", setId: "wri-gone", setTitle: null })], total: 1 }} onChanged={() => {}} />
      </MemoryRouter>,
    );
    expect(screen.getByText("wri-gone")).toBeInTheDocument();
  });

  it("/progress shows every Attempt, a page at a time", async () => {
    const all = Array.from({ length: 56 }, (_, i) => attempt({ id: `att-${String(i).padStart(2, "0")}`, setTitle: `Set ${i}` }));
    stubFetch([
      ["/api/attempts?", (url) => {
        const params = new URL(url, "http://localhost").searchParams;
        const limit = Number(params.get("limit"));
        const offset = Number(params.get("offset") ?? 0);
        return json({ items: all.slice(offset, offset + limit), total: all.length });
      }],
      ["/api/stats/summary", () => json({ sections: [], overall: { band: 5, missingSections: [] }, weaknesses: [], judgeAgreement: { avgDelta: null, sampleSize: 0 }, skillItems: [], skillItemsLimit: 300 })],
      ["/api/stats/trends", () => json([])],
    ]);
    render(<MemoryRouter><Progress /></MemoryRouter>);

    expect(await screen.findByText("Showing 25 of 56 Attempts")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("Showing 50 of 56 Attempts")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Load more" }));
    expect(await screen.findByText("All 56 Attempts")).toBeInTheDocument();
    expect(screen.getByText("Set 55")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("/progress says the breakdown failed to load instead of showing an empty breakdown", async () => {
    stubFetch([
      ["/api/attempts?", () => json({ items: [], total: 0 })],
      ["/api/stats/summary", () => new Response("", { status: 500 })],
      ["/api/stats/trends", () => json([])],
    ]);
    render(<MemoryRouter><Progress /></MemoryRouter>);
    expect(await screen.findByText(/Couldn't load the weakness breakdown/)).toBeInTheDocument();
    expect(screen.queryByText(/No deduction data yet/)).toBeNull();
  });
});

describe("unfinished Attempts — acting on one asks first", () => {
  function renderOne(over: Partial<AttemptListItemVM>) {
    const calls = stubFetch([["/api/attempts/", () => json({ status: "ok" })]]);
    const onChanged = vi.fn();
    render(
      <MemoryRouter>
        <AttemptsFeed attempts={{ items: [attempt({ id: "att-open", status: "in_progress", completedAt: null, ...over })], total: 1 }} onChanged={onChanged} />
      </MemoryRouter>,
    );
    return { calls, onChanged };
  }

  it("Discard says what it does and does nothing until confirmed", async () => {
    const { calls, onChanged } = renderOne({});
    await userEvent.click(screen.getByRole("button", { name: "Discard…" }));
    expect(calls).toHaveLength(0);
    expect(screen.getByRole("dialog", { name: "Discard this Attempt?" })).toBeInTheDocument();
    expect(screen.getByText(/never gets a Band Estimate/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(calls.map((c) => [c.url, c.init?.method])).toEqual([["/api/attempts/att-open/abort", "POST"]]);
    await vi.waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("Cancel leaves the Attempt alone", async () => {
    const { calls } = renderOne({});
    await userEvent.click(screen.getByRole("button", { name: "Discard…" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(calls).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Discard…" })).toBeInTheDocument();
  });

  it("Finish and score on a Speaking Simulation warns that unrecorded Items score 0", async () => {
    const { calls } = renderOne({ kind: "speaking", mode: "simulation" });
    await userEvent.click(screen.getByRole("button", { name: "Finish and score…" }));
    expect(screen.getByRole("dialog", { name: "Finish and score this Speaking Simulation?" })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
    expect(screen.getByText(/Items you haven't recorded will score 0/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Finish and score" }));
    expect(calls.map((c) => [c.url, c.init?.method])).toEqual([["/api/attempts/att-open/complete", "POST"]]);
  });

  it("Finish and score elsewhere says only submitted work is scored", async () => {
    renderOne({ kind: "writing", mode: "drill" });
    await userEvent.click(screen.getByRole("button", { name: "Finish and score…" }));
    expect(screen.getByText(/Only what you've already submitted is scored/)).toBeInTheDocument();
    expect(screen.queryByText(/score 0/)).toBeNull();
  });
});
