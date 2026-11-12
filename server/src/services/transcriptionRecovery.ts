import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DeliveryReportSchema,
  type AnySet,
  type DeliveryReport,
  type ScoreRequest,
  type TranscriptionFailureKind,
  type TranscriptionJobStatus,
  type TranscriptionJobVM,
} from "@toefl-prep/shared";
import { config } from "../lib/config.js";
import { resolveAudioPath, resolvePathWithinBase, resolveRealPathWithinBase } from "../lib/paths.js";
import { createSetStore, type SetReader } from "./setStore.js";
import { type TranscriptionJobRow } from "../db/rows.js";
import { parseSqliteTimestamp, sqliteTimestamp, sqliteTimestampToIso, type SqliteTimestamp } from "../db/timestamps.js";
import { EarsError, hearRecording as realHearRecording } from "./ears.js";
import { jobAdmissionsAreOpen } from "./jobCancellation.js";
import {
  enqueueScoringJob,
  INTERRUPTED_ITEM_SCORE_JSON,
  settleStrandedItems,
  type BootRecoveryServer,
  type ScoringJobDeps,
  type ScoringStore,
} from "./scoringJobs.js";
import type { ResponseRow } from "./judgeEnsemble.js";

// ---------------------------------------------------------------------------------------------
// Durable transcription of Speaking recordings. A recording the upload route has stored becomes a
// `transcription_jobs` row and is sent to Ears. A transient failure is retried automatically after
// 15 s, 60 s and 5 min; after that, or after a terminal failure, the job is 'failed' and only the
// User's Retry runs it again. A recording transcribed on the first call lands its Item at 'pending'
// for the client's own score request; one transcribed on a later run is handed to scoring here, as
// a one-Item scoring job. Also here: the per-Item read model the review shows, and the two boot
// sweeps at the bottom of the file, which spend nothing.
// ---------------------------------------------------------------------------------------------

export type AdmitRecordingInput = {
  attemptId: string;
  itemId: string;
  taskType: "listen_repeat" | "interview";
  recordingPath: string; // dataDir-relative, constructed by the upload route
  mimeType: "audio/webm";
  context: string;
};

export type AdmitRecordingResult =
  | { kind: "transcribed"; transcript: string; deliveryReport: DeliveryReport }
  | { kind: "accepted"; job: TranscriptionJobVM };

/**
 * Thrown by `retry` for its only two conflicts: the job is not 'failed', or it is no longer the
 * current job for its Item (a later take replaced it). The route answers exactly these with 409;
 * any other error from `retry` is a fault and answers 500.
 */
export class TranscriptionJobNotRetryable extends Error {}
/** Thrown by `admitRecording` when a newer take for the same Item replaced this recording. */
export class TranscriptionAdmissionSuperseded extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptionAdmissionSuperseded";
  }
}
/**
 * Thrown when no Ears call may start: job admissions are closed (a shutdown or a lost lease) or this
 * process does not own execution (lease not yet held, boot recovery still running). Also how a run
 * ends whose call was aborted, or whose result arrived once this process no longer owned execution;
 * that result is discarded, not persisted.
 */
export class TranscriptionExecutionUnavailable extends Error {
  constructor() { super("execution ownership unavailable"); this.name = "TranscriptionExecutionUnavailable"; }
}

export interface TranscriptionRecovery {
  /**
   * Records the stored recording as a transcription job and calls Ears once. Returns `transcribed`
   * when that call succeeds (the Item is then at 'pending' with its transcript), otherwise `accepted`:
   * the job is durable and will be retried. Re-admitting the same bytes for the same Item reuses the
   * existing job and never calls Ears again.
   */
  admitRecording(input: AdmitRecordingInput): Promise<AdmitRecordingResult>;
  /** The User's Retry: runs the Item's current 'failed' job once, without starting a new automatic cycle. */
  retry(jobId: string): Promise<TranscriptionJobVM>;
  /** Runs every due job, resumes every pending scoring handoff, and re-arms the timer. Optionally one Attempt's only. */
  runDueAndReconcile(attemptId?: string): Promise<void>;
  /** The current job per Item, leaving out a 'done' job with no scoring result still to wait for. */
  readAttemptSnapshot(attemptId: string): ReadonlyMap<string, TranscriptionJobVM>;
  /** Aborts every Ears call in flight and writes nothing; called when the execution lease is lost. */
  abortActive?(): void;
  /**
   * The runs in flight in this process, from claim to recorded outcome; a shutdown drain waits for
   * them. Optional, as abortActive and interruptForShutdown are, only so a route test's stand-in need
   * not declare it; the coordinator always has all three.
   */
  activeCount?(): number;
  /**
   * Ends a shutdown drain's remaining Ears calls: each job still 'running' is recorded 'failed' with
   * INTERRUPTED_BY_RESTART_ERROR (retryable kind 'provider', so the User can Retry it), then its call
   * is aborted and its run writes nothing more. Records nothing once this process no longer owns
   * execution, where it only aborts.
   */
  interruptForShutdown?(): void;
}

// ---------------------------------------------------------------------------------------------
// Persistence port
// ---------------------------------------------------------------------------------------------

/**
 * The `transcription_jobs` operations this module makes, declared as members rather than as the
 * whole repo. db/stores/transcription.ts implements it over SQLite.
 *
 * Transcription is not a durableJobRunner family: its shape is create-or-reuse, claim, then persist
 * or schedule a retry, then end through a retry budget. Every write that ends a run is conditional:
 * `claimTranscriptionJob` returns the claimed row or `undefined`, both persist writers return
 * whether they landed, and `updateTranscriptionJob` never writes a 'superseded' or 'done' row.
 *
 * Two members write `item_results` as well as `transcription_jobs`, each in one transaction, so a
 * crash cannot leave a transcript on the Item beside a job that does not record it:
 *
 *   persistRecoveredTranscriptAndAwaitScore  a later run's success: the transcript lands on an Item
 *                                            still at 'transcription_pending' and the job moves to
 *                                            'awaiting_score'.
 *   persistFreshTranscriptAndFinishJob       a first call's success: the Item moves to 'pending'
 *                                            with its transcript and the job to 'done'.
 *
 * `getAttempt` and `insertItemResult` belong to the Attempt aggregate. They are declared here
 * because this module needs them wider than ScoreStore declares them: the Attempt's `set_id` (to
 * frame the Ears prompt from its Set), and an Item row written with its audio path and the
 * 'transcription_pending' status.
 */
