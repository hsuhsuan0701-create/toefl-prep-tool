import { useCallback, useEffect, useRef, useState } from "react";
import type { TranscriptionJobVM } from "@toefl-prep/shared";
import { HttpError, retryTranscription } from "../../lib/api";
import { isTerminalTranscriptionFailure, terminalTranscriptionMessage } from "../../lib/transcriptionFailure";
import { Button } from "../../ui/Button";
import { Notice } from "../../ui/Notice";
import { asSentence, formatTime } from "../../ui/format";
import { TRANSCRIPTION_JOB_STATUS } from "../../ui/labels";

// One durable transcription job, rendered from `item.transcriptionJob` on every load — never from
// one-time navigation state — so it reads the same whether the User just finished a Simulation or
// comes back a week later mid-recovery. Retry exists only for 'failed' (the one status a manual
// retry accepts) and is single-flight; its POST body is empty, because the server re-derives the
// stored recording itself and the client never resends audio.

const PANEL_TONE: Record<TranscriptionJobVM["status"], "info" | "caution" | "critical" | "positive"> = {
  queued: "info",
  running: "info",
  retry_wait: "caution",
  awaiting_score: "info",
  done: "positive",
  failed: "critical",
  // Total over the union; the server never sends a superseded job (it reads only current ones).
  superseded: "info",
};

/**
 * A short fixed sentence per HTTP status, never the response body: an error's message embeds the
 * body, and a proxy's HTML error page would otherwise land in the panel.
 */
function transcriptionRetryMessage(err: unknown): string {
  const status = err instanceof HttpError ? err.status : 0;
  if (status === 404) return "That transcription job is no longer available.";
  if (status === 409) return "This recording can't be retried anymore.";
  return "Retry didn't go through. Try again in a moment.";
}

export default function TranscriptionJobPanel({
  attemptId,
  job,
  onRetried,
}: {
  attemptId: string;
  job: TranscriptionJobVM;
  /** Re-reads the Attempt; settles once the refreshed job is on screen (or the read failed). */
  onRetried: () => Promise<void>;
}) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A retry error is about one try at one job state; it must not outlive the state it was about.
  useEffect(() => {
    setRetryError(null);
  }, [job.jobId, job.status]);

  const handleRetry = useCallback(() => {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    // The button stays busy until the refreshed Attempt has arrived, not just the POST: until then
    // the panel still shows the job as failed, and a second click would only be refused, since the
    // server retries a job only while it is failed.
    void retryTranscription(attemptId, job.jobId)
      .then(() => (mountedRef.current ? onRetried() : undefined))
      .catch((e) => {
        // The status only, never the body — the same reason as the rendered message.
        console.error("AttemptReview: transcription retry failed", e instanceof HttpError ? `status ${e.status}` : "network error");
        if (!mountedRef.current) return;
        setRetryError(transcriptionRetryMessage(e));
      })
      .finally(() => {
        if (mountedRef.current) setRetrying(false);
      });
  }, [attemptId, job.jobId, onRetried, retrying]);

  // Which failure kinds a retry provably cannot clear lives in lib/transcriptionFailure.ts.
  const terminal = isTerminalTranscriptionFailure(job);

  return (
    <Notice
      tone={PANEL_TONE[job.status]}
      title={TRANSCRIPTION_JOB_STATUS[job.status].label}
      action={
        job.status === "failed" && !terminal ? (
          <Button size="sm" onClick={handleRetry} loading={retrying}>
            {retrying ? "Retrying…" : "Retry transcription"}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-1">
        {job.automaticAttempts > 0 && (
          <p>
            Tried automatically {job.automaticAttempts} {job.automaticAttempts === 1 ? "time" : "times"}
            {/* An ISO instant from the server, formatted once in local time. */}
            {job.status === "retry_wait" && job.nextRetryAt && <>; next attempt around {formatTime(job.nextRetryAt)}</>}.
          </p>
        )}
        {/* Already a server-bounded, safe message: never a provider body, a path or a transcript. */}
        {job.error && <p>{asSentence(job.error)}</p>}
        {/* A terminal fault gets an honest dead end, not a Retry that re-runs the same bytes. */}
        {terminal && job.failureKind !== null && <p>{terminalTranscriptionMessage(job.failureKind)}</p>}
        {retryError && (
          <p role="alert" className="font-medium text-critical">
            {retryError}
          </p>
        )}
      </div>
    </Notice>
  );
}
