import {
  MCQ_UNANSWERED_SENTINEL,
  READING_MODULE_TIME_LIMITS_SEC,
  routedModule,
  type DeterministicScoreRequest,
  type ModulePath,
  type RoutedModule,
  type ServedReadingModule,
  type ServedReadingSet,
  type ServedReadingStimulus,
} from "@toefl-prep/shared";

// The Reading Simulation's pure state machine: Router Module -> (score + route) -> path-reveal ->
// the routed Lower/Upper Module -> (score) -> complete. No I/O lives here: the component makes every
// request (through submitModule.ts) and dispatches the outcome back in as an event.

export type ReadingSimState =
  | { stage: "intro" }
  | {
      stage: "module";
      module: RoutedModule;
      deadlineMs: number;
      answers: Map<string, string>;
      visitedStimulusIdx: number;
      /** Which of the visited Stimulus's questions is on screen. Absent = 0 (a Complete the Words passage is one screen). */
      visitedQuestionIdx?: number;
      /**
       * The Stimulus on screen before the User navigated here; absent when the Module opened on this
       * screen. Tells a text the User was just reading from one newly on screen.
       */
      previousStimulusIdx?: number;
    }
  | { stage: "submitting"; module: RoutedModule }
  // Reached only once some request's retry budget is exhausted (submitModule.ts), so a transient
  // failure never strands the Attempt in "submitting". "retry-submit" re-enters "submitting" for the
  // same Module, and only the Task Types the server has not accepted are re-sent.
  | { stage: "submit-failed"; module: RoutedModule }
  | { stage: "path-reveal"; path: ModulePath }
  | { stage: "complete" };

export type ReadingSimEvent =
  | { type: "begin" }
  | { type: "answer"; itemId: string; value: string }
  | { type: "navigate"; stimulusIdx: number; questionIdx?: number }
  | { type: "submit-module" }
  | { type: "timer-expired" }
  | { type: "routed"; path: ModulePath }
  | { type: "continue-to-module2" }
  | { type: "module2-scored" }
  | { type: "submit-error" }
  | { type: "retry-submit" };

// The fixed Module budgets (Router 20 minutes, Lower/Upper 9 minutes), read from shared's
// READING_MODULE_TIME_LIMITS_SEC rather than from the Set. The keys are mapped by hand because
// shared names the second Modules "lowerModule"/"upperModule".
export const MODULE_TIME_LIMIT_SEC: Record<RoutedModule, number> = {
  router: READING_MODULE_TIME_LIMITS_SEC.router,
  lower: READING_MODULE_TIME_LIMITS_SEC.lowerModule,
  upper: READING_MODULE_TIME_LIMITS_SEC.upperModule,
};

function freshDeadline(module: RoutedModule): number {
  return Date.now() + MODULE_TIME_LIMIT_SEC[module] * 1000;
}

/**
 * Pure transition function. Every branch that doesn't match the event's required stage/module
 * returns the same state reference unchanged (a structural no-op, not a thrown error) — an event
 * arriving after its window has already closed (a duplicate timer fire racing a manual submit, a
 * stray `routed` replay) is expected, not exceptional.
 */
export function reduceReadingSim(state: ReadingSimState, ev: ReadingSimEvent): ReadingSimState {
  switch (ev.type) {
    case "begin":
      if (state.stage !== "intro") return state;
      return { stage: "module", module: "router", deadlineMs: freshDeadline("router"), answers: new Map(), visitedStimulusIdx: 0 };

    case "answer":
      if (state.stage !== "module") return state;
      return { ...state, answers: new Map(state.answers).set(ev.itemId, ev.value) };

    case "navigate":
      if (state.stage !== "module") return state;
      return {
        ...state,
        visitedStimulusIdx: ev.stimulusIdx,
        visitedQuestionIdx: ev.questionIdx ?? 0,
        previousStimulusIdx: state.visitedStimulusIdx,
      };

    // A manual "Submit Module" click and the Module clock's expiry are the same transition — the
    // Module's response window is over either way, and buildScoreRequests below fills whatever was
    // left unanswered.
    case "submit-module":
    case "timer-expired":
      if (state.stage !== "module") return state;
      return { stage: "submitting", module: state.module };

    case "routed":
      if (state.stage !== "submitting" || state.module !== "router") return state;
      return { stage: "path-reveal", path: ev.path };

    // No auto-advance out of path-reveal: the User reads the Module Path disclosure (which path, and
    // that the lower path's Band Estimate is capped, both this app's assumptions rather than ETS
    // policy) and continues when ready.
    case "continue-to-module2":
      if (state.stage !== "path-reveal") return state;
      return { stage: "module", module: state.path, deadlineMs: freshDeadline(state.path), answers: new Map(), visitedStimulusIdx: 0 };

    // Only the second Module completes this way; the Router Module advances through "routed". The
    // guard sits in the reducer, so a stray dispatch while the Router Module is submitting cannot
    // complete the Attempt unrouted, however the component calls it.
    case "module2-scored":
      if (state.stage !== "submitting" || state.module === "router") return state;
      return { stage: "complete" };

    // Some request's retry budget is exhausted: move to a stage with an explicit "Retry submit"
    // rather than leaving "submitting", whose effect would never fire again, stuck.
    case "submit-error":
      if (state.stage !== "submitting") return state;
      return { stage: "submit-failed", module: state.module };

    // Re-enters "submitting" for the same Module so the component's submitting effect fires again.
    // It re-sends only what the component's own tracking says is still outstanding (nothing already
    // accepted is resent); see the "submit-failed" stage in ReadingSimState.
    case "retry-submit":
      if (state.stage !== "submit-failed") return state;
      return { stage: "submitting", module: state.module };

    default:
      return state;
  }
}

