import { useEffect, useRef } from "react";
import type { RetryClock } from "../../lib/captureRetry";
import { useFinishingEscapeHatch } from "./simulationShell";

// ---------------------------------------------------------------------------
// The tail of a Speaking or Writing Simulation — settle every Response still on its way to the
// server, fire the completion request exactly once, and bound the wait — as one pure async function
// (`runFinishingSequence`) with a thin hook over it (`useFinishingSequence`).
//
// The sequence reports `finished` as soon as the Responses are handed in and the completion call has
// landed, and `completion-failed` when the completion call could not be made: the section then
// stays on its wrap-up with Retry, and inside a Full-Test Run does not advance it. It never waits
// on a scoring job: judging takes minutes, the jobs keep running server-side, and AttemptReview
// renders them landing.
//
// The settle step is detached. It runs to the end even after the User has navigated away (an escape
// link, the browser's Back), because what it does — upload a recording, send an essay, then post the
// completion — is exactly what would be lost if leaving cancelled it. Leaving only stops the
// sequence from navigating a page that is gone.
//
// `runFinishingSequence` is pure in the sense submitModule.ts is: no React, no `Date.now()`, no
// timers, no module-level state. Time arrives as `clock`, I/O as `settle`/`complete`, React as
// `stillActive`/`log`; the hook at the bottom of this file supplies them.
// ---------------------------------------------------------------------------

/**
 * What the settle step reports.
 *
 * - `settled` — every Response the server should have, it has. Completion may run.
 * - `held`    — some Response still has not reached the server. Completion must not run ahead of it,
 *               so the sequence stops short of completing and the section shows what is missing.
 *               Only Writing reports this; Speaking reports a recording it could not send to the
 *               server inside its own completion call (the capture marker's `uploadFailedItemIds`).
 */
export type SettleResult = "settled" | "held";

/**
 * What the completion call reports, after its own bounded retries.
 *
 * - `completed` — the server has it. The claim stands: nothing issues this Attempt's completion
 *                 again.
 * - `failed`    — a refusal, or the retry budget ran out; `error` is the last failure, for
 *                 requestErrorMessage. The claim is released and the chain forgotten, so the User's
 *                 Retry issues the call again. Both calls are idempotent: a second POST
 *                 /:id/complete answers from the completed Attempt, and the capture marker never
 *                 moves once written.
 */
export type CompletionResult = { kind: "completed" } | { kind: "failed"; error: unknown };

/**
 * How the sequence can end. A discriminated union so the one call site can `switch` exhaustively.
 *
 * - `finished`          — settled and the completion call landed. Navigate.
 * - `timed-out`         — the overall budget, plus `guardMs` of waiting on the chain, expired.
 *                         Navigate anyway: the chain keeps running and the server owns what it is
 *                         still doing.
 * - `held`              — settle reported `held`. Do not navigate; show the User what has not been
 *                         sent.
 * - `completion-failed` — every Response is in, and the completion call could not be made. Do not
 *                         navigate (and inside a Full-Test Run do not advance it); show the failure
 *                         with Retry.
 * - `abandoned`         — the caller went away first. Do nothing — there is no page left to
 *                         navigate.
 */
export type FinishingOutcome =
  | { kind: "finished" }
  | { kind: "timed-out" }
  | { kind: "held" }
  | { kind: "completion-failed"; error: unknown }
  | { kind: "abandoned" };

/** Where one settle -> complete chain ended. */
type ChainResult = { kind: "finished" } | { kind: "held" } | { kind: "completion-failed"; error: unknown };

/**
 * The single-flight claim and the memoized settle chain, held by the caller so both survive an
 * effect re-run: a second run must join the first run's chain, not start a second completion of its
 * own.
 */
export type FinishingSequenceState = {
  completionClaimed: boolean;
  chain: Promise<ChainResult> | null;
};

export function newFinishingSequenceState(): FinishingSequenceState {
  return { completionClaimed: false, chain: null };
}

