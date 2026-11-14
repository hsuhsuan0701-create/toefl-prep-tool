-- Academic Passage MVP: separate, deterministic practice history.
-- Full adaptive TOEFL attempts remain untouched.
ALTER TABLE generation_drafts ADD COLUMN reviewed_at TEXT;
ALTER TABLE generation_drafts ADD COLUMN review_note TEXT;
ALTER TABLE generation_drafts ADD COLUMN review_checklist_json TEXT;

CREATE TABLE IF NOT EXISTS academic_practice_attempts (
  id TEXT PRIMARY KEY,
  draft_id TEXT NOT NULL REFERENCES generation_drafts(id),
  title TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  review_json TEXT NOT NULL,
  correct_count INTEGER NOT NULL CHECK (correct_count BETWEEN 0 AND 5),
  total_count INTEGER NOT NULL CHECK (total_count = 5),
  completed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_academic_practice_recent
  ON academic_practice_attempts(completed_at DESC, id DESC);
