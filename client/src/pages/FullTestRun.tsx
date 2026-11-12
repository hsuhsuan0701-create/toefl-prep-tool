import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import type { BandShortfallVM, FullTestRunVM, FullTestSection, FullTestSectionVM } from "@toefl-prep/shared";
import { advanceFullTest } from "../lib/api";
import { requestErrorMessage } from "../lib/requestError";
import { NOT_RUNNABLE, isTerminalSection, useFullTestRun } from "../hooks/useFullTestRun";
import { totalSkipped } from "../lib/coverage";
import { taskTypeLabel } from "../lib/taskTypes";
import ModulePathDisclosure from "../components/ModulePathDisclosure";
import { shortfallReasons } from "../components/review/reviewText";
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
import { coverageText, formatWhenRange, joinAnd } from "../ui/format";
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

function formatElapsed(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

/**
 * How long this sitting has been open: wall clock from the Run's creation to now, or to its
 * completion. Ticks every 30 s, since the display is in whole minutes. Wall clock, not time on
 * task: a Run left overnight reads as a very long sitting, which is the truth about it.
 */
function useRunElapsed(createdAt: string, completedAt: string | null): string {
  const endMs = completedAt ? new Date(completedAt).getTime() : null;
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (endMs !== null) return;
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [endMs]);
  return formatElapsed((endMs ?? nowMs) - new Date(createdAt).getTime());
}

/** What a section still waiting on scoring is waiting for, in plain words. */
function outstandingSentence(outstanding: { taskType: string; itemCount: number }[]): string {
  if (outstanding.length === 0) return "Still scoring: the last scores are being recorded.";
  const parts = outstanding.map((o) => `${o.itemCount} ${taskTypeLabel(o.taskType)} ${o.itemCount === 1 ? "Item" : "Items"}`);
  return `Still scoring ${joinAnd(parts)}. The band appears when scoring finishes.`;
}

/** Why a section whose scoring has settled has no band, in the words Attempt review uses. */
function noBandSentence(shortfall: BandShortfallVM): string {
  const reasons = shortfallReasons(shortfall);
  if (reasons.length === 0) return "No Band Estimate was recorded for this section.";
  const rule = (shortfall.moduleShortfalls?.length ?? 0) > 0
    ? "A band needs both Modules the section was routed through."
    : "A band needs every Item of the section scored.";
  return `${reasons.join(" ")} ${rule}`;
}

/**
 * One section's band within the Run, read from the server's band status. A finished section with
 * no band says why — still scoring (what is outstanding), or settled without one (which Items failed,
 * are unscored or never arrived, and which Task Types have none) — and never shows a band from part
 * of the section.
 *
 * A band comes with the pencilled figure and its CEFR level, the method in words, what it was
 * computed over (skipped Items included, as a real 0), the Module Path for Reading and Listening,
 * and the internal method name behind the disclosure.
 */
function SectionBand({ section }: { section: FullTestSectionVM }) {
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
    return (
      <div data-testid={`section-no-band-${section.section}`}>
        <BandFigure band={null} size="sm" missing={noBandSentence(bandStatus.status === "no-band" ? bandStatus : { unscored: [], absent: [] })} />
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

function SectionRow({ runId, section }: { runId: string; section: FullTestSectionVM }) {
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

      <SectionBand section={section} />

      {!section.setId && <p className="text-ui text-ink-soft">No Set was available in the bank for this section.</p>}
      {!section.runnable && <p className="text-ui text-ink-soft">{NOT_RUNNABLE}</p>}
      {/* Why a section that is neither finished nor startable is sitting there: the exam's order. */}
      {section.runnable && section.state === "pending" && !section.launchable && (
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
function RunReport({ run }: { run: FullTestRunVM }) {
  const { overall } = run;
  // "Still scoring" is only honest when every section without a band is one the server says is still
  // being scored; an abandoned section, or one that settled short of a Task Type, has none coming.
  const bandStatusOf = (section: FullTestSection) => run.sections.find((s) => s.section === section)?.bandStatus.status;
  const stillScoring = overall.pendingSections.every((section) => bandStatusOf(section) === "scoring");
  const neverBanded = overall.pendingSections.filter((section) => bandStatusOf(section) !== "scoring");
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
            missing={
              stillScoring ? (
                <>
                  {names(overall.pendingSections)} {overall.pendingSections.length === 1 ? "is" : "are"} still scoring. The Overall needs all four
                  section bands; a mean of the {overall.scoredSections} already scored would be a different number, not an early look at this one.
                  Refresh once the Judges finish.
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
      title={`The ${SECTION_LABEL[currentSection]} section is finished, but this Full-Test Run never recorded the handoff.`}
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
  const elapsed = useRunElapsed(run.createdAt, run.completedAt);
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
            <span>
              {run.completedAt ? "Took" : "Elapsed"} {elapsed} · the whole test runs {EXPECTED_ENVELOPE}
            </span>
          </>
        }
      />

      <div className="space-y-12">
        <div className="space-y-4">
          {/* A finished sitting leads with its Overall; a sitting in progress gets its rules instead. */}
          {run.status === "completed" ? (
            <RunReport run={run} />
          ) : (
            <Notice tone="info">
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
              <SectionRow key={section.section} runId={run.id} section={section} />
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
