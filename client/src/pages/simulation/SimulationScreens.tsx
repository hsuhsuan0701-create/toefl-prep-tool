import { useEffect, useRef, type ReactNode } from "react";
import { requestErrorMessage } from "../../lib/requestError";
import { Button, TextLink } from "../../ui/Button";
import { IconSpinner } from "../../ui/icons";
import { Notice } from "../../ui/Notice";
import { Skeleton } from "../../ui/Skeleton";
import type { AttemptCompletion } from "./simulationShell";

// The shared shell's chrome: the two full-screen states every section Simulation can be in before
// (or instead of) its own flow, and the status block a running section shows between its screens.
// Components only, so react/only-export-components stays quiet; the shell's behavioural half lives
// next door in simulationShell.ts.
//
// Loading and error draw no ExamShell header: they are the same for all four sections, and loading
// (like a failed load) comes before the section has a Set to name.


/** The full-screen loading state, with `label` in words ("Loading the Set…"). */
export function LoadingMain({ label }: { label: string }) {
  return (
    <main aria-busy="true" className="mx-auto flex min-h-dvh w-full max-w-measure flex-col justify-center gap-4 px-gutter py-16">
      <p className="text-ui text-graphite">{label}</p>
      <Skeleton lines={3} />
    </main>
  );
}

/**
 * The full-screen fatal error state: what went wrong, a Retry when the failure can be retried, and
 * the way back: to the Full-Test Run when the section belongs to one (`fullTestRunId`), otherwise to
 * Practice.
 */
export function ErrorMain({
  message,
  onRetry,
  fullTestRunId,
}: {
  message: string;
  onRetry?: (() => void) | null;
  fullTestRunId?: string;
}) {
  const back = fullTestRunId
    ? { to: `/full-test/${fullTestRunId}`, label: "Back to the Full-Test Run" }
    : { to: "/", label: "Back to Practice" };
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-measure flex-col justify-center px-gutter py-16">
      <Notice
        tone="critical"
        title="Something went wrong"
        action={
          <>
            {onRetry && (
              <Button variant="primary" size="sm" onClick={onRetry}>
                Retry
              </Button>
            )}
            <span className="inline-flex min-h-8 items-center text-ui">
              <TextLink to={back.to}>{back.label}</TextLink>
            </span>
          </>
        }
      >
        <p>{message}</p>
      </Notice>
    </main>
  );
}

/**
 * A status screen inside a running section, under ExamShell: a Module being scored, a submit that
 * failed, the Module Path, the wrap-up. A heading that says where things stand, what it means, and
 * the next step. Focus moves to the heading when it appears, since the button the User just pressed
 * has gone with the screen it was on.
 */
export function SimulationStatus({
  title,
  busy,
  children,
  actions,
}: {
  title: ReactNode;
  /** Something is still happening: a spinner beside the heading, and aria-busy on the block. */
  busy?: boolean;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <div aria-busy={busy || undefined} className="mx-auto max-w-measure py-4 sm:py-10">
      <h1 ref={headingRef} tabIndex={-1} className="flex items-center gap-2.5 rounded-chip text-heading font-semibold text-ink">
        {busy && <IconSpinner size={18} />}
        {title}
      </h1>
      {children && <div className="mt-3 space-y-4 text-body text-ink-soft text-pretty">{children}</div>}
      {actions && <div className="mt-6 flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
  );
}

/**
 * The wrap-up of any section Simulation whose end did not land (POST /:id/complete, or Speaking's
 * capture marker) once its retries ran out: what did not happen, why (requestErrorMessage), what is
 * safe and what finishing gives (`children`, in the section's own words), Retry, and the report as
 * it stands. It never says the Attempt is finished when it is not, and nothing on it advances a
 * Full-Test Run: only a Retry that lands hands the section off.
 */
export function CompletionFailed({
  title = "Couldn't finish this Attempt",
  error,
  onRetry,
  onOpenReport,
  children,
  later = "The report as it stands shows the Attempt unfinished. Finish and score, on the Progress page, finishes it later.",
}: {
  title?: string;
  error: unknown;
  onRetry: () => void;
  /** Leaves for the Attempt's report, unfinished. */
  onOpenReport: () => void;
  children: ReactNode;
  /** The closing line: what the report as it stands shows, and how the Attempt is finished later. */
  later?: ReactNode;
}) {
  return (
    <SimulationStatus
      title={title}
      actions={
        <>
          <Button variant="primary" onClick={onRetry}>
            Retry
          </Button>
          <Button variant="quiet" onClick={onOpenReport}>
            Open the report as it stands
          </Button>
        </>
      }
    >
      <Notice tone="critical">{requestErrorMessage(error)}</Notice>
      {children}
      <p>{later}</p>
    </SimulationStatus>
  );
}

/**
 * The wrap-up of a Reading or Listening Simulation, once both Modules are scored: "Wrapping up…"
 * while the Attempt is being completed (useAttemptCompletion) and handed off, and, if completing it
 * failed, CompletionFailed. The two states are different components, so the failure's heading takes
 * focus when it appears.
 */
export function CompletionWrapUp({
  completion,
  fullTestRunId,
  onOpenReport,
  notice,
}: {
  completion: AttemptCompletion;
  fullTestRunId?: string;
  /** Leaves for the Attempt's report, unfinished. */
  onOpenReport: () => void;
  /** Shown under the busy state's text, e.g. the Repeat notice. */
  notice?: ReactNode;
}) {
  if (completion.status !== "failed") {
    return (
      <SimulationStatus busy title="Wrapping up…">
        <p>{fullTestRunId ? "The Full-Test Run continues in a moment." : "Your report opens in a moment."}</p>
        {notice}
      </SimulationStatus>
    );
  }
  return (
    <CompletionFailed error={completion.error} onRetry={completion.retry} onOpenReport={onOpenReport}>
      <p>
        Both Modules are scored, and your Responses are safe. Finishing the Attempt is what gives it a Band Estimate and the key
        and Explanation for every Item{fullTestRunId ? ", and what lets the Full-Test Run go on to the next section" : ""}.
      </p>
    </CompletionFailed>
  );
}
