import { cx } from "../../ui/cx";
import { Kicker } from "../../ui/Heading";

/** One Item's entry in the overview: its id, and whether it currently carries a Response. */
export type SentenceOverviewItem = {
  /** The Build a Sentence Item's id — used as the React key, and as what a jump resolves to. */
  id: string;
  /**
   * True when the Item carries a Response: at least one blank filled. An Item the User visited and
   * left empty is `false`, exactly like one never reached — both commit as empty, so both read as
   * carrying no Response. Deriving this belongs to whatever owns the run state; this component is
   * handed the outcome.
   */
  hasResponse: boolean;
};

export type SentenceItemOverviewProps = {
  /** Every Item in the run, in run order. The entry's position is the Item index. */
  items: SentenceOverviewItem[];
  /** Index of the Item the User is on, in the same index space as `items`. */
  currentIndex: number;
  /** Reports the Item the User selected. This component performs no navigation itself. */
  onJump: (index: number) => void;
};

/**
 * The review affordance for a Build a Sentence run: one control per Item, showing which Items
 * already carry a Response, which Item the User is on, and letting the User jump straight to any of
 * them.
 *
 * Back-navigation without it is not navigation: ten Items reachable only by stepping backwards give
 * the User no way to find the one they skipped.
 *
 * Purely presentational and holds no run state. A private internal of the Build a Sentence task
 * module: `BuildSentenceTask` derives the flags from the run state and this renders them.
 *
 * Exactly two states per Item (carries a Response / does not) plus the current-Item marker, and no
 * third "visited but empty" state: it would promise a distinction the commit path does not make.
 * The states differ by shape, not only colour — a solid edge against a dashed one, the same dashed
 * idiom an empty blank uses — and the current Item by a ring of its own.
 */
export default function SentenceItemOverview({ items, currentIndex, onJump }: SentenceItemOverviewProps) {
  const withResponse = items.filter((item) => item.hasResponse).length;

  return (
    <nav aria-label="Build a Sentence Items" className="space-y-2">
      <Kicker as="p">
        Items · {withResponse} of {items.length} carry a Response
      </Kicker>
      <ul className="flex flex-wrap items-center gap-2">
        {items.map((item, index) => {
          const isCurrent = index === currentIndex;

          return (
            <li key={item.id}>
              <button
                type="button"
                // The current Item stays enabled: disabling it would drop it out of the tab order,
                // and a jump to where the User already is is a harmless no-op for the run state.
                onClick={() => onJump(index)}
                aria-current={isCurrent ? "true" : undefined}
                aria-label={`Item ${index + 1} of ${items.length}, ${item.hasResponse ? "carries a Response" : "no Response yet"}`}
                data-testid={`bas-overview-item-${index}`}
                className={cx(
                  "figures h-10 w-10 rounded-control border text-ui font-medium pointer-coarse:h-11 pointer-coarse:w-11",
                  "transition-colors duration-(--duration-quick) ease-quiet",
                  item.hasResponse
                    ? "border-accent bg-accent-wash text-accent hover:bg-accent-rule"
                    : "border-dashed border-rule-strong bg-field text-graphite hover:border-graphite",
                  isCurrent && "ring-2 ring-ink ring-offset-2 ring-offset-paper",
                )}
              >
                {index + 1}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
