import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import { createSqliteProviderQuotaStore } from "../src/db/stores/providerQuota.js";
import { createRepoProviderCircuitPersistence } from "../src/services/reasoning/providerQuotaStore.js";
import { createProviderState } from "../src/services/reasoning/providerState.js";
import { pinTimezone } from "./helpers/pinTimezone.js";

// The provider circuit's persistence over the real `provider_quota_resets` table.
// `createRepoProviderCircuitPersistence` translates between a row and a circuit state, and it is not
// a passthrough: it converts ISO-8601 to and from epoch milliseconds, and a `Number.isFinite` guard
// decides between restoring a circuit and reporting none. reasoning.providerState.test.ts fakes the
// layer above it (`ProviderCircuitPersistence`), so this file runs the translation over the real
// SQLite store: the subject is what reaches disk and what comes back, and a fake would only prove
// the translation agrees with itself.
//
// The decision pinned here (docs/adr/0008): `provider_quota_resets` keeps ISO-8601 rather than the
// project's space-form UTC. The stored-format tests fail if either writer is "corrected" to the
// convention, and the SQL guard at the end fails if a query appears that would make the format
// unsafe.

// On a UTC machine the ISO form and the space form name the same instant, so an assertion about the
// difference between them would pass falsely; the exception is reachable only under a real offset.
const EXPECTED_OFFSET = pinTimezone();

/** What `new Date(ms).toISOString()` emits, exactly — the form the two columns are meant to hold. */
const ISO_8601_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** What `sqliteTimestamp()` emits — the project-wide convention these two columns deliberately opt out of. */
const SQLITE_SPACE_FORM = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// A quota window with a non-zero millisecond component, so a lossy round trip cannot pass by
// accident: the space form's `slice(0, 19)` would silently drop the .123.
const RESET_AT_MS = Date.UTC(2026, 7, 22, 12, 50, 10, 123);

function overRealSqlite() {
  const store = createSqliteProviderQuotaStore(openDb(":memory:"));
  return { store, persistence: createRepoProviderCircuitPersistence(store) };
}