export type TranscriptionJobStore = {
  createOrGetTranscriptionJob(i: {
    id: string; attemptId: string; itemId: string; taskType: "listen_repeat" | "interview";
    audioPath: string; audioSha256: string; now: SqliteTimestamp;
  }): TranscriptionJobRow;
  claimTranscriptionJob(i: { id: string; now: SqliteTimestamp }): TranscriptionJobRow | undefined;
  updateTranscriptionJob(i: {
    id: string; status?: TranscriptionJobStatus; automaticAttempts?: number;
    nextRetryAt?: SqliteTimestamp | null; failureKind?: TranscriptionFailureKind | null; error?: string | null;
    scoreJobId?: string | null; now: SqliteTimestamp;
  }): void;
  getTranscriptionJob(id: string): TranscriptionJobRow | undefined;
  getCurrentTranscriptionJobs(attemptId: string): TranscriptionJobRow[];
  listRecoverableTranscriptionJobs(now: SqliteTimestamp): TranscriptionJobRow[];
  listInterruptedTranscriptionJobs(): TranscriptionJobRow[];
  listAwaitingScoreTranscriptionJobs(): TranscriptionJobRow[];
  persistRecoveredTranscriptAndAwaitScore(i: {
    jobId: string; attemptId: string; itemId: string; audioPath: string; audioSha256: string;
    transcript: string; deliveryReport: string; now: SqliteTimestamp;
  }): boolean;
  persistFreshTranscriptAndFinishJob(i: {
    jobId: string; attemptId: string; itemId: string; taskType: string; responseAudioPath: string;
    audioSha256: string; transcript: string; deliveryReport: string; now: SqliteTimestamp;
  }): boolean;
  /** The Response rows this family reads, plus the Attempt's Set — see the port doc above. */
  getAttempt(id: string): { set_id: string; items: ResponseRow[] } | undefined;
  /** Wider than ScoreStore's: transcription writes the audio path and the pending-transcription status. */
  insertItemResult(i: {
    attemptId: string; itemId: string; taskType: string; responseText?: string;
    responseAudioPath?: string; transcript?: string; deliveryReport?: string; scoringStatus?: string;
  }): void;
};

/**
 * The database a store is bound to (`dbFile`), which keys the per-database coordinator memo in
 * createTranscriptionRecovery. Not a store operation: it reads and writes nothing.
 */
export type DatabaseIdentity = { readonly dbFile: string };

/**
 * This module's whole persistence: its own aggregate plus the scoring family's store, which a
 * recovered recording's handoff needs (`enqueueScoringJob`, `listActiveScoringJobsForTask`,
 * `getScoringJob`). ScoringStore's `getAttempt` and `insertItemResult` are left out so the
 * declarations in TranscriptionJobStore are the ones in scope; they still satisfy ScoringStore's,
 * so these deps can be handed to `enqueueScoringJob` as they are.
 */
export type TranscriptionStore =
  TranscriptionJobStore & Omit<ScoringStore, "getAttempt" | "insertItemResult"> & DatabaseIdentity;

/**
 * The scoring family's deps plus this module's own: a recovered recording is scored through
 * `enqueueScoringJob`, which needs the same Judges and Arbiters the /score route uses.
 */
export type TranscriptionRecoveryDeps = Omit<ScoringJobDeps, "repo"> & {
  repo: TranscriptionStore;
  dataDir?: string;
  now?: () => Date;
  setStore?: SetReader;
  hearRecording?: typeof realHearRecording;
  /**
   * Whether this process owns execution: in production the execution owner's readiness (lease held,
   * boot recovery done). While false no Ears call starts and an arriving result is discarded. It
   * stays true through a graceful shutdown's drain, so a call that finishes then is persisted.
   */
  admissionReady?: () => boolean;
  /**
   * Whether a new Ears call may start, the automatic retry timer's included. Defaults to the
   * process-wide job admission gate (jobAdmissionsAreOpen), which closes at the start of a shutdown
   * and on a lost lease.
   */
  admissionsOpen?: () => boolean;
  /**
   * Passed as `onTerminal` to every scoring job this module creates. Defaults to re-running this
   * Attempt's transcription work; a caller that supplies its own (createSpeakingCoordinators) must
   * include that re-run, or a deferred handoff is never retried (see coordinateScoringHandoff).
   */
  onScoringTerminal?: (attemptId: string) => Promise<void> | void;
  /**
   * Fires when a job ends without producing a scoring job, so nothing else will reconcile its
   * Attempt: on 'failed', and on 'done' with no linked scoring job after a later run (the Item was
   * already scored, or had left 'transcription_pending' while Ears ran). Not fired on 'superseded'
   * (the newer job reports its own end), on 'done' with a linked scoring job (that job's
   * `onTerminal` reconciles), or on a first call's success (the Item waits at 'pending' for the
   * client's own score request).
   */
  onTranscriptionTerminal?: (attemptId: string) => Promise<void> | void;
};

const DURABLE_RETRY_DELAYS_MS = [15_000, 60_000, 300_000] as const;
const MAX_AUTOMATIC_ATTEMPTS = 1 + DURABLE_RETRY_DELAYS_MS.length;

/**
 * The `error` a job carries when a restart, not a failure, left it unfinished. The review's
 * transcription panel shows this column, so the User can tell the two apart; a real failure
 * describes the recording or the provider instead.
 *
 * It is not a separate TranscriptionFailureKind: `failure_kind` has a SQLite CHECK over the existing
 * eleven values, which only a table rebuild could change, and such a job behaves exactly like one
 * failed with 'provider', the kind it is given. 'provider' is retryable here and in the client, so
 * the panel offers Retry.
 */
export const INTERRUPTED_BY_RESTART_ERROR = "interrupted by a server restart";

// Failure kinds that end the automatic retries at once. Three come from Ears (authentication,
// configuration, unsupported-audio); three from this module's own checks of the stored recording
// before Ears is called. Every other kind is retried on the automatic schedule.
const TERMINAL_FAILURE_KINDS = new Set<TranscriptionFailureKind>([
  "authentication",
  "configuration",
  "unsupported-audio",
  "unsafe-path",
  "missing-recording",
  "corrupt-recording",
]);

function isRetryable(kind: TranscriptionFailureKind): boolean {
  return !TERMINAL_FAILURE_KINDS.has(kind);
}

function sha256File(realPath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(realPath)).digest("hex");
}

function toVM(job: TranscriptionJobRow): TranscriptionJobVM {
  // Field by field, never a spread of the row: the audio path, hash and ids stay on the server.
  return {
    jobId: job.id,
    status: job.status,
    automaticAttempts: job.automatic_attempts,
    nextRetryAt: sqliteTimestampToIso(job.next_retry_at),
    failureKind: job.failure_kind,
    error: job.error,
    scoreJobId: job.score_job_id,
  };
}

// Whether an Item's stored response_audio_path names the same file as a job's audio_path, in either
// the dataDir-relative or a legacy absolute form (resolveAudioPath). Returns false, never throws,
// for a path that resolves outside dataDir.
function itemPointsAtJobPath(responseAudioPath: string | null, jobAudioPath: string, dataDir: string): boolean {
  try {
    return resolveAudioPath(responseAudioPath ?? "__none__", dataDir) === resolveAudioPath(jobAudioPath, dataDir);
  } catch {
    return false;
  }
}

function safeParseDeliveryReport(json: string | null): DeliveryReport {
  const fallback: DeliveryReport = { paceWpm: null, pauses: "", intelligibility: "", suspectedMispronunciations: [], intonation: "" };
  if (!json) return fallback;
  try {
    return DeliveryReportSchema.parse(JSON.parse(json));
  } catch {
    return fallback;
  }
}

// The Ears framing text for an Item, identical to what routes/attempts.ts's findSpeakingItem builds
// at upload; keep the two in step. A later run rebuilds it from the Set rather than storing it,
// because it quotes Set text (scenario and question), which this module never persists. A published
// Set never changes, so the rebuilt text is the text admission used.
function findSpeakingContext(set: AnySet, itemId: string, taskType: "listen_repeat" | "interview"): string | undefined {
  if (set.kind !== "speaking") return undefined;
  if (taskType === "listen_repeat") {
    const item = set.listenAndRepeat.items.find((i) => i.id === itemId);
    if (!item) return undefined;
    return `Listen and Repeat task. Scenario: ${set.listenAndRepeat.scenarioTitle} — ${set.listenAndRepeat.scenarioDescription}. The test taker just heard a sentence spoken once and is repeating it from memory.`;
  }
  const question = set.interview.questions.find((i) => i.id === itemId);
  if (!question) return undefined;
  return `Interview task. Scenario: ${set.interview.scenarioTitle}. The interviewer asked: "${question.question}"`;
}

