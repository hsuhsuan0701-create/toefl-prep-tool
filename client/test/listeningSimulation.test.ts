import { describe, expect, it } from "vitest";
import type { ServedListeningSet } from "@toefl-prep/shared";
import {
  LISTENING_AUDIO_AUTO_RETRIES,
  buildScoreRequests,
  reduceListeningSim,
  type ListeningSimEvent,
  type ListeningSimState,
} from "../src/pages/listeningSimulation";

// The Listening Simulation's pure state machine. Its view, including the gate that keeps every
// option out of the DOM until the audio ends, belongs to components/StimulusQuestions.tsx and is
// covered for all four Listening Task Types in both Attempt modes by StimulusQuestions.test.tsx.

function opts(n: number) {
  const letters = ["a", "b", "c", "d"];
  return letters.slice(0, n).map((id) => ({ id, text: `Option ${id.toUpperCase()}` }));
}

const fixtureSet: ServedListeningSet = {
  id: "lsn-test",
  kind: "listening",
  source: "generated",
  createdAt: "2026-01-01T00:00:00.000Z",
  router: {
    timeLimitSec: 1700,
    listenChoose: [
      {
        id: "lc-r1",
        taskType: "listen_choose",
        audio: "stimuli/lsn-test/lc-r1.mp3",
        speaker: { id: "sp-1", role: "student", gender: "male", accent: "north-american" },
        options: opts(4),
      },
    ],
    conversations: [
      {
        id: "cv-r1",
        taskType: "conversation",
        audio: "stimuli/lsn-test/cv-r1.mp3",
        setting: "campus bookstore",
        speakers: [
          { id: "sp-2", role: "student", gender: "female", accent: "british" },
          { id: "sp-3", role: "clerk", gender: "male", accent: "australian" },
        ],
        questions: [
          { id: "cv-r1-q1", stem: "stem1?", options: opts(3) },
          { id: "cv-r1-q2", stem: "stem2?", options: opts(3) },
        ],
      },
    ],
    announcements: [],
    academicTalks: [],
  },
  lowerModule: {
    timeLimitSec: 900,
    listenChoose: [
      {
        id: "lc-l1",
        taskType: "listen_choose",
        audio: "stimuli/lsn-test/lc-l1.mp3",
        speaker: { id: "sp-4", role: "librarian", gender: "female", accent: "north-american" },
        options: opts(4),
      },
    ],
    conversations: [],
    announcements: [],
    academicTalks: [],
  },
  upperModule: {
    timeLimitSec: 900,
    listenChoose: [
      {
        id: "lc-u1",
        taskType: "listen_choose",
        audio: "stimuli/lsn-test/lc-u1.mp3",
        speaker: { id: "sp-5", role: "professor", gender: "male", accent: "british" },
        options: opts(4),
      },
    ],
    conversations: [],
    announcements: [],
    academicTalks: [],
  },
};

const ALL_EVENTS: ListeningSimEvent[] = [
  { type: "begin" },
  { type: "avatar-settled" },
  { type: "audio-ended" },
  { type: "audio-error" },
  { type: "retry-audio" },
  { type: "skip-stimulus" },
  { type: "answer", itemId: "x", optionId: "y" },
  { type: "next-question" },
  { type: "routed", path: "lower" },
  { type: "continue-to-module2" },
  { type: "module2-scored" },
  { type: "submit-error" },
  { type: "retry-submit" },
];

