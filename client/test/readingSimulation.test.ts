import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./fakeTimers";
import type { ServedReadingSet } from "@toefl-prep/shared";
import {
  buildScoreRequests,
  reduceReadingSim,
  type ReadingSimEvent,
  type ReadingSimState,
} from "../src/pages/readingSimulation";

function emptyModule() {
  return { timeLimitSec: 60, ctwPassages: [], dailyLife: [], academic: [] };
}

const fixtureSet: ServedReadingSet = {
  id: "rd-test",
  kind: "reading",
  source: "generated",
  createdAt: "2026-01-01T00:00:00.000Z",
  router: {
    timeLimitSec: 1200,
    ctwPassages: [
      {
        id: "ctw-r1",
        taskType: "complete_words",
        topic: "test",
        segments: [
          { type: "text", text: "The " },
          { type: "gap", gapId: "ctw-r1-g1" },
          { type: "text", text: " sat." },
          { type: "gap", gapId: "ctw-r1-g2" },
        ],
        gaps: [
          { id: "ctw-r1-g1", prefix: "ca", blankLength: 1 },
          { id: "ctw-r1-g2", prefix: "he", blankLength: 2 },
        ],
      },
    ],
    dailyLife: [
      {
        id: "dl-r1",
        taskType: "daily_life",
        genre: "notice",
        text: "text",
        questions: [
          {
            id: "dl-r1-q1",
            stem: "stem?",
            options: [
              { id: "a", text: "A" },
              { id: "b", text: "B" },
              { id: "c", text: "C" },
            ],
          },
        ],
      },
    ],
    academic: [],
  },
  lowerModule: emptyModule(),
  upperModule: emptyModule(),
};

