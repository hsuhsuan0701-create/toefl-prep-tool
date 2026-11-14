-- One UTC-day claim for a complete Reading Set, never mixed with single-passage drafts.
-- A failed attempt is recorded; subsequent cron invocations cannot multiply API cost.
CREATE TABLE IF NOT EXISTS reading_refill_runs (
  day TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('started','published','failed','skipped')),
  new_set_id TEXT,
  unused_sets_at_start INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS reading_refill_runs_status ON reading_refill_runs(status, created_at DESC);
