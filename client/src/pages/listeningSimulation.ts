import {
  MCQ_UNANSWERED_SENTINEL,
  routedModule,
  type DeterministicScoreRequest,
  type ModulePath,
  type RoutedModule,
  type ServedListeningModule,
  type ServedListeningSet,
  type ServedListeningStimulus,
} from "@toefl-prep/shared";

// The Listening Simulation's pure state machine: Router Module -> (score + route) -> path-reveal ->
// the routed Lower/Upper Module -> (score) -> complete. No I/O; every event that does not match the
// state it arrives in is a structural no-op. Two differences from readingSimulation.ts:
//
//   1. No Module clock. A Listening Module is paced by its audio: a Stimulus plays once, its
//      Question(s) are answered in order, and there is no way back. So there is no deadline and no
//      timer event, and time spent on the audio-failed gate costs the User nothing.
//   2. reduceListeningSim takes the (served) Set as a third parameter, because it needs a Module's
//      Stimulus count and a Stimulus's Question count to know whether "next" means the next
//      Question, the next Stimulus, or submitting the Module.
//
// A Module's submit is per Task Type, retried by submitModule.ts; "submit-failed" /
// "retry-submit" exist so an exhausted retry budget does not strand the Attempt in "submitting".

/**
 * How many times a Stimulus whose audio fails is reloaded on its own before it stops on the
 * audio-failed gate. A clip that will not play is the app's failure, never the User's.
 */
export const LISTENING_AUDIO_AUTO_RETRIES = 2;

/**
 * Where a Stimulus whose audio just failed goes next, given how many times it has been reloaded: a
 * fresh load on its own, or the audio-failed gate once the automatic reloads are spent. The one rule
 * for both Attempt modes: the Simulation's reducer and the Drill's queue (StimulusQueueRun.tsx) both
 * call it, so neither can quietly give up sooner or reveal the Question(s) instead.
 */
export function afterAudioError(audioTry = 0): { phase: "playing" | "audio-failed"; audioTry: number } {
  return audioTry < LISTENING_AUDIO_AUTO_RETRIES ? { phase: "playing", audioTry: audioTry + 1 } : { phase: "audio-failed", audioTry };
}

export type ListeningSimState =
  | { stage: "intro" }
  | {
      stage: "stimulus";
      module: RoutedModule;
      idx: number;
      // "audio-failed" is the gate a Stimulus stops on when its audio would not play: nothing
      // answerable is shown, and only the User's Retry (or Skip) moves it on.
      phase: "avatar" | "playing" | "audio-failed" | "questions";
      questionIdx: number;
      answers: Map<string, string>;
      /** How many times this Stimulus's audio has been reloaded; keys the player. Absent = 0. */
      audioTry?: number;
    }
  | { stage: "submitting"; module: RoutedModule }
  // Reached once some Task Type's (or the routing call's) retry budget is exhausted. "retry-submit"
  // re-enters "submitting" for the same Module, and only what the server has not yet accepted is
  // re-sent (submitModule.ts's acceptedTaskTypes).
  | { stage: "submit-failed"; module: RoutedModule }
  | { stage: "path-reveal"; path: ModulePath }
  | { stage: "complete" };

export type ListeningSimEvent =
  | { type: "begin" }
  | { type: "avatar-settled" }
  | { type: "audio-ended" }
  // The Stimulus's player reported a load/playback failure: reload it, or stop on the gate.
  | { type: "audio-error" }
  // From the audio-failed gate: play the Stimulus again.
  | { type: "retry-audio" }
  // From the audio-failed gate, the User's own choice: move on, leaving the Stimulus's Question(s)
  // unanswered.
  | { type: "skip-stimulus" }
  | { type: "answer"; itemId: string; optionId: string }
  | { type: "next-question" }
  | { type: "routed"; path: ModulePath }
  | { type: "continue-to-module2" }
  | { type: "module2-scored" }
  | { type: "submit-error" }
  | { type: "retry-submit" };

/**
 * Pure transition function. Every branch that doesn't match the event's required stage/phase/module
 * returns the same state reference unchanged (a structural no-op, not a thrown error) — a duplicate
 * `audio-ended` racing a manual advance, or a stray `routed` replay, is expected, not exceptional.
 * `set` is read only by the branches that need a Module's Stimulus count or a Stimulus's Question
 * count ("next-question", "skip-stimulus"); every other branch ignores it.
 */
