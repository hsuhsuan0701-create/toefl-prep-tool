import { useEffect, useRef, useState, type ReactNode } from "react";
import { requestErrorMessage } from "../../lib/requestError";
import { Button, TextLink } from "../../ui/Button";
import { ExamIntro, type ExamIntroFact } from "../../ui/ExamIntro";
import { ExamExit, ExamShell } from "../../ui/ExamShell";
import { Kicker } from "../../ui/Heading";
import { IconArrowLeft, IconArrowRight, IconChevronRight, IconCritical } from "../../ui/icons";
import { Notice } from "../../ui/Notice";
import { Skeleton } from "../../ui/Skeleton";
import type { DrillCompletion } from "./drillShell";

// The Drill shell's chrome: the screens every Drill draws around its own run body — the loading
// state, the fatal error surface, the Task Type picker, the intro that commits the User to a run,
// and the line a results screen shows when finishing failed. Components only, so react/only-export-components stays quiet; the shell's behavioural half
// lives next door in drillShell.ts, split the same way as SimulationScreens.tsx and
// simulationShell.ts.
//
// Everything that varies between the four Drills here is data: the section, the Set's title, a line
// of copy, the option list, the facts. The headings and the start button are built from the section
// ("Reading Drill", "Start Reading Drill"), so no Drill can name them differently. There is no mode
// parameter, because there is no behaviour to switch on: these screens render what they are given
// and call back.
//
// The picker and the intro are exam screens (ExamShell): no app navigation, one quiet Exit back to
// Practice. Loading and error stand on their own, without a header, because they are the same in all
// four Drills.

/** The full-screen loading state. Identical in all four Drills, so it takes no props. */
export function DrillLoadingScreen() {
  return (
    <main aria-busy="true" className="mx-auto flex min-h-dvh w-full max-w-measure flex-col justify-center gap-4 px-gutter py-16">
      <p className="text-ui text-graphite">Loading the Set…</p>
      <Skeleton lines={3} />
    </main>
  );
}

/** A retry affordance on the error screen: what to call, and what to call the button. */
export type DrillRetry = { label: string; onRetry: () => void };

export type DrillErrorScreenProps = {
  /** `null` falls back to a generic sentence. */
  message: string | null;
  /**
   * A `DrillRetry` draws its button ahead of the way back to Practice. Omitted or `null` draws only
   * the way back. Writing is the one Drill that passes a retry, and only while a failed Build a
   * Sentence score request is waiting to be sent again.
   */
  retry?: DrillRetry | null;
};

/** The full-screen fatal error state: what went wrong, then the way out. */
export function DrillErrorScreen({ message, retry }: DrillErrorScreenProps) {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-measure flex-col justify-center px-gutter py-16">
      <Notice
        tone="critical"
        title="Something went wrong"
        action={
          <>
            {retry && (
              <Button variant="primary" size="sm" onClick={retry.onRetry}>
                {retry.label}
              </Button>
            )}
            <span className="inline-flex min-h-8 items-center text-ui">
              <TextLink to="/">Back to Practice</TextLink>
            </span>
          </>
        }
      >
        <p>{message ?? "The Drill stopped before it could continue."}</p>
      </Notice>
    </main>
  );
}

/**
 * The one line a Drill's results screen shows, beside its finish button, when finishing could not
 * mark the Attempt finished (drillShell.ts's `finish`): what did not happen and why, with Retry
 * beside it. Nothing until then. The finish button still leaves.
 */
export function DrillCompletionFailed({ completion }: { completion: DrillCompletion }) {
  if (completion.status !== "failed") return null;
  return (
    <div role="status" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-ui text-ink">
      <span className="inline-flex min-w-0 items-start gap-1.5">
        <span className="mt-[0.1875rem] shrink-0 text-critical">
          <IconCritical size={14} />
        </span>
        <span className="text-pretty">This Attempt couldn't be marked finished. {requestErrorMessage(completion.error)}</span>
      </span>
      <Button size="sm" onClick={completion.retry}>
        Retry
      </Button>
    </div>
  );
}

/** One card on the picker: what it is called, what it costs, and what picking it does. */
export type DrillPickerOption = {
  label: string;
  /** The small print under the label — a Stimulus count, a time budget, or the queue's own order. */
  detail: string;
  onPick: () => void;
};

