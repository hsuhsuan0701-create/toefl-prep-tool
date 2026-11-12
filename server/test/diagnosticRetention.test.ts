import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/db.js";
import { createSqliteStores, diagnosticRetentionStore } from "../src/db/stores/index.js";
import {
  DIAGNOSTIC_RETENTION_INTERVAL_MS,
  modelCallPruneCutoff,
  reclaimFreePagesWhileIdle,
  startDiagnosticRetention,
  wireModelCallPruning,
} from "../src/services/modelCallLog.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_V1_SQL = fs.readFileSync(path.join(here, "../src/db/schemaV1.sql"), "utf8");

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "toefl-retention-"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

type Stores = ReturnType<typeof sqliteStores>;

function insertRouteInvocationAt(db: Database.Database, r: Stores, id: string, createdAt: string): void {
  r.insertRouteInvocation({ id, operation: "aggregate", family: "scoring", queuedAtMs: 0 });
  r.insertProviderExecution({ id: `${id}-pe`, routeInvocationId: id, sequence: 1, provider: "claude", family: "scoring", operation: "aggregate", queuedAtMs: 0 });
  r.insertModelAttempt({ id: `${id}-ma`, providerExecutionId: `${id}-pe`, sequence: 1, kind: "initial", prompt: "p", startedAtMs: 0 });
  db.prepare("UPDATE route_invocations SET created_at=? WHERE id=?").run(createdAt, id);
}

function insertClipMeasurementAt(db: Database.Database, r: Stores, id: string, createdAt: string): void {
  r.insertClipMeasurement({ id, setId: "spk-1", role: "lr-item", file: `${id}.mp3`, wordCount: 7, durationSec: 2.4, wpm: 175, speed: 0.95, correctionCount: 0, inBand: true });
  db.prepare("UPDATE clip_measurements SET created_at=? WHERE id=?").run(createdAt, id);
}

/** Runs every 'listening' listener `wire` registers, as the boot chain does. */
function bootWith(wire: (server: { on: (event: "listening", fn: () => unknown) => void }) => void): void {
  const listeners: Array<() => unknown> = [];
  wire({ on: (_event, fn) => listeners.push(fn) });
  for (const listener of listeners) listener();
}

const BOOTED_AT = () => new Date("2026-08-04T12:00:00Z");

describe("diagnostic retention at boot", () => {
  it("prunes by age, keeps the boundary row, and takes the executions and attempts with it", () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    insertRouteInvocationAt(db, r, "ancient", "2026-06-01 00:00:00");
    insertRouteInvocationAt(db, r, "boundary", "2026-07-05 12:00:00");
    insertRouteInvocationAt(db, r, "recent", "2026-08-01 00:00:00");

    // 30 days before 2026-08-04 12:00:00 is exactly the boundary row's stamp.
    expect(modelCallPruneCutoff(BOOTED_AT(), 30)).toBe("2026-07-05 12:00:00");
    bootWith((server) => wireModelCallPruning(server, r, 30, BOOTED_AT));

    expect(db.prepare("SELECT id FROM route_invocations ORDER BY id").all()).toEqual([{ id: "boundary" }, { id: "recent" }]);
    expect(db.prepare("SELECT id FROM model_attempts ORDER BY id").all()).toEqual([{ id: "boundary-ma" }, { id: "recent-ma" }]);
  });

  it("treats a retention of 0 as keeping everything", () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    insertRouteInvocationAt(db, r, "ancient", "2026-06-01 00:00:00");
    bootWith((server) => wireModelCallPruning(server, r, 0, BOOTED_AT));
    expect(db.prepare("SELECT COUNT(*) AS n FROM route_invocations").get()).toEqual({ n: 1 });
  });

  it("prunes the clip measurements under the same retention setting", () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    insertClipMeasurementAt(db, r, "clip-old", "2026-06-01 00:00:00");
    insertClipMeasurementAt(db, r, "clip-fresh", "2026-08-01 00:00:00");
    bootWith((server) => wireModelCallPruning(server, r, 30, BOOTED_AT));
    expect(db.prepare("SELECT id FROM clip_measurements").all()).toEqual([{ id: "clip-fresh" }]);
  });
});

