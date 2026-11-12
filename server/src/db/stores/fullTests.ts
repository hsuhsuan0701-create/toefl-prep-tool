import type Database from "better-sqlite3";
import type { FullTestRunStatus, FullTestSection } from "@toefl-prep/shared";
import type { FullTestRunRow } from "../rows.js";
import { sqliteTimestamp } from "../timestamps.js";
import { ATTEMPT_COUNTS_AS_SITTING_SQL } from "./attempts.js";
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
    // Every Set id any Run has already drawn, in any section. Feeds the "never reuse a Set another Run
    // already claimed, while alternatives remain" half of Set selection, the only reason a Run needs
    // to see any Run but its own.
    listFullTestSetIds(): string[] {
      const rows = db.prepare(
        `SELECT reading_set_id AS a, listening_set_id AS b, writing_set_id AS c, speaking_set_id AS d
         FROM full_test_runs`
      ).all() as { a: string | null; b: string | null; c: string | null; d: string | null }[];
      return rows.flatMap((r) => [r.a, r.b, r.c, r.d]).filter((id): id is string => id !== null);
    },
    // Points one section at the Attempt that is sitting it. Column name is interpolated from a
    // CLOSED union (FullTestSection), never from request data — the same treatment updateItemScore's
    // scored_at expression gets.
    linkFullTestAttempt(runId: string, section: FullTestSection, attemptId: string): boolean {
      return db.prepare(`UPDATE full_test_runs SET ${section}_attempt_id=? WHERE id=?`)
        .run(attemptId, runId).changes > 0;
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
