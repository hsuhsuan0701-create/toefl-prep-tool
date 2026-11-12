// What the Writing Simulation mirrors to sessionStorage, so a reload — or coming back to the page in
// the same tab — does not lose a Response: one record for the section in progress (which Attempt,
// which Task, when its clock runs out) and one draft per Item. sessionStorage rather than
// localStorage because it lives exactly as long as the tab, and that is as long as the sitting can
// still be picked up.
//
// Every access is wrapped: storage can be unavailable or full (private windows, blocked site data),
// and the Simulation must run the same without it — it only loses the ability to restore.

export type WritingTask = "build_sentence" | "email" | "discussion";

export type WritingSession = {
  attemptId: string;
  setId: string;
  /** The Task on screen, or "finishing" once all three have been handed in. */
  task: WritingTask | "finishing";
  /** When the running Task's clock reaches zero (epoch ms). Null once the section is finishing. */
  deadlineMs: number | null;
  /** Tasks whose Responses the server has accepted; their drafts are already gone. */
  accepted: WritingTask[];
};

/**
 * One Item's Response as last seen on screen: an essay's text (plus the seconds it took, once handed
 * in), or a Build a Sentence arrangement as tile texts per blank. Texts, not tile ids: the server
 * serves the tiles in a fresh order on every request, so an id from before a reload names a
 * different tile after it.
 */
export type ItemDraft = { text?: string; secondsUsed?: number; slots?: (string | null)[] };

const sessionKey = (scope: string) => `toefl.writingSimulation.${scope}`;
const draftKey = (attemptId: string, itemId: string) => `toefl.draft.${attemptId}.${itemId}`;

function read<T>(key: string): T | null {
  try {
    const raw = window.sessionStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable: the Response still goes to the server as normal.
  }
}

function remove(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // Nothing to clean up if storage cannot be reached.
  }
}

/** `scope` is the Full-Test Run id when the section is sat inside one, else "standalone". */
export const readWritingSession = (scope: string) => read<WritingSession>(sessionKey(scope));
export const writeWritingSession = (scope: string, session: WritingSession) => write(sessionKey(scope), session);
export const clearWritingSession = (scope: string) => remove(sessionKey(scope));

export const readDraft = (attemptId: string, itemId: string) => read<ItemDraft>(draftKey(attemptId, itemId));
export const writeDraft = (attemptId: string, itemId: string, draft: ItemDraft) => write(draftKey(attemptId, itemId), draft);
export const clearDraft = (attemptId: string, itemId: string) => remove(draftKey(attemptId, itemId));
