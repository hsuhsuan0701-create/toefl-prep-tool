import type { ScoreStore } from "./judgeEnsemble.js";

export type ScoringPersistenceOperation =
  | { kind: "delete-judge-reports"; attemptId: string; itemId: string }
  | { kind: "insert-judge-report"; attemptId: string; itemId: string; judge: string; reportJson: string }
  | { kind: "update-item-score"; attemptId: string; itemId: string; score: number | null; scoreJson: string; scoringStatus: string };

/**
 * Wraps a ScoreStore so its three guarded writes (Judge Report delete/insert, Item score update) are
 * queued in `operations` instead of written; every other member passes through, including
 * `insertItemResult`, so an essay Response is still recorded at once. A scoring job commits the
 * queue inside the transaction that wins its terminal 'done' or 'failed', and drops it otherwise.
 */
export function createBufferedScoringPersistence(store: ScoreStore): {
  store: ScoreStore;
  operations: ScoringPersistenceOperation[];
} {
  const operations: ScoringPersistenceOperation[] = [];
  const buffered = new Proxy(store, {
    get(target, property, receiver) {
      if (property === "deleteJudgeReports") {
        return (attemptId: string, itemId: string) => operations.push({ kind: "delete-judge-reports", attemptId, itemId });
      }
      if (property === "insertJudgeReport") {
        return (input: Omit<Extract<ScoringPersistenceOperation, { kind: "insert-judge-report" }>, "kind">) =>
          operations.push({ kind: "insert-judge-report", ...input });
      }
      if (property === "updateItemScore") {
        return (input: Omit<Extract<ScoringPersistenceOperation, { kind: "update-item-score" }>, "kind">) =>
          operations.push({ kind: "update-item-score", ...input });
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return { store: buffered, operations };
}
