import { useCallback, useEffect, type ReactNode } from "react";
import { scoreTask } from "../../lib/api";
import { TASK_TYPES } from "../../lib/taskTypes";
import { scoringInterrupted } from "../../lib/progressUtils";
import { forgetScoringJob, scoringJobKey, startScoringJobOnce } from "../../lib/scoringJobOnce";
import { useScoringJob } from "../../hooks/useScoringJob";
import SceneImage from "../../components/SceneImage";
import { ScoreCautionChips, ScoreCautionNotes, ScoreReport } from "../../components/ScoreCard";
import { scoreCautions } from "../../components/scoreCautions";
import { ItemCard } from "../../components/review/ReviewParts";
import { SpokenPromptAudio } from "../../components/review/SpokenPromptAudio";
import ScoringProgress from "../../components/ScoringProgress";
import TranscriptDiff from "../../components/TranscriptDiff";
import type { RunnableItem } from "../../components/ItemRecorder";
import { ScoreFigure } from "../../ui/BandFigure";
import { StatusChip } from "../../ui/Chip";
import { Kicker, SectionHeader } from "../../ui/Heading";
import { Notice } from "../../ui/Notice";
import { Prose } from "../../ui/Prose";
import { ITEM_SCORING_STATUS, type StatusPresentation } from "../../ui/labels";
import {
  judgesForItem,
  type SpeakingScoreResult,
  type SpeakingSlotSpec,
  type SpeakingTaskKind,
} from "./speakingDrillModel";

/**
 * One Task Type's results in the Speaking Drill. Fires the Task's scoring job the moment it mounts
 * and shows the job until it lands, then the results Item by Item.
 *
 * The job is started through lib/scoringJobOnce.ts, keyed by Attempt and Task Type, so this slot can
 * be drawn in one place while the Drill runs (`compact`: one status line) and in another on the
 * results screen without a second POST /score superseding the first. Only an explicit Retry starts a
 * new job.
 */
