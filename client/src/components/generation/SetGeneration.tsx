import { useEffect, useRef, useState } from "react";
import type { ActiveGenerationEntryVM, GenerationBatchDetailVM, GenerationJobDetailVM, NoveltyResidualIssue, SceneGenerationOutcome } from "@toefl-prep/shared";
import { useGenerationBatch } from "../../hooks/useGenerationBatch";
import { useGenerationJob, type GenerationKind } from "../../hooks/useGenerationJob";
import { listActiveGeneration, type SetupStatus } from "../../lib/api";
import { noveltyResidualSummary, sceneOutcomeSummary } from "../../lib/progressUtils";
import { TextLink } from "../../ui/Button";
import { SectionHeader } from "../../ui/Heading";
import { SECTION_LABEL } from "../../ui/labels";
import { Notice } from "../../ui/Notice";
import BatchGenerationProgress from "../BatchGenerationProgress";
import GenerationProgress from "../GenerationProgress";
import { GenerateSetsDialog, type GenerationRequest } from "./GenerateSetsDialog";

type SetGenerationProps = {
  /** Whether the "Generate Sets" dialog is showing. The page's header button opens it. */
  dialogOpen: boolean;
  onDialogClose: () => void;
  /** Called each time a new Set lands, so the page can refresh its Set lists. */
  onGenerated: () => void;
  /** What this machine can do, so the dialog does not offer a section it cannot generate. */
  setup: SetupStatus | null;
};

/**
 * Set generation on the Dashboard: the dialog that starts a run, and the progress of every run still
 * going. Generation jobs are durable on the server, so on mount this re-attaches to whatever is still
 * queued or running (GET /api/generate): a refresh, or a Drill and back, mid-generation picks the
 * progress up again, elapsed clock included, without POSTing anything. One Set takes the single-job
 * path; more than one is a batch.
 */
