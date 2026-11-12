import type { FullTestSection, JudgeReport, SetAdvisoryNote } from "./schemas.js";

// The response shapes server routes build and the client consumes as-is. Distinct from the row types in
// server/src/db/rows.ts, which mirror SQLite's snake_case columns and stay on the server. A route that
// annotates the value it sends with `satisfies` gets a compile error for a renamed field instead of
// sending `undefined`.
//
// Every timestamp field here is an ISO-8601 instant ("2026-08-22T12:50:10.000Z"). The SQLite columns
// behind most of them hold space-form UTC, which routes convert with sqliteTimestampToIso
// (server/src/db/timestamps.ts); client code parses with `new Date(value)` and never converts, because
// `new Date` reads the space form as local time.

export type Section = "speaking" | "writing" | "reading" | "listening";
export type AttemptKind = "speaking" | "writing" | "reading" | "listening";
export type AttemptMode = "drill" | "simulation";
export type AttemptStatus = "in_progress" | "completed" | "aborted";
export type TranscriptionFailureKind = "network" | "timeout" | "rate-limit" | "provider" | "invalid-output" | "authentication" | "configuration" | "unsupported-audio" | "unsafe-path" | "missing-recording" | "corrupt-recording";
export type TranscriptionJobStatus = "queued" | "running" | "retry_wait" | "awaiting_score" | "done" | "failed" | "superseded";
export interface TranscriptionJobVM { jobId: string; status: TranscriptionJobStatus; automaticAttempts: number; nextRetryAt: string | null; failureKind: TranscriptionFailureKind | null; error: string | null; scoreJobId: string | null; }

export interface AttemptVM {
  id: string;
  kind: AttemptKind;
  mode: AttemptMode;
  setId: string;
  /**
   * The Set's display title (see SetListEntryVM.title), or null when the Set can no longer be read —
   * the caller then labels the Attempt by `setId`.
   */
  setTitle: string | null;
  isRepeat: boolean;
  status: AttemptStatus;
  startedAt: string;
  completedAt: string | null;
  captureFinishedAt: string | null;
  flagged: boolean;
  // The Module Path a Reading/Listening Simulation was routed to and the Router raw score the cut was
  // applied to; both null (or absent) for an Attempt that was never routed.
  modulePath?: "lower" | "upper" | null;
  routerRaw?: number | null;
}

/**
 * One row of the Attempt log: the Attempt and its own Band Estimate. The estimate is read through
 * the same coverage rule as every other band surface, so a row persisted from part of a section is
 * null here, never a band. `method` is the versioned estimator it was computed under, verbatim.
 */
export interface AttemptListItemVM extends AttemptVM {
  estimate: { band: number; method: string } | null;
  /**
   * The Full-Test Run that has this Attempt as one of its sections, or null. A section restarted
   * after a reload leaves its old Attempt pointed at by no Run, so that one is null too. While the
   * Run is in progress and this Attempt is unfinished, it is the section the Run is sitting: the
   * log offers the way back into the Run instead of finishing or discarding it, and
   * POST /api/attempts/:id/abort refuses it.
   */
  fullTestRun: { id: string; status: FullTestRunStatus } | null;
}

/**
 * GET /api/attempts — one page of the Attempt log, newest first. `total` counts every Attempt that
 * matches the request's filters, not just this page, so "See all N attempts" and "load more" are
 * stated against the whole log.
 */
export interface AttemptListVM {
  items: AttemptListItemVM[];
  total: number;
}

export interface ItemVM {
  attemptId: string;
  itemId: string;
  taskType: string;
  responseText: string | null;
  responseAudioPath: string | null;
  transcript: string | null;
  score: number | null;
  // Parsed item_results.score_json when present AND parseable; null when absent OR when the
  // persisted JSON is corrupt (defensive — never throws/500s, just omits the parsed field). A
  // Simulation's Build a Sentence Item carries its key (`correctAnswers`) only once the Attempt is
  // completed; before that the field is absent.
  scoreJson: unknown | null;
  scoringStatus: string;
  deliveryReport: string | null;
  createdAt: string;
  transcriptionJob?: TranscriptionJobVM;
}

