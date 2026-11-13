import type { BuildupDiffOp, DeterministicItemScoreJson, ItemVM, JudgeReportVM, ScoreRequest } from "@toefl-prep/shared";
import type { ScoringJobState } from "../../hooks/useScoringJob";
import type { DeliveryReport } from "../../lib/api";
import { scoringInterrupted } from "../../lib/progressUtils";
import type { JudgeSummary, ScoreReportItem } from "../ScoreCard";

// What an Attempt review reads out of each ItemVM: the `scoreJson` shapes the server persists, and
// the rules that decide whether an Item can be re-scored and what that request carries. Pure, so the
// page, its Item renderers and the job controller all ask the same question the same way.

/**
 * What deterministic scoring persists for every Reading/Listening Item in either mode: shared's
 * DeterministicItemScoreJson, whose fields are documented there. The words of the Response
 * (`selectedOptionText`, `selectedOptionIndex`, `prefix`) are absent from rows scored before they
 * were stored.
 */
export type DeterministicScoreJson = DeterministicItemScoreJson;

export function isDeterministicScoreJson(v: unknown): v is DeterministicScoreJson {
  const j = v as { correct?: unknown; module?: unknown; answer?: unknown };
  return typeof v === "object" && v !== null && typeof j.correct === "boolean" && typeof j.module === "string" && typeof j.answer === "string";
}

/** The `meta` a scored spoken Item carries beside its Score Report: the target and diff, or the question. */
export type SpeakingMeta = { target?: string; diff?: BuildupDiffOp[]; question?: string };
export type PersistedScoreItem = ScoreReportItem & { meta?: SpeakingMeta; noSpeechDetected?: boolean; noWordsWritten?: boolean };
/**
 * What Build a Sentence scoring persists. `correctAnswers` (the key) is absent while a Simulation
 * is not yet completed: the server withholds it until then, and correctness alone is shown.
 */
export type BuildSentenceScoreJson = { correct: boolean; correctAnswers?: string[][] };
export type FailedScoreJson = { error: string };

export function isPersistedScoreItem(v: unknown): v is PersistedScoreItem {
  const item = v as { finalScore?: unknown; dimensions?: unknown; selfArbitrated?: unknown };
  return (
    typeof v === "object" &&
    v !== null &&
    typeof item.finalScore === "number" &&
    Array.isArray(item.dimensions) &&
    (item.selfArbitrated === undefined || typeof item.selfArbitrated === "boolean")
  );
}

export function isBuildSentenceScoreJson(v: unknown): v is BuildSentenceScoreJson {
  const key = (v as { correctAnswers?: unknown } | null)?.correctAnswers;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { correct?: unknown }).correct === "boolean" &&
    (key === undefined || Array.isArray(key))
  );
}

export function isFailedScoreJson(v: unknown): v is FailedScoreJson {
  return typeof v === "object" && v !== null && typeof (v as { error?: unknown }).error === "string";
}

/** The four judged Task Types: the only ones scored asynchronously, and so the only ones re-scorable. */
function supportsManualRescore(taskType: string): boolean {
  return taskType === "email" || taskType === "discussion" || taskType === "listen_repeat" || taskType === "interview";
}

export function isSpeakingTaskType(taskType: string): boolean {
  return taskType === "listen_repeat" || taskType === "interview";
}

export function isSelfArbitratedPersistedItem(item: ItemVM): boolean {
  return (
    item.scoringStatus === "scored" &&
    isPersistedScoreItem(item.scoreJson) &&
    item.scoreJson.itemId === item.itemId &&
    item.scoreJson.selfArbitrated === true
  );
}

/**
 * Whether a re-score request naming this Item would be admitted.
 *
 * The server admits a request as a whole: one requested spoken Item with no stored transcript makes
 * it reject the entire request ("missing transcript"), so nothing is re-scored and every Item it
 * named shows the failure. The rows that make this reachable are the failed placeholders written for
 * a recording that never arrived (transcript `null`). Offering those a Re-score would be a guaranteed
 * rejection that also drags every other failed Item of the Task Type down with it.
 *
 * An empty transcript is different: Ears heard the recording and found no speech, and the server
 * admits it and scores it a deterministic 0 without the Judges. Only `null` is absent.
 *
 * Email and Academic Discussion are exempt: their request carries the Response text itself.
 */
