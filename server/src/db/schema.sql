-- The schema at the current version (migrations.ts's SCHEMA_VERSION). openDb runs this file only
-- on a new, empty database; an existing one is brought here by migrations.ts. Change the two
-- together. Every *_at column holds space-form UTC text (db/timestamps.ts) unless its comment says
-- otherwise.

-- One sitting of one Set, in one mode.
CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('speaking','writing','reading','listening')),
  mode TEXT NOT NULL CHECK (mode IN ('drill','simulation')),
  set_id TEXT NOT NULL,
  is_repeat INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','aborted')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  -- Set when a Speaking Simulation has finished capturing Responses; finalization completes the
  -- Attempt once its transcription and scoring work has ended.
  capture_finished_at TEXT,
  flagged INTEGER NOT NULL DEFAULT 0,
  -- The Router's decision for a Reading/Listening Simulation and the raw Router Module score it
  -- was made on. Both NULL until it routes, and always NULL for Speaking, Writing and Drills.
  module_path TEXT CHECK (module_path IN ('lower','upper')),
  router_raw REAL
);

-- One Item's Response and its score within an Attempt.
CREATE TABLE item_results (
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  item_id TEXT NOT NULL,
  task_type TEXT NOT NULL,
  response_text TEXT,
  response_audio_path TEXT,
  transcript TEXT,
  score REAL,
  score_json TEXT,
  scoring_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (scoring_status IN ('pending','scored','failed','transcription_pending')),
  delivery_report TEXT,
  -- When the current score was written; NULL whenever the row is not scored.
  scored_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (attempt_id, item_id)
);

