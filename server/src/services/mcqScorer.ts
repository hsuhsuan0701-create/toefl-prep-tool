import { MCQ_UNANSWERED_SENTINEL } from "@toefl-prep/shared";

/**
 * Scores one multiple-choice Response. MCQ_UNANSWERED_SENTINEL, and any id that names none of the
 * question's options, is `valid: false` and incorrect.
 */
export function scoreMcq(
  q: { options: Array<{ id: string }>; correctOptionId: string },
  selectedOptionId: string
): { correct: boolean; valid: boolean } {
  if (selectedOptionId === MCQ_UNANSWERED_SENTINEL) return { correct: false, valid: false };
  const valid = q.options.some((o) => o.id === selectedOptionId);
  if (!valid) return { correct: false, valid: false };
  return { correct: selectedOptionId === q.correctOptionId, valid: true };
}
