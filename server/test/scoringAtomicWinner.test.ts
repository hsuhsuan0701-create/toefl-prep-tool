import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

describe("atomic scoring completion", () => {
  it("writes no score or Judge Reports when cancellation already won", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "attempt", kind: "writing", mode: "drill", setId: "set", isRepeat: false });
    r.insertItemResult({ attemptId: "attempt", itemId: "item", taskType: "email", responseText: "response" });
    r.createScoringJob({ id: "job", attemptId: "attempt", taskType: "email", itemIds: ["item"] });
    r.requestScoringJobCancellation({ id: "job", reason: "user", now: "2026-08-13 00:00:00" });

    expect(r.completeScoringJobAtomically({
      id: "job",
      result: "{}",
      now: "2026-08-13 00:00:01",
      operations: [
        { kind: "insert-judge-report", attemptId: "attempt", itemId: "item", judge: "gemini", reportJson: "{}" },
        { kind: "update-item-score", attemptId: "attempt", itemId: "item", score: 5, scoreJson: "{}", scoringStatus: "scored" },
      ],
    })).toBe(false);
    expect(r.getJudgeReports("attempt")).toEqual([]);
    expect(r.getAttempt("attempt")?.items[0]).toMatchObject({ score: null, scoring_status: "pending" });
  });
});
