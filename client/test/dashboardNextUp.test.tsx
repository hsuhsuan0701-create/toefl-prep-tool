import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import type { AttemptListVM, SetListEntryVM } from "@toefl-prep/shared";
import * as api from "../src/lib/api";
import Dashboard from "../src/pages/Dashboard";
import { renderRoutes } from "./dataRouter";

// The Dashboard's "Next up" is what its heading says, Sets not attempted yet, and each section's
// "See all" opens that section's own tab of the Set bank.

vi.mock("../src/lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/api")>();
  return {
    ...real,
    getStatsSummary: vi.fn(async () => ({
      sections: [],
      overall: { band: null, missingSections: ["reading", "listening", "writing", "speaking"] },
      weaknesses: [],
      judgeAgreement: { avgDelta: null, sampleSize: 0 },
      skillItems: [],
      skillItemsLimit: 300,
    })),
    getStatsSettings: vi.fn(async () => ({ targets: { reading: 5.5, listening: 5.5, writing: 5.5, speaking: 5.5 } })),
    getSetupStatus: vi.fn(async () => null),
    recheckSetupStatus: vi.fn(),
    getReasoningStatus: vi.fn(async () => ({ providers: [], operationalProviders: [] })),
    listSets: vi.fn(),
    listAttempts: vi.fn(),
    listFullTests: vi.fn(async () => []),
    listActiveGeneration: vi.fn(async () => ({ active: [] })),
  };
});

const mocked = vi.mocked(api);

function writingSet(n: number, attempted: boolean): SetListEntryVM {
  return {
    id: `wri-${n}`,
    kind: "writing",
    source: "generated",
    createdAt: `2026-11-0${n}T00:00:00.000Z`,
    title: `Writing Set ${n}`,
    summary: null,
    attempted,
  };
}

const ONE_ATTEMPT: AttemptListVM = {
  items: [
    {
      id: "att-1",
      kind: "writing",
      mode: "simulation",
      setId: "wri-1",
      setTitle: "Writing Set 1",
      isRepeat: false,
      status: "completed",
      startedAt: "2026-11-10T09:30:00.000Z",
      completedAt: "2026-11-10T10:00:00.000Z",
      captureFinishedAt: null,
      flagged: false,
      estimate: null,
      missingBand: null,
      fullTestRun: null,
    },
  ],
  total: 1,
};

describe("the Dashboard's Next up", () => {
  it("lists only Sets with no Attempt, and opens the section's own tab from See all", async () => {
    mocked.listAttempts.mockResolvedValue(ONE_ATTEMPT);
    // Newest first, as the listing serves them: two new, then three already attempted.
    mocked.listSets.mockImplementation(async (kind?: string) =>
      kind === "writing" ? [writingSet(5, false), writingSet(4, true), writingSet(3, false), writingSet(2, true), writingSet(1, true)] : [],
    );
    renderRoutes([{ path: "/", element: <Dashboard /> }], "/");

    const list = await screen.findByRole("list", { name: "Writing Sets" });
    const titles = within(list)
      .getAllByRole("link")
      .map((a) => a.textContent ?? "");
    expect(titles.some((t) => t.includes("Writing Set 5"))).toBe(true);
    expect(titles.some((t) => t.includes("Writing Set 3"))).toBe(true);
    expect(titles.some((t) => /Writing Set [124]/.test(t))).toBe(false);
    expect(within(list).queryByText("Attempted")).toBeNull();

    expect(screen.getByRole("link", { name: "See all 5 Writing Sets" })).toHaveAttribute("href", "/sets?section=writing");
  });

  it("says so when every Set of a section has been attempted", async () => {
    mocked.listAttempts.mockResolvedValue(ONE_ATTEMPT);
    mocked.listSets.mockImplementation(async (kind?: string) => (kind === "writing" ? [writingSet(2, true), writingSet(1, true)] : []));
    renderRoutes([{ path: "/", element: <Dashboard /> }], "/");

    expect(await screen.findByText("Nothing new in Writing Sets")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "See all 2 Writing Sets" })).toHaveAttribute("href", "/sets?section=writing");
  });
});
