-- Quarantine AI drafts until independently reviewed and converted into full adaptive Sets.
CREATE TABLE IF NOT EXISTS generation_runs (
  day TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('started','pending_review','failed')),
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS generation_drafts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind = 'reading_academic_draft'),
  title TEXT NOT NULL,
  fingerprint TEXT NOT NULL UNIQUE,
  content_json TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','rejected','approved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_generation_drafts_status ON generation_drafts(status,created_at DESC);
