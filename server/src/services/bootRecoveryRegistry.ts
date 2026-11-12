import {
  scoreSilentItemsLeftUnscored,
  wireBootRecovery,
  type BootRecoveryServer,
  type ScoringBootStore,
  type ScoringStore,
} from "./scoringJobs.js";
import { wireGenerationBootRecovery, type GenerationJobStore } from "./generationJobs.js";
import {
  safeErrorDescriptor,
  wireStrandedRecordingAdoption,
  wireTranscriptionInterruptionSweep,
  type TranscriptionBootStore,
  type TranscriptionStore,
} from "./transcriptionRecovery.js";
import { wireSpeakingBootRecovery, type SpeakingFinalization } from "./speakingFinalization.js";
import type { CaptureStore } from "./attemptStore.js";
import { wireModelCallPruning, type DiagnosticRetentionStore } from "./modelCallLog.js";
import { wireClipMeasurementReconciliation } from "./clipTakeManifest.js";
import type { ClipMeasurementStore } from "./clipMeasurementLog.js";
import { wireSupersessionManifest, type SupersessionIndexStore } from "./supersessionManifest.js";

/**
 * Every boot-recovery pass, in declared phases. Node fires 'listening' listeners in registration
 * order, so the order passes run in is load-bearing; declaring it as phases makes it a fact the suite
 * asserts (bootRecoveryRegistry.test.ts) rather than an accident of where `server.on` is called.
 */
export const BOOT_RECOVERY_PHASES = [
  "scoring-recovery",
  "generation-recovery",
  "transcription-sweep",
  "speaking-reconcile",
  "housekeeping",
] as const;

export type BootRecoveryPhase = (typeof BOOT_RECOVERY_PHASES)[number];

/**
 * What the wired passes need: the union of their own stores.
 *
 * `Omit<ScoringStore, "getAttempt">`: the job stores declare `getAttempt` at different widths, an
 * intersection resolves to the first signature, and only the widest is safe to leave in scope.
 * TranscriptionStore's leads because it is the widest (`set_id` plus ResponseRow items).
 */
export type BootRecoveryStore =
  TranscriptionStore
  & Omit<ScoringStore, "getAttempt">
  & ScoringBootStore
  & TranscriptionBootStore
  & Pick<CaptureStore, "listCaptureFinishedInProgressAttempts">
  & GenerationJobStore
  & DiagnosticRetentionStore
  & Pick<ClipMeasurementStore, "insertClipMeasurement">
  & SupersessionIndexStore;

export type BootRecoveryDeps = {
  repo: BootRecoveryStore;
  /** The process's own finalizer — the last pass reconciles through it. */
  speakingFinalization: Pick<SpeakingFinalization, "reconcileAttempt">;
};

/**
 * What each pass is handed: the deps, plus one boot's record of the Attempts the healing passes
 * changed. A pass adds an Attempt when it settles that Attempt's jobs or Items in a way a live
 * process would have followed with a reconcile (a terminal job, a scored or failed Item); the
 * speaking-reconcile pass, which runs after all of them, reconciles each one once.
 */
export type BootRecoveryPassDeps = BootRecoveryDeps & { changedAttempts: Set<string> };

export type BootRecoveryPass = {
  readonly name: string;
  readonly phase: BootRecoveryPhase;
  /** What this pass heals, and what its phase placement is protecting. */
  readonly rationale: string;
  /**
   * Registers the pass on the server's 'listening' event. A listener may return a promise;
   * index.ts's runAllBootRecovery awaits each one before starting the next.
   */
  readonly register: (server: BootRecoveryServer, deps: BootRecoveryPassDeps) => void;
};

