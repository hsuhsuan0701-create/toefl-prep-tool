import type { ItemVM, JudgeReportVM } from "@toefl-prep/shared";
import type { ScoringJobState } from "../../hooks/useScoringJob";
import { taskTypeLabel } from "../../lib/taskTypes";
import { ScoreFigure } from "../../ui/BandFigure";
import { Card } from "../../ui/Card";
import { StatusChip } from "../../ui/Chip";
import { Kicker } from "../../ui/Heading";
import { Prose } from "../../ui/Prose";
import { ScoreCautionChips, ScoreCautionNotes, ScoreReport } from "../ScoreCard";
import TranscriptDiff from "../TranscriptDiff";
import { scoreCautions } from "../scoreCautions";
import { ItemCard, RescoreAction } from "./ReviewParts";
import { ScoringOutcome } from "./ScoringOutcome";
import { itemStatusChip } from "./reviewText";
import { SpokenPromptAudio } from "./SpokenPromptAudio";
import TranscriptionJobPanel from "./TranscriptionJobPanel";
import {
  isManualRescoreItem,
  isPersistedScoreItem,
  isSelfArbitratedPersistedItem,
  jobViewInPlaceOfItem,
  judgesForItem,
  parseDeliveryReport,
} from "./reviewItems";

export type SpokenItemReviewProps = {
  item: ItemVM;
  position: number;
  total: number;
  /** 1-based position within its Task Type: "Sentence 3", "Question 2". */
  ordinal: number;
  attemptId: string;
  judgeReports: JudgeReportVM[];
  jobView?: ScoringJobState;
  taskBusy: boolean;
  rescoreCount: number;
  onRescore: () => void;
  /** Re-reads the Attempt after a transcription retry; the panel waits for it before re-enabling. */
  onTranscriptionRetried: () => Promise<void>;
  settled: boolean;
  discarded: boolean;
  /**
   * The prompt's audio path, from the Set, to play again beside the recording; scored or not. The
   * page passes it only for a completed Attempt, and it is absent when the Set cannot be read.
   */
  promptAudio?: string;
  /**
   * The sentence or question as text, from the Attempt detail's `spokenPrompts`: the server sends it
   * only for a completed Attempt, scored or not (docs/adr/0017). Shown when the Score Report carries
   * none, so an Item whose transcription or scoring failed still says what was asked.
   */
  promptText?: string;
};

/**
 * A Listen and Repeat sentence or an Interview question: what was asked, the recording, its
 * transcription state, and its Score Report — the transcript marked in red pen, and for Listen and
 * Repeat the word-by-word comparison with the target. The sentence and the question come from the
 * Score Report's `meta`, or, for an Item with no Score Report, from `promptText`, which only a
 * completed Attempt carries: the served Set withholds both. Its prompt audio (`promptAudio`) plays
 * for any Item. The Listen and Repeat scene is the group's, shown once above the sentences
 * (AttemptReview).
 */
