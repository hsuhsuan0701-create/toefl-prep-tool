-- Free-tier-only model-scoped TTS claims. Never erase/refund an attempted clip.
-- The old global ledger stays in place for audit and rollback compatibility.
-- Import it as Lite so pre-upgrade attempts still count toward its daily cap.
CREATE TABLE IF NOT EXISTS listening_refill_model_attempts (
  day TEXT NOT NULL,
  model TEXT NOT NULL CHECK(model IN ('gemini-3.8-flash-lite-tts','gemini-3.8-flash-tts')),
  slot INTEGER NOT NULL CHECK(slot BETWEEN 1 AND 10),
  set_id TEXT NOT NULL,
  stimulus_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK(status IN ('claimed','uploaded','flagged')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(day,model,slot),
  UNIQUE(day,set_id,stimulus_id)
);
CREATE INDEX IF NOT EXISTS idx_listening_refill_model_day
  ON listening_refill_model_attempts(day,model);
INSERT OR IGNORE INTO listening_refill_model_attempts(day,model,slot,set_id,stimulus_id,status,created_at)
  SELECT day,'gemini-3.8-flash-lite-tts',slot,set_id,stimulus_id,status,created_at
  FROM listening_refill_daily_attempts;
