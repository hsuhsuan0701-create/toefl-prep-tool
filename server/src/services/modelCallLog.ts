import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { config } from "../lib/config.js";
import type {
  ModelCallInsert,
  ModelCallProvider,
  ModelAttemptInsert,
} from "../db/rows.js";
import { sqliteTimestamp, type SqliteTimestamp } from "../db/timestamps.js";
import type { ClipMeasurementStore } from "./clipMeasurementLog.js";
import type { BootRecoveryServer } from "./scoringJobs.js";
import { ModelCallRecorder, type ModelDiagnosticStore } from "./modelCallRecorder.js";
import type { ProviderExecution } from "./reasoning/providerExecutor.js";
import type { CliTranscript } from "./claudeRunner.js";
import type { CancellationReason } from "./reasoning/contracts.js";

export type DatabaseFreeSpace = {
  readonly pageSize: number;
  readonly pageCount: number;
  readonly freePages: number;
  /** auto_vacuum is INCREMENTAL, so free pages can be reclaimed a few at a time. */
  readonly incremental: boolean;
};

/**
 * Retention (MODEL_CALL_RETENTION_DAYS, ADR 0004) across the observability tables as one port, plus
 * giving the space a prune frees back to the file system. Every prune deletes by `created_at < ?`
 * compared as a string, which is why each cutoff is a `SqliteTimestamp` (db/timestamps.ts).
 * `pruneNormalizedModelCalls` deletes `route_invocations`, and the two child tables follow by cascade.
 */
export type DiagnosticRetentionStore = {
  pruneNormalizedModelCalls(olderThan: SqliteTimestamp): number;
  freeSpace(): DatabaseFreeSpace;
  reclaimFreePages(maxPages: number): void;
  compactDatabase(): void;
  checkpointWal(): void;
} & Pick<ClipMeasurementStore, "pruneClipMeasurements">;

/** Compatibility facade for normalized, centrally-redacted model diagnostics; see ADR 0004. */

