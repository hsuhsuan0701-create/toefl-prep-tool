import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "./helpers/deferred.js";
import { useFakeTimersInTest } from "./helpers/fakeTimers.js";
import { PROBE_RECHECK_MS } from "../src/services/reasoning/providerCircuit.js";
import {
  createProviderExecutor,
  providerResultFromExecution,
} from "../src/services/reasoning/providerExecutor.js";
import {
  PROVIDER_LABELS,
  ReasoningRouteError,
  fallbackEligible,
  opensCircuit,
  type ProviderResult,
  type ReasoningEvent,
} from "../src/services/reasoning/contracts.js";
import {
  CIRCUIT_MS,
  createProviderState,
  type ProviderState,
} from "../src/services/reasoning/providerState.js";

/**
 * One live call through the production composition the router uses: executor admission on the
 * provider scheduler, the circuit consulted before admission for work submitted while it is open
 * and after dequeue otherwise, and every terminal outcome fed back to the provider state. Events
 * are reported as the router reports them: `queued` while the scheduler or an open circuit holds
 * the request, `running` once the provider call starts.
 */
async function executeOn<P extends "claude" | "codex">(
  state: ProviderState,
  provider: P,
  operation: () => unknown,
  onEvent?: (event: ReasoningEvent) => unknown,
): Promise<ProviderResult<unknown, P>> {
  const report = onEvent as ((event: ReasoningEvent) => void) | undefined;
  const executor = createProviderExecutor({
    admission: {
      admit: (request, admitted) =>
        state.admit(provider, request, admitted, report),
    },
  });
  const submittedWhileOpen = state.circuitOpen(provider);
  const check = (requestId: string, queuedAtMs: number) =>
    state.checkCircuit(provider, {
      requestId, queuedAtMs, submittedWhileOpen, family: "scoring",
      onHeld: () => report?.({ state: "queued", provider, queuePosition: 0 }),
    });
  const envelope = await executor.execute<unknown, P>({
    provider,
    family: "scoring",
    operation: "aggregate",
    budgetMs: 60_000,
    jobId: "provider-state-test",
    context: "email",
    observer: (event) => {
      if (event.state === "started") report?.({ state: "running", provider });
    },
    ...(submittedWhileOpen ? { beforeAdmission: check } : { beforeStart: check }),
    onTerminal: (terminal, executionId) => state.recordExecution(provider, terminal, executionId),
    adapter: async () => (await operation()) as ProviderResult<unknown, P>,
  });
  return providerResultFromExecution(envelope)!;
}

function success<T, P extends "claude" | "codex">(
  provider: P,
  value: T
): ProviderResult<T, P> {
  return { ok: true, value, provider };
}

function failure<P extends "claude" | "codex">(
  provider: P,
  kind: "authentication" | "quota" | "invalid-output"
): ProviderResult<never, P> {
  return {
    ok: false,
    failure: { provider, kind, source: "call" },
  };
}