// A few MiB of model attempts, all older than the retention window — what a server that has been
// off for a month finds at boot.
function fillWithOldDiagnostics(db: Database.Database, r: Stores, count = 400): void {
  const prompt = "x".repeat(16 * 1024);
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      r.insertRouteInvocation({ id: `old-${i}`, operation: "aggregate", family: "scoring", queuedAtMs: 0 });
      r.insertProviderExecution({ id: `old-${i}-pe`, routeInvocationId: `old-${i}`, sequence: 1, provider: "claude", family: "scoring", operation: "aggregate", queuedAtMs: 0 });
      r.insertModelAttempt({ id: `old-${i}-ma`, providerExecutionId: `old-${i}-pe`, sequence: 1, kind: "initial", prompt, startedAtMs: 0 });
    }
    db.prepare("UPDATE route_invocations SET created_at='2026-06-01 00:00:00'").run();
  })();
}

const pages = (db: Database.Database) => ({
  total: db.pragma("page_count", { simple: true }) as number,
  free: db.pragma("freelist_count", { simple: true }) as number,
});

/**
 * A database created from the v1 schema without incremental auto-vacuum, as an existing install's
 * may be, for openDb to adopt.
 */
function databaseWithoutIncrementalVacuum(): string {
  const file = path.join(dir, "old.sqlite");
  const raw = new Database(file);
  raw.exec(SCHEMA_V1_SQL);
  raw.close();
  return file;
}

describe("database space", () => {
  it("is reclaimable in small steps on a database created by this version", () => {
    const db = openDb(path.join(dir, "new.sqlite"));
    expect(db.pragma("auto_vacuum", { simple: true })).toBe(2); // INCREMENTAL
    db.close();
  });

  it("is compacted after a large prune at boot, which also makes it reclaimable in small steps", () => {
    const file = databaseWithoutIncrementalVacuum();
    const db = openDb(file);
    expect(db.pragma("auto_vacuum", { simple: true })).toBe(0);
    const r = sqliteStores(db);
    fillWithOldDiagnostics(db, r);
    const before = pages(db).total;
    vi.spyOn(console, "log").mockImplementation(() => {});

    bootWith((server) => wireModelCallPruning(server, r, 30, BOOTED_AT));

    expect(db.prepare("SELECT COUNT(*) AS n FROM model_attempts").get()).toEqual({ n: 0 });
    expect(db.pragma("auto_vacuum", { simple: true })).toBe(2);
    expect(pages(db).free).toBe(0);
    expect(pages(db).total).toBeLessThan(before / 10);
    db.close();
    expect(fs.statSync(file).size).toBeLessThan(before * 4096 / 10);
  });

  it("is reclaimed in small steps after a large prune at boot on a database that already allows it", () => {
    const db = openDb(path.join(dir, "incremental.sqlite"));
    const r = sqliteStores(db);
    fillWithOldDiagnostics(db, r);
    const before = pages(db).total;
    vi.spyOn(console, "log").mockImplementation(() => {});

    bootWith((server) => wireModelCallPruning(server, r, 30, BOOTED_AT));

    expect(pages(db).free).toBe(0);
    expect(pages(db).total).toBeLessThan(before / 10);
    db.close();
  });

  it("is left alone at boot when the prune freed only a little of the file", () => {
    const file = databaseWithoutIncrementalVacuum();
    const db = openDb(file);
    const r = sqliteStores(db);
    fillWithOldDiagnostics(db, r, 4);
    vi.spyOn(console, "log").mockImplementation(() => {});

    bootWith((server) => wireModelCallPruning(server, r, 30, BOOTED_AT));

    expect(db.prepare("SELECT COUNT(*) AS n FROM model_attempts").get()).toEqual({ n: 0 });
    expect(db.pragma("auto_vacuum", { simple: true })).toBe(0); // no full VACUUM for a small prune
    expect(pages(db).free).toBeGreaterThan(0);
    db.close();
  });
});

