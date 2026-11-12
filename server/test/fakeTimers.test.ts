import { describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./helpers/fakeTimers.js";

// The failure this helper exists for, reproduced: a test vitest abandons at its timeout must hand the
// next test real timers, and its body, still running in the background, must not be able to move
// the clock the next test installs.
describe("useFakeTimersInTest", () => {
  let releaseAbandonedBody!: () => void;
  const abandonedBodyMayResume = new Promise<void>((resolve) => {
    releaseAbandonedBody = resolve;
  });
  let lateAdvanceError: unknown;
  let lateAdvanceSettled!: () => void;
  const lateAdvanceDone = new Promise<void>((resolve) => {
    lateAdvanceSettled = resolve;
  });

  it.fails("a test abandoned at its timeout while holding fake timers", async () => {
    const clock = useFakeTimersInTest();
    // Still suspended here when the 50 ms budget runs out.
    await abandonedBodyMayResume;
    try {
      await clock.advanceBy(1_000);
    } catch (error) {
      lateAdvanceError = error;
    }
    lateAdvanceSettled();
  }, 50);

  it("leaves the next test on real timers, and its late advance cannot move that test's clock", async () => {
    expect(vi.isFakeTimers()).toBe(false);

    const clock = useFakeTimersInTest();
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 1_000);

    releaseAbandonedBody();
    await lateAdvanceDone;
    expect(String(lateAdvanceError)).toMatch(/advanced after its test finished/);
    expect(fired).toBe(false);

    await clock.advanceBy(1_000);
    expect(fired).toBe(true);
  });

  it("restores real timers after a test that passes", () => {
    expect(vi.isFakeTimers()).toBe(false);
  });
});
