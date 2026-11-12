import type { ReactNode } from "react";
import CefrLevelNote from "../components/CefrLevelNote";
import { cx } from "./cx";
import { formatBand, targetGapText } from "./format";

export type BandKind = "estimate" | "target";
type BandSize = "lg" | "md" | "sm";

const NUMBER: Record<BandSize, string> = {
  lg: "text-figure-lg",
  md: "text-figure",
  sm: "text-figure-sm",
};

const SUFFIX: Record<BandSize, string> = {
  lg: "text-figure-sm",
  md: "text-heading",
  sm: "text-ui",
};

type BandFigureProps = {
  /** A band on the 1–6 half-step grid, or null when there is none yet. */
  band: number | null;
  /**
   * What the number is, which decides how it is marked:
   * - `estimate` (default) — computed by this app. Pencilled: a dashed rule under the figure and the
   *   word "estimate". Every band the app computes is one; there is no unmarked variant.
   * - `target` — the band the User is aiming for. Solid ink, "target".
   */
  kind?: BandKind;
  size?: BandSize;
  /** With `band` null: what is missing, in the User's terms ("Score an Email and an Academic Discussion"). */
  missing?: ReactNode;
  /**
   * With `band` null: the line that says so. "No band yet" (default) while one can still come; "No
   * band" where none will (a discarded Attempt, a Drill that never produces one).
   */
  emptyLabel?: string;
  /** A qualifier after the tag, e.g. a caution Chip on a band that carries a condition. */
  note?: ReactNode;
  /**
   * Hide the "target" word when a visible label right before the figure already says it
   * ("Target 5.5/6 · C1"). Ignored for estimates: an estimate is always marked as one.
   */
  tag?: boolean;
  className?: string;
};

const TAG: Record<BandKind, string> = { estimate: "estimate", target: "target" };

/**
 * A band, everywhere a band appears: the number, "/6", its CEFR level (always via CefrLevelNote, so
 * the level inherits the band's status: an estimated band, an estimated level), and what kind of
 * number it is.
 * Never print a band as bare text; never lift the CEFR level out of this figure.
 */
export function BandFigure({ band, kind = "estimate", size = "md", missing, emptyLabel = "No band yet", note, tag = true, className }: BandFigureProps) {
  if (band === null) {
    return (
      <div className={cx("min-w-0", className)}>
        <p className={cx("font-serif figures font-semibold text-faint", NUMBER[size])} aria-hidden="true">
          —
        </p>
        <p className={cx("font-medium text-ink-soft", size === "sm" ? "text-meta" : "mt-2 text-ui")}>{emptyLabel}</p>
        {missing && <p className="mt-0.5 text-meta text-graphite text-pretty">{missing}</p>}
      </div>
    );
  }

  return (
    <div className={cx("flex flex-wrap items-baseline gap-x-2 gap-y-1", className)}>
      <span className="font-serif figures font-semibold text-ink">
        <span
          className={cx(
            NUMBER[size],
            kind === "estimate" &&
              "underline decoration-dashed decoration-estimate-rule underline-offset-[0.14em] [text-decoration-thickness:max(1px,0.035em)]",
          )}
        >
          {formatBand(band)}
        </span>
        <span className={cx("font-medium text-graphite", SUFFIX[size])}>
          <span aria-hidden="true">/6</span>
          <span className="sr-only"> out of 6</span>
          <CefrLevelNote band={band} className="font-medium text-graphite" />
        </span>
      </span>
      {(tag || kind === "estimate") && (
      <span
        className={cx(
          "inline-flex items-center gap-1 font-semibold tracking-[0.05em] [font-variant-caps:all-small-caps]",
          size === "sm" ? "text-meta" : "text-ui",
          kind === "target" ? "text-ink-soft" : "text-estimate",
        )}
      >
        {TAG[kind]}
      </span>
      )}
      {note}
    </div>
  );
}

/**
 * An Item's final score on its 0–5 rubric (a Score Report's final score). Pencilled like a band —
 * it is a model's estimate too — but with no "/6" and no CEFR level, which belong to bands only.
 * For 0–1 accuracy Task Types show a percentage or "Correct"/"Incorrect" instead.
 */
