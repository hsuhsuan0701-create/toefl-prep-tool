import type { GappedSegmentSnapshot, StimulusContentSnapshot } from "../../pages/attemptSetSnapshot";
import { Disclosure } from "../../ui/Disclosure";
import { IconCheck, IconCross, IconDash } from "../../ui/icons";
import { PassagePane } from "../../ui/PassagePane";
import { Prose } from "../../ui/Prose";

// What a Stimulus showed the User, under its heading in review: the text the Items were answered
// against. It is mounted only beside a key review (CLAUDE.md "Sets and answers"): for every Stimulus
// of a completed Attempt, and for a Stimulus with a scored Item in an unfinished or discarded Drill,
// whose check already showed its key and Explanation. And only when the Set could be read.
//
// Two shapes, by how much there is to read. A passage with gaps is short and is the Items
// themselves, so it is shown filled in. A text the questions were asked about is long, so it opens
// on demand and the Items stay in view.

/**
 * One gap as review fills it in: the number of its Item in the Attempt, what the User typed (empty
 * for no Response), whether that was right (null: the Item has no score), and the whole correct word
 * when the review has the key.
 */
export type ReviewedGap = Readonly<{ number: number; typed: string; correct: boolean | null; completion?: string }>;

export type ReviewStimulusProps = {
  content: StimulusContentSnapshot;
  /** For a passage with gaps: each gap's Item, by gap id. A gap with no entry shows its prefix alone. */
  gaps?: ReadonlyMap<string, ReviewedGap>;
  /** For a text: what opening it reveals ("The text", "The passage"). */
  summary?: string;
};

export default function ReviewStimulus({ content, gaps, summary = "The text" }: ReviewStimulusProps) {
  if (content.kind === "gapped") {
    return <FilledPassage segments={content.segments} prefixesByGapId={content.prefixesByGapId} gaps={gaps ?? new Map()} />;
  }
  // Open to begin with: the questions under it are checked against the text, so it is what the
  // User needs first. It can still be folded away to bring the Items up.
  return (
    <Disclosure summary={summary} defaultOpen>
      <PassagePane label={content.label ?? undefined} text={content.text} preserveLines={content.preserveLines} className="mt-2 mb-1" />
    </Disclosure>
  );
}

// The characters a text run starts with before its first space: what follows a gap with no space
// between it, such as the comma or full stop that ends the gap's word (as components/CtwGapInput).
const LEADING_WORD_RUN = /^\S+/;

/**
 * A Complete the Words passage as the run set it, in the monospace face throughout, with each gap
 * filled: its Item's number, the prefix the User saw, then the letters they typed, marked right or
 * wrong by a glyph and, for a screen reader, a word; beside a wrong or empty gap, the correct word.
 */
function FilledPassage({
  segments,
  prefixesByGapId,
  gaps,
}: {
  segments: readonly GappedSegmentSnapshot[];
  prefixesByGapId: Readonly<Record<string, string>>;
  gaps: ReadonlyMap<string, ReviewedGap>;
}) {
  return (
    <Prose as="p" size="stimulus" preserveLines className="font-mono leading-[2.15] wrap-anywhere">
      {segments.map((segment, i) => {
        if (segment.type === "text") {
          const text = segments[i - 1]?.type === "gap" ? segment.text.replace(LEADING_WORD_RUN, "") : segment.text;
          return <span key={`text-${i}`}>{text}</span>;
        }
        const next = segments[i + 1];
        const trailing = next?.type === "text" ? (LEADING_WORD_RUN.exec(next.text)?.[0] ?? "") : "";
        return (
          <FilledGap
            key={segment.gapId}
            gapId={segment.gapId}
            prefix={prefixesByGapId[segment.gapId] ?? ""}
            gap={gaps.get(segment.gapId)}
            trailing={trailing}
          />
        );
      })}
    </Prose>
  );
}

function FilledGap({ gapId, prefix, gap, trailing }: { gapId: string; prefix: string; gap?: ReviewedGap; trailing: string }) {
  if (!gap) {
    return (
      <span data-testid={`gap-${gapId}`}>
        {prefix}
        {trailing}
      </span>
    );
  }
  const answered = gap.typed.trim() !== "";
  const correct = gap.correct === true;
  const showCompletion = gap.correct === false && gap.completion !== undefined;
  // The punctuation that ends the gap's word stays with the last thing on its line: the User's own
  // word when it was right, otherwise the correct word printed beside it.
  return (
    <span data-testid={`gap-${gapId}`}>
      <span className="whitespace-nowrap">
        <sup className="figures mr-0.5 text-caption font-semibold text-graphite" aria-hidden="true">
          {gap.number}
        </sup>
        <span className="sr-only">Item {gap.number}: </span>
        {prefix}
        {answered && (
          <span className={correct ? "bg-positive-wash text-positive" : gap.correct === false ? "bg-correction-wash text-correction" : "bg-well text-ink"}>
            {gap.typed}
          </span>
        )}
        {gap.correct !== null && (
          <span className={correct ? "ml-0.5 inline-flex items-center self-center text-positive" : "ml-0.5 inline-flex items-center self-center text-correction"}>
            {correct ? <IconCheck size={14} /> : answered ? <IconCross size={14} /> : <IconDash size={14} />}
            <span className="sr-only">{correct ? " Correct" : answered ? " Incorrect" : " No Response"}</span>
          </span>
        )}
        {!showCompletion && trailing}
      </span>
      {showCompletion && (
        <>
          {" "}
          <span className="whitespace-nowrap">
            <span className="sr-only">The word is </span>
            <span className="font-medium text-correction underline decoration-correction decoration-1 underline-offset-[0.2em]">{gap.completion}</span>
            {trailing}
          </span>
        </>
      )}
    </span>
  );
}
