/** How long an arrival keeps its target in place while the page around it loads. */
export const FOLLOW_MS = 3000;
/** What the User does to scroll the page themselves, which ends that. */
const TAKES_OVER_SCROLL = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/**
 * Keeps a place in the page where an arrival put it while the page is still loading. A page fetches
 * its parts on mount and draws placeholders first, so each part that lands above the place pushes
 * it down after the scroll has been made: `place` is called again whenever `page` changes height,
 * until the page has had FOLLOW_MS to finish loading or the User scrolls. Returns what stops it,
 * which the caller runs on unmount so a later page is never scrolled by an earlier one.
 */
export function followWhilePageLoads(place: () => void, page: Element): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const observer = new ResizeObserver(() => place());
  observer.observe(page);
  const stop = () => {
    observer.disconnect();
    window.clearTimeout(timer);
    for (const type of TAKES_OVER_SCROLL) window.removeEventListener(type, stop);
  };
  const timer = window.setTimeout(stop, FOLLOW_MS);
  for (const type of TAKES_OVER_SCROLL) window.addEventListener(type, stop, { passive: true });
  return stop;
}
