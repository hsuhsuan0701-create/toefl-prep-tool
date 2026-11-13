-- Phase 0 D1 foundation. This is not a full replacement for the original SQLite schema.
-- Completed attempts will be synchronized only after the relevant API routes are migrated.
-- In-progress cross-device resume is explicitly out of scope.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('reading','listening','speaking','writing')),
    mode TEXT NOT NULL CHECK (mode IN ('drill','simulation')),
    set_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','completed','aborted')),
    is_repeat INTEGER NOT NULL DEFAULT 0,
    module_path TEXT CHECK (module_path IN ('lower','upper')),
    router_raw REAL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_attempts_recent ON attempts(completed_at DESC, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_set ON attempts(set_id, status);

CREATE TABLE IF NOT EXISTS item_results (
    attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    item_id TEXT NOT NULL,
    task_type TEXT NOT NULL,
    response_text TEXT,
    score REAL,
    score_json TEXT,
    scoring_status TEXT NOT NULL DEFAULT 'pending' CHECK (scoring_status IN ('pending','scored','failed')),
    scored_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (attempt_id, item_id)
);

CREATE TABLE IF NOT EXISTS section_estimates (
    attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
    section TEXT NOT NULL,
    raw_detail TEXT NOT NULL,
    estimated_band REAL NOT NULL,
    method TEXT NOT NULL,
    PRIMARY KEY (attempt_id, section)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
