import { describe, expect, it } from "vitest";
import { runGenerationBatchWindow } from "../src/services/generationBatchWindow.js";

describe("runGenerationBatchWindow", () => {
  it("runs at most seven children concurrently and retains index-ordered results", async () => {
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started: number[] = [];

    const running = runGenerationBatchWindow(
      Array.from({ length: 9 }, (_, index) => index),
      async (index) => {
        active += 1;
        peak = Math.max(peak, active);
        started.push(index);
        await gate;
        active -= 1;
        return `child-${index}`;
      },
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(peak).toBe(7);
    release();
    await expect(running).resolves.toEqual([
      "child-0", "child-1", "child-2", "child-3", "child-4",
      "child-5", "child-6", "child-7", "child-8",
    ]);
  });

  it("stops admitting children once cancellation is observed", async () => {
    let cancelled = false;
    const started: number[] = [];
    const results = await runGenerationBatchWindow(
      [0, 1, 2, 3],
      async (index) => {
        started.push(index);
        if (index === 0) cancelled = true;
        return index;
      },
      { concurrency: 2, shouldAdmit: () => !cancelled },
    );

    expect(started).toEqual([0]);
    expect(results).toEqual([0, undefined, undefined, undefined]);
  });
});
