import { cx } from "./cx";

export type NavigatorStop = {
  key: string;
  /** What the button shows: the Item number, or a range for a passage of gaps ("1–10"). */
  label: string;
  /** What a screen reader hears for it: "Question 21", "Questions 1 to 10". */
  name: string;
  /** How many of this stop's Items are answered: a gap only once every one of its slots holds a letter. */
  answered: number;
  /**
   * How many of this stop's Items hold a Response that is started and not complete: a gap with some
   * of its letters typed. Counted apart from `answered`, never in it.
   */
  partly?: number;
  /** How many Items this stop holds. */
  total: number;
};

type QuestionNavigatorProps = {
  stops: NavigatorStop[];
  /** The stop on screen. */
  current: number;
  onSelect: (index: number) => void;
  /** Names the navigation landmark. */
  label?: string;
  className?: string;
};

type StopState = "answered" | "partial" | "empty";

function stateOf(stop: NavigatorStop): StopState {
  if (stop.answered >= stop.total) return "answered";
  return stop.answered > 0 || (stop.partly ?? 0) > 0 ? "partial" : "empty";
}

function stateWords(stop: NavigatorStop): string {
  const state = stateOf(stop);
  if (state === "answered") return "answered";
  if (state === "partial") {
    const partly = stop.partly ?? 0;
    return `${stop.answered} of ${stop.total} answered${partly > 0 ? `, ${partly} partly filled` : ""}`;
  }
  return "not answered";
}

/**
 * Every question in a Module, as a row of numbered stops the User can jump between — the exam's
 * review strip. Each stop shows its state by shape, never colour alone: answered (every Item
 * answered) is filled; partly (a passage some of whose gaps hold letters but not all of which are
 * complete, even when every gap holds some) is a solid outline filled from the bottom in proportion
 * to its answered Items; not yet (nothing typed or chosen) is a dashed outline. The stop on screen is
 * underlined and marked `aria-current`. Every button's name says its state in words, a count above
 * the row says how many Items are answered, and a small legend says what the shapes mean.
 */
export function QuestionNavigator({ stops, current, onSelect, label = "Questions in this Module", className }: QuestionNavigatorProps) {
  const answeredItems = stops.reduce((n, s) => n + Math.min(s.answered, s.total), 0);
  const totalItems = stops.reduce((n, s) => n + s.total, 0);
  return (
    <nav aria-label={label} className={className}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-meta text-ink-soft">
          <span className="figures font-medium text-ink">{answeredItems}</span> of <span className="figures">{totalItems}</span> Items answered
        </p>
        <p aria-hidden="true" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-graphite">
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-chip bg-ink-soft" /> Answered
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="relative h-2.5 w-2.5 overflow-hidden rounded-chip border border-ink-soft">
              <span className="absolute inset-x-0 bottom-0 h-1/2 bg-ink-soft" />
            </span>
            Partly
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-chip border border-dashed border-graphite" /> Not yet
          </span>
        </p>
      </div>
      <ol className="mt-2.5 flex flex-wrap gap-1.5">
        {stops.map((stop, i) => {
          const state = stateOf(stop);
          const isCurrent = i === current;
          return (
            <li key={stop.key}>
              <button
                type="button"
                onClick={() => onSelect(i)}
                aria-current={isCurrent ? "step" : undefined}
                aria-label={`${stop.name}, ${stateWords(stop)}${isCurrent ? ", on screen" : ""}`}
                className={cx(
                  "figures relative flex h-9 min-w-9 items-center justify-center overflow-hidden rounded-control px-2 text-meta font-medium",
                  "transition-colors duration-(--duration-quick) pointer-coarse:h-11 pointer-coarse:min-w-11",
                  state === "answered" && "border border-ink-soft bg-ink-soft text-sheet hover:bg-ink",
                  state === "partial" && "border border-ink-soft bg-sheet text-ink hover:bg-well",
                  state === "empty" && "border border-dashed border-graphite bg-transparent text-ink-soft hover:bg-well",
                  isCurrent &&
                    "after:absolute after:inset-x-1.5 after:bottom-0.5 after:h-0.5 after:rounded-full after:bg-accent",
                  isCurrent && state === "answered" && "after:bg-sheet",
                )}
              >
                {state === "partial" && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 bottom-0 bg-ink-soft/20"
                    style={{ height: `${(stop.answered / stop.total) * 100}%` }}
                  />
                )}
                <span className="relative">{stop.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
