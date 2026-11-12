import { describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./helpers/fakeTimers.js";
import { createExecutionOwner, type ExecutionLeaseStore } from "../src/services/executionOwner.js";
import { sqliteTimestamp } from "../src/db/timestamps.js";

// A type-level test: `npm run typecheck` compiles this file (server/tsconfig.json includes test/),
// and each @ts-expect-error below fails that compile if its line ever stops being an error. Vitest
// only runs the function body, which asserts nothing.
//
// The lease store compares `expires_at > ?` as strings, so it must receive the form the columns hold.
// An ISO value sorts above every same-day space-form value ('T' > ' '), so a lease written that way
// would look live forever and no second server could take over after a crash. The SqliteTimestamp
// brand on the port makes the space form the only one it accepts. That the real store expires and
// hands over a lease written in that form is executionOwner.leaseWait.test.ts's subject.
describe("execution lease store port", () => {
  it("accepts a SqliteTimestamp and refuses an ISO-8601 string at compile time", () => {
    type LeaseInput = Parameters<ExecutionLeaseStore["acquireExecutionLease"]>[0];
    const now = new Date("2026-08-23T10:00:00.000Z");
    const accepted: LeaseInput = {
      ownerToken: "t", now: sqliteTimestamp(now), expiresAt: sqliteTimestamp(new Date(now.getTime() + 15_000)),
    };
    const refused: LeaseInput = {
      ownerToken: "t",
      // @ts-expect-error an ISO-8601 string is not a SqliteTimestamp
      now: now.toISOString(),
      expiresAt: sqliteTimestamp(now),
    };
    const heartbeat: Parameters<ExecutionLeaseStore["heartbeatExecutionLease"]>[0] = {
      ownerToken: "t",
      now: sqliteTimestamp(now),
      // @ts-expect-error an ISO-8601 string is not a SqliteTimestamp
      expiresAt: now.toISOString(),
    };
    void accepted;
    void refused;
    void heartbeat;
  });
});

describe("execution owner", () => {
  it("loses readiness when a heartbeat finds it does not own the lease", async () => {
    const clock = useFakeTimersInTest();
    const heartbeat = vi.fn(() => false);
    const onLeaseLost = vi.fn();
    const owner = createExecutionOwner({
      acquireExecutionLease: () => true,
      heartbeatExecutionLease: heartbeat,
      releaseExecutionLease: () => true,
    }, { onLeaseLost });
    await owner.start(async () => undefined);
    expect(owner.readiness()).toEqual({ ready: true });
    await clock.advanceBy(5_000);
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(owner.readiness()).toEqual({ ready: false, reason: "lease-unavailable" });
    expect(onLeaseLost).toHaveBeenCalledOnce();
  });

  it("does not become ready until it owns the database lease and recovery completes", async () => {
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const lease = {
      acquireExecutionLease: vi.fn(() => true),
      heartbeatExecutionLease: vi.fn(() => true),
      releaseExecutionLease: vi.fn(() => true),
    };
    const owner = createExecutionOwner(lease, { token: "owner-1", now: () => new Date(0) });

    const starting = owner.start(() => recovery);
    expect(owner.readiness()).toEqual({ ready: false, reason: "recovering" });
    finishRecovery();
    await starting;
    expect(owner.readiness()).toEqual({ ready: true });
    owner.stop();
    expect(lease.releaseExecutionLease).toHaveBeenCalledWith("owner-1");
  });

  it("heartbeats during recovery and never becomes ready after losing the lease", async () => {
    const clock = useFakeTimersInTest();
    let finishRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => { finishRecovery = resolve; });
    const onLeaseLost = vi.fn();
    const heartbeat = vi.fn(() => false);
    const owner = createExecutionOwner({
      acquireExecutionLease: () => true,
      heartbeatExecutionLease: heartbeat,
      releaseExecutionLease: () => true,
    }, { onLeaseLost });

    const starting = owner.start(() => recovery);
    expect(owner.readiness()).toEqual({ ready: false, reason: "recovering" });
    await clock.advanceBy(5_000);
    expect(heartbeat).toHaveBeenCalledOnce();
    expect(owner.readiness()).toEqual({ ready: false, reason: "lease-unavailable" });
    finishRecovery();
    await expect(starting).rejects.toThrow("execution lease was lost during recovery");
    expect(owner.readiness()).toEqual({ ready: false, reason: "lease-unavailable" });
    expect(onLeaseLost).toHaveBeenCalledOnce();
  });

  it("refuses readiness when another live owner holds the lease", async () => {
    const clock = useFakeTimersInTest();
    const owner = createExecutionOwner({
      acquireExecutionLease: () => false,
      heartbeatExecutionLease: () => false,
      releaseExecutionLease: () => false,
    });
    const starting = expect(owner.start(async () => undefined)).rejects.toThrow("execution lease");
    expect(owner.readiness()).toEqual({ ready: false, reason: "waiting-for-lease" });
    await clock.advanceBy(60_000);
    await starting;
    expect(owner.readiness()).toEqual({ ready: false, reason: "lease-unavailable" });
  });
});
