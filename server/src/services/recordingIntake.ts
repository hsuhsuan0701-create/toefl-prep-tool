import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DeliveryReport, TranscriptionJobVM } from "@toefl-prep/shared";
import { config } from "../lib/config.js";
import { toDataDirRelative } from "../lib/paths.js";
import { jobAdmissionsAreOpen } from "./jobCancellation.js";
import {
  probeDurationSec as realProbeDurationSec,
  transcodeWebmToMp3 as realTranscodeWebmToMp3,
  TranscodeError,
} from "./transcode.js";
import {
  TranscriptionAdmissionSuperseded,
  TranscriptionExecutionUnavailable,
  type AdmitRecordingInput,
  type AdmitRecordingResult,
} from "./transcriptionRecovery.js";

// Recording intake: everything the Speaking upload route (POST /:id/items/:itemId/audio) does
// between "a usable file arrived" and "a transcription job owns it": staging to private temp paths,
// transcoding, hashing, the per-Item publication lock, the two canonical renames, and the hand-off
// to the transcription coordinator's admitRecording.
//
// The route keeps parsing (multipart to bytes, the minimum-size floor), the Attempt/Set/Item lookup
// and the HTTP statuses. Every way intake can end is a named outcome below, and the route maps each
// one to a status.

// ---------------------------------------------------------------------------------------------
// Persistence port
// ---------------------------------------------------------------------------------------------

// The one store member intake uses. `createSqliteRecordingStore` (db/stores/transcription.ts)
// implements it.
export type RecordingStore = {
  isSupersededTranscriptionHash(i: { attemptId: string; itemId: string; audioSha256: string }): boolean;
};

// The one member intake needs from the transcription coordinator (TranscriptionRecovery).
export type RecordingAdmission = {
  admitRecording(input: AdmitRecordingInput): Promise<AdmitRecordingResult>;
};

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------

/**
 * The three ways an upload conflicts with another take of the same Item:
 *
 *   publication-in-progress  Another upload of the same (Attempt, Item) holds its publication lock:
 *                            refused so two publishers never interleave the two-file canonical pair.
 *                            Route: 409 "recording upload in progress".
 *   superseded-recording     These exact bytes belong to a transcription job that is no longer the
 *                            Item's current one (a replayed upload of a take a later re-record
 *                            replaced). Refused while both staged files are still private, so no
 *                            canonical pair is ever rolled back. Route: 409 "recording superseded".
 *   superseded-admission     The recording published, but admission found a newer take for the same
 *                            Item (TranscriptionAdmissionSuperseded). Route: 409 "recording
 *                            superseded".
 *
 * The last two share a message because to the User they are the same fact, a newer take won; they
 * are separate names because they are separate rules, so a status change to one cannot move the
 * other.
 */
export type RecordingIntakeConflict =
  | "publication-in-progress"
  | "superseded-recording"
  | "superseded-admission";

/**
 * Every way intake can end, with the status the route maps each to:
 *
 *   transcribed            200  transcript and Delivery Report already persisted by admitRecording.
 *   transcription-pending  202  stored and owned by a transcription job that will retry.
 *   conflict               409  one of the three conflicts above.
 *   unusable-recording     400  transcode refused the upload; nothing canonical was touched.
 *   unavailable            503  job admissions are closed or the server is not ready to run jobs
 *                               ("server is not ready").
 */
export type RecordingIntakeOutcome =
  | { outcome: "transcribed"; transcript: string; deliveryReport: DeliveryReport; durationSec: number | null }
  | { outcome: "transcription-pending"; job: TranscriptionJobVM }
  | { outcome: "conflict"; conflict: RecordingIntakeConflict }
  | { outcome: "unusable-recording" }
  | { outcome: "unavailable" };

// ---------------------------------------------------------------------------------------------
// Publication lock
// ---------------------------------------------------------------------------------------------

// The canonical recordings whose publication is in progress in this process, by their webm path.
//
// In-process on purpose: the execution lease makes one server process the only one that publishes
// recordings into a data directory (a process without the lease refuses before its renames, at the
// admissions check below), so the exclusion needed is between this process's own concurrent
// uploads of one Item, which interleave across awaits. A lock that lives in memory also dies with
// its process, so a crash leaves nothing to sweep at the next boot.
const publishingRecordings = new Set<string>();

// Takes the lock on one canonical recording, or answers undefined while another upload holds it.
// The returned release must run exactly once, whatever happens after.
function tryLockRecordingPublication(canonicalWebmPath: string): (() => void) | undefined {
  const key = path.resolve(canonicalWebmPath);
  if (publishingRecordings.has(key)) return undefined;
  publishingRecordings.add(key);
  return () => {
    publishingRecordings.delete(key);
  };
}

// ---------------------------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------------------------

export type RecordingIntakeRequest = {
  attemptId: string;
  itemId: string;
  taskType: "listen_repeat" | "interview";
  // The framing Ears is given, built by the route from the Set. It never contains a Listen and
  // Repeat Item's target sentence.
  context: string;
  // The parsed upload. The multipart body, and the minimum-size floor that separates "no usable
  // recording" from a real take, are the route's.
  bytes: Uint8Array;
};

export type RecordingIntakeDeps = {
  store: RecordingStore;
  // The process's one coordinator, passed in rather than built here.
  transcriptionRecovery: RecordingAdmission;
  dataDir?: string;
  // Seams a test replaces to run with no ffmpeg. Each defaults to the real one.
  transcode?: (webmPath: string, mp3Path: string) => Promise<void>;
  probeDurationSec?: (filePath: string) => Promise<number>;
  admissionsAreOpen?: () => boolean;
};