// What judge_reports.report_json holds: the JudgeReport plus, for Speaking, whether the Judge heard the
// audio or scored in Text Fallback.
export type PersistedJudgeReport = JudgeReport & { mode?: "audio" | "text-fallback" };

export type ReasoningProvider = "claude" | "codex" | "openai-http";

export type ReasoningFailureKind =
  | "missing-cli"
  | "authentication"
  | "quota"
  | "rate-limit"
  | "provider"
  | "timeout"
  | "invalid-output"
  | "configuration"
  | "application";

export type ReasoningProgressDetail = {
  provider?: ReasoningProvider;
  fallbackFrom?: ReasoningProvider;
  queuePosition?: number;
};

export type ScoringProgressDetail = {
  judgesDone?: string[];
  judgesFailed?: string[];
  openaiJudgeProvider?: "codex" | "openai-http";
  arbiterProvider?: "claude" | "codex";
  fallbackFrom?: "claude" | "codex";
  queuePosition?: number;
};

export interface ReasoningProviderStatusVM {
  provider: "claude" | "codex";
  availability: "checking" | "available" | "circuit-open";
  failureKind?: ReasoningFailureKind;
  retryAt?: string;
}

export interface ReasoningStatusVM {
  providers: ReasoningProviderStatusVM[];
  operationalProviders: Array<{
    provider: "claude" | "codex";
    active: Record<"scoring" | "generation", number>;
    queued: Record<"scoring" | "generation", number>;
    effectiveCapacity: number;
    reservedScoring: number;
    pressureStrikes: number;
    circuitState: "closed" | "open" | "probing";
    probeOwner?: string;
    oldestHeldAgeMs?: number;
    queueLatencyMs?: { count: number; total: number; max: number };
  }>;
  processMetrics: {
    cancellations: number;
    timeouts: number;
    forcedKills: number;
    fallbacks: number;
    recorderLoss: { overflow: number; database: number; total: number };
  };
  openaiTextPrimary: "codex" | "http";
  codexModel: string;
  codexReasoningEffort: string;
}

export interface JudgeReportVM {
  itemId: string;
  judge: "gemini" | "openai";
  mode?: "audio" | "text-fallback";
  // Parsed report_json; null when the persisted JSON is corrupt (defensive — never 500s).
  report: PersistedJudgeReport | null;
}

// One Attempt's Band Estimate as POST /:id/complete computes it and section_estimates stores it: the
// band (1–6), the 0–1 raw score it was mapped from, the versioned method and per-Task-Type coverage.
export interface SectionEstimateVM {
  section: Section;
  band: number;
  raw: number;
  method: string;
  // `skippedCount`: how many of a Task Type's Items are deliberate skips scored 0. Absent on rows
  // persisted before skips were counted; read absence as "not disclosed", never as zero.
  coverage: { taskType: string; itemCount: number; skippedCount?: number }[];
}

export type CancellationReason = "user" | "superseded" | "parent_cancelled" | "shutdown";

export interface CancellationMetadataVM {
  cancellationRequestedAt?: string | null;
  terminalAt?: string | null;
  cancellationReason?: CancellationReason | null;
}

// scoring_jobs.status, as a union so a client switch on it is exhaustive.
export type ScoringJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

// One queued or running scoring job, listed in AttemptDetailVM.activeJobs so a page returning to an
// Attempt re-attaches to its live progress. GET /:id/score-jobs/:jobId answers with
// ScoringJobDetailVM, which adds the progress, result and error.
export interface ScoringJobVM {
  jobId: string;
  taskType: string;
  /**
   * The Items this job scores. A job covers a subset of its Task Type's Items — a Re-score sends only
   * the Items that need it, and transcription recovery enqueues one Item at a time — so a client
   * draws a job's progress or failure over exactly these Items and leaves the others' persisted
   * scores on screen.
   */
  itemIds: string[];
  stage: string | null;
  status: ScoringJobStatus;
}

