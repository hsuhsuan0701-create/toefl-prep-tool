// The Simulations' retry policy for a request that must land: the Speaking capture marker
// (POST /:id/capture-finished), a Reading/Listening Module submit, a Writing Response, a Speaking
// upload. Pure and injectable so it can be pinned on a virtual clock; the server suite also imports
// it, beside the capture-finished route whose restart behaviour the budget is sized against.
//
// The budget is wall-clock time, not an attempt count: a connection-refused fetch rejects in
// milliseconds, so a fixed number of attempts covers a few seconds against a server that is down,
// less than one `tsx watch` restart. Backing off 2s/4s/8s/16s, with the last attempt at the edge of
// 30s, outlives an ordinary dev-server restart.
export const CAPTURE_RETRY_BUDGET_MS = 30_000;
export const CAPTURE_RETRY_FIRST_DELAY_MS = 2_000;
export const CAPTURE_RETRY_MAX_DELAY_MS = 16_000;

/** 1 -> 2s, 2 -> 4s, 3 -> 8s, 4+ -> 16s. */
export function captureRetryDelayMs(failureCount: number): number {
  return Math.min(CAPTURE_RETRY_FIRST_DELAY_MS * 2 ** (failureCount - 1), CAPTURE_RETRY_MAX_DELAY_MS);
}

export type RetryClock = { now: () => number; sleep: (ms: number) => Promise<void> };

/**
 * Runs `attempt` until it succeeds or the wall-clock budget is spent, backing off between failures.
 * Returns true if it ever succeeded. Never throws: a caller that has already navigated away must not
 * be handed a rejection.
 *
 * `isPermanent` stops early on a failure that resending cannot fix (the server read the request and
 * refused it), so the caller hears about it now instead of after the whole budget.
 */
export async function retryWithinBudget(
  attempt: (attemptNumber: number) => Promise<unknown>,
  clock: RetryClock,
  onFailure?: (attemptNumber: number, error: unknown) => void,
  budgetMs: number = CAPTURE_RETRY_BUDGET_MS,
  isPermanent?: (error: unknown) => boolean,
): Promise<boolean> {
  const deadline = clock.now() + budgetMs;
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      await attempt(attemptNumber);
      return true;
    } catch (error) {
      onFailure?.(attemptNumber, error);
      if (isPermanent?.(error)) return false;
      const now = clock.now();
      // The last sleep is clipped to end at the deadline and the attempt after it still runs, so the
      // budget is coverage, not a cutoff a fast failure can undershoot.
      if (now >= deadline) return false;
      await clock.sleep(Math.min(captureRetryDelayMs(attemptNumber), deadline - now));
    }
  }
}
