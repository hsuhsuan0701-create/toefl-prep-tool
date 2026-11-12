import crypto from "node:crypto";
import type {
  AnySet,
  CancellationReason,
  ScoreRequest,
  ScoringProgressDetail,
} from "@toefl-prep/shared";
import { scoreItems, type ScoreDeps } from "./scoreItems.js";
import {
  noSpeechScoreWrite,
  spokenItemPrompt,
  spokenResponseState,
  type ResponseRow,
  type ScoreStore,
} from "./judgeEnsemble.js";
import { createSetStore, type SetReader } from "./setStore.js";
import { type CancellationRequestResult, type ScoringJobRow } from "../db/rows.js";
import type { DurableJobClaim } from "./durableJobRunner.js";
import { sqliteTimestamp, type SqliteTimestamp } from "../db/timestamps.js";
import { scoringJobCancellations } from "./jobCancellation.js";
import { createBufferedScoringPersistence, type ScoringPersistenceOperation } from "./scoringPersistence.js";
import { reportStrandedJob, runDurableJob } from "./durableJobRunner.js";

export type { ScoringProgress, OnScoringProgress } from "./scoreItems.js";

/**
 * The `scoring_jobs` aggregate: the durable scoring-job operations, declared as the members their
 * callers use rather than as the whole repo. One adapter satisfies it: db/stores/scoring.ts over
 * SQLite, which the tests use too.
 *
 * Every member that ends a job is conditional on the row still being queued or running, and reports
 * what it changed: the terminal writers return whether they won, and replaceScoringJobAndSupersede
 * returns the ids it superseded. Callers act on that answer instead of assuming the write landed, and
 * a new terminal writer must report it too.
 *
 * Three members reach beyond `scoring_jobs`, because each is one transaction or one query whose
 * correctness depends on staying whole:
 *
 *   createRecoveryScoringJobAndLink  creates the scoring job and marks the transcription job that
 *                                    hands off to it 'done' and linked, together.
 *   listPendingItemsWithTranscript   reads pending `item_results` with a transcript, excluding any
 *                                    Item with a transcription job at 'awaiting_score': that Item is
 *                                    mid-handoff to scoring, not an orphan.
 *   completeScoringJobAtomically     write a run's buffered Judge Reports and Item scores only
 *   failScoringJobConditional        inside the transaction that wins its terminal 'done' or
 *                                    'failed'.
 */
