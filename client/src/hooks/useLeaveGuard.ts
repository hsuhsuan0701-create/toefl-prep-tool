import { useCallback, useContext, useEffect, useRef } from "react";
import { useBlocker, useNavigate, type BlockerFunction } from "react-router-dom";
import { LeaveGuardContext, type LeaveMessage } from "./leaveGuardContext";

/**
 * Asks the browser to confirm before unloading (reload, tab close) while `active`: the half of
 * useLeaveGuard the router cannot hold. Not exported, so a page cannot mount a second guard that
 * disagrees with the one its shell holds.
 *
 * Browsers ignore custom text and only show their own prompt, so no message is supplied. Chrome
 * also shows it only once the User has interacted with the page.
 */
function useUnloadPrompt(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older Chrome ignores preventDefault() here and prompts only when returnValue is assigned.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [active]);
}

export type LeaveGuard = {
  /**
   * Navigates away without asking — for the page's own exits (its hand-off to the report, a "leave
   * anyway" button). The guard's predicate is read when a navigation starts, so flipping `active`
   * off in the same tick as a `navigate` call would not stop the blocker; this is the way through.
   */
  leave: (to: string) => void;
};

/**
 * The guard every Drill and Simulation mounts while its Attempt is under way: reload or close asks
 * the browser to confirm (beforeunload), and in-app navigation — the browser's Back button, a swipe,
 * the screen's own Exit, a link — is held by the router and asked about in LeaveGuardHost's dialog,
 * which shows `message` and stays put unless the User chooses Leave. The message's opening question
 * titles the dialog (leaveGuardContext.ts's leavePromptCopy).
 *
 * Needs a data router (`createBrowserRouter`/`createMemoryRouter`), because useBlocker throws under
 * a plain <BrowserRouter>, and a LeaveGuardHost above the page, because that is what draws the
 * prompt: without one a held navigation would show nothing and never end, so this throws instead.
 */
export function useLeaveGuard(active: boolean, message: LeaveMessage): LeaveGuard {
  const showPrompt = useLeavePromptHost();
  useUnloadPrompt(active);
  const navigate = useNavigate();

  // Read at navigation time, not captured per render, so the page's own `leave` can lift the guard
  // and navigate in one go.
  const activeRef = useRef(active);
  activeRef.current = active;
  const leavingRef = useRef(false);

  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      activeRef.current && !leavingRef.current && currentLocation.pathname !== nextLocation.pathname,
    [],
  );
  const blocker = useBlocker(shouldBlock);
  const blockerRef = useRef(blocker);
  blockerRef.current = blocker;

  // While a navigation is held, the host shows this page's prompt. Re-published when the message
  // changes under an open prompt (a section moving into its wrap-up), and withdrawn if the page
  // goes away with the prompt still up.
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    showPrompt({
      message,
      leave: () => {
        showPrompt(null);
        blocker.proceed();
      },
      stay: () => {
        showPrompt(null);
        blocker.reset();
      },
    });
    return () => showPrompt(null);
  }, [blocker, message, showPrompt]);

  const leave = useCallback(
    (to: string) => {
      leavingRef.current = true;
      // The page's own exit wins over a prompt the User has not answered yet: drop the held
      // navigation and the dialog with it, then go.
      if (blockerRef.current.state === "blocked") {
        showPrompt(null);
        blockerRef.current.reset();
      }
      navigate(to);
    },
    [navigate, showPrompt],
  );

  return { leave };
}

function useLeavePromptHost() {
  const showPrompt = useContext(LeaveGuardContext);
  if (!showPrompt) {
    throw new Error("useLeaveGuard needs a <LeaveGuardHost> above it (App.tsx mounts one in its root route).");
  }
  return showPrompt;
}
