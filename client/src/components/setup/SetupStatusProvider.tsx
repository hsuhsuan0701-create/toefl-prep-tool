import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { getSetupStatus, type SetupStatus } from "../../lib/api";
import { SetupStatusContext } from "./sectionScorability";

/**
 * Holds the setup status for every screen that reads it through useSectionScorability. It fetches
 * nothing by itself: the first screen that asks starts the request, so a page that never warns about
 * scoring never calls GET /api/setup-status. A failed request keeps the last answer (or none, which
 * reads as `unknown` and warns about nothing). The Dashboard keeps its own useSetupStatus, with its
 * recheck.
 */
export function SetupStatusProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const inFlight = useRef(false);
  const request = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    void getSetupStatus()
      .then(setStatus, () => {})
      .finally(() => {
        inFlight.current = false;
      });
  }, []);
  const value = useMemo(() => ({ status, request }), [status, request]);
  return <SetupStatusContext.Provider value={value}>{children}</SetupStatusContext.Provider>;
}