describe("reduceReadingSim", () => {
  beforeEach(() => {
    useFakeTimersInTest();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
  });

  it("begin from intro starts the router module with a fresh deadline", () => {
    const next = reduceReadingSim({ stage: "intro" }, { type: "begin" });
    expect(next.stage).toBe("module");
    if (next.stage !== "module") throw new Error("expected module stage");
    expect(next.module).toBe("router");
    expect(next.deadlineMs).toBe(Date.now() + 1200_000);
    expect(next.answers.size).toBe(0);
    expect(next.visitedStimulusIdx).toBe(0);
  });

  it("begin is a no-op outside the intro stage", () => {
    const state: ReadingSimState = { stage: "complete" };
    expect(reduceReadingSim(state, { type: "begin" })).toBe(state);
  });

  it("timer-expired in the router module moves to submitting, with sentinel-filled requests available from the pre-submit answers", () => {
    const answers = new Map([["ctw-r1-g1", "t"]]);
    const moduleState: ReadingSimState = { stage: "module", module: "router", deadlineMs: Date.now() + 1000, answers, visitedStimulusIdx: 2 };
    const next = reduceReadingSim(moduleState, { type: "timer-expired" });
    expect(next).toEqual({ stage: "submitting", module: "router" });

    // The component builds the ScoreRequests from the answers captured just before dispatch — see
    // the buildScoreRequests describe block below for the sentinel-filling assertion itself.
    const requests = buildScoreRequests(fixtureSet, "router", answers);
    expect(requests.find((r) => r.taskType === "complete_words")?.items).toEqual([
      { itemId: "ctw-r1-g1", typed: "t" },
      { itemId: "ctw-r1-g2", typed: "" },
    ]);
  });

  it("submit-module behaves identically to timer-expired", () => {
    const moduleState: ReadingSimState = { stage: "module", module: "upper", deadlineMs: Date.now() + 1000, answers: new Map(), visitedStimulusIdx: 0 };
    expect(reduceReadingSim(moduleState, { type: "submit-module" })).toEqual({ stage: "submitting", module: "upper" });
  });

  it("answer/navigate update the current module state without touching other fields", () => {
    const state: ReadingSimState = { stage: "module", module: "router", deadlineMs: 5000, answers: new Map(), visitedStimulusIdx: 0 };
    const answered = reduceReadingSim(state, { type: "answer", itemId: "ctw-r1-g1", value: "t" });
    expect(answered).toEqual({ stage: "module", module: "router", deadlineMs: 5000, answers: new Map([["ctw-r1-g1", "t"]]), visitedStimulusIdx: 0 });

    const navigated = reduceReadingSim(answered, { type: "navigate", stimulusIdx: 3 });
    expect(navigated).toEqual({ ...answered, visitedStimulusIdx: 3, visitedQuestionIdx: 0 });

    // A question within the Stimulus is part of where the User is.
    const toQuestion = reduceReadingSim(answered, { type: "navigate", stimulusIdx: 2, questionIdx: 1 });
    expect(toQuestion).toEqual({ ...answered, visitedStimulusIdx: 2, visitedQuestionIdx: 1 });
  });

  it("routed moves the router's submitting stage to path-reveal", () => {
    const next = reduceReadingSim({ stage: "submitting", module: "router" }, { type: "routed", path: "lower" });
    expect(next).toEqual({ stage: "path-reveal", path: "lower" });
  });

  it("routed is a no-op unless submitting the router module", () => {
    const state: ReadingSimState = { stage: "submitting", module: "lower" };
    expect(reduceReadingSim(state, { type: "routed", path: "lower" })).toBe(state);
  });

  it("path-reveal does not auto-advance on any event other than continue-to-module2", () => {
    const state: ReadingSimState = { stage: "path-reveal", path: "upper" };
    const otherEvents: ReadingSimEvent[] = [
      { type: "module2-scored" },
      { type: "answer", itemId: "x", value: "y" },
      { type: "navigate", stimulusIdx: 1 },
      { type: "submit-module" },
      { type: "timer-expired" },
      { type: "routed", path: "lower" },
      { type: "begin" },
    ];
    for (const ev of otherEvents) {
      expect(reduceReadingSim(state, ev)).toBe(state);
    }
  });

  it("after continue-to-module2, module = the routed path with a fresh deadline", () => {
    const next = reduceReadingSim({ stage: "path-reveal", path: "upper" }, { type: "continue-to-module2" });
    expect(next.stage).toBe("module");
    if (next.stage !== "module") throw new Error("expected module stage");
    expect(next.module).toBe("upper");
    expect(next.deadlineMs).toBe(Date.now() + 540_000);
    expect(next.answers.size).toBe(0);
    expect(next.visitedStimulusIdx).toBe(0);
  });

  it("module2-scored completes the attempt for lower/upper but is a no-op for the router module", () => {
    expect(reduceReadingSim({ stage: "submitting", module: "lower" }, { type: "module2-scored" })).toEqual({ stage: "complete" });
    expect(reduceReadingSim({ stage: "submitting", module: "upper" }, { type: "module2-scored" })).toEqual({ stage: "complete" });

    const routerSubmitting: ReadingSimState = { stage: "submitting", module: "router" };
    expect(reduceReadingSim(routerSubmitting, { type: "module2-scored" })).toBe(routerSubmitting);
  });

  // A Module submit that exhausts its retry budget must not be a dead end: the reducer offers an
  // explicit "submit-failed" -> "retry-submit" path back into "submitting" for the same Module,
  // rather than leaving the Attempt stuck.
  describe("submit-error / retry-submit", () => {
    it("submit-error moves a submitting module to submit-failed, preserving the module", () => {
      expect(reduceReadingSim({ stage: "submitting", module: "router" }, { type: "submit-error" })).toEqual({
        stage: "submit-failed",
        module: "router",
      });
      expect(reduceReadingSim({ stage: "submitting", module: "lower" }, { type: "submit-error" })).toEqual({
        stage: "submit-failed",
        module: "lower",
      });
    });

    it("submit-error is a no-op outside the submitting stage", () => {
      const state: ReadingSimState = { stage: "path-reveal", path: "upper" };
      expect(reduceReadingSim(state, { type: "submit-error" })).toBe(state);
    });

    it("retry-submit moves submit-failed back to submitting for the SAME module", () => {
      expect(reduceReadingSim({ stage: "submit-failed", module: "upper" }, { type: "retry-submit" })).toEqual({
        stage: "submitting",
        module: "upper",
      });
    });

    it("retry-submit is a no-op outside submit-failed", () => {
      const state: ReadingSimState = { stage: "submitting", module: "router" };
      expect(reduceReadingSim(state, { type: "retry-submit" })).toBe(state);
    });

    it("routed and module2-scored are no-ops from submit-failed — the failure must be retried, not silently bypassed", () => {
      const routerFailed: ReadingSimState = { stage: "submit-failed", module: "router" };
      expect(reduceReadingSim(routerFailed, { type: "routed", path: "lower" })).toBe(routerFailed);

      const lowerFailed: ReadingSimState = { stage: "submit-failed", module: "lower" };
      expect(reduceReadingSim(lowerFailed, { type: "module2-scored" })).toBe(lowerFailed);
    });
  });

  it("no event path ever leads back to the router module from module2", () => {
    const moduleStates: ReadingSimState[] = [
      { stage: "module", module: "lower", deadlineMs: Date.now() + 1000, answers: new Map(), visitedStimulusIdx: 0 },
      { stage: "module", module: "upper", deadlineMs: Date.now() + 1000, answers: new Map(), visitedStimulusIdx: 0 },
      { stage: "submitting", module: "lower" },
      { stage: "submitting", module: "upper" },
      { stage: "submit-failed", module: "lower" },
      { stage: "submit-failed", module: "upper" },
    ];
    const events: ReadingSimEvent[] = [
      { type: "begin" },
      { type: "answer", itemId: "x", value: "y" },
      { type: "navigate", stimulusIdx: 1 },
      { type: "submit-module" },
      { type: "timer-expired" },
      { type: "routed", path: "lower" },
      { type: "routed", path: "upper" },
      { type: "continue-to-module2" },
      { type: "module2-scored" },
      { type: "submit-error" },
      { type: "retry-submit" },
    ];
    for (const state of moduleStates) {
      for (const ev of events) {
        const next = reduceReadingSim(state, ev);
        expect(next.stage).not.toBe("intro");
        expect(next.stage).not.toBe("path-reveal");
        if (next.stage === "module" || next.stage === "submitting" || next.stage === "submit-failed") {
          expect(next.module).not.toBe("router");
        }
      }
    }
  });
});

