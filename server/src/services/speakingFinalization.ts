import { NOT_CAPTURED_ITEM_ERROR, SKIPPED_ITEM_REASON, type SpeakingSet, type TranscriptionJobStatus } from "@toefl-prep/shared";
import { config } from "../lib/config.js";
import { createSetStore, type SetReader } from "./setStore.js";
import { parseSqliteTimestamp, sqliteTimestamp } from "../db/timestamps.js";
import type {
  AttemptReadStore,
  AttemptSettlementStore,
  CaptureStore,
} from "./attemptStore.js";
import {
  noSpeechScoreWrite,
  spokenItemPrompt,
  spokenResponseState,
} from "./judgeEnsemble.js";
import { recomputeSectionEstimate, type EstimateStore } from "./sectionEstimates.js";
import {
  parseItemIds,
  scoringJobCoversItsItems,
  type BootRecoveryServer,
  type ScoringJobStore,
} from "./scoringJobs.js";
import {
  createTranscriptionRecovery,
  currentCoordinatorGeneration,
  isSharedDatabaseFile,
  safeErrorDescriptor,
  type TranscriptionJobStore,
  type TranscriptionRecovery,
  type TranscriptionRecoveryDeps,
} from "./transcriptionRecovery.js";

// Speaking finalization: when a Speaking Attempt completes, and its Band Estimate after that.
// markCaptureFinished records which Items a Speaking Simulation never captured. reconcileAttempt
// runs whenever outstanding work may have ended (a scoring or transcription job reaching its end,
// the capture-finished and complete routes, a grace timer, boot); it completes the Attempt once
// nothing is outstanding, settles Items no job will ever score, and recomputes the estimate. It
// reads what the stores and transcriptionRecovery persist and reproduces neither's rules. This
// module also composes the speaking coordinators and registers the last boot pass.

/**
 * What the client knows about capture that the server cannot observe.
 *
 * `uploadFailedItemIds` are Items the browser recorded but could not get onto the server: every
 * retry of POST /:id/audio was spent, or the endpoint rejected the bytes. Nothing reaches the
 * database either way, so to the server those Items look exactly like ones the User never spoke
 * into, and this hint is the only thing that separates the two (classifyMissingItem).
 *
 * Advisory only: the expected Item list comes from the Set, never from the client, so a client that
 * lies, omits this, or predates it can only move an Item from "skip, scored 0" to "lost upload,
 * failed"; it can never remove an Item from the reconciliation or invent one.
 */
export type CaptureFinishedHints = {
  uploadFailedItemIds?: readonly string[];
};

export interface SpeakingFinalization {
  markCaptureFinished(attemptId: string, hints?: CaptureFinishedHints): Promise<void>;
  reconcileAttempt(attemptId: string): Promise<void>;
}

/**
 * The persistence speaking finalization uses, declared as those members rather than the whole repo,
 * each reused from the port that owns it:
 *
 *   the Attempt         `getAttempt` (the row plus every persisted Item), CaptureStore's atomic
 *                       capture write, and `settleAttempt`, which writes the orphan heal, the
 *                       completion and the Band Estimate in one transaction;
 *   scoring_jobs        the per-Attempt reads the active-work gate and the coverage set need;
 *   transcription_jobs  the current-jobs read the same gate needs;
 *   Band Estimates      EstimateStore, handed straight to recomputeSectionEstimate for a completed
 *                       Writing Attempt, which has nothing to heal or complete.
 *
 * The ports declare `getAttempt` at different widths, and an intersection of two call signatures
 * resolves to the first rather than to the wider one: it compiles either way and only the call site
 * fails. So AttemptReadStore's, the widest, is the one left in scope and EstimateStore's is omitted.
 * The wider member still satisfies the narrower port, which is what lets this store be handed
 * straight to recomputeSectionEstimate.
 */
