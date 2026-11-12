import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";

type Option<T extends string> = { value: T; label: ReactNode };

/** Arrow/Home/End movement across a row of buttons; returns the index to focus, or null. */
function nextIndex(e: KeyboardEvent, current: number, count: number): number | null {
  switch (e.key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

type SegmentedControlProps<T extends string> = {
  /** Names the choice for screen readers: "Trend range". */
  label: string;
  options: Option<T>[];
  value: T;
  onChange: (value: T) => void;
  size?: "md" | "sm";
  className?: string;
};

/**
 * One choice among a few, applied immediately: the trend range on Progress. A radio group: one Tab
 * stop, arrows move and select. For switching between panels of content use Tabs; for navigation
 * between pages use links.
 *
 * On a screen too narrow for every option the row wraps inside its track rather than scrolling, so
 * no option sits out of sight.
 */
export function SegmentedControl<T extends string>({ label, options, value, onChange, size = "md", className }: SegmentedControlProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div role="radiogroup" aria-label={label} className={cx("inline-flex max-w-full flex-wrap gap-y-0.5 rounded-control border border-rule-strong bg-well p-0.5", className)}>
      {options.map((o, i) => {
        const checked = i === selected;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              const n = nextIndex(e, i, options.length);
              if (n === null) return;
              e.preventDefault();
              onChange(options[n].value);
              refs.current[n]?.focus();
            }}
            className={cx(
              "rounded-[0.1875rem] font-medium whitespace-nowrap transition-colors duration-(--duration-quick)",
              size === "sm" ? "min-h-7 px-2.5 text-meta pointer-coarse:min-h-10" : "min-h-8 px-3 text-ui pointer-coarse:min-h-10",
              checked ? "bg-sheet text-ink shadow-[0_0_0_1px_var(--color-rule-strong)]" : "text-ink-soft hover:text-ink",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

type TabItem = { id: string; label: ReactNode; panel: ReactNode };

type TabsProps = {
  label: string;
  items: TabItem[];
  /** Controlled selection; omit for the Tabs to manage it. */
  value?: string;
  onChange?: (id: string) => void;
  className?: string;
};

/**
 * Panels of related content where only one is shown at a time: the Sets page's sections. Ruled
 * underline tabs; arrows move between tabs and select.
 */
export function Tabs({ label, items, value, onChange, className }: TabsProps) {
  const [internal, setInternal] = useState(items[0]?.id ?? "");
  const selectedId = value ?? internal;
  const baseId = useId();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const select = (id: string) => {
    if (value === undefined) setInternal(id);
    onChange?.(id);
  };
  const selected = items.find((t) => t.id === selectedId) ?? items[0];
  return (
    <div className={className}>
      <div role="tablist" aria-label={label} className="flex gap-5 overflow-x-auto border-b border-rule">
        {items.map((t, i) => {
          const isSelected = t.id === selected?.id;
          return (
            <button
              key={t.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${t.id}`}
              aria-selected={isSelected}
              aria-controls={`${baseId}-panel-${t.id}`}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => select(t.id)}
              onKeyDown={(e) => {
                const n = nextIndex(e, i, items.length);
                if (n === null) return;
                e.preventDefault();
                select(items[n].id);
                refs.current[n]?.focus();
              }}
              className={cx(
                "-mb-px min-h-10 border-b-2 text-ui font-medium whitespace-nowrap transition-colors duration-(--duration-quick)",
                isSelected ? "border-accent text-ink" : "border-transparent text-graphite hover:text-ink",
              )}
            >
              {t.label}
            </button>
          );
        })}
      </div>
      {selected && (
        <div role="tabpanel" id={`${baseId}-panel-${selected.id}`} aria-labelledby={`${baseId}-tab-${selected.id}`} tabIndex={0} className="pt-4 focus-visible:outline-offset-4">
          {selected.panel}
        </div>
      )}
    </div>
  );
}