describe("reclaiming free pages on a running server", () => {
  it("returns pages to the file system a chunk at a time, yielding between chunks", async () => {
    const db = openDb(path.join(dir, "running.sqlite"));
    const r = sqliteStores(db);
    fillWithOldDiagnostics(db, r);
    r.pruneNormalizedModelCalls("2026-07-01 00:00:00");
    const freed = pages(db).free;
    expect(freed).toBeGreaterThan(1024); // more than one step's worth

    let yields = 0;
    const reclaimed = await reclaimFreePagesWhileIdle(r, () => true, async () => { yields += 1; });

    expect(reclaimed).toBe(freed);
    expect(pages(db).free).toBe(0);
    expect(yields).toBeGreaterThan(1);
    db.close();
  });

  it("stops at the next chunk boundary once a job is running", async () => {
    const db = openDb(path.join(dir, "busy.sqlite"));
    const r = sqliteStores(db);
    fillWithOldDiagnostics(db, r);
    r.pruneNormalizedModelCalls("2026-07-01 00:00:00");
    const freed = pages(db).free;

    let idle = true;
    const reclaimed = await reclaimFreePagesWhileIdle(r, () => idle, async () => { idle = false; });

    expect(reclaimed).toBeGreaterThan(0);
    expect(reclaimed).toBeLessThan(freed);
    expect(pages(db).free).toBe(freed - reclaimed);
    db.close();
  });

  it("does not start while a job is running", async () => {
    const db = openDb(path.join(dir, "busy-from-start.sqlite"));
    const r = sqliteStores(db);
    fillWithOldDiagnostics(db, r);
    r.pruneNormalizedModelCalls("2026-07-01 00:00:00");
    const freed = pages(db).free;

    expect(await reclaimFreePagesWhileIdle(r, () => false, async () => {})).toBe(0);
    expect(pages(db).free).toBe(freed);
    db.close();
  });
});

describe("the daily retention timer", () => {
  it("prunes once a day and reclaims what it freed, and does nothing after it is stopped", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = openDb(path.join(dir, "timer.sqlite"));
    const r = sqliteStores(db);
    fillWithOldDiagnostics(db, r);
    const before = pages(db).total;

    const stop = startDiagnosticRetention({ repo: r, isIdle: () => true, retentionDays: 30, now: BOOTED_AT });
    vi.advanceTimersByTime(DIAGNOSTIC_RETENTION_INTERVAL_MS - 1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM route_invocations").get()).toEqual({ n: 400 });

    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(pages(db).free).toBe(0));
    expect(db.prepare("SELECT COUNT(*) AS n FROM route_invocations").get()).toEqual({ n: 0 });
    expect(pages(db).total).toBeLessThan(before / 10);

    stop();
    insertRouteInvocationAt(db, r, "after-stop", "2026-06-01 00:00:00");
    vi.advanceTimersByTime(DIAGNOSTIC_RETENTION_INTERVAL_MS * 2);
    expect(db.prepare("SELECT id FROM route_invocations").all()).toEqual([{ id: "after-stop" }]);
    db.close();
  });

  it("prunes but leaves the free pages while a job is running", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const db = openDb(path.join(dir, "timer-busy.sqlite"));
    const r = sqliteStores(db);
    fillWithOldDiagnostics(db, r);

    const stop = startDiagnosticRetention({ repo: r, isIdle: () => false, retentionDays: 30, now: BOOTED_AT });
    vi.advanceTimersByTime(DIAGNOSTIC_RETENTION_INTERVAL_MS);
    await vi.waitFor(() => expect(db.prepare("SELECT COUNT(*) AS n FROM route_invocations").get()).toEqual({ n: 0 }));
    expect(pages(db).free).toBeGreaterThan(0);
    stop();
    db.close();
  });
});

describe("the retention timer's store", () => {
  it("carries the two prunes and the space operations, and nothing else", () => {
    const store = diagnosticRetentionStore(createSqliteStores(openDb(":memory:")));
    expect(Object.keys(store).sort()).toEqual([
      "checkpointWal", "compactDatabase", "freeSpace", "pruneClipMeasurements", "pruneNormalizedModelCalls", "reclaimFreePages",
    ]);
  });
});
