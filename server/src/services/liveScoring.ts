import { isDeterministicTaskType, type TranscriptionJobStatus } from "@toefl-prep/shared";

// Whether an Attempt still has scoring on its way, decided once for the two places that tell the User
// "still scoring": the Attempt review (routes/attemptBandStatus.ts) and a Full-Test Run's section
// (services/fullTestRun.ts). An unscored judged Item counts as on its way only while some work that
// can score it is live. An Item left pending or transcription-pending with no job behind it (a
// transcription that failed for good, say) is stuck, and saying "still scoring" over it would be a
// promise nothing will keep.

/** Transcription job statuses with work still to do; the client's Attempt-review poll uses the same set. */
const LIVE_TRANSCRIPTION: ReadonlySet<TranscriptionJobStatus> = new Set(["queued", "running", "retry_wait", "awaiting_score"]);

const UNSCORED: ReadonlySet<string> = new Set(["pending", "transcription_pending"]);

export type LiveScoringFacts = {
  attempt: {
    status: string;
    capture_finished_at?: string | null;
    items: readonly { item_id: string; task_type: string; scoring_status: string }[];
  };
  /** The Attempt's queued or running scoring jobs, each with the Items it covers. */
  activeJobs: readonly { itemIds: readonly string[] }[];
  /** The current transcription job's status per Item, where there is one. */
  transcriptionStatuses: readonly TranscriptionJobStatus[];
};

/** Counts per Task Type, in first-seen order (the order the Items were stored). */
function countByTaskType(items: readonly { task_type: string }[]): { taskType: string; itemCount: number }[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.task_type, (counts.get(item.task_type) ?? 0) + 1);
  return [...counts].map(([taskType, itemCount]) => ({ taskType, itemCount }));
}

/**
 * The judged Items still to be scored, counted per Task Type, while work that can score them is live:
 * a Speaking capture the server is still finalizing, a queued or running scoring job, or a
 * transcription job with work left. An Item a live scoring job covers counts even when it is already
 * scored, because that job (a Re-score) replaces its score. Null when nothing is live, so the caller
 * reports what the band rule finds missing instead.
 */
export function liveScoringOutstanding(facts: LiveScoringFacts): { taskType: string; itemCount: number }[] | null {
  const { attempt } = facts;
  const finalizing = attempt.status === "in_progress" && !!attempt.capture_finished_at;
  const live =
    finalizing || facts.activeJobs.length > 0 || facts.transcriptionStatuses.some((status) => LIVE_TRANSCRIPTION.has(status));
  if (!live) return null;
  const covered = new Set(facts.activeJobs.flatMap((job) => job.itemIds));
  return countByTaskType(
    attempt.items.filter((item) => !isDeterministicTaskType(item.task_type) && (UNSCORED.has(item.scoring_status) || covered.has(item.item_id))),
  );
}

/**
 * The status of each Item's current transcription job: the newest one not superseded (the rows come
 * oldest first), as the Attempt review's transcription snapshot reads it.
 */
export function currentTranscriptionStatuses(
  repo: { getCurrentTranscriptionJobs(attemptId: string): readonly { item_id: string; status: string }[] },
  attemptId: string,
): TranscriptionJobStatus[] {
  const newest = new Map<string, TranscriptionJobStatus>();
  for (const job of repo.getCurrentTranscriptionJobs(attemptId)) newest.set(job.item_id, job.status as TranscriptionJobStatus);
  return [...newest.values()];
}
