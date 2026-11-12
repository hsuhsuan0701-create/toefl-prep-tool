import { onTestFinished, vi } from "vitest";

/**
 * Installs vitest's fake timers for the calling test only (call it inside the test, or in a
 * `beforeEach`), and returns the one handle that may advance them asynchronously.
 *
 * Restoration hangs off the test's own lifecycle (`onTestFinished`), which vitest runs whether the
 * test passed, failed, or was abandoned at its timeout, and after every `afterEach` hook, so React
 * Testing Library's unmount still clears the fake timers its effects armed. A `vi.useRealTimers()`
 * in a `finally` or an `afterEach` does not have that property: an abandoned body is still
 * suspended at its last `await`, so its `finally` has not run when the next test starts, and that
 * test inherits fake timers it never asked for.
 *
 * `advanceBy` refuses once its own test has finished, so an abandoned body that wakes up later
 * cannot advance whichever fake clock the next test installed. Synchronous advances inside `act()`
 * still go through `vi.advanceTimersByTime`.
 *
 * The server suite has the same helper in server/test/helpers/fakeTimers.ts; the two workspaces do
 * not share test code.
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
  return {
    async advanceBy(ms) {
      if (finished) {
        throw new Error("A fake clock was advanced after its test finished; that test was abandoned at its timeout.");
      }
      await vi.advanceTimersByTimeAsync(ms);
    },
  };
}
