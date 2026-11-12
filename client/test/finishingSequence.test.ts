import { describe, expect, it, vi } from "vitest";
import { deferred } from "./deferred";
import {
  newFinishingSequenceState,
  runFinishingSequence,
  type CompletionResult,
  type FinishingOutcome,
  type FinishingSequenceInput,
} from "../src/pages/simulation/finishingSequence";

// The Speaking and Writing Simulations' finishing sequence: fire the completion exactly once, never
// complete ahead of a Response that has not reached the server, stop waiting (never the sequence)
// at the overall timeout, and never navigate a page the User has already left.
//
// The overall timeout runs on a clock the test advances by hand (`controllableClock`), so a
// three-minute budget is exercised without sleeping and without flaking under load.

const TIMEOUT_MS = 3 * 60_000;
const GUARD_MS = 15_000;

/** Lets every already-resolved await boundary in the sequence run before the next assertion. */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await Promise.resolve();
}

/** The sequence's own time seam: `sleep` parks until the test moves the clock past its wake time. */
function controllableClock() {
  let now = 0;
  let waiters: Array<{ at: number; resolve: () => void }> = [];
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        waiters.push({ at: now + ms, resolve });
      }),
    async advance(ms: number) {
      now += ms;
      const due = waiters.filter((w) => w.at <= now);
      waiters = waiters.filter((w) => w.at > now);
      for (const w of due) w.resolve();
      await flush();
    },
  };
}

/** Every dep defaulted to a benign happy path, so each test overrides only what it is about. */
function run(
  overrides: Partial<Omit<FinishingSequenceInput, "clock">> = {},
  clock: ReturnType<typeof controllableClock> = controllableClock(),
): {
  outcome: Promise<FinishingOutcome>;
  clock: ReturnType<typeof controllableClock>;
  log: ReturnType<typeof vi.fn>;
  state: FinishingSequenceInput["state"];
} {
  const log = vi.fn();
  const state = overrides.state ?? newFinishingSequenceState();
  const outcome = runFinishingSequence({
    attemptId: "att-1",
    settle: async () => "settled",
    complete: async () => ({ kind: "completed" }),
    timeoutMs: TIMEOUT_MS,
    guardMs: GUARD_MS,
    stillActive: () => true,
    log,
    ...overrides,
    state,
    clock,
  });
  return { outcome, clock, log, state };
}

const committed = async (): Promise<CompletionResult> => ({ kind: "completed" });

