import type Database from "better-sqlite3";
import type {
  BackwardBuildupRepRow, DrillLabRepSummaryRow, DrillLabScoreRow, DrillLabStore,
} from "../../routes/drillLab.js";

// ---------------------------------------------------------------------------------------------
// The `backward_buildup_reps` aggregate, over SQLite
// ---------------------------------------------------------------------------------------------
//
// One writer and three readers, all in routes/drillLab.ts, exactly as that route's port declares
// them. The reads that do not touch this table (`listenRepeatScores`, `scoresForItem`,
// `answeredListenRepeatItems`) live here anyway because they are the Drill Lab's own view of history:
// which sentences the User has already failed, and which ones they have already answered. All are
// read-only over `item_results`/`attempts`: this store never writes outside its own table, so a
// practice rep can never reach scoring state (see schema.sql's note on the table).

/**
 * A Listen and Repeat Item row the User has answered: a recorded take that was scored. The one
 * predicate every read below filters on, so the queue, an Item's past scores and the bank browser
 * agree on which sentences the User has heard and answered. The recording is required because a
 * skip is scored too: a Speaking Simulation finished early scores every Item it never reached 0,
 * with no take, and such an Item's sentence has never been heard. Over `item_results AS ir`.
 */
const ANSWERED_LISTEN_REPEAT_ITEM_SQL = `ir.task_type = 'listen_repeat' AND ir.scoring_status = 'scored'
              AND ir.score IS NOT NULL AND ir.response_audio_path IS NOT NULL`;

export function createSqliteDrillLabStore(db: Database.Database) {
  return {
    /**
     * Every answered Listen and Repeat Item's score the User has ever produced, newest first.
     *
     * Returns raw rows rather than an aggregate because the route decides both the weakness
     * threshold and the ordering, and a store that encoded either would have to change every time
     * the drill's selection rule did.
     *
     * Ordered by `rowid` after `created_at`, and the second key matters: `created_at` has one-second
     * resolution and a Speaking Drill scores all seven Listen and Repeat Items in a burst, so
     * same-second ties are the normal case. Without the tiebreak, the route's `latestScore`
     * (scores[0]) would be an arbitrary one of the tied scores; `rowid` ascends with insertion.
     */
    listenRepeatScores(): DrillLabScoreRow[] {
      return db
        .prepare(
          `SELECT a.set_id AS setId, ir.item_id AS itemId, ir.score AS score, ir.created_at AS createdAt
             FROM item_results ir
             JOIN attempts a ON a.id = ir.attempt_id
            WHERE ${ANSWERED_LISTEN_REPEAT_ITEM_SQL}
            ORDER BY ir.created_at DESC, ir.rowid DESC`
        )
        .all() as DrillLabScoreRow[];
    },

    /** Every answered score for ONE item, newest first — the item page's own read. */
    scoresForItem(setId: string, itemId: string): DrillLabScoreRow[] {
      return db
        .prepare(
          `SELECT a.set_id AS setId, ir.item_id AS itemId, ir.score AS score, ir.created_at AS createdAt
             FROM item_results ir
             JOIN attempts a ON a.id = ir.attempt_id
            WHERE ${ANSWERED_LISTEN_REPEAT_ITEM_SQL}
              AND a.set_id = ? AND ir.item_id = ?
            ORDER BY ir.created_at DESC, ir.rowid DESC`
        )
        .all(setId, itemId) as DrillLabScoreRow[];
    },

    /**
     * Per-item rep totals plus the most recent MEASURED rep, in one query.
     *
     * Replaces a `listReps` call per queue entry. The window function picks, per (set, item), the
     * newest rep that carries an alignment — `matched_word_count IS NOT NULL` sorts first, so an
     * item whose only reps failed transcription still yields a row and the route's `heldWordCount`
     * turns it into the null it should be, rather than the row vanishing and reading as "never
     * practised".
     */
    repSummaries(): DrillLabRepSummaryRow[] {
      return db
        .prepare(
          `SELECT setId, itemId, repCount, breakdownIndex, targetWordCount, matchedWordCount
             FROM (
               SELECT set_id AS setId, item_id AS itemId,
                      COUNT(*) OVER (PARTITION BY set_id, item_id) AS repCount,
                      breakdown_index AS breakdownIndex,
                      target_word_count AS targetWordCount,
                      matched_word_count AS matchedWordCount,
                      ROW_NUMBER() OVER (
                        PARTITION BY set_id, item_id
                        ORDER BY (matched_word_count IS NOT NULL) DESC, created_at DESC, rowid DESC
                      ) AS rn
                 FROM backward_buildup_reps
             )
            WHERE rn = 1`
        )
        .all() as DrillLabRepSummaryRow[];
    },

    /** Every Listen and Repeat Item the User has answered, in any Attempt, whatever its status. */
    answeredListenRepeatItems(): { setId: string; itemId: string }[] {
      return db
        .prepare(
          `SELECT DISTINCT a.set_id AS setId, ir.item_id AS itemId
             FROM item_results ir
             JOIN attempts a ON a.id = ir.attempt_id
            WHERE ${ANSWERED_LISTEN_REPEAT_ITEM_SQL}`
        )
        .all() as { setId: string; itemId: string }[];
    },

    /** Every rep against one target sentence, oldest first — the drill renders these as a trend. */
    listReps(setId: string, itemId: string): BackwardBuildupRepRow[] {
      return db
        .prepare(
          `SELECT id, set_id AS setId, item_id AS itemId, phase, transcript,
                  transcription_error AS transcriptionError, breakdown_index AS breakdownIndex,
                  target_word_count AS targetWordCount, matched_word_count AS matchedWordCount,
                  diff_json AS diffJson, audio_path AS audioPath, created_at AS createdAt
             FROM backward_buildup_reps
            WHERE set_id = ? AND item_id = ?
            ORDER BY created_at ASC, rowid ASC`
        )
        .all(setId, itemId) as BackwardBuildupRepRow[];
    },

    insertRep(row: BackwardBuildupRepRow): void {
      db.prepare(
        `INSERT INTO backward_buildup_reps
           (id, set_id, item_id, phase, transcript, transcription_error, breakdown_index,
            target_word_count, matched_word_count, diff_json, audio_path, created_at)
         VALUES (@id, @setId, @itemId, @phase, @transcript, @transcriptionError, @breakdownIndex,
                 @targetWordCount, @matchedWordCount, @diffJson, @audioPath, @createdAt)`
      ).run(row);
    },
  } satisfies DrillLabStore;
}
