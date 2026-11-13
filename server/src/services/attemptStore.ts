import type { SectionEstimateVM } from "@toefl-prep/shared";
import type { AttemptRow, ItemResultRow } from "../db/rows.js";
import type { SqliteTimestamp } from "../db/timestamps.js";
import type { ItemScoreWrite } from "./judgeEnsemble.js";

// The persistence ports of the `attempts` aggregate: the Attempt lifecycle, declared as the members
// production uses rather than as the whole repo. One adapter satisfies every type below:
// db/stores/attempts.ts over SQLite, which the tests use too. The port has its own module because
// the Attempt has several owners: the routes create, complete, flag and route it,
// speakingFinalization finalizes it, the Full-Test Run links it, sectionEstimates reads it.

/** An Attempt row with the Items persisted against it. */
export type AttemptWithItems = AttemptRow & { items: ItemResultRow[] };

/**
 * One expected Item that never arrived, classified: a deliberate skip is a scored 0, a lost upload
 * is failed. `score` defaults to null and `scoringStatus` to 'failed'.
 */
export type MissingItemPlaceholderWrite = {
  itemId: string;
  taskType: "listen_repeat" | "interview";
  scoreJson: string;
  score?: number | null;
  scoringStatus?: "failed" | "scored";
};

/**
 * The capture-finished write: the marker and every missing-Item placeholder together.
 * `placeholders: []` writes the marker alone, for a Speaking Simulation whose Set is unreadable and
 * so has no expected Item ids to compare against.
 */
export type CaptureFinishedWrite = {
  attemptId: string;
  now?: SqliteTimestamp;
  placeholders: MissingItemPlaceholderWrite[];
};

/**
 * Write-once capture. `markCaptureFinishedWithMissingItemPlaceholders` is the only writer of
 * `capture_finished_at`, and it writes it through `COALESCE(capture_finished_at, ?)`, so the marker
 * never moves once set. In one transaction it also inserts each placeholder only where the Item has
 * no row yet, so an Item that already arrived keeps its row and a repeated call changes nothing.
 *
 * The marker and the placeholders have no separate writers on purpose: a crash between two calls
 * would leave a capture-finished Attempt with placeholders missing, or placeholders with no marker,
 * which neither reconcileAttempt nor the boot pass ever looks at. scheduleGraceReconcile also relies
 * on the marker never moving forward.
 *
 * `now` is injectable for fake-clock tests, and a scored placeholder's `scored_at` is stamped from the
 * same value. It is a `SqliteTimestamp`, so a caller cannot pass the ISO form that would sort wrong
 * against `started_at`/`completed_at`.
 */
export type CaptureStore = {
  markCaptureFinishedWithMissingItemPlaceholders(input: CaptureFinishedWrite): void;
  /**
   * Every Attempt that has a capture marker and is still in progress: the Speaking Simulations the
   * last boot pass reconciles.
   */
  listCaptureFinishedInProgressAttempts(): AttemptRow[];
};

/** Reads of the Attempt aggregate. `getAttempt` is the widest one; narrower ports re-declare it. */
export type AttemptReadStore = {
  getAttempt(id: string): AttemptWithItems | undefined;
  /** An Attempt's Items with only their id, Task Type and scoring status, in stored order. */
  listItemScoringStates(attemptId: string): { item_id: string; task_type: string; scoring_status: string }[];
  listAttempts(q?: { kind?: string; setId?: string; limit?: number; offset?: number }): AttemptRow[];
  /**
   * Which of these Attempts have their marks withheld (MARKS_WITHHELD_SQL in db/stores/attempts.ts):
   * a Simulation in progress, or the discarded Attempt of a Full-Test section restarted in a Run
   * still in progress. Every route that sends an Attempt's marks or a count of them asks this.
   */
  listMarksWithheldAttemptIds(attemptIds: readonly string[]): Set<string>;
  /** How many Attempts `listAttempts` would return for the same filters with no page bound. */
  countAttempts(q?: { kind?: string; setId?: string }): number;
  /**
   * Whether a Set has been attempted: some Attempt on it has a scored Item, or is completed and holds
   * at least one Item (ATTEMPT_COUNTS_AS_SITTING_SQL). The Repeat tag's source at Attempt creation.
   */
  isSetAttempted(setId: string): boolean;
  /** Every Set `isSetAttempted` is true for — the Set listing's `attempted` flag. */
  listSetIdsCountedAsAttempted(): string[];
};

/**
 * The Attempt lifecycle's writers. `completeAttempt` and `abortAttempt` each move an Attempt out of
 * 'in_progress' and nowhere else, and report whether this call did it. That is what makes a
 * replayed reconciliation (a late recovery, a duplicate terminal callback) leave the original
 * completion time alone, and what keeps an aborted Attempt from ever being completed.
 */
export type AttemptWriteStore = {
  createAttempt(a: { id: string; kind: string; mode: string; setId: string; isRepeat: boolean }): void;
  completeAttempt(id: string, now?: SqliteTimestamp): boolean;
  abortAttempt(id: string): boolean;
  flagAttempt(id: string): void;
  setAttemptRouting(attemptId: string, path: "lower" | "upper", routerRaw: number): void;
};

/** What settling an Attempt writes: the Item scores to settle first, and the completion time. */
export type AttemptSettlement = {
  attemptId: string;
  itemScores?: readonly Omit<ItemScoreWrite, "attemptId">[];
  now?: SqliteTimestamp;
};

/**
 * The end of an Attempt as one transaction. `settleAttempt` writes `itemScores`, completes the
 * Attempt if it is still in progress (completeAttempt's guard), and then recomputes its Band
 * Estimate from its Items as they now stand (recomputeSectionEstimate). A crash or a fault anywhere
 * leaves none of the three, so no Attempt is completed with an estimate nobody recomputed, and no
 * estimate is computed from Items that a heal in the same step was still settling.
 *
 * Returns whether this call completed the Attempt and the estimate it now has (null for none). A
 * missing or aborted Attempt is left untouched and answers undefined. An Attempt completed earlier
 * still has its estimate recomputed: a later heal or re-score can change it.
 */
export type AttemptSettlementStore = {
  settleAttempt(input: AttemptSettlement): { completedNow: boolean; estimate: SectionEstimateVM | null } | undefined;
};

/** The whole aggregate, for a caller that spans it (the Attempts route does). */
export type AttemptStore = AttemptReadStore & AttemptWriteStore & CaptureStore & AttemptSettlementStore;
