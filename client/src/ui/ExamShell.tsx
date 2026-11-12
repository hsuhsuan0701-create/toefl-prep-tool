import { useEffect, useRef, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useDeadlineCountdown } from "../hooks/useDeadlineCountdown";
import { Button, ButtonLink } from "./Button";
import { cx } from "./cx";
import { formatClock, formatDuration } from "./format";
import { IconClock } from "./icons";

type ExamShellProps = {
  /** The section being sat: "Reading". */
  section: string;
  /** Where in it: "Router Module · Read an Academic Passage". */
  part?: ReactNode;
  /** The ExamClock, centred in the header. Omit for untimed screens (a Drill's intro). */
  clock?: ReactNode;
  /** The screen's one way out, top right: an ExamExit. Required by intent: an exam screen has no
   *  navigation, so this is the only exit. `null` only where nothing may leave mid-step (a Module
   *  being scored) or the screen's own button is the way out (a Drill's results). */
  exit: ReactNode;
  /** How far through the run, drawn as a hairline under the header and stated in words. */
  progress?: { current: number; total: number; label: string };
  /** Back / Next / Submit. Sticks to the bottom of the viewport. */
  footer?: ReactNode;
  children: ReactNode;
};

/**
 * The quiet exam room: Drills, Simulations, Full-Test sections. No navigation, no decoration — a
 * header with where you are, the clock and the exit; the Stimulus and the Response; a footer with
 * the next step. Everything on these screens is ink and paper; colour appears only when the clock
 * runs low.
 */
export function ExamShell({ section, part, clock, exit, progress, footer, children }: ExamShellProps) {
  return (
    <div className="flex min-h-dvh flex-col bg-paper">
      <header className="sticky top-0 z-20 border-b border-rule bg-paper">
        {/* Below sm the label takes whatever the clock and exit leave, since equal side columns would
            hold it to the width of "Exit…"; from sm up the side columns are equal so the clock sits
            in the centre. The part line wraps rather than truncates: it is where the User is. */}
        <div className="mx-auto grid min-h-14 max-w-exam grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 px-gutter py-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <div className="min-w-0">
            <p className="text-ui font-semibold text-ink">{section}</p>
            {part && <p className="break-words text-meta text-graphite">{part}</p>}
          </div>
          <div className="justify-self-center">{clock}</div>
          <div className="flex justify-end">{exit}</div>
        </div>
        {progress && (
          <div className="mx-auto max-w-exam px-gutter pb-2">
            <div className="flex items-center gap-3">
              <div className="h-0.5 flex-1 overflow-hidden rounded-full bg-rule" aria-hidden="true">
                <div className="h-full bg-ink-soft" style={{ width: `${(Math.min(progress.current, progress.total) / Math.max(1, progress.total)) * 100}%` }} />
              </div>
              <p className="figures shrink-0 text-caption text-graphite">{progress.label}</p>
            </div>
          </div>
        )}
      </header>
      <main className="mx-auto w-full max-w-exam flex-1 px-gutter py-6 sm:py-8">{children}</main>
      {footer && (
        <footer className="sticky bottom-0 z-20 border-t border-rule bg-paper">
          <div className="mx-auto flex max-w-exam items-center justify-between gap-3 px-gutter py-3">{footer}</div>
        </footer>
      )}
    </div>
  );
}

/**
 * The one way out of an exam screen, for the `exit` slot. It only navigates: a running Drill or
 * Simulation holds the navigation with its leave guard (useLeaveGuard), and LeaveGuardHost asks the
 * one "Leave …?" question every way out shares, the browser's Back included. So `asks` changes the
 * label and nothing else: "Exit…" where the guard is up and will ask, plain "Exit" where nothing has
 * started (a picker, an intro) and leaving costs nothing.
 */
export function ExamExit({ to, asks }: { to: string; asks: boolean }) {
  const navigate = useNavigate();
  if (!asks) {
    return (
      <ButtonLink to={to} variant="quiet" size="sm">
        Exit
      </ButtonLink>
    );
  }
  return (
    <Button variant="quiet" size="sm" onClick={() => navigate(to)}>
      Exit…
    </Button>
  );
}

type ExamClockProps = {
  secondsLeft: number;
  /** From this many seconds the clock turns to caution and says so. Default 5 minutes. */
  lowAt?: number;
  /** From this many seconds it turns critical. Default 1 minute. */
  criticalAt?: number;
  /** Accessible name: "Time remaining in this Module". */
  label?: string;
};

/**
 * The proctor's clock. Tabular figures so it does not jitter; turns ochre, then red, as time runs
 * low, and says "Under 5 min" / "Under 1 min" in words beside it — colour is never the only cue.
 * role="timer" keeps screen readers from reading every tick; the two threshold crossings are
 * announced once each through a separate polite live region.
 */
export function ExamClock({ secondsLeft, lowAt = 300, criticalAt = 60, label = "Time remaining" }: ExamClockProps) {
  const phase = secondsLeft <= criticalAt ? "critical" : secondsLeft <= lowAt ? "low" : "normal";
  const cue = phase === "critical" ? `Under ${formatDuration(criticalAt)}` : phase === "low" ? `Under ${formatDuration(lowAt)}` : null;
  return (
    <div className="flex flex-col items-center sm:flex-row sm:gap-2">
      <div
        role="timer"
        aria-label={label}
        className={cx(
          "figures inline-flex items-center gap-1.5 rounded-control px-2 py-0.5 text-clock font-semibold",
          phase === "normal" && "text-ink",
          phase === "low" && "bg-caution-wash text-caution",
          phase === "critical" && "bg-critical-wash text-critical",
        )}
      >
        <IconClock size={16} />
        {formatClock(secondsLeft)}
      </div>
      {cue && <span className={cx("text-caption font-medium sm:text-meta", phase === "critical" ? "text-critical" : "text-caution")}>{cue}</span>}
      <span aria-live="polite" className="sr-only">
        {cue ? `${cue} left.` : ""}
      </span>
    </div>
  );
}

/**
 * An ExamClock counting down to a wall-clock deadline (useDeadlineCountdown), for a screen whose only
 * use of the time is to show it and act when it runs out: a Reading Module. `onExpire` fires once.
 */
export function DeadlineClock({ deadlineMs, onExpire, ...clock }: { deadlineMs: number; onExpire: () => void } & Omit<ExamClockProps, "secondsLeft">) {
  const secondsLeft = useDeadlineCountdown(deadlineMs, onExpire);
  return <ExamClock secondsLeft={secondsLeft} {...clock} />;
}

/**
 * A Stimulus's heading inside the exam shell. Takes focus when it mounts, so a keyboard or
 * screen-reader User starts each Stimulus at its top rather than wherever the last Next button was.
 * Key it by the Stimulus, so the next one mounts a fresh heading and takes focus again.
 */
export function StageHeading({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1} className="rounded-chip text-heading font-semibold text-ink">
      {children}
    </h1>
  );
}
