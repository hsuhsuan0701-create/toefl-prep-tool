import { failureKeepsAudioDirectory, generateSet, type Deps as GeneratorDeps, type OnGenerationProgress } from "./generator.js";
import { cleanupUnpublishedSetArtifacts, isCleanableSetKind, unpublishedSetCleanupTargets } from "./setArtifacts.js";
import type { CancellationRequestResult, GenerationBatchRow, GenerationJobRow } from "../db/rows.js";
import type { DurableJobClaim } from "./durableJobRunner.js";
import type { BootRecoveryServer } from "./scoringJobs.js";
import type { CancellationReason, GenerationBatchStatus, GenerationProgressDetail } from "@toefl-prep/shared";
import {
  generationJobCancellations,
  JobCancelledError,
  type JobCancellationReason,
} from "./jobCancellation.js";
import { reportStrandedJob, runDurableJob } from "./durableJobRunner.js";
import { runGenerationBatchWindow } from "./generationBatchWindow.js";
import { sqliteTimestamp, type SqliteTimestamp } from "../db/timestamps.js";
import { safeErrorDescriptor } from "./transcriptionRecovery.js";
import {
  recordSupersessionOnPublication,
  type SupersessionStore,
} from "./supersession.js";
import {
  persistAndReconcileCleanupDebt,
  reconcileCleanupDebt,
  reconcileGenerationPublicationIntent,
  reconcileGenerationPublications,
  type PublicationIntent,
  type PublicationRepo,
} from "./generationPublication.js";

export type { GenerationProgress, OnGenerationProgress, GenerationStage } from "./generator.js";

// ---------------------------------------------------------------------------------------------
// Persistence port
// ---------------------------------------------------------------------------------------------

/**
 * The `generation_jobs` + `generation_batches` aggregate, as exactly the operations the job runner,
 * the batch runner and the boot sweep make. db/stores/generation.ts and db/stores/publication.ts
 * satisfy it over SQLite.
 *
 * The runners' terminal writers are conditional and report whether they won
 * (`failGenerationJobConditional`, `finishGenerationJobCancellation`,
 * `markGenerationPublicationComplete`, `abandonGenerationPublicationIntent`,
 * `settleGenerationBatch`), so a caller can report a row nothing could move instead of assuming it
 * moved. Only the boot sweep writes a batch's terminal status through the unconditional
 * `updateGenerationBatch`; it runs before this process admits any job, so nothing can race it.
 *
 * The publication-intent and cleanup-debt members come from `PublicationRepo`; this port adds the
 * two only the runner calls, `commitGenerationPublicationIntent` and
 * `getUnreconciledGenerationPublicationIntent`.
 *
 * `SupersessionStore` is the one reach outside the aggregate (`superseded_sets`): the runner is what
 * knows a replacement published. It never calls `supersedeSet` itself; `commit` goes through
 * `recordSupersessionOnPublication` (supersession.ts), which cannot be called before the replacement
 * has published. That write is not in a transaction with the job's own terminal write.
 */
export type GenerationJobStore = PublicationRepo & SupersessionStore & {
  getGenerationJob(id: string): GenerationJobRow | undefined;
  listInterruptedGenerationJobs(): GenerationJobRow[];
  listGenerationJobsByBatch(batchId: string): GenerationJobRow[];
  claimGenerationJobRunning(id: string, now?: SqliteTimestamp): DurableJobClaim;
  updateGenerationJob(u: {
    id: string;
    status?: string;
    stage?: string | null;
    progress?: string | null;
    setId?: string | null;
    error?: string | null;
  }): void;
  requestGenerationJobCancellation(i: { id: string; reason: CancellationReason; now: SqliteTimestamp }): CancellationRequestResult | undefined;
  finishGenerationJobCancellation(i: { id: string; now: SqliteTimestamp }): boolean;
  failGenerationJobConditional(i: { id: string; error: string; now: SqliteTimestamp }): boolean;
  commitGenerationPublicationIntent(i: {
    childId: string; setId: string; expectedKind: string; stagingPath: string;
    canonicalPath: string; contentHash: string; now: SqliteTimestamp;
  }): boolean;
  getUnreconciledGenerationPublicationIntent(childId: string): unknown | undefined;
  getGenerationBatch(id: string): GenerationBatchRow | undefined;
  listInterruptedGenerationBatches(): GenerationBatchRow[];
  claimGenerationBatchRunning(id: string, now?: SqliteTimestamp): DurableJobClaim;
  updateGenerationBatch(u: { id: string; status?: string; cancelRequested?: boolean; error?: string | null }): void;
  settleGenerationBatch(i: { id: string; status: GenerationBatchStatus; error?: string | null; now: SqliteTimestamp }): boolean;
};

