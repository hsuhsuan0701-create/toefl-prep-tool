import type { ReactNode } from "react";
import { cx } from "./cx";

type Delta = {
  direction: "up" | "down" | "flat";
  /** The comparison in words: "from 3.0 / 5", "from 80%". The arrow alone is never the message. */
  text: string;
};

type StatTileProps = {
  /** What is measured: a Task Type's name ("Interview"). */
  label: ReactNode;
  /** The figure, already formatted ("4.0 / 5", "86%"). Use lib/taskTypeScale's formatScore. */
  value: ReactNode;
  delta?: Delta;
  /** A Sparkline beside the figure. */
  sparkline?: ReactNode;
  /** One small line under everything: sample size, "Last 20 Attempts". */
  footnote?: ReactNode;
  /**
   * Makes the whole tile a button that opens and closes detail shown elsewhere on the page (the full
   * trend chart), with `expanded` as its state.
   */
  onToggle?: () => void;
  expanded?: boolean;
  className?: string;
};

const ARROW: Record<Delta["direction"], string> = { up: "▲", down: "▼", flat: "—" };

/**
 * One measured number with its recent direction: Progress's per-Task-Type trend tiles. Not for
 * bands — a band is a BandFigure. Up/down are drawn as arrows with words, in ink, not green/red: a
 * falling Listen and Repeat score is information, not an alarm.
 */
export function StatTile({ label, value, delta, sparkline, footnote, onToggle, expanded = false, className }: StatTileProps) {
  const body = (
    <>
      <div className="min-w-0 flex-1">
        <p className="truncate text-meta font-medium text-ink-soft">{label}</p>
        <p className="figures mt-1 text-figure-sm font-semibold text-ink">{value}</p>
        {delta && (
          <p className="figures mt-0.5 text-meta text-graphite">
            <span aria-hidden="true" className="mr-1 text-caption">
              {ARROW[delta.direction]}
            </span>
            <span className="sr-only">{delta.direction === "up" ? "Up, " : delta.direction === "down" ? "Down, " : "Unchanged, "}</span>
            {delta.text}
          </p>
        )}
        {footnote && <p className="mt-1 text-caption text-graphite">{footnote}</p>}
      </div>
      {sparkline && <div className="w-28 shrink-0 self-center">{sparkline}</div>}
    </>
  );
  // An open toggle tile is the selected one: the accent wash, as on a selected option.
  const selected = Boolean(onToggle) && expanded;
  const classes = cx(
    "flex items-start gap-3 rounded-sheet border p-4",
    selected ? "border-accent-rule bg-accent-wash" : "border-rule bg-sheet",
    className,
  );
  if (onToggle) {
    return (
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className={cx(
          classes,
          "w-full text-left transition-colors duration-(--duration-quick) hover:border-rule-strong",
        )}
      >
        {body}
      </button>
    );
  }
  return <div className={classes}>{body}</div>;
}

export type SparkPoint = { value: number; mode?: "drill" | "simulation" };

type SparklineProps = {
  points: SparkPoint[];
  /** The scale's bounds: 0–1 for accuracy Task Types, 0–5 for judged ones (lib/taskTypeScale). */
  min: number;
  max: number;
  /** Accessible summary, e.g. "Interview, last 8 Attempts, 3.25 to 4.0". */
  label: string;
};

/**
 * A tiny trend line for a StatTile. Drill and Simulation points differ by shape (hollow circle vs
 * filled square), never by colour alone; the latest point is larger. Pure SVG — no chart library.
 */
export function Sparkline({ points, min, max, label }: SparklineProps) {
  const W = 112;
  const H = 36;
  const PAD = 4;
  if (points.length === 0) return null;
  const span = max - min || 1;
  const x = (i: number) => (points.length === 1 ? W / 2 : PAD + (i * (W - PAD * 2)) / (points.length - 1));
  const y = (v: number) => H - PAD - ((Math.min(max, Math.max(min, v)) - min) / span) * (H - PAD * 2);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label={label} className="block overflow-visible text-ink-soft">
      <line x1={0} x2={W} y1={H - PAD} y2={H - PAD} className="stroke-rule" strokeWidth={1} />
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => {
        const last = i === points.length - 1;
        const r = last ? 3 : 2;
        return p.mode === "simulation" ? (
          <rect
            key={i}
            x={x(i) - r}
            y={y(p.value) - r}
            width={r * 2}
            height={r * 2}
            className={last ? "fill-accent" : "fill-ink-soft"}
          />
        ) : (
          <circle
            key={i}
            cx={x(i)}
            cy={y(p.value)}
            r={r}
            strokeWidth={1.25}
            className={last ? "fill-sheet stroke-accent" : "fill-sheet stroke-ink-soft"}
          />
        );
      })}
    </svg>
  );
}
