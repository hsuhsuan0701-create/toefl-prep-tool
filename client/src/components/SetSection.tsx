import { useId, useState, type ReactNode } from "react";
import type { SetMeta } from "../lib/api";
import { Button, ButtonLink, TextLink } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { formatDay } from "../ui/format";
import { SectionHeader } from "../ui/Heading";
import { advisoryNoteLines } from "../ui/labels";
import { List, SetRow } from "../ui/ListRow";
import { Notice } from "../ui/Notice";
import { Skeleton } from "../ui/Skeleton";

/**
 * One section's Sets as a ruled list of SetRows: the whole bank on /sets (with "Hide attempted"),
 * or, with `limit`, the next few Sets not attempted yet on the Practice page, with a link to the rest.
 *
 * "Attempted" is each entry's own `attempted` flag, set by the server; this list reads no Attempts.
 * Unattempted Sets come first; the listing's newest-first order holds within each half. The
 * shortlist holds unattempted Sets only, because that is what it is offered as.
 */
export default function SetSection({
  title,
  linkBase,
  simulateHref,
  sets,
  error,
  limit,
  seeAllHref,
  onRetry,
  emptyAction,
}: {
  title: string;
  linkBase: string;
  /**
   * The Simulation entry point. It picks an unattempted Set by the same `attempted` flag and does
   * its own fetch, so it stays usable when this list failed to load.
   */
  simulateHref: string;
  sets: SetMeta[] | null;
  /** Set only when this section's own listing failed; every other section renders regardless. */
  error?: string;
  /** Show only the first `limit` unattempted Sets (the Practice page's shortlist) and link to `seeAllHref`. */
  limit?: number;
  seeAllHref?: string;
  /** Re-requests the listing after a failure. Without it the failure offers no retry. */
  onRetry?: () => void;
  /** The next step when the section has no Sets at all, e.g. a link to generate some. */
  emptyAction?: ReactNode;
}) {
  const [hideAttempted, setHideAttempted] = useState(false);
  const headingId = useId();
  const fullBank = limit === undefined;

  const ordered = sets ? [...sets].sort((a, b) => Number(a.attempted) - Number(b.attempted)) : null;
  const filtered = ordered && (!fullBank || hideAttempted) ? ordered.filter((s) => !s.attempted) : ordered;
  const shown = filtered && !fullBank ? filtered.slice(0, limit) : filtered;
  const total = ordered?.length ?? 0;
  const newCount = ordered?.filter((s) => !s.attempted).length ?? 0;

  return (
    <section aria-labelledby={headingId} aria-busy={sets === null && !error ? true : undefined} className="space-y-4">
      <SectionHeader
        id={headingId}
        title={title}
        description={ordered && total > 0 ? `${total} ${total === 1 ? "Set" : "Sets"} · ${newCount} new` : undefined}
        action={
          <>
            {fullBank && total > 0 && (
              <label className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-ui text-ink-soft select-none pointer-coarse:min-h-10">
                <input
                  type="checkbox"
                  checked={hideAttempted}
                  onChange={(e) => setHideAttempted(e.target.checked)}
                  className="size-4 accent-accent"
                />
                Hide attempted
              </label>
            )}
            <ButtonLink to={simulateHref} size="sm">
              Start Simulation
            </ButtonLink>
          </>
        }
      />

      {/* A failure is said out loud even over a list loaded earlier, which is then stale. */}
      {error && (
        <Notice
          tone="critical"
          title={shown === null ? "Couldn't load this list" : "Couldn't refresh this list"}
          action={
            onRetry && (
              <Button size="sm" onClick={onRetry}>
                Try again
              </Button>
            )
          }
        >
          {error}
          {shown !== null && " The list below is as it last loaded."}
        </Notice>
      )}

      {shown === null && !error && (
        <List label={`${title}, loading`}>
          {[0, 1, 2].map((i) => (
            <li key={i} className="px-4 py-3">
              <Skeleton lines={2} className="max-w-md" />
            </li>
          ))}
        </List>
      )}

      {shown !== null && total === 0 && !error && (
        <EmptyState title={`No ${title} yet`} action={emptyAction}>
          Sets you generate or add to the bank appear here.
        </EmptyState>
      )}

      {shown !== null && total > 0 && shown.length === 0 && (
        <EmptyState
          title={fullBank ? "Nothing new here" : `Nothing new in ${title}`}
          action={
            fullBank && (
              <Button size="sm" variant="quiet" onClick={() => setHideAttempted(false)}>
                Show attempted
              </Button>
            )
          }
        >
          You have attempted every one of these {total} Sets. Another Attempt on one is a Repeat, which is left out of Band
          Estimates.
        </EmptyState>
      )}

      {shown !== null && shown.length > 0 && (
        <List label={title}>
          {shown.map((s) => (
            <SetRow
              key={s.id}
              title={s.title}
              setId={s.id}
              to={`${linkBase}/${s.id}`}
              // The shortlist is new by definition, so its rows carry no state chip.
              state={fullBank ? (s.attempted ? "attempted" : "new") : undefined}
              source={s.source}
              created={formatDay(s.createdAt)}
              summary={s.summary ?? undefined}
              noteLines={advisoryNoteLines(s.advisoryNotes ?? [])}
            />
          ))}
        </List>
      )}

      {!fullBank && seeAllHref && shown !== null && total > shown.length && (
        <p className="text-ui">
          <TextLink to={seeAllHref}>
            See all {total} {title}
          </TextLink>
        </p>
      )}
    </section>
  );
}