export default function SetGeneration({ dialogOpen, onDialogClose, onGenerated, setup }: SetGenerationProps) {
  const [activeMode, setActiveMode] = useState<"single" | "batch" | null>(null);
  const singleJob = useGenerationJob();
  const batchJob = useGenerationBatch();
  const notifiedRef = useRef(false);
  const lastNotifiedCompletedRef = useRef(0);
  // Set the moment the User starts a run here, so a slow active listing can never re-attach over
  // (and so replace) work they just started watching.
  const userStartedRef = useRef(false);
  // Every other entry the listing returned beyond the one attached above (a second tab's run, say),
  // each in its own panel with its own hook instance and its own Cancel.
  const [otherActive, setOtherActive] = useState<ActiveGenerationEntryVM[]>([]);

  const { attach: attachSingle } = singleJob;
  const { attach: attachBatch } = batchJob;
  useEffect(() => {
    let stale = false;
    listActiveGeneration()
      .then(({ active }) => {
        if (stale || userStartedRef.current || active.length === 0) return;
        const [entry, ...rest] = active; // newest first: what the User most recently started
        if (entry.kind === "batch") {
          // Seeded from the listing, so Sets that landed before this mount don't read as new.
          lastNotifiedCompletedRef.current = entry.completed;
          setActiveMode("batch");
          attachBatch({ jobId: entry.jobId, total: entry.total, createdAt: entry.createdAt });
        } else {
          setActiveMode("single");
          attachSingle({ jobId: entry.jobId, kind: entry.kind, createdAt: entry.createdAt });
        }
        if (rest.length > 0) setOtherActive(rest);
      })
      .catch(() => {
        // Best-effort: a failed listing only means no resumed panel. The job itself is untouched,
        // and its Set still lands in the lists when it finishes.
      });
    return () => {
      stale = true;
    };
  }, [attachSingle, attachBatch]);

  // One Set: tell the page once, when it lands.
  useEffect(() => {
    if (activeMode !== "single") return;
    if (singleJob.status === "done" && !notifiedRef.current) {
      notifiedRef.current = true;
      onGenerated();
    }
    if (singleJob.status !== "done") notifiedRef.current = false;
  }, [activeMode, singleJob.status, onGenerated]);

  // A batch: tell the page each time another Set lands, so early Sets are usable before the last.
  useEffect(() => {
    if (activeMode !== "batch") return;
    if (batchJob.completed > lastNotifiedCompletedRef.current) {
      lastNotifiedCompletedRef.current = batchJob.completed;
      onGenerated();
    }
  }, [activeMode, batchJob.completed, onGenerated]);

  const running = (status: string) => status === "starting" || status === "queued" || status === "running";
  const busy = (activeMode === "single" && running(singleJob.status)) || (activeMode === "batch" && running(batchJob.status));

  function start(request: GenerationRequest) {
    userStartedRef.current = true;
    if (request.mode === "single") {
      setActiveMode("single");
      singleJob.run(request.section, request.supersedesSetId ? { supersedesSetId: request.supersedesSetId } : {});
    } else {
      lastNotifiedCompletedRef.current = 0;
      setActiveMode("batch");
      batchJob.run(request.items);
    }
  }

  const showSingle = activeMode === "single" && singleJob.status !== "idle";
  const showBatch = activeMode === "batch" && batchJob.status !== "idle";

  return (
    <>
      <GenerateSetsDialog open={dialogOpen} onClose={onDialogClose} onStart={start} busy={busy} setup={setup} />
      {(showSingle || showBatch || otherActive.length > 0) && (
        <section aria-labelledby="generation-heading" className="space-y-4">
          <SectionHeader id="generation-heading" title="New Sets" />
          {showSingle &&
            (singleJob.status === "done" && singleJob.setId ? (
              <GeneratedSetNotice setId={singleJob.setId} kind={singleJob.kind} sceneOutcome={singleJob.sceneOutcome} noveltyResidual={singleJob.noveltyResidual} />
            ) : (
              <GenerationProgress job={singleJob} onRetry={singleJob.retry} onCancel={singleJob.cancel} />
            ))}
          {showBatch && <BatchGenerationProgress batch={batchJob} onCancel={batchJob.cancel} onRetry={batchJob.retry} />}
          {otherActive.length > 0 && (
            <div className="space-y-3">
              <SectionHeader as="h3" title="Also running" description="Started in another tab, or before this page loaded." />
              {otherActive.map((entry) =>
                entry.kind === "batch" ? (
                  <AttachedBatchJob key={entry.jobId} entry={entry} onGenerated={onGenerated} />
                ) : (
                  <AttachedSingleJob key={entry.jobId} entry={entry} onGenerated={onGenerated} />
                ),
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}

// One panel per other active single-Set job the mount-time listing returned. Its own hook instance
// owns that one job end to end: it attaches once (the parent keys this component by jobId, so the
// job never changes under it) and never re-attaches.
function AttachedSingleJob({ entry, onGenerated }: { entry: GenerationJobDetailVM & { createdAt: string }; onGenerated: () => void }) {
  const job = useGenerationJob();
  const { attach } = job;
  const notifiedRef = useRef(false);

  useEffect(() => {
    attach(entry);
    // Deliberately once: the job this panel follows never changes across its life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (job.status === "done" && !notifiedRef.current) {
      notifiedRef.current = true;
      onGenerated();
    }
    if (job.status !== "done") notifiedRef.current = false;
  }, [job.status, onGenerated]);

  if (job.status === "idle") return null;
  if (job.status === "done" && job.setId) {
    return <GeneratedSetNotice setId={job.setId} kind={job.kind} sceneOutcome={job.sceneOutcome} noveltyResidual={job.noveltyResidual} />;
  }
  return <GenerationProgress job={job} onRetry={job.retry} onCancel={job.cancel} />;
}

// The batch counterpart: one panel, one hook instance, attached once.
function AttachedBatchJob({ entry, onGenerated }: { entry: GenerationBatchDetailVM & { createdAt: string }; onGenerated: () => void }) {
  const batch = useGenerationBatch();
  const { attach } = batch;
  // Seeded from the listing: Sets that landed before this panel mounted are not new.
  const lastNotifiedCompletedRef = useRef(entry.completed);

  useEffect(() => {
    attach(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (batch.completed > lastNotifiedCompletedRef.current) {
      lastNotifiedCompletedRef.current = batch.completed;
      onGenerated();
    }
  }, [batch.completed, onGenerated]);

  if (batch.status === "idle") return null;
  return <BatchGenerationProgress batch={batch} onCancel={batch.cancel} onRetry={batch.retry} />;
}

/** A single new Set that landed: where to practise it, and anything it is known to fall short on. */
function GeneratedSetNotice({
  setId,
  kind,
  sceneOutcome,
  noveltyResidual,
}: {
  setId: string;
  kind: GenerationKind | null;
  sceneOutcome: SceneGenerationOutcome | null;
  noveltyResidual: NoveltyResidualIssue[] | null;
}) {
  return (
    <Notice
      tone="positive"
      live="polite"
      title={kind ? `Your new ${SECTION_LABEL[kind]} Set is ready` : "Your new Set is ready"}
      action={kind ? <TextLink to={`/${kind}/${setId}`}>Practise it</TextLink> : undefined}
    >
      <span className="font-mono text-caption text-graphite">{setId}</span>
      {kind === "speaking" && sceneOutcome && <p>{sceneOutcomeSummary(sceneOutcome)}</p>}
      {/* Overlaps with earlier Sets the Plan was admitted with: usable, but worth knowing. */}
      {noveltyResidual && noveltyResidual.length > 0 && <p>{noveltyResidualSummary(noveltyResidual)}</p>}
    </Notice>
  );
}
