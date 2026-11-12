import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import { createSqliteAttemptStore } from "../src/db/stores/attempts.js";
import { createSqliteEstimateStore } from "../src/db/stores/estimates.js";
import { at } from "./helpers/timestamps.js";

// A section's headline Band Estimate, and the recent Simulation bands shown beside it, come only
// from a completed Attempt. Completion is what persists an estimate, so a row on any other Attempt
// is stale (written by an older build, or by a write the Attempt's own state does not support) and
// is stepped over rather than shown.

const WRITING_DETAIL = JSON.stringify({
  raw: 0.6,
  coverage: [{ taskType: "build_sentence", itemCount: 10 }, { taskType: "email", itemCount: 1 }, { taskType: "discussion", itemCount: 1 }],
});

function stores() {
  const db = openDb(":memory:");
  const attempts = createSqliteAttemptStore(db);
  const estimates = createSqliteEstimateStore(db);
  function attemptWithBand(id: string, band: number, completedAt: string, finish: "complete" | "abort" | "leave") {
    attempts.createAttempt({ id, kind: "writing", mode: "simulation", setId: `wri-${id}`, isRepeat: false });
    for (const [itemId, taskType] of [["bs-1", "build_sentence"], ["email-1", "email"], ["disc-1", "discussion"]]) {
      attempts.insertItemResult({ attemptId: id, itemId, taskType });
      attempts.updateItemScore({ attemptId: id, itemId, score: 1, scoreJson: "{}", scoringStatus: "scored" });
    }
    if (finish === "complete") attempts.completeAttempt(id, at(completedAt));
    if (finish === "abort") attempts.abortAttempt(id);
    estimates.saveSectionEstimate({ attemptId: id, section: "writing", rawDetail: WRITING_DETAIL, estimatedBand: band, method: "linear-v2" });
  }
  return { estimates, attemptWithBand };
}

describe("the headline Band Estimate", () => {
  it("skips an estimate whose Attempt is still in progress or was aborted", () => {
    const s = stores();
    s.attemptWithBand("done", 4, "2026-08-01 00:00:00", "complete");
    s.attemptWithBand("open", 6, "", "leave");
    s.attemptWithBand("discarded", 5.5, "", "abort");

    expect(s.estimates.getLatestEstimates().writing).toMatchObject({ attemptId: "done", estimatedBand: 4 });
    expect(s.estimates.recentSimulationBands("writing", 3)).toEqual([4]);
  });

  it("is absent when the only estimate belongs to an Attempt that is not completed", () => {
    const s = stores();
    s.attemptWithBand("open", 6, "", "leave");

    expect(s.estimates.getLatestEstimates().writing).toBeUndefined();
    expect(s.estimates.recentSimulationBands("writing", 3)).toEqual([]);
  });
});