type EarsAttemptOutcome =
  | { ok: true; transcript: string; deliveryReport: DeliveryReport }
  | { ok: false; kind: TranscriptionFailureKind; safeMessage: string };

type RecoveryLogFields = {
  attemptId: string;
  itemId: string;
  transcriptionJobId: string;
  scoringJobId: string | null;
  status: TranscriptionJobStatus;
  automaticAttempts: number;
  durationMs: number;
  failureKind: TranscriptionFailureKind | null;
};

// Logs ids, statuses, counts and timings only: never a transcript, Set text, audio or a provider
// response body.
function logRecoveryEvent(fields: RecoveryLogFields): void {
  console.log(`[transcriptionRecovery] ${JSON.stringify(fields)}`);
}

/**
 * Renders a caught error for a log line as its name plus its `code` (truncated to 40 characters),
 * never its message: a message can quote its input (a JSON.parse SyntaxError embeds a fragment of
 * the text it failed on), and Set text and transcripts must not reach a log. Use it wherever an
 * arbitrary caught error is logged.
 */
export function safeErrorDescriptor(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") return `${err.name} (${String(code).slice(0, 40)})`;
  return err.name;
}

// One coordinator per database per process. Its timer, its in-flight set and its Ears abort
// controllers are per instance: two instances over one database would each arm a scheduler over the
// same rows and each abort only its own Ears calls when the lease is lost. The claim keeps them from
// running one job twice, but nothing would keep their timing or their shutdown coherent.
//
// So construction is memoized per database, and a second call returns the existing coordinator.
// Memoized rather than refused, so each test's private in-memory database still gets its own. The
// memo has two keys: the repo object (a WeakMap, so a discarded test repo is not retained), and the
// database file (`repo.dbFile`), which also catches a second store object opened over the same file.
// A private database (`:memory:` or "") has no file key: no other handle can reach it.
type MemoizedCoordinator = { generation: number; coordinator: TranscriptionRecovery };
// Bumped only by resetTranscriptionCoordinatorsForNewProcess; an entry from an earlier generation is
// ignored, which is how the WeakMap (no `clear()`) is invalidated too.
let coordinatorGeneration = 0;
const coordinatorsByRepo = new WeakMap<object, MemoizedCoordinator>();
const coordinatorsByDbFile = new Map<string, MemoizedCoordinator>();

/**
 * Whether two handles naming this `dbFile` are handles on the same database: true for a file, false
 * for a private database (`:memory:`, or "" for an anonymous temporary one), which only its own
 * handle can reach. Shared with speakingFinalization's memo, which keys the same way.
 */
export function isSharedDatabaseFile(dbFile: string): boolean {
  return dbFile !== ":memory:" && dbFile !== "";
}

function currentEntry(entry: MemoizedCoordinator | undefined): TranscriptionRecovery | undefined {
  return entry && entry.generation === coordinatorGeneration ? entry.coordinator : undefined;
}

function existingCoordinatorFor(repo: TranscriptionRecoveryDeps["repo"]): TranscriptionRecovery | undefined {
  return (
    currentEntry(coordinatorsByRepo.get(repo)) ??
    (isSharedDatabaseFile(repo.dbFile) ? currentEntry(coordinatorsByDbFile.get(repo.dbFile)) : undefined)
  );
}

/**
 * Test-only: forgets every memoized coordinator, as a process restart would. A test that simulates a
 * restart over the same database needs it, or it gets the old coordinator back with its old
 * in-flight set and timer. Production never calls it.
 */
export function resetTranscriptionCoordinatorsForNewProcess(): void {
  coordinatorGeneration += 1;
  coordinatorsByDbFile.clear();
}

/**
 * The memo generation, bumped by each reset. speakingFinalization's memo reads it, so a bundle built
 * before a reset is never handed back holding a coordinator this module has since replaced.
 */
export function currentCoordinatorGeneration(): number {
  return coordinatorGeneration;
}