describe("buildScoreRequests", () => {
  it("groups items by task type and fills sentinels for unanswered items", () => {
    const requests = buildScoreRequests(fixtureSet, "router", new Map([["ctw-r1-g1", "c"]]));
    const byType = new Map(requests.map((r) => [r.taskType, r]));

    expect(byType.get("complete_words")?.items).toEqual([
      { itemId: "ctw-r1-g1", typed: "c" },
      { itemId: "ctw-r1-g2", typed: "" },
    ]);
    expect(byType.get("daily_life")?.items).toEqual([{ itemId: "dl-r1-q1", selectedOptionId: "__none__" }]);
    // The router fixture has no academic passage — no empty request should be produced for it.
    expect(byType.has("academic_passage")).toBe(false);
  });

  it("fills a real selection instead of the sentinel when the User answered an MCQ", () => {
    const requests = buildScoreRequests(fixtureSet, "router", new Map([["dl-r1-q1", "b"]]));
    const dailyLife = requests.find((r) => r.taskType === "daily_life");
    expect(dailyLife?.items).toEqual([{ itemId: "dl-r1-q1", selectedOptionId: "b" }]);
  });

  it("returns no requests for an empty module", () => {
    expect(buildScoreRequests(fixtureSet, "lower", new Map())).toEqual([]);
  });
});
