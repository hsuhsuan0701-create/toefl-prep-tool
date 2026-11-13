import { useEffect, useState } from "react";
import { useLocation, useNavigationType, type Location } from "react-router-dom";
import type { AttemptListVM } from "@toefl-prep/shared";
import { followWhilePageLoads } from "../lib/followIntoView";

// Coming back to an Attempt list (Progress, the Dashboard's Recent Attempts) from an Attempt
// review. Each list page fetches its data again on mount and draws placeholders first, so the
// browser's own scroll restoration finds nothing to scroll to, and a pixel offset would be wrong
// anyway once the parts above the list land. So the row that was opened is remembered, by the
// history entry it was opened from, with where it sat in the window; coming back to that entry,
// the list fetches as many rows as it had, and once the row is on screen it is put back where it
// sat, and kept there while the rest of the page loads.

/** The row an Attempt review was opened from: which Attempt, its top in the window, how many rows were loaded. */
export type RowPlace = { attemptId: string; top: number; rows: number };

/** The page an Attempt review was opened from: its path and the history entry it was opened in. */
export type ReviewOrigin = { path: string; key: string };

const STORE = "toefl-prep:attempt-list-places";
// Enough for any trail of Back presses; older entries are dropped first.
const MAX_PLACES = 20;
// Where the places live when the browser refuses sessionStorage (a private window, blocked site data).
const memory = new Map<string, RowPlace>();

function readPlaces(): [string, RowPlace][] {
  try {
    const raw = window.sessionStorage.getItem(STORE);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as [string, RowPlace][]) : [];
  } catch {
    return [...memory];
  }
}

/** Remembers the row opened from the history entry `locationKey`. */
export function rememberOpenedRow(locationKey: string, place: RowPlace): void {
  const places = [...readPlaces().filter(([key]) => key !== locationKey), [locationKey, place] as [string, RowPlace]].slice(-MAX_PLACES);
  memory.clear();
  for (const [key, value] of places) memory.set(key, value);
  try {
    window.sessionStorage.setItem(STORE, JSON.stringify(places));
  } catch {
    // Kept in memory only: it still serves Back within this page load.
  }
}

function placeFor(locationKey: string): RowPlace | null {
  const found = readPlaces().find(([key]) => key === locationKey)?.[1];
  return found && typeof found.attemptId === "string" && typeof found.top === "number" && typeof found.rows === "number" ? found : null;
}

// The location the app opened on in this page load (App.tsx notes it). A reload reopens the same
// history entry, which is a "POP" like a Back, and should still start at the top; so until the
// first navigation away from it, being there is a fresh visit. A page load that is itself a Back
// (the entry's document was gone) is not.
let documentEntryKey: string | null = null;
let onDocumentEntry = false;
type RouterLike = { state: { location: Location }; subscribe: (fn: (state: { location: Location }) => void) => () => void };
export function noteDocumentEntry(router: RouterLike): void {
  const key = router.state.location.key;
  documentEntryKey = key;
  onDocumentEntry = true;
  const unsubscribe = router.subscribe(({ location }) => {
    if (location.key === key) return;
    onDocumentEntry = false;
    unsubscribe();
  });
}

function cameBackToDocument(): boolean {
  const nav = typeof performance.getEntriesByType === "function" ? performance.getEntriesByType("navigation")[0] : undefined;
  return (nav as PerformanceNavigationTiming | undefined)?.type === "back_forward";
}

/**
 * The row to bring back on arriving at a list page, decided once, on mount: on a Back or Forward
 * to the entry a row was opened from, or through the review's own back link (which names that
 * entry as `returnTo`). Never on a fresh visit: a link, the nav, a reload.
 */
export function useReturnPlace(): RowPlace | null {
  const location = useLocation();
  const navigationType = useNavigationType();
  const [place] = useState(() => {
    if (onDocumentEntry && location.key === documentEntryKey && !cameBackToDocument()) return null;
    // An entry's own row comes first: the entry the back link pushed keeps its `returnTo` on every
    // Back to it, and a row opened from it since is the one to bring back.
    const own = navigationType === "POP" ? placeFor(location.key) : null;
    if (own) return own;
    const returnTo = (location.state as { returnTo?: unknown } | null)?.returnTo;
    return typeof returnTo === "string" ? placeFor(returnTo) : null;
  });
  return place;
}

function rowLink(list: Element, attemptId: string): HTMLElement | null {
  const href = `/attempts/${attemptId}`;
  return [...list.querySelectorAll<HTMLElement>("a[href]")].find((a) => a.getAttribute("href") === href) ?? null;
}

/**
 * Brings the arrival's place into view on the list with id `listId`: the remembered row, put back
 * where it sat in the window, once `attempts` has loaded; the list itself when the row is no longer
 * among those shown (the list changed meanwhile) or when the page was reached at `#<listId>` ("See
 * all N Attempts"). Kept there while the page above it loads, and only until the page is left.
 */
export function useAttemptListArrival(listId: string, attempts: AttemptListVM | null, place: RowPlace | null): void {
  const { hash } = useLocation();
  const [arrivedAtList] = useState(() => !place && hash === `#${listId}`);
  // Turns true once and stays so: a later reload of the list (a row finished or discarded) moves
  // nothing.
  const ready = arrivedAtList || (place !== null && attempts !== null);
  useEffect(() => {
    if (!ready) return;
    const list = document.getElementById(listId);
    if (!list) return;
    const row = place ? rowLink(list, place.attemptId) : null;
    const bringBack =
      row && place
        ? () => window.scrollTo({ top: window.scrollY + row.getBoundingClientRect().top - place.top, behavior: "instant" })
        : () => list.scrollIntoView({ block: "start" });
    bringBack();
    return followWhilePageLoads(bringBack, list.closest("main") ?? document.body);
  }, [listId, ready, place]);
}

/** Link state for a link into an Attempt review, naming the page it was opened from. */
export function useReviewLinkState(): { reviewOrigin: ReviewOrigin } {
  const { pathname, search, key } = useLocation();
  return { reviewOrigin: { path: `${pathname}${search}`, key } };
}

/** The page an Attempt review was opened from, if its link said (useReviewLinkState). */
export function reviewOriginOf(state: unknown): ReviewOrigin | null {
  const origin = (state as { reviewOrigin?: Partial<ReviewOrigin> } | null)?.reviewOrigin;
  return origin && typeof origin.path === "string" && origin.path.startsWith("/") && typeof origin.key === "string"
    ? { path: origin.path, key: origin.key }
    : null;
}
