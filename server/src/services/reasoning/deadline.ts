import { performance } from "node:perf_hooks";

export interface ProviderDeadline {
  readonly expiresAtMs: number;
  readonly now: () => number;
  readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => unknown;
  readonly clearTimer: (handle: unknown) => void;
}

export interface DeadlineClock {
  readonly now?: () => number;
  readonly setTimer?: ProviderDeadline["setTimer"];
  readonly clearTimer?: ProviderDeadline["clearTimer"];
}

/**
 * Once provider execution has timed out, queue release may wait this much
 * longer for adapter-owned process teardown and known-artifact cleanup. This
 * grace is supervisory only: the provider deadline remains expired, so it
 * cannot be spent on more execution, validation, or repair work.
 */
export const PROVIDER_TEARDOWN_GRACE_MS = 3_000;

export class ProviderDeadlineExceeded extends Error {
  constructor() {
    super("structured reasoning provider deadline exceeded");
    this.name = "ProviderDeadlineExceeded";
  }
}

const systemSetTimer: ProviderDeadline["setTimer"] = (
  callback,
  delayMs,
) => setTimeout(callback, delayMs);

const systemClearTimer: ProviderDeadline["clearTimer"] = (handle) => {
  clearTimeout(handle as ReturnType<typeof setTimeout>);
};

export function createProviderDeadline(
  timeoutMs: number,
  clock: DeadlineClock = {},
): ProviderDeadline {
  const now = clock.now ?? (() => performance.now());
  const expiresAtMs = now() + Math.max(0, timeoutMs);
  return Object.freeze({
    expiresAtMs,
    now,
    setTimer: clock.setTimer ?? systemSetTimer,
    clearTimer: clock.clearTimer ?? systemClearTimer,
  });
}

export function remainingDeadlineMs(
  deadline: ProviderDeadline,
): number {
  return Math.max(0, deadline.expiresAtMs - deadline.now());
}

export function deadlineExpired(
  deadline: ProviderDeadline,
): boolean {
  return deadline.now() >= deadline.expiresAtMs;
}

export function throwIfDeadlineExpired(
  deadline: ProviderDeadline,
): void {
  if (deadlineExpired(deadline)) {
    throw new ProviderDeadlineExceeded();
  }
}

export function isProviderDeadlineExceeded(
  error: unknown,
): error is ProviderDeadlineExceeded {
  return error instanceof ProviderDeadlineExceeded;
}

export async function runBeforeDeadline<T>(
  deadline: ProviderDeadline,
  operation: () => T | Promise<T>,
): Promise<T> {
  throwIfDeadlineExpired(deadline);
  const remainingMs = remainingDeadlineMs(deadline);
  let timer: unknown;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = deadline.setTimer(
      () => reject(new ProviderDeadlineExceeded()),
      remainingMs,
    );
  });
  const pending = Promise.resolve().then(operation);

  try {
    const value = await Promise.race([pending, timedOut]);
    throwIfDeadlineExpired(deadline);
    return value;
  } finally {
    deadline.clearTimer(timer);
  }
}

type ObservedSettlement<T> =
  | { readonly state: "fulfilled"; readonly value: T }
  | { readonly state: "rejected"; readonly error: unknown };

function observeSettlement<T>(
  operation: () => T | Promise<T>,
): Promise<ObservedSettlement<T>> {
  return Promise.resolve()
    .then(operation)
    .then(
      (value) => ({ state: "fulfilled" as const, value }),
      (error: unknown) => ({
        state: "rejected" as const,
        error,
      }),
    );
}

/**
 * Supervises one complete adapter operation without granting it a second
 * execution budget. A deadline first fixes the logical result as timeout, then
 * waits only for observed adapter settlement or a small independent teardown
 * grace before allowing the owning provider queue to advance.
 */
export async function superviseBeforeDeadline<T>(
  deadline: ProviderDeadline,
  operation: () => T | Promise<T>,
  teardownGraceMs = PROVIDER_TEARDOWN_GRACE_MS,
): Promise<T> {
  throwIfDeadlineExpired(deadline);
  const settlement = observeSettlement(operation);
  const deadlineMarker = Object.freeze({ state: "deadline" as const });
  let deadlineTimer: unknown;
  const deadlineReached = new Promise<typeof deadlineMarker>((resolve) => {
    deadlineTimer = deadline.setTimer(
      () => resolve(deadlineMarker),
      remainingDeadlineMs(deadline),
    );
  });

  const first = await Promise.race([settlement, deadlineReached]);
  deadline.clearTimer(deadlineTimer);

  if (first.state !== "deadline") {
    // A synchronously blocking adapter can settle after the absolute time even
    // though its promise wins the timer race. Its late value/error is still
    // subordinate to the fixed deadline result.
    throwIfDeadlineExpired(deadline);
    if (first.state === "rejected") throw first.error;
    return first.value;
  }

  let graceTimer: unknown;
  const graceElapsed = new Promise<void>((resolve) => {
    graceTimer = deadline.setTimer(
      resolve,
      Math.max(0, teardownGraceMs),
    );
  });
  try {
    await Promise.race([settlement, graceElapsed]);
  } finally {
    deadline.clearTimer(graceTimer);
  }
  throw new ProviderDeadlineExceeded();
}
