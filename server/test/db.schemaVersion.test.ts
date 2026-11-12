import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import {
  DatabaseFromNewerVersionError,
  LAST_COMMIT_WITH_LEGACY_UPGRADES,
  MIGRATIONS,
  SCHEMA_VERSION,
  UnversionedDatabaseError,
  migrateToCurrentVersion,
  userVersion,
  type Migration,
} from "../src/db/migrations.js";
import { describeSchema, diffSchemaShapes } from "../src/db/schemaShape.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_SQL = fs.readFileSync(path.join(here, "../src/db/schema.sql"), "utf8");
const SCHEMA_V1_SQL = fs.readFileSync(path.join(here, "../src/db/schemaV1.sql"), "utf8");
// The real long-lived database's DDL: columns added by ALTER TABLE sit last, rebuilt tables carry
// their rebuild-time text.
const UPGRADED_DB_SQL = fs.readFileSync(path.join(here, "fixtures/upgraded-db-schema.sql"), "utf8");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toefl-schema-version-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A database file built from raw DDL, with no schema version — the state before versioning. */
function unversionedDb(ddl: string, seed?: (db: Database.Database) => void): string {
  const file = path.join(dir, `db-${Math.random().toString(36).slice(2)}.sqlite`);
  const raw = new Database(file);
  raw.exec(ddl);
  seed?.(raw);
  raw.close();
  return file;
}

function freshShape() {
  const db = openDb(":memory:");
  try {
    return describeSchema(db);
  } finally {
    db.close();
  }
}

function seedOneAttempt(db: Database.Database): void {
  db.prepare("INSERT INTO attempts (id, kind, mode, set_id, status) VALUES ('a1','speaking','simulation','spk-1','completed')").run();
  db.prepare("INSERT INTO item_results (attempt_id, item_id, task_type, score, scoring_status) VALUES ('a1','lr-1','listen_repeat',4,'scored')").run();
}

describe("a new database", () => {
  it("is created from schema.sql at the current schema version", () => {
    const db = openDb(path.join(dir, "new.sqlite"));
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    const fromSchemaSql = new Database(":memory:");
    fromSchemaSql.exec(SCHEMA_SQL);
    expect(diffSchemaShapes(describeSchema(fromSchemaSql), describeSchema(db))).toEqual([]);
    fromSchemaSql.close();
    db.close();
  });

  it("is left as it is when opened again", () => {
    const file = path.join(dir, "again.sqlite");
    openDb(file).close();
    const before = fs.readFileSync(file);
    const db = openDb(file);
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    db.close();
    expect(fs.readFileSync(file).equals(before)).toBe(true);
  });
});

describe("a database from before schema versions", () => {
  it("is stamped version 1 and migrated to a schema identical to a new database's", () => {
    const db = openDb(unversionedDb(SCHEMA_V1_SQL));
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(diffSchemaShapes(freshShape(), describeSchema(db))).toEqual([]);
    db.close();
  });

  it("is adopted in the shape the real upgraded database has, with its rows intact", () => {
    const db = openDb(unversionedDb(UPGRADED_DB_SQL, seedOneAttempt));
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    expect(diffSchemaShapes(freshShape(), describeSchema(db))).toEqual([]);
    expect(db.prepare("SELECT id, status FROM attempts").all()).toEqual([{ id: "a1", status: "completed" }]);
    expect(db.prepare("SELECT item_id, score FROM item_results").all()).toEqual([{ item_id: "lr-1", score: 4 }]);
    db.close();
  });

  it("is refused, untouched, when its tables are older than version 1, with what differs and what to do", () => {
    // A database last opened before the Drill Lab existed: no backward_buildup_reps table, and
    // clip_measurements still without take_disposition.
    const older = SCHEMA_V1_SQL
      .replace(/CREATE TABLE backward_buildup_reps \([\s\S]*?\);\nCREATE INDEX idx_bbr_item[^\n]*\n/, "")
      .replace(/\s*take_disposition TEXT CHECK \(take_disposition IN \('published','discarded'\)\),/, "");
    expect(older).not.toContain("backward_buildup_reps");
    expect(older).not.toContain("take_disposition");
    const file = unversionedDb(older, seedOneAttempt);
    const shapeBefore = (() => {
      const raw = new Database(file, { readonly: true });
      try {
        return describeSchema(raw);
      } finally {
        raw.close();
      }
    })();

    let refusal: unknown;
    try {
      openDb(file);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(UnversionedDatabaseError);
    const message = (refusal as Error).message;
    expect(message).toContain(file);
    expect(message).toContain("missing table backward_buildup_reps");
    expect(message).toContain("clip_measurements: missing column take_disposition");
    expect(message).toContain(`commit ${LAST_COMMIT_WITH_LEGACY_UPGRADES}`);
    expect(message).toContain("start a new database");
    expect(message).toContain("the question bank in that directory is not affected");

    // Only the journal mode, which openDb switches to WAL before it reads anything, may differ.
    const raw = new Database(file, { readonly: true });
    expect(userVersion(raw)).toBe(0);
    expect(diffSchemaShapes(shapeBefore, describeSchema(raw))).toEqual([]);
    expect(raw.prepare("SELECT id FROM attempts").all()).toEqual([{ id: "a1" }]);
    raw.close();
  });

  it("is refused when a CHECK constraint is older than version 1's, though every column matches", () => {
    const older = SCHEMA_V1_SQL.replace(
      "kind TEXT NOT NULL CHECK (kind IN ('speaking','writing','reading','listening')),\n  mode",
      "kind TEXT NOT NULL CHECK (kind IN ('speaking','writing')),\n  mode",
    );
    expect(older).not.toBe(SCHEMA_V1_SQL);
    expect(() => openDb(unversionedDb(older))).toThrow(/attempts: missing CHECK \(kindin\('speaking','writing','reading','listening'\)\)/);
  });
});

describe("a database written by a newer checkout", () => {
  it("is refused rather than used", () => {
    const file = path.join(dir, "newer.sqlite");
    openDb(file).close();
    const raw = new Database(file);
    raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    expect(() => openDb(file)).toThrow(DatabaseFromNewerVersionError);
    expect(() => openDb(file)).toThrow(`only knows versions up to ${SCHEMA_VERSION}`);
  });
});

describe("the migration list", () => {
  it("numbers its migrations contiguously from 2, and the last one is the current version", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 2));
    expect(SCHEMA_VERSION).toBe(MIGRATIONS.length + 1);
  });
});