CREATE TABLE judge_reports (
  attempt_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  judge TEXT NOT NULL CHECK (judge IN ('gemini','openai')),
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- At most one Band Estimate per Attempt and section.
CREATE TABLE section_estimates (
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  section TEXT NOT NULL,
  raw_detail TEXT NOT NULL,
  estimated_band REAL NOT NULL,
  method TEXT NOT NULL
);
CREATE UNIQUE INDEX section_estimates_attempt_section ON section_estimates(attempt_id, section);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One request to score one Task Type's Items with the Judges and the Arbiter. A newer request for
-- the same (attempt, task type) cancels the older one with cancellation_reason 'superseded'. Nothing
-- writes status 'superseded' (migration 6 rewrote the rows that had it); the CHECK still admits it
-- because changing a CHECK means rebuilding the table.
CREATE TABLE scoring_jobs (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  task_type TEXT NOT NULL,
  item_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','done','failed','superseded','cancelled')),
  stage TEXT,
  progress TEXT,
  result TEXT,
  error TEXT,
  cancel_requested_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR cancellation_reason IN ('user','superseded','parent_cancelled','shutdown')),
  terminal_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Turning one Speaking recording into a transcript, with automatic retries. A 'retry_wait' row
-- must say when it is due, or no scheduler read would ever find it again.
CREATE TABLE transcription_jobs (
  id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  item_id TEXT NOT NULL,
  task_type TEXT NOT NULL CHECK (task_type IN ('listen_repeat','interview')),
  audio_path TEXT NOT NULL,
  audio_sha256 TEXT NOT NULL CHECK (length(audio_sha256) = 64),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','retry_wait','awaiting_score','done','failed','superseded')),
  automatic_attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  failure_kind TEXT
    CHECK (failure_kind IS NULL OR failure_kind IN (
      'network','timeout','rate-limit','provider','invalid-output','authentication',
      'configuration','unsupported-audio','unsafe-path','missing-recording','corrupt-recording'
    )),
  error TEXT,
  score_job_id TEXT REFERENCES scoring_jobs(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (attempt_id, item_id, audio_sha256),
  CHECK (status <> 'retry_wait' OR next_retry_at IS NOT NULL)
);
CREATE INDEX transcription_jobs_due ON transcription_jobs(status, next_retry_at);

-- One POST /api/generate {items:[...]}: a parent over generation_jobs children, which it runs
-- concurrently within a bounded window. `status` is derived from what the children became:
-- 'partial' means at least one Set was published, 'cancelled' that none was and at least one child
-- was cancelled. `cancel_requested` stops children that have not started and aborts running ones.
CREATE TABLE generation_batches (
  id TEXT PRIMARY KEY,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','done','partial','failed','cancelled')),
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  cancel_requested_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR cancellation_reason IN ('user','superseded','parent_cancelled','shutdown')),
  terminal_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Generating one Set.
CREATE TABLE generation_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('speaking','writing','reading','listening')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','done','failed','cancelled')),
  stage TEXT,
  progress TEXT,
  -- Written as soon as the Set id is minted, before it is published, so boot recovery can find and
  -- remove the half-written files of a job the process died during.
  set_id TEXT,
  error TEXT,
  cancel_requested_at TEXT,
  cancelled_at TEXT,
  cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR cancellation_reason IN ('user','superseded','parent_cancelled','shutdown')),
  terminal_at TEXT,
  -- NULL for a standalone job. For a batch child, its batch and its 0-based ADMISSION position
  -- (children run concurrently, so they may finish in any order).
  batch_id TEXT REFERENCES generation_batches(id),
  batch_index INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A committed promise that these exact bytes will land at canonical_path. A live intent
-- (published_at and abandoned_at both NULL) protects its job from cancellation and failure.
-- abandoned_at records an intent that can no longer be kept (neither file hashes to content_hash
-- after a crash): it stops protecting the job and stops being outstanding work.
CREATE TABLE generation_publication_intents (
  child_id TEXT PRIMARY KEY REFERENCES generation_jobs(id),
  set_id TEXT NOT NULL,
  expected_kind TEXT NOT NULL CHECK (expected_kind IN ('speaking','writing','reading','listening')),
  staging_path TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  published_at TEXT,
  abandoned_at TEXT
);

-- Files a generation job could not remove when it ended, retried by boot recovery.
CREATE TABLE cleanup_debt (
  id TEXT PRIMARY KEY,
  child_id TEXT REFERENCES generation_jobs(id),
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  last_error TEXT
);
CREATE INDEX idx_cleanup_debt_pending ON cleanup_debt(completed_at, created_at);

-- Model diagnostics (docs/adr/0004): one route invocation per text model call a job makes, each
-- provider execution it tried, and each attempt (initial, repair) within an execution, with the
-- prompt and response bounded and redacted by the recorder. Local only: no route serves these and
-- scoring never reads them. Pruned by age (MODEL_CALL_RETENTION_DAYS); deleting a route invocation
-- deletes its executions and attempts by cascade. IDs and sequences are allocated before the calls
-- run, so insertion order means nothing; order by queued_at_ms and sequence.
CREATE TABLE route_invocations (
  id TEXT PRIMARY KEY,
  operation TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('scoring','generation')),
  context_kind TEXT,
  context_id TEXT,
  context_detail TEXT,
  queued_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  duration_ms INTEGER,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('success','failure','cancelled')),
  failure_kind TEXT,
  cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR cancellation_reason IN ('user','superseded','parent_cancelled','shutdown')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_route_invocations_context ON route_invocations(context_kind, context_id);
CREATE INDEX idx_route_invocations_created ON route_invocations(created_at);

CREATE TABLE provider_executions (
  id TEXT PRIMARY KEY,
  route_invocation_id TEXT NOT NULL REFERENCES route_invocations(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  provider TEXT NOT NULL,
  family TEXT NOT NULL CHECK (family IN ('scoring','generation')),
  operation TEXT NOT NULL,
  queued_at_ms INTEGER NOT NULL,
  dequeued_at_ms INTEGER,
  started_at_ms INTEGER,
  finished_at_ms INTEGER,
  queue_ms INTEGER,
  duration_ms INTEGER,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('success','failure','cancelled')),
  failure_kind TEXT,
  cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR cancellation_reason IN ('user','superseded','parent_cancelled','shutdown')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(route_invocation_id, sequence)
);
CREATE INDEX idx_provider_executions_route ON provider_executions(route_invocation_id, sequence);
CREATE INDEX idx_provider_executions_created ON provider_executions(created_at);

