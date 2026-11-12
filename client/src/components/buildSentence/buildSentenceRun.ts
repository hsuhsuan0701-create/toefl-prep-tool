import { blankOrderTexts, emptyBlanks, type SlotFill } from "./sentenceSlotFill";

// Build a Sentence run: the pure state machine for a whole Build a Sentence Task on one pooled time
// budget shared by every Item. Same shape as pages/readingSimulation.ts and listeningSimulation.ts:
// exported state type, exported event type, exported pure transition function, no I/O.
//
// A private internal of the Build a Sentence task module. `BuildSentenceTask` is the one thing that
// drives it: it owns every timer, dispatches outcomes back in as events and reads the committed
// Responses off the "finished" state. Nothing outside this directory imports it.
//
// Two things this machine deliberately does not do:
//
//   1. It never reads the Item's `timeLimitSec`. Generation does not emit that field; only the
//      persisted Item schema declares it, as an optional key, because older banked Writing Sets
//      carry it, and a Set file that fails to parse is skipped and its Attempts lose their review.
//      The budget below is a Task-level constant, whether or not an Item carries that key.
//   2. It never force-advances. Expiry commits what is arranged and ends the Task (see
//      "budget-expired" below) rather than marching the User through the Items they never reached.

/**
 * The whole Build a Sentence Task runs on 410 seconds (6:50) for every Item together.
 *
 * ETS publishes no per-part figure for Build a Sentence, only a Writing section of about 23 minutes
 * with Write an Email at 7:00 and Write for an Academic Discussion at 10:00. 410 s is the figure
 * third-party reporting (Magoosh) gives for the part, and it fits the published total: 410 + 420 +
 * 600 = 1430 s, still "about 23 minutes" once the section's directions are left out. A per-part
 * figure from ETS would outrank it (docs/adr/0009).
 *
 * The budget is pooled, so a minute saved on Item 1 is a minute available on Item 9, which ten
 * separate per-Item clocks could not give.
 */
export const BUILD_A_SENTENCE_BUDGET_SEC = 410;

/**
 * The budget as a clock reading: "6:50".
 *
 * Both call sites describe the budget in their own chrome before this module is mounted. 410 s is
 * not a whole number of minutes, and rounding it would promise seven minutes for a Task that ends
 * at 6:50. Derived from the constant, so the copy cannot drift from the clock the User is racing.
 */
export const BUILD_A_SENTENCE_BUDGET_CLOCK =
  `${Math.floor(BUILD_A_SENTENCE_BUDGET_SEC / 60)}:${String(BUILD_A_SENTENCE_BUDGET_SEC % 60).padStart(2, "0")}`;

/**
 * The only thing this machine needs to know about an Item: its id, and its position in the Task.
 *
 * Structurally a subset of `BuildSentenceItem` (SentenceTiles.tsx), so the Items a caller hands
 * `BuildSentenceTask` go straight in. Everything else about an Item — prompt, Frame, tiles — is the
 * component's business, and the blank count is passed to {@link arrangementOf} rather than read off
 * the Item, because parsing the Frame belongs to the component too.
 */
export type BuildSentenceRunItem = { id: string };

/**
 * One committed Response, in the wire format of `ScoreRequestSchema`'s `build_sentence` member:
 * `{ itemId, tileOrder }`, tile texts in blank order.
 */
export type BuildSentenceResponse = { itemId: string; tileOrder: string[] };

/** Why the Task ended. Both reasons commit through the same path — see {@link commitAll}. */
export type BuildSentenceRunEnd = "finished-early" | "budget-expired";

