import { describe, expect, it } from "vitest";
import { dayTickIndices } from "../src/lib/trendAxis";

describe("dayTickIndices", () => {
  const at = (iso: string) => ({ ts: new Date(iso).getTime() });

  it("emits one tick per calendar day, at the index of that day's first attempt", () => {
    // A day with several Attempts gets one label, not one per Attempt. On the Attempt-ordered axis
    // the tick lands on the position of the day's first Attempt.
    const ticks = dayTickIndices([
      at("2026-08-16T01:00:00.000Z"),
      at("2026-08-16T02:00:00.000Z"),
      at("2026-08-16T03:00:00.000Z"),
      at("2026-08-17T01:00:00.000Z"),
      at("2026-08-17T02:00:00.000Z"),
    ]);
    expect(ticks).toEqual([0, 3]);
  });

  it("thins a long history down but always keeps its first and last day", () => {
    const days = Array.from({ length: 20 }, (_, i) => at(`2026-08-${String(i + 1).padStart(2, "0")}T01:00:00.000Z`));
    const ticks = dayTickIndices(days);
    expect(ticks.length).toBeLessThanOrEqual(5);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(19);
  });
});
