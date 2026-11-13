import { useCallback, useEffect, useRef, useState } from "react";
import type { FullTestRunVM, FullTestSectionState } from "@toefl-prep/shared";
import { getFullTest } from "../lib/api";
import { requestErrorMessage } from "../lib/requestError";

// What the Full-Test Run report (FullTestRun.tsx) and the section gate (FullTestSectionRun.tsx) both
// read. They are separate route chunks, so the report never ships the four Simulations the gate
// mounts; this module is the part they share.

/**
 * A section the server says has no runner. Unreachable while all four are runnable, and kept as the
 * honest thing to say if one is ever turned off.
 */
export const NOT_RUNNABLE = "This section cannot be sat inside a Full-Test Run.";

/**
 * Is this section done with: the client-side twin of isTerminalSectionState in
 * server/src/services/fullTestRun.ts.
 */
export function isTerminalSection(state: FullTestSectionState): boolean {
  return state === "completed" || state === "aborted";
}

/**
 * The section a Run in progress waits on, or undefined once every section is finished: the
 * client-side twin of launchableFullTestSection, over the states the server derived. Undefined on a
 * Run in progress means its hand-off was lost: it is finished, its next advance completes it, and
 * the abandon route refuses it.
 */
export function nextSectionToSit(run: FullTestRunVM): FullTestRunVM["sections"][number] | undefined {
  return run.sections.find((s) => !isTerminalSection(s.state));
}

/** Loads one Full-Test Run by id, with a `reload` that keeps the last good copy on screen. */
export function useFullTestRun(runId: string | undefined) {
  const [run, setRun] = useState<FullTestRunVM | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    if (!runId) {
      setError("No Full-Test Run id in the address.");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const fresh = await getFullTest(runId);
      if (!mountedRef.current) return;
      setRun(fresh);
    } catch (e) {
      if (!mountedRef.current) return;
      setError(requestErrorMessage(e));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { run, error, loading, reload };
}
