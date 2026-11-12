import type { ReactNode } from "react";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Kicker } from "../../ui/Heading";
import { IconCheck, IconCross, IconDash } from "../../ui/icons";
import { cx } from "../../ui/cx";
import { DISCARDED_NOT_SCORABLE } from "./reviewText";

// The small pieces every Item renderer in Attempt review shares.

/**
 * A link to a place on this page ("#group-email"). A router Link would change the URL without
 * scrolling, so this is a plain anchor drawn like TextLink: underlined, never colour alone.
 */
export function HashLink({ href, children }: { href: `#${string}`; children: ReactNode }) {
  return (
    <a
      href={href}
      className="rounded-chip font-medium text-accent underline decoration-accent-rule decoration-1 underline-offset-[0.2em] transition-colors duration-(--duration-quick) hover:text-accent-strong hover:decoration-accent"
    >
      {children}
    </a>
  );
}

/** Right, wrong or unanswered: an icon AND a word, so the result never rests on colour. */
export function ResultMark({ correct, unanswered = false, className }: { correct: boolean; unanswered?: boolean; className?: string }) {
  if (unanswered) {
    return (
      <span className={cx("inline-flex shrink-0 items-center gap-1 text-meta font-medium text-correction", className)}>
        <IconDash size={14} />
        No Response
      </span>
    );
  }
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1 text-meta font-medium", correct ? "text-positive" : "text-correction", className)}>
      {correct ? <IconCheck size={14} /> : <IconCross size={14} />}
      {correct ? "Correct" : "Incorrect"}
    </span>
  );
}

type ItemCardProps = {
  itemId: string;
  /** "Item 11 of 12". */
  kicker: string;
  title: ReactNode;
  /** h2 when the card is its own group (an Email), h3 inside a group (one Interview question). */
  headingLevel: "h2" | "h3";
  chips?: ReactNode;
  /** The score figure, top right. */
  figure?: ReactNode;
  children: ReactNode;
};

/** One judged Item: a header (position, name, state, score) over the Item's own review. */
export function ItemCard({ itemId, kicker, title, headingLevel: Heading, chips, figure, children }: ItemCardProps) {
  const headingId = `item-heading-${itemId}`;
  return (
    <Card as="article" padding="none" id={`item-${itemId}`} data-testid={`item-${itemId}`} aria-labelledby={headingId} className="min-w-0 scroll-mt-6">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b border-rule px-4 py-4 sm:px-6">
        <div className="min-w-0">
          <Kicker as="p">{kicker}</Kicker>
          <Heading id={headingId} className="text-heading font-semibold text-ink">
            {title}
          </Heading>
          {chips && <div className="mt-2 flex flex-wrap gap-2">{chips}</div>}
        </div>
        {figure && (
          <div className="text-right">
            <p className="text-meta text-graphite">Score Report</p>
            {figure}
          </div>
        )}
      </header>
      <div className="space-y-8 px-4 py-5 sm:px-6 sm:py-6">{children}</div>
    </Card>
  );
}

/**
 * Re-score on one Item's card. A Re-score sends every re-scorable Item of the Task Type together (one
 * job per Task Type), so when more than one Item of the Task Type needs it the button is the group's
 * (GroupRescoreAction) and the card points there instead. It waits while another job of the Task
 * Type runs. A discarded Attempt is never scored again (the server refuses it), so it gets a sentence.
 */
export function RescoreAction({
  onRescore,
  taskBusy,
  grouped,
  taskTypeName,
  discarded,
}: {
  onRescore: () => void;
  taskBusy: boolean;
  /** Other Items of this Task Type need a Re-score too, so the button sits at the top of the group. */
  grouped: boolean;
  taskTypeName: string;
  discarded: boolean;
}) {
  if (discarded) return <p className="text-ui text-ink-soft">{DISCARDED_NOT_SCORABLE}</p>;
  if (taskBusy) {
    return <p className="text-ui text-ink-soft">This Item can be re-scored once the scoring run in progress finishes.</p>;
  }
  if (grouped) {
    return <p className="text-ui text-ink-soft">Re-score it with the other {taskTypeName} Items, from the top of this group.</p>;
  }
  return (
    <Button size="sm" onClick={onRescore}>
      Re-score
    </Button>
  );
}

/**
 * The one Re-score for a Task Type with several Items that need it, beside the group's heading. It
 * sends them all in one job, as the server scores them. Nothing is offered while a job of the Task
 * Type runs or once the Attempt is discarded: each card says why.
 */
export function GroupRescoreAction({ count, onRescore, taskBusy, discarded }: { count: number; onRescore: () => void; taskBusy: boolean; discarded: boolean }) {
  if (count < 2 || taskBusy || discarded) return null;
  return (
    <Button size="sm" onClick={onRescore}>
      Re-score {count} Items
    </Button>
  );
}