/** Builds the coordinator for `deps.repo`'s database, or returns the one already built for it. */
export function createTranscriptionRecovery(deps: TranscriptionRecoveryDeps): TranscriptionRecovery {
  const repo = deps.repo;
  const existing = existingCoordinatorFor(repo);
  if (existing) {
    console.warn(
      "[transcriptionRecovery] createTranscriptionRecovery was called more than once for the same database; returning the existing coordinator. Two coordinators over one database would each run a retry timer over the same jobs and abort only their own Ears calls when execution ownership is lost. Build it once in the composition root and share that instance.",
    );
    return existing;
  }
  const hearRecording = deps.hearRecording ?? realHearRecording;
  const dataDir = deps.dataDir ?? config.dataDir;
  const setStore = deps.setStore ?? createSetStore(dataDir);
  const now = deps.now ?? (() => new Date());
  const admissionReady = deps.admissionReady ?? (() => true);
  const admissionsOpen = deps.admissionsOpen ?? jobAdmissionsAreOpen;
  // The gate in front of every Ears call. admissionReady alone decides whether a result that arrives
  // is kept, so a call already running when admissions close is drained, not discarded.
  const mayStartEars = () => admissionReady() && admissionsOpen();
  // A handoff deferred behind another active scoring job of the same Task Type leaves its job at
  // 'awaiting_score', which the timer never schedules. Re-running this Attempt's work when a scoring
  // job ends is what retries that handoff, with no polling.
  const onScoringTerminal =
    deps.onScoringTerminal ??
    ((attemptId: string) => {
      void runDueAndReconcile(attemptId).catch((err) =>
        console.error("[transcriptionRecovery] onScoringTerminal re-drive failed:", safeErrorDescriptor(err))
      );
    });

  // The one place onTranscriptionTerminal fires. A throwing hook is logged and swallowed: the
  // outcome is already recorded, and this runs on workers, timers and request handlers alike.
  async function notifyTranscriptionTerminal(attemptId: string): Promise<void> {
    if (!deps.onTranscriptionTerminal) return;
    try {
      await deps.onTranscriptionTerminal(attemptId);
    } catch (err) {
      console.error("[transcriptionRecovery] onTranscriptionTerminal threw:", safeErrorDescriptor(err));
    }
  }

  // Jobs a run in this process is working on. The due scan skips them (the claim alone already
  // prevents a second claim) and rescheduleTimer leaves them out until their run records an outcome.
  const inFlightJobIds = new Set<string>();
  const activeEars = new Map<string, AbortController>();
  let timerHandle: NodeJS.Timeout | null = null;

  function buildContext(job: TranscriptionJobRow): string | undefined {
    const attempt = repo.getAttempt(job.attempt_id);
    if (!attempt) return undefined;
    const set = setStore.readSet(attempt.set_id);
    if (!set) return undefined;
    return findSpeakingContext(set, job.item_id, job.task_type);
  }

  // The one place Ears is called, for a first call, an automatic retry and a manual retry alike.
  // Checks the stored recording first (inside dataDir, present, at its canonical path, same hash as
  // when admitted), then, if `checkItemStillCurrent`, that the Item still points at it: `skip` means a
  // later take replaced it. A first call passes false, because runClaimedAttempt has just written the
  // Item row pointing at this recording.
  async function attemptEars(
    job: TranscriptionJobRow,
    context: string | undefined,
    checkItemStillCurrent: boolean,
  ): Promise<EarsAttemptOutcome | { ok: "skip" }> {
    if (!mayStartEars()) throw new TranscriptionExecutionUnavailable();
    // The lexical bound check comes first and needs no file. resolveRealPathWithinBase calls
    // fs.realpathSync, which throws for a missing file, so checking existence in between is what
    // reports a deleted recording as missing rather than as an unsafe path.
    let lexicalPath: string;
    try {
      lexicalPath = resolvePathWithinBase(job.audio_path, dataDir);
    } catch {
      return { ok: false, kind: "unsafe-path", safeMessage: "recording path is unsafe" };
    }
    if (!fs.existsSync(lexicalPath)) {
      return { ok: false, kind: "missing-recording", safeMessage: "recording is missing" };
    }

    let realPath: string;
    try {
      realPath = resolveRealPathWithinBase(job.audio_path, dataDir);
    } catch {
      return { ok: false, kind: "unsafe-path", safeMessage: "recording path is unsafe" };
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(realPath);
    } catch {
      return { ok: false, kind: "missing-recording", safeMessage: "recording is missing" };
    }

    const expectedRelative = path.join("audio/responses", job.attempt_id, `${job.item_id}.webm`);
    const isExpectedPath = path.resolve(dataDir, job.audio_path) === path.resolve(dataDir, expectedRelative);
    if (!stat.isFile() || !job.audio_path.endsWith(".webm") || !isExpectedPath) {
      return { ok: false, kind: "corrupt-recording", safeMessage: "recording does not match the expected canonical path" };
    }

    if (sha256File(realPath) !== job.audio_sha256) {
      return { ok: false, kind: "corrupt-recording", safeMessage: "recording content no longer matches the accepted hash" };
    }

    if (checkItemStillCurrent) {
      const attempt = repo.getAttempt(job.attempt_id);
      const item = attempt?.items.find((i) => i.item_id === job.item_id);
      if (!item) {
        // No Item row is not staleness: a process death between the first claim and
        // runClaimedAttempt's claim-time write, or a throw from that write, leaves this shape.
        // Treating it as `skip` would supersede the job and strand an accepted recording. Write the
        // row that claim-time write would have written, so the paid Ears result has the
        // 'transcription_pending' row that persistRecoveredTranscriptAndAwaitScore requires.
        repo.insertItemResult({
          attemptId: job.attempt_id, itemId: job.item_id, taskType: job.task_type,
          responseAudioPath: job.audio_path, scoringStatus: "transcription_pending",
        });
      } else {
        let itemStillCurrent: boolean;
        try {
          itemStillCurrent = resolveAudioPath(item.response_audio_path ?? "__none__", dataDir) === resolveAudioPath(job.audio_path, dataDir);
        } catch {
          // A legacy absolute response_audio_path outside dataDir (a backup restored from another
          // machine, say) makes resolveAudioPath throw; it is classified, not let escape a timer.
          return { ok: false, kind: "unsafe-path", safeMessage: "recording path is unsafe" };
        }
        if (!itemStillCurrent) return { ok: "skip" };
      }
    }

    const controller = new AbortController();
    activeEars.set(job.id, controller);
    try {
      const result = await hearRecording({ audioPath: realPath, mimeType: "audio/webm", context, signal: controller.signal });
      if (controller.signal.aborted || !admissionReady()) throw new TranscriptionExecutionUnavailable();
      return { ok: true, transcript: result.transcript, deliveryReport: result.deliveryReport };
    } catch (err) {
      if (controller.signal.aborted || !admissionReady() || err instanceof TranscriptionExecutionUnavailable) throw new TranscriptionExecutionUnavailable();
      if (err instanceof EarsError) return { ok: false, kind: err.kind, safeMessage: err.safeMessage };
      return { ok: false, kind: "provider", safeMessage: "transcription failed unexpectedly" };
    } finally {
      activeEars.delete(job.id);
    }
  }

  // Records one failed run on the job. A manual run returns it to 'failed' and leaves
  // automatic_attempts alone, so a Retry never starts a new automatic cycle. An automatic run counts
  // one attempt and schedules the next delay, unless the kind is terminal or this was the fourth
  // automatic attempt; then the job is 'failed', which the User can still Retry.
  function finalizeAutomaticOrManualFailure(
    job: TranscriptionJobRow,
    outcome: { kind: TranscriptionFailureKind; safeMessage: string },
    manual: boolean,
    nowDate: Date,
  ): void {
    const nowStr = sqliteTimestamp(nowDate);
    if (manual) {
      // A 'failed' job never carries a next_retry_at: the snapshot would show automatic work that
      // no timer will run.
      repo.updateTranscriptionJob({ id: job.id, status: "failed", nextRetryAt: null, failureKind: outcome.kind, error: outcome.safeMessage, now: nowStr });
      return;
    }
    const nextAttemptNumber = job.automatic_attempts + 1;
    const exhausted = !isRetryable(outcome.kind) || nextAttemptNumber >= MAX_AUTOMATIC_ATTEMPTS;
    // `automaticAttempts: 1` does not set the counter to 1. Its presence makes updateTranscriptionJob
    // increment the column in SQL (`automatic_attempts + 1`), so two concurrent writers cannot
    // collapse into one increment; the value itself is ignored.
    if (exhausted) {
      repo.updateTranscriptionJob({ id: job.id, status: "failed", automaticAttempts: 1, nextRetryAt: null, failureKind: outcome.kind, error: outcome.safeMessage, now: nowStr });
      return;
    }
    const delayMs = DURABLE_RETRY_DELAYS_MS[nextAttemptNumber - 1];
    const nextRetryAt = sqliteTimestamp(new Date(nowDate.getTime() + delayMs));
    repo.updateTranscriptionJob({ id: job.id, status: "retry_wait", automaticAttempts: 1, nextRetryAt, failureKind: outcome.kind, error: outcome.safeMessage, now: nowStr });
    rescheduleTimer();
  }

  // Turns an unexpected throw out of a claimed run (a filesystem error hashing the recording, a
  // database error) into a recorded failure. Without it the row stays 'running', which no pass of
  // this coordinator picks up and retry() refuses: stranded until a restart. Every site that claims
  // a job (admitRecording, retry, processDueJob) routes its throws here.
  //
  // The kind is 'provider', the retryable kind for a fault with no better classification, so the
  // job goes through the ordinary failure path to 'retry_wait' or 'failed'. A throw from this
  // function itself (the database is what is broken) is left to reach the caller.
  async function recordUnexpectedAttemptFailure(claimed: TranscriptionJobRow, manual: boolean, err: unknown, site: string): Promise<void> {
    console.error(`[transcriptionRecovery] ${site} threw unexpectedly for job ${claimed.id}:`, safeErrorDescriptor(err));
    const stuck = repo.getTranscriptionJob(claimed.id);
    if (stuck && stuck.status === "running") {
      finalizeAutomaticOrManualFailure(claimed, { kind: "provider", safeMessage: "unexpected failure processing this job" }, manual, now());
      if (repo.getTranscriptionJob(claimed.id)?.status === "failed") await notifyTranscriptionTerminal(claimed.attempt_id);
    }
  }

  // Hands an 'awaiting_score' job's Item to scoring: if the Item is already scored, the job is 'done'
  // with no scoring job; if a scoring job of the same Task Type is active, nothing happens until a
  // later pass (onScoringTerminal re-runs one when that job ends); otherwise one one-Item scoring job
  // is created and linked to this job.
  async function coordinateScoringHandoff(transcriptionJobId: string): Promise<void> {
    const job = repo.getTranscriptionJob(transcriptionJobId);
    if (!job || job.status !== "awaiting_score") return;

    const nowStr = sqliteTimestamp(now());
    const attempt = repo.getAttempt(job.attempt_id);
    const item = attempt?.items.find((i) => i.item_id === job.item_id);
    if (item?.scoring_status === "scored") {
      repo.updateTranscriptionJob({ id: job.id, status: "done", now: nowStr });
      // No scoring job will end for this Item and no score request is coming, so this is the only
      // signal its Attempt gets.
      await notifyTranscriptionTerminal(job.attempt_id);
      return;
    }

    // Checked here because enqueueScoringJob's recovery branch returns null both when it must wait
    // for active work and when the handoff is stale; only this check tells the two apart.
    if (repo.listActiveScoringJobsForTask(job.attempt_id, job.task_type).length > 0) return;

    if (!attempt) return;
    const set = setStore.readSet(attempt.set_id);
    if (!set) return; // can't build a scoring request without the set; a later pass retries

    const oneItemRequest: ScoreRequest =
      job.task_type === "listen_repeat"
        ? { taskType: "listen_repeat", items: [{ itemId: job.item_id }] }
        : { taskType: "interview", items: [{ itemId: job.item_id }] };

    enqueueScoringJob(
      deps,
      { attemptId: job.attempt_id, set, request: oneItemRequest },
      { supersedeActive: false, transcriptionJobId: job.id, onTerminal: onScoringTerminal },
    );
    // A null return launches nothing; a job still at 'awaiting_score' is retried by a later pass.
  }

  // One run of a job this process has just claimed ('running'): a first call, an automatic retry or
  // a manual retry. Records the outcome on the job and returns it, so admitRecording can answer
  // without re-reading the Item.
  async function runClaimedAttempt(
    claimed: TranscriptionJobRow,
    opts: { manual: boolean; freshAdmission: boolean; adhocContext?: string },
  ): Promise<EarsAttemptOutcome | { ok: "skip" }> {
    if (opts.freshAdmission) {
      // Written before the first Ears call, so the Item row and the job exist together for the whole
      // call. If the process dies mid-call, the boot sweep fails the job and the User's Retry finds
      // the Item at 'transcription_pending' pointing at this recording, which is what a later run
      // checks and persistRecoveredTranscriptAndAwaitScore requires. On a re-record this also clears
      // the previous take's transcript, Delivery Report and score, so the Item is not scored on the
      // take the User replaced.
      repo.insertItemResult({
        attemptId: claimed.attempt_id, itemId: claimed.item_id, taskType: claimed.task_type,
        responseAudioPath: claimed.audio_path, scoringStatus: "transcription_pending",
      });
    }
    const context = opts.adhocContext ?? (await buildContext(claimed));
    const started = Date.now();
    const outcome = await attemptEars(claimed, context, !opts.freshAdmission);
    const durationMs = Date.now() - started;
    const nowDate = now();
    const nowStr = sqliteTimestamp(nowDate);

    if (outcome.ok === "skip") {
      // The Item no longer points at this recording. Mark the job superseded so it does not stay
      // 'running' (a no-op if it already is superseded).
      repo.updateTranscriptionJob({ id: claimed.id, status: "superseded", now: nowStr });
      return outcome;
    }

    if (outcome.ok) {
      if (opts.freshAdmission) {
        // The transcript and the job's 'done' commit in one transaction, which lands only while this
        // job is still the Item's current, running take. If a newer take replaced it, nothing lands
        // and the admission reports the recording superseded rather than a stale success.
        const persisted = repo.persistFreshTranscriptAndFinishJob({
          jobId: claimed.id, attemptId: claimed.attempt_id, itemId: claimed.item_id,
          taskType: claimed.task_type, responseAudioPath: claimed.audio_path,
          audioSha256: claimed.audio_sha256,
          transcript: outcome.transcript, deliveryReport: JSON.stringify(outcome.deliveryReport),
          now: nowStr,
        });
        if (!persisted) return { ok: "skip" };
        const freshDone = repo.getTranscriptionJob(claimed.id);
        logRecoveryEvent({
          attemptId: claimed.attempt_id, itemId: claimed.item_id, transcriptionJobId: claimed.id,
          scoringJobId: freshDone?.score_job_id ?? null, status: freshDone?.status ?? "done",
          automaticAttempts: claimed.automatic_attempts, durationMs, failureKind: null,
        });
        return outcome;
      }
      const persisted = repo.persistRecoveredTranscriptAndAwaitScore({
        jobId: claimed.id, attemptId: claimed.attempt_id, itemId: claimed.item_id,
        audioPath: claimed.audio_path, audioSha256: claimed.audio_sha256,
        transcript: outcome.transcript, deliveryReport: JSON.stringify(outcome.deliveryReport),
        now: nowStr,
      });
      if (persisted) {
        await coordinateScoringHandoff(claimed.id);
      } else {
        // Refused: either the job was superseded while Ears ran (it is already 'superseded'), or the
        // Item left 'transcription_pending' some other way. In the second case Ears succeeded, so
        // the job is 'done', never 'failed': a Retry would pay for Ears again only to be refused
        // again, since the Item never returns to 'transcription_pending'. Left alone, the job would
        // stay 'running', which nothing picks up.
        const stuck = repo.getTranscriptionJob(claimed.id);
        if (stuck && stuck.status !== "superseded" && stuck.status !== "done") {
          // Clears the failure fields an earlier retry_wait left, as the success path's transaction does.
          repo.updateTranscriptionJob({ id: claimed.id, status: "done", nextRetryAt: null, failureKind: null, error: null, now: nowStr });
        }
      }
      const after = repo.getTranscriptionJob(claimed.id);
      logRecoveryEvent({
        attemptId: claimed.attempt_id, itemId: claimed.item_id, transcriptionJobId: claimed.id,
        scoringJobId: after?.score_job_id ?? null, status: after?.status ?? claimed.status,
        automaticAttempts: claimed.automatic_attempts, durationMs, failureKind: null,
      });
      // The refused persist above ended the job 'done' with no scoring job, so nothing else will
      // signal its Attempt. A landed transcript's handoff signals on its own when it ends the job
      // that way (the Item turned out to be scored), so this runs only for the refusal.
      if (!persisted && after?.status === "done" && after.score_job_id === null) await notifyTranscriptionTerminal(claimed.attempt_id);
      return outcome;
    }

    finalizeAutomaticOrManualFailure(claimed, outcome, opts.manual, nowDate);
    const after = repo.getTranscriptionJob(claimed.id);
    logRecoveryEvent({
      attemptId: claimed.attempt_id, itemId: claimed.item_id, transcriptionJobId: claimed.id,
      scoringJobId: claimed.score_job_id, status: after?.status ?? "failed",
      automaticAttempts: after?.automatic_attempts ?? claimed.automatic_attempts,
      durationMs, failureKind: outcome.kind,
    });
    // Only 'failed' ends the job; a 'retry_wait' job has a timer and will end later.
    if (after?.status === "failed") await notifyTranscriptionTerminal(claimed.attempt_id);
    return outcome;
  }

  async function admitRecording(input: AdmitRecordingInput): Promise<AdmitRecordingResult> {
    if (!mayStartEars()) throw new TranscriptionExecutionUnavailable();
    let realPath: string;
    try {
      realPath = resolveRealPathWithinBase(input.recordingPath, dataDir);
    } catch {
      // Recording intake builds this path right after publishing the file, so an unsafe one is a
      // caller bug, not the User's: fail closed.
      throw new Error(`admitRecording: recordingPath is unsafe: ${input.recordingPath}`);
    }
    const sha256 = sha256File(realPath);
    const candidateId = crypto.randomUUID();
    const nowStr = sqliteTimestamp(now());
    const job = repo.createOrGetTranscriptionJob({
      id: candidateId, attemptId: input.attemptId, itemId: input.itemId, taskType: input.taskType,
      audioPath: input.recordingPath, audioSha256: sha256, now: nowStr,
    });

    if (job.id !== candidateId) {
      // These exact bytes already have a job for this Item, which createOrGetTranscriptionJob
      // returns unchanged in whatever state it is in. Answer from the current state; never call
      // Ears again.
      const current = currentJobsByItem(job.attempt_id).get(job.item_id);
      if (!current || current.id !== job.id || current.audio_sha256 !== sha256) {
        throw new TranscriptionAdmissionSuperseded("recording was superseded by a newer take");
      }
      const attempt = repo.getAttempt(job.attempt_id);
      const item = attempt?.items.find((i) => i.item_id === job.item_id);
      if (item?.transcript != null && itemPointsAtJobPath(item.response_audio_path, job.audio_path, dataDir)) {
        return { kind: "transcribed", transcript: item.transcript, deliveryReport: safeParseDeliveryReport(item.delivery_report) };
      }
      return { kind: "accepted", job: toVM(job) };
    }

    const claimed = repo.claimTranscriptionJob({ id: job.id, now: nowStr });
    if (!claimed) {
      // Unreachable while the row was inserted 'queued' in this same synchronous block. Should it
      // happen, the job is durable: report it accepted and let the scheduler run it, never run an
      // unclaimed row.
      rescheduleTimer();
      return { kind: "accepted", job: toVM(repo.getTranscriptionJob(job.id) ?? job) };
    }
    inFlightJobIds.add(claimed.id);
    try {
      try {
        const outcome = await runClaimedAttempt(claimed, { manual: false, freshAdmission: true, adhocContext: input.context });
        if (outcome.ok === true) {
          return { kind: "transcribed", transcript: outcome.transcript, deliveryReport: outcome.deliveryReport };
        }
        if (outcome.ok === "skip") {
          throw new TranscriptionAdmissionSuperseded("recording was superseded while transcription was running");
        }
      } catch (err) {
        if (err instanceof TranscriptionAdmissionSuperseded || err instanceof TranscriptionExecutionUnavailable) throw err;
        // Answered as 'accepted', not rethrown: the failure is recorded on the job (normally as
        // 'retry_wait') and the `finally` arms its timer, so the recording is kept and will be
        // retried. A 500 would tell the User it was lost. Re-posting the same bytes reuses the job.
        await recordUnexpectedAttemptFailure(claimed, false, err, "admitRecording");
      }
      return { kind: "accepted", job: toVM(repo.getTranscriptionJob(claimed.id) ?? claimed) };
    } finally {
      inFlightJobIds.delete(claimed.id);
      // Every rescheduleTimer call made during this run skipped this job as in flight, so this call,
      // after the delete, is what schedules its retry when it is the only outstanding recording.
      // rescheduleTimer never throws, so it cannot mask an error from the `try`.
      rescheduleTimer();
    }
  }

  // A row read moments earlier in the same call that is now gone fails with an error naming the
  // job, not a bare TypeError.
  function requireJobRow(jobId: string): TranscriptionJobRow {
    const row = repo.getTranscriptionJob(jobId);
    if (!row) throw new Error(`transcription job ${jobId} disappeared mid-operation`);
    return row;
  }

  async function retry(jobId: string): Promise<TranscriptionJobVM> {
    if (!mayStartEars()) throw new TranscriptionExecutionUnavailable();
    const job = repo.getTranscriptionJob(jobId);
    if (!job || job.status !== "failed") {
      throw new TranscriptionJobNotRetryable(`retry: transcription job ${jobId} is not a manually-retryable failed job`);
    }
    // 'failed' is not enough: a re-record does not supersede a job that has already failed, so a
    // 'failed' job may belong to a take the User has since replaced.
    const current = currentJobsByItem(job.attempt_id).get(job.item_id);
    if (!current || current.id !== job.id) {
      throw new TranscriptionJobNotRetryable(`retry: transcription job ${jobId} is not the current job for its item`);
    }
    const nowStr = sqliteTimestamp(now());
    // Queued and claimed with no `await` between, so nothing interleaves; the claim's
    // compare-and-set on 'queued' is what keeps two retries from both running the job.
    repo.updateTranscriptionJob({ id: jobId, status: "queued", now: nowStr });
    const claimed = repo.claimTranscriptionJob({ id: jobId, now: nowStr });
    if (!claimed) {
      // Another run owns the job: answer with its current state.
      return toVM(requireJobRow(jobId));
    }
    inFlightJobIds.add(claimed.id);
    try {
      try {
        await runClaimedAttempt(claimed, { manual: true, freshAdmission: false });
      } catch (err) {
        if (err instanceof TranscriptionExecutionUnavailable) throw err;
        // As a manual run: the job returns to 'failed', which the User can Retry again.
        await recordUnexpectedAttemptFailure(claimed, true, err, "retry");
      }
      return toVM(requireJobRow(jobId));
    } finally {
      inFlightJobIds.delete(claimed.id);
      // Re-armed after the delete, as in admitRecording: calls made during the run skipped this job.
      rescheduleTimer();
    }
  }

  async function processDueJob(job: TranscriptionJobRow): Promise<void> {
    if (!mayStartEars()) return;
    const nowStr = sqliteTimestamp(now());
    // The claim is what keeps two passes from running one job; the caller's in-flight filter only
    // saves a wasted claim.
    const claimed = repo.claimTranscriptionJob({ id: job.id, now: nowStr });
    if (!claimed) return;
    inFlightJobIds.add(claimed.id);
    try {
      // Every row claimed here was queued or scheduled by the automatic path: retry() claims the row
      // it queues in the same synchronous step, and boot fails every queued row a restart leaves. So
      // a row whose automatic budget is spent should never arrive; if one does, it runs as manual
      // rather than starting a new automatic cycle.
      const runAsManual = claimed.automatic_attempts >= MAX_AUTOMATIC_ATTEMPTS;
      try {
        await runClaimedAttempt(claimed, { manual: runAsManual, freshAdmission: false });
      } catch (err) {
        if (err instanceof TranscriptionExecutionUnavailable) return;
        await recordUnexpectedAttemptFailure(claimed, runAsManual, err, "processDueJob");
      }
    } finally {
      inFlightJobIds.delete(claimed.id);
    }
  }

  async function runDueAndReconcile(attemptId?: string): Promise<void> {
    // Closed admissions stop the retry timer's pass too: a shutdown drain must not start a new paid
    // call, and the next boot's sweep settles whatever is still waiting.
    if (!mayStartEars()) return;
    // The `finally` re-arms the timer even when this pass throws; without it the automatic retries
    // would stop until something else re-armed it. The per-job catches keep one broken job from
    // blocking the rest of the pass.
    try {
      const nowStr = sqliteTimestamp(now());

      // Never a 'running' row: listRecoverableTranscriptionJobs returns queued and due retry_wait
      // rows only. A 'running' row belongs to a live run, since boot recovery fails every row a
      // previous process left running before any job is admitted, and resuming it would pay Ears
      // twice for one recording.
      const due = repo
        .listRecoverableTranscriptionJobs(nowStr)
        .filter((j) => (attemptId === undefined || j.attempt_id === attemptId) && !inFlightJobIds.has(j.id));
      for (const job of due) {
        try {
          await processDueJob(job);
        } catch (err) {
          console.error(`[transcriptionRecovery] processDueJob threw unexpectedly for job ${job.id}:`, safeErrorDescriptor(err));
        }
      }

      const awaitingScore = repo
        .listAwaitingScoreTranscriptionJobs()
        .filter((j) => attemptId === undefined || j.attempt_id === attemptId);
      for (const job of awaitingScore) {
        try {
          await coordinateScoringHandoff(job.id);
        } catch (err) {
          console.error(`[transcriptionRecovery] coordinateScoringHandoff threw unexpectedly for job ${job.id}:`, safeErrorDescriptor(err));
        }
      }
    } finally {
      rescheduleTimer();
    }
  }

  // Arms one unref'd timer for the nearest due job not in flight: a queued job is due now, a
  // retry_wait job at its next_retry_at. Never throws (failures are logged), because it runs in
  // `finally` blocks where a throw would replace the error already propagating.
  function rescheduleTimer(): void {
    try {
      if (timerHandle) {
        clearTimeout(timerHandle);
        timerHandle = null;
      }
      // A cutoff past every next_retry_at, so every queued and retry_wait job is listed. The column
      // compares as a string, so the cutoff is minted by sqliteTimestamp like every other value
      // compared with it.
      const FAR_FUTURE = sqliteTimestamp(new Date("9999-12-31T23:59:59Z"));
      const jobs = repo.listRecoverableTranscriptionJobs(FAR_FUTURE).filter((j) => !inFlightJobIds.has(j.id));
      if (jobs.length === 0) return;

      const nowMs = now().getTime();
      let soonestMs = Infinity;
      for (const j of jobs) {
        const dueMs = j.status === "queued" ? nowMs : parseSqliteTimestamp(j.next_retry_at!).getTime();
        if (dueMs < soonestMs) soonestMs = dueMs;
      }
      const delayMs = Math.max(0, soonestMs - nowMs);
      timerHandle = setTimeout(() => {
        timerHandle = null;
        void runDueAndReconcile().catch((err) => console.error("[transcriptionRecovery] reconcile timer failed:", safeErrorDescriptor(err)));
      }, delayMs);
      timerHandle.unref?.();
    } catch (err) {
      console.error("[transcriptionRecovery] rescheduleTimer failed:", safeErrorDescriptor(err));
    }
  }

  // The newest non-superseded job per Item. A re-record does not supersede a job that already ended
  // ('failed' or 'done'), so an Item can have several non-superseded jobs; the rows come oldest
  // first (created_at, rowid), so the last one written into the map is the current take's.
  function currentJobsByItem(attemptId: string): Map<string, TranscriptionJobRow> {
    const newest = new Map<string, TranscriptionJobRow>();
    for (const job of repo.getCurrentTranscriptionJobs(attemptId)) {
      newest.set(job.item_id, job);
    }
    return newest;
  }

  function readAttemptSnapshot(attemptId: string): ReadonlyMap<string, TranscriptionJobVM> {
    const attempt = repo.getAttempt(attemptId);
    const itemsById = new Map((attempt?.items ?? []).map((i) => [i.item_id, i]));
    const map = new Map<string, TranscriptionJobVM>();
    // The omission rule below applies to the current job only, so an earlier take's failure never
    // shows in place of a later take's success.
    for (const [itemId, job] of currentJobsByItem(attemptId)) {
      if (job.status === "done") {
        const item = itemsById.get(itemId);
        // A 'done' job with no linked scoring job has nothing to show and is left out. One with a
        // linked scoring job stays until that result lands: the Item is scored or failed, or the
        // scoring job has ended (or is gone) without writing one, which leaves the Item rescorable
        // and nothing more for this panel to wait for.
        const scoreJob = job.score_job_id ? repo.getScoringJob(job.score_job_id) : undefined;
        const scoreJobSettled =
          !!job.score_job_id && (!scoreJob || scoreJob.status === "done" || scoreJob.status === "failed" || scoreJob.status === "cancelled");
        const resultLanded =
          !job.score_job_id || item?.scoring_status === "scored" || item?.scoring_status === "failed" || scoreJobSettled;
        if (resultLanded) continue;
      }
      map.set(itemId, toVM(job));
    }
    return map;
  }

  // Records each interrupted job before aborting its call, synchronously, so the row is settled
  // however soon the process exits; the aborted run then ends in TranscriptionExecutionUnavailable
  // and writes nothing. A job no longer 'running' (a re-record superseded it) is left as it is.
  function interruptForShutdown(): void {
    const owned = admissionReady();
    const interrupted: string[] = [];
    for (const [jobId, controller] of activeEars) {
      if (owned && repo.getTranscriptionJob(jobId)?.status === "running") {
        repo.updateTranscriptionJob({
          id: jobId, status: "failed", nextRetryAt: null,
          failureKind: "provider", error: INTERRUPTED_BY_RESTART_ERROR, now: sqliteTimestamp(now()),
        });
        const attemptId = repo.getTranscriptionJob(jobId)?.attempt_id;
        if (attemptId) interrupted.push(attemptId);
      }
      controller.abort(new TranscriptionExecutionUnavailable());
    }
    // Reconciled as any other 'failed' outcome is; the hook catches its own faults.
    for (const attemptId of interrupted) void notifyTranscriptionTerminal(attemptId);
  }

  const coordinator: TranscriptionRecovery = {
    admitRecording,
    retry,
    runDueAndReconcile,
    readAttemptSnapshot,
    abortActive: () => {
      for (const controller of activeEars.values()) controller.abort(new TranscriptionExecutionUnavailable());
    },
    activeCount: () => inFlightJobIds.size,
    interruptForShutdown,
  };
  // Memoized only once construction has succeeded, so a throw above never leaves a half-built one.
  const entry: MemoizedCoordinator = { generation: coordinatorGeneration, coordinator };
  coordinatorsByRepo.set(repo, entry);
  if (isSharedDatabaseFile(repo.dbFile)) coordinatorsByDbFile.set(repo.dbFile, entry);
  return coordinator;
}

