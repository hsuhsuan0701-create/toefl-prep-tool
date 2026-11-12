import { useState, type ReactNode } from "react";
import type { AttemptListItemVM, AttemptListVM } from "@toefl-prep/shared";
import { abortAttempt, completeAttempt } from "../lib/api";
import { requestErrorMessage } from "../lib/requestError";
import { Button, ButtonLink, TextLink } from "../ui/Button";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { EmptyState } from "../ui/EmptyState";
import { formatWhen } from "../ui/format";
import { ATTEMPT_MODE_LABEL, SECTION_LABEL } from "../ui/labels";
import { AttemptRow, List } from "../ui/ListRow";
import { Notice } from "../ui/Notice";
import { Skeleton } from "../ui/Skeleton";

type PendingAction = { attempt: AttemptListItemVM; action: "finish" | "discard" };

/**
 * What finishing an unfinished Attempt does to it. A Speaking Simulation is finalized as the exam
 * is: an Item never recorded scores 0. Every other Attempt is completed on what it already holds.
 */
function finishConsequence(a: AttemptListItemVM): string {
  return a.kind === "speaking" && a.mode === "simulation"
    ? "Items you haven't recorded will score 0, as an unanswered question does on the real test."
    : "Only what you've already submitted is scored, and you can't add to it afterwards.";
}

// The abort route keeps the row and anything already scored; the Attempt just never completes.
const DISCARD_CONSEQUENCE =
  "It stays in your history, but nothing more is scored and it never gets a Band Estimate. This cannot be undone.";

/**
 * The Run this unfinished Attempt is the live section of, if any. Finishing or discarding it from
 * here would end that section for good (a Run never re-sits one), so its row leads back into the Run
 * instead. A Run no longer in progress, or a section a restart replaced, leaves both actions.
 */
function liveFullTestRunId(a: AttemptListItemVM): string | null {
  return a.status === "in_progress" && a.fullTestRun?.status === "in-progress" ? a.fullTestRun.id : null;
}

/** A finished Reading or Listening Drill has no band by design, which the row says rather than leaving a gap. */
function rowSummary(a: AttemptListItemVM): string | undefined {
  if (liveFullTestRunId(a)) return "A section of a Full-Test Run in progress";
  if (a.status === "completed" && a.estimate === null && a.mode === "drill" && (a.kind === "reading" || a.kind === "listening")) {
    return "Drills give no band";
  }
  return undefined;
}

/**
 * A completed Attempt that was meant to give a band and has none: its scoring failed, an Item was
 * never transcribed or never captured. A Reading or Listening Drill, or a Drill of fewer Task Types,
 * gives no band by design (`bandExpected`), and a Repeat never becomes a headline band, so neither
 * is marked.
 */
function missingBand(a: AttemptListItemVM): boolean {
  return a.status === "completed" && a.estimate === null && !a.isRepeat && a.bandExpected;
}

/**
 * The Attempt log as AttemptRows: each named by what it was ("Writing Simulation"), its Set and
 * when, with its own Band Estimate or its status in words. The Practice page shows the last few
 * (`limit` + `seeAllHref`); /progress pages through the whole log (`onLoadMore`).
 */
