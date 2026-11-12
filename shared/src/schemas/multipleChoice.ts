import { z } from "zod";
import { SafeIdSchema } from "./primitives.js";

// The multiple-choice question shape Reading and Listening share, so neither section imports the
// other.

export const McqOptionSchema = z.object({ id: SafeIdSchema, text: z.string().min(1) });

// One multiple-choice question shape over a section's skill vocabulary: Reading questions tag a
// ReadingSkillCategory, Listening questions a ListeningSkillCategory. stripAnswers (../servedSet.ts)
// removes the key, the skill and the explanation alike for both.
export function mcqQuestionSchema<Skill extends z.ZodEnum<Record<string, string>>>(skill: Skill) {
  return z.object({
    id: SafeIdSchema,
    stem: z.string().min(1),
    // Three is the floor only because two banked Reading Sets (rd-efd07fb4, rd-eef47b63) have
    // 3-option questions. A new question has exactly four: the generation guide says so and
    // readingGenerator's advisory "option-count" check backs it up.
    options: z.array(McqOptionSchema).min(3).max(4), // options carry no correctness flag
    correctOptionId: SafeIdSchema,                   // stripped
    skill,                                           // stripped (weakness tracking; not User-facing before answering)
    explanationZh: z.string().min(1),                // stripped — key rationale + per-distractor rationale
  });
}
