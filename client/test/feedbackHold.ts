import { FEEDBACK_HOLD_MS } from "../src/pages/drill/stimulusQueue";

/**
 * Waits out a Drill Stimulus's feedback hold, so the next press on "Next Stimulus" or "See results"
 * is a separate, deliberate one rather than the tail of the press that checked the Stimulus
 * (stimulusQueue.ts's FEEDBACK_HOLD_MS). A plain timer, so it also passes under fake timers that
 * advance with real time.
 */
export function afterFeedbackHold(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, FEEDBACK_HOLD_MS + 20));
}
