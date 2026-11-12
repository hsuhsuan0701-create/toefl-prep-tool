import type Database from "better-sqlite3";
import type { CancellationReason } from "@toefl-prep/shared";
import type { ClipMeasurementInsert, ClipTakeDisposition, DiagnosticOutcome, ModelAttemptInsert, ProviderExecutionInsert, RouteInvocationInsert } from "../rows.js";
import type { ModelDiagnosticStore } from "../../services/modelCallRecorder.js";
import type { DatabaseFreeSpace, DiagnosticRetentionStore } from "../../services/modelCallLog.js";
import type { ClipMeasurementStore } from "../../services/clipMeasurementLog.js";

// ---------------------------------------------------------------------------------------------
// The model-diagnostics aggregate, over SQLite (docs/adr/0004)
// ---------------------------------------------------------------------------------------------
//
// Tables: `route_invocations` -> `provider_executions` -> `model_attempts`. Local-only, exposed by
// no route or UI, never read by scoring.
//
// Write-only by construction: nothing in production reads these rows back. The suite reads them
// through its own probe (server/test/helpers/sqliteStores.ts), and a person debugging a job uses the
// sqlite3 query ADR 0004 gives.
//
// Every `*_at_ms` column holds epoch milliseconds (Date.now()), for the CLI routes and the HTTP
// calls alike, so ordering by `queued_at_ms` follows when calls ran, across restarts too. Rows from
// before that rule can hold a CLI route's stamps as milliseconds since its process started, which
// sort before every epoch value; they are not rewritten, and retention prunes them.

