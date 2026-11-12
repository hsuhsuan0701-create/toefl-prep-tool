import fs from "node:fs";
import path from "node:path";
import { config } from "../lib/config.js";
import type { ClipTakeDisposition } from "../db/rows.js";
import { parseSqliteTimestamp, sqliteTimestamp } from "../db/timestamps.js";
import {
  markPublishedClipTake,
  recordClipMeasurement,
  type ClipMeasurementEntry,
  type ClipMeasurementStore,
} from "./clipMeasurementLog.js";
import { modelCallPruneCutoff } from "./modelCallLog.js";
import type { BootRecoveryServer } from "./scoringJobs.js";
import { safeErrorDescriptor } from "./transcriptionRecovery.js";

/**
 * Makes a render's clip measurements travel with its audio. `clip_measurements` rows live in the
 * database of the checkout whose process did the rendering, but a Set moves between checkouts as
 * files (its JSON and its audio directory), so a batch rendered in a git worktree would leave its
 * measurements behind. Each render's `audio-manifest.json`, written into the Set's own audio
 * directory, therefore carries every take, and a boot pass replays them into the local database.
 * A shared database is not the alternative: `config.dataDir` is per checkout so that generation in a
 * worktree cannot touch the User's practice history.
 *
 * A manifest without `takes` is skipped rather than reconstructed from its `clips`, which lack
 * `correctionCount`, `inBand` and `accent`: invented values would be indistinguishable from measured
 * ones.
 */

/**
 * One synthesis attempt, as it travels inside a render's manifest. Measurements and identifiers only:
 * never clip text, a scenario, an interview question, a prompt or a provider payload. `file` is a
 * generated clip name such as 'lr-6.mp3'. The manifest itself is never served (routes/audio.ts serves
 * only audio), because per-clip `wordCount` would reveal each Listen and Repeat answer's length.
 *
 * `measurementId` is the id of the live `clip_measurements` row: the join key across checkouts, and
 * why replaying a manifest into a database that already holds its rows inserts nothing.
 *
 * `disposition` starts 'discarded', because when a take is measured the take it will be compared
 * with may not exist yet, and is changed once, by `publishClipTake`, for the take that ships.
 *
 * Not carried: `contextKind`/`contextId` (a job id in the rendering checkout, meaningless elsewhere)
 * and `speed` (always 1; pace is steered by the prompt).
 */
export type ClipTakeRecord = {
  readonly measurementId: string;
  readonly role: string;
  readonly file: string;
  readonly wordCount: number;
  readonly durationSec: number;
  readonly wpm: number;
  /**
   * Which round produced this take: 0 for the first, then the corrective round's number. Any
   * non-negative integer, since a Listening clip may buy several rounds.
   */
  readonly correctionCount: number;
  readonly inBand: boolean;
  readonly accent?: string;
  readonly profileVersion: string;
  disposition: ClipTakeDisposition;
};

/** The fields both renderers' `audio-manifest.json` carry for replay. */
export type ClipTakeManifestFields = {
  readonly setId: string;
  /** Real ISO-8601, like a Set's own `createdAt` — a manifest is a JSON artifact, not a SQLite row. */
  readonly renderedAt: string;
  readonly takes: readonly ClipTakeRecord[];
};

/**
 * Records one take in `clip_measurements` and returns its manifest record. Both renderers record
 * takes only through here.
 */
export function recordClipTake(
  entry: ClipMeasurementEntry & { readonly correctionCount: number; readonly profileVersion: string },
): ClipTakeRecord {
  return {
    measurementId: recordClipMeasurement(entry),
    role: entry.role,
    file: entry.file,
    wordCount: entry.wordCount,
    durationSec: entry.durationSec,
    wpm: entry.wpm,
    correctionCount: entry.correctionCount,
    inBand: entry.inBand,
    ...(entry.accent === undefined ? {} : { accent: entry.accent }),
    profileVersion: entry.profileVersion,
    disposition: "discarded",
  };
}

/**
 * Names the take that shipped in the render's manifest record. The renderer calls it right after
 * renaming that take into its published name; the database row follows in `markPublishedTakes`,
 * once the manifest carrying this record is on disk.
 */
export function publishClipTake(take: ClipTakeRecord): void {
  take.disposition = "published";
}

/**
 * Marks every published take's `clip_measurements` row 'published'. The renderer calls it once its
 * audio-manifest.json is written, and not before: until then the render can still fail and delete its
 * whole output directory, and a row already marked would claim audio that never shipped.
 *
 * It does not close every such window. After the renderer returns, the generator can still refuse or
 * cancel the Set's publication and remove the audio, with these rows already marked. And a crash
 * between the manifest write and this loop leaves the rows 'discarded': the manifest still records
 * which take shipped, but the boot replay inserts only missing rows and does not promote existing
 * ones.
 */
export function markPublishedTakes(takes: readonly ClipTakeRecord[]): void {
  for (const take of takes) {
    if (take.disposition === "published") markPublishedClipTake(take.measurementId);
  }
}

// ---------------------------------------------------------------------------------------------
// Reading a manifest back
// ---------------------------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Reads the replay fields out of a parsed manifest, or `undefined` if it does not carry them.
 *
 * All or nothing per manifest: one malformed take rejects the whole file, because a partly replayed
 * render looks complete and is not. A manifest that predates the fields also returns `undefined`.
 */
