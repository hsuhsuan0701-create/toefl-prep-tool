import type { ItemVM, JudgeReportVM } from "@toefl-prep/shared";
import type { ScoringJobState } from "../../hooks/useScoringJob";
import { taskTypeLabel } from "../../lib/taskTypes";
import type { AttemptSetSnapshot, EssayTaskSnapshot } from "../../pages/attemptSetSnapshot";
import { essayTaskFor } from "../../pages/attemptSetSnapshot";
import { ScoreFigure } from "../../ui/BandFigure";
import { Card } from "../../ui/Card";
import { StatusChip } from "../../ui/Chip";
import { Disclosure } from "../../ui/Disclosure";
import { Prose } from "../../ui/Prose";
import { ScoreCautionChips, ScoreCautionNotes, ScoreReport } from "../ScoreCard";
import { scoreCautions } from "../scoreCautions";
import { ItemCard, RescoreAction } from "./ReviewParts";
import { ScoringOutcome } from "./ScoringOutcome";
import { itemStatusChip } from "./reviewText";
import { isManualRescoreItem, isPersistedScoreItem, isSelfArbitratedPersistedItem, jobViewInPlaceOfItem, judgesForItem } from "./reviewItems";

export type EssayItemReviewProps = {
  item: ItemVM;
  position: number;
  total: number;
  judgeReports: JudgeReportVM[];
  jobView?: ScoringJobState;
  taskBusy: boolean;
  rescoreCount: number;
  onRescore: () => void;
  settled: boolean;
  discarded: boolean;
  setSnapshot: AttemptSetSnapshot | null;
};

/** An Email or Academic Discussion: the task, then its Score Report in the design system's order. */
export default function EssayItemReview({
  item,
  position,
  total,
  judgeReports,
  jobView,
  taskBusy,
  rescoreCount,
  onRescore,
  settled,
  discarded,
  setSnapshot,
}: EssayItemReviewProps) {
  const userText = item.responseText ?? "";
  const report = item.scoringStatus === "scored" && isPersistedScoreItem(item.scoreJson) ? item.scoreJson : null;
  const judges = judgesForItem(judgeReports, item.itemId);
  const cautions = report ? scoreCautions(report, judges) : [];
  const task = essayTaskFor(setSnapshot, item.itemId);
  const inPlace = jobViewInPlaceOfItem(jobView, item);
  const showReport = report && !inPlace;
  // An essay with no words was scored 0 without a Judge or the Arbiter: its Summary says so, and the
  // rest of a Score Report (Deductions, the Arbiter's reasoning) would describe a judging that never
  // happened, so the Response is shown on its own instead.
  const noWords = report?.noWordsWritten === true;

  return (
    <ItemCard
      itemId={item.itemId}
      kicker={`Item ${position} of ${total}`}
      title={taskTypeLabel(item.taskType)}
      headingLevel="h2"
      chips={
        <>
          <StatusChip status={itemStatusChip(item, inPlace, settled)} />
          {showReport && <ScoreCautionChips cautions={cautions} />}
        </>
      }
      figure={showReport ? <ScoreFigure score={report.finalScore} max={report.maxScore} /> : undefined}
    >
      {task && <EssayTask task={task} />}

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

      {showReport && noWords ? (
        <>
          {report.feedbackZh && (
            <section className="space-y-2">
              <h3 className="text-body font-semibold text-ink">Summary</h3>
              <Prose lang="zh-Hant">{report.feedbackZh}</Prose>
            </section>
          )}
          <EssayResponse userText={userText} />
        </>
      ) : showReport ? (
        <>
          {cautions.length > 0 && (
            <div className="space-y-2">
              <ScoreCautionNotes cautions={cautions} />
              {isSelfArbitratedPersistedItem(item) && (
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
          <ScoreReport item={report} judges={judges} responseText={userText} />
        </>
      ) : (
        <EssayResponse userText={userText} />
      )}
    </ItemCard>
  );
}

/**
 * The task an essay answered, closed by default: the Score Report comes first. Also drawn on the
 * Writing Drill's results, so the two places show the same task in the same words.
 */
export function EssayTask({ task }: { task: EssayTaskSnapshot }) {
  return (
    <Disclosure summary="The task">
      <div className="max-w-measure space-y-1">
        {task.lines.map((line, i) => (
          <p key={i} className="text-pretty">
            {line}
          </p>
        ))}
      </div>
    </Disclosure>
  );
}

/** An essay with no Score Report to carry it: the Response on its own. */
export function EssayResponse({ userText }: { userText: string }) {
  return (
    <section className="space-y-2">
      <h3 className="text-body font-semibold text-ink">Your Response</h3>
      <Card tone="well">
        {userText.trim() === "" ? (
          <p className="text-body text-graphite">No Response was submitted.</p>
        ) : (
          <Prose preserveLines>{userText}</Prose>
        )}
      </Card>
    </section>
  );
}