export interface ModelCallCorrelation {
  readonly kind: string; // 'generation-job' | 'scoring-job' | 'transcription-job'
  readonly id: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface ModelCallEntry {
  readonly provider: ModelCallProvider;
  readonly model?: string;
  readonly route: string;
  readonly task?: string;
  readonly attemptIndex?: number;
  readonly prompt: string;
  readonly response?: string;
  readonly outcome: "succeeded" | "failed";
  readonly failureKind?: string;
  readonly queueMs?: number;
  readonly durationMs?: number;
}

export type ModelCallSink = (call: ModelCallInsert) => void;

// Correlation travels ambiently rather than as a parameter: threading a context field from
// runGenerationJob through generateSet, GenerationPlanner, SkillTaskRunner and the router's request
// would put the owning job id into every signature on that path. AsyncLocalStorage confines it to the
// two job runners that already know the id.
//
// The store is not only observational: the reasoning router reads it (currentModelCallCorrelation) to
// pick a call's admission bucket, so the id it carries decides scheduling as well as what a row says.
// A reasoning call made outside any withModelCallContext scope loses its per-job fairness as well as
// its attribution, and is bucketed by its task name.
const correlation = new AsyncLocalStorage<ModelCallCorrelation>();
type RouteRecording = { readonly id: string; readonly family: "scoring"|"generation"; nextExecutionSequence: number };
const routeRecording = new AsyncLocalStorage<RouteRecording>();

// No-op until the composition root installs the real one (see index.ts). A default that opened its
// own database would give this process a second write handle to the same file purely as a side
// effect of an import, which is exactly the shape the transcription singleton assertion exists to
// prevent; tests install a capturing sink instead.
let sink: ModelCallSink = () => undefined;
let lifecycleRecorder: ModelCallRecorder | undefined;
const recorderLosses = { overflow: 0, database: 0 };

export function getModelCallRecorderLossSnapshot(): Readonly<{ overflow: number; database: number; total: number }> {
  return Object.freeze({ ...recorderLosses, total: recorderLosses.overflow + recorderLosses.database });
}

export function resetModelCallRecorderLossSnapshot(): void {
  recorderLosses.overflow = 0;
  recorderLosses.database = 0;
}

export function setModelCallSink(next: ModelCallSink): void {
  sink = next;
}

export function createRepoModelCallSink(repo: ModelDiagnosticStore): ModelCallSink {
  // Compatibility adapter for call sites that still emit one completed-call event: it writes the
  // normalized lifecycle tables.
  const recorder = new ModelCallRecorder(repo, { onLoss: (loss) => {
    recorderLosses[loss.kind] += 1;
    console.error(JSON.stringify({ event: "model_call_recorder_loss", ...loss }));
  }});
  lifecycleRecorder = recorder;
  return (call) => {
    const route = routeRecording.getStore();
    recorder.completedCall(call, route ? { routeId: route.id, family: route.family, executionSequence: route.nextExecutionSequence++ } : undefined);
  };
}

/** Test seam: drops back to the no-op sink so one test's rows cannot leak into the next. */
export function resetModelCallSink(): void {
  sink = () => undefined;
  lifecycleRecorder = undefined;
}

/** Drains the process-owned diagnostic queue during graceful shutdown. */
export async function flushModelCallRecorder(timeoutMs = 5_000): Promise<boolean> {
  return lifecycleRecorder?.flush(timeoutMs) ?? true;
}

export async function withModelCallRoute<T>(input: {
  operation: string;
  family: "scoring"|"generation";
  queuedAtMs: number;
  now: () => number;
}, run: () => Promise<T>): Promise<T> {
  const recorder = lifecycleRecorder;
  if (!recorder) return run();
  const id = randomUUID();
  const current = correlation.getStore();
  let contextDetail: string | undefined;
  try { contextDetail = current?.detail ? JSON.stringify(current.detail) : undefined; } catch { contextDetail = undefined; }
  recorder.route({ id, operation: input.operation, family: input.family, contextKind: current?.kind, contextId: current?.id, contextDetail, queuedAtMs: input.queuedAtMs });
  return routeRecording.run({id,family:input.family,nextExecutionSequence:1}, async () => {
    try {
      const value = await run();
      const finishedAtMs = input.now();
      const result = value as {ok?:boolean;cancelled?:boolean;reason?:CancellationReason;attempts?:Array<{kind?:string}>};
      const outcome = result.cancelled ? "cancelled" : result.ok === false ? "failure" : "success";
      recorder.finishRoute({ id, finishedAtMs, durationMs: Math.max(0,finishedAtMs-input.queuedAtMs), outcome,
        ...(result.cancelled && result.reason ? {cancellationReason:result.reason}:{}),
        ...(outcome==="failure" && result.attempts?.at(-1)?.kind ? {failureKind:result.attempts.at(-1)!.kind}:{}),
      });
      return value;
    } catch (error) {
      const finishedAtMs=input.now();
      recorder.finishRoute({id,finishedAtMs,durationMs:Math.max(0,finishedAtMs-input.queuedAtMs),outcome:"failure",failureKind:"application"});
      throw error;
    }
  });
}

/**
 * How long a timed-out execution's write waits for its runner to finish tearing down the CLI and
 * report the attempt's transcript: the configured SIGTERM-to-SIGKILL grace, plus a margin for the
 * supervisor's settle fallback, the output read and temp-dir cleanup. Past this the execution is
 * recorded with what has arrived.
 */
function lateTranscriptWaitMs(): number {
  return (config.attemptTerminationGraceMs ?? 2_000) + 10_000;
}

/**
 * Records one provider execution and its attempts. `settled`, when given, is the runner's own
 * settlement: a timed-out runner is still killing its CLI when the route moves on, and reports the
 * attempt's transcript only once that finishes, so the write waits for it (bounded). The execution's
 * sequence is taken now, so a fallback recorded meanwhile still orders after it.
 */
export function recordProviderExecutionLifecycle<T>(
  execution: ProviderExecution<T>,
  transcripts: {
    readonly values: readonly CliTranscript[];
    readonly model?: string;
    readonly settled?: Promise<unknown>;
  } = {values:[]},
): boolean {
  try {
    const recorder = lifecycleRecorder;
    if (!recorder) return false;
    const route = routeRecording.getStore();
    if (!route) return false;
    const outcome = execution.status === "success"
      ? "success"
      : execution.status === "cancelled"
        ? "cancelled"
        : "failure";
    const failureKind = execution.status === "failure"
      ? execution.failure.kind
      : undefined;
    const cancellationReason = execution.status === "cancelled"
      ? execution.reason
      : undefined;
    const executionRecord = {
      id: execution.executionId,
      routeInvocationId: route.id,
      sequence: route.nextExecutionSequence++,
      provider: execution.provider,
      family: execution.family,
      operation: execution.operation,
      queuedAtMs: Math.round(execution.queuedAtMs),
      dequeuedAtMs: Math.round(execution.dequeuedAtMs),
      startedAtMs: Math.round(execution.startedAtMs),
      finishedAtMs: Math.round(execution.finishedAtMs),
      queueMs: Math.round(execution.dequeuedAtMs - execution.queuedAtMs),
      durationMs: Math.round(execution.finishedAtMs - execution.startedAtMs),
      outcome,
      ...(failureKind ? { failureKind } : {}),
      ...(cancellationReason ? { cancellationReason } : {}),
    } as const;
    const write = () => {
      const attempts: ModelAttemptInsert[] = transcripts.values.map((transcript,index) => {
        const final=index===transcripts.values.length-1;
        return {
          id:randomUUID(),providerExecutionId:execution.executionId,sequence:index+1,kind:index===0?"initial" as const:"repair" as const,
          ...(transcripts.model?{model:transcripts.model}:{}),prompt:transcript.prompt,...(transcript.response===undefined?{}:{response:transcript.response}),
          startedAtMs:Math.round(transcript.startedAtMs ?? execution.startedAtMs),finishedAtMs:Math.round(transcript.finishedAtMs ?? execution.finishedAtMs),
          durationMs:Math.max(0,Math.round((transcript.finishedAtMs ?? execution.finishedAtMs)-(transcript.startedAtMs ?? execution.startedAtMs))),
          outcome: final ? outcome : "failure",
          ...(final ? (failureKind?{failureKind}:{}) : {failureKind:"invalid-output"}),
          ...(final&&cancellationReason?{cancellationReason}:{}),
        };
      });
      recorder.executionWithAttempts(executionRecord,attempts);
    };
    if (transcripts.settled === undefined) {
      write();
    } else {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, lateTranscriptWaitMs());
        timer.unref?.();
      });
      void Promise.race([transcripts.settled.then(() => undefined, () => undefined), waited])
        .then(() => {
          clearTimeout(timer);
          try { write(); } catch { /* recording is observational */ }
        });
    }
    return true;
  } catch {
    // Normalized lifecycle recording is observational.
    return false;
  }
}