CREATE TABLE model_attempts (
  id TEXT PRIMARY KEY,
  provider_execution_id TEXT NOT NULL REFERENCES provider_executions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('initial','repair')),
  model TEXT,
  prompt TEXT,
  prompt_omitted_bytes INTEGER NOT NULL DEFAULT 0,
  response TEXT,
  response_omitted_bytes INTEGER NOT NULL DEFAULT 0,
  started_at_ms INTEGER NOT NULL,
  finished_at_ms INTEGER,
  duration_ms INTEGER,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('success','failure','cancelled')),
  failure_kind TEXT,
  cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR cancellation_reason IN ('user','superseded','parent_cancelled','shutdown')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(provider_execution_id, sequence)
);
CREATE INDEX idx_model_attempts_execution ON model_attempts(provider_execution_id, sequence);
CREATE INDEX idx_model_attempts_created ON model_attempts(created_at);

-- The one execution owner per database. The singleton row is token guarded so a stale owner
-- cannot heartbeat or release its replacement's lease.
CREATE TABLE execution_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_token TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- When a provider's quota resets. Both columns hold ISO-8601, not the space form (docs/adr/0008).
CREATE TABLE provider_quota_resets (
  provider TEXT PRIMARY KEY,
  reset_at TEXT NOT NULL,
  observed_at TEXT NOT NULL
);

-- Every TTS synthesis a render makes, including the takes it discards: measurements and
-- identifiers only, never clip text, prompts or provider payloads. `take_disposition` says which
-- take the User hears. Every take is inserted 'discarded', the one that shipped included; it becomes
-- 'published' once the render's audio-manifest.json is written (clipTakeManifest.ts's
-- markPublishedTakes), and a row the boot replay restores from a manifest takes the manifest's
-- disposition. NULL on rows written before the column existed (which take shipped is not
-- recoverable for those). Pruned by age with the model diagnostics.
CREATE TABLE clip_measurements (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL,
  context_kind TEXT,
  context_id TEXT,
  role TEXT NOT NULL,
  file TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  duration_sec REAL NOT NULL,
  wpm REAL NOT NULL,
  speed REAL NOT NULL,
  correction_count INTEGER NOT NULL,
  accent TEXT,
  profile_version TEXT,
  in_band INTEGER NOT NULL,
  take_disposition TEXT CHECK (take_disposition IN ('published','discarded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_clip_measurements_set ON clip_measurements(set_id);
CREATE INDEX idx_clip_measurements_created_at ON clip_measurements(created_at);

-- The runtime index of data/question-sets/supersessions.json (tracked in git): a Set a newer Set
-- replaces. A superseded Set leaves the Set picker and the Novelty Catalog but still loads, so past
-- Attempts on it still render. `superseded_by` is not a foreign key: Sets are files, not rows.
CREATE TABLE superseded_sets (
  set_id TEXT PRIMARY KEY,
  superseded_by TEXT NOT NULL,
  superseded_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One Full-Test Run: the four sections in exam order, a Set chosen for each when the Run is created
-- and, once sat, a Simulation Attempt linked per section. A Run scores nothing itself: each
-- section's state and band are read from its linked Attempt.
CREATE TABLE full_test_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('in-progress','completed','abandoned')),
  current_section TEXT CHECK (current_section IS NULL OR current_section IN ('reading','listening','writing','speaking')),
  reading_attempt_id TEXT REFERENCES attempts(id),
  listening_attempt_id TEXT REFERENCES attempts(id),
  writing_attempt_id TEXT REFERENCES attempts(id),
  speaking_attempt_id TEXT REFERENCES attempts(id),
  reading_set_id TEXT,
  listening_set_id TEXT,
  writing_set_id TEXT,
  speaking_set_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX idx_full_test_runs_created ON full_test_runs(created_at);

-- Drill Lab backward-buildup reps: one blind try at a whole Listen and Repeat sentence. NOT an
-- Attempt: the learner has read the sentence, so nothing that estimates a band, writes a Score
-- Report or computes stats reads this table (only routes/drillLab.ts does). `breakdown_index` is
-- the 0-based index of the first target word the transcript missed, NULL for a clean rep.
CREATE TABLE backward_buildup_reps (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('baseline','post')),
  transcript TEXT,
  transcription_error TEXT,
  breakdown_index INTEGER,
  target_word_count INTEGER NOT NULL,
  matched_word_count INTEGER,
  diff_json TEXT,
  audio_path TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_bbr_item ON backward_buildup_reps(set_id, item_id, created_at);
