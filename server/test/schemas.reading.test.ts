import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  AnySetSchema,
  GenerationPlanSchema,
  READING_MODULE_COMPOSITION,
  READING_MODULE_TIME_LIMITS_SEC,
  ReadingGenerationInputSchema,
  readingPlanEntryCount,
  ReadingSetSchema,
  stripAnswers,
} from "@toefl-prep/shared";
import { READING_FIXTURE, READING_PLAN_MARKER } from "./fixtures/reading-set.fixture.js";
import { collectObjectKeys, collectSchemaKeys } from "./schemaAssertions.js";

// A minimal generation input that is schema-valid. Not READING_FIXTURE: that is a published Set,
// whose CtW passages already carry segments and gaps and whose modules do not match the exact
// composition counts ReadingGenerationInputSchema binds its arrays to. Word counts and prose are
// placeholders: the schema checks structure only, and the word-count guidance is checked at
// generation (deterministicReadingPreChecks in readingGenerator.ts).
function mcqEntry(id: string, correctId: string) {
  return {
    id, stem: `Stem for ${id}?`,
    options: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }],
    correctOptionId: correctId, skill: "detail" as const, explanationZh: "解析",
  };
}
function dailyLifeEntry(id: string) {
  return {
    id, taskType: "daily_life" as const, genre: "notice", text: "placeholder text",
    questions: [mcqEntry(`${id}-q1`, "a"), mcqEntry(`${id}-q2`, "b")],
  };
}
function academicEntry(id: string) {
  return {
    id, taskType: "academic_passage" as const, title: "Title", discipline: "discipline",
    text: "placeholder text",
    questions: [1, 2, 3, 4, 5].map((n) => mcqEntry(`${id}-q${n}`, "a")),
  };
}
function ctwGenerationEntry(id: string, sourceParagraph = "A short placeholder paragraph.") {
  return { id, taskType: "complete_words" as const, topic: "topic", sourceParagraph };
}
function moduleGenerationInput(
  counts: { ctw: number; dailyLife: number; academic: number },
  prefix: string,
  // timeLimitSec is a per-module literal (READING_MODULE_TIME_LIMITS_SEC), so a schema-valid
  // generation input supplies the exact value for the module being built.
  timeLimitSec: number,
) {
  return {
    timeLimitSec,
    ctwPassages: Array.from({ length: counts.ctw }, (_, i) => ctwGenerationEntry(`${prefix}-ctw${i + 1}`)),
    dailyLife: Array.from({ length: counts.dailyLife }, (_, i) => dailyLifeEntry(`${prefix}-dl${i + 1}`)),
    academic: Array.from({ length: counts.academic }, (_, i) => academicEntry(`${prefix}-ap${i + 1}`)),
  };
}
/**
 * READING_FIXTURE is a published Set and keeps an older plan (6 `dailyLifeTexts`, a Daily Life text
 * in the Upper Module) on purpose: that is a shape the persisted schema must go on accepting. This is
 * the same plan at the current composition, for the tests about what a fresh Plan call may emit. The
 * count comes from `readingPlanEntryCount`, the derivation ReadingGenerationPlanSchema pins its array
 * lengths with, rather than from a hardcoded number.
 */
function currentCompositionPlan() {
  const plan = structuredClone(READING_FIXTURE.generationPlan!);
  return {
    ...plan,
    dailyLifeTexts: plan.dailyLifeTexts.slice(0, readingPlanEntryCount("dailyLife")),
  };
}

function validGenerationInput() {
  return {
    id: "rd-schematest", kind: "reading" as const, source: "generated" as const,
    createdAt: "2026-08-09T00:00:00.000Z",
    router: moduleGenerationInput(READING_MODULE_COMPOSITION.router, "r", READING_MODULE_TIME_LIMITS_SEC.router),
    lowerModule: moduleGenerationInput(
      READING_MODULE_COMPOSITION.lowerModule, "lo", READING_MODULE_TIME_LIMITS_SEC.lowerModule,
    ),
    upperModule: moduleGenerationInput(
      READING_MODULE_COMPOSITION.upperModule, "up", READING_MODULE_TIME_LIMITS_SEC.upperModule,
    ),
  };
}

