import { describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./helpers/fakeTimers.js";
import type { ProviderResult, ReasoningEvent } from "../src/services/reasoning/contracts.js";
import type { ReasoningRouteLog } from "../src/services/reasoning/router.js";
import { ProviderCircuit } from "../src/services/reasoning/providerCircuit.js";
import { createProviderState } from "../src/services/reasoning/providerState.js";
import { preflightProviders } from "../src/services/reasoning/preflight.js";
import { runSkillTask } from "../src/services/reasoning/router.js";
import type { RunClaudeOptions } from "../src/services/claudeRunner.js";
import { deferred } from "./helpers/deferred.js";

/** The production defaults: cooldowns 1, 2, 5 and 10 minutes; the hold ceiling is also 10 minutes. */
const PRODUCTION_COOLDOWNS_MS = [60_000, 120_000, 300_000, 600_000] as const;

function admission(cooldownsMs: readonly number[]) {
  const provider = { initial: 4, floor: 2, ceiling: 8, scoringReserve: 1, cooldownsMs };
  return { claude: provider, codex: provider };
}

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};

function request() {
  return {
    task: { task: "aggregate" as const, context: "email" as const },
    prompt: "aggregate",
    jsonSchema: schema,
    parse: (value: unknown) => value as { answer: string },
  };
}

function success<P extends "claude" | "codex">(provider: P, answer: string): ProviderResult<{ answer: string }, P> {
  return { ok: true, provider, value: { answer } };
}

function failure<P extends "claude" | "codex">(
  provider: P,
  kind: "authentication" | "quota",
): ProviderResult<never, P> {
  return { ok: false, failure: { provider, kind, source: "call" } };
}