/** Runs `fn` with this correlation attached to every model call it makes, however deeply nested. */
export function withModelCallContext<T>(
  context: ModelCallCorrelation,
  fn: () => T,
): T {
  return correlation.run(Object.freeze({ ...context }), fn);
}

/**
 * Adds detail to the correlation already in scope, for callers that know more than the job runner
 * did — `callGenerationSkillTask` knows the stage and which of the three diversity attempts this
 * is, which is precisely the field that makes a failed generation readable afterward. A no-op call
 * outside any context: detail without an id has nothing to attach to.
 */
export function withModelCallDetail<T>(
  detail: Readonly<Record<string, unknown>>,
  fn: () => T,
): T {
  const current = correlation.getStore();
  if (!current) return fn();
  return correlation.run(
    Object.freeze({
      ...current,
      detail: Object.freeze({ ...current.detail, ...detail }),
    }),
    fn,
  );
}

/**
 * The correlation in scope. Two consumers, and only one is observational:
 *
 * - other records that hang off the same job (clipMeasurementLog), so a generation job's model calls
 *   and its TTS measurements cannot end up attributed to different ids;
 * - the reasoning router's admissionJobId(), which uses `id` as the per-job admission bucket key so
 *   concurrent batch children are round-robined instead of starving each other (ADR 0007). Changing
 *   what this returns changes scheduling.
 */
export function currentModelCallCorrelation(): ModelCallCorrelation | undefined {
  return correlation.getStore();
}

function contextFields(): Pick<
  ModelCallInsert,
  "contextKind" | "contextId" | "contextDetail"
> {
  const current = correlation.getStore();
  if (!current) return {};
  let contextDetail: string | undefined;
  try {
    contextDetail =
      current.detail && Object.keys(current.detail).length > 0
        ? JSON.stringify(current.detail)
        : undefined;
  } catch {
    // A detail bag that cannot be serialized (cycle, BigInt) must not cost us the row itself.
    contextDetail = undefined;
  }
  return {
    contextKind: current.kind,
    contextId: current.id,
    ...(contextDetail === undefined ? {} : { contextDetail }),
  };
}

/**
 * Records one model call. Never throws and never returns a failure: an observability write that can
 * fail the paid call it observes is worse than no observability at all. The same rule the router
 * already applies to its own route observers (`observe` in reasoning/router.ts).
 */
