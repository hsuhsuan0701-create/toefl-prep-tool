import { describe, expect, it, vi } from "vitest";
import type { DeterministicScoreRequest } from "@toefl-prep/shared";
import { DeterministicAlreadyScoredError, HttpError } from "../src/lib/api";
import { CAPTURE_RETRY_BUDGET_MS } from "../src/lib/captureRetry";
import {
  submitModule,
  type ModuleSubmitInput,
  type ModuleSubmitOutcome,
} from "../src/pages/simulation/submitModule";

// The Reading and Listening Module submit, one pure function for both sections. Two rules in it
// decide whether an Attempt's Responses were really scored: the already-scored conflict, and retry
// exhaustion. Getting either wrong marks unscored Attempts complete, or leaves the User stuck on an
// error no retry can clear.
//
// Everything here runs on a virtual clock: `submitModule` takes the same `{ now, sleep }` seam
// retryWithinBudget does, so a whole 30-second retry budget is exercised without sleeping and
// without flaking under load. Same idiom as routes.attempts.test.ts's own capture-retry tests.

function virtualClock() {
  let now = 0;
  return { now: () => now, sleep: async (ms: number) => { now += ms; }, at: () => now };
}

const CTW: DeterministicScoreRequest = { taskType: "complete_words", items: [{ itemId: "ctw-1", typed: "cat" }] };
const DAILY: DeterministicScoreRequest = { taskType: "daily_life", items: [{ itemId: "dl-1", selectedOptionId: "b" }] };

/** Every dep defaulted to a benign happy-path stub, so each test overrides only what it is about. */
function run(overrides: Partial<ModuleSubmitInput> = {}): {
  outcome: Promise<ModuleSubmitOutcome>;
  accepted: Set<string>;
  clock: ReturnType<typeof virtualClock>;
  log: ReturnType<typeof vi.fn>;
} {
  const clock = virtualClock();
  const accepted = overrides.acceptedTaskTypes ?? new Set<string>();
  const log = vi.fn();
  const outcome = submitModule({
    attemptId: "att-1",
    module: "lower",
    requests: [CTW, DAILY],
    // Always the same object the assertions below read — `accepted` IS overrides' own Set when the
    // caller supplied one, so the spread can only ever set it to itself.
    acceptedTaskTypes: accepted,
    scoreTaskType: async () => ({}),
    route: async () => ({ path: "upper" as const }),
    clock,
    stillActive: () => true,
    section: "reading",
    log,
    ...overrides,
  });
  return { outcome, accepted, clock, log };
}

describe("submitModule: the conflict rule", () => {
  // The rule that must not be inverted. A 409 marked `alreadyScored` means the server already holds
  // this Task Type's item_results and only the 200 was lost, so it is the one failure that counts as
  // acceptance.
  it("treats an already-scored 409 as success: banks the Task Type, never retries, never re-sends", async () => {
    const scoreTaskType = vi.fn(async (_attemptId: string, req: DeterministicScoreRequest) => {
      if (req.taskType === "complete_words") throw new DeterministicAlreadyScoredError("already scored");
      return {};
    });

    const { outcome, accepted, clock, log } = run({ scoreTaskType });

    expect(await outcome).toEqual({ kind: "module2-scored" });
    // Banked exactly like a 200 would have been — so a later "Retry submit" for this same Module
    // skips it instead of re-sending it into a 409 it can never get past.
    expect(accepted).toEqual(new Set(["complete_words", "daily_life"]));
    // One call, not five: swallowing the error stops retryWithinBudget dead rather than burning the
    // budget on a request the server has already answered.
    expect(scoreTaskType.mock.calls.map(([, req]) => req.taskType)).toEqual(["complete_words", "daily_life"]);
    expect(clock.at()).toBe(0);
    expect(log).not.toHaveBeenCalled();
  });

  // The inverse, which is the half that would silently mark unscored Attempts complete if the rule
  // were ever widened from "the already-scored conflict" to "a conflict".
  it("does NOT treat any other 409 as success — it is retried and then exhausted", async () => {
    const scoreTaskType = vi.fn(async () => {
      throw new HttpError(409, "409: ModuleLockedError");
    });

    const { outcome, accepted } = run({ scoreTaskType });

    expect(await outcome).toEqual({ kind: "submit-error" });
    expect(accepted).toEqual(new Set());
    expect(scoreTaskType).toHaveBeenCalledTimes(5); // retried, not accepted
  });

  it("does not treat an error that merely LOOKS already-scored as success", async () => {
    const scoreTaskType = vi.fn(async () => {
      const e = new Error("already scored");
      e.name = "DeterministicAlreadyScoredError"; // name only — not the real class
      throw e;
    });

    expect(await run({ scoreTaskType }).outcome).toEqual({ kind: "submit-error" });
  });
});

