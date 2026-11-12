import type { ReactNode } from "react";
import { cx } from "./cx";
import { formatDay } from "./format";
import { Kicker } from "./Heading";
import { setSourceLabel } from "./labels";

export type ExamIntroFact = {
  /** A short label in the User's words: "Time", "Items", "Moving around", "Feedback", "Leaving". */
  term: string;
  /** One or two plain sentences. Times in words ("20 min"), never seconds. */
  detail: ReactNode;
};

type ExamIntroProps = {
  /** What this is, in small capitals: "Reading Simulation", "Full-Test Run · Section 1 of 4". */
  kicker?: ReactNode;
  /** The Set's title (docs/design-system.md, "Naming a Set"), or the Task Type a Drill will run. */
  title: ReactNode;
  /** One line under the title: usually an ExamSetLine. */
  meta?: ReactNode;
  /** Notices the User should read before starting: a Repeat, a Drill's no-Band-Estimate note. */
  notice?: ReactNode;
  /**
   * What is about to happen: how long, how many Items, what is and is not allowed, when feedback
   * comes. An empty list draws nothing (a caller that says it all in `children`).
   */
  facts: ExamIntroFact[];
  /** Anything secondary after the facts, typically a Disclosure. */
  children?: ReactNode;
  /** The one button that starts the Attempt, plus at most a quiet way back. */
  actions: ReactNode;
  className?: string;
};

/**
 * The screen before an Attempt starts, inside ExamShell (Drills and Simulations of every section).
 * It names the Set, then says plainly what is about to happen as a short list of facts — each a
 * term and a sentence, so the User can find "how long?" without reading a paragraph — and ends with
 * the start button. The title is the page's one serif line.
 */
export function ExamIntro({ kicker, title, meta, notice, facts, children, actions, className }: ExamIntroProps) {
  return (
    <div className={cx("mx-auto max-w-measure", className)}>
      {kicker && <Kicker as="p">{kicker}</Kicker>}
      <h1 className={cx("font-serif text-title font-semibold text-ink text-balance", kicker ? "mt-1" : null)}>{title}</h1>
      {meta && <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-graphite">{meta}</div>}
      {notice && <div className="mt-5 space-y-3">{notice}</div>}
      {facts.length > 0 && (
        <dl className="mt-6 divide-y divide-rule border-y border-rule">
          {facts.map((fact) => (
            <div key={fact.term} className="grid gap-0.5 py-3 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-4">
              <dt className="text-ui font-medium text-graphite">{fact.term}</dt>
              <dd className="text-body text-ink text-pretty">{fact.detail}</dd>
            </div>
          ))}
        </dl>
      )}
      {children && <div className="mt-4 space-y-3">{children}</div>}
      <div className="mt-8 flex flex-wrap items-center gap-3">{actions}</div>
    </div>
  );
}

/**
 * Where a Set came from, under its title: "Generated · Sep 1", then the id in small mono for bug
 * reports. The id is never the Set's name.
 */
export function ExamSetLine({ source, createdAt, setId }: { source: string; createdAt: string; setId: string }) {
  // A Set file missing either field still names itself by what it has.
  const origin = [source ? setSourceLabel(source) : null, createdAt ? formatDay(createdAt) : null].filter(Boolean).join(" · ");
  return (
    <>
      {origin && <span>{origin}</span>}
      <span className="font-mono text-caption text-faint">{setId}</span>
    </>
  );
}
