import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// Migration 7, run over a version-1 database file: it drops full_test_runs.paced, a column no
// section hand-off ever set, and leaves every Run as it was otherwise.

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_V1_SQL = fs.readFileSync(path.join(here, "../src/db/schemaV1.sql"), "utf8");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toefl-migration-7-"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("migration 7", () => {
  it("drops full_test_runs.paced and keeps each Run's other columns, its index and its Attempt links", () => {
    const file = path.join(dir, "db.sqlite");
    const raw = new Database(file);
    raw.exec(SCHEMA_V1_SQL);
    raw.prepare("INSERT INTO attempts (id, kind, mode, set_id) VALUES ('a-reading','reading','simulation','rd-1')").run();
    const insert = raw.prepare(
      `INSERT INTO full_test_runs (id, status, paced, current_section, reading_attempt_id, reading_set_id, listening_set_id, writing_set_id, speaking_set_id, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'rd-1', 'lsn-1', 'wri-1', 'spk-1', ?, ?)`,
    );
    insert.run("run-in-progress", "in-progress", 0, "listening", "a-reading", "2026-08-01 09:00:00", null);
    insert.run("run-marked-paced", "completed", 1, null, null, "2026-08-02 09:00:00", "2026-08-02 10:30:00");
    raw.close();

    const db = openDb(file);

    const columns = (db.prepare("PRAGMA table_info(full_test_runs)").all() as { name: string }[]).map((column) => column.name);
    expect(columns).not.toContain("paced");
    expect(columns).toEqual(expect.arrayContaining(["id", "status", "current_section", "reading_attempt_id", "speaking_set_id", "created_at", "completed_at"]));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_full_test_runs_created'").get()).toBeDefined();

    const repo = sqliteStores(db);
    expect(repo.getFullTestRun("run-in-progress")).toMatchObject({
      status: "in-progress",
      current_section: "listening",
      reading_attempt_id: "a-reading",
      reading_set_id: "rd-1",
      created_at: "2026-08-01 09:00:00",
      completed_at: null,
    });
    expect(repo.getFullTestRun("run-marked-paced")).toMatchObject({
      status: "completed",
      current_section: null,
      speaking_set_id: "spk-1",
      completed_at: "2026-08-02 10:30:00",
    });
    db.close();
  });
});