// generateSet's injectable dependencies plus the store this runner persists progress and terminal
// state to; `batchConcurrency` overrides the batch window.
export type GenerationJobDeps = GeneratorDeps & { repo: GenerationJobStore; batchConcurrency?: number };

// `supersedesSetId`: the Set this job's output replaces. Standalone jobs only: a batch request has
// no way to name a per-child target, so runGenerationBatch never passes one.
export type RunGenerationJobInput = {
  kind: "speaking" | "writing" | "reading" | "listening";
  supersedesSetId?: string;
};

function mergeGenerationProgress(
  cumulative: GenerationProgressDetail,
  detail: GenerationProgressDetail,
): void {
  const {
    provider,
    fallbackFrom,
    queuePosition,
    position,
    ...durable
  } = detail;
  Object.assign(cumulative, durable);

  // Reasoning route fields form one current snapshot. A provider event without queue metadata is
  // dequeued/running; one without fallback metadata is direct. Clear the previous route before
  // applying the new one while retaining durable counts, set id, and scene outcome above.
  if (provider === "claude" || provider === "codex") {
    delete cumulative.provider;
    delete cumulative.fallbackFrom;
    delete cumulative.queuePosition;
    delete cumulative.position;
    cumulative.provider = provider;
    if (
      (fallbackFrom === "claude" || fallbackFrom === "codex") &&
      fallbackFrom !== provider
    ) {
      cumulative.fallbackFrom = fallbackFrom;
    }
    if (typeof queuePosition === "number") {
      cumulative.queuePosition = queuePosition;
    }
    if (typeof position === "number") {
      cumulative.position = position;
    }
  }
}

/**
 * Runs one generation job in-process. routes/generate.ts starts it without awaiting it, right after
 * creating the job row. runDurableJob owns the lifecycle (admission, the claim, the progress merge,
 * the still-running guard before every terminal write, cancellation), shared with scoring; this is
 * generation's adapter, which calls generateSet and says what each step means for a
 * generation_jobs row.
 *
 * Every checkpoint generateSet reports is persisted, `setId` included from the moment it is minted,
 * so boot recovery knows what to clean up after a crash mid-run.
 *
 * Everything up to the claim runs before the first await, so a standalone job is already 'running'
 * when the route answers 202. A batch child stays 'queued' until the batch window admits it. (The
 * job status 'queued' is unrelated to the progress stage of the same name.)
 */