// GET /api/attempts/:id/score-jobs/:jobId: one job's live progress. `stage` is "judging",
// "aggregating" or "persisting", and `progress` that stage's detail (judgesDone/judgesFailed while
// judging). `result` is a done job's scoreItems() payload and `error` a failed job's message; each key
// is absent until the job has one. The provider fields of `progress` (`openaiJudgeProvider`,
// `arbiterProvider`, `fallbackFrom`) exist only while the job is queued or running: the write that ends
// a job removes them.
export interface ScoringJobDetailVM extends ScoringJobVM, CancellationMetadataVM {
  progress: ScoringProgressDetail | null;
  result?: unknown;
  error?: string;
}

/**
 * POST /api/attempts/:id/score's inline answer to a Build a Sentence request, one entry per requested
 * Item. A Drill's entries carry the key: every accepted arrangement (`correctAnswers`) and the one
 * the Response matched (`matchedAnswer`, null when it matched none). A Simulation's carry bare
 * correctness, and its keys reach the client only in the review of the completed Attempt.
 */
export interface BuildSentenceDrillScoreItemVM {
  itemId: string;
  correct: boolean;
  matchedAnswer: string[] | null;
  correctAnswers: string[][];
}
export interface BuildSentenceSimulationScoreItemVM {
  itemId: string;
  correct: boolean;
}
export type BuildSentenceScoreVM =
  | { taskType: "build_sentence"; items: BuildSentenceDrillScoreItemVM[] }
  | { taskType: "build_sentence"; items: BuildSentenceSimulationScoreItemVM[] };

// One reviewable Reading/Listening Item of a completed Attempt: its key and Explanation (錯題解析),
// re-derived from the Set. They are never stored, and before the Attempt completes only a Drill's own
// inline score response shows them. `correct` is read from item_results.score, not from what the client
// submitted.
export interface DeterministicReviewItemVM {
  itemId: string;
  taskType: string;
  correct: boolean;
  key?: string;
  explanationZh?: string;
  // The Stimulus transcript, for Listening's Conversation, Announcement and Academic Talk only (one
  // "<role>: <text>" line per turn for a Conversation). Never set for Listen and Choose a Response,
  // whose utterance is never shown as text, even after answering.
  transcript?: string;
}

/**
 * What stands between a settled Attempt and a Band Estimate, as counts a surface puts in the User's
 * words. A band needs every Item of the section's Task Types scored — a deliberate skip is a scored
 * 0 and counts — and every Task Type the section requires present (docs/adr/0010).
 *
 *   unscored          each Task Type with Items that are not scored, in section order: how many
 *                     failed scoring, how many are still unscored (pending, or waiting on a
 *                     transcription), and how many recordings never reached the server. The three
 *                     are disjoint.
 *   absent            Speaking and Writing: the Task Types the section requires that have no Item
 *                     at all, in section order. Always empty for Reading and Listening, whose
 *                     missing Task Types are per Module, in `moduleShortfalls`.
 *   moduleShortfalls  Reading and Listening only, and absent unless a Module is short: a routed
 *                     Attempt's band needs Items of both Modules it took, the Router Module and
 *                     the one its Module Path names, each covering every Task Type that Module
 *                     carries. One entry per short Module, Router first.
 *
 * All three empty means every Item is scored and there is still no band on record for the Attempt.
 */
export interface BandShortfallVM {
  unscored: { taskType: string; failed: number; pending: number; notCaptured: number }[];
  absent: string[];
  moduleShortfalls?: ModuleShortfallVM[];
}

/**
 * One Module of a routed Reading or Listening Attempt that is short of Items (BandShortfallVM).
 * `sat` is false when the Attempt has no Item of the Module at all: for the Module its Module Path
 * names, an Attempt routed there and finished before any of it was answered. `absent` lists the
 * Task Types the Module carries that have no Item of it, in section order (all of them when `sat`
 * is false).
 */
export interface ModuleShortfallVM {
  module: "router" | "lower" | "upper";
  sat: boolean;
  absent: string[];
}

