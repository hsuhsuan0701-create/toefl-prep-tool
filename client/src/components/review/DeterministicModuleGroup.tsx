import { MCQ_UNANSWERED_SENTINEL, type DeterministicReviewItemVM, type ItemVM } from "@toefl-prep/shared";
import { taskTypeLabel } from "../../lib/taskTypes";
import { questionFor, stimulusAudioFor, stimulusContentFor, stimulusFor, type AttemptSetSnapshot, type QuestionSnapshot, type SnapshotModule } from "../../pages/attemptSetSnapshot";
import StimulusReplay from "../StimulusReplay";
import { Card } from "../../ui/Card";
import { ChoiceList } from "../../ui/ChoiceList";
import { StatusChip } from "../../ui/Chip";
import { Disclosure } from "../../ui/Disclosure";
import { Kicker } from "../../ui/Heading";
import { IconChevronRight } from "../../ui/icons";
import { Prose } from "../../ui/Prose";
import { ITEM_MARK_DEFERRED, itemScoringStatus } from "../../ui/labels";
import { ResultMark } from "./ReviewParts";
import ReviewStimulus, { type ReviewedGap } from "./ReviewStimulus";
import { isDeterministicScoreJson } from "./reviewItems";
import { capitalise, correctSummary, unmarkedSummary, type IndexedItem } from "./reviewText";

type StimulusRun = {
  key: string;
  taskType: string;
  name: string | null;
  /** The run's own Stimulus, by its Module and id; null for a Listen and Choose a Response run or without the Set. */
  stimulus: { module: SnapshotModule; id: string } | null;
  items: IndexedItem[];
};

/**
 * One Module's Items cut into the Stimuli they were answered against, in test order. Without the
 * Set (it could not be read), Items fall back to one run per Task Type. Listen and Choose a Response
 * Items are each their own Stimulus, so consecutive ones share a card rather than taking one each.
 * Each Stimulus is looked up in its Item's own Module: a Stimulus id may repeat across Modules.
 */
function stimulusRuns(items: readonly IndexedItem[], setSnapshot: AttemptSetSnapshot | null): StimulusRun[] {
  const runs: StimulusRun[] = [];
  for (const entry of items) {
    const { item } = entry;
    const question = questionFor(setSnapshot, item.itemId);
    const key = question && item.taskType !== "listen_choose" ? `stimulus-${question.module}-${question.stimulusId}` : `type-${item.taskType}`;
    const last = runs[runs.length - 1];
    if (last && last.key === key) {
      last.items.push(entry);
      continue;
    }
    const own = question && item.taskType !== "listen_choose";
    runs.push({
      key,
      taskType: item.taskType,
      name: own ? (stimulusFor(setSnapshot, question.module, question.stimulusId)?.name ?? null) : null,
      stimulus: own ? { module: question.module, id: question.stimulusId } : null,
      items: [entry],
    });
  }
  return runs;
}

/**
 * An option as the run showed it: its letter by its place in the question, then its text. Null when
 * the Set no longer has it (it could not be read, or the option is gone): an option id is internal
 * ("o3", "lcr-r1-a") and was never what the User saw.
 */
function optionText(question: QuestionSnapshot | undefined, optionId: string): string | null {
  const index = question?.options.findIndex((o) => o.id === optionId) ?? -1;
  if (!question || index < 0) return null;
  return `${String.fromCharCode(65 + index)}. ${question.options[index].text}`;
}

/** The multiple-choice Task Types, Reading's and Listening's, whose opened row lists every option of the question. */
const QUESTION_TYPES = new Set(["daily_life", "academic_passage", "listen_choose", "conversation", "announcement", "academic_talk"]);

/** A Response whose option the Set can no longer name. */
const OPTION_NOT_SHOWN = "An option that can no longer be shown";

export type DeterministicModuleGroupProps = {
  items: IndexedItem[];
  setSnapshot: AttemptSetSnapshot | null;
  /**
   * The key and Explanation per Item: every Item of a completed Attempt, and only the scored Items
   * of an unfinished or discarded Drill (which already showed them). None for an unfinished
   * Simulation.
   */
  reviewByItemId: ReadonlyMap<string, DeterministicReviewItemVM>;
  /**
   * Show each Stimulus under its heading, its text (Reading) or a control to play it again
   * (Listening): for a completed Attempt, the one whose keys and Explanations have all reached the
   * client. Otherwise only a Stimulus with a reviewed Item shows it (a Drill's scored Stimulus,
   * whose review the server sends); the rest show the Items alone.
   */
  showStimulus: boolean;
  /**
   * Show each scored Item's Correct or Incorrect mark and each Stimulus's tally. False for a
   * Simulation still in progress, whose feedback waits for completion like its key: its review
   * shows the Responses alone (issue #48).
   */
  showMarks: boolean;
};

