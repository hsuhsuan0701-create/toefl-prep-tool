-- Reading cloud adapter: persist original complete Reading Sets, not stand-alone drafts.
-- Protected import is explicit; never publish answer-bearing JSON as static assets.
CREATE TABLE IF NOT EXISTS reading_sets (
  id TEXT PRIMARY KEY,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE attempts ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0,1));
CREATE INDEX IF NOT EXISTS idx_reading_sets_added ON reading_sets(created_at DESC);

-- Stop late or out-of-module writes atomically, including concurrent HTTP requests.
-- This is scoped to original Reading Attempts; other sections are untouched.
CREATE TRIGGER IF NOT EXISTS reading_score_stage_guard
BEFORE INSERT ON item_results
WHEN (SELECT kind FROM attempts WHERE id=NEW.attempt_id)='reading'
BEGIN
  SELECT CASE
    WHEN (SELECT status FROM attempts WHERE id=NEW.attempt_id) <> 'in_progress'
      THEN RAISE(ABORT, 'Reading Attempt is already closed')
    WHEN (SELECT mode FROM attempts WHERE id=NEW.attempt_id)='drill'
      AND COALESCE(json_extract(NEW.score_json, '$.module'), '') <> 'router'
      THEN RAISE(ABORT, 'Reading drill only uses Router module')
    WHEN (SELECT mode FROM attempts WHERE id=NEW.attempt_id)='simulation'
      AND (SELECT module_path FROM attempts WHERE id=NEW.attempt_id) IS NULL
      AND COALESCE(json_extract(NEW.score_json, '$.module'), '') <> 'router'
      THEN RAISE(ABORT, 'Reading Router is not complete')
    WHEN (SELECT mode FROM attempts WHERE id=NEW.attempt_id)='simulation'
      AND (SELECT module_path FROM attempts WHERE id=NEW.attempt_id) IS NOT NULL
      AND COALESCE(json_extract(NEW.score_json, '$.module'), '')
          <> (SELECT module_path FROM attempts WHERE id=NEW.attempt_id)
      THEN RAISE(ABORT, 'Reading routed module is locked')
  END;
END;
