import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./fakeTimers";
import {
  BUILD_A_SENTENCE_BUDGET_CLOCK,
  BUILD_A_SENTENCE_BUDGET_SEC,
  arrangementOf,
  carriesResponse,
  initialBuildSentenceRunState,
  reduceBuildSentenceRun,
  respondedItemIds,
  type BuildSentenceRunEvent,
  type BuildSentenceRunState,
} from "../src/components/buildSentence/buildSentenceRun";
import { emptyBlanks, tileIdOf, type SlotFill } from "../src/components/buildSentence/sentenceSlotFill";

// The Task's ten Items, in the shape the two call sites hand in. The reducer reads only `id` and
// position (BuildSentenceRunItem), so every deadline assertion below is also a standing check that
// the budget is derived from nothing on the Item.
const items = Array.from({ length: 10 }, (_, i) => ({
  id: `bs-${i + 1}`,
  prompt: `Item ${i + 1}`,
  frame: "The ___ ___ ___.",
  tiles: ["cat", "sat", "down", "quickly"],
}));

const ALL_EVENTS: BuildSentenceRunEvent[] = [
  { type: "begin" },
  { type: "arrangement-changed", itemId: "bs-1", slots: [tileIdOf("cat", 0), null, null] },
  { type: "navigate-to-item", index: 3 },
  { type: "next" },
  { type: "back" },
  { type: "finish-early" },
  { type: "budget-expired" },
];

function reduce(state: BuildSentenceRunState, ev: BuildSentenceRunEvent): BuildSentenceRunState {
  return reduceBuildSentenceRun(state, ev, items);
}

function reduceAll(state: BuildSentenceRunState, evs: BuildSentenceRunEvent[]): BuildSentenceRunState {
  return evs.reduce(reduce, state);
}

/** A running state that has already begun, for the branches that do not care how it began. */
function running(overrides: Partial<Extract<BuildSentenceRunState, { stage: "running" }>> = {}): BuildSentenceRunState {
  return { stage: "running", deadlineMs: 1_000_000, index: 0, arrangements: new Map(), ...overrides };
}

