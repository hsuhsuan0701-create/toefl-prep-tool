-- Audit previously synthesized, human-reviewed local MP3s imported through the
-- dedicated manual endpoint. No TTS quota is claimed by this migration.
-- Existing listening_refill_model_attempts rows are not modified.
CREATE TABLE IF NOT EXISTS listening_refill_audio_imports (
  set_id TEXT NOT NULL REFERENCES listening_refill_drafts(id) ON DELETE CASCADE,
  stimulus_id TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(length(content_sha256)=64),
  mp3_sha256 TEXT NOT NULL CHECK(length(mp3_sha256)=64),
  tts_model TEXT NOT NULL CHECK(tts_model IN ('gemini-3.8-flash-tts','gemini-3.8-flash-lite-tts')),
  review_method TEXT NOT NULL CHECK(review_method='human-listened-local-mp3'),
  bytes INTEGER NOT NULL CHECK(bytes BETWEEN 1025 AND 8388608),
  object_key TEXT NOT NULL UNIQUE,
  imported_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(set_id, stimulus_id)
);
