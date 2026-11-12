import { useCallback, useEffect, useRef, useState } from "react";
import type { AttemptListVM, UnloadableSetsVM } from "@toefl-prep/shared";
import { listAttempts, listSets, listUnloadableSets, type SetMeta } from "../lib/api";
import { requestErrorMessage } from "../lib/requestError";

export type PracticeSection = "writing" | "speaking" | "reading" | "listening";
export const PRACTICE_SECTIONS: PracticeSection[] = ["writing", "speaking", "reading", "listening"];

/** How many Attempts one page of the log holds. */
export const ATTEMPT_PAGE_SIZE = 25;
// The server's own per-request ceiling (routes/attempts.ts); a reload of a longer log is split.
const MAX_ATTEMPTS_PER_REQUEST = 100;

export type AttemptLog = {
  /** The Attempts loaded so far, newest first, and how many the whole log holds. */
  attempts: AttemptListVM | null;
  /** Set when the last request failed — alongside whatever was loaded before it, if anything. */
  error?: string;
  loadingMore: boolean;
  reload: () => void;
  /** Appends the next page. A no-op once every Attempt is loaded. */
  loadMore: () => void;
};

/**
 * The Attempt log, a page at a time. `total` comes from the server, so "N attempts" is the true
 * count however few are loaded. A reload re-fetches as many Attempts as are already on screen, so
 * acting on one row of a long log does not collapse it back to the first page.
 */
export function useAttempts(refreshKey = 0, pageSize = ATTEMPT_PAGE_SIZE): AttemptLog {
  const [attempts, setAttempts] = useState<AttemptListVM | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const [localRefresh, setLocalRefresh] = useState(0);
  // Reloads and Load more are sequenced apart, so neither discards the other. Only a newer reload
  // supersedes a reload: a slow one never overwrites a fresher one. A Load more never drops a reload
  // in flight, which may be carrying the row just finished or discarded, and its page is merged by
  // id whichever lands first (see the reload's tail below).
  const reloadSeq = useRef(0);
  const moreSeq = useRef(0);
  const loadedCount = useRef(0);

  const reload = useCallback(() => setLocalRefresh((n) => n + 1), []);

  useEffect(() => {
    const seq = ++reloadSeq.current;
    void fetchFirst(Math.max(pageSize, loadedCount.current))
      .then((page) => {
        if (seq !== reloadSeq.current) return;
        setAttempts((prev) => {
          // A page Load more appended while this reload was in flight lies past what it re-read, and
          // is kept rather than collapsed away.
          const fresh = new Set(page.items.map((a) => a.id));
          const tail = (prev?.items ?? []).slice(page.items.length).filter((a) => !fresh.has(a.id));
          const items = [...page.items, ...tail];
          loadedCount.current = items.length;
          return { items, total: page.total };
        });
        setError(undefined);
      })
      .catch((err) => {
        if (seq === reloadSeq.current) setError(requestErrorMessage(err));
      });
  }, [refreshKey, localRefresh, pageSize]);

  const loadMore = useCallback(() => {
    if (!attempts || attempts.items.length >= attempts.total || loadingMore) return;
    const seq = ++moreSeq.current;
    setLoadingMore(true);
    void listAttempts({ limit: pageSize, offset: attempts.items.length })
      .then((page) => {
        if (seq !== moreSeq.current) return;
        // Appended by id: a row already listed keeps what it shows, which a reload may have
        // refreshed after this page was asked for.
        setAttempts((prev) => {
          const have = prev?.items ?? [];
          const seen = new Set(have.map((a) => a.id));
          const items = [...have, ...page.items.filter((a) => !seen.has(a.id))];
          loadedCount.current = items.length;
          return { items, total: page.total };
        });
        setError(undefined);
      })
      .catch((err) => {
        if (seq === moreSeq.current) setError(requestErrorMessage(err));
      })
      .finally(() => setLoadingMore(false));
  }, [attempts, loadingMore, pageSize]);

  return { attempts, error, loadingMore, reload, loadMore };
}

async function fetchFirst(count: number): Promise<AttemptListVM> {
  const items: AttemptListVM["items"] = [];
  let total = 0;
  for (let offset = 0; offset < count; offset += MAX_ATTEMPTS_PER_REQUEST) {
    const page = await listAttempts({ limit: Math.min(MAX_ATTEMPTS_PER_REQUEST, count - offset), offset });
    items.push(...page.items);
    total = page.total;
    if (items.length >= total || page.items.length === 0) break;
  }
  return { items, total };
}

