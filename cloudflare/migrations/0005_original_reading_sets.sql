-- Reading cloud adapter: persist original complete Reading Sets, not stand-alone drafts.
-- Protected import is explicit; never publish answer-bearing JSON as static assets.
CREATE TABLE IF NOT EXISTS reading_sets (
  id TEXT PRIMARY KEY,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE attempts ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0,1));
CREATE INDEX IF NOT EXISTS idx_reading_sets_added ON reading_sets(created_at DESC);
