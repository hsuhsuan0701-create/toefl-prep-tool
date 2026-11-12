import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";

// What each data migration in migrations.ts does to rows, starting from a version-1 database holding
// the rows it was written for. (The mechanism itself, and the shape every migration must end at, are
// db.schemaVersion.test.ts's.)

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_V1_SQL = fs.readFileSync(path.join(here, "../src/db/schemaV1.sql"), "utf8");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toefl-schema-migrations-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A version-1 database (no version stamp yet, as every database was before versioning) with rows. */
function versionOneDbWith(seed: (db: Database.Database) => void): string {
  const file = path.join(dir, "db.sqlite");
  const raw = new Database(file);
  raw.exec(SCHEMA_V1_SQL);
  seed(raw);
  raw.close();
  return file;
}

describe("migration 3: failed-arbitration text that names a provider", () => {
  it("is rewritten to the neutral text on Items and jobs, and nothing else is touched", () => {
    const essay = "Dear Claude, the Codex of my club and I disagree about the arbiter.";
    const file = versionOneDbWith((db) => {
      db.prepare("INSERT INTO attempts (id, kind, mode, set_id) VALUES ('a1','speaking','simulation','spk-1')").run();
      db.prepare("INSERT INTO attempts (id, kind, mode, set_id) VALUES ('a2','writing','drill','wri-1')").run();
      const item = db.prepare("INSERT INTO item_results (attempt_id, item_id, task_type, response_text, score, score_json, scoring_status) VALUES (?,?,?,?,?,?,?)");
      item.run("a1", "lr-1", "listen_repeat", null, null, JSON.stringify({ error: "Error: arbiter failed: claude timed out" }), "failed");
      item.run("a1", "lr-2", "listen_repeat", null, null, JSON.stringify({ error: "Error: arbiter failed: Structured reasoning unavailable: Claude (rate-limit) → Codex (provider)." }), "failed");
      item.run("a1", "lr-3", "listen_repeat", null, null, JSON.stringify({ error: "scoring interrupted" }), "failed");
      item.run("a2", "email-1", "email", essay, 4, JSON.stringify({ finalScore: 4, reconciliationNote: "claude and codex agree" }), "scored");
      const job = db.prepare("INSERT INTO scoring_jobs (id, attempt_id, task_type, item_ids, status, error) VALUES (?,?,?,?,?,?)");
      job.run("j1", "a1", "listen_repeat", '["lr-1","lr-2"]', "failed", "Error: arbiter failed: claude timed out");
      job.run("j2", "a1", "listen_repeat", '["lr-3"]', "failed", "interrupted by server restart");
      db.prepare("INSERT INTO generation_jobs (id, kind, status, error) VALUES ('g1','speaking','failed','claude generated failed: claude exited 1')").run();
    });

    const db = openDb(file);
    const scoreJson = (itemId: string) =>
      JSON.parse((db.prepare("SELECT score_json FROM item_results WHERE item_id=?").get(itemId) as { score_json: string }).score_json);
    expect(scoreJson("lr-1")).toEqual({ error: "arbitration failed" });
    expect(scoreJson("lr-2")).toEqual({ error: "arbitration failed" });
    expect(scoreJson("lr-3")).toEqual({ error: "scoring interrupted" });
    expect(scoreJson("email-1")).toEqual({ finalScore: 4, reconciliationNote: "claude and codex agree" });
    expect(db.prepare("SELECT response_text FROM item_results WHERE item_id='email-1'").get()).toEqual({ response_text: essay });
    expect(db.prepare("SELECT id, error FROM scoring_jobs ORDER BY id").all()).toEqual([
      { id: "j1", error: "arbitration failed" },
      { id: "j2", error: "interrupted by server restart" },
    ]);
    // Not score-bearing: a generation job's error is left alone.
    expect(db.prepare("SELECT error FROM generation_jobs").get()).toEqual({ error: "claude generated failed: claude exited 1" });
    db.close();
  });
});

describe("migration 4: transcription_jobs.manual_run and resumptions", () => {
  it("drops both columns and keeps every job's other values", () => {
    const file = versionOneDbWith((db) => {
      db.prepare("INSERT INTO attempts (id, kind, mode, set_id) VALUES ('a1','speaking','drill','spk-1')").run();
      db.prepare(
        `INSERT INTO transcription_jobs (id, attempt_id, item_id, task_type, audio_path, audio_sha256, status, automatic_attempts, failure_kind, error, manual_run, resumptions, created_at, updated_at)
         VALUES ('t1','a1','lr-1','listen_repeat','responses/a1/lr-1.webm',?, 'failed', 2, 'provider', 'interrupted by server restart', 1, 3, '2026-08-20 10:00:00', '2026-08-20 10:05:00')`,
      ).run("a".repeat(64));
    });

    const db = openDb(file);
    const columns = (db.prepare("PRAGMA table_info(transcription_jobs)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain("manual_run");
    expect(columns).not.toContain("resumptions");
    expect(db.prepare("SELECT * FROM transcription_jobs").get()).toEqual({
      id: "t1", attempt_id: "a1", item_id: "lr-1", task_type: "listen_repeat",
      audio_path: "responses/a1/lr-1.webm", audio_sha256: "a".repeat(64), status: "failed",
      automatic_attempts: 2, next_retry_at: null, failure_kind: "provider",
      error: "interrupted by server restart", score_job_id: null,
      created_at: "2026-08-20 10:00:00", updated_at: "2026-08-20 10:05:00",
    });
    db.close();
  });
});