// The Set files on disk that failed schema validation and are therefore missing from every listing
// above. Its own hook, not another request inside `usePracticeData`, because it costs another full
// server-side pass over the whole Set bank and only the page that renders it (/sets) should pay
// for it.
//
// A failure of this probe itself is swallowed into `null`: a diagnostic that cannot load must never
// put an error banner over a Set bank that loaded perfectly well.
export function useUnloadableSets(): UnloadableSetsVM | null {
  const [unloadable, setUnloadable] = useState<UnloadableSetsVM | null>(null);

  useEffect(() => {
    let cancelled = false;
    listUnloadableSets()
      .then((result) => {
        if (!cancelled) setUnloadable(result);
      })
      .catch(() => {
        if (!cancelled) setUnloadable(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return unloadable;
}

export type SetBanks = {
  sets: Record<PracticeSection, SetMeta[] | null>;
  // Set only for the sections whose own request rejected — see the error-isolation note below.
  errors: Partial<Record<PracticeSection, string>>;
  reload: () => void;
};

// The four Set banks, each entry carrying the server's own `attempted` flag (a Set counts as
// attempted only through an Attempt that has a scored Item, or is completed and holds at least one
// Item).
//
// One failed request must not discard the healthy ones: `Promise.allSettled`, not `Promise.all` —
// each bank settles independently, a fulfilled one updates its own state, and a rejected one is
// recorded in `errors` so its own section can say so instead of rendering "Loading…" forever.
// `errors` is rebuilt fresh from every settle, so a section that failed on a previous refresh but
// succeeds this time drops its error.
export function useSetBanks(refreshKey = 0): SetBanks {
  const [writingSets, setWritingSets] = useState<SetMeta[] | null>(null);
  const [speakingSets, setSpeakingSets] = useState<SetMeta[] | null>(null);
  const [readingSets, setReadingSets] = useState<SetMeta[] | null>(null);
  const [listeningSets, setListeningSets] = useState<SetMeta[] | null>(null);
  const [errors, setErrors] = useState<Partial<Record<PracticeSection, string>>>({});
  const [localRefresh, setLocalRefresh] = useState(0);

  const reload = useCallback(() => setLocalRefresh((n) => n + 1), []);

  useEffect(() => {
    Promise.allSettled([listSets("writing"), listSets("speaking"), listSets("reading"), listSets("listening")]).then(
      ([w, s, r, l]) => {
        if (w.status === "fulfilled") setWritingSets(w.value);
        if (s.status === "fulfilled") setSpeakingSets(s.value);
        if (r.status === "fulfilled") setReadingSets(r.value);
        if (l.status === "fulfilled") setListeningSets(l.value);
        setErrors({
          ...(w.status === "rejected" ? { writing: requestErrorMessage(w.reason) } : {}),
          ...(s.status === "rejected" ? { speaking: requestErrorMessage(s.reason) } : {}),
          ...(r.status === "rejected" ? { reading: requestErrorMessage(r.reason) } : {}),
          ...(l.status === "rejected" ? { listening: requestErrorMessage(l.reason) } : {}),
        });
      },
    );
  }, [refreshKey, localRefresh]);

  return {
    sets: { writing: writingSets, speaking: speakingSets, reading: readingSets, listening: listeningSets },
    errors,
    reload,
  };
}

export type PracticeData = {
  sets: Record<PracticeSection, SetMeta[] | null>;
  attempts: AttemptListVM | null;
  errors: Partial<Record<PracticeSection | "attempts", string>>;
  reload: () => void;
};

// The Dashboard's data: the four Set banks plus the recent-Attempts feed, owned in one place.
// /sets reads `useSetBanks` alone and /progress reads `useAttempts` alone — `listSets` is not cheap
// on the server (each call re-parses the whole bank), and neither page needs the other half.
export function usePracticeData(refreshKey = 0): PracticeData {
  const banks = useSetBanks(refreshKey);
  const log = useAttempts(refreshKey);

  const banksReload = banks.reload;
  const logReload = log.reload;
  const reload = useCallback(() => {
    banksReload();
    logReload();
  }, [banksReload, logReload]);

  return {
    sets: banks.sets,
    attempts: log.attempts,
    errors: { ...banks.errors, ...(log.error ? { attempts: log.error } : {}) },
    reload,
  };
}

// Where each section's Drill and Simulation live. One table rather than four call sites repeating
// the same two string templates.
export const SECTION_ROUTES: Record<PracticeSection, { label: string; linkBase: string; simulateHref: string }> = {
  writing: { label: "Writing", linkBase: "/writing", simulateHref: "/simulate/writing" },
  speaking: { label: "Speaking", linkBase: "/speaking", simulateHref: "/simulate/speaking" },
  reading: { label: "Reading", linkBase: "/reading", simulateHref: "/simulate/reading" },
  listening: { label: "Listening", linkBase: "/listening", simulateHref: "/simulate/listening" },
};