export type ScoringJobStore = {
  getScoringJob(id: string): ScoringJobRow | undefined;
  listInterruptedJobs(): ScoringJobRow[];
  listAllScoringJobs(): ScoringJobRow[];
  /** Read by the transcription family before it hands a recovered Item off to scoring. */
  listActiveScoringJobsForTask(attemptId: string, taskType: string): ScoringJobRow[];
  /**
   * Every queued or running job for one Attempt, across Task Types. Read by the Attempt routes (so a
   * returning client can re-attach to live progress), the Full-Test Run routes, and
   * speakingFinalization's active-work gate.
   */
  listActiveJobs(attemptId: string): ScoringJobRow[];
  /**
   * Every job for one Attempt, terminal ones included: speakingFinalization's orphan heal decides
   * for each row whether it still covers its Items (scoringJobCoversItsItems).
   */
  listScoringJobsForAttempt(attemptId: string): ScoringJobRow[];
  listPendingItemsWithTranscript(): { attemptId: string; itemId: string }[];
  claimScoringJobRunning(i: { id: string; stage?: string | null; now: SqliteTimestamp }): DurableJobClaim;
  /**
   * The stage alone, written only while the job is queued or running; reports whether it was. It
   * writes no status, result or error, so a job ends only through the guarded terminal writers below.
   */
  setScoringJobStage(i: { id: string; stage: string }): boolean;
  /**
   * A progress checkpoint, written only while the job is queued or running; reports whether it was.
   * A run keeps reporting after it has been superseded or cancelled, and its checkpoints must not
   * land on the finished row.
   */
  saveScoringJobProgress(i: { id: string; stage: string | null; progress: string | null }): boolean;
  /**
   * Creates the new queued job and cancels (reason 'superseded') every queued or running job for the
   * same Attempt and Task Type, in one transaction; returns the superseded ids so their in-process
   * runs can be aborted. Two calls could not express it: a crash between them could leave resubmitted
   * Items whose only job is superseded, and boot recovery never releases a superseded job's Items,
   * because their replacement is assumed to score them.
   */
  replaceScoringJobAndSupersede(i: { id: string; attemptId: string; taskType: string; itemIds: string[]; now: SqliteTimestamp }): string[];
  createRecoveryScoringJobAndLink(i: {
    transcriptionJobId: string;
    scoringJobId: string;
    attemptId: string;
    taskType: "listen_repeat" | "interview";
    itemId: string;
    now: SqliteTimestamp;
  }): { created: boolean; scoreJobId: string } | undefined;
  completeScoringJobAtomically(i: { id: string; result: string; operations: ScoringPersistenceOperation[]; now: SqliteTimestamp }): boolean;
  /**
   * The 'failed' terminal write. `operations`, a failing run's buffered writes, commit in the same
   * transaction and only if the write wins.
   */
  failScoringJobConditional(i: { id: string; error: string; now: SqliteTimestamp; operations?: ScoringPersistenceOperation[] }): boolean;
  finishScoringJobCancellation(i: { id: string; now: SqliteTimestamp }): boolean;
  /**
   * Records a cancellation request on a queued or running job; the run settles it. Called by the
   * Attempt route's cancel endpoint and by shutdown. Idempotent: an already-cancelled or
   * already-requested row answers `accepted` without a second write, any other terminal row is
   * refused, and a missing row answers undefined.
   */
  requestScoringJobCancellation(i: {
    id: string; reason: CancellationReason; now: SqliteTimestamp;
  }): CancellationRequestResult | undefined;
};

/**
 * The scoring family's whole persistence: its own aggregate plus the Judge ensemble's ScoreStore.
 * ScoreStore's `getScoringJob` is dropped because this family needs the whole row
 * (cancel_requested_at, item_ids), and an intersection of two call signatures resolves to the first
 * rather than the wider one. `getAttempt` is re-declared with the Attempt's `set_id` for the same
 * reason: a stranded no-speech Item's 0 is shown against its Set material (settleStrandedItems).
 */
export type ScoringStore = ScoringJobStore & Omit<ScoreStore, "getScoringJob" | "getAttempt"> & {
  getAttempt(id: string): { set_id: string; items: ResponseRow[] } | undefined;
};

/** The scoring family's DI bag: scoreItems' injectable Judges/Arbiters over the scoring store. */
export type ScoringJobDeps = Omit<ScoreDeps, "repo"> & { repo: ScoringStore };

/**
 * Whether a job's `item_ids` count as covered by it. A cancelled job, whatever the reason, discarded
 * its buffered Score Report and scores nothing; a superseded one (cancelled with reason
 * 'superseded') leaves its Items to its replacement, which may not cover them all. Both orphan sweeps
 * (boot's and speakingFinalization's) read coverage through this.
 */
export function scoringJobCoversItsItems(job: Pick<ScoringJobRow, "status">): boolean {
  return job.status !== "cancelled";
}

export const INTERRUPTED_ITEM_SCORE_JSON = JSON.stringify({ error: "scoring interrupted" });
const CANCELLED_ITEM_SCORE_JSON = JSON.stringify({ error: "scoring cancelled" });

/**
 * Settles the Items among `itemIds` still at 'pending', which the caller has established no scoring
 * job will score. A no-speech recording gets its deterministic 0 (the rule `admit` applies); anything
 * else becomes failed with `failureScoreJson`, which Attempt review offers to re-score. Items in any
 * other state are left as they are. Returns how many it settled.
 */