/**
 * Why an Attempt does or does not have a Band Estimate, so its review can say so in the User's
 * terms instead of showing an empty space. Checked in this order:
 *
 *   estimated       `estimate` holds the band. The only status with a band, and exactly when
 *                   `estimate` is non-null.
 *   discarded       the Attempt was discarded; it counts toward nothing.
 *   not-applicable  a Reading/Listening Attempt that cannot have a band: a Drill (`drill`), or a
 *                   Simulation that ended before its Router Module was routed (`not-routed`).
 *   unfinished      started and never submitted.
 *   scoring         work that can still change the band is live: a scoring job, a transcription
 *                   job, or a Speaking capture the server is still finalizing. `outstanding` counts,
 *                   per Task Type, the judged Items not scored yet or being re-scored.
 *   incomplete      scoring has settled and the Attempt has no band; the BandShortfallVM fields say
 *                   which Items and Task Types stand in the way.
 */
export type AttemptBandStatusVM =
  | { status: "estimated" }
  | { status: "discarded" }
  | { status: "not-applicable"; reason: "drill" | "not-routed" }
  | { status: "unfinished" }
  | { status: "scoring"; outstanding: { taskType: string; itemCount: number }[] }
  | ({ status: "incomplete" } & BandShortfallVM);

export interface AttemptDetailVM {
  attempt: AttemptVM;
  items: ItemVM[];
  judgeReports: JudgeReportVM[];
  // The estimate persisted for THIS attempt specifically, not the section's current best across all
  // attempts — null when this Attempt has no band (see `bandStatus` for why), including when a row
  // persisted under an older, looser rule no longer passes against its current Items.
  estimate: SectionEstimateVM | null;
  /** Where this Attempt's Band Estimate stands, and why there is none when there is none. */
  bandStatus: AttemptBandStatusVM;
  // Queued or running scoring jobs (ScoringJobVM). Deterministic Task Types, Build a Sentence included,
  // are scored inline and never appear here.
  activeJobs: ScoringJobVM[];
  // Present only for a completed Reading or Listening Attempt, Drill or Simulation; absent, not empty,
  // otherwise.
  deterministicReview?: DeterministicReviewItemVM[];
}

/**
 * One entry of GET /api/sets — a Set as the practice lists and the Simulation picker show it.
 *
 * `title` and `summary` are derived on the server from the served form of the Set (after
 * `stripAnswers`), so they can only quote text the User is shown anyway: a scenario, an email
 * subject, a passage title, a setting. `title` is at most 60 characters; `summary` is one line, or
 * null when the Set has nothing to add beyond its title.
 *
 * `attempted` is true when at least one Attempt on the Set has a scored Item, or is completed and
 * holds at least one Item, so a Set opened and abandoned with nothing scored, or completed with
 * nothing answered, stays unattempted.
 *
 * `createdAt` comes from the Set's own JSON and is already ISO-8601.
 * `advisoryNotes` is absent, not empty, on a Set that carries none.
 */
export interface SetListEntryVM {
  id: string;
  kind: Section;
  source: string;
  createdAt: string;
  title: string;
  summary: string | null;
  attempted: boolean;
  advisoryNotes?: SetAdvisoryNote[];
}

/**
 * One Set file on disk that failed schema validation, as GET /api/sets/unloadable serves it.
 * Content-free by construction: `kind` and `file` are a directory and a file name, and `error` names
 * the failing field and rule without quoting the file's text.
 */
export interface SetLoadFailureVM {
  kind: string;
  file: string;
  error: string;
}

export interface UnloadableSetsVM {
  count: number;
  failures: SetLoadFailureVM[];
}

export interface TrendPointVM {
  date: string;
  attemptId: string;
  mode: AttemptMode;
  isRepeat: boolean;
  taskType: string;
  avgScore: number;
}

/**
 * One section's headline Band Estimate on the Dashboard. A section is listed only once a completed
 * non-Repeat Attempt has a Band Estimate — every Item of its Task Types scored, every Task Type it
 * needs present; nothing stands in for one that does not exist yet.
 */
