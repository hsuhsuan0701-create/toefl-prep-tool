import crypto from "node:crypto";
import { sqliteTimestamp, type SqliteTimestamp } from "../db/timestamps.js";
import { abortableDelay } from "../lib/abortableDelay.js";

const HEARTBEAT_MS = 5_000;
const EXPIRY_MS = 15_000;
const ACQUIRE_RETRY_MS = 1_000;
export const EXECUTION_LEASE_HEARTBEAT_MS = HEARTBEAT_MS;
export const EXECUTION_LEASE_EXPIRY_MS = EXPIRY_MS;

/**
 * The lease stayed held for the whole acquisition window. Either another live server is using this
 * database, or one is still shutting down and outlasted the window.
 */
export class ExecutionLeaseUnavailableError extends Error {
  constructor(readonly waitedMs: number) {
    super(`execution lease is held by another server (waited ${Math.round(waitedMs / 1000)}s)`);
    this.name = "ExecutionLeaseUnavailableError";
  }
}

/** `start` was abandoned by `stop()` or its signal before it acquired the lease. */
export class ExecutionOwnerStoppedError extends Error {
  constructor() {
    super("execution owner stopped before it acquired the lease");
    this.name = "ExecutionOwnerStoppedError";
  }
}

/**
 * The `execution_lease` port: the single-row lease that makes one process the owner of every durable
 * job in this database (adapter: db/stores/executionLease.ts).
 *
 * Both timestamps are compared as strings, which is why they are `SqliteTimestamp` rather than
 * `string`: acquire compares the stored `expires_at` against the caller's `now`, and the heartbeat
 * writes the pair the next acquire compares. An ISO-8601 value sorts above every same-day space-form
 * value ('T' > ' '), so a lease written that way would look live forever and no server could take
 * over after a crash; with the formats the other way round, two processes could hold it at once and
 * each treat the other's jobs as orphans.
 *
 * The release and the heartbeat are token-guarded compare-and-writes that report whether they won: a
 * process that has lost the lease learns it from the answer rather than assuming it still holds one.
 */
export type ExecutionLeaseStore = {
  acquireExecutionLease(input: { ownerToken: string; now: SqliteTimestamp; expiresAt: SqliteTimestamp }): boolean;
  heartbeatExecutionLease(input: { ownerToken: string; now: SqliteTimestamp; expiresAt: SqliteTimestamp }): boolean;
  releaseExecutionLease(ownerToken: string): boolean;
};

/**
 * Owns the execution lease for this process.
 *
 * `start` takes the lease, runs `recover`, and only then reports ready. A lease that is still held
 * is normal right after a restart: a process killed without releasing it (SIGKILL, a crash, `tsx
 * watch` giving up on a slow shutdown) leaves it live until its expiry, and a predecessor that is
 * still draining keeps heartbeating it. So `start` retries every second for `acquireTimeoutMs`
 * before giving up with `ExecutionLeaseUnavailableError`. Readiness reads `waiting-for-lease` meanwhile, which keeps
 * job admission closed. `stop()` or `signal` abandons the wait, so a process shutting down while it
 * waits can never acquire the lease afterwards and leave it held.
 */
export function createExecutionOwner(
  repo: ExecutionLeaseStore,
  options: {
    token?: string;
    now?: () => Date;
    onLeaseLost?: () => void;
    /** Called once, when the first acquisition attempt finds the lease held. */
    onWaitingForLease?: () => void;
    /**
     * How long to keep retrying a held lease. Never less than one expiry (the longest a dead
     * holder's lease outlives it) plus one heartbeat of margin for the timestamps' 1 s precision.
     */
    acquireTimeoutMs?: number;
  } = {},
) {
  const token = options.token ?? crypto.randomUUID();
  const now = options.now ?? (() => new Date());
  const acquireTimeoutMs = Math.max(options.acquireTimeoutMs ?? 0, EXPIRY_MS + HEARTBEAT_MS);
  let state: "stopped" | "waiting-for-lease" | "lease-unavailable" | "recovering" | "ready" = "stopped";
  let heartbeat: NodeJS.Timeout | undefined;
  let leaseLost = false;
  let abandonWait: AbortController | undefined;

  function leaseTimes() {
    const current = now();
    return {
      now: sqliteTimestamp(current),
      expiresAt: sqliteTimestamp(new Date(current.getTime() + EXPIRY_MS)),
    };
  }

  const tryAcquire = () => repo.acquireExecutionLease({ ownerToken: token, ...leaseTimes() });

  async function waitForLease(signal: AbortSignal): Promise<void> {
    options.onWaitingForLease?.();
    let waitedMs = 0;
    while (waitedMs < acquireTimeoutMs) {
      try {
        await abortableDelay(ACQUIRE_RETRY_MS, signal);
      } catch {
        throw new ExecutionOwnerStoppedError();
      }
      waitedMs += ACQUIRE_RETRY_MS;
      if (tryAcquire()) return;
    }
    throw new ExecutionLeaseUnavailableError(waitedMs);
  }

  return {
    token,
    async start(recover: () => Promise<void> | void, opts: { signal?: AbortSignal } = {}): Promise<void> {
      if (opts.signal?.aborted) throw new ExecutionOwnerStoppedError();
      // The first attempt is synchronous, so an uncontended start reads `recovering` as soon as it
      // returns its promise.
      if (!tryAcquire()) {
        state = "waiting-for-lease";
        const controller = new AbortController();
        abandonWait = controller;
        try {
          await waitForLease(opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal);
        } catch (error) {
          state = error instanceof ExecutionLeaseUnavailableError ? "lease-unavailable" : "stopped";
          throw error;
        } finally {
          if (abandonWait === controller) abandonWait = undefined;
        }
      }
      state = "recovering";
      leaseLost = false;
      heartbeat = setInterval(() => {
        if (!repo.heartbeatExecutionLease({ ownerToken: token, ...leaseTimes() })) {
          leaseLost = true;
          state = "lease-unavailable";
          if (heartbeat) clearInterval(heartbeat);
          heartbeat = undefined;
          options.onLeaseLost?.();
        }
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
      try {
        await recover();
      } catch (error) {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = undefined;
        if (!leaseLost) {
          repo.releaseExecutionLease(token);
          state = "stopped";
        }
        throw error;
      }
      if (leaseLost) {
        throw new Error("execution lease was lost during recovery");
      }
      state = "ready";
    },
    readiness(): { ready: true } | { ready: false; reason: string } {
      return state === "ready" ? { ready: true } : {
        ready: false,
        reason: state === "stopped" ? "not-started" : state,
      };
    },
    stop(): void {
      abandonWait?.abort();
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      repo.releaseExecutionLease(token);
      state = "stopped";
    },
  };
}

export type ExecutionOwner = ReturnType<typeof createExecutionOwner>;