export type SpeakingFinalizationStore =
  Pick<AttemptReadStore, "getAttempt">
  & AttemptSettlementStore
  & CaptureStore
  & Pick<ScoringJobStore, "listActiveJobs" | "listScoringJobsForAttempt">
  & Pick<TranscriptionJobStore, "getCurrentTranscriptionJobs">
  & Omit<EstimateStore, "getAttempt">;

export type SpeakingFinalizationDeps = {
  repo: SpeakingFinalizationStore;
  dataDir?: string;
  // Real wall clock by default; tests inject a fake to assert exact timestamps.
  now?: () => Date;
  // Defaults to the Set store bound to `dataDir`.
  setStore?: SetReader;
};

// markCaptureFinished's rejections, one class per cause so the routes can answer each with its own
// status. Named apart from scoreItems' `NotFound`, which the same route file imports. An unknown
// Attempt id is the client's 404; an existing Attempt whose Set file is missing or invalid
// (SetUnavailable) is a server-state problem, not a bad id.
export class AttemptNotFound extends Error {}
export class NotSpeakingSimulation extends Error {}
export class SetUnavailable extends Error {}

const MISSING_UPLOAD_SCORE_JSON = JSON.stringify({ error: NOT_CAPTURED_ITEM_ERROR });
const ORPHANED_ITEM_SCORE_JSON = JSON.stringify({ error: "scoring request did not arrive" });
// The deliberate-skip marker (shared/src/schemas/scoring.ts owns its shape and wording, because the
// review page reads this exact value back). A scored 0, not a failure: nothing was recorded, so there
// was nothing to judge, and on the real exam an unanswered Item earns 0 raw points.
const SKIPPED_ITEM_SCORE_JSON = JSON.stringify({ skipped: true, reason: SKIPPED_ITEM_REASON });

// The transcription_jobs statuses that are still work in flight for an Item. 'done', 'failed' and
// 'superseded' are terminal and never hold completion: a transcription that has spent its retries
// leaves its Item unscored (and the Attempt without a band) rather than blocking completion forever.
const ACTIVE_TRANSCRIPTION_STATUSES = new Set<TranscriptionJobStatus>([
  "queued", "running", "retry_wait", "awaiting_score",
]);

// How long a capture marker must have stood before an Item that is pending, has a transcript and is
// covered by no job counts as abandoned rather than a healthy upload whose POST /score from the
// client is still on its way. Well past a request round-trip, yet short enough that an abandoned
// Item is settled by the first reconcile after it (scheduleGraceReconcile arms one), or at boot.
const ORPHAN_HEAL_GRACE_MS = 30_000;

// Whether an uncovered pending Item with a transcript can be treated as abandoned now: once the
// Attempt is completed (its run is over, so no score request from it is still on its way), or once
// the capture marker is older than the grace margin. `nowDate` is the caller's reading of the
// injectable clock, so this stays deterministic under a fake clock.
function orphanHealIsSafe(attempt: { status: string; capture_finished_at: string | null }, nowDate: Date): boolean {
  if (attempt.status === "completed") return true;
  if (attempt.capture_finished_at === null) return false;
  const ageMs = nowDate.getTime() - parseSqliteTimestamp(attempt.capture_finished_at).getTime();
  return ageMs >= ORPHAN_HEAL_GRACE_MS;
}

// ---------------------------------------------------------------------------------------------
// The grace re-reconcile
// ---------------------------------------------------------------------------------------------

// A capture-finished Attempt whose only reconcile lands inside ORPHAN_HEAL_GRACE_MS is refused the
// orphan heal at that moment, rightly: a healthy upload occupies the same state until the client's
// POST /score arrives. If the Item really was orphaned, nothing in-process would look again (no
// transcription job left to end, no scoring job to fire onTerminal), and the Attempt would stay
// in progress until the next boot. So whichever route wrote the marker (or completed a Speaking
// Drill) arms one delayed re-reconcile.
//
// One timer rather than a reconcile on every Attempt read: it is scoped to the Attempt and the window
// that created the doubt instead of putting a write path behind every GET; it needs no client, so a
// User who closes the tab is still finalized; and it is bounded, at most one pending unref'd timer
// per Attempt and never a poll loop. Its delay is derived from the grace margin, so when it fires
// the marker is past the margin and the heal is not refused for the same reason again. Work still
// in flight is declined by reconcileAttempt itself and finalized by that work's own terminal
// callback.
const CAPTURE_RECONCILE_RETRY_MS = ORPHAN_HEAL_GRACE_MS + 1_000;

