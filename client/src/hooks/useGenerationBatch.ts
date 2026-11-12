import { useCallback, useMemo, useRef } from "react";
import type { CancellationReason, GenerationBatchActiveChildVM, GenerationBatchChildVM, GenerationBatchDetailVM, GenerationBatchStatus, NoveltyResidualIssue, SceneGenerationOutcome } from "@toefl-prep/shared";
import { cancelGenerateBatch, getGenerateBatchJob, startGenerateBatch, type BatchGenerateItem } from "../lib/api";
import { deriveJobDisplay } from "../lib/progressUtils";
import { usePolledJob, type PolledJobProjectionInput } from "./usePolledJob";

// "idle"/"starting" are client-only states, same convention as useGenerationJob's
// GenerationJobUiStatus — every other value is exactly generation_batches.status as returned by
// GET /api/generate/:jobId's batch shape.
export type GenerationBatchUiStatus = "idle" | "starting" | GenerationBatchStatus;

// One running child's own display, in the shape GenerationProgress draws (derived through
// deriveJobDisplay, the same translation useGenerationJob uses), plus setIndex and elapsedMs for
// the batch's "set N of total" framing, which GenerationProgress knows nothing about.
export type CurrentSetDisplay = {
  jobId: string;
  setIndex: number;
  // The same union as GenerationBatchChildVM's `kind`.
  kind: "writing" | "speaking" | "reading" | "listening";
  stage: string | null;
  waiting: boolean;
  provider: "claude" | "codex" | null;
  fallbackFrom: "claude" | "codex" | null;
  queuePosition: number | null;
  planningAttempt: 1 | 2 | 3 | null;
  generationAttempt: 1 | 2 | 3 | null;
  maxDiversityAttempts: 3 | null;
  audioProgress: { done: number; total: number } | null;
  sceneOutcome: SceneGenerationOutcome | null;
  // Catalog overlaps Plan admission let through; see useGenerationJob's field of the same name.
  // Retained across polls exactly like sceneOutcome.
  noveltyResidual: NoveltyResidualIssue[] | null;
  // Time since this hook first saw this child running, keyed by jobId. Distinct from the hook's own
  // `elapsedMs`, which is the whole batch's running time.
  elapsedMs: number;
};

/**
 * A running child as the projection holds it: everything above except `elapsedMs`, which is not a
 * poll outcome. It is derived at render time from the engine's one ticker (childElapsedMs below).
 */
export type BatchChildProjection = Omit<CurrentSetDisplay, "elapsedMs">;

export type GenerationBatchState = {
  status: GenerationBatchUiStatus;
  total: number;
  queued: number;
  activeCount: number;
  completed: number;
  failed: number;
  cancelledCount: number;
  cancelRequested: boolean;
  cancellationRequestedAt: string | null;
  terminalAt: string | null;
  cancellationReason: CancellationReason | null;
  active: CurrentSetDisplay[];
  children: GenerationBatchChildVM[];
  elapsedMs: number;
  error: string | null;
  run: (items: BatchGenerateItem[]) => void;
  // Re-attaches to a batch already running server-side (GET /api/generate's active listing) — same
  // affordance as useGenerationJob's attach: no POST, elapsed backdated to the batch's real start,
  // cancel() wired to the re-attached id. `retry()` after an attach re-polls rather than re-queuing.
  attach: (batch: AttachableGenerationBatch) => void;
  cancel: () => void;
  retry: () => void;
};

export type AttachableGenerationBatch = { jobId: string; total: number; createdAt: string };

/** Everything this hook folds out of polls, i.e. its state minus what the engine owns. */
export type GenerationBatchProjection =
  Omit<GenerationBatchState, "elapsedMs" | "run" | "attach" | "cancel" | "retry" | "active"> & {
    active: BatchChildProjection[];
  };

const TERMINAL: ReadonlySet<GenerationBatchStatus> = new Set(["done", "partial", "failed", "cancelled"]);

/** The projection a fresh batch starts from — `total` is supplied by the caller below. */
const IDLE: Omit<GenerationBatchProjection, "total"> = {
  status: "idle",
  queued: 0,
  activeCount: 0,
  completed: 0,
  failed: 0,
  cancelledCount: 0,
  cancelRequested: false,
  cancellationRequestedAt: null,
  terminalAt: null,
  cancellationReason: null,
  active: [],
  children: [],
  error: null,
};

