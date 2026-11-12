import type { ReactNode } from "react";
import { cx } from "./cx";
import { IconCheck, IconCross, IconDash, IconSpinner } from "./icons";

type ProgressBarProps = {
  /** What is progressing, visible above the bar: "Rendering audio". */
  label: ReactNode;
  value: number;
  max: number;
  /** The amount in words, visible and announced: "9 of 13 clips". Defaults to "value of max". */
  valueText?: string;
  className?: string;
};

/**
 * A determinate bar for a count you can name ("9 of 13 clips"). If you cannot name the count, it
 * is not a bar — use StepProgress, or a spinner with words.
 */
export function ProgressBar({ label, value, max, valueText, className }: ProgressBarProps) {
  const fraction = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const text = valueText ?? `${value} of ${max}`;
  return (
    <div className={cx("min-w-0", className)}>
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-meta">
        <span className="font-medium text-ink-soft">{label}</span>
        <span className="figures text-graphite">{text}</span>
      </div>
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-valuetext={text}
        aria-label={typeof label === "string" ? label : undefined}
        className="h-1.5 overflow-hidden rounded-full bg-well"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-(--duration-calm) ease-quiet"
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
    </div>
  );
}

export type StepState = "done" | "active" | "pending" | "failed" | "skipped";
export type Step = { key: string; label: string; state: StepState; detail?: ReactNode };

const STEP_WORD: Record<StepState, string> = {
  done: "done",
  active: "in progress",
  pending: "not started",
  failed: "failed",
  skipped: "skipped",
};

function StepMarker({ state, index }: { state: StepState; index: number }) {
  const base = "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-caption font-semibold figures";
  switch (state) {
    case "done":
      return (
        <span className={cx(base, "border-accent bg-accent text-on-accent")}>
          <IconCheck size={13} />
        </span>
      );
    case "active":
      return (
        <span className={cx(base, "border-accent bg-accent-wash text-accent")}>
          <IconSpinner size={14} />
        </span>
      );
    case "failed":
      return (
        <span className={cx(base, "border-critical bg-critical-wash text-critical")}>
          <IconCross size={13} />
        </span>
      );
    case "skipped":
      return (
        <span className={cx(base, "border-rule-strong bg-well text-graphite")}>
          <IconDash size={13} />
        </span>
      );
    case "pending":
      return <span className={cx(base, "border-rule-strong bg-sheet text-graphite")}>{index + 1}</span>;
  }
}

type StepProgressProps = {
  /** Names the job for screen readers: "Scoring your Email". */
  label: string;
  steps: Step[];
  className?: string;
};

/**
 * The checkpoints of a long job you cannot measure in percent: scoring (Judges → Arbiter → saving),
 * generating a Set (planning → writing → checking → audio). Each step says its state in words; the
 * current step is announced politely when it changes, once — not on every poll.
 */
export function StepProgress({ label, steps, className }: StepProgressProps) {
  const activeIndex = steps.findIndex((s) => s.state === "active" || s.state === "failed");
  const current = activeIndex >= 0 ? steps[activeIndex] : steps.every((s) => s.state === "done" || s.state === "skipped") ? null : undefined;
  const announcement =
    current === null
      ? `${label}: finished.`
      : current
        ? `${label}: step ${activeIndex + 1} of ${steps.length}, ${current.label}, ${STEP_WORD[current.state]}.`
        : "";
  return (
    <div className={className}>
      <ol aria-label={label} className="grid gap-x-4 gap-y-3 sm:grid-flow-col sm:auto-cols-fr">
        {steps.map((step, i) => (
          <li key={step.key} className="flex items-start gap-2.5 sm:flex-col sm:items-start sm:gap-2">
            <div className="flex items-center gap-2 sm:w-full">
              <StepMarker state={step.state} index={i} />
              {i < steps.length - 1 && (
                <span aria-hidden="true" className={cx("hidden h-px flex-1 sm:block", step.state === "done" ? "bg-accent" : "bg-rule-strong")} />
              )}
            </div>
            <div className="min-w-0 -mt-0.5 sm:mt-0">
              <p className={cx("text-ui", step.state === "pending" ? "text-graphite" : "font-medium text-ink")}>
                {step.label}
                <span className="sr-only"> ({STEP_WORD[step.state]})</span>
              </p>
              {step.detail && <p className="text-meta text-graphite">{step.detail}</p>}
            </div>
          </li>
        ))}
      </ol>
      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  );
}
