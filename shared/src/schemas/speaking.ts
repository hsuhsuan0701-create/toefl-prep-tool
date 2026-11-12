import { z } from "zod";
import { advisoryNotes } from "./advisoryNotes.js";
import { boundedPlanText, distinctions, GenerationDomainFamilySchema, noveltyKey, requiredConcepts } from "./planFields.js";
import { base, SafeIdSchema } from "./primitives.js";
import { SpeakingAudioProfileSchema } from "./speakingAudioProfile.js";

// Speaking: the Plan, the Set the model writes (Listen and Repeat, Interview) and the Set as
// persisted.

/** The Listen and Repeat response window, in seconds, for items 1–7 in order. */
export const RESPONSE_WINDOW_RAMP = [8, 8, 10, 10, 10, 12, 12] as const;

// Normalised 0–1 bounding box (fractions of image width and height) of the object a Listen and Repeat
// sentence refers to in the Set's scene illustration, which the run highlights. Also the shape
// server/src/services/sceneImage.ts validates the vision pass's answers against.
export const FocusRegionSchema = z.object({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  w: z.number().positive().max(1), h: z.number().positive().max(1),
}).superRefine((region, ctx) => {
  if (region.x + region.w > 1) {
    ctx.addIssue({ code: "custom", path: ["w"], message: "x + w must be at most 1" });
  }
  if (region.y + region.h > 1) {
    ctx.addIssue({ code: "custom", path: ["h"], message: "y + h must be at most 1" });
  }
});
export type FocusRegion = z.infer<typeof FocusRegionSchema>;

const ListenAndRepeatGenerationItemSchema = z.object({
  id: SafeIdSchema, sentence: z.string().min(1), audio: z.string(),
  responseWindowSec: z.union([z.literal(8), z.literal(10), z.literal(12)]),
});

const ListenAndRepeatItemSchema = ListenAndRepeatGenerationItemSchema.extend({
  // Absent means no highlight for this item: the Set has no scene, or the scene does not show this
  // sentence's object. Partial coverage is expected, as in ETS's own illustrations.
  focusRegion: FocusRegionSchema.optional(),
});

function validateResponseWindowRamp(
  items: readonly { responseWindowSec: 8 | 10 | 12 }[],
  ctx: z.RefinementCtx
): void {
  items.forEach((item, i) => {
    if (item.responseWindowSec !== RESPONSE_WINDOW_RAMP[i]) {
      ctx.addIssue({ code: "custom", message: `ramp: item ${i + 1} must be ${RESPONSE_WINDOW_RAMP[i]}s` });
    }
  });
}

const InterviewSchema = z.object({
  scenarioTitle: z.string(), intro: z.string(), introAudio: z.string(),
  questions: z.array(z.object({
    id: SafeIdSchema, type: z.enum(["factual", "experience", "opinion"]),
    question: z.string(), audio: z.string(), responseWindowSec: z.literal(45),
  })).length(4),
});

const SpeakingPlanComponentSchema = z.object({
  domain: GenerationDomainFamilySchema,
  noveltyKey,
  requiredConcepts,
  distinguishesFrom: distinctions,
});

export const SpeakingGenerationPlanSchema = z.object({
  version: z.literal("cross-set-diversity-v1"),
  kind: z.literal("speaking"),
  listenAndRepeat: SpeakingPlanComponentSchema.extend({
    setting: boundedPlanText,
    speakerRole: boundedPlanText,
    communicativePurpose: boundedPlanText,
  }),
  interview: SpeakingPlanComponentSchema.extend({
    topic: boundedPlanText,
    premise: boundedPlanText,
    questionArc: z.tuple([
      boundedPlanText,
      boundedPlanText,
      boundedPlanText,
      boundedPlanText,
    ]),
  }),
});

export type SpeakingGenerationPlan =
  z.infer<typeof SpeakingGenerationPlanSchema>;

// What Speaking generation and import are shown and parsed against. The scene image and focus regions
// are server-owned: absent here, so the JSON Schema never offers them and zod strips them if a producer
// sends them anyway.
export const SpeakingGenerationInputSchema = z.object({
  ...base, kind: z.literal("speaking"),
  listenAndRepeat: z.object({
    scenarioTitle: z.string(), scenarioDescription: z.string(),
    items: z.array(ListenAndRepeatGenerationItemSchema).length(7).superRefine(validateResponseWindowRamp),
  }),
  interview: InterviewSchema,
});
export type SpeakingGenerationInput =
  z.infer<typeof SpeakingGenerationInputSchema>;

export const SpeakingSetSchema = SpeakingGenerationInputSchema.extend({
  advisoryNotes,
  generationPlan: SpeakingGenerationPlanSchema.optional(),
  audioProfile: SpeakingAudioProfileSchema.optional(),
  listenAndRepeat: z.object({
    scenarioTitle: z.string(), scenarioDescription: z.string(),
    introAudio: z.string().optional(),
    // The scene illustration shown while the sentences play, as memory support. Optional, as is
    // focusRegion: a Set whose image generation failed is still fully practisable. `file` is relative
    // to data/ (e.g. "images/scenarios/spk-abc123.webp") and is also its path under /api/
    // (server/src/routes/images.ts).
    image: z.object({ file: z.string(), prompt: z.string(), model: z.literal("gpt-image-2") }).optional(),
    items: z.array(ListenAndRepeatItemSchema).length(7).superRefine(validateResponseWindowRamp),
  }),
});

export type SpeakingSet = z.infer<typeof SpeakingSetSchema>;