describe("provider queues", () => {
  it("only lets the designated probe close an open provider circuit", async () => {
    let now = 1_000;
    const state = createProviderState({
      now: () => now,
      admission: {
        claude: { initial: 2, floor: 1, ceiling: 4, scoringReserve: 1, cooldownsMs: [100] },
        codex: { initial: 2, floor: 1, ceiling: 4, scoringReserve: 1, cooldownsMs: [100] },
      },
    });
    state.recordPressure("claude", "quota");
    now = 1_101;

    await expect(state.checkCircuit("claude", {
      requestId: "probe",
      queuedAtMs: 999,
      submittedWhileOpen: false,
    })).resolves.toMatchObject({ ok: true });
    state.recordExecution("claude", success("claude", "unrelated"), "unrelated");
    expect(state.circuitOpen("claude")).toBe(true);

    state.recordExecution("claude", success("claude", "recovered"), "probe");
    expect(state.circuitOpen("claude")).toBe(false);
  });

  it("resets a partial clean wave when the circuit opens", () => {
    const state = createProviderState({ capacity: 3 });
    state.recordExecution("claude", success("claude", "one"));
    state.recordExecution("claude", success("claude", "two"));
    expect(state.operationalSnapshot()[0]).toMatchObject({ effectiveCapacity: 3 });
    state.recordPressure("claude", "quota");
    // A call already in flight finishes after the circuit opened; it starts a new wave.
    state.recordExecution("claude", success("claude", "in-flight"));
    expect(state.operationalSnapshot()[0]).toMatchObject({ effectiveCapacity: 3 });
  });

  it("never lets a successful preflight close an open circuit; only a probe does", async () => {
    let now = 0;
    const state = createProviderState({ now: () => now });
    state.recordPreflight("claude", { ok: false, kind: "authentication" });
    state.recordPreflight("claude", { ok: true });
    expect(state.circuitOpen("claude")).toBe(true);

    now = CIRCUIT_MS;
    await state.checkCircuit("claude", { requestId: "probe", queuedAtMs: now, submittedWhileOpen: true });
    state.recordExecution("claude", success("claude", "recovered"), "probe");
    expect(state.circuitOpen("claude")).toBe(false);
  });

  it("does not count a pressure-bearing successful execution toward clean growth", async () => {
    const state = createProviderState({ capacity: 2 });
    await state.checkCircuit("claude", {
      requestId: "pressure-success",
      queuedAtMs: 0,
      submittedWhileOpen: false,
      family: "generation",
    });
    state.recordPressure("claude", "pressure");
    state.recordExecution("claude", success("claude", "tainted"), "pressure-success");
    state.recordExecution("claude", success("claude", "clean-one"));
    expect(state.operationalSnapshot()[0]).toMatchObject({ effectiveCapacity: 2 });
  });

  it("records a failed probe before reopening so cooldown escalates", async () => {
    let now = 0;
    const state = createProviderState({
      now: () => now,
      admission: {
        claude: { initial: 2, floor: 1, ceiling: 4, scoringReserve: 1, cooldownsMs: [10, 20] },
        codex: { initial: 2, floor: 1, ceiling: 4, scoringReserve: 1, cooldownsMs: [10, 20] },
      },
    });
    state.recordPressure("claude", "quota");
    now = 10;
    await state.checkCircuit("claude", {
      requestId: "failed-probe", queuedAtMs: -1, submittedWhileOpen: false, family: "scoring",
    });
    state.recordExecution("claude", failure("claude", "quota"), "failed-probe");
    expect(state.snapshot()[0]).toMatchObject({
      availability: "circuit-open",
      failureKind: "quota",
      retryAtMs: 30,
    });
  });

  it("restores and clears trustworthy hard-quota reset persistence", () => {
    const persisted = new Map<string, { failureKind: "quota"; resetAtMs: number }>([
      ["claude", { failureKind: "quota", resetAtMs: 50_000 }],
    ]);
    const state = createProviderState({
      now: () => 1_000,
      persistence: {
        load: (provider) => persisted.get(provider),
        save: (provider, value) => persisted.set(provider, value),
        clear: (provider) => { persisted.delete(provider); },
      },
    });

    expect(state.circuitOpen("claude")).toBe(true);
    const startupToken = state.captureActivityToken("claude");
    state.recordPreflight("claude", { ok: true }, startupToken);
    expect(persisted.has("claude")).toBe(true);
    state.recordPressure("claude", "quota", 90_000);
    expect(persisted.get("claude")).toEqual({ failureKind: "quota", resetAtMs: 90_000 });
    state.recordExecution("claude", failure("claude", "quota"));
    expect(persisted.get("claude")).toEqual({ failureKind: "quota", resetAtMs: 90_000 });
  });

  it("retains persisted quota state when configured during its five-second safety margin", () => {
    const persisted = new Map<string, { failureKind: "quota"; resetAtMs: number }>([
      ["claude", { failureKind: "quota", resetAtMs: 50_000 }],
    ]);
    const state = createProviderState({ now: () => 52_000 });

    state.configurePersistence({
      load: (provider) => persisted.get(provider),
      save: (provider, value) => persisted.set(provider, value),
      clear: (provider) => { persisted.delete(provider); },
    });

    expect(state.circuitOpen("claude")).toBe(true);
    expect(persisted.get("claude")).toEqual({ failureKind: "quota", resetAtMs: 50_000 });
  });

  it("serializes calls to one provider while Claude and Codex can overlap", async () => {
    const state = createProviderState({ now: () => 1_000 });
    const claudeGate = deferred<void>();
    const started: string[] = [];

    const firstClaude = executeOn(state, "claude", async () => {
      started.push("claude-1");
      await claudeGate.promise;
      return success("claude", "first");
    });
    const secondClaude = executeOn(state, "claude", async () => {
      started.push("claude-2");
      return success("claude", "second");
    });
    const codex = executeOn(state, "codex", async () => {
      started.push("codex");
      return success("codex", "parallel");
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["claude-1", "codex"]);

    claudeGate.resolve();
    await expect(Promise.all([firstClaude, secondClaude, codex])).resolves.toEqual([
      success("claude", "first"),
      success("claude", "second"),
      success("codex", "parallel"),
    ]);
    expect(started).toEqual(["claude-1", "codex", "claude-2"]);
  });

  it("reports queued synchronously, then lets pre-open queued work probe after cooldown", async () => {
    const clock = useFakeTimersInTest();
    let now = 1_000;
    const state = createProviderState({ now: () => now });
    const firstGate = deferred<void>();
    const firstStarted = deferred<void>();
    const secondEvents: ReasoningEvent[] = [];
    let secondExecuted = false;

    const first = executeOn(state, "claude", async () => {
      firstStarted.resolve();
      await firstGate.promise;
      return failure("claude", "quota");
    });
    const second = executeOn(
      state,
      "claude",
      async () => {
        secondExecuted = true;
        return success("claude", "should not run");
      },
      (event) => secondEvents.push(event)
    );

    expect(secondEvents).toEqual([
      { state: "queued", provider: "claude", queuePosition: 0 },
    ]);

    await firstStarted.promise;
    firstGate.resolve();
    await expect(first).resolves.toEqual(failure("claude", "quota"));
    now += CIRCUIT_MS;
    await clock.advanceBy(CIRCUIT_MS);
    await expect(second).resolves.toEqual(success("claude", "should not run"));
    expect(secondExecuted).toBe(true);
    // Queued behind the first call, then held by the circuit the first call opened (still waiting,
    // so still `queued`), and `running` only once the probe's call starts.
    expect(secondEvents).toEqual([
      { state: "queued", provider: "claude", queuePosition: 0 },
      { state: "queued", provider: "claude", queuePosition: 0 },
      { state: "running", provider: "claude" },
    ]);
  });

  it("preserves FIFO when a synchronous queued observer re-enters the same provider queue", async () => {
    const state = createProviderState({ now: () => 1_000 });
    const firstGate = deferred<void>();
    const order: string[] = [];
    let third: Promise<ProviderResult<unknown, "claude">> | undefined;

    const first = executeOn(state, "claude", async () => {
      order.push("first");
      await firstGate.promise;
      return success("claude", "first");
    });
    const second = executeOn(
      state,
      "claude",
      async () => {
        order.push("second");
        return success("claude", "second");
      },
      (event) => {
        if (event.state !== "queued") return;
        third = executeOn(state, "claude", async () => {
          order.push("third");
          return success("claude", "third");
        });
      }
    );

    expect(third).toBeDefined();
    firstGate.resolve();
    await Promise.all([first, second, third!]);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("keeps provider queues and circuits isolated", async () => {
    const state = createProviderState({ now: () => 1_000 });
    await executeOn(state, "claude", async () => failure("claude", "authentication"));
    let codexExecuted = false;

    const result = await executeOn(state, "codex", async () => {
      codexExecuted = true;
      return success("codex", "ok");
    });

    expect(codexExecuted).toBe(true);
    expect(result).toEqual(success("codex", "ok"));
    expect(state.snapshot()).toEqual([
      {
        provider: "claude",
        availability: "circuit-open",
        failureKind: "authentication",
        retryAtMs: 601_000,
      },
      { provider: "codex", availability: "available" },
    ]);
  });

  it("normalizes thrown operations and leaves the queue usable without leaking the error", async () => {
    const state = createProviderState({ now: () => 1_000 });
    const secret = "stderr prompt token sk-live-secret";
    const thrown = executeOn(state, "claude", async () => {
      throw new Error(secret);
    });
    const next = executeOn(state, "claude", async () => success("claude", "recovered"));

    const thrownResult = await thrown;
    expect(thrownResult).toEqual({
      ok: false,
      failure: { provider: "claude", kind: "application", source: "call" },
    });
    expect(JSON.stringify(thrownResult)).not.toContain(secret);
    await expect(next).resolves.toEqual(success("claude", "recovered"));
    expect(state.snapshot()).toEqual([
      { provider: "claude", availability: "available" },
      { provider: "codex", availability: "checking" },
    ]);
  });

  it("observes rejected async event reporters without awaiting them", async () => {
    const state = createProviderState({ now: () => 1_000 });
    const firstGate = deferred<void>();
    let rejectionHandlerAttached = false;
    const rejectedThenable = {
      then(
        _onFulfilled?: (value: void) => unknown,
        onRejected?: (reason: unknown) => unknown
      ) {
        rejectionHandlerAttached = onRejected !== undefined;
        onRejected?.(new Error("observer stderr sk-live-secret"));
      },
    } as unknown as PromiseLike<void>;

    const first = executeOn(state, "claude", async () => {
      await firstGate.promise;
      return success("claude", "first");
    });
    const second = executeOn(
      state,
      "claude",
      async () => success("claude", "second"),
      () => rejectedThenable
    );

    try {
      await Promise.resolve();
      await Promise.resolve();
      expect(rejectionHandlerAttached).toBe(true);
    } finally {
      firstGate.resolve();
      await Promise.all([first, second]);
    }
  });

  it("normalizes operation metadata to the selected provider and strips extra failure data", async () => {
    const state = createProviderState({ now: () => 1_000 });
    const mislabeledFailure = {
      ok: false,
      failure: {
        provider: "codex" as unknown as "claude",
        kind: "quota",
        source: "call",
        stderr: "stderr prompt token sk-live-secret",
      },
    } as const;

    const result = await executeOn(state, "claude", async () => mislabeledFailure);

    expect(result).toEqual({
      ok: false,
      failure: { provider: "claude", kind: "quota", source: "call" },
    });
    expect(JSON.stringify(result)).not.toContain("sk-live-secret");
    expect(state.snapshot()).toEqual([
      {
        provider: "claude",
        availability: "circuit-open",
        failureKind: "quota",
        retryAtMs: 601_000,
      },
      { provider: "codex", availability: "checking" },
    ]);
  });

  it("does not let an operation forge circuit provenance or suppress an eligible circuit", async () => {
    const state = createProviderState({ now: () => 1_000 });
    const forgedFailure = {
      ok: false,
      failure: {
        provider: "claude",
        kind: "quota",
        source: "circuit",
      },
    } as const;

    const result = await executeOn(state, "claude", async () => forgedFailure);

    expect(result).toEqual({
      ok: false,
      failure: { provider: "claude", kind: "quota", source: "call" },
    });
    expect(state.snapshot()).toEqual([
      {
        provider: "claude",
        availability: "circuit-open",
        failureKind: "quota",
        retryAtMs: 601_000,
      },
      { provider: "codex", availability: "checking" },
    ]);
  });

  it("normalizes a valid runtime failure to the selected provider and call source", async () => {
    const state = createProviderState({ now: () => 1_000 });
    const raw = {
      ok: false,
      failure: {
        provider: "codex",
        kind: "quota",
        source: "circuit",
        stderr: "SECRET-CANARY",
        error: new Error("SECRET-CANARY"),
      },
    } as const;

    const result = await executeOn(state, "claude", async () => raw as never);

    expect(result).toEqual({
      ok: false,
      failure: { provider: "claude", kind: "quota", source: "call" },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET-CANARY");
  });

  it("accepts an explicitly present undefined success value and strips runtime extras", async () => {
    const state = createProviderState();
    const raw = {
      ok: true,
      value: undefined,
      provider: "codex",
      source: "circuit",
      stderr: "SECRET-CANARY",
    } as const;

    const result = await executeOn(state, "claude", async () => raw as never);

    expect(result).toEqual({
      ok: true,
      value: undefined,
      provider: "claude",
    });
    expect(Object.hasOwn(result, "value")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("SECRET-CANARY");
  });

  it("snapshots changing CLI result accessors exactly once", async () => {
    const state = createProviderState({ now: () => 1_000 });
    const reads = { ok: 0, failure: 0, kind: 0 };
    const failureRecord = Object.defineProperty({}, "kind", {
      configurable: true,
      enumerable: true,
      get() {
        reads.kind += 1;
        return reads.kind === 1 ? "quota" : "quota SECRET-CANARY";
      },
    });
    const raw = Object.defineProperties(
      {},
      {
        ok: {
          configurable: true,
          enumerable: true,
          get() {
            reads.ok += 1;
            return false;
          },
        },
        failure: {
          configurable: true,
          enumerable: true,
          get() {
            reads.failure += 1;
            return failureRecord;
          },
        },
      }
    );

    const result = await executeOn(state, "claude", async () => raw as never);

    expect(result).toEqual({
      ok: false,
      failure: { provider: "claude", kind: "quota", source: "call" },
    });
    expect(reads).toEqual({ ok: 1, failure: 1, kind: 1 });
    expect(JSON.stringify(result)).not.toContain("SECRET-CANARY");
    expect(state.snapshot()).toEqual([
      {
        provider: "claude",
        availability: "circuit-open",
        failureKind: "quota",
        retryAtMs: 601_000,
      },
      { provider: "codex", availability: "checking" },
    ]);
  });

  it("normalizes a throwing CLI result accessor without leaking or opening a circuit", async () => {
    const state = createProviderState({ now: () => 1_000 });
    let kindReads = 0;
    const failureRecord = Object.defineProperty({}, "kind", {
      configurable: true,
      enumerable: true,
      get() {
        kindReads += 1;
        throw new Error("SECRET-CANARY");
      },
    });

    const result = await executeOn(state, "claude", async () => ({
      ok: false,
      failure: failureRecord,
      error: "SECRET-CANARY",
    }) as never);

    expect(result).toEqual({
      ok: false,
      failure: { provider: "claude", kind: "application", source: "call" },
    });
    expect(kindReads).toBe(1);
    expect(JSON.stringify(result)).not.toContain("SECRET-CANARY");
    expect(state.snapshot()).toEqual([
      { provider: "claude", availability: "checking" },
      { provider: "codex", availability: "checking" },
    ]);
  });

  it("snapshots a changing explicit success value exactly once", async () => {
    const state = createProviderState();
    const reads = { ok: 0, value: 0 };
    const raw = Object.defineProperties(
      {},
      {
        ok: {
          configurable: true,
          enumerable: true,
          get() {
            reads.ok += 1;
            return true;
          },
        },
        value: {
          configurable: true,
          enumerable: true,
          get() {
            reads.value += 1;
            return reads.value === 1 ? "safe" : "SECRET-CANARY";
          },
        },
      }
    );

    const result = await executeOn(state, "codex", async () => raw as never);

    expect(result).toEqual({
      ok: true,
      value: "safe",
      provider: "codex",
    });
    expect(reads).toEqual({ ok: 1, value: 1 });
    expect(JSON.stringify(result)).not.toContain("SECRET-CANARY");
  });
});

describe("provider availability circuits", () => {
  it("starts every provider in checking until provider-scoped evidence arrives", () => {
    const state = createProviderState({ now: () => 1_000 });

    expect(state.snapshot()).toEqual([
      { provider: "claude", availability: "checking" },
      { provider: "codex", availability: "checking" },
    ]);

    state.recordPreflight("claude", { ok: true });
    expect(state.snapshot()).toEqual([
      { provider: "claude", availability: "available" },
      { provider: "codex", availability: "checking" },
    ]);
  });

  it("uses newer live outcomes to establish availability while the other provider remains checking", async () => {
    const state = createProviderState({ now: () => 1_000 });

    await expect(
      executeOn(state, "codex", async () => success("codex", "ready")),
    ).resolves.toEqual(success("codex", "ready"));

    expect(state.snapshot()).toEqual([
      { provider: "claude", availability: "checking" },
      { provider: "codex", availability: "available" },
    ]);
  });

  it.each([
    ["truthy discriminant", { ok: "true", error: "SECRET-CANARY" }],
    [
      "unknown kind",
      { ok: false, kind: "quota SECRET-CANARY", error: "SECRET-CANARY" },
    ],
    ["missing kind", { ok: false, error: "SECRET-CANARY" }],
    ["raw string", "SECRET-CANARY"],
    ["Error", new Error("SECRET-CANARY")],
  ])("normalizes a malformed %s preflight without opening a circuit", (_case, raw) => {
    const state = createProviderState({ now: () => 1_000 });

    const result = state.recordPreflight("codex", raw as never);

    expect(result).toEqual({
      ok: false,
      failure: { provider: "codex", kind: "application", source: "preflight" },
    });
    expect(JSON.stringify(result)).not.toContain("SECRET-CANARY");
    expect(state.snapshot()).toEqual([
      { provider: "claude", availability: "checking" },
      { provider: "codex", availability: "checking" },
    ]);
  });

  it("snapshots changing preflight accessors once and opens only the captured circuit", () => {
    const state = createProviderState({ now: () => 1_000 });
    const reads = { ok: 0, kind: 0 };
    const raw = Object.defineProperties(
      {},
      {
        ok: {
          configurable: true,
          enumerable: true,
          get() {
            reads.ok += 1;
            return false;
          },
        },
        kind: {
          configurable: true,
          enumerable: true,
          get() {
            reads.kind += 1;
            return reads.kind === 1 ? "quota" : "quota SECRET-CANARY";
          },
        },
      }
    );

    const result = state.recordPreflight("codex", raw as never);

    expect(result).toEqual({
      ok: false,
      failure: { provider: "codex", kind: "quota", source: "preflight" },
    });
    expect(reads).toEqual({ ok: 1, kind: 1 });
    expect(JSON.stringify(result)).not.toContain("SECRET-CANARY");
    expect(state.snapshot()).toEqual([
      { provider: "claude", availability: "checking" },
      {
        provider: "codex",
        availability: "circuit-open",
        failureKind: "quota",
        retryAtMs: 601_000,
      },
    ]);
  });

  it("normalizes a throwing preflight accessor without leaking or opening a circuit", () => {
    const state = createProviderState({ now: () => 1_000 });
    let kindReads = 0;
    const raw = Object.defineProperties(
      {},
      {
        ok: {
          configurable: true,
          enumerable: true,
          value: false,
        },
        kind: {
          configurable: true,
          enumerable: true,
          get() {
            kindReads += 1;
            throw new Error("SECRET-CANARY");
          },
        },
      }
    );

    const result = state.recordPreflight("codex", raw as never);

    expect(result).toEqual({
      ok: false,
      failure: { provider: "codex", kind: "application", source: "preflight" },
    });
    expect(kindReads).toBe(1);
    expect(JSON.stringify(result)).not.toContain("SECRET-CANARY");
    expect(state.snapshot()).toEqual([
      { provider: "claude", availability: "checking" },
      { provider: "codex", availability: "checking" },
    ]);
  });

  it("opens for ten minutes, then lets the next request probe and close it", async () => {
    let now = 1_000;
    const state = createProviderState({ now: () => now });
    expect(CIRCUIT_MS).toBe(10 * 60 * 1_000);

    await expect(
      executeOn(state, "claude", async () => failure("claude", "quota"))
    ).resolves.toEqual(failure("claude", "quota"));
    expect(state.snapshot()).toEqual([
      {
        provider: "claude",
        availability: "circuit-open",
        failureKind: "quota",
        retryAtMs: 601_000,
      },
      { provider: "codex", availability: "checking" },
    ]);

    now = 600_999;
    let beforeExpiryExecuted = false;
    await expect(
      executeOn(state, "claude", async () => {
        beforeExpiryExecuted = true;
        return success("claude", "too soon");
      })
    ).resolves.toEqual({
      ok: false,
      failure: { provider: "claude", kind: "quota", source: "circuit" },
    });
    expect(beforeExpiryExecuted).toBe(false);

    now = 601_001;
    let probeExecuted = false;
    await expect(
      executeOn(state, "claude", async () => {
        probeExecuted = true;
        return success("claude", "available");
      })
    ).resolves.toEqual(success("claude", "available"));
    expect(probeExecuted).toBe(true);
    expect(state.snapshot()).toEqual([
      { provider: "claude", availability: "available" },
      { provider: "codex", availability: "checking" },
    ]);
  });

  it("does not open the circuit for invalid output", async () => {
    const state = createProviderState({ now: () => 1_000 });

    await expect(
      executeOn(state, "codex", async () => failure("codex", "invalid-output"))
    ).resolves.toEqual(failure("codex", "invalid-output"));

    let nextExecuted = false;
    await expect(
      executeOn(state, "codex", async () => {
        nextExecuted = true;
        return success("codex", "retried");
      })
    ).resolves.toEqual(success("codex", "retried"));
    expect(nextExecuted).toBe(true);
    expect(state.snapshot()).toEqual([
      { provider: "claude", availability: "checking" },
      { provider: "codex", availability: "available" },
    ]);
  });

  it.each([
    "missing-cli",
    "authentication",
    "quota",
    "rate-limit",
    "provider",
  ] as const)("opens the shared circuit for an eligible %s preflight failure", (kind) => {
    const state = createProviderState({ now: () => 1_000 });

    expect(
      state.recordPreflight("claude", { ok: false, kind })
    ).toEqual({
      ok: false,
      failure: { provider: "claude", kind, source: "preflight" },
    });
    expect(state.snapshot()).toEqual([
      {
        provider: "claude",
        availability: "circuit-open",
        failureKind: kind,
        retryAtMs: 601_000,
      },
      { provider: "codex", availability: "checking" },
    ]);
  });

  it.each([
    "invalid-output",
    "configuration",
    "application",
    // A check that did not answer in time is no evidence either way; the next real call decides.
    "timeout",
  ] as const)("does not open the circuit for a %s preflight failure", (kind) => {
    const state = createProviderState({ now: () => 1_000 });

    expect(
      state.recordPreflight("codex", { ok: false, kind })
    ).toEqual({
      ok: false,
      failure: { provider: "codex", kind, source: "preflight" },
    });
    expect(state.snapshot()).toEqual([
      { provider: "claude", availability: "checking" },
      { provider: "codex", availability: "checking" },
    ]);
  });

  it("records startup capability without letting successful preflight close a live circuit", () => {
    const state = createProviderState({ now: () => 1_000 });
    state.recordPreflight("codex", { ok: false, kind: "authentication" });
    const startupToken = state.captureActivityToken("codex");

    expect(state.recordPreflight("codex", { ok: true }, startupToken)).toEqual({
      ok: true,
      value: undefined,
      provider: "codex",
    });
    expect(state.snapshot()).toEqual([
      { provider: "claude", availability: "checking" },
      {
        provider: "codex",
        availability: "circuit-open",
        failureKind: "authentication",
        retryAtMs: 601_000,
      },
    ]);
  });
});

/** A valid production-shaped profile (`1 <= reserve < floor <= initial <= ceiling`, see config.ts). */
function admissionPolicy(cooldownsMs: readonly number[]) {
  const provider = {
    initial: 4,
    floor: 2,
    ceiling: 4,
    scoringReserve: 1,
    cooldownsMs,
  } as const;
  return { claude: provider, codex: provider };
}

describe("circuit rejections are not provider evidence", () => {
  it("does not re-open the circuit or push the retry deadline out", async () => {
    let now = 0;
    const state = createProviderState({ now: () => now, admission: admissionPolicy([1_000]) });
    state.recordPressure("claude", "quota");
    expect(state.snapshot()[0]).toMatchObject({ availability: "circuit-open", retryAtMs: 1_000 });

    now = 500;
    const rejected = await state.checkCircuit("claude", {
      requestId: "walk-in",
      queuedAtMs: 500,
      submittedWhileOpen: true,
      family: "generation",
    });

    expect(rejected).toEqual({
      ok: false,
      failure: { provider: "claude", kind: "quota", source: "circuit" },
    });
    state.recordExecution("claude", rejected, "walk-in");
    expect(state.snapshot()[0]).toMatchObject({ retryAtMs: 1_000 });
  });

  it("does not let rejected traffic contract adaptive capacity or bank pressure strikes", async () => {
    let now = 0;
    const state = createProviderState({ now: () => now, admission: admissionPolicy([1_000]) });
    state.recordPreflight("claude", { ok: false, kind: "rate-limit" });
    expect(state.operationalSnapshot()[0]).toMatchObject({
      effectiveCapacity: 4,
      pressureStrikes: 0,
      retryAtMs: 1_000,
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      now += 100;
      const rejected = await state.checkCircuit("claude", {
        requestId: `walk-in-${attempt}`,
        queuedAtMs: now,
        submittedWhileOpen: true,
        family: "generation",
      });
      expect(rejected).toMatchObject({ ok: false, failure: { source: "circuit" } });
      state.recordExecution("claude", rejected, `walk-in-${attempt}`);
    }

    expect(state.operationalSnapshot()[0]).toMatchObject({
      circuitState: "open",
      effectiveCapacity: 4,
      pressureStrikes: 0,
      retryAtMs: 1_000,
    });
  });

  it("admits the queued probe on the configured cooldown under continuous rejected traffic", async () => {
    const clock = useFakeTimersInTest();
      let now = 0;
      const state = createProviderState({ now: () => now, admission: admissionPolicy([1_000]) });
      state.recordPressure("claude", "quota");

      let held: ProviderResult<void, "claude"> | undefined;
      void state
        .checkCircuit("claude", {
          requestId: "queued-before-open",
          queuedAtMs: -1,
          submittedWhileOpen: false,
          family: "generation",
        })
        .then((result) => {
          held = result;
        });

      for (let tick = 100; tick <= 900; tick += 100) {
        now = tick;
      await clock.advanceBy(100);
        const rejected = await state.checkCircuit("claude", {
          requestId: `child-${tick}`,
          queuedAtMs: tick,
          submittedWhileOpen: true,
          family: "generation",
        });
        expect(rejected).toMatchObject({ ok: false, failure: { source: "circuit" } });
        state.recordExecution("claude", rejected, `child-${tick}`);
      }
      expect(held).toBeUndefined();

      now = 1_000;
    await clock.advanceBy(100);

      expect(held).toEqual({ ok: true, provider: "claude", value: undefined });
      expect(state.operationalSnapshot()[0]).toMatchObject({
        circuitState: "probing",
        probeOwner: "queued-before-open",
      });
  });

  it("leaves probe ownership intact when a rejection lands mid-probe", async () => {
    const clock = useFakeTimersInTest();
      let now = 0;
      const state = createProviderState({ now: () => now, admission: admissionPolicy([1_000]) });
      state.recordPressure("claude", "quota");

      let probe: ProviderResult<void, "claude"> | undefined;
      void state
        .checkCircuit("claude", {
          requestId: "probe",
          queuedAtMs: -1,
          submittedWhileOpen: false,
          family: "scoring",
        })
        .then((result) => {
          probe = result;
        });

      now = 1_000;
    await clock.advanceBy(1_000);
      expect(probe).toMatchObject({ ok: true });

      now = 1_100;
      const rejected = await state.checkCircuit("claude", {
        requestId: "walk-in",
        queuedAtMs: 1_100,
        submittedWhileOpen: true,
        family: "generation",
      });
      state.recordExecution("claude", rejected, "walk-in");
      expect(state.operationalSnapshot()[0]).toMatchObject({
        circuitState: "probing",
        probeOwner: "probe",
      });

      state.recordExecution("claude", success("claude", "recovered"), "probe");
      expect(state.circuitOpen("claude")).toBe(false);
      expect(state.operationalSnapshot()[0]).toMatchObject({
        circuitState: "closed",
        effectiveCapacity: 2,
      });
  });

  it("recovers through the executor while a batch of generation children is rejected", async () => {
    const clock = useFakeTimersInTest();
      let now = 0;
      const state = createProviderState({ now: () => now, admission: admissionPolicy([1_000]) });
      const executor = createProviderExecutor({
        now: () => now,
        admission: {
          admit: (request, operation) => state.admit("claude", request, operation),
        },
      });
      const adapter = vi.fn(() => ({ ok: true as const, provider: "claude" as const, value: "ran" }));
      // The wiring the router's runCli uses: beforeAdmission for work that arrives while the circuit
      // is already open, beforeStart for work that was queued before it opened.
      const call = (jobId: string, submittedWhileOpen: boolean) =>
        executor.execute({
          provider: "claude" as const,
          family: "generation" as const,
          operation: "generate",
          budgetMs: 60_000,
          jobId,
          context: "listening",
          ...(submittedWhileOpen
            ? {
                beforeAdmission: (executionId: string, queuedAtMs: number) =>
                  state.checkCircuit("claude", {
                    requestId: executionId,
                    queuedAtMs,
                    submittedWhileOpen: true,
                    family: "generation" as const,
                  }),
              }
            : {
                beforeStart: (executionId: string, queuedAtMs: number) =>
                  state.checkCircuit("claude", {
                    requestId: executionId,
                    queuedAtMs,
                    submittedWhileOpen: false,
                    family: "generation" as const,
                  }),
              }),
          onTerminal: (terminal, executionId) =>
            state.recordExecution("claude", terminal, executionId),
          adapter,
        });

      state.recordPressure("claude", "quota");
      for (let child = 0; child < 8; child += 1) {
        now += 100;
        await expect(call(`child-${child}`, true)).resolves.toMatchObject({
          status: "failure",
          failure: { provider: "claude", kind: "quota", source: "circuit" },
        });
      }
      expect(adapter).not.toHaveBeenCalled();
      expect(state.snapshot()[0]).toMatchObject({ retryAtMs: 1_000 });

      now = 1_000;
      await expect(call("recovery", false)).resolves.toMatchObject({ status: "success" });
      expect(adapter).toHaveBeenCalledOnce();
      expect(state.operationalSnapshot()[0]).toMatchObject({
        circuitState: "closed",
        availability: "available",
        effectiveCapacity: 2,
      });
  });

  it("still escalates the cooldown on a genuine repeat provider failure under rejected traffic", async () => {
    const clock = useFakeTimersInTest();
      let now = 0;
      const state = createProviderState({
        now: () => now,
        admission: admissionPolicy([1_000, 2_000]),
      });
      state.recordPressure("claude", "quota");

      let probe: ProviderResult<void, "claude"> | undefined;
      void state
        .checkCircuit("claude", {
          requestId: "probe",
          queuedAtMs: -1,
          submittedWhileOpen: false,
          family: "scoring",
        })
        .then((result) => {
          probe = result;
        });

      now = 1_000;
    await clock.advanceBy(1_000);
      expect(probe).toMatchObject({ ok: true });

      now = 1_200;
      const rejected = await state.checkCircuit("claude", {
        requestId: "walk-in",
        queuedAtMs: 1_200,
        submittedWhileOpen: true,
        family: "generation",
      });
      state.recordExecution("claude", rejected, "walk-in");

      now = 1_500;
      state.recordExecution("claude", failure("claude", "quota"), "probe");

      expect(state.snapshot()[0]).toMatchObject({
        availability: "circuit-open",
        failureKind: "quota",
        retryAtMs: 3_500,
      });
  });
});

describe("held requests wait on the circuit, not on a spin", () => {
  it("wakes a bounded number of times and holds one abort listener across a long probe", async () => {
    const clock = useFakeTimersInTest();
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      let now = 0;
      const state = createProviderState({ now: () => now, admission: admissionPolicy([1_000]) });
      state.recordPressure("claude", "quota");
      const controller = new AbortController();

      void state.checkCircuit("claude", {
        requestId: "probe",
        queuedAtMs: 0,
        submittedWhileOpen: false,
        family: "scoring",
      });
      let heldResult: ProviderResult<void, "claude"> | undefined;
      void state
        .checkCircuit("claude", {
          requestId: "held",
          queuedAtMs: 1,
          submittedWhileOpen: false,
          family: "generation",
          signal: controller.signal,
        })
        .then((result) => {
          heldResult = result;
        });

      now = 1_000;
      await clock.advanceBy(1_000);
      expect(state.operationalSnapshot()[0]).toMatchObject({
        circuitState: "probing",
        probeOwner: "probe",
      });

      const probeMs = 20 * PROBE_RECHECK_MS;
      timers.mockClear();
      let peakListeners = 0;
      for (let elapsed = 0; elapsed < probeMs; elapsed += 1_000) {
        now += 1_000;
        await clock.advanceBy(1_000);
        peakListeners = Math.max(
          peakListeners,
          getEventListeners(controller.signal, "abort").length,
        );
      }

      expect(heldResult).toBeUndefined();
      expect(timers.mock.calls.length).toBeLessThanOrEqual(probeMs / PROBE_RECHECK_MS + 2);
      expect(peakListeners).toBeLessThanOrEqual(1);
    } finally {
      timers.mockRestore();
    }
  });

  it("wakes a held request promptly on abort and leaves no listener behind", async () => {
    const clock = useFakeTimersInTest();
      let now = 0;
      const state = createProviderState({ now: () => now, admission: admissionPolicy([600_000]) });
      state.recordPressure("claude", "quota");
      const controller = new AbortController();

      let heldResult: ProviderResult<void, "claude"> | undefined;
      void state
        .checkCircuit("claude", {
          requestId: "held",
          queuedAtMs: 0,
          submittedWhileOpen: false,
          family: "generation",
          signal: controller.signal,
        })
        .then((result) => {
          heldResult = result;
        });
    await clock.advanceBy(0);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);

      controller.abort("user");
    await clock.advanceBy(0);

      expect(heldResult).toEqual({
        ok: false,
        failure: { provider: "claude", kind: "application", source: "circuit" },
      });
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(state.operationalSnapshot()[0]?.oldestHeldAgeMs).toBeUndefined();
  });

  it("still rejects a request held behind another's probe once the hold ceiling passes", async () => {
    const clock = useFakeTimersInTest();
      let now = 0;
      const state = createProviderState({ now: () => now, admission: admissionPolicy([1_000]) });
      state.recordPressure("claude", "quota");

      let probe: ProviderResult<void, "claude"> | undefined;
      void state
        .checkCircuit("claude", {
          requestId: "probe",
          queuedAtMs: -2,
          submittedWhileOpen: false,
          family: "scoring",
        })
        .then((result) => {
          probe = result;
        });
      let heldResult: ProviderResult<void, "claude"> | undefined;
      void state
        .checkCircuit("claude", {
          requestId: "held",
          queuedAtMs: -1,
          submittedWhileOpen: false,
          family: "generation",
        })
        .then((result) => {
          heldResult = result;
        });

      now = 1_000;
    await clock.advanceBy(1_000);
      expect(probe).toMatchObject({ ok: true });
      expect(heldResult).toBeUndefined();

      now = 600_001;
    await clock.advanceBy(599_001);

      expect(heldResult).toEqual({
        ok: false,
        failure: { provider: "claude", kind: "quota", source: "circuit" },
      });
  });
});

describe("normalized reasoning contracts", () => {
  it("builds a sanitized route error from normalized attempts only", () => {
    const rawAttempts = [
      {
        provider: "claude",
        kind: "authentication",
        stderr: "stderr secret",
        prompt: "private prompt",
        token: "token secret",
        credential: "sk-live-secret",
      },
      {
        provider: "codex",
        kind: "quota",
        stderr: "more stderr",
        prompt: "more prompt",
      },
    ] as const;

    const error = new ReasoningRouteError(rawAttempts);

    expect(error.message).toBe(
      "Structured reasoning unavailable: Claude (authentication) → Codex (quota)."
    );
    expect(error.attempts).toEqual([
      { provider: "claude", kind: "authentication" },
      { provider: "codex", kind: "quota" },
    ]);
    expect(JSON.stringify(error)).not.toMatch(
      /stderr|prompt|token|sk-live-secret|private/
    );
  });

  it("defines provider labels and routing/circuit eligibility from normalized kinds", () => {
    expect(PROVIDER_LABELS).toEqual({
      claude: "Claude",
      codex: "Codex",
      "openai-http": "OpenAI HTTP",
    });

    expect(fallbackEligible("configuration")).toBe(false);
    expect(fallbackEligible("application")).toBe(false);
    expect(fallbackEligible("invalid-output")).toBe(true);
    expect(fallbackEligible("quota")).toBe(true);

    expect(opensCircuit("configuration")).toBe(false);
    expect(opensCircuit("application")).toBe(false);
    expect(opensCircuit("invalid-output")).toBe(false);
    expect(opensCircuit("authentication")).toBe(true);
    expect(opensCircuit("quota")).toBe(true);
  });
});
