import type { Ref } from "react";
import type { TrendPointVM } from "@toefl-prep/shared";
import { formatScore, scaleFor } from "../lib/taskTypeScale";
import { Sparkline, StatTile } from "../ui/StatTile";

// One Task Type's recent form as a StatTile: where the score is now, which way it moved from the
// Attempt before, and a sparkline of the window. The full chart opens below the section's tiles for
// the one Task Type being looked at, so axes and the legend appear once rather than twelve times.
//
// The sparkline places Attempts by order, not by time: practice is bursty, and on a time axis an
// evening's Attempts bunch into a vertical smear while idle weeks take the width. Pacing questions
// belong to the range control and the full chart's day labels.

function attempts(n: number): string {
  return `${n} ${n === 1 ? "Attempt" : "Attempts"}`;
}

export default function TrendCard({
  taskType,
  label,
  points,
  expanded,
  onToggle,
  emptyNote,
  ref,
}: {
  taskType: string;
  label: string;
  points: TrendPointVM[];
  expanded: boolean;
  onToggle: () => void;
  /**
   * What an empty tile means. The default reads as "never attempted"; a container that filtered the
   * points away by range passes "No Attempts in this range", so a history outside the window is
   * never reported as a missing one.
   */
  emptyNote?: string;
  /** The tile's toggle button, which a closing chart hands focus back to. */
  ref?: Ref<HTMLButtonElement>;
}) {
  const latest = points.length > 0 ? points[points.length - 1] : null;
  const previous = points.length > 1 ? points[points.length - 2] : null;
  // StatTile truncates its label to one line; a Task Type name is the tile's whole identity, so it
  // wraps instead ("Read an Academic Passage" does not fit beside a sparkline in a three-up grid).
  const name = <span className="whitespace-normal">{label}</span>;

  if (!latest) {
    return (
      <StatTile
        label={name}
        value={
          <>
            <span className="text-faint" aria-hidden="true">
              —
            </span>
            <span className="sr-only">No score</span>
          </>
        }
        footnote={emptyNote ?? "No Attempts scored yet"}
      />
    );
  }

  const scale = scaleFor(taskType);
  const delta = previous ? latest.avgScore - previous.avgScore : null;
  const first = points[0];

  return (
    <StatTile
      label={name}
      value={formatScore(taskType, latest.avgScore)}
      // The previous value is named outright rather than compressed into a signed difference: "+25%"
      // on an accuracy scale reads as either 25 points or a 25% relative rise.
      delta={
        delta === null || !previous
          ? undefined
          : { direction: delta > 0 ? "up" : delta < 0 ? "down" : "flat", text: `from ${formatScore(taskType, previous.avgScore)}` }
      }
      footnote={attempts(points.length)}
      sparkline={
        <Sparkline
          min={0}
          max={scale.max}
          points={points.map((p) => ({ value: p.avgScore, mode: p.mode }))}
          label={`${label}, ${attempts(points.length)}${points.length > 1 ? `, from ${formatScore(taskType, first.avgScore)} to ${formatScore(taskType, latest.avgScore)}` : ""}`}
        />
      }
      onToggle={onToggle}
      expanded={expanded}
      ref={ref}
    />
  );
}
