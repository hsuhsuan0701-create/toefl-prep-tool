import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

describe("concurrent pipeline persistence", () => {
  it("uses a token-guarded execution lease", () => {
    const r = sqliteStores(openDb(":memory:"));
    expect(r.acquireExecutionLease({ ownerToken: "a", now: "2026-01-01 00:00:00", expiresAt: "2026-01-01 00:00:15" })).toBe(true);
    expect(r.acquireExecutionLease({ ownerToken: "b", now: "2026-01-01 00:00:01", expiresAt: "2026-01-01 00:00:16" })).toBe(false);
    expect(r.heartbeatExecutionLease({ ownerToken: "b", now: "2026-01-01 00:00:05", expiresAt: "2026-01-01 00:00:20" })).toBe(false);
    expect(r.heartbeatExecutionLease({ ownerToken: "a", now: "2026-01-01 00:00:05", expiresAt: "2026-01-01 00:00:20" })).toBe(true);
    expect(r.acquireExecutionLease({ ownerToken: "b", now: "2026-01-01 00:00:21", expiresAt: "2026-01-01 00:00:36" })).toBe(true);
    expect(r.releaseExecutionLease("a")).toBe(false);
  });

  it("lets generation publication intent beat a later cancellation", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createGenerationJob({ id: "g", kind: "speaking" });
    r.updateGenerationJob({ id: "g", status: "running", setId: "set-1" });
    expect(r.commitGenerationPublicationIntent({ childId: "g", setId: "set-1", expectedKind: "speaking", stagingPath: "/tmp/a", canonicalPath: "/sets/a", contentHash: "abc", now: "2026-01-01 00:00:00" })).toBe(true);
    expect(r.requestGenerationJobCancellation({ id: "g", reason: "user", now: "2026-01-01 00:00:01" })).toEqual({ accepted: false, state: "publication_committed" });
  });

  it("lets committed cancellation suppress publication and creates idempotent cleanup debt", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createGenerationJob({ id: "g", kind: "writing" });
    expect(r.requestGenerationJobCancellation({ id: "g", reason: "superseded", now: "2026-01-01 00:00:00" })).toEqual({ accepted: true, state: "cancel_requested" });
    expect(r.commitGenerationPublicationIntent({ childId: "g", setId: "set-1", expectedKind: "writing", stagingPath: "/tmp/a", canonicalPath: "/sets/a", contentHash: "abc", now: "2026-01-01 00:00:01" })).toBe(false);
    r.createCleanupDebt({ id: "d", childId: "g", path: "/tmp/a", now: "2026-01-01 00:00:01" });
    r.createCleanupDebt({ id: "d", childId: "g", path: "/tmp/a", now: "2026-01-01 00:00:01" });
    expect(r.listPendingCleanupDebt()).toHaveLength(1);
  });

  it("persists and clears a trustworthy provider quota reset", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.setProviderQuotaReset({ provider: "claude", resetAt: "2026-01-02 00:00:00", observedAt: "2026-01-01 00:00:00" });
    expect(r.getProviderQuotaReset("claude")?.reset_at).toBe("2026-01-02 00:00:00");
    r.clearProviderQuotaReset("claude");
    expect(r.getProviderQuotaReset("claude")).toBeUndefined();
  });
});
