import { randomUUID } from "node:crypto";
import type { ClipMeasurementInsert, ClipTakeDisposition } from "../db/rows.js";
import type { SqliteTimestamp } from "../db/timestamps.js";
import { currentModelCallCorrelation } from "./modelCallLog.js";

/**
 * The `clip_measurements` aggregate: one row per TTS synthesis, written once, promoted once, pruned by
 * age (ADR 0004). `createSqliteClipMeasurementStore` in db/stores/diagnostics.ts is the SQLite
 * adapter.
 *
 * `markClipMeasurementTake` is the only change a row accepts after it is written, and it changes one
 * column: which take shipped is not knowable at insert time, because the better take wins and the
 * take it is compared with has not been bought yet.
 *
 * `pruneClipMeasurements` compares `created_at < ?` as a string, so its cutoff is a `SqliteTimestamp`
 * (db/timestamps.ts); a cutoff in another format would silently break retention on the faster-growing
 * of the two diagnostic tables.
 */
export type ClipMeasurementStore = {
  insertClipMeasurement(c: ClipMeasurementInsert): void;
  markClipMeasurementTake(id: string, disposition: ClipTakeDisposition): void;
  pruneClipMeasurements(olderThan: SqliteTimestamp): number;
};

type Repo = Pick<ClipMeasurementStore, "insertClipMeasurement" | "markClipMeasurementTake">;

/**
 * The TTS counterpart to modelCallLog; schema.sql documents the `clip_measurements` table.
 *
 * Measurements and correlating identifiers only: never clip text, a scenario, an interview question,
 * a prompt or a provider payload. The entry shape below enforces it, since no field takes free text.
 */

export interface ClipMeasurementEntry {
  readonly setId: string;
  readonly role: string;
  readonly file: string;
  readonly wordCount: number;
  readonly durationSec: number;
  readonly wpm: number;
  readonly speed: number;
  readonly correctionCount: number;
  readonly accent?: string;
  readonly profileVersion?: string;
  readonly inBand: boolean;
}

/**
 * Recording a take, and later naming the take that shipped. One object rather than two setters so a
 * sink is never half installed: an insert without the promotion would leave every row reading
 * 'discarded'.
 */
export type ClipMeasurementSink = {
  insert(row: ClipMeasurementInsert): void;
  markTake(id: string, disposition: ClipTakeDisposition): void;
};

const NO_OP_SINK: ClipMeasurementSink = { insert: () => undefined, markTake: () => undefined };

let sink: ClipMeasurementSink = NO_OP_SINK;

/**
 * Installs where rows go. Until a process installs one (index.ts, and the generate/import scripts),
 * every write is a no-op.
 */
export function setClipMeasurementSink(next: ClipMeasurementSink): void {
  sink = next;
}

export function createRepoClipMeasurementSink(repo: Repo): ClipMeasurementSink {
  return {
    insert: (row) => repo.insertClipMeasurement(row),
    markTake: (id, disposition) => repo.markClipMeasurementTake(id, disposition),
  };
}

/** Test seam: drops back to the no-op sink so one test's rows cannot leak into the next. */
export function resetClipMeasurementSink(): void {
  sink = NO_OP_SINK;
}

/**
 * Records one synthesis attempt as 'discarded' and returns the row id, so the caller can name the
 * take that ships later (markPublishedClipTake).
 *
 * The id is minted before the write and returned even when the write throws: it also travels in the
 * render's audio manifest, and reconciling that manifest restores a row this call failed to write
 * (clipTakeManifest.ts). The id identifies the take, not a database row known to exist.
 *
 * Never throws: an observability write must not fail a render that has already been paid for.
 */
export function recordClipMeasurement(entry: ClipMeasurementEntry): string {
  const id = randomUUID();
  try {
    const correlation = currentModelCallCorrelation();
    sink.insert({
      id,
      takeDisposition: "discarded",
      setId: entry.setId,
      role: entry.role,
      file: entry.file,
      wordCount: entry.wordCount,
      durationSec: entry.durationSec,
      wpm: entry.wpm,
      speed: entry.speed,
      correctionCount: entry.correctionCount,
      inBand: entry.inBand,
      ...(entry.accent === undefined ? {} : { accent: entry.accent }),
      ...(entry.profileVersion === undefined
        ? {}
        : { profileVersion: entry.profileVersion }),
      ...(correlation === undefined
        ? {}
        : { contextKind: correlation.kind, contextId: correlation.id }),
    });
  } catch {
    // Deliberately swallowed — see this function's doc comment.
  }
  return id;
}

/**
 * Names the take that shipped. `id` is what `recordClipMeasurement` returned for that take.
 *
 * Called through clipTakeManifest's `markPublishedTakes`, once the render's manifest is on disk and
 * not before: marking early can claim a take shipped from a render that then failed and deleted its
 * audio, while marking late can only under-report, and the manifest still records which take
 * shipped. A false 'published' is indistinguishable from a true one.
 *
 * Never throws, for the same reason recordClipMeasurement does not.
 */
export function markPublishedClipTake(id: string): void {
  try {
    sink.markTake(id, "published");
  } catch {
    // Deliberately swallowed — see this function's doc comment.
  }
}
