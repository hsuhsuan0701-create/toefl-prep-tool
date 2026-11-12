import type { AttemptBandStatusVM, SectionEstimateVM, TranscriptionJobStatus } from "@toefl-prep/shared";
import type { SectionBandResult } from "../services/sectionEstimates.js";
import { liveScoringOutstanding } from "../services/liveScoring.js";

// The Attempt review's answer to "why is there no band here": one pure decision over facts GET
// /:id has already read, so the page can say what is missing and what the User can do about it
// instead of showing a hole.
//
// Whether an unscored judged Item is "scoring" or stuck is liveScoringOutstanding's call, the same
// one a Full-Test Run's section makes (`fullTestSectionBand`), so the Run's report and this review
// never disagree about whether a band is on its way.

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

  const outstanding = liveScoringOutstanding(facts);
  if (outstanding) return { status: "scoring", outstanding };

  // Settled with no band: what the band rule found missing, from the Attempt's current Items. Empty
  // when every Item is scored and still no band is on record.
  return { status: "incomplete", ...(computed.status === "incomplete" ? computed.shortfall : { unscored: [], absent: [] }) };
}
