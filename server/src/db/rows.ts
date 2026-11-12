import type { CancellationReason, FullTestSection, GenerationBatchStatus, TranscriptionFailureKind, TranscriptionJobStatus } from "@toefl-prep/shared";
import type { DurableJobClaim } from "../services/durableJobRunner.js";

// The row and insert shapes the database hands back and takes. No SQL and no database handle: nothing
// here may take a `Database` or declare a method, so a module can name a row without importing a
// store. A shape that needs a query to produce it gets that query in db/stores/.

export interface AttemptRow {
  id: string;
  kind: string;
  mode: string;
  set_id: string;
  is_repeat: 0 | 1;
  status: string;
  started_at: string;
  completed_at: string | null;
  capture_finished_at: string | null;
  flagged: 0 | 1;
  // The Module Path a Reading/Listening Simulation was routed to and the Router raw score the cut was
  // applied to; both NULL for an Attempt that was never routed.
  module_path: "lower" | "upper" | null;
  router_raw: number | null;
}

export interface TranscriptionJobRow {
  id: string; attempt_id: string; item_id: string; task_type: "listen_repeat" | "interview";
  audio_path: string; audio_sha256: string; status: TranscriptionJobStatus;
  automatic_attempts: number; next_retry_at: string | null; failure_kind: TranscriptionFailureKind | null;
  error: string | null; score_job_id: string | null;
  created_at: string; updated_at: string;
}

export interface LatestEstimateRow {
  attemptId: string;
  section: string;
  rawDetail: string;
  estimatedBand: number;
  method: string;
  mode: string;
  startedAt: string;
  completedAt: string | null;
  // The Module Path of the backing Attempt; null for Speaking/Writing. A table3-v1 estimate is
  // persisted only for a routed Simulation (completeWithLocalEstimate in routes/attempts.ts), so a
  // Reading/Listening row has one. Carried so the Dashboard discloses it wherever the band appears.
  modulePath: "lower" | "upper" | null;
}

export interface TrendRow {
  attemptId: string;
  mode: string;
  isRepeat: 0 | 1;
  startedAt: string;
  completedAt: string | null;
  avgScore: number;
}

export interface JudgeReportListRow {
  attemptId: string;
  itemId: string;
  judge: string;
  reportJson: string;
}

