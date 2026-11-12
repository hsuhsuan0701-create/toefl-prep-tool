import type { ReactNode } from "react";
import { cx } from "./cx";
import { StatusGlyph } from "./icons";
import type { Glyph, StatusPresentation, Tone } from "./labels";

const TONE: Record<Tone, string> = {
  neutral: "bg-well text-ink-soft border-rule",
  accent: "bg-accent-wash text-accent border-accent-rule",
  positive: "bg-positive-wash text-positive border-positive-rule",
  caution: "bg-caution-wash text-caution border-caution-rule",
  critical: "bg-critical-wash text-critical border-critical-rule",
  correction: "bg-correction-wash text-correction border-correction-rule",
};

type ChipProps = {
  tone?: Tone;
  glyph?: Glyph;
  /** A tooltip for the one-sentence meaning (StatusPresentation.hint). */
  title?: string;
  children: ReactNode;
  className?: string;
};

/**
 * A small printed label: a status, a category ("Grammar 文法"), a tag ("Repeat"). Squared, not a
 * pill. Always words, optionally a glyph — never colour alone. Not interactive; for a choice use
 * SegmentedControl.
 */
export function Chip({ tone = "neutral", glyph = "none", title, children, className }: ChipProps) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1 rounded-chip border px-1.5 py-px text-caption font-medium whitespace-nowrap",
        TONE[tone],
        className,
      )}
    >
      <StatusGlyph glyph={glyph} size={12} />
      {children}
    </span>
  );
}

/**
 * A status from one of ui/labels.ts's tables: `<StatusChip status={ATTEMPT_STATUS[attempt.status]} />`.
 * Never build a status chip from a raw code — go through the table so the words stay the same app-wide.
 */
export function StatusChip({ status, className }: { status: StatusPresentation; className?: string }) {
  return (
    <Chip tone={status.tone} glyph={status.glyph} title={status.hint} className={className}>
      {status.label}
    </Chip>
  );
}
