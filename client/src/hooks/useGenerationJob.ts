import { useCallback, useRef } from "react";
import type {
  CancellationReason,
  GenerationJobDetailVM,
  GenerationJobStatus,
  NoveltyResidualIssue,
  SceneGenerationOutcome,
} from "@toefl-prep/shared";
import { cancelGenerateJob, getGenerateJob, startGenerate } from "../lib/api";
import { deriveJobDisplay } from "../lib/progressUtils";
import { usePolledJob, type PolledJobProjectionInput } from "./usePolledJob";

// "idle" (nothing ever started) and "starting" (POST /api/generate in flight, jobId not known
// yet) are client-only states, mirroring useScoringJob's own "starting" convention — every other
// value is exactly generation_jobs.status as returned by GET /api/generate/:jobId.
export type GenerationJobUiStatus = "idle" | "starting" | GenerationJobStatus;

// The same union as GenerationJobDetailVM's `kind`, so the projection below assigns one union to
// itself rather than a narrower one into a wider one.
export type GenerationKind = "writing" | "speaking" | "reading" | "listening";

export type AudioProgress = { done: number; total: number };

export type GenerationJobState = {
  status: GenerationJobUiStatus;
  kind: GenerationKind | null;
  // The last concrete stage the job reported — "planning" | "generating" | "verifying" |
  // "rendering-audio" | "rendering-image" | "locating-regions" | "saving" (never "queued" itself;
  // see `waiting` below for that). Null until the first concrete checkpoint lands.
  stage: string | null;
  // True exactly when the job's current reasoning call is waiting for a slot with its provider
  // (server stage === "queued"). Claude and Codex each have their own adaptive scheduler, which
  // round-robins across jobs within a family and keeps each job's calls in order (docs/adr/0007), so
  // a wait here means other admitted work holds the capacity, not that one call is stuck with
  // everything else behind it. Its own boolean rather than a step in the stepper, so an admission
  // wait never makes a finished step (e.g. "generating") look unstarted again. See GenerationStage
  // in server/src/services/generationReasoning.ts.
  waiting: boolean;
  provider: "claude" | "codex" | null;
  fallbackFrom: "claude" | "codex" | null;
  queuePosition: number | null;
  planningAttempt: 1 | 2 | 3 | null;
  generationAttempt: 1 | 2 | 3 | null;
  maxDiversityAttempts: 3 | null;
  // Speaking's {done, total} clip tally while rendering audio. Sticky like useScoringJob's judge
  // lists: replaced only by a poll that carries a tally, so the bar keeps its count through a
  // checkpoint that derives none (a "queued" one, for instance).
  audioProgress: AudioProgress | null;
  // Final result of speaking's optional scene/regions work. A failed optional call does not change
  // the job's `done` status, so this is tracked separately from `error`.
  sceneOutcome: SceneGenerationOutcome | null;
  // Overlaps with the Catalog that Plan admission recorded and let through, reported at the planning
  // checkpoint. Sticky like audioProgress, so the finished-Set line can still disclose them.
  noveltyResidual: NoveltyResidualIssue[] | null;
  elapsedMs: number;
  setId: string | null;
  error: string | null;
  cancellationRequestedAt: string | null;
  terminalAt: string | null;
  cancellationReason: CancellationReason | null;
  // `opts.supersedesSetId` (the Set this one replaces) is remembered with the kind, so `retry()`
  // re-runs the same replacement the User chose rather than generating an extra Set that retires
  // nothing.
  run: (kind: GenerationKind, opts?: GenerationRunOptions) => void;
  // Re-attaches to a job already running server-side (from GET /api/generate's active listing):
  // polls it without POSTing anything, with the elapsed clock backdated to the job's real start.
  // This is what survives a page refresh mid-generation. `retry()` after an attach starts a fresh
  // run of the same kind, because replaying the attach starter would only re-poll the failed job.
  // The original run's supersedesSetId is not in the listing, so such a retry retires nothing.
  attach: (job: AttachableGenerationJob) => void;
  retry: () => void;
  // Fire-and-forget POST /api/generate/:id/cancel against whichever job id `run`/`attach` last
  // established (a standalone job or a batch child's own id; useGenerationBatch's cancel hits the
  // same endpoint). A no-op before any job is known. Optimistic like the batch hook's cancel: it
  // flips `cancellationRequestedAt` at once so the click feels instant, and the next poll's real
  // value confirms or corrects it.
  cancel: () => void;
};

