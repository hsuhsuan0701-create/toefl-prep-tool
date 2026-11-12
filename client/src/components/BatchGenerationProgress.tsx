import type { GenerationBatchChildVM } from "@toefl-prep/shared";
import type { CurrentSetDisplay, GenerationBatchUiStatus } from "../hooks/useGenerationBatch";
import { deriveJobDisplay, formatElapsed, sceneOutcomeSummary } from "../lib/progressUtils";
import { Button, TextLink } from "../ui/Button";
import { Card } from "../ui/Card";
import { StatusChip } from "../ui/Chip";
import { cx } from "../ui/cx";
import { GENERATION_BATCH_STATUS, GENERATION_JOB_STATUS, SECTION_LABEL } from "../ui/labels";
import { Notice } from "../ui/Notice";
import { ProgressBar } from "../ui/Progress";
import { setCount } from "./generation/generationCost";
import GenerationProgress from "./GenerationProgress";

/**
 * Everything this panel draws, as one object: structurally a subset of `useGenerationBatch`'s
 * `GenerationBatchState`, so the Dashboard hands its hook state straight in (`batch={batchJob}`).
 *
 * It leaves out the hook's terminalAt and cancellationReason: a finished batch is shown as the
 * per-Set summary below, which says more than a cancellation reason would.
 */
export type BatchGenerationProgressBatch = {
  status: GenerationBatchUiStatus;
  total: number;
  queued: number;
  activeCount: number;
  completed: number;
  failed: number;
  cancelledCount: number;
  cancelRequested: boolean;
  cancellationRequestedAt: string | null;
  active: CurrentSetDisplay[];
  children: GenerationBatchChildVM[];
  elapsedMs: number;
  error: string | null;
};

export type BatchGenerationProgressProps = {
  batch: BatchGenerationProgressBatch;
  onCancel: () => void;
  onRetry: () => void;
};

const TERMINAL: ReadonlySet<GenerationBatchUiStatus> = new Set(["done", "partial", "failed", "cancelled"]);

// One segment per Set, filled by that Set's real status, so which Set failed and which are still
// waiting shows at a glance with no invented percentage. Decorative: the counts beside it say the
// same in words.
const SEGMENT: Record<GenerationBatchChildVM["status"], string> = {
  queued: "bg-well",
  running: "bg-accent-rule",
  done: "bg-accent",
  failed: "bg-critical",
  cancelled: "bg-rule-strong",
};

function SegmentedTrack({ sets }: { sets: GenerationBatchChildVM[] }) {
  return (
    <div className="flex gap-0.5" aria-hidden="true">
      {sets.map((child) => (
        <span key={child.jobId} className={cx("h-1.5 flex-1 rounded-chip transition-colors duration-(--duration-calm)", SEGMENT[child.status])} />
      ))}
    </div>
  );
}

