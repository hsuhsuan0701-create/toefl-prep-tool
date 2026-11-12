import { isSkippedItemScoreJson, type ItemVM } from "@toefl-prep/shared";
import type { ScoringJobState } from "../../hooks/useScoringJob";
import { taskTypeLabel } from "../../lib/taskTypes";
import { Disclosure } from "../../ui/Disclosure";
import { Notice } from "../../ui/Notice";
import ScoringProgress from "../ScoringProgress";
import { RescoreAction } from "./ReviewParts";
import { isPersistedScoreItem, isSpeakingTaskType } from "./reviewItems";
import { failureText } from "./reviewText";

export type ScoringOutcomeProps = {
  item: ItemVM;
  /** The live job's view, present only when that job covers this Item. */
  jobView?: ScoringJobState;
  taskBusy: boolean;
  /** Whether a Re-score would include this Item (reviewItems' isManualRescoreItem). */
  canRescore: boolean;
  /** How many Items of this Task Type a Re-score sends. More than one, and the button is the group's. */
  rescoreCount: number;
  onRescore: () => void;
  /** No server-side work is still running for this Attempt, so "waiting" would be a false promise. */
  settled: boolean;
  /** The Attempt was discarded: nothing in it is scored again. */
  discarded: boolean;
};

/**
 * Where a judged Item's scoring stands when it has no Score Report to show — or is about to get a
 * new one: live progress over the Items a job covers, a failure with what can be done about it, a
 * skip or a recording with no speech (both a real 0), or not scored yet. Renders nothing for an Item
 * with an ordinary Score Report and no job over it.
 */
export function ScoringOutcome({ item, jobView, taskBusy, canRescore, rescoreCount, onRescore, settled, discarded }: ScoringOutcomeProps) {
  if (jobView) return <ScoringProgress job={jobView} onRetry={jobView.retry} />;

  const rescore = (
    <RescoreAction
      onRescore={onRescore}
      taskBusy={taskBusy}
      grouped={rescoreCount > 1}
      taskTypeName={taskTypeLabel(item.taskType)}
      discarded={discarded}
    />
  );

  if (item.scoringStatus === "failed") {
    const failure = failureText(item.scoreJson);
    return (
      <Notice
        tone="critical"
        title="Scoring failed"
        action={
          canRescore ? (
            rescore
          ) : isSpeakingTaskType(item.taskType) ? (
            <p className="text-ui text-ink-soft">
              {item.transcriptionJob
                ? "There is no transcript for this Item yet, so it cannot be re-scored. Scoring follows once the transcription above succeeds."
                : "Only a new Attempt can score it."}
            </p>
          ) : undefined
        }
      >
        <p>{failure.summary} It is not in the band.</p>
        {failure.detail && (
          <Disclosure summary="What the server reported" className="mt-1">
            <p className="break-words">{failure.detail}</p>
          </Disclosure>
        )}
      </Notice>
    );
  }

  if (item.scoringStatus === "scored" && isSkippedItemScoreJson(item.scoreJson)) {
    return (
      <div data-testid="skipped-item-note">
        <Notice tone="caution" title="Skipped, scored 0">
          {item.scoreJson.reason}
        </Notice>
      </div>
    );
  }

  if (item.scoringStatus === "scored" && isPersistedScoreItem(item.scoreJson) && item.scoreJson.noSpeechDetected) {
    return (
      <div data-testid="no-speech-note">
        <Notice tone="caution" title="No speech detected">
          {item.scoreJson.reconciliationNote}
        </Notice>
      </div>
    );
  }

  if (item.scoringStatus === "transcription_pending" && !item.transcriptionJob) {
    return (
      <p className="text-ui text-ink-soft">
        {settled
          ? "This recording was saved but never transcribed, so it was not scored and is not in the band."
          : "This recording is waiting to be transcribed. Scoring starts once the transcript is in."}
      </p>
    );
  }

  if (item.scoringStatus === "pending") {
    return (
      <p className="text-ui text-ink-soft">
        {settled ? "This Response was never scored, and nothing is scoring it now. It is not in the band." : "Not scored yet."}
      </p>
    );
  }

  return null;
}