export type GenerationRunOptions = { supersedesSetId?: string };

export type AttachableGenerationJob = { jobId: string; kind: GenerationKind; createdAt: string };

/** Everything this hook folds out of polls, i.e. its state minus what the engine owns. */
export type GenerationJobProjection = Omit<GenerationJobState, "elapsedMs" | "run" | "attach" | "retry" | "cancel">;

const TERMINAL: ReadonlySet<GenerationJobStatus> = new Set(["done", "failed", "cancelled"]);

/** The projection a fresh generation job starts from — `kind` is supplied by the caller below. */
const IDLE: Omit<GenerationJobProjection, "kind"> = {
  status: "idle",
  stage: null,
  waiting: false,
  provider: null,
  fallbackFrom: null,
  queuePosition: null,
  planningAttempt: null,
  generationAttempt: null,
  maxDiversityAttempts: null,
  audioProgress: null,
  sceneOutcome: null,
  noveltyResidual: null,
  setId: null,
  error: null,
  cancellationRequestedAt: null,
  terminalAt: null,
  cancellationReason: null,
};

/**
 * Folds one poll into the generation job's view. Pure, and tested directly with no React involved
 * (client/test/jobProjections.test.ts).
 *
 * Every `if (x !== null)` below is the sticky rule, not defensive noise: a field the snapshot says
 * nothing about keeps its last value. deriveJobDisplay reports null for a field a checkpoint does
 * not carry (a "queued" checkpoint has no concrete stage and no audio tally), and assigning that
 * null would blank the stepper, the audio tally, the scene outcome, the Catalog overlaps or the
 * diversity attempt counters already on screen.
 */
export function projectGenerationJob(
  prev: GenerationJobProjection,
  { phase, snapshot, startError }: PolledJobProjectionInput<GenerationJobDetailVM>,
): GenerationJobProjection {
  if (startError !== null) return { ...prev, status: "failed", error: startError };
  if (!snapshot) {
    if (phase === "starting") return { ...prev, status: "starting" };
    if (phase === "polling") return { ...prev, status: "queued" };
    return prev;
  }

  const job = snapshot;
  const derived = deriveJobDisplay(job.stage, job.progress);
  const next: GenerationJobProjection = {
    ...prev,
    status: job.status,
    kind: job.kind,
    cancellationRequestedAt: job.cancellationRequestedAt ?? null,
    terminalAt: job.terminalAt ?? null,
    cancellationReason: job.cancellationReason ?? null,
    waiting: derived.waiting,
    provider: derived.provider,
    fallbackFrom: derived.fallbackFrom,
    queuePosition: derived.queuePosition,
  };
  if (derived.planningAttempt !== null) next.planningAttempt = derived.planningAttempt;
  if (derived.generationAttempt !== null) next.generationAttempt = derived.generationAttempt;
  if (derived.maxDiversityAttempts !== null) next.maxDiversityAttempts = derived.maxDiversityAttempts;
  if (derived.concreteStage !== null) next.stage = derived.concreteStage;
  if (derived.audioProgress) next.audioProgress = derived.audioProgress;
  if (derived.sceneOutcome) next.sceneOutcome = derived.sceneOutcome;
  if (derived.noveltyResidual) next.noveltyResidual = derived.noveltyResidual;
  if (job.setId) next.setId = job.setId;
  if (job.status === "failed") next.error = job.error ?? "Generation failed.";
  return next;
}