export interface ScoringJobRow {
  id: string;
  attempt_id: string;
  task_type: string;
  item_ids: string; // JSON array of item id strings
  status: string; // 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  stage: string | null;
  progress: string | null; // JSON — the current stage's ScoringProgressDetail (e.g. judgesDone while judging)
  result: string | null; // JSON — the terminal scoreItems() response payload, set once on status='done'
  error: string | null;
  cancel_requested_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: CancellationReason | null;
  terminal_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GenerationJobRow {
  id: string;
  kind: string; // 'speaking' | 'writing' | 'reading' | 'listening'
  status: string; // 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  stage: string | null;
  progress: string | null; // JSON — the job's cumulative GenerationProgressDetail
  set_id: string | null; // set as soon as generateSet() mints it, not only once status='done' — see schema.sql
  error: string | null;
  cancel_requested_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: CancellationReason | null;
  terminal_at: string | null;
  batch_id: string | null; // NULL for a standalone job, the batch's id for a batch child
  batch_index: number | null; // this child's 0-based position in its batch's execution order
  created_at: string;
  updated_at: string;
}

export interface GenerationBatchRow {
  id: string;
  total: number;
  status: string; // 'queued' | 'running' | 'done' | 'partial' | 'failed' | 'cancelled'
  cancel_requested: 0 | 1;
  cancel_requested_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: CancellationReason | null;
  terminal_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export type { CancellationReason, GenerationBatchStatus } from "@toefl-prep/shared";
export type CancellationRequestResult = { accepted: boolean; state: "cancel_requested" | "cancelled" | "publication_committed" | "terminal" };
// Three-valued rather than a boolean because the two refusals oblige the caller to do opposite
// things: 'cancel_requested' is a row still 'queued' and held off 'running' only by a cancellation
// already recorded, which nobody else will come for, so the caller owes it a terminal state;
// 'unclaimable' is a row that vanished or that something else moved on, which is not the caller's to
// touch. The contract is the durable runner's (DurableJobClaim in durableJobRunner.ts); generation's
// call sites use this name.
export type GenerationJobClaimResult = DurableJobClaim;
export type { DurableJobClaim };
export type DiagnosticOutcome = "success" | "failure" | "cancelled";

export interface RouteInvocationInsert {
  id: string; operation: string; family: "scoring" | "generation";
  contextKind?: string; contextId?: string; contextDetail?: string;
  queuedAtMs: number; finishedAtMs?: number; durationMs?: number;
  outcome?: DiagnosticOutcome; failureKind?: string; cancellationReason?: CancellationReason;
}
export interface ProviderExecutionInsert {
  id: string; routeInvocationId: string; sequence: number; provider: string;
  family: "scoring" | "generation"; operation: string; queuedAtMs: number;
  dequeuedAtMs?: number; startedAtMs?: number; finishedAtMs?: number;
  queueMs?: number; durationMs?: number; outcome?: DiagnosticOutcome;
  failureKind?: string; cancellationReason?: CancellationReason;
}
export interface ModelAttemptInsert {
  id: string; providerExecutionId: string; sequence: number; kind: "initial" | "repair";
  model?: string; prompt?: string; promptOmittedBytes?: number; response?: string;
  responseOmittedBytes?: number; startedAtMs: number; finishedAtMs?: number;
  durationMs?: number; outcome?: DiagnosticOutcome; failureKind?: string;
  cancellationReason?: CancellationReason;
}

export interface RouteInvocationRow {
  id: string; operation: string; family: string; context_kind: string | null; context_id: string | null;
  context_detail: string | null; queued_at_ms: number; finished_at_ms: number | null;
  duration_ms: number | null; outcome: DiagnosticOutcome | null; failure_kind: string | null;
  cancellation_reason: CancellationReason | null; created_at: string;
}
export interface ModelAttemptRow {
  id: string; provider_execution_id: string; sequence: number; kind: "initial" | "repair"; model: string | null;
  prompt: string | null; prompt_omitted_bytes: number; response: string | null; response_omitted_bytes: number;
  started_at_ms: number; finished_at_ms: number | null; duration_ms: number | null;
  outcome: DiagnosticOutcome | null; failure_kind: string | null; cancellation_reason: CancellationReason | null;
  created_at: string;
}
export interface ProviderExecutionRow {
  id:string;route_invocation_id:string;sequence:number;provider:string;family:string;operation:string;
  queued_at_ms:number;dequeued_at_ms:number|null;started_at_ms:number|null;finished_at_ms:number|null;
  queue_ms:number|null;duration_ms:number|null;outcome:DiagnosticOutcome|null;failure_kind:string|null;
  cancellation_reason:CancellationReason|null;created_at:string;
}

// One row of full_test_runs. `*_at` values are space-form UTC; routes/fullTests.ts converts them to
// instants at the boundary.
export interface FullTestRunRow {
  id: string;
  status: string; // 'in-progress' | 'completed' | 'abandoned'
  current_section: FullTestSection | null;
  reading_attempt_id: string | null;
  listening_attempt_id: string | null;
  writing_attempt_id: string | null;
  speaking_attempt_id: string | null;
  reading_set_id: string | null;
  listening_set_id: string | null;
  writing_set_id: string | null;
  speaking_set_id: string | null;
  created_at: string;
  completed_at: string | null;
}

// One row per retired Set (docs/adr/0011).
export interface SupersededSetRow {
  set_id: string;
  superseded_by: string;
  superseded_at: string;
}

export type ModelCallProvider = "claude" | "codex" | "openai-http" | "gemini-http";

export interface ModelCallRow {
  id: string;
  provider: string;
  model: string | null;
  route: string;
  task: string | null;
  context_kind: string | null;
  context_id: string | null;
  context_detail: string | null; // JSON — e.g. {"stage":"generating","generationAttempt":3}
  attempt_index: number;
  prompt: string;
  response: string | null; // NULL means "no output at all", distinct from an empty response
  outcome: string; // 'succeeded' | 'failed'
  failure_kind: string | null;
  queue_ms: number | null;
  duration_ms: number | null;
  created_at: string;
}

export interface ModelCallInsert {
  id: string;
  provider: ModelCallProvider;
  model?: string;
  route: string;
  task?: string;
  contextKind?: string;
  contextId?: string;
  contextDetail?: string;
  attemptIndex?: number;
  prompt: string;
  response?: string;
  outcome: "succeeded" | "failed";
  failureKind?: string;
  queueMs?: number;
  durationMs?: number;
}

/**
/**
 * Which take of a clip a measurement row describes. `null` on rows written before the column existed:
 * which take shipped is not derivable from them, so they are left unmigrated rather than guessed at
 * (schema.sql on `clip_measurements.take_disposition`).
 */
export type ClipTakeDisposition = "published" | "discarded";

export interface ClipMeasurementRow {
  id: string;
  set_id: string;
  context_kind: string | null;
  context_id: string | null;
  role: string;
  file: string;
  word_count: number;
  duration_sec: number;
  wpm: number;
  speed: number;
  correction_count: number;
  accent: string | null;
  profile_version: string | null;
  in_band: 0 | 1;
  take_disposition: ClipTakeDisposition | null;
  created_at: string;
}

export interface ClipMeasurementInsert {
  id: string;
  setId: string;
  contextKind?: string;
  contextId?: string;
  role: string;
  file: string;
  wordCount: number;
  durationSec: number;
  wpm: number;
  speed: number;
  correctionCount: number;
  accent?: string;
  profileVersion?: string;
  inBand: boolean;
  /**
   * The live renderer always inserts 'discarded' and promotes the take it publishes afterwards; the
   * manifest reconciliation passes the value the render already resolved. Omitted, the column stays
   * NULL rather than acquiring a made-up value.
   */
  takeDisposition?: ClipTakeDisposition;
  /**
  /**
   * Reconciliation only: when the render happened, for a row replayed from another checkout's
   * manifest. Space-form UTC (db/timestamps.ts); omitted on the live path, where SQLite's
   * `datetime('now')` default writes the same form.
   */
  createdAt?: string;
}

export interface ItemResultRow {
  attempt_id: string;
  item_id: string;
  task_type: string;
  response_text: string | null;
  response_audio_path: string | null;
  transcript: string | null;
  score: number | null;
  score_json: string | null;
  scoring_status: string;
  delivery_report: string | null;
  // Set by updateItemScore when the Item is scored and reset to NULL on any other status (a failed
  // re-score, a fresh insert), so it says whether the row is scored now, and since when.
  scored_at: string | null;
  created_at: string;
}
