-- The DDL of the one long-lived database this app has (`sqlite3 data/db.sqlite .schema`, taken
-- 2026-11-12; no rows). Tables that gained a column by ALTER TABLE list it last, and rebuilt tables
-- carry their rebuild-time text, so this is the shape an upgraded database really has rather than
-- the one schema.sql writes. db.schemaVersion.test.ts proves it is adopted as version 1.
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
  created_at TEXT NOT NULL DEFAULT (datetime('now')), delivery_report TEXT, scored_at TEXT,
  PRIMARY KEY (attempt_id, item_id)
);
CREATE TABLE judge_reports (
  attempt_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  judge TEXT NOT NULL CHECK (judge IN ('gemini','openai')),
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE section_estimates (
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  section TEXT NOT NULL,
  raw_detail TEXT NOT NULL,
  estimated_band REAL NOT NULL,
  method TEXT NOT NULL
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE generation_batches (
  id TEXT PRIMARY KEY,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','done','partial','failed','cancelled')),
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, cancel_requested_at TEXT, cancelled_at TEXT, cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR cancellation_reason IN ('user','superseded','parent_cancelled','shutdown')), terminal_at TEXT);
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
  manual_run INTEGER NOT NULL DEFAULT 0 CHECK (manual_run IN (0,1)),
  -- `resumptions` (Task 9, final round): how many times the boot sweep has converted this job back
  -- from an interrupted 'running' state. A process death DURING the Ears call records no outcome, so
  -- neither automatic_attempts nor any other column advances — the resumption is free, and the loop
  -- is real (`npm run dev` runs `tsx watch`, which kills the process on every file save). Charging
  -- automatic_attempts bounds the AUTOMATIC path, but a manual run is deliberately exempt from that
  -- counter (Task 7's invariant: a manual retry never increments it, and three tests pin the
  -- no-upward-drift property), so the manual path needs its own bound. This column is that bound: a
  -- per-job-id resumption cap that touches nothing Task 7 asserts. Same no-migration precedent as
  -- manual_run above -- transcription_jobs has never existed in any real database.
  resumptions INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (attempt_id, item_id, audio_sha256),
  CHECK (status <> 'retry_wait' OR next_retry_at IS NOT NULL)
);
CREATE TABLE recording_publication_locks (
  attempt_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL CHECK (owner_pid > 0),
  owner_token TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, item_id)
);
CREATE INDEX transcription_jobs_due ON transcription_jobs(status, next_retry_at);
CREATE UNIQUE INDEX section_estimates_attempt_section ON section_estimates(attempt_id, section);
CREATE TABLE model_calls (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('claude','codex','openai-http','gemini-http')),
  model TEXT,
  -- Which call site produced this row: 'skill-task' | 'openai-text' | 'gemini-essay-judge' |
  -- 'gemini-speaking-judge' | 'openai-audio-judge' | 'ears'. Deliberately NOT a CHECK constraint:
  -- adding a call site should never require a schema migration to become observable.
  route TEXT NOT NULL,
  -- Skill task descriptor for the CLI routes ('plan:speaking', 'generate:writing', 'arbitrate', …),
  -- NULL for the HTTP routes, which have no skill.
  task TEXT,
  -- Correlation back to the work that caused the call. NULL when a call runs outside any job
  -- (e.g. a direct route hit): the row is still recorded, just harder to attribute.
  context_kind TEXT,
  context_id TEXT,
  context_detail TEXT,
  attempt_index INTEGER NOT NULL DEFAULT 0,
  prompt TEXT NOT NULL,
  -- NULL when the call produced no output at all (spawn failure, timeout before first byte) — as
  -- distinct from '' which means the provider genuinely returned empty.
  response TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded','failed')),
  failure_kind TEXT,
  queue_ms INTEGER,
  duration_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_model_calls_created_at ON model_calls(created_at);
CREATE INDEX idx_model_calls_context ON model_calls(context_kind, context_id);
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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
, take_disposition TEXT CHECK (take_disposition IN ('published','discarded')));
CREATE INDEX idx_clip_measurements_set ON clip_measurements(set_id);
CREATE INDEX idx_clip_measurements_created_at ON clip_measurements(created_at);
CREATE TABLE "generation_jobs" (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('speaking','writing','reading','listening')),
          status TEXT NOT NULL DEFAULT 'queued'
            CHECK (status IN ('queued','running','done','failed','cancelled')),
          stage TEXT,
          progress TEXT,
          set_id TEXT,
          error TEXT,
          batch_id TEXT REFERENCES generation_batches(id),
          batch_index INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        , cancel_requested_at TEXT, cancelled_at TEXT, cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR cancellation_reason IN ('user','superseded','parent_cancelled','shutdown')), terminal_at TEXT);
CREATE TABLE "attempts" (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('speaking','writing','reading','listening')),
          mode TEXT NOT NULL CHECK (mode IN ('drill','simulation')),
          set_id TEXT NOT NULL,
          is_repeat INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','aborted')),
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          completed_at TEXT,
          capture_finished_at TEXT,
          flagged INTEGER NOT NULL DEFAULT 0,
          module_path TEXT CHECK (module_path IN ('lower','upper')),
          router_raw REAL
        );
CREATE TABLE superseded_sets (
  set_id TEXT PRIMARY KEY,
  superseded_by TEXT NOT NULL,
  superseded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
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
CREATE TABLE execution_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  owner_token TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE provider_quota_resets (
  provider TEXT PRIMARY KEY,
  reset_at TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE TABLE generation_publication_intents (
  child_id TEXT PRIMARY KEY REFERENCES generation_jobs(id),
  set_id TEXT NOT NULL,
  expected_kind TEXT NOT NULL CHECK (expected_kind IN ('speaking','writing','reading','listening')),
  staging_path TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  published_at TEXT,
  -- The other terminal state for an intent, and the reason this is not just `published_at`'s
  -- absence. An intent is a PROMISE that these exact bytes will land at canonical_path, and it
  -- outranks the ordinary cancel/fail writers precisely so a Set that is already committed cannot be
  -- thrown away underneath itself. But the promise can turn out to be unkeepable — the process died
  -- between committing and renaming, and neither the staging nor the canonical file still hashes to
  -- content_hash. Such an intent must stop protecting its job (so the job can finally be failed) and
  -- stop being outstanding work (so boot recovery does not re-examine it forever), while staying on
  -- the record. Every guard reads "live intent" as published_at IS NULL AND abandoned_at IS NULL.
  abandoned_at TEXT
);
CREATE TABLE cleanup_debt (
  id TEXT PRIMARY KEY,
  child_id TEXT REFERENCES generation_jobs(id),
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  last_error TEXT
);
CREATE INDEX idx_cleanup_debt_pending ON cleanup_debt(completed_at, created_at);
CREATE TABLE "scoring_jobs" (
        id TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL REFERENCES attempts(id),
        task_type TEXT NOT NULL,
        item_ids TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed','superseded','cancelled')),
        stage TEXT, progress TEXT, result TEXT, error TEXT,
        cancel_requested_at TEXT, cancelled_at TEXT,
        cancellation_reason TEXT CHECK (cancellation_reason IS NULL OR cancellation_reason IN ('user','superseded','parent_cancelled','shutdown')),
        terminal_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
CREATE TABLE full_test_runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('in-progress','completed','abandoned')),
  paced INTEGER NOT NULL DEFAULT 0 CHECK (paced IN (0,1)),
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
