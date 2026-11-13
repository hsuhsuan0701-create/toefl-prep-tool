import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { AttemptDetailVM, BandShortfallVM, FullTestRunVM, FullTestSection, FullTestSectionVM } from "@toefl-prep/shared";
import { advanceFullTest, getAttempt } from "../lib/api";
import { requestErrorMessage } from "../lib/requestError";
import { NOT_RUNNABLE, isTerminalSection, useFullTestRun } from "../hooks/useFullTestRun";
import { totalSkipped } from "../lib/coverage";
import { taskTypeLabel } from "../lib/taskTypes";
import AbandonFullTestRun from "../components/AbandonFullTestRun";
import ModulePathDisclosure from "../components/ModulePathDisclosure";
import { shortfallReasons, shortfallRemedy, type ShortfallRemedy } from "../components/review/reviewText";
import { BandFigure } from "../ui/BandFigure";
import { Button, ButtonLink, TextLink } from "../ui/Button";
import { Card } from "../ui/Card";
import { StatusChip } from "../ui/Chip";
import { Disclosure, InternalName } from "../ui/Disclosure";
import { Kicker, PageHeader, SectionHeader } from "../ui/Heading";
import { IconArrowLeft } from "../ui/icons";
import { Notice } from "../ui/Notice";
import { PageShell } from "../ui/PageShell";
import { Skeleton } from "../ui/Skeleton";
import { coverageText, formatDuration, formatWhenRange, joinAnd } from "../ui/format";
import { FULL_TEST_RUN_STATUS, FULL_TEST_SECTION_STATE, SECTION_LABEL, estimateMethod } from "../ui/labels";
import { readWritingSession } from "./simulation/writingDrafts";

// The Full-Test Run page: one sitting of the whole test, its four sections in ETS order, each with
// whatever its Attempt has become. While the Run is in progress it is the between-section screen,
// and shows no navigation — a nav bar there is an invitation to leave mid-sitting; the back link is
// the one way out. Once the Run is over the page is its report, a reading page like any other.
//
// The page owns no exam mechanics. A section starts at /full-test/:runId/:section
// (FullTestSectionRun), which renders that section's standalone Simulation with the Run's Set, and
// a sitting left part-way resumes here at whichever section is still outstanding. Every band on it
// is read from the payload this page fetches: the Overall is derived server-side from the four
// section bands, and never from fewer than four.

/**
 * The expected length of the whole test, shown beside the sitting's elapsed time. Display only: the
 * sitting's length comes from each Simulation's own clocks, and nothing here times anything. It is
 * the expectation to set the sitting against, not a budget.
 */
const EXPECTED_ENVELOPE = "about 1 h 23 min – 1 h 29 min";

/**
 * Milliseconds until formatDuration's text for an elapsed `ms` next changes. Under a minute it shows
 * rounded seconds, which roll over at each half second; from a minute on, rounded minutes, which roll
 * over at each half minute.
 */
function msUntilElapsedTextChanges(ms: number): number {
  const s = Math.round(ms / 1000);
  const nextMs = s < 60 ? (s + 0.5) * 1000 : (Math.round(s / 60) * 60 + 29.5) * 1000;
  return Math.max(1, nextMs - ms);
}

/**
 * How long this sitting has been open: wall clock from the Run's creation to now, or to its
 * completion. While the Run is open it re-renders exactly when the shown text would change: every
 * second for its first minute, then once a minute. Wall clock, not time on task: a Run left
 * overnight reads as a very long sitting, which is the truth about it.
 *
 * Each tick bumps a counter and the clock is read where it is used, so every tick schedules the
 * next one even when the clock answers with the time it gave last (a browser that coarsens
 * Date.now to resist fingerprinting does); a tick stored as the clock's value would then change
 * nothing, and the count would stop. A time that does not parse counts nothing and never ticks.
 */
function useRunElapsed(createdAt: string, completedAt: string | null): string {
  const startMs = new Date(createdAt).getTime();
  const endMs = completedAt ? new Date(completedAt).getTime() : null;
  const counting = endMs === null && Number.isFinite(startMs);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!counting) return;
    const t = setTimeout(() => setTick((n) => n + 1), msUntilElapsedTextChanges(Math.max(0, Date.now() - startMs)));
    return () => clearTimeout(t);
  }, [counting, startMs, tick]);
  const elapsedMs = (endMs ?? Date.now()) - startMs;
  // formatDuration, as the Dashboard's Full-Test Run panel uses, so a sitting reads the same length
  // in both places.
  return formatDuration(Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) / 1000 : 0);
}