// Just the reconcile entry point the timer drives, so a test can arm the scheduler against a
// one-method object.
export type GraceReconcileTarget = { reconcileAttempt(attemptId: string): Promise<void> };

// At most one pending grace timer per Attempt per finalizer, however often the client polls
// capture-finished. Keyed by the finalizer as well as the Attempt id because this map is
// module-level: an Attempt-id key alone would let one finalizer's timer suppress another's. The
// WeakMap lets a discarded finalizer's entries be collected.
const pendingGraceReconciles = new WeakMap<GraceReconcileTarget, Map<string, NodeJS.Timeout>>();

/**
 * Arms the one delayed re-reconcile for an Attempt. Idempotent per (finalizer, Attempt) while a
 * timer is pending, and never throws: a reconcile fault is logged as a bounded safe descriptor,
 * never as the error value.
 */
export function scheduleGraceReconcile(finalization: GraceReconcileTarget, attemptId: string): void {
  let byAttempt = pendingGraceReconciles.get(finalization);
  if (!byAttempt) {
    byAttempt = new Map<string, NodeJS.Timeout>();
    pendingGraceReconciles.set(finalization, byAttempt);
  }
  // Already armed: dropping the duplicate is safe because the pending timer fires earlier, and the
  // capture marker never moves forward (CaptureStore), so it is past the grace margin by then too.
  if (byAttempt.has(attemptId)) return;
  const timer = setTimeout(() => {
    byAttempt.delete(attemptId);
    void (async () => finalization.reconcileAttempt(attemptId))().catch((err) =>
      console.error("[speakingFinalization] delayed capture reconcile failed:", safeErrorDescriptor(err)),
    );
  }, CAPTURE_RECONCILE_RETRY_MS);
  // Never keeps the process alive on its own.
  timer.unref?.();
  byAttempt.set(attemptId, timer);
}

/**
 * Every Item a Speaking Simulation expects, read from the Set: the Set, not whatever arrived, defines
 * "every Item" (7 Listen and Repeat, 4 Interview). markCaptureFinished compares against this list.
 */
export function expectedSpeakingItems(
  set: SpeakingSet,
): { itemId: string; taskType: "listen_repeat" | "interview" }[] {
  return [
    ...set.listenAndRepeat.items.map((item) => ({
      itemId: item.id,
      taskType: "listen_repeat" as const,
    })),
    ...set.interview.questions.map((item) => ({
      itemId: item.id,
      taskType: "interview" as const,
    })),
  ];
}

// ---------------------------------------------------------------------------------------------
// Skip or lost upload: an expected Item with no item_results row once capture has finished.
//
//   Skip: the User let the response window pass without recording. The exam scores an unanswered
//   Item 0, as this app's other sections do, so it is scored 0 deterministically; no Judge is called
//   and no audio is invented. Leaving it out instead would reward skipping the hard Items.
//
//   Lost upload: a recording existed and could not be landed. Scoring it 0 would punish the User for
//   a network fault, so it stays 'failed' (not captured), and the Attempt has no Band Estimate until
//   it is resolved (bandShortfall, ADR 0010).
//
// Only the browser can tell the two apart: it reports the Items whose uploads it gave up on in the
// capture-finished request, and every other missing Item is a skip. Defaulting the unknown case to
// a skip is deliberate: it is the common case and what the exam does. An Item that does have a row
// (transcription pending or exhausted, orphaned score request, Judge failure) is never touched by
// this rule; its own failure state already keeps the Attempt from a band.
// ---------------------------------------------------------------------------------------------
type MissingItemPlaceholder = {
  itemId: string;
  taskType: "listen_repeat" | "interview";
  scoreJson: string;
  score: number | null;
  scoringStatus: "failed" | "scored";
};

