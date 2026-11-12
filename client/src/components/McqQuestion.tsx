import { useEffect, useId, useRef } from "react";
import { ChoiceList } from "../ui/ChoiceList";
import { cx } from "../ui/cx";
import { Kicker } from "../ui/Heading";
import { IconCheck, IconCross, IconDash } from "../ui/icons";
import { Prose } from "../ui/Prose";

export type McqOption = { id: string; text: string };
export type McqResult = { correct: boolean; key?: string; explanationZh?: string };

export type McqQuestionProps = {
  stem: string;
  options: McqOption[];
  selected?: string;
  result?: McqResult;
  onSelect: (optionId: string) => void;
  /** Where this question sits in its Stimulus, above the stem: "Question 2 of 3". */
  kicker?: string;
  /**
   * Move focus to the question when it mounts, so a keyboard or screen-reader User lands on the
   * question that just came into view (the next one in a Simulation, the first one after the audio).
   */
  autoFocus?: boolean;
  /**
   * Take that focus without moving the page. For the first question of a text the User has not read
   * yet: focusing would scroll the question, which a phone stacks below the whole text, into view,
   * so the caller starts the text at its top instead (StimulusQuestions).
   */
  focusInPlace?: boolean;
};

// One multiple-choice Item (Read in Daily Life, Read an Academic Passage, and every Listening Task
// Type). The options carry no correctness flag, and stripAnswers removes the question's
// `correctOptionId`, so before `result` this is only the stem over ChoiceList's exam-style options.
// Once `result` lands (a Drill's scoreDeterministicTask response) the options lock, ChoiceList marks
// the key and the User's own pick, and a verdict and the Explanation follow underneath.
export default function McqQuestion({ stem, options, selected, result, onSelect, kicker, autoFocus, focusInPlace }: McqQuestionProps) {
  const stemId = useId();
  const headRef = useRef<HTMLDivElement>(null);

  // On mount only: a question re-rendering (a pick, the result arriving) must not pull focus back.
  useEffect(() => {
    if (autoFocus) headRef.current?.focus(focusInPlace ? { preventScroll: true } : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div role="group" aria-labelledby={stemId} className="space-y-4">
      <div ref={headRef} tabIndex={-1} className="rounded-chip">
        {kicker && <Kicker as="p">{kicker}</Kicker>}
        <p id={stemId} className={cx("text-stimulus text-ink text-pretty", kicker && "mt-1")}>
          {stem}
        </p>
      </div>
      <ChoiceList
        labelledBy={stemId}
        choices={options.map((o) => ({ id: o.id, label: o.text }))}
        value={selected ?? null}
        onChange={onSelect}
        disabled={Boolean(result)}
        reveal={result?.key ? { correctId: result.key } : undefined}
        // CONTEXT.md's Response entry: the User's pick is their Response, never their "answer".
        revealLabels={{ pick: "Your Response" }}
      />
      {result && (
        <div className="space-y-2 rounded-sheet bg-well px-4 py-3">
          <ResultVerdict correct={result.correct} answered={selected !== undefined} />
          {result.explanationZh && (
            <div>
              <Kicker as="p">Explanation</Kicker>
              <Prose lang="zh-Hant" size="body" className="mt-0.5">
                {result.explanationZh}
              </Prose>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Right or wrong for one scored Item, by glyph and word as well as colour: "Correct" with a check,
 * "Incorrect" with a cross, or "No Response" with a dash when nothing was chosen or typed.
 */
export function ResultVerdict({ correct, answered }: { correct: boolean; answered: boolean }) {
  const [Icon, word] = correct ? [IconCheck, "Correct"] : answered ? [IconCross, "Incorrect"] : [IconDash, "No Response"];
  return (
    <span className={cx("inline-flex items-center gap-1.5 text-ui font-semibold", correct ? "text-positive" : "text-correction")}>
      <Icon size={14} />
      {word}
    </span>
  );
}