// Declared in phase order for readability only — wireBootRecoveryPasses sorts by the declared phase,
// so moving an entry in this array cannot change the order anything actually runs in.
export const BOOT_RECOVERY_PASSES: readonly BootRecoveryPass[] = [
  {
    name: "scoring-interrupted-jobs",
    phase: "scoring-recovery",
    rationale:
      "Interrupted SCORING jobs -> failed, their Items rescorable (or a no-speech 0). Boot recovery " +
      "runs once this process holds the database's execution lease and before it admits any job, so " +
      "a job still queued|running here was orphaned by a previous process dying mid-run. Also " +
      "releases the Items of a job that ended 'cancelled' (not superseded) in a process that died " +
      "before releasing them, and fails a pending Item with a transcript that no job covers (the " +
      "orphan sweep folded into failInterruptedJobs). Every Attempt it changes is reconciled by the " +
      "last pass. Never re-runs scoring itself: no API spend at boot. MUST precede any pass that can " +
      "CREATE a scoring job: a recovery-created job swept afterwards is marked 'failed' while its " +
      "transcription job is already 'done' with score_job_id set, at which point " +
      "createRecoveryScoringJobAndLink returns {created:false} forever and nothing re-creates it, " +
      "stranding the recovered Item.",
    register: (server, deps) =>
      wireBootRecovery(server, deps.repo, { onAttemptChanged: (id) => deps.changedAttempts.add(id) }),
  },
  {
    name: "no-speech-items",
    phase: "scoring-recovery",
    rationale:
      "Unscored no-speech recordings -> their deterministic 0, whatever path left them " +
      "unscored or failed: a recording Ears heard nothing in is never sent to a Judge, so nothing " +
      "else would ever score it. Writes state only; the last pass recomputes each changed " +
      "Attempt's estimate.",
    register: (server, deps) => {
      server.on("listening", () => {
        // A throw would end runAllBootRecovery (index.ts) here, skipping every later pass, so a
        // fault is logged as a safe descriptor and the boot goes on.
        try {
          const scored = scoreSilentItemsLeftUnscored({ repo: deps.repo, onAttemptChanged: (id) => deps.changedAttempts.add(id) });
          if (scored > 0) console.log(`[server] scored ${scored} no-speech recording(s) 0`);
        } catch (err) {
          console.error("[server] no-speech sweep failed:", safeErrorDescriptor(err));
        }
      });
    },
  },
  {
    name: "generation-interrupted-jobs",
    phase: "generation-recovery",
    rationale:
      "Interrupted GENERATION jobs and batch parents -> failed/cancelled, with half-written artifacts " +
      "removed where safe. The same lease-held timing and the same no-paid-work policy. Its own " +
      "internal ordering is load-bearing too and lives with the pass: cleanup debt and publication " +
      "intents reconcile BEFORE the interrupted-job loop, and batch parents are reclassified after it.",
    register: (server, deps) => wireGenerationBootRecovery(server, deps.repo),
  },
  {
    name: "transcription-interruption-sweep",
    phase: "transcription-sweep",
    rationale:
      "Unfinished TRANSCRIPTIONS -> settled without spending anything. Nothing resumes after a " +
      "restart: a 'running' row records no outcome, and a 'queued' or 'retry_wait' row would resume " +
      "only if something in the new process armed the scheduler — paid Ears work boot must not " +
      "start. Each becomes terminal 'failed' naming the restart, which is exactly what the User-facing " +
      "Retry accepts. An 'awaiting_score' row already has its transcript, so it becomes 'done' and " +
      "its Item is settled like a stranded scoring job's: rescorable, or a no-speech 0. No scoring " +
      "job is created.",
    register: (server, deps) =>
      wireTranscriptionInterruptionSweep(server, deps.repo, { onAttemptChanged: (id) => deps.changedAttempts.add(id) }),
  },
  {
    name: "stranded-recordings",
    phase: "transcription-sweep",
    rationale:
      "Items at 'transcription_pending' with no current transcription job (recordings saved before " +
      "transcription_jobs existed) -> a job born 'failed' that the User can Retry, or a failed Item " +
      "when the recording is gone. Nothing else ever looks at that shape. Hashes the recording, " +
      "calls no Ears, and changes nothing score-bearing, so it adds no Attempt to the reconcile.",
    register: (server, deps) => wireStrandedRecordingAdoption(server, deps.repo),
  },
  {
    name: "speaking-boot-recovery",
    phase: "speaking-reconcile",
    rationale:
      "Every Attempt an earlier pass changed, and every capture-finished Speaking Simulation still " +
      "in progress -> reconciled (speakingFinalization.ts's wireSpeakingBootRecovery). Reconciling " +
      "spends nothing: it heals orphans, completes a Simulation whose work has all ended and " +
      "recomputes a completed Attempt's Band Estimate. It runs after every healing pass, so the jobs " +
      "they settled no longer count as active work.",
    register: (server, deps) =>
      wireSpeakingBootRecovery(server, {
        repo: deps.repo,
        speakingFinalization: deps.speakingFinalization,
        changedAttempts: deps.changedAttempts,
      }),
  },
  {
    name: "supersession-manifest",
    phase: "housekeeping",
    rationale:
      "Inserts every pair in data/question-sets/supersessions.json that superseded_sets does not " +
      "already hold, so a fresh clone retires the same Sets the bank's history retired. Never " +
      "replaces or deletes a row the database has, and skips a pair whose replacement Set is not on " +
      "disk. It heals no job, so it sits in housekeeping; it runs first there so the Set listing is " +
      "complete as early in the boot as possible.",
    register: (server, deps) => wireSupersessionManifest(server, deps.repo),
  },
  {
    name: "clip-measurement-manifest-reconciliation",
    phase: "housekeeping",
    rationale:
      "Replays each render's own audio-manifest.json takes into the LOCAL clip_measurements. A " +
      "batch rendered in one checkout is often copied into another, and rows do not travel with " +
      "files, so without this a copied bank has no measurements at all. Idempotent by row id, so it " +
      "is a no-op in the checkout that did the rendering and on every boot after the first. " +
      "Housekeeping, like the prune: it heals no job and blocks nothing. AHEAD of the prune, so a " +
      "replayed row and a live one face the same retention edge in the same boot rather than one " +
      "boot apart; the replay skips anything already past that edge for the same reason.",
    register: (server, deps) => wireClipMeasurementReconciliation(server, deps.repo),
  },
  {
    name: "model-call-pruning",
    phase: "housekeeping",
    rationale:
      "Model-call transcript retention (MODEL_CALL_RETENTION_DAYS). Last, because it is pure " +
      "housekeeping: it heals nothing and blocks nothing, so it must never run ahead of work that " +
      "does. Its own listener logs and swallows a failure, as the no-speech pass does, so the boot " +
      "goes on.",
    register: (server, deps) => wireModelCallPruning(server, deps.repo),
  },
];

/** Every pass, in the order they will run. */
export function registeredBootRecoveryPasses(): readonly BootRecoveryPass[] {
  return BOOT_RECOVERY_PHASES.flatMap((phase) => BOOT_RECOVERY_PASSES.filter((pass) => pass.phase === phase));
}

/**
 * Registers every wired pass on `server`'s 'listening' event in declared-phase order. In production
 * that event is runAllBootRecovery's (index.ts), fired only once this process holds the database's
 * execution lease and before it admits any job. The lease is what makes the chain safe: without it
 * a second process, started while a first is alive and mid-job, would read the same rows and mark
 * the first process's in-flight work as failed.
 */
export function wireBootRecoveryPasses(server: BootRecoveryServer, deps: BootRecoveryDeps): void {
  const passDeps: BootRecoveryPassDeps = { ...deps, changedAttempts: new Set<string>() };
  for (const pass of registeredBootRecoveryPasses()) pass.register(server, passDeps);
}