function classifyMissingItem(
  item: { itemId: string; taskType: "listen_repeat" | "interview" },
  uploadFailedItemIds: ReadonlySet<string>,
): MissingItemPlaceholder {
  if (uploadFailedItemIds.has(item.itemId)) {
    return { ...item, scoreJson: MISSING_UPLOAD_SCORE_JSON, score: null, scoringStatus: "failed" };
  }
  return { ...item, scoreJson: SKIPPED_ITEM_SCORE_JSON, score: 0, scoringStatus: "scored" };
}

// Whether any work is still outstanding for the Attempt: a transcription job in an active status, or
// a scoring job queued or running. Completing while, say, an Interview answer is still transcribing
// would finalize the Attempt before that Item is scored, and completion is one-way.
function hasActiveSpeakingWork(repo: SpeakingFinalizationDeps["repo"], attemptId: string): boolean {
  const activeTranscription = repo
    .getCurrentTranscriptionJobs(attemptId)
    .some((job) => ACTIVE_TRANSCRIPTION_STATUSES.has(job.status));
  if (activeTranscription) return true;
  return repo.listActiveJobs(attemptId).length > 0;
}

export function createSpeakingFinalization(deps: SpeakingFinalizationDeps): SpeakingFinalization {
  const repo = deps.repo;
  const dataDir = deps.dataDir ?? config.dataDir;
  const now = deps.now ?? (() => new Date());
  const setStore = deps.setStore ?? createSetStore(dataDir);

  // Marks capture finished for a Speaking Simulation and records every missing Item: a scored 0 when
  // it was skipped, a failed placeholder when the client reports its upload was lost
  // (classifyMissingItem). Throws on an unexpected input rather than doing nothing, unlike
  // reconcileAttempt: a route calls this only for a known Speaking Simulation, so a bad input is a
  // caller bug.
  async function markCaptureFinished(attemptId: string, hints: CaptureFinishedHints = {}): Promise<void> {
    const attempt = repo.getAttempt(attemptId);
    if (!attempt) throw new AttemptNotFound(`markCaptureFinished: unknown attempt ${attemptId}`);
    if (attempt.kind !== "speaking" || attempt.mode !== "simulation") {
      throw new NotSpeakingSimulation(
        `markCaptureFinished: attempt ${attemptId} is not a speaking simulation`,
      );
    }

    const set = setStore.readSet(attempt.set_id);
    if (!set || set.kind !== "speaking") {
      // Attempt creation checks the Set's kind, so this means the Set file is missing or invalid.
      // Without the expected Item list nothing can be classified, so refuse rather than mark capture
      // finished with no placeholders; the route decides what to do instead.
      throw new SetUnavailable(`markCaptureFinished: unknown or invalid speaking set for attempt ${attemptId}`);
    }

    const uploadFailedItemIds = new Set(hints.uploadFailedItemIds ?? []);
    const placeholders = expectedSpeakingItems(set).map((item) => classifyMissingItem(item, uploadFailedItemIds));

    // One transaction (CaptureStore): the marker is set once and never moved, and a placeholder is
    // inserted only where the Item has no row, so an Item that already arrived keeps its row. An
    // upload still in flight lands afterwards and replaces its skip placeholder with the recording
    // (the item_results upsert resets a row on a new recording), so a skip is final only if the
    // recording never arrives.
    repo.markCaptureFinishedWithMissingItemPlaceholders({
      attemptId,
      now: sqliteTimestamp(now()),
      placeholders,
    });
  }

  // Completes a Speaking Attempt once no work is outstanding, settles Items no job will ever score,
  // and recomputes the section estimate. It runs as the terminal callback of every scoring job, of
  // every Attempt kind, so an unknown, non-speaking or not-yet-eligible Attempt is a silent no-op,
  // never a throw.
  async function reconcileAttempt(attemptId: string): Promise<void> {
    const attempt = repo.getAttempt(attemptId);
    if (!attempt) return;

    // Writing has no capture marker and no transcription, but its estimate still changes after
    // completion: a Writing Simulation completes before its essays finish scoring, and a Re-score
    // changes an Item later. So a completed Writing Attempt gets its estimate recomputed. Only a
    // completed one, for the reason the Drill branch below gives.
    if (attempt.kind !== "speaking") {
      if (attempt.kind === "writing" && attempt.status === "completed") {
        recomputeSectionEstimate(repo, attemptId);
      }
      return;
    }

    // An aborted Attempt is never touched: no heal, no completion, no estimate.
    if (attempt.status !== "in_progress" && attempt.status !== "completed") return;

    if (attempt.mode === "simulation") {
      // An in-progress Simulation waits for its capture marker. A completed one goes on to the
      // estimate recompute whether or not it has a marker: Attempts completed before the marker
      // existed have none, and a later Re-score must still update their estimate.
      if (attempt.capture_finished_at === null && attempt.status !== "completed") return;
    } else {
      // A Drill has no capture marker, and the active-work gate below sees only Items that already
      // have a job, so an early Item's job ending would otherwise complete a Drill the User is still
      // working through. A Drill is reconciled only once /complete has completed it.
      if (attempt.status !== "completed") return;
    }

    if (hasActiveSpeakingWork(repo, attemptId)) return;

    const nowDate = now();

    // The orphan heal. A pending Item with a transcript that no scoring job covers will never be
    // scored by anyone, but a healthy upload occupies the same state until the client's POST /score
    // creates its job. A request in flight cannot be observed here, so elapsed time decides
    // (orphanHealIsSafe); healing early would fail Items whose score request is on its way and
    // complete the Attempt without them.
    //
    // Coverage is scoringJobCoversItsItems. A superseded job does not cover: a client POST /score
    // supersedes every active job for its Attempt and Task Type, including a one-Item job recovery
    // launched for an Item the request left out, and counting that row would hide the Item for good.
    // A cancelled job does not cover either: it discarded its Score Report.
    const coveredItemIds = new Set<string>();
    for (const job of repo.listScoringJobsForAttempt(attemptId)) {
      if (!scoringJobCoversItsItems(job)) continue;
      for (const itemId of parseItemIds(job)) coveredItemIds.add(itemId);
    }
    const orphanedItems = attempt.items.filter((item) => {
      if (item.scoring_status !== "pending" || coveredItemIds.has(item.item_id)) return false;
      const state = spokenResponseState(item);
      return state === "usable" || state === "no-speech";
    });
    if (orphanedItems.length > 0 && !orphanHealIsSafe(attempt, nowDate)) {
      // Too early to conclude these will never be scored: no heal, no completion, no estimate. A
      // later reconcile (the client's score job ending, the grace timer, boot) starts over.
      return;
    }
    // The rule `admit` applies: a no-speech recording is a deterministic 0, scored here; a judgeable
    // one becomes failed and rescorable.
    const set = orphanedItems.length > 0 ? setStore.readSet(attempt.set_id) : undefined;
    const itemScores = orphanedItems.map((item) =>
      spokenResponseState(item) === "no-speech"
        ? noSpeechScoreWrite(attemptId, item.item_id, spokenItemPrompt(set, item.item_id))
        : { itemId: item.item_id, score: null, scoreJson: ORPHANED_ITEM_SCORE_JSON, scoringStatus: "failed" },
    );

    // The heal, the completion and the estimate, as one transaction (settleAttempt): a crash leaves
    // all three or none, and the next reconcile starts over. Completion moves only an in-progress
    // Attempt and keeps its first completed_at, so a replayed reconcile changes nothing there.
    //
    // For a Speaking Simulation this is the only estimate writer: /complete and capture-finished both
    // delegate to markCaptureFinished and this reconcile. A Speaking Drill's /complete computes its
    // estimate at once, and this replaces it on every later terminal event; both go through the one
    // recompute in sectionEstimates.ts, which reads the Items after the heal has settled them.
    repo.settleAttempt({ attemptId, itemScores, now: sqliteTimestamp(nowDate) });
  }

  return { markCaptureFinished, reconcileAttempt };
}

