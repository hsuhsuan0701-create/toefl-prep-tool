import type { Ref } from "react";
import { cx } from "./cx";
import { formatBand } from "./format";

/** The half-step 1–6 grid every band lives on, estimated or set by the User. */
const BAND_STEPS = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6] as const;

type BandSelectProps = {
  value: number;
  onChange: (band: number) => void;
  /** Names the field: "Reading Target". Visible unless `hideLabel`, and always the accessible name. */
  label: string;
  /** Keep the label for screen readers only, when the surrounding line already says it. */
  hideLabel?: boolean;
  disabled?: boolean;
  ref?: Ref<HTMLSelectElement>;
  className?: string;
};

/**
 * A field for choosing a band the User sets, such as a Target: a native select over the half-step
 * 1–6 grid, so the keyboard, screen readers and phones all get their platform control. It shows
 * the number only; the CEFR level belongs to a band figure (BandFigure), not to a form option.
 */
export function BandSelect({ value, onChange, label, hideLabel, disabled, ref, className }: BandSelectProps) {
  return (
    <label className={cx("inline-flex items-center gap-2", className)}>
      <span className={hideLabel ? "sr-only" : "text-meta text-graphite"}>{label}</span>
      <select
        ref={ref}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={cx(
          "figures min-h-10 rounded-control border border-rule-strong bg-field pr-7 pl-2.5 text-ui text-ink",
          "transition-colors duration-(--duration-quick) hover:border-graphite disabled:cursor-not-allowed disabled:text-faint",
          "pointer-coarse:min-h-11",
        )}
      >
        {BAND_STEPS.map((band) => (
          <option key={band} value={band}>
            {formatBand(band)}
          </option>
        ))}
      </select>
    </label>
  );
}