/**
 * Drives POST /api/generate + polling GET /api/generate/:jobId (the durable generation_jobs row)
 * on top of the shared polled-job engine (usePolledJob) — which owns the mounted guard, the capped
 * backoff on transient network errors, the monotonic generation counter that stops a stale retry
 * clobbering fresher state, and the elapsed ticker. Unlike useScoringJob this hook does not
 * auto-start: generating a Set is a deliberate click on the Dashboard, not something to fire the
 * moment a component mounts.
 */
export function useGenerationJob(): GenerationJobState {
  const kindRef = useRef<GenerationKind | null>(null);

  const initial = useCallback(
    (): GenerationJobProjection => ({ ...IDLE, kind: kindRef.current }),
    [],
  );

  const engine = usePolledJob<GenerationJobDetailVM, GenerationJobProjection>({
    initial,
    project: projectGenerationJob,
    isTerminal: isGenerationTerminal,
  });

  const { begin, patch } = engine;
  // Whether the current lifecycle came from attach() rather than run(); read by retry below.
  const attachedRef = useRef(false);
  // The job id `cancel()` targets — set synchronously by attach() (the id is already known) and,
  // for run(), only once the POST resolves and only if this begin() is still current (guards against
  // a superseded run's late-resolving POST writing over a newer job's id — same isCurrent()
  // convention useGenerationBatch's own run() uses for its batchIdRef).
  const jobIdRef = useRef<string | null>(null);

  // The starter closes over both the kind and `opts` (its supersedesSetId), which is what makes the
  // engine's `retry()`, a bare re-invocation of the last starter, re-run the same replacement the
  // User chose rather than generating an extra Set that retires nothing.
  const run = useCallback((kind: GenerationKind, opts: GenerationRunOptions = {}) => {
    attachedRef.current = false;
    jobIdRef.current = null;
    kindRef.current = kind; // read by initial() above, so the panel names the kind from frame one
    begin((isCurrent) =>
      startGenerate(kind, opts).then((res) => {
        if (isCurrent()) jobIdRef.current = res.jobId;
        return { fetch: () => getGenerateJob(res.jobId) };
      }),
    );
  }, [begin]);

  // The synchronous-starter path (usePolledJob's own re-attach affordance): no POST, straight to
  // polling the known id, elapsed backdated to the job's real creation instant.
  const attach = useCallback((job: AttachableGenerationJob) => {
    attachedRef.current = true;
    kindRef.current = job.kind;
    jobIdRef.current = job.jobId;
    begin(
      () => ({ fetch: () => getGenerateJob(job.jobId) }),
      { startedAtMs: Date.parse(job.createdAt) },
    );
  }, [begin]);

  const cancel = useCallback(() => {
    const jobId = jobIdRef.current;
    if (!jobId) return;
    patch((prev) => ({ ...prev, cancellationRequestedAt: new Date().toISOString() }));
    cancelGenerateJob(jobId).catch(() => {
      // Best-effort — the next poll's real cancellationRequestedAt/status is the source of truth,
      // same convention as useGenerationBatch's cancel.
    });
  }, [patch]);

  // On a run()-originated job the engine's retry re-invokes the POSTing starter — a real re-run,
  // options included. On an attach()-originated job that same replay would only re-poll the failed
  // job, so Retry instead queues a fresh run of the remembered kind (see the attach comment above
  // for the supersedesSetId caveat).
  const { retry: engineRetry } = engine;
  const retry = useCallback(() => {
    const kind = kindRef.current;
    if (attachedRef.current && kind) {
      run(kind);
      return;
    }
    // Cleared before re-invoking the original starter — otherwise a cancel() clicked in the window
    // between this retry and the new POST resolving would target the old, already-terminal job id
    // still sitting in jobIdRef from the failed run.
    jobIdRef.current = null;
    engineRetry();
  }, [run, engineRetry]);

  return { ...engine.projection, elapsedMs: engine.elapsedMs, run, attach, retry, cancel };
}

function isGenerationTerminal(job: GenerationJobDetailVM): boolean {
  return TERMINAL.has(job.status);
}