export interface StatsSectionVM {
  section: Section;
  band: number;
  /** The versioned estimate method (`linear-v2`, `table3-v1`, or a persisted older one). */
  method: string;
  attemptId: string;
  mode: AttemptMode;
  /** When the backing Attempt finished (or began, if it never completed), as ISO-8601. */
  attemptedAt: string;
  /** The User's Target for this section, the same number GET /api/stats/settings reports. */
  target: number;
  /**
   * The Module Path of the backing Attempt, present only for a routed Reading/Listening Simulation
   * (table3-v1's own precondition), so the Dashboard can disclose it wherever this band appears.
   */
  modulePath?: "lower" | "upper";
  /**
   * The min and max of the section's last three non-Repeat Simulation bands (each a Band Estimate by
   * the same rule as the headline), and how many there were. Absent when the section has no such
   * Simulation, which also means the headline is a Drill's.
   */
  recentSimulationRange?: { min: number; max: number; count: number };
}

/**
 * The Dashboard's Overall: the rounded mean of the four sections' Band Estimates. It exists only
 * when all four sections have one — a mean of fewer is a different number, not a rough Overall.
 */
export interface StatsOverallVM {
  /** The rounded mean, or null while `missingSections` is non-empty. */
  band: number | null;
  /** Sections with no Band Estimate yet, in test order. Empty exactly when `band` is a number. */
  missingSections: Section[];
}

export interface StatsSummaryVM {
  sections: StatsSectionVM[];
  overall: StatsOverallVM;
  weaknesses: { category: string; count: number }[];
  // avgDelta is null when sampleSize is 0 (no matched Judge Report pairs yet): there is no average of
  // zero deltas, and 0.0 would read as perfect agreement.
  judgeAgreement: { avgDelta: number | null; sampleSize: number };
  // The User's most recently scored Reading/Listening questions, unaggregated. `skill` is stripped from
  // every served Set, so it comes only from already-scored item_results rows. The client buckets them by
  // section and skill (the two sections share some skill names), filters and sorts them
  // (computeSkillAccuracy in client/src/pages/weaknessCategories.ts).
  skillItems: { section: "reading" | "listening"; skill: string; correct: boolean }[];
  // The most `skillItems` the server sends: the window is the latest this many, and the pane names it.
  skillItemsLimit: number;
}

// GET /api/stats/settings, and the response to PUT /api/stats/settings (whose request is a partial
// `{ targets }` patch): the User's Target band for each section, 5.5 until they set one.
export interface StatsSettingsVM {
  targets: Record<Section, number>;
}

// generation_jobs.status. There is no 'superseded': generation jobs never replace one another.
// 'cancelled' is reachable by a standalone job and by a batch child: POST /api/generate/:id/cancel takes
// either id, cancelling a batch cascades 'parent_cancelled' to its live children, and shutdown cancels
// whatever is in flight.
export type GenerationJobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

// The final outcome of a Speaking generation's two optional scene calls. Neither failure fails the job:
// a failed image publishes an audio-only Set and skips regions, and failed regions publish the image
// without highlights. Carried in the job's progress at `saving`/`done`, not in the Set.
export type SceneGenerationOutcome = {
  image: "succeeded" | "failed";
  regions: "succeeded" | "failed" | "skipped";
};

// One cross-set collision a Plan was admitted with rather than rejected for. The scrubbed shape and
// nothing more (ids, kinds, counts, positions; scrubDiversityIssues in diversityIssues.ts): never a plan
// label or any scenario, topic or title text, which no channel to the UI may carry. `taskType` and
// `kind` are plain strings because a client must not depend on the exact membership of a server-side
// union it never validates.
export type NoveltyResidualIssue = {
  taskType: string;
  kind: string;
  conflictingSetIds?: string[];
  itemPosition?: number;
  score?: number;
};

export type GenerationProgressDetail = ReasoningProgressDetail & {
  position?: number;
  done?: number;
  total?: number;
  setId?: string;
  scene?: SceneGenerationOutcome;
  // Durable retry counters for the two bounded diversity phases. They intentionally expose only
  // ordinal progress, never the private plan/catalog or generated User-facing content.
  planningAttempt?: 1 | 2 | 3;
  generationAttempt?: 1 | 2 | 3;
  maxDiversityAttempts?: 3;
  // The collisions the Plan was admitted with. Non-fatal, so it rides progress (as `scene` does) rather
  // than `error`, and survives generationJobs.ts's progress merge so a done job still shows it.
  noveltyResidual?: NoveltyResidualIssue[];
};