describe("the provider circuit's quota persistence", () => {
  it("runs under a non-UTC machine timezone, so the space-form trap is reachable", () => {
    expect(new Date(RESET_AT_MS).getTimezoneOffset()).toBe(EXPECTED_OFFSET);
  });

  it("round-trips a hard-quota deadline through the real table with no drift", () => {
    const { persistence } = overRealSqlite();

    persistence.save("claude", { failureKind: "quota", resetAtMs: RESET_AT_MS });

    // Exactly the instant that was saved, to the millisecond. This is the assertion the whole
    // feature rests on: a restart must not forget — or move — a quota window with hours left on it.
    expect(persistence.load("claude")).toEqual({ failureKind: "quota", resetAtMs: RESET_AT_MS });
  });

  it("keeps each provider's window to itself", () => {
    const { persistence } = overRealSqlite();

    persistence.save("claude", { failureKind: "quota", resetAtMs: RESET_AT_MS });
    persistence.save("codex", { failureKind: "quota", resetAtMs: RESET_AT_MS + 3_600_000 });

    expect(persistence.load("claude")?.resetAtMs).toBe(RESET_AT_MS);
    expect(persistence.load("codex")?.resetAtMs).toBe(RESET_AT_MS + 3_600_000);
  });

  it("stores reset_at as ISO-8601 UTC, deliberately NOT this project's space form", () => {
    const { store, persistence } = overRealSqlite();

    persistence.save("claude", { failureKind: "quota", resetAtMs: RESET_AT_MS });

    const row = store.getProviderQuotaReset("claude");
    // This column is the documented exception to the `sqliteTimestamp()` convention, and rewriting
    // the writer to that helper would shift every persisted window by the machine's UTC offset and
    // misread every row already on disk. If this line failed, read docs/adr/0008 before changing the
    // assertion.
    expect(row?.reset_at).toMatch(ISO_8601_UTC_MS);
    expect(row?.reset_at).toBe("2026-08-22T12:50:10.123Z");
    expect(SQLITE_SPACE_FORM.test(row?.reset_at ?? "")).toBe(false);

    // observed_at is written by the same call and carries the same exception.
    expect(row?.observed_at).toMatch(ISO_8601_UTC_MS);
    expect(SQLITE_SPACE_FORM.test(row?.observed_at ?? "")).toBe(false);
    expect(Math.abs(Date.parse(row?.observed_at ?? "") - Date.now())).toBeLessThan(60_000);
  });

  it("would restore a window eight hours early if the column were 'corrected' to the space form", () => {
    const { store, persistence } = overRealSqlite();

    // The edit this exception exists to prevent: the same instant, written through the project-wide
    // convention instead. `Date.parse` reads that form as local time.
    const spaceForm = new Date(RESET_AT_MS).toISOString().replace("T", " ").slice(0, 19);
    store.setProviderQuotaReset({ provider: "claude", resetAt: spaceForm, observedAt: spaceForm });

    const restored = persistence.load("claude");
    // Not a rounding difference but a whole UTC offset (eight hours here), which on a real quota
    // window reopens the circuit while the provider is still refusing work. Nothing throws, and the
    // value is finite, so the guard cannot catch it either: the format has to be pinned.
    expect(restored?.resetAtMs).toBe(RESET_AT_MS - 123 + EXPECTED_OFFSET * 60_000);
    expect(restored?.resetAtMs).not.toBe(RESET_AT_MS);
    expect(RESET_AT_MS - (restored?.resetAtMs ?? 0)).toBe(8 * 60 * 60 * 1000 + 123);
  });

  it("restores a circuit from a parseable row, so a restart honours a live quota window", () => {
    const { store, persistence } = overRealSqlite();
    store.setProviderQuotaReset({
      provider: "claude",
      resetAt: new Date(RESET_AT_MS).toISOString(),
      observedAt: new Date(RESET_AT_MS - 3_600_000).toISOString(),
    });

    // The guard's finite branch, end to end: the row on disk becomes an open circuit whose retry
    // deadline is the epoch milliseconds this translation produced, plus ADR 0007's five-second
    // margin on a trustworthy reset timestamp. The window arrives as a number that later arithmetic
    // depends on, so a translation off by a UTC offset would land silently in that arithmetic.
    const state = createProviderState({ now: () => RESET_AT_MS - 60_000, persistence });
    expect(state.circuitOpen("claude")).toBe(true);
    expect(state.snapshot()[0]).toMatchObject({
      provider: "claude",
      availability: "circuit-open",
      failureKind: "quota",
      retryAtMs: RESET_AT_MS + 5_000,
    });
    // The other provider has no row: nothing restored, nothing invented.
    expect(state.circuitOpen("codex")).toBe(false);
  });

  it.each([
    ["free text", "not a timestamp"],
    ["an empty string", ""],
    ["an impossible date", "2026-13-45T99:99:99Z"],
    ["a bare epoch-ms number", "1787661010123"],
  ])("reports no persisted circuit when reset_at holds %s", (_label, stored) => {
    const { store, persistence } = overRealSqlite();
    store.setProviderQuotaReset({ provider: "claude", resetAt: stored, observedAt: stored });

    // The guard's non-finite branch: `undefined` exactly, not a circuit carrying NaN, which would
    // reopen at once or never and compare false against every clock reading in between.
    expect(persistence.load("claude")).toBeUndefined();

    const state = createProviderState({ now: () => RESET_AT_MS, persistence });
    expect(state.circuitOpen("claude")).toBe(false);
    expect(state.snapshot()[0]).toMatchObject({ provider: "claude" });
    expect(state.snapshot()[0].retryAtMs).toBeUndefined();
  });

  it("reports no persisted circuit when the provider has no row at all", () => {
    const { persistence } = overRealSqlite();
    expect(persistence.load("claude")).toBeUndefined();
    expect(persistence.load("codex")).toBeUndefined();
  });

  it("clears a window so a recovered provider does not reopen its own circuit on the next boot", () => {
    const { store, persistence } = overRealSqlite();
    persistence.save("claude", { failureKind: "quota", resetAtMs: RESET_AT_MS });

    persistence.clear("claude");

    expect(store.getProviderQuotaReset("claude")).toBeUndefined();
    expect(persistence.load("claude")).toBeUndefined();
    // Clearing a provider that has no row is a no-op, not a throw: `clear` is called on every
    // successful preflight, and the common case is that there is nothing to clear.
    expect(() => persistence.clear("codex")).not.toThrow();
  });

  it("overwrites the previous window rather than accumulating rows", () => {
    const { store, persistence } = overRealSqlite();
    persistence.save("claude", { failureKind: "quota", resetAtMs: RESET_AT_MS });
    persistence.save("claude", { failureKind: "quota", resetAtMs: RESET_AT_MS + 7_200_000 });

    expect(store.getProviderQuotaReset("claude")?.reset_at).toBe(new Date(RESET_AT_MS + 7_200_000).toISOString());
    expect(persistence.load("claude")?.resetAtMs).toBe(RESET_AT_MS + 7_200_000);
  });
});

