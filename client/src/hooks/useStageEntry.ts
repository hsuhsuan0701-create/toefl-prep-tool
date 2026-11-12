import { useLayoutEffect, useRef } from "react";

/**
 * Opens each stage of a Drill or Simulation at its top. The stages of a run (its first screen, each
 * Task, the results or the wrap-up) replace one another inside one route, so the window would keep
 * whatever scroll offset the stage before left, and a new stage would open part-way down with its
 * beginning under the sticky exam header and, in a timed stage, its clock already running.
 *
 * `stage` names the stage on screen; whenever it changes, the window goes back to the top before the
 * new stage is painted. The first stage a page shows is left alone: a route change already opens at
 * the top. Name stages, not Items: moving between the Items of one stage (Next, Back, the question
 * navigator) keeps the page where the User put it.
 */
export function useStageEntry(stage: string): void {
  const shownRef = useRef(stage);
  // A layout effect, so the new stage is never painted at the old offset first. Children's layout
  // effects run before this one, and their focus effects after it, so a stage that focuses its own
  // heading or question does so from the top.
  useLayoutEffect(() => {
    if (shownRef.current === stage) return;
    shownRef.current = stage;
    window.scrollTo({ top: 0, left: 0, behavior: "instant" });
  }, [stage]);
}
