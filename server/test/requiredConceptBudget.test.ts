import { describe, expect, it } from "vitest";
import {
  LCR_UTTERANCE_DESIGN_WORD_RANGE,
  ListeningGenerationPlanSchema,
  ReadingGenerationPlanSchema,
  SpeakingGenerationPlanSchema,
  WritingGenerationPlanSchema,
  maxSupportableRequiredConcepts,
} from "@toefl-prep/shared";

// The shared 2-5 requiredConcepts bound suits Stimuli of 15-250 words and cannot be met by a Listen
// and Choose a Response utterance of about 4-8 words. So shared/src/schemas/listening.ts derives
// that Task Type's bound from `maxSupportableRequiredConcepts`, a function of
// REQUIRED_CONCEPT_COVERAGE and the guide's stated word range. This recomputes the derivation from
// the live constants and asserts the schema's configured bound equals it, so the bound cannot become
// a hand-copied literal.
describe("Listen-and-Choose requiredConcepts bound stays derived from its word budget", () => {
  it("enforces exactly the bound the word-budget derivation yields for a Listen and Choose a Response entry", () => {
    const derivedMin = maxSupportableRequiredConcepts(LCR_UTTERANCE_DESIGN_WORD_RANGE.min);
    const derivedMax = maxSupportableRequiredConcepts(LCR_UTTERANCE_DESIGN_WORD_RANGE.max);

    // The schema is the source of truth for what is enforced: parse a minimal listenChoose plan
    // entry at the derived boundary counts, rather than keeping a second copy of "1" and "2".
    const baseEntry = {
      domain: "everyday-life" as const,
      noveltyKey: "pin-test-lcr",
      distinguishesFrom: [],
      topic: "pin test topic",
      speakerRole: "student",
    };
    const withConcepts = (count: number) => ({
      ...baseEntry,
      requiredConcepts: Array.from({ length: count }, (_, i) => `pin test concept ${i}`),
    });

    expect(
      ListeningGenerationPlanSchema.shape.listenChoose.element.safeParse(withConcepts(derivedMin)).success,
      `derived min (${derivedMin}) must be schema-valid`,
    ).toBe(true);
    if (derivedMin > 1) {
      expect(
        ListeningGenerationPlanSchema.shape.listenChoose.element.safeParse(withConcepts(derivedMin - 1)).success,
        `one below the derived min (${derivedMin - 1}) must be schema-invalid, or the schema's min is looser than the derivation`,
      ).toBe(false);
    }
    expect(
      ListeningGenerationPlanSchema.shape.listenChoose.element.safeParse(withConcepts(derivedMax)).success,
      `derived max (${derivedMax}) must be schema-valid`,
    ).toBe(true);
    expect(
      ListeningGenerationPlanSchema.shape.listenChoose.element.safeParse(withConcepts(derivedMax + 1)).success,
      `one above the derived max (${derivedMax + 1}) must be schema-invalid, or the schema's max is looser than the word budget supports`,
    ).toBe(false);
  });

  it("leaves Reading, Speaking and Writing plan components on the default 2-5 bound", () => {
    const ctwShape = ReadingGenerationPlanSchema.shape.ctwPassages.element.shape.requiredConcepts;
    const listenRepeatShape = SpeakingGenerationPlanSchema.shape.listenAndRepeat.shape.requiredConcepts;
    const emailShape = WritingGenerationPlanSchema.shape.email.shape.requiredConcepts;
    for (const shape of [ctwShape, listenRepeatShape, emailShape]) {
      expect(shape.safeParse(["a", "b"]).success).toBe(true);
      expect(shape.safeParse(["a"]).success).toBe(false);
      expect(shape.safeParse(["a", "b", "c", "d", "e"]).success).toBe(true);
      expect(shape.safeParse(["a", "b", "c", "d", "e", "f"]).success).toBe(false);
    }
  });
});
