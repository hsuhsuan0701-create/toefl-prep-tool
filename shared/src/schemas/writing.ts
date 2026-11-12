import { z } from "zod";
import { SentenceFrameError, parseSentenceFrame } from "../sentenceFrame.js";
import { advisoryNotes } from "./advisoryNotes.js";
import { boundedPlanText, distinctions, GenerationDomainFamilySchema, noveltyKey, requiredConcepts } from "./planFields.js";
import { base, SafeIdSchema } from "./primitives.js";

// Writing: the Plan, the Set the model writes (Build a Sentence, Email, Academic Discussion) and
// the Set as persisted.

const BuildSentenceSituationPlanSchema = z.object({
  domain: GenerationDomainFamilySchema,
  situation: boundedPlanText,
  participantRoles: z.tuple([boundedPlanText, boundedPlanText]),
  noveltyKey,
  requiredConcepts,
  distinguishesFrom: distinctions,
});

const WritingPlanComponentSchema = z.object({
  domain: GenerationDomainFamilySchema,
  noveltyKey,
  requiredConcepts,
  distinguishesFrom: distinctions,
});

export const WritingGenerationPlanSchema = z.object({
  version: z.literal("cross-set-diversity-v1"),
  kind: z.literal("writing"),
  buildASentence: z.object({
    situations: z.tuple([
      BuildSentenceSituationPlanSchema,
      BuildSentenceSituationPlanSchema,
      BuildSentenceSituationPlanSchema,
      BuildSentenceSituationPlanSchema,
      BuildSentenceSituationPlanSchema,
      BuildSentenceSituationPlanSchema,
      BuildSentenceSituationPlanSchema,
      BuildSentenceSituationPlanSchema,
      BuildSentenceSituationPlanSchema,
      BuildSentenceSituationPlanSchema,
    ]),
  }),
  email: WritingPlanComponentSchema.extend({
    situation: boundedPlanText,
    recipientRole: boundedPlanText,
    communicativeActs: z.tuple([
      boundedPlanText,
      boundedPlanText,
      boundedPlanText,
    ]),
  }),
  academicDiscussion: WritingPlanComponentSchema.extend({
    proposition: boundedPlanText,
    competingValues: z.tuple([boundedPlanText, boundedPlanText]),
  }),
});

export type WritingGenerationPlan =
  z.infer<typeof WritingGenerationPlanSchema>;

// One Build a Sentence Item as the model emits it. `frame` is required and nullable here, optional on
// the persisted Item: this object becomes JSON Schema for the reasoning providers, and Codex rejects a
// schema with a property its `required` list omits (isCodexStrictOutputSchema in
// server/src/services/reasoning/codexRunner.ts). So the model says "no frame" with `null`, and
// toPersistedWritingSet drops the null before a candidate becomes a Set. A generated Item with no frame
// fails the `frame-missing` conformance check (buildASentenceConformance.ts) in any case.
const BuildASentenceGenerationItemSchema = z.object({
  id: SafeIdSchema, prompt: z.string(),
  frame: z.string().min(1).nullable(),
  tiles: z.array(z.string().min(1)).min(3),
  // Tile TEXT, never blank indices — the served `tiles` array is permuted per request, so an
  // index-keyed answer would mean something different on every serve.
  answers: z.array(z.array(z.string().min(1)).min(3)).min(1),
});

// One Build a Sentence Item as it is persisted and served: the generation Item with an optional
// `frame`, the partial sentence the tiles complete, blanks written as `___` (../sentenceFrame.ts).
//
// It stays loose because narrowing a Set schema makes banked Sets unloadable (schemas.test.ts
// re-parses every banked Writing Set): `frame` is optional and three tiles are enough here. The rules
// only a new Set must meet (a frame present, the blank/tile arithmetic, 4–10 tiles, no capitalised
// tile, no tile ending the sentence) are buildASentenceConformance.ts's, where a violation buys a
// regeneration. What this schema enforces is that a frame, when present, parses, and that "no frame"
// is one state on disk (no key), not two.
//
// `timeLimitSec` is carried by every Item of the older banked Sets. Nothing reads it (Build a Sentence
// is timed as one Task-level budget) and generation no longer asks for it; it stays declared so a
// strip-by-default parse keeps it in those Sets and in what GET /api/sets/:id serves. Only the
// persisted Item may declare it: an optional key on the generation Item would fail Codex's
// strict-output check.
export const BuildASentenceItemSchema = BuildASentenceGenerationItemSchema.extend({
  frame: z.string().min(1).optional(),
  timeLimitSec: z.literal(40).optional(),
}).superRefine((item, ctx) => {
  if (item.frame === undefined) return;
  try {
    parseSentenceFrame(item.frame);
  } catch (err) {
    ctx.addIssue({
      code: "custom",
      path: ["frame"],
      message: err instanceof SentenceFrameError ? err.message : "frame could not be parsed",
    });
  }
});

export const WritingGenerationInputSchema = z.object({
  ...base, kind: z.literal("writing"),
  buildASentence: z.object({
    items: z.array(BuildASentenceGenerationItemSchema).length(10),
  }),
  email: z.object({
    id: SafeIdSchema, scenario: z.string(), to: z.string(), subject: z.string(),
    bullets: z.array(z.string()).length(3), timeLimitSec: z.literal(420),
    wordGuidance: z.object({ min: z.literal(80), max: z.literal(120) }),
  }),
  academicDiscussion: z.object({
    id: SafeIdSchema, courseTitle: z.string(), professorName: z.string(),
    professorPost: z.string(),
    studentPosts: z.array(z.object({ name: z.string(), post: z.string() })).length(2),
    timeLimitSec: z.literal(600), minWords: z.literal(100),
  }),
});
export type WritingGenerationInput =
  z.infer<typeof WritingGenerationInputSchema>;

// The persisted Writing Set: the generation input plus the server-owned fields, with `buildASentence`
// restated so its Items take the persisted shape.
export const WritingSetSchema = WritingGenerationInputSchema.extend({
  advisoryNotes,
  generationPlan: WritingGenerationPlanSchema.optional(),
  buildASentence: z.object({
    items: z.array(BuildASentenceItemSchema).length(10),
  }),
});

/**
 * Converts a parsed Writing candidate, generated or imported, to the persisted shape: an Item whose
 * `frame` is null loses the key. That is all it does; it never invents a frame or touches tiles or
 * answers. Generation and import both call it, and returning `WritingSet` makes skipping it a compile
 * error rather than a null that fails WritingSetSchema at publish.
 */
export function toPersistedWritingSet(candidate: WritingGenerationInput): WritingSet {
  return {
    ...candidate,
    buildASentence: {
      items: candidate.buildASentence.items.map(({ frame, ...rest }) =>
        frame === null ? rest : { ...rest, frame }),
    },
  };
}

export type WritingSet = z.infer<typeof WritingSetSchema>;