// ---------------------------------------------------------------------------------------------
// Boot sweeps. Bookkeeping only, and not part of the coordinator: they call no Ears, create no
// scoring job and fire no hook. After a restart nothing resumes on its own, so every piece of
// transcription work the previous process left ends in a state the User can act on, at no cost.
// ---------------------------------------------------------------------------------------------

/**
 * The transcription family's boot-only members. Not on TranscriptionJobStore, so no route can reach
 * a sweep over every Attempt's Items.
 */
export type TranscriptionBootStore = {
  listTranscriptionPendingItemsWithoutJob(): { attemptId: string; itemId: string; taskType: string; responseAudioPath: string | null }[];
  insertFailedTranscriptionJob(i: {
    id: string; attemptId: string; itemId: string; taskType: "listen_repeat" | "interview";
    audioPath: string; audioSha256: string; failureKind: TranscriptionFailureKind; error: string; now: SqliteTimestamp;
  }): boolean;
};

export type TranscriptionBootSweepOptions = {
  setStore?: SetReader;
  /** Told about every Attempt whose transcription work or Items this sweep settled. */
  onAttemptChanged?: (attemptId: string) => void;
};

/**
 * Settles every transcription job a restart left unfinished, and returns how many it settled.
 *
 *   running, queued, retry_wait  -> 'failed' with INTERRUPTED_BY_RESTART_ERROR and the retryable
 *                                   kind 'provider': the state retry() accepts and the client offers
 *                                   Retry for. A death during the Ears call records no outcome, and a
 *                                   queued or waiting job would resume only if something in the new
 *                                   process happened to arm the scheduler — paid work boot must not
 *                                   start. A waiting job's remaining automatic retries are forfeited;
 *                                   from here a retry is the User's.
 *   awaiting_score               -> 'done'. Ears already succeeded and the transcript is on the Item;
 *                                   only the scoring handoff, which is paid, never happened. The Item
 *                                   is settled the way a stranded scoring job's are
 *                                   (settleStrandedItems): rescorable, or a no-speech 0.
 *
 * `automatic_attempts` is left alone: it bounds paid calls, and this buys none.
 * Idempotent across boots — every row it writes leaves the statuses it selects.
 */