// GET /api/generate/:jobId for a standalone job or a batch child. `stage` is a GenerationStage
// (server/src/services/generationReasoning.ts), null before the first checkpoint; "rendering-image" and
// "locating-regions" are Speaking-only and may fail without failing the Set. `progress` is that stage's
// detail: {position} while queued, {done,total} while a Speaking Set renders its 13 clips, the `scene`
// outcome at saving/done. `setId` is present from the moment the Set id is minted, before the job is
// done; `error` only once it has failed.
export interface GenerationJobDetailVM extends CancellationMetadataVM {
  jobId: string;
  kind: "speaking" | "writing" | "reading" | "listening";
  status: GenerationJobStatus;
  stage: string | null;
  progress: GenerationProgressDetail | null;
  setId?: string;
  error?: string;
}

// generation_batches.status. 'partial' and 'cancelled' are told apart by what survived, not by what
// ended the batch: 'partial' means at least one child published, 'cancelled' that none did and at least
// one was cancelled. A cancel after some Sets were generated therefore leaves the batch 'partial', and
// those Sets are kept. computeBatchStatus in generationJobs.ts is the one implementation, for the live
// runner and boot recovery alike.
export type GenerationBatchStatus = "queued" | "running" | "done" | "partial" | "failed" | "cancelled";

// One child of a batch, in execution order (generation_jobs.batch_index): the per-job fields of
// GenerationJobDetailVM plus `setIndex`, so the client can say "set N of total".
export interface GenerationBatchChildVM {
  jobId: string;
  setIndex: number;
  kind: "speaking" | "writing" | "reading" | "listening";
  status: GenerationJobStatus;
  stage: string | null;
  progress: GenerationProgressDetail | null;
  setId?: string;
  error?: string;
  cancellationRequestedAt?: string | null;
  terminalAt?: string | null;
  cancellationReason?: CancellationReason | null;
}

export type GenerationBatchActiveChildVM = Pick<
  GenerationBatchChildVM,
  "jobId" | "setIndex" | "kind" | "stage" | "progress"
>;

// GET /api/generate/:jobId when the id is a batch's, discriminated from GenerationJobDetailVM by
// `kind: "batch"`, which no job has. `completed`/`failed`/`cancelled` are counted from `children` on each
// read, so they cannot drift from the list. `active` holds every running child in batch-index order;
// `current`, the lowest-index active child or null, is kept for clients that still read it.
export interface GenerationBatchDetailVM extends CancellationMetadataVM {
  jobId: string;
  kind: "batch";
  status: GenerationBatchStatus;
  total: number;
  queued: number;
  activeCount: number;
  completed: number;
  failed: number;
  cancelled: number;
  cancelRequested: boolean;
  active: GenerationBatchActiveChildVM[];
  activeChildIds: string[];
  current: GenerationBatchActiveChildVM | null;
  children: GenerationBatchChildVM[];
}

export type GenerationJobOrBatchDetailVM = GenerationJobDetailVM | GenerationBatchDetailVM;

// GET /api/generate (no id): every batch and standalone job still queued or running, newest first, so
// a freshly mounted page re-attaches to work still running on the server. Each entry is the per-id
// detail shape GET /api/generate/:jobId serves, plus `createdAt`, so the client's elapsed clock starts
// at the job's real start. Batch children are covered by their batch.
export type ActiveGenerationEntryVM = GenerationJobOrBatchDetailVM & { createdAt: string };
export interface ActiveGenerationListVM {
  active: ActiveGenerationEntryVM[];
}

// ---------------------------------------------------------------------------------------------
// Full-Test Runs: the GET/POST /api/full-tests response shapes.
// ---------------------------------------------------------------------------------------------

/**
 * A Run's own lifecycle. 'completed' is stamped when the Run steps past its last section. 'abandoned'
 * is never written: a Run left mid-sitting stays 'in-progress' and can be resumed.
 */
export type FullTestRunStatus = "in-progress" | "completed" | "abandoned";

