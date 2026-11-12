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
// to a half-sat Run and to a finished Run's report (its page is the report).
//
// Failures stay inside this panel: a failed listing must never blank the practice lists around it.

const HOME_FULL_TESTS = 3;

export default function FullTestPanel() {
  const [runs, setRuns] = useState<FullTestRunVM[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const startRun = useStartFullTest();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Every in-progress Run, however old — this panel is the only route back to one — plus the few
  // most recent Runs for their reports. A Run in both answers is listed once.
  const reload = useCallback(async () => {
    try {
      const [unfinished, recent] = await Promise.all([
        listFullTests({ status: "in-progress" }),
        listFullTests({ limit: HOME_FULL_TESTS }),
      ]);
      const byId = new Map([...unfinished, ...recent].map((run) => [run.id, run]));
      if (mountedRef.current) setRuns([...byId.values()]);
    } catch (e) {
      if (mountedRef.current) setError(requestErrorMessage(e));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const shown = runs.filter((r) => r.status === "in-progress" || r.status === "completed");
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
      {shown.length > 0 && (
        <List label="Full-Test Runs">
          {shown.map((run) => (run.status === "in-progress" ? <InProgressRun key={run.id} run={run} /> : <FinishedRun key={run.id} run={run} />))}
        </List>
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
