-- Unreviewed Gemini TTS takes are separate from published Listening audio.
-- Existing 0010 reviewed-local imports must be retained in local source before deployment.
-- This table never modifies, replaces or deletes the existing 36-clip draft.
CREATE TABLE IF NOT EXISTS listening_auto_review_staged (
  set_id TEXT NOT NULL,
  stimulus_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK(status IN ('pending_review','approved','rejected')),
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  model TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1024 AND 8388608),
  duration_sec REAL NOT NULL CHECK(duration_sec > 0 AND duration_sec < 1200),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  reviewer_note TEXT,
  PRIMARY KEY (set_id,stimulus_id),
  FOREIGN KEY (set_id,stimulus_id)
    REFERENCES listening_refill_clips(set_id,stimulus_id)
);
CREATE INDEX IF NOT EXISTS idx_listening_staged_pending
ON listening_auto_review_staged(status,created_at);