// The score requests built from a Module's collected answers, and the Module helpers they and the
// screen share. The served Reading shapes come from `shared` (servedSet.ts), derived from the Set
// schemas by the same Omit stripAnswers performs.

/** A Module's Stimuli in the order they are sat: Complete the Words, Read in Daily Life, Read an Academic Passage. */
export function flattenReadingModule(mod: ServedReadingModule): ServedReadingStimulus[] {
  return [...mod.ctwPassages, ...mod.dailyLife, ...mod.academic];
}

/**
 * One screen of a Reading Module: a whole Complete the Words passage (every gap at once, as on the
 * test), or one question of a Daily Life text or an academic passage beside its text. `firstItem` is
 * the 1-based number of its first Item across the whole Module.
 */
export type ReadingScreen = { stimulusIdx: number; questionIdx: number; itemIds: string[]; firstItem: number };

/** The screens of a Module, in order, each numbered by the Items it holds. */
export function readingScreens(stimuli: readonly ServedReadingStimulus[]): ReadingScreen[] {
  const screens: ReadingScreen[] = [];
  let next = 1;
  stimuli.forEach((stimulus, stimulusIdx) => {
    if (stimulus.taskType === "complete_words") {
      const itemIds = stimulus.gaps.map((g) => g.id);
      screens.push({ stimulusIdx, questionIdx: 0, itemIds, firstItem: next });
      next += itemIds.length;
      return;
    }
    stimulus.questions.forEach((q, questionIdx) => {
      screens.push({ stimulusIdx, questionIdx, itemIds: [q.id], firstItem: next });
      next += 1;
    });
  });
  return screens;
}

/** How many Items a Module holds — every gap and every question. */
export function readingItemCount(mod: ServedReadingModule): number {
  return readingScreens(flattenReadingModule(mod)).reduce((n, screen) => n + screen.itemIds.length, 0);
}

/**
 * Builds one ScoreRequest per Task Type present in the given Module, grouping the Items of every
 * Stimulus of that Task Type together (matching POST /:id/score's per-Task-Type batching). Every
 * Item the Module contains is included, rather than left out, so a Simulation's coverage always
 * reflects the whole Module however the clock or a manual submit ended it: an untyped gap as `""`,
 * an unanswered question as shared's MCQ_UNANSWERED_SENTINEL, both scored incorrect.
 */
export function buildScoreRequests(set: ServedReadingSet, module: RoutedModule, answers: Map<string, string>): DeterministicScoreRequest[] {
  const mod = routedModule(set, module);
  const requests: DeterministicScoreRequest[] = [];

  if (mod.ctwPassages.length > 0) {
    requests.push({
      taskType: "complete_words",
      items: mod.ctwPassages.flatMap((passage) => passage.gaps.map((gap) => ({ itemId: gap.id, typed: answers.get(gap.id) ?? "" }))),
    });
  }
  if (mod.dailyLife.length > 0) {
    requests.push({
      taskType: "daily_life",
      items: mod.dailyLife.flatMap((text) =>
        text.questions.map((q) => ({ itemId: q.id, selectedOptionId: answers.get(q.id) ?? MCQ_UNANSWERED_SENTINEL })),
      ),
    });
  }
  if (mod.academic.length > 0) {
    requests.push({
      taskType: "academic_passage",
      items: mod.academic.flatMap((passage) =>
        passage.questions.map((q) => ({ itemId: q.id, selectedOptionId: answers.get(q.id) ?? MCQ_UNANSWERED_SENTINEL })),
      ),
    });
  }

  return requests;
}