export default function SpokenItemReview({
  item,
  position,
  total,
  ordinal,
  attemptId,
  judgeReports,
  jobView,
  taskBusy,
  rescoreCount,
  onRescore,
  onTranscriptionRetried,
  settled,
  discarded,
  promptAudio,
  promptText,
}: SpokenItemReviewProps) {
  const isRepeat = item.taskType === "listen_repeat";
  const report = item.scoringStatus === "scored" && isPersistedScoreItem(item.scoreJson) ? item.scoreJson : null;
  const meta = isPersistedScoreItem(item.scoreJson) ? item.scoreJson.meta : undefined;
  const judges = judgesForItem(judgeReports, item.itemId);
  const noSpeech = report?.noSpeechDetected === true;
  const cautions = report ? scoreCautions(report, judges) : [];
  const inPlace = jobViewInPlaceOfItem(jobView, item);
  const showReport = report !== null && !inPlace;
  const delivery = parseDeliveryReport(item.deliveryReport);
  const replaySrc = item.responseAudioPath ? `/api/audio/responses/${attemptId}/${item.itemId}.webm` : null;
  const transcript = item.transcript ?? "";
  // Both name the same sentence or question when both exist; the Score Report's is preferred, as it
  // is what the Item was scored against.
  const prompt = (isRepeat ? meta?.target : meta?.question) || promptText;
  const title = isRepeat ? `Sentence ${ordinal}` : `Question ${ordinal}`;

  return (
    <ItemCard
      itemId={item.itemId}
      kicker={`Item ${position} of ${total}`}
      title={title}
      headingLevel="h3"
      chips={
        <>
          <StatusChip status={itemStatusChip(item, inPlace, settled)} />
          {showReport && <ScoreCautionChips cautions={cautions} />}
        </>
      }
      figure={showReport ? <ScoreFigure score={report.finalScore} max={report.maxScore} /> : undefined}
    >
      {prompt && (
        <div className="min-w-0 space-y-1">
          <Kicker as="p">{isRepeat ? "The sentence to repeat" : "The question"}</Kicker>
          <Prose size="body">{prompt}</Prose>
        </div>
      )}

      {(promptAudio || replaySrc || delivery) && (
        <div className="space-y-2">
          {promptAudio && <SpokenPromptAudio audio={promptAudio} isRepeat={isRepeat} title={title} />}
          {replaySrc && (
            <div className="space-y-1">
              <Kicker as="p">Your recording</Kicker>
              <audio src={replaySrc} controls className="w-full max-w-measure" aria-label={`Your recording, ${taskTypeLabel(item.taskType)} ${ordinal}`} />
            </div>
          )}
          {delivery && (
            <p className="text-meta text-graphite">
              Pace <span className="figures">{delivery.paceWpm ?? "—"}</span> words a minute · Intonation: {delivery.intonation} · Pauses: {delivery.pauses}
            </p>
          )}
        </div>
      )}

      {/* Rendered from the Item on every load, alongside a scoring job's own progress: it says how
          the Item got here. A recovered Item can carry one at 'awaiting_score' or 'done' while it is
          still pending, so this does not hang off the scoring status. */}
      {item.transcriptionJob && <TranscriptionJobPanel attemptId={attemptId} job={item.transcriptionJob} onRetried={onTranscriptionRetried} />}

      <ScoringOutcome
        item={item}
        jobView={jobView}
        taskBusy={taskBusy}
        canRescore={isManualRescoreItem(item)}
        rescoreCount={rescoreCount}
        onRescore={onRescore}
        settled={settled}
        discarded={discarded}
      />

      {showReport && noSpeech && report.feedbackZh && (
        <section className="space-y-2">
          <h4 className="text-body font-semibold text-ink">Summary</h4>
          <Prose lang="zh-Hant">{report.feedbackZh}</Prose>
        </section>
      )}

      {showReport && !noSpeech && (
        <>
          {cautions.length > 0 && (
            <div className="space-y-2">
              <ScoreCautionNotes cautions={cautions} />
              {isSelfArbitratedPersistedItem(item) && isManualRescoreItem(item) && (
                <RescoreAction
                  onRescore={onRescore}
                  taskBusy={taskBusy}
                  grouped={rescoreCount > 1}
                  taskTypeName={taskTypeLabel(item.taskType)}
                  discarded={discarded}
                />
              )}
            </div>
          )}
          <ScoreReport
            item={report}
            judges={judges}
            responseText={transcript}
            responseLabel="Your Response, transcribed"
            headingLevel="h4"
            responseExtra={
              isRepeat && meta?.diff ? (
                <div className="space-y-1 pt-2">
                  <Kicker as="p">Against the target, word by word</Kicker>
                  <TranscriptDiff diff={meta.diff} />
                </div>
              ) : undefined
            }
          />
        </>
      )}

      {!showReport && !inPlace && transcript.trim() !== "" && (
        <section className="space-y-2">
          <h4 className="text-body font-semibold text-ink">Your Response, transcribed</h4>
          <Card tone="well">
            <Prose>{transcript}</Prose>
          </Card>
        </section>
      )}
    </ItemCard>
  );
}