export async function runGenerationJob(deps: GenerationJobDeps, jobId: string, input: RunGenerationJobInput): Promise<void> {
  const repo = deps.repo;
  let publicationIntentCommitted = false;
  await runDurableJob<GenerationJobRow, GenerationProgressDetail, Awaited<ReturnType<typeof generateSet>>>({
    family: "generation",
    jobId,
    // Every model call generateSet makes, however deeply nested, records its diagnostics under this
    // job id, and ADR 0007's scheduler admits it as this job's. Each batch child installs its own.
    correlation: { kind: "generation-job", id: jobId },
    cancellations: generationJobCancellations,
    read: () => repo.getGenerationJob(jobId),
    claim: () => repo.claimGenerationJobRunning(jobId, sqliteTimestamp()),
    // A job cancelled before it started is still 'queued', passes the queued no-op, and is refused
    // by the claim, which requires no cancel stamp. Settle it here through the same terminalizer
    // every interrupted path uses, or it stays non-terminal until the next boot.
    // (cancelUnpublishedChildren is the backstop for a batch child, once the window has drained.)
    //
    // No set id was minted and no publication intent can exist (both writers refuse a row with a
    // cancel stamp), so there is nothing to clean up. The reason passed is a fallback only: the
    // request is durably recorded, so the terminalizer's first write keeps the row's own reason.
    disposeCancelRequested: (row) => terminalizeInterruptedGenerationJob(
      repo,
      jobId,
      { kind: "cancelled", reason: row.cancellation_reason ?? "user" },
      false,
    ),
    progress: {
      merge: mergeGenerationProgress,
      // detail.setId is also written to its own column, where boot recovery reads it
      // (schema.sql, generation_jobs.set_id).
      save: ({ stage, progress, detail }) => repo.updateGenerationJob({
        id: jobId,
        stage,
        progress,
        ...(detail?.setId ? { setId: detail.setId } : {}),
      }),
    },
    run: ({ signal, onProgress }) => generateSet(
      input.kind,
      {
        ...deps,
        generationOwnerId: jobId,
        abortSignal: signal,
        commitPublication: (publication) => {
          publicationIntentCommitted = repo.commitGenerationPublicationIntent({
            childId: jobId,
            expectedKind: publication.kind,
            stagingPath: publication.stagingPath,
            canonicalPath: publication.canonicalPath,
            contentHash: publication.contentHash,
            setId: publication.setId,
            now: sqliteTimestamp(),
          });
          return publicationIntentCommitted;
        },
        ...(input.supersedesSetId ? { supersedesSetId: input.supersedesSetId } : {}),
      },
      onProgress,
    ),
    commit: ({ setId }) => {
      // The last `saving` progress JSON is left intact: it carries the latest provider/fallback
      // metadata and, for Speaking, the scene outcome.
      repo.updateGenerationJob({ id: jobId, stage: "saving", setId });
      const published = repo.markGenerationPublicationComplete({ childId: jobId, now: sqliteTimestamp() });
      // The writer refuses a missing intent and one abandoned because its bytes were verified missing,
      // so `false` means this Set did not publish. Retiring the Set it replaces would then leave the
      // picker with neither.
      if (!published) {
        reportStrandedJob("generation", jobId, "done", repo.getGenerationJob(jobId)?.status);
        return;
      }
      // This branch states only what it alone knows: this job published `setId` and was asked to
      // retire `input.supersedesSetId`. supersession.ts owns the ordering and never fails the job.
      recordSupersessionOnPublication(repo, {
        jobId,
        publishedSetId: setId,
        supersedesSetId: input.supersedesSetId,
      });
    },
    fail: (err, { row }) => {
      // A late failure (schema, write, rename) can come after the audio and scene image exist. Clean
      // up while this row is still active and owns its unpublished set id: once it is terminal, boot
      // recovery never revisits it. `input.kind` rather than the row's untyped `kind` column, so the
      // cleanup's kind parameter needs no cast.
      if (err instanceof JobCancelledError) {
        if (row.set_id && !publicationIntentCommitted) {
          persistAndReconcileCleanupDebt(repo, jobId, unpublishedSetCleanupTargets(input.kind, row.set_id));
        }
        terminalizeInterruptedGenerationJob(repo, jobId, { kind: "cancelled", reason: err.reason }, publicationIntentCommitted);
      } else {
        // With a committed intent the bytes decide: the terminalizer reconciles it, and removes the
        // artifacts itself only when the Set did not publish.
        if (row.set_id && !publicationIntentCommitted) {
          cleanupUnpublishedSetArtifacts(input.kind, row.set_id, { preserveAudio: failureKeepsAudioDirectory(err) });
        }
        terminalizeInterruptedGenerationJob(
          repo,
          jobId,
          { kind: "failed", error: err instanceof Error ? err.message : String(err) },
          publicationIntentCommitted,
        );
        // Reconciliation can find the Set's bytes in place and end the job done after all. The Set
        // then published like any other, so the Set it replaces is retired the same way.
        const settled = repo.getGenerationJob(jobId);
        if (settled?.status === "done" && settled.set_id) {
          recordSupersessionOnPublication(repo, {
            jobId,
            publishedSetId: settled.set_id,
            supersedesSetId: input.supersedesSetId,
          });
        }
      }
    },
    // A no-op on every generation path that reaches it: a cancel this run observed has already been
    // settled by the terminalizer above, and generateSet cannot return successfully while a cancel
    // stamp is live (publishSet throws when its intent is refused).
    disposeCancellation: () => {
      if (repo.getGenerationJob(jobId)?.cancel_requested_at) repo.finishGenerationJobCancellation({ id: jobId, now: sqliteTimestamp() });
    },
  });
}

/** Aborts a job running in this process, in memory only. False when no such run is in flight. */
export function abortGenerationJob(jobId: string, reason: JobCancellationReason): boolean {
  return generationJobCancellations.cancel(jobId, reason);
}