/** What a section still waiting on scoring is waiting for, in plain words. */
function outstandingSentence(outstanding: { taskType: string; itemCount: number }[]): string {
  if (outstanding.length === 0) return "Still scoring: the last scores are being recorded.";
  const parts = outstanding.map((o) => `${o.itemCount} ${taskTypeLabel(o.taskType)} ${o.itemCount === 1 ? "Item" : "Items"}`);
  return `Still scoring ${joinAnd(parts)}. The band appears when scoring finishes.`;
}

/**
 * Where the page stands with a no-band section's Attempt: still reading it, read (the review's
 * decision is known), or unreadable (the request failed; the page's Refresh asks again).
 */
type AttemptRead = { state: "reading" } | { state: "read"; detail: AttemptDetailVM } | { state: "unreadable"; error: string };
type AttemptReads = Readonly<Record<string, AttemptRead>>;

/**
 * A settled section short of a band, with what its own Attempt review decides can be done about it
 * (shortfallRemedy, the review's one rule). The shortfall is the review's own when its Attempt has
 * been read, so the reasons and the remedy describe the same Items. `read` is "settled" when the
 * shortfall alone decides (a Task Type or Module with no Item) and the Attempt is not needed.
 */
type NoBand = { shortfall: BandShortfallVM; remedy: ShortfallRemedy; read: "settled" | AttemptRead };

/** Whether the shortfall alone leaves a section's outlook open, so only its Attempt can decide it. */
function needsAttempt(shortfall: BandShortfallVM): boolean {
  return shortfallRemedy(shortfall, null).outlook === "unknown";
}

/**
 * For each section settled with no band that its shortfall alone does not decide, its Attempt as the
 * review loads it (GET /api/attempts/:id). Counts cannot tell a recording whose transcription can be
 * retried from one that failed for good, or from one nothing is working on, so the page asks the
 * Attempt rather than guessing. Every Run the page reads (its first load and each Refresh) reads
 * them again, and until each answers its section says it is checking and promises nothing.
 */
function useNoBandAttempts(run: FullTestRunVM): AttemptReads {
  const [reads, setReads] = useState<Record<string, AttemptRead>>({});
  useEffect(() => {
    let live = true;
    const pending = run.sections.filter(
      (section): section is FullTestSectionVM & { attemptId: string } =>
        section.bandStatus.status === "no-band" && needsAttempt(section.bandStatus) && section.attemptId !== null,
    );
    setReads(Object.fromEntries(pending.map((section) => [section.attemptId, { state: "reading" }])));
    for (const { attemptId } of pending) {
      getAttempt(attemptId).then(
        (detail) => {
          if (live) setReads((prev) => ({ ...prev, [attemptId]: { state: "read", detail } }));
        },
        (e: unknown) => {
          if (live) setReads((prev) => ({ ...prev, [attemptId]: { state: "unreadable", error: requestErrorMessage(e) } }));
        },
      );
    }
    return () => {
      live = false;
    };
  }, [run]);
  return reads;
}

/** A no-band section's shortfall and remedy, from its Attempt once that has been read. */
function noBandOf(section: FullTestSectionVM, reads: AttemptReads): NoBand | null {
  const { bandStatus } = section;
  if (bandStatus.status !== "no-band") return null;
  const undecided = { shortfall: bandStatus, remedy: shortfallRemedy(bandStatus, null) };
  if (!needsAttempt(bandStatus)) return { ...undecided, read: "settled" };
  // Before the effect has asked (the first render of a new Run), the Attempt is as good as being read.
  const read: AttemptRead = (section.attemptId ? reads[section.attemptId] : undefined) ?? { state: "reading" };
  if (read.state !== "read") return { ...undecided, read };
  const { detail } = read;
  // The review decides from its own band status; one that has moved on since the Run was read (a
  // Retry started, say) decides nothing until the next Refresh.
  if (detail.bandStatus.status === "incomplete") return { shortfall: detail.bandStatus, remedy: shortfallRemedy(detail.bandStatus, detail.items), read };
  return { ...undecided, read };
}

