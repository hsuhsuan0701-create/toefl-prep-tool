import type Database from "better-sqlite3";
import type { FullTestRunStatus, FullTestSection } from "@toefl-prep/shared";
import type { FullTestRunRow } from "../rows.js";
import { sqliteTimestamp } from "../timestamps.js";
import { ATTEMPT_COUNTS_AS_SITTING_SQL, createSqliteAttemptStore } from "./attempts.js";
import type { FullTestRunStore } from "../../routes/fullTests.js";

// ---------------------------------------------------------------------------------------------
// The Full-Test Run aggregate, over SQLite
// ---------------------------------------------------------------------------------------------
//
// Table: `full_test_runs` — four linked Simulation Attempts under one combined report.
//
// `lastAttemptStartedAtBySetId` reads `attempts` rather than this table, and is here rather than in
// stores/attempts.ts because routes/fullTests.ts's port is where it is DECLARED: it exists so Set
// selection can prefer a Set this Run has not recently used, and its result is SORTED, which is why
// the space-form convention has to hold across the column it reads. Following the port keeps one
// declaration and one implementation in the same place; moving it would leave the port pointing at
// an aggregate that no longer answers it.

export function createSqliteFullTestStore(db: Database.Database) {
  // The Attempt writers the two Run transactions below call, so a section's Attempt is opened, the one
  // it replaces discarded, and a Run's live section discarded through the same statements POST
  // /api/attempts and POST /api/attempts/:id/abort run. The Attempt aggregate owns them; this is the
  // same adapter over the same connection.
  const attempts = createSqliteAttemptStore(db);
  // Column name interpolated from a CLOSED union (FullTestSection), never from request data — the
  // same treatment updateItemScore's scored_at expression gets.
  const linkFullTestAttempt = (runId: string, section: FullTestSection, attemptId: string): boolean =>
    db.prepare(`UPDATE full_test_runs SET ${section}_attempt_id=? WHERE id=?`).run(attemptId, runId).changes > 0;

  return {

    // -----------------------------------------------------------------------------------------
    // Full-Test Runs. See schema.sql's full_test_runs for what a Run is and is not.
    // -----------------------------------------------------------------------------------------

    createFullTestRun(r: {
      id: string;
      currentSection: FullTestSection;
      setIds: Partial<Record<FullTestSection, string | null>>;
      createdAt?: string;
    }): void {
      db.prepare(
        `INSERT INTO full_test_runs
           (id, status, current_section, reading_set_id, listening_set_id, writing_set_id, speaking_set_id, created_at)
         VALUES (?, 'in-progress', ?, ?, ?, ?, ?, ?)`
      ).run(
        r.id,
        r.currentSection,
        r.setIds.reading ?? null,
        r.setIds.listening ?? null,
        r.setIds.writing ?? null,
        r.setIds.speaking ?? null,
        r.createdAt ?? sqliteTimestamp(),
      );
    },
    getFullTestRun(id: string): FullTestRunRow | undefined {
      return db.prepare("SELECT * FROM full_test_runs WHERE id=?").get(id) as FullTestRunRow | undefined;
    },
    // An Attempt is linked to at most one Run (it is created with its link), and a restarted section
    // repoints its column at the new Attempt, so the one it replaced is found by no Run.
    getFullTestRunForAttempt(attemptId: string): FullTestRunRow | undefined {
      return db.prepare(
        `SELECT * FROM full_test_runs
          WHERE ? IN (reading_attempt_id, listening_attempt_id, writing_attempt_id, speaking_attempt_id)
          ORDER BY created_at DESC, rowid DESC LIMIT 1`
      ).get(attemptId) as FullTestRunRow | undefined;
    },
    // getFullTestRunForAttempt for a page of the Attempt log in one statement: each Attempt's Run, the
    // newest when (in rows older than the link rule) more than one names it. Attempts no Run names
    // are absent from the map.
    listFullTestRunsForAttempts(attemptIds: readonly string[]): Map<string, { id: string; status: string }> {
      const rows = db.prepare(
        `SELECT a.value AS attempt_id, r.id, r.status
           FROM json_each(?) a
           JOIN full_test_runs r
             ON a.value IN (r.reading_attempt_id, r.listening_attempt_id, r.writing_attempt_id, r.speaking_attempt_id)
          ORDER BY r.created_at DESC, r.rowid DESC`
      ).all(JSON.stringify(attemptIds)) as { attempt_id: string; id: string; status: string }[];
      const runs = new Map<string, { id: string; status: string }>();
      for (const row of rows) if (!runs.has(row.attempt_id)) runs.set(row.attempt_id, { id: row.id, status: row.status });
      return runs;
    },
    // Filtered by status, the listing is unbounded unless the caller pages it: the in-progress Runs
    // are the practice page's only route back to a half-sat sitting, and there are few of them.
    listFullTestRuns(q: { limit?: number; status?: FullTestRunStatus } = {}): FullTestRunRow[] {
      return q.status
        ? db.prepare(
          "SELECT * FROM full_test_runs WHERE status=? ORDER BY created_at DESC, rowid DESC LIMIT ?"
        ).all(q.status, q.limit ?? -1) as FullTestRunRow[]
        : db.prepare(
          "SELECT * FROM full_test_runs ORDER BY created_at DESC, rowid DESC LIMIT ?"
        ).all(q.limit ?? 20) as FullTestRunRow[];
    },
    // Every Set id a Run has claimed, in any section. Feeds the "never reuse a Set another Run already
    // claimed, while alternatives remain" half of Set selection, the only reason a Run needs to see
    // any Run but its own. A Run in progress or completed claims all four of its Sets. An abandoned
    // Run claims only the Sets that were sat (ATTEMPT_COUNTS_AS_SITTING_SQL, the attempted rule):
    // a Run started by mistake and abandoned at once has sat nothing, and must not keep its Sets from
    // every later Run.
    listFullTestSetIds(): string[] {
      const rows = db.prepare(
        `SELECT claimed.set_id AS setId FROM (
           SELECT status, reading_set_id AS set_id FROM full_test_runs
           UNION ALL SELECT status, listening_set_id FROM full_test_runs
           UNION ALL SELECT status, writing_set_id FROM full_test_runs
           UNION ALL SELECT status, speaking_set_id FROM full_test_runs
         ) claimed
         WHERE claimed.set_id IS NOT NULL
           AND (claimed.status <> 'abandoned'
             OR EXISTS (SELECT 1 FROM attempts a WHERE a.set_id = claimed.set_id AND ${ATTEMPT_COUNTS_AS_SITTING_SQL}))`
      ).all() as { setId: string }[];
      return rows.map((r) => r.setId);
    },
    // Points one section at the Attempt that is sitting it.
    linkFullTestAttempt,
    // A section's Attempt opened inside its Run, in one transaction: the Attempt row, the Run's link
    // to it and, when it restarts the section, the discard of the Attempt it replaces. Discarding that
    // one in the same step keeps it from being finished later (its review would show the key of a Set
    // the Run is still sitting) and from being listed as unfinished beside the live one. Discarding
    // alone would release its marks, which a discarded Simulation shows: MARKS_WITHHELD_SQL keeps them
    // on the server until the Run ends, since the restart sits the same Set under the same tag.
    openFullTestSectionAttempt(o: {
      runId: string;
      section: FullTestSection;
      attempt: { id: string; mode: string; setId: string; isRepeat: boolean };
      replacedAttemptId: string | null;
    }): void {
      db.transaction(() => {
        attempts.createAttempt({ ...o.attempt, kind: o.section });
        linkFullTestAttempt(o.runId, o.section, o.attempt.id);
        if (o.replacedAttemptId) attempts.abortAttempt(o.replacedAttemptId);
      })();
    },
    setFullTestCurrentSection(runId: string, section: FullTestSection | null): boolean {
      return db.prepare("UPDATE full_test_runs SET current_section=? WHERE id=?")
        .run(section, runId).changes > 0;
    },
    // The end of a sitting: the Run steps past Speaking, so nothing is current any more. Guarded on
    // 'in-progress' and COALESCE'd on completed_at, as completeAttempt is, so a repeated handoff can
    // neither move a finished Run's timestamp nor revive an abandoned one. Returns whether this call
    // completed it.
    completeFullTestRun(runId: string, now: string = sqliteTimestamp()): boolean {
      return db.prepare(
        `UPDATE full_test_runs
            SET status='completed', current_section=NULL, completed_at=COALESCE(completed_at,?)
          WHERE id=? AND status='in-progress'`
      ).run(now, runId).changes > 0;
    },
    // A Run given up on: it ends 'abandoned', with no current section and no completion time, and the
    // section it was sitting, if any, is discarded in the same transaction. Finished sections keep
    // their Attempts and Band Estimates. Guarded on 'in-progress' like completeFullTestRun, and the
    // discard runs only once that guard has passed, so a completed Run is never abandoned and its
    // sections are never touched. Returns whether this call abandoned the Run.
    abandonFullTestRun(runId: string, liveAttemptIds: readonly string[]): boolean {
      return db.transaction(() => {
        const abandoned = db.prepare(
          "UPDATE full_test_runs SET status='abandoned', current_section=NULL WHERE id=? AND status='in-progress'"
        ).run(runId).changes > 0;
        if (abandoned) for (const attemptId of liveAttemptIds) attempts.abortAttempt(attemptId);
        return abandoned;
      })();
    },
    // The start of each Set's most recent sitting (ATTEMPT_COUNTS_AS_SITTING_SQL), for
    // least-recently-attempted Set selection: an id absent from the map has never been attempted, so a
    // Run prefers it, which keeps the Run's sections from being Repeats. Space-form UTC strings, which
    // sort correctly as text (db/timestamps.ts).
    lastAttemptStartedAtBySetId(): Map<string, string> {
      const rows = db.prepare(
        `SELECT a.set_id AS setId, MAX(a.started_at) AS startedAt FROM attempts a
          WHERE ${ATTEMPT_COUNTS_AS_SITTING_SQL} GROUP BY a.set_id`
      ).all() as { setId: string; startedAt: string }[];
      return new Map(rows.map((r) => [r.setId, r.startedAt]));
    },
  } satisfies FullTestRunStore;
}
