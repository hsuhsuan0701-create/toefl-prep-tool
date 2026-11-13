import type Database from "better-sqlite3";
import { AnyTaskType, isDeterministicTaskType, ListeningTaskType, ReadingTaskType } from "@toefl-prep/shared";
import type { AttemptRow, ItemResultRow, JudgeReportListRow, TrendRow } from "../rows.js";
import { sqliteTimestamp } from "../timestamps.js";
import { createSqliteEstimateStore } from "./estimates.js";
import type { AttemptSettlement, AttemptStore } from "../../services/attemptStore.js";
import { recomputeSectionEstimate } from "../../services/sectionEstimates.js";
import type { DeterministicScoreStore } from "../../services/deterministicScoring.js";
import type { ScoreStore } from "../../services/judgeEnsemble.js";
import type { BuildSentenceScoreStore } from "../../services/scoreItems.js";
import type { StatsReadStore } from "../../routes/stats.js";

// ---------------------------------------------------------------------------------------------
// The Attempt aggregate, over SQLite
// ---------------------------------------------------------------------------------------------
//
// Tables: `attempts`, `item_results`, `judge_reports`, an Attempt and the two child tables that exist
// only against one. `settleAttempt` also rewrites the Attempt's `section_estimates` row, through the
// estimate adapter, because the end of an Attempt and its Band Estimate commit as one transaction.
//
// `satisfies` rather than a return-type annotation: four ports declare `getAttempt` at four widths,
// and annotating the factory with their intersection would resolve every read of it to the first
// signature rather than the widest. `satisfies` keeps the concrete inferred type, so the SQL-level
// suite sees the real row, and still fails the build when a port gains a member this adapter lacks.
//
// `Omit<StatsReadStore, "getLatestEstimates" | "recentSimulationBands">` because the Dashboard reads
// satisfied here span `attempts`/`item_results`/`judge_reports`, while those two read
// `section_estimates` and belong to estimates.ts. Splitting the port's satisfaction across the two
// aggregates that own the tables is the point; routes/stats.ts still receives the whole port.

// The six Reading/Listening Task Types whose Items are multiple-choice questions, derived from the
// shared enums. Complete the Words is left out: a gap carries no skill.
const MCQ_TASK_TYPES: readonly string[] = [
  ...ReadingTaskType.options.filter((t) => t !== "complete_words"),
  ...ListeningTaskType.options,
];

// The judge-scored Task Types — the only ones whose Score Reports carry Deductions, so the only ones
// the weakness breakdown's window may hold.
const JUDGED_TASK_TYPES: readonly string[] = AnyTaskType.options.filter((t) => !isDeterministicTaskType(t));

// Whether an `item_results` row (alias `ir`) holds the deliberate-skip marker, in SQL: the test
// isSkippedItemScoreJson (shared/src/schemas/scoring.ts) makes on a parsed value. json_valid guards
// json_extract, which raises on a corrupt column rather than answering false.
const SKIPPED_ITEM_SQL = `(CASE WHEN json_valid(ir.score_json) THEN json_extract(ir.score_json, '$.skipped') IS 1 ELSE 0 END)`;

// The item_results upsert, shared so its writers cannot drift apart: insertItemResult, the scored
// batches below (writeScoredItems), and stores/transcription.ts's
// persistFreshTranscriptAndFinishJob, which runs it in one transaction with its own
// `transcription_jobs` write. Exported for that last one; this aggregate owns `item_results`.
//
// Writing a Response over an existing row replaces it and resets its scoring state (score,
// score_json, scored_at, status), because a score describes the Response it was given, with one
// exception: a TEXT Response (no recording on either side) written again verbatim over a committed
// score is left alone. That is a rescore of the same essay or tile order, and its prior score stays
// until a new result is committed in its place. A recording never takes the exception: every take
// of an Item lands on the same canonical path, so a re-record must always reset the row.
export const ITEM_RESULT_UPSERT_SQL = `INSERT INTO item_results (attempt_id, item_id, task_type, response_text, response_audio_path, transcript, delivery_report, scoring_status)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(attempt_id, item_id) DO UPDATE SET
           response_text=excluded.response_text,
           response_audio_path=excluded.response_audio_path,
           transcript=excluded.transcript,
           delivery_report=excluded.delivery_report,
           score=NULL,
           score_json=NULL,
           scored_at=NULL,
           scoring_status=excluded.scoring_status
         WHERE NOT (
           item_results.scoring_status = 'scored'
           AND excluded.response_text IS NOT NULL
           AND item_results.response_text IS excluded.response_text
           AND excluded.response_audio_path IS NULL
           AND item_results.response_audio_path IS NULL
         )`;

