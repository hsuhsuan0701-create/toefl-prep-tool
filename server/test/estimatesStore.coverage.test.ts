import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import { createSqliteAttemptStore } from "../src/db/stores/attempts.js";
import { createSqliteEstimateStore, selectLatestEstimate } from "../src/db/stores/estimates.js";
import { sqliteTimestamp } from "../src/db/timestamps.js";
import type { Section } from "../src/services/bandEstimator.js";
import { readPersistedEstimate } from "../src/services/sectionEstimates.js";
import { wholeSittingItems } from "./helpers/wholeSitting.js";

// The Band Estimate store over SQLite, for the coverage rule: a band needs every Task Type its
// section needs scored at least once. A database can hold rows written without that rule (the
// fixtures below reproduce two real ones: a Speaking 1.0 from three skipped Interviews and a
// Speaking 4.0 from Listen and Repeat alone), and the headline read steps past them.

function harness() {
  const db = openDb(":memory:");
  const attempts = createSqliteAttemptStore(db);
  const estimates = createSqliteEstimateStore(db);
  let clock = 0;
  // A completed Attempt with one scored Item of every Task Type, so whether its row is a band turns
  // on the row's stored coverage alone.
  function attempt(id: string, kind: string, mode = "simulation", opts: { repeat?: boolean; modulePath?: "lower" | "upper" } = {}) {
    attempts.createAttempt({ id, kind, mode, setId: `${kind}-set`, isRepeat: opts.repeat ?? false });
    if (opts.modulePath) attempts.setAttemptRouting(id, opts.modulePath, 0.7);
    for (const { itemId, taskType, scoreJson } of wholeSittingItems(kind as Section, opts.modulePath ?? "upper")) {
      attempts.insertItemResult({ attemptId: id, itemId, taskType });
      attempts.updateItemScore({ attemptId: id, itemId, score: 1, scoreJson, scoringStatus: "scored" });
    }
    clock += 1;
    // Each Attempt completes one minute after the previous, so "latest" is creation order.
    attempts.completeAttempt(id, sqliteTimestamp(new Date(Date.UTC(2026, 7, 20, 0, clock))));
  }
  function estimate(attemptId: string, section: string, band: number, coverage: { taskType: string; itemCount: number }[], method = "linear-v2") {
    estimates.saveSectionEstimate({ attemptId, section, rawDetail: JSON.stringify({ raw: 0.5, coverage }), estimatedBand: band, method });
  }
  return { db, attempts, estimates, attempt, estimate };
}

const SPEAKING_FULL = [{ taskType: "listen_repeat", itemCount: 7 }, { taskType: "interview", itemCount: 4 }];
const READING_FULL = [
  { taskType: "complete_words", itemCount: 30 },
  { taskType: "daily_life", itemCount: 10 },
  { taskType: "academic_passage", itemCount: 10 },
];

describe("selectLatestEstimate skips rows whose stored coverage is short", () => {
  it("the latest Simulation with full coverage is the headline, not a later one built from part of the section", () => {
    const h = harness();
    h.attempt("att-whole-section", "speaking");
    h.estimate("att-whole-section", "speaking", 4.5, SPEAKING_FULL);
    h.attempt("att-interview-only", "speaking");
    h.estimate("att-interview-only", "speaking", 1, [{ taskType: "interview", itemCount: 3 }]);
    h.attempt("att-listen-repeat-only", "speaking");
    h.estimate("att-listen-repeat-only", "speaking", 4, [{ taskType: "listen_repeat", itemCount: 7 }]);

    expect(selectLatestEstimate(h.db, "speaking")).toMatchObject({ attemptId: "att-whole-section", estimatedBand: 4.5 });
  });

  it("a partial Simulation yields the headline to a full-coverage Drill", () => {
    const h = harness();
    h.attempt("drill", "speaking", "drill");
    h.estimate("drill", "speaking", 4, SPEAKING_FULL);
    h.attempt("sim-partial", "speaking");
    h.estimate("sim-partial", "speaking", 1, [{ taskType: "interview", itemCount: 3 }]);

    expect(selectLatestEstimate(h.db, "speaking")?.attemptId).toBe("drill");
  });

  it("no full-coverage row at all means no headline", () => {
    const h = harness();
    h.attempt("partial", "writing", "drill");
    h.estimate("partial", "writing", 6, [{ taskType: "email", itemCount: 1 }], "linear-v1");
    h.attempt("no-coverage", "writing");
    h.estimate("no-coverage", "writing", 4, []);

    expect(selectLatestEstimate(h.db, "writing")).toBeUndefined();
  });

  it("corrupt raw_detail is skipped, never thrown", () => {
    const h = harness();
    h.attempt("ok", "writing");
    h.estimate("ok", "writing", 5, [
      { taskType: "build_sentence", itemCount: 10 },
      { taskType: "email", itemCount: 1 },
      { taskType: "discussion", itemCount: 1 },
    ]);
    h.attempt("corrupt", "writing");
    h.estimates.saveSectionEstimate({ attemptId: "corrupt", section: "writing", rawDetail: "{not json", estimatedBand: 6, method: "linear-v2" });

    expect(selectLatestEstimate(h.db, "writing")?.attemptId).toBe("ok");
  });

  it("keeps the repeat exclusion and the Simulation preference", () => {
    const h = harness();
    h.attempt("sim", "reading", "simulation", { modulePath: "upper" });
    h.estimate("sim", "reading", 5, READING_FULL, "table3-v1");
    h.attempt("repeat", "reading", "simulation", { repeat: true, modulePath: "upper" });
    h.estimate("repeat", "reading", 6, READING_FULL, "table3-v1");

    expect(selectLatestEstimate(h.db, "reading")).toMatchObject({ attemptId: "sim", modulePath: "upper" });
  });
});

describe("the estimate row's own lifecycle", () => {
  it("clearSectionEstimate removes the Attempt's row and nothing else", () => {
    const h = harness();
    h.attempt("a", "speaking");
    h.estimate("a", "speaking", 4, SPEAKING_FULL);
    h.attempt("b", "speaking");
    h.estimate("b", "speaking", 5, SPEAKING_FULL);

    h.estimates.clearSectionEstimate("a");

    expect(h.estimates.getSectionEstimate("a")).toBeUndefined();
    expect(h.estimates.getSectionEstimate("b")).toMatchObject({ estimatedBand: 5 });
  });

  it("getSectionEstimate carries the owning Attempt's Module Path, so the read side checks the Modules it took", () => {
    const h = harness();
    h.attempt("rd", "reading", "simulation", { modulePath: "lower" });
    h.estimate("rd", "reading", 4.5, READING_FULL, "table3-v1");

    expect(h.estimates.getSectionEstimate("rd")).toMatchObject({ modulePath: "lower" });
    expect(readPersistedEstimate(h.estimates, "rd")).toMatchObject({ band: 4.5, method: "table3-v1" });
  });
});