describe("reading set schema", () => {
  it("parses the fixture through AnySetSchema", () => {
    expect(AnySetSchema.parse(READING_FIXTURE).kind).toBe("reading");
  });

  // Generated Reading MCQs carry 4 options (the generation guide asks for it, and the advisory
  // `option-count` check flags fewer), but the schema floor is `.min(3)`: two banked Sets
  // (rd-efd07fb4, rd-eef47b63) carry 3-option questions, and published Sets are never edited. The
  // fixture's own MCQs have 3 options, so this pins that shape by name rather than by coincidence.
  it("still parses a legacy 3-option MCQ — the .min(3) floor is legacy-compat, not the generation target", () => {
    expect(READING_FIXTURE.router.dailyLife[0]!.questions[0]!.options).toHaveLength(3);
    expect(AnySetSchema.safeParse(READING_FIXTURE).success).toBe(true);
    // The floor itself still holds: 2 options is malformed, not legacy.
    const bad = structuredClone(READING_FIXTURE);
    const question = bad.router.dailyLife[0]!.questions[0]!;
    question.options = question.options.slice(0, 2);
    question.correctOptionId = question.options[0]!.id;
    expect(AnySetSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a CtW passage without exactly 10 gaps", () => {
    const bad = structuredClone(READING_FIXTURE);
    const passage = bad.router.ctwPassages[0]!;
    const dropped = passage.gaps.pop()!;
    // Drop the orphaned segment reference too, so the only rule left to fail is the gap count.
    passage.segments = passage.segments.filter((s) => s.type === "text" || s.gapId !== dropped.id);
    expect(AnySetSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a segment referencing a gapId that does not exist", () => {
    const bad = structuredClone(READING_FIXTURE);
    const passage = bad.router.ctwPassages[0]!;
    passage.segments = passage.segments.map((s) =>
      s.type === "gap" && s.gapId === "ctw-1-g1" ? { ...s, gapId: "ctw-1-g99" } : s
    );
    const result = AnySetSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("ctw-1-g99");
  });

  it("rejects a gap that no segment references", () => {
    const bad = structuredClone(READING_FIXTURE);
    const passage = bad.router.ctwPassages[0]!;
    // g10's slot now points at g1, so g1 is referenced twice and g10 not at all.
    passage.segments = passage.segments.map((s) =>
      s.type === "gap" && s.gapId === "ctw-1-g10" ? { ...s, gapId: "ctw-1-g1" } : s
    );
    const result = AnySetSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("ctw-1-g10");
  });

  it("accepts a plan at the current composition through GenerationPlanSchema", () => {
    expect(GenerationPlanSchema.parse(currentCompositionPlan()).kind).toBe("reading");
  });

  // The current composition has no Daily Life text in the Upper Module (RR-25-12 Table 1), so a plan
  // holds 5 `dailyLifeTexts` where banked Sets hold 6. `generationPlan` is persisted inside every
  // published Set and re-validated on every read (setStore.ts), so binding it to the current counts
  // would make the banked Sets unloadable. So the schema is split: ReadingSetSchema takes the
  // unpinned published plan shape, GenerationPlanSchema (the model-facing union) the derived counts.
  // Both halves are asserted on the same fixture, so removing either fails.
  it("keeps a legacy published plan (6 daily-life entries) parseable as a Set while the generation union pins 5", () => {
    expect(READING_FIXTURE.generationPlan!.dailyLifeTexts).toHaveLength(6);
    expect(READING_FIXTURE.upperModule.dailyLife).toHaveLength(1);
    // The archive half: still a valid published Set, plan and Upper Module daily-life text included.
    const parsed = ReadingSetSchema.parse(READING_FIXTURE);
    expect(parsed.generationPlan!.dailyLifeTexts).toHaveLength(6);
    expect(AnySetSchema.safeParse(READING_FIXTURE).success).toBe(true);
    // The generation half: that same plan is not one a fresh Plan call may emit.
    expect(GenerationPlanSchema.safeParse(READING_FIXTURE.generationPlan).success).toBe(false);
    expect(currentCompositionPlan().dailyLifeTexts).toHaveLength(5);
  });

  // The same split at the module level: a new generation candidate's Upper Module holds no Daily
  // Life text at all.
  it("rejects a generation input whose upper Module still carries a Daily Life text", () => {
    expect(READING_MODULE_COMPOSITION.upperModule.dailyLife).toBe(0);
    const valid = validGenerationInput();
    expect(ReadingGenerationInputSchema.safeParse(valid).success).toBe(true);
    expect(valid.upperModule.dailyLife).toHaveLength(0);
    const bad = validGenerationInput();
    bad.upperModule.dailyLife.push(dailyLifeEntry("up-dl-extra"));
    expect(ReadingGenerationInputSchema.safeParse(bad).success).toBe(false);
  });

  // A generation-input CtW passage carries only {id, taskType, topic, sourceParagraph}; the server
  // derives segments and gaps. Asserting only that a key is absent would prove nothing, since zod
  // strips unknown keys from a non-strict object, so these two tests pin both what is present and
  // what is required.
  it("a valid generation input parses with sourceParagraph on every CtW entry and no segments/gaps", () => {
    const parsed = ReadingGenerationInputSchema.parse(validGenerationInput());
    for (const moduleName of ["router", "lowerModule", "upperModule"] as const) {
      for (const passage of parsed[moduleName].ctwPassages) {
        expect(typeof passage.sourceParagraph).toBe("string");
        expect(passage.sourceParagraph.length).toBeGreaterThan(0);
        expect(passage).not.toHaveProperty("segments");
        expect(passage).not.toHaveProperty("gaps");
      }
    }
  });

  it("rejects a generation input whose CtW entry is missing sourceParagraph", () => {
    const bad = validGenerationInput();
    const { sourceParagraph: _sourceParagraph, ...withoutParagraph } = bad.router.ctwPassages[0]!;
    (bad.router.ctwPassages as unknown[])[0] = withoutParagraph;
    const result = ReadingGenerationInputSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("sourceParagraph");
  });

  // The module arrays are bound to READING_MODULE_COMPOSITION's exact count per module, so a model
  // emitting the wrong number of Stimuli fails at the parse rather than at a later check.
  it("rejects a router module with the wrong number of CtW passages (composition is bound, not just checked later)", () => {
    const bad = validGenerationInput();
    bad.router.ctwPassages.push(ctwGenerationEntry("r-ctw-extra"));
    expect(bad.router.ctwPassages).toHaveLength(READING_MODULE_COMPOSITION.router.ctw + 1);
    expect(ReadingGenerationInputSchema.safeParse(bad).success).toBe(false);
  });

  // ETS's module time limits (router 1200 s, lower 540 s, upper 540 s) are bound per module, as the
  // composition counts are, so a generate call cannot produce a Set with an invented number.
  it("rejects a generation input whose timeLimitSec is not the official value, per module", () => {
    const wrongRouter = validGenerationInput();
    wrongRouter.router.timeLimitSec = 1080; // Listening's router value, not Reading's
    expect(ReadingGenerationInputSchema.safeParse(wrongRouter).success).toBe(false);

    const wrongLower = validGenerationInput();
    wrongLower.lowerModule.timeLimitSec = 600; // a plausible round number, but not ETS's
    expect(ReadingGenerationInputSchema.safeParse(wrongLower).success).toBe(false);

    const wrongUpper = validGenerationInput();
    wrongUpper.upperModule.timeLimitSec = 420; // Listening's lower value, not Reading's upper
    expect(ReadingGenerationInputSchema.safeParse(wrongUpper).success).toBe(false);
  });

  it("accepts a generation input carrying exactly the official per-module timeLimitSec values", () => {
    const parsed = ReadingGenerationInputSchema.parse(validGenerationInput());
    expect(parsed.router.timeLimitSec).toBe(READING_MODULE_TIME_LIMITS_SEC.router);
    expect(parsed.lowerModule.timeLimitSec).toBe(READING_MODULE_TIME_LIMITS_SEC.lowerModule);
    expect(parsed.upperModule.timeLimitSec).toBe(READING_MODULE_TIME_LIMITS_SEC.upperModule);
  });
});

describe("stripAnswers(reading) leak scan", () => {
  const KNOWN_SECRETS = [
    ...READING_FIXTURE.router.ctwPassages[0]!.gaps.map((g) => g.completion),
    "sourceParagraph",
    "SEE deriveCtwGaps GOLDEN TEXT", // the sourceParagraph's own value
    "correctOptionId",
    "skill",
    "explanationZh",
    "因為文中明確提到", // explanation substring
    "generationPlan",
    READING_PLAN_MARKER, // plan content, not just the field name
  ];

  it("removes every answer-bearing string", () => {
    const serialized = JSON.stringify(stripAnswers(READING_FIXTURE));
    for (const secret of KNOWN_SECRETS) expect(serialized).not.toContain(secret);
  });

  it("keeps what the client renders", () => {
    const pub = JSON.stringify(stripAnswers(READING_FIXTURE));
    expect(pub).toContain("segments");
    expect(pub).toContain("blankLength");
    expect(pub).toContain("prefix");
    expect(pub).toContain("stem");
    expect(pub).toContain("Option A");
    expect(pub).toContain("Stem for dl-1-q1?");
    expect(pub).toContain("lowerModule"); // both variants ship stripped; routing is server-side
    expect(pub).toContain("upperModule");
  });

  // The two tests above enumerate known secrets and known kept fields, so neither notices a new
  // field: a per-gap list of accepted completions, say, would hand over every accepted spelling and
  // still leave both green if it shipped unstripped. The two tests below classify every key by name
  // instead: the stripped payload may hold nothing outside ALLOWED_KEYS, and every key
  // ReadingSetSchema can produce must be classified as kept or stripped, so a new schema field forces
  // a decision here rather than shipping unclassified. schemas.listening.test.ts does the same.
  const ALLOWED_KEYS = new Set([
    // Set
    "id", "kind", "source", "createdAt", "router", "lowerModule", "upperModule",
    // ReadingModule
    "timeLimitSec", "ctwPassages", "dailyLife", "academic",
    // CtwPassage / CtwSegment / CtwGap; completion and explanationZh are stripped, see below
    "taskType", "topic", "segments", "gaps", "type", "text", "gapId", "prefix", "blankLength",
    // DailyLifeReading / AcademicPassage
    "genre", "title", "discipline", "questions",
    // MCQ; correctOptionId, skill and explanationZh are stripped, see below
    "stem", "options",
    // The advisory notes a Set was published with, and the fields of one note. Kept: see the same
    // list in schemas.listening.test.ts for why a note carries nothing an answer or a passage could
    // hide in.
    "advisoryNotes", "check", "detail", "take", "itemPosition", "conflictingSetIds", "score",
    "measuredWpm", "targetWpm", "minWpm", "maxWpm",
    // Which clip a speech-rate note is about: a server-derived id constrained to a safe filename
    // segment, so it names the clip without carrying a word of its content.
    "clipId",
  ]);
  const STRIPPED_KEYS = new Set([
    "sourceParagraph", "completion", "explanationZh", "correctOptionId", "skill", "generationPlan",
    // These occur only inside `generationPlan`, which stripAnswers drops whole: the plan's version,
    // its plan-only array names (`dailyLifeTexts` and `academicPassages`; its `ctwPassages` shares
    // the name of a kept module field), each entry's domain, noveltyKey, requiredConcepts and
    // distinguishesFrom, and the plan-only `angle` and `scenario`. `topic`, `genre`, `title` and
    // `discipline` are allowed because the Set fields of those names are kept.
    "version", "dailyLifeTexts", "academicPassages",
    "domain", "noveltyKey", "requiredConcepts", "distinguishesFrom", "angle", "scenario",
    // A plan distinction's fields (the elements of distinguishesFrom). READING_FIXTURE's
    // distinguishesFrom arrays are empty, so only the schema walk below sees these.
    "setId", "reason",
  ]);

  it("keeps only allowlisted keys in the stripped payload — a field added anywhere without a matching strip fails this test, not just a future review", () => {
    const publicKeys = collectObjectKeys(stripAnswers(READING_FIXTURE));
    const unexpected = [...publicKeys].filter((key) => !ALLOWED_KEYS.has(key));
    expect(unexpected).toEqual([]);
  });

  // A scan of the fixture sees only the keys it populates, so it misses an optional field, and an
  // optional field is the only kind a schema can gain: banked Sets are immutable and re-parsed on
  // every read, so a new required field would make them unloadable. Walking ReadingSetSchema's own
  // JSON Schema sees every key the schema can produce, populated in the fixture or not.
  it("classifies every key ReadingSetSchema can EVER produce as kept or stripped — including optional fields no fixture populates", () => {
    const sourceKeys = collectSchemaKeys(z.toJSONSchema(ReadingSetSchema));
    const unclassified = [...sourceKeys].filter(
      (key) => !ALLOWED_KEYS.has(key) && !STRIPPED_KEYS.has(key),
    );
    expect(unclassified).toEqual([]);
  });
});
