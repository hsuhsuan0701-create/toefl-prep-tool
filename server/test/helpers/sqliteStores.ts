import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { openDb } from "../../src/db/db.js";
import { sqliteTimestamp } from "../../src/db/timestamps.js";
import type {
  LatestEstimateRow, ModelAttemptRow, ModelCallRow, ProviderExecutionRow,
  RouteInvocationRow, ScoringJobRow, SupersededSetRow, TranscriptionJobRow,
} from "../../src/db/rows.js";
import { createSqliteAttemptStore } from "../../src/db/stores/attempts.js";
import {
  createSqliteClipMeasurementStore, createSqliteDiagnosticStore,
} from "../../src/db/stores/diagnostics.js";
import { createSqliteEstimateStore, selectLatestEstimate } from "../../src/db/stores/estimates.js";
import { createSqliteDrillLabStore } from "../../src/db/stores/drillLab.js";
import { createSqliteExecutionLeaseStore } from "../../src/db/stores/executionLease.js";
import { createSqliteFullTestStore } from "../../src/db/stores/fullTests.js";
import { createSqliteGenerationStore } from "../../src/db/stores/generation.js";
import { createSqliteProviderQuotaStore } from "../../src/db/stores/providerQuota.js";
import { createSqlitePublicationStore } from "../../src/db/stores/publication.js";
import { createSqliteScoringJobStore } from "../../src/db/stores/scoring.js";
import { createSqliteSettingsStore } from "../../src/db/stores/settings.js";
import { createSqliteSupersessionStore } from "../../src/db/stores/supersession.js";
import {
  createSqliteRecordingStore, createSqliteTranscriptionJobStore,
} from "../../src/db/stores/transcription.js";

// The SQL-level suite's handle on one database. Production composes only the narrow port each
// consumer declares (src/db/stores/index.ts), but the suite that tests the SQL itself needs one
// handle that spans aggregates, because a single test routinely has to create an Attempt, upload an
// Item, run a scoring job and read a Band Estimate back. That handle lives here, under test/, on
// three conditions:
//
//   * Production cannot reach it. Nothing under src/ imports it, and every production handle is
//     narrowed to a declared port at the composition root.
//   * The first half is a composition of the real adapters, not a second implementation. Every
//     statement the suite exercises through it is the statement production runs.
//   * The second half (`testOnlyStatements`) is the only SQL in this project that ships nowhere. It
//     exists for exactly two jobs: constructing a state production reaches by another route, and
//     reading back a table whose production port is write-only.
//
// Prefer a single aggregate's factory where a test only needs one; this helper is for the files
// that span several.

/**
 * Test-only statements. None of these has a production caller or a port; each is here only because
 * the suite needs it:
 *
 *   createScoringJob                  seeds a bare 'queued' row. Production only ever creates one
 *                                     through `replaceScoringJobAndSupersede` (which terminalizes
 *                                     the prior jobs in the same transaction) or through
 *                                     `createRecoveryScoringJobAndLink`; a test that wants a lone
 *                                     queued job with default timestamps has no other way to say so.
 *   linkTranscriptionScoreJob         }  the two transcription writes production makes only inside
 *   supersedeOtherTranscriptionJobs   }  a larger transaction: `createRecoveryScoringJobAndLink`
 *                                        and `createOrGetTranscriptionJob`'s own sweep.
 *   latestEstimate                    one section's headline row. The estimate store exposes only
 *                                     `getLatestEstimates` (all four sections); the suite asserts
 *                                     one section at a time.
 *   getSupersession                   read-back for `superseded_sets`, whose production port is
 *                                     write-plus-list only.
 *   listModelCallsByContext           }  the read side of the model-diagnostics aggregate, whose
 *   getRouteInvocation                }  production port is write-only by construction. These are
 *   listModelAttempts                 }  how the suite proves the shipping writers wrote what they
 *   listProviderExecutions            }  claim; a human debugging a job uses ADR 0004's sqlite3
 *                                        command instead.
 *   seedScoringJob                    }  raw rows with any columns a test names, schema defaults for
 *   seedTranscriptionJob              }  the rest: the shapes no writer produces (a corrupt
 *                                        `item_ids`, a transcription job created straight at
 *                                        'awaiting_score'), still subject to every CHECK and FK.
 *   seedScoringJobState               any status, stage, progress, result or error on an existing
 *                                     scoring job, unconditionally. Production has no such writer: a
 *                                     job's stage moves through `setScoringJobStage`, and it ends
 *                                     only through the guarded terminal writes.
 *   countSectionEstimates             how many `section_estimates` rows one Attempt holds. The
 *                                     production read returns one row, so it cannot tell the upsert
 *                                     from an append that happens to return the newest row first.
 *
 * A statement here is covered by nothing, because it ships nowhere. Do not move production
 * behaviour into this object to make a test easier.
 */
