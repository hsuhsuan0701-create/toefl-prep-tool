import { isSkippedItemScoreJson, type ItemVM } from "@toefl-prep/shared";
import type { ScoringJobState } from "../../hooks/useScoringJob";
import { taskTypeEntry, taskTypeLabel } from "../../lib/taskTypes";
import { Button } from "../../ui/Button";
import { Disclosure } from "../../ui/Disclosure";
import { asSentence } from "../../ui/format";
import { RESCORE_FAILED } from "../../ui/labels";
import { Notice } from "../../ui/Notice";
import ScoringProgress from "../ScoringProgress";
import { ScoringNotSetUpFailure, SetupLink } from "../setup/ScoringSetupNotice";
import { useScoringNotSetUp } from "../setup/sectionScorability";
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
  // Only a judged section's failure can be down to this machine's setup; asked only once one shows.
  const itemSection = taskTypeEntry(item.taskType)?.section;
  const judgedSection = itemSection === "speaking" || itemSection === "writing" ? itemSection : null;
  const persistedFailure = !jobView && item.scoringStatus === "failed";
  const notSetUp = useScoringNotSetUp(persistedFailure ? judgedSection : null);

  // A failed re-score of a scored Item committed nothing, and the Score Report beneath still shows
  // the committed score, so the notice says the Re-score failed rather than that scoring did.
  if (jobView?.status === "failed" && item.scoringStatus === "scored") {
    return (
      <Notice
        tone="critical"
        live="assertive"
        title={RESCORE_FAILED.label}
        action={
          <Button size="sm" onClick={jobView.retry}>
            Retry scoring
          </Button>
        }
      >
        {jobView.error && <p>{asSentence(jobView.error)}</p>}
        <p>{RESCORE_FAILED.hint}</p>
      </Notice>
    );
  }
  if (jobView) return <ScoringProgress job={jobView} onRetry={jobView.retry} section={judgedSection ?? undefined} />;

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
            <>
              {rescore}
              {notSetUp && <SetupLink />}
            </>
          ) : notSetUp ? (
            <SetupLink />
          ) : isSpeakingTaskType(item.taskType) ? (
            <p className="text-ui text-ink-soft">
              {item.transcriptionJob
                ? "There is no transcript for this Item yet, so it cannot be re-scored. Scoring follows once the transcription above succeeds."
                : "Only a new Attempt can score it."}
            </p>
          ) : undefined
        }
      >
        {/* On a machine that cannot score this section, that is the reason worth reading; the
            server's words, when they say more than a known summary, stay under the Disclosure. */}
        {notSetUp ? <ScoringNotSetUpFailure /> : <p>{failure.summary} It is not in the band.</p>}
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