describe("runFinishingSequence: firing the completion exactly once", () => {
  // Two runs at once: an effect re-firing while the completion request is in flight. The claim is
  // set synchronously before `await complete(...)`; setting it after the await would let the second
  // run call `complete` again.
  it("joins an in-flight completion from a second run rather than firing a second one", async () => {
    const inFlight = deferred();
    const complete = vi.fn(async (): Promise<CompletionResult> => {
      await inFlight.promise;
      return { kind: "completed" };
    });
    const state = newFinishingSequenceState();

    const first = run({ complete, state });
    await flush();
    const second = run({ complete, state });
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);

    inFlight.resolve();
    expect(await first.outcome).toEqual({ kind: "finished" });
    expect(await second.outcome).toEqual({ kind: "finished" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("joins the one in-flight sequence on timeout rather than starting a second one", async () => {
    const clock = controllableClock();
    const inFlight = deferred();
    const settle = vi.fn(async () => "settled" as const);
    const complete = vi.fn(async (): Promise<CompletionResult> => {
      await inFlight.promise;
      return { kind: "completed" };
    });

    const { outcome } = run({ settle, complete }, clock);

    await flush();
    // The budget expires with the completion's own POST still in flight.
    await clock.advance(TIMEOUT_MS);
    await clock.advance(GUARD_MS);

    expect(await outcome).toEqual({ kind: "timed-out" });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);

    inFlight.resolve();
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  // A completion that could not be made is a failure of the sequence, not a finish: the section
  // stays on its wrap-up (and a Full-Test Run is not advanced). The claim is still set
  // synchronously; only its release is conditional, so the User's Retry may issue the call again.
  it("reports a failed completion and releases the claim", async () => {
    const error = new TypeError("Failed to fetch");
    const complete = vi.fn(async (): Promise<CompletionResult> => ({ kind: "failed", error }));

    const { outcome, state } = run({ complete });

    expect(await outcome).toEqual({ kind: "completion-failed", error });
    expect(state.completionClaimed).toBe(false);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  // The User's Retry is a re-run on the same state. It must not join the chain that already ended,
  // which would report the old failure again without a request.
  it("settles afresh and completes once more on a re-run after a failed completion", async () => {
    const settle = vi.fn(async () => "settled" as const);
    const complete = vi
      .fn<() => Promise<CompletionResult>>()
      .mockResolvedValueOnce({ kind: "failed", error: new TypeError("Failed to fetch") })
      .mockResolvedValueOnce({ kind: "completed" });
    const state = newFinishingSequenceState();

    expect((await run({ settle, complete, state }).outcome).kind).toBe("completion-failed");
    expect(await run({ settle, complete, state }).outcome).toEqual({ kind: "finished" });

    expect(settle).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(2);
    expect(state.completionClaimed).toBe(true);
  });

  it("holds the claim across a re-run when the completion committed", async () => {
    const complete = vi.fn(committed);
    const state = newFinishingSequenceState();

    expect(await run({ complete, state }).outcome).toEqual({ kind: "finished" });
    expect(await run({ complete, state }).outcome).toEqual({ kind: "finished" });

    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("runFinishingSequence: a Response that has not reached the server", () => {
  it("does not complete, reports held, and lets a later run settle afresh", async () => {
    const complete = vi.fn(committed);
    const settle = vi.fn<() => Promise<"settled" | "held">>(async () => "held");
    const state = newFinishingSequenceState();

    expect(await run({ settle, complete, state }).outcome).toEqual({ kind: "held" });
    expect(complete).not.toHaveBeenCalled();

    // The User's Retry: a fresh settle, not the remembered `held`.
    settle.mockResolvedValueOnce("settled");
    expect(await run({ settle, complete, state }).outcome).toEqual({ kind: "finished" });
    expect(settle).toHaveBeenCalledTimes(2);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("reports held, not timed-out, when the stuck settle turns out held during the guard", async () => {
    const clock = controllableClock();
    const sending = deferred<"held">();
    const complete = vi.fn(committed);

    const { outcome } = run({ settle: () => sending.promise, complete }, clock);

    await clock.advance(TIMEOUT_MS);
    sending.resolve("held");
    await flush();

    expect(await outcome).toEqual({ kind: "held" });
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("runFinishingSequence: the overall timeout", () => {
  // The timeout stops the waiting, not the sequence: it joins the same settle -> complete chain,
  // gives up waiting after the guard, and the chain keeps running. It never completes on its own,
  // which would put the completion ahead of a Response still being sent.
  it("abandons the WAIT, not the sequence, and never completes around a stuck settle", async () => {
    const clock = controllableClock();
    const sending = deferred();
    const complete = vi.fn(committed);

    const { outcome, log } = run(
      {
        settle: async () => {
          await sending.promise;
          return "settled";
        },
        complete,
      },
      clock,
    );

    await clock.advance(TIMEOUT_MS);
    expect(complete).not.toHaveBeenCalled();

    await clock.advance(GUARD_MS);
    expect(await outcome).toEqual({ kind: "timed-out" });
    expect(complete).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("navigating anyway"), expect.anything());

    // The User has been moved on, and the sequence was never cancelled: the send finally lands and
    // the completion follows it, in order.
    sending.resolve();
    await flush();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  // A completion still retrying at the timeout that then fails is a failure, not a reason to move on.
  it("reports a completion that fails during the guard's wait, not timed-out", async () => {
    const clock = controllableClock();
    const completing = deferred<CompletionResult>();
    const error = new TypeError("Failed to fetch");

    const { outcome } = run({ complete: () => completing.promise }, clock);

    await clock.advance(TIMEOUT_MS);
    completing.resolve({ kind: "failed", error });
    await flush();

    expect(await outcome).toEqual({ kind: "completion-failed", error });
  });

  it("does not navigate when the caller leaves during the guard's own wait", async () => {
    const clock = controllableClock();
    let active = true;

    const { outcome } = run({ settle: () => new Promise(() => {}), stillActive: () => active }, clock);

    await clock.advance(TIMEOUT_MS);
    active = false;
    await clock.advance(GUARD_MS);
    expect(await outcome).toEqual({ kind: "abandoned" });
  });
});

describe("runFinishingSequence: leaving mid-sequence", () => {
  // The User leaves (an escape link, the browser's Back) and the section unmounts. Nothing may
  // navigate after that — and nothing may be cancelled either: the detached chain still sends and
  // still completes.
  it("reports abandoned without navigating, and still finishes the detached sequence", async () => {
    let active = true;
    const sending = deferred();
    const complete = vi.fn(committed);

    const { outcome } = run({
      settle: async () => {
        await sending.promise;
        return "settled";
      },
      complete,
      stillActive: () => active,
    });

    await flush();
    active = false;
    sending.resolve();
    await flush();

    expect(await outcome).toEqual({ kind: "abandoned" });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});

describe("runFinishingSequence: completion order, and never waiting on marking", () => {
  // The sequence finishes when the completion lands; no scoring job can delay or gate it.
  it("settles, completes, and reports finished with no clock advance — nothing waits on a judge", async () => {
    const order: string[] = [];

    const { outcome } = run({
      settle: async () => {
        order.push("settle");
        return "settled";
      },
      complete: async () => {
        order.push("complete");
        return { kind: "completed" };
      },
    });

    expect(await outcome).toEqual({ kind: "finished" });
    expect(order).toEqual(["settle", "complete"]);
  });
});