// The other half of the decision: the SQL that keeps the exception safe. The ISO exception is sound
// because nothing compares these columns as strings: the table is read by exact `provider` match
// only, with no ORDER BY and no range predicate. That is a property of the SQL, not of the format,
// so a comment cannot hold it: the first `WHERE reset_at > ?` or `ORDER BY reset_at` would break
// silently, because an ISO value sorts above every same-day space-form value ('T' > ' ') and the two
// forms are eight hours apart here.
//
// So the premise is asserted against the store's real source (as claudeRunner.test.ts checks its
// deny list against `fs.readdirSync`), not a hand-kept mirror. A query that ranges over or orders by
// `reset_at` fails here and has to migrate the column first, the conversation docs/adr/0008 asks
// for.
describe("the provider_quota_resets statements", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const storePath = path.resolve(here, "../src/db/stores/providerQuota.ts");
  const source = fs.readFileSync(storePath, "utf8");

  const statements = [...source.matchAll(/db\.prepare\(\s*(`[^`]*`|"[^"]*"|'[^']*')/g)]
    .map((match) => match[1].slice(1, -1));

  it("are all visible to this guard", () => {
    // If a statement is written in a form the matcher above misses, the assertions below would pass
    // vacuously. Anchor the count to the real number of `db.prepare(` call sites in the file.
    expect(statements.length).toBe((source.match(/db\.prepare\(/g) ?? []).length);
    expect(statements.length).toBeGreaterThanOrEqual(3);
    expect(statements.every((sql) => /provider_quota_resets/i.test(sql))).toBe(true);
  });

  it("never order by or range over reset_at/observed_at, which is what keeps the ISO exception safe", () => {
    for (const sql of statements) {
      expect(sql, `ORDER BY over provider_quota_resets would depend on the stored format:\n${sql}`)
        .not.toMatch(/\border\s+by\b/i);
      expect(sql, `a comparison against reset_at/observed_at would depend on the stored format:\n${sql}`)
        .not.toMatch(/\b(reset_at|observed_at)\s*(<|>|<=|>=|!=|<>|\bbetween\b|\blike\b|\bglob\b)/i);
      // Every filter this table has must be on `provider` alone. Anything after WHERE that names a
      // timestamp column — even `reset_at = ?` — makes the on-disk format load-bearing.
      const filter = sql.split(/\bwhere\b/i)[1];
      if (filter !== undefined) {
        expect(filter, `provider_quota_resets must be filtered by provider only:\n${sql}`)
          .not.toMatch(/reset_at|observed_at/i);
      }
    }
  });
});