describe("reduceListeningSim", () => {
  it("begin from intro starts the router module at Stimulus 0, phase avatar, no answers", () => {
    const next = reduceListeningSim({ stage: "intro" }, { type: "begin" }, fixtureSet);
    expect(next).toEqual({ stage: "stimulus", module: "router", idx: 0, phase: "avatar", questionIdx: 0, answers: new Map() });
  });

  it("begin is a no-op outside intro", () => {
    const state: ListeningSimState = { stage: "complete" };
    expect(reduceListeningSim(state, { type: "begin" }, fixtureSet)).toBe(state);
  });

  describe("avatar -> playing on settle (and nowhere else)", () => {
    it("avatar-settled moves phase avatar -> playing, preserving idx/questionIdx/answers", () => {
      const avatarState: ListeningSimState = { stage: "stimulus", module: "router", idx: 0, phase: "avatar", questionIdx: 0, answers: new Map() };
      expect(reduceListeningSim(avatarState, { type: "avatar-settled" }, fixtureSet)).toEqual({ ...avatarState, phase: "playing" });
    });

    it("avatar-settled is a no-op once already playing or in questions", () => {
      const playingState: ListeningSimState = { stage: "stimulus", module: "router", idx: 0, phase: "playing", questionIdx: 0, answers: new Map() };
      expect(reduceListeningSim(playingState, { type: "avatar-settled" }, fixtureSet)).toBe(playingState);

      const questionsState: ListeningSimState = { ...playingState, phase: "questions" };
      expect(reduceListeningSim(questionsState, { type: "avatar-settled" }, fixtureSet)).toBe(questionsState);
    });
  });

  describe("playing -> questions ONLY on audio-ended", () => {
    it("audio-ended moves phase playing -> questions at questionIdx 0", () => {
      const playingState: ListeningSimState = { stage: "stimulus", module: "router", idx: 1, phase: "playing", questionIdx: 0, answers: new Map() };
      expect(reduceListeningSim(playingState, { type: "audio-ended" }, fixtureSet)).toEqual({ ...playingState, phase: "questions", questionIdx: 0 });
    });

    it("audio-ended is a no-op outside the playing phase", () => {
      const avatarState: ListeningSimState = { stage: "stimulus", module: "router", idx: 0, phase: "avatar", questionIdx: 0, answers: new Map() };
      expect(reduceListeningSim(avatarState, { type: "audio-ended" }, fixtureSet)).toBe(avatarState);

      const questionsState: ListeningSimState = { ...avatarState, phase: "questions" };
      expect(reduceListeningSim(questionsState, { type: "audio-ended" }, fixtureSet)).toBe(questionsState);
    });
  });

  // A Stimulus whose audio fails is the app's failure, never the User's: it is reloaded a bounded
  // number of times, then the Stimulus stops on a gate — nothing is skipped or scored on its own.
  describe("audio-error retries the clip, then stops on a gate", () => {
    const playing: ListeningSimState = { stage: "stimulus", module: "router", idx: 0, phase: "playing", questionIdx: 0, answers: new Map() };

    it("reloads the clip on a fresh player, staying on the same Stimulus", () => {
      expect(reduceListeningSim(playing, { type: "audio-error" }, fixtureSet)).toEqual({ ...playing, audioTry: 1 });
    });

    it(`stops on the audio-failed gate once ${LISTENING_AUDIO_AUTO_RETRIES} reloads have failed too`, () => {
      let state: ListeningSimState = playing;
      for (let i = 0; i < LISTENING_AUDIO_AUTO_RETRIES; i += 1) state = reduceListeningSim(state, { type: "audio-error" }, fixtureSet);
      expect(state).toMatchObject({ stage: "stimulus", idx: 0, phase: "playing" });
      expect(reduceListeningSim(state, { type: "audio-error" }, fixtureSet)).toMatchObject({
        stage: "stimulus",
        idx: 0,
        phase: "audio-failed",
      });
    });

    it("never advances to the next Stimulus or to submitting on its own, even on the Module's last Stimulus", () => {
      let state: ListeningSimState = { ...playing, idx: 1 };
      for (let i = 0; i <= LISTENING_AUDIO_AUTO_RETRIES + 3; i += 1) {
        state = reduceListeningSim(state, { type: "audio-error" }, fixtureSet);
      }
      expect(state).toMatchObject({ stage: "stimulus", idx: 1, phase: "audio-failed" });
    });

    it("retry-audio plays the clip again on a fresh player; ending then reveals the Questions", () => {
      const gated: ListeningSimState = { ...playing, phase: "audio-failed", audioTry: 2 };
      const retried = reduceListeningSim(gated, { type: "retry-audio" }, fixtureSet);
      expect(retried).toEqual({ ...playing, audioTry: 3 });
      expect(reduceListeningSim(retried, { type: "audio-ended" }, fixtureSet)).toMatchObject({ phase: "questions" });
    });

    it("skip-stimulus is the User's own choice from the gate, and only from there", () => {
      const gated: ListeningSimState = { ...playing, phase: "audio-failed" };
      expect(reduceListeningSim(gated, { type: "skip-stimulus" }, fixtureSet)).toMatchObject({ stage: "stimulus", idx: 1, phase: "avatar" });
      expect(reduceListeningSim(playing, { type: "skip-stimulus" }, fixtureSet)).toBe(playing);
    });

    it("is a no-op outside the playing phase (never fires mid-avatar or mid-questions)", () => {
      const avatarState: ListeningSimState = { ...playing, phase: "avatar" };
      expect(reduceListeningSim(avatarState, { type: "audio-error" }, fixtureSet)).toBe(avatarState);
    });

    it("buildScoreRequests scores a skipped Stimulus's Items as unanswered", () => {
      const requests = buildScoreRequests(fixtureSet, "router", new Map([["lc-r1", "a"]]));
      const conversation = requests.find((r) => r.taskType === "conversation");
      expect(conversation?.items).toEqual([
        { itemId: "cv-r1-q1", selectedOptionId: "__none__" },
        { itemId: "cv-r1-q2", selectedOptionId: "__none__" },
      ]);
    });
  });

  it("answer only applies while phase is questions, keyed by itemId, without touching other fields", () => {
    const questionsState: ListeningSimState = { stage: "stimulus", module: "router", idx: 0, phase: "questions", questionIdx: 0, answers: new Map() };
    expect(reduceListeningSim(questionsState, { type: "answer", itemId: "lc-r1", optionId: "b" }, fixtureSet)).toEqual({
      ...questionsState,
      answers: new Map([["lc-r1", "b"]]),
    });

    const playingState: ListeningSimState = { ...questionsState, phase: "playing" };
    expect(reduceListeningSim(playingState, { type: "answer", itemId: "lc-r1", optionId: "b" }, fixtureSet)).toBe(playingState);
  });

  describe("next-only navigation: no event returns to a previous Question or Stimulus", () => {
    it("next-question is a no-op outside the questions phase", () => {
      const avatarState: ListeningSimState = { stage: "stimulus", module: "router", idx: 0, phase: "avatar", questionIdx: 0, answers: new Map() };
      expect(reduceListeningSim(avatarState, { type: "next-question" }, fixtureSet)).toBe(avatarState);
    });

    it("next-question on a multi-Question Stimulus advances questionIdx within the SAME Stimulus first", () => {
      const q0: ListeningSimState = { stage: "stimulus", module: "router", idx: 1, phase: "questions", questionIdx: 0, answers: new Map() };
      const q1 = reduceListeningSim(q0, { type: "next-question" }, fixtureSet);
      expect(q1).toEqual({ ...q0, questionIdx: 1 });

      // Last question of the module's last Stimulus -> submitting.
      expect(reduceListeningSim(q1, { type: "next-question" }, fixtureSet)).toEqual({ stage: "submitting", module: "router" });
    });

    it("next-question from a single-Question Stimulus moves straight to the next Stimulus's fresh avatar phase", () => {
      const q0: ListeningSimState = { stage: "stimulus", module: "router", idx: 0, phase: "questions", questionIdx: 0, answers: new Map([["lc-r1", "a"]]) };
      expect(reduceListeningSim(q0, { type: "next-question" }, fixtureSet)).toEqual({
        stage: "stimulus",
        module: "router",
        idx: 1,
        phase: "avatar",
        questionIdx: 0,
        answers: new Map([["lc-r1", "a"]]),
      });
    });

    it("no event ever decreases idx/questionIdx or moves phase backward within a Stimulus stage", () => {
      // The audio-failed gate sits beside "playing": a retry plays the same Stimulus again.
      const phaseRank: Record<"avatar" | "playing" | "audio-failed" | "questions", number> = {
        avatar: 0,
        playing: 1,
        "audio-failed": 1,
        questions: 2,
      };
      const midStates: Array<Extract<ListeningSimState, { stage: "stimulus" }>> = [
        { stage: "stimulus", module: "router", idx: 1, phase: "questions", questionIdx: 1, answers: new Map() },
        { stage: "stimulus", module: "router", idx: 1, phase: "playing", questionIdx: 0, answers: new Map() },
        { stage: "stimulus", module: "router", idx: 0, phase: "avatar", questionIdx: 0, answers: new Map() },
      ];
      for (const state of midStates) {
        for (const ev of ALL_EVENTS) {
          const next = reduceListeningSim(state, ev, fixtureSet);
          if (next.stage !== "stimulus") continue; // leaving "stimulus" entirely (e.g. -> submitting) is fine
          expect(next.module).toBe(state.module);
          if (next.idx === state.idx) {
            expect(phaseRank[next.phase]).toBeGreaterThanOrEqual(phaseRank[state.phase]);
            if (next.phase === "questions" && state.phase === "questions") {
              expect(next.questionIdx).toBeGreaterThanOrEqual(state.questionIdx);
            }
          } else {
            expect(next.idx).toBeGreaterThan(state.idx);
          }
        }
      }
    });
  });

  it("last Stimulus of a Module -> submitting -> routed -> path-reveal -> module2", () => {
    const lastQuestion: ListeningSimState = { stage: "stimulus", module: "router", idx: 1, phase: "questions", questionIdx: 1, answers: new Map() };
    const submitting = reduceListeningSim(lastQuestion, { type: "next-question" }, fixtureSet);
    expect(submitting).toEqual({ stage: "submitting", module: "router" });

    const routed = reduceListeningSim(submitting, { type: "routed", path: "lower" }, fixtureSet);
    expect(routed).toEqual({ stage: "path-reveal", path: "lower" });

    const module2 = reduceListeningSim(routed, { type: "continue-to-module2" }, fixtureSet);
    expect(module2).toEqual({ stage: "stimulus", module: "lower", idx: 0, phase: "avatar", questionIdx: 0, answers: new Map() });
  });

  it("routed is a no-op unless submitting the router module", () => {
    const state: ListeningSimState = { stage: "submitting", module: "lower" };
    expect(reduceListeningSim(state, { type: "routed", path: "lower" }, fixtureSet)).toBe(state);
  });

  it("path-reveal does not auto-advance on any event other than continue-to-module2", () => {
    const state: ListeningSimState = { stage: "path-reveal", path: "upper" };
    for (const ev of ALL_EVENTS) {
      if (ev.type === "continue-to-module2") continue;
      expect(reduceListeningSim(state, ev, fixtureSet)).toBe(state);
    }
  });

  it("module2-scored completes the attempt for lower/upper but is a no-op for the router module", () => {
    expect(reduceListeningSim({ stage: "submitting", module: "lower" }, { type: "module2-scored" }, fixtureSet)).toEqual({ stage: "complete" });
    expect(reduceListeningSim({ stage: "submitting", module: "upper" }, { type: "module2-scored" }, fixtureSet)).toEqual({ stage: "complete" });

    const routerSubmitting: ListeningSimState = { stage: "submitting", module: "router" };
    expect(reduceListeningSim(routerSubmitting, { type: "module2-scored" }, fixtureSet)).toBe(routerSubmitting);
  });

  // A Module submit that exhausts its retry budget must not be a dead end: "submit-failed" waits
  // for "retry-submit". The same cases as readingSimulation.test.ts's submit-error describe block.
  describe("submit-error / retry-submit: an exhausted submit waits for the User's retry", () => {
    it("submit-error moves a submitting module to submit-failed, preserving the module", () => {
      expect(reduceListeningSim({ stage: "submitting", module: "router" }, { type: "submit-error" }, fixtureSet)).toEqual({
        stage: "submit-failed",
        module: "router",
      });
      expect(reduceListeningSim({ stage: "submitting", module: "lower" }, { type: "submit-error" }, fixtureSet)).toEqual({
        stage: "submit-failed",
        module: "lower",
      });
    });

    it("submit-error is a no-op outside the submitting stage", () => {
      const state: ListeningSimState = { stage: "path-reveal", path: "upper" };
      expect(reduceListeningSim(state, { type: "submit-error" }, fixtureSet)).toBe(state);
    });

    it("retry-submit moves submit-failed back to submitting for the SAME module", () => {
      expect(reduceListeningSim({ stage: "submit-failed", module: "upper" }, { type: "retry-submit" }, fixtureSet)).toEqual({
        stage: "submitting",
        module: "upper",
      });
    });

    it("retry-submit is a no-op outside submit-failed", () => {
      const state: ListeningSimState = { stage: "submitting", module: "router" };
      expect(reduceListeningSim(state, { type: "retry-submit" }, fixtureSet)).toBe(state);
    });

    it("routed and module2-scored are no-ops from submit-failed — the failure must be retried, not silently bypassed", () => {
      const routerFailed: ListeningSimState = { stage: "submit-failed", module: "router" };
      expect(reduceListeningSim(routerFailed, { type: "routed", path: "lower" }, fixtureSet)).toBe(routerFailed);

      const lowerFailed: ListeningSimState = { stage: "submit-failed", module: "lower" };
      expect(reduceListeningSim(lowerFailed, { type: "module2-scored" }, fixtureSet)).toBe(lowerFailed);
    });
  });

  it("no event path ever leads back to the router module from module2", () => {
    const moduleStates: ListeningSimState[] = [
      { stage: "stimulus", module: "lower", idx: 0, phase: "avatar", questionIdx: 0, answers: new Map() },
      { stage: "stimulus", module: "upper", idx: 0, phase: "questions", questionIdx: 0, answers: new Map() },
      { stage: "submitting", module: "lower" },
      { stage: "submitting", module: "upper" },
      { stage: "submit-failed", module: "lower" },
      { stage: "submit-failed", module: "upper" },
    ];
    for (const state of moduleStates) {
      for (const ev of ALL_EVENTS) {
        const next = reduceListeningSim(state, ev, fixtureSet);
        expect(next.stage).not.toBe("intro");
        expect(next.stage).not.toBe("path-reveal");
        if (next.stage === "stimulus" || next.stage === "submitting" || next.stage === "submit-failed") {
          expect(next.module).not.toBe("router");
        }
      }
    }
  });
});