/**
 * What a section without a band will become, for the Overall: still scoring, able to get a band
 * from its report, never getting one (abandoned, or lost by the review's rule), not known here, or
 * not known yet because its Attempt is still being read or could not be.
 */
function sectionOutlook(section: FullTestSectionVM, reads: AttemptReads): "scoring" | "reading" | "unreadable" | ShortfallRemedy["outlook"] {
  const { bandStatus } = section;
  if (bandStatus.status === "scoring") return "scoring";
  if (bandStatus.status === "not-finished") return "lost";
  const noBand = noBandOf(section, reads);
  if (!noBand) return "lost";
  if (noBand.read !== "settled" && noBand.read.state !== "read") return noBand.read.state;
  return noBand.remedy.outlook;
}

/**
 * What the User can do about a section's unscored Items: the review's remedy, in its words, pointed
 * at that review (where the Re-score and the Retry are) rather than "below".
 */
function noBandAction(remedy: ShortfallRemedy, shortfall: BandShortfallVM): string {
  switch (remedy.outlook) {
    case "lost":
      return (shortfall.moduleShortfalls?.length ?? 0) > 0
        ? "A band needs both Modules the section was routed through."
        : "A band needs every Item of the section scored.";
    case "unknown":
      return "This section's report shows where each of them stands.";
    case "can-still-come":
      if (!remedy.retry) return `Re-score ${remedy.rescore === 1 ? "it" : "them"} from this section's report to get a band.`;
      if (remedy.rescore === 0) return "Retry the transcription from this section's report; the band follows once it is scored.";
      return "Re-score the failed Items and retry the transcription from this section's report to get a band.";
  }
}

/**
 * Why a section whose scoring has settled has no band, in the words Attempt review uses. While its
 * Attempt is being read, or when it could not be, the reasons stand and nothing is said about what
 * can be done: only the Attempt can say that.
 */
function noBandSentence({ shortfall, remedy, read }: NoBand): string {
  const reasons = shortfallReasons(shortfall);
  if (reasons.length === 0) return "No Band Estimate was recorded for this section.";
  if (read !== "settled" && read.state === "reading") return `${reasons.join(" ")} Checking this section's report for where each of them stands.`;
  if (read !== "settled" && read.state === "unreadable") {
    return `${reasons.join(" ")} This section's report could not be read, so where each of them stands is not known here. ${read.error} Refresh to try again.`;
  }
  return `${reasons.join(" ")} ${noBandAction(remedy, shortfall)}`;
}

/**
 * One section's band within the Run, read from the server's band status. A finished section with
 * no band says why — still scoring (what is outstanding), or settled without one (which Items failed,
 * are unscored or never arrived, and which Task Types have none) — and never shows a band from part
 * of the section. "No band yet" and a named action appear only where the section's Attempt review
 * offers the same; while that Attempt is being read, or if it could not be, the section says so.
 *
 * A band comes with the pencilled figure and its CEFR level, the method in words, what it was
 * computed over (skipped Items included, as a real 0), the Module Path for Reading and Listening,
 * and the internal method name behind the disclosure.
 */
