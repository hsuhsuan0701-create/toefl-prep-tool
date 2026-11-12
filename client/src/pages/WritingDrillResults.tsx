import { useCallback, useEffect } from "react";
import type { BuildSentenceDrillScoreItemVM } from "@toefl-prep/shared";
import { scoreTask } from "../lib/api";
import { TASK_TYPES } from "../lib/taskTypes";
import { scoringInterrupted } from "../lib/progressUtils";
import { forgetScoringJob, scoringJobKey, startScoringJobOnce } from "../lib/scoringJobOnce";
import { useScoringJob } from "../hooks/useScoringJob";
import { sentenceAnswerText } from "../components/sentenceAnswerText";
import type { BuildSentenceItem } from "../components/buildSentence";
import ScoreCard, { type EssayScoreResult } from "../components/ScoreCard";
import ScoringProgress from "../components/ScoringProgress";
import { ResultMark } from "../components/review/ReviewParts";
import { SectionHeader } from "../ui/Heading";

// The Writing Drill's results, Task by Task: Build a Sentence's deterministic results, and each
// essay's scoring job and Score Report. Drawn two ways from the same components — a one-line status
// per Task while the Drill is still running, so the Task on screen keeps the room, and in full on
// the results screen at the end.

/** One Item of a Drill's Build a Sentence answer, which carries its key. */
export type BuildSentenceResult = BuildSentenceDrillScoreItemVM;

export type SubmittedAnswer = { itemId: string; tileOrder: string[] };

export type EssayKind = "email" | "discussion";

export type CompletedBuildSentence = {
  kind: "build_sentence";
  items: BuildSentenceItem[];
  answers: SubmittedAnswer[];
  results: BuildSentenceResult[];
};

/**
 * An essay Task's slot, added the moment the Task is handed in (not once scored): everything
 * EssayResultSlot needs to fire — and, on Retry, re-fire — the scoring job itself while the Drill
 * moves on to the next Task.
 */
export type EssaySlot = { kind: EssayKind; userText: string; itemId: string; secondsUsed: number };

export type CompletedStage = CompletedBuildSentence | EssaySlot;

export function CompletedStageView({
  stage,
  attemptId,
  compact,
  onEssayStatusChange,
}: {
  stage: CompletedStage;
  attemptId: string | null;
  /** One line while the Drill is still running; the full results on the results screen. */
  compact: boolean;
  onEssayStatusChange: (kind: EssayKind, inFlight: boolean) => void;
}) {
  if (stage.kind === "build_sentence") {
    return compact ? <BuildSentenceStatusLine stage={stage} /> : <BuildSentenceResults stage={stage} />;
  }
  // attemptId is always set by the time an essay slot exists (only created after the Attempt is);
  // the null case is defensive, so this never crashes.
  if (!attemptId) return null;
  return (
    <EssayResultSlot
      attemptId={attemptId}
      kind={stage.kind}
      itemId={stage.itemId}
      userText={stage.userText}
      secondsUsed={stage.secondsUsed}
      compact={compact}
      onStatusChange={onEssayStatusChange}
    />
  );
}

function BuildSentenceStatusLine({ stage }: { stage: CompletedBuildSentence }) {
  const correct = stage.results.filter((r) => r.correct).length;
  return (
    <p className="text-meta text-graphite">
      <span className="font-medium text-ink-soft">Build a Sentence</span> · {correct} of {stage.items.length} correct.
      Details at the end of the Drill.
    </p>
  );
}

function BuildSentenceResults({ stage }: { stage: CompletedBuildSentence }) {
  const correct = stage.results.filter((r) => r.correct).length;
  return (
    <section aria-labelledby="bas-results" className="space-y-4">
      <SectionHeader
        id="bas-results"
        title={TASK_TYPES.build_sentence.label}
        description={`${correct} of ${stage.items.length} correct`}
      />
      <ol className="divide-y divide-rule rounded-sheet border border-rule bg-sheet">
        {stage.items.map((item, i) => {
          const result = stage.results.find((r) => r.itemId === item.id);
          const submitted = stage.answers.find((a) => a.itemId === item.id);
          // An Item nobody touched says so outright, rather than echoing the bare frame back: with
          // every blank still empty there is no Response to read, and the frame alone could be
          // misread as one.
          const userResponse =
            submitted && submitted.tileOrder.length > 0
              ? sentenceAnswerText(item.frame, submitted.tileOrder)
              : "(no Response submitted)";
          const isCorrect = Boolean(result?.correct);
          return (
            <li key={item.id} className="space-y-2 px-4 py-3">
              <div className="flex items-start justify-between gap-4">
                <p className="text-body text-ink-soft">
                  <span className="figures mr-2 text-graphite">{i + 1}.</span>
                  {item.prompt}
                </p>
                {/* The same mark, in the same words, as Attempt review. */}
                <ResultMark correct={isCorrect} />
              </div>
              <p data-testid={`bas-answer-${item.id}`} className="text-body text-ink">
                {/* The User's Response, and below it the Set's accepted arrangement — two labels,
                    because the one is the User's and the other is the key. */}
                <span className="text-graphite">Your Response: </span>
                {userResponse}
              </p>
              <p data-testid={`bas-key-${item.id}`} className="text-meta text-ink-soft">
                <span className="text-graphite">{(result?.correctAnswers.length ?? 0) > 1 ? "Key (any of these): " : "Key: "}</span>
                {/* Through the same composition: a frame Item's key is the blank fills alone, so
                    printed bare it reads as a fragment. */}
                {result?.correctAnswers.map((a) => sentenceAnswerText(item.frame, a)).join(" / ")}
              </p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * Fires (and, on Retry, re-fires) one essay's scoring job when it mounts — the moment its slot is
 * added at hand-in — and shows the job until it lands, then its Score Report. The job is started
 * through lib/scoringJobOnce.ts, so this slot being drawn elsewhere (compact during the run, full at
 * the end) never POSTs the essay a second time; only an explicit Retry starts a new job.
 */
function EssayResultSlot({
  attemptId,
  kind,
  itemId,
  userText,
  secondsUsed,
  compact,
  onStatusChange,
}: {
  attemptId: string;
  kind: EssayKind;
  itemId: string;
  userText: string;
  secondsUsed: number;
  compact: boolean;
  onStatusChange: (kind: EssayKind, inFlight: boolean) => void;
}) {
  const key = scoringJobKey(attemptId, kind);
  const start = useCallback(
    (): Promise<{ jobId: string }> =>
      startScoringJobOnce(key, async () => {
        const res = await scoreTask(attemptId, { taskType: kind, items: [{ itemId, text: userText, secondsUsed }] });
        if (!("jobId" in res)) throw new Error("unexpected synchronous response scoring an essay task");
        return res;
      }),
    [key, attemptId, kind, itemId, userText, secondsUsed],
  );

  const job = useScoringJob(attemptId, { start });
  // An explicit Retry starts a new job, so the registry must not hand back the failed one.
  const { retry } = job;
  const handleRetry = useCallback(() => {
    forgetScoringJob(key);
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

  return (
    <section aria-label={title} className="space-y-4">
      <SectionHeader title={title} />
      {job.status === "done" && job.result ? (
        <ScoreCard result={job.result as EssayScoreResult} userText={userText} />
      ) : (
        <ScoringProgress job={job} onRetry={handleRetry} />
      )}
    </section>
  );
}