export function settleStrandedItems(
  repo: Pick<ScoringStore, "getAttempt" | "updateItemScore">,
  attemptId: string,
  itemIds: readonly string[],
  failureScoreJson: string,
  readSet: (setId: string) => AnySet | undefined,
): number {
  const attempt = repo.getAttempt(attemptId);
  if (!attempt) return 0;
  const wanted = new Set(itemIds);
  const stranded = attempt.items.filter((item) => wanted.has(item.item_id) && item.scoring_status === "pending");
  let set: AnySet | undefined;
  for (const item of stranded) {
    if (spokenResponseState(item) === "no-speech") {
      set ??= readSet(attempt.set_id);
      repo.updateItemScore(noSpeechScoreWrite(attemptId, item.item_id, spokenItemPrompt(set, item.item_id)));
    } else {
      repo.updateItemScore({ attemptId, itemId: item.item_id, score: null, scoreJson: failureScoreJson, scoringStatus: "failed" });
    }
  }
  return stranded.length;
}

/**
 * Settles the still-pending Items of a job that ended 'cancelled' for any reason but supersession.
 * Nothing else will: the buffered Score Report was discarded and no replacement job covers them. A
 * shutdown reads as an interruption, anything else as a cancellation. Idempotent.
 */
function releaseCancelledJobItems(
  repo: ScoringStore,
  jobId: string,
  readSet: (setId: string) => AnySet | undefined,
): { attemptId: string; items: number } | undefined {
  const job = repo.getScoringJob(jobId);
  if (!job || job.status !== "cancelled" || job.cancellation_reason === "superseded") return undefined;
  const failure = job.cancellation_reason === "shutdown" ? INTERRUPTED_ITEM_SCORE_JSON : CANCELLED_ITEM_SCORE_JSON;
  return { attemptId: job.attempt_id, items: settleStrandedItems(repo, job.attempt_id, parseItemIds(job), failure, readSet) };
}

/**
 * Aborts this process's run of a scoring job, if there is one, and reports whether there was. The
 * caller records the cancellation on the row first (requestScoringJobCancellation).
 */
export function abortScoringJob(jobId: string, reason: CancellationReason): boolean {
  return scoringJobCancellations.cancel(jobId, reason);
}

// What a run needs beyond its row. The row's `item_ids` is only a list of ids, for bookkeeping
// (recovery, supersession, the orphan sweeps); it cannot carry an essay's text or the Set's material,
// so the caller, which holds both when it creates the job, passes them in.
export type RunScoringJobInput = {
  attemptId: string;
  set: AnySet;
  request: ScoreRequest;
};

// enqueueScoringJob's two kinds of caller. The /score route supersedes any active job for the same
// Attempt and Task Type and has no transcription job to link. Transcription recovery links to the
// transcription job it hands off from and never supersedes: that would cancel work nothing replaces.
// `transcriptionJobId` (required in one, `never` in the other) makes mixing them a compile error.
export type RouteScoringJobOptions = {
  supersedeActive: true;
  transcriptionJobId?: never;
  onTerminal?: (attemptId: string) => Promise<void> | void;
};

export type RecoveryScoringJobOptions = {
  supersedeActive: false;
  transcriptionJobId: string;
  onTerminal?: (attemptId: string) => Promise<void> | void;
};

/**
 * The one place a scoring job row is created and its run launched (fire-and-forget); returns the job
 * id. The route form always creates a job. The recovery form returns the already-linked job's id
 * without launching anything when the transcription job was linked before, and null when the
 * transcription job is not eligible to hand off (wrong identity, not at 'awaiting_score', or an
 * active job already covers its Attempt and Task Type).
 */