/** Each Complete the Words gap of a run, filled in from its Item: what was typed, right or wrong, and the word. */
function reviewedGaps(
  run: StimulusRun,
  setSnapshot: AttemptSetSnapshot | null,
  reviewByItemId: ReadonlyMap<string, DeterministicReviewItemVM>,
  showMarks: boolean,
): Map<string, ReviewedGap> {
  const gaps = new Map<string, ReviewedGap>();
  for (const { item, position } of run.items) {
    const score = item.scoringStatus === "scored" && isDeterministicScoreJson(item.scoreJson) ? item.scoreJson : null;
    const key = reviewByItemId.get(item.itemId)?.key;
    const typed = !score || score.answer === MCQ_UNANSWERED_SENTINEL ? "" : score.answer;
    gaps.set(item.itemId, {
      number: position,
      typed,
      correct: score && showMarks ? score.correct : null,
      ...(key === undefined ? {} : { completion: `${questionFor(setSnapshot, item.itemId)?.prefix ?? ""}${key}` }),
    });
  }
  return gaps;
}

const STIMULUS_SUMMARY: Record<string, string> = { daily_life: "The text", academic_passage: "The passage" };

export default function DeterministicModuleGroup({ items, setSnapshot, reviewByItemId, showStimulus, showMarks }: DeterministicModuleGroupProps) {
  return (
    <div className="space-y-4">
      {stimulusRuns(items, setSnapshot).map((run) => {
        // A Listen and Choose a Response utterance is audio only, whatever a review entry carries.
        const transcript =
          run.taskType === "listen_choose" ? undefined : run.items.map(({ item }) => reviewByItemId.get(item.itemId)?.transcript).find((t) => t !== undefined);
        const headingId = `${run.key}-${run.items[0].item.itemId}`;
        const shows = showStimulus || run.items.some(({ item }) => reviewByItemId.has(item.itemId));
        const content = shows && run.stimulus ? stimulusContentFor(setSnapshot, run.stimulus.module, run.stimulus.id) : undefined;
        // A Listen and Choose a Response run has no one Stimulus (each Item is its own), so its
        // replay is on each Item's row instead.
        const audio = shows && run.stimulus ? stimulusAudioFor(setSnapshot, run.stimulus.module, run.stimulus.id) : undefined;
        return (
          <Card key={headingId} as="section" padding="none" aria-labelledby={headingId} className="min-w-0">
            <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-rule px-4 py-3">
              <div className="min-w-0">
                {run.name ? (
                  <>
                    <Kicker as="p">{taskTypeLabel(run.taskType)}</Kicker>
                    <h3 id={headingId} className="text-body font-semibold text-ink text-pretty">
                      {capitalise(run.name)}
                    </h3>
                  </>
                ) : (
                  <h3 id={headingId} className="text-body font-semibold text-ink">
                    {taskTypeLabel(run.taskType)}
                  </h3>
                )}
              </div>
              <p className="text-meta text-graphite">{showMarks ? correctSummary(run.items) : unmarkedSummary(run.items)}</p>
            </header>
            {audio && (
              <div className="min-w-0 border-b border-rule px-4 py-3">
                <StimulusReplay audio={audio} label={`${run.name ? capitalise(run.name) : taskTypeLabel(run.taskType)}: play again`} />
              </div>
            )}
            {content && (
              <div className="min-w-0 border-b border-rule px-4 py-3">
                <ReviewStimulus
                  content={content}
                  gaps={content.kind === "gapped" ? reviewedGaps(run, setSnapshot, reviewByItemId, showMarks) : undefined}
                  summary={STIMULUS_SUMMARY[run.taskType]}
                />
              </div>
            )}
            <ol className="divide-y divide-rule">
              {run.items.map(({ item, position }) => {
                const question = questionFor(setSnapshot, item.itemId);
                return (
                  <DeterministicRow
                    key={item.itemId}
                    item={item}
                    position={position}
                    question={question}
                    review={reviewByItemId.get(item.itemId)}
                    showMark={showMarks}
                    replayAudio={
                      question && (showStimulus || reviewByItemId.has(item.itemId)) && item.taskType === "listen_choose"
                        ? stimulusAudioFor(setSnapshot, question.module, question.stimulusId)
                        : undefined
                    }
                  />
                );
              })}
            </ol>
            {transcript && (
              <div className="border-t border-rule px-4 py-3">
                <Disclosure summary="Transcript">
                  <Prose size="body" preserveLines className="mt-1">
                    {transcript}
                  </Prose>
                </Disclosure>
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

/**
 * One Reading or Listening Item: the User's Response, the key when it differs, and the Explanation
 * (錯題解析). The question's stem and the key are shown only beside a review — i.e. once the
 * Attempt is complete, or for an Item a Drill has scored. The Response is written out as the run showed it, letter and text, whether
 * or not the Attempt is complete: the User picked that option, so it is no key, and nothing else of
 * the question comes with it. A Complete the Words prefix is the same: the User saw it in the
 * passage. A Listen and Choose a Response utterance is never shown as text at all; the server does
 * not send it. In a completed Attempt's review it can be heard again from the opened row
 * (`replayAudio`), the Item being its own Stimulus.
 */
function DeterministicRow({
  item,
  position,
  question,
  review,
  showMark,
  replayAudio,
}: {
  item: ItemVM;
  position: number;
  question?: QuestionSnapshot;
  review?: DeterministicReviewItemVM;
  showMark: boolean;
  replayAudio?: string;
}) {
  const score = item.scoringStatus === "scored" && isDeterministicScoreJson(item.scoreJson) ? item.scoreJson : null;
  const isGap = item.taskType === "complete_words";
  const shown = review ? question : undefined;
  // A gap's prefix was printed in the paragraph the User read, so it is no key: the Response reads
  // as the whole word they produced whether or not the Attempt is complete.
  const prefix = question?.prefix ?? "";
  const unanswered = score !== null && (score.answer === MCQ_UNANSWERED_SENTINEL || score.answer.trim() === "");

  const responseText = !score
    ? null
    : unanswered
      ? "No Response"
      : isGap
        ? `${prefix}${score.answer}`
        : (optionText(question, score.answer) ?? OPTION_NOT_SHOWN);
  const keyText = review?.key === undefined ? null : isGap ? `${prefix}${review.key}` : optionText(shown, review.key);
  const showsOptions = QUESTION_TYPES.has(item.taskType) && (shown?.options.length ?? 0) > 0;

  const line = (
    <>
      <span className="figures w-14 shrink-0 text-meta text-graphite">Item {position}</span>
      <span className="order-last col-span-full min-w-0 flex-1 space-y-0.5 sm:order-none">
        {shown?.stem && <span className="block max-w-measure text-body text-ink text-pretty">{shown.stem}</span>}
        {responseText !== null && (
          <span className="block text-ui text-ink">
            <span className="text-graphite">Your Response: </span>
            {responseText}
          </span>
        )}
        {keyText !== null && !score?.correct && (
          <span className="block text-ui text-ink">
            <span className="text-graphite">{isGap ? "Correct completion: " : "Key: "}</span>
            {keyText}
          </span>
        )}
      </span>
      {score && showMark ? (
        <ResultMark correct={score.correct} unanswered={unanswered} />
      ) : (
        <StatusChip status={score ? ITEM_MARK_DEFERRED : itemScoringStatus(item.scoringStatus)} />
      )}
    </>
  );

  // From `sm` up the line is one row: number, text, verdict. Below it the text would get a third of
  // a phone's width, so the number and the verdict share a first line and the text spans the card
  // under them (the text's `order-last col-span-full`).
  //
  // With an Explanation, the row is its own disclosure: one line until opened, and already open
  // for an Item the User got wrong. Without one (an unfinished Attempt) it is just the line.
  if (!review?.explanationZh) {
    return (
      <li
        id={`item-${item.itemId}`}
        data-testid={`item-${item.itemId}`}
        className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 py-2.5 pr-4 pl-4 sm:flex sm:gap-3 sm:pl-[2.625rem]"
      >
        {line}
      </li>
    );
  }
  return (
    <li id={`item-${item.itemId}`} data-testid={`item-${item.itemId}`}>
      <details open={!score?.correct} className="group">
        <summary className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-2.5 select-none hover:bg-paper sm:flex sm:gap-3 [&::-webkit-details-marker]:hidden">
          <span className="mt-0.5 text-graphite transition-transform duration-(--duration-quick) group-open:rotate-90" aria-hidden="true">
            <IconChevronRight size={14} />
          </span>
          {line}
        </summary>
        <div className="space-y-1 pr-4 pb-3 pl-4 sm:pl-[6.875rem]">
          {replayAudio && (
            <div className="pb-2">
              <StimulusReplay audio={replayAudio} label={`${taskTypeLabel(item.taskType)}, Item ${position}: play again`} />
            </div>
          )}
          {showsOptions && shown && (
            // Every option the question offered, as the run listed them, with the User's pick and
            // the key marked: a question is checked against all four, not only the two.
            <div className="max-w-measure pb-2">
              <ChoiceList
                label="Options"
                choices={shown.options.map((o) => ({ id: o.id, label: o.text }))}
                value={score && !unanswered ? score.answer : null}
                disabled
                reveal={review.key === undefined ? undefined : { correctId: review.key }}
                revealLabels={{ key: "Key", pick: "Your Response" }}
              />
            </div>
          )}
          <p className="text-meta font-medium text-graphite">Explanation</p>
          <Prose lang="zh-Hant" size="body">
            {review.explanationZh}
          </Prose>
        </div>
      </details>
    </li>
  );
}
