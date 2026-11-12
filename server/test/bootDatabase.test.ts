import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/db.js";
import { SCHEMA_VERSION } from "../src/db/migrations.js";
import { openDatabaseAtBoot } from "../src/index.js";

// The boot path's handling of a database this checkout refuses: the refusal's own message, alone, on
// stderr, and a non-zero exit only once that line is written — never a stack trace, and never the
// rest of the composition running on without a database.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toefl-boot-db-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function bootIo() {
  const written: string[] = [];
  let flush: (() => void) | undefined;
  const exit = vi.fn();
  return {
    written,
    exit,
    flushStderr: () => flush?.(),
    io: {
      writeStderr: (text: string, done: () => void) => {
        written.push(text);
        flush = done;
      },
      exit,
    },
  };
}

describe("openDatabaseAtBoot", () => {
  it("opens a usable database and writes nothing", () => {
    const boot = bootIo();
    const db = openDatabaseAtBoot(() => openDb(path.join(dir, "db.sqlite")), boot.io);
    expect(db).toBeDefined();
    expect(boot.written).toEqual([]);
    expect(boot.exit).not.toHaveBeenCalled();
    db?.close();
  });

  it("prints a newer checkout's database refusal alone and exits 1 once it is written", () => {
    const file = path.join(dir, "db.sqlite");
    openDb(file).close();
    const raw = new Database(file);
    raw.pragma(`user_version = ${SCHEMA_VERSION + 7}`);
    raw.close();

    const boot = bootIo();
    expect(openDatabaseAtBoot(() => openDb(file), boot.io)).toBeUndefined();
    expect(boot.written).toHaveLength(1);
    expect(boot.written[0]).toBe(
      `${file} is at schema version ${SCHEMA_VERSION + 7}, but this checkout only knows versions up to ${SCHEMA_VERSION}. ` +
        "A newer version of this app has upgraded it; run that version (or a newer one) against it.\n",
    );
    expect(boot.written[0]).not.toMatch(/\n\s+at /);
    expect(boot.exit).not.toHaveBeenCalled();
    boot.flushStderr();
    expect(boot.exit).toHaveBeenCalledWith(1);
  });

  it("prints an unversioned database's refusal the same way", () => {
    const file = path.join(dir, "db.sqlite");
    const raw = new Database(file);
    raw.exec("CREATE TABLE attempts (id TEXT PRIMARY KEY)");
    raw.close();

    const boot = bootIo();
    expect(openDatabaseAtBoot(() => openDb(file), boot.io)).toBeUndefined();
    expect(boot.written[0]).toContain(`${file} has no schema version`);
    expect(boot.written[0]).not.toMatch(/\n\s+at /);
    boot.flushStderr();
    expect(boot.exit).toHaveBeenCalledWith(1);
  });

  it("lets any other failure through as the error it is", () => {
    const boot = bootIo();
    const failure = new Error("disk I/O error");
    expect(() => openDatabaseAtBoot(() => { throw failure; }, boot.io)).toThrow(failure);
    expect(boot.written).toEqual([]);
    expect(boot.exit).not.toHaveBeenCalled();
  });
});