export function failInterruptedTranscriptionJobs(
  repo: TranscriptionRecoveryDeps["repo"],
  now: () => Date = () => new Date(),
  options: TranscriptionBootSweepOptions = {},
): number {
  const nowStr = sqliteTimestamp(now());
  const setStore = options.setStore ?? createSetStore();
  const FAR_FUTURE = sqliteTimestamp(new Date("9999-12-31T23:59:59Z"));
  let settled = 0;
  const unfinished = [...repo.listInterruptedTranscriptionJobs(), ...repo.listRecoverableTranscriptionJobs(FAR_FUTURE)];
  for (const job of unfinished) {
    // A 'failed' row never carries a next_retry_at that no timer will serve.
    repo.updateTranscriptionJob({
      id: job.id, status: "failed", nextRetryAt: null,
      failureKind: "provider", error: INTERRUPTED_BY_RESTART_ERROR, now: nowStr,
    });
    options.onAttemptChanged?.(job.attempt_id);
    settled += 1;
  }
  for (const job of repo.listAwaitingScoreTranscriptionJobs()) {
    repo.updateTranscriptionJob({ id: job.id, status: "done", now: nowStr });
    settleStrandedItems(repo, job.attempt_id, [job.item_id], INTERRUPTED_ITEM_SCORE_JSON, (setId) => setStore.readSet(setId));
    options.onAttemptChanged?.(job.attempt_id);
    settled += 1;
  }
  return settled;
}

