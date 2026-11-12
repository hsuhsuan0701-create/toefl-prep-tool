import { heldWordCount, type BuildupDiffOp, type BuildupRepVM } from "@toefl-prep/shared";
import { IconCheck } from "../../ui/icons";

/**
 * One rep's word alignment against the target, plus the drill's actual instrument: where recall
 * first broke.
 *
 * Kept apart from BuildupRun so the run body owns choreography (play, record, upload) and this owns
 * the presentation of a finished rep. Marks follow the same rule as TranscriptDiff: a missed word is
 * struck through in the correction colour, a substitution strikes the target and underlines what
 * was said, an added word is underlined. Never colour alone.
 */
export function BuildupDiff({ rep }: { rep: BuildupRepVM }) {
  if (rep.transcriptionError) {
    return (
      <p className="text-ui text-caution">
        Couldn't transcribe this take ({rep.transcriptionError}). The recording is kept: listen back and compare it
        yourself.
      </p>
    );
  }
  if (!rep.diff) return <p className="text-ui text-graphite">No transcript to compare for this take.</p>;
  return (
    <div className="space-y-3">
      <p className="flex flex-wrap gap-x-1.5 gap-y-1 text-stimulus leading-relaxed">
        {rep.diff.map((op, i) => (
          <DiffToken key={i} op={op} />
        ))}
      </p>
      <BreakdownMeter rep={rep} />
    </div>
  );
}

function DiffToken({ op }: { op: BuildupDiffOp }) {
  if (op.op === "match") return <span className="text-ink">{op.targetWord}</span>;
  if (op.op === "substitution") {
    return (
      <span className="text-ink">
        <s className="text-correction decoration-correction">{op.targetWord}</s>
        <span aria-hidden="true" className="px-0.5 text-graphite">
          →
        </span>
        <span className="sr-only"> said as </span>
        <span className="underline decoration-correction decoration-[1.5px] underline-offset-[0.2em]">{op.saidWord}</span>
      </span>
    );
  }
  if (op.op === "omission") {
    return (
      <span className="text-correction line-through decoration-correction">
        <span className="sr-only">missed: </span>
        {op.targetWord}
      </span>
    );
  }
  return (
    <span className="text-ink-soft underline decoration-dotted underline-offset-[0.2em]">
      <span className="sr-only">added: </span>
      <span aria-hidden="true">+</span>
      {op.saidWord}
    </span>
  );
}

/**
 * The breakdown position as a bar: how far into the sentence the User got before the first
 * substitution or omission.
 *
 * This is the number the drill is steered by, not the match count. A per-rep accuracy percentage
 * moves with every filler and every synonym and reads as noise week to week; the position where
 * recall collapses moves later and stays later as the phonological buffer lengthens, so it is
 * legible as progress long before a score would be.
 */
function BreakdownMeter({ rep }: { rep: BuildupRepVM }) {
  const total = rep.targetWordCount;
  const held = heldWordCount(rep);
  // Unmeasured reps never reach here — BuildupDiff returns early on transcriptionError and on a
  // missing diff — but the meter must not invent a bar if one ever does.
  if (held === null) return null;
  const pct = total > 0 ? Math.round((held / total) * 100) : 0;
  const clean = rep.breakdownIndex === null;
  return (
    <div className="space-y-1.5">
      <div
        role="meter"
        aria-label="Words held before the first slip"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={held}
        className="h-2 w-full overflow-hidden rounded-full bg-well"
      >
        <div className="h-full rounded-full bg-ink-soft" style={{ width: `${pct}%` }} />
      </div>
      <p className="text-meta text-ink-soft">
        {clean ? (
          <span className="inline-flex items-center gap-1 font-medium text-positive">
            <IconCheck size={14} />
            Clean all the way: all {total} words
          </span>
        ) : (
          <>
            Held to word <span className="figures font-semibold text-ink">{held}</span> of {total} before the first slip
          </>
        )}
      </p>
    </div>
  );
}