export function recordModelCall(entry: ModelCallEntry): void {
  try {
    sink({
      id: randomUUID(),
      provider: entry.provider,
      route: entry.route,
      prompt: entry.prompt,
      outcome: entry.outcome,
      attemptIndex: entry.attemptIndex ?? 0,
      ...(entry.model === undefined ? {} : { model: entry.model }),
      ...(entry.task === undefined ? {} : { task: entry.task }),
      ...(entry.response === undefined ? {} : { response: entry.response }),
      ...(entry.failureKind === undefined
        ? {}
        : { failureKind: entry.failureKind }),
      // Rounded because the router measures with performance.now(), which yields fractional
      // milliseconds, and both columns are declared INTEGER. SQLite's INTEGER affinity only
      // converts a REAL when the conversion is lossless, so an unrounded 140281.65075 is stored
      // verbatim — a float sitting in a column whose declared type says otherwise. Sub-millisecond
      // precision on a call that takes minutes is noise; the honest type is not.
      ...(entry.queueMs === undefined ? {} : { queueMs: Math.round(entry.queueMs) }),
      ...(entry.durationMs === undefined
        ? {}
        : { durationMs: Math.round(entry.durationMs) }),
      ...contextFields(),
    });
  } catch {
    // Deliberately swallowed — see this function's doc comment.
  }
}

/**
 * The one shape every direct-`fetch` model call site needs: request body in, response body out.
 * Exists so the five HTTP sites (two essay judges, two speaking judges, Ears) stay a single line
 * each instead of restating the entry shape — and so that "body, not headers" is expressed once, in
 * the parameter list, rather than being a rule each site has to remember.
 */
export function recordHttpModelCall(input: {
  readonly provider: Extract<ModelCallProvider, "gemini-http" | "openai-http">;
  readonly route: string;
  readonly model?: string;
  readonly requestBody: string;
  readonly responseBody?: string;
  readonly ok: boolean;
  readonly failureKind?: string;
  readonly durationMs?: number;
}): void {
  recordModelCall({
    provider: input.provider,
    route: input.route,
    prompt: input.requestBody,
    outcome: input.ok ? "succeeded" : "failed",
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.responseBody === undefined
      ? {}
      : { response: input.responseBody }),
    ...(input.failureKind === undefined
      ? {}
      : { failureKind: input.failureKind }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
  });
}

/**
 * The retention cutoff, in the on-disk timestamp form. The prunes compare `created_at < ?` against it
 * as strings, so it is minted by `sqliteTimestamp`, and the branded return type keeps it that way.
 */
export function modelCallPruneCutoff(
  now: Date,
  retentionDays: number,
): SqliteTimestamp {
  return sqliteTimestamp(new Date(now.getTime() - retentionDays * 86_400_000));
}

/** How often a running server prunes. Boot prunes too, so a restart never waits a day. */
export const DIAGNOSTIC_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

// Free space is given back only after a prune that freed a lot of the file: at least a quarter of
// it, and at least 1 MiB. Smaller amounts are left for new rows to reuse.
const MIN_RECLAIM_BYTES = 1024 * 1024;
// One incremental-vacuum step: a few milliseconds of moving pages, so a request waits at most that.
const RECLAIM_CHUNK_PAGES = 1024;
// A whole-file VACUUM rewrites every live page while holding the write lock. Above this much live
// data it is skipped, and the free pages are left for reuse.
const MAX_COMPACT_LIVE_BYTES = 64 * 1024 * 1024;

function worthReclaiming(space: DatabaseFreeSpace): boolean {
  return space.freePages * space.pageSize >= MIN_RECLAIM_BYTES && space.freePages * 4 >= space.pageCount;
}

