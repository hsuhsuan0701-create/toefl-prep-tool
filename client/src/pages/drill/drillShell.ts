import { useCallback, useEffect, useRef, useState } from "react";
import { expectServedSet, type ServedSetKind, type ServedSetOfKind } from "@toefl-prep/shared";
import type { LeaveMessage } from "../../hooks/leaveGuardContext";
import { useLeaveGuard } from "../../hooks/useLeaveGuard";
import { createAttempt, getSet, listSets, type SetMeta } from "../../lib/api";
import { requestErrorMessage } from "../../lib/requestError";
import { useAttemptCompletion } from "../simulation/simulationShell";

// ---------------------------------------------------------------------------
// The shared shell of the four Drills: everything the Speaking, Writing, Reading and Listening
// Drill pages need around their own run body. It loads the Set, owns the fatal error surface,
// creates the Attempt (and with it the Repeat tag), holds the leave guard while that Attempt is
// open, and applies the finish-and-navigate rule. The four Drill pages in ../ are its only callers.
//
// The shell's screens live next door in DrillScreens.tsx, as SimulationScreens.tsx sits beside
// simulationShell.ts: a module that exports both components and non-components is what
// react/only-export-components warns about, so behaviour and chrome are two files.
//
// Each Drill's run body stays with its page, because those genuinely differ: recording with retry
// chips, essay editing, and the deterministic Stimulus queue (one run body for Reading and
// Listening, ./StimulusQueueRun.tsx). Speaking's mic check stays with Speaking as part of its
// capture flow.
// ---------------------------------------------------------------------------

/**
 * Where the shell itself is, independent of whichever stage the page's own run flow is in.
 *
 * `loading` and `error` are full-screen: a page in either renders the shared screen and nothing of
 * its own. `ready` means the Set is loaded and the page's own stage machine decides the render.
 */
export type DrillPhase = "loading" | "error" | "ready";

export type DrillShell<K extends ServedSetKind> = {
  /** See DrillPhase. Starts at "loading" and re-enters it whenever `setId` changes. */
  phase: DrillPhase;
  /** The loaded Set, narrowed to this Drill's section. Non-null exactly while `phase` is "ready". */
  set: ServedSetOfKind<K> | null;
  /**
   * The message the error screen shows — and, for a page that renders it inline instead (Speaking's
   * intro after its mic check), the message it shows there. `null` renders the error screen's own
   * fallback copy.
   */
  errorMsg: string | null;
  /**
   * Fails the whole page: `phase` becomes "error" and `errorMsg` carries the failure in words
   * (`requestErrorMessage`).
   */
  fail: (e: unknown) => void;
  /**
   * Takes a failed Drill back to its run: `phase` returns to "ready" and `errorMsg` is cleared, which
   * also puts the leave guard back up. For a failure the page can send again from the error screen
   * (Writing's Build a Sentence commit); a failed Set load has nothing to return to.
   */
  resume: () => void;
  /**
   * Sets or clears `errorMsg` without leaving the current phase — for a failure a page shows inline
   * and recovers from in place (SpeakingDrill's intro, whose failed Attempt creation leaves the User
   * there with the message above the start button).
   */
  setErrorMsg: (msg: string | null) => void;
  attemptId: string | null;
  /**
   * The Attempt's Repeat tag (CONTEXT.md's Repeat), as the server decided it when it created the
   * Attempt. A Repeat is allowed and tagged, and never becomes the section's headline Band Estimate.
   * Every Drill's repeat notice reads this one field.
   */
  isRepeat: boolean;
  /**
   * Creates this Drill's Attempt — `{ kind, mode: "drill", setId }`, always — and stores the
   * `attemptId`/`isRepeat` it comes back with. Rejects on failure so the caller decides what that
   * means: three Drills call `fail`, Speaking shows it inline and stays on Ready.
   */
  beginAttempt: () => Promise<void>;
  /**
   * Whether leaving now asks first: true from the moment the Attempt exists until `finish`, and not
   * on the error screen. Exits label themselves from it (ExamExit's "Exit…" against a plain "Exit").
   */
  guarded: boolean;
  /**
   * The finish-and-navigate rule, once: complete the Attempt, then leave without the leave guard
   * asking. The completion is retried as a Simulation's is (useAttemptCompletion); while it runs a
   * second press does nothing. If it still fails, the results screen says so (`completion`, drawn
   * by DrillCompletionFailed) with Retry, and a Retry that lands leaves for where the press was
   * going. A press after the failure leaves at once, without completing: a Drill has no Band
   * Estimate to lose, so a completion that cannot be made never keeps the User here, and the
   * Attempt stays Unfinished in the Attempt log until Finish and score on the Progress page.
   *
   * `to` defaults to the Dashboard. SpeakingDrill passes the Attempt report instead when something
   * in the run went to transcription recovery, because that report is the only screen showing it.
   */
  finish: (to?: string) => void;
  /** Where `finish`'s completion stands, for the results screen. */
  completion: DrillCompletion;
};

/**
 * Where completing a Drill's Attempt stands: `idle` until the finish button is pressed,
 * `finishing` while the completion runs (and on its way out once it lands), `failed` once its
 * retries ran out. `error` is the last failure, for requestErrorMessage; `retry` runs the
 * completion again.
 */
export type DrillCompletion = {
  status: "idle" | "finishing" | "failed";
  error: unknown;
  retry: () => void;
};