function testOnlyStatements(db: Database.Database) {
  return {
    // id is caller-supplied (crypto.randomUUID(), as createAttempt takes it). item_ids is the
    // JSON-encoded list of Item ids the job covers, which boot recovery (failInterruptedJobs and the
    // orphan sweep) reads to tell which item_results rows belong to a job.
    createScoringJob(j: { id: string; attemptId: string; taskType: string; itemIds: string[] }) {
      db.prepare(
        `INSERT INTO scoring_jobs (id, attempt_id, task_type, item_ids, status)
         VALUES (?,?,?,?, 'queued')`
      ).run(j.id, j.attemptId, j.taskType, JSON.stringify(j.itemIds));
    },
    // The same guard as the transcription store's updateTranscriptionJob: a stale link write cannot
    // land on a row already superseded or done.
    linkTranscriptionScoreJob(i: { jobId: string; scoreJobId: string | null; now: string }): void { db.prepare("UPDATE transcription_jobs SET score_job_id=?,updated_at=? WHERE id=? AND status NOT IN ('superseded','done')").run(i.scoreJobId,i.now,i.jobId); },
    // A single statement, so already atomic without a transaction.
    supersedeOtherTranscriptionJobs(i: { attemptId: string; itemId: string; keepJobId: string; now: string }): void { db.prepare("UPDATE transcription_jobs SET status='superseded',updated_at=? WHERE attempt_id=? AND item_id=? AND id!=? AND status IN ('queued','running','retry_wait','awaiting_score')").run(i.now,i.attemptId,i.itemId,i.keepJobId); },
    /**
     * One section's current Band Estimate: the query `getLatestEstimates` is built from, imported
     * rather than restated, for the one section a test is asserting about.
     */
    latestEstimate(section: string): LatestEstimateRow | undefined {
      return selectLatestEstimate(db, section);
    },
    getSupersession(setId: string): SupersededSetRow | undefined {
      return db.prepare("SELECT * FROM superseded_sets WHERE set_id=?").get(setId) as SupersededSetRow | undefined;
    },
    // Oldest first: reading a failure means replaying the attempts in the order they happened.
    listModelCallsByContext(context: { kind: string; id: string }): ModelCallRow[] {
      const normalized = db.prepare(`SELECT
          ma.id, pe.provider, ma.model, ri.operation AS route, ri.operation AS task,
          ri.context_kind,ri.context_id,ri.context_detail,ma.sequence-1 AS attempt_index,
          COALESCE(ma.prompt,'') AS prompt,ma.response,
          CASE ma.outcome WHEN 'success' THEN 'succeeded' ELSE 'failed' END AS outcome,
          ma.failure_kind,pe.queue_ms,ma.duration_ms,ma.created_at
        FROM route_invocations ri JOIN provider_executions pe ON pe.route_invocation_id=ri.id
        JOIN model_attempts ma ON ma.provider_execution_id=pe.id
        WHERE ri.context_kind=? AND ri.context_id=? ORDER BY ri.queued_at_ms,pe.sequence,ma.sequence`).all(context.kind,context.id) as ModelCallRow[];
      return normalized.sort((a,b)=>a.created_at.localeCompare(b.created_at));
    },
    getRouteInvocation(id: string): RouteInvocationRow | undefined {
      return db.prepare("SELECT * FROM route_invocations WHERE id=?").get(id) as RouteInvocationRow | undefined;
    },
    listModelAttempts(providerExecutionId: string): ModelAttemptRow[] {
      return db.prepare("SELECT * FROM model_attempts WHERE provider_execution_id=? ORDER BY sequence").all(providerExecutionId) as ModelAttemptRow[];
    },
    listProviderExecutions(routeInvocationId:string):ProviderExecutionRow[]{
      return db.prepare("SELECT * FROM provider_executions WHERE route_invocation_id=? ORDER BY sequence").all(routeInvocationId) as ProviderExecutionRow[];
    },
    seedScoringJob(row: Partial<ScoringJobRow> & { id: string; attempt_id: string }): ScoringJobRow {
      insertRow(db, "scoring_jobs", { task_type: "email", item_ids: "[]", ...row });
      return db.prepare("SELECT * FROM scoring_jobs WHERE id=?").get(row.id) as ScoringJobRow;
    },
    seedTranscriptionJob(
      row: Partial<TranscriptionJobRow> & { id: string; attempt_id: string; item_id: string },
    ): TranscriptionJobRow {
      // created_at/updated_at have no schema default here: the store's writers stamp the caller's now.
      const now = sqliteTimestamp();
      insertRow(db, "transcription_jobs", {
        task_type: "listen_repeat",
        audio_path: `audio/responses/${row.attempt_id}/${row.item_id}.webm`,
        audio_sha256: "a".repeat(64),
        created_at: now,
        updated_at: now,
        ...row,
      });
      return db.prepare("SELECT * FROM transcription_jobs WHERE id=?").get(row.id) as TranscriptionJobRow;
    },
    // An omitted field leaves its column untouched, and an explicit value (null included) sets it.
    // updated_at always advances to now.
    seedScoringJobState(u: { id: string; status?: string; stage?: string | null; progress?: string | null; result?: string | null; error?: string | null }): void {
      const sets: string[] = [];
      const params: unknown[] = [];
      for (const [column, value] of [["status", u.status], ["stage", u.stage], ["progress", u.progress], ["result", u.result], ["error", u.error]] as const) {
        if (value === undefined) continue;
        sets.push(`${column}=?`);
        params.push(value);
      }
      sets.push("updated_at=datetime('now')");
      db.prepare(`UPDATE scoring_jobs SET ${sets.join(", ")} WHERE id=?`).run(...params, u.id);
    },
    countSectionEstimates(attemptId: string): number {
      return (db.prepare("SELECT COUNT(*) AS n FROM section_estimates WHERE attempt_id=?").get(attemptId) as { n: number }).n;
    },
  };
}

