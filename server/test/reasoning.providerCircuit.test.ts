import { describe, expect, it } from "vitest";
import {
  PROBE_RECHECK_MS,
  ProviderCircuit,
} from "../src/services/reasoning/providerCircuit.js";

describe("ProviderCircuit", () => {
  it("opens immediate failures and rejects new work while allowing old work to be held", () => {
    let now = 1_000;
    const circuit = new ProviderCircuit({ now: () => now, cooldownsMs: [60_000] });
    circuit.open("authentication");

    expect(circuit.admit({ queuedAtMs: now - 100, wasQueuedWhenOpened: false })).toEqual({
      kind: "reject", failureKind: "authentication", retryAtMs: 61_000,
    });
    expect(circuit.admit({ queuedAtMs: now - 100, wasQueuedWhenOpened: true })).toEqual({ kind: "hold" });
    now += 10 * 60_000 + 1;
    expect(circuit.admit({ queuedAtMs: 1_000, wasQueuedWhenOpened: true })).toMatchObject({ kind: "reject" });
  });

  it("gives recovery probe ownership to one request and resumes at capacity two on success", () => {
    let now = 1_000;
    const circuit = new ProviderCircuit({ now: () => now, cooldownsMs: [60_000] });
    circuit.open("provider");
    now = 61_000;

    expect(circuit.admit({ requestId: "score", queuedAtMs: 0, wasQueuedWhenOpened: true })).toEqual({ kind: "probe" });
    expect(circuit.admit({ requestId: "other", queuedAtMs: 0, wasQueuedWhenOpened: true })).toEqual({ kind: "hold" });
    expect(circuit.recordProbe("score", "success")).toEqual({ resumed: true, capacity: 2 });
    expect(circuit.snapshot().state).toBe("closed");
  });

  it("hands cancelled probe ownership to the next eligible request", () => {
    let now = 0;
    const circuit = new ProviderCircuit({ now: () => now, cooldownsMs: [1] });
    circuit.open("rate-limit");
    now = 1;
    expect(circuit.admit({ requestId: "first", queuedAtMs: 0, wasQueuedWhenOpened: true }).kind).toBe("probe");
    expect(circuit.recordProbe("first", "cancelled")).toEqual({ resumed: false });
    expect(circuit.admit({ requestId: "second", queuedAtMs: 0, wasQueuedWhenOpened: true }).kind).toBe("probe");
  });

  it("prefers the oldest held scoring request over generation for recovery", () => {
    let now = 0;
    const circuit = new ProviderCircuit({ now: () => now, cooldownsMs: [10] });
    circuit.open("quota");
    expect(circuit.admit({ requestId: "generation", family: "generation", queuedAtMs: 1, wasQueuedWhenOpened: true })).toEqual({ kind: "hold" });
    expect(circuit.admit({ requestId: "score-new", family: "scoring", queuedAtMs: 3, wasQueuedWhenOpened: true })).toEqual({ kind: "hold" });
    expect(circuit.admit({ requestId: "score-old", family: "scoring", queuedAtMs: 2, wasQueuedWhenOpened: true })).toEqual({ kind: "hold" });
    now = 10;
    expect(circuit.admit({ requestId: "generation", family: "generation", queuedAtMs: 1, wasQueuedWhenOpened: true })).toEqual({ kind: "hold" });
    expect(circuit.admit({ requestId: "score-old", family: "scoring", queuedAtMs: 2, wasQueuedWhenOpened: true })).toEqual({ kind: "probe" });
  });

  it("points a held request at the retry deadline while open and at a bounded re-check while probing", () => {
    let now = 0;
    const circuit = new ProviderCircuit({ now: () => now, cooldownsMs: [60_000], holdMaxMs: 600_000 });
    circuit.open("provider");

    expect(circuit.nextEligibleAtMs()).toBe(60_000);

    now = 60_000;
    expect(circuit.admit({ requestId: "owner", queuedAtMs: 0, wasQueuedWhenOpened: true }).kind).toBe("probe");
    expect(circuit.admit({ requestId: "held", queuedAtMs: 1, wasQueuedWhenOpened: true }).kind).toBe("hold");

    // A probing circuit leaves retryAtMs in the past for the whole probe by design, so a held
    // request keyed to it would wake on the caller's 1 ms floor rather than on the circuit.
    expect(circuit.snapshot()).toMatchObject({ state: "probing", retryAtMs: 60_000 });
    expect(circuit.nextEligibleAtMs()).toBe(now + PROBE_RECHECK_MS);
    expect(PROBE_RECHECK_MS).toBeGreaterThanOrEqual(100);
  });

  it("never schedules a held request past the hold ceiling", () => {
    let now = 0;
    const circuit = new ProviderCircuit({ now: () => now, cooldownsMs: [600_000], holdMaxMs: 1_000 });
    circuit.open("provider");

    // The ceiling (openedAtMs + holdMaxMs, exclusive) beats a far-away retry deadline: the held
    // request's next state change is its own rejection, not the probe window.
    expect(circuit.nextEligibleAtMs()).toBe(1_001);
    now = 1_001;
    expect(circuit.admit({ requestId: "held", queuedAtMs: 0, wasQueuedWhenOpened: true })).toMatchObject({ kind: "reject" });
  });

  it("never schedules a wake in the past", () => {
    let now = 0;
    const circuit = new ProviderCircuit({ now: () => now, cooldownsMs: [1_000] });
    circuit.open("provider");
    now = 5_000;

    expect(circuit.nextEligibleAtMs()).toBe(5_000);
    circuit.close();
    expect(circuit.nextEligibleAtMs()).toBe(5_000);
  });

  it("exports only trustworthy hard-quota reset state", () => {
    const circuit = new ProviderCircuit({ now: () => 1_000 });
    circuit.open("quota", 50_000);
    expect(circuit.persistentState()).toEqual({ failureKind: "quota", resetAtMs: 50_000 });
    expect(circuit.snapshot()).toMatchObject({
      state: "open", failureKind: "quota", retryAtMs: 55_000,
    });
    circuit.open("authentication");
    expect(circuit.persistentState()).toBeUndefined();
  });

  it("preserves a trustworthy quota reset when later quota evidence omits reset time", () => {
    let now = 1_000;
    const circuit = new ProviderCircuit({ now: () => now });
    circuit.open("quota", 50_000);
    now = 10_000;
    circuit.open("quota");
    expect(circuit.persistentState()).toEqual({ failureKind: "quota", resetAtMs: 50_000 });
    expect(circuit.snapshot().retryAtMs).toBe(55_000);
  });
});