export default function AttemptsFeed({
  attempts,
  error,
  onChanged,
  limit,
  seeAllHref,
  onLoadMore,
  loadingMore = false,
  emptyAction,
}: {
  attempts: AttemptListVM | null;
  error?: string;
  /** Re-fetches the log; called after an Attempt is finished or discarded, and by "Try again". */
  onChanged: () => void;
  limit?: number;
  seeAllHref?: string;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  /** The next step when there are no Attempts at all, e.g. a link to the Sets. */
  emptyAction?: ReactNode;
}) {
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<Record<string, string>>({});

  // "Finish and score" runs the completion the run itself would have (for a Speaking Simulation,
  // the durable finalizer that computes the band); "Discard" marks the Attempt aborted. Both ask
  // first, and both re-fetch rather than patch local state, so what is shown is what the server did.
  const confirm = async ({ attempt, action }: PendingAction) => {
    setBusy(true);
    setActionError((prev) => {
      const next = { ...prev };
      delete next[attempt.id];
      return next;
    });
    try {
      await (action === "finish" ? completeAttempt(attempt.id) : abortAttempt(attempt.id));
      setPending(null);
      onChanged();
    } catch (err) {
      setPending(null);
      setActionError((prev) => ({ ...prev, [attempt.id]: requestErrorMessage(err) }));
    } finally {
      setBusy(false);
    }
  };

  const items = attempts?.items ?? null;
  const shown = items && limit !== undefined ? items.slice(0, limit) : items;
  const total = attempts?.total ?? 0;
  const pendingName = pending ? `${SECTION_LABEL[pending.attempt.kind]} ${ATTEMPT_MODE_LABEL[pending.attempt.mode]}` : "";

  return (
    <div className="space-y-4" aria-busy={attempts === null && !error ? true : undefined}>
      {/* A failure is said out loud even over a log loaded earlier, which is then stale. */}
      {error && (
        <Notice
          tone="critical"
          title={attempts === null ? "Couldn't load your Attempts" : "Couldn't refresh your Attempts"}
          action={
            <Button size="sm" onClick={onChanged}>
              Try again
            </Button>
          }
        >
          {error}
          {attempts !== null && " The list below is as it last loaded."}
        </Notice>
      )}

      {attempts === null && !error && (
        <List label="Attempts, loading">
          {[0, 1, 2].map((i) => (
            <li key={i} className="px-4 py-3">
              <Skeleton lines={2} className="max-w-sm" />
            </li>
          ))}
        </List>
      )}

      {shown !== null && shown.length === 0 && (
        <EmptyState title="No Attempts yet" action={emptyAction}>
          Your Attempts appear here as soon as you start one, finished or not.
        </EmptyState>
      )}

      {shown !== null && shown.length > 0 && (
        <List label="Attempts">
          {shown.map((a) => (
            <AttemptRow
              key={a.id}
              section={a.kind}
              mode={a.mode}
              setTitle={a.setTitle ?? a.setId}
              when={formatWhen(a.startedAt)}
              to={`/attempts/${a.id}`}
              status={a.status}
              band={a.estimate?.band ?? null}
              modulePath={a.modulePath}
              repeat={a.isRepeat}
              flagged={a.flagged}
              noBand={missingBand(a)}
              summary={rowSummary(a)}
              actions={
                liveFullTestRunId(a) ? (
                  <ButtonLink size="sm" to={`/full-test/${liveFullTestRunId(a)}`}>
                    Resume the Full-Test Run
                  </ButtonLink>
                ) : a.status === "in_progress" ? (
                  <>
                    <Button size="sm" disabled={busy && pending?.attempt.id === a.id} onClick={() => setPending({ attempt: a, action: "finish" })}>
                      Finish and score…
                    </Button>
                    <Button size="sm" variant="quiet" disabled={busy && pending?.attempt.id === a.id} onClick={() => setPending({ attempt: a, action: "discard" })}>
                      Discard…
                    </Button>
                    {actionError[a.id] && (
                      <p role="alert" className="basis-full text-meta text-critical">
                        {actionError[a.id]}
                      </p>
                    )}
                  </>
                ) : undefined
              }
            />
          ))}
        </List>
      )}

      {seeAllHref && shown !== null && total > shown.length && (
        <p className="text-ui">
          <TextLink to={seeAllHref}>See all {total} Attempts</TextLink>
        </p>
      )}

      {onLoadMore && items !== null && total > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-meta text-graphite">
          {items.length < total ? (
            <>
              <span className="figures">
                Showing {items.length} of {total} Attempts
              </span>
              <Button size="sm" onClick={onLoadMore} loading={loadingMore}>
                Load more
              </Button>
            </>
          ) : (
            <span className="figures">All {total} Attempts</span>
          )}
        </div>
      )}

      <ConfirmDialog
        open={pending !== null}
        title={pending?.action === "discard" ? "Discard this Attempt?" : `Finish and score this ${pendingName}?`}
        confirmLabel={pending?.action === "discard" ? "Discard" : "Finish and score"}
        cancelLabel={pending?.action === "discard" ? "Cancel" : "Keep it open"}
        tone={pending?.action === "discard" ? "destructive" : "default"}
        busy={busy}
        onConfirm={() => pending && void confirm(pending)}
        onCancel={() => setPending(null)}
      >
        {pending && <p>{pending.action === "discard" ? DISCARD_CONSEQUENCE : finishConsequence(pending.attempt)}</p>}
      </ConfirmDialog>
    </div>
  );
}
