import { describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/db.js";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { createSpeakingCoordinators, createSpeakingFinalization } from "../src/services/speakingFinalization.js";
import { readBankSet } from "./helpers/setFixtures.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// The end of an Attempt is one transaction (settleAttempt): the Item scores a reconcile settles, the
// completion, and the Band Estimate recomputed from the Items as they then stand. A fault in the
// last step is injected as a trigger on `section_estimates`, a real failure of the real statement,
// and nothing of the three may survive it.

const WRITING_SET_ID = "wri-77af733e";
const SPEAKING_SET_ID = "spk-e5b2b735";

function failEstimateWrites(db: Database.Database): () => void {
  for (const event of ["INSERT", "UPDATE", "DELETE"]) {
    db.exec(`CREATE TRIGGER fail_estimate_${event.toLowerCase()} BEFORE ${event} ON section_estimates
      BEGIN SELECT RAISE(ABORT, 'estimate write failed'); END`);
  }
  return () => {
    for (const event of ["insert", "update", "delete"]) db.exec(`DROP TRIGGER fail_estimate_${event}`);
  };
}

function estimateRows(db: Database.Database, attemptId: string): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM section_estimates WHERE attempt_id=?").get(attemptId) as { n: number }).n;
}

describe("POST /:id/complete settles the Attempt and its estimate together", () => {
  it("leaves the Attempt in progress, without an estimate, when the estimate write fails", async () => {
    const db = openDb(":memory:");
    const repo = sqliteStores(db);
    const scoreDeps = { repo, judgeEssay: vi.fn(), aggregate: vi.fn(), judgeSpeaking: vi.fn(), aggregateSpeaking: vi.fn() };
    const app = buildAttemptsRoutes({ ...scoreDeps, ...createSpeakingCoordinators({ ...scoreDeps, hearRecording: vi.fn() }) });
    repo.createAttempt({ id: "writing-sim", kind: "writing", mode: "simulation", setId: WRITING_SET_ID, isRepeat: false });
    for (const [itemId, taskType, score] of [["bas-1", "build_sentence", 1], ["email-x", "email", 4], ["disc-x", "discussion", 4]] as const) {
      repo.insertItemResult({ attemptId: "writing-sim", itemId, taskType, responseText: "[]" });
      repo.updateItemScore({ attemptId: "writing-sim", itemId, score, scoreJson: "{}", scoringStatus: "scored" });
    }

    const allowEstimateWrites = failEstimateWrites(db);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failed = await app.request("/writing-sim/complete", { method: "POST" });
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "internal error" });
    } finally {
      errors.mockRestore();
    }
    expect(repo.getAttempt("writing-sim")).toMatchObject({ status: "in_progress", completed_at: null });
    expect(estimateRows(db, "writing-sim")).toBe(0);

    // The same request once the write can land: nothing was half-done, so it completes normally.
    allowEstimateWrites();
    const res = await app.request("/writing-sim/complete", { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "completed", estimate: { section: "writing" } });
    expect(repo.getAttempt("writing-sim")?.status).toBe("completed");
    expect(estimateRows(db, "writing-sim")).toBe(1);
  });
});