// The three objects every caller of the speaking lifecycle needs, wired together in one place
// (createSpeakingCoordinators), so the cycle between them and the composition of the
// scoring-terminal callback have a single definition.
export type SpeakingCoordinators = {
  transcriptionRecovery: TranscriptionRecovery;
  speakingFinalization: SpeakingFinalization;
  // The composed scoring-terminal callback, so the /score route's jobs fire the same pair of effects
  // a recovery-created job does.
  onScoringTerminal: (attemptId: string) => Promise<void>;
};

// Runs one effect with its fault logged rather than thrown, so the scoring-terminal callback's two
// halves, and each boot reconcile, never skip the ones after them.
async function runIsolated(label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (err) {
    console.error(`[speakingCoordinators] ${label} failed:`, safeErrorDescriptor(err));
  }
}

// The bundle is memoized, not only the transcription coordinator inside it. createTranscriptionRecovery
// returns its existing instance for a repeat call, so without this memo a second
// createSpeakingCoordinators for the same database would return a mismatched bundle: the memoized
// recovery coordinator, still wired to the first finalizer, beside a new finalizer and callback.
//
// Keyed on the same two axes createTranscriptionRecovery uses: the store object, and its database
// file. The file axis is the one that matters in practice, because speakingCoordinatorStore(stores)
// allocates a new object on every call, so a caller that composes it inline never hits the object
// axis. `:memory:` is exempt from the file axis (isSharedDatabaseFile): every in-memory database is
// private to its handle. Each entry is stamped with the coordinator generation, so a simulated
// restart invalidates the bundle together with the coordinator inside it.
type MemoizedBundle = { generation: number; bundle: SpeakingCoordinators };
const coordinatorBundlesByRepo = new WeakMap<object, MemoizedBundle>();
const coordinatorBundlesByDbFile = new Map<string, MemoizedBundle>();
// A WeakMap has no `clear()`, so entries are invalidated by generation rather than by emptying; the
// file-keyed Map, which would otherwise keep a stale bundle per database forever, is also emptied the
// first time a new generation is seen.
let lastSeenBundleGeneration = currentCoordinatorGeneration();

