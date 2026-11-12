import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/db.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openDb connection settings", () => {
  it("turns foreign keys on and synchronous to FULL itself rather than inheriting the build's defaults", () => {
    // Diagnostic pruning deletes route_invocations and relies on ON DELETE CASCADE to remove
    // model_attempts, the largest table. A better-sqlite3 build compiled with SQLite's own default
    // (foreign keys off) would silently stop pruning it, so the setting is asserted as an explicit
    // statement, not only as the value this particular binary happens to start with.
    const pragma = vi.spyOn(Database.prototype, "pragma");
    const db = openDb(":memory:");
    const issued = pragma.mock.calls.map(([source]) => String(source).replace(/\s+/g, " ").trim().toLowerCase());
    expect(issued).toContain("foreign_keys = on");
    expect(issued).toContain("synchronous = full");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("synchronous", { simple: true })).toBe(2);
    db.close();
  });

  it("cascades a pruned route invocation down to its executions and attempts", () => {
    const db = openDb(":memory:");
    db.prepare("INSERT INTO route_invocations (id, operation, family, queued_at_ms) VALUES ('ri', 'aggregate', 'scoring', 0)").run();
    db.prepare(
      "INSERT INTO provider_executions (id, route_invocation_id, sequence, provider, family, operation, queued_at_ms) VALUES ('pe', 'ri', 0, 'claude', 'scoring', 'aggregate', 0)",
    ).run();
    db.prepare(
      "INSERT INTO model_attempts (id, provider_execution_id, sequence, kind, started_at_ms) VALUES ('ma', 'pe', 0, 'initial', 0)",
    ).run();
    db.prepare("DELETE FROM route_invocations WHERE id = 'ri'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM provider_executions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM model_attempts").get()).toEqual({ n: 0 });
    db.close();
  });
});