function SectionBand({ section, noBand }: { section: FullTestSectionVM; noBand: NoBand | null }) {
  const { bandStatus } = section;
  if (bandStatus.status === "not-finished") return null;
  if (bandStatus.status === "scoring") {
    return (
      <div data-testid={`section-scoring-${section.section}`}>
        <BandFigure band={null} size="sm" missing={outstandingSentence(bandStatus.outstanding)} />
      </div>
    );
  }
  if (bandStatus.status === "no-band" || !section.estimate) {
    // An "estimated" section with no estimate on record is a section with every Item scored and no band.
    const shown: NoBand = noBand ?? { shortfall: { unscored: [], absent: [] }, remedy: { outlook: "lost", rescorable: false }, read: "settled" };
    return (
      <div data-testid={`section-no-band-${section.section}`} aria-busy={shown.read !== "settled" && shown.read.state === "reading"}>
        <BandFigure
          band={null}
          size="sm"
          emptyLabel={shown.remedy.outlook === "can-still-come" ? "No band yet" : "No band"}
          missing={noBandSentence(shown)}
        />
      </div>
    );
  }

  const { estimate } = section;
  const method = estimateMethod(estimate.method);
  const skipped = totalSkipped(estimate.coverage);
  return (
    <div className="grid gap-x-8 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)]" data-testid={`section-band-${section.section}`}>
      <BandFigure band={estimate.band} />
      <div className="min-w-0 space-y-1 text-meta text-ink-soft">
        <p className="text-ui text-ink">{method.label}, over:</p>
        {estimate.coverage.map((c) => (
          <p key={c.taskType}>{coverageText(c)}</p>
        ))}
        {skipped > 0 && (
          <p>
            Includes {skipped} skipped {skipped === 1 ? "Item" : "Items"} scored 0: an Item with no Response counts against the band, as it does on the test.
          </p>
        )}
        <ModulePathDisclosure modulePath={section.modulePath} />
        <Disclosure summary="How this band is estimated">
          <p className="max-w-measure">{method.detail}</p>
          <p className="mt-1">
            Method <InternalName>{estimate.method}</InternalName>
          </p>
        </Disclosure>
      </div>
    </div>
  );
}

/**
 * Whether a section left part-way can be picked up where it stopped. Only Writing keeps its work on
 * the device (in this tab's sessionStorage), and only for the Attempt the Run still records; every
 * other section left part-way starts again from its beginning, as a new Attempt.
 */
function resumableInThisTab(runId: string, section: FullTestSectionVM): boolean {
  if (section.section !== "writing" || section.state !== "in-progress" || !section.attemptId) return false;
  return readWritingSession(runId)?.attemptId === section.attemptId;
}

function SectionRow({ runId, section, noBand, sitting }: { runId: string; section: FullTestSectionVM; noBand: NoBand | null; sitting: boolean }) {
  // `launchable` is the server's own answer to "is this the section the Run is waiting on" — the ETS
  // order, decided in one place (launchableFullTestSection) and applied by both this button and
  // POST /api/attempts. Not re-derived here: a page that decided which section is next could offer
  // one the server would then refuse.
  const canStart = section.launchable;
  const leftPartWay = section.state === "in-progress";
  const resumes = resumableInThisTab(runId, section);
  const label = SECTION_LABEL[section.section];
  return (
    <Card as="li" className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Kicker as="p">Section {section.order} of 4</Kicker>
          <h3 className="text-heading font-semibold text-ink">{label}</h3>
        </div>
        <StatusChip status={FULL_TEST_SECTION_STATE[section.state]} />
      </div>

      <SectionBand section={section} noBand={noBand} />

      {!section.setId && <p className="text-ui text-ink-soft">No Set was available in the bank for this section.</p>}
      {!section.runnable && <p className="text-ui text-ink-soft">{NOT_RUNNABLE}</p>}
      {/* Why a section that is neither finished nor startable is sitting there: the exam's order.
          An abandoned Run starts nothing, so it does not say so. */}
      {sitting && section.runnable && section.state === "pending" && !section.launchable && (
        <p className="text-ui text-graphite">Starts once the earlier sections are finished.</p>
      )}
      {canStart && leftPartWay && (
        <p className="text-ui text-ink-soft">
          {resumes
            ? "You left this section part-way through. Your writing is kept in this browser tab, so it picks up where the clock allows."
            : "You left this section part-way through. Sitting it now starts it again from the beginning, as a new Attempt."}
        </p>
      )}

      {((canStart && section.setId) || (section.attemptId && section.state !== "in-progress")) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {canStart && section.setId && (
            <ButtonLink variant="primary" to={`/full-test/${runId}/${section.section}`}>
              {!leftPartWay ? `Start ${label}` : resumes ? `Resume ${label}` : `Start ${label} again`}
            </ButtonLink>
          )}
          {section.attemptId && section.state !== "in-progress" && (
            <TextLink to={`/attempts/${section.attemptId}`} className="text-ui">
              View this section's report
            </TextLink>
          )}
        </div>
      )}
      {section.setId && <p className="font-mono text-caption text-faint">{section.setId}</p>}
    </Card>
  );
}