describe("reconcileAttempt settles the heal, the completion and the estimate together", () => {
  const speakingSet = readBankSet("speaking", SPEAKING_SET_ID);
  const itemIds = [
    ...speakingSet.listenAndRepeat.items.map((item) => ({ itemId: item.id, taskType: "listen_repeat" as const })),
    ...speakingSet.interview.questions.map((question) => ({ itemId: question.id, taskType: "interview" as const })),
  ];

  it("rolls back the orphan heal and the completion when the estimate write fails", async () => {
    const db = openDb(":memory:");
    const repo = sqliteStores(db);
    let now = new Date("2026-11-01T10:00:00Z");
    const finalization = createSpeakingFinalization({ repo, now: () => now });
    repo.createAttempt({ id: "speaking-sim", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    const [orphan, ...answered] = itemIds;
    for (const { itemId, taskType } of answered) {
      repo.insertItemResult({ attemptId: "speaking-sim", itemId, taskType, responseAudioPath: `audio/responses/speaking-sim/${itemId}.webm`, transcript: "an answer" });
      repo.updateItemScore({ attemptId: "speaking-sim", itemId, score: 4, scoreJson: "{}", scoringStatus: "scored" });
    }
    // Transcribed, never covered by a scoring job: the heal fails it once the grace margin has passed.
    repo.insertItemResult({ attemptId: "speaking-sim", itemId: orphan!.itemId, taskType: orphan!.taskType, responseAudioPath: "audio/responses/speaking-sim/orphan.webm", transcript: "an answer" });
    await finalization.markCaptureFinished("speaking-sim");
    // A band an earlier state of the Attempt had, which the heal now makes stale.
    repo.saveSectionEstimate({ attemptId: "speaking-sim", section: "speaking", rawDetail: "{}", estimatedBand: 4, method: "linear-v2" });
    now = new Date("2026-11-01T10:05:00Z");

    const allowEstimateWrites = failEstimateWrites(db);
    await expect(finalization.reconcileAttempt("speaking-sim")).rejects.toThrow(/estimate write failed/);

    const afterFault = repo.getAttempt("speaking-sim")!;
    expect(afterFault).toMatchObject({ status: "in_progress", completed_at: null });
    expect(afterFault.items.find((item) => item.item_id === orphan!.itemId)?.scoring_status).toBe("pending");
    expect(estimateRows(db, "speaking-sim")).toBe(1);

    allowEstimateWrites();
    await finalization.reconcileAttempt("speaking-sim");

    const settled = repo.getAttempt("speaking-sim")!;
    expect(settled).toMatchObject({ status: "completed", completed_at: "2026-11-01 10:05:00" });
    expect(settled.items.find((item) => item.item_id === orphan!.itemId)?.scoring_status).toBe("failed");
    expect(estimateRows(db, "speaking-sim")).toBe(0);
  });
});

describe("settleAttempt", () => {
  it("leaves an aborted Attempt untouched: no Item score, no completion, no estimate", () => {
    const repo = sqliteStores(openDb(":memory:"));
    repo.createAttempt({ id: "gone", kind: "writing", mode: "drill", setId: WRITING_SET_ID, isRepeat: false });
    repo.insertItemResult({ attemptId: "gone", itemId: "bas-1", taskType: "build_sentence", responseText: "[]" });
    repo.abortAttempt("gone");

    expect(repo.settleAttempt({
      attemptId: "gone",
      itemScores: [{ itemId: "bas-1", score: 1, scoreJson: "{}", scoringStatus: "scored" }],
    })).toBeUndefined();
    expect(repo.getAttempt("gone")).toMatchObject({ status: "aborted", completed_at: null });
    expect(repo.getAttempt("gone")!.items[0]).toMatchObject({ scoring_status: "pending", score: null });
    expect(repo.settleAttempt({ attemptId: "never-created" })).toBeUndefined();
  });

  it("says whether this call completed the Attempt, and recomputes the estimate of one completed earlier", () => {
    const repo = sqliteStores(openDb(":memory:"));
    repo.createAttempt({ id: "w", kind: "writing", mode: "simulation", setId: WRITING_SET_ID, isRepeat: false });
    for (const [itemId, taskType] of [["bas-1", "build_sentence"], ["email-x", "email"], ["disc-x", "discussion"]] as const) {
      repo.insertItemResult({ attemptId: "w", itemId, taskType, responseText: "[]" });
    }

    // Two Items unscored: completed, and no band.
    expect(repo.settleAttempt({
      attemptId: "w",
      itemScores: [{ itemId: "bas-1", score: 1, scoreJson: "{}", scoringStatus: "scored" }],
    })).toEqual({ completedNow: true, estimate: null });

    // A later settle of the rest is not a completion, and it is what gives the Attempt its band.
    const later = repo.settleAttempt({
      attemptId: "w",
      itemScores: [
        { itemId: "email-x", score: 4, scoreJson: "{}", scoringStatus: "scored" },
        { itemId: "disc-x", score: 4, scoringStatus: "scored", scoreJson: "{}" },
      ],
    });
    expect(later?.completedNow).toBe(false);
    expect(later?.estimate).toMatchObject({ section: "writing" });
  });
});