export function enqueueScoringJob(
  deps: ScoringJobDeps,
  input: RunScoringJobInput,
  options: RouteScoringJobOptions,
): string;
export function enqueueScoringJob(
  deps: ScoringJobDeps,
  input: RunScoringJobInput,
  options: RecoveryScoringJobOptions,
): string | null;
export function enqueueScoringJob(
  deps: ScoringJobDeps,
  input: RunScoringJobInput,
  options: RouteScoringJobOptions | RecoveryScoringJobOptions,
): string | null {
  const taskType = input.request.taskType;
  const itemIds = input.request.items.map((i) => i.itemId);

  if (options.supersedeActive) {
    const jobId = crypto.randomUUID();
    const superseded = deps.repo.replaceScoringJobAndSupersede({
      id: jobId,
      attemptId: input.attemptId,
      taskType,
      itemIds,
      now: sqliteTimestamp(),
    });
    for (const predecessorId of superseded) {
      scoringJobCancellations.cancel(predecessorId, "superseded");
    }
    void runScoringJob(deps, jobId, input, options.onTerminal).catch((err) => {
      console.error(`[scoringJobs] job ${jobId} runner threw unexpectedly:`, err);
    });
    return jobId;
  }

  // Recovery path. The caller checks listActiveScoringJobsForTask first: an undefined answer from
  // createRecoveryScoringJobAndLink means either "an active job covers this Task Type, try later" or
  // "this transcription job is not eligible", and only that check tells the two apart. Either way
  // nothing is launched.
  const scoringJobId = crypto.randomUUID();
  const linked = deps.repo.createRecoveryScoringJobAndLink({
    transcriptionJobId: options.transcriptionJobId,
    scoringJobId,
    attemptId: input.attemptId,
    taskType: taskType as "listen_repeat" | "interview",
    itemId: itemIds[0],
    now: sqliteTimestamp(),
  });
  if (!linked) return null;
  if (!linked.created) {
    // Already linked by an earlier handoff: that call launched the run, and a second launch would
    // run the same job twice.
    return linked.scoreJobId;
  }
  void runScoringJob(deps, linked.scoreJobId, input, options.onTerminal).catch((err) => {
    console.error(`[scoringJobs] recovery job ${linked.scoreJobId} runner threw unexpectedly:`, err);
  });
  return linked.scoreJobId;
}

function mergeScoringProgress(
  cumulative: ScoringProgressDetail,
  detail: ScoringProgressDetail,
): void {
  const {
    arbiterProvider,
    fallbackFrom,
    queuePosition,
    ...durable
  } = detail;
  Object.assign(cumulative, durable);

  // The Arbiter's route (provider, fallback, queue position) is a current snapshot, not a cumulative
  // fact: an event naming the Arbiter's provider replaces all three, so a dequeue clears the queue
  // position and a later direct route clears an earlier fallback. Everything else accumulates.
  if (arbiterProvider === "claude" || arbiterProvider === "codex") {
    delete cumulative.arbiterProvider;
    delete cumulative.fallbackFrom;
    delete cumulative.queuePosition;
    cumulative.arbiterProvider = arbiterProvider;
    if (
      (fallbackFrom === "claude" || fallbackFrom === "codex") &&
      fallbackFrom !== arbiterProvider
    ) {
      cumulative.fallbackFrom = fallbackFrom;
    }
    if (typeof queuePosition === "number") {
      cumulative.queuePosition = queuePosition;
    }
  }
}

/**
 * Settles a scoring job whose own terminal write ('done' or 'failed', each carrying the run's
 * buffered writes) did not win. Both terminal writes require no cancel stamp and 'cancelled'
 * requires one, so a cancellation recorded while the run was settling is what usually stopped it:
 * it is finished here, never overwritten with the run's error or result, and the run's buffered
 * writes are dropped with it. A row still queued or running after that is logged
 * (reportStrandedJob) and left for the next boot's sweep.
 */
