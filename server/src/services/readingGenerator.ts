import { z } from "zod";
import {
  mcqQuestionSchema,
  READING_MODULE_COMPOSITION,
  ReadingGeneratedSetSchema,
  ReadingGenerationInputSchema,
  ReadingSetSchema,
  ReadingSkillCategory,
  type GenerationPlan,
  type ReadingGeneratedSet,
  type ReadingGenerationInput,
  type ReadingGenerationPlan,
  type ReadingModule,
  type ReadingSet,
} from "@toefl-prep/shared";
import { toProviderJsonSchema } from "./reasoning/jsonSchema.js";
import { CtwDerivationError, deriveCtwGaps } from "./ctest.js";
import {
  optionLengthBiasFlags,
  positionReferenceInstruction,
  referencesOptionByPosition,
  wordCount,
  type OptionBiasSample,
} from "./optionQuality.js";
import {
  callGenerationSkillTask,
  type OnGenerationProgress,
  type SkillTaskRunner,
} from "./generationReasoning.js";
import {
  validateItemIds,
  type CandidateAdapter,
  type PlannedCandidate,
} from "./generationCandidateLoop.js";
import {
  addReason,
  assertVerdictCoverage,
  runVerifyLoop,
  MAX_VERIFY_ATTEMPTS,
  VerifyRemediation,
  type VerifyPolicy,
} from "./generationVerifyLoop.js";
import { blocksGeneration, classifyGenerationCheck, READING_REMEDIABLE_KINDS } from "./generationCheckPolicy.js";
import {
  academicPassageBandDetail,
  compareReadingModuleDifficulty,
  moduleBandDetail,
  moduleDifficultyDetail,
  readingModuleBandVerdict,
  textBandVerdict,
  UPPER_MODULE_HARDER_RETRY,
} from "./moduleDifficulty.js";
import {
  answerKeyDefect,
  CJK_RE,
  contentGateNotes,
  contentGateTiers,
  EXPLANATION_HARD_LIMIT_CODE_POINTS,
  EXPLANATION_TARGET_CODE_POINTS,
  explanationLength,
  finishVerifiedSet,
  itemQualityNotes,
  requestedReplacements,
  shuffleMcqOptions,
} from "./generationVerifyRemediation.js";

// Reading's half of Set generation: GENERATE → derive the Complete the Words gaps (with a bounded
// repair) → per-passage Explanations → deterministic content gates → VERIFY with targeted
// regeneration. generationCandidateLoop.ts owns the attempt budget, retry hints and novelty wiring
// shared by every section; readingCandidateAdapter at the foot of this file is Reading's side of that
// contract. Nothing here imports generator.ts, which imports this file.

type ReadingModuleName = keyof typeof READING_MODULE_COMPOSITION;
/** shared's own skill vocabulary, so ACADEMIC_SKILL_SLOTS cannot name a value the enum lacks. */
type ReadingSkill = z.infer<typeof ReadingSkillCategory>;
export const READING_MODULE_NAMES: readonly ReadingModuleName[] = [
  "router",
  "lowerModule",
  "upperModule",
];

type CtwGenerationEntry = ReadingGenerationInput["router"]["ctwPassages"][number];
type CtwPlanEntry = ReadingGenerationPlan["ctwPassages"][number];
type CtwPassage = ReadingModule["ctwPassages"][number];
type ReadingMcqQuestion = ReadingModule["dailyLife"][number]["questions"][number];

function moduleComposition(module: {
  ctwPassages: readonly unknown[];
  dailyLife: readonly unknown[];
  academic: readonly unknown[];
}): string {
  return `${module.ctwPassages.length} CtW + ${module.dailyLife.length} daily-life + ${module.academic.length} academic`;
}

// ---------------------------------------------------------------------------
// GENERATE prompt (the main call, one full candidate)
// ---------------------------------------------------------------------------

/**
 * `upperNotHarder` is set only on an attempt that follows a difficulty rejection. It is a boolean
 * rather than the measured grades: the difficulty index is gate-only, and a model shown the number
 * optimises the number instead of writing harder prose.
 */