/** "1 ready · 2 in progress · 1 waiting", leaving out the counts that are zero. */
function tallies(batch: BatchGenerationProgressBatch): string {
  const parts: [number, string][] = [
    [batch.completed, "ready"],
    [batch.activeCount, "in progress"],
    [batch.queued, "waiting"],
    [batch.failed, "failed"],
    [batch.cancelledCount, "cancelled"],
  ];
  return parts.filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`).join(" · ") || "Preparing";
}

/**
 * A batch of Sets: one segment per Set, the counts in words, and, for every Set running now (several
 * run at once), the same GenerationProgress a single Set uses. At a terminal status it becomes a
 * summary listing every Set and its outcome, unless the batch never got as far as creating any Sets,
 * which reads as a single failure with Retry.
 */
export default function BatchGenerationProgress({ batch, onCancel, onRetry }: BatchGenerationProgressProps) {
  const { status, total, completed, failed, cancelledCount, cancelRequested, cancellationRequestedAt, active, children: sets, elapsedMs, error } = batch;

  if (status === "failed" && sets.length === 0) {
    return (
      <Notice
        tone="critical"
        live="polite"
        title="The batch could not start"
        action={
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        }
      >
        {error ?? "Something went wrong before any Sets could be queued."}
      </Notice>
    );
  }

  if (TERMINAL.has(status)) {
    return (
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <StatusChip status={GENERATION_BATCH_STATUS[status as Exclude<GenerationBatchUiStatus, "idle" | "starting">]} />
          <p role="status" className="text-ui font-medium text-ink">
            {summaryHeadline(status, completed, failed, cancelledCount, total)}
          </p>
        </div>
        {sets.length > 0 && <SegmentedTrack sets={sets} />}
        {/* Keyed off the counts, not the status: a batch that published something and then had Sets
            cancelled reports "partial", and that is exactly when the reassurance is owed. */}
        {cancelledCount > 0 && completed > 0 && <p className="text-meta text-ink-soft">The Sets that finished are kept.</p>}
        <ul className="divide-y divide-rule border-t border-rule">
          {sets.map((child) => (
            <ChildOutcome key={child.jobId} child={child} />
          ))}
        </ul>
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="text-ui font-medium text-ink">
          Generating {setCount(total)}
          {(cancelRequested || cancellationRequestedAt) && <span className="ml-2 font-normal text-caution">Cancellation requested…</span>}
        </p>
        <span className="figures text-meta text-graphite">{formatElapsed(elapsedMs)}</span>
      </div>

      <div className="space-y-1.5">
        {/* Before the first poll returns any Sets there are no segments to draw, only a count. */}
        {sets.length > 0 ? (
          <SegmentedTrack sets={sets} />
        ) : (
          <ProgressBar label="Sets" value={completed + failed} max={total} valueText={`${completed + failed} of ${total} finished`} />
        )}
        <p className="text-meta text-graphite" aria-live="polite">
          {tallies(batch)}
        </p>
      </div>

      {active.length > 0 && (
        <div className="divide-y divide-rule border-t border-rule">
          {active.map((item) => (
            <section key={item.jobId} aria-label={`Set ${item.setIndex + 1} of ${total}`} className="space-y-2 py-4">
              <p className="text-meta font-medium text-ink-soft">
                Set {item.setIndex + 1} of {total} · {SECTION_LABEL[item.kind]}
              </p>
              {/* A running child is drawn as a generation job, minus what only a whole job has: it
                  is running by construction, and its own failure is reported in the summary. */}
              <GenerationProgress job={{ ...item, status: "running", error: null }} onRetry={onRetry} framed={false} />
            </section>
          ))}
        </div>
      )}

      {!cancelRequested && (
        <Button variant="secondary" size="sm" onClick={onCancel}>
          Cancel batch
        </Button>
      )}
    </Card>
  );
}

function ChildOutcome({ child }: { child: GenerationBatchChildVM }) {
  const sceneOutcome = child.kind === "speaking" ? deriveJobDisplay(child.stage, child.progress).sceneOutcome : null;
  return (
    <li className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-2">
      <span className="text-ui text-ink-soft">
        Set {child.setIndex + 1} · {SECTION_LABEL[child.kind]}
      </span>
      <span className="flex min-w-0 flex-col items-end gap-0.5 text-right">
        <span className="flex flex-wrap items-center justify-end gap-2">
          <StatusChip status={GENERATION_JOB_STATUS[child.status]} />
          {child.status === "done" && child.setId && (
            <TextLink to={`/${child.kind}/${child.setId}`} className="text-meta">
              Practise it
            </TextLink>
          )}
        </span>
        {child.status === "done" && child.setId && <span className="font-mono text-caption text-faint">{child.setId}</span>}
        {child.status === "done" && sceneOutcome && <span className="text-meta text-graphite">{sceneOutcomeSummary(sceneOutcome)}</span>}
        {child.status === "failed" && (
          <span className="max-w-xs text-meta text-critical text-pretty">{child.error ?? "Failed for an unknown reason."}</span>
        )}
      </span>
    </li>
  );
}

function summaryHeadline(status: GenerationBatchUiStatus, completed: number, failed: number, cancelledCount: number, total: number): string {
  if (status === "done") return total === 1 ? "The Set is ready." : `All ${total} Sets are ready.`;
  // The server reports 'cancelled' only when no Set was published (computeBatchStatus); the count
  // is still printed from the data rather than assumed to be 0.
  if (status === "cancelled") return `Cancelled — ${completed} of ${setCount(total)} generated before stopping.`;
  if (status === "failed") return `Generation failed for all ${setCount(total)}.`;
  const extra = [...(failed > 0 ? [`${failed} failed`] : []), ...(cancelledCount > 0 ? [`${cancelledCount} cancelled`] : [])];
  return `${completed} of ${setCount(total)} generated${extra.length > 0 ? `, ${extra.join(", ")}` : ""}.`;
}
