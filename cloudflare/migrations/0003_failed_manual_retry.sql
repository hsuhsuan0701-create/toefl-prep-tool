-- Permit one additional explicit manual attempt after a failed UTC-day generation.
-- The original run is preserved for audit; successful runs cannot be retried.
ALTER TABLE generation_runs ADD COLUMN manual_retries INTEGER NOT NULL DEFAULT 0
  CHECK (manual_retries BETWEEN 0 AND 1);
