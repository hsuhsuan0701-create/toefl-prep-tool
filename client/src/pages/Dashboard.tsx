import { useCallback, useEffect, useRef, useState } from "react";
import type { Section, StatsSettingsVM, StatsSummaryVM } from "@toefl-prep/shared";
import AttemptsFeed from "../components/AttemptsFeed";
import BandCard from "../components/BandCard";
import FullTestPanel from "../components/FullTestPanel";
import SetGeneration from "../components/generation/SetGeneration";
import SetSection from "../components/SetSection";
import { ProviderNotice } from "../components/setup/ProviderNotice";
import { SetupSection } from "../components/setup/SetupSection";
import { useSetupStatus } from "../components/setup/useSetupStatus";
import { SECTION_ROUTES, usePracticeData } from "../hooks/usePracticeData";
import { useProviderStatus } from "../hooks/useProviderStatus";
import { getStatsSettings, getStatsSummary, putStatsSettings } from "../lib/api";
import { requestErrorMessage } from "../lib/requestError";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Disclosure, InternalName } from "../ui/Disclosure";
import { EmptyState } from "../ui/EmptyState";
import { PageHeader, SectionHeader } from "../ui/Heading";
import { ESTIMATE_METHOD, SECTION_LABEL } from "../ui/labels";
import { Notice } from "../ui/Notice";
import { PageShell } from "../ui/PageShell";
import { Skeleton } from "../ui/Skeleton";
import { OverallCard } from "./dashboard/OverallCard";
import { missingBandText } from "./dashboard/sectionCopy";
import { StartHere } from "./dashboard/StartHere";
import { SuggestedNext } from "./dashboard/SuggestedNext";
import { sectionScorability, suggestNext, TEST_ORDER, type Scorability } from "./dashboard/suggestNext";

// How much of each list the home page carries before handing off to /sets and /progress.
const HOME_SETS_PER_SECTION = 3;
const HOME_ATTEMPTS = 5;

const LEDE = "Every band here is an unofficial estimate from your own Attempts — a direction to practise in, not an ETS score.";
const FIRST_RUN_LEDE =
  "Reading and Listening work right now, with no keys or sign-in. Every band this page shows will be an unofficial estimate from your own Attempts, not an ETS score.";

/**
 * The practice page. A first run (no Attempts yet) leads with "Start here" and the Setup checklist;
 * after that it leads with the Overall band and the one suggested next step, and the checklist stays
 * at the bottom, collapsed. Below either: the four sections' bands against their Targets, the next
 * unattempted Sets, Full-Test Runs and recent Attempts.
 */
