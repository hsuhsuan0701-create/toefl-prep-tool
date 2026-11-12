import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createFullTest } from "../lib/api";
import { requestErrorMessage } from "../lib/requestError";

export type StartFullTest = {
  /** Creates a Full-Test Run and goes to it. Ignored while a start is already in flight. */
  start: () => void;
  starting: boolean;
  /** Why the last start failed, in words; cleared by the next start. */
  error: string | null;
};

/**
 * Starting a Full-Test Run: one request, then the Run's own page. Shared by the Full-Test Run panel
 * and the Dashboard's suggested next step, so both refuse a double click and report a failure the
 * same way.
 */
export function useStartFullTest(): StartFullTest {
  const navigate = useNavigate();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const start = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStarting(true);
    setError(null);
    createFullTest()
      .then((run) => navigate(`/full-test/${run.id}`))
      .catch((err) => {
        if (mounted.current) setError(requestErrorMessage(err));
      })
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) setStarting(false);
      });
  }, [navigate]);

  return { start, starting, error };
}
