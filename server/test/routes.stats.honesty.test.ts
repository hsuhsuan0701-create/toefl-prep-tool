import { describe, expect, it } from "vitest";
import type { StatsSummaryVM, TrendPointVM } from "@toefl-prep/shared";
import { buildStatsRoutes } from "../src/routes/stats.js";
import { openDb } from "../src/db/db.js";
import { requiredTaskTypes } from "../src/services/bandEstimator.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { wholeSittingItems } from "./helpers/wholeSitting.js";

// GET /api/stats over a real database: the Overall headline, the window weaknesses are read from,
// and which Attempts a trend counts.

type Section = "speaking" | "writing" | "reading" | "listening";

function harness() {
  const repo = sqliteStores(openDb(":memory:"));
  const app = buildStatsRoutes({ repo });
  const summary = async () => (await (await app.request("/summary")).json()) as StatsSummaryVM;
  // A completed Simulation with one scored Item of every Task Type (for Reading and Listening, in
  // each Module of the Upper path) and its persisted band.
  function estimate(attemptId: string, section: Section, band: number) {
    repo.createAttempt({ id: attemptId, kind: section, mode: "simulation", setId: `${section}-set`, isRepeat: false });
    if (section === "reading" || section === "listening") repo.setAttemptRouting(attemptId, "upper", 0.8);
    for (const i of wholeSittingItems(section, "upper")) scored(attemptId, i.itemId, i.taskType, 1, JSON.parse(i.scoreJson));
    repo.completeAttempt(attemptId);
    repo.saveSectionEstimate({
      attemptId,
      section,
      rawDetail: JSON.stringify({ raw: 0.6, coverage: requiredTaskTypes(section, null).map((taskType) => ({ taskType, itemCount: 1 })) }),
      estimatedBand: band,
      method: section === "reading" || section === "listening" ? "table3-v1" : "linear-v2",
    });
  }
  function scored(attemptId: string, itemId: string, taskType: string, score: number, scoreJson: unknown = {}) {
    repo.insertItemResult({ attemptId, itemId, taskType });
    repo.updateItemScore({ attemptId, itemId, score, scoreJson: JSON.stringify(scoreJson), scoringStatus: "scored" });
  }
  return { repo, app, summary, estimate, scored };
}

describe("GET /summary — the Overall exists only when all four sections have a value", () => {
  it("a first run (no Attempts) has no Overall number, and says every section is missing", async () => {
    const h = harness();
    const body = await h.summary();
    expect(body.overall).toEqual({ band: null, missingSections: ["reading", "listening", "writing", "speaking"] });
  });

  it("stays absent with three of four sections, naming the one still missing", async () => {
    const h = harness();
    h.estimate("rd", "reading", 5);
    h.estimate("ls", "listening", 5.5);
    h.estimate("spk", "speaking", 4.5);
    const body = await h.summary();
    expect(body.overall.band).toBeNull();
    expect(body.overall.missingSections).toEqual(["writing"]);
  });

  it("never takes a stored Pin as a section's value", async () => {
    const h = harness();
    h.estimate("spk", "speaking", 4.5);
    h.estimate("wri", "writing", 5);
    h.repo.setSetting("pin.reading", "5");
    h.repo.setSetting("pin.listening", "6");
    expect((await h.summary()).overall).toEqual({ band: null, missingSections: ["reading", "listening"] });
  });

  it("is the mean of the four Band Estimates once they all exist", async () => {
    const h = harness();
    h.estimate("spk", "speaking", 4);
    h.estimate("wri", "writing", 5);
    h.estimate("rd", "reading", 6);
    h.estimate("ls", "listening", 6);
    // (4 + 5 + 6 + 6) / 4 = 5.25 -> 5.5
    expect((await h.summary()).overall).toEqual({ band: 5.5, missingSections: [] });
  });

  it("a section whose only estimate covers part of the section counts as missing", async () => {
    const h = harness();
    h.estimate("rd", "reading", 5);
    h.estimate("ls", "listening", 5.5);
    h.estimate("wri", "writing", 5);
    h.repo.createAttempt({ id: "partial", kind: "speaking", mode: "simulation", setId: "s", isRepeat: false });
    h.repo.saveSectionEstimate({
      attemptId: "partial", section: "speaking",
      rawDetail: JSON.stringify({ raw: 0, coverage: [{ taskType: "interview", itemCount: 3, skippedCount: 3 }] }),
      estimatedBand: 1, method: "linear-v2",
    });
    const body = await h.summary();
    expect(body.sections.find((s) => s.section === "speaking")).toBeUndefined();
    expect(body.overall).toMatchObject({ band: null, missingSections: ["speaking"] });
  });
});

describe("GET /summary — weaknesses come from judge-scored Task Types only", () => {
  it("a Reading Simulation scored after the essays does not push the essays' Deductions out of the window", async () => {
    const h = harness();
    h.repo.createAttempt({ id: "wri", kind: "writing", mode: "drill", setId: "w", isRepeat: false });
    for (let i = 0; i < 20; i++) {
      h.scored("wri", `email-${i}`, "email", 3, { deductions: [{ category: "grammar", quote: "x", issue: "y", fix: "z" }] });
    }
    h.repo.createAttempt({ id: "rd", kind: "reading", mode: "simulation", setId: "r", isRepeat: false });
    for (let i = 0; i < 50; i++) h.scored("rd", `ctw-${i}`, "complete_words", 1, { correct: true });
    h.scored("wri", "bs-1", "build_sentence", 1, { correct: true });

    expect((await h.summary()).weaknesses).toEqual([{ category: "grammar", count: 20 }]);
  });
});

describe("GET /trends — only completed Attempts are plotted", () => {
  it("leaves out an Attempt still in progress and one that was abandoned", async () => {
    const h = harness();
    for (const id of ["done", "open", "gone"]) {
      h.repo.createAttempt({ id, kind: "writing", mode: "drill", setId: "w", isRepeat: false });
      h.scored(id, "email-1", "email", 4);
    }
    h.repo.completeAttempt("done");
    h.repo.abortAttempt("gone");

    const points = (await (await h.app.request("/trends?taskType=email")).json()) as TrendPointVM[];
    expect(points.map((p) => p.attemptId)).toEqual(["done"]);
  });
});
