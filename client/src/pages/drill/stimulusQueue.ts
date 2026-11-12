import { MCQ_UNANSWERED_SENTINEL, type DeterministicScoreRequest, type ServedListeningStimulus } from "@toefl-prep/shared";
import type { QuestionedStimulus } from "../../components/StimulusQuestions";

// The pure half of the deterministic Stimulus queue: the parts of the Reading and Listening Drill
// run bodies that are decisions rather than DOM. The component half is next door in
// StimulusQueueRun.tsx (react/only-export-components; the same split as drillShell.ts and
// DrillScreens.tsx).
//
// Everything here dispatches on the Stimulus's own `taskType`, never on which page is asking. That
// is what lets one queue serve both sections without a mode axis: "this Stimulus is answered by
// typing letters", "this Stimulus is its single Item", "this Stimulus must be heard before it can be
// answered" are all properties of the Stimulus, and the discriminated served union already carries
// them.

/**
 * "Stimulus" pluralizes irregularly ("Stimuli", not "Stimuluses"). One helper so every call site
 * agrees.
 */
export function stimulusCountLabel(count: number): string {
  return `${count} ${count === 1 ? "Stimulus" : "Stimuli"}`;
}

/**
 * The Response(s) the User has entered for one Stimulus, as the scorer wants them.
 *
 * Three shapes for seven Task Types, and which one applies is read off the Stimulus:
 *  * Complete the Words — one Item per gap, carrying the letters typed into it.
 *  * Listen and Choose a Response — the Stimulus is its one Item (no stem, no separate question),
 *    so the Item id is the Stimulus id.
 *  * everything else (Read in Daily Life, Read an Academic Passage, Conversation, Announcement,
 *    Academic Talk) — one Item per Question.
 *
 * An unanswered question is sent as shared's MCQ_UNANSWERED_SENTINEL and an untyped gap as `""`;
 * both score as wrong. A Drill submits
 * the whole Stimulus at once, so a skipped Item must still be sent and scored rather than omitted.
 */
export function deterministicScoreRequest(
  stimulus: QuestionedStimulus,
  answers: ReadonlyMap<string, string>,
): DeterministicScoreRequest {
  if (stimulus.taskType === "complete_words") {
    return {
      taskType: stimulus.taskType,
      items: stimulus.gaps.map((gap) => ({ itemId: gap.id, typed: answers.get(gap.id) ?? "" })),
    };
  }
  if (stimulus.taskType === "listen_choose") {
    return {
      taskType: stimulus.taskType,
      items: [{ itemId: stimulus.id, selectedOptionId: answers.get(stimulus.id) ?? MCQ_UNANSWERED_SENTINEL }],
    };
  }
  return {
    taskType: stimulus.taskType,
    items: stimulus.questions.map((q) => ({ itemId: q.id, selectedOptionId: answers.get(q.id) ?? MCQ_UNANSWERED_SENTINEL })),
  };
}

/**
 * Whether this Stimulus is heard rather than read — i.e. whether its Item(s) sit behind the leak
 * gate (components/StimulusQuestions.tsx's ListeningStimulusQuestions: no option text and no answer
 * control in the DOM before the audio ends).
 *
 * Derived from the Task Type rather than passed in as a section, deliberately: the gate belongs to
 * the Stimulus, not to the page, and a queue that reads it this way cannot be handed a Listening
 * Stimulus with the gate switched off.
 */
export function isListeningStimulus(stimulus: QuestionedStimulus): stimulus is ServedListeningStimulus {
  return (
    stimulus.taskType === "listen_choose" ||
    stimulus.taskType === "conversation" ||
    stimulus.taskType === "announcement" ||
    stimulus.taskType === "academic_talk"
  );
}
