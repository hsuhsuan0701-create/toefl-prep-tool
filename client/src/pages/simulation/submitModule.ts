import type { DeterministicScoreRequest, ModulePath, RoutedModule } from "@toefl-prep/shared";
import { DeterministicAlreadyScoredError } from "../../lib/api";
import { retryWithinBudget, type RetryClock } from "../../lib/captureRetry";

// ---------------------------------------------------------------------------
// The Reading and Listening Simulations' Module submit, as one pure async function that both
// sections call from their submitting effect. It holds four rules: the accepted-Task-Type
// bookkeeping, the per-Task-Type retry budgets, the already-scored-conflict-is-success rule, and the
// Router Module fork. Keeping them here means one copy for both sections, tested directly by
// client/test/submitModule.test.ts rather than only through a rendered component.
//
// Pure in the sense captureRetry.ts's retryWithinBudget is pure: no React, no `Date.now()`, no
// timers, no module-level state. Everything time-shaped arrives as `clock`, everything I/O-shaped as
// `scoreTaskType`/`route`, and everything React-shaped as `stillActive`/`log`. The caller decides
// what to do with the outcome; this function never dispatches, navigates or renders.
// ---------------------------------------------------------------------------

/**
 * Exactly four ways a Module submit can end. A discriminated union rather than a bare enum so both
 * call sites can `switch` exhaustively: adding a fifth outcome is a compile error in ReadingSimulation
 * and ListeningSimulation alike, which keeps the two sections handling the same outcomes.
 *
 * - `routed`         — the Router Module scored and POST /:id/route answered; carries the Module Path.
 * - `module2-scored` — the Lower/Upper Module scored; the Attempt is ready to complete.
 * - `submit-error`   — some request's retry budget was genuinely exhausted. Recoverable: whatever was
 *                      accepted stays accepted (see `acceptedTaskTypes`), so a retry re-sends only
 *                      what is still outstanding.
 * - `abandoned`      — the caller went inactive (unmounted, or a newer submit superseded this one)
 *                      partway through. The caller must do nothing with this: dispatching into a
 *                      dead or superseded component is exactly what the `stillActive` checks exist
 *                      to prevent.
 */
export type ModuleSubmitOutcome =
  | { kind: "routed"; path: ModulePath }
  | { kind: "module2-scored" }
  | { kind: "submit-error" }
  | { kind: "abandoned" };

export type ModuleSubmitInput = {
  attemptId: string;
  /** Which Module just closed. `"router"` is what forks into routing rather than completion. */
  module: RoutedModule;
  /** Every Task Type request the closed Module contains — already sentinel-filled by the caller's
   *  own `buildScoreRequests`. Filtering out what is already accepted happens here, not there. */
  requests: readonly DeterministicScoreRequest[];
  /**
   * Which Task Types of this Module the server has already accepted (200'd, or 409'd as already
   * scored — see the conflict rule below). Read to skip them and mutated as new ones land, so the
   * caller's own retry ("Retry submit" after a `submit-error`) re-sends only what is still
   * outstanding rather than every Task Type of the Module again. The caller owns the lifetime of
   * this Set and must hand over a fresh one wherever a genuinely new Module starts.
   */
  acceptedTaskTypes: Set<string>;
  scoreTaskType: (attemptId: string, req: DeterministicScoreRequest) => Promise<unknown>;
  route: (attemptId: string) => Promise<{ path: ModulePath }>;
  clock: RetryClock;
  /** False once the caller no longer wants an outcome — re-checked at every await boundary. */
  stillActive: () => boolean;
  /** Prefixes every diagnostic, keeping the two sections' log lines distinguishable. */
  section: "reading" | "listening";
  /** Where diagnostics go. Injected rather than calling `console.error` so this stays pure. */
  log: (message: string, error: unknown) => void;
};

const ABANDONED: ModuleSubmitOutcome = { kind: "abandoned" };

/**
 * Scores every still-outstanding Task Type of the just-closed Module, each within its own bounded
 * retry budget (retryWithinBudget's wall-clock/backoff policy), then either routes the Attempt
 * (Router Module) or reports the second Module done.
 */
export async function submitModule(input: ModuleSubmitInput): Promise<ModuleSubmitOutcome> {
  const { attemptId, module, requests, acceptedTaskTypes, scoreTaskType, route, clock, stillActive, section, log } =
    input;

  try {
    const outstanding = requests.filter((req) => !acceptedTaskTypes.has(req.taskType));

    for (const req of outstanding) {
      if (!stillActive()) return ABANDONED;
      const succeeded = await retryWithinBudget(
        async () => {
          try {
            await scoreTaskType(attemptId, req);
          } catch (e) {
            // The conflict rule. A 409 marked `alreadyScored: true` is positive evidence the server
            // already committed this Task Type's item_results, all of them in one transaction: an
            // earlier request landed and only its 200 was lost. scoreDeterministicTask throws the
            // same error for a 200 whose body could not be read. Only that conflict is success:
            // swallowed, so retryWithinBudget stops and the Task Type is banked below. Every other
            // failure (a network error, the 409s for a kind mismatch or a locked Module, the 404 for
            // an unknown Item) still propagates and is retried until the budget runs out, because
            // treating it as success would mark complete an Attempt whose Responses were never
            // scored.
            if (e instanceof DeterministicAlreadyScoredError) return;
            throw e;
          }
        },
        clock,
        (attemptNumber, e) => log(`${section} simulation: ${req.taskType} score attempt ${attemptNumber} failed`, e),
      );
      if (!stillActive()) return ABANDONED;
      if (!succeeded) return { kind: "submit-error" };
      acceptedTaskTypes.add(req.taskType);
    }

    if (!stillActive()) return ABANDONED;

    if (module === "router") {
      // retryWithinBudget reports success/failure, never the resolved value, so the Module Path is
      // captured out of the attempt closure. A one-element sink rather than a `let`, because
      // TypeScript's control-flow analysis cannot see that the closure ran and would narrow a `let`
      // to its initializer; the last push is the attempt that actually succeeded.
      const routeResults: Array<{ path: ModulePath }> = [];
      const routed = await retryWithinBudget(
        async () => {
          routeResults.push(await route(attemptId));
        },
        clock,
        (attemptNumber, e) => log(`${section} simulation: route attempt ${attemptNumber} failed`, e),
      );
      if (!stillActive()) return ABANDONED;
      const result = routeResults[routeResults.length - 1];
      if (!routed || !result) return { kind: "submit-error" };
      return { kind: "routed", path: result.path };
    }

    return { kind: "module2-scored" };
  } catch (e) {
    // Anything retryWithinBudget did not already absorb (a caller-supplied dep throwing
    // synchronously, a malformed request): log it and surface a recoverable submit error, unless the
    // caller has already gone away.
    if (!stillActive()) return ABANDONED;
    log(`${section} simulation: module scoring failed`, e);
    return { kind: "submit-error" };
  }
}
