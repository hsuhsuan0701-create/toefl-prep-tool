import type { ReactNode } from "react";
import ItemRecorder, { type RunnableItem } from "../../components/ItemRecorder";
import type { useRecorder } from "../../hooks/useRecorder";
import { Button } from "../../ui/Button";
import { cx } from "../../ui/cx";
import { IconCaution, IconCheck, IconCritical, IconMic, IconProgress, IconRepeat, IconSpinner } from "../../ui/icons";
import { ProgressBar } from "../../ui/Progress";
import { settledCount, type UploadEntry } from "./speakingDrillModel";

/**
 * Where each of a Task's recordings stands once the last Item has been recorded, with what can be
 * done about the ones that are stuck: an upload that never reached the server can be sent again, and
 * a recording the server refused can be recorded again (a Drill allows re-recording). A recording
 * the server has already stored for background transcription needs nothing from the User — it is
 * scored later and shows up in the Attempt report.
 *
 * Only one Item may drive the shared recorder at a time: while a re-record is open, every other
 * Record again is disabled, so a second re-record cannot swap the first one's recorder out from
 * under a running take.
 */
export default function UploadsSettling({
  items,
  uploads,
  recorder,
  rerecordItemId,
  onRetryUpload,
  onRerecord,
  onRerecordFinished,
  onCancelRerecord,
}: {
  items: RunnableItem[];
  uploads: Record<string, UploadEntry>;
  recorder: ReturnType<typeof useRecorder>;
  rerecordItemId: string | null;
  onRetryUpload: (itemId: string, blob: Blob) => void;
  onRerecord: (itemId: string) => void;
  onRerecordFinished: (itemId: string, blob: Blob) => void;
  onCancelRerecord: () => void;
}) {
  const rerecordItem = rerecordItemId ? (items.find((it) => it.id === rerecordItemId) ?? null) : null;

  return (
    <div className="mx-auto max-w-measure space-y-6">
      <div className="space-y-2">
        <h1 className="text-heading font-semibold text-ink">Sending your recordings</h1>
        <p className="text-body text-ink-soft">
          Scoring starts by itself once every recording below has reached the server. Recordings saved for later
          transcription are scored when that finishes and show up in your Attempt report.
        </p>
      </div>

      <ProgressBar label="Recordings settled" value={settledCount(items, uploads)} max={items.length} />

      {/* Only the recordings that need the User are announced, once each, not every upload that
          lands. */}
      <p aria-live="polite" className="sr-only">
        {items
          .map((it, i) => ({ status: uploads[it.id]?.status, n: i + 1 }))
          .filter(({ status }) => status === "retryable-failed" || status === "needs-rerecord-failed")
          .map(({ status, n }) => (status === "retryable-failed" ? `Item ${n}: upload failed.` : `Item ${n}: recording unusable.`))
          .join(" ")}
      </p>
      <ol className="divide-y divide-rule rounded-sheet border border-rule bg-sheet">
        {items.map((it, i) => {
          const u = uploads[it.id];
          return (
            <li key={it.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
              <span className="text-ui font-medium text-ink">Item {i + 1}</span>
              {(!u || u.status === "uploading") && <Status icon={<IconSpinner size={14} />}>Uploading…</Status>}
              {u?.status === "done" && <Status icon={<IconCheck size={14} />}>Uploaded</Status>}
              {u?.status === "recovery-pending" &&
                // The server accepted and stored this recording, so nothing is offered: resending
                // would only resolve to the same job. A job already at "failed" has spent its
                // automatic retries; the manual retry lives on the Attempt report.
                (u.job?.status === "failed" ? (
                  <Status tone="caution" icon={<IconCaution size={14} />}>
                    Saved — transcription needs a retry from your Attempt report
                  </Status>
                ) : (
                  <Status icon={<IconProgress size={14} />}>Saved — being transcribed</Status>
                ))}
              {u?.status === "retryable-failed" && (
                <span className="flex flex-wrap items-center gap-3">
                  <Status tone="caution" icon={<IconCaution size={14} />}>
                    Upload failed
                  </Status>
                  <Button size="sm" icon={<IconRepeat size={14} />} onClick={() => onRetryUpload(it.id, u.blob)}>
                    Retry
                  </Button>
                </span>
              )}
              {u?.status === "needs-rerecord-failed" && (
                <span className="flex flex-wrap items-center gap-3">
                  <Status tone="critical" icon={<IconCritical size={14} />}>
                    Recording unusable
                  </Status>
                  {rerecordItemId === it.id ? (
                    <span className="text-meta text-graphite">Recording below</span>
                  ) : (
                    <Button size="sm" icon={<IconMic size={14} />} onClick={() => onRerecord(it.id)} disabled={rerecordItemId !== null}>
                      Record again
                    </Button>
                  )}
                </span>
              )}
            </li>
          );
        })}
      </ol>

      {rerecordItem && (
        <section aria-label="Recording this Item again" className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-ui text-ink-soft">Recording Item {items.indexOf(rerecordItem) + 1} again</p>
            {/* Clearing the re-record unmounts the ItemRecorder below, whose own unmount stops a take
                still running, so Cancel needs no recorder logic of its own. */}
            <Button variant="quiet" size="sm" onClick={onCancelRerecord}>
              Cancel
            </Button>
          </div>
          <ItemRecorder
            key={`rerecord-${rerecordItem.id}`}
            item={rerecordItem}
            recorder={recorder}
            onFinished={(blob) => onRerecordFinished(rerecordItem.id, blob)}
          />
        </section>
      )}
    </div>
  );
}

function Status({ tone = "neutral", icon, children }: { tone?: "neutral" | "caution" | "critical"; icon: ReactNode; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 text-ui",
        tone === "neutral" && "text-ink-soft",
        tone === "caution" && "text-caution",
        tone === "critical" && "text-critical",
      )}
    >
      {icon}
      {children}
    </span>
  );
}
