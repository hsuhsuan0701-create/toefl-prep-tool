import { describe, expect, it } from "vitest";
import type { StatsSummaryVM } from "@toefl-prep/shared";
import { buildStatsRoutes } from "../src/routes/stats.js";
import { openDb } from "../src/db/db.js";
import { requiredTaskTypes } from "../src/services/bandEstimator.js";
import { sqliteTimestamp } from "../src/db/timestamps.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { wholeSittingItems } from "./helpers/wholeSitting.js";

// The spread of a section's recent Simulation bands, beside its headline: the min and max of the
// last three non-Repeat Simulations whose band covers every Task Type. One Simulation is a noisy
// sample; the range says how much the headline moves from sitting to sitting.

type Section = "speaking" | "writing" | "reading" | "listening";

function harness() {
  const repo = sqliteStores(openDb(":memory:"));
  const app = buildStatsRoutes({ repo });
  let minute = 0;
  function sitting(id: string, section: Section, band: number, opts: { mode?: string; repeat?: boolean; partial?: boolean } = {}) {
    repo.createAttempt({ id, kind: section, mode: opts.mode ?? "simulation", setId: `${section}-${id}`, isRepeat: opts.repeat ?? false });
    if (section === "reading" || section === "listening") repo.setAttemptRouting(id, "upper", 0.8);
    for (const { itemId, taskType, scoreJson } of wholeSittingItems(section, "upper")) {
      repo.insertItemResult({ attemptId: id, itemId, taskType });
      repo.updateItemScore({ attemptId: id, itemId, score: 1, scoreJson, scoringStatus: "scored" });
    }
    minute += 1;
    repo.completeAttempt(id, sqliteTimestamp(new Date(Date.UTC(2026, 7, 20, 0, minute))));
    const taskTypes = requiredTaskTypes(section, null);
    const coverage = (opts.partial ? taskTypes.slice(1) : taskTypes).map((taskType) => ({ taskType, itemCount: 1 }));
    repo.saveSectionEstimate({
      attemptId: id,
      section,
      rawDetail: JSON.stringify({ raw: 0.6, coverage }),
      estimatedBand: band,
      method: section === "reading" || section === "listening" ? "table3-v1" : "linear-v2",
    });
  }
  const sectionOf = async (section: Section) =>
    ((await (await app.request("/summary")).json()) as StatsSummaryVM).sections.find((s) => s.section === section);
  return { repo, sitting, sectionOf };
}

describe("GET /summary — recent Simulation range", () => {
  it("is the min and max of the last three full-coverage, non-Repeat Simulations", async () => {
    const h = harness();
    h.sitting("old", "reading", 3); // a fourth, older Simulation falls outside the window
    h.sitting("a", "reading", 5.5);
    h.sitting("b", "reading", 5);
    h.sitting("c", "reading", 6);
    const reading = await h.sectionOf("reading");
    expect(reading).toMatchObject({ attemptId: "c", recentSimulationRange: { min: 5, max: 6, count: 3 } });
  });

  it("skips Repeats, Drills and partial-coverage rows when choosing the three", async () => {
    const h = harness();
    h.sitting("a", "speaking", 4);
    h.sitting("b", "speaking", 4.5);
    h.sitting("partial", "speaking", 1, { partial: true });
    h.sitting("repeat", "speaking", 6, { repeat: true });
    h.sitting("drill", "speaking", 6, { mode: "drill" });
    h.sitting("c", "speaking", 3.5);
    expect((await h.sectionOf("speaking"))).toMatchObject({ recentSimulationRange: { min: 3.5, max: 4.5, count: 3 } });
  });

  it("reports how many Simulations it spans when there are fewer than three", async () => {
    const h = harness();
    h.sitting("only", "writing", 5);
    expect(await h.sectionOf("writing")).toMatchObject({ recentSimulationRange: { min: 5, max: 5, count: 1 } });
  });

  it("is absent when the headline comes from a Drill", async () => {
    const h = harness();
    h.sitting("drill", "writing", 5, { mode: "drill" });
    expect(await h.sectionOf("writing")).not.toHaveProperty("recentSimulationRange");
  });
});
