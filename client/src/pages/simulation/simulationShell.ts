import { useCallback, useEffect, useState } from "react";
import {
  advanceFullTest,
  completeAttempt,
  finishSpeakingCapture,
  flagAttempt,
  getAttempt,
  listSets,
  type SetMeta,
} from "../../lib/api";
import type { LeaveMessage } from "../../hooks/leaveGuardContext";
import { retryWithinBudget } from "../../lib/captureRetry";
import { formatDay } from "../../ui/format";
import type { CompletionResult } from "./finishingSequence";

// The shared shell of the four section Simulations: Set picking, the visibilitychange flag, the
// finishing sequence's bounded-timeout primitives and completion calls, the escape hatch, and the
// messages more than one section shows. Its callers are the four section modules and
// finishingSequence.ts in this directory; the Drills borrow `fallbackSetTitle`, and the Drill shell
// finishes through `useAttemptCompletion`, so a Drill's completion is retried by the same rule.
//
// The shared screens live next door in SimulationScreens.tsx: a module that exports both components
// and non-components is what react/only-export-components warns about.

/**
 * Present exactly when a section Simulation is sat as one section of a Full-Test Run, and the whole
 * of what a Run changes about it: which Set it loads (the one the Run drew), the Run named on the
 * Attempt it creates, where it goes when it finishes (back to the Run), and the intro's back link and
 * title. `attemptId` is the Attempt the Run currently records for this section — the only one a
 * section that keeps a draft (Writing) may pick back up. Absent, every Simulation is its standalone
 * `/simulate/:kind` self.
 */
export type FullTestSectionContext = { runId: string; setId: string; attemptId?: string | null };

/**
 * Tells a Full-Test Run this section is done, on the way out of a section Simulation.
 *
 * A failed advance is logged and ignored: the Run derives every section's state from its Attempt on
 * every read, so a lost call costs the Run its `currentSection` cursor and nothing else — any later
 * advance catches it up, and the Run page fires the finishing advance itself when nothing is left to
 * sit. Stranding the User on a wrap-up screen over it would be worse than a stale cursor.
 *
 * Never throws, so a caller can `await` it immediately before navigating.
 */
export async function advanceFullTestSection(runId: string, section: string): Promise<void> {
  try {
    await advanceFullTest(runId);
  } catch (e) {
    console.error(`${section} simulation: advanceFullTest failed`, e);
  }
}

/**
 * The Set a standalone Simulation sits: the newest one the listing marks unattempted, or the newest
 * Set once every one has been attempted. `attempted` is the listing's own flag, the one the
 * practice lists sort by: a Set counts as attempted through an Attempt that has a scored Item, or
 * is completed and holds at least one Item. Automatic because the Simulation entry point
 * (`/simulate/:kind`) carries no setId of its own.
 *
 * Returns the whole listing entry, so the intro can name the Set by its title and say whether this
 * Attempt will be a Repeat from the same answer.
 */
export async function pickSimulationSet(kind: "speaking" | "writing" | "reading" | "listening"): Promise<SetMeta> {
  const sets = await listSets(kind);
  if (sets.length === 0) {
    throw new Error(`There are no ${kind} Sets yet. Generate one from Practice first.`);
  }
  return sets.find((s) => !s.attempted) ?? sets[0];
}

/**
 * A Full-Test Run's own Set as the bank lists it — for its title and whether it has been attempted —
 * or null when the listing cannot be read. The Run already fixed which Set this is, so the
 * lookup is by id across the whole bank and never chooses; a failure costs the intro the Set's title
 * and its Repeat notice, never the section.
 */
export async function findListedSet(setId: string): Promise<SetMeta | null> {
  try {
    const sets = await listSets();
    return sets.find((s) => s.id === setId) ?? null;
  } catch (e) {
    console.error("simulation: the Set listing could not be read", e);
    return null;
  }
}

/**
 * Whether the Attempt this Simulation's intro is about to start will be a Repeat, by the rule POST
 * /api/attempts applies, so the intro's caution and the server's tag agree.
 *
 * A section a Full-Test Run already records an Attempt for (`replacedAttemptId`, the
 * FullTestSectionContext's `attemptId`) is restarted, and a restarted section keeps the tag of the
 * Attempt it replaces. The listing's `attempted` flag cannot stand in for that: the replaced Attempt
 * is often exactly what marks the Set attempted. Anything else is a Repeat when the Set is attempted.
 * If the replaced Attempt cannot be read, the listing's flag is the best guess left; the answer to
 * the start request replaces it either way.
 */