/**
 * One section's state within a Run, DERIVED on every read from the linked Attempt rather than
 * stored: 'pending' (no Attempt yet), then whatever that Attempt became. A Run therefore cannot
 * disagree with the Attempts it points at, however a client died mid-section.
 *
 * 'completed' means done sitting it, not done scoring: a Speaking Attempt that has finished capture
 * reads as completed while its Judges still run, because a Run must not wait on scoring
 * (fullTestSectionState in server/src/services/fullTestRun.ts).
 */
export type FullTestSectionState = "pending" | "in-progress" | "completed" | "aborted";

/**
 * Where a Full-Test section's Band Estimate stands, DERIVED on every read like `state`:
 *
 *   not-finished  the section's Attempt is not complete (not started, in progress or abandoned).
 *   scoring       the section is finished and work that can still change its band is live — an
 *                 active scoring job, a transcription job with work left, or a Speaking capture its
 *                 finalizer has not completed (the rule AttemptBandStatusVM's `scoring` uses). No
 *                 band is shown, even one persisted earlier, because the outcome of that work
 *                 replaces it. `outstanding` counts, per Task Type, the judged Items not scored yet
 *                 or being re-scored; it can be empty while the finalizer settles.
 *   estimated     scoring has settled and `estimate` holds the band.
 *   no-band       scoring has settled and there is no band (a judged Item left unscored with nothing
 *                 working on it counts as settled): the BandShortfallVM fields say which
 *                 Items and Task Types stand in the way, and are both empty only when the section
 *                 has every Item scored and still no band on record.
 */
export type FullTestSectionBandVM =
  | { status: "not-finished" }
  | { status: "scoring"; outstanding: { taskType: string; itemCount: number }[] }
  | { status: "estimated" }
  | ({ status: "no-band" } & BandShortfallVM);

export interface FullTestSectionVM {
  section: FullTestSection;
  /** 1-based position in FULL_TEST_SECTION_ORDER — the ETS delivery order. */
  order: number;
  /** The Set drawn for this section at Run creation. Never changes for the life of the Run. */
  setId: string | null;
  attemptId: string | null;
  state: FullTestSectionState;
  /**
   * Whether the section can be sat inside a Run at all; true for all four. The server states it
   * (RUNNABLE_FULL_TEST_SECTIONS) rather than the page keeping a list of its own.
   */
  runnable: boolean;
  /**
   * Whether this is the section the Run lets the User start now: the first, in ETS order, that is
   * neither complete nor abandoned, and only while the Run is in progress. This enforces the exam's
   * order and locks a finished section: exactly one section of an in-progress Run carries it (none
   * once every section is finished), and POST /api/attempts refuses a `fullTestRunId` link for any
   * other section by the same rule.
   */
  launchable: boolean;
  /** Why this section does or does not have a band right now — see FullTestSectionBandVM. */
  bandStatus: FullTestSectionBandVM;
  /**
   * The Band Estimate this section's completed Attempt was given — read straight off that Attempt's
   * own section_estimates row (`readPersistedEstimate`), so it carries the same estimate labelling,
   * `method` and per-Task-Type coverage as the Attempt review. Non-null exactly when
   * `bandStatus.status` is "estimated".
   */
  estimate: SectionEstimateVM | null;
  /**
   * The Module Path this section's Attempt was routed to: non-null only for a routed Reading/Listening
   * Attempt. Carried so the run report can disclose it wherever the band appears, as the Dashboard
   * does. A fact about the Attempt, not the estimate: a Reading section can be routed and still wait
   * on its band.
   */
  modulePath: "lower" | "upper" | null;
}

/**
 * The whole Run's Band Estimate: the mean of the four section bands, rounded to the nearest half band,
 * ties up (ETS's rule, Technical Manual III-3).
 *
 * Derived on every read, never stored. A Run completes when its Speaking section finishes capture,
 * while Speaking's Judges (and often Writing's) are still running, so a completed Run can have fewer
 * than four bands for a while. `band` is null for that whole time: a mean of three sections is a
 * different number, not a rough Overall. `pendingSections` names what the Run is still waiting on.
 */
