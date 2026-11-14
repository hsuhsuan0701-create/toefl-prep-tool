-- Deferred Listening generation queue. An entire original-format Listening Set is
-- drafted and validated before it is eligible for up to three DAILY audio uploads.
-- Publishing is a separate explicit operation. No TTS calls from SQL or Worker cron.
CREATE TABLE IF NOT EXISTS listening_refill_drafts (
  id TEXT PRIMARY KEY CHECK(id GLOB 'lsn-*'),
  content_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','rendering','ready','published','blocked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS listening_refill_clips (
  set_id TEXT NOT NULL REFERENCES listening_refill_drafts(id) ON DELETE CASCADE,
  stimulus_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 89),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','claimed','uploaded','flagged')),
  claim_day TEXT,
  claimed_at TEXT,
  uploaded_at TEXT,
  bytes INTEGER,
  object_key TEXT,
  PRIMARY KEY (set_id,stimulus_id),
  UNIQUE (set_id,ordinal)
);
CREATE INDEX IF NOT EXISTS idx_listening_refill_next ON listening_refill_clips(set_id,status,ordinal);
-- One row per attempt, including failed/aborted synthesis attempts. Never silently
-- retry a day's failed request or a clip which might have been charged.
CREATE TABLE IF NOT EXISTS listening_refill_daily_attempts (
  day TEXT NOT NULL,
  slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 3),
  set_id TEXT NOT NULL,
  stimulus_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK(status IN ('claimed','uploaded','flagged')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(day,slot),
  UNIQUE(day,set_id,stimulus_id)
);