/**
 * Moves an interrupted job to the terminal state its actual row permits, not the one the caller
 * assumed.
 *
 * The terminal writers' guards are mutually exclusive: 'cancelled' requires `cancel_requested_at IS
 * NOT NULL`, 'failed' requires it NULL, and both refuse a row holding a live publication intent. The
 * observed outcome and the row disagree on two ordinary paths: an abort delivered in memory only
 * (index.ts's onLeaseLost aborts every run without recording a request) leaves the row with no
 * cancel request, so the 'cancelled' writer refuses it until one is recorded below; and an error
 * arriving after a cancel was requested is refused by the 'failed' writer. So each writer's answer
 * is checked, and the other tried.
 *
 * Also called before the run, for a job cancelled while still 'queued' (see runGenerationJob's
 * claim), so the two cases share one answer.
 *
 * A row left non-terminal is worse than either outcome: a poller on that job's id waits forever, and
 * a batch parent does not wait with it, since computeBatchStatus counts a non-terminal child as not
 * done and reports the batch finished. Nothing repairs it before the next boot's sweep.
 */
function terminalizeInterruptedGenerationJob(
  repo: GenerationJobStore,
  jobId: string,
  outcome: { kind: "cancelled"; reason: JobCancellationReason } | { kind: "failed"; error: string },
  publicationIntentCommitted: boolean,
): void {
  // A committed intent outranks both outcomes. Reaching here with one means the rename in
  // setStore.publish threw, so the canonical file may or may not exist, and only the bytes can say:
  // run the byte check on this job's own intent (never the repo-wide sweep, which is boot-only).
  if (publicationIntentCommitted) {
    const intent = repo.getUnreconciledGenerationPublicationIntent(jobId);
    if (intent) {
      reconcileGenerationPublicationIntent(repo, intent as PublicationIntent);
      return;
    }
  }
  if (outcome.kind === "cancelled") {
    if (repo.finishGenerationJobCancellation({ id: jobId, now: sqliteTimestamp() })) return;
    // The abort was delivered in-memory only, so the request the 'cancelled' writer requires was
    // never durably recorded. Record it now, carrying the reason the abort itself named, and retry.
    repo.requestGenerationJobCancellation({ id: jobId, reason: outcome.reason, now: sqliteTimestamp() });
    if (repo.finishGenerationJobCancellation({ id: jobId, now: sqliteTimestamp() })) return;
  } else {
    if (repo.failGenerationJobConditional({ id: jobId, error: outcome.error, now: sqliteTimestamp() })) return;
    // A cancel was recorded while this run was failing of something else. Honour the recorded
    // request rather than the incidental error the run raised on its way out.
    if (repo.finishGenerationJobCancellation({ id: jobId, now: sqliteTimestamp() })) return;
  }
  const stranded = repo.getGenerationJob(jobId);
  if (stranded && (stranded.status === "queued" || stranded.status === "running")) {
    console.error(
      `[generationJobs] job ${jobId} could not be terminalized (status=${stranded.status}, outcome=${outcome.kind}); boot recovery will sweep it`,
    );
  }
}

export type FailInterruptedGenerationJobsSummary = { jobs: number; cleaned: number };

const INTERRUPTED_GENERATION_ERROR = "interrupted by server restart";

// --- Batch generation ---------------------------------------------------------------------------

/**
 * The one rule for what a batch is, given its children's final states. The live runner applies it
 * once every admitted child has settled, and boot recovery once every non-terminal child has been
 * swept, so a batch recovered after a crash is classified exactly as the same batch finishing live.
 *
 * 'done' when every child published; 'partial' when some did, counting cancelled children with the
 * failed ones (a Set asked for that did not land); 'cancelled' only when nothing published and some
 * child was cancelled; otherwise 'failed'. A published child outranks a cancelled sibling because a
 * child can be cancelled on its own (by its own id, or by an in-memory abort that reaches children
 * one at a time), and its siblings' Sets are real.
 */
export function computeBatchStatus(children: Pick<GenerationJobRow, "status">[]): GenerationBatchStatus {
  if (children.length === 0) return "failed"; // defensive — a batch is never created with 0 children
  const doneCount = children.filter((c) => c.status === "done").length;
  if (doneCount === children.length) return "done";
  if (doneCount > 0) return "partial";
  // Nothing published. A cancel is then the story of this batch, even beside children that failed on
  // their own; those failures stay visible on the children themselves.
  if (children.some((c) => c.status === "cancelled")) return "cancelled";
  return "failed";
}