/**
 * failInterruptedTranscriptionJobs on 'listening', like every boot pass. In production boot
 * recovery runs only once this process holds the execution lease and before it admits any job, so
 * every 'running' row the sweep sees belongs to a dead process, never to a live one or to this one.
 *
 * The try/catch matters: the boot recovery chain stops at the first pass that throws, so an
 * uncaught fault here would skip every later boot pass.
 */
export function wireTranscriptionInterruptionSweep(
  server: BootRecoveryServer,
  repo: TranscriptionRecoveryDeps["repo"],
  options: TranscriptionBootSweepOptions = {},
): void {
  server.on("listening", () => {
    try {
      const settled = failInterruptedTranscriptionJobs(repo, undefined, options);
      console.log(
        `[server] transcription boot sweep: ${settled} transcription(s) left unfinished by a restart settled (retryable by the user; nothing re-transcribed)`,
      );
    } catch (err) {
      console.error("[server] transcription boot sweep failed:", safeErrorDescriptor(err));
    }
  });
}

const NEVER_TRANSCRIBED_ERROR = "this recording was saved but never transcribed";
const MISSING_RECORDING_SCORE_JSON = JSON.stringify({ error: "recording is missing" });

/**
 * Gives every Item stuck at 'transcription_pending' with no current transcription job a way out.
 * Nothing else ever looks at that shape: no job means no timer, no snapshot panel and no Retry.
 *
 *   recording on disk at its canonical path -> a transcription job born 'failed' (retryable kind
 *                                              'provider'), so the User's Retry transcribes it and
 *                                              hands it to scoring like any recovered recording.
 *                                              The hash is of the bytes there now, which is what
 *                                              retry() verifies before calling Ears.
 *   no recording                            -> the Item fails with "recording is missing"; there is
 *                                              nothing left to transcribe.
 *
 * Reads the recording to hash it and spends nothing. Idempotent: the Item then has a current job,
 * or is no longer 'transcription_pending'. Nothing score-bearing changes (the unscored Item kept
 * its Attempt from a Band Estimate before, and still does), so the Attempt is not reconciled for
 * it, and an estimate persisted under an older method keeps that method.
 */