/**
 * Whether an Attempt counts as a sitting of its Set, as SQL over an `attempts` row aliased `a`: it has
 * a scored Item, or it is completed and holds at least one Item. One opened and left, or discarded,
 * before anything was scored does not, and neither does one completed with no Item at all: nothing
 * of the Set was answered. Every reader that decides something from "this Set has been attempted"
 * uses it.
 */
export const ATTEMPT_COUNTS_AS_SITTING_SQL = `EXISTS (SELECT 1 FROM item_results sitting_item
  WHERE sitting_item.attempt_id = a.id AND (sitting_item.scoring_status = 'scored' OR a.status = 'completed'))`;

/** The WHERE clause the Attempt listing and its count share, so a page and its total always agree. */
function attemptFilter(q: { kind?: string; setId?: string }): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (q.kind) {
    clauses.push("kind=?");
    params.push(q.kind);
  }
  if (q.setId) {
    clauses.push("set_id=?");
    params.push(q.setId);
  }
  return { where: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function createSqliteAttemptStore(db: Database.Database) {
  // Completion is one-way out of 'in_progress', the same guard abortAttempt carries: an aborted
  // Attempt is never resurrected and a completed one never moves its completion time, so a
  // replayed reconciliation or a repeated POST /complete changes nothing. Returns whether this
  // call completed it.
  function completeAttempt(id: string, now = sqliteTimestamp()): boolean {
    return db.prepare(
      "UPDATE attempts SET status='completed', completed_at=COALESCE(completed_at, ?) WHERE id=? AND status='in_progress'"
    ).run(now, id).changes > 0;
  }

  function getAttempt(id: string) {
    const attempt = db.prepare("SELECT * FROM attempts WHERE id=?").get(id) as AttemptRow | undefined;
    if (!attempt) return undefined;
    const items = db.prepare("SELECT * FROM item_results WHERE attempt_id=? ORDER BY created_at, rowid")
      .all(id) as ItemResultRow[];
    return { ...attempt, items } as AttemptRow & { items: ItemResultRow[] };
  }

  // scored_at is stamped at scoring time, not upload time (item_results.created_at), so "most recently
  // scored" reads hold across a re-score of an old upload. Any status but 'scored' resets it to NULL,
  // so a row that is no longer scored can never look scored through a leftover timestamp.
  function updateItemScore(u: { attemptId: string; itemId: string; score: number | null; scoreJson: string; scoringStatus: string }) {
    const scoredAtExpr = u.scoringStatus === "scored" ? "datetime('now')" : "NULL";
    db.prepare(
      `UPDATE item_results SET score=?, score_json=?, scoring_status=?, scored_at=${scoredAtExpr} WHERE attempt_id=? AND item_id=?`
    ).run(u.score, u.scoreJson, u.scoringStatus, u.attemptId, u.itemId);
  }

  // The estimate rows settleAttempt rewrites inside its own transaction. The Band Estimate aggregate
  // owns them (stores/estimates.ts); this is the same adapter over the same connection.
  const estimates = createSqliteEstimateStore(db);

  // Insert-then-score for each Item, all inside one transaction: 2N statements that must commit
  // together, so a failure on any Item leaves none of the request's rows behind.
  function writeScoredItems(
    items: Array<{ attemptId: string; itemId: string; taskType: string; responseText: string | null; score: number; scoreJson: string }>,
  ): void {
    const insert = db.prepare(ITEM_RESULT_UPSERT_SQL);
    const update = db.prepare(
      "UPDATE item_results SET score=?, score_json=?, scoring_status='scored', scored_at=datetime('now') WHERE attempt_id=? AND item_id=?"
    );
    db.transaction(() => {
      for (const item of items) {
        insert.run(item.attemptId, item.itemId, item.taskType, item.responseText, null, null, null, "pending");
        update.run(item.score, item.scoreJson, item.attemptId, item.itemId);
      }
    })();
  }

  return {
    createAttempt(a: { id: string; kind: string; mode: string; setId: string; isRepeat: boolean }) {
      db.prepare(
        "INSERT INTO attempts (id, kind, mode, set_id, is_repeat) VALUES (?,?,?,?,?)"
      ).run(a.id, a.kind, a.mode, a.setId, a.isRepeat ? 1 : 0);
    },
    // The only writer of status='aborted'. Guarded on 'in_progress' so a completed attempt can
    // never be un-completed, and so a double click is a harmless no-op. Returns whether a row
    // actually changed, which is what the route answers from; its getAttempt read first only tells a
    // 404 from a 409.
    abortAttempt(id: string): boolean {
      return db.prepare("UPDATE attempts SET status='aborted' WHERE id=? AND status='in_progress'").run(id).changes > 0;
    },
    completeAttempt,
    // AttemptSettlementStore: the Item scores, the completion and the estimate, in one transaction.
    // The status read is inside it, so an Attempt aborted a moment earlier is never healed or given
    // an estimate. better-sqlite3 transactions are synchronous, so nothing else runs in between.
    settleAttempt(input: AttemptSettlement) {
      return db.transaction(() => {
        const row = db.prepare("SELECT status FROM attempts WHERE id=?").get(input.attemptId) as { status: string } | undefined;
        if (!row || row.status === "aborted") return undefined;
        for (const item of input.itemScores ?? []) updateItemScore({ ...item, attemptId: input.attemptId });
        const completedNow = completeAttempt(input.attemptId, input.now);
        const estimate = recomputeSectionEstimate({ ...estimates, getAttempt }, input.attemptId);
        return { completedNow, estimate };
      })();
    },
    // Sets `flagged`, which POST /:id/flag does when the tab goes hidden during a Simulation. Never
    // cleared: once flagged, an Attempt stays flagged.
    flagAttempt(id: string) {
      db.prepare("UPDATE attempts SET flagged=1 WHERE id=?").run(id);
    },
    // Records the Module Path and the Router raw score its cut was applied to. Unconditional: the route
    // writes it once, and a replayed routing request returns the stored decision instead.
    setAttemptRouting(attemptId: string, path: "lower" | "upper", routerRaw: number): void {
      db.prepare("UPDATE attempts SET module_path=?, router_raw=? WHERE id=?").run(path, routerRaw, attemptId);
    },
    getAttempt,
    // An Attempt's Items as the Attempt log's band state reads them: which Item, its Task Type and its
    // scoring status, and none of the Response, transcript or Score Report getAttempt carries.
    listItemScoringStates(attemptId: string) {
      return db.prepare("SELECT item_id, task_type, scoring_status FROM item_results WHERE attempt_id=? ORDER BY created_at, rowid")
        .all(attemptId) as { item_id: string; task_type: string; scoring_status: string }[];
    },
    // Newest first. Without an explicit `limit`, the whole-log listing stops at 50 rows while a
    // per-Set listing is unbounded (a Set's own Attempts stay few however long the log grows).
    // GET /api/attempts always passes `limit` and `offset` and states `countAttempts` beside the
    // page, so no caller has to treat one page as the whole log.
    listAttempts(q: { kind?: string; setId?: string; limit?: number; offset?: number } = {}) {
      const { where, params } = attemptFilter(q);
      const limit = q.limit ?? (q.setId ? -1 : 50);
      return db.prepare(`SELECT * FROM attempts ${where} ORDER BY started_at DESC, rowid DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, q.offset ?? 0) as AttemptRow[];
    },
    countAttempts(q: { kind?: string; setId?: string } = {}): number {
      const { where, params } = attemptFilter(q);
      return (db.prepare(`SELECT COUNT(*) AS n FROM attempts ${where}`).get(...params) as { n: number }).n;
    },
    insertItemResult(i: { attemptId: string; itemId: string; taskType: string; responseText?: string; responseAudioPath?: string; transcript?: string; deliveryReport?: string; scoringStatus?: string }) {
      // An upsert on (attempt_id, item_id): a new Response replaces the old one and resets its
      // scoring state, including scored_at, so a stale timestamp never makes the row look scored
      // to the `scored_at IS NOT NULL` readers. A text Response re-recorded verbatim over a
      // committed score keeps that score (see ITEM_RESULT_UPSERT_SQL). scoringStatus defaults to
      // 'pending'; transcription writes 'transcription_pending' for a take still awaiting Ears.
      const scoringStatus = i.scoringStatus ?? "pending";
      db.prepare(ITEM_RESULT_UPSERT_SQL).run(i.attemptId, i.itemId, i.taskType, i.responseText ?? null, i.responseAudioPath ?? null, i.transcript ?? null, i.deliveryReport ?? null, scoringStatus);
    },
    updateItemScore,
    // Every deterministic Item of one Task Type request commits as a unit, or none does. A client
    // retrying a Reading/Listening submission treats one already-scored Item as proof that the whole
    // request landed (routes/attempts.ts's `alreadyScored` marker), which is only true if no request
    // can ever be half-written.
    scoreDeterministicItemsBatch(
      items: Array<{ attemptId: string; itemId: string; taskType: string; score: number; scoreJson: string }>
    ): void {
      // Reading/Listening Items keep no response column of their own: the typed letters or the
      // selected option live in score_json's `answer` field.
      writeScoredItems(items.map((item) => ({ ...item, responseText: null })));
    },
    // The same all-or-nothing write for one Build a Sentence request. Its Response (the tile order)
    // is a column, so it is written in the same transaction as the score it earned.
    scoreBuildSentenceItems(
      items: Array<{ attemptId: string; itemId: string; responseText: string; score: number; scoreJson: string }>
    ): void {
      writeScoredItems(items.map((item) => ({ ...item, taskType: "build_sentence" })));
    },
    insertJudgeReport(j: { attemptId: string; itemId: string; judge: string; reportJson: string }) {
      db.prepare(
        "INSERT INTO judge_reports (attempt_id, item_id, judge, report_json) VALUES (?,?,?,?)"
      ).run(j.attemptId, j.itemId, j.judge, j.reportJson);
    },
    deleteJudgeReports(attemptId: string, itemId: string) {
      db.prepare("DELETE FROM judge_reports WHERE attempt_id=? AND item_id=?").run(attemptId, itemId);
    },
    getJudgeReports(attemptId: string) {
      return db.prepare(
        "SELECT item_id, judge, report_json FROM judge_reports WHERE attempt_id=? ORDER BY created_at, rowid"
      ).all(attemptId) as { item_id: string; judge: string; report_json: string }[];
    },
    // ATTEMPT_COUNTS_AS_SITTING_SQL. Decides whether a new Attempt is a Repeat.
    isSetAttempted(setId: string): boolean {
      return (db.prepare(
        `SELECT EXISTS (SELECT 1 FROM attempts a WHERE a.set_id = ? AND ${ATTEMPT_COUNTS_AS_SITTING_SQL}) AS attempted`
      ).get(setId) as { attempted: 0 | 1 }).attempted === 1;
    },
    // ATTEMPT_COUNTS_AS_SITTING_SQL. Feeds GET /api/sets' `attempted` flag, which the practice lists
    // and the Simulation picker read.
    listSetIdsCountedAsAttempted(): string[] {
      return (db.prepare(
        `SELECT DISTINCT a.set_id FROM attempts a WHERE ${ATTEMPT_COUNTS_AS_SITTING_SQL} ORDER BY a.set_id`
      ).all() as { set_id: string }[]).map((r) => r.set_id);
    },
    // Every judge_reports row, unfiltered, for the Dashboard's Judge-agreement figure (mean |Gemini −
    // OpenAI| per Item). Pairing and JSON parsing are the caller's.
    listAllJudgeReports(): JudgeReportListRow[] {
      return db.prepare(
        `SELECT attempt_id AS attemptId, item_id AS itemId, judge, report_json AS reportJson
         FROM judge_reports ORDER BY attempt_id, item_id, created_at, rowid`
      ).all() as JudgeReportListRow[];
    },
    // Marks capture finished and inserts a placeholder for every missing Item in one transaction, so a
    // failure partway leaves capture_finished_at untouched. ON CONFLICT DO NOTHING lets an Item row that
    // already arrived (a real upload or an earlier placeholder) win, which also makes a retried call a
    // no-op. A placeholder is either a deliberate skip (status 'scored', score 0) or a recording that
    // never arrived (status 'failed', score null: the default); speakingFinalization.ts decides which.
    // A scored skip gets `scored_at`, the "currently scored" signal the stats reads filter on, from the
    // same `now` as the capture marker.
    markCaptureFinishedWithMissingItemPlaceholders(input: { attemptId: string; now?: string; placeholders: { itemId: string; taskType: "listen_repeat" | "interview"; scoreJson: string; score?: number | null; scoringStatus?: "failed" | "scored" }[] }): void {
      const now = input.now ?? sqliteTimestamp();
      db.transaction(() => {
        db.prepare("UPDATE attempts SET capture_finished_at=COALESCE(capture_finished_at,?) WHERE id=?").run(now, input.attemptId);
        const insert = db.prepare("INSERT INTO item_results (attempt_id,item_id,task_type,score,score_json,scoring_status,scored_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(attempt_id,item_id) DO NOTHING");
        for (const item of input.placeholders) {
          const scoringStatus = item.scoringStatus ?? "failed";
          insert.run(input.attemptId, item.itemId, item.taskType, item.score ?? null, item.scoreJson, scoringStatus, scoringStatus === "scored" ? now : null);
        }
      })();
    },
    listCaptureFinishedInProgressAttempts(): AttemptRow[] { return db.prepare("SELECT * FROM attempts WHERE capture_finished_at IS NOT NULL AND status='in_progress' ORDER BY started_at,rowid").all() as AttemptRow[]; },
    // The most recently SCORED judged Items — feeds the stats/summary weakness breakdown
    // (deduction-category counts over the last N). Scoped to judge-scored Task Types IN the query,
    // before the LIMIT: one Reading Simulation scores dozens of right-or-wrong Items at once, and a
    // window that admitted them would hold no Deductions at all. Likewise only a Response with a Score
    // Report (a `deductions` array, empty for a recording with no speech) takes a slot: a skip
    // placeholder is a scored 0 but no Response, and a Speaking Simulation left early writes one for
    // every Item it never reached, which would push real Responses out. Ordered by scored_at (scoring
    // time), NOT created_at (upload time, which never moves on a rescore), with rowid DESC as the
    // tiebreak for same-second scoring passes. scoring_status/score_json are belt-and-suspenders
    // filters alongside `scored_at IS NOT NULL`, the real "currently scored" signal (see
    // updateItemScore).
    recentScoredItemResults(limit: number): { scoreJson: string }[] {
      const placeholders = JUDGED_TASK_TYPES.map(() => "?").join(",");
      return db.prepare(
        `SELECT score_json AS scoreJson FROM item_results
         WHERE scoring_status = 'scored' AND score_json IS NOT NULL AND scored_at IS NOT NULL
           AND task_type IN (${placeholders})
           AND (CASE WHEN json_valid(score_json) THEN json_type(score_json, '$.deductions') END) = 'array'
         ORDER BY scored_at DESC, rowid DESC LIMIT ?`
      ).all(...JUDGED_TASK_TYPES, limit) as { scoreJson: string }[];
    },
    // The most recently scored Reading/Listening multiple-choice Items, for the per-skill accuracy pane
    // (computeSkillItems in routes/stats.ts), ordered as recentScoredItemResults. Complete the Words is
    // left out: a gap has no skill. `taskType` is returned because the two sections' skill enums share
    // names ("detail", "inference"), so the caller needs it to assign the section. The caller passes a
    // wider window than the weakness breakdown's, since a per-skill pane needs several Attempts' worth.
    recentScoredReadingListeningItemResults(limit: number): { scoreJson: string; taskType: string }[] {
      const placeholders = MCQ_TASK_TYPES.map(() => "?").join(",");
      return db.prepare(
        `SELECT score_json AS scoreJson, task_type AS taskType FROM item_results
         WHERE scoring_status = 'scored' AND score_json IS NOT NULL AND scored_at IS NOT NULL
           AND task_type IN (${placeholders})
         ORDER BY scored_at DESC, rowid DESC LIMIT ?`
      ).all(...MCQ_TASK_TYPES, limit) as { scoreJson: string; taskType: string }[];
    },
    // One point per completed Attempt whose Items of this Task Type are all scored, the band rule's
    // test (sectionEstimates.ts, ADR 0010) taken per Task Type: the mean of those scores, a skip
    // counted as the 0 it scores. An Attempt with one of them failed, pending or untranscribed gives
    // no point, since a mean of its scored siblings alone is not its result. Nor does one whose Items
    // of this Task Type are all skips: a Speaking Simulation left early has a skip placeholder for
    // every Item it never reached, and a point made of placeholders alone would plot 0 for a Task
    // Type the User never answered. In-progress and aborted Attempts are not points. Repeats are
    // included, flagged by isRepeat, for the client to draw distinctly. Ties break on the Attempt's
    // insertion order (a.rowid), since ids are random UUIDs; it is single-valued per group.
    trendPoints(taskType: string): TrendRow[] {
      return db.prepare(
        `SELECT ir.attempt_id AS attemptId, a.mode AS mode, a.is_repeat AS isRepeat,
                a.started_at AS startedAt, a.completed_at AS completedAt, AVG(ir.score) AS avgScore
         FROM item_results ir
         JOIN attempts a ON a.id = ir.attempt_id
         WHERE ir.task_type = ? AND a.status = 'completed'
         GROUP BY ir.attempt_id
         HAVING SUM(ir.scoring_status <> 'scored' OR ir.score IS NULL) = 0
            AND SUM(NOT ${SKIPPED_ITEM_SQL}) > 0
         ORDER BY COALESCE(a.completed_at, a.started_at) ASC, a.rowid ASC`
      ).all(taskType) as TrendRow[];
    },
  } satisfies AttemptStore & DeterministicScoreStore & BuildSentenceScoreStore & Omit<ScoreStore, "getScoringJob"> & Omit<StatsReadStore, "getLatestEstimates" | "recentSimulationBands">;
}

/**
 * Recomputes the Band Estimate of an Attempt that is already completed, from its Items as they
 * stand. The scoring-job store calls it inside the transaction that ends a job, so the Item scores a
 * re-score commits and the band computed from them never part across a crash. An Attempt still in
 * progress has no estimate to keep in step: `settleAttempt` writes its first.
 */
export function createCompletedAttemptEstimateRefresh(db: Database.Database): (attemptId: string) => void {
  const { getAttempt } = createSqliteAttemptStore(db);
  const estimates = createSqliteEstimateStore(db);
  const readStatus = db.prepare("SELECT status FROM attempts WHERE id=?");
  return (attemptId) => {
    const row = readStatus.get(attemptId) as { status: string } | undefined;
    if (row?.status === "completed") recomputeSectionEstimate({ ...estimates, getAttempt }, attemptId);
  };
}