export type FinishingSequenceInput = {
  attemptId: string;
  /**
   * Make sure every Response has reached the server — awaiting the requests that hand it in, never
   * the scoring jobs they start. Runs to the end whether or not the caller is still mounted.
   */
  settle: (attemptId: string) => Promise<SettleResult>;
  /**
   * The section's one completion call. Invoked at most once per claim and never expected to throw —
   * each section bounds, retries and logs its own call, and reports a failure as `failed`.
   */
  complete: (attemptId: string) => Promise<CompletionResult>;
  /** How long the caller waits on settle + complete before it stops waiting (the work goes on). */
  timeoutMs: number;
  /**
   * After `timeoutMs`, how much longer to wait on the same chain before navigating anyway. The
   * timeout never gets its own shortcut to completion: a completion may not run ahead of a Response
   * still being sent, and Speaking's capture marker may not run ahead of its score requests.
   */
  guardMs: number;
  state: FinishingSequenceState;
  /** Only `sleep` is read; the shape is captureRetry.ts's so a caller carries one clock. */
  clock: RetryClock;
  /** False once the caller no longer wants an outcome. */
  stillActive: () => boolean;
  /** Where diagnostics go. Injected rather than calling `console.error` so this stays pure. */
  log: (message: string, error: unknown) => void;
};

/**
 * Settle -> complete (exactly once), raced against `timeoutMs`. Never throws: a caller that has
 * already navigated away must not be handed a rejection.
 */
export async function runFinishingSequence(input: FinishingSequenceInput): Promise<FinishingOutcome> {
  const { attemptId, settle, complete, timeoutMs, guardMs, state, clock, stillActive, log } = input;

  const deadline = clock.sleep(timeoutMs);

  // The fire-exactly-once guarantee. The claim is set synchronously, before the first await, so a
  // second caller sees it claimed even on the very next microtask tick. Claiming only on success
  // would let the normal path and a re-run both be mid-completion at once. A failed call releases
  // it, so the User's Retry may issue the call again.
  const completeOnce = async (): Promise<CompletionResult> => {
    if (state.completionClaimed) return { kind: "completed" };
    state.completionClaimed = true;
    const result = await complete(attemptId);
    if (result.kind === "failed") state.completionClaimed = false;
    return result;
  };

  // Memoized in caller-owned state, so the normal path, the timeout's wait and a re-run of the
  // effect all join this exact chain. A chain that ends `held`, ends with the completion failed, or
  // throws is forgotten again, so the User's Retry starts a fresh settle and a fresh completion
  // rather than re-reading the old answer.
  const settleThenComplete = (): Promise<ChainResult> => {
    const started = state.chain;
    if (started) return started;
    const chain = (async (): Promise<ChainResult> => {
      try {
        if ((await settle(attemptId)) === "held") {
          state.chain = null;
          return { kind: "held" };
        }
      } catch (e) {
        state.chain = null;
        throw e;
      }
      const completed = await completeOnce();
      if (completed.kind === "failed") {
        state.chain = null;
        return { kind: "completion-failed", error: completed.error };
      }
      return { kind: "finished" };
    })();
    state.chain = chain;
    return chain;
  };

  const TIMED_OUT = { kind: "timed-out" } as const;

  const main = (async (): Promise<ChainResult | typeof TIMED_OUT> => {
    try {
      return await settleThenComplete();
    } catch (e) {
      // No section's settle step throws on purpose (each one catches its own requests), so this is
      // not a shortcut to navigation: the overall timeout stays the only thing that moves the User on.
      log("simulation: finishing sequence failed unexpectedly", e);
      await deadline;
      return TIMED_OUT;
    }
  })();

  const winner = await Promise.race([main, deadline.then(() => TIMED_OUT)]);
  if (!stillActive()) return { kind: "abandoned" };
  if (winner.kind !== "timed-out") return winner;

  // Timed out. Wait a bounded while longer on the same chain — never cancel it, and never start a
  // second one — then navigate.
  let late: ChainResult | typeof TIMED_OUT | null = null;
  try {
    late = await withDeadline(main, guardMs, clock);
  } catch (e) {
    log("simulation: finishing sequence still running at the timeout guard; navigating anyway", e);
  }
  if (!stillActive()) return { kind: "abandoned" };
  return late ?? TIMED_OUT;
}