/**
 * The Overall for a finished sitting. For the first minutes after a sitting there usually is none
 * yet: the Run completes at Speaking's capture, with Speaking's Judges (and often Writing's) still
 * running. It then says which sections it is waiting on and never averages the ones it has — a
 * three-section mean is not a rough whole-test band, it is a different number under the same label.
 */
function RunReport({ run, reads }: { run: FullTestRunVM; reads: AttemptReads }) {
  const { overall } = run;
  // Each section without a band says what it will become, by the rule its own report applies
  // (sectionOutlook). "Still scoring" is only honest when every one of them is still being scored;
  // "will not get one" only for a section nothing can score any more; "No Overall yet" only when
  // every section without a band can still get one from its report. A section whose report cannot
  // say (an Item nothing is working on, or an Attempt that could not be read) is promised nothing
  // either way, and while any section's Attempt is still being read the Overall says it is checking
  // rather than state a conclusion that answer may change.
  const outlookOf = (section: FullTestSection) => {
    const s = run.sections.find((candidate) => candidate.section === section);
    return s ? sectionOutlook(s, reads) : "lost";
  };
  const stillScoring = overall.pendingSections.every((section) => outlookOf(section) === "scoring");
  const neverBanded = overall.pendingSections.filter((section) => outlookOf(section) === "lost");
  const awaitingRescore = overall.pendingSections.filter((section) => outlookOf(section) === "can-still-come");
  const checking = overall.pendingSections.filter((section) => outlookOf(section) === "reading");
  const unreadable = overall.pendingSections.filter((section) => outlookOf(section) === "unreadable");
  const undecided = overall.pendingSections.filter((section) => ["unknown", "unreadable"].includes(outlookOf(section)));
  // Named together when any of them is undecided: the Overall can then promise none of them.
  const waitingOnReport = overall.pendingSections.filter((section) => ["unknown", "unreadable", "can-still-come"].includes(outlookOf(section)));
  const names = (sections: readonly FullTestSection[]) => joinAnd(sections.map((s) => SECTION_LABEL[s]));
  const method = estimateMethod(overall.method);

  return (
    <Card padding="lg" data-testid="full-test-report" className="space-y-4">
      <Kicker as="h2">Overall</Kicker>
      {overall.band !== null ? (
        <div className="space-y-2">
          <div data-testid="overall-band">
            <BandFigure band={overall.band} size="lg" />
          </div>
          <p className="max-w-measure text-ui text-ink-soft">{method.label} below.</p>
        </div>
      ) : (
        <div data-testid="overall-pending">
          <BandFigure
            band={null}
            size="lg"
            emptyLabel={neverBanded.length > 0 || undecided.length > 0 || checking.length > 0 ? "No band" : "No band yet"}
            missing={
              stillScoring ? (
                <>
                  {names(overall.pendingSections)} {overall.pendingSections.length === 1 ? "is" : "are"} still scoring. The Overall needs all four
                  section bands; a mean of the {overall.scoredSections} already scored would be a different number, not an early look at this one.
                  Refresh once the Judges finish.
                </>
              ) : neverBanded.length === 0 && checking.length > 0 ? (
                <>
                  Checking the {checking.length === 1 ? "report" : "reports"} of {names(checking)} for where {checking.length === 1 ? "its" : "their"}{" "}
                  unscored Items stand. The Overall needs all four section bands.
                </>
              ) : neverBanded.length === 0 && undecided.length > 0 ? (
                <>
                  No Overall: {names(waitingOnReport)} {waitingOnReport.length === 1 ? "has" : "have"} no band, and{" "}
                  {waitingOnReport.length === 1 ? "that section's report says" : "each section's report says"} where its unscored Items stand. The
                  Overall needs all four section bands.
                  {unreadable.length > 0 && (
                    <>
                      {" "}
                      The {unreadable.length === 1 ? "report" : "reports"} of {names(unreadable)} could not be read here; Refresh to try again.
                    </>
                  )}
                </>
              ) : neverBanded.length === 0 ? (
                <>
                  No Overall yet: {names(awaitingRescore)} {awaitingRescore.length === 1 ? "has" : "have"} no band until its unscored Items are
                  scored, which {awaitingRescore.length === 1 ? "that section's report" : "each section's report"} can still do. The Overall needs
                  all four section bands.
                </>
              ) : (
                <>
                  No Overall for this sitting: {names(neverBanded)} {neverBanded.length === 1 ? "has" : "have"} no band and will not get one.
                  {overall.scoredSections > 0 && (
                    <>
                      {" "}
                      The {overall.scoredSections} {overall.scoredSections === 1 ? "section with a band is" : "sections with a band are"} below, on
                      their own terms.
                    </>
                  )}
                </>
              )
            }
          />
        </div>
      )}
      <Disclosure summary="How the Overall is estimated">
        <p className="max-w-measure">
          {method.detail} Each section's band comes from its own Attempt, and the Overall appears only once all four have one.
        </p>
        <p className="mt-1">
          Method <InternalName>{overall.method}</InternalName>
        </p>
      </Disclosure>
    </Card>
  );
}

