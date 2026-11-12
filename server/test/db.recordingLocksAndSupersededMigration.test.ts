import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/db.js";
import { scoringJobCoversItsItems } from "../src/services/scoringJobs.js";

// Migration 6, run over a version-1 database file: it drops the recording publication lock table
// (the lock lives in memory), and rewrites a scoring job with the legacy status 'superseded' the way
// supersession writes one, as cancelled with reason 'superseded'.

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_V1_SQL = fs.readFileSync(path.join(here, "../src/db/schemaV1.sql"), "utf8");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toefl-migration-6-"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("migration 6", () => {
  it("drops recording_publication_locks and rewrites legacy 'superseded' scoring jobs, leaving every other job alone", () => {
    const file = path.join(dir, "db.sqlite");
    const raw = new Database(file);
    raw.exec(SCHEMA_V1_SQL);
    raw.prepare("INSERT INTO attempts (id, kind, mode, set_id) VALUES ('a1','speaking','simulation','spk-1')").run();
    raw.prepare("INSERT INTO recording_publication_locks (attempt_id, item_id, owner_pid, owner_token, acquired_at) VALUES ('a1','lr-1',4242,'t','2026-08-01 00:00:00')").run();
    const job = raw.prepare(
      "INSERT INTO scoring_jobs (id, attempt_id, task_type, item_ids, status, cancellation_reason, cancel_requested_at, cancelled_at, terminal_at, updated_at) VALUES (?, 'a1', 'listen_repeat', '[\"lr-1\"]', ?, ?, ?, ?, ?, ?)",
    );
    job.run("legacy", "superseded", null, null, null, null, "2026-08-02 10:00:00");
    job.run("cancelled-by-user", "cancelled", "user", "2026-08-03 00:00:00", "2026-08-03 00:00:01", "2026-08-03 00:00:01", "2026-08-03 00:00:01");
    job.run("done", "done", null, null, null, "2026-08-04 00:00:00", "2026-08-04 00:00:00");
    raw.close();

    const db = openDb(file);

    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='recording_publication_locks'").get()).toBeUndefined();
    const row = (id: string) => db.prepare(
      "SELECT status, cancellation_reason, cancel_requested_at, cancelled_at, terminal_at, updated_at FROM scoring_jobs WHERE id=?",
    ).get(id);
    expect(row("legacy")).toEqual({
      status: "cancelled",
      cancellation_reason: "superseded",
      cancel_requested_at: "2026-08-02 10:00:00",
      cancelled_at: "2026-08-02 10:00:00",
      terminal_at: "2026-08-02 10:00:00",
      updated_at: "2026-08-02 10:00:00",
    });
    expect(scoringJobCoversItsItems(row("legacy") as { status: string })).toBe(false);
    expect(row("cancelled-by-user")).toMatchObject({ status: "cancelled", cancellation_reason: "user", cancel_requested_at: "2026-08-03 00:00:00" });
    expect(row("done")).toMatchObject({ status: "done", cancellation_reason: null, terminal_at: "2026-08-04 00:00:00" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM scoring_jobs WHERE status='superseded'").get()).toEqual({ n: 0 });
    db.close();
  });
});