export function ScoreFigure({ score, max = 5, size = "md" }: { score: number; max?: number; size?: "md" | "sm" }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="font-serif figures font-semibold text-ink">
        <span
          className={cx(
            size === "md" ? "text-figure" : "text-figure-sm",
            "underline decoration-dashed decoration-estimate-rule underline-offset-[0.14em] [text-decoration-thickness:max(1px,0.035em)]",
          )}
        >
          {Number.isInteger(score) ? score : score.toFixed(1)}
        </span>
        <span className={cx("font-medium text-graphite", size === "md" ? "text-heading" : "text-ui")}>
          <span aria-hidden="true">/{max}</span>
          <span className="sr-only"> out of {max}</span>
        </span>
      </span>
      <span className={cx("font-semibold tracking-[0.05em] text-estimate [font-variant-caps:all-small-caps]", size === "md" ? "text-ui" : "text-meta")}>
        estimate
      </span>
    </span>
  );
}

type BandScaleProps = {
  /** The section's Band Estimate, if there is one. */
  band: number | null;
  target?: number;
  /** The section name, for the accessible description ("Speaking"). */
  label: string;
  className?: string;
};

const position = (band: number) => `${((Math.min(6, Math.max(1, band)) - 1) / 5) * 100}%`;
const TICKS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6];

/**
 * The 1–6 band ruler: where the section stands against its Target, at a glance and in words. The
 * caret is the estimate, the solid bar is the Target, and the sentence under the ruler says the
 * distance — the picture never carries meaning alone. CEFR levels are deliberately not drawn on the
 * ruler (they belong to a band figure, via CefrLevelNote).
 */
export function BandScale({ band, target, label, className }: BandScaleProps) {
  const summary =
    band === null
      ? target !== undefined
        ? `Target ${formatBand(target)}. No band yet.`
        : "No band yet."
      : target !== undefined
        ? `Estimate ${formatBand(band)}, Target ${formatBand(target)}: ${targetGapText(band, target)}.`
        : `Estimate ${formatBand(band)}.`;

  const lo = band !== null && target !== undefined ? Math.min(band, target) : null;
  const hi = band !== null && target !== undefined ? Math.max(band, target) : null;

  return (
    <div className={cx("min-w-0", className)}>
      <div role="img" aria-label={`${label} on the 1 to 6 band scale. ${summary}`} className="relative h-11 select-none">
        {/* Track */}
        <div className="absolute inset-x-0 top-4 h-px bg-rule-strong" />
        {/* The stretch between estimate and Target, drawn as a heavier rule. */}
        {lo !== null && hi !== null && hi > lo && (
          <div
            className={cx("absolute top-[0.9375rem] h-[3px] rounded-full", band! < target! ? "bg-caution-rule" : "bg-positive-rule")}
            style={{ left: position(lo), width: `calc(${position(hi)} - ${position(lo)})` }}
          />
        )}
        {/* Ticks and numerals */}
        {TICKS.map((t) => (
          <div key={t} className="absolute top-4 -translate-x-1/2" style={{ left: position(t) }}>
            <div className={cx("mx-auto w-px bg-rule-strong", Number.isInteger(t) ? "h-2" : "h-1")} />
            {Number.isInteger(t) && <div className="figures mt-0.5 text-center text-caption text-faint">{t}</div>}
          </div>
        ))}
        {/* Target: a solid ink bar across the track. */}
        {target !== undefined && (
          <div className="absolute top-2.5 h-3.5 w-[3px] -translate-x-1/2 rounded-full bg-ink" style={{ left: position(target) }} />
        )}
        {/* The estimate's caret. */}
        {band !== null && (
          <svg
            width="12"
            height="9"
            viewBox="0 0 12 9"
            className="absolute top-0 -translate-x-1/2 text-ink"
            style={{ left: position(band) }}
            aria-hidden="true"
          >
            <path
              d="M1 1h10L6 8z"
              fill="currentColor"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
      <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-meta text-graphite" aria-hidden="true">
        {band !== null && (
          <span className="inline-flex items-center gap-1">
            <svg width="9" height="7" viewBox="0 0 12 9" className="text-ink">
              <path d="M1 1h10L6 8z" fill="currentColor" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            Estimate
          </span>
        )}
        {target !== undefined && (
          <span className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-[3px] rounded-full bg-ink" />
            Target
          </span>
        )}
        {band !== null && target !== undefined && <span className="font-medium text-ink-soft">{targetGapText(band, target)}</span>}
      </p>
    </div>
  );
}
