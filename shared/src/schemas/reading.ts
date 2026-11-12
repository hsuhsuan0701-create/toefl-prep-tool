import { z } from "zod";
import { advisoryNotes } from "./advisoryNotes.js";
import { mcqQuestionSchema } from "./multipleChoice.js";
import { boundedPlanText, distinctions, GenerationDomainFamilySchema, noveltyKey, requiredConcepts } from "./planFields.js";
import { base, SafeIdSchema } from "./primitives.js";

// Reading: module composition and time limits, the Plan, the Set as persisted, and the shape
// generation is shown, which differs from the Set for Complete the Words.

// The skill a Reading question is tagged with. The last three are Academic Passage skills that stand
// in as alternates within a passage's five question slots (readingGenerator's ACADEMIC_SKILL_SLOTS)
// rather than adding required ones. Values are only ever added: a banked Set whose tag left this enum
// would fail AnySetSchema and stop loading.
export const ReadingSkillCategory = z.enum([
  "main_idea", "detail", "inference", "vocabulary", "purpose", "organization",
  "figurative_language", "grammatical_complexity", "rhetorical_structure",
]);

// How many Stimuli of each shape each Reading module holds. The generation plan lengths
// (readingPlanEntryCount), the generation input schema and readingGenerator.ts's checks and prompt all
// read it. The Upper Module has no Daily Life text, as in ETS's design; the Lower Module keeps an
// Academic Passage that ETS's does not have, so the lower path still meets expository reading
// (docs/adr/0005). Generation only: the persisted module schema leaves its arrays unbounded, so Sets
// banked under an older composition keep loading.
export const READING_MODULE_COMPOSITION = {
  router: { ctw: 2, dailyLife: 3, academic: 1 },
  lowerModule: { ctw: 1, dailyLife: 2, academic: 1 },
  upperModule: { ctw: 1, dailyLife: 0, academic: 1 },
} as const;

// A shape's Stimulus count summed over the three modules: the length of that shape's plan array.
// Exported so tests derive the same total rather than restating it.
export function readingPlanEntryCount(
  shape: keyof (typeof READING_MODULE_COMPOSITION)["router"],
): number {
  return READING_MODULE_COMPOSITION.router[shape]
    + READING_MODULE_COMPOSITION.lowerModule[shape]
    + READING_MODULE_COMPOSITION.upperModule[shape];
}

// Every plan component carries a domain (cross-set balance), a noveltyKey (exact-collision detection),
// requiredConcepts and up to three prior Sets it is unlike. One entry per Stimulus, so the planner
// commits to the whole Set's spread before any text is written.
const ReadingComponentPlanSchema = z.object({
  domain: GenerationDomainFamilySchema,
  noveltyKey,
  requiredConcepts,
  distinguishesFrom: distinctions,
});
const CtwPlanEntrySchema = ReadingComponentPlanSchema.extend({
  topic: boundedPlanText,
  angle: boundedPlanText,   // the paragraph's specific expository angle/thesis
});
const DailyLifePlanEntrySchema = ReadingComponentPlanSchema.extend({
  genre: boundedPlanText,    // "notice" | "menu" | "text-message chain" | … (novelty axis)
  scenario: boundedPlanText, // the concrete situation the text depicts
});
const AcademicPlanEntrySchema = ReadingComponentPlanSchema.extend({
  title: boundedPlanText,
  discipline: boundedPlanText, // novelty axis
  angle: boundedPlanText,
});
// The plan a published Reading Set carries. Array lengths are unpinned: a published Set is immutable
// and re-parsed on every read, so pinning it to today's composition would make every Set planned under
// an older one unloadable.
const PublishedReadingGenerationPlanSchema = z.object({
  version: z.literal("cross-set-diversity-v1"),
  kind: z.literal("reading"),
  ctwPassages: z.array(CtwPlanEntrySchema),
  dailyLifeTexts: z.array(DailyLifePlanEntrySchema),
  academicPassages: z.array(AcademicPlanEntrySchema),
});

// The plan a fresh Plan call is shown and parsed against (generationPlanner.ts): the published shape,
// with array lengths derived from READING_MODULE_COMPOSITION.
export const ReadingGenerationPlanSchema = PublishedReadingGenerationPlanSchema.extend({
  ctwPassages: z.array(CtwPlanEntrySchema).length(readingPlanEntryCount("ctw")),
  dailyLifeTexts: z.array(DailyLifePlanEntrySchema).length(readingPlanEntryCount("dailyLife")),
  academicPassages: z.array(AcademicPlanEntrySchema).length(readingPlanEntryCount("academic")),
});

export type ReadingGenerationPlan =
  z.infer<typeof ReadingGenerationPlanSchema>;

const ReadingMcqQuestionSchema = mcqQuestionSchema(ReadingSkillCategory);

const CtwGapSchema = z.object({
  id: SafeIdSchema,                        // the scoreable itemId
  prefix: z.string().min(1),               // visible first half, e.g. "univ"
  completion: z.string().min(1),           // the deleted letters — stripped
  blankLength: z.number().int().min(1),    // = completion.length; client renders N letter boxes
  explanationZh: z.string().min(1),        // stripped
});

// The passage as the client walks it: text runs with gap slots punched out. A gap segment carries
// only the id — the visible `prefix` and the box count live on the gap itself, so the deleted
// letters are never part of the rendered document.
const CtwSegmentSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("gap"), gapId: SafeIdSchema }),
]);
// Segments survive stripAnswers untouched (they name no deleted letter), so this is both the stored
// and the client-facing segment shape — named for the consumers that only ever see the public one.
export type PublicCtwSegment = z.infer<typeof CtwSegmentSchema>;

