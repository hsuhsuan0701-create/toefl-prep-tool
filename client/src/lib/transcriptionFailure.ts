// Which transcription failures Attempt review offers no Retry for, and what it says instead.
// Pure policy, kept apart from the panel so the server suite can pin it beside the route whose
// failure kinds it interprets (the same arrangement as progressUtils.ts).
import type { TranscriptionFailureKind, TranscriptionJobVM } from "@toefl-prep/shared";

// Failure kinds a manual retry cannot clear. A retry re-runs the same stored recording, and the
// server revalidates its path and content hash before spending anything on Ears, so a missing file,
// a path that no longer resolves inside the data dir, or content whose hash no longer matches fails
// the same way every time.
//
// `unsupported-audio` is different in kind: the recording is intact, but Ears said it cannot process
// these exact bytes (a 400 whose error names the audio, or a 413 or 415), and the server treats that
// as terminal. A retry would send the same bytes back — a paid call per click on a button that can
// never succeed. A wrong model name, a rejected or missing key, a refused region and a 400 whose
// error the server does not recognise all read as `configuration`, not this, and stay retryable.
//
// Everything else stays retryable on purpose — most of all `authentication` and `configuration`,
// where a retry is exactly what the User wants once the key or setting is repaired.
const UNRETRYABLE_FAILURE_KINDS: ReadonlySet<TranscriptionFailureKind> = new Set<TranscriptionFailureKind>([
  "missing-recording",
  "corrupt-recording",
  "unsafe-path",
  "unsupported-audio",
]);

// `unsupported-audio` with exactly this message marks a 400 classified by its status alone, without
// reading its error body. Such a job may have been refused for a mistyped key rather than for its
// audio, so it keeps Retry. A 400 whose error names the audio carries a different message.
const UNCLASSIFIED_400_MESSAGE = "request rejected (HTTP 400)";

export function isTerminalTranscriptionFailure(job: Pick<TranscriptionJobVM, "status" | "failureKind" | "error">): boolean {
  if (job.status !== "failed" || job.failureKind === null) return false;
  if (job.failureKind === "unsupported-audio" && job.error === UNCLASSIFIED_400_MESSAGE) return false;
  return UNRETRYABLE_FAILURE_KINDS.has(job.failureKind);
}

// An honest dead end, not a Retry button that comes back identical every time. The two terminal
// classes have genuinely different causes, so they get genuinely different sentences: the stored
// recording is unreadable, versus the recording is fine but the provider will not accept it.
export function terminalTranscriptionMessage(failureKind: TranscriptionFailureKind): string {
  if (failureKind === "unsupported-audio") {
    return "The transcription provider rejected this recording, and retrying sends the same audio, so it can't be transcribed. Recording this item again in a new attempt is the only way to get a score for it.";
  }
  return "The stored recording can no longer be read, so transcription can't be retried. Recording this item again in a new attempt is the only way to get a score for it.";
}
