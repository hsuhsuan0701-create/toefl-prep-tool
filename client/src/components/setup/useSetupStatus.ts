import { useCallback, useEffect, useRef, useState } from "react";
import { getSetupStatus, recheckSetupStatus, type SetupStatus } from "../../lib/api";
import { requestErrorMessage } from "../../lib/requestError";

export type SetupStatusState = {
  /** The last answer, kept through a failed recheck. Null until the first one arrives. */
  status: SetupStatus | null;
  /** When `status` was answered, as ISO-8601. */
  checkedAt: string | null;
  /** Why the last request failed, in words; cleared by the next success. */
  error: string | null;
  /** True once the first request has settled either way. */
  settled: boolean;
  rechecking: boolean;
  /** Asks the server to run its checks again. Ignored while one is in flight. */
  recheck: () => void;
};

/** What this installation can do (GET /api/setup-status), loaded once on mount and re-checked on demand. */
export function useSetupStatus(): SetupStatusState {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settled, setSettled] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const mounted = useRef(true);
  const inFlight = useRef(false);

  const apply = useCallback((request: Promise<SetupStatus>) => {
    inFlight.current = true;
    return request
      .then((next) => {
        if (!mounted.current) return;
        setStatus(next);
        setCheckedAt(new Date().toISOString());
        setError(null);
      })
      .catch((err) => {
        if (mounted.current) setError(requestErrorMessage(err));
      })
      .finally(() => {
        inFlight.current = false;
        if (mounted.current) setSettled(true);
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    void apply(getSetupStatus());
    return () => {
      mounted.current = false;
    };
  }, [apply]);

  const recheck = useCallback(() => {
    if (inFlight.current) return;
    setRechecking(true);
    void apply(recheckSetupStatus()).finally(() => {
      if (mounted.current) setRechecking(false);
    });
  }, [apply]);

  return { status, checkedAt, error, settled, rechecking, recheck };
}
