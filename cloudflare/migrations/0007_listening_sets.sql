-- Original Listening Set JSON is stored only after ALL referenced MP3 clips
-- are verified present in the bound Cloudflare assets. No answers in public assets.
CREATE TABLE IF NOT EXISTS listening_sets (
  id TEXT PRIMARY KEY,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_listening_sets_created ON listening_sets(created_at DESC);
-- Reuse original attempts, item_results, section_estimates (no parallel grades).
CREATE TRIGGER IF NOT EXISTS listening_score_stage_guard
BEFORE INSERT ON item_results
WHEN (SELECT kind FROM attempts WHERE id=NEW.attempt_id)='listening'
BEGIN
  SELECT CASE
    WHEN (SELECT status FROM attempts WHERE id=NEW.attempt_id)<>'in_progress'
      THEN RAISE(ABORT,'Listening Attempt already closed')
    WHEN (SELECT mode FROM attempts WHERE id=NEW.attempt_id)='drill'
      AND COALESCE(json_extract(NEW.score_json, '$.module'),'')<>'router'
      THEN RAISE(ABORT,'Listening drill uses Router module')
    WHEN (SELECT mode FROM attempts WHERE id=NEW.attempt_id)='simulation'
      AND (SELECT module_path FROM attempts WHERE id=NEW.attempt_id) IS NULL
      AND COALESCE(json_extract(NEW.score_json, '$.module'),'')<>'router'
      THEN RAISE(ABORT,'Listening Router not completed')
    WHEN (SELECT mode FROM attempts WHERE id=NEW.attempt_id)='simulation'
      AND (SELECT module_path FROM attempts WHERE id=NEW.attempt_id) IS NOT NULL
      AND COALESCE(json_extract(NEW.score_json, '$.module'),'')
        <> (SELECT module_path FROM attempts WHERE id=NEW.attempt_id)
      THEN RAISE(ABORT,'Listening routed module locked')
  END;
END;
