import { useId, type ReactNode } from "react";
import { cx } from "./cx";
import { IconCheck, IconCross } from "./icons";

export type Choice = { id: string; label: ReactNode };

type ChoiceListProps = {
  /** The question stem's id, or a label, naming the group. */
  labelledBy?: string;
  label?: string;
  choices: Choice[];
  value: string | null;
  onChange?: (id: string) => void;
  disabled?: boolean;
  /**
   * Only once the Item is scored (Attempt review, a Drill's feedback): mark the key and the User's
   * pick. `correctId` gets a check and "Correct answer"; a wrong pick gets a cross and "Your answer".
   * Never pass this while the Item can still be answered.
   */
  reveal?: { correctId: string };
  /** Words for the two reveal marks, where a screen has its own: `{ pick: "Your Response" }`. */
  revealLabels?: { key?: string; pick?: string };
};

/**
 * The answer options of a multiple-choice Item, exam style: full-width rows, a large hit area, a
 * real radio input underneath (so arrows, Space and screen readers behave natively). Letters A–D
 * are part of the row, as on the test; each radio is named by its option's text alone.
 */
export function ChoiceList({ labelledBy, label, choices, value, onChange, disabled, reveal, revealLabels }: ChoiceListProps) {
  const name = useId();
  const keyLabel = revealLabels?.key ?? "Correct answer";
  const pickLabel = revealLabels?.pick ?? "Your answer";
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} aria-label={labelledBy ? undefined : label} className="grid gap-2">
      {choices.map((c, i) => {
        const checked = value === c.id;
        const isKey = reveal?.correctId === c.id;
        const wrongPick = reveal && checked && !isKey;
        return (
          <label
            key={c.id}
            className={cx(
              "group relative flex min-h-12 cursor-pointer items-start gap-3 rounded-control border px-3.5 py-3 transition-colors duration-(--duration-quick)",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-focus",
              reveal
                ? isKey
                  ? "border-positive-rule bg-positive-wash"
                  : wrongPick
                    ? "border-correction-rule bg-correction-wash"
                    : "border-rule bg-sheet"
                : checked
                  ? "border-accent bg-accent-wash"
                  : "border-rule-strong bg-field hover:border-graphite",
              disabled && "cursor-default",
            )}
          >
            <input
              type="radio"
              name={name}
              value={c.id}
              checked={checked}
              disabled={disabled}
              onChange={() => onChange?.(c.id)}
              aria-labelledby={`${name}-${i}`}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className={cx(
                "mt-px flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-meta font-semibold",
                checked ? "border-accent bg-accent text-on-accent" : "border-rule-strong bg-sheet text-ink-soft",
              )}
            >
              {String.fromCharCode(65 + i)}
            </span>
            <span id={`${name}-${i}`} className="min-w-0 flex-1 text-body text-ink">
              {c.label}
            </span>
            {reveal && (isKey || wrongPick) && (
              <span className={cx("inline-flex shrink-0 items-center gap-1 text-meta font-medium", isKey ? "text-positive" : "text-correction")}>
                {isKey ? <IconCheck size={14} /> : <IconCross size={14} />}
                {isKey ? keyLabel : pickLabel}
              </span>
            )}
          </label>
        );
      })}
    </div>
  );
}
