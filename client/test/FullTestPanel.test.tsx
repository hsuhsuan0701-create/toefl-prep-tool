import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { FullTestOverallVM, FullTestRunVM } from "@toefl-prep/shared";
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

function renderPanel(runs: FullTestRunVM[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (!url.includes("/api/full-tests")) throw new Error(`unhandled fetch in test: ${url}`);
      return Promise.resolve(
        new Response(JSON.stringify(runs), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    }) as unknown as typeof fetch,
  );
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
        const body = url.includes("status=in-progress") ? [unfinished] : recent;
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