describe("submitModule: retry exhaustion", () => {
  it("spends the whole wall-clock budget, then reports a recoverable submit-error", async () => {
    const attemptedAt: number[] = [];
    const clock = virtualClock();
    const scoreTaskType = vi.fn(async (_attemptId: string, _req: DeterministicScoreRequest) => {
      attemptedAt.push(clock.at());
      throw new TypeError("Failed to fetch"); // what a dead network looks like to fetch()
    });

    const { outcome, accepted, log } = run({ clock, scoreTaskType });

    expect(await outcome).toEqual({ kind: "submit-error" });
    // retryWithinBudget's exponential backoff, and the last attempt lands at the far edge of the
    // budget rather than four seconds in — see captureRetry.ts's own doc comment.
    expect(attemptedAt).toEqual([0, 2_000, 6_000, 14_000, 30_000]);
    expect(clock.at()).toBeGreaterThanOrEqual(CAPTURE_RETRY_BUDGET_MS);
    // Nothing is banked, so the User's "Retry submit" re-sends this Task Type — the whole point of
    // submit-error being recoverable rather than terminal.
    expect(accepted).toEqual(new Set());
    // And the Module submit stops at the first exhausted request: the second Task Type is never
    // sent, so a partially-scored Module is never mistaken for a complete one.
    expect(scoreTaskType.mock.calls.every(([, req]) => req.taskType === "complete_words")).toBe(true);
    expect(log).toHaveBeenCalledTimes(5);
    expect(log.mock.calls[0][0]).toBe("reading simulation: complete_words score attempt 1 failed");
  });

  it("keeps everything already accepted when a LATER request exhausts", async () => {
    const scoreTaskType = vi.fn(async (_attemptId: string, req: DeterministicScoreRequest) => {
      if (req.taskType === "daily_life") throw new TypeError("Failed to fetch");
      return {};
    });

    const { outcome, accepted } = run({ scoreTaskType });

    expect(await outcome).toEqual({ kind: "submit-error" });
    expect(accepted).toEqual(new Set(["complete_words"]));
  });

  it("skips Task Types the caller already banked, so a retry re-sends only what is outstanding", async () => {
    const scoreTaskType = vi.fn(async (_attemptId: string, _req: DeterministicScoreRequest) => ({}));

    const { outcome } = run({ scoreTaskType, acceptedTaskTypes: new Set(["complete_words"]) });

    expect(await outcome).toEqual({ kind: "module2-scored" });
    expect(scoreTaskType.mock.calls.map(([, req]) => req.taskType)).toEqual(["daily_life"]);
  });

  it("exhausting the ROUTE call is a submit-error too, with every Task Type still banked", async () => {
    const route = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    const { outcome, accepted, log } = run({ module: "router", route });

    expect(await outcome).toEqual({ kind: "submit-error" });
    expect(accepted).toEqual(new Set(["complete_words", "daily_life"]));
    expect(route).toHaveBeenCalledTimes(5);
    expect(log.mock.calls[0][0]).toBe("reading simulation: route attempt 1 failed");
  });
});

describe("submitModule: the Router Module fork", () => {
  it("routes the Attempt once the Router Module is scored", async () => {
    const route = vi.fn(async () => ({ path: "lower" as const }));

    const { outcome } = run({ module: "router", route, section: "listening" });

    expect(await outcome).toEqual({ kind: "routed", path: "lower" });
    expect(route).toHaveBeenCalledWith("att-1");
  });

  it("never routes a second Module — it reports module2-scored instead", async () => {
    const route = vi.fn(async () => ({ path: "lower" as const }));

    expect(await run({ module: "upper", route }).outcome).toEqual({ kind: "module2-scored" });
    expect(await run({ module: "lower", route }).outcome).toEqual({ kind: "module2-scored" });
    expect(route).not.toHaveBeenCalled();
  });
});

describe("submitModule: abandonment", () => {
  it("reports `abandoned` rather than an outcome the caller would dispatch", async () => {
    let active = true;
    const scoreTaskType = vi.fn(async () => {
      active = false; // the User navigated away / the component unmounted mid-request
      return {};
    });

    const { outcome, accepted } = run({ scoreTaskType, stillActive: () => active });

    expect(await outcome).toEqual({ kind: "abandoned" });
    // Deliberate: the accepted-Task-Type bookkeeping advances only while the caller is still there
    // to own it.
    expect(accepted).toEqual(new Set());
  });

  it("reports `abandoned` rather than submit-error when a failure races the unmount", async () => {
    let active = true;
    const scoreTaskType = vi.fn(async () => {
      active = false;
      throw new TypeError("Failed to fetch");
    });

    expect(await run({ scoreTaskType, stillActive: () => active }).outcome).toEqual({ kind: "abandoned" });
  });
});