describe("buildScoreRequests", () => {
  it("groups items by task type present in the Module and fills sentinels for unanswered items", () => {
    const requests = buildScoreRequests(fixtureSet, "router", new Map([["lc-r1", "b"]]));
    const byType = new Map(requests.map((r) => [r.taskType, r]));

    expect(byType.get("listen_choose")?.items).toEqual([{ itemId: "lc-r1", selectedOptionId: "b" }]);
    expect(byType.get("conversation")?.items).toEqual([
      { itemId: "cv-r1-q1", selectedOptionId: "__none__" },
      { itemId: "cv-r1-q2", selectedOptionId: "__none__" },
    ]);
    // The router fixture has no announcement/academic_talk — no empty request for either.
    expect(byType.has("announcement")).toBe(false);
    expect(byType.has("academic_talk")).toBe(false);
  });

  it("fills a real selection instead of the sentinel when the User answered an MCQ", () => {
    const requests = buildScoreRequests(fixtureSet, "router", new Map([["cv-r1-q1", "b"]]));
    const conversation = requests.find((r) => r.taskType === "conversation");
    expect(conversation?.items).toEqual([
      { itemId: "cv-r1-q1", selectedOptionId: "b" },
      { itemId: "cv-r1-q2", selectedOptionId: "__none__" },
    ]);
  });

  it("returns no requests for an empty module", () => {
    const emptyModule = { timeLimitSec: 60, listenChoose: [], conversations: [], announcements: [], academicTalks: [] };
    expect(buildScoreRequests({ ...fixtureSet, lowerModule: emptyModule }, "lower", new Map())).toEqual([]);
  });
});
