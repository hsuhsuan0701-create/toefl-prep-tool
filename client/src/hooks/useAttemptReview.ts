import { useCallback, useEffect, useRef, useState } from "react";
import type { AttemptDetailVM, ItemVM, TranscriptionJobVM } from "@toefl-prep/shared";
import { getAttempt, getSet } from "../lib/api";
import { requestErrorMessage } from "../lib/requestError";
import { snapshotAttemptSet, type AttemptSetSnapshot } from "../pages/attemptSetSnapshot";
import { rescoreCandidates } from "../components/review/reviewItems";
import type { ScoringJobState } from "./useScoringJob";

// Everything Attempt review keeps between renders: the Attempt detail and the one path that writes
// it, the self-rescheduling poll that follows durable server-side work, the best-effort Set fetch,
// and the registry of scoring-job controllers (components/review/TaskJobController.tsx) that draw
// live progress over exactly the Items each job covers.
//
// There are two pollers on purpose. This hook polls GET /:id while transcription, scoring or a
// capture's finalization is active; each controller polls its own job. They are not redundant:
// `activeJobs` carries only a job's stage and Items, never its Judge ticks, queue position, error or
// cancellation, and a job drops out of it the moment it ends — so a failed job's "Scoring failed"
// with its Retry over the covered Items can only come from the per-job read.

const TRANSCRIPTION_ACTIVE_STATUSES: ReadonlySet<TranscriptionJobVM["status"]> = new Set([
  "queued",
  "running",
  "retry_wait",
  "awaiting_score",
]);

export type PollReasons = { transcriptionActive: boolean; scoringActive: boolean; captureFinalizing: boolean };

/**
 * Why the Attempt still needs polling, read from the last fetched detail. Kept as three reasons
 * rather than one boolean because only one of them has no natural end: transcription and scoring
 * jobs reach a terminal status and drop out of the snapshot, but "capture finished while the Attempt
 * is still in progress" stays true forever if server-side reconciliation never completes it.
 */
export function pollReasons(detail: AttemptDetailVM): PollReasons {
  return {
    transcriptionActive: detail.items.some(
      (item) => item.transcriptionJob && TRANSCRIPTION_ACTIVE_STATUSES.has(item.transcriptionJob.status),
    ),
    scoringActive: detail.activeJobs.length > 0,
    captureFinalizing: detail.attempt.captureFinishedAt !== null && detail.attempt.status === "in_progress",
  };
}

const POLL_INTERVAL_MS = 2_000;
// A failing poll backs off up to this, rather than re-arming at a flat 2 s against a server that is down.
const POLL_BACKOFF_MAX_MS = 15_000;
// How many consecutive cycles may poll for capture finalization alone (~2 minutes): well past the
// server's own delayed grace reconcile (about 31 s), after which nothing this poll can observe will
// change without a reload. Any transcription or scoring activity resets the count.
const MAX_FINALIZING_ONLY_POLLS = 60;

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function sameOptionalList(a: string[] | null, b: string[] | null): boolean {
  return a === null || b === null ? a === b : sameStringList(a, b);
}

// A job in one of these states has nothing left to do, so its Task Type is free for a new Re-score.
// ('done' never lingers: a controller that sees it releases its Task Type.)
const SETTLED_JOB_STATUSES: ReadonlySet<ScoringJobState["status"]> = new Set(["failed", "cancelled"]);

/**
 * Whether two job views render identically. useScoringJob returns a fresh object every render, and a
 * controller reports it on every render, so storing it unconditionally re-renders the controller,
 * which reports again, without end. Skipping identical views ends that cycle; `elapsedMs` changes
 * once a second, so a running job settles at a re-render per tick.
 */
export function sameScoringView(a: ScoringJobState, b: ScoringJobState): boolean {
  return (
    a.status === b.status &&
    sameOptionalList(a.itemIds, b.itemIds) &&
    a.stage === b.stage &&
    a.openaiJudgeProvider === b.openaiJudgeProvider &&
    a.arbiterProvider === b.arbiterProvider &&
    a.fallbackFrom === b.fallbackFrom &&
    a.queuePosition === b.queuePosition &&
    a.elapsedMs === b.elapsedMs &&
    a.error === b.error &&
    a.result === b.result &&
    a.retry === b.retry &&
    sameStringList(a.judgesDone, b.judgesDone) &&
    sameStringList(a.judgesFailed, b.judgesFailed)
  );
}