export type BuildSentenceRunState =
  // Before "begin". Named "idle" rather than "intro" (readingSimulation.ts's spelling) because this
  // machine owns one Task inside a larger flow: the Drill's Task picker and the Simulation's intro
  // screen belong to the pages that mount the module, not to this machine.
  | { stage: "idle" }
  | {
      stage: "running";
      /**
       * Epoch ms. Set once, by "begin" (from the caller's `resume`, or now plus the budget), and
       * never recomputed: no navigation, arrangement change or any other event touches it.
       * Wall-clock rather than elapsed-since-mount, so a system suspend does not pause the budget
       * (useDeadlineCountdown).
       */
      deadlineMs: number;
      /** Which Item the User is looking at. Free navigation — see "next"/"back"/"navigate-to-item". */
      index: number;
      /**
       * Every Item's arrangement so far, keyed by Item id, in the lossless per-blank {@link SlotFill}
       * form: one slot per blank, each slot a tile id or `null`.
       *
       * Not the form a Response is sent in. `blankOrderTexts` drops empty blanks and does not record
       * which ones they were, so an Item restored from it would come back with its tiles shifted
       * left. Storing the lossless form is what makes an Item the User returns to look exactly as
       * they left it, blanks and all.
       */
      arrangements: ReadonlyMap<string, SlotFill>;
    }
  | {
      stage: "finished";
      reason: BuildSentenceRunEnd;
      /**
       * One Response per Item of the Task, in the Set's own Item order — never in visit order — so
       * however much the User navigated back and forth, nothing is duplicated, dropped or reordered.
       */
      responses: readonly BuildSentenceResponse[];
    };

/** The state a call site starts a fresh Build a Sentence Task from. */
export const initialBuildSentenceRunState: BuildSentenceRunState = { stage: "idle" };

export type BuildSentenceRunEvent =
  /**
   * Starts the Task. `resume` supplies a deadline and arrangements the caller already holds, instead
   * of a fresh budget with every Item empty. Arrangements for ids that are not Items of this Task are
   * dropped.
   */
  | { type: "begin"; resume?: { deadlineMs: number; arrangements: ReadonlyMap<string, SlotFill> } }
  /** Every drag inside SentenceTiles, reported as the whole new arrangement of that Item. */
  | { type: "arrangement-changed"; itemId: string; slots: SlotFill }
  /** Straight to one Item, from the review affordance. Clamped: an out-of-range index is a no-op. */
  | { type: "navigate-to-item"; index: number }
  | { type: "next" }
  | { type: "back" }
  | { type: "finish-early" }
  | { type: "budget-expired" };

/**
 * Pure transition function. Every branch that does not match the event's required stage returns the
 * same state reference unchanged: a structural no-op, never a throw. A duplicate "budget-expired"
 * racing a manual "finish-early" is expected, not exceptional, as in the Reading and Listening
 * Simulation reducers.
 *
 * `items` is the Task's Items in Set order. It is read only by the branches that need to know how
 * many Items there are, or which ids belong to the Task ("begin", "next", "navigate-to-item",
 * "arrangement-changed", and the two ending branches); nothing about an Item other than its id and
 * its position is ever consulted, and `timeLimitSec` in particular never is.
 */
