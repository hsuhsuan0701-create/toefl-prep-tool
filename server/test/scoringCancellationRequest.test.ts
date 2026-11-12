import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// requestScoringJobCancellation over a real database: the read and the guarded stamp are one
// transaction, and the answer is what the stamp actually did, never what the read before it assumed.

function harness() {
  const db = openDb(":memory:");
  const r = sqliteStores(db);
  r.createAttempt({ id: "attempt", kind: "writing", mode: "drill", setId: "set", isRepeat: false });
  r.insertItemResult({ attemptId: "attempt", itemId: "item", taskType: "email", responseText: "response" });
  r.createScoringJob({ id: "job", attemptId: "attempt", taskType: "email", itemIds: ["item"] });
  return { db, r };
}

const now = "2026-08-13 00:00:00";

describe("requestScoringJobCancellation", () => {
  it("stamps a live job and reports the request", () => {
    const { r } = harness();
    expect(r.requestScoringJobCancellation({ id: "job", reason: "user", now })).toEqual({ accepted: true, state: "cancel_requested" });
    expect(r.getScoringJob("job")).toMatchObject({ status: "queued", cancel_requested_at: now, cancellation_reason: "user" });
  });

  it("answers a repeat request without a second stamp", () => {
    const { r } = harness();
    r.requestScoringJobCancellation({ id: "job", reason: "user", now });
    expect(r.requestScoringJobCancellation({ id: "job", reason: "shutdown", now: "2026-08-13 00:00:09" })).toEqual({ accepted: true, state: "cancel_requested" });
    expect(r.getScoringJob("job")).toMatchObject({ cancel_requested_at: now, cancellation_reason: "user" });
  });

  it("refuses a finished job and an unknown one", () => {
    const { r } = harness();
    r.seedScoringJobState({ id: "job", status: "done" });
    expect(r.requestScoringJobCancellation({ id: "job", reason: "user", now })).toEqual({ accepted: false, state: "terminal" });
    expect(r.requestScoringJobCancellation({ id: "missing", reason: "user", now })).toBeUndefined();
  });

  it("reports the row as it ended up when the guarded stamp does not land", () => {
    const { db, r } = harness();
    // Stands in for a terminal write landing between the read and the stamp: the stamp's own UPDATE
    // finds the job finished and changes nothing.
    db.exec(`CREATE TEMP TRIGGER finish_first BEFORE UPDATE OF cancel_requested_at ON main.scoring_jobs
             BEGIN UPDATE scoring_jobs SET status = 'done' WHERE id = OLD.id; SELECT RAISE(IGNORE); END`);

    expect(r.requestScoringJobCancellation({ id: "job", reason: "user", now })).toEqual({ accepted: false, state: "terminal" });
    expect(r.getScoringJob("job")).toMatchObject({ status: "done", cancel_requested_at: null });
  });
});