export function reduceListeningSim(state: ListeningSimState, ev: ListeningSimEvent, set: ServedListeningSet): ListeningSimState {
  switch (ev.type) {
    case "begin":
      if (state.stage !== "intro") return state;
      return { stage: "stimulus", module: "router", idx: 0, phase: "avatar", questionIdx: 0, answers: new Map() };

    case "avatar-settled":
      if (state.stage !== "stimulus" || state.phase !== "avatar") return state;
      return { ...state, phase: "playing" };

    case "audio-ended":
      if (state.stage !== "stimulus" || state.phase !== "playing") return state;
      return { ...state, phase: "questions", questionIdx: 0 };

    case "audio-error":
      if (state.stage !== "stimulus" || state.phase !== "playing") return state;
      return { ...state, ...afterAudioError(state.audioTry) };

    case "retry-audio":
      if (state.stage !== "stimulus" || state.phase !== "audio-failed") return state;
      return { ...state, phase: "playing", audioTry: (state.audioTry ?? 0) + 1 };

    case "skip-stimulus":
      if (state.stage !== "stimulus" || state.phase !== "audio-failed") return state;
      return advanceStimulus(set, state);

    case "answer":
      if (state.stage !== "stimulus" || state.phase !== "questions") return state;
      return { ...state, answers: new Map(state.answers).set(ev.itemId, ev.optionId) };

    case "next-question": {
      if (state.stage !== "stimulus" || state.phase !== "questions") return state;
      const stimuli = flattenListeningModule(routedModule(set, state.module));
      const questionCount = questionCountFor(stimuli[state.idx]);
      if (state.questionIdx + 1 < questionCount) {
        return { ...state, questionIdx: state.questionIdx + 1 };
      }
      return advanceStimulus(set, state);
    }

    case "routed":
      if (state.stage !== "submitting" || state.module !== "router") return state;
      return { stage: "path-reveal", path: ev.path };

    // No auto-advance out of path-reveal: the User reads the Module Path disclosure and continues
    // when ready.
    case "continue-to-module2":
      if (state.stage !== "path-reveal") return state;
      return { stage: "stimulus", module: state.path, idx: 0, phase: "avatar", questionIdx: 0, answers: new Map() };

    // Only the second Module completes this way; the Router Module advances through "routed". The
    // guard sits in the reducer, so a stray dispatch while the Router Module is submitting cannot
    // complete the Attempt unrouted, however the component calls it.
    case "module2-scored":
      if (state.stage !== "submitting" || state.module === "router") return state;
      return { stage: "complete" };

    case "submit-error":
      if (state.stage !== "submitting") return state;
      return { stage: "submit-failed", module: state.module };

    case "retry-submit":
      if (state.stage !== "submit-failed") return state;
      return { stage: "submitting", module: state.module };

    default:
      return state;
  }
}

// Moves to the next Stimulus (fresh avatar phase, first Question) if one remains in the Module, or
// to "submitting" after the Module's last one. `answers` carries over untouched, so a Stimulus the
// User skipped from the audio-failed gate leaves its Item(s) for buildScoreRequests to fill as
// unanswered.
function advanceStimulus(
  set: ServedListeningSet,
  state: Extract<ListeningSimState, { stage: "stimulus" }>,
): ListeningSimState {
  const stimuli = flattenListeningModule(routedModule(set, state.module));
  const nextIdx = state.idx + 1;
  if (nextIdx < stimuli.length) {
    return { stage: "stimulus", module: state.module, idx: nextIdx, phase: "avatar", questionIdx: 0, answers: state.answers };
  }
  return { stage: "submitting", module: state.module };
}

// The per-Task-Type score requests built from a Module's collected answers, and the Module helpers
// they and the screen share. Nothing here reads a served Module's `timeLimitSec`: this section has
// no Module clock. (The intro reads it once, to say roughly how long the section takes.)

/**
 * A Module's Stimuli in the order they are heard. Matches LISTENING_MODULE_COMPOSITION's field order
 * (shared/src/schemas/listening.ts) and buildScoreRequests' grouping below — listenChoose, then
 * conversations, then announcements, then academicTalks. The reducer's idx/questionIdx bookkeeping
 * and the screen both read it, so they cannot disagree about which Stimulus is on screen.
 */
export function flattenListeningModule(mod: ServedListeningModule): ServedListeningStimulus[] {
  return [...mod.listenChoose, ...mod.conversations, ...mod.announcements, ...mod.academicTalks];
}

/** How many Items a Module holds: every Question of every Stimulus. */
export function listeningItemCount(mod: ServedListeningModule): number {
  return flattenListeningModule(mod).reduce((n, stimulus) => n + questionCountFor(stimulus), 0);
}

// A listen_choose Stimulus is its own one Question (no `questions` array); every other shape has a
// `questions` array, whose length the schema fixes (CONVERSATION_QUESTIONS_PER_STIMULUS and its
// siblings in shared/src/schemas/listening.ts) and this only reads.
export function questionCountFor(stimulus: ServedListeningStimulus): number {
  return stimulus.taskType === "listen_choose" ? 1 : stimulus.questions.length;
}

/**
 * One score request per Task Type present in the Module (the Upper Module has no announcements, the
 * Lower no academic talks), covering every Item the Module contains: an Item without a Response —
 * only possible for a Stimulus the User skipped from the audio-failed gate, since Next needs an
 * answer — is sent as unanswered (shared's MCQ_UNANSWERED_SENTINEL, scored incorrect) rather than
 * left out.
 */
export function buildScoreRequests(set: ServedListeningSet, module: RoutedModule, answers: Map<string, string>): DeterministicScoreRequest[] {
  const mod = routedModule(set, module);
  const requests: DeterministicScoreRequest[] = [];

  const sentinelFill = (itemId: string) => ({ itemId, selectedOptionId: answers.get(itemId) ?? MCQ_UNANSWERED_SENTINEL });

  if (mod.listenChoose.length > 0) {
    requests.push({ taskType: "listen_choose", items: mod.listenChoose.map((item) => sentinelFill(item.id)) });
  }
  if (mod.conversations.length > 0) {
    requests.push({
      taskType: "conversation",
      items: mod.conversations.flatMap((c) => c.questions.map((q) => sentinelFill(q.id))),
    });
  }
  if (mod.announcements.length > 0) {
    requests.push({
      taskType: "announcement",
      items: mod.announcements.flatMap((a) => a.questions.map((q) => sentinelFill(q.id))),
    });
  }
  if (mod.academicTalks.length > 0) {
    requests.push({
      taskType: "academic_talk",
      items: mod.academicTalks.flatMap((t) => t.questions.map((q) => sentinelFill(q.id))),
    });
  }

  return requests;
}
