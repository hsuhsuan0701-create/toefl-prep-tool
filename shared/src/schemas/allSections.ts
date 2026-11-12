import { z } from "zod";
import { ListeningGenerationPlanSchema, ListeningSetSchema } from "./listening.js";
import { ReadingGenerationPlanSchema, ReadingSetSchema } from "./reading.js";
import { SpeakingGenerationPlanSchema, SpeakingSetSchema } from "./speaking.js";
import { WritingGenerationPlanSchema, WritingSetSchema } from "./writing.js";

// The unions over all four sections. It imports every section module, and no schema module
// imports it.

export const GenerationPlanSchema = z.discriminatedUnion("kind", [
  SpeakingGenerationPlanSchema,
  WritingGenerationPlanSchema,
  ReadingGenerationPlanSchema,
  ListeningGenerationPlanSchema,
]);
export type GenerationPlan = z.infer<typeof GenerationPlanSchema>;

export const AnySetSchema = z.discriminatedUnion("kind", [SpeakingSetSchema, WritingSetSchema, ReadingSetSchema, ListeningSetSchema]);
export type AnySet = z.infer<typeof AnySetSchema>;