export function reduceBuildSentenceRun(
  state: BuildSentenceRunState,
  ev: BuildSentenceRunEvent,
  items: readonly BuildSentenceRunItem[],
): BuildSentenceRunState {
  switch (ev.type) {
    case "begin":
      if (state.stage !== "idle") return state;
      return {
        stage: "running",
        deadlineMs: ev.resume?.deadlineMs ?? Date.now() + BUILD_A_SENTENCE_BUDGET_SEC * 1000,
        index: 0,
        arrangements: new Map(
          [...(ev.resume?.arrangements ?? [])].filter(([itemId]) => items.some((item) => item.id === itemId)),
        ),
      };

    case "arrangement-changed": {
      if (state.stage !== "running") return state;
      // An id that belongs to no Item of this Task is ignored, so the arrangement map can only ever
      // hold Items this Task will actually commit.
      if (!items.some((item) => item.id === ev.itemId)) return state;
      const arrangements = new Map(state.arrangements);
      arrangements.set(ev.itemId, ev.slots);
      return { ...state, arrangements };
    }

    // Navigation never touches deadlineMs: the budget is pooled, so moving between Items neither
    // resets nor extends it. Each branch also returns the same state reference when the move would
    // not go anywhere, so "Back on Item 1" and "jump to the Item you are already on" are no-ops.
    case "navigate-to-item":
      if (state.stage !== "running") return state;
      if (!Number.isInteger(ev.index) || ev.index < 0 || ev.index >= items.length) return state;
      if (ev.index === state.index) return state;
      return { ...state, index: ev.index };

    // Clamps at the last Item rather than ending the Task. With free navigation and a review
    // affordance, running off the end of the Items is not a decision to submit: "finish-early" is
    // the one manual way to end, so a stray Next on the last Item cannot burn the remaining budget.
    case "next":
      if (state.stage !== "running") return state;
      if (state.index + 1 >= items.length) return state;
      return { ...state, index: state.index + 1 };

    case "back":
      if (state.stage !== "running") return state;
      if (state.index === 0) return state;
      return { ...state, index: state.index - 1 };

    // The two ways a Build a Sentence Task ends, sharing one commit path so early finishing and
    // expiry cannot drift apart. Expiry does not advance through the remaining Items: it commits
    // whatever is arranged, records the rest as empty Responses, and hands the Responses to the
    // caller. Items never reached score zero through that ordinary empty-Response path; there is no
    // separate mechanism for them, and none is needed.
    case "finish-early":
    case "budget-expired":
      if (state.stage !== "running") return state;
      return {
        stage: "finished",
        reason: ev.type === "budget-expired" ? "budget-expired" : "finished-early",
        responses: commitAll(state.arrangements, items),
      };

    default:
      return state;
  }
}

/**
 * The commit path shared by "finish-early" and "budget-expired".
 *
 * Walks the Task's Items in Set order, not visit order, and emits one Response for every one of
 * them: the arrangement if the Item carries one, an empty `tileOrder` if it does not. The lossless
 * arrangement becomes the Response's `tileOrder` through `blankOrderTexts` (tile texts in blank
 * order, empty blanks dropped).
 */
function commitAll(
  arrangements: ReadonlyMap<string, SlotFill>,
  items: readonly BuildSentenceRunItem[],
): BuildSentenceResponse[] {
  return items.map((item) => {
    const slots = arrangements.get(item.id);
    return { itemId: item.id, tileOrder: slots === undefined ? [] : blankOrderTexts(slots) };
  });
}

/**
 * Whether an arrangement counts as a Response: at least one blank filled.
 *
 * An Item visited and left completely empty is indistinguishable from one never visited, and should
 * be — both commit as an empty `tileOrder` and score the same.
 */
export function carriesResponse(slots: SlotFill | undefined): boolean {
  return slots !== undefined && slots.some((tileId) => tileId !== null);
}

/**
 * Which Items currently carry a Response: the derivation behind the review affordance, which
 * has to distinguish answered from unanswered across every Item without the User clicking
 * backwards blindly to find out.
 *
 * Empty before the Task begins and after it ends; while running, exactly the Item ids whose
 * arrangement has at least one filled blank.
 */
export function respondedItemIds(state: BuildSentenceRunState): ReadonlySet<string> {
  if (state.stage !== "running") return new Set();
  const responded = new Set<string>();
  for (const [itemId, slots] of state.arrangements) {
    if (carriesResponse(slots)) responded.add(itemId);
  }
  return responded;
}

/**
 * The arrangement to render for one Item: what the User left there, or a fresh all-empty arrangement
 * of `blankCount` blanks if they have not touched it yet.
 *
 * `blankCount` is passed in rather than derived here because parsing the Item's Frame is the
 * component's job (see `emptySlotsForFrame` in sentenceSlotFill.ts), and a frameless Item, from a
 * Set banked before Frames existed, has no blanks at all.
 */
export function arrangementOf(state: BuildSentenceRunState, itemId: string, blankCount: number): SlotFill {
  if (state.stage !== "running") return emptyBlanks(blankCount);
  return state.arrangements.get(itemId) ?? emptyBlanks(blankCount);
}