function settleLostTerminalWrite(
  repo: ScoringStore,
  jobId: string,
  outcome: "failed" | "done",
  finishCancellation: () => boolean,
): void {
  if (finishCancellation()) return;
  reportStrandedJob("scoring", jobId, outcome, repo.getScoringJob(jobId)?.status);
}

/**
 * Runs one scoring job in this process; enqueueScoringJob launches it fire-and-forget. The lifecycle
 * (admissions gate, claim, progress, the still-running guard, cancellation, terminal callback) is
 * runDurableJob's; this is the scoring adapter: which store writes those steps mean for a
 * scoring_jobs row, around scoreItems(). scoreItems() writes through a buffer, so its Judge Reports
 * and Item scores land only when the job commits 'done' or fails.
 *
 * `onTerminal` fires once the row has reached a terminal status, read fresh by the runner; a row
 * already terminal when the run starts still fires it, a missing row does not.
 */
export async function runScoringJob(
  deps: ScoringJobDeps,
  jobId: string,
  input: RunScoringJobInput,
  onTerminal?: (attemptId: string) => Promise<void> | void,
): Promise<void> {
  const repo = deps.repo;
  // Buffered until the run's terminal 'done' or 'failed' transaction wins, so a job cancelled
  // mid-flight persists nothing of it.
  const persistence = createBufferedScoringPersistence(repo);
  // Every path that settles a cancellation goes through here, so the Items a non-superseding
  // cancellation leaves behind are settled on whichever path wins, before onTerminal reconciles.
  const finishCancellation = (): boolean => {
    if (!repo.finishScoringJobCancellation({ id: jobId, now: sqliteTimestamp() })) return false;
    releaseCancelledJobItems(repo, jobId, () => input.set);
    return true;
  };
  await runDurableJob<ScoringJobRow, ScoringProgressDetail, Awaited<ReturnType<typeof scoreItems>>>({
    family: "scoring",
    jobId,
    // Correlates every model call this run makes back to this job, and is the per-job admission
    // bucket ADR 0007's scheduler keys on (DurableJob.correlation).
    correlation: { kind: "scoring-job", id: jobId, detail: { attemptId: input.attemptId } },
    cancellations: scoringJobCancellations,
    read: () => repo.getScoringJob(jobId),
    claim: () => repo.claimScoringJobRunning({ id: jobId, stage: "judging", now: sqliteTimestamp() }),
    // A cancellation recorded before the job started makes the claim refuse it: settle it now, before
    // any paid Judge or Arbiter call.
    disposeCancelRequested: () => { finishCancellation(); },
    progress: {
      merge: mergeScoringProgress,
      save: ({ stage, progress }) => { repo.saveScoringJobProgress({ id: jobId, stage, progress }); },
    },
    run: ({ signal, onProgress }) => scoreItems(
      { ...deps, repo: persistence.store },
      input.attemptId,
      input.set,
      input.request,
      onProgress,
      jobId,
      signal,
    ),
    // Called only while the row is running. The buffered writes are committed inside the
    // conditional 'done' transaction, so a job superseded or cancelled since that check commits
    // nothing and is not resurrected.
    commit: (result) => {
      repo.setScoringJobStage({ id: jobId, stage: "persisting" });
      if (repo.completeScoringJobAtomically({
        id: jobId,
        result: JSON.stringify(result),
        operations: persistence.operations,
        now: sqliteTimestamp(),
      })) return;
      settleLostTerminalWrite(repo, jobId, "done", finishCancellation);
    },
    fail: (err, { cancelled }) => {
      // On cancel the buffer is discarded and disposeCancellation settles the row.
      if (cancelled) return;
      // A failed run keeps what it buffered (Judge Reports it received, no-speech 0s, and its Items
      // marked failed so Attempt review offers a Re-score), committed in the transaction that wins
      // 'failed'. A cancellation recorded first wins instead, and those writes are dropped.
      if (repo.failScoringJobConditional({
        id: jobId,
        error: err instanceof Error ? err.message : String(err),
        now: sqliteTimestamp(),
        operations: persistence.operations,
      })) return;
      settleLostTerminalWrite(repo, jobId, "failed", finishCancellation);
    },
    disposeCancellation: () => {
      if (repo.getScoringJob(jobId)?.cancel_requested_at) finishCancellation();
    },
    ...(onTerminal ? { onTerminal: () => onTerminal(input.attemptId) } : {}),
  });
}