describe("reduceBuildSentenceRun", () => {
  beforeEach(() => {
    useFakeTimersInTest();
    vi.setSystemTime(new Date("2026-08-22T00:00:00.000Z"));
  });

  describe("the pooled budget", () => {
    it("is 410 seconds for the whole Task, not 40 per Item", () => {
      // 410 s = 6:50, the figure reported for the real Build a Sentence part.
      expect(BUILD_A_SENTENCE_BUDGET_SEC).toBe(410);
      // 10 x 40 = 400: close to what ten per-Item clocks would total, but pooled, so time saved on
      // one Item can be spent on another.
      expect(BUILD_A_SENTENCE_BUDGET_SEC).toBeGreaterThan(items.length * 40);
    });

    // The one place the seconds become User-visible copy. Both call sites render this string, so a
    // budget that is not a whole number of minutes cannot be rounded into a lie on either screen.
    it("states itself honestly as a clock reading, never as rounded minutes", () => {
      expect(BUILD_A_SENTENCE_BUDGET_CLOCK).toBe("6:50");
      expect(BUILD_A_SENTENCE_BUDGET_CLOCK).not.toBe("7:00");
    });

    it("begin establishes one deadline 410 s out, at Item 0, with no arrangements", () => {
      const next = reduce(initialBuildSentenceRunState, { type: "begin" });
      expect(next).toEqual({
        stage: "running",
        deadlineMs: Date.now() + 410_000,
        index: 0,
        arrangements: new Map(),
      });
    });

    // `timeLimitSec` is an optional key on the persisted Item schema that the older banked Writing
    // Sets carry on every Build a Sentence Item, so an Item really can arrive with a clock on it.
    it("ignores the Item's own timeLimitSec entirely — a Set of 5 s Items still gets 410 s", () => {
      const oddItems = items.map((item) => ({ ...item, timeLimitSec: 5 }));
      const next = reduceBuildSentenceRun(initialBuildSentenceRunState, { type: "begin" }, oddItems);
      expect(next.stage === "running" && next.deadlineMs).toBe(Date.now() + 410_000);
    });

    it("is not recomputed or extended by advancing, going back, jumping, or arranging tiles", () => {
      const begun = reduce(initialBuildSentenceRunState, { type: "begin" });
      const deadlineMs = begun.stage === "running" ? begun.deadlineMs : -1;

      // Real time passes between every move, so a reducer that recomputed the deadline from
      // Date.now() anywhere would push it out here.
      let state = begun;
      for (const ev of [
        { type: "next" },
        { type: "arrangement-changed", itemId: "bs-2", slots: [tileIdOf("cat", 0), null, null] },
        { type: "next" },
        { type: "back" },
        { type: "navigate-to-item", index: 7 },
        { type: "navigate-to-item", index: 0 },
      ] satisfies BuildSentenceRunEvent[]) {
        vi.advanceTimersByTime(11_000);
        state = reduce(state, ev);
        expect(state.stage === "running" && state.deadlineMs).toBe(deadlineMs);
      }
    });

    it("begin is a no-op once the Task is already running or finished", () => {
      const runningState = running();
      expect(reduce(runningState, { type: "begin" })).toBe(runningState);

      const finished = reduce(runningState, { type: "budget-expired" });
      expect(reduce(finished, { type: "begin" })).toBe(finished);
    });
  });

  describe("navigation", () => {
    it("next advances one Item and back returns one Item", () => {
      const state = reduceAll(running(), [{ type: "next" }, { type: "next" }]);
      expect(state.stage === "running" && state.index).toBe(2);
      expect(reduce(state, { type: "back" })).toMatchObject({ index: 1 });
    });

    it("navigate-to-item jumps straight to any Item", () => {
      expect(reduce(running(), { type: "navigate-to-item", index: 9 })).toMatchObject({ index: 9 });
    });

    it("clamps at both ends and on out-of-range jumps, returning the SAME state reference", () => {
      const first = running({ index: 0 });
      expect(reduce(first, { type: "back" })).toBe(first);

      const last = running({ index: items.length - 1 });
      // Next on the last Item does not end the Task: "finish-early" is the only manual way out, so
      // a stray Next cannot burn the User's remaining budget.
      expect(reduce(last, { type: "next" })).toBe(last);

      for (const index of [-1, items.length, 1.5, Number.NaN]) {
        expect(reduce(first, { type: "navigate-to-item", index })).toBe(first);
      }
      // Jumping to the Item you are already on moves nothing.
      expect(reduce(first, { type: "navigate-to-item", index: 0 })).toBe(first);
    });
  });

  describe("arrangements survive navigation, blanks and all", () => {
    // Blank 0 empty, blank 1 filled, blank 2 empty — the case a Response's lossy wire form cannot
    // represent, and the reason state holds the per-blank SlotFill instead.
    const gappy: SlotFill = [null, tileIdOf("sat", 1), null];

    it("an Item navigated away from and returned to comes back identical, including WHICH blanks were empty", () => {
      const state = reduceAll(running(), [
        { type: "arrangement-changed", itemId: "bs-1", slots: gappy },
        { type: "next" },
        { type: "next" },
        { type: "back" },
        { type: "back" },
      ]);
      expect(state.stage === "running" && state.index).toBe(0);
      expect(arrangementOf(state, "bs-1", 3)).toEqual([null, tileIdOf("sat", 1), null]);
    });

    it("an untouched Item reads back as all-empty blanks, not as a missing arrangement", () => {
      expect(arrangementOf(running(), "bs-4", 3)).toEqual(emptyBlanks(3));
      expect(arrangementOf(initialBuildSentenceRunState, "bs-4", 3)).toEqual(emptyBlanks(3));
    });

    it("keeps one arrangement per Item, keyed by Item id", () => {
      const state = reduceAll(running(), [
        { type: "arrangement-changed", itemId: "bs-1", slots: gappy },
        { type: "next" },
        { type: "arrangement-changed", itemId: "bs-2", slots: [tileIdOf("cat", 0), null, null] },
      ]);
      expect(arrangementOf(state, "bs-1", 3)).toEqual(gappy);
      expect(arrangementOf(state, "bs-2", 3)).toEqual([tileIdOf("cat", 0), null, null]);
    });

    it("ignores an arrangement for an id that belongs to no Item of this Task", () => {
      const state = running();
      expect(reduce(state, { type: "arrangement-changed", itemId: "not-an-item", slots: gappy })).toBe(state);
    });

    it("is a no-op outside the running stage", () => {
      const finished = reduce(running(), { type: "finish-early" });
      expect(reduce(finished, { type: "arrangement-changed", itemId: "bs-1", slots: gappy })).toBe(finished);
      expect(reduce(initialBuildSentenceRunState, { type: "arrangement-changed", itemId: "bs-1", slots: gappy })).toBe(
        initialBuildSentenceRunState,
      );
    });
  });

  describe("the Item-carries-a-Response derivation", () => {
    it("is true for an Item with at least one blank filled and false for one visited but left empty", () => {
      const state = reduceAll(running(), [
        { type: "arrangement-changed", itemId: "bs-1", slots: [null, tileIdOf("sat", 1), null] },
        // Visited, a tile dragged in and back out: an arrangement exists, but it is all-empty.
        { type: "arrangement-changed", itemId: "bs-2", slots: [tileIdOf("cat", 0), null, null] },
        { type: "arrangement-changed", itemId: "bs-2", slots: [null, null, null] },
      ]);
      const responded = respondedItemIds(state);
      expect(responded.has("bs-1")).toBe(true);
      expect(responded.has("bs-2")).toBe(false);
      // Never visited at all — indistinguishable from visited-and-empty, and should be.
      expect(responded.has("bs-3")).toBe(false);
      expect([...responded]).toEqual(["bs-1"]);
    });

    it("carriesResponse is exactly 'at least one blank filled'", () => {
      expect(carriesResponse(undefined)).toBe(false);
      expect(carriesResponse([])).toBe(false);
      expect(carriesResponse([null, null, null])).toBe(false);
      expect(carriesResponse([null, null, tileIdOf("down", 2)])).toBe(true);
    });

    it("is empty before the Task begins and after it ends", () => {
      expect(respondedItemIds(initialBuildSentenceRunState).size).toBe(0);
      const finished = reduceAll(running(), [
        { type: "arrangement-changed", itemId: "bs-1", slots: [tileIdOf("cat", 0), null, null] },
        { type: "budget-expired" },
      ]);
      expect(respondedItemIds(finished).size).toBe(0);
    });
  });

  describe("ending the Task", () => {
    const arranged: BuildSentenceRunEvent[] = [
      // Full arrangement on Item 1.
      { type: "arrangement-changed", itemId: "bs-1", slots: [tileIdOf("cat", 0), tileIdOf("sat", 1), tileIdOf("down", 2)] },
      // Half-finished arrangement on Item 2, with a gap in the middle.
      { type: "arrangement-changed", itemId: "bs-2", slots: [tileIdOf("cat", 0), null, tileIdOf("down", 2)] },
    ];

    it("expiry commits every arranged Item, records the rest as empty, and ends the Task", () => {
      const state = reduceAll(running(), [...arranged, { type: "budget-expired" }]);
      expect(state.stage).toBe("finished");
      expect(state.stage === "finished" && state.reason).toBe("budget-expired");
      expect(state.stage === "finished" && state.responses).toEqual([
        { itemId: "bs-1", tileOrder: ["cat", "sat", "down"] },
        // Empty blanks are dropped when the per-blank arrangement becomes a Response: the wire
        // format is the tile texts in blank order.
        { itemId: "bs-2", tileOrder: ["cat", "down"] },
        ...items.slice(2).map((item) => ({ itemId: item.id, tileOrder: [] })),
      ]);
    });

    it("expiry does NOT advance through the remaining Items — it stops the Task where it stands", () => {
      const midway = reduceAll(running(), [{ type: "navigate-to-item", index: 2 }, ...arranged]);
      const expired = reduce(midway, { type: "budget-expired" });
      // No stage exists that still carries an index: there is nothing left to advance through.
      expect(expired.stage).toBe("finished");
      expect(expired).not.toHaveProperty("index");
      // Every Item is accounted for exactly once, in Set order, whichever one the User was on.
      expect(expired.stage === "finished" && expired.responses.map((r) => r.itemId)).toEqual(items.map((i) => i.id));
    });

    it("finishing early ends the Task through the same commit path, differing only in the recorded reason", () => {
      const beforeEnd = reduceAll(running(), arranged);
      const expired = reduce(beforeEnd, { type: "budget-expired" });
      const early = reduce(beforeEnd, { type: "finish-early" });

      expect(early.stage === "finished" && early.reason).toBe("finished-early");
      expect(early.stage === "finished" && early.responses).toEqual(expired.stage === "finished" ? expired.responses : null);
    });

    it("finishing after walking all ten Items commits all ten, in Set order", () => {
      let state = reduce(initialBuildSentenceRunState, { type: "begin" });
      for (const item of items) {
        state = reduce(state, {
          type: "arrangement-changed",
          itemId: item.id,
          slots: [tileIdOf("cat", 0), null, tileIdOf("down", 2)],
        });
        state = reduce(state, { type: "next" });
      }
      const finished = reduce(state, { type: "finish-early" });
      expect(finished.stage === "finished" && finished.responses).toEqual(
        items.map((item) => ({ itemId: item.id, tileOrder: ["cat", "down"] })),
      );
    });

    it("repeated back-and-forward navigation neither duplicates, drops nor reorders committed Responses", () => {
      const wandering: BuildSentenceRunEvent[] = [
        { type: "arrangement-changed", itemId: "bs-1", slots: [tileIdOf("cat", 0), null, null] },
        { type: "next" },
        { type: "arrangement-changed", itemId: "bs-2", slots: [null, tileIdOf("sat", 1), null] },
        { type: "back" },
        { type: "next" },
        { type: "next" },
        { type: "arrangement-changed", itemId: "bs-3", slots: [null, null, tileIdOf("down", 2)] },
        { type: "back" },
        { type: "back" },
        { type: "navigate-to-item", index: 2 },
        { type: "navigate-to-item", index: 1 },
        { type: "back" },
        { type: "next" },
        { type: "next" },
      ];
      const state = reduceAll(reduce(initialBuildSentenceRunState, { type: "begin" }), wandering);
      const finished = reduce(state, { type: "finish-early" });
      const responses = finished.stage === "finished" ? finished.responses : [];

      // Exactly one Response per Item, in Set order.
      expect(responses.map((r) => r.itemId)).toEqual(items.map((i) => i.id));
      expect(new Set(responses.map((r) => r.itemId)).size).toBe(items.length);
      // And each one carries the arrangement last left on it, not whatever was on screen at the end.
      expect(responses[0]).toEqual({ itemId: "bs-1", tileOrder: ["cat"] });
      expect(responses[1]).toEqual({ itemId: "bs-2", tileOrder: ["sat"] });
      expect(responses[2]).toEqual({ itemId: "bs-3", tileOrder: ["down"] });
    });

    it("expiry after the Task already finished is a no-op, and so is finishing after expiry", () => {
      const beforeEnd = reduceAll(running(), arranged);

      const early = reduce(beforeEnd, { type: "finish-early" });
      expect(reduce(early, { type: "budget-expired" })).toBe(early);

      const expired = reduce(beforeEnd, { type: "budget-expired" });
      expect(reduce(expired, { type: "finish-early" })).toBe(expired);
      // A duplicate expiry racing itself is expected, not exceptional.
      expect(reduce(expired, { type: "budget-expired" })).toBe(expired);
    });

    it("neither ending event fires before the Task has begun", () => {
      expect(reduce(initialBuildSentenceRunState, { type: "budget-expired" })).toBe(initialBuildSentenceRunState);
      expect(reduce(initialBuildSentenceRunState, { type: "finish-early" })).toBe(initialBuildSentenceRunState);
    });
  });

  it("every event that does not match the current stage returns the SAME state reference, never a throw", () => {
    const finished = reduce(running(), { type: "budget-expired" });

    for (const ev of ALL_EVENTS) {
      // "idle" accepts only "begin".
      if (ev.type !== "begin") {
        expect(reduce(initialBuildSentenceRunState, ev)).toBe(initialBuildSentenceRunState);
      }
      // "finished" is terminal: nothing at all moves it.
      expect(reduce(finished, ev)).toBe(finished);
    }
  });

  it("never mutates the state it is handed", () => {
    const before = reduce(initialBuildSentenceRunState, { type: "begin" });
    const snapshot = JSON.stringify({
      ...(before as Extract<BuildSentenceRunState, { stage: "running" }>),
      arrangements: [...(before as Extract<BuildSentenceRunState, { stage: "running" }>).arrangements],
    });

    for (const ev of ALL_EVENTS) reduce(before, ev);

    expect(
      JSON.stringify({
        ...(before as Extract<BuildSentenceRunState, { stage: "running" }>),
        arrangements: [...(before as Extract<BuildSentenceRunState, { stage: "running" }>).arrangements],
      }),
    ).toBe(snapshot);
  });
});