/**
 * `promise`, or a rejection once `ms` has passed. Built by hand rather than as a `Promise.race` so
 * the losing side can never reject into nothing.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, clock: RetryClock): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    void clock.sleep(ms).then(() => {
      if (done) return;
      done = true;
      reject(new Error(`timed out after ${ms}ms`));
    });
    promise.then(
      (value) => {
        if (done) return;
        done = true;
        resolve(value);
      },
      (error) => {
        if (done) return;
        done = true;
        reject(error);
      },
    );
  });
}

export type UseFinishingSequenceOptions = {
  /** True exactly while the section is on its "Wrapping up…" screen. */
  active: boolean;
  attemptId: string | null;
  settle: (attemptId: string) => Promise<SettleResult>;
  complete: (attemptId: string) => Promise<CompletionResult>;
  timeoutMs: number;
  guardMs: number;
  /** Where to send the User once the sequence says so. */
  onFinished: (attemptId: string) => void;
  /** Called instead of `onFinished` when settle reports `held`. */
  onHeld?: (attemptId: string) => void;
  /** Called instead of `onFinished` when the completion call could not be made. */
  onCompletionFailed: (attemptId: string, error: unknown) => void;
};

/**
 * The React half: run the sequence once per entry into the finishing screen, hand its outcome to
 * `onFinished`/`onHeld`/`onCompletionFailed`, and drive the escape hatch (a link shown after 20 s, for sections that
 * offer one). Unmounting flips `stillActive` off and lands the sequence on `abandoned` — no second
 * navigation, and nothing cancelled.
 */
export function useFinishingSequence(options: UseFinishingSequenceOptions): boolean {
  const showEscape = useFinishingEscapeHatch(options.active);
  // Latest-value ref: both sections build fresh step closures every render, and none of that should
  // re-key the effect below.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Survives an effect re-run, which keeps the completion single-flight and the chain shared across
  // one. Re-armed only when a different Attempt starts finishing.
  const stateRef = useRef<{ attemptId: string | null; state: FinishingSequenceState }>({
    attemptId: null,
    state: newFinishingSequenceState(),
  });

  const { active, attemptId } = options;

  useEffect(() => {
    if (!active || !attemptId) return;
    if (stateRef.current.attemptId !== attemptId) {
      stateRef.current = { attemptId, state: newFinishingSequenceState() };
    }
    const state = stateRef.current.state;
    let cancelled = false;
    // Every timer this run creates, cleared on unmount — the overall budget is minutes long.
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const clock: RetryClock = {
      now: () => Date.now(),
      sleep: (ms) =>
        new Promise<void>((resolve) => {
          const id = setTimeout(() => {
            timers.delete(id);
            resolve();
          }, ms);
          timers.add(id);
        }),
    };

    void (async () => {
      const outcome = await runFinishingSequence({
        attemptId,
        settle: (id) => optionsRef.current.settle(id),
        complete: (id) => optionsRef.current.complete(id),
        timeoutMs: optionsRef.current.timeoutMs,
        guardMs: optionsRef.current.guardMs,
        state,
        clock,
        stillActive: () => !cancelled,
        log: (message, error) => console.error(message, error),
      });
      switch (outcome.kind) {
        case "finished":
        case "timed-out":
          optionsRef.current.onFinished(attemptId);
          return;
        case "held":
          optionsRef.current.onHeld?.(attemptId);
          return;
        case "completion-failed":
          optionsRef.current.onCompletionFailed(attemptId, outcome.error);
          return;
        case "abandoned":
          return;
        default: {
          const unhandled: never = outcome;
          throw new Error(`unhandled finishing outcome: ${String(unhandled)}`);
        }
      }
    })();

    return () => {
      cancelled = true;
      for (const id of timers) clearTimeout(id);
    };
  }, [active, attemptId]);

  return showEscape;
}