// Called once the batch window has drained, so a 'queued' child here never started. A cancelled
// child is marked 'cancelled' rather than deleted, so the batch's `children` list shows it beside
// the Sets that did land; a child that failed on its own is left as it is.
//
// `parentCancelled` decides which children count as cancelled. With the parent cancelled, every
// unstarted child does, whether or not the batch's cancel managed to stamp its row. Otherwise only
// a child with its own durable cancel request does: a child left 'queued' for another reason
// (admissions closed by shutdown) was cancelled by no one, and boot recovery classifies that row
// 'failed'. runGenerationJob's claim normally settles an individually cancelled child as the window
// admits it; this catches one the window never reached.
//
// Only 'queued' children are touched. The window has awaited every admitted child's run, and
// runDurableJob unregisters a run's cancellation when it returns, so no child is still running in
// this process; a row still 'running' here is one whose terminal write did not land, and the boot
// sweep settles it.
function cancelUnpublishedChildren(
  repo: GenerationJobStore,
  children: GenerationJobRow[],
  options: { parentCancelled: boolean },
): void {
  for (const child of children) {
    if (child.status !== "queued") continue;
    if (!options.parentCancelled && !child.cancel_requested_at) continue;
    // The child's own recorded reason wins: a child cancelled by its own id was not cancelled by its
    // parent. With no stamp, this sweep is acting on the parent's cancellation.
    repo.requestGenerationJobCancellation({
      id: child.id,
      reason: child.cancellation_reason ?? "parent_cancelled",
      now: sqliteTimestamp(),
    });
    repo.finishGenerationJobCancellation({ id: child.id, now: sqliteTimestamp() });
  }
}

/**
 * Runs a batch's children through the bounded window (runGenerationBatchWindow), admitted in
 * `batch_index` order. Several run at once, so index order is the order children start, not finish.
 * Each child runs through the same runGenerationJob as a standalone job, which records its own
 * failure, so a failed Set does not stop the batch.
 *
 * The parent's cancel flag is read at admission only (`shouldAdmit`, before each child starts) and
 * answers "may anything else start"; it takes no child, so cancelling one child never ends the batch.
 * Cancellation is also observed elsewhere: the cancel route aborts every running child in memory, and
 * a child can be cancelled on its own (by its own id, or by a shutdown or lease-loss abort) without
 * the batch flag being set. Hence the parent's status is computed from what the children became
 * (computeBatchStatus). A child cancelled by its own id is refused by its claim inside
 * runGenerationJob before any model call, so skipping it costs only an admission slot.
 *
 * `finalizationAdmission` serializes one step of each child's tail, the publish; children plan,
 * generate, verify and render in parallel. generator.ts's finalizeAndPublishSet says why only that
 * step, and the "batch finalization gate" suites in generator.test.ts and generator.reading.test.ts
 * pin the boundary from both sides.
 */
export async function runGenerationBatch(deps: GenerationJobDeps, batchId: string): Promise<void> {
  const repo = deps.repo;
  // The parent installs no model-call correlation: every paid call is a child's, under the child's
  // own, and one shared id across children would collapse ADR 0007 admission to one FIFO. It
  // registers no cancellation either: the cancel route aborts children one at a time, and the
  // parent's flag is an admission gate, not a stop.
  await runDurableJob<GenerationBatchRow, never, void>({
    family: "generation-batch",
    jobId: batchId,
    read: () => repo.getGenerationBatch(batchId),
    claim: () => repo.claimGenerationBatchRunning(batchId, sqliteTimestamp()),
    run: async () => {
      const children = repo.listGenerationJobsByBatch(batchId);
      let finalizationTail = Promise.resolve();
      const finalizationAdmission = async <T>(run: () => Promise<T>): Promise<T> => {
        const admitted = finalizationTail.then(run, run);
        finalizationTail = admitted.then(() => undefined, () => undefined);
        return admitted;
      };
      await runGenerationBatchWindow(
        children,
        async (child) => runGenerationJob(
          { ...deps, finalizationAdmission },
          child.id,
          { kind: child.kind as "speaking" | "writing" | "reading" | "listening" },
        ),
        {
          concurrency: deps.batchConcurrency,
          shouldAdmit: () => repo.getGenerationBatch(batchId)?.cancel_requested !== 1,
        },
      );

      // Unconditional: a child can be cancelled without its parent, and cancelUnpublishedChildren
      // decides per child which case it is looking at.
      cancelUnpublishedChildren(repo, repo.listGenerationJobsByBatch(batchId), {
        parentCancelled: repo.getGenerationBatch(batchId)?.cancel_requested === 1,
      });
    },
    // The parent's status comes from what the children became, never from whether a cancel was
    // requested on the parent.
    commit: () => {
      const status = computeBatchStatus(repo.listGenerationJobsByBatch(batchId));
      if (!repo.settleGenerationBatch({ id: batchId, status, now: sqliteTimestamp() })) {
        reportStrandedJob("generation-batch", batchId, status, repo.getGenerationBatch(batchId)?.status);
      }
    },
    // No `fail` hook: a throw from the window is an invariant breaking, not a Set failing (each
    // child's failure is recorded by runGenerationJob). It propagates to routes/generate.ts's .catch,
    // and the next boot's recoverInterruptedGenerationBatches reclassifies the parent.
  });
}