function existingBundleFor(repo: SpeakingCoordinatorStore): SpeakingCoordinators | undefined {
  const generation = currentCoordinatorGeneration();
  if (generation !== lastSeenBundleGeneration) {
    coordinatorBundlesByDbFile.clear();
    lastSeenBundleGeneration = generation;
  }
  const current = (entry: MemoizedBundle | undefined): SpeakingCoordinators | undefined =>
    entry && entry.generation === generation ? entry.bundle : undefined;
  return (
    current(coordinatorBundlesByRepo.get(repo)) ??
    (isSharedDatabaseFile(repo.dbFile) ? current(coordinatorBundlesByDbFile.get(repo.dbFile)) : undefined)
  );
}

/**
 * The persistence the speaking coordinators need: finalization's port and transcription recovery's,
 * and nothing else. `speakingCoordinatorStore` (db/stores/index.ts) builds it, so a coordinator
 * cannot reach generation jobs or the model diagnostics.
 *
 * Transcription's `getAttempt` is omitted for the reason SpeakingFinalizationStore gives: it is
 * narrower (`set_id` plus Response rows), and an intersection resolves to the first signature, which
 * would hand finalization an Attempt with no `status`, `mode` or `capture_finished_at`. The wider one
 * still satisfies transcription.
 */
export type SpeakingCoordinatorStore =
  SpeakingFinalizationStore & Omit<TranscriptionRecoveryDeps["repo"], "getAttempt">;

/**
 * Builds the speaking coordinators for one database, or returns the bundle already built for it in
 * this process, because the transcription coordinator inside is one per database. Build it once, in
 * the composition root.
 */