export function hasScorableResponse(item: ItemVM): boolean {
  if (!isSpeakingTaskType(item.taskType)) return true;
  return typeof item.transcript === "string";
}

/**
 * The job view to draw instead of an Item's own persisted state (its status chip and Score Report),
 * or undefined. A running job stands in for the Item, and so does a failed one over an Item with no
 * score, which the server marks failed. A failed re-score of a scored Item commits nothing (the
 * server keeps the committed score), so that Item keeps its Score Report and the failure sits above
 * it. A job interrupted by anything but supersession commits nothing either: the refreshed Item says
 * where it stands (failed, or still scored when a re-score of it was interrupted), and only the job's
 * notice and its Retry sit above that.
 */
export function jobViewInPlaceOfItem(jobView: ScoringJobState | undefined, item: ItemVM): ScoringJobState | undefined {
  if (!jobView || scoringInterrupted(jobView.status, jobView.cancellationReason)) return undefined;
  if (jobView.status === "failed" && item.scoringStatus === "scored") return undefined;
  return jobView;
}

/** Failed Items, and Items scored under Self-Arbitration, can be sent for a fresh Judge + Arbiter run. */
export function isManualRescoreItem(item: ItemVM): boolean {
  return (
    supportsManualRescore(item.taskType) &&
    hasScorableResponse(item) &&
    (item.scoringStatus === "failed" || isSelfArbitratedPersistedItem(item))
  );
}

/** The Items a Re-score of this Task Type sends. Scoring is one job per Task Type request, so all go together. */
export function rescoreCandidates(items: ItemVM[], taskType: string): ItemVM[] {
  return items.filter((item) => item.taskType === taskType && isManualRescoreItem(item));
}

/**
 * The POST /:id/score body re-scoring these Items of one Task Type, or null when there is nothing to
 * send or the Task Type does not score asynchronously. Build a Sentence is excluded: it scores
 * synchronously (no job to follow) and never leaves an Item failed.
 */
export function buildRescoreRequest(taskType: string, rescoreItems: ItemVM[]): ScoreRequest | null {
  if (rescoreItems.length === 0) return null;
  if (taskType === "listen_repeat" || taskType === "interview") {
    return { taskType, items: rescoreItems.map((i) => ({ itemId: i.itemId })) };
  }
  if (taskType === "email" || taskType === "discussion") {
    const item = rescoreItems[0];
    // The schema requires secondsUsed but scoring never reads it; 0 is an inert placeholder.
    return { taskType, items: [{ itemId: item.itemId, text: item.responseText ?? "", secondsUsed: 0 }] };
  }
  return null;
}

const ALL_JUDGES = ["gemini", "openai"] as const;

/**
 * The Judge Reports persisted for one Item. A Judge that failed has no row (judge_reports is
 * replaced per Item at scoring time), which is also how the Judges that did not respond are found.
 */
export function judgesForItem(judgeReports: JudgeReportVM[], itemId: string): JudgeSummary[] {
  return judgeReports
    .filter((jr) => jr.itemId === itemId && jr.report)
    .flatMap((jr) => {
      const reportItem = jr.report!.items.find((i) => i.itemId === itemId);
      if (!reportItem) return [];
      return [
        {
          judge: jr.judge,
          mode: jr.mode,
          score: reportItem.score,
          dimensions: reportItem.dimensions,
          deductions: reportItem.deductions,
        },
      ];
    });
}

export function judgesFailedFor(judgeReports: JudgeReportVM[], itemId: string): string[] {
  const present = new Set(judgeReports.filter((jr) => jr.itemId === itemId).map((jr) => jr.judge));
  return ALL_JUDGES.filter((j) => !present.has(j));
}

export function parseDeliveryReport(raw: string | null): DeliveryReport | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as DeliveryReport;
  } catch {
    return null;
  }
}