/** `INSERT INTO table (the row's keys) VALUES (its values)`; every column it leaves out takes its schema default. */
function insertRow(db: Database.Database, table: string, row: Record<string, unknown>): void {
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
    .run(...columns.map((column) => row[column]));
}

/**
 * Where the supersession store writes its manifest when a test does not say. A fresh path per store,
 * outside config.dataDir, created only if the test actually retires a Set.
 */
function scratchSupersessionManifestPath(): string {
  return path.join(os.tmpdir(), "toefl-test-supersessions", randomUUID(), "supersessions.json");
}

type SqliteStoresOptions = { supersessionManifestPath?: string };

/** The shipped half of `sqliteStores`: the fifteen real adapters, merged and otherwise as is. */
function productionStatements(db: Database.Database, options: SqliteStoresOptions = {}) {
  return {
    dbFile: db.name,
    ...createSqliteAttemptStore(db),
    ...createSqliteEstimateStore(db),
    ...createSqliteSettingsStore(db),
    ...createSqliteTranscriptionJobStore(db),
    ...createSqliteRecordingStore(db),
    ...createSqliteScoringJobStore(db),
    ...createSqliteGenerationStore(db),
    ...createSqlitePublicationStore(db),
    ...createSqliteSupersessionStore(db, options.supersessionManifestPath ?? scratchSupersessionManifestPath()),
    ...createSqliteDiagnosticStore(db),
    ...createSqliteClipMeasurementStore(db),
    ...createSqliteExecutionLeaseStore(db),
    ...createSqliteProviderQuotaStore(db),
    ...createSqliteFullTestStore(db),
    ...createSqliteDrillLabStore(db),
  };
}

/**
 * The two halves unmerged, for the disjointness guard in sqliteStores.test.ts. Returns the same
 * objects the merge below consumes rather than a hand-maintained list of names: a guard that mirrors
 * the thing it guards drifts from it, so it has to read the thing itself.
 */
export function sqliteStoreHalves(db: Database.Database) {
  return { production: productionStatements(db), testOnly: testOnlyStatements(db) };
}

/**
 * Every aggregate over one database, merged, plus the test-only statements above. The merge is what
 * makes this a test helper rather than a store: production composes the same adapters into narrow
 * ports instead (src/db/stores/index.ts).
 *
 * The test-only half is spread last, so a name present in both would resolve to the test-only copy
 * silently: the production statement it shadows would never run, and its tests would stay green.
 * Adding a `latestEstimate` method to the estimate store is the likeliest such collision.
 * sqliteStores.test.ts's disjointness case turns a collision into a failing suite; do not delete it,
 * and do not reorder these spreads to quiet a collision it reports: one of the two names has to go.
 */
export function sqliteStores(db: Database.Database, options: SqliteStoresOptions = {}) {
  return {
    ...productionStatements(db, options),
    ...testOnlyStatements(db),
  };
}

/** `sqliteStores(openDb(file))` in one call — the shape most test files want. */
export function openSqliteStores(file = ":memory:") {
  return sqliteStores(openDb(file));
}