// Registers failInterruptedGenerationJobs as a boot-recovery pass (bootRecoveryRegistry.ts). The
// passes run once this process holds the database's execution lease, so no other live process can
// be mid-job when it marks rows failed and deletes their half-written files.
export function wireGenerationBootRecovery(server: BootRecoveryServer, repo: GenerationJobStore): void {
  server.on("listening", () => {
    // A fault here (an unreadable artifact, a file system error) must not end the boot: the passes
    // after this one, and the server itself, do not depend on generation's leftovers being settled.
    // What this pass could not settle stays for the next boot.
    try {
      const recovery = failInterruptedGenerationJobs({ repo });
      console.log(
        `[server] generation boot recovery: ${recovery.jobs} interrupted job(s), ${recovery.cleaned} half-written artifact(s) removed`,
      );
    } catch (err) {
      console.error("[server] generation boot recovery failed:", safeErrorDescriptor(err));
    }
  });
}

/**
 * The generation half of boot recovery. It never re-runs generation (no model or TTS spend at
 * boot); it settles state and removes half-written artifacts a killed process left behind.
 *
 * In order: retry pending cleanup debt; reconcile publication intents, so a fully prepared Set is
 * completed rather than deleted as failed work; sweep every queued|running job (batch child or
 * standalone) to the state its own row justifies, 'cancelled' where a cancel was durably requested
 * and 'failed' otherwise, removing its artifacts; then classify each interrupted batch parent from
 * its now-terminal children. Idempotent: a second call finds no queued or running job.
 *
 * Returns the number of jobs swept and of artifact sets removed; recovered batch parents are not
 * counted.
 */
export function failInterruptedGenerationJobs(deps: { repo: GenerationJobStore }): FailInterruptedGenerationJobsSummary {
  const repo = deps.repo;
  let cleaned = 0;

  reconcileCleanupDebt(repo);

  // A publication intent wins: reconcile intents before the interrupted-job sweep, so a fully
  // prepared Set is completed, never deleted as failed work.
  reconcileGenerationPublications(repo);

  const interrupted = repo.listInterruptedGenerationJobs();
  for (const job of interrupted) {
    // `job.kind` is the row's untyped string column; isCleanableSetKind narrows it.
    if (job.set_id && isCleanableSetKind(job.kind) && cleanupUnpublishedSetArtifacts(job.kind, job.set_id)) cleaned += 1;
    if (job.cancel_requested_at) {
      repo.finishGenerationJobCancellation({ id: job.id, now: sqliteTimestamp() });
    } else {
      repo.failGenerationJobConditional({ id: job.id, error: INTERRUPTED_GENERATION_ERROR, now: sqliteTimestamp() });
    }
  }

  recoverInterruptedGenerationBatches(repo);

  return { jobs: interrupted.length, cleaned };
}

// Runs after the child sweep in failInterruptedGenerationJobs (synchronously, so every child is
// terminal by the time this reads them back). A batch parent left queued|running at boot was
// orphaned mid-run, and with all its children now terminal, computeBatchStatus classifies it exactly
// as a live run reaching the same children would. This pass has no rule of its own.
function recoverInterruptedGenerationBatches(repo: GenerationJobStore): void {
  for (const batch of repo.listInterruptedGenerationBatches()) {
    const children = repo.listGenerationJobsByBatch(batch.id);
    const status = computeBatchStatus(children);
    repo.updateGenerationBatch({
      id: batch.id,
      status,
      error: status === "failed" ? INTERRUPTED_GENERATION_ERROR : null,
    });
  }
}
