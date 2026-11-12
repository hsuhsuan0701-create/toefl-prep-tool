import { z } from "zod";

// The fields every section's generation Plan is built from: the domain families, bounded text,
// required concepts and how many a Stimulus can carry, and the prior Sets a component is unlike.

export const GenerationDomainFamilySchema = z.enum([
  "campus-academics",
  "workplace-business",
  "community-civic",
  "science-environment",
  "technology-media",
  "arts-culture",
  "health-wellbeing",
  "services-travel",
  "history-social-change",
  "everyday-life",
]);
export type GenerationDomainFamily =
  z.infer<typeof GenerationDomainFamilySchema>;

export const boundedPlanText = z.string()
  .refine((value) => !/\p{Cc}/u.test(value), {
    message: "control characters are not allowed",
  })
  .trim()
  .min(1)
  .max(240);
export const noveltyKey = z.string()
  .refine((value) => !/\p{Cc}/u.test(value), {
    message: "control characters are not allowed",
  })
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
/**
 * The longest a required concept may be, in characters. A required concept is something the content
 * should mention, phrased the way the content would say it ("cheaper fares versus frequent service"),
 * not an instruction about the answer ("a stated preference between ..."), which produces worse prose.
 * Required concepts guide the Plan and the generation prompt; nothing checks the generated text
 * against them word for word.
 *
 * A character cap rather than a word count because z.toJSONSchema carries `.max()` through to the
 * model as `maxLength`, where a `.superRefine` would be dropped.
 */
export const REQUIRED_CONCEPT_MAX_CHARS = 60;

const requiredConceptText = boundedPlanText.max(REQUIRED_CONCEPT_MAX_CHARS);

// The share of a required concept's content words a Stimulus is assumed to need. Used only to size
// how many required concepts a Stimulus can carry (maxSupportableRequiredConcepts below).
export const REQUIRED_CONCEPT_COVERAGE = 0.6;

export function boundedRequiredConcepts(min: number, max: number) {
  return z.array(requiredConceptText).min(min).max(max)
    .superRefine((concepts, ctx) => {
      const normalized = concepts.map((concept) => concept.toLocaleLowerCase());
      if (new Set(normalized).size !== normalized.length) {
        ctx.addIssue({
          code: "custom",
          message: "required concepts must be unique",
        });
      }
    });
}

// The default required-concept bound, for every plan component except Listen and Choose a Response's
// (see LISTENING_LCR_REQUIRED_CONCEPTS).
export const requiredConcepts = boundedRequiredConcepts(2, 5);

// A conservative estimate of the share of a Stimulus's words that carry content rather than grammar,
// used only to derive the bounds below. Real short utterances run higher, so the bounds err small.
const REQUIRED_CONCEPT_CONTENT_WORD_DENSITY = 0.5;
// A required concept averages about three content words (the generation guides' examples run 2–4), so
// at REQUIRED_CONCEPT_COVERAGE each concept is sized as needing two of a Stimulus's content words.
const REQUIRED_CONCEPT_AVG_CONTENT_TOKENS = 3;
const REQUIRED_CONCEPT_TOKENS_NEEDED = Math.ceil(REQUIRED_CONCEPT_AVG_CONTENT_TOKENS * REQUIRED_CONCEPT_COVERAGE);

/** How many required concepts a Stimulus of `words` words can carry, under the estimates above.
 * Exported so server/test/requiredConceptBudget.test.ts can recompute the derivation. */
export function maxSupportableRequiredConcepts(words: number): number {
  return Math.floor((words * REQUIRED_CONCEPT_CONTENT_WORD_DENSITY) / REQUIRED_CONCEPT_TOKENS_NEEDED);
}

// A prior Set a plan component is deliberately unlike, cited by id. One schema serves every section's
// plan, so the prefix accepts any section; a citation the bank cannot support for that Task Type is
// stripped at ingest (stripInvalidDistinctions in generationNovelty.ts) rather than failing the Plan.
const PlanDistinctionSchema = z.object({
  setId: z.string().regex(/^(?:spk|wri|rd|lsn)-[A-Za-z0-9_-]+$/),
  reason: boundedPlanText,
});
export const distinctions = z.array(PlanDistinctionSchema).max(3);
