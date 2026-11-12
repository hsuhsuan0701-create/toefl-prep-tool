import { jobAdmissionsAreOpen, type JobCancellationRegistry } from "./jobCancellation.js";
import { withModelCallContext, type ModelCallCorrelation } from "./modelCallLog.js";

/**
 * The lifecycle every durable job family shares: the admissions gate, the queued no-op, the claim,
 * the progress-snapshot merge, the still-running guard in front of every terminal write,
 * terminalization of failed-or-cancelled, cancellation disposal and the terminal callback. Each
 * family supplies an adapter (`DurableJob`) saying what those steps mean for its own row.
 *
 * It sits above ADR 0007's admission scheduler and knows nothing about it: the scheduler decides
 * which model call runs next inside a job, this decides what a job row may become. The two meet only
 * at `correlation`.
 *
 * Scoring, generation and the generation batch parent are families. Transcription is not: its rows
 * carry no stage, progress or cancellation columns, it retries on a budget through `retry_wait`
 * rather than settling failed-or-cancelled, and it gates admission on execution-lease readiness
 * alone. Folding it in would add more optional knobs than shared behaviour.
 */

/** Every job family this runner drives. */
export type DurableJobFamily = "scoring" | "generation" | "generation-batch";

/**
 * The tri-state result of the durable 'queued' -> 'running' compare-and-set.
 *
 * The two refusals oblige their caller to do opposite things. 'cancel_requested' is a row still
 * 'queued' and held off 'running' only by a cancellation already recorded on it: nobody else is
 * coming for it, so this caller owes it a terminal state. 'unclaimable' is a row that vanished or
 * that something else already moved on, which is not this caller's to write.
 */
export type DurableJobClaim = "claimed" | "cancel_requested" | "unclaimable";

/** Every status a durable job row can end in, across every family. */
const TERMINAL_JOB_STATUSES = new Set(["done", "failed", "cancelled", "partial"]);

export function isTerminalJobStatus(status: string | undefined): boolean {
  return status !== undefined && TERMINAL_JOB_STATUSES.has(status);
}

/** One progress checkpoint as the work reports it. */
export type DurableJobProgressEvent<TDetail extends object> = {
  stage: string;
  detail?: TDetail;
};

/**
 * How a family folds a checkpoint into the job row. The runner owns the CUMULATIVE object and when
 * it is written; the family owns what merging means for its own detail shape (route metadata is a
 * current snapshot, durable counts are not) and which columns the write touches.
 */
export type DurableJobProgressSink<TDetail extends object> = {
  merge(cumulative: TDetail, detail: TDetail): void;
  save(snapshot: {
    stage: string;
    /** The merged cumulative detail as JSON, or null when nothing durable has accumulated yet. */
    progress: string | null;
    /** The cumulative detail itself. */
    cumulative: TDetail;
    /** THIS checkpoint's raw detail — what the family may promote to its own columns. */
    detail: TDetail | undefined;
  }): void;
};

export type DurableJobRunContext<TDetail extends object> = {
  /** Aborted when a cancellation that has already won durably is delivered to this process. */
  signal: AbortSignal | undefined;
  onProgress(event: DurableJobProgressEvent<TDetail>): void;
};

/**
 * One family's adapter. Everything here is family-specific by construction; everything the runner
 * does with it is not.
 */
export type DurableJob<TRow extends { status: string }, TDetail extends object, TResult> = {
  readonly family: DurableJobFamily;
  /** The durable job-row id: the key the run registers under in `cancellations`, and the id in logs. */
  readonly jobId: string;

  /**
   * The ambient model-call correlation installed around the entire awaited run.
   *
   * Load-bearing for ADR 0007, not only for diagnostics: the reasoning scheduler reads this id as the
   * per-job admission bucket, so it must be the durable job-row id and each batch child must install
   * its own. Moving the await out of the correlation, or sharing one id across children, collapses
   * admission to a single flat FIFO.
   *
   * Omitted by a family whose own run makes no model calls: the batch parent, whose children each
   * install their own.
   */
  readonly correlation?: ModelCallCorrelation;

  /** Process-local cancellation delivery. Omitted by a family with no in-process abort channel. */
  readonly cancellations?: JobCancellationRegistry;

  /** The durable row, or undefined when it has vanished. */
  read(): TRow | undefined;

  /** The durable 'queued' -> 'running' compare-and-set. */
  claim(): DurableJobClaim;

  /**
   * Settle a row the claim refused because a cancellation was already recorded on it. Omitted by a
   * family whose claim never answers 'cancel_requested' (the batch parent: its cancel flag gates the
   * admission of children rather than the parent's own start, and terminalizing the parent here
   * would leave its children non-terminal).
   */
  disposeCancelRequested?(row: TRow): void;

  /** Omitted by a family whose rows carry no stage/progress columns. */
  readonly progress?: DurableJobProgressSink<TDetail>;

  /** The work itself — the only step that may spend money. */
  run(ctx: DurableJobRunContext<TDetail>): Promise<TResult>;

  /**
   * The run returned. Write whatever terminal state that result implies. Called only while the row
   * is still 'running', so a job superseded mid-flight is never resurrected.
   */
  commit(result: TResult, ctx: { row: TRow }): void;

  /**
   * The run threw. Called only while the row is still 'running'. `cancelled` is true when a
   * cancellation was delivered to this process before the throw, so a family can discard buffered
   * work rather than persist it.
   *
   * Omitted by a family with no failure disposition, and the error then propagates to the caller
   * (the batch parent, whose boot sweep reclassifies it).
   */
  fail?(error: unknown, ctx: { row: TRow; cancelled: boolean }): void;

  /**
   * Settle a cancellation recorded on the row while the run was in flight. Called on every exit
   * path once the run (if any) has settled, so it must be a no-op on an already-terminal row.
   */
  disposeCancellation?(): void;

  /**
   * Fired once the row has reached a terminal status, read fresh rather than inferred from which
   * branch ran. A row already terminal before this invocation started (the queued no-op) still
   * fires it; a missing row does not.
   */
  onTerminal?(status: string): Promise<void> | void;
};

