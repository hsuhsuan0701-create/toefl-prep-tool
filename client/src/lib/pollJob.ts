/**
 * The non-React half of the polled-job engine: the loop that fetches one durable job's snapshot
 * until it reports a terminal status, tolerating transient failures.
 *
 * React-free so it can be tested with fake timers alone (no renderHook/act); `usePolledJob` is the
 * stateful wrapper the hooks use.
 */

/** How often to re-poll, and how far the capped exponential backoff may grow after failures. */
export type PollPolicy = {
  /** Wait between a successful poll and the next one. Also the base a failed poll backs off from. */
  intervalMs: number;
  /** Ceiling for the doubled backoff. Set equal to `intervalMs` for a loop that never backs off. */
  maxBackoffMs: number;
};

/**
 * The cadence every polled job uses unless its caller passes another: 1.5 s, doubling after a failed
 * poll up to 15 s. A loop that must never back off passes `{intervalMs: 1500, maxBackoffMs: 1500}`.
 */
export const DEFAULT_POLL_POLICY: PollPolicy = { intervalMs: 1500, maxBackoffMs: 15_000 };

export type PollUntilTerminalArgs<TSnapshot> = {
  /** One poll. Rejecting is expected and non-fatal — see `pollUntilTerminal`'s doc comment. */
  fetch: () => Promise<TSnapshot>;
  /** Whether this snapshot ends the job. The loop returns it and stops. */
  isTerminal: (snapshot: TSnapshot) => boolean;
  /** Every successful poll, terminal or not, in arrival order. Never called for a failed poll. */
  onSnapshot?: (snapshot: TSnapshot, terminal: boolean) => void;
  /**
   * Re-consulted before every fetch, as soon as every fetch settles, and after every wait. Returning
   * false abandons the polling only; the job keeps running on the server, so a caller can re-attach
   * to the same id later.
   */
  shouldContinue?: () => boolean;
  policy?: Partial<PollPolicy>;
};

/**
 * Polls until `isTerminal` accepts a snapshot (returned) or `shouldContinue` says stop (returns
 * null).
 *
 * A failed fetch is never an outcome: it is swallowed, the backoff doubles (capped at
 * `maxBackoffMs`), and the loop keeps polling the same job. That is what survives a server restart
 * mid-poll: once the server is back, the next successful poll carries the job's real status (boot
 * recovery marks an interrupted job 'failed' with an explanatory error, which arrives here as an
 * ordinary terminal snapshot, not a hang). A successful poll resets the backoff to `intervalMs`.
 */
export async function pollUntilTerminal<TSnapshot>(
  args: PollUntilTerminalArgs<TSnapshot>,
): Promise<TSnapshot | null> {
  const policy: PollPolicy = { ...DEFAULT_POLL_POLICY, ...args.policy };
  const live = args.shouldContinue ?? (() => true);
  let backoffMs = policy.intervalMs;

  for (;;) {
    if (!live()) return null;
    let snapshot: TSnapshot;
    try {
      snapshot = await args.fetch();
    } catch {
      if (!live()) return null;
      backoffMs = Math.min(backoffMs * 2, policy.maxBackoffMs);
      await sleep(backoffMs);
      continue;
    }
    if (!live()) return null;
    backoffMs = policy.intervalMs; // a successful response always resets backoff
    const terminal = args.isTerminal(snapshot);
    args.onSnapshot?.(snapshot, terminal);
    if (terminal) return snapshot;
    await sleep(backoffMs);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
