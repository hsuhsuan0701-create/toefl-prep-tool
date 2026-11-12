import { useState, type ReactNode } from "react";
import { LeaveGuardContext, leavePromptCopy, type PendingLeave } from "../hooks/leaveGuardContext";
import { ConfirmDialog } from "../ui/ConfirmDialog";

/**
 * Draws the one "Leave …?" dialog for the whole app. A page that mounts useLeaveGuard (a running
 * Drill, Simulation or Full-Test section) never renders the prompt itself: when the router holds a
 * navigation away from it (the browser's Back, the screen's ExamExit, a link), the guard hands the
 * held navigation here and this asks. So every way out of every run gets the same dialog, worded by
 * the page's own message.
 *
 * Mounted once, in App.tsx's root route, inside the data router (useBlocker needs one). Reload and
 * tab close are not routed through here: the browser shows its own beforeunload prompt, which no
 * page can style.
 *
 * Leaving a run costs the User something, so the dialog is destructive-toned and opens with focus on
 * Stay.
 */
export default function LeaveGuardHost({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingLeave | null>(null);
  const copy = pending ? leavePromptCopy(pending.message) : null;
  return (
    <LeaveGuardContext.Provider value={setPending}>
      {children}
      <ConfirmDialog
        open={pending !== null}
        title={copy?.title ?? ""}
        confirmLabel="Leave"
        cancelLabel="Stay"
        tone="destructive"
        onConfirm={() => pending?.leave()}
        onCancel={() => pending?.stay()}
      >
        {copy && <p>{copy.body}</p>}
      </ConfirmDialog>
    </LeaveGuardContext.Provider>
  );
}
