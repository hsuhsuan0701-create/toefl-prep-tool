import { onTestFinished, vi } from "vitest";

/**
 * Installs vitest's fake timers for the calling test only, and returns the one handle that may
 * advance them.
 *
 * Restoration hangs off the test's own lifecycle (`onTestFinished`), which vitest runs whether the
 * test passed, failed, or was abandoned at its timeout. A `finally { vi.useRealTimers() }` inside the
 * body does not have that property: an abandoned body is still suspended at its last `await`, so its
 * `finally` has not run when the next test starts, and that test inherits fake timers it never asked
 * for.
 *
 * An abandoned body also keeps running in the background once whatever it awaited settles. If it
 * then advanced the clock through `vi`, it would advance whichever fake clock is installed at that
 * moment, which may belong to the next test. `advanceBy` refuses once its own test has finished.
 */
export function useFakeTimersInTest(...config: Parameters<typeof vi.useFakeTimers>): {
  advanceBy: (ms: number) => Promise<void>;
} {
  vi.useFakeTimers(...config);
  let finished = false;
  onTestFinished(() => {
    finished = true;
    vi.useRealTimers();
  });
  const assertLive = () => {
    if (finished) {
      throw new Error("A fake clock was advanced after its test finished; that test was abandoned at its timeout.");
    }
  };
  return {
    async advanceBy(ms) {
      assertLive();
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}