describe("an open circuit recovers through the next request", () => {
  it("recovers from a startup preflight failure with nothing queued", async () => {
    let now = 0;
    const state = createProviderState({ now: () => now, admission: admission(PRODUCTION_COOLDOWNS_MS) });
    await preflightProviders({
      state,
      probeClaude: async () => ({ ok: false, kind: "authentication" }),
      probeCodex: async () => ({ ok: true }),
    });
    expect(state.circuitOpen("claude")).toBe(true);

    const runClaude = vi.fn().mockResolvedValue(success("claude", "from claude"));
    const runCodex = vi.fn().mockResolvedValue(success("codex", "from codex"));
    const deps = { providerState: state, runClaude, runCodex, onLog: () => undefined };

    now = 30_000;
    await expect(runSkillTask(request(), deps)).resolves.toMatchObject({ ok: true, provider: "codex" });
    expect(runClaude).not.toHaveBeenCalled();

    now = 60_000;
    await expect(runSkillTask(request(), deps)).resolves.toMatchObject({
      ok: true,
      provider: "claude",
      value: { answer: "from claude" },
    });
    expect(runClaude).toHaveBeenCalledOnce();
    expect(state.operationalSnapshot()[0]).toMatchObject({
      circuitState: "closed",
      availability: "available",
      effectiveCapacity: 2,
    });
  });

  it("recovers from a single call's authentication failure", async () => {
    let now = 0;
    const state = createProviderState({ now: () => now, admission: admission(PRODUCTION_COOLDOWNS_MS) });
    const runClaude = vi
      .fn()
      .mockResolvedValueOnce(failure("claude", "authentication"))
      .mockResolvedValueOnce(success("claude", "logged back in"));
    const runCodex = vi.fn().mockResolvedValue(success("codex", "fallback"));
    const deps = { providerState: state, runClaude, runCodex, onLog: () => undefined };

    await expect(runSkillTask(request(), deps)).resolves.toMatchObject({ ok: true, provider: "codex" });
    expect(state.snapshot()[0]).toMatchObject({
      availability: "circuit-open",
      failureKind: "authentication",
      retryAtMs: 60_000,
    });

    now = 60_001;
    await expect(runSkillTask(request(), deps)).resolves.toMatchObject({ ok: true, provider: "claude" });
    expect(runClaude).toHaveBeenCalledTimes(2);
    expect(state.circuitOpen("claude")).toBe(false);
  });

  it("lets a request held through the longest cooldown, which equals the hold ceiling, probe", () => {
    let now = 0;
    const circuit = new ProviderCircuit({ now: () => now, cooldownsMs: PRODUCTION_COOLDOWNS_MS });
    circuit.open("provider");
    for (const cooldownMs of PRODUCTION_COOLDOWNS_MS.slice(0, 3)) {
      now += cooldownMs;
      const id = `probe-after-${cooldownMs}`;
      expect(circuit.admit({ requestId: id, queuedAtMs: now, wasQueuedWhenOpened: false }).kind).toBe("probe");
      circuit.recordProbe(id, "failure");
    }

    const openedAtMs = now;
    expect(circuit.snapshot().retryAtMs).toBe(openedAtMs + 600_000);
    expect(circuit.admit({ requestId: "held", queuedAtMs: openedAtMs - 1, wasQueuedWhenOpened: true }))
      .toEqual({ kind: "hold" });
    expect(circuit.nextEligibleAtMs()).toBe(openedAtMs + 600_000);

    // A held request's timer fires a little after the deadline it asked for.
    now = openedAtMs + 600_000 + 4;
    expect(circuit.admit({ requestId: "held", queuedAtMs: openedAtMs - 1, wasQueuedWhenOpened: true }))
      .toEqual({ kind: "probe" });
    expect(circuit.recordProbe("held", "success")).toEqual({ resumed: true, capacity: 2 });
  });

  it("wakes a request held through a ten-minute cooldown as the probe", async () => {
    const clock = useFakeTimersInTest();
    let now = 0;
    const state = createProviderState({ now: () => now, admission: admission([600_000]) });
    state.recordPressure("claude", "quota");

    let held: ProviderResult<void, "claude"> | undefined;
    void state
      .checkCircuit("claude", { requestId: "held", queuedAtMs: -1, submittedWhileOpen: false, family: "scoring" })
      .then((result) => { held = result; });

    now = 600_004;
    await clock.advanceBy(600_000);

    expect(held).toEqual({ ok: true, provider: "claude", value: undefined });
    expect(state.operationalSnapshot()[0]).toMatchObject({ circuitState: "probing", probeOwner: "held" });
  });

  it("never names an aborted holder as the probe owner", async () => {
    const clock = useFakeTimersInTest();
    let now = 0;
    const state = createProviderState({ now: () => now, admission: admission([1_000]) });
    state.recordPressure("claude", "quota");

    const abort = new AbortController();
    const dead = state.checkCircuit("claude", {
      requestId: "dead",
      queuedAtMs: -2,
      submittedWhileOpen: false,
      family: "scoring",
      signal: abort.signal,
    });
    let alive: ProviderResult<void, "claude"> | undefined;
    void state
      .checkCircuit("claude", { requestId: "alive", queuedAtMs: -1, submittedWhileOpen: false, family: "generation" })
      .then((result) => { alive = result; });

    abort.abort();
    await expect(dead).resolves.toMatchObject({ ok: false, failure: { source: "circuit" } });

    now = 1_000;
    await clock.advanceBy(1_000);

    expect(alive).toEqual({ ok: true, provider: "claude", value: undefined });
    expect(state.operationalSnapshot()[0]).toMatchObject({ circuitState: "probing", probeOwner: "alive" });
  });

  it("closes the circuit when the probe's provider answered, even with invalid output", async () => {
    let now = 0;
    const state = createProviderState({ now: () => now, admission: admission([1_000, 2_000]) });
    state.recordPressure("claude", "quota");

    now = 1_000;
    await expect(state.checkCircuit("claude", {
      requestId: "probe", queuedAtMs: 1_000, submittedWhileOpen: true, family: "scoring",
    })).resolves.toMatchObject({ ok: true });
    state.recordExecution(
      "claude",
      { ok: false, failure: { provider: "claude", kind: "invalid-output", source: "call" } },
      "probe",
    );

    expect(state.operationalSnapshot()[0]).toMatchObject({
      circuitState: "closed",
      availability: "available",
      effectiveCapacity: 2,
    });
  });

  it.each(["application", "configuration"] as const)(
    "hands the probe on without escalating the cooldown after a local %s failure",
    async (kind) => {
      let now = 0;
      const state = createProviderState({ now: () => now, admission: admission([1_000, 2_000]) });
      state.recordPressure("claude", "quota");

      now = 1_000;
      await state.checkCircuit("claude", {
        requestId: "probe", queuedAtMs: 1_000, submittedWhileOpen: true, family: "scoring",
      });
      state.recordExecution("claude", { ok: false, failure: { provider: "claude", kind, source: "call" } }, "probe");

      expect(state.snapshot()[0]).toMatchObject({ availability: "circuit-open", retryAtMs: 1_000 });
      await expect(state.checkCircuit("claude", {
        requestId: "next", queuedAtMs: 1_001, submittedWhileOpen: true, family: "generation",
      })).resolves.toMatchObject({ ok: true });
      expect(state.operationalSnapshot()[0]).toMatchObject({ circuitState: "probing", probeOwner: "next" });
    },
  );

  // With room for two calls, B can be admitted before A's failure opens the circuit and still be
  // running when the cooldown ends and C becomes the probe. B's failure is older evidence than the
  // opening; if it reopened the circuit it would clear C's probe ownership, C's success would then
  // be discarded, and the circuit would stay open a further cooldown on the strength of the stale
  // failure.
  it.each([
    ["fails with an opening kind", "failure"],
    ["reports a refused rate-limit window", "refusal"],
  ] as const)("lets the probe's success close the circuit when a request admitted before the opening %s", async (_label, staleEvidence) => {
    let now = 0;
    const state = createProviderState({ now: () => now, admission: admission([1_000]) });
    const releaseB = deferred<void>();
    const releaseC = deferred<void>();
    const bRunning = deferred<void>();
    const cRunning = deferred<void>();
    const runClaude = vi.fn(async (options: RunClaudeOptions<{ answer: string }>) => {
      if (options.prompt === "A") return failure("claude", "authentication");
      if (options.prompt === "B") {
        bRunning.resolve();
        await releaseB.promise;
        if (staleEvidence === "failure") return failure("claude", "authentication");
        // A served call whose stream also carried a refused window: only the pressure report can
        // touch the circuit here.
        options.onPressure?.({ kind: "quota", window: "five_hour@1786870800" });
        return success("claude", "served");
      }
      cRunning.resolve();
      await releaseC.promise;
      return success("claude", "recovered");
    });
    const runCodex = vi.fn().mockResolvedValue(success("codex", "fallback"));
    const deps = { providerState: state, runClaude: runClaude as never, runCodex, onLog: () => undefined };

    const b = runSkillTask({ ...request(), prompt: "B" }, deps);
    await bRunning.promise;
    await expect(runSkillTask({ ...request(), prompt: "A" }, deps)).resolves.toMatchObject({ provider: "codex" });
    expect(state.circuitOpen("claude")).toBe(true);

    now = 1_000;
    const c = runSkillTask({ ...request(), prompt: "C" }, deps);
    await cRunning.promise;
    expect(state.operationalSnapshot()[0]).toMatchObject({ circuitState: "probing" });

    releaseB.resolve();
    await b;
    releaseC.resolve();
    await expect(c).resolves.toMatchObject({ ok: true, provider: "claude", value: { answer: "recovered" } });
    expect(state.operationalSnapshot()[0]).toMatchObject({ circuitState: "closed" });
  });

  // A request queued before the circuit opened is held after dequeue until the cooldown ends. No
  // call is made while it is held, so scoring progress must not say the Arbiter is working, and the
  // route log's provider time must not include the hold.
  it("reports a request held by the circuit as waiting, and starts its provider time when the call starts", async () => {
    const clock = useFakeTimersInTest();
    let now = 0;
    const one = { initial: 1, floor: 1, ceiling: 1, scoringReserve: 0, cooldownsMs: [1_000] };
    const state = createProviderState({ now: () => now, admission: { claude: one, codex: one } });
    const releaseFirst = deferred<void>();
    const firstRunning = deferred<void>();
    const runClaude = vi.fn(async (options: RunClaudeOptions<{ answer: string }>) => {
      if (options.prompt === "first") {
        firstRunning.resolve();
        await releaseFirst.promise;
        return failure("claude", "authentication");
      }
      now += 7;
      return success("claude", "probed");
    });
    const runCodex = vi.fn().mockResolvedValue(success("codex", "fallback"));
    const shared = { providerState: state, runClaude: runClaude as never, runCodex, now: () => now };

    const first = runSkillTask({ ...request(), prompt: "first" }, { ...shared, onLog: () => undefined });
    await firstRunning.promise;
    const events: ReasoningEvent[] = [];
    const logs: ReasoningRouteLog[] = [];
    const held = runSkillTask({ ...request(), prompt: "held", onEvent: (event) => { events.push(event); } }, { ...shared, onLog: (entry) => { logs.push(entry); } });
    expect(events).toEqual([{ state: "queued", provider: "claude", queuePosition: 0 }]);

    releaseFirst.resolve();
    await expect(first).resolves.toMatchObject({ provider: "codex" });
    await clock.advanceBy(10);
    // Dequeued and held by the circuit the first call opened: still waiting, not running.
    expect(state.operationalSnapshot()[0]).toMatchObject({ circuitState: "open" });
    expect(events).toEqual([
      { state: "queued", provider: "claude", queuePosition: 0 },
      { state: "queued", provider: "claude", queuePosition: 0 },
    ]);
    expect(runClaude).toHaveBeenCalledTimes(1);

    now = 1_000;
    await clock.advanceBy(1_000);
    await expect(held).resolves.toMatchObject({ ok: true, provider: "claude" });
    expect(events.at(-1)).toEqual({ state: "running", provider: "claude" });
    expect(logs.at(-1)).toMatchObject({ state: "succeeded", queueDurationMs: 1_000, providerDurationMs: 7 });
  });

  it("gives a held request priority over new work once the cooldown ends", () => {
    let now = 0;
    const circuit = new ProviderCircuit({ now: () => now, cooldownsMs: [1_000] });
    circuit.open("rate-limit");
    expect(circuit.admit({ requestId: "held", family: "scoring", queuedAtMs: -1, wasQueuedWhenOpened: true }).kind)
      .toBe("hold");

    now = 1_000;
    expect(circuit.admit({ requestId: "walk-in", family: "generation", queuedAtMs: 1_000, wasQueuedWhenOpened: false }))
      .toMatchObject({ kind: "reject", failureKind: "rate-limit" });
    expect(circuit.admit({ requestId: "held", family: "scoring", queuedAtMs: -1, wasQueuedWhenOpened: true }))
      .toEqual({ kind: "probe" });
  });
});