/**
 * One Task Type's registered controller: the job it follows (null while a Re-score's POST is still
 * in flight), the Items that job covers, and how many times the Task Type has been armed —
 * part of the controller's key, so arming again after a failed job mounts a fresh controller.
 */
export type ControllerEntry = { jobId: string | null; itemIds: string[]; arm: number };

export type AttemptReviewState = {
  detail: AttemptDetailVM | null;
  error: string | null;
  /** The Set's display enrichments, or null until (or unless) the Set could be read. */
  setSnapshot: AttemptSetSnapshot | null;
  /** True once the capture-finalizing poll has given up, so the page stops promising it updates itself. */
  finalizingStalled: boolean;
  /** Every registered controller, by Task Type. The page renders one TaskJobController per entry. */
  controllers: Record<string, ControllerEntry>;
  /** A live job's view, only when that job covers this Item; every other Item keeps its persisted state. */
  coveredJobView: (item: ItemVM) => ScoringJobState | undefined;
  /** A job for this Task Type has not settled, so a Re-score must wait for it. */
  taskBusy: (taskType: string) => boolean;
  rescore: (taskType: string) => void;
  /** Re-reads the Attempt in the background; settles once it has (or failed to), never rejecting. */
  refresh: () => Promise<void>;
  onJobView: (taskType: string, instanceId: number, view: ScoringJobState) => void;
  onJobUnmounted: (taskType: string, instanceId: number) => void;
  onJobLanded: (taskType: string) => void;
  onJobFailed: (taskType: string) => void;
};

