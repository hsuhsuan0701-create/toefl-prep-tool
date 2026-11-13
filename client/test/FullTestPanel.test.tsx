import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { FullTestOverallVM, FullTestRunVM, FullTestSectionVM } from "@toefl-prep/shared";
import FullTestPanel from "../src/components/FullTestPanel";

// The practice page's Full-Test panel is the only way back to a Full-Test Run once the User has left
// its page, because the Run page carries no nav bar. It has to list a half-sat Run to resume and a
// finished Run's report, or the sitting's Overall band is unreachable once the page is closed.

function overall(over: Partial<FullTestOverallVM> = {}): FullTestOverallVM {
  return { band: null, method: "mean-of-sections-v1", scoredSections: 0, pendingSections: [], ...over };
}

function run(over: Partial<FullTestRunVM> & Pick<FullTestRunVM, "id" | "status">): FullTestRunVM {
  return {
    currentSection: over.status === "in-progress" ? "listening" : null,
    createdAt: "2026-08-23T02:00:00.000Z",
    completedAt: over.status === "completed" ? "2026-08-23T03:30:00.000Z" : null,
    sections: [],
    overall: overall(),
    ...over,
  };
}

// GET /api/full-tests as the route answers it: `runs` newest first, filtered by `status` and cut to
// `limit` when the request names them.
function stubListing(runs: FullTestRunVM[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
      if (url.pathname !== "/api/full-tests") throw new Error(`unhandled fetch in test: ${url.toString()}`);
      const status = url.searchParams.get("status");
      const limit = url.searchParams.get("limit");
      const matching = runs.filter((r) => status === null || r.status === status);
      const page = limit === null ? matching : matching.slice(0, Number(limit));
      return Promise.resolve(
        new Response(JSON.stringify(page), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    }) as unknown as typeof fetch,
  );
}

function renderPanel(runs: FullTestRunVM[]) {
  stubListing(runs);
  render(
    <MemoryRouter>
      <FullTestPanel />
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("the practice page's full-test panel", () => {
  it("offers a finished sitting's report, with the whole-test band it produced", async () => {
    renderPanel([
      run({ id: "run-done", status: "completed", overall: overall({ band: 5, scoredSections: 4 }) }),
    ]);

    const entry = (await screen.findAllByRole("listitem"))[0];
    // The whole-test band, pencilled as the estimate it is, with its CEFR level.
    expect(within(entry).getByText("5")).toBeInTheDocument();
    expect(within(entry).getByText("estimate")).toBeInTheDocument();
    expect(within(entry).getByTestId("cefr-level")).toHaveTextContent("C1");
    expect(within(entry).getByRole("link", { name: "View report" })).toHaveAttribute("href", "/full-test/run-done");
  });

  // Never a partial mean, here either: the index entry reports how much of the sitting is scored.
  it("says how far a still-scoring sitting has got, rather than showing a band it does not have", async () => {
    renderPanel([
      run({
        id: "run-scoring",
        status: "completed",
        overall: overall({ band: null, scoredSections: 3, pendingSections: ["speaking"] }),
      }),
    ]);

    const entry = (await screen.findAllByRole("listitem"))[0];
    expect(within(entry).getByText("3 of 4 sections have a band")).toBeInTheDocument();
    expect(within(entry).queryByText("estimate")).toBeNull();
    expect(within(entry).queryByTestId("cefr-level")).toBeNull();
    expect(within(entry).getByRole("link", { name: "View report" })).toBeInTheDocument();
  });

  it("still offers to resume an unfinished sitting", async () => {
    renderPanel([run({ id: "run-open", status: "in-progress" })]);
    expect(await screen.findByRole("link", { name: "Resume" })).toHaveAttribute("href", "/full-test/run-open");
    expect(screen.queryByRole("link", { name: "View report" })).toBeNull();
  });
});

describe("an unfinished sitting is never pushed off the panel", () => {
  it("lists an in-progress Run even when more than three newer Runs have finished since", async () => {
    const recent = [1, 2, 3].map((i) => run({ id: `run-new-${i}`, status: "completed" }));
    const unfinished = run({ id: "run-old-open", status: "in-progress", createdAt: "2026-08-01T02:00:00.000Z" });
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const body = url.includes("status=in-progress") ? [unfinished] : url.includes("status=abandoned") ? [] : recent;
        return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
      }) as unknown as typeof fetch,
    );
    render(
      <MemoryRouter>
        <FullTestPanel />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("link", { name: "Resume" })).toHaveAttribute("href", "/full-test/run-old-open");
    expect(screen.getAllByRole("link", { name: "View report" })).toHaveLength(3);
  });
});

