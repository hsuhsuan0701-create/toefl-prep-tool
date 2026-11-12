import { useEffect, useState } from "react";
import type { ReasoningStatusVM } from "@toefl-prep/shared";
import { getReasoningStatus } from "../lib/api";

const REFRESH_INTERVAL_MS = 30_000;

export function useProviderStatus(): ReasoningStatusVM | null {
  const [status, setStatus] = useState<ReasoningStatusVM | null>(null);

  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      void getReasoningStatus()
        .then((next) => {
          if (mounted) setStatus(next);
        })
        .catch(() => {
          // Provider visibility is best-effort. Retain the last good snapshot so a transient
          // network failure never blocks the dashboard or turns known status into fabricated data.
        });
    };

    refresh();
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, []);

  return status;
}