export function readingGenerationPrompt(
  plan: ReadingGenerationPlan,
  upperNotHarder = false,
): string {
  return [
    "/toefl-reading",
    "GENERATE reading",
    "",
    "Produce one complete Reading Set as JSON matching the supplied generation-input schema.",
    "Follow this accepted server plan exactly. Do not emit generationPlan.",
    "Every ctwPassages entry is a BARE paragraph: emit ONLY {id, taskType, topic, sourceParagraph}.",
    "Do not invent segments or gaps for it — the server derives both deterministically from sourceParagraph.",
    "sourceParagraph's first sentence must be a complete, grammatical sentence (it is kept intact by the deriver); write at least 70 words total so the deriver can find 10 gaps after it.",
    "Module composition (how many of each stimulus each module holds):",
    JSON.stringify(READING_MODULE_COMPOSITION),
    "",
    "```accepted-plan-json",
    JSON.stringify(plan),
    "```",
    // Shared verbatim with listeningGenerationPrompt: the property is identical in both sections, and
    // two wordings of it would be two subtly different instructions.
    ...(upperNotHarder ? [UPPER_MODULE_HARDER_RETRY] : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Derive-then-repair: model paragraph -> deriveCtwGaps -> bounded repair on CtwDerivationError
// ---------------------------------------------------------------------------

const CtwParagraphOnlySchema = z.object({ sourceParagraph: z.string().min(1) });

const MAX_CTW_REPAIR_ATTEMPTS = 3;

/**
 * The Complete the Words paragraph word budget, measured by the content gate and stated to the model
 * by ctwRepairPrompt.
 *
 * A model-visible TARGET, which is why the gate and the prompt may share it: the generation guide
 * already publishes 70–100 words, so a repair prompt restating it discloses nothing new. A gate-only
 * TOLERANCE (EXPLANATION_HARD_LIMIT_CODE_POINTS, CTW_CONTENT_LEAK_TOLERANCE_PER_PASSAGE) is the
 * opposite and must never appear in a prompt, or the model writes to the slack. The two kinds never
 * leak into each other in either direction. The gate fires at exactly these bounds, so there is no
 * slack here for a model to discover.
 */
const CTW_PARAGRAPH_MIN_WORDS = 70;
const CTW_PARAGRAPH_MAX_WORDS = 100;

// The repair prompt carries the current paragraph because its feedback can only be followed against
// it (the gap-leak feedback asks for a surgical edit that leaves every other word as it was).
// `currentParagraph` is always the model's own prior output, so including it discloses nothing
// gate-only.
function ctwRepairPrompt(input: { planEntry: CtwPlanEntry; feedback: string; currentParagraph: string }): string {
  return [
    "/toefl-reading",
    "GENERATE reading",
    "",
    "Regenerate ONE Complete-the-Words source paragraph.",
    "Return ONLY {\"sourceParagraph\": string}. Sentence 1 must be a complete, grammatical sentence.",
    "",
    // The generation guide states these two rules to the GENERATE call. They are restated here because
    // a repair prompt is a different entry point into the same skill, and the model does not re-read
    // the whole guide for it; without them a repair can break both rules in one call.
    `The rewritten paragraph must still be ${CTW_PARAGRAPH_MIN_WORDS}-${CTW_PARAGRAPH_MAX_WORDS} words long.`,
    "Past sentence 1, do NOT repeat any distinctive content word (a topic-specific noun, verb, adjective"
      + " or adverb — ordinary function words like \"the\"/\"and\"/\"that\" are fine and repeat naturally)."
      + " Gap positions are chosen by the server from your text, so a content word repeated anywhere past"
      + " sentence 1 risks printing a gap's own answer in plain text elsewhere in the paragraph, where the"
      + " test taker can simply read it. If the topic needs to name the same thing twice, use a synonym,"
      + " a pronoun or a shorter reference the second time.",
    "",
    "```ctw-plan-entry",
    JSON.stringify(input.planEntry),
    "```",
    "",
    "```current-paragraph",
    input.currentParagraph,
    "```",
    "",
    "```repair-feedback",
    input.feedback,
    "```",
  ].join("\n");
}

type DerivedPassageContent = {
  topic: string;
  sourceParagraph: string;
  segments: ReturnType<typeof deriveCtwGaps>["segments"];
  gaps: ReturnType<typeof deriveCtwGaps>["gaps"];
};

/**
 * Derives segments and gaps for one CtW passage, repairing on CtwDerivationError up to
 * MAX_CTW_REPAIR_ATTEMPTS tries in total. `seedFeedback` makes attempt 1 also go through a repair
 * call before deriving: verify-driven regeneration passes a paragraph that already derives and needs
 * its content changed, not its shape.
 */
async function deriveWithRepair(input: {
  entryId: string;
  initialTopic: string;
  initialParagraph: string;
  planEntry: CtwPlanEntry;
  run: SkillTaskRunner;
  onProgress?: OnGenerationProgress;
  seedFeedback?: string;
}): Promise<DerivedPassageContent> {
  let paragraph = input.initialParagraph;
  const topic = input.initialTopic;
  let lastGapCount: number | undefined;

  for (let rawAttempt = 1; rawAttempt <= MAX_CTW_REPAIR_ATTEMPTS; rawAttempt += 1) {
    const attempt = rawAttempt as 1 | 2 | 3;
    const needsRepairCall = attempt > 1 || input.seedFeedback !== undefined;
    if (needsRepairCall) {
      const feedback = attempt === 1 && input.seedFeedback !== undefined
        ? input.seedFeedback
        // deriveCtwGaps stops at the tenth gap, so the only way to miss is a paragraph that runs out
        // of words first.
        : `Previous paragraph derived ${lastGapCount} gaps; need exactly 10. deriveCtwGaps gaps every 2nd multi-character token (continuous across sentences) after sentence 1, until 10 exist — the paragraph ran out of words before the tenth gap, so rewrite it with more words after sentence 1.`;
      const result = await callGenerationSkillTask({
        run: input.run,
        task: { task: "generate", context: "reading" },
        // Always the current draft: the initial paragraph on the first repair call, otherwise the
        // previous repair's output.
        prompt: ctwRepairPrompt({ planEntry: input.planEntry, feedback, currentParagraph: paragraph }),
        jsonSchema: toProviderJsonSchema(CtwParagraphOnlySchema),
        parse: (value) => CtwParagraphOnlySchema.parse(value),
        stage: "generating",
        onProgress: input.onProgress,
        generationAttempt: attempt,
      });
      if (!result.ok) throw new Error(result.error);
      paragraph = result.value.sourceParagraph;
    }
    try {
      const { segments, gaps } = deriveCtwGaps(input.entryId, paragraph);
      return { topic, sourceParagraph: paragraph, segments, gaps };
    } catch (err) {
      if (!(err instanceof CtwDerivationError)) throw err;
      lastGapCount = err.gapCount;
    }
  }
  throw new Error(
    `set validation failed: CtW passage "${input.entryId}" could not derive exactly 10 gaps after ${MAX_CTW_REPAIR_ATTEMPTS} attempts (last attempt produced ${lastGapCount ?? "?"})`,
  );
}

// ---------------------------------------------------------------------------
// Per-passage Explanation (錯題解析) call: a separate generate:reading call, made after derivation
// because the gaps it explains do not exist before it.
// ---------------------------------------------------------------------------

const CtwExplanationsSchema = z.object({
  explanations: z.array(z.object({
    gapId: z.string().min(1),
    explanationZh: z.string().min(1),
  })).length(10),
});

function ctwExplanationsPrompt(input: {
  passageId: string;
  topic: string;
  sourceParagraph: string;
  gaps: readonly { id: string; prefix: string; completion: string }[];
  feedback?: string;
}): string {
  return [
    "/toefl-reading",
    "GENERATE reading",
    "",
    "Write the 繁體中文 Explanation (錯題解析) for each derived Complete-the-Words gap below: why the completed word is correct in this exact context.",
    "Return ONLY {\"explanations\":[{\"gapId\":string,\"explanationZh\":string}, ...]} — exactly one entry per gap listed, using its own gapId.",
    ...(input.feedback ? ["", "```explanation-feedback", input.feedback, "```"] : []),
    "",
    "```ctw-derived-gaps",
    JSON.stringify({
      passageId: input.passageId,
      topic: input.topic,
      sourceParagraph: input.sourceParagraph,
      gaps: input.gaps.map((gap) => ({ id: gap.id, word: gap.prefix + gap.completion })),
    }),
    "```",
  ].join("\n");
}

async function generateCtwExplanations(input: {
  passageId: string;
  topic: string;
  sourceParagraph: string;
  gaps: readonly { id: string; prefix: string; completion: string }[];
  run: SkillTaskRunner;
  onProgress?: OnGenerationProgress;
  feedback?: string;
}): Promise<Map<string, string>> {
  const result = await callGenerationSkillTask({
    run: input.run,
    task: { task: "generate", context: "reading" },
    prompt: ctwExplanationsPrompt(input),
    jsonSchema: toProviderJsonSchema(CtwExplanationsSchema),
    parse: (value) => CtwExplanationsSchema.parse(value),
    stage: "generating",
    onProgress: input.onProgress,
  });
  if (!result.ok) throw new Error(result.error);
  const byGapId = new Map(result.value.explanations.map((e) => [e.gapId, e.explanationZh]));
  for (const gap of input.gaps) {
    if (!byGapId.has(gap.id)) {
      throw new Error(
        `set validation failed: explanation call for passage "${input.passageId}" did not return gapId "${gap.id}"`,
      );
    }
  }
  return byGapId;
}

function assembleCtwPassage(entryId: string, derived: DerivedPassageContent, explanations: Map<string, string>): CtwPassage {
  return {
    id: entryId,
    taskType: "complete_words",
    topic: derived.topic,
    segments: derived.segments,
    sourceParagraph: derived.sourceParagraph,
    gaps: derived.gaps.map((gap) => ({
      id: gap.id,
      prefix: gap.prefix,
      completion: gap.completion,
      blankLength: gap.blankLength,
      explanationZh: explanations.get(gap.id) ?? "",
    })),
  };
}

// ---------------------------------------------------------------------------
// Assembly: the model's sourceParagraph-only candidate -> the full candidate with derived segments,
// gaps and Explanations, matching ReadingGeneratedSetSchema.
// ---------------------------------------------------------------------------

export async function assembleReadingContent(input: {
  raw: ReadingGenerationInput;
  plan: ReadingGenerationPlan;
  run: SkillTaskRunner;
  onProgress?: OnGenerationProgress;
}): Promise<ReadingGeneratedSet> {
  let ctwIndex = 0;
  const modules: Record<ReadingModuleName, ReadingModule> = {} as Record<ReadingModuleName, ReadingModule>;

  for (const moduleName of READING_MODULE_NAMES) {
    const rawModule = input.raw[moduleName];
    const ctwPassages: CtwPassage[] = [];
    for (const entry of rawModule.ctwPassages as readonly CtwGenerationEntry[]) {
      const planEntry = input.plan.ctwPassages[ctwIndex];
      ctwIndex += 1;
      const derived = await deriveWithRepair({
        entryId: entry.id,
        initialTopic: entry.topic,
        initialParagraph: entry.sourceParagraph,
        planEntry,
        run: input.run,
        onProgress: input.onProgress,
      });
      const explanations = await generateCtwExplanations({
        passageId: entry.id,
        topic: derived.topic,
        sourceParagraph: derived.sourceParagraph,
        gaps: derived.gaps,
        run: input.run,
        onProgress: input.onProgress,
      });
      ctwPassages.push(assembleCtwPassage(entry.id, derived, explanations));
    }
    modules[moduleName] = {
      timeLimitSec: rawModule.timeLimitSec,
      ctwPassages,
      dailyLife: rawModule.dailyLife,
      academic: rawModule.academic,
    };
  }

  return ReadingGeneratedSetSchema.parse({
    id: input.raw.id,
    kind: "reading",
    source: input.raw.source,
    createdAt: input.raw.createdAt,
    router: modules.router,
    lowerModule: modules.lowerModule,
    upperModule: modules.upperModule,
  });
}

// ---------------------------------------------------------------------------
// Deterministic pre-checks (run before the Verifier call)
// ---------------------------------------------------------------------------

/**
 * Refuses a regeneration reply whose key is unusable (answerKeyDefect). The throw happens inside a
 * remediation, so the verify loop counts a failed round and asks again; the same defect on a fresh
 * candidate is the content gate's `invalid-answer-key`.
 */
function checkMcqOptions(
  questions: readonly { id: string; options: readonly { id: string }[]; correctOptionId: string }[],
): void {
  for (const question of questions) {
    const defect = answerKeyDefect(question.options, question.correctOptionId);
    if (defect) throw new Error(`set validation failed: MCQ "${question.id}": ${defect}`);
  }
}

// ---------------------------------------------------------------------------
// The content gate: every rule the generation guide states that can be decided without a model,
// checked on every verify round. It returns violations rather than throwing; generationCheckPolicy
// decides each kind's tier, and verifyReadingSet repairs the remediable ones.
// ---------------------------------------------------------------------------

/** Each kind's tier is in generationCheckPolicy (READING_REMEDIABLE_KINDS, READING_ADVISORY_KINDS). */
export type ReadingViolationKind =
  | "composition"
  | "word-count"
  // A CtW paragraph over its word ceiling, named apart from `word-count` so a note can say which Task
  // Type ran long.
  | "ctw-word-count-over"
  | "item-language"
  | "explanation-language"
  | "academic-coverage"
  | "explanation-length-ctw"
  | "explanation-length-mcq"
  // A CtW gap whose completed word is also spelled out elsewhere in the paragraph's visible text
  // (leakedCtwGapIds).
  | "ctw-gap-leak"
  // A Set-wide distribution property rather than a single-Item defect (longestOptionBiasViolations).
  | "option-length-bias"
  // An explanationZh that names an option by position instead of content (optionQuality's
  // referencesOptionByPosition). The finishing shuffle would make such a reference false, so a
  // flagged Item keeps its option order (finishVerifiedSet).
  | "explanation-position-reference"
  // An MCQ whose key names none of its options, or two of whose options share an id
  // (answerKeyDefect). Regenerated whole; the job fails only if it survives every repair round.
  | "invalid-answer-key"
  // An MCQ with fewer than READING_MCQ_OPTION_COUNT options.
  | "option-count"
  // A module whose prose reads outside the absolute Flesch-Kincaid band designed for it
  // (moduleDifficulty's READING_MODULE_GRADE_BANDS). Separate from the fatal relative check that the
  // Upper Module reads harder than the Lower.
  | "module-difficulty-band"
  // One Academic Passage outside its module's band, which the pooled module measure can miss.
  | "passage-difficulty-band"
  // One CtW source paragraph outside its module's band. About the prose only; the gap derivation is
  // ETS's C-test rule and untouched.
  | "ctw-paragraph-difficulty-band";

type ReadingViolationBase = {
  /**
   * Where it was found: a Stimulus ("upperModule/ctw/ctw-up1"), or the bare module name for a
   * whole-module kind.
   */
  readonly label: string;
  /** The offending id: an item id where there is one, otherwise the stimulus/module. */
  readonly id: string;
  /**
   * Actual vs expected, in operator-readable terms: ids, counts and positions, never Set text. It
   * reaches `job.error` through the verify loop's diagnostics, which carry no content.
   */
  readonly detail: string;
  /**
   * Which slot of the plan's per-Task-Type array this violation is about, set by the two
   * per-Stimulus band kinds (`ctw-paragraph-difficulty-band`, `passage-difficulty-band`). The
   * User-facing note carries no producer-authored string (contentGateNotes), so a server-computed
   * position is how it names one Stimulus without becoming a content channel.
   */
  readonly itemPosition?: number;
};

export type ReadingContentViolation =
  | (ReadingViolationBase & {
      readonly kind: "explanation-length-ctw" | "explanation-length-mcq";
      readonly actualLength: number;
    })
  | (ReadingViolationBase & {
      readonly kind: "ctw-gap-leak";
      /**
       * The gaps whose word is readable elsewhere in the paragraph. The repair prompt names their
       * words, which it reads from the Set; `detail` names only these ids.
       */
      readonly leakedGapIds: readonly string[];
    })
  | (ReadingViolationBase & {
      readonly kind: Exclude<ReadingViolationKind, "explanation-length-ctw" | "explanation-length-mcq" | "ctw-gap-leak">;
    });

/**
 * The kinds the verify loop repairs, each through the narrowest regeneration that can fix it — see
 * readingRemediationRoute. Every one of them ends advisory if its repairs never land; the policy
 * module owns that decision.
 */
export const REMEDIABLE_VIOLATION_KINDS: ReadonlySet<ReadingViolationKind> = READING_REMEDIABLE_KINDS;

/**
 * Which remediation collection a violation kind belongs to; the single source of that routing
 * decision, since verifyReadingSet branches on the route rather than on the kind. Reading's
 * remediations are per-granularity (CtW passage, MCQ question, explanation only), so there is no
 * generic remedy for an unrouted kind. generator.reading.test.ts asserts every
 * REMEDIABLE_VIOLATION_KINDS member has a route and that each route collects.
 */
export type ReadingRemediationRoute =
  | "ctw-explanation-length"
  | "mcq-explanation-length"
  | "ctw-gap-leak"
  | "mcq-wholesale"
  | "mcq-position-reference"
  | "explanation-language";

export function readingRemediationRoute(kind: ReadingViolationKind): ReadingRemediationRoute | undefined {
  switch (kind) {
    case "explanation-length-ctw": return "ctw-explanation-length";
    case "explanation-length-mcq": return "mcq-explanation-length";
    case "ctw-gap-leak": return "ctw-gap-leak";
    // A stem or option not in English, or a key no Response can match, is rewritten by
    // regenerating that question whole.
    case "option-length-bias":
    case "invalid-answer-key":
    case "item-language": return "mcq-wholesale";
    case "explanation-position-reference": return "mcq-position-reference";
    // Routed by what the id names: a CtW gap's explanation is rewritten with its passage's
    // explanation call, an MCQ's by regenerating the question.
    case "explanation-language": return "explanation-language";
    default: return undefined;
  }
}

// ---------------------------------------------------------------------------
// CtW gap-leak detection
// ---------------------------------------------------------------------------

/**
 * What the User sees of one CtW passage before any gap is filled in: every `text` segment verbatim
 * and each gap's visible `prefix`, never its `completion`. Searching `sourceParagraph` instead would
 * flag every gap, because the source prose contains each gapped word at its own location.
 */
function reconstructVisibleCtwText(passage: CtwPassage): string {
  const prefixByGapId = new Map(passage.gaps.map((gap) => [gap.id, gap.prefix]));
  return passage.segments
    .map((segment) => (segment.type === "text" ? segment.text : prefixByGapId.get(segment.gapId) ?? ""))
    .join("");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ids of every gap whose full word (prefix + completion) also appears, as a whole word and ignoring
 * case, in what the User can read before filling any blank. A gap's own blank cannot match: it
 * contributes only `prefix`, at least one letter short of the word (CtwGapSchema's `blankLength`
 * minimum). The gate uses the narrower contentWordLeakedGapIds.
 */
export function leakedCtwGapIds(passage: CtwPassage): string[] {
  const visible = reconstructVisibleCtwText(passage);
  return passage.gaps
    .filter((gap) => new RegExp(`\\b${escapeRegExp(gap.prefix + gap.completion)}\\b`, "iu").test(visible))
    .map((gap) => gap.id);
}

// Closed-class words a gap may repeat without counting as a leak. Repeating them is unavoidable in
// ordinary English, and it gives nothing away: "th[__]" with "the" written elsewhere tells the User
// no more than the prefix and grammar already do. A repeated content word specific to the topic is
// the exploitable case, because the User can find the answer instead of understanding the sentence.
const CTW_LEAK_STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "the", "and", "but", "or", "nor", "for", "yet", "so", "of", "to", "in", "on", "at",
  "by", "with", "from", "as", "that", "this", "these", "those", "is", "are", "was", "were", "be",
  "been", "being", "has", "have", "had", "do", "does", "did", "will", "would", "shall", "should",
  "can", "could", "may", "might", "must", "not", "no", "it", "its", "they", "them", "their", "he",
  "she", "him", "her", "his", "we", "us", "our", "you", "your", "i", "me", "my", "which", "who",
  "whom", "whose", "what", "when", "where", "why", "how", "than", "then", "there", "here", "if",
  "because", "while", "although", "though", "after", "before", "until", "unless", "about", "into",
  "over", "under", "between", "among", "through", "during", "without", "within", "up", "down",
  "out", "off", "again", "further", "once", "all", "each", "few", "more", "most", "other", "some",
  "such", "only", "own", "same", "too", "very", "just", "also", "one", "two", "three",
  // The rest of the quantifiers and determiners begun above, erring toward not flagging.
  "every", "any", "many", "much", "several", "another", "both",
]);

/** leakedCtwGapIds narrowed to content-word leaks (CTW_LEAK_STOPWORDS says why); the gate uses this. */
export function contentWordLeakedGapIds(passage: CtwPassage): string[] {
  const completionById = new Map(passage.gaps.map((gap) => [gap.id, gap.prefix + gap.completion]));
  return leakedCtwGapIds(passage).filter((gapId) => {
    const word = completionById.get(gapId);
    return word !== undefined && !CTW_LEAK_STOPWORDS.has(word.toLowerCase());
  });
}

/**
 * What the surgical gap-leak repair is told about one passage: the leaked gaps and their words. Read
 * from the Set at repair time because the gate's `detail` carries ids only, and the model has to know
 * which words to change. Only the prompt carries this; it never reaches `job.error` or a log.
 */
function ctwGapLeakFeedback(set: ReadingSet, passageId: string, leakedGapIds: readonly string[]): string {
  const passage = READING_MODULE_NAMES
    .flatMap((moduleName) => set[moduleName].ctwPassages)
    .find((candidate) => candidate.id === passageId);
  const wordByGapId = new Map(passage?.gaps.map((gap) => [gap.id, gap.prefix + gap.completion]) ?? []);
  const words = leakedGapIds.flatMap((gapId) => wordByGapId.get(gapId) ?? []);
  return `gap(s) ${leakedGapIds.join(", ")} (word(s): ${words.join(", ")}) have their completed word already visible in plain text elsewhere in this same paragraph (outside any blank), letting a test taker find the answer without understanding the gapped sentence`;
}

// How many content-word leaks one CtW passage may carry before it is repaired. Gate-only and never
// model-visible: the generation guide asks for no repeated content word at all, the target, strictly
// inside this tolerance. One incidental repeat passes without spending a call; two or more get the
// surgical repair, which edits the actual paragraph rather than drawing a fresh one.
const CTW_CONTENT_LEAK_TOLERANCE_PER_PASSAGE = 1;

// ---------------------------------------------------------------------------
// Option-length bias: a distribution property, not a per-Item defect. A key that happens to be its
// own longest option is not wrong alone; only the pattern across many Items is exploitable, so it is
// repaired per Item and never fails a Set. Detection, chance rates and ceiling live in
// optionQuality.ts (optionLengthBiasFlags), shared with Listening; every number there is gate-only.
// The model-visible counterpart is the generation guide's number-free rule that length alone must
// never signal the key.
// ---------------------------------------------------------------------------

// Gate-only. How many option-length offenders one verify round may hand to regenerateRejectedMcqs,
// sized to clear a real Set's measured demand in one round. regenerateRejectedMcqs batches by
// Stimulus, so a larger cap mostly means more Items per call rather than more calls.
const MAX_LONGEST_OPTION_REMEDIATIONS_PER_ROUND = 12;

/**
 * The option-length-bias violations for one Reading Set's MCQs, given in traversal order. Every round
 * re-derives the selection from the current Set, so an Item the cap leaves out is picked up later.
 */
function longestOptionBiasViolations(items: readonly OptionBiasSample[]): ReadingContentViolation[] {
  return optionLengthBiasFlags(items, MAX_LONGEST_OPTION_REMEDIATIONS_PER_ROUND).map((flag) => ({
    kind: "option-length-bias" as const,
    label: flag.label,
    id: flag.id,
    detail: flag.detail,
  }));
}

/**
 * The generation guide's academic rule: an Academic Passage's five questions cover ETS's five skill
 * slots, one question each. Every slot needs at least one of its `accepts` values among the five
 * questions' `skill` tags; a missing slot is an advisory `academic-coverage` violation.
 *
 * ETS's technical manual (RR-25-12) also names figurative and idiomatic expressions, grammatical
 * complexity and rhetorical structure. A passage has only five question slots, so these are not
 * extra requirements: each is an alternate inside the slot whose comprehension it belongs to, and a
 * passage that uses none of them conforms through the primary categories.
 *
 * Slot order is the order violations are reported in.
 */
const ACADEMIC_SKILL_SLOTS = [
  // "relationship between ideas across sentences/paragraphs". `rhetorical_structure` asks how the
  // text is ORGANIZED to make its case (contrast, cause-effect, chronology) — the same relations,
  // named from the author's side.
  { label: "idea-relationship", accepts: ["organization", "rhetorical_structure"] },
  // "purpose of all or part of the text". No alternate: this is the slot `rhetorical_structure`
  // would be mistaken for, and letting one cover both would let a passage drop purpose entirely.
  { label: "author's-purpose", accepts: ["purpose"] },
  { label: "inference", accepts: ["inference"] },
  // "vocabulary in context". `figurative_language` is the same skill applied to an idiom or a
  // figure of speech rather than to a single literal word.
  { label: "word-meaning", accepts: ["vocabulary", "figurative_language"] },
  // "factual information", plus the long-standing `main_idea` substitution. `grammatical_complexity`
  // joins it because a "which sentence best restates this one" item is factual comprehension carried
  // by syntax rather than by a new proposition.
  { label: "factual-information", accepts: ["detail", "main_idea", "grammatical_complexity"] },
] as const satisfies readonly { label: string; accepts: readonly ReadingSkill[] }[];

// Every Reading MCQ has exactly 4 options, like the exam. The generation guide states the same 4, so
// this is not a gate-only number. It lives in the content gate rather than the schema because
// mcqQuestionSchema keeps a floor of 3 for two published 3-option Sets.
const READING_MCQ_OPTION_COUNT = 4;

function formatReadingViolations(violations: readonly ReadingContentViolation[]): string {
  return violations.map((v) => `${v.kind} ${v.label} "${v.id}": ${v.detail}`).join("; ");
}

export function readingContentViolations(set: {
  router: ReadingModule;
  lowerModule: ReadingModule;
  upperModule: ReadingModule;
}): ReadingContentViolation[] {
  const violations: ReadingContentViolation[] = [];

  const checkExplanation = (
    kind: "explanation-length-ctw" | "explanation-length-mcq",
    label: string,
    id: string,
    explanationZh: string,
  ): void => {
    const length = explanationLength(explanationZh);
    if (length > EXPLANATION_HARD_LIMIT_CODE_POINTS) {
      violations.push({
        kind, label, id, actualLength: length,
        detail: `explanationZh is ${length} 字, past the ${EXPLANATION_HARD_LIMIT_CODE_POINTS}-字 runaway limit (target is ${EXPLANATION_TARGET_CODE_POINTS})`,
      });
    }
    if (!CJK_RE.test(explanationZh)) {
      violations.push({
        kind: "explanation-language", label, id,
        detail: `explanationZh contains no CJK character at all (繁體中文 expected)`,
      });
    }
  };

  // Every MCQ, in traversal order, for the Set-wide option-length-bias check.
  const mcqSamples: OptionBiasSample[] = [];

  // Indexes into the plan's `ctwPassages` and `academicPassages` arrays, which a note's
  // `itemPosition` addresses. Each runs across modules in READING_MODULE_NAMES order (router, lower,
  // upper) and advances on every passage, flagged or not, so it matches the coordinate
  // generationCatalog.ts's entriesFromReadingPlan assigns.
  let ctwPosition = 0;
  let academicPosition = 0;

  const checkMcq = (label: string, question: ReadingMcqQuestion): void => {
    // Both details also become the regeneration's reason (mcqFromGate), whose prompt carries the
    // whole question, so the model still sees the text it must rewrite.
    if (CJK_RE.test(question.stem)) {
      violations.push({
        kind: "item-language", label, id: question.id,
        detail: `stem is not English (explanationZh is the only 繁體中文 field)`,
      });
    }
    for (const option of question.options) {
      if (CJK_RE.test(option.text)) {
        violations.push({
          kind: "item-language", label, id: question.id,
          detail: `option "${option.id}" is not English (explanationZh is the only 繁體中文 field)`,
        });
      }
    }
    const keyDefect = answerKeyDefect(question.options, question.correctOptionId);
    if (keyDefect) violations.push({ kind: "invalid-answer-key", label, id: question.id, detail: keyDefect });
    // The schema admits 3 or 4 options, so in practice this fires only on 3.
    if (question.options.length < READING_MCQ_OPTION_COUNT) {
      violations.push({
        kind: "option-count", label, id: question.id,
        detail: `has ${question.options.length} options, expected exactly ${READING_MCQ_OPTION_COUNT}`,
      });
    }
    checkExplanation("explanation-length-mcq", label, question.id, question.explanationZh);
    // `detail` quotes no explanation text, because formatReadingViolations can carry it into a job's
    // error and from there to the API. The repair prompt serialises the whole flagged question, so
    // the model still sees the text it must fix.
    if (referencesOptionByPosition(question.explanationZh)) {
      violations.push({
        kind: "explanation-position-reference", label, id: question.id,
        detail: `explanationZh refers to an option by POSITION or LABEL, which the answer-key rebalance (the pipeline's own last mutation) can and does invalidate — describe the key and distractors by CONTENT instead`,
      });
    }
    mcqSamples.push({ label, id: question.id, options: question.options, correctOptionId: question.correctOptionId });
  };

  for (const moduleName of READING_MODULE_NAMES) {
    const module = set[moduleName];
    const expected = READING_MODULE_COMPOSITION[moduleName];
    if (
      module.ctwPassages.length !== expected.ctw ||
      module.dailyLife.length !== expected.dailyLife ||
      module.academic.length !== expected.academic
    ) {
      violations.push({
        kind: "composition", label: moduleName, id: moduleName,
        detail: `is ${moduleComposition(module)}, expected ${expected.ctw} CtW + ${expected.dailyLife} daily-life + ${expected.academic} academic`,
      });
    }

    // The absolute difficulty band, per module. It belongs here rather than beside the fatal relative
    // check in readingCandidateAdapter, which must run on the raw candidate before
    // assembleReadingContent spends anything; this one is advisory and only ever becomes a note.
    // `label` is the bare module name, so the note carries no `taskType`: the band belongs to the
    // whole module.
    const bandVerdict = readingModuleBandVerdict(moduleName, module);
    if (bandVerdict && bandVerdict.placement !== "in-band") {
      violations.push({
        kind: "module-difficulty-band", label: moduleName, id: moduleName,
        detail: moduleBandDetail(bandVerdict),
      });
    }

    for (const passage of module.ctwPassages) {
      const label = `${moduleName}/ctw/${passage.id}`;
      const itemPosition = ctwPosition;
      ctwPosition += 1;

      // The module's band asked of this paragraph alone: an Upper Module's Academic Passage can carry
      // the pooled grade into band while its CtW paragraph, the Stimulus for ten Items, reads at the
      // Router Module's level.
      const paragraphBand = textBandVerdict(moduleName, passage.sourceParagraph);
      if (paragraphBand && paragraphBand.placement !== "in-band") {
        violations.push({
          kind: "ctw-paragraph-difficulty-band", label, id: passage.id, itemPosition,
          detail: `source paragraph ${moduleBandDetail(paragraphBand)}`,
        });
      }

      const words = wordCount(passage.sourceParagraph);
      if (words < CTW_PARAGRAPH_MIN_WORDS || words > CTW_PARAGRAPH_MAX_WORDS) {
        violations.push({
          kind: words < CTW_PARAGRAPH_MIN_WORDS ? "word-count" : "ctw-word-count-over",
          label, id: passage.id,
          detail: `sourceParagraph is ${words} words, expected ${CTW_PARAGRAPH_MIN_WORDS}-${CTW_PARAGRAPH_MAX_WORDS}`,
        });
      }
      for (const gap of passage.gaps) {
        checkExplanation("explanation-length-ctw", label, gap.id, gap.explanationZh);
      }
      // `detail` names the leaked gaps by id, never their words (which are answer keys) and never the
      // gate-only tolerance. The repair reads the words from the Set (ctwGapLeakFeedback).
      const contentLeaked = contentWordLeakedGapIds(passage);
      if (contentLeaked.length > CTW_CONTENT_LEAK_TOLERANCE_PER_PASSAGE) {
        violations.push({
          kind: "ctw-gap-leak", label, id: passage.id, leakedGapIds: contentLeaked,
          detail: `gap(s) ${contentLeaked.join(", ")} have their completed word visible in plain text elsewhere in this paragraph`,
        });
      }
    }

    for (const text of module.dailyLife) {
      const label = `${moduleName}/daily_life/${text.id}`;
      const words = wordCount(text.text);
      if (words < 15 || words > 150) {
        violations.push({
          kind: "word-count", label, id: text.id, detail: `text is ${words} words, expected 15-150`,
        });
      }
      for (const question of text.questions) checkMcq(label, question);
    }

    for (const passage of module.academic) {
      const label = `${moduleName}/academic/${passage.id}`;
      const itemPosition = academicPosition;
      academicPosition += 1;
      const words = wordCount(passage.text);
      if (words < 150 || words > 250) {
        violations.push({
          kind: "word-count", label, id: passage.id,
          detail: `text is ${words} words, expected ~200 (150-250 tolerance)`,
        });
      }
      // The module's band asked of this one passage: a module can sit in band on average while its
      // Academic Passage, which carries the section's difficulty ceiling, does not. `itemPosition`
      // lets the note say which passage without carrying the model-authored id.
      const passageBand = textBandVerdict(moduleName, passage.text);
      if (passageBand && passageBand.placement !== "in-band") {
        violations.push({
          kind: "passage-difficulty-band", label, id: passage.id, itemPosition,
          detail: academicPassageBandDetail(passageBand),
        });
      }
      const skills = passage.questions.map((question) => question.skill);
      if (passage.questions.length !== 5) {
        violations.push({
          kind: "academic-coverage", label, id: passage.id,
          detail: `has ${passage.questions.length} questions, expected 5`,
        });
      }
      // One violation per uncovered slot, naming the primary category and then its alternates, so the
      // message says what to add.
      for (const slot of ACADEMIC_SKILL_SLOTS) {
        if (slot.accepts.some((accepted) => skills.includes(accepted))) continue;
        const [primary, ...alternates] = slot.accepts;
        const rotation = alternates.length > 0
          ? ` or one of its rotation alternates ${alternates.map((skill) => `"${skill}"`).join(", ")}`
          : "";
        violations.push({
          kind: "academic-coverage", label, id: passage.id,
          detail: `has no ${slot.label} question: needs "${primary}"${rotation} (present: ${skills.join(", ")})`,
        });
      }
      for (const question of passage.questions) checkMcq(label, question);
    }
  }

  violations.push(...longestOptionBiasViolations(mcqSamples));
  return violations;
}

/** Reading's content-gate kinds read through generationCheckPolicy. */
const READING_GATE = contentGateTiers((kind: ReadingViolationKind) =>
  classifyGenerationCheck({ family: "content-gate", section: "reading", kind })
);

/**
 * Which Task Type a violation's `${module}/${component}/${id}` label names, for the advisory note.
 * Any other shape, such as the bare module name a whole-module kind uses, yields no `taskType`
 * rather than a guess.
 */
function readingViolationTaskType(label: string): string | undefined {
  switch (label.split("/")[1]) {
    case "ctw": return "complete_words";
    case "daily_life": return "daily_life";
    case "academic": return "academic_passage";
    default: return undefined;
  }
}

/**
 * The one exit both of verifyReadingSet's success paths go through. The option rebalance runs here
 * because this is downstream of every possible options-array mutation.
 */
function finishReadingSet(
  set: ReadingSet,
  violations: readonly ReadingContentViolation[],
  /** The Task Type of each MCQ published with an unrepaired Verifier "quality" finding. */
  acceptedQuality: readonly string[] = [],
): ReadingSet {
  return finishVerifiedSet({
    set,
    violations,
    rebalance: (current, keepOrderOf) => rebalanceReadingOptionOrder(current, Math.random, keepOrderOf),
    notes: [
      {
        producer: "reading content gate",
        notes: contentGateNotes(violations, READING_GATE.degrades, readingViolationTaskType),
      },
      { producer: "reading verify", notes: itemQualityNotes(acceptedQuality) },
    ],
  });
}

/**
 * The fail-on-sight checks run before verification: throws on any fatal content-gate kind (module
 * composition) and on `blankLength` !== completion length (true by construction from deriveCtwGaps,
 * asserted for hand-authored Sets). Every other violation is left to verifyReadingSet to repair or
 * record, an unusable answer key (`invalid-answer-key`) included. Item id uniqueness is checked
 * earlier, by validateItemIds.
 */
export function deterministicReadingPreChecks(set: {
  router: ReadingModule;
  lowerModule: ReadingModule;
  upperModule: ReadingModule;
}): void {
  const violations = readingContentViolations(set);
  const blocking = violations.filter((violation) => READING_GATE.isFatal(violation.kind));
  if (blocking.length > 0) {
    // Reports the remediable violations too, labeled apart, so one failure shows everything wrong
    // with the candidate.
    const remediable = violations.filter((violation) => REMEDIABLE_VIOLATION_KINDS.has(violation.kind));
    const parts = [
      `${blocking.length} blocking violation(s): ${formatReadingViolations(blocking)}`,
      ...(remediable.length > 0
        ? [
          `${remediable.length} remediable violation(s) also present (not the cause of this failure): ${
            formatReadingViolations(remediable)
          }`,
        ]
        : []),
    ];
    throw new Error(
      `set validation failed: reading content gate found ${violations.length} violation(s): ${parts.join(" | ")}`,
    );
  }
  for (const moduleName of READING_MODULE_NAMES) {
    const module = set[moduleName];
    for (const passage of module.ctwPassages) {
      for (const gap of passage.gaps) {
        if (gap.blankLength !== gap.completion.length) {
          throw new Error(
            `set validation failed: gap "${gap.id}" blankLength ${gap.blankLength} does not match completion length ${gap.completion.length}`,
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// LLM verify (verify:reading) + ambiguity-driven CtW regeneration
// ---------------------------------------------------------------------------

const ReadingVerifierSchema = z.object({
  ctwPassages: z.array(z.union([
    z.object({ id: z.string(), verdict: z.literal("ok") }),
    // `ambiguousGaps` names each gap and the alternate word the Verifier says also fits, so the
    // claim can be checked before a paid rewrite is spent on it: see isTypeableCtwAlternate.
    z.object({
      id: z.string(),
      verdict: z.literal("ambiguous"),
      ambiguousGaps: z.array(z.object({ gapId: z.string(), alternate: z.string() })).min(1),
      reason: z.string(),
    }),
    // A gap can be unambiguous and still carry an Explanation that is wrong, explains another gap,
    // or does not justify its word. Only the Explanation prose is regenerated
    // (regenerateUnfaithfulExplanations); the paragraph and gaps stand.
    z.object({
      id: z.string(),
      verdict: z.literal("unfaithful-explanation"),
      gapIds: z.array(z.string()).min(1),
      reason: z.string(),
    }),
  ])),
  // Two failing MCQ verdicts, tiered differently (ADR 0006). "issue" is a key the User would be
  // taught wrong (wrong, not the only defensible option, unanswerable from the text, or explained
  // with facts the text does not hold) and is repair-then-fail. "quality" is an Item keyed correctly
  // but weak (a distractor nobody would pick, an option not in English): it gets one regeneration
  // and is then published with a note. See readingVerifyPolicy's planRound.
  mcqItems: z.array(z.union([
    z.object({ id: z.string(), verdict: z.literal("ok") }),
    z.object({ id: z.string(), verdict: z.literal("issue"), reason: z.string() }),
    z.object({ id: z.string(), verdict: z.literal("quality"), reason: z.string() }),
  ])),
});

/** The verify unit key of a CtW passage and of an MCQ, kept apart so the two id spaces never meet. */
const ctwUnit = (passageId: string): string => `ctw:${passageId}`;
const mcqUnit = (questionId: string): string => `mcq:${questionId}`;

/**
 * Every unit the Reading Verifier judges, with a fingerprint of what its verdict depends on: a CtW
 * passage's paragraph and gaps (explanations included, since their faithfulness is judged), and an
 * MCQ together with the text it is about.
 */
function readingVerifyUnits(set: ReadingGeneratedSet): Map<string, string> {
  const units = new Map<string, string>();
  for (const moduleName of READING_MODULE_NAMES) {
    for (const passage of set[moduleName].ctwPassages) {
      units.set(ctwUnit(passage.id), JSON.stringify([passage.sourceParagraph, passage.gaps]));
    }
    for (const stimulus of [...set[moduleName].dailyLife, ...set[moduleName].academic]) {
      for (const question of stimulus.questions) {
        units.set(mcqUnit(question.id), JSON.stringify([stimulus.text, question]));
      }
    }
  }
  return units;
}

/**
 * Whether `alternate` is a word the User could actually type into `gap` instead of its key.
 *
 * The blank shows the gap's prefix followed by one box per missing letter, and the input's
 * `maxLength` is `blankLength`, so the only typeable alternates start with the prefix and are exactly
 * prefix + blankLength characters long. A Verifier "ambiguous" claim naming any other word cannot
 * make the exact-match scorer reject a reasonable answer, so it is not a defect in the gap. The key
 * itself, in any case, is not an alternate.
 */
export function isTypeableCtwAlternate(
  gap: { readonly prefix: string; readonly completion: string; readonly blankLength: number },
  alternate: string,
): boolean {
  const word = alternate.trim().toLowerCase();
  const prefix = gap.prefix.toLowerCase();
  return word.length === prefix.length + gap.blankLength
    && word.startsWith(prefix)
    && word !== (gap.prefix + gap.completion).toLowerCase();
}

/** A Daily Life text or Academic passage as the Verifier sees it: the text its questions are about. */
type ReadingVerifyStimulus = { id: string; taskType: "daily_life" | "academic_passage"; text: string };

/**
 * The Verifier judges whether each MCQ's key is right, so every question travels with the text it
 * is asked about: `stimuli` carries each Daily Life text and Academic passage once, and each
 * `mcqItems` entry names its own by `stimulusId` — the same shape Listening's verify payload uses
 * for transcripts.
 */
function readingVerifyRequest(set: ReadingGeneratedSet, pending: ReadonlySet<string>): {
  prompt: string;
  sent: { ctwPassages: string[]; mcqItems: string[] };
} {
  const ctwPayload = READING_MODULE_NAMES.flatMap((moduleName) =>
    set[moduleName].ctwPassages.filter((passage) => pending.has(ctwUnit(passage.id))).map((passage) => ({
      id: passage.id,
      sourceParagraph: passage.sourceParagraph,
      gaps: passage.gaps.map((gap) => ({
        id: gap.id, prefix: gap.prefix, completion: gap.completion, blankLength: gap.blankLength,
        explanationZh: gap.explanationZh,
      })),
    }))
  );
  const stimuli: ReadingVerifyStimulus[] = [];
  const mcqPayload = READING_MODULE_NAMES.flatMap((moduleName) => [
    ...set[moduleName].dailyLife.map((text) => ({ stimulus: text, taskType: "daily_life" as const })),
    ...set[moduleName].academic.map((passage) => ({ stimulus: passage, taskType: "academic_passage" as const })),
  ]).flatMap(({ stimulus, taskType }) => {
    const questions = stimulus.questions.filter((question) => pending.has(mcqUnit(question.id)));
    if (questions.length > 0) stimuli.push({ id: stimulus.id, taskType, text: stimulus.text });
    return questions.map((question) => ({
      id: question.id, stimulusId: stimulus.id, stem: question.stem, options: question.options,
      correctOptionId: question.correctOptionId, explanationZh: question.explanationZh,
    }));
  });
  const prompt = [
    "/toefl-reading",
    "VERIFY reading",
    "",
    "Each CtW gap shows the learner its `prefix` followed by exactly `blankLength` letter boxes, and the input accepts no more letters than that. So a gap is ambiguous only over an alternate word that starts with that prefix and has exactly prefix-length + blankLength letters — a word of any other length cannot be typed into the blank and is never a reason to call it ambiguous.",
    "For each CtW passage: verdict \"ambiguous\" if ANY gap has a genuinely plausible alternate completion in context that fits its blank exactly as above (not merely a synonym spelled differently), listing each such gap in `ambiguousGaps` with the full alternate word; verdict \"unfaithful-explanation\" (listing the offending gapIds) if one or more gaps' explanationZh is factually wrong, explains a DIFFERENT gap, or does not actually justify why that gap's own completed word fits its context; otherwise \"ok\".",
    "For each MCQ item: verdict \"issue\" if the key is wrong for a learner — correctOptionId is wrong, another option is equally defensible from the text, the question cannot be answered from the text, or explanationZh misstates the key or cites a detail the text does not contain. Otherwise verdict \"quality\" if the item is keyed correctly but weak — a distractor is not genuinely plausible (obviously wrong without reading the text), or the stem or any option is not written in English (explanationZh is the only field that is 繁體中文). \"issue\" takes precedence when both apply; otherwise \"ok\".",
    "Every `mcqItems` entry's `stimulusId` names the `stimuli` entry it is asked about, and that entry's `text` is the full Daily Life text or Academic passage. Read it: judge the key, every distractor and the explanation against what that text actually says, never against the explanation alone.",
    "Return {\"ctwPassages\":[{\"id\",\"verdict\":\"ok\"}|{\"id\",\"verdict\":\"ambiguous\",\"ambiguousGaps\":[{\"gapId\",\"alternate\"}],\"reason\"}|{\"id\",\"verdict\":\"unfaithful-explanation\",\"gapIds\",\"reason\"}],\"mcqItems\":[{\"id\",\"verdict\":\"ok\"}|{\"id\",\"verdict\":\"issue\"|\"quality\",\"reason\"}]}, one entry per passage/item supplied.",
    "",
    "```json",
    JSON.stringify({ ctwPassages: ctwPayload, stimuli, mcqItems: mcqPayload }),
    "```",
  ].join("\n");
  return {
    prompt,
    sent: { ctwPassages: ctwPayload.map((passage) => passage.id), mcqItems: mcqPayload.map((item) => item.id) },
  };
}

/**
 * Regenerates whole CtW paragraphs. Gap positions follow deterministically from the paragraph
 * (ctest.ts), so the server cannot move or re-pick a gap: a passage-level defect is fixed only by
 * changing what the paragraph says.
 *
 * `seedFeedbackByPassageId` holds the caller's already-worded feedback per flagged passage, because
 * the defects that route here need different guidance: a Verifier "ambiguous" verdict is about a
 * second word that fits a blank, a "ctw-gap-leak" violation about a gapped word already visible
 * elsewhere in the paragraph.
 */
async function regenerateWholesalePassages(
  set: ReadingSet,
  plan: ReadingGenerationPlan,
  seedFeedbackByPassageId: ReadonlyMap<string, string>,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<ReadingSet> {
  let ctwIndex = 0;
  const modules: Record<ReadingModuleName, ReadingModule> = {} as Record<ReadingModuleName, ReadingModule>;

  for (const moduleName of READING_MODULE_NAMES) {
    const module = set[moduleName];
    const ctwPassages: CtwPassage[] = [];
    for (const passage of module.ctwPassages) {
      const planEntry = plan.ctwPassages[ctwIndex];
      ctwIndex += 1;
      const seedFeedback = seedFeedbackByPassageId.get(passage.id);
      if (seedFeedback === undefined) {
        ctwPassages.push(passage);
        continue;
      }
      const derived = await deriveWithRepair({
        entryId: passage.id,
        initialTopic: passage.topic,
        initialParagraph: passage.sourceParagraph,
        planEntry,
        run,
        onProgress,
        seedFeedback,
      });
      const explanations = await generateCtwExplanations({
        passageId: passage.id,
        topic: derived.topic,
        sourceParagraph: derived.sourceParagraph,
        gaps: derived.gaps,
        run,
        onProgress,
      });
      ctwPassages.push(assembleCtwPassage(passage.id, derived, explanations));
    }
    modules[moduleName] = { ...module, ctwPassages };
  }

  return ReadingSetSchema.parse({ ...set, ...modules });
}

/**
 * Rewrites a passage's explanations when its paragraph and gaps are fine and only the explanation
 * prose is wrong: a Verifier "unfaithful-explanation" verdict, or a gap explanation the content gate
 * found with no 繁體中文 in it. Re-runs generateCtwExplanations (the call assembleReadingContent
 * uses) with the reason and the offending gapIds as feedback; it never touches the paragraph.
 */
async function regenerateUnfaithfulExplanations(
  set: ReadingSet,
  unfaithful: ReadonlyMap<string, { reason: string; gapIds: readonly string[] }>,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<ReadingSet> {
  const modules: Record<ReadingModuleName, ReadingModule> = {} as Record<ReadingModuleName, ReadingModule>;

  for (const moduleName of READING_MODULE_NAMES) {
    const module = set[moduleName];
    const ctwPassages: CtwPassage[] = [];
    for (const passage of module.ctwPassages) {
      const flagged = unfaithful.get(passage.id);
      if (!flagged) {
        ctwPassages.push(passage);
        continue;
      }
      const explanations = await generateCtwExplanations({
        passageId: passage.id,
        topic: passage.topic,
        sourceParagraph: passage.sourceParagraph,
        gaps: passage.gaps,
        run,
        onProgress,
        feedback: `A previous draft's explanations were flagged for gap(s) ${flagged.gapIds.join(", ")}: ${flagged.reason}. Rewrite the explanationZh for every gap in this passage, in 繁體中文, so each one accurately and specifically explains why THAT gap's own completed word is correct in this exact context — never another gap's word.`,
      });
      ctwPassages.push({
        ...passage,
        // generateCtwExplanations returns every gap id; the fallback keeps the prior explanation
        // rather than an empty one should that ever not hold.
        gaps: passage.gaps.map((gap) => ({
          ...gap,
          explanationZh: explanations.get(gap.id) ?? gap.explanationZh,
        })),
      });
    }
    modules[moduleName] = { ...module, ctwPassages };
  }

  return ReadingSetSchema.parse({ ...set, ...modules });
}

/**
 * Rewrites the explanations of a passage whose CtW gap explanations ran over the hard limit, keeping
 * the paragraph and gaps. The feedback quotes each gap's measured 字 count, because a model cannot
 * count its own characters: "this one was 260" is actionable where "keep it to about 120" is not.
 * `overlong` arrives already filtered by the verify loop, which drops every gap of a passage another
 * remediation rewrites this round (the policy's `scope`).
 */
async function regenerateOverlongCtwExplanations(
  set: ReadingSet,
  overlong: ReadonlyMap<string, number>,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<ReadingSet> {
  const modules: Record<ReadingModuleName, ReadingModule> = {} as Record<ReadingModuleName, ReadingModule>;

  for (const moduleName of READING_MODULE_NAMES) {
    const module = set[moduleName];
    const ctwPassages: CtwPassage[] = [];
    for (const passage of module.ctwPassages) {
      const flagged = passage.gaps.filter((gap) => overlong.has(gap.id));
      if (flagged.length === 0) {
        ctwPassages.push(passage);
        continue;
      }
      const counts = flagged.map((gap) => `${gap.id} (${overlong.get(gap.id)} 字)`).join(", ");
      const explanations = await generateCtwExplanations({
        passageId: passage.id,
        topic: passage.topic,
        sourceParagraph: passage.sourceParagraph,
        gaps: passage.gaps,
        run,
        onProgress,
        feedback: `A previous draft's explanations ran far too long. These counts were measured by the server and are the real lengths: ${counts}. Rewrite the explanationZh for every gap in this passage to about ${EXPLANATION_TARGET_CODE_POINTS} 字 each. That means cutting real content, not rephrasing: give the single strongest reason that gap's own completed word fits, and stop. Do not stack a grammatical-role analysis and a semantic analysis onto one gap, and do not quote more than a few words of English.`,
      });
      ctwPassages.push({
        ...passage,
        gaps: passage.gaps.map((gap) => ({
          ...gap,
          explanationZh: explanations.get(gap.id) ?? gap.explanationZh,
        })),
      });
    }
    modules[moduleName] = { ...module, ctwPassages };
  }

  return ReadingSetSchema.parse({ ...set, ...modules });
}

// ---------------------------------------------------------------------------
// MCQ regeneration: replaces whole flagged questions (stem, options, key and explanation). Unlike
// the CtW remediations, which reuse assembly's own calls, it has its own prompt and schema.
// ---------------------------------------------------------------------------

const McqReplacementsSchema = z.object({
  questions: z.array(mcqQuestionSchema(ReadingSkillCategory)).min(1),
});

function mcqRegenerationPrompt(input: {
  stimulusId: string;
  stimulusText: string;
  flagged: readonly (ReadingMcqQuestion & { reason: string })[];
}): string {
  return [
    "/toefl-reading",
    "GENERATE reading",
    "",
    "Regenerate ONLY the flagged MCQ question(s) below for one stimulus; keep every other question and the stimulus text untouched.",
    "Return ONLY {\"questions\":[{\"id\",\"stem\",\"options\":[{\"id\",\"text\"}, ...],\"correctOptionId\",\"skill\",\"explanationZh\"}, ...]}, exactly one replacement per flagged question, reusing its own id and carrying exactly 4 options.",
    // A regenerated question carries a fresh explanation, and the options are shuffled after the
    // last remediation, so the explanation rule applies here exactly as it does to a rewrite.
    `In explanationZh: ${positionReferenceInstruction()}`,
    "",
    "```mcq-regeneration",
    JSON.stringify({
      stimulusId: input.stimulusId,
      stimulusText: input.stimulusText,
      flaggedQuestions: input.flagged,
    }),
    "```",
  ].join("\n");
}

/**
 * Regenerates the flagged questions of one Stimulus (a Daily Life text or Academic Passage) in a
 * single call. Only requested ids are read from the reply (requestedReplacements), and checkMcqOptions
 * runs on them before they are accepted. An untouched question passes through by identity.
 */
async function regenerateFlaggedQuestions(
  stimulusId: string,
  stimulusText: string,
  questions: readonly ReadingMcqQuestion[],
  issues: ReadonlyMap<string, string>,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<ReadingMcqQuestion[]> {
  const flagged = questions.filter((question) => issues.has(question.id));
  if (flagged.length === 0) return [...questions];

  const result = await callGenerationSkillTask({
    run,
    task: { task: "generate", context: "reading" },
    prompt: mcqRegenerationPrompt({
      stimulusId,
      stimulusText,
      flagged: flagged.map((question) => ({ ...question, reason: issues.get(question.id)! })),
    }),
    jsonSchema: toProviderJsonSchema(McqReplacementsSchema),
    parse: (value) => McqReplacementsSchema.parse(value),
    stage: "generating",
    onProgress,
  });
  if (!result.ok) throw new Error(result.error);
  const byId = requestedReplacements(flagged.map((question) => question.id), result.value.questions, (id) => {
    throw new Error(`set validation failed: MCQ regeneration for stimulus "${stimulusId}" did not return question "${id}"`);
  });
  checkMcqOptions(flagged.map((question) => byId.get(question.id)!));
  return questions.map((question) => byId.get(question.id) ?? question);
}

async function regenerateRejectedMcqs(
  set: ReadingSet,
  issues: ReadonlyMap<string, string>,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<ReadingSet> {
  const modules: Record<ReadingModuleName, ReadingModule> = {} as Record<ReadingModuleName, ReadingModule>;

  for (const moduleName of READING_MODULE_NAMES) {
    const module = set[moduleName];
    const dailyLife: ReadingModule["dailyLife"] = [];
    for (const text of module.dailyLife) {
      const questions = await regenerateFlaggedQuestions(text.id, text.text, text.questions, issues, run, onProgress);
      dailyLife.push({ ...text, questions });
    }
    const academic: ReadingModule["academic"] = [];
    for (const passage of module.academic) {
      const questions = await regenerateFlaggedQuestions(passage.id, passage.text, passage.questions, issues, run, onProgress);
      academic.push({ ...passage, questions });
    }
    modules[moduleName] = { ...module, dailyLife, academic };
  }

  return ReadingSetSchema.parse({ ...set, ...modules });
}

// ---------------------------------------------------------------------------
// MCQ explanation-only rewrite, for an over-long explanation. Not regenerateFlaggedQuestions, which
// would churn the stem, options and key of a question whose only fault is its 錯題解析: this call
// returns {id, explanationZh} and nothing else, so nothing else can change.
// ---------------------------------------------------------------------------

const McqExplanationRewritesSchema = z.object({
  explanations: z.array(z.object({
    id: z.string().min(1),
    explanationZh: z.string().min(1),
  })).min(1),
});

function mcqExplanationRewritePrompt(input: {
  stimulusId: string;
  stimulusText: string;
  overlong: readonly (ReadingMcqQuestion & { actualLength: number })[];
}): string {
  return [
    "/toefl-reading",
    "GENERATE reading",
    "",
    "Rewrite ONLY the 繁體中文 Explanation (錯題解析) of the MCQ question(s) below, each of which ran far too long; change no other field.",
    "Return ONLY {\"explanations\":[{\"id\":string,\"explanationZh\":string}, ...]}, exactly one entry per question listed, reusing its own id.",
    `Each question's \`actualLength\` is its current draft's 字 count, measured by the server — cut real content until it is about ${EXPLANATION_TARGET_CODE_POINTS} 字, keeping the key's own justification plus one short clause per distractor, and stop.`,
    `In every explanationZh you write: ${positionReferenceInstruction()}`,
    "",
    "```mcq-explanation-rewrite",
    JSON.stringify({
      stimulusId: input.stimulusId,
      stimulusText: input.stimulusText,
      targetZh: EXPLANATION_TARGET_CODE_POINTS,
      overlongExplanations: input.overlong,
    }),
    "```",
  ].join("\n");
}

/**
 * Rewrites the explanationZh of the over-long questions of one Stimulus in a single call, with the
 * same reply filtering as regenerateFlaggedQuestions. Every other field stays as it was, since the
 * reply carries no other field. `overlong` arrives already filtered by the verify loop, which drops a
 * question another remediation regenerates whole this round.
 */
async function rewriteOverlongExplanations(
  stimulusId: string,
  stimulusText: string,
  questions: readonly ReadingMcqQuestion[],
  overlong: ReadonlyMap<string, number>,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<ReadingMcqQuestion[]> {
  const flagged = questions.filter((question) => overlong.has(question.id));
  if (flagged.length === 0) return [...questions];

  const result = await callGenerationSkillTask({
    run,
    task: { task: "generate", context: "reading" },
    prompt: mcqExplanationRewritePrompt({
      stimulusId,
      stimulusText,
      overlong: flagged.map((question) => ({ ...question, actualLength: overlong.get(question.id)! })),
    }),
    jsonSchema: toProviderJsonSchema(McqExplanationRewritesSchema),
    parse: (value) => McqExplanationRewritesSchema.parse(value),
    stage: "generating",
    onProgress,
  });
  if (!result.ok) throw new Error(result.error);
  const byId = requestedReplacements(flagged.map((question) => question.id), result.value.explanations, (id) => {
    throw new Error(`set validation failed: MCQ explanation rewrite for stimulus "${stimulusId}" did not return question "${id}"`);
  });
  return questions.map((question) => {
    const rewrite = byId.get(question.id);
    return rewrite === undefined ? question : { ...question, explanationZh: rewrite.explanationZh };
  });
}

async function regenerateOverlongMcqExplanations(
  set: ReadingSet,
  overlong: ReadonlyMap<string, number>,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<ReadingSet> {
  const modules: Record<ReadingModuleName, ReadingModule> = {} as Record<ReadingModuleName, ReadingModule>;

  for (const moduleName of READING_MODULE_NAMES) {
    const module = set[moduleName];
    const dailyLife: ReadingModule["dailyLife"] = [];
    for (const text of module.dailyLife) {
      const questions = await rewriteOverlongExplanations(text.id, text.text, text.questions, overlong, run, onProgress);
      dailyLife.push({ ...text, questions });
    }
    const academic: ReadingModule["academic"] = [];
    for (const passage of module.academic) {
      const questions = await rewriteOverlongExplanations(passage.id, passage.text, passage.questions, overlong, run, onProgress);
      academic.push({ ...passage, questions });
    }
    modules[moduleName] = { ...module, dailyLife, academic };
  }

  return ReadingSetSchema.parse({ ...set, ...modules });
}

// The position-reference rewrite: the same batch-by-Stimulus shape and response schema as the length
// rewrite above, kept separate because that pathway is keyed by a measured length rather than by a
// flag.
function mcqPositionReferenceRewritePrompt(input: {
  stimulusId: string;
  stimulusText: string;
  flagged: readonly ReadingMcqQuestion[];
}): string {
  return [
    "/toefl-reading",
    "GENERATE reading",
    "",
    "Rewrite ONLY the 繁體中文 Explanation (錯題解析) of the MCQ question(s) below; change no other field.",
    // Shared with Listening and pinned against the detector by optionQuality.test.ts, so the wording
    // and the gate cannot drift apart.
    positionReferenceInstruction(),
    "Return ONLY {\"explanations\":[{\"id\":string,\"explanationZh\":string}, ...]}, exactly one entry per question listed, reusing its own id.",
    "",
    "```mcq-position-reference-rewrite",
    JSON.stringify({ stimulusId: input.stimulusId, stimulusText: input.stimulusText, flagged: input.flagged }),
    "```",
  ].join("\n");
}

async function rewritePositionReferenceExplanations(
  stimulusId: string,
  stimulusText: string,
  questions: readonly ReadingMcqQuestion[],
  flaggedIds: ReadonlySet<string>,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<ReadingMcqQuestion[]> {
  const flagged = questions.filter((question) => flaggedIds.has(question.id));
  if (flagged.length === 0) return [...questions];

  const result = await callGenerationSkillTask({
    run,
    task: { task: "generate", context: "reading" },
    prompt: mcqPositionReferenceRewritePrompt({ stimulusId, stimulusText, flagged }),
    jsonSchema: toProviderJsonSchema(McqExplanationRewritesSchema),
    parse: (value) => McqExplanationRewritesSchema.parse(value),
    stage: "generating",
    onProgress,
  });
  if (!result.ok) throw new Error(result.error);
  const byId = requestedReplacements(flagged.map((question) => question.id), result.value.explanations, (id) => {
    throw new Error(
      `set validation failed: MCQ position-reference explanation rewrite for stimulus "${stimulusId}" did not return question "${id}"`,
    );
  });
  return questions.map((question) => {
    const rewrite = byId.get(question.id);
    return rewrite === undefined ? question : { ...question, explanationZh: rewrite.explanationZh };
  });
}

async function regeneratePositionReferenceMcqExplanations(
  set: ReadingSet,
  flagged: ReadonlySet<string>,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<ReadingSet> {
  const modules: Record<ReadingModuleName, ReadingModule> = {} as Record<ReadingModuleName, ReadingModule>;

  for (const moduleName of READING_MODULE_NAMES) {
    const module = set[moduleName];
    const dailyLife: ReadingModule["dailyLife"] = [];
    for (const text of module.dailyLife) {
      const questions = await rewritePositionReferenceExplanations(text.id, text.text, text.questions, flagged, run, onProgress);
      dailyLife.push({ ...text, questions });
    }
    const academic: ReadingModule["academic"] = [];
    for (const passage of module.academic) {
      const questions = await rewritePositionReferenceExplanations(passage.id, passage.text, passage.questions, flagged, run, onProgress);
      academic.push({ ...passage, questions });
    }
    modules[moduleName] = { ...module, dailyLife, academic };
  }

  return ReadingSetSchema.parse({ ...set, ...modules });
}

/**
 * Every daily-life and academic MCQ in the Set through shuffleMcqOptions — see it for the property
 * this establishes. `rng` defaults to `Math.random`; tests inject a deterministic one.
 */
export function rebalanceReadingOptionOrder(
  set: ReadingSet,
  rng: () => number = Math.random,
  /** Questions whose explanation still names an option by position: shuffling them would make it false. */
  keepOrderOf: ReadonlySet<string> = new Set(),
): ReadingSet {
  const shuffle = (question: ReadingMcqQuestion): ReadingMcqQuestion =>
    keepOrderOf.has(question.id) ? question : shuffleMcqOptions(question, rng);
  const shuffleModule = (module: ReadingModule): ReadingModule => ({
    ...module,
    dailyLife: module.dailyLife.map((text) => ({ ...text, questions: text.questions.map(shuffle) })),
    academic: module.academic.map((passage) => ({ ...passage, questions: passage.questions.map(shuffle) })),
  });
  return {
    ...set,
    router: shuffleModule(set.router),
    lowerModule: shuffleModule(set.lowerModule),
    upperModule: shuffleModule(set.upperModule),
  };
}

type ReadingVerdict = z.infer<typeof ReadingVerifierSchema>;

/**
 * Reading's half of the shared verify loop (generationVerifyLoop.ts): what only Reading knows. The
 * loop owns the round budget, the remediation guard, admission and the exhaustion report.
 *
 * Each round runs the content gate, then the Verifier on every unit not yet passed at its current
 * content. A CtW passage flagged "ambiguous" (or by the gate's `ctw-gap-leak`) is rewritten whole;
 * one flagged "unfaithful-explanation" (or with an Explanation not in 繁體中文) gets only its
 * Explanations rewritten. An MCQ "issue" or "quality" verdict, option-length bias, or a stem, option
 * or Explanation not in its language regenerates the question; "issue" stays outstanding until
 * fixed, while "quality" buys one regeneration and is then accepted with a note. Over-long and
 * position-referencing explanations are rewritten in place.
 *
 * The gate re-runs every round, so a remediation that introduces a new violation is caught before
 * publish. Only `composition` fails on sight; the other kinds publish with a note once the
 * MAX_VERIFY_ATTEMPTS budget is spent.
 */
function readingVerifyPolicy(input: {
  plan: ReadingGenerationPlan;
  run: SkillTaskRunner;
  onProgress: OnGenerationProgress | undefined;
}): VerifyPolicy<ReadingSet, ReadingContentViolation, ReadingVerdict, string> {
  const { plan, run, onProgress } = input;
  // The "quality" verdict's one repair, tracked across rounds. `qualityFlaggedAt` is the content an
  // MCQ was first flagged at; once its content has changed (it was regenerated) a further "quality"
  // verdict is accepted rather than repaired again. `acceptedQuality` is what `finish` turns into
  // notes, keyed by question id with the Task Type the note names. Per-run state: a policy is built
  // per verifyReadingSet call.
  const qualityFlaggedAt = new Map<string, string>();
  const acceptedQuality = new Map<string, "daily_life" | "academic_passage">();
  return {
    logPrefix: "[readingGenerator]",
    // Plain strings: Reading has no SafeDiagnostic brand. Every `detail` the gate writes and every
    // exhaustion part below carries ids, counts and kinds only, never Set text or Verifier prose.
    diagnostic: (text) => text,
    preflight: (set) => deterministicReadingPreChecks(set),
    violations: (set) => readingContentViolations(set),
    isBlocking: (violation) => READING_GATE.isFatal(violation.kind),
    isAdvisory: (violation) => READING_GATE.isAdvisory(violation.kind),
    isDegradable: (violation) => READING_GATE.degrades(violation.kind),
    formatViolations: (violations) => formatReadingViolations(violations),
    describeGateFailure: (violations) =>
      `set validation failed: reading content gate found ${violations.length} violation(s): ${formatReadingViolations(violations)}`,
    units: (set) => readingVerifyUnits(set),
    emptyVerdict: { ctwPassages: [], mcqItems: [] },
    verify: (set, pending) => {
      const { prompt, sent } = readingVerifyRequest(set, pending);
      return {
        task: { task: "verify", context: "reading" },
        prompt,
        jsonSchema: toProviderJsonSchema(ReadingVerifierSchema),
        parse: (value) => {
          const verdict = ReadingVerifierSchema.parse(value);
          assertVerdictCoverage("ctwPassages", sent.ctwPassages, verdict.ctwPassages.map((entry) => entry.id));
          assertVerdictCoverage("mcqItems", sent.mcqItems, verdict.mcqItems.map((entry) => entry.id));
          return verdict;
        },
      };
    },
    planRound: ({ isFinalRound, set, violations, verdict, units }) => {
      const overlongCtwExplanations = new Map<string, number>();
      const overlongMcqExplanations = new Map<string, number>();
      const gapLeak = new Map<string, string>();
      // Gate findings that regenerate a question whole: option-length bias, and a stem or option not
      // in English. One question can carry several (one per offending field), so reasons merge.
      const mcqFromGate = new Map<string, string>();
      const explanationLanguage: string[] = [];
      // Only the ids matter: the prompt carries one generic instruction, not a per-question reason.
      const positionReference = new Map<string, true>();
      for (const violation of violations) {
        const route = readingRemediationRoute(violation.kind);
        if (route === "ctw-explanation-length" && violation.kind === "explanation-length-ctw") {
          overlongCtwExplanations.set(violation.id, violation.actualLength);
        } else if (route === "mcq-explanation-length" && violation.kind === "explanation-length-mcq") {
          overlongMcqExplanations.set(violation.id, violation.actualLength);
        } else if (route === "ctw-gap-leak" && violation.kind === "ctw-gap-leak") {
          gapLeak.set(violation.id, ctwGapLeakFeedback(set, violation.id, violation.leakedGapIds));
        } else if (route === "mcq-wholesale") {
          addReason(mcqFromGate, violation.id, violation.detail);
        } else if (route === "mcq-position-reference") {
          positionReference.set(violation.id, true);
        } else if (route === "explanation-language") {
          explanationLanguage.push(violation.id);
        } else if (REMEDIABLE_VIOLATION_KINDS.has(violation.kind)) {
          // A remediable kind with no route would never be repaired; say so loudly rather than
          // spend the budget silently (readingRemediationRoute says why there is no generic remedy).
          // Every remediable Reading kind ends advisory, so the Set still publishes, with a note.
          // `kind` is a literal, never content.
          console.error(
            `[readingGenerator] remediable violation kind "${violation.kind}" has no remediation route; it re-flags every round, spends the whole verify budget, and the Set publishes with it as a note`,
          );
        }
      }

      const mcqIssues = verdict.mcqItems.filter(
        (item): item is { id: string; verdict: "issue"; reason: string } => item.verdict === "issue",
      );
      // "quality" is repair-then-accept with an advisory ending: an MCQ flagged at content it has not
      // been regenerated from yet buys one regeneration; flagged again after it changed — or on the
      // final round — it is accepted, recorded for a note, and passed so it is not re-sent.
      const taskTypeByQuestionId = new Map(
        READING_MODULE_NAMES.flatMap((moduleName) => [
          ...set[moduleName].dailyLife.flatMap((text) => text.questions.map((q) => [q.id, "daily_life"] as const)),
          ...set[moduleName].academic.flatMap((passage) => passage.questions.map((q) => [q.id, "academic_passage"] as const)),
        ]),
      );
      const qualityRepairs: { id: string; reason: string }[] = [];
      const passed: string[] = [];
      for (const item of verdict.mcqItems) {
        if (item.verdict === "ok") {
          acceptedQuality.delete(item.id);
          passed.push(mcqUnit(item.id));
        } else if (item.verdict === "issue") {
          acceptedQuality.delete(item.id);
        } else {
          const fingerprint = units.get(mcqUnit(item.id)) ?? "";
          const flaggedAt = qualityFlaggedAt.get(item.id);
          if (isFinalRound || (flaggedAt !== undefined && flaggedAt !== fingerprint)) {
            acceptedQuality.set(item.id, taskTypeByQuestionId.get(item.id) ?? "daily_life");
            passed.push(mcqUnit(item.id));
          } else {
            qualityFlaggedAt.set(item.id, fingerprint);
            qualityRepairs.push({ id: item.id, reason: item.reason });
          }
        }
      }
      for (const item of verdict.ctwPassages) {
        if (item.verdict === "ok") passed.push(ctwUnit(item.id));
      }
      // An "ambiguous" claim stands only for the gaps whose named alternate fits the blank
      // (isTypeableCtwAlternate). A passage left with no such gap is treated as passed: the claim was
      // about a word the User cannot type. Dropped claims are logged by id only.
      const gapsByPassageId = new Map(
        READING_MODULE_NAMES.flatMap((moduleName) => set[moduleName].ctwPassages)
          .map((passage) => [passage.id, new Map(passage.gaps.map((gap) => [gap.id, gap]))] as const),
      );
      const ambiguous: { id: string; reason: string; alternates: { gapId: string; alternate: string }[] }[] = [];
      const droppedAmbiguity: string[] = [];
      for (const item of verdict.ctwPassages) {
        if (item.verdict !== "ambiguous") continue;
        const gaps = gapsByPassageId.get(item.id);
        const alternates = item.ambiguousGaps.filter(({ gapId, alternate }) => {
          const gap = gaps?.get(gapId);
          return gap !== undefined && isTypeableCtwAlternate(gap, alternate);
        });
        if (alternates.length === 0) {
          droppedAmbiguity.push(item.id);
          passed.push(ctwUnit(item.id));
        } else {
          ambiguous.push({ id: item.id, reason: item.reason, alternates });
        }
      }
      if (droppedAmbiguity.length > 0) {
        console.warn(
          `[readingGenerator] dropping ${droppedAmbiguity.length} "ambiguous" verdict(s) whose alternates do not fit their blanks: ${droppedAmbiguity.join(", ")}`,
        );
      }
      const unfaithful = verdict.ctwPassages.filter(
        (item): item is { id: string; verdict: "unfaithful-explanation"; gapIds: string[]; reason: string } =>
          item.verdict === "unfaithful-explanation",
      );

      // Every question regenerated whole this round: Verifier "issue" and "quality" verdicts, and the
      // gate's question-level findings. addReason merges, so a question flagged by several sources
      // gets one call stating every reason.
      const mcqWholesale = new Map<string, string>();
      for (const item of mcqIssues) addReason(mcqWholesale, item.id, item.reason);
      for (const item of qualityRepairs) addReason(mcqWholesale, item.id, item.reason);
      for (const [id, detail] of mcqFromGate) addReason(mcqWholesale, id, detail);

      // The over-long-explanation rewrite is driven by GAP ids but re-runs a whole passage's
      // explanation call, so a passage claimed by either CtW wholesale remediation moots every one of
      // its gaps at once. That is what the loop's `scope` hook is for; this is the map it reads.
      const passageIdByGapId = new Map<string, string>();
      for (const moduleName of READING_MODULE_NAMES) {
        for (const passage of set[moduleName].ctwPassages) {
          for (const gap of passage.gaps) passageIdByGapId.set(gap.id, passage.id);
        }
      }

      // An explanation with no 繁體中文 in it: a CtW gap's goes to its passage's explanation rewrite
      // beside any Verifier "unfaithful-explanation" verdict on the same passage; an MCQ's is
      // regenerated with the question.
      const ctwExplanationRewrites = new Map<string, { reason: string; gapIds: string[] }>(
        unfaithful.map((item) => [item.id, { reason: item.reason, gapIds: [...item.gapIds] }]),
      );
      for (const id of explanationLanguage) {
        const passageId = passageIdByGapId.get(id);
        if (passageId === undefined) {
          addReason(mcqWholesale, id, "Its explanationZh contained no 繁體中文 at all; write it genuinely in 繁體中文.");
          continue;
        }
        const reason = `gap ${id}'s explanationZh contained no 繁體中文 at all; write it genuinely in 繁體中文`;
        const existing = ctwExplanationRewrites.get(passageId);
        ctwExplanationRewrites.set(passageId, existing
          ? { reason: `${existing.reason} Separately: ${reason}`, gapIds: [...existing.gapIds, id] }
          : { reason, gapIds: [id] });
      }

      return {
        verdictFindings: mcqIssues.length + qualityRepairs.length + ambiguous.length + unfaithful.length,
        passed,
        remediations: [
          // Wave 1: the wholesale rewrites, which claim everything the explanation-only rewrites
          // below must not spend a call on. They share one wave, so a passage flagged both
          // "ambiguous" (or gap-leak) and unfaithful receives both calls.
          [
            VerifyRemediation.declare({
              category: "CtW passage rewrite",
              pass: "wholesale",
              targets: new Map<string, string>([
                ...ambiguous.map((item): [string, string] => [
                  item.id,
                  `A previous draft of this paragraph was flagged AMBIGUOUS by the verifier: ${item.reason} (${item.alternates.map(({ gapId, alternate }) => `gap ${gapId} also admits "${alternate}"`).join("; ")}). Rewrite the paragraph's content, keeping the same topic. Gap positions are chosen by the server, not by you, so the only fix is different wording. The bar: for every gapped word, the visible prefix plus the number of missing letters must admit exactly ONE real English word that fits the sentence — no second word of the same length may fit the same slot. Verb-tense and inflection pairs are the usual offenders; where a word fails this test, change that word (or the surrounding phrasing that makes both readings sensible), not just the sentence around it.`,
                ]),
                // A surgical edit of the named words rather than an open-ended rewrite: more likely to
                // succeed in one round, and less likely to introduce a new leak elsewhere. Followable
                // because ctwRepairPrompt sends the current paragraph.
                ...[...gapLeak].map(([passageId, finding]): [string, string] => [
                  passageId,
                  `The paragraph above (in the current-paragraph fence) was flagged because ${finding}. Starting from that EXACT text: for each named word, KEEP its first occurrence exactly as written, and change every LATER occurrence to a different, natural word that fits its own sentence — so that word appears only once in the whole paragraph afterward. Leave every other word EXACTLY as it was; do not rewrite unrelated sentences or restructure the paragraph, and do not replace every occurrence of a named word (that only trades one repeated word for another). Gap positions are chosen by the server from your edited paragraph, not by you, so this surgical edit is the only fix needed.`,
                ]),
              ]),
              apply: (current, targets) => regenerateWholesalePassages(current, plan, targets, run, onProgress),
            }),
            VerifyRemediation.declare({
              category: "unfaithful CtW explanation",
              pass: "wholesale",
              targets: ctwExplanationRewrites,
              apply: (current, targets) => regenerateUnfaithfulExplanations(current, targets, run, onProgress),
            }),
            VerifyRemediation.declare({
              category: "MCQ wholesale",
              pass: "wholesale",
              targets: mcqWholesale,
              apply: (current, targets) => regenerateRejectedMcqs(current, targets, run, onProgress),
            }),
          ],
          // Wave 2: the explanation-only rewrites, admitted against wave 1's claims.
          [
            VerifyRemediation.declare({
              category: "CtW explanation-length",
              pass: "explanation",
              targets: overlongCtwExplanations,
              scope: (gapId) => passageIdByGapId.get(gapId) ?? gapId,
              apply: (current, targets) => regenerateOverlongCtwExplanations(current, targets, run, onProgress),
            }),
            VerifyRemediation.declare({
              category: "MCQ explanation-length",
              pass: "explanation",
              targets: overlongMcqExplanations,
              apply: (current, targets) => regenerateOverlongMcqExplanations(current, targets, run, onProgress),
            }),
          ],
          // Wave 3: also excludes questions rewritten for length in wave 2, whose new text has not
          // been measured yet. A deferred id is re-flagged next round, not skipped.
          [
            VerifyRemediation.declare({
              category: "MCQ position-reference",
              pass: "explanation",
              targets: positionReference,
              apply: (current, targets) =>
                regeneratePositionReferenceMcqExplanations(current, new Set(targets.keys()), run, onProgress),
            }),
          ],
        ],
        // Ids the Set itself holds, nothing else: a Verifier's `reason` can quote the passage it
        // judged, its `gapIds` are unchecked strings, and these parts reach `job.error`. Every verdict
        // id has passed assertVerdictCoverage.
        exhaustionParts: [
          ...(ambiguous.length > 0
            ? [`${ambiguous.length} ambiguous: ${ambiguous.map((item) => item.id).join(", ")}`]
            : []),
          ...(unfaithful.length > 0
            ? [`${unfaithful.length} with unfaithful explanations: ${unfaithful.map((item) => item.id).join(", ")}`]
            : []),
          ...(mcqIssues.length > 0
            ? [`${mcqIssues.length} MCQ item(s) with issues: ${mcqIssues.map((item) => item.id).join(", ")}`]
            : []),
        ],
      };
    },
    // Worded for both causes: a Verifier finding, or the content gate alone after an all-"ok" verdict.
    describeExhaustion: ({ parts }) =>
      `set validation failed: reading set still has unresolved issues after ${MAX_VERIFY_ATTEMPTS} verify attempts: ${parts.join(" | ")}`,
    finish: (set, violations) => finishReadingSet(set, violations, [...acceptedQuality.values()]),
  };
}

/**
 * Runs Reading's content gate, Verifier and repairs over a minted Set and returns the Set to publish,
 * or throws. Takes the full ReadingSet because it reads the Plan back off `generationPlan`, which
 * generator.ts attaches when it mints the Set.
 */
export async function verifyReadingSet(
  set: ReadingSet,
  run: SkillTaskRunner,
  onProgress: OnGenerationProgress | undefined,
  setId: string,
): Promise<ReadingSet> {
  const plan = set.generationPlan;
  if (!plan) {
    throw new Error("set validation failed: reading set is missing its generationPlan");
  }
  return runVerifyLoop({
    set,
    policy: readingVerifyPolicy({ plan, run, onProgress }),
    run,
    onProgress,
    setId,
  });
}

// ---------------------------------------------------------------------------
// The candidate adapter
// ---------------------------------------------------------------------------

/**
 * The one way a Reading candidate is rejected: its Upper Module reads no harder than its Lower. The
 * hint is a boolean — see readingGenerationPrompt.
 */
type ReadingRejection = {
  readonly rejection: "difficulty";
  readonly hint: true;
  readonly detail: string;
};

/**
 * Reading's side of the shared candidate loop. The GENERATE call returns a sourceParagraph-only
 * candidate that assembleReadingContent derives into the full shape (segments, gaps, Explanations)
 * before Item ids or novelty can be checked. The fatal difficulty comparison runs in `prepare` on
 * the raw response, since it needs only passage text, so a rejected candidate never pays for
 * assembly.
 */
export function readingCandidateAdapter(
  plan: GenerationPlan,
): CandidateAdapter<ReadingGenerationInput, ReadingGeneratedSet, ReadingRejection> {
  if (plan.kind !== "reading") {
    throw new Error("set validation failed: generation kind mismatch");
  }
  const readingPlan = plan;
  return {
    task: { task: "generate", context: "reading" },
    jsonSchema: toProviderJsonSchema(ReadingGenerationInputSchema),
    parseResponse: (value) => ReadingGenerationInputSchema.parse(value),
    parseCandidate: (value) =>
      ReadingGenerationInputSchema.parse({
        ...(value as object),
        id: "pending-candidate",
        source: "generated",
        createdAt: "1970-01-01T00:00:00.000Z",
      }),
    prompt: (hints) => readingGenerationPrompt(readingPlan, hints.difficulty ?? false),
    prepare: async ({ raw, ctx }) => {
      const rawDifficulty = compareReadingModuleDifficulty(raw);
      // A blocking finding rejects the candidate; the candidate loop regenerates while its budget
      // lasts, and the job fails when it runs out.
      if (!rawDifficulty.upperIsHarder && blocksGeneration({ family: "module-difficulty", section: "reading" })) {
        const detail = moduleDifficultyDetail(rawDifficulty);
        console.error(
          `[generator] reading candidate attempt ${ctx.attempt}/${ctx.attemptBudget} rejected: ${detail}`,
        );
        return { rejected: { rejection: "difficulty", hint: true, detail } };
      }
      const candidate = await assembleReadingContent({
        raw,
        plan: readingPlan,
        run: ctx.run,
        onProgress: ctx.onProgress,
      });
      validateItemIds(candidate);
      return { candidate };
    },
    decide: ({ candidate }) => {
      const accepted: PlannedCandidate = { kind: "reading", candidate, plan: readingPlan };
      return { accepted };
    },
    describeExhaustion: ({ attempts, newest }) =>
      `set validation failed: upper module is not harder than lower module after ${attempts} attempts\n${newest.detail}`,
  };
}