export interface FullTestOverallVM {
  /** The rounded mean of all four section bands, or null while any section is still without one. */
  band: number | null;
  /**
   * The versioned combining rule (`mean-of-sections-v1`), labelled like a section estimate's method,
   * so a change to the rule cannot silently reinterpret a number already shown.
   */
  method: string;
  /** How many of the four sections have a band right now (0-4). */
  scoredSections: number;
  /**
   * The sections without a band right now, in FULL_TEST_SECTION_ORDER — whether still scoring or
   * never getting one; each section's `bandStatus` says which. Empty exactly when `band` isn't null.
   */
  pendingSections: FullTestSection[];
}

export interface FullTestRunVM {
  id: string;
  status: FullTestRunStatus;
  /** Which section the Run is currently sitting at, or null once it has stepped past the last. */
  currentSection: FullTestSection | null;
  createdAt: string;
  completedAt: string | null;
  /** Always four entries, always in FULL_TEST_SECTION_ORDER. */
  sections: FullTestSectionVM[];
  /**
   * The Run's own Band Estimate, derived from `sections` on every read — see FullTestOverallVM.
   * Always present (it is a fact about whatever the four sections currently are, computable at any
   * point in a Run's life); its `band` is what stays null until all four sections have one.
   */
  overall: FullTestOverallVM;
}

/**
 * GET /api/setup-status: what this installation can do, for a first-run screen. Every field is a
 * boolean or a small enum; no key, model id or path is ever included.
 * POST /api/setup-status/recheck re-runs the checks that can change while the server is up (both
 * CLIs' auth checks, the PATH lookups, which rubric copy resolves) and answers with the same view.
 *
 * Reading and Listening practice needs none of these and is always available.
 */
export type SetupCliState =
  /** The boot-time `auth status` / `login status` check has not answered yet. */
  | "checking"
  | "ready"
  | "not-installed"
  | "not-logged-in"
  /** Installed, but the check or recent calls failed for another reason (quota, timeouts, …). */
  | "unavailable";

export type SetupPiece =
  | "claude-cli"
  | "codex-cli"
  | "gemini-api-key"
  | "openai-api-key"
  | "gemini-judge-model"
  | "openai-judge-model"
  | "ffmpeg"
  | "ffprobe";

export type SetupCapability =
  /** Generating Reading and Writing Sets: a logged-in Claude or Codex CLI. */
  | "reading-writing-generation"
  /** Generating Speaking and Listening Sets: also Gemini text-to-speech, ffmpeg and ffprobe. */
  | "speaking-listening-generation"
  /** Scoring Write an Email / Academic Discussion: an Arbiter CLI and at least one Judge. */
  | "writing-scoring"
  /** Scoring Speaking: an Arbiter CLI, Ears (Gemini key and Judge model) and ffmpeg. */
  | "speaking-scoring"
  /** Accepting a Speaking recording at all: ffmpeg transcodes every upload. */
  | "speaking-uploads";

/**
 * Which text the Writing and Speaking rubrics are scored with. "rewritten" is this project's own
 * description of ETS's criteria, which ships with the app. "official" is ETS's own scoring-guide
 * text, which a user installs on their machine (docs/official-rubrics.md), and is reported only when
 * all four rubric files resolve to installed copies that each have every band and dimension. Any
 * other state — none installed, some installed, or an installed copy that is incomplete — reports
 * "rewritten", even though a file that is installed is read in place of its shipped copy;
 * `npm run rubrics:check` names which file is which and what an incomplete one lacks.
 */
export type RubricSource = "rewritten" | "official";

export interface SetupStatusVM {
  claudeCli: SetupCliState;
  codexCli: SetupCliState;
  geminiApiKey: boolean;
  openaiApiKey: boolean;
  geminiJudgeModel: boolean;
  openaiJudgeModel: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  /** True only when everything the capability needs is known to be present. */
  capabilities: Record<SetupCapability, boolean>;
  /**
   * Every piece known to be missing, with the capabilities it turns off. A piece whose job another
   * present piece already covers (Codex when Claude is ready) turns off nothing. A CLI still
   * `checking` is not listed.
   */
  missing: Array<{ piece: SetupPiece; disables: SetupCapability[] }>;
  rubrics: { source: RubricSource };
}