/**
 * What leaving a Drill with its Attempt open costs, as LeaveGuardHost's dialog says it: the question
 * is the dialog's title. True on every screen the guard is up for, the results screen included,
 * where only `finish` completes the Attempt.
 */
const LEAVE_MESSAGE: Record<ServedSetKind, LeaveMessage> = {
  reading: "Leave this Drill? Every Stimulus you checked stays scored, and the Attempt is left Unfinished.",
  listening: "Leave this Drill? Every Stimulus you checked stays scored, and the Attempt is left Unfinished.",
  writing: "Leave this Drill? What you have handed in is kept and scored, and the Attempt is left Unfinished.",
  speaking: "Leave this Drill? Recordings already sent are kept and scored, and the Attempt is left Unfinished.",
};

/**
 * The Drill shell: hand it the section and the route's `setId`, get back the Set, the Attempt, and
 * the finish rule.
 *
 * One implementation of what all four Drills need — the cancellable load, the error funnel, the
 * `createAttempt({ kind, mode: "drill", setId })` plus `isRepeat` wiring, the leave guard, and the
 * complete-then-leave finish — so "all four Drills tag a Repeat, ask before leaving and finish
 * identically" is true by construction.
 *
 * The guard (useLeaveGuard) is up from the moment the Attempt exists until `finish`, unless the Drill
 * has failed. The screen's Exit and the browser's Back ask first in the same dialog a Simulation
 * uses (LeaveGuardHost); a reload or a closed tab gets the browser's own prompt.
 */
export function useDrillShell<K extends ServedSetKind>(kind: K, setId: string | undefined): DrillShell<K> {
  const [phase, setPhase] = useState<DrillPhase>("loading");
  const [set, setSet] = useState<ServedSetOfKind<K> | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [isRepeat, setIsRepeat] = useState(false);
  // Down once the Drill has failed: its error screen is a dead end, and asking on the way out of it
  // would only stand between the User and Practice.
  const guarded = attemptId !== null && phase !== "error";
  const { leave } = useLeaveGuard(guarded, LEAVE_MESSAGE[kind]);

  // `beginAttempt` awaits a POST that can outlive the page, so it stores nothing once the page has
  // unmounted: an Attempt id that arrives after the User left is never used.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fail = useCallback((e: unknown) => {
    setErrorMsg(requestErrorMessage(e));
    setPhase("error");
  }, []);

  const resume = useCallback(() => {
    setErrorMsg(null);
    setPhase("ready");
  }, []);

  // Cancellable, re-run on `setId`, and narrowing with `expectServedSet` inside the `then`, so a
  // wrong-section Set throws into the same `catch` a failed fetch does (expectServedSet's doc
  // comment in shared/src/servedSet.ts relies on that).
  useEffect(() => {
    if (!setId) return;
    let cancelled = false;
    setPhase("loading");
    getSet(setId)
      .then((s) => {
        if (cancelled) return;
        setSet(expectServedSet(kind, s));
        setPhase("ready");
      })
      .catch((e) => {
        if (cancelled) return;
        setErrorMsg(requestErrorMessage(e));
        setPhase("error");
      });
    return () => {
      cancelled = true;
    };
  }, [setId, kind]);

  const beginAttempt = useCallback(async () => {
    if (!setId) throw new Error("no setId");
    const res = await createAttempt({ kind, mode: "drill", setId });
    if (!mountedRef.current) return;
    setAttemptId(res.attemptId);
    setIsRepeat(res.isRepeat);
  }, [kind, setId]);

  // Where the pressed finish is going; null until the finish button is pressed. Setting it is what
  // starts the completion.
  const [finishTo, setFinishTo] = useState<string | null>(null);
  const attemptCompletion = useAttemptCompletion(finishTo !== null, attemptId, `${kind} drill`);

  useEffect(() => {
    if (finishTo !== null && attemptCompletion.status === "completed") leave(finishTo);
  }, [finishTo, attemptCompletion.status, leave]);

  const finish = useCallback(
    (to = "/") => {
      if (!attemptId) {
        leave(to);
        return;
      }
      if (finishTo === null) {
        setFinishTo(to);
        return;
      }
      if (attemptCompletion.status === "failed") leave(to);
    },
    [attemptId, finishTo, attemptCompletion.status, leave],
  );

  const completion: DrillCompletion = {
    status: finishTo === null ? "idle" : attemptCompletion.status === "failed" ? "failed" : "finishing",
    error: attemptCompletion.error,
    retry: attemptCompletion.retry,
  };

  return { phase, set, errorMsg, fail, resume, setErrorMsg, attemptId, isRepeat, guarded, beginAttempt, finish, completion };
}

/**
 * This Drill's Set as the bank lists it — for its title on the picker and the intro — or null until
 * it arrives or when it cannot be read. Best-effort: the Drill runs on `getSet` alone, so a failed
 * listing costs the title and nothing else.
 */
export function useListedSet(kind: ServedSetKind, setId: string | undefined): SetMeta | null {
  const [entry, setEntry] = useState<SetMeta | null>(null);
  useEffect(() => {
    if (!setId) return;
    let cancelled = false;
    void (async () => {
      try {
        const sets = await listSets(kind);
        if (!cancelled) setEntry(sets.find((s) => s.id === setId) ?? null);
      } catch {
        // The title is a nicety here; the Drill itself does not depend on the listing.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, setId]);
  return entry;
}
