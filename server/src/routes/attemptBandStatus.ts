import { isDeterministicTaskType, type AttemptBandStatusVM, type SectionEstimateVM, type TranscriptionJobStatus } from "@toefl-prep/shared";
import type { SectionBandResult } from "../services/sectionEstimates.js";

// The Attempt review's answer to "why is there no band here": one pure decision over facts GET
// /:id has already read, so the page can say what is missing and what the User can do about it
// instead of showing a hole.
//
// It differs from the Full-Test Run's section status (`fullTestSectionBand`) on one point, on
// purpose: an unscored judged Item counts as "scoring" here only while some work that can score it
// is live. An Item left pending or transcription-pending with no job behind it is stuck, and saying
// "still scoring" over it would be a promise nothing will keep.

/** Transcription job statuses with work still to do; the client's Attempt-review poll uses the same set. */
const LIVE_TRANSCRIPTION: ReadonlySet<TranscriptionJobStatus> = new Set(["queued", "running", "retry_wait", "awaiting_score"]);

const UNSCORED: ReadonlySet<string> = new Set(["pending", "transcription_pending"]);

export type AttemptBandFacts = {
  attempt: {
    status: string;
    mode: string;
    capture_finished_at: string | null;
    items: readonly { item_id: string; task_type: string; scoring_status: string }[];
  };
  /** The persisted estimate, already refused when it fails the band rule (readPersistedEstimate). */
  estimate: SectionEstimateVM | null;
  /** computeSectionEstimate over the Attempt's current Items. */
  computed: SectionBandResult;
  /** The Attempt's queued or running scoring jobs. */
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
 * `estimated` when the persisted estimate passed the band rule; otherwise the first of discarded,
 * not applicable (a Reading or Listening Drill, or an unrouted Simulation), unfinished, scoring and
 * incomplete that holds.
 */
export function attemptBandStatus(facts: AttemptBandFacts): AttemptBandStatusVM {
  const { attempt, computed } = facts;
  if (facts.estimate) return { status: "estimated" };
  if (attempt.status === "aborted") return { status: "discarded" };
  if (computed.status === "not-applicable") return { status: "not-applicable", reason: attempt.mode === "drill" ? "drill" : "not-routed" };

  const finalizing = attempt.status === "in_progress" && attempt.capture_finished_at !== null;
  if (attempt.status === "in_progress" && !finalizing) return { status: "unfinished" };

  const live =
    finalizing || facts.activeJobs.length > 0 || facts.transcriptionStatuses.some((status) => LIVE_TRANSCRIPTION.has(status));
  if (live) {
    const covered = new Set(facts.activeJobs.flatMap((job) => job.itemIds));
    const outstanding = attempt.items.filter(
      (item) => !isDeterministicTaskType(item.task_type) && (UNSCORED.has(item.scoring_status) || covered.has(item.item_id)),
    );
    return { status: "scoring", outstanding: countByTaskType(outstanding) };
  }

  // Settled with no band: what the band rule found missing, from the Attempt's current Items. Empty
  // when every Item is scored and still no band is on record.
  return { status: "incomplete", ...(computed.status === "incomplete" ? computed.shortfall : { unscored: [], absent: [] }) };
}
