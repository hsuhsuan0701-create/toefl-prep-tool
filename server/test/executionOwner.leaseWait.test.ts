import { describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./helpers/fakeTimers.js";
import {
  createExecutionOwner,
  ExecutionLeaseUnavailableError,
  EXECUTION_LEASE_EXPIRY_MS,
  EXECUTION_LEASE_HEARTBEAT_MS,
  type ExecutionLeaseStore,
} from "../src/services/executionOwner.js";
import { openDb } from "../src/db/db.js";
import { createSqliteStores } from "../src/db/stores/index.js";
import { sqliteTimestamp } from "../src/db/timestamps.js";

// A server that restarts inside the lease's expiry finds the lease still held by the process it
// replaced. The lease is the authority on who owns durable jobs, so the new process must wait it
// out rather than give up on the first refusal and leave the API with no listener.

function refusingStore(grantAfter = Infinity) {
  let calls = 0;
  const store: ExecutionLeaseStore = {
    acquireExecutionLease: () => {
      calls += 1;
      return calls > grantAfter;
    },
    heartbeatExecutionLease: () => true,
    releaseExecutionLease: () => true,
  };
  return { store, calls: () => calls };
}

describe("execution owner: waiting for a held lease", () => {
  it("waits out a killed predecessor's lease through the real store, then recovers and becomes ready", async () => {
    const clock = useFakeTimersInTest({ now: new Date("2026-11-11T10:00:00.000Z") });
    const lease = createSqliteStores(openDb(":memory:")).executionLease;
    // The predecessor's last heartbeat, exactly as a SIGKILL leaves it: a foreign token that is
    // still live for one full expiry and is never released.
    const killedAt = new Date();
    expect(lease.acquireExecutionLease({
      ownerToken: "killed-predecessor",
      now: sqliteTimestamp(killedAt),
      expiresAt: sqliteTimestamp(new Date(killedAt.getTime() + EXECUTION_LEASE_EXPIRY_MS)),
    })).toBe(true);

    const recover = vi.fn(async () => undefined);
    const owner = createExecutionOwner(lease, { token: "replacement" });
    const starting = owner.start(recover);
    let settled = false;
    void starting.then(() => { settled = true; }, () => { settled = true; });

    await clock.advanceBy(5_000);
    expect(owner.readiness()).toEqual({ ready: false, reason: "waiting-for-lease" });
    expect(recover).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    await clock.advanceBy(EXECUTION_LEASE_EXPIRY_MS);
    await starting;
    expect(owner.readiness()).toEqual({ ready: true });
    expect(recover).toHaveBeenCalledOnce();
    // It now holds the lease itself: the dead token can no longer heartbeat it back.
    expect(lease.heartbeatExecutionLease({
      ownerToken: "killed-predecessor", now: sqliteTimestamp(new Date()), expiresAt: sqliteTimestamp(new Date()),
    })).toBe(false);
    owner.stop();
  });

  it("gives up with an actionable error after expiry plus a heartbeat when a live owner keeps the lease", async () => {
    const clock = useFakeTimersInTest();
    const { store, calls } = refusingStore();
    const recover = vi.fn();
    const owner = createExecutionOwner(store);
    const starting = owner.start(recover);
    const outcome = starting.then(() => "resolved", (error: unknown) => error);

    await clock.advanceBy(EXECUTION_LEASE_EXPIRY_MS + EXECUTION_LEASE_HEARTBEAT_MS - 1_000);
    expect(owner.readiness()).toEqual({ ready: false, reason: "waiting-for-lease" });

    await clock.advanceBy(2_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(ExecutionLeaseUnavailableError);
    expect((error as ExecutionLeaseUnavailableError).waitedMs).toBeGreaterThanOrEqual(
      EXECUTION_LEASE_EXPIRY_MS + EXECUTION_LEASE_HEARTBEAT_MS,
    );
    expect(calls()).toBeGreaterThan(10);
    expect(recover).not.toHaveBeenCalled();
    expect(owner.readiness()).toEqual({ ready: false, reason: "lease-unavailable" });
  });

  it("honours a longer acquisition window", async () => {
    const clock = useFakeTimersInTest();
    const { store } = refusingStore(40);
    const owner = createExecutionOwner(store, { acquireTimeoutMs: 60_000 });
    const starting = owner.start(async () => undefined);
    await clock.advanceBy(45_000);
    await starting;
    expect(owner.readiness()).toEqual({ ready: true });
    owner.stop();
  });

  it("stop() during the wait ends the retries, so a shutdown can never take the lease afterwards", async () => {
    const clock = useFakeTimersInTest();
    const { store, calls } = refusingStore(5);
    const recover = vi.fn();
    const owner = createExecutionOwner(store);
    const starting = owner.start(recover);
    const outcome = starting.then(() => "resolved", (error: unknown) => error);

    await clock.advanceBy(2_000);
    owner.stop();
    const callsAtStop = calls();
    await clock.advanceBy(30_000);

    expect(await outcome).toBeInstanceOf(Error);
    expect(await outcome).not.toBeInstanceOf(ExecutionLeaseUnavailableError);
    expect(calls()).toBe(callsAtStop);
    expect(recover).not.toHaveBeenCalled();
    expect(owner.readiness()).toEqual({ ready: false, reason: "not-started" });
  });

  it("an aborted signal ends the wait the same way, without releasing a lease it never held", async () => {
    const clock = useFakeTimersInTest();
    const { store, calls } = refusingStore(5);
    const release = vi.spyOn(store, "releaseExecutionLease");
    const recover = vi.fn();
    const owner = createExecutionOwner(store);
    const controller = new AbortController();
    const outcome = owner.start(recover, { signal: controller.signal }).then(() => "resolved", (error: unknown) => error);

    await clock.advanceBy(2_000);
    controller.abort();
    const callsAtAbort = calls();
    await clock.advanceBy(30_000);

    expect(await outcome).toBeInstanceOf(Error);
    expect(calls()).toBe(callsAtAbort);
    expect(recover).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
});
