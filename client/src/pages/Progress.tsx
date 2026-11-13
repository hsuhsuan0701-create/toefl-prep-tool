import { useEffect, useId, useState } from "react";
import type { StatsSummaryVM } from "@toefl-prep/shared";
import { getStatsSummary } from "../lib/api";
import { requestErrorMessage } from "../lib/requestError";
import AttemptsFeed from "../components/AttemptsFeed";
import TrendsSection from "../components/TrendsSection";
import WeaknessPanel from "../components/WeaknessPanel";
import { useAttemptListArrival, useReturnPlace } from "../hooks/useAttemptListPlace";
import { ATTEMPT_PAGE_SIZE, useAttempts } from "../hooks/usePracticeData";
import { Button, ButtonLink } from "../ui/Button";
import { SectionHeader, PageHeader } from "../ui/Heading";
import { Notice } from "../ui/Notice";
import { PageShell } from "../ui/PageShell";
import { Skeleton } from "../ui/Skeleton";
import { computeSkillAccuracy } from "./weaknessCategories";

/** The Attempt list's id: "See all N Attempts" links to /progress#attempts. */
const ATTEMPT_LIST_ID = "attempts";

// Everything that answers "how am I doing": each Task Type's trend, where points go, and the whole
// Attempt log. None of it is needed to start practising, which is why it is off the Practice page.
export default function Progress() {
  const [summary, setSummary] = useState<StatsSummaryVM | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summaryRequest, setSummaryRequest] = useState(0);
  // Attempts only: this page renders no Sets, and `listSets` re-parses the whole Set bank
  // server-side on every call. The log is paged, and its total is the whole history. Coming back
  // from an Attempt review, it loads as many rows as it had and puts the opened one back in place.
  const returnPlace = useReturnPlace();
  const attemptLog = useAttempts(0, ATTEMPT_PAGE_SIZE, returnPlace?.rows);
  useAttemptListArrival(ATTEMPT_LIST_ID, attemptLog.attempts, returnPlace);
  const ids = useId();

  useEffect(() => {
    let cancelled = false;
    getStatsSummary()
      .then((loaded) => {
        if (cancelled) return;
        setSummary(loaded);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(requestErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [summaryRequest]);

  const total = attemptLog.attempts?.total;

  return (
    <PageShell>
      <PageHeader
        title="Progress"
        lede="How each Task Type's score is moving, where your points go, and every Attempt you have made. Every band here is an unofficial estimate."
      />
      <div className="space-y-12">
        <section aria-labelledby={`${ids}-trends`} className="space-y-4">
          <SectionHeader
            id={`${ids}-trends`}
            title="Trends"
            description="Your average score on each Task Type, Attempt by Attempt. Select a tile for its full chart."
          />
          <TrendsSection />
        </section>

        <section aria-labelledby={`${ids}-weakness`} className="space-y-4" aria-busy={!summary && !error ? true : undefined}>
          <SectionHeader id={`${ids}-weakness`} title="Weakness breakdown" description="What costs you points, and which skills you miss most." />
          {/* Drawn only from a summary that actually loaded: from an empty stand-in, a failed or
              pending request would read as "no Deductions yet". */}
          {summary ? (
            <WeaknessPanel
              weaknesses={summary.weaknesses}
              judgeAgreement={summary.judgeAgreement}
              skillAccuracy={computeSkillAccuracy(summary.skillItems)}
              skillItemsLimit={summary.skillItemsLimit}
            />
          ) : error ? (
            <Notice
              tone="critical"
              title="Couldn't load the weakness breakdown"
              action={
                <Button size="sm" onClick={() => setSummaryRequest((n) => n + 1)}>
                  Try again
                </Button>
              }
            >
              {error}
            </Notice>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {[0, 1].map((i) => (
                <div key={i} className="rounded-sheet border border-rule bg-sheet p-4 sm:p-5">
                  <Skeleton className="w-1/3" />
                  <Skeleton lines={4} className="mt-4" />
                </div>
              ))}
            </div>
          )}
        </section>

        <section id={ATTEMPT_LIST_ID} aria-labelledby={`${ids}-log`} className="scroll-mt-6 space-y-4">
          <SectionHeader
            id={`${ids}-log`}
            title="All Attempts"
            description={total ? `${total} in all, newest first. Open one to review it.` : undefined}
          />
          <AttemptsFeed
            attempts={attemptLog.attempts}
            error={attemptLog.error}
            onChanged={attemptLog.reload}
            onLoadMore={attemptLog.loadMore}
            loadingMore={attemptLog.loadingMore}
            emptyAction={
              <ButtonLink to="/sets" size="sm">
                Choose a Set
              </ButtonLink>
            }
          />
        </section>
      </div>
    </PageShell>
  );
}
