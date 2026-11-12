import { useCallback, useEffect, useRef, useState } from "react";
import type { FullTestRunVM } from "@toefl-prep/shared";
import { useStartFullTest } from "../hooks/useStartFullTest";
import { listFullTests } from "../lib/api";
import { requestErrorMessage } from "../lib/requestError";
import { BandFigure } from "../ui/BandFigure";
import { Button, ButtonLink, TextLink } from "../ui/Button";
import { StatusChip } from "../ui/Chip";
import { formatDuration, formatWhen } from "../ui/format";
import { SectionHeader } from "../ui/Heading";
import { FULL_TEST_RUN_STATUS, MODULE_PATH_LABEL, SECTION_LABEL } from "../ui/labels";
import { List } from "../ui/ListRow";
import { Notice } from "../ui/Notice";

// The practice page's one entry to a Full-Test Run: start a new sitting, return to one under way, or
// open a finished one's report.
//
// Returning matters. A Run lives at /full-test/:runId, its page shows no nav bar while the Run is
// being sat, and no other page lists Runs, so once a User goes home this panel is the only way back
// to a half-sat Run and to every finished Run's report (its page is the report).
//
// Failures stay inside this panel: a failed listing must never blank the practice lists around it.

// How many finished Runs show before "Show earlier finished Runs".
const HOME_FINISHED_RUNS = 3;

export default function FullTestPanel() {
  const [inProgress, setInProgress] = useState<FullTestRunVM[]>([]);
  // The most recent finished Runs, one more than are shown so the panel knows whether there are
  // earlier ones; every finished Run once the User asks for them.
  const [finished, setFinished] = useState<FullTestRunVM[]>([]);
  const [showAllFinished, setShowAllFinished] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const startRun = useStartFullTest();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Runs in progress and finished Runs are fetched apart, so neither can push the other off the
  // panel: every Run in progress, however old or many (Start creates one at once, so a few
  // mis-clicks make several), and then the most recent finished Runs for their reports.
  const reload = useCallback(async () => {
    try {
      const [unfinished, recentFinished] = await Promise.all([
        listFullTests({ status: "in-progress" }),
        listFullTests({ status: "completed", limit: HOME_FINISHED_RUNS + 1 }),
      ]);
      if (!mountedRef.current) return;
      setInProgress(unfinished);
      setFinished(recentFinished);
    } catch (e) {
      if (mountedRef.current) setError(requestErrorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Filtered by status and given no limit, the listing returns every finished Run.
  const showEarlierFinished = async () => {
    setLoadingEarlier(true);
    try {
      const all = await listFullTests({ status: "completed" });
      if (!mountedRef.current) return;
      setFinished(all);
      setShowAllFinished(true);
    } catch (e) {
      if (mountedRef.current) setError(requestErrorMessage(e));
    } finally {
      if (mountedRef.current) setLoadingEarlier(false);
    }
  };

  const shownFinished = showAllFinished ? finished : finished.slice(0, HOME_FINISHED_RUNS);
  const hasEarlierFinished = !showAllFinished && finished.length > HOME_FINISHED_RUNS;
  const failure = startRun.error ?? error;

  return (
    <section aria-labelledby="full-test-heading" className="space-y-4">
      <SectionHeader
        id="full-test-heading"
        title="Full-Test Run"
        description="All four sections in test order, one Set each — about an hour and a half. Leaving mid-sitting is safe: you resume at the section you were on."
        action={
          <Button size="sm" loading={startRun.starting} onClick={startRun.start}>
            Start a Full-Test Run
          </Button>
        }
      />
      {failure && (
        <Notice tone="critical" live="polite">
          {startRun.error ? `Couldn't start a Full-Test Run. ${startRun.error}` : `Couldn't load your Full-Test Runs. ${error}`}
        </Notice>
      )}
      {inProgress.length > 0 && (
        <List label="Full-Test Runs in progress">
          {inProgress.map((run) => (
            <InProgressRun key={run.id} run={run} />
          ))}
        </List>
      )}
      {shownFinished.length > 0 && (
        <List label="Finished Full-Test Runs">
          {shownFinished.map((run) => (
            <FinishedRun key={run.id} run={run} />
          ))}
        </List>
      )}
      {hasEarlierFinished && (
        <Button size="sm" variant="quiet" loading={loadingEarlier} onClick={() => void showEarlierFinished()}>
          Show earlier finished Runs
        </Button>
      )}
    </section>
  );
}

function InProgressRun({ run }: { run: FullTestRunVM }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 text-body font-medium text-ink">
          Full-Test Run
          <StatusChip status={FULL_TEST_RUN_STATUS["in-progress"]} />
        </p>
        <p className="mt-0.5 text-meta text-graphite">
          Started {formatWhen(run.createdAt)}
          {run.currentSection ? ` · at the ${SECTION_LABEL[run.currentSection]} section` : ""}
        </p>
      </div>
      <ButtonLink to={`/full-test/${run.id}`} size="sm">
        Resume
      </ButtonLink>
    </li>
  );
}

function FinishedRun({ run }: { run: FullTestRunVM }) {
  const finishedAt = run.completedAt ?? run.createdAt;
  const seconds = (Date.parse(finishedAt) - Date.parse(run.createdAt)) / 1000;
  const routed = run.sections.filter((s): s is typeof s & { modulePath: "lower" | "upper" } => s.modulePath !== null);
  return (
    <li className="grid gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
      <div className="min-w-0">
        <p className="text-body font-medium text-ink">Full-Test Run · {formatWhen(finishedAt)}</p>
        <p className="mt-0.5 text-meta text-graphite">
          {[seconds > 0 ? formatDuration(seconds) : null, ...routed.map((s) => `${SECTION_LABEL[s.section]} on the ${MODULE_PATH_LABEL[s.modulePath]}`)]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {/* The Overall band, or how many sections have a band; never a mean of fewer than four.
            A section can be scored and still have no band, so the count is of bands, not of
            scoring. */}
        {run.overall.band !== null ? (
          <BandFigure band={run.overall.band} size="sm" />
        ) : (
          <span className="text-meta text-ink-soft">
            {run.overall.scoredSections} of 4 sections have a band
          </span>
        )}
        <TextLink to={`/full-test/${run.id}`}>View report</TextLink>
      </div>
    </li>
  );
}
