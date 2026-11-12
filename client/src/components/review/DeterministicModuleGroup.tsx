import { MCQ_UNANSWERED_SENTINEL, type DeterministicReviewItemVM, type ItemVM } from "@toefl-prep/shared";
import { taskTypeLabel } from "../../lib/taskTypes";
import { questionFor, type AttemptSetSnapshot, type QuestionSnapshot } from "../../pages/attemptSetSnapshot";
import { Card } from "../../ui/Card";
import { StatusChip } from "../../ui/Chip";
import { Disclosure } from "../../ui/Disclosure";
import { Kicker } from "../../ui/Heading";
import { IconChevronRight } from "../../ui/icons";
import { Prose } from "../../ui/Prose";
import { itemScoringStatus } from "../../ui/labels";
import { ResultMark } from "./ReviewParts";
import { isDeterministicScoreJson } from "./reviewItems";
import { capitalise, correctSummary, type IndexedItem } from "./reviewText";

type StimulusRun = { key: string; taskType: string; name: string | null; items: IndexedItem[] };

/**
 * One Module's Items cut into the Stimuli they were answered against, in test order. Without the
 * Set (it could not be read), Items fall back to one run per Task Type. Listen and Choose a Response
 * Items are each their own Stimulus, so consecutive ones share a card rather than taking one each.
 */
function stimulusRuns(items: readonly IndexedItem[], setSnapshot: AttemptSetSnapshot | null): StimulusRun[] {
  const names = new Map((setSnapshot?.stimuli ?? []).map((s) => [s.id, s.name]));
  const runs: StimulusRun[] = [];
  for (const entry of items) {
    const { item } = entry;
    const question = questionFor(setSnapshot, item.itemId);
    const key = question && item.taskType !== "listen_choose" ? `stimulus-${question.stimulusId}` : `type-${item.taskType}`;
    const last = runs[runs.length - 1];
    if (last && last.key === key) {
      last.items.push(entry);
      continue;
    }
    runs.push({ key, taskType: item.taskType, name: question && item.taskType !== "listen_choose" ? (names.get(question.stimulusId) ?? null) : null, items: [entry] });
  }
  return runs;
}

function optionText(question: QuestionSnapshot | undefined, optionId: string): string {
  const index = question?.options.findIndex((o) => o.id === optionId) ?? -1;
  if (!question || index < 0) return `Option ${optionId.toUpperCase()}`;
  return `${String.fromCharCode(65 + index)}. ${question.options[index].text}`;
}

export type DeterministicModuleGroupProps = {
  items: IndexedItem[];
  setSnapshot: AttemptSetSnapshot | null;
  /** The key and Explanation per Item, present only once the Attempt is complete. */
  reviewByItemId: ReadonlyMap<string, DeterministicReviewItemVM>;
};

export default function DeterministicModuleGroup({ items, setSnapshot, reviewByItemId }: DeterministicModuleGroupProps) {
  return (
    <div className="space-y-4">
      {stimulusRuns(items, setSnapshot).map((run) => {
        const transcript = run.items.map(({ item }) => reviewByItemId.get(item.itemId)?.transcript).find((t) => t !== undefined);
        const headingId = `${run.key}-${run.items[0].item.itemId}`;
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
              <p className="text-meta text-graphite">{correctSummary(run.items)}</p>
            </header>
            <ol className="divide-y divide-rule">
              {run.items.map(({ item, position }) => (
                <DeterministicRow key={item.itemId} item={item} position={position} question={questionFor(setSnapshot, item.itemId)} review={reviewByItemId.get(item.itemId)} />
              ))}
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
 * (錯題解析). Question text and option text are shown only beside a review — i.e. once the Attempt
 * is complete — so an unfinished Listening Attempt never puts options into the page early. A
 * Complete the Words prefix is the exception: the User saw it in the passage, and it is no key. A Listen
 * and Choose a Response utterance is never shown as text at all; the server does not send it.
 */
function DeterministicRow({ item, position, question, review }: { item: ItemVM; position: number; question?: QuestionSnapshot; review?: DeterministicReviewItemVM }) {
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
        : optionText(shown, score.answer);
  const keyText = review?.key === undefined ? null : isGap ? `${prefix}${review.key}` : optionText(shown, review.key);

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
      {score ? <ResultMark correct={score.correct} unanswered={unanswered} /> : <StatusChip status={itemScoringStatus(item.scoringStatus)} />}
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
          <p className="text-meta font-medium text-graphite">Explanation</p>
          <Prose lang="zh-Hant" size="body">
            {review.explanationZh}
          </Prose>
        </div>
      </details>
    </li>
  );
}
