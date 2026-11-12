import type { BuildupDiffOp } from "@toefl-prep/shared";

// A Listen and Repeat alignment, one op per word, as the Speaking score response carries it per Item
// in `diff`. Shared's BuildupDiffOp is that alignment (server/src/services/wordDiff.ts's DiffOp), so
// a scored Item and a Drill Lab rep are drawn from one shape.
type TranscriptDiffProps = { diff: BuildupDiffOp[] };

const MISSED = "line-through decoration-correction decoration-[1.5px] text-correction";
const ADDED = "underline decoration-ink-soft decoration-[1.5px] underline-offset-[0.22em] text-ink";

/**
 * A Listen and Repeat Response against its target sentence, word by word. Meaning never rests on
 * colour: a target word you missed is struck through, a word you said that the target does not have
 * is underlined, and a word said differently shows both, in that order. Screen readers hear the
 * same in words.
 */
export default function TranscriptDiff({ diff }: TranscriptDiffProps) {
  if (diff.length === 0) {
    return <p className="text-meta text-graphite">No word-by-word comparison is available.</p>;
  }

  return (
    <div className="space-y-2">
      <p className="max-w-measure text-body leading-relaxed text-ink">
        {diff.map((op, i) => (
          <span key={i}>
            <DiffWord op={op} />{" "}
          </span>
        ))}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-meta text-graphite" aria-hidden="true">
        <li>
          <span className={MISSED}>struck</span>: in the target, not said
        </li>
        <li>
          <span className={ADDED}>underlined</span>: said, not in the target
        </li>
      </ul>
    </div>
  );
}

function DiffWord({ op }: { op: BuildupDiffOp }) {
  switch (op.op) {
    case "match":
      return <span>{op.saidWord}</span>;
    case "substitution":
      return (
        <span title={`Target: "${op.targetWord}"`}>
          <del className={MISSED}>
            <span className="sr-only">missed </span>
            {op.targetWord}
          </del>{" "}
          <ins className="no-underline">
            <span className="sr-only">said instead </span>
            <span className={ADDED}>{op.saidWord}</span>
          </ins>
        </span>
      );
    case "omission":
      return (
        <del className={MISSED} title="In the target sentence, not said">
          <span className="sr-only">missed </span>
          {op.targetWord}
        </del>
      );
    case "insertion":
      return (
        <ins className="no-underline" title="Said, not in the target sentence">
          <span className="sr-only">added </span>
          <span className={ADDED}>{op.saidWord}</span>
        </ins>
      );
  }
}