/**
 * The Overall of an abandoned Run, which it never has: an abandoned Run never gets its fourth band,
 * and the Overall is four real Band Estimates or none. The sections finished before it ended keep
 * their bands, below.
 */
function AbandonedReport({ run }: { run: FullTestRunVM }) {
  const finished = run.sections.filter((s) => s.state === "completed").length;
  return (
    <Card padding="lg" data-testid="full-test-abandoned" className="space-y-4">
      <Kicker as="h2">Overall</Kicker>
      <BandFigure
        band={null}
        size="lg"
        emptyLabel="No band"
        missing={
          <>
            This Full-Test Run was abandoned, so it has no Overall: the Overall needs all four section bands.{" "}
            {finished === 0
              ? "No section was finished before it ended."
              : `The ${finished === 1 ? "section" : `${finished} sections`} finished before it ended ${finished === 1 ? "keeps its" : "keep their"} Attempt${finished === 1 ? "" : "s"} and band${finished === 1 ? "" : "s"}, below.`}
          </>
        }
      />
    </Card>
  );
}

/**
 * The recovery half of the section handoff.
 *
 * Each section's Simulation fires POST /api/full-tests/:id/advance itself as it finishes,
 * best-effort. When that call goes missing, the Run is left pointing at a section already done:
 * every section still reads correctly (state is derived from the Attempts), but the cursor never
 * moved, and after Speaking the Run never gets its 'completed' stamp. This fires the same request.
 *
 * The server catches the cursor up to the derived position in one call, so `next` is the first
 * section still to sit anywhere in the order — not the cursor's successor, which can itself be
 * finished when a later handoff was also lost.
 *
 * With sections left to sit, moving on is the User's own step, so this is a button. With nothing
 * left it fires by itself: there is no decision to make, and a fully sat Run reading "In progress"
 * until someone finds the right button is the stuck Run this exists to close. The button stays as
 * the fallback when that automatic call fails.
 */