/**
 * Runs one durable job through the shared lifecycle.
 *
 * Rejects with whatever a row read, the claim, or a progress write threw: those are invariant
 * failures, not job failures. An error from `run` is a job failure and goes to `fail` (or propagates
 * when the family declares none). The terminal-callback block catches its own errors, so a throwing
 * re-read or callback never replaces an error already propagating: callers launch this
 * fire-and-forget, and the rejection is the only thing anyone sees.
 */
export async function runDurableJob<TRow extends { status: string }, TDetail extends object, TResult>(
  job: DurableJob<TRow, TDetail, TResult>,
): Promise<void> {
  // Admissions gate, ahead of everything including the terminal callback: a process that has stopped
  // admitting work owes this row nothing, and the next boot's sweep owns it.
  if (!jobAdmissionsAreOpen()) return;

  const cancellation = job.cancellations?.start(job.jobId);
  try {
    // Queued no-op: nothing to run if the row vanished or moved on before this invocation started.
    const queued = job.read();
    if (!queued || queued.status !== "queued") return;

    const claim = job.claim();
    if (claim !== "claimed") {
      if (claim === "cancel_requested") job.disposeCancelRequested?.(queued);
      return;
    }

    const cumulative = {} as TDetail;
    const onProgress = (event: DurableJobProgressEvent<TDetail>): void => {
      if (!job.progress) return;
      if (event.detail) job.progress.merge(cumulative, event.detail);
      job.progress.save({
        stage: event.stage,
        progress: Object.keys(cumulative).length > 0 ? JSON.stringify(cumulative) : null,
        cumulative,
        detail: event.detail,
      });
    };

    try {
      const runContext: DurableJobRunContext<TDetail> = { signal: cancellation?.signal, onProgress };
      // The await is inside the callback, so the correlation covers the whole run and not just its
      // synchronous prefix (see `correlation`).
      const result = job.correlation
        ? await withModelCallContext(job.correlation, () => job.run(runContext))
        : await job.run(runContext);
      const row = job.read();
      if (row?.status === "running") job.commit(result, { row });
    } catch (err) {
      if (!job.fail) throw err;
      const row = job.read();
      if (row?.status === "running") job.fail(err, { row, cancelled: cancellation?.signal.aborted === true });
    }
  } finally {
    try {
      job.disposeCancellation?.();
      const status = job.read()?.status;
      if (job.onTerminal && isTerminalJobStatus(status)) {
        try {
          await job.onTerminal(status!);
        } catch (err) {
          console.error(`[durableJobRunner] ${job.family} job ${job.jobId} onTerminal callback threw:`, err);
        }
      }
    } catch (err) {
      console.error(
        `[durableJobRunner] ${job.family} job ${job.jobId} terminal-callback dispatch failed:`,
        err instanceof Error ? err.name : "unknown",
      );
    }
    cancellation?.dispose();
  }
}

/**
 * Logs a job whose terminal write did not win and whose row is still queued or running; says nothing
 * when the row already ended some other way. Every terminal write is a conditional store call that
 * reports whether it won (a JS pre-check in front of it is an optimisation, not the guarantee). A row
 * left non-terminal keeps anything polling it waiting until the next boot's sweep settles it.
 */
export function reportStrandedJob(family: DurableJobFamily, jobId: string, outcome: string, status: string | undefined): void {
  if (status !== "queued" && status !== "running") return;
  console.error(
    `[durableJobRunner] ${family} job ${jobId} could not be terminalized (status=${status}, outcome=${outcome}); boot recovery will sweep it`,
  );
}