export type FailInterruptedJobsSummary = { jobs: number; items: number };

export type FailInterruptedJobsDeps = {
  repo: ScoringStore;
  setStore?: SetReader;
  /** Told about every Attempt whose jobs or Items this pass settled, so it can be reconciled afterwards. */
  onAttemptChanged?: (attemptId: string) => void;
};

const INTERRUPTED_JOB_ERROR = "interrupted by server restart";

// What a boot recovery pass registers on: a 'listening' event. In production, runAllBootRecovery
// (index.ts) passes a stand-in that fires it once this process holds the database's execution
// lease, so no pass can settle jobs another live server is still running. Tests pass a fake.
export type BootRecoveryServer = { on: (event: "listening", listener: () => void) => void };

/** Registers failInterruptedJobs to run once, on `server`'s 'listening' event, and logs its summary. */
export function wireBootRecovery(
  server: BootRecoveryServer,
  repo: ScoringStore,
  options: Omit<FailInterruptedJobsDeps, "repo"> = {},
): void {
  server.on("listening", () => {
    const recovery = failInterruptedJobs({ repo, ...options });
    console.log(
      `[server] boot recovery: ${recovery.jobs} interrupted job(s), ${recovery.items} stranded item(s) resolved`,
    );
  });
}

/**
 * The scoring boot pass. Spends nothing: every Item it touches goes through settleStrandedItems,
 * which only writes state (failed and rescorable, or a no-speech 0). Three populations:
 *
 * 1. Jobs still queued or running: the previous process died mid-run. Each is terminalized (failed,
 *    or cancelled when a cancellation was recorded) and its still-pending Items are settled.
 * 2. Jobs that ended 'cancelled' for a reason other than supersession whose process died before
 *    settling their Items (runScoringJob normally does it). This also reaches Items with no
 *    transcript, such as an essay, which the orphan sweep cannot see.
 * 3. The orphan sweep: pending Items with a transcript that no job covers (scoringJobCoversItsItems).
 *
 * Idempotent: a second call finds nothing queued or running and nothing pending among these, and
 * returns {jobs: 0, items: 0}.
 */
export function failInterruptedJobs(deps: FailInterruptedJobsDeps): FailInterruptedJobsSummary {
  const repo = deps.repo;
  const setStore = deps.setStore ?? createSetStore();
  const readSet = (setId: string) => setStore.readSet(setId);
  let itemsResolved = 0;
  const record = (attemptId: string, resolved: number, jobSettled = false) => {
    itemsResolved += resolved;
    if (resolved > 0 || jobSettled) deps.onAttemptChanged?.(attemptId);
  };

  const interrupted = repo.listInterruptedJobs();
  for (const job of interrupted) {
    if (job.cancel_requested_at) {
      repo.finishScoringJobCancellation({ id: job.id, now: sqliteTimestamp() });
    } else {
      // Conditional even though listInterruptedJobs already filtered: the guard in the write's own
      // SQL, not the query that fed it, is what makes the write safe.
      repo.failScoringJobConditional({ id: job.id, error: INTERRUPTED_JOB_ERROR, now: sqliteTimestamp() });
    }
    record(job.attempt_id, settleStrandedItems(repo, job.attempt_id, parseItemIds(job), INTERRUPTED_ITEM_SCORE_JSON, readSet), true);
  }

  const allJobs = repo.listAllScoringJobs();
  for (const job of allJobs) {
    const released = releaseCancelledJobItems(repo, job.id, readSet);
    if (released) record(released.attemptId, released.items);
  }

  // `allJobs` was read after step 1, so a job step 1 just failed counts as covering its Items, which
  // step 1 already settled: they are not orphans to handle twice.
  const covered = new Set<string>();
  for (const job of allJobs) {
    if (!scoringJobCoversItsItems(job)) continue;
    for (const itemId of parseItemIds(job)) covered.add(jobItemKey(job.attempt_id, itemId));
  }
  const orphansByAttempt = new Map<string, string[]>();
  for (const { attemptId, itemId } of repo.listPendingItemsWithTranscript()) {
    if (covered.has(jobItemKey(attemptId, itemId))) continue;
    orphansByAttempt.set(attemptId, [...(orphansByAttempt.get(attemptId) ?? []), itemId]);
  }
  for (const [attemptId, itemIds] of orphansByAttempt) {
    record(attemptId, settleStrandedItems(repo, attemptId, itemIds, INTERRUPTED_ITEM_SCORE_JSON, readSet));
  }

  return { jobs: interrupted.length, items: itemsResolved };
}