export function useAttemptReview(id: string | undefined): AttemptReviewState {
  const [detail, setDetail] = useState<AttemptDetailVM | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The controller registry: Task Type -> the job its controller follows. Sticky state, never
  // derived from `detail.activeJobs` on each render: this hook's poll refreshes `detail`
  // independently of each controller's own job poll, so `activeJobs` routinely empties before the
  // controller has seen `done` itself. Deriving lifetime from it would unmount a controller before
  // it lands (a frozen progress panel over landed scores) and flip its key back to armed, which
  // mounts a fresh controller whose start() POSTs a second, paid Judge and Arbiter run.
  //
  // Three rules, which together rule both out:
  //   - Add only: a Task Type enters when it appears in activeJobs or the User arms it.
  //   - Move forward only: null -> jobId once one is observed; jobId -> a different jobId if the
  //     server names one (poll-only: a controller mounted with a jobId polls it and POSTs nothing).
  //     The one way back to an armed entry is an explicit Re-score on a Task Type whose job settled
  //     as failed or cancelled, which bumps `arm` so a fresh controller starts a new job.
  //   - Remove only in onJobLanded, after a controller has observed a terminal status itself.
  const [controllers, setControllers] = useState<Record<string, ControllerEntry>>({});
  // Each in-flight Task Type's live job view, lifted out of its controller so every card the job
  // covers draws the same progress instead of polling the same job again. Tagged with the reporting
  // instance so an unmounting controller only ever clears its own entry.
  const [jobsByTaskType, setJobsByTaskType] = useState<Record<string, { instanceId: number; view: ScoringJobState }>>({});
  // Read by rescore, which must know whether a Task Type's job has settled without being re-created
  // on every view tick. Assigned during render, like currentIdRef below.
  const jobsByTaskTypeRef = useRef(jobsByTaskType);
  jobsByTaskTypeRef.current = jobsByTaskType;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const [finalizingStalled, setFinalizingStalled] = useState(false);
  const [setSnapshot, setSetSnapshot] = useState<AttemptSetSnapshot | null>(null);
  const mountedRef = useRef(true);
  const requestedSetIdRef = useRef<string | null>(null);
  // Request ordering shared by every writer of `detail` (initial load, poll, refresh). Without it a
  // poll issued just before a transcription retry could land after the retry's refresh and put back
  // the pre-retry snapshot — and since the poll gate reads that snapshot, polling would stop with an
  // enabled Retry over a retry that is genuinely running.
  const requestSeqRef = useRef(0);
  const appliedSeqRef = useRef(0);
  const pollBackoffRef = useRef(POLL_INTERVAL_MS);
  const finalizingOnlyPollsRef = useRef(0);
  // The latest route param, read when a fetch resolves to drop a response for an Attempt the User
  // has already left. Assigned during render so callbacks created this render see it.
  const currentIdRef = useRef<string | undefined>(id);
  currentIdRef.current = id;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The single path that writes `detail`. Resolves to the applied snapshot, or null when the
  // response was dropped (superseded, wrong Attempt, or unmounted); rejects only on a real failure.
  const fetchDetail = useCallback(async (): Promise<AttemptDetailVM | null> => {
    if (!id) return null;
    const seq = requestSeqRef.current + 1;
    requestSeqRef.current = seq;
    const d = await getAttempt(id);
    if (!mountedRef.current || currentIdRef.current !== id || seq <= appliedSeqRef.current) return null;
    appliedSeqRef.current = seq;
    setDetail(d);
    return d;
  }, [id]);

  // A background re-fetch that keeps the page on screen (no reset to the loading state), used when a
  // job lands or fails and after a transcription retry. Ordered with the poll through fetchDetail.
  // Settles once a snapshot issued at or after this call has been applied (a newer one wins over this
  // one's) or the fetch failed, and never rejects, so a caller can wait for it.
  const refresh = useCallback(
    (): Promise<void> =>
      fetchDetail().then(
        () => undefined,
        (e) => {
          console.error("AttemptReview: refresh failed", e);
        },
      ),
    [fetchDetail],
  );

  useEffect(() => {
    const setId = detail?.attempt.setId;
    if (!setId || requestedSetIdRef.current === setId) return;

    requestedSetIdRef.current = setId;
    setSetSnapshot(null);
    void getSet(setId)
      .then((set) => {
        if (mountedRef.current && requestedSetIdRef.current === setId) {
          setSetSnapshot(snapshotAttemptSet(setId, set));
        }
      })
      .catch((e) => {
        // Best-effort: a Set that cannot be read leaves the snapshot null and the review renders
        // from the Attempt alone. Never a broken page.
        console.warn(`AttemptReview: set ${setId} fetch failed; continuing without set metadata`, e);
      });
  }, [detail?.attempt.setId]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    setDetail(null);
    setError(null);
    // All of this belongs to one Attempt. Kept across a route change, the registry would mount a
    // controller for the new Attempt carrying the old Attempt's jobId, or POST a re-score of an
    // Attempt nobody asked to re-score.
    setControllers({});
    setJobsByTaskType({});
    setFinalizingStalled(false);
    pollBackoffRef.current = POLL_INTERVAL_MS;
    finalizingOnlyPollsRef.current = 0;
    void fetchDetail().catch((e) => {
      if (!cancelled) setError(requestErrorMessage(e));
    });
    return () => {
      cancelled = true;
    };
  }, [id, fetchDetail]);

  // The only place `activeJobs` feeds the registry, and only by adding. A Task Type that drops out of
  // activeJobs stays registered until its own controller reports a terminal status.
  useEffect(() => {
    if (!detail) return;
    setControllers((prev) => {
      let next = prev;
      for (const job of detail.activeJobs) {
        if (prev[job.taskType]?.jobId === job.jobId) continue;
        if (next === prev) next = { ...prev };
        next[job.taskType] = { jobId: job.jobId, itemIds: job.itemIds ?? [], arm: prev[job.taskType]?.arm ?? 0 };
      }
      return next;
    });
  }, [detail]);

  // Poll GET /:id while durable work is active (pollReasons). Self-rescheduling: each fetch that
  // changes `detail` re-runs this effect, which decides whether to arm the next timer, so polling
  // stops by itself the moment no reason survives in the current detail.
  useEffect(() => {
    if (!id || !detail) return;
    const reasons = pollReasons(detail);
    if (!reasons.transcriptionActive && !reasons.scoringActive && !reasons.captureFinalizing) {
      pollBackoffRef.current = POLL_INTERVAL_MS;
      finalizingOnlyPollsRef.current = 0;
      setFinalizingStalled(false);
      return;
    }
    if (reasons.transcriptionActive || reasons.scoringActive) {
      finalizingOnlyPollsRef.current = 0;
      setFinalizingStalled(false);
    } else {
      finalizingOnlyPollsRef.current += 1;
      if (finalizingOnlyPollsRef.current > MAX_FINALIZING_ONLY_POLLS) {
        setFinalizingStalled(true);
        return;
      }
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = () => {
      void fetchDetail()
        .then(() => {
          pollBackoffRef.current = POLL_INTERVAL_MS;
        })
        .catch((e) => {
          console.error("AttemptReview: poll failed", e);
          if (cancelled) return;
          pollBackoffRef.current = Math.min(pollBackoffRef.current * 2, POLL_BACKOFF_MAX_MS);
          timer = setTimeout(poll, pollBackoffRef.current);
        });
    };
    timer = setTimeout(poll, pollBackoffRef.current);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id, detail, fetchDetail]);

  const rescore = useCallback((taskType: string) => {
    // A discarded Attempt is never scored again; the server refuses it and the page offers none.
    if (detailRef.current?.attempt.status === "aborted") return;
    const view = jobsByTaskTypeRef.current[taskType]?.view;
    const itemIds = rescoreCandidates(detailRef.current?.items ?? [], taskType).map((i) => i.itemId);
    setControllers((prev) => {
      const current = prev[taskType];
      // A controller whose job has not settled owns this Task Type: a second click must never re-key
      // it, which is exactly the transition that calls start(). One whose job failed or was
      // cancelled has nothing left to do, so an explicit Re-score arms a fresh controller.
      if (current && !(view && SETTLED_JOB_STATUSES.has(view.status))) return prev;
      return { ...prev, [taskType]: { jobId: null, itemIds, arm: (current?.arm ?? 0) + 1 } };
    });
  }, []);

  const onJobView = useCallback((taskType: string, instanceId: number, view: ScoringJobState) => {
    setJobsByTaskType((prev) => {
      const current = prev[taskType];
      if (current && current.instanceId === instanceId && sameScoringView(current.view, view)) return prev;
      return { ...prev, [taskType]: { instanceId, view } };
    });
  }, []);

  // Clears a Task Type's live view when its controller leaves for any reason other than landing (a
  // re-key onto a newly observed jobId, or the page unmounting) — only while the stored entry still
  // belongs to the leaving instance, so a successor that has already reported is never wiped.
  const onJobUnmounted = useCallback((taskType: string, instanceId: number) => {
    setJobsByTaskType((prev) => {
      if (prev[taskType]?.instanceId !== instanceId) return prev;
      const next = { ...prev };
      delete next[taskType];
      return next;
    });
  }, []);

  const onJobLanded = useCallback(
    (taskType: string) => {
      // The one place a Task Type leaves the registry.
      setControllers((prev) => {
        if (!(taskType in prev)) return prev;
        const next = { ...prev };
        delete next[taskType];
        return next;
      });
      setJobsByTaskType((prev) => {
        if (!(taskType in prev)) return prev;
        const next = { ...prev };
        delete next[taskType];
        return next;
      });
      void refresh();
    },
    [refresh],
  );

  // Refreshes but leaves the controller mounted, so the failure and its Retry stay on screen.
  const onJobFailed = useCallback(() => {
    void refresh();
  }, [refresh]);

  const coveredJobView = (item: ItemVM): ScoringJobState | undefined => {
    const live = jobsByTaskType[item.taskType];
    if (!live) return undefined;
    // The job's own snapshot says which Items it covers; until one arrives, the request that started it.
    const covered = live.view.itemIds ?? controllers[item.taskType]?.itemIds ?? [];
    return covered.includes(item.itemId) ? live.view : undefined;
  };

  const taskBusy = (taskType: string): boolean => {
    if (!(taskType in controllers)) return false;
    const live = jobsByTaskType[taskType];
    return !(live && SETTLED_JOB_STATUSES.has(live.view.status));
  };

  return {
    detail,
    error,
    setSnapshot: detail && setSnapshot?.setId === detail.attempt.setId ? setSnapshot : null,
    finalizingStalled,
    controllers,
    coveredJobView,
    taskBusy,
    rescore,
    refresh,
    onJobView,
    onJobUnmounted,
    onJobLanded,
    onJobFailed,
  };
}