/**
 * Folds one poll into the batch's view. Pure, and tested directly with no React involved
 * (client/test/jobProjections.test.ts).
 *
 * Per-child stickiness is carried by `prev.active`, looked up by jobId: a poll that says nothing
 * about a child's stage, audio tally, scene outcome, Catalog overlaps or attempt counters keeps
 * what that child last reported, as the single-job projection does.
 */
export function projectGenerationBatch(
  prev: GenerationBatchProjection,
  { phase, snapshot, startError }: PolledJobProjectionInput<GenerationBatchDetailVM>,
): GenerationBatchProjection {
  if (startError !== null) return { ...prev, status: "failed", error: startError };
  if (!snapshot) {
    if (phase === "starting") return { ...prev, status: "starting" };
    if (phase === "polling") return { ...prev, status: "queued" };
    return prev;
  }

  const batch = snapshot;
  const orderedActive = [...batch.active].sort((a, b) => a.setIndex - b.setIndex);
  const retained = new Map(prev.active.map((item) => [item.jobId, item]));
  return {
    ...prev,
    status: batch.status,
    total: batch.total,
    queued: batch.queued,
    activeCount: batch.activeCount,
    completed: batch.completed,
    failed: batch.failed,
    cancelledCount: batch.cancelled,
    cancelRequested: batch.cancelRequested,
    cancellationRequestedAt: batch.cancellationRequestedAt ?? null,
    terminalAt: batch.terminalAt ?? null,
    cancellationReason: batch.cancellationReason ?? null,
    children: batch.children,
    active: orderedActive.map((child) => activeDisplay(child, retained.get(child.jobId))),
  };
}

/**
 * Drives POST /api/generate {items} + polling GET /api/generate/:jobId's batch shape on top of the
 * shared polled-job engine (usePolledJob), which owns the mounted guard, the capped
 * backoff, the monotonic generation counter that stops a stale run clobbering a newer one, and the
 * single elapsed ticker. Started by an explicit `run(items)` call, never on mount — same deliberate
 * divergence from useScoringJob that useGenerationJob has.
 */