export function createSqliteDiagnosticStore(db: Database.Database) {
  return {
    insertRouteInvocation(r: RouteInvocationInsert): void {
      db.prepare(`INSERT INTO route_invocations
        (id,operation,family,context_kind,context_id,context_detail,queued_at_ms,finished_at_ms,duration_ms,outcome,failure_kind,cancellation_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(r.id,r.operation,r.family,r.contextKind??null,r.contextId??null,r.contextDetail??null,
          Math.round(r.queuedAtMs),r.finishedAtMs===undefined?null:Math.round(r.finishedAtMs),r.durationMs===undefined?null:Math.round(r.durationMs),
          r.outcome??null,r.failureKind??null,r.cancellationReason??null);
    },
    finishRouteInvocation(r: { id: string; finishedAtMs: number; durationMs: number; outcome: DiagnosticOutcome; failureKind?: string; cancellationReason?: CancellationReason }): boolean {
      return db.prepare(`UPDATE route_invocations SET finished_at_ms=?,duration_ms=?,outcome=?,failure_kind=?,cancellation_reason=?
        WHERE id=? AND outcome IS NULL`).run(Math.round(r.finishedAtMs),Math.round(r.durationMs),r.outcome,r.failureKind??null,r.cancellationReason??null,r.id).changes===1;
    },
    insertProviderExecution(e: ProviderExecutionInsert): void {
      db.prepare(`INSERT INTO provider_executions
        (id,route_invocation_id,sequence,provider,family,operation,queued_at_ms,dequeued_at_ms,started_at_ms,finished_at_ms,queue_ms,duration_ms,outcome,failure_kind,cancellation_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(e.id,e.routeInvocationId,e.sequence,e.provider,e.family,e.operation,
          Math.round(e.queuedAtMs),e.dequeuedAtMs===undefined?null:Math.round(e.dequeuedAtMs),e.startedAtMs===undefined?null:Math.round(e.startedAtMs),
          e.finishedAtMs===undefined?null:Math.round(e.finishedAtMs),e.queueMs===undefined?null:Math.round(e.queueMs),e.durationMs===undefined?null:Math.round(e.durationMs),
          e.outcome??null,e.failureKind??null,e.cancellationReason??null);
    },
    insertModelAttempt(a: ModelAttemptInsert): void {
      db.prepare(`INSERT INTO model_attempts
        (id,provider_execution_id,sequence,kind,model,prompt,prompt_omitted_bytes,response,response_omitted_bytes,started_at_ms,finished_at_ms,duration_ms,outcome,failure_kind,cancellation_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(a.id,a.providerExecutionId,a.sequence,a.kind,a.model??null,a.prompt??null,a.promptOmittedBytes??0,
          a.response??null,a.responseOmittedBytes??0,Math.round(a.startedAtMs),a.finishedAtMs===undefined?null:Math.round(a.finishedAtMs),
          a.durationMs===undefined?null:Math.round(a.durationMs),a.outcome??null,a.failureKind??null,a.cancellationReason??null);
    },
    // Strictly older than the cutoff — a row stamped exactly at the boundary is kept, so that
    // "retain N days" cannot silently discard the oldest day it promised to keep. Deleting a route
    // invocation deletes its executions and attempts by cascade. Returns the invocations deleted.
    pruneNormalizedModelCalls(olderThan: string): number {
      return db.prepare("DELETE FROM route_invocations WHERE created_at < ?").run(olderThan).changes;
    },
    // The space a prune frees, and the three ways of giving it back. These act on the whole
    // database file, and they live here because diagnostics are what frees it: they are nearly all
    // of what the file holds and the only rows deleted in bulk.
    freeSpace(): DatabaseFreeSpace {
      return {
        pageSize: db.pragma("page_size", { simple: true }) as number,
        pageCount: db.pragma("page_count", { simple: true }) as number,
        freePages: db.pragma("freelist_count", { simple: true }) as number,
        incremental: db.pragma("auto_vacuum", { simple: true }) === 2,
      };
    },
    // Moves up to `maxPages` free pages to the end of the file and truncates them away, in one
    // short write. A no-op unless auto_vacuum is INCREMENTAL.
    reclaimFreePages(maxPages: number): void {
      if (!Number.isSafeInteger(maxPages) || maxPages <= 0) throw new Error(`invalid page count ${maxPages}`);
      db.pragma(`incremental_vacuum(${maxPages})`);
    },
    // Rewrites the whole file without its free pages, switching it to incremental auto-vacuum on
    // the way (the only way an existing database can be switched), then truncates the write-ahead
    // log the rewrite went through. Holds the write lock for the whole rewrite.
    compactDatabase(): void {
      db.pragma("auto_vacuum = INCREMENTAL");
      db.exec("VACUUM");
      db.pragma("wal_checkpoint(TRUNCATE)");
    },
    // Copies the write-ahead log into the database file without waiting on any other connection,
    // which is when pages an incremental vacuum removed actually leave the file.
    checkpointWal(): void {
      db.pragma("wal_checkpoint(PASSIVE)");
    },
  } satisfies ModelDiagnosticStore & Omit<DiagnosticRetentionStore, "pruneClipMeasurements">;
}

// ---------------------------------------------------------------------------------------------
// The `clip_measurements` aggregate, over SQLite
// ---------------------------------------------------------------------------------------------
//
// One writer, one age-based deleter, one take promoter, and never any clip text (see
// clipMeasurementLog.ts). A separate adapter from the model-diagnostics one because the two tables
// answer to different ports and grow at very different rates, which is why retention is asserted per
// table.

export function createSqliteClipMeasurementStore(db: Database.Database) {
  return {
    // One row per synthesis attempt, discarded corrections included (schema.sql on
    // clip_measurements).
    //
    // OR IGNORE and a supplied `created_at` serve the second way a row arrives: replayed from a
    // render's audio-manifest.json, possibly in another checkout. The manifest records the id the live
    // row was given, so the id makes the replay idempotent, and reconciling in the checkout that
    // rendered inserts nothing. The live path passes neither field: its id is a fresh randomUUID, and
    // an omitted `createdAt` falls through to SQLite's `datetime('now')`, the same space form
    // db/timestamps.ts mints.
    insertClipMeasurement(c: ClipMeasurementInsert) {
      db.prepare(
        `INSERT OR IGNORE INTO clip_measurements
           (id, set_id, context_kind, context_id, role, file, word_count, duration_sec, wpm,
            speed, correction_count, accent, profile_version, in_band, take_disposition, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?, datetime('now')))`
      ).run(
        c.id, c.setId, c.contextKind ?? null, c.contextId ?? null, c.role, c.file,
        c.wordCount, c.durationSec, c.wpm, c.speed, c.correctionCount,
        c.accent ?? null, c.profileVersion ?? null, c.inBand ? 1 : 0,
        c.takeDisposition ?? null, c.createdAt ?? null,
      );
    },
    /**
     * Promotes one already-recorded take to the one that shipped. Called by the renderer straight
     * after the fs.rename that publishes it, so the flag is written by the code path that
     * decides what ships. Addressed by row id — never by (set_id, file) — because a Set re-rendered
     * later has rows for the same clip from BOTH renders and a predicate would reach into the older
     * one.
     */
    markClipMeasurementTake(id: string, disposition: ClipTakeDisposition): void {
      db.prepare("UPDATE clip_measurements SET take_disposition = ? WHERE id = ?").run(disposition, id);
    },
    pruneClipMeasurements(olderThan: string): number {
      return db.prepare("DELETE FROM clip_measurements WHERE created_at < ?").run(olderThan).changes;
    },
  } satisfies ClipMeasurementStore;
}