export default function SpeakingResultSlot({
  attemptId,
  spec,
  compact,
  onStatusChange,
}: {
  attemptId: string | null;
  spec: SpeakingSlotSpec;
  compact: boolean;
  onStatusChange: (kind: SpeakingTaskKind, inFlight: boolean) => void;
}) {
  const { kind, items } = spec;
  const key = attemptId ? scoringJobKey(attemptId, kind) : null;

  const start = useCallback((): Promise<{ jobId: string }> => {
    if (!attemptId || !key) return Promise.reject(new Error("no attempt id"));
    return startScoringJobOnce(key, async () => {
      const res = await scoreTask(attemptId, { taskType: kind, items: items.map((it) => ({ itemId: it.id })) });
      if (!("jobId" in res)) throw new Error("unexpected synchronous response scoring a speaking task");
      return res;
    });
  }, [attemptId, key, kind, items]);

  const job = useScoringJob(attemptId ?? "", { start });

  // An explicit Retry starts a new job, so the registry must not hand back the failed one.
  const { retry } = job;
  const handleRetry = useCallback(() => {
    if (key) forgetScoringJob(key);
    retry();
  }, [key, retry]);

  const settled = job.status === "done" || job.status === "failed" || job.status === "cancelled";
  useEffect(() => {
    onStatusChange(kind, !settled);
  }, [settled, kind, onStatusChange]);

  const title = TASK_TYPES[kind].label;

  if (compact) {
    return (
      <p className="text-meta text-graphite">
        <span className="font-medium text-ink-soft">{title}</span> ·{" "}
        {job.status === "done"
          ? "scored. Results at the end of the Drill."
          : job.status === "failed"
            ? "scoring failed. You can retry it at the end of the Drill."
            : scoringInterrupted(job.status, job.cancellationReason)
              ? "scoring was interrupted. You can retry it at the end of the Drill."
              : "being scored while you go on."}
      </p>
    );
  }

  if (job.status === "done" && job.result) {
    return <CompletedSpeakingStage spec={spec} result={job.result as SpeakingScoreResult} attemptId={attemptId} />;
  }

  // A job that ended without scores still leaves each Item's prompt and recording to listen to: the
  // Drill is over, and nothing else on this screen says what those recordings answered.
  const unscored = job.status === "failed" || scoringInterrupted(job.status, job.cancellationReason);
  return (
    <section aria-label={title} className="space-y-4">
      <SectionHeader title={title} />
      <ScoringProgress job={job} onRetry={handleRetry} section="speaking" />
      {unscored && (
        <div className="space-y-6">
          {items.map((item, i) => (
            <UnscoredSpokenItem
              key={item.id}
              item={item}
              kind={kind}
              number={spec.numberByItemId[item.id] ?? i + 1}
              total={Object.keys(spec.numberByItemId).length || items.length}
              attemptId={attemptId}
              status={ITEM_SCORING_STATUS.failed}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One spoken Item of the Drill with no score on this screen (its scoring failed, or its recording
 * went to background transcription): its prompt to play again, and the User's recording.
 */
export function UnscoredSpokenItem({
  item,
  kind,
  number,
  total,
  attemptId,
  status,
  kickerPrefix,
  children,
}: {
  item: RunnableItem;
  kind: SpeakingTaskKind;
  number: number;
  total: number;
  attemptId: string | null;
  status: StatusPresentation;
  /** Names the Task when the card is not inside its Task's own section. */
  kickerPrefix?: string;
  children?: ReactNode;
}) {
  const isRepeat = kind === "listen_repeat";
  const title = isRepeat ? `Sentence ${number}` : `Question ${number}`;
  return (
    <ItemCard
      itemId={item.id}
      kicker={`${kickerPrefix ? `${kickerPrefix} · ` : ""}Item ${number} of ${total}`}
      title={title}
      headingLevel="h3"
      chips={<StatusChip status={status} />}
    >
      {children}
      <div className="space-y-2">
        <SpokenPromptAudio audio={item.audio} isRepeat={isRepeat} title={title} />
        {attemptId && <RecordingPlayer attemptId={attemptId} itemId={item.id} title={title} />}
      </div>
    </ItemCard>
  );
}

function RecordingPlayer({ attemptId, itemId, title }: { attemptId: string; itemId: string; title: string }) {
  return (
    <div className="space-y-1">
      <Kicker as="p">Your recording</Kicker>
      <audio src={`/api/audio/responses/${attemptId}/${itemId}.webm`} controls className="w-full max-w-measure" aria-label={`Your recording, ${title}`} />
    </div>
  );
}

/**
 * A scored Task, drawn the way Attempt review draws it: the Listen and Repeat scene once for the
 * Task, then one card per Item with what was asked (the prompt to play again, and its text from the
 * scoring job's meta), the recording and its Score Report.
 */
function CompletedSpeakingStage({
  spec,
  result,
  attemptId,
}: {
  spec: SpeakingSlotSpec;
  result: SpeakingScoreResult;
  attemptId: string | null;
}) {
  const { kind, items, transcripts, numberByItemId, scene } = spec;
  const isRepeat = kind === "listen_repeat";
  const total = Object.keys(numberByItemId).length || items.length;
  return (
    <section aria-label={TASK_TYPES[kind].label} className="space-y-4">
      <SectionHeader title={TASK_TYPES[kind].label} />
      {result.judgesFailed.length > 0 && (
        <Notice tone="caution" title="One Judge did not answer">
          {result.judgesFailed.join(", ")} failed to respond for this Task. These scores come from the other Judge and the
          Arbiter only.
        </Notice>
      )}
      {isRepeat && scene && (
        <div className="w-full max-w-56">
          <SceneImage file={scene.file} />
        </div>
      )}
      <div className="space-y-6">
        {items.map((item, i) => {
          // The Item's position in the Task the User sat, not in this scoreable-only list.
          const itemNumber = numberByItemId[item.id] ?? i + 1;
          const meta = result.items.find((m) => m.itemId === item.id);
          const reportItem = result.report.items.find((r) => r.itemId === item.id);
          const transcript = transcripts[item.id] ?? "";
          const title = isRepeat ? `Sentence ${itemNumber}` : `Question ${itemNumber}`;

          if (!reportItem) {
            return (
              <UnscoredSpokenItem
                key={item.id}
                item={item}
                kind={kind}
                number={itemNumber}
                total={total}
                attemptId={attemptId}
                status={ITEM_SCORING_STATUS.failed}
              >
                <Notice tone="critical" title={`${title}: scoring failed`}>
                  No score is available for this Item.
                </Notice>
              </UnscoredSpokenItem>
            );
          }

          const judges = judgesForItem(result, item.id);
          const cautions = scoreCautions(reportItem, judges);
          const prompt = isRepeat ? meta?.target : meta?.question;
          return (
            <ItemCard
              key={item.id}
              itemId={item.id}
              kicker={`Item ${itemNumber} of ${total}`}
              title={title}
              headingLevel="h3"
              chips={cautions.length > 0 ? <ScoreCautionChips cautions={cautions} /> : undefined}
              figure={<ScoreFigure score={reportItem.finalScore} max={reportItem.maxScore} />}
            >
              {prompt && (
                <div className="min-w-0 space-y-1">
                  <Kicker as="p">{isRepeat ? "The sentence to repeat" : "The question"}</Kicker>
                  <Prose size="body">{prompt}</Prose>
                </div>
              )}
              <div className="space-y-2">
                <SpokenPromptAudio audio={item.audio} isRepeat={isRepeat} title={title} />
                {attemptId && <RecordingPlayer attemptId={attemptId} itemId={item.id} title={title} />}
              </div>
              <ScoreCautionNotes cautions={cautions} />
              <ScoreReport
                item={reportItem}
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
            </ItemCard>
          );
        })}
      </div>
    </section>
  );
}