// "Start a Full-Test Run" creates a Run at once, so a few mis-clicks make several Runs in progress.
// Those must never push a finished sitting's report off the panel, the only place that lists Runs.
describe("a finished sitting's report stays reachable", () => {
  it("lists a completed Run with its report even when three newer Runs are in progress", async () => {
    const newer = [3, 2, 1].map((i) => run({ id: `run-open-${i}`, status: "in-progress", createdAt: `2026-08-2${4 + i}T02:00:00.000Z` }));
    renderPanel([...newer, run({ id: "run-done", status: "completed" })]);

    expect(await screen.findByRole("link", { name: "View report" })).toHaveAttribute("href", "/full-test/run-done");
    expect(screen.getAllByRole("link", { name: "Resume" })).toHaveLength(3);
  });

  it("reveals the earlier finished Runs on request, each opening its own report", async () => {
    const finished = [1, 2, 3, 4, 5].map((i) => run({ id: `run-done-${i}`, status: "completed" }));
    renderPanel(finished);

    await screen.findAllByRole("link", { name: "View report" });
    expect(screen.getAllByRole("link", { name: "View report" }).map((a) => a.getAttribute("href"))).toEqual(
      ["run-done-1", "run-done-2", "run-done-3"].map((id) => `/full-test/${id}`),
    );

    await userEvent.click(screen.getByRole("button", { name: "Show earlier finished Runs" }));

    await waitFor(() => expect(screen.getAllByRole("link", { name: "View report" })).toHaveLength(5));
    expect(screen.getAllByRole("link", { name: "View report" }).map((a) => a.getAttribute("href"))).toEqual(
      finished.map((r) => `/full-test/${r.id}`),
    );
    expect(screen.queryByRole("button", { name: "Show earlier finished Runs" })).toBeNull();
  });

  it("offers no such control when every finished Run already fits", async () => {
    renderPanel([1, 2, 3].map((i) => run({ id: `run-done-${i}`, status: "completed" })));
    expect(await screen.findAllByRole("link", { name: "View report" })).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "Show earlier finished Runs" })).toBeNull();
  });

  it("lists an abandoned Run among the finished ones, newest first, marked abandoned", async () => {
    renderPanel([
      run({ id: "run-gave-up", status: "abandoned", createdAt: "2026-08-24T02:00:00.000Z" }),
      run({ id: "run-done", status: "completed" }),
    ]);
    const links = await screen.findAllByRole("link", { name: "View report" });
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/full-test/run-gave-up", "/full-test/run-done"]);
    const rows = within(screen.getByRole("list", { name: "Finished Full-Test Runs" })).getAllByRole("listitem");
    expect(within(rows[0]).getByText("Abandoned")).toBeInTheDocument();
    expect(within(rows[1]).queryByText("Abandoned")).toBeNull();
    expect(screen.queryByRole("link", { name: "Resume" })).toBeNull();
  });
});

function sectionVM(section: FullTestSectionVM["section"], order: number, state: FullTestSectionVM["state"]): FullTestSectionVM {
  return {
    section,
    order,
    setId: `set-${section}`,
    attemptId: state === "pending" ? null : `att-${section}`,
    state,
    runnable: true,
    launchable: state === "in-progress",
    bandStatus: { status: "not-finished" },
    estimate: null,
    modulePath: null,
  };
}

// A Run started by mistake goes away from the panel, behind a confirmation that says what it costs.
// Starting stays one press because of it.
describe("abandoning a Run in progress from the panel", () => {
  it("asks first, changes nothing on Cancel, and lists the Run as abandoned once confirmed", async () => {
    const sections = [
      sectionVM("reading", 1, "completed"),
      sectionVM("listening", 2, "in-progress"),
      sectionVM("writing", 3, "pending"),
      sectionVM("speaking", 4, "pending"),
    ];
    let current = run({ id: "run-open", status: "in-progress", sections, overall: overall({ scoredSections: 1 }) });
    const posts: string[] = [];
    const json = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
        if (init?.method === "POST") {
          posts.push(url.pathname);
          if (url.pathname !== "/api/full-tests/run-open/abandon") throw new Error(`unhandled POST in test: ${url.pathname}`);
          current = {
            ...current,
            status: "abandoned",
            currentSection: null,
            sections: sections.map((s) => (s.state === "in-progress" ? { ...s, state: "aborted" as const, launchable: false } : s)),
          };
          return json(current);
        }
        if (url.pathname !== "/api/full-tests") throw new Error(`unhandled fetch in test: ${url.toString()}`);
        return json(url.searchParams.get("status") === current.status ? [current] : []);
      }) as unknown as typeof fetch,
    );
    render(
      <MemoryRouter>
        <FullTestPanel />
      </MemoryRouter>,
    );

    await userEvent.click(await screen.findByRole("button", { name: "Abandon Run…" }));
    const dialog = screen.getByRole("dialog", { name: "Abandon this Full-Test Run?" });
    expect(dialog).toHaveTextContent("The Run ends here, without an Overall band");
    expect(dialog).toHaveTextContent("The section you finished keeps its Attempt and its band.");
    expect(dialog).toHaveTextContent("The Listening section you left part-way is discarded.");

    await userEvent.click(within(dialog).getByRole("button", { name: "Keep the Run" }));
    expect(posts).toEqual([]);
    expect(screen.getByRole("link", { name: "Resume" })).toHaveAttribute("href", "/full-test/run-open");

    await userEvent.click(screen.getByRole("button", { name: "Abandon Run…" }));
    await userEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Abandon Run" }));

    expect(posts).toEqual(["/api/full-tests/run-open/abandon"]);
    expect(await screen.findByRole("link", { name: "View report" })).toHaveAttribute("href", "/full-test/run-open");
    expect(within(screen.getByRole("list", { name: "Finished Full-Test Runs" })).getByText("Abandoned")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Resume" })).toBeNull();
    expect(screen.getByText("1 of 4 sections have a band")).toBeInTheDocument();
  });
});