export function parseClipTakeManifest(value: unknown): ClipTakeManifestFields | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.takes)) return undefined;
  if (typeof raw.setId !== "string" || !raw.setId) return undefined;
  if (typeof raw.renderedAt !== "string" || Number.isNaN(new Date(raw.renderedAt).getTime())) return undefined;

  const takes: ClipTakeRecord[] = [];
  for (const entry of raw.takes) {
    if (!entry || typeof entry !== "object") return undefined;
    const t = entry as Record<string, unknown>;
    if (typeof t.measurementId !== "string" || !t.measurementId) return undefined;
    if (typeof t.role !== "string" || typeof t.file !== "string" || typeof t.profileVersion !== "string") return undefined;
    if (!isFiniteNumber(t.wordCount) || !isFiniteNumber(t.durationSec) || !isFiniteNumber(t.wpm)) return undefined;
    if (!isFiniteNumber(t.correctionCount) || !Number.isInteger(t.correctionCount) || t.correctionCount < 0) {
      return undefined;
    }
    if (typeof t.inBand !== "boolean") return undefined;
    if (t.disposition !== "published" && t.disposition !== "discarded") return undefined;
    if (t.accent !== undefined && typeof t.accent !== "string") return undefined;
    takes.push({
      measurementId: t.measurementId,
      role: t.role,
      file: t.file,
      wordCount: t.wordCount,
      durationSec: t.durationSec,
      wpm: t.wpm,
      correctionCount: t.correctionCount,
      inBand: t.inBand,
      ...(t.accent === undefined ? {} : { accent: t.accent }),
      profileVersion: t.profileVersion,
      disposition: t.disposition,
    });
  }
  return { setId: raw.setId, renderedAt: raw.renderedAt, takes };
}

/**
 * Every `audio-manifest.json` under `<dataDir>/audio/stimuli`: both renderers write one directly into
 * each Set's own audio directory.
 */
function manifestPaths(dataDir: string): string[] {
  const root = path.join(dataDir, "audio/stimuli");
  let setDirs: fs.Dirent[];
  try {
    setDirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // No rendered audio in this checkout at all.
  }
  return setDirs
    .filter((setDir) => setDir.isDirectory())
    .map((setDir) => path.join(root, setDir.name, "audio-manifest.json"))
    .filter((file) => fs.existsSync(file));
}

export type ClipMeasurementReconciliation = { manifests: number; inserted: number };

/**
 * Replays every manifest's takes into the local `clip_measurements`.
 *
 * Idempotent by row id (the store inserts OR IGNORE), so this is safe to run on every boot, safe to
 * run in the checkout that did the rendering, and safe to run twice.
 *
 * `olderThan` is the SAME retention cutoff the prune uses, and skipping manifests older than it is
 * not an optimisation: without it, every boot would re-insert rows that the prune running moments
 * later in the same boot deletes again, forever. A render older than the retention window is one the
 * retention policy has already decided not to keep.
 *
 * Each take's `created_at` is the RENDER's instant, not this moment — a row that claimed to be new
 * would be exempt from retention it has already outlived, and would misdate every "when was this
 * bank rendered" query. Converted through db/timestamps.ts, the one home for that form.
 */
export function reconcileClipMeasurementsFromManifests(input: {
  dataDir: string;
  repo: Pick<ClipMeasurementStore, "insertClipMeasurement">;
  olderThan?: Date;
}): ClipMeasurementReconciliation {
  let manifests = 0;
  let inserted = 0;
  for (const file of manifestPaths(input.dataDir)) {
    let parsed: ClipTakeManifestFields | undefined;
    try {
      parsed = parseClipTakeManifest(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      continue; // Unreadable or not JSON: a diagnostic replay must never be the thing that fails.
    }
    if (!parsed) continue;
    const renderedAt = new Date(parsed.renderedAt);
    if (input.olderThan && renderedAt.getTime() < input.olderThan.getTime()) continue;
    manifests += 1;
    for (const take of parsed.takes) {
      input.repo.insertClipMeasurement({
        id: take.measurementId,
        setId: parsed.setId,
        role: take.role,
        file: take.file,
        wordCount: take.wordCount,
        durationSec: take.durationSec,
        wpm: take.wpm,
        // The constant both renderers write: pace is steered by the prompt, not a rate setting.
        speed: 1,
        correctionCount: take.correctionCount,
        ...(take.accent === undefined ? {} : { accent: take.accent }),
        profileVersion: take.profileVersion,
        inBand: take.inBand,
        takeDisposition: take.disposition,
        createdAt: sqliteTimestamp(renderedAt),
      });
      inserted += 1;
    }
  }
  return { manifests, inserted };
}

/**
 * Registers the replay as a boot pass (housekeeping phase, ahead of the prune; see
 * bootRecoveryRegistry.ts). Boot passes run once this process holds the database's execution lease,
 * so the replay cannot race a live predecessor. Failures are logged and swallowed: a throwing
 * listener would stop the passes after it, and housekeeping must never take a recovery pass down.
 */
export function wireClipMeasurementReconciliation(
  server: BootRecoveryServer,
  repo: Pick<ClipMeasurementStore, "insertClipMeasurement">,
  dataDir: string = config.dataDir,
  retentionDays: number = config.modelCallRetentionDays,
  now: () => Date = () => new Date(),
): void {
  server.on("listening", () => {
    try {
      const result = reconcileClipMeasurementsFromManifests({
        dataDir,
        repo,
        // modelCallPruneCutoff returns the on-disk space form; parseSqliteTimestamp is its correct
        // inverse, where `new Date(...)` would read it as local time and shift the retention edge.
        ...(retentionDays > 0
          ? { olderThan: parseSqliteTimestamp(modelCallPruneCutoff(now(), retentionDays)) }
          : {}),
      });
      if (result.inserted > 0) {
        console.log(
          `[server] clip measurements: replayed ${result.inserted} take(s) from ${result.manifests} render manifest(s)`,
        );
      }
    } catch (err) {
      console.error("[server] clip measurement reconciliation failed:", safeErrorDescriptor(err));
    }
  });
}