describe("running migrations", () => {
  function versionOneDb(): Database.Database {
    const db = new Database(unversionedDb(SCHEMA_V1_SQL, seedOneAttempt));
    db.pragma("foreign_keys = ON");
    return db;
  }

  it("commits each migration with its version, and a failing one rolls back to the version before it", () => {
    const db = versionOneDb();
    const migrations: Migration[] = [
      { version: 2, description: "add a table", up: (d) => d.exec("CREATE TABLE added_by_two (x INTEGER)") },
      {
        version: 3,
        description: "fails halfway",
        up: (d) => {
          d.exec("CREATE TABLE added_by_three (x INTEGER)");
          throw new Error("migration three failed");
        },
      },
    ];
    expect(() => migrateToCurrentVersion(db, "test.sqlite", migrations)).toThrow("migration three failed");
    expect(userVersion(db)).toBe(2);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name);
    expect(tables).toContain("added_by_two");
    expect(tables).not.toContain("added_by_three");

    // The next open resumes from the version that committed.
    const fixed: Migration[] = [migrations[0]!, { version: 3, description: "fixed", up: (d) => d.exec("CREATE TABLE added_by_three (x INTEGER)") }];
    migrateToCurrentVersion(db, "test.sqlite", fixed);
    expect(userVersion(db)).toBe(3);
    db.close();
  });

  it("runs a table rebuild with foreign keys off, refuses one that leaves dangling references, and turns them back on", () => {
    const db = versionOneDb();
    const rebuildAttempts = (keep: string): Migration => ({
      version: 2,
      description: "rebuild attempts",
      foreignKeysOff: true,
      up: (d) => {
        d.exec(`CREATE TABLE attempts_new (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, mode TEXT NOT NULL, set_id TEXT NOT NULL,
          is_repeat INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'in_progress',
          started_at TEXT NOT NULL DEFAULT (datetime('now')), completed_at TEXT, capture_finished_at TEXT,
          flagged INTEGER NOT NULL DEFAULT 0, module_path TEXT, router_raw REAL)`);
        d.exec(`INSERT INTO attempts_new SELECT * FROM attempts WHERE ${keep}`);
        d.exec("DROP TABLE attempts");
        d.exec("ALTER TABLE attempts_new RENAME TO attempts");
      },
    });

    expect(() => migrateToCurrentVersion(db, "test.sqlite", [rebuildAttempts("0")])).toThrow(/dangling foreign keys/);
    expect(userVersion(db)).toBe(1);
    expect(db.prepare("SELECT id FROM attempts").all()).toEqual([{ id: "a1" }]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);

    migrateToCurrentVersion(db, "test.sqlite", [rebuildAttempts("1")]);
    expect(userVersion(db)).toBe(2);
    expect(db.prepare("SELECT id FROM attempts").all()).toEqual([{ id: "a1" }]);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    db.close();
  });
});