/**
 * Publishes one uploaded recording and hands it to transcription, returning the outcome the route
 * maps to a status. Never throws for a condition that has an outcome; an unclassified fault (fs,
 * better-sqlite3, an unexpected coordinator error) propagates rather than being reported as one.
 *
 * The order matters:
 *   1. stage both temp files and transcode before taking the lock, so a corrupt upload is refused
 *      without waiting on a legitimate publisher, and a busy lock leaves no canonical file touched;
 *   2. hash the staged webm, then take the lock;
 *   3. while both staged files are still private, refuse a superseded hash and refuse when job
 *      admissions are closed. Every take of an Item is renamed onto the same canonical pair, so a
 *      refusal after the renames would leave the database describing the previous take while its
 *      files hold this one;
 *   4. only then rename into the canonical pair and hand off.
 */
export async function intakeRecording(
  deps: RecordingIntakeDeps,
  request: RecordingIntakeRequest,
): Promise<RecordingIntakeOutcome> {
  const { attemptId, itemId } = request;
  const dataDir = deps.dataDir ?? config.dataDir;
  const transcode = deps.transcode ?? realTranscodeWebmToMp3;
  const probeDurationSec = deps.probeDurationSec ?? realProbeDurationSec;
  const admissionsAreOpen = deps.admissionsAreOpen ?? jobAdmissionsAreOpen;

  const dir = path.join(dataDir, "audio/responses", attemptId);
  fs.mkdirSync(dir, { recursive: true });
  const webmPath = path.join(dir, `${itemId}.webm`);
  const mp3Path = path.join(dir, `${itemId}.mp3`);

  // Staged in the same directory (so the rename is atomic) and renamed onto the canonical paths only
  // after transcode has validated the upload, so a re-upload that fails to transcode never
  // overwrites the previous good take.
  const tmpSuffix = crypto.randomUUID();
  const tmpWebmPath = path.join(dir, `${itemId}.webm.tmp-${tmpSuffix}`);
  const tmpMp3Path = path.join(dir, `${itemId}.mp3.tmp-${tmpSuffix}`);
  fs.writeFileSync(tmpWebmPath, request.bytes);

  try {
    await transcode(tmpWebmPath, tmpMp3Path);
  } catch (err) {
    fs.rmSync(tmpWebmPath, { force: true });
    fs.rmSync(tmpMp3Path, { force: true });
    if (err instanceof TranscodeError) {
      // Only the temp files are discarded; the canonical files and the Item row are untouched.
      return { outcome: "unusable-recording" };
    }
    throw err;
  }

  const uploadedSha256 = crypto.createHash("sha256").update(fs.readFileSync(tmpWebmPath)).digest("hex");
  const releaseUploadLock = tryLockRecordingPublication(webmPath);
  if (!releaseUploadLock) {
    fs.rmSync(tmpWebmPath, { force: true });
    fs.rmSync(tmpMp3Path, { force: true });
    return { outcome: "conflict", conflict: "publication-in-progress" };
  }

  try {
    // Both refusals come while the staged files are still private (step 3 above). In production
    // the admissions gate includes the same readiness admitRecording checks first, and nothing
    // between the two checks awaits, so admission is not refused for readiness after the renames.
    if (deps.store.isSupersededTranscriptionHash({ attemptId, itemId, audioSha256: uploadedSha256 })) {
      return { outcome: "conflict", conflict: "superseded-recording" };
    }
    if (!admissionsAreOpen()) return { outcome: "unavailable" };
    fs.renameSync(tmpWebmPath, webmPath);
    fs.renameSync(tmpMp3Path, mp3Path);

    // From here the transcription coordinator owns the recording. It calls Ears, classifies the
    // failures, and writes the Item's 'transcription_pending' row before its first Ears call;
    // intake must not write that row too. It takes the dataDir-relative path that is stored, while
    // probeDurationSec below needs the absolute one.
    let admitted: AdmitRecordingResult;
    try {
      admitted = await deps.transcriptionRecovery.admitRecording({
        attemptId,
        itemId,
        taskType: request.taskType,
        recordingPath: toDataDirRelative(webmPath, dataDir),
        mimeType: "audio/webm",
        context: request.context,
      });
    } catch (err) {
      if (err instanceof TranscriptionExecutionUnavailable) return { outcome: "unavailable" };
      if (!(err instanceof TranscriptionAdmissionSuperseded)) throw err;
      return { outcome: "conflict", conflict: "superseded-admission" };
    }

    if (admitted.kind === "accepted") {
      // Stored and owned by a transcription job that will retry: the upload succeeded, so this is
      // a 202, not an error.
      return { outcome: "transcription-pending", job: admitted.job };
    }

    // admitRecording has already persisted the transcript and Delivery Report together with the
    // job's completion. The duration is display-only, so a failed probe (ffprobe missing, say)
    // never fails the upload.
    let durationSec: number | null;
    try {
      durationSec = await probeDurationSec(webmPath);
    } catch {
      durationSec = null;
    }
    return { outcome: "transcribed", transcript: admitted.transcript, deliveryReport: admitted.deliveryReport, durationSec };
  } finally {
    fs.rmSync(tmpWebmPath, { force: true });
    fs.rmSync(tmpMp3Path, { force: true });
    releaseUploadLock();
  }
}