/**
 * The scoring family's boot-only read, across every Attempt. Kept off ScoringJobStore so only the
 * boot recovery store type exposes it.
 */
export type ScoringBootStore = {
  listUnscoredItemsWithTranscript(): { attemptId: string; itemId: string; scoring_status: string; transcript: string }[];
};

/**
 * A boot pass: scores every unscored (pending or failed) Item whose transcript is a no-speech
 * recording its deterministic 0, whatever path left it unscored. Items without a transcript
 * (lost-upload and skip placeholders, essays) are never touched. Idempotent: a scored Item is not a
 * candidate. Returns how many it scored.
 */
export function scoreSilentItemsLeftUnscored(deps: {
  repo: ScoringBootStore & Pick<ScoringStore, "getAttempt" | "updateItemScore">;
  setStore?: SetReader;
  onAttemptChanged?: (attemptId: string) => void;
}): number {
  const setStore = deps.setStore ?? createSetStore();
  const silentByAttempt = new Map<string, string[]>();
  for (const row of deps.repo.listUnscoredItemsWithTranscript()) {
    if (spokenResponseState(row) !== "no-speech") continue;
    silentByAttempt.set(row.attemptId, [...(silentByAttempt.get(row.attemptId) ?? []), row.itemId]);
  }
  let scored = 0;
  for (const [attemptId, itemIds] of silentByAttempt) {
    const attempt = deps.repo.getAttempt(attemptId);
    if (!attempt) continue;
    const set = setStore.readSet(attempt.set_id);
    for (const itemId of itemIds) {
      deps.repo.updateItemScore(noSpeechScoreWrite(attemptId, itemId, spokenItemPrompt(set, itemId)));
      scored += 1;
    }
    deps.onAttemptChanged?.(attemptId);
  }
  return scored;
}

function jobItemKey(attemptId: string, itemId: string): string {
  return `${attemptId}::${itemId}`;
}

/**
 * A job's `item_ids`. Malformed JSON yields [] with a warning rather than a throw, because boot
 * recovery must not crash on the state it exists to clean up. A row read as [] settles and covers
 * nothing, so a still-pending Item with a transcript and no other covering job falls to the orphan
 * sweep. speakingFinalization's orphan heal reads coverage through this too.
 */
export function parseItemIds(job: ScoringJobRow): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(job.item_ids);
  } catch (err) {
    console.warn(
      `[scoringJobs] scoring_jobs row ${job.id} has corrupt item_ids JSON, skipping its items: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
  if (!Array.isArray(parsed) || !parsed.every((x) => typeof x === "string")) {
    console.warn(`[scoringJobs] scoring_jobs row ${job.id} has non-string-array item_ids, skipping its items: ${job.item_ids}`);
    return [];
  }
  return parsed;
}
