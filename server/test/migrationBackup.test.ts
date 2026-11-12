import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/db.js";
import { MigrationBackupError, SCHEMA_VERSION, userVersion } from "../src/db/migrations.js";

// Before the migration runner changes an existing database it writes a consistent snapshot of it to
// backups/ beside the file, and keeps the three most recent. Every case here runs over a real
// database file.

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_V1_SQL = fs.readFileSync(path.join(here, "../src/db/schemaV1.sql"), "utf8");
const SNAPSHOT = /^db-before-migration-from-v(\d+)-(\d{8}T\d{9}Z)\.sqlite$/;

let dir: string;
let file: string;
let backups: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toefl-migration-backup-"));
  file = path.join(dir, "db.sqlite");
  backups = path.join(dir, "backups");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A database from before schema versions, in version 1's shape, holding one Attempt. Its connection
 * is returned open in WAL mode with checkpoints off, so the Attempt exists only in the -wal file: a
 * copy of db.sqlite alone would not contain it.
 */
function unversionedDbInWal(): Database.Database {
  const raw = new Database(file);
  raw.pragma("journal_mode = WAL");
  raw.pragma("wal_autocheckpoint = 0");
  raw.exec(SCHEMA_V1_SQL);
  raw.prepare("INSERT INTO attempts (id, kind, mode, set_id, status) VALUES ('a1','writing','drill','wri-1','completed')").run();
  return raw;
}

/** This runner's snapshots, oldest first. */
function snapshots(): string[] {
  if (!fs.existsSync(backups)) return [];
  const stamp = (name: string) => SNAPSHOT.exec(name)![2]!;
  return fs.readdirSync(backups).filter((name) => SNAPSHOT.test(name)).sort((a, b) => stamp(a).localeCompare(stamp(b)));
}

describe("the backup before migrating", () => {
  it("snapshots an existing database, WAL contents included, before changing it, and says where", () => {
    const writer = unversionedDbInWal();
    const db = openDb(file);
    writer.close();
    expect(userVersion(db)).toBe(SCHEMA_VERSION);
    db.close();

    const [name, ...others] = snapshots();
    expect(others).toEqual([]);
    expect(name).toMatch(/^db-before-migration-from-v0-/);
    const snapshot = new Database(path.join(backups, name!), { readonly: true });
    expect(userVersion(snapshot)).toBe(0);
    expect(snapshot.prepare("SELECT id FROM attempts").all()).toEqual([{ id: "a1" }]);
    expect(snapshot.prepare("SELECT name FROM sqlite_master WHERE name='model_calls'").get()).toEqual({ name: "model_calls" });
    snapshot.close();

    const lines = vi.mocked(console.log).mock.calls.map((call) => call.join(" "));
    expect(lines.filter((line) => line.includes(path.join(backups, name!)))).toHaveLength(1);
  });

  it("takes none for a new database, nor for one already at the current version", () => {
    openDb(file).close();
    openDb(file).close();
    expect(fs.existsSync(backups)).toBe(false);
  });

  it("takes none for a database it refuses", () => {
    const raw = new Database(file);
    raw.exec("CREATE TABLE attempts (id TEXT PRIMARY KEY)");
    raw.close();
    expect(() => openDb(file)).toThrow(/has no schema version/);
    expect(fs.existsSync(backups)).toBe(false);
  });

  it("refuses to migrate when the snapshot cannot be written, and leaves the database as it was", () => {
    unversionedDbInWal().close();
    fs.writeFileSync(backups, "a file where the backups directory belongs");

    let refusal: unknown;
    try {
      openDb(file);
    } catch (err) {
      refusal = err;
    }
    expect(refusal).toBeInstanceOf(MigrationBackupError);
    const message = (refusal as Error).message;
    expect(message).toContain(file);
    expect(message).toContain(backups);
    expect(message).toContain("was not migrated");

    const raw = new Database(file, { readonly: true });
    expect(userVersion(raw)).toBe(0);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name='model_calls'").get()).toEqual({ name: "model_calls" });
    raw.close();
  });

  it("keeps the three most recent snapshots, clears an interrupted one, and touches nothing it did not write", () => {
    unversionedDbInWal().close();
    fs.mkdirSync(backups);
    const older = [
      "db-before-migration-from-v0-20260101T000000000Z.sqlite",
      "db-before-migration-from-v2-20260201T000000000Z.sqlite",
      "db-before-migration-from-v3-20260301T000000000Z.sqlite",
      "db-before-migration-from-v3-20260401T000000000Z.sqlite",
    ];
    const notOurs = ["db-before-batch-migration-20260729-030908.sqlite", "db-before-test-data-cleanup-20260730-145420.sqlite-wal", "notes.txt"];
    // What a snapshot interrupted by a crash leaves behind.
    const stalePartial = "db-before-migration-20260402T000000000Z.partial";
    // One being written right now by another process that opened the same file.
    const livePartial = "db-before-migration-20260402T000001000Z.partial";
    for (const name of [...older, ...notOurs, stalePartial, livePartial]) fs.writeFileSync(path.join(backups, name), "x");
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(path.join(backups, stalePartial), twoHoursAgo, twoHoursAgo);

    openDb(file).close();
    expect(fs.existsSync(path.join(backups, stalePartial))).toBe(false);
    expect(fs.existsSync(path.join(backups, livePartial))).toBe(true);

    const kept = snapshots();
    expect(kept).toHaveLength(3);
    expect(kept.slice(0, 2)).toEqual([older[2], older[3]]);
    expect(kept[2]).toMatch(/^db-before-migration-from-v0-/);
    for (const name of notOurs) expect(fs.existsSync(path.join(backups, name))).toBe(true);
  });
});