export async function predictRepeat(listing: SetMeta | null, replacedAttemptId?: string | null): Promise<boolean> {
  if (replacedAttemptId) {
    try {
      return (await getAttempt(replacedAttemptId)).attempt.isRepeat;
    } catch (e) {
      console.error("simulation: the replaced Attempt could not be read", e);
    }
  }
  return listing?.attempted ?? false;
}

// Fires POST /:id/flag whenever the tab goes hidden while `active`; AttemptReview renders the
// resulting `flagged` boolean as an "interrupted" note (a prompt that would not play raises the same
// flag, so the note never says the User left). Errors are swallowed: this is a best-effort
// signal, not something worth interrupting a timed section over.
export function useFlagOnHidden(attemptId: string | null, active: boolean) {
  useEffect(() => {
    if (!active || !attemptId) return;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        void flagAttempt(attemptId).catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [attemptId, active]);
}

// `promise`, or a rejection once `ms` has passed. Never cancels the underlying request (fetch has no
// cheap cancel here) — it only stops waiting on it, so a connection that never answers cannot hold a
// caller forever. The rejection's message is a sentence, because requestErrorMessage shows it as is.
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The server didn't answer within ${Math.round(ms / 1000)} seconds.`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// How long Speaking's "Wrapping up…" screen sits before offering its escape link to the report:
// long enough not to flash on a normal finish, short enough that nobody wonders whether it is stuck.
const ESCAPE_HATCH_DELAY_MS = 20_000;
// The finishing sequence's overall budgets (finishingSequence.ts). Both sections' settle steps are
// bounded by their own retry budgets and per-request timeouts, so these are backstops: past one, the
// sequence waits FINISH_SEQUENCE_GUARD_MS more on the same chain and then navigates anyway, while
// the chain keeps running. Speaking's must stay above its uploads' final retry budget plus the
// capture marker's, or the backstop would routinely cut those retries off.
export const SPEAKING_FINISHING_TIMEOUT_MS = 3 * 60_000;
export const WRITING_FINISHING_TIMEOUT_MS = 4 * 60_000;
export const FINISH_SEQUENCE_GUARD_MS = 15_000;
// Bounds each completion/capture-marker request.
const COMPLETION_REQUEST_TIMEOUT_MS = 15_000;

/** The HTTP status of a failed request, read by shape as requestError.ts does: suites mock lib/api.ts. */
function httpStatus(e: unknown): number | null {
  const status = e instanceof Error ? (e as { status?: unknown }).status : undefined;
  return typeof status === "number" ? status : null;
}

/**
 * A refusal that says the Attempt is already completed: an earlier POST /:id/complete landed and
 * only its reply was lost, so the completion is done. Any other refusal (an aborted Attempt, an
 * unknown one) is not.
 */
function isAlreadyCompleted(e: unknown): boolean {
  return httpStatus(e) === 409 && e instanceof Error && /\bcompleted\b/.test(e.message);
}

/** The server read the request and refused it; sending it again cannot help. */
function isRefused(e: unknown): boolean {
  const status = httpStatus(e);
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * How sending the request that ends an Attempt ended.
 *
 * - `completed` — the server has it (now, or already).
 * - `failed`    — a refusal, or the retry budget ran out; `error` is the last failure, for
 *                 requestErrorMessage.
 * - `abandoned` — the caller stopped wanting an answer partway through; do nothing with it.
 */
export type CompletionOutcome = { kind: "completed" } | { kind: "failed"; error: unknown } | { kind: "abandoned" };

const ABANDONED = new Error("completion abandoned");

/**
 * Sends `request` until it lands, with the Module submit's retry policy (retryWithinBudget: a
 * wall-clock budget with backoff) and each request bounded. A failure that may pass (no answer, a
 * timeout, a 5xx, a 408 or 429) is retried; a refusal stops at once, except the one saying the
 * Attempt is already completed, which is success. Stops before its next request once `stillActive`
 * turns false. `what` names the request in the log ("reading simulation: completeAttempt"). Never
 * throws.
 *
 * The one copy of the rule for every request that ends an Attempt: POST /:id/complete from a
 * Simulation or a Drill, and Speaking's capture marker.
 */
async function landWithinBudget(
  request: () => Promise<unknown>,
  what: string,
  stillActive: () => boolean,
): Promise<CompletionOutcome> {
  let lastError: unknown = null;
  const landed = await retryWithinBudget(
    async () => {
      if (!stillActive()) throw ABANDONED;
      try {
        await withTimeout(request(), COMPLETION_REQUEST_TIMEOUT_MS);
      } catch (e) {
        if (isAlreadyCompleted(e)) return;
        throw e;
      }
    },
    { now: () => Date.now(), sleep },
    (attempt, e) => {
      if (e === ABANDONED) return;
      lastError = e;
      console.error(`${what} attempt ${attempt} failed`, e);
    },
    undefined,
    (e) => e === ABANDONED || isRefused(e),
  );
  if (!stillActive()) return { kind: "abandoned" };
  return landed ? { kind: "completed" } : { kind: "failed", error: lastError };
}

/**
 * POST /:id/complete until it lands (landWithinBudget). `caller` names the flow in the log
 * ("reading simulation", "writing drill").
 */
export function completeAttemptWithinBudget(
  attemptId: string,
  caller: string,
  stillActive: () => boolean,
): Promise<CompletionOutcome> {
  return landWithinBudget(() => completeAttempt(attemptId), `${caller}: completeAttempt`, stillActive);
}

/** A detached completion call's answer for the finishing sequence: it never abandons. */
function asCompletionResult(outcome: CompletionOutcome): CompletionResult {
  return outcome.kind === "failed" ? outcome : { kind: "completed" };
}

// The Writing Simulation's completion call, made only once the server has every Response, and
// retried like the Reading and Listening one. Detached (it never stops on its own), because the
// finishing sequence runs it to the end even after the User has left the page. A failure goes back
// to the sequence, which reports it, so the section shows it with Retry rather than hand off.
export async function completeWritingAttempt(attemptId: string): Promise<CompletionResult> {
  return asCompletionResult(await completeAttemptWithinBudget(attemptId, "writing simulation", () => true));
}

// The Speaking Simulation's completion call: POST /:id/capture-finished, after which the server's
// own reconciliation completes the Attempt once judging lands. Retried like POST /:id/complete
// (landWithinBudget), and detached like Writing's, because a missing marker strands the Attempt —
// the server only ever reconciles Attempts that carry it. A failure goes back to the finishing
// sequence, so the section shows it with Retry rather than hand off.
//
// `uploadFailedItemIds` is read by the caller after every upload has settled, so it is the final
// list; retries, the User's included, reuse it unchanged because the POST is idempotent and the
// marker never moves.
export async function markSpeakingCaptureFinished(
  attemptId: string,
  uploadFailedItemIds: string[],
): Promise<CompletionResult> {
  return asCompletionResult(
    await landWithinBudget(
      () => finishSpeakingCapture(attemptId, uploadFailedItemIds),
      "speaking simulation: finishSpeakingCapture",
      () => true,
    ),
  );
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Where completing an Attempt stands. `failed` carries the last failure, for requestErrorMessage;
 * `retry` starts another round from the failure's Retry.
 */
export type AttemptCompletion = {
  status: "completing" | "completed" | "failed";
  error: unknown;
  retry: () => void;
};

/**
 * Once `active`, complete the Attempt (completeAttemptWithinBudget), and say where that stands.
 *
 * The terminal step of the Reading and Listening Simulations: completing is what gives the Attempt
 * its Band Estimate and releases the key and Explanations, and inside a Full-Test Run it is what
 * makes the section finished, so a failure is not passed over: the section shows it, with Retry,
 * and the hand-off (useHandOffOnceCompleted) waits for `completed`. The Drill shell runs its finish
 * through it too. `caller` names the flow in the log ("reading simulation", "writing drill").
 *
 * Separate from the hand-off so the leave guard, which the hand-off navigates through, can read
 * `status` and drop once the Attempt is completed. Each round stops retrying when the caller
 * unmounts or a newer round starts.
 */
export function useAttemptCompletion(active: boolean, attemptId: string | null, caller: string): AttemptCompletion {
  const [round, setRound] = useState(0);
  const [outcome, setOutcome] = useState<{ status: "completed" | "failed"; error: unknown } | null>(null);

  useEffect(() => {
    if (!active || !attemptId) return;
    let cancelled = false;
    void completeAttemptWithinBudget(attemptId, caller, () => !cancelled).then((result) => {
      if (cancelled || result.kind === "abandoned") return;
      setOutcome(result.kind === "completed" ? { status: "completed", error: null } : { status: "failed", error: result.error });
    });
    return () => {
      cancelled = true;
    };
  }, [active, attemptId, caller, round]);

  const retry = useCallback(() => {
    setOutcome(null);
    setRound((n) => n + 1);
  }, []);

  return { status: outcome?.status ?? "completing", error: outcome?.error ?? null, retry };
}

/**
 * Hands a Reading or Listening Simulation off once its Attempt is completed: to the report, or
 * inside a Full-Test Run to the Run after telling it this section is done. Never before: a Run
 * advanced past a section whose Attempt is still in progress would offer to sit it again, which
 * replaces a sitting that is already scored. Writing and Speaking hand off the same way from their
 * finishing sequence (finishingSequence.ts).
 */
export function useHandOffOnceCompleted(
  completed: boolean,
  attemptId: string | null,
  leave: (to: string) => void,
  section: "reading" | "listening",
  fullTestRunId?: string,
) {
  useEffect(() => {
    if (!completed || !attemptId) return;
    if (!fullTestRunId) {
      leave(`/attempts/${attemptId}`);
      return;
    }
    let cancelled = false;
    void advanceFullTestSection(fullTestRunId, section).then(() => {
      if (!cancelled) leave(`/full-test/${fullTestRunId}`);
    });
    return () => {
      cancelled = true;
    };
  }, [completed, attemptId, leave, section, fullTestRunId]);
}

// True once `active` has held for ESCAPE_HATCH_DELAY_MS — drives the "This is taking a while" link
// on Speaking's finishing screen. Resets whenever `active` goes false.
export function useFinishingEscapeHatch(active: boolean): boolean {
  const [showEscape, setShowEscape] = useState(false);
  useEffect(() => {
    if (!active) {
      setShowEscape(false);
      return;
    }
    const t = setTimeout(() => setShowEscape(true), ESCAPE_HATCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [active]);
  return showEscape;
}

/**
 * What the leave guard asks before an in-app navigation takes the User out of a running section.
 * Speaking, Reading and Listening keep nothing on this device, so a section left part-way cannot be
 * picked up again: sitting it again starts a new Attempt from the beginning. Writing says something
 * different because it does keep its Responses (see WritingSimulation's drafts). The opening question
 * becomes the leave dialog's title (leaveGuardContext.ts's leavePromptCopy).
 */
export function leaveRestartsSectionMessage(section: "Speaking" | "Reading" | "Listening"): LeaveMessage {
  return `Leave the ${section} section? It can't be resumed. Coming back starts the ${section} section again from the beginning, as a new Attempt.`;
}

/**
 * What the leave guard asks in a Reading or Listening wrap-up, while the Attempt, every Module of it
 * already scored, is still being completed or has failed to be. Leaving loses no Response, but stops
 * the completion, and an unfinished Attempt has no Band Estimate and no review.
 */
export function leaveBeforeCompletedMessage(section: "Reading" | "Listening"): LeaveMessage {
  return `Leave before the ${section} Attempt is finished? Your Responses are scored and kept, but until the Attempt is finished it has no Band Estimate, key or Explanations. Finish and score, on the Progress page, finishes it later.`;
}

/**
 * A Set's name when the listing has none to give (it could not be read): "Reading Set · Sep 1", the
 * design system's fallback. Never the Set's id.
 */
export function fallbackSetTitle(section: string, createdAt: string | undefined): string {
  return createdAt ? `${section} Set · ${formatDay(createdAt)}` : `${section} Set`;
}

/**
 * Whether an Attempt on this Set will be a Repeat, worded for a Simulation's intro (before the User
 * commits to the section) and, in Reading and Listening, its wrap-up. A Repeat never becomes a
 * section's headline band (CONTEXT.md's Repeat), and for Reading and Listening a Simulation is the
 * only source of one, so it is said before starting rather than discovered afterwards.
 */
export function repeatNoticeText(section: "Reading" | "Listening" | "Writing" | "Speaking"): string {
  return `You have practised this Set before, so this Attempt is a Repeat. It will not change your ${section} Band Estimate.`;
}