export function useGenerationBatch(): GenerationBatchState {
  const batchIdRef = useRef<string | null>(null);
  const requestedTotalRef = useRef(0);
  const batchStartedAtRef = useRef(Date.now());
  // When each currently-running child was first seen running, keyed by child jobId. A fresh Map per
  // run() (and per retry, which re-invokes the same starter) so a superseded run's in-flight poll
  // can only ever write into its own dead Map, never the live one.
  const activeStartedAtRef = useRef(new Map<string, number>());

  const initial = useCallback(
    (): GenerationBatchProjection => ({ ...IDLE, total: requestedTotalRef.current }),
    [],
  );

  const engine = usePolledJob<GenerationBatchDetailVM, GenerationBatchProjection>({
    initial,
    project: projectGenerationBatch,
    isTerminal: isBatchTerminal,
  });

  const { begin, patch } = engine;
  const run = useCallback((items: BatchGenerateItem[]) => {
    // Shown as "set 0 of N" while the POST is still in flight, before any poll has come back.
    requestedTotalRef.current = items.reduce((sum, i) => sum + i.count, 0);
    // The starter closes over `items`, which is what makes the engine's `retry()` — a bare
    // re-invocation of the last starter — re-run the same batch.
    begin((isCurrent) => {
      const startedAt = new Map<string, number>();
      activeStartedAtRef.current = startedAt;
      batchStartedAtRef.current = Date.now();
      batchIdRef.current = null;
      return startGenerateBatch(items).then((res) => {
        // Guarded: cancel() reads this ref, and a superseded run's POST resolving late must never
        // leave it pointing at a batch the user has already replaced.
        if (isCurrent()) batchIdRef.current = res.jobId;
        return {
          fetch: async () => {
            const batch = await getGenerateBatchJob(res.jobId);
            syncChildStartTimes(startedAt, batch.active);
            return batch;
          },
        };
      });
    });
  }, [begin]);

  const attach = useCallback((target: AttachableGenerationBatch) => {
    requestedTotalRef.current = target.total;
    const startedAtMs = Date.parse(target.createdAt);
    // Synchronous starter: usePolledJob skips "starting" and goes straight to polling the known id,
    // and begin() invokes it before returning, so no isCurrent() guard is needed (unlike run()'s
    // .then, nothing can supersede this begin before the starter body runs). The child start-time
    // Map begins empty, so a child already mid-run reads as started now. That understates only its
    // own per-set clock, whose true start this client never saw; the batch clock is backdated
    // through startedAtMs.
    begin(() => {
      const startedAt = new Map<string, number>();
      activeStartedAtRef.current = startedAt;
      batchStartedAtRef.current = startedAtMs;
      batchIdRef.current = target.jobId;
      return {
        fetch: async () => {
          const batch = await getGenerateBatchJob(target.jobId);
          syncChildStartTimes(startedAt, batch.active);
          return batch;
        },
      };
    }, { startedAtMs });
  }, [begin]);

  // Fire-and-forget POST /:batchId/cancel — optimistically flips cancelRequested immediately (the
  // button click should feel instant) rather than waiting on the round trip; the next poll's real
  // server state confirms it (or corrects it, in the rare race where the batch had already reached
  // a terminal status the instant before this fired — see the route's 409 branch).
  const cancel = useCallback(() => {
    const batchId = batchIdRef.current;
    if (!batchId) return;
    patch((prev) => ({ ...prev, cancelRequested: true }));
    cancelGenerateBatch(batchId).catch(() => {
      // Best-effort — the next poll's server-reported cancelRequested/status is the source of truth.
    });
  }, [patch]);

  const { projection, elapsedMs } = engine;
  // Per-child elapsed, derived at render time from the engine's one ticker rather than written into
  // state by a second interval: `elapsedMs` is (tick - batchStartedAt), so subtracting a child's own
  // offset from the batch's start yields exactly (tick - childStartedAt), with no second timer and
  // no state write per tick.
  const childElapsedMs = useCallback((jobId: string): number => {
    const startedAt = activeStartedAtRef.current.get(jobId);
    if (startedAt === undefined) return 0;
    return Math.max(0, elapsedMs - (startedAt - batchStartedAtRef.current));
  }, [elapsedMs]);

  const { active: projectedActive } = projection;
  const active = useMemo(
    () => projectedActive.map((child) => ({ ...child, elapsedMs: childElapsedMs(child.jobId) })),
    [projectedActive, childElapsedMs],
  );

  return { ...projection, active, elapsedMs, run, attach, cancel, retry: engine.retry };
}

function isBatchTerminal(batch: GenerationBatchDetailVM): boolean {
  return TERMINAL.has(batch.status);
}

/**
 * Records when each currently-running child was first seen and forgets the ones that have stopped.
 * Done here, in the fetcher, rather than inside the projection: the projection must stay pure, and
 * "what time is it now" is exactly the impurity that does not belong in it. Each run() hands its
 * own Map in, so a superseded run's late-resolving poll can never write into the live one.
 */
function syncChildStartTimes(startedAt: Map<string, number>, active: GenerationBatchActiveChildVM[]): void {
  const liveIds = new Set(active.map((child) => child.jobId));
  for (const id of startedAt.keys()) {
    if (!liveIds.has(id)) startedAt.delete(id);
  }
  for (const child of active) {
    if (!startedAt.has(child.jobId)) startedAt.set(child.jobId, Date.now());
  }
}

function activeDisplay(child: GenerationBatchActiveChildVM, retained: BatchChildProjection | undefined): BatchChildProjection {
  const derived = deriveJobDisplay(child.stage, child.progress);
  return {
    jobId: child.jobId,
    setIndex: child.setIndex,
    kind: child.kind,
    stage: derived.concreteStage ?? retained?.stage ?? null,
    waiting: derived.waiting,
    provider: derived.provider,
    fallbackFrom: derived.fallbackFrom,
    queuePosition: derived.queuePosition,
    planningAttempt: derived.planningAttempt ?? retained?.planningAttempt ?? null,
    generationAttempt: derived.generationAttempt ?? retained?.generationAttempt ?? null,
    maxDiversityAttempts: derived.maxDiversityAttempts ?? retained?.maxDiversityAttempts ?? null,
    audioProgress: derived.audioProgress ?? retained?.audioProgress ?? null,
    sceneOutcome: derived.sceneOutcome ?? retained?.sceneOutcome ?? null,
    noveltyResidual: derived.noveltyResidual ?? retained?.noveltyResidual ?? null,
  };
}
