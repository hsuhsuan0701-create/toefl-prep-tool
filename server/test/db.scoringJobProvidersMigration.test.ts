import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/db.js";

// Migration 5, run over a version-1 database file. A finished scoring job's progress names no
// provider (the write that ends a job removes them), and this migration removes them from jobs that
// finished before that rule.

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_V1_SQL = fs.readFileSync(path.join(here, "../src/db/schemaV1.sql"), "utf8");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toefl-provider-migration-"));
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const withProviders = JSON.stringify({
  judgesDone: ["openai", "gemini"],
  judgesFailed: [],
  openaiJudgeProvider: "openai-http",
  arbiterProvider: "codex",
  fallbackFrom: "claude",
});

describe("removing provider names from finished scoring jobs' progress", () => {
  it("rewrites every finished job's progress, and leaves live jobs and unreadable progress alone", () => {
    const file = path.join(dir, "db.sqlite");
    const raw = new Database(file);
    raw.exec(SCHEMA_V1_SQL);
    raw.prepare("INSERT INTO attempts (id, kind, mode, set_id) VALUES ('a1','writing','drill','wri-1')").run();
    const job = raw.prepare("INSERT INTO scoring_jobs (id, attempt_id, task_type, item_ids, status, progress) VALUES (?, 'a1', 'email', '[]', ?, ?)");
    job.run("done", "done", withProviders);
    job.run("failed", "failed", JSON.stringify({ judgesDone: ["gemini"], judgesFailed: ["openai"], arbiterProvider: "claude" }));
    job.run("cancelled", "cancelled", JSON.stringify({ judgesDone: [], judgesFailed: [], arbiterProvider: "claude", queuePosition: 2 }));
    job.run("superseded", "superseded", withProviders);
    job.run("running", "running", withProviders);
    job.run("unreadable", "done", "{not json");
    job.run("no-progress", "done", null);
    job.run("no-providers", "done", JSON.stringify({ judgesDone: ["gemini", "openai"], judgesFailed: [] }));
    raw.close();

    const db = openDb(file);
    const progress = (id: string) => (db.prepare("SELECT progress FROM scoring_jobs WHERE id=?").get(id) as { progress: string | null }).progress;
    expect(JSON.parse(progress("done")!)).toEqual({ judgesDone: ["openai", "gemini"], judgesFailed: [] });
    expect(JSON.parse(progress("failed")!)).toEqual({ judgesDone: ["gemini"], judgesFailed: ["openai"] });
    expect(JSON.parse(progress("cancelled")!)).toEqual({ judgesDone: [], judgesFailed: [], queuePosition: 2 });
    expect(JSON.parse(progress("superseded")!)).toEqual({ judgesDone: ["openai", "gemini"], judgesFailed: [] });
    expect(progress("running")).toBe(withProviders);
    expect(progress("unreadable")).toBe("{not json");
    expect(progress("no-progress")).toBeNull();
    expect(JSON.parse(progress("no-providers")!)).toEqual({ judgesDone: ["gemini", "openai"], judgesFailed: [] });
    db.close();
  });
});