const CtwPassageSchema = z.object({
  id: SafeIdSchema, taskType: z.literal("complete_words"), topic: z.string(),
  segments: z.array(CtwSegmentSchema),
  gaps: z.array(CtwGapSchema).length(10),
  sourceParagraph: z.string(),             // generation provenance — stripped
}).superRefine((passage, ctx) => {
  // `segments` and `gaps` are two halves of one document, consistent by construction when ctest.ts
  // derives them, but an imported passage could pair them wrongly: a dangling reference renders a
  // blank nobody can score, and an unreferenced gap is an Item never shown yet counted.
  const gapIds = new Set(passage.gaps.map((gap) => gap.id));
  const referenceCounts = new Map<string, number>();
  passage.segments.forEach((segment, i) => {
    if (segment.type !== "gap") return;
    if (!gapIds.has(segment.gapId)) {
      ctx.addIssue({
        code: "custom", path: ["segments", i, "gapId"],
        message: `segment references unknown gapId "${segment.gapId}"`,
      });
      return;
    }
    referenceCounts.set(segment.gapId, (referenceCounts.get(segment.gapId) ?? 0) + 1);
  });
  passage.gaps.forEach((gap, i) => {
    const count = referenceCounts.get(gap.id) ?? 0;
    if (count !== 1) {
      ctx.addIssue({
        code: "custom", path: ["gaps", i, "id"],
        message: `gap "${gap.id}" must be referenced by exactly one segment, not ${count}`,
      });
    }
  });
});

const DailyLifeReadingSchema = z.object({
  id: SafeIdSchema, taskType: z.literal("daily_life"),
  genre: z.string(),                       // "notice" | "menu" | "text-message chain" | … (novelty axis)
  text: z.string(),                        // 15–150 words
  questions: z.array(ReadingMcqQuestionSchema).min(2).max(3),
});

const AcademicPassageSchema = z.object({
  id: SafeIdSchema, taskType: z.literal("academic_passage"),
  title: z.string(), discipline: z.string(),
  text: z.string(),                        // ~200 words
  questions: z.array(ReadingMcqQuestionSchema).length(5),
});

// The persisted module: array counts are unbounded so Sets banked under an older composition keep
// loading. Generation binds them (readingModuleGenerationInputSchema).
const ReadingModuleSchema = z.object({
  timeLimitSec: z.number().int().positive(),
  ctwPassages: z.array(CtwPassageSchema),
  dailyLife: z.array(DailyLifeReadingSchema),
  academic: z.array(AcademicPassageSchema),
});
export type ReadingModule = z.infer<typeof ReadingModuleSchema>;

export const ReadingSetSchema = z.object({
  ...base, kind: z.literal("reading"),
  advisoryNotes,
  router: ReadingModuleSchema, lowerModule: ReadingModuleSchema, upperModule: ReadingModuleSchema,
  // The published plan shape, its arrays unpinned (see PublishedReadingGenerationPlanSchema).
  generationPlan: PublishedReadingGenerationPlanSchema.optional(),   // stripped
});

// ETS's Reading module time limits, in seconds (20, 9 and 9 minutes). The Reading Simulation's module
// clock takes them from here (client/src/pages/readingSimulation.ts), not from the Set. They bind only
// the generation input schema; the persisted ReadingModuleSchema accepts any positive integer.
export const READING_MODULE_TIME_LIMITS_SEC = {
  router: 1200,       // 20 min
  lowerModule: 540,   // 9 min
  upperModule: 540,   // 9 min
} as const;

// What Reading generation is shown and parsed against. Unlike the other sections, Reading changes shape
// between the model's output and the Set: the model writes each Complete the Words passage as a bare
// paragraph, and the server derives its segments and gaps (deriveCtwGaps in ctest.ts), so the gap keys
// are correct by construction. The MCQ shapes are the persisted ones.
const CtwGenerationEntrySchema = z.object({
  id: SafeIdSchema, taskType: z.literal("complete_words"), topic: z.string(),
  sourceParagraph: z.string().min(1),
});
// Binds each module's arrays to their exact composition count and its time limit to the official
// value, so a candidate with a wrong count or limit fails to parse at once (and the JSON Schema the
// provider sees states the exact count) rather than after paid follow-up calls.
function readingModuleGenerationInputSchema(
  counts: { ctw: number; dailyLife: number; academic: number },
  timeLimitSec: number,
) {
  return z.object({
    timeLimitSec: z.literal(timeLimitSec),
    ctwPassages: z.array(CtwGenerationEntrySchema).length(counts.ctw),
    dailyLife: z.array(DailyLifeReadingSchema).length(counts.dailyLife),
    academic: z.array(AcademicPassageSchema).length(counts.academic),
  });
}
export const ReadingGenerationInputSchema = z.object({
  ...base, kind: z.literal("reading"),
  router: readingModuleGenerationInputSchema(
    READING_MODULE_COMPOSITION.router, READING_MODULE_TIME_LIMITS_SEC.router,
  ),
  lowerModule: readingModuleGenerationInputSchema(
    READING_MODULE_COMPOSITION.lowerModule, READING_MODULE_TIME_LIMITS_SEC.lowerModule,
  ),
  upperModule: readingModuleGenerationInputSchema(
    READING_MODULE_COMPOSITION.upperModule, READING_MODULE_TIME_LIMITS_SEC.upperModule,
  ),
});
export type ReadingGenerationInput = z.infer<typeof ReadingGenerationInputSchema>;

// The assembled Reading candidate after gap derivation and gap explanations: the published shape
// without a plan. Novelty checks and publication work on it.
export const ReadingGeneratedSetSchema = ReadingSetSchema.omit({ generationPlan: true });
export type ReadingGeneratedSet = z.infer<typeof ReadingGeneratedSetSchema>;

export type ReadingSet = z.infer<typeof ReadingSetSchema>;
