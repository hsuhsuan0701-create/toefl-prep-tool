import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

export type StageEntryOptions = {
  /**
   * Scroll the window to the top when the stage changes. On by default; off for a step inside a
   * screen that is already where the User is looking (MicCheck's own steps).
   */
  scroll?: boolean;
  /** Where focus goes; omitted, the new stage's own (see focusStage). */
  focusTarget?: RefObject<HTMLElement | null>;
};

/**
 * Opens each stage of a Drill or Simulation at its top, with keyboard focus inside it. The stages
 * of a run (its first screen, each Task, the results or the wrap-up) replace one another inside one
 * route, so the window would keep whatever scroll offset the stage before left, and a new stage
 * would open part-way down with its beginning under the sticky exam header and, in a timed stage,
 * its clock already running. The control that replaced it is gone with the old stage, so focus
 * would fall back to the page body and a keyboard or screen-reader User would start again from the
 * top of the page.
 *
 * `stage` names the stage on screen; whenever it changes, the window goes back to the top before the
 * new stage is painted, and then focus moves into it without scrolling, unless the new stage already
 * took focus itself (a question head, a status heading). The first stage a page shows is left
 * alone: a route change already opens at the top. Name stages, not Items: moving between the Items
 * of one stage (Next, Back, the question navigator) keeps the page where the User put it.
 */
export function useStageEntry(stage: string, { scroll = true, focusTarget }: StageEntryOptions = {}): void {
  const shownRef = useRef(stage);
  const enteredRef = useRef(false);
  // A layout effect, so the new stage is never painted at the old offset first. Children's layout
  // effects run before this one, and their focus effects after it, so a stage that focuses its own
  // heading or question does so from the top.
  useLayoutEffect(() => {
    if (shownRef.current === stage) return;
    shownRef.current = stage;
    enteredRef.current = true;
    if (scroll) window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [stage, scroll]);
  // After the new stage's own effects, so whatever focus it took for itself stands.
  useEffect(() => {
    if (!enteredRef.current) return;
    enteredRef.current = false;
    focusStage(focusTarget?.current ?? null);
  }, [stage, focusTarget]);
}

/**
 * Moves focus into a stage that has just replaced another, without scrolling: to `target` when
 * given, otherwise to the field marked `data-stage-focus` (an essay stage's editor), the stage's
 * heading, or the page's main region. Does nothing while focus is already on something still in the
 * page: either the new stage placed it, or the User did.
 */
function focusStage(target: HTMLElement | null): void {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  const main = document.querySelector("main");
  const next = target ?? main?.querySelector<HTMLElement>("[data-stage-focus]") ?? main?.querySelector<HTMLElement>("h1") ?? main;
  if (!next) return;
  // A heading or a region is not focusable on its own; -1 lets it take focus without joining the
  // Tab order.
  if (next.tabIndex < 0 && !next.hasAttribute("tabindex")) next.setAttribute("tabindex", "-1");
  next.focus({ preventScroll: true });
}
