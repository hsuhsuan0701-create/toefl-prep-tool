import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sqliteTimestamp, type SqliteTimestamp } from "../db/timestamps.js";
import { isCleanableSetKind, unpublishedSetCleanupTargets } from "./setArtifacts.js";

export type PublicationIntent = {
  child_id: string;
  set_id: string;
  expected_kind: string;
  staging_path: string;
  canonical_path: string;
  content_hash: string;
};

/**
 * The publication-intent and cleanup-debt members of the generation store
 * (db/stores/publication.ts). GenerationJobStore composes it rather than restating them.
 */
export type PublicationRepo = CleanupDebtRepo & {
  listUnreconciledGenerationPublicationIntents(): unknown[];
  markGenerationPublicationComplete(input: { childId: string; now: SqliteTimestamp }): boolean;
  abandonGenerationPublicationIntent(input: { childId: string; error: string; now: SqliteTimestamp }): boolean;
};

export type CleanupDebtRecoveryRepo = {
  listPendingCleanupDebt(): unknown[];
  completeCleanupDebt(input: { id: string; now: SqliteTimestamp }): boolean;
  failCleanupDebt(input: { id: string; error: string }): boolean;
};
export type CleanupDebtRepo = CleanupDebtRecoveryRepo & {
  createCleanupDebt(input: { id: string; childId?: string; path: string; now: SqliteTimestamp }): void;
};

/**
 * Records each path as cleanup debt before removing it, so a removal that fails (or a crash before
 * it) is retried at boot by `reconcileCleanupDebt`.
 */
export function persistAndReconcileCleanupDebt(
  repo: CleanupDebtRepo,
  childId: string,
  paths: string[],
  remove: (path: string) => void = (target) => fs.rmSync(target, { recursive: true, force: true }),
): { completed: number; failed: number } {
  let completed = 0;
  let failed = 0;
  for (const target of paths) {
    const id = crypto.createHash("sha256").update(`${childId}\0${target}`).digest("hex");
    repo.createCleanupDebt({ id, childId, path: target, now: sqliteTimestamp() });
    try {
      remove(target);
      if (repo.completeCleanupDebt({ id, now: sqliteTimestamp() })) completed += 1;
    } catch (error) {
      repo.failCleanupDebt({ id, error: error instanceof Error ? error.name : "cleanup failure" });
      failed += 1;
    }
  }
  return { completed, failed };
}

/** Retries filesystem cleanup only; missing targets count as successfully reconciled. */
export function reconcileCleanupDebt(repo: CleanupDebtRecoveryRepo): { completed: number; failed: number } {
  let completed = 0;
  let failed = 0;
  for (const raw of repo.listPendingCleanupDebt()) {
    const debt = raw as { id: string; path: string };
    try {
      fs.rmSync(debt.path, { recursive: true, force: true });
      if (repo.completeCleanupDebt({ id: debt.id, now: sqliteTimestamp() })) completed += 1;
    } catch (error) {
      repo.failCleanupDebt({ id: debt.id, error: error instanceof Error ? error.name : "cleanup failure" });
      failed += 1;
    }
  }
  return { completed, failed };
}

/**
 * Whether `filePath` is a regular file holding exactly the promised bytes. Anything else at the path
 * (nothing, a directory, a symlink, a file it cannot read) is not those bytes, and says so rather
 * than throwing: the caller is settling a job, and at boot a throw would end recovery.
 */
function hasExpectedHash(filePath: string, expected: string): boolean {
  try {
    if (!fs.lstatSync(filePath).isFile()) return false;
    const actual = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    return actual === expected;
  } catch {
    return false;
  }
}

/** Moves the staged bytes into place, reporting whether the rename happened rather than throwing. */
function placeStagedBytes(intent: PublicationIntent): boolean {
  try {
    fs.mkdirSync(path.dirname(intent.canonical_path), { recursive: true });
    fs.renameSync(intent.staging_path, intent.canonical_path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Settles one publication intent by the bytes on disk, never by what the job that staged them
 * believed: a canonical file with the promised hash completes it, a staging file with that hash is
 * renamed into place and completes it, and anything else abandons it and fails the job.
 *
 * The live runner calls this for its own intent when a publication dies mid-rename (generationJobs.ts),
 * so the row is settled at once rather than at the next boot. It is single-intent on purpose: the
 * repo-wide sweep below is safe only at boot, where nothing else is mid-publication. Run against a
 * live process, it would move another job's staging file into place and mark that job 'done' while
 * it is still running.
 */
export function reconcileGenerationPublicationIntent(
  repo: PublicationRepo,
  intent: PublicationIntent,
): "completed" | "failed" | "unclaimed" {
  if (hasExpectedHash(intent.canonical_path, intent.content_hash)) {
    return repo.markGenerationPublicationComplete({ childId: intent.child_id, now: sqliteTimestamp() }) ? "completed" : "unclaimed";
  }
  if (hasExpectedHash(intent.staging_path, intent.content_hash) && placeStagedBytes(intent)) {
    return repo.markGenerationPublicationComplete({ childId: intent.child_id, now: sqliteTimestamp() }) ? "completed" : "unclaimed";
  }
  // Neither copy of the bytes hashes to what the intent promised, or the staged copy cannot be moved
  // into place (something other than this Set holds the canonical path), so the promise cannot be
  // kept.
  // This goes through abandonGenerationPublicationIntent, not failGenerationJobConditional: that
  // writer refuses any job holding a live intent, and every row reaching this line holds one, so it
  // would leave the job 'running' and the intent re-examined on every boot.
  if (repo.abandonGenerationPublicationIntent({
    childId: intent.child_id,
    error: "invalid interrupted publication artifact",
    now: sqliteTimestamp(),
  }) && isCleanableSetKind(intent.expected_kind)) {
    // The abandon has failed the job, so failInterruptedGenerationJobs' sweep (which lists only
    // queued|running rows) will never reach it. This removes its orphans instead: the unusable
    // staging JSON plus any audio and scene image already rendered under the same set id.
    persistAndReconcileCleanupDebt(repo, intent.child_id, unpublishedSetCleanupTargets(intent.expected_kind, intent.set_id));
  }
  return "failed";
}

/** Reconciles only already-prepared bytes. It never invokes reasoning, media, or fallback work. */
export function reconcileGenerationPublications(repo: PublicationRepo): { completed: number; failed: number } {
  let completed = 0;
  let failed = 0;
  for (const raw of repo.listUnreconciledGenerationPublicationIntents()) {
    const verdict = reconcileGenerationPublicationIntent(repo, raw as PublicationIntent);
    if (verdict === "completed") completed += 1;
    else if (verdict === "failed") failed += 1;
  }
  return { completed, failed };
}