function mebibytes(pages: number, pageSize: number): string {
  return `${((pages * pageSize) / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Deletes every diagnostic row older than the retention window. Returns the rows deleted. */
function pruneDiagnostics(repo: DiagnosticRetentionStore, retentionDays: number, now: Date): number {
  // Model diagnostics and clip measurements, under the one retention setting.
  const cutoff = modelCallPruneCutoff(now, retentionDays);
  const deleted = repo.pruneNormalizedModelCalls(cutoff) + repo.pruneClipMeasurements(cutoff);
  if (deleted > 0) {
    console.log(`[server] observability log: pruned ${deleted} row(s) older than ${retentionDays} day(s)`);
  }
  return deleted;
}

function describeFailure(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : err instanceof Error ? err.name : "unknown error";
}

/**
 * Gives free pages back to the file system in RECLAIM_CHUNK_PAGES steps, yielding to the event loop
 * between steps so requests keep being served, and stopping at the first step boundary where
 * `isIdle` is false (a scoring or generation job is running, or this process no longer owns the
 * database). Returns the pages reclaimed. Does nothing unless the database is in incremental
 * auto-vacuum mode.
 */
export async function reclaimFreePagesWhileIdle(
  repo: Pick<DiagnosticRetentionStore, "freeSpace" | "reclaimFreePages" | "checkpointWal">,
  isIdle: () => boolean,
  yieldToEventLoop: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve)),
): Promise<number> {
  const start = repo.freeSpace();
  if (!start.incremental) return 0;
  let remaining = start.freePages;
  while (remaining > 0 && isIdle()) {
    repo.reclaimFreePages(RECLAIM_CHUNK_PAGES);
    const after = repo.freeSpace().freePages;
    if (after >= remaining) break;
    remaining = after;
    await yieldToEventLoop();
  }
  const reclaimed = start.freePages - remaining;
  if (reclaimed > 0) repo.checkpointWal();
  return reclaimed;
}

/**
 * Boot's reclaim. Nothing else runs yet — recovery runs after this process takes the execution
 * lease and before it admits any job — so a database that cannot yet reclaim incrementally is
 * compacted with one VACUUM, which also switches it to incremental mode for every later prune.
 */
function reclaimAtBoot(repo: DiagnosticRetentionStore): void {
  const space = repo.freeSpace();
  if (!worthReclaiming(space)) return;
  if (space.incremental) {
    let remaining = space.freePages;
    while (remaining > 0) {
      repo.reclaimFreePages(RECLAIM_CHUNK_PAGES);
      const after = repo.freeSpace().freePages;
      if (after >= remaining) break;
      remaining = after;
    }
    repo.checkpointWal();
  } else if ((space.pageCount - space.freePages) * space.pageSize <= MAX_COMPACT_LIVE_BYTES) {
    repo.compactDatabase();
  } else {
    return;
  }
  const after = repo.freeSpace();
  console.log(
    `[server] database: reclaimed ${mebibytes(space.pageCount - after.pageCount, space.pageSize)} ` +
      `(now ${mebibytes(after.pageCount, after.pageSize)})`,
  );
}

/**
 * Boot's prune, run on 'listening' like every other boot pass (see wireGenerationBootRecovery): this
 * process holds the execution lease by then, so it cannot delete rows out from under a still-live
 * predecessor. Retention 0 disables pruning outright rather than deleting everything: "keep nothing"
 * is never what someone means by setting it.
 */
export function wireModelCallPruning(
  server: BootRecoveryServer,
  repo: DiagnosticRetentionStore,
  retentionDays: number = config.modelCallRetentionDays,
  // Injected so the retention window can be asserted against a fixed instant. A test that pins row
  // timestamps but reads the real clock proves nothing today and starts failing on its own once
  // enough calendar time passes for its "recent" rows to age out.
  now: () => Date = () => new Date(),
): void {
  server.on("listening", () => {
    if (retentionDays <= 0) return;
    try {
      if (pruneDiagnostics(repo, retentionDays, now()) > 0) reclaimAtBoot(repo);
    } catch (err) {
      // Same containment rule as the recorder: a prune failure must not end the boot recovery
      // chain, which stops at the first pass that throws.
      console.error(`[server] diagnostic retention failed: ${describeFailure(err)}`);
    }
  });
}

/**
 * The running server's prune: every DIAGNOSTIC_RETENTION_INTERVAL_MS, the same prune boot does,
 * then its freed pages reclaimed in small steps while `isIdle` holds. The timer never keeps the
 * process alive, and a pass still reclaiming when the next one is due is not doubled up. Returns
 * the stop function, which the shutdown sequence calls.
 */
export function startDiagnosticRetention(options: {
  repo: DiagnosticRetentionStore;
  isIdle: () => boolean;
  retentionDays?: number;
  now?: () => Date;
}): () => void {
  const { repo, isIdle } = options;
  const retentionDays = options.retentionDays ?? config.modelCallRetentionDays;
  const now = options.now ?? (() => new Date());
  let stopped = false;
  let running = false;

  async function pass(): Promise<void> {
    if (stopped || running || retentionDays <= 0) return;
    running = true;
    try {
      if (pruneDiagnostics(repo, retentionDays, now()) > 0 && worthReclaiming(repo.freeSpace())) {
        await reclaimFreePagesWhileIdle(repo, () => !stopped && isIdle());
      }
    } catch (err) {
      console.error(`[server] diagnostic retention failed: ${describeFailure(err)}`);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void pass(), DIAGNOSTIC_RETENTION_INTERVAL_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