/**
 * The Task Type picker: the first screen of every Drill, and the last one before an Attempt exists.
 * Named the way every exam intro is (ExamIntro): "{Section} Drill" over the Set's title, the Set's
 * origin under it.
 *
 * `notice` is a slot rather than a flag: Reading and Listening put `DrillBandEstimateNotice` here
 * (a Drill never produces a Band Estimate for those sections — CONTEXT.md's Simulation entry), and
 * the other two put nothing.
 */
export function DrillPickerScreen({
  section,
  setTitle,
  meta,
  subtitle,
  notice,
  options,
}: {
  /** "Reading": the header, and the kicker's "Reading Drill". */
  section: string;
  /** The Set's title (docs/design-system.md, "Naming a Set"): the page's heading. */
  setTitle: string;
  /** A line under the heading saying where the Set came from (ExamSetLine). */
  meta?: ReactNode;
  /** The line under the heading: what to do here, in each Drill's own words. */
  subtitle: string;
  notice?: ReactNode;
  options: readonly DrillPickerOption[];
}) {
  return (
    <ExamShell section={section} part="Drill" exit={<ExamExit to="/" asks={false} />}>
      <div className="mx-auto max-w-measure">
        <Kicker as="p">{section} Drill</Kicker>
        <h1 className="mt-1 font-serif text-title font-semibold text-ink text-balance">{setTitle}</h1>
        {meta && <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-graphite">{meta}</div>}
        <p className="mt-3 text-body text-ink-soft text-pretty">{subtitle}</p>
        {notice && <div className="mt-5">{notice}</div>}
        <ul className="mt-6 grid gap-3 sm:grid-cols-2">
          {options.map((opt) => (
            <li key={opt.label} className="min-w-0">
              <button
                type="button"
                onClick={opt.onPick}
                className="group flex h-full min-h-16 w-full items-center gap-3 rounded-sheet border border-rule-strong bg-field px-4 py-3 text-left transition-colors duration-(--duration-quick) hover:border-graphite hover:bg-sheet"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-body font-medium text-ink">{opt.label}</span>{" "}
                  <span className="mt-0.5 block text-meta text-graphite text-pretty">{opt.detail}</span>
                </span>
                <span className="text-graphite group-hover:text-ink">
                  <IconChevronRight size={16} />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </ExamShell>
  );
}

/**
 * The intro: what the picked Task Types will ask of the User, and the button that creates the
 * Attempt, as ExamIntro draws every exam intro. Reading, Listening and Writing draw this before the
 * run; Speaking draws it after its mic check, where it is the last screen before recording starts.
 * The kicker is "{Section} Drill", the heading what is about to run (one Task Type, or several, such
 * as "All three Task Types"), and the button "Start {Section} Drill".
 *
 * The button is single-flight: while `onStart`'s promise is pending it is busy and a second click
 * does nothing, so a double click cannot create two Attempts.
 */
export function DrillIntroScreen({
  section,
  heading,
  meta,
  backLabel,
  onBack,
  onStart,
  facts,
  notice,
  children,
  part = "Drill",
}: {
  /** "Reading": the header, the kicker's "Reading Drill" and the button's "Start Reading Drill". */
  section: string;
  /** What is about to run: the picked Task Type, or a name for several ("Both Task Types"). */
  heading: string;
  /** A line under the heading: the Set's title. */
  meta?: ReactNode;
  backLabel: string;
  onBack: () => void;
  onStart: () => Promise<void>;
  /** How long, how many Items, when feedback comes. See ExamIntro. */
  facts: ExamIntroFact[];
  notice?: ReactNode;
  children?: ReactNode;
  /** The header's second line. "Drill" unless the screen is a step of it ("Drill · Ready"). */
  part?: string;
}) {
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const start = async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
      await onStart();
    } finally {
      startingRef.current = false;
      if (mountedRef.current) setStarting(false);
    }
  };

  return (
    <ExamShell section={section} part={part} exit={<ExamExit to="/" asks={false} />}>
      <div className="mx-auto max-w-measure">
        <Button variant="quiet" size="sm" icon={<IconArrowLeft size={14} />} onClick={onBack} disabled={starting} className="-ml-3 mb-3">
          {backLabel}
        </Button>
      </div>
      <ExamIntro
        kicker={`${section} Drill`}
        title={heading}
        meta={meta}
        notice={notice}
        facts={facts}
        actions={
          <Button variant="primary" iconEnd={<IconArrowRight size={16} />} onClick={() => void start()} loading={starting}>
            Start {section} Drill
          </Button>
        }
      >
        {children}
      </ExamIntro>
    </ExamShell>
  );
}
