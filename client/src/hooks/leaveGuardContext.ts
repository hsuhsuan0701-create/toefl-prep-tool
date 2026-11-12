import { createContext } from "react";

// The channel between useLeaveGuard (which knows when a navigation is being held) and
// LeaveGuardHost (which draws the one dialog that asks about it). Kept apart from both so the host's
// file exports only a component (react/only-export-components).

/**
 * What leaving costs, in the page's own words: a question that titles the dialog, then the body
 * ("Leave this Drill? Every Stimulus you checked stays scored, …"). The type holds every message to
 * that shape, so the dialog always has its title.
 */
export type LeaveMessage = `${string}? ${string}`;

/** A navigation the leave guard is holding, and the two ways out of it. */
export type PendingLeave = {
  /** The page's own words for what leaving costs right now. */
  message: LeaveMessage;
  /** Let the held navigation through. */
  leave: () => void;
  /** Drop it and stay on the page. */
  stay: () => void;
};

/** Shows a held navigation's prompt, or clears it with `null`. Null when no host is mounted. */
export const LeaveGuardContext = createContext<((pending: PendingLeave | null) => void) | null>(null);

/**
 * Splits a leave message into the dialog's title, its opening question ("Leave the Reading
 * section?"), and its body, the rest ("It can't be resumed…").
 */
export function leavePromptCopy(message: LeaveMessage): { title: string; body: string } {
  const end = message.indexOf("? ") + 1;
  return { title: message.slice(0, end).trim(), body: message.slice(end).trim() };
}