export default function Dashboard() {
  const [summary, setSummary] = useState<StatsSummaryVM | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [settings, setSettings] = useState<StatsSettingsVM | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [setsRefreshKey, setSetsRefreshKey] = useState(0);
  const [generateOpen, setGenerateOpen] = useState(false);
  const [setupOpen, setSetupOpen] = useState(false);
  const providerStatus = useProviderStatus();
  const practice = usePracticeData(setsRefreshKey);
  const setup = useSetupStatus();

  // A saved Target, a finished or discarded Attempt and the first load each re-read the summary, and
  // they can overlap: only the latest request's answer applies.
  const summaryRequest = useRef(0);
  const loadSummary = useCallback(() => {
    const request = ++summaryRequest.current;
    return getStatsSummary()
      .then((next) => {
        if (request !== summaryRequest.current) return;
        setSummary(next);
        setSummaryError(null);
      })
      .catch((e) => {
        if (request === summaryRequest.current) setSummaryError(requestErrorMessage(e));
      });
  }, []);

  const loadSettings = useCallback(
    () =>
      getStatsSettings()
        .then((next) => {
          setSettings(next);
          setSettingsError(null);
        })
        .catch((e) => setSettingsError(requestErrorMessage(e))),
    [],
  );

  useEffect(() => {
    void loadSummary();
    void loadSettings();
  }, [loadSummary, loadSettings]);

  // A Try again clears the failure first, so its slot reads as loading again until the answer lands.
  const retrySummary = () => {
    setSummaryError(null);
    void loadSummary();
  };
  const retrySettings = () => {
    setSettingsError(null);
    void loadSettings();
  };

  const onGenerated = useCallback(() => setSetsRefreshKey((k) => k + 1), []);

  // Finishing or discarding an Attempt can change a section's band, and with it the Overall and the
  // suggested next step: the summary is read again with the log, so the cards agree with the row.
  const reloadPractice = practice.reload;
  const onAttemptChanged = useCallback(() => {
    reloadPractice();
    void loadSummary();
  }, [reloadPractice, loadSummary]);

  async function saveTarget(section: Section, target: number) {
    try {
      setSettings(await putStatsSettings({ targets: { [section]: target } }));
    } catch (e) {
      throw new Error(requestErrorMessage(e));
    }
    await loadSummary();
  }

  function showSetup() {
    setSetupOpen(true);
    const target = document.getElementById("setup");
    target?.scrollIntoView?.({ behavior: "smooth", block: "start" });
    target?.focus({ preventScroll: true });
  }

  const estimates = new Map((summary?.sections ?? []).map((s) => [s.section, s]));
  const scorability = Object.fromEntries(TEST_ORDER.map((s) => [s, sectionScorability(s, setup.status)])) as Record<Section, Scorability>;
  const firstRun = practice.attempts !== null && practice.attempts.total === 0;
  const attemptsKnown = practice.attempts !== null || practice.errors.attempts !== undefined;
  const suggestion =
    summary && settings && setup.settled
      ? suggestNext({ bands: Object.fromEntries([...estimates].map(([s, e]) => [s, e.band])), targets: settings.targets, scorability })
      : null;
  // Suggested next needs both the bands and the Targets: either request failing leaves it nothing to
  // work from, and its Try again re-fetches whichever is missing.
  const suggestionError = (!summary && summaryError) || (!settings && settingsError) || null;
  const retrySuggestion = () => {
    if (!summary) retrySummary();
    if (!settings) retrySettings();
  };
  const overallLoading = !summary && !summaryError;
  const suggestionLoading = !suggestion && !suggestionError;

  return (
    <PageShell>
      <PageHeader title="Practice" lede={firstRun ? FIRST_RUN_LEDE : LEDE} actions={<Button onClick={() => setGenerateOpen(true)}>Generate Sets</Button>} />

      <div className="space-y-12">
        {providerStatus && <ProviderNotice providers={providerStatus.providers} />}

        <SetGeneration dialogOpen={generateOpen} onDialogClose={() => setGenerateOpen(false)} onGenerated={onGenerated} setup={setup.status} />

        {!attemptsKnown ? (
          <Skeleton shape="block" className="h-48 w-full" />
        ) : firstRun ? (
          <>
            <StartHere writing={scorability.writing} speaking={scorability.speaking} onShowSetup={showSetup} />
            <SetupSection setup={setup} mode="expanded" />
          </>
        ) : (
          <Card
            padding="lg"
            aria-busy={overallLoading || suggestionLoading || undefined}
            className="grid gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] md:items-center"
          >
            {summary ? (
              <OverallCard overall={summary.overall} />
            ) : summaryError ? (
              <SlotFailure title="Couldn't load your Overall band" message={summaryError} onRetry={retrySummary} />
            ) : (
              <Skeleton shape="block" className="h-24 w-48" />
            )}
            <div className="border-t border-rule pt-5 md:border-t-0 md:border-l md:pt-0 md:pl-6">
              {suggestion ? (
                <SuggestedNext suggestion={suggestion} onShowSetup={showSetup} />
              ) : suggestionError ? (
                <SlotFailure title="Couldn't work out what to practise next" message={suggestionError} onRetry={retrySuggestion} />
              ) : (
                <Skeleton lines={3} />
              )}
            </div>
          </Card>
        )}

        <section aria-labelledby="bands-heading" className="space-y-4">
          <SectionHeader
            id="bands-heading"
            title="Sections"
            description={
              firstRun
                ? "Each section gets a band once its Simulation is scored. The Overall band appears when all four have one."
                : "In test order, each against the Target you set."
            }
          />
          {(summaryError || settingsError) && (
            <Notice tone="critical">
              {summaryError ? `Couldn't load your bands. ${summaryError}` : `Couldn't load your Targets. ${settingsError}`}
            </Notice>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            {TEST_ORDER.map((section) => (
              <BandCard
                key={section}
                section={section}
                estimate={estimates.get(section)}
                loading={!summary && !summaryError}
                target={settings?.targets[section]}
                onTargetChange={(target) => saveTarget(section, target)}
                missing={missingBandText(section, scorability[section])}
              />
            ))}
          </div>
          <HowBandsAreEstimated />
        </section>

        <section aria-labelledby="next-heading" className="space-y-4">
          <SectionHeader id="next-heading" title="Next up" description="Sets you have not attempted yet, a few per section." />
          <div className="grid gap-x-6 gap-y-8 lg:grid-cols-2">
            {TEST_ORDER.map((section) => (
              <SetSection
                key={section}
                title={`${SECTION_LABEL[section]} Sets`}
                linkBase={SECTION_ROUTES[section].linkBase}
                simulateHref={SECTION_ROUTES[section].simulateHref}
                sets={practice.sets[section]}
                error={practice.errors[section]}
                limit={HOME_SETS_PER_SECTION}
                seeAllHref={`/sets?section=${section}`}
              />
            ))}
          </div>
        </section>

        <FullTestPanel />

        <section aria-labelledby="recent-heading" className="space-y-4">
          <SectionHeader id="recent-heading" title="Recent Attempts" />
          {firstRun ? (
            <EmptyState title="No Attempts yet">Your Attempts appear here as soon as you start one — finished or not.</EmptyState>
          ) : (
            <AttemptsFeed
              attempts={practice.attempts}
              error={practice.errors.attempts}
              onChanged={onAttemptChanged}
              limit={HOME_ATTEMPTS}
              seeAllHref="/progress"
            />
          )}
        </section>

        {attemptsKnown && !firstRun && <SetupSection setup={setup} mode="collapsed" open={setupOpen} onOpenChange={setSetupOpen} />}
      </div>
    </PageShell>
  );
}

/** A slot of the featured card whose request failed: what did not load, why, and a way to ask again. */
function SlotFailure({ title, message, onRetry }: { title: string; message: string; onRetry: () => void }) {
  return (
    <Notice
      tone="critical"
      title={title}
      action={
        <Button size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {message}
    </Notice>
  );
}

/** The estimate methods in plain words, each with its internal name as a secondary detail. */
function HowBandsAreEstimated() {
  const methods: [string, string][] = [
    ["Reading and Listening", "table3-v1"],
    ["Writing and Speaking", "linear-v2"],
    ["Overall", "mean-of-sections-v1"],
  ];
  return (
    <Disclosure summary="How these bands are estimated">
      <div className="max-w-measure space-y-2">
        <p>
          A section's band comes from its latest Simulation, or from its latest Drill while it has no Simulation. Every Item of that
          Attempt has to be scored, across every Task Type of the section (a skipped Item counts as 0), and a Repeat of a Set you had
          already attempted doesn't count. Reading and Listening Drills never give a band.
        </p>
        {methods.map(([who, method]) => (
          <p key={method}>
            <span className="font-medium text-ink">{who}:</span> {ESTIMATE_METHOD[method].label}. {ESTIMATE_METHOD[method].detail}{" "}
            <InternalName>{method}</InternalName>
          </p>
        ))}
      </div>
    </Disclosure>
  );
}
