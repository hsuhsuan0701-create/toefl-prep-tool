import { useCallback, useRef } from "react";
import type {
  CancellationReason,
  ScoringJobDetailVM,
  ScoringJobStatus,
  ScoringProgressDetail,
} from "@toefl-prep/shared";
import { getScoreJob } from "../lib/api";
import { usePolledJob, type PolledJobProjectionInput } from "./usePolledJob";

// "starting" is a client-only state that exists before a jobId is known (the initial POST /score
// that creates the job is still in flight) — every other value mirrors scoring_jobs.status exactly
// (ScoringJobStatus, shared/src/viewModels.ts) as returned by GET /:id/score-jobs/:jobId.
export type ScoringJobUiStatus = "starting" | ScoringJobStatus;

const TERMINAL: ReadonlySet<ScoringJobStatus> = new Set(["done", "failed", "cancelled"]);

export type ScoringJobStarter = () => Promise<{ jobId: string }>;

export type UseScoringJobArgs = {
  // A job that already exists, to re-attach to: the mount polls it and POSTs nothing. AttemptReview's
  // controllers pass one for each `activeJobs` entry.
  jobId?: string | null;
  // Creates the job (a POST /score). Called once on mount when no `jobId` is given, and again by
  // every retry(), which always creates a new scoring_jobs row and never re-polls an old jobId.
  // `start` and `jobId` can be given together: the mount then only polls, and a re-attached job that
  // ends 'failed' still has a Retry that does something. Without `start`, retry() reports a visible
  // failure (see the starter below) instead of doing nothing.
  start?: ScoringJobStarter;
};

export type ScoringJobState = {
  status: ScoringJobUiStatus;
  /** The Items the job scores, from its latest snapshot; null until one has arrived. */
  itemIds: string[] | null;
  stage: string | null;
  judgesDone: string[];
  judgesFailed: string[];
  openaiJudgeProvider: "codex" | "openai-http" | null;
  arbiterProvider: "claude" | "codex" | null;
  fallbackFrom: "claude" | "codex" | null;
  queuePosition: number | null;
  elapsedMs: number;
  result: unknown | null;
  error: string | null;
  cancellationRequestedAt: string | null;
  terminalAt: string | null;
  cancellationReason: CancellationReason | null;
  retry: () => void;
};

/** Everything this hook folds out of polls, i.e. its state minus what the engine owns. */
export type ScoringJobProjection = Omit<ScoringJobState, "elapsedMs" | "retry">;

/** The projection a fresh scoring job starts from — `status` is supplied by the caller below. */
const IDLE: Omit<ScoringJobProjection, "status"> = {
  itemIds: null,
  stage: null,
  judgesDone: [],
  judgesFailed: [],
  openaiJudgeProvider: null,
  arbiterProvider: null,
  fallbackFrom: null,
  queuePosition: null,
  result: null,
  error: null,
  cancellationRequestedAt: null,
  terminalAt: null,
  cancellationReason: null,
};

function isScoringTerminal(job: ScoringJobDetailVM): boolean {
  return TERMINAL.has(job.status);
}