function HandoffRecovery({ run, onAdvanced }: { run: FullTestRunVM; onAdvanced: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoFiredRef = useRef(false);

  const currentSection = run.currentSection;
  const current = run.sections.find((s) => s.section === currentSection);
  const stale = run.status === "in-progress" && currentSection !== null && current !== undefined && isTerminalSection(current.state);
  // The client-side twin of the server's launchableFullTestSection: where an advance actually lands.
  const next = run.sections.find((s) => !isTerminalSection(s.state));
  const finishes = next === undefined;

  const advance = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await advanceFullTest(run.id);
      onAdvanced();
    } catch (e) {
      setError(requestErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [run.id, onAdvanced]);

  useEffect(() => {
    if (!stale || !finishes || autoFiredRef.current) return;
    autoFiredRef.current = true;
    void advance();
  }, [stale, finishes, advance]);

  if (!stale) return null;

  if (finishes && !error) {
    return (
      <Notice tone="info" live="polite">
        All four sections are finished; recording the end of this Full-Test Run…
      </Notice>
    );
  }

  return (
    <Notice
      tone="info"
      title={`The ${SECTION_LABEL[currentSection]} section ${current?.state === "aborted" ? "was abandoned" : "is finished"}, but this Full-Test Run never recorded the handoff.`}
      action={
        <Button variant="primary" onClick={() => void advance()} loading={busy}>
          {next ? `Continue to ${SECTION_LABEL[next.section]}` : "Finish the Full-Test Run"}
        </Button>
      }
    >
      {error && <p className="font-medium text-critical">{error}</p>}
    </Notice>
  );
}

function BackLink() {
  return (
    <TextLink to="/" className="inline-flex items-center gap-1">
      <IconArrowLeft size={14} />
      Practice
    </TextLink>
  );
}

function RunPage({ run, reload }: { run: FullTestRunVM; reload: () => void }) {
  const abandoned = run.status === "abandoned";
  // An abandoned Run has no end time to count to, and is not still open: it shows no elapsed time.
  const elapsed = useRunElapsed(run.createdAt, abandoned ? run.createdAt : run.completedAt);
  const reads = useNoBandAttempts(run);
  const sitting = run.status === "in-progress";
  return (
    <PageShell nav={!sitting}>
      <PageHeader
        kicker={<BackLink />}
        title="Full-Test Run"
        lede={sitting ? undefined : "Every band here is an unofficial estimate from this app, not an ETS score."}
        meta={
          <>
            <span>{formatWhenRange(run.createdAt, run.completedAt)}</span>
            <StatusChip status={FULL_TEST_RUN_STATUS[run.status]} />
            {!abandoned && (
              <span>
                {run.completedAt ? "Took" : "Elapsed"} {elapsed} · the whole test runs {EXPECTED_ENVELOPE}
              </span>
            )}
          </>
        }
      />

      <div className="space-y-12">
        <div className="space-y-4">
          {/* A finished sitting leads with its Overall, an abandoned one with why it has none; a
              sitting in progress gets its rules, and the way to give it up. */}
          {run.status === "completed" ? (
            <RunReport run={run} reads={reads} />
          ) : abandoned ? (
            <AbandonedReport run={run} />
          ) : (
            <Notice tone="info" action={<AbandonFullTestRun run={run} size="sm" onAbandoned={reload} />}>
              The four sections run in the order ETS gives them, one at a time: each unlocks when the one before it is finished, and a
              finished section cannot be sat again. If you leave part-way, the Run waits at the section you were on — but a Reading,
              Listening or Speaking section left part-way starts again from its beginning, and Writing picks up only in the same browser
              tab. Each section's band is an unofficial estimate from that section's own Attempt, and the whole-test band appears here once
              all four sections have one.
            </Notice>
          )}
          <HandoffRecovery run={run} onAdvanced={reload} />
        </div>

        <section aria-labelledby="run-sections" className="space-y-4">
          <SectionHeader
            id="run-sections"
            title="Sections, in test order"
            action={
              <Button variant="quiet" size="sm" onClick={reload}>
                Refresh
              </Button>
            }
          />
          <ol aria-labelledby="run-sections" className="grid gap-4 lg:grid-cols-2">
            {run.sections.map((section) => (
              <SectionRow key={section.section} runId={run.id} section={section} noBand={noBandOf(section, reads)} sitting={sitting} />
            ))}
          </ol>
        </section>
      </div>
    </PageShell>
  );
}

export default function FullTestRun() {
  const { runId } = useParams<{ runId: string }>();
  const { run, error, loading, reload } = useFullTestRun(runId);
  const refresh = useCallback(() => void reload(), [reload]);

  // A reload keeps the page on screen; only the first load shows the placeholder.
  if (loading && !run) {
    return (
      <PageShell nav={false}>
        <div aria-busy="true" aria-label="Loading the Full-Test Run" className="space-y-6">
          <Skeleton className="h-9 w-56" shape="block" />
          <Skeleton className="h-40 w-full" shape="block" />
        </div>
      </PageShell>
    );
  }

  if (error || !run) {
    return (
      <PageShell>
        <PageHeader kicker={<BackLink />} title="Full-Test Run" />
        <Notice
          tone="critical"
          title="This Full-Test Run could not be loaded."
          action={
            <Button size="sm" onClick={refresh}>
              Try again
            </Button>
          }
        >
          {error ?? "Full-Test Run not found."}
        </Notice>
      </PageShell>
    );
  }

  return <RunPage run={run} reload={refresh} />;
}