export function createSpeakingCoordinators(
  deps: Omit<TranscriptionRecoveryDeps, "onScoringTerminal" | "onTranscriptionTerminal" | "repo"> & {
    repo: SpeakingCoordinatorStore;
  },
): SpeakingCoordinators {
  const memoized = existingBundleFor(deps.repo);
  if (memoized) return memoized;

  const speakingFinalization = createSpeakingFinalization({
    repo: deps.repo,
    dataDir: deps.dataDir,
    now: deps.now,
    setStore: deps.setStore,
  });

  // The two modules need each other's terminal events, a cycle resolved with a closure over a `let`.
  // `onScoringTerminal` is only called after both constructions have completed, so the binding is
  // initialized by the time it is read.
  let transcriptionRecovery!: TranscriptionRecovery;

  // Composed, not replaced: supplying `onScoringTerminal` overrides transcriptionRecovery's default,
  // the re-drive that resumes a recovered Item's handoff deferred while another scoring job for its
  // Task Type was active. Passing only the finalization reconcile would drop it and strand that Item.
  // The re-drive runs first, so a scoring job it creates counts as active work for the reconcile.
  const onScoringTerminal = async (attemptId: string): Promise<void> => {
    await runIsolated("scoring-terminal re-drive", () => transcriptionRecovery.runDueAndReconcile(attemptId));
    await runIsolated("scoring-terminal reconcile", () => Promise.resolve(speakingFinalization.reconcileAttempt(attemptId)));
  };

  transcriptionRecovery = createTranscriptionRecovery({
    ...deps,
    onScoringTerminal,
    // A transcription that ends 'failed' produces no scoring job, so without this hook a
    // capture-finished Simulation waiting only on that Item would wait for the next boot.
    onTranscriptionTerminal: (attemptId) => speakingFinalization.reconcileAttempt(attemptId),
  });

  const bundle: SpeakingCoordinators = { transcriptionRecovery, speakingFinalization, onScoringTerminal };
  const entry: MemoizedBundle = { generation: currentCoordinatorGeneration(), bundle };
  coordinatorBundlesByRepo.set(deps.repo, entry);
  if (isSharedDatabaseFile(deps.repo.dbFile)) coordinatorBundlesByDbFile.set(deps.repo.dbFile, entry);
  return bundle;
}

/**
 * The last boot pass: reconciles every Attempt the earlier passes changed, plus every
 * capture-finished Speaking Simulation still in progress. reconcileAttempt spends nothing — it
 * heals orphans, completes a Simulation whose work has all ended, and recomputes the estimate of a
 * completed Attempt — so it is safe at boot, and it is the only thing that brings those Attempts up
 * to date: an Item boot recovery failed or scored changes a completed Attempt's band, and a
 * Simulation whose last job died with the old process has no terminal event left to complete it.
 *
 * It runs after every other healing pass, so the jobs they settled are already terminal here.
 */
export function wireSpeakingBootRecovery(
  server: BootRecoveryServer,
  deps: {
    repo: Pick<CaptureStore, "listCaptureFinishedInProgressAttempts">;
    speakingFinalization: Pick<SpeakingFinalization, "reconcileAttempt">;
    /** The Attempts the earlier boot passes changed, filled in by the time 'listening' reaches here. */
    changedAttempts: ReadonlySet<string>;
  },
): void {
  server.on("listening", async () => {
    let attemptIds: Set<string>;
    try {
      attemptIds = new Set([...deps.changedAttempts, ...deps.repo.listCaptureFinishedInProgressAttempts().map((a) => a.id)]);
    } catch (err) {
      console.error("[server] speaking boot recovery failed:", safeErrorDescriptor(err));
      return;
    }
    for (const attemptId of attemptIds) {
      await runIsolated("boot reconcile", () => deps.speakingFinalization.reconcileAttempt(attemptId));
    }
    console.log(`[server] speaking boot recovery: ${attemptIds.size} attempt(s) reconciled`);
  });
}