export function adoptStrandedRecordings(
  repo: TranscriptionBootStore & Pick<TranscriptionRecoveryDeps["repo"], "updateItemScore">,
  options: { dataDir?: string; now?: () => Date } = {},
): number {
  const dataDir = options.dataDir ?? config.dataDir;
  const nowStr = sqliteTimestamp((options.now ?? (() => new Date()))());
  let adopted = 0;
  for (const item of repo.listTranscriptionPendingItemsWithoutJob()) {
    if (item.taskType !== "listen_repeat" && item.taskType !== "interview") continue;
    const audioPath = path.join("audio/responses", item.attemptId, `${item.itemId}.webm`);
    const recording = itemPointsAtJobPath(item.responseAudioPath, audioPath, dataDir) ? storedRecording(audioPath, dataDir) : undefined;
    if (recording) {
      repo.insertFailedTranscriptionJob({
        id: crypto.randomUUID(), attemptId: item.attemptId, itemId: item.itemId, taskType: item.taskType,
        audioPath, audioSha256: sha256File(recording), failureKind: "provider", error: NEVER_TRANSCRIBED_ERROR, now: nowStr,
      });
    } else {
      repo.updateItemScore({ attemptId: item.attemptId, itemId: item.itemId, score: null, scoreJson: MISSING_RECORDING_SCORE_JSON, scoringStatus: "failed" });
    }
    adopted += 1;
  }
  return adopted;
}

function storedRecording(audioPath: string, dataDir: string): string | undefined {
  try {
    const realPath = resolveRealPathWithinBase(audioPath, dataDir);
    return fs.statSync(realPath).isFile() ? realPath : undefined;
  } catch {
    return undefined;
  }
}

/** adoptStrandedRecordings on 'listening', isolated like every other boot sweep. */
export function wireStrandedRecordingAdoption(
  server: BootRecoveryServer,
  repo: TranscriptionBootStore & Pick<TranscriptionRecoveryDeps["repo"], "updateItemScore">,
): void {
  server.on("listening", () => {
    try {
      const adopted = adoptStrandedRecordings(repo);
      if (adopted > 0) console.log(`[server] ${adopted} recording(s) saved without a transcription job given a retry`);
    } catch (err) {
      console.error("[server] stranded-recording sweep failed:", safeErrorDescriptor(err));
    }
  });
}
