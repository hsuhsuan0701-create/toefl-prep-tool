import { describe, expect, it, vi } from "vitest";
import { createBufferedScoringPersistence } from "../src/services/scoringPersistence.js";
import type { ScoreStore } from "../src/services/judgeEnsemble.js";

describe("buffered scoring persistence", () => {
  it("buffers score and Judge Report mutations until the caller commits them", () => {
    // Typed against ScoreStore (`satisfies`), the narrow port the buffer is written against, so the
    // fake cannot drift from it. Only call counts matter here: nothing reaches the underlying store.
    const underlying = {
      getAttempt: vi.fn(() => undefined),
      insertItemResult: vi.fn(),
      updateItemScore: vi.fn(),
      deleteJudgeReports: vi.fn(),
      insertJudgeReport: vi.fn(),
      getScoringJob: vi.fn(() => ({ status: "running" })),
      getJudgeReports: vi.fn(() => []),
    } satisfies ScoreStore;
    const buffered = createBufferedScoringPersistence(underlying);

    buffered.store.deleteJudgeReports("attempt", "item");
    buffered.store.insertJudgeReport({ attemptId: "attempt", itemId: "item", judge: "gemini", reportJson: "{}" });
    buffered.store.updateItemScore({ attemptId: "attempt", itemId: "item", score: 4, scoreJson: "{}", scoringStatus: "scored" });

    expect(underlying.deleteJudgeReports).not.toHaveBeenCalled();
    expect(underlying.insertJudgeReport).not.toHaveBeenCalled();
    expect(underlying.updateItemScore).not.toHaveBeenCalled();
    expect(buffered.operations).toEqual([
      { kind: "delete-judge-reports", attemptId: "attempt", itemId: "item" },
      { kind: "insert-judge-report", attemptId: "attempt", itemId: "item", judge: "gemini", reportJson: "{}" },
      { kind: "update-item-score", attemptId: "attempt", itemId: "item", score: 4, scoreJson: "{}", scoringStatus: "scored" },
    ]);
  });
});
