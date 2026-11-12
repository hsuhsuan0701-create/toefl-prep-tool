import { describe, expect, it } from "vitest";
import { AdaptiveCapacity } from "../src/services/reasoning/adaptiveCapacity.js";

describe("AdaptiveCapacity", () => {
  it("grows by one after a clean wave equal to current capacity", () => {
    const capacity = new AdaptiveCapacity({ floor: 2, initial: 3, ceiling: 5 });
    expect(capacity.recordTerminal("success")).toEqual({ capacity: 3, openCircuit: false });
    expect(capacity.recordTerminal("invalid-output")).toEqual({ capacity: 3, openCircuit: false });
    expect(capacity.recordTerminal("timeout")).toEqual({ capacity: 3, openCircuit: false });
    expect(capacity.recordTerminal("success")).toEqual({ capacity: 3, openCircuit: false });
    expect(capacity.recordTerminal("cancelled")).toEqual({ capacity: 3, openCircuit: false });
    expect(capacity.recordTerminal("success")).toEqual({ capacity: 3, openCircuit: false });
    expect(capacity.recordTerminal("success")).toEqual({ capacity: 3, openCircuit: false });
    expect(capacity.recordTerminal("success")).toEqual({ capacity: 4, openCircuit: false });
  });

  it("reduces once, halves on a second pressure strike, and opens on a third", () => {
    let now = 1_000;
    const capacity = new AdaptiveCapacity({ floor: 2, initial: 8, ceiling: 8, now: () => now });
    expect(capacity.recordTerminal("pressure")).toEqual({ capacity: 7, openCircuit: false });
    now += 30_000;
    expect(capacity.recordTerminal("pressure")).toEqual({ capacity: 3, openCircuit: false });
    now += 30_000;
    expect(capacity.recordTerminal("pressure")).toEqual({ capacity: 2, openCircuit: true });
  });

  it("does not penalize cancellation, invalid output, or isolated timeout", () => {
    const capacity = new AdaptiveCapacity({ floor: 2, initial: 4, ceiling: 8 });
    capacity.recordTerminal("cancelled");
    capacity.recordTerminal("invalid-output");
    capacity.recordTerminal("timeout");
    expect(capacity.snapshot()).toMatchObject({ capacity: 4, pressureStrikes: 0 });
  });

  it("strikes once per rate-limit window and never opens the circuit for a served call", () => {
    let now = 0;
    const capacity = new AdaptiveCapacity({ floor: 2, initial: 8, ceiling: 8, now: () => now });
    expect(capacity.recordWindowPressure("seven_day@1787821200")).toEqual({ capacity: 7, openCircuit: false });
    expect(capacity.recordWindowPressure("seven_day@1787821200")).toEqual({ capacity: 7, openCircuit: false });
    now += 1_000;
    expect(capacity.recordWindowPressure("five_hour@1786870800")).toEqual({ capacity: 3, openCircuit: false });
    expect(capacity.recordWindowPressure("api_retry@session")).toEqual({ capacity: 2, openCircuit: false });
    expect(capacity.snapshot()).toMatchObject({ pressureStrikes: 3 });
  });
});