function readJudgeList(key: "judgesDone" | "judgesFailed", progress: ScoringProgressDetail | null): string[] {
  const value = progress?.[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/**
 * Folds one poll into the scoring job's view. Pure, and tested directly with no React involved
 * (client/test/jobProjections.test.ts).
 *
 * The judge lists change only on a snapshot that carries progress. The server's progress accumulates
 * across checkpoints but is null until the first one with detail (judging opens with a tick that has
 * none), so a snapshot without it says nothing about the Judges and must not clear the Gemini and
 * OpenAI badges already shown.
 */
export function projectScoringJob(
  prev: ScoringJobProjection,
  { phase, snapshot, startError }: PolledJobProjectionInput<ScoringJobDetailVM>,
): ScoringJobProjection {
  if (startError !== null) {
    // The starter itself failed: POST /score never produced a job, or (a jobId-only re-attach with
    // no restart handler) there was nothing to call at all. Either way this is a visible failure,
    // never a hang.
    return { ...prev, status: "failed", error: startError };
  }
  if (!snapshot) {
    // Lifecycle-only transition. "starting" is the client-only pre-jobId state; reaching "polling"
    // with nothing back yet means an id is known and the job is, by definition, queued.
    if (phase === "starting") return { ...prev, status: "starting" };
    if (phase === "polling") return { ...prev, status: "queued" };
    return prev;
  }

  const job = snapshot;
  const next: ScoringJobProjection = {
    ...prev,
    status: job.status,
    itemIds: Array.isArray(job.itemIds) ? job.itemIds : prev.itemIds,
    stage: job.stage,
    cancellationRequestedAt: job.cancellationRequestedAt ?? null,
    terminalAt: job.terminalAt ?? null,
    cancellationReason: job.cancellationReason ?? null,
  };

  if (job.progress) {
    next.judgesDone = readJudgeList("judgesDone", job.progress);
    next.judgesFailed = readJudgeList("judgesFailed", job.progress);
    // Read from each snapshot rather than kept from the last one: the server holds the field in a
    // running job's progress once it is known and drops it when the job ends, so a finished job's
    // panel names no provider.
    next.openaiJudgeProvider =
      job.progress.openaiJudgeProvider === "codex" ||
      job.progress.openaiJudgeProvider === "openai-http"
        ? job.progress.openaiJudgeProvider
        : null;
    const arbiterProvider =
      job.progress.arbiterProvider === "claude" ||
      job.progress.arbiterProvider === "codex"
        ? job.progress.arbiterProvider
        : null;
    const fallbackFrom =
      arbiterProvider !== null &&
      (
        job.progress.fallbackFrom === "claude" ||
        job.progress.fallbackFrom === "codex"
      ) &&
      job.progress.fallbackFrom !== arbiterProvider
        ? job.progress.fallbackFrom
        : null;
    next.arbiterProvider = arbiterProvider;
    next.fallbackFrom = fallbackFrom;
    next.queuePosition =
      typeof job.progress.queuePosition === "number"
        ? job.progress.queuePosition
        : null;
  }

  if (job.status === "done") {
    next.result = job.result ?? null;
  } else if (job.status === "failed") {
    next.error = typeof job.error === "string" ? job.error : "Scoring failed.";
  }
  return next;
}

/**
 * Polls GET /api/attempts/:id/score-jobs/:jobId every 1.5 s until the job is done, failed or
 * cancelled (a newer request for the same Task Type cancels it with reason `superseded`). A failed
 * fetch, a server restart included, is never an error state by itself: the loop backs off (capped)
 * and keeps polling the same jobId. Boot recovery ends a job the restart interrupted as 'failed' (or
 * 'cancelled', when a cancel was recorded), which arrives here as an ordinary terminal status rather
 * than a hang. The loop is usePolledJob's; this hook supplies the
 * endpoint and the projection.
 *
 * `attemptId` and `jobId`/`start` (see UseScoringJobArgs) say what to poll. `retry()` always goes
 * through `start` and creates a new job; it never re-polls a finished jobId. With no `start` (a
 * jobId-only re-attach), retry() lands in a visible 'failed' state.
 */
export function useScoringJob(attemptId: string, args: UseScoringJobArgs): ScoringJobState {
  const jobIdRef = useRef<string | null>(args.jobId ?? null);
  const startRef = useRef<ScoringJobStarter | undefined>(args.start);
  startRef.current = args.start;
  const attemptIdRef = useRef(attemptId);
  attemptIdRef.current = attemptId;

  // Re-attaching to a known jobId returns its handle synchronously: no POST is made, so the engine
  // skips "starting" and this hook reports 'queued' from the first frame.
  const starter = useCallback(() => {
    const known = jobIdRef.current;
    if (known) return { fetch: () => getScoreJob(attemptIdRef.current, known) };

    const start = startRef.current;
    if (!start) {
      // Reachable when the hook was given neither `jobId` nor `start` (a caller bug), or when
      // retry() runs on a jobId-only re-attach. Doing nothing would leave a Retry button that never
      // works, so it fails visibly instead, thrown synchronously so it settles in the same tick as
      // the click.
      throw new Error("Can't restart this job — no restart handler was provided.");
    }
    // The new id lives in the fetch closure, not back in jobIdRef: retry() always clears the ref to
    // force a fresh POST, so writing it back would only open a window in which a stale starter
    // could hand a dead job id to the next retry.
    return start().then((res) => ({ fetch: () => getScoreJob(attemptIdRef.current, res.jobId) }));
  }, []);

  const initial = useCallback(
    (): ScoringJobProjection => ({
      ...IDLE,
      status: jobIdRef.current ? "queued" : "starting",
    }),
    [],
  );

  const engine = usePolledJob<ScoringJobDetailVM, ScoringJobProjection>({
    initial,
    project: projectScoringJob,
    isTerminal: isScoringTerminal,
    autoStart: starter,
  });

  const { retry: beginAgain } = engine;
  const retry = useCallback(() => {
    jobIdRef.current = null; // force a fresh start() — never re-poll a finished jobId
    beginAgain();
  }, [beginAgain]);

  return { ...engine.projection, elapsedMs: engine.elapsedMs, retry };
}
