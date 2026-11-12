import { z } from "zod";
import {
  LISTENING_MODULE_COMPOSITION,
  ListeningGenerationInputSchema,
  ListeningSkillCategory,
  ListeningTaskType,
  McqOptionSchema,
  mcqQuestionSchema,
  type GenerationPlan,
  type ListeningGenerationInput,
  type ListeningGenerationPlan,
  type ListeningModule,
  type ListeningSet,
  type SetAdvisoryNote,
} from "@toefl-prep/shared";
import { toProviderJsonSchema } from "./reasoning/jsonSchema.js";
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
import { blocksGeneration, classifyGenerationCheck, LISTENING_REMEDIABLE_KINDS } from "./generationCheckPolicy.js";
import {
  compareListeningModuleDifficulty,
  moduleDifficultyDetail,
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
import {
  optionLengthBiasFlags,
  positionReferenceInstruction,
  referencesOptionByPosition,
  wordCount,
  type OptionBiasSample,
} from "./optionQuality.js";
import { GEMINI_VOICE_POOL_NAMES, GEMINI_VOICE_POOLS, type GeminiVoicePool } from "./geminiVoices.js";
import { listeningClipIdProblem } from "./listeningAudioRenderer.js";

// Listening's half of Set generation: the GENERATE prompt, the code-owned speaker rendering, the
// content gate, the verify policy with its four regeneration grains, and the candidate adapter.
// The shared loops drive these pieces: generationCandidateLoop.ts (attempt budget, retry hints) and
// generationVerifyLoop.ts (round budget, admission, dispatch). readingGenerator.ts is the Reading
// counterpart.
//
// Unlike Reading, the GENERATE call's output is already the final Set shape, so there is no
// derive-then-repair step. Instead, assignSpeakerRendering overwrites every Speaker's rendering
// fields right after generation; the model's values for them are placeholders.
//
// Imports nothing from generator.ts, which imports from here.

type ListeningModuleName = keyof typeof LISTENING_MODULE_COMPOSITION;
export const LISTENING_MODULE_NAMES: readonly ListeningModuleName[] = [
  "router",
  "lowerModule",
  "upperModule",
];

type LcrItem = ListeningModule["listenChoose"][number];
type Conversation = ListeningModule["conversations"][number];
type Announcement = ListeningModule["announcements"][number];
type AcademicTalk = ListeningModule["academicTalks"][number];
type ListeningMcqQuestion = Conversation["questions"][number];
type ListeningSpeaker = LcrItem["speaker"];

function moduleComposition(module: {
  listenChoose: readonly unknown[];
  conversations: readonly unknown[];
  announcements: readonly unknown[];
  academicTalks: readonly unknown[];
}): string {
  return `${module.listenChoose.length} listen-choose + ${module.conversations.length} conversation + ${module.announcements.length} announcement + ${module.academicTalks.length} academic-talk`;
}

// ---------------------------------------------------------------------------
// GENERATE prompt (the main call, one full candidate)
// ---------------------------------------------------------------------------

/**
 * The Upper-harder-than-Lower property, stated in every full-Set GENERATE prompt rather than only
 * after a candidate has been rejected for missing it (UPPER_MODULE_HARDER_RETRY is the escalation on
 * top).
 *
 * Number-free: the difficulty index the gate grades is gate-only, and a model shown a number
 * optimises the number instead of writing harder prose. The per-task CEFR targets are model-visible
 * (they are ETS's published targets), but they live in the generation guide's difficulty section,
 * which this line points at rather than restating.
 *
 * Listening-only: Reading's guide states its direction as an absolute per-module CEFR and
 * Flesch-Kincaid table, and ETS publishes no readability range for spoken text.
 */
export const LISTENING_UPPER_MODULE_DIRECTION = [
  "",
  "MODULE DIFFICULTY IS PART OF THE SPEC, NOT AN AFTERTHOUGHT. The UPPER MODULE is what a stronger",
  "test taker is routed to, so its spoken English must be genuinely more demanding than the LOWER",
  "MODULE's: longer and more complex sentences, denser information, less common vocabulary (idiomatic",
  "and figurative use included), and more abstract content. The LOWER MODULE stays correspondingly",
  "plainer and more concrete. Carry that gap in the LANGUAGE — never by changing a plan entry's topic,",
  "setting, discipline, speaker role or domain, and never by making one module's scripts longer, since",
  "every Task Type keeps the same word target in both modules. The guide's difficulty section states",
  "the per-task CEFR targets and the upper-vs-lower levers; follow it.",
].join("\n");

export function listeningGenerationPrompt(
  plan: ListeningGenerationPlan,
  /**
   * The previous attempt's Upper Module read no harder than its Lower Module. A boolean rather than
   * the measured grades, because the index is gate-only. Adds UPPER_MODULE_HARDER_RETRY on top of
   * LISTENING_UPPER_MODULE_DIRECTION, which every prompt carries.
   */
  upperNotHarder = false,
): string {
  return [
    "/toefl-listening",
    "GENERATE listening",
    "",
    "Produce one complete Listening Set as JSON matching the supplied generation-input schema.",
    "Follow this accepted server plan exactly. Do not emit generationPlan.",
    "Every audio field is the literal empty string \"\" — the renderer fills it in after this call.",
    "Every Speaker.voice and Speaker.provider is a schema-valid placeholder — the server overwrites both after this call.",
    "Module composition (how many of each stimulus each module holds):",
    JSON.stringify(LISTENING_MODULE_COMPOSITION),
    "",
    "```accepted-plan-json",
    JSON.stringify(plan),
    "```",
    LISTENING_UPPER_MODULE_DIRECTION,
    ...(upperNotHarder ? [UPPER_MODULE_HARDER_RETRY] : []),
  ].join("\n");
}


// ---------------------------------------------------------------------------
// Speaker rendering: code-owned, never model-chosen
// ---------------------------------------------------------------------------
//
// The server, not the model, decides every Speaker's accent, voice and provider, and the gender of
// every single-speaker Stimulus. Balancing those across a whole Set is counting, which a model does
// badly in prose and code does exactly; deciding them here leaves nothing to gate or repair.
//
// Gender is server-owned only for the single-speaker shapes (Listen and Choose a Response,
// Announcement, Academic Talk): each is first-person delivery, so no transcript line can contradict
// it. A Conversation's two speakers can refer to each other, so their genders stay the model's; the
// schema requires one male and one female.
//
// No regeneration schema in this file returns a `speaker`, so this assignment, made once right after
// generation, survives every later repair.

const ACCENT_ROTATION = ["north-american", "british", "australian"] as const;

// Every Speaker is synthesised by Gemini, so `provider` is always "gemini". The schema still accepts
// "openai" because one published Set (lsn-14659f38) records it. The voice pools live in
// geminiVoices.ts; which Stimulus shape draws from which pool is decided here.

function renderedSpeaker(
  speaker: ListeningSpeaker,
  accent: (typeof ACCENT_ROTATION)[number],
  voice: string,
  // Defaults to the model's own choice, which Conversations keep. Every other caller passes
  // nextGender().
  gender: "male" | "female" = speaker.gender,
): ListeningSpeaker {
  return { ...speaker, gender, accent, provider: "gemini", voice };
}

// Listen and Choose a Response rotates through every pool geminiVoices.ts declares. Derived from
// GEMINI_VOICE_POOL_NAMES so a pool added to the cast is drawn here too.
const LCR_POOL_ROTATION: readonly GeminiVoicePool[] = GEMINI_VOICE_POOL_NAMES;

/**
 * Overwrites every Speaker's `accent`, `voice` and `provider`, and the `gender` of every
 * single-speaker Stimulus, in Set-traversal order (router, lowerModule, upperModule; within each,
 * listenChoose, conversations, announcements, academicTalks; within each array, index order).
 *
 * The voice pool follows the Stimulus shape, never `role`, which is model-written free text a
 * keyword classifier would mis-cast:
 *   - academicTalks -> `authoritative`
 *   - announcements -> `service`
 *   - conversations -> speakers[0] from `young`, speakers[1] from `service`
 *   - listenChoose  -> rotates through every pool (LCR_POOL_ROTATION)
 * Casting a Conversation by position assumes a student talking to staff. When the model puts the
 * staff member first, that speaker gets a younger voice: a realism cost, not a defect.
 *
 * Within each (pool, gender) pair the voice rotates on its own counter, so a Set does not reuse one
 * voice for every speaker of a kind. The pools are disjoint (geminiVoices.test.ts), so a
 * Conversation's two speakers always get different voices.
 *
 * Pure and deterministic: no randomness, no clock.
 */
export function assignSpeakerRendering(candidate: ListeningGenerationInput): ListeningGenerationInput {
  let accentTick = 0;
  let genderTick = 0;
  let lcrPoolTick = 0;
  const voiceTick: Record<GeminiVoicePool, Record<"male" | "female", number>> = {
    authoritative: { male: 0, female: 0 },
    young: { male: 0, female: 0 },
    service: { male: 0, female: 0 },
  };
  const nextAccent = (): (typeof ACCENT_ROTATION)[number] => {
    const accent = ACCENT_ROTATION[accentTick % ACCENT_ROTATION.length]!;
    accentTick += 1;
    return accent;
  };
  // Alternates across every single-speaker Stimulus in traversal order, so gender is balanced by
  // construction.
  const nextGender = (): "male" | "female" => {
    const gender: "male" | "female" = genderTick % 2 === 0 ? "male" : "female";
    genderTick += 1;
    return gender;
  };
  // One counter per (pool, gender), shared by every shape that draws that pair, so a voice repeats
  // only after every other voice of the pair has been used.
  const nextVoice = (pool: GeminiVoicePool, gender: "male" | "female"): string => {
    const members = GEMINI_VOICE_POOLS[pool][gender];
    const voice = members[voiceTick[pool][gender] % members.length]!;
    voiceTick[pool][gender] += 1;
    return voice;
  };
  const nextLcrPool = (): GeminiVoicePool => {
    const pool = LCR_POOL_ROTATION[lcrPoolTick % LCR_POOL_ROTATION.length]!;
    lcrPoolTick += 1;
    return pool;
  };

  const renderModule = (module: ListeningModule): ListeningModule => ({
    ...module,
    listenChoose: module.listenChoose.map((item) => {
      const gender = nextGender();
      const pool = nextLcrPool();
      return { ...item, speaker: renderedSpeaker(item.speaker, nextAccent(), nextVoice(pool, gender), gender) };
    }),
    conversations: module.conversations.map((conversation) => {
      // Gender stays the model's (no fourth argument); the pool is chosen by position.
      const [first, second] = conversation.speakers;
      const firstVoice = nextVoice("young", first!.gender);
      const secondVoice = nextVoice("service", second!.gender);
      return {
        ...conversation,
        speakers: [
          renderedSpeaker(first!, nextAccent(), firstVoice),
          renderedSpeaker(second!, nextAccent(), secondVoice),
        ] as [ListeningSpeaker, ListeningSpeaker],
      };
    }),
    announcements: module.announcements.map((announcement) => {
      const gender = nextGender();
      return { ...announcement, speaker: renderedSpeaker(announcement.speaker, nextAccent(), nextVoice("service", gender), gender) };
    }),
    academicTalks: module.academicTalks.map((talk) => {
      const gender = nextGender();
      return { ...talk, speaker: renderedSpeaker(talk.speaker, nextAccent(), nextVoice("authoritative", gender), gender) };
    }),
  });

  return {
    ...candidate,
    router: renderModule(candidate.router),
    lowerModule: renderModule(candidate.lowerModule),
    upperModule: renderModule(candidate.upperModule),
  };
}

// ---------------------------------------------------------------------------
// The content gate
// ---------------------------------------------------------------------------

// Set content must never reach a thrown message. A thrown message becomes the generation job's
// `error`, which the API serves and the client shows, while a transcript reaches the User only in
// an Attempt review and a Listen and Choose a Response utterance never reaches the User as text. The
// Verifier's `reason` is the riskiest source: it is grounded in the transcript and often quotes it.
//
// The boundary is enforced at the source, by type. SafeDiagnostic is a branded string: a plain
// string is not assignable to it, so it can only come from `safeDiagnostic()` or a function typed to
// return one. Every violation `detail`, every message builder and `listeningFailure` (the only place
// in this file an Error is constructed) take SafeDiagnostic, so embedding model text in a message
// takes an explicit, greppable `safeDiagnostic(...)` call. The shared sink (generationJobs.ts's
// job.error) is not the place to scrub: it serves every section, and it cannot tell content from
// diagnostics without becoming section-aware.
//
// Exported, type-only, so generator.listening.test.ts can pin the boundary with `@ts-expect-error`.
// That test also pins that this file constructs an Error in exactly one place.
export type SafeDiagnostic = string & { readonly __safeListeningDiagnostic: unique symbol };

/** Mints a SafeDiagnostic. Every caller passes ids, kind labels, counts or a check's own computed
 * number, or a route-failure message (`result.error`, which carries provider labels and failure
 * kinds only; see `ReasoningRouteError`). Never a Verifier `.reason`, a transcript, an utterance, a
 * stem or option text. */
function safeDiagnostic(text: string): SafeDiagnostic {
  return text as SafeDiagnostic;
}

/** Names flagged entries by id and count, never by the Verifier's free-text reason.
 *
 * The reason is not lost: it reaches the model through the regeneration prompt, and the Verifier's
 * response is kept in the model-call diagnostic tables (ADR 0004), which both the job path and
 * `scripts/generate-set.ts` record. It is not logged, because a grounded reason may quote a
 * transcript. */
function summarizeFlaggedIds(label: string, ids: readonly string[]): SafeDiagnostic {
  return safeDiagnostic(`${ids.length} ${label}: ${ids.join(", ")}`);
}

/** Throws the pipeline's "set validation failed" Error from SafeDiagnostic fragments, joined with
 * no separator (each fragment carries its own punctuation). The only Error constructor in this
 * file. */
function listeningFailure(...parts: readonly SafeDiagnostic[]): never {
  throw new Error(parts.join(""));
}

// A rough total-syllable estimate (vowel-group counting), not a stressed-syllable count. The guide
// asks for at most about six stressed syllables, ETS's bound; this gate's threshold sits well above
// that because total syllables always exceed stressed ones and a model cannot count either exactly.
// It catches a runaway utterance, not a near miss. Gate-only: never in the guide or SKILL.md.
function estimateSyllables(text: string): number {
  let total = 0;
  for (const rawWord of text.toLowerCase().split(/[^a-z']+/u).filter(Boolean)) {
    let word = rawWord;
    if (word.length > 2 && word.endsWith("e") && !word.endsWith("le")) {
      word = word.slice(0, -1);
    }
    const groups = word.match(/[aeiouy]+/gu);
    total += Math.max(1, groups ? groups.length : 1);
  }
  return total;
}
const LCR_MAX_ESTIMATED_SYLLABLES = 16;

const CONVERSATION_WORD_RANGE = { min: 80, max: 150 } as const;
const ANNOUNCEMENT_WORD_RANGE = { min: 40, max: 85 } as const;
// ETS's published length for an Academic Talk: "short (175–250 words)".
const ACADEMIC_TALK_WORD_RANGE = { min: 175, max: 250 } as const;

// The model-visible word TARGETS, stated in the guide and in every word-count repair prompt. Each
// sits well inside its *_WORD_RANGE, the gate-only TOLERANCE: a model asked to hit a boundary lands
// on both sides of it, while one asked for the middle keeps its misses inside the tolerance. Neither
// may leak into the other, so no *_WORD_RANGE number appears in the guide or a prompt.
//
// The Academic Talk is the exception: its target is ETS's whole published band, so target and gate
// coincide, and the guide asks the model to land comfortably inside the range, not at an edge.
const CONVERSATION_WORD_TARGET = { min: 100, max: 130 } as const;
const ANNOUNCEMENT_WORD_TARGET = { min: 55, max: 70 } as const;
const ACADEMIC_TALK_WORD_TARGET = { min: 175, max: 250 } as const;

// Each remediable kind maps to the narrowest regeneration that can fix it (see listeningVerifyPolicy
// for the routing, and generationCheckPolicy.ts for each kind's tier):
//   - word-count, transcript-language: the whole Stimulus (a fresh transcript and questions).
//     transcript-language is a kind apart from item-language because it is Stimulus-grain.
//   - syllable-estimate: the one Listen and Choose a Response item.
//   - item-language, invalid-answer-key, option-length-bias: the one Listen and Choose a Response
//     item or the one question, whichever the id names.
//   - explanation-length, explanation-language, explanation-position-reference: the explanation
//     alone.
// "composition" is the one kind that is not remediable: a wrong array length cannot be fixed by
// regenerating content. The generation-input schema already fixes every module's counts, so this is
// a safety net.
//
// Gender balance has no kind: assignSpeakerRendering balances it by construction.
//
// invalid-answer-key is a key that names none of its options, or options sharing an id
// (answerKeyDefect, shared with Reading). checkOptionKey still throws when a regeneration's reply
// carries either. That throw happens inside a remediation, so the verify loop's guard turns it into
// a failed round, not a failed job.
export type ListeningViolationKind =
  | "composition"
  | "word-count"
  | "syllable-estimate"
  | "item-language"
  | "transcript-language"
  | "explanation-language"
  | "explanation-length"
  | "invalid-answer-key"
  // A Set-wide distribution property, not a single-item defect; see optionLengthBiasViolations.
  | "option-length-bias"
  // explanationZh names an option by its position or label, which the final option shuffle can
  // make false; see referencesOptionByPosition in optionQuality.ts.
  | "explanation-position-reference";

type ListeningViolationBase = {
  readonly label: string;
  readonly id: string;
  readonly detail: SafeDiagnostic;
};

export type ListeningContentViolation =
  | (ListeningViolationBase & { readonly kind: "explanation-length"; readonly actualLength: number })
  | (ListeningViolationBase & { readonly kind: "word-count"; readonly actualWords: number })
  | (ListeningViolationBase & { readonly kind: "syllable-estimate"; readonly actualSyllables: number })
  | (ListeningViolationBase & { readonly kind: Exclude<ListeningViolationKind, "explanation-length" | "word-count" | "syllable-estimate"> });

const REMEDIABLE_VIOLATION_KINDS: ReadonlySet<ListeningViolationKind> = LISTENING_REMEDIABLE_KINDS;

// Option-length bias (the key is too often the longest option): detection, per-group chance rates
// and the ceiling all live in optionLengthBiasFlags (optionQuality.ts), shared with Reading.
// Everything numeric there is gate-only; the guide's distractor rules state the model-visible side
// in prose. Listening mixes 3- and 4-option questions, which is why the check measures per group.

// Gate-only. How many option-length-bias offenders one verify round may hand to regeneration; the
// rest wait for a later round. Large enough that this check is not what exhausts the round budget
// it shares with the whole-Stimulus repairs (MAX_STIMULUS_REPAIRS_PER_ROUND). A larger cap costs few
// extra calls: flagged Listen and Choose a Response items share one call, and flagged questions one
// call per Stimulus.
const MAX_LONGEST_OPTION_REMEDIATIONS_PER_ROUND = 12;

/**
 * Option-length bias over every scoreable item in the Set: the Listen and Choose a Response items
 * and every Stimulus question together. A thin wrapper over optionLengthBiasFlags, as Reading's
 * longestOptionBiasViolations is.
 */
function optionLengthBiasViolations(items: readonly OptionBiasSample[]): ListeningContentViolation[] {
  return optionLengthBiasFlags(items, MAX_LONGEST_OPTION_REMEDIATIONS_PER_ROUND).map((flag) => ({
    kind: "option-length-bias" as const,
    label: flag.label,
    id: flag.id,
    // Counts, group names and measure names only; no item text.
    detail: safeDiagnostic(flag.detail),
  }));
}

function formatListeningViolations(violations: readonly ListeningContentViolation[]): SafeDiagnostic {
  // Every part is already safe: `detail` is SafeDiagnostic, kind and label are server-composed, and
  // ids are SafeIdSchema tokens.
  return safeDiagnostic(violations.map((v) => `${v.kind} ${v.label} "${v.id}": ${v.detail}`).join("; "));
}

export function listeningContentViolations(set: {
  router: ListeningModule;
  lowerModule: ListeningModule;
  upperModule: ListeningModule;
}): ListeningContentViolation[] {
  const violations: ListeningContentViolation[] = [];

  const checkExplanation = (label: string, id: string, explanationZh: string): void => {
    const length = explanationLength(explanationZh);
    if (length > EXPLANATION_HARD_LIMIT_CODE_POINTS) {
      violations.push({
        kind: "explanation-length", label, id, actualLength: length,
        detail: safeDiagnostic(`explanationZh is ${length} 字, past the ${EXPLANATION_HARD_LIMIT_CODE_POINTS}-字 runaway limit (target is ${EXPLANATION_TARGET_CODE_POINTS})`),
      });
    }
    if (!CJK_RE.test(explanationZh)) {
      violations.push({
        kind: "explanation-language", label, id,
        detail: safeDiagnostic(`explanationZh contains no CJK character at all (繁體中文 expected)`),
      });
    }
    if (referencesOptionByPosition(explanationZh)) {
      violations.push({
        kind: "explanation-position-reference", label, id,
        detail: safeDiagnostic(`explanationZh refers to an option by POSITION or LABEL, which the answer-key rebalance (the pipeline's own last mutation) can and does invalidate — describe the key and distractors by CONTENT instead`),
      });
    }
  };

  const checkOptionsAndStem = (label: string, id: string, stem: string, options: readonly { id: string; text: string }[]): void => {
    if (CJK_RE.test(stem)) {
      violations.push({ kind: "item-language", label, id, detail: safeDiagnostic(`stem is not English`) });
    }
    for (const option of options) {
      if (CJK_RE.test(option.text)) {
        violations.push({ kind: "item-language", label, id, detail: safeDiagnostic(`option "${option.id}" is not English`) });
      }
    }
  };

  // Option ids and `correctOptionId` are SafeIdSchema tokens, so they may appear in `detail`.
  const checkAnswerKey = (label: string, id: string, options: readonly { id: string }[], correctOptionId: string): void => {
    const defect = answerKeyDefect(options, correctOptionId);
    if (defect) violations.push({ kind: "invalid-answer-key", label, id, detail: safeDiagnostic(defect) });
  };

  // Every scoreable item, in traversal order, for the Set-wide option-length-bias check at the end.
  const optionSamples: OptionBiasSample[] = [];

  const checkQuestion = (label: string, question: ListeningMcqQuestion): void => {
    checkOptionsAndStem(label, question.id, question.stem, question.options);
    checkExplanation(label, question.id, question.explanationZh);
    checkAnswerKey(label, question.id, question.options, question.correctOptionId);
    optionSamples.push({ label, id: question.id, options: question.options, correctOptionId: question.correctOptionId });
  };

  for (const moduleName of LISTENING_MODULE_NAMES) {
    const module = set[moduleName];
    const expected = LISTENING_MODULE_COMPOSITION[moduleName];
    if (
      module.listenChoose.length !== expected.listenChoose ||
      module.conversations.length !== expected.conversations ||
      module.announcements.length !== expected.announcements ||
      module.academicTalks.length !== expected.academicTalks
    ) {
      violations.push({
        kind: "composition", label: moduleName, id: moduleName,
        detail: safeDiagnostic(`is ${moduleComposition(module)}, expected ${expected.listenChoose} listen-choose + ${expected.conversations} conversation + ${expected.announcements} announcement + ${expected.academicTalks} academic-talk`),
      });
    }

    for (const item of module.listenChoose) {
      const label = `${moduleName}/listen_choose/${item.id}`;
      const syllables = estimateSyllables(item.utterance);
      if (syllables > LCR_MAX_ESTIMATED_SYLLABLES) {
        violations.push({
          kind: "syllable-estimate", label, id: item.id, actualSyllables: syllables,
          detail: safeDiagnostic(`utterance is an estimated ${syllables} syllables, expected roughly at most 6 stressed syllables (short utterance)`),
        });
      }
      if (CJK_RE.test(item.utterance)) {
        // Never embed `item.utterance`: it is never shown to the User as text, and `detail` can
        // reach the job's `error`.
        violations.push({ kind: "item-language", label, id: item.id, detail: safeDiagnostic(`utterance is not English`) });
      }
      checkOptionsAndStem(label, item.id, "", item.options);
      checkExplanation(label, item.id, item.explanationZh);
      checkAnswerKey(label, item.id, item.options, item.correctOptionId);
      optionSamples.push({ label, id: item.id, options: item.options, correctOptionId: item.correctOptionId });
    }

    for (const conversation of module.conversations) {
      const label = `${moduleName}/conversation/${conversation.id}`;
      const words = conversation.transcript.reduce((sum, turn) => sum + wordCount(turn.text), 0);
      if (words < CONVERSATION_WORD_RANGE.min || words > CONVERSATION_WORD_RANGE.max) {
        violations.push({
          kind: "word-count", label, id: conversation.id, actualWords: words,
          detail: safeDiagnostic(`transcript is ${words} words total, expected ${CONVERSATION_WORD_RANGE.min}-${CONVERSATION_WORD_RANGE.max}`),
        });
      }
      // A transcript is Stimulus-grain: transcript-language, not item-language.
      for (const turn of conversation.transcript) {
        if (CJK_RE.test(turn.text)) {
          violations.push({ kind: "transcript-language", label, id: conversation.id, detail: safeDiagnostic(`transcript turn is not English`) });
        }
      }
      for (const question of conversation.questions) checkQuestion(label, question);
    }

    for (const announcement of module.announcements) {
      const label = `${moduleName}/announcement/${announcement.id}`;
      const words = wordCount(announcement.transcript);
      if (words < ANNOUNCEMENT_WORD_RANGE.min || words > ANNOUNCEMENT_WORD_RANGE.max) {
        violations.push({
          kind: "word-count", label, id: announcement.id, actualWords: words,
          detail: safeDiagnostic(`transcript is ${words} words, expected ${ANNOUNCEMENT_WORD_RANGE.min}-${ANNOUNCEMENT_WORD_RANGE.max}`),
        });
      }
      if (CJK_RE.test(announcement.transcript)) {
        violations.push({ kind: "transcript-language", label, id: announcement.id, detail: safeDiagnostic(`transcript is not English`) });
      }
      for (const question of announcement.questions) checkQuestion(label, question);
    }

    for (const talk of module.academicTalks) {
      const label = `${moduleName}/academic_talk/${talk.id}`;
      const words = wordCount(talk.transcript);
      if (words < ACADEMIC_TALK_WORD_RANGE.min || words > ACADEMIC_TALK_WORD_RANGE.max) {
        violations.push({
          kind: "word-count", label, id: talk.id, actualWords: words,
          detail: safeDiagnostic(`transcript is ${words} words, expected ${ACADEMIC_TALK_WORD_RANGE.min}-${ACADEMIC_TALK_WORD_RANGE.max}`),
        });
      }
      if (CJK_RE.test(talk.transcript)) {
        violations.push({ kind: "transcript-language", label, id: talk.id, detail: safeDiagnostic(`transcript is not English`) });
      }
      for (const question of talk.questions) checkQuestion(label, question);
    }
  }

  violations.push(...optionLengthBiasViolations(optionSamples));
  return violations;
}

/** Listening's content-gate kinds read through generationCheckPolicy. */
const LISTENING_GATE = contentGateTiers((kind: ListeningViolationKind) =>
  classifyGenerationCheck({ family: "content-gate", section: "listening", kind })
);

const LISTENING_TASK_TYPE_LABELS: ReadonlySet<string> = new Set(ListeningTaskType.options);

/**
 * Which Task Type a violation's label names, for the advisory note.
 *
 * Read back off the `${module}/${taskType}/${id}` label, as readingViolationTaskType does. The middle
 * segment already is a ListeningTaskType value, so this validates rather than translates. Any other
 * shape, including the bare module name a `composition` violation carries, yields no Task Type
 * rather than a guess.
 */
function listeningViolationTaskType(label: string): string | undefined {
  const segment = label.split("/")[1];
  return segment !== undefined && LISTENING_TASK_TYPE_LABELS.has(segment) ? segment : undefined;
}

/**
 * The label a `talk-register` note's `detail` carries. A fixed, server-authored string: the note's
 * whole payload is which check fired and which talk it fired on, and the Verifier's own `reason` —
 * the only prose in play — is exactly what may never travel this channel.
 */
const REGISTER_ADVISORY_DETAIL = "below-task-register";

/**
 * The advisory notes for Academic Talks that publish with a surviving "register" verdict, so the
 * finding is recorded on the Set and shown to the User (ADR 0006's advisory tier).
 *
 * `positions` are global Academic Talk positions (router, then lower, then upper), the way the
 * diversity checks name a Listening component. Nothing else travels: not the id, which the model
 * wrote, and not the reason, which may quote the transcript.
 */
function registerAdvisoryNotes(positions: readonly number[]): SetAdvisoryNote[] {
  return positions.map((itemPosition) => ({
    check: "talk-register" as const,
    detail: REGISTER_ADVISORY_DETAIL,
    taskType: "academic_talk",
    itemPosition,
  }));
}

/**
 * The one exit every one of verifyListeningSet's success paths goes through. The option rebalance
 * runs here because this is downstream of every possible options-array mutation.
 *
 * `survivingRegisterPositions` carries the Verifier-sourced findings: the verify loop's `finish`
 * hands over content-gate violations only, so register findings arrive as state the deciding round
 * wrote down. See listeningVerifyPolicy.
 */
function finishListeningSet(
  set: ListeningSet,
  violations: readonly ListeningContentViolation[],
  survivingRegisterPositions: readonly number[] = [],
  /** The Task Type of each Item published with an unrepaired Verifier "quality" finding. */
  acceptedQuality: readonly string[] = [],
): ListeningSet {
  return finishVerifiedSet({
    set,
    violations,
    rebalance: (current, keepOrderOf) => rebalanceListeningOptionOrder(current, Math.random, keepOrderOf),
    notes: [
      {
        producer: "listening content gate",
        notes: contentGateNotes(violations, LISTENING_GATE.degrades, listeningViolationTaskType),
      },
      { producer: "listening verify", notes: registerAdvisoryNotes(survivingRegisterPositions) },
      { producer: "listening verify", notes: itemQualityNotes(acceptedQuality) },
    ],
  });
}

/** Refuses a regeneration reply whose key is unusable (answerKeyDefect); ids only in the message. */
function checkOptionKey(id: string, options: readonly { id: string }[], correctOptionId: string): void {
  const defect = answerKeyDefect(options, correctOptionId);
  if (defect) listeningFailure(safeDiagnostic(`set validation failed: item "${id}": ${defect}`));
}

/**
 * The content gate's check on the candidate entering verification, as deterministicReadingPreChecks
 * is for Reading. Fails on any fatal violation, listing every violation found; remediable ones are
 * left for the verify loop to repair.
 */
export function deterministicListeningPreChecks(set: {
  router: ListeningModule;
  lowerModule: ListeningModule;
  upperModule: ListeningModule;
}): void {
  const violations = listeningContentViolations(set);
  const blocking = violations.filter((violation) => LISTENING_GATE.isFatal(violation.kind));
  if (blocking.length > 0) {
    const remediable = violations.filter((violation) => REMEDIABLE_VIOLATION_KINDS.has(violation.kind));
    // Typed SafeDiagnostic[] so a raw model string cannot be pushed here.
    const parts: SafeDiagnostic[] = [
      safeDiagnostic(`${blocking.length} blocking violation(s): ${formatListeningViolations(blocking)}`),
      ...(remediable.length > 0
        ? [safeDiagnostic(`${remediable.length} remediable violation(s) also present (not the cause of this failure): ${formatListeningViolations(remediable)}`)]
        : []),
    ];
    listeningFailure(safeDiagnostic(`set validation failed: listening content gate found ${violations.length} violation(s): `), safeDiagnostic(parts.join(" | ")));
  }
}

// ---------------------------------------------------------------------------
// LLM verify (verify:listening) + remediation
// ---------------------------------------------------------------------------

const ListeningVerifierSchema = z.object({
  // "issue" and "quality" are tiered differently (ADR 0006), as in Reading: "issue" is a key the
  // User would be taught wrong, repaired and then fatal; "quality" is a correctly keyed but weak
  // Item that gets one regeneration and then publishes with a note. The same split applies to
  // `questions` below. See listeningVerifyPolicy's planRound.
  listenChooseItems: z.array(z.union([
    z.object({ id: z.string(), verdict: z.literal("ok") }),
    z.object({ id: z.string(), verdict: z.literal("issue"), reason: z.string() }),
    z.object({ id: z.string(), verdict: z.literal("quality"), reason: z.string() }),
  ])),
  stimuli: z.array(z.union([
    z.object({ id: z.string(), verdict: z.literal("ok") }),
    z.object({ id: z.string(), verdict: z.literal("unanswerable"), reason: z.string() }),
    // Academic Talks only: the transcript supports its questions, but its language is below the
    // task type's level (plain high-frequency vocabulary throughout, where ETS describes
    // "vocabulary that is sometimes uncommon, colloquial, or idiomatic", or a flat list of facts with
    // no rhetorical pattern). A separate arm from "unanswerable" because the tiers differ: an
    // unanswerable Stimulus would teach a wrong answer and blocks, while this is taste over a usable
    // Set, which ADR 0006 never lets block.
    //
    // The schema cannot know which ids are Academic Talks, so planRound drops a register verdict on
    // any other id rather than spending regenerations on a clean Stimulus.
    z.object({ id: z.string(), verdict: z.literal("register"), reason: z.string() }),
  ])),
  questions: z.array(z.union([
    z.object({ id: z.string(), verdict: z.literal("ok") }),
    z.object({ id: z.string(), verdict: z.literal("issue"), reason: z.string() }),
    z.object({ id: z.string(), verdict: z.literal("quality"), reason: z.string() }),
  ])),
});

/**
 * The verify unit keys: a Listen-and-Choose item on its own, and a Stimulus together with its
 * questions. A Stimulus is judged on whether its transcript supports its questions and each question
 * against the transcript, so the two are sent, passed and re-sent as one group.
 */
const lcrUnit = (itemId: string): string => `lcr:${itemId}`;
const stimulusUnit = (stimulusId: string): string => `stimulus:${stimulusId}`;

function listeningStimuli(set: ListeningSet): StimulusPayload[] {
  return LISTENING_MODULE_NAMES.flatMap((moduleName) => [
    ...set[moduleName].conversations.map((c) => ({
      id: c.id, taskType: "conversation" as const, transcript: c.transcript, questions: c.questions,
    })),
    ...set[moduleName].announcements.map((a) => ({
      id: a.id, taskType: "announcement" as const, transcript: a.transcript, questions: a.questions,
    })),
    ...set[moduleName].academicTalks.map((t) => ({
      id: t.id, taskType: "academic_talk" as const, transcript: t.transcript, questions: t.questions,
    })),
  ]);
}

function listeningVerifyUnits(set: ListeningSet): Map<string, string> {
  const units = new Map<string, string>();
  for (const moduleName of LISTENING_MODULE_NAMES) {
    for (const item of set[moduleName].listenChoose) {
      units.set(lcrUnit(item.id), JSON.stringify([item.utterance, item.options, item.correctOptionId, item.explanationZh]));
    }
  }
  for (const stimulus of listeningStimuli(set)) {
    units.set(stimulusUnit(stimulus.id), JSON.stringify([stimulus.transcript, stimulus.questions]));
  }
  return units;
}

type StimulusPayload = {
  id: string;
  taskType: "conversation" | "announcement" | "academic_talk";
  transcript: unknown;
  questions: readonly { id: string; stem: string; options: readonly { id: string; text: string }[]; correctOptionId: string; explanationZh: string }[];
};

function listeningVerifyRequest(set: ListeningSet, pending: ReadonlySet<string>): {
  prompt: string;
  sent: { listenChooseItems: string[]; stimuli: string[]; questions: string[] };
} {
  const listenChooseItems = LISTENING_MODULE_NAMES.flatMap((moduleName) =>
    set[moduleName].listenChoose.filter((item) => pending.has(lcrUnit(item.id))).map((item) => ({
      id: item.id, utterance: item.utterance, options: item.options,
      correctOptionId: item.correctOptionId, explanationZh: item.explanationZh,
    }))
  );
  const stimuli = listeningStimuli(set).filter((stimulus) => pending.has(stimulusUnit(stimulus.id)));
  const questions = stimuli.flatMap((stimulus) =>
    stimulus.questions.map((question) => ({
      id: question.id, stimulusId: stimulus.id, stem: question.stem, options: question.options,
      correctOptionId: question.correctOptionId, explanationZh: question.explanationZh,
    }))
  );
  const prompt = [
    "/toefl-listening",
    "VERIFY listening",
    "",
    "For each Listen-and-Choose item: verdict \"issue\" if the key is wrong for a learner — correctOptionId is wrong, another option is an equally valid response, or explanationZh misstates the key or cites a detail the utterance does not contain. Otherwise verdict \"quality\" if it is keyed correctly but weak — a distractor is not genuinely plausible, an option echoes the utterance's own words, or the item is answerable by generic social-script guessing without the utterance's specific content. \"issue\" takes precedence when both apply; otherwise \"ok\".",
    "For each Conversation/Announcement/Academic-Talk stimulus: verdict \"unanswerable\" if the transcript itself cannot support one or more of its own questions; otherwise \"ok\".",
    "For an Academic-Talk stimulus ONLY (taskType \"academic_talk\"), when it is NOT unanswerable: verdict \"register\" if its language sits below what this task type is for — its vocabulary is plain and high-frequency end to end, with nothing uncommon, colloquial or idiomatic anywhere in it, or it is a flat list of facts built on no rhetorical pattern (compare/contrast, cause-effect). \"unanswerable\" takes precedence: one verdict per stimulus, and a transcript that cannot support its questions is the bigger problem. Never give \"register\" to a Conversation or an Announcement.",
    "For each Conversation/Announcement/Academic-Talk question: verdict \"issue\" if the key is wrong for a learner — correctOptionId is wrong, another option is equally defensible from the transcript, it isn't answerable from the transcript alone despite an otherwise-sound transcript, or explanationZh misstates the key or cites a detail the transcript does not contain. Otherwise verdict \"quality\" if it is keyed correctly but weak — a distractor is not genuinely plausible, or explanationZh doesn't cite the transcript line the answer hinges on. \"issue\" takes precedence when both apply; otherwise \"ok\".",
    "Each `stimuli` entry carries its own full `transcript` (an array of {speakerId, text} turns for a conversation, a single string otherwise). Every `questions` entry's `stimulusId` names which `stimuli` entry it belongs to — resolve that reference and ground every verdict above in the actual transcript text, not the id alone.",
    "Return {\"listenChooseItems\":[...],\"stimuli\":[...],\"questions\":[...]} exactly as shaped above, one entry per item/stimulus/question supplied.",
    "",
    "```json",
    JSON.stringify({ listenChooseItems, stimuli: stimuli.map(({ id, taskType, transcript }) => ({ id, taskType, transcript })), questions }),
    "```",
  ].join("\n");
  return {
    prompt,
    sent: {
      listenChooseItems: listenChooseItems.map((item) => item.id),
      stimuli: stimuli.map((stimulus) => stimulus.id),
      questions: questions.map((question) => question.id),
    },
  };
}

// --- Listen and Choose a Response item regeneration (whole item) ------------------------------

const LcrReplacementSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    utterance: z.string().min(1),
    options: z.array(McqOptionSchema).length(4),
    correctOptionId: z.string().min(1),
    skill: ListeningSkillCategory,
    explanationZh: z.string().min(1),
  })).min(1),
});

function lcrRegenerationPrompt(flagged: readonly (LcrItem & { reason: string })[]): string {
  return [
    "/toefl-listening",
    "GENERATE listening",
    "",
    "Regenerate ONLY the flagged Listen-and-Choose item(s) below; keep every other item, and each flagged item's own id and speaker, untouched.",
    "Return ONLY {\"items\":[{\"id\",\"utterance\",\"options\":[{\"id\",\"text\"}, ...],\"correctOptionId\",\"skill\",\"explanationZh\"}, ...]}, exactly one replacement per flagged item, reusing its own id.",
    `In explanationZh: ${positionReferenceInstruction()}`,
    "",
    "```lcr-regeneration",
    JSON.stringify({ items: flagged }),
    "```",
  ].join("\n");
}

async function regenerateFlaggedLcrItems(
  set: ListeningSet,
  issues: ReadonlyMap<string, string>,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<ListeningSet> {
  if (issues.size === 0) return set;
  const allItems = LISTENING_MODULE_NAMES.flatMap((moduleName) => set[moduleName].listenChoose);
  const flagged = allItems.filter((item) => issues.has(item.id));
  if (flagged.length === 0) return set;

  const result = await callGenerationSkillTask({
    run,
    task: { task: "generate", context: "listening" },
    prompt: lcrRegenerationPrompt(flagged.map((item) => ({ ...item, reason: issues.get(item.id)! }))),
    jsonSchema: toProviderJsonSchema(LcrReplacementSchema),
    parse: (value) => LcrReplacementSchema.parse(value),
    stage: "generating",
    onProgress,
  });
  if (!result.ok) listeningFailure(safeDiagnostic(result.error));
  const byId = requestedReplacements(flagged.map((item) => item.id), result.value.items, (id) =>
    listeningFailure(safeDiagnostic(`set validation failed: LCR regeneration did not return item "${id}"`)));
  for (const item of flagged) checkOptionKey(item.id, byId.get(item.id)!.options, byId.get(item.id)!.correctOptionId);

  const patchModule = (module: ListeningModule): ListeningModule => ({
    ...module,
    listenChoose: module.listenChoose.map((item) => {
      const replacement = byId.get(item.id);
      return replacement ? { ...item, ...replacement } : item;
    }),
  });
  return {
    ...set,
    router: patchModule(set.router), lowerModule: patchModule(set.lowerModule), upperModule: patchModule(set.upperModule),
  };
}

// --- Stimulus transcript regeneration (whole transcript + fresh questions) -------------------

/**
 * A regenerated Stimulus's questions, carrying the ids of the questions they replace, by position.
 *
 * A User's Response is stored under its Item id, so ids are the server's to keep stable, not the
 * model's to choose: a regeneration that answered with ids it saw elsewhere in the Set would let one
 * Response overwrite another. The replacement's content is kept whole; only `id` is taken from the
 * original at the same index. A count mismatch cannot be mapped and is a failed regeneration.
 */
function withReplacedQuestionIds<Q extends { id: string }>(
  stimulusId: string,
  original: readonly { id: string }[],
  replacement: readonly Q[],
): Q[] {
  if (replacement.length !== original.length) {
    listeningFailure(safeDiagnostic(
      `set validation failed: regeneration for "${stimulusId}" returned ${replacement.length} question(s), expected ${original.length}`,
    ));
  }
  return replacement.map((question, index) => ({ ...question, id: original[index]!.id }));
}

const ConversationRegenSchema = z.object({
  transcript: z.array(z.object({ speakerId: z.string().min(1), text: z.string().min(1) })).min(1),
  questions: z.array(mcqQuestionSchema(ListeningSkillCategory)).length(2),
});
const AnnouncementRegenSchema = z.object({
  transcript: z.string().min(1),
  questions: z.array(mcqQuestionSchema(ListeningSkillCategory)).length(2),
});
const AcademicTalkRegenSchema = z.object({
  transcript: z.string().min(1),
  questions: z.array(mcqQuestionSchema(ListeningSkillCategory)).length(4),
});

function stimulusRegenerationPrompt(input: {
  stimulusId: string;
  taskType: "conversation" | "announcement" | "academic_talk";
  context: Record<string, unknown>;
  reason: string;
}): string {
  return [
    "/toefl-listening",
    "GENERATE listening",
    "",
    "Regenerate ONE Listening stimulus's transcript and questions; the reason field below says what was wrong with the previous draft (unanswerable questions, a word count outside its target, non-English content, or — for an Academic Talk — vocabulary and rhetoric below the task type's level).",
    "Return ONLY {\"transcript\": ..., \"questions\": [...]} in the shape matching this stimulus's own taskType (an array of {speakerId, text} turns for a conversation, a single string otherwise).",
    `In each question's explanationZh: ${positionReferenceInstruction()}`,
    "",
    "```stimulus-regeneration",
    JSON.stringify(input),
    "```",
  ].join("\n");
}

async function regenerateOneStimulus(
  stimulus: Conversation | Announcement | AcademicTalk,
  taskType: "conversation" | "announcement" | "academic_talk",
  reason: string,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<Conversation | Announcement | AcademicTalk> {
  if (taskType === "conversation") {
    const conversation = stimulus as Conversation;
    const result = await callGenerationSkillTask({
      run,
      task: { task: "generate", context: "listening" },
      prompt: stimulusRegenerationPrompt({
        stimulusId: conversation.id, taskType, reason,
        context: { setting: conversation.setting, speakers: conversation.speakers.map((s) => ({ id: s.id, role: s.role })) },
      }),
      jsonSchema: toProviderJsonSchema(ConversationRegenSchema),
      parse: (value) => ConversationRegenSchema.parse(value),
      stage: "generating",
      onProgress,
    });
    if (!result.ok) listeningFailure(safeDiagnostic(result.error));
    const speakerIds = new Set(conversation.speakers.map((s) => s.id));
    for (const turn of result.value.transcript) {
      if (!speakerIds.has(turn.speakerId)) {
        listeningFailure(safeDiagnostic(`set validation failed: stimulus regeneration for "${conversation.id}" referenced unknown speakerId "${turn.speakerId}"`));
      }
    }
    const questions = withReplacedQuestionIds(conversation.id, conversation.questions, result.value.questions);
    for (const question of questions) checkOptionKey(question.id, question.options, question.correctOptionId);
    return { ...conversation, transcript: result.value.transcript, questions };
  }
  if (taskType === "announcement") {
    const announcement = stimulus as Announcement;
    const result = await callGenerationSkillTask({
      run,
      task: { task: "generate", context: "listening" },
      prompt: stimulusRegenerationPrompt({
        stimulusId: announcement.id, taskType, reason,
        context: { setting: announcement.setting, speakerRole: announcement.speaker.role },
      }),
      jsonSchema: toProviderJsonSchema(AnnouncementRegenSchema),
      parse: (value) => AnnouncementRegenSchema.parse(value),
      stage: "generating",
      onProgress,
    });
    if (!result.ok) listeningFailure(safeDiagnostic(result.error));
    const questions = withReplacedQuestionIds(announcement.id, announcement.questions, result.value.questions);
    for (const question of questions) checkOptionKey(question.id, question.options, question.correctOptionId);
    return { ...announcement, transcript: result.value.transcript, questions };
  }
  const talk = stimulus as AcademicTalk;
  const result = await callGenerationSkillTask({
    run,
    task: { task: "generate", context: "listening" },
    prompt: stimulusRegenerationPrompt({
      stimulusId: talk.id, taskType, reason,
      context: { discipline: talk.discipline, speakerRole: talk.speaker.role },
    }),
    jsonSchema: toProviderJsonSchema(AcademicTalkRegenSchema),
    parse: (value) => AcademicTalkRegenSchema.parse(value),
    stage: "generating",
    onProgress,
  });
  if (!result.ok) listeningFailure(safeDiagnostic(result.error));
  const questions = withReplacedQuestionIds(talk.id, talk.questions, result.value.questions);
  for (const question of questions) checkOptionKey(question.id, question.options, question.correctOptionId);
  return { ...talk, transcript: result.value.transcript, questions };
}

// Whole-Stimulus regeneration serves every reason a fresh transcript and questions can fix: a
// Verifier "unanswerable" or "register" verdict, and the content gate's word-count and
// transcript-language findings. `flagged` carries the reason text.
//
// One call per flagged Stimulus, sequentially, at most MAX_STIMULUS_REPAIRS_PER_ROUND per round. The
// rest are deferred, never dropped: `flagged` is rebuilt every round from the unchanged Set, so a
// deferred Stimulus is picked up later, while a dropped one would be re-found unchanged until the
// budget ran out.
//
// The cap covers the worst case a Set can produce. The final verify round only decides the ending,
// so MAX_VERIFY_ATTEMPTS - 1 rounds repair, and N flagged Stimuli need ceil(N / 4) of them:
// ceil(16 / 4) + 1 = 5 = MAX_VERIFY_ATTEMPTS, and 16 is every Stimulus in a Set besides the Listen
// and Choose a Response items. A deferred Stimulus's questions are claimed by this remediation, so
// their explanation rewrites wait for it too.
//
// Option-length-bias repairs (MAX_LONGEST_OPTION_REMEDIATIONS_PER_ROUND) run in the same rounds,
// not in separate ones.
const MAX_STIMULUS_REPAIRS_PER_ROUND = 4;

async function regenerateFlaggedStimuli(
  set: ListeningSet,
  flagged: ReadonlyMap<string, string>,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<ListeningSet> {
  if (flagged.size === 0) return set;
  const idsThisRound = new Set([...flagged.keys()].slice(0, MAX_STIMULUS_REPAIRS_PER_ROUND));
  if (flagged.size > MAX_STIMULUS_REPAIRS_PER_ROUND) {
    const deferred = [...flagged.keys()].filter((id) => !idsThisRound.has(id));
    console.warn(
      `[listeningGenerator] whole-Stimulus regeneration capped at ${MAX_STIMULUS_REPAIRS_PER_ROUND} per round: regenerating ${idsThisRound.size} of ${flagged.size} flagged Stimuli now (${[...idsThisRound].join(", ")}), deferring ${deferred.length} to a later round (${deferred.join(", ")})`,
    );
  }

  const patchModule = async (module: ListeningModule): Promise<ListeningModule> => {
    const conversations: Conversation[] = [];
    for (const conversation of module.conversations) {
      const reason = idsThisRound.has(conversation.id) ? flagged.get(conversation.id) : undefined;
      conversations.push(
        reason === undefined ? conversation : (await regenerateOneStimulus(conversation, "conversation", reason, run, onProgress)) as Conversation,
      );
    }
    const announcements: Announcement[] = [];
    for (const announcement of module.announcements) {
      const reason = idsThisRound.has(announcement.id) ? flagged.get(announcement.id) : undefined;
      announcements.push(
        reason === undefined ? announcement : (await regenerateOneStimulus(announcement, "announcement", reason, run, onProgress)) as Announcement,
      );
    }
    const academicTalks: AcademicTalk[] = [];
    for (const talk of module.academicTalks) {
      const reason = idsThisRound.has(talk.id) ? flagged.get(talk.id) : undefined;
      academicTalks.push(
        reason === undefined ? talk : (await regenerateOneStimulus(talk, "academic_talk", reason, run, onProgress)) as AcademicTalk,
      );
    }
    return { ...module, conversations, announcements, academicTalks };
  };

  return {
    ...set,
    router: await patchModule(set.router),
    lowerModule: await patchModule(set.lowerModule),
    upperModule: await patchModule(set.upperModule),
  };
}

// --- MCQ question regeneration (batched per stimulus, flagged only) ----------------------------

const QuestionReplacementsSchema = z.object({
  questions: z.array(mcqQuestionSchema(ListeningSkillCategory)).min(1),
});

function questionRegenerationPrompt(input: {
  stimulusId: string;
  transcript: unknown;
  flagged: readonly (ListeningMcqQuestion & { reason: string })[];
}): string {
  return [
    "/toefl-listening",
    "GENERATE listening",
    "",
    "Regenerate ONLY the flagged question(s) below for one Listening stimulus; keep every other question and the transcript untouched.",
    "Return ONLY {\"questions\":[{\"id\",\"stem\",\"options\":[{\"id\",\"text\"}, ...],\"correctOptionId\",\"skill\",\"explanationZh\"}, ...]}, exactly one replacement per flagged question, reusing its own id.",
    `In explanationZh: ${positionReferenceInstruction()}`,
    "",
    "```question-regeneration",
    JSON.stringify({ stimulusId: input.stimulusId, transcript: input.transcript, flaggedQuestions: input.flagged }),
    "```",
  ].join("\n");
}

async function regenerateFlaggedQuestionsOfStimulus(
  stimulusId: string,
  transcript: unknown,
  questions: readonly ListeningMcqQuestion[],
  issues: ReadonlyMap<string, string>,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<ListeningMcqQuestion[]> {
  const flagged = questions.filter((question) => issues.has(question.id));
  if (flagged.length === 0) return [...questions];

  const result = await callGenerationSkillTask({
    run,
    task: { task: "generate", context: "listening" },
    prompt: questionRegenerationPrompt({
      stimulusId, transcript,
      flagged: flagged.map((question) => ({ ...question, reason: issues.get(question.id)! })),
    }),
    jsonSchema: toProviderJsonSchema(QuestionReplacementsSchema),
    parse: (value) => QuestionReplacementsSchema.parse(value),
    stage: "generating",
    onProgress,
  });
  if (!result.ok) listeningFailure(safeDiagnostic(result.error));
  const byId = requestedReplacements(flagged.map((question) => question.id), result.value.questions, (id) =>
    listeningFailure(safeDiagnostic(`set validation failed: question regeneration for stimulus "${stimulusId}" did not return question "${id}"`)));
  for (const question of flagged) checkOptionKey(question.id, byId.get(question.id)!.options, byId.get(question.id)!.correctOptionId);
  return questions.map((question) => byId.get(question.id) ?? question);
}

const QUESTION_STIMULUS_GROUPS = ["conversations", "announcements", "academicTalks"] as const;

/**
 * One call per Stimulus holding a flagged question, all started together. Every call is awaited
 * before this settles, failed or not: a call left running after the remediation has failed would go
 * on spending, and its progress could reach the job row after the job ended.
 *
 * All or nothing. The verify loop takes a remediation's result as either a whole new Set or a
 * throw that leaves the Set unchanged and is counted in its failure ledger, so a partial apply has
 * no way to report the calls that failed. When any call fails, this throws the first failure once
 * the rest have settled, and the next round asks again for every question still flagged.
 */
async function regenerateRejectedListeningQuestions(
  set: ListeningSet,
  issues: ReadonlyMap<string, string>,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<ListeningSet> {
  if (issues.size === 0) return set;

  const calls: { key: string; questions: Promise<ListeningMcqQuestion[]> }[] = [];
  for (const moduleName of LISTENING_MODULE_NAMES) {
    for (const group of QUESTION_STIMULUS_GROUPS) {
      set[moduleName][group].forEach((stimulus, index) => {
        if (!stimulus.questions.some((question) => issues.has(question.id))) return;
        calls.push({
          key: `${moduleName}/${group}/${index}`,
          questions: regenerateFlaggedQuestionsOfStimulus(stimulus.id, stimulus.transcript, stimulus.questions, issues, run, onProgress),
        });
      });
    }
  }
  const settled = await Promise.allSettled(calls.map((call) => call.questions));
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
  const replaced = new Map(calls.map((call, i) => [call.key, (settled[i] as PromiseFulfilledResult<ListeningMcqQuestion[]>).value]));

  const patchModule = (moduleName: ListeningModuleName): ListeningModule => {
    const module = set[moduleName];
    const questionsOf = <T extends { questions: ListeningMcqQuestion[] }>(group: (typeof QUESTION_STIMULUS_GROUPS)[number], stimulus: T, index: number): T => {
      const questions = replaced.get(`${moduleName}/${group}/${index}`);
      return questions ? { ...stimulus, questions } : stimulus;
    };
    return {
      ...module,
      conversations: module.conversations.map((conversation, index) => questionsOf("conversations", conversation, index)),
      announcements: module.announcements.map((announcement, index) => questionsOf("announcements", announcement, index)),
      academicTalks: module.academicTalks.map((talk, index) => questionsOf("academicTalks", talk, index)),
    };
  };

  return {
    ...set,
    router: patchModule("router"),
    lowerModule: patchModule("lowerModule"),
    upperModule: patchModule("upperModule"),
  };
}

// --- Explanation-only rewrite (content-gate findings, items and questions) --------------------

const ExplanationRewritesSchema = z.object({
  explanations: z.array(z.object({ id: z.string().min(1), explanationZh: z.string().min(1) })).min(1),
});

/**
 * What the model is shown for each flagged item: the whole item and, for a question, its Stimulus's
 * transcript. A rewrite asked to describe each option by what it says has to see the options;
 * without them the model can only invent an Explanation, which the gate's length, language and
 * position checks would still accept.
 *
 * These are the fields `listeningVerifyRequest` already sends for the same items, through the same
 * prompt channel the other regenerations use. They go to the model and to the model-call diagnostic
 * tables (ADR 0004), never to the job's `error`.
 */
type ExplanationRewriteTarget =
  | { readonly id: string; readonly reason: string; readonly taskType: "listen_choose"; readonly utterance: string; readonly options: readonly { id: string; text: string }[]; readonly correctOptionId: string; readonly explanationZh: string }
  | { readonly id: string; readonly reason: string; readonly taskType: "conversation" | "announcement" | "academic_talk"; readonly stimulusId: string; readonly stem: string; readonly options: readonly { id: string; text: string }[]; readonly correctOptionId: string; readonly explanationZh: string };

type ExplanationRewriteStimulus = { readonly id: string; readonly taskType: string; readonly transcript: unknown };

/** Resolves every flagged id to its own item content, plus the transcript of each Stimulus a flagged
 * question belongs to (once per Stimulus, not once per question). An id that cannot be resolved is
 * dropped rather than sent context-free — a context-free entry can only produce a fabrication, and
 * the gate re-derives its violations from scratch next round, so dropping defers rather than skips. */
function explanationRewriteTargets(
  set: ListeningSet,
  flagged: ReadonlyMap<string, string>,
): { targets: ExplanationRewriteTarget[]; stimuli: ExplanationRewriteStimulus[] } {
  const targets: ExplanationRewriteTarget[] = [];
  const stimuli = new Map<string, ExplanationRewriteStimulus>();
  for (const moduleName of LISTENING_MODULE_NAMES) {
    const module = set[moduleName];
    for (const item of module.listenChoose) {
      const reason = flagged.get(item.id);
      if (reason === undefined) continue;
      targets.push({
        id: item.id, reason, taskType: "listen_choose", utterance: item.utterance,
        options: item.options, correctOptionId: item.correctOptionId, explanationZh: item.explanationZh,
      });
    }
    const stimulusGroups = [
      ["conversation", module.conversations],
      ["announcement", module.announcements],
      ["academic_talk", module.academicTalks],
    ] as const;
    for (const [taskType, entries] of stimulusGroups) {
      for (const stimulus of entries) {
        for (const question of stimulus.questions) {
          const reason = flagged.get(question.id);
          if (reason === undefined) continue;
          targets.push({
            id: question.id, reason, taskType, stimulusId: stimulus.id, stem: question.stem,
            options: question.options, correctOptionId: question.correctOptionId, explanationZh: question.explanationZh,
          });
          if (!stimuli.has(stimulus.id)) {
            stimuli.set(stimulus.id, { id: stimulus.id, taskType, transcript: stimulus.transcript });
          }
        }
      }
    }
  }
  return { targets, stimuli: [...stimuli.values()] };
}

// One prompt for every reason a rewrite of explanationZh alone can fix: too long, no CJK at all, or
// a position reference. Each item's `reason` says which.
function explanationRewritePrompt(input: {
  targets: readonly ExplanationRewriteTarget[];
  stimuli: readonly ExplanationRewriteStimulus[];
}): string {
  return [
    "/toefl-listening",
    "GENERATE listening",
    "",
    "Rewrite ONLY the 繁體中文 Explanation (錯題解析) of the item(s) below; change no other field.",
    "Return ONLY {\"explanations\":[{\"id\",\"explanationZh\"}, ...]}, exactly one entry per item listed, reusing its own id.",
    "Each entry in `flagged` carries the whole item — its own utterance (Listen-and-Choose) or stem plus its Stimulus's transcript in `stimuli` (Conversation/Announcement/Academic-Talk), every option's text, which option is correct, and the explanation you wrote last time. Ground the rewrite in that text: every claim you make about an option must be checkable against the option's own words and the utterance/transcript.",
    `Each item's own \`reason\` says what was wrong with its current draft. For a length reason, cut real content until it is about ${EXPLANATION_TARGET_CODE_POINTS} 字, keeping the key's own justification plus one short clause per distractor, and stop. For a language reason, rewrite it genuinely in 繁體中文.`,
    // Stated for every reason, so a rewrite for length or language cannot pick up a position
    // reference on the way. The same instruction Reading's rewrite uses; optionQuality.test.ts pins
    // it against the detector.
    `In every explanationZh you write: ${positionReferenceInstruction()}`,
    "",
    "```explanation-rewrite",
    JSON.stringify({ targetZh: EXPLANATION_TARGET_CODE_POINTS, flagged: input.targets, stimuli: input.stimuli }),
    "```",
  ].join("\n");
}

async function rewriteFlaggedExplanationsBatch(
  set: ListeningSet,
  flagged: ReadonlyMap<string, string>,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<Map<string, string>> {
  const { targets, stimuli } = explanationRewriteTargets(set, flagged);
  if (targets.length === 0) return new Map();
  const result = await callGenerationSkillTask({
    run,
    task: { task: "generate", context: "listening" },
    prompt: explanationRewritePrompt({ targets, stimuli }),
    jsonSchema: toProviderJsonSchema(ExplanationRewritesSchema),
    parse: (value) => ExplanationRewritesSchema.parse(value),
    stage: "generating",
    onProgress,
  });
  if (!result.ok) listeningFailure(safeDiagnostic(result.error));
  const requested = new Set(targets.map((target) => target.id));
  return new Map(result.value.explanations.filter((e) => requested.has(e.id)).map((e) => [e.id, e.explanationZh]));
}

async function regenerateFlaggedExplanations(
  set: ListeningSet,
  flagged: ReadonlyMap<string, string>,
  run: SkillTaskRunner,
  onProgress?: OnGenerationProgress,
): Promise<ListeningSet> {
  // The verify loop's admission step has already removed every id a wholesale regeneration replaces
  // this round, so no explanation is rewritten for content about to be discarded.
  if (flagged.size === 0) return set;
  const explanations = await rewriteFlaggedExplanationsBatch(set, flagged, run, onProgress);

  const patchModule = (module: ListeningModule): ListeningModule => ({
    ...module,
    listenChoose: module.listenChoose.map((item) => {
      const explanationZh = explanations.get(item.id);
      return explanationZh === undefined ? item : { ...item, explanationZh };
    }),
    conversations: module.conversations.map((conversation) => ({
      ...conversation,
      questions: conversation.questions.map((question) => {
        const explanationZh = explanations.get(question.id);
        return explanationZh === undefined ? question : { ...question, explanationZh };
      }),
    })),
    announcements: module.announcements.map((announcement) => ({
      ...announcement,
      questions: announcement.questions.map((question) => {
        const explanationZh = explanations.get(question.id);
        return explanationZh === undefined ? question : { ...question, explanationZh };
      }),
    })),
    academicTalks: module.academicTalks.map((talk) => ({
      ...talk,
      questions: talk.questions.map((question) => {
        const explanationZh = explanations.get(question.id);
        return explanationZh === undefined ? question : { ...question, explanationZh };
      }),
    })),
  });

  return {
    ...set,
    router: patchModule(set.router), lowerModule: patchModule(set.lowerModule), upperModule: patchModule(set.upperModule),
  };
}

/**
 * Every Listen-and-Choose item and every Stimulus question in the Set through shuffleMcqOptions — see
 * it for the property this establishes. `rng` defaults to `Math.random`; tests inject a
 * deterministic one.
 */
export function rebalanceListeningOptionOrder(
  set: ListeningSet,
  rng: () => number = Math.random,
  /** Items whose explanation still names an option by position: shuffling them would make it false. */
  keepOrderOf: ReadonlySet<string> = new Set(),
): ListeningSet {
  const shuffle = <Q extends { id: string; options: readonly { id: string; text: string }[]; correctOptionId: string }>(
    question: Q,
  ): Q => (keepOrderOf.has(question.id) ? question : shuffleMcqOptions(question, rng));
  const shuffleModule = (module: ListeningModule): ListeningModule => ({
    ...module,
    listenChoose: module.listenChoose.map(shuffle),
    conversations: module.conversations.map((conversation) => ({ ...conversation, questions: conversation.questions.map(shuffle) })),
    announcements: module.announcements.map((announcement) => ({ ...announcement, questions: announcement.questions.map(shuffle) })),
    academicTalks: module.academicTalks.map((talk) => ({ ...talk, questions: talk.questions.map(shuffle) })),
  });
  return {
    ...set,
    router: shuffleModule(set.router),
    lowerModule: shuffleModule(set.lowerModule),
    upperModule: shuffleModule(set.upperModule),
  };
}

function gateReasonFor(violation: ListeningContentViolation): string {
  if (violation.kind === "word-count") {
    const target = violation.label.includes("/conversation/")
      ? CONVERSATION_WORD_TARGET
      : violation.label.includes("/announcement/")
      ? ANNOUNCEMENT_WORD_TARGET
      : ACADEMIC_TALK_WORD_TARGET;
    return `Your previous transcript was measured at ${violation.actualWords} words, outside its target. Rewrite so the total lands between ${target.min} and ${target.max} words — expand or trim with real content, not filler.`;
  }
  if (violation.kind === "syllable-estimate") {
    return `Your previous utterance ran long (estimated ${violation.actualSyllables} syllables). Rewrite it shorter and more natural — at most about 6 stressed syllables, typically 4 to 8 words.`;
  }
  if (violation.kind === "item-language" || violation.kind === "transcript-language") {
    // `.detail` carries no content, so it is safe in a reason. The model still sees the flagged
    // text: an item or question regeneration prompt includes the whole item, and a whole-Stimulus
    // regeneration does not need the old transcript.
    return `${violation.detail} — rewrite in English.`;
  }
  if (violation.kind === "invalid-answer-key") {
    // `.detail` names option ids only.
    return `${violation.detail} — rewrite it so correctOptionId names one of the option ids you actually wrote.`;
  }
  if (violation.kind === "option-length-bias") {
    // `.detail` names counts, groups and measures only.
    return `${violation.detail}.`;
  }
  // Must not fall through to the ternary below, which would describe it as missing CJK. The rule
  // itself is stated once, in the prompt, by positionReferenceInstruction().
  if (violation.kind === "explanation-position-reference") {
    return `${violation.detail}.`;
  }
  // explanation-length / explanation-language
  return violation.kind === "explanation-length"
    ? `Your previous explanationZh was measured at ${violation.actualLength} 字, past the runaway limit — cut real content until it is about ${EXPLANATION_TARGET_CODE_POINTS} 字.`
    : `Your previous explanationZh contained no CJK character at all — rewrite it genuinely in 繁體中文.`;
}

type ListeningVerdict = z.infer<typeof ListeningVerifierSchema>;

/**
 * Listening's half of the shared verify loop (generationVerifyLoop.ts): which finding goes to which
 * regeneration. The loop owns the round budget, the guard around each remediation, admission,
 * dispatch order and the exhaustion message.
 *
 * Each finding, from the content gate or the Verifier, goes to the narrowest regeneration that can
 * fix it:
 *   - a whole Listen and Choose a Response item -> regenerateFlaggedLcrItems. Sources: a Verifier
 *     "issue" or "quality" verdict; the gate's syllable-estimate; the gate's item-language,
 *     invalid-answer-key and option-length-bias when the id names such an item.
 *   - a whole Stimulus (transcript and questions) -> regenerateFlaggedStimuli. Sources: a Verifier
 *     "unanswerable" verdict; a Verifier "register" verdict on an Academic Talk; the gate's
 *     word-count and transcript-language.
 *   - one question -> regenerateRejectedListeningQuestions. Sources: a Verifier "issue" or
 *     "quality" verdict; the gate's item-language, invalid-answer-key and option-length-bias when the
 *     id names a question.
 *   - explanationZh alone -> regenerateFlaggedExplanations. Sources: the gate's explanation-length,
 *     explanation-language and explanation-position-reference. The Verifier has no explanation-only
 *     verdict: an unfaithful explanation is an "issue", which replaces the whole item or question.
 * An id flagged by several sources in one round gets one call with every reason merged (addReason).
 * A "quality" verdict buys one regeneration and is then accepted with a note, and so is a "register"
 * verdict once the repair rounds run out; everything else still outstanding on the final round fails
 * the job unless its tier degrades.
 */
function listeningVerifyPolicy(input: {
  run: SkillTaskRunner;
  onProgress: OnGenerationProgress | undefined;
}): VerifyPolicy<ListeningSet, ListeningContentViolation, ListeningVerdict, SafeDiagnostic> {
  const { run, onProgress } = input;
  // How surviving register findings reach the published Set. The loop's `finish(set, violations)`
  // carries content-gate violations only, and widening that shared interface for a Listening-only
  // verdict would teach the loop about a check one section has. So planRound writes down what it
  // decided, and `finish`, which the loop calls only after planRound in the same round, reads it.
  //
  // Safe because the policy is built per verifyListeningSet call, and planRound assigns this every
  // round (empty while repair rounds remain), so it never holds a finding a later round repaired.
  let survivingRegisterPositions: readonly number[] = [];
  // The "quality" verdict's one repair, tracked across rounds as in Reading: the content an Item was
  // first flagged at, and the Items accepted with an unrepaired finding (id -> the Task Type the
  // note names).
  const qualityFlaggedAt = new Map<string, string>();
  const acceptedQuality = new Map<string, string>();
  return {
    logPrefix: "[listeningGenerator]",
    // Every fragment the loop assembles into a thrown message is minted here, from ids, kind labels
    // and counts.
    diagnostic: safeDiagnostic,
    preflight: (set) => deterministicListeningPreChecks(set),
    violations: (set) => listeningContentViolations(set),
    isBlocking: (violation) => LISTENING_GATE.isFatal(violation.kind),
    isAdvisory: (violation) => LISTENING_GATE.isAdvisory(violation.kind),
    isDegradable: (violation) => LISTENING_GATE.degrades(violation.kind),
    formatViolations: (violations) => formatListeningViolations(violations),
    describeGateFailure: (violations) =>
      safeDiagnostic(`set validation failed: listening content gate found ${violations.length} violation(s): ${formatListeningViolations(violations)}`),
    units: (set) => listeningVerifyUnits(set),
    emptyVerdict: { listenChooseItems: [], stimuli: [], questions: [] },
    verify: (set, pending) => {
      const { prompt, sent } = listeningVerifyRequest(set, pending);
      return {
        task: { task: "verify", context: "listening" },
        prompt,
        jsonSchema: toProviderJsonSchema(ListeningVerifierSchema),
        parse: (value) => {
          const verdict = ListeningVerifierSchema.parse(value);
          assertVerdictCoverage("listenChooseItems", sent.listenChooseItems, verdict.listenChooseItems.map((entry) => entry.id));
          assertVerdictCoverage("stimuli", sent.stimuli, verdict.stimuli.map((entry) => entry.id));
          assertVerdictCoverage("questions", sent.questions, verdict.questions.map((entry) => entry.id));
          return verdict;
        },
      };
    },
    planRound: ({ attempt, isFinalRound, set, violations, verdict, units }) => {
      // Route each content-gate violation to its regeneration grain. The Listen and Choose a
      // Response ids tell an item-grain kind on such an item apart from the same kind on a question.
      const lcrItemIds = new Set(LISTENING_MODULE_NAMES.flatMap((m) => set[m].listenChoose.map((i) => i.id)));
      const lcrFromGate = new Map<string, string>();
      const stimulusFromGate = new Map<string, string>();
      const questionFromGate = new Map<string, string>();
      const explanationFromGate = new Map<string, string>();
      for (const violation of violations) {
        // Fatal, so the loop has already thrown before planRound if it is present. Skipped
        // explicitly because gateReasonFor has no branch for it.
        if (violation.kind === "composition") continue;
        // An `advisory` kind has no remediation route; regenerating for one would pay for a finding
        // that publishes anyway. Kinds that are repaired and only end in advisory are not skipped.
        if (LISTENING_GATE.isAdvisory(violation.kind)) continue;
        const reason = gateReasonFor(violation);
        if (violation.kind === "syllable-estimate") addReason(lcrFromGate, violation.id, reason);
        // These three are fixed at whichever grain the id names: the whole Listen and Choose a
        // Response item, or the one question.
        else if (violation.kind === "item-language" || violation.kind === "invalid-answer-key" || violation.kind === "option-length-bias") addReason(lcrItemIds.has(violation.id) ? lcrFromGate : questionFromGate, violation.id, reason);
        else if (violation.kind === "word-count" || violation.kind === "transcript-language") addReason(stimulusFromGate, violation.id, reason);
        else addReason(explanationFromGate, violation.id, reason);
      }

      const lcrIssues = verdict.listenChooseItems.filter(
        (item): item is { id: string; verdict: "issue"; reason: string } => item.verdict === "issue",
      );
      const unanswerable = verdict.stimuli.filter(
        (item): item is { id: string; verdict: "unanswerable"; reason: string } => item.verdict === "unanswerable",
      );
      const questionIssues = verdict.questions.filter(
        (item): item is { id: string; verdict: "issue"; reason: string } => item.verdict === "issue",
      );

      // "quality": repaired, then accepted with a note, as in Reading. Accepted once its content has
      // changed since it was first flagged, or at once on the final round. An accepted Item counts as
      // passed for carry-forward.
      const stimulusById = new Map(listeningStimuli(set).map((stimulus) => [stimulus.id, stimulus]));
      const stimulusOfQuestion = new Map(
        [...stimulusById.values()].flatMap((stimulus) => stimulus.questions.map((q) => [q.id, stimulus] as const)),
      );
      const itemFingerprint = (id: string): string => {
        const stimulus = stimulusOfQuestion.get(id);
        if (!stimulus) return units.get(lcrUnit(id)) ?? "";
        return JSON.stringify([stimulus.transcript, stimulus.questions.find((q) => q.id === id)]);
      };
      const lcrQualityRepairs: { id: string; reason: string }[] = [];
      const questionQualityRepairs: { id: string; reason: string }[] = [];
      const settled = new Set<string>();
      for (const item of [...verdict.listenChooseItems, ...verdict.questions]) {
        if (item.verdict === "ok") {
          acceptedQuality.delete(item.id);
          settled.add(item.id);
        } else if (item.verdict === "issue") {
          acceptedQuality.delete(item.id);
        } else {
          const fingerprint = itemFingerprint(item.id);
          const flaggedAt = qualityFlaggedAt.get(item.id);
          if (isFinalRound || (flaggedAt !== undefined && flaggedAt !== fingerprint)) {
            acceptedQuality.set(item.id, stimulusOfQuestion.get(item.id)?.taskType ?? "listen_choose");
            settled.add(item.id);
          } else {
            qualityFlaggedAt.set(item.id, fingerprint);
            (stimulusOfQuestion.has(item.id) ? questionQualityRepairs : lcrQualityRepairs)
              .push({ id: item.id, reason: item.reason });
          }
        }
      }
      // "register": an Academic Talk whose language is below the task type's level.
      //
      // The Set's Academic Talks by global position (router, then lower, then upper). The map says
      // both whether an id is an Academic Talk and which position a surviving finding's note names.
      const academicTalkPositions = new Map<string, number>(
        LISTENING_MODULE_NAMES
          .flatMap((moduleName) => set[moduleName].academicTalks)
          .map((talk, position) => [talk.id, position] as const),
      );
      // A "register" verdict counts only on an Academic Talk id. The prompt says so, but the schema
      // cannot enforce it, and a stray verdict on a Conversation or Announcement would otherwise buy
      // whole-Stimulus regenerations of a clean Stimulus and hold back that Stimulus's cheaper
      // repairs. A dropped verdict is not counted, not regenerated, and logged as ids only.
      const registerOnTalks: { readonly finding: { id: string; reason: string }; readonly position: number }[] = [];
      const registerOffTalks: string[] = [];
      for (const finding of verdict.stimuli) {
        if (finding.verdict !== "register") continue;
        const position = academicTalkPositions.get(finding.id);
        if (position === undefined) registerOffTalks.push(finding.id);
        else registerOnTalks.push({ finding, position });
      }
      if (registerOffTalks.length > 0) {
        // Ids and counts only: `.reason` may quote the transcript (see summarizeFlaggedIds).
        console.warn(
          `[listeningGenerator] verify attempt ${attempt}/${MAX_VERIFY_ATTEMPTS}: dropping `
            + `${registerOffTalks.length} "register" verdict(s) on non-Academic-Talk stimulus/stimuli: `
            + registerOffTalks.join(", "),
        );
      }

      // What this round passed: every settled Listen-and-Choose item, and every Stimulus whose own
      // verdict and every question's verdict were settled. A "register" verdict on a non-talk was
      // dropped above, so it does not hold its Stimulus back.
      const passed: string[] = verdict.listenChooseItems
        .filter((item) => settled.has(item.id))
        .map((item) => lcrUnit(item.id));
      for (const entry of verdict.stimuli) {
        const stimulusSettled = entry.verdict === "ok" || (entry.verdict === "register" && registerOffTalks.includes(entry.id));
        const questions = stimulusById.get(entry.id)?.questions ?? [];
        if (stimulusSettled && questions.every((question) => settled.has(question.id))) passed.push(stimulusUnit(entry.id));
      }

      const lcrWholesale = new Map(lcrFromGate);
      for (const item of lcrIssues) addReason(lcrWholesale, item.id, item.reason);
      for (const item of lcrQualityRepairs) addReason(lcrWholesale, item.id, item.reason);
      const stimulusWholesale = new Map(stimulusFromGate);
      for (const item of unanswerable) addReason(stimulusWholesale, item.id, item.reason);
      // A register finding gets the same remediation as any whole-transcript defect: a fresh talk and
      // questions, with the Verifier's reason in the prompt.
      for (const { finding } of registerOnTalks) addReason(stimulusWholesale, finding.id, finding.reason);
      const questionWholesale = new Map(questionFromGate);
      for (const item of questionIssues) addReason(questionWholesale, item.id, item.reason);
      for (const item of questionQualityRepairs) addReason(questionWholesale, item.id, item.reason);

      // A whole-Stimulus regeneration replaces all of that Stimulus's questions, so it claims their
      // ids too, and the loop admits the question and explanation remediations against them.
      const questionIdsByStimulusId = new Map<string, readonly string[]>(
        LISTENING_MODULE_NAMES.flatMap((moduleName) => [
          ...set[moduleName].conversations,
          ...set[moduleName].announcements,
          ...set[moduleName].academicTalks,
        ]).map((entry) => [entry.id, entry.questions.map((question) => question.id)]),
      );

      // The register tier, repair-then-accept ending in advisory (ADR 0006), in the one seam the
      // loop gives a policy for a Verifier finding: `verdictFindings` counted on a repair round buys
      // another round, and counted on the final round fails the job. A talk in plain vocabulary is
      // usable and teaches nothing wrong, so it is counted only while repair rounds remain, and the
      // Set then publishes. Read `isFinalRound` from the loop rather than recomputing it from
      // MAX_VERIFY_ATTEMPTS, so the two cannot disagree.
      const registerBlocksThisRound = !isFinalRound;
      // What publishes is recorded. Assigned every round, so a finding repaired in an earlier round
      // leaves nothing behind.
      survivingRegisterPositions = registerBlocksThisRound
        ? []
        : registerOnTalks.map(({ position }) => position);
      if (!registerBlocksThisRound && registerOnTalks.length > 0) {
        // The operator's counterpart of the loop's own "publishing with N unrepaired advisory
        // violation(s)" warning, which sees content-gate violations only. It names ids, which an
        // operator can act on; the User's advisory note names positions. Never the reason.
        console.warn(
          `[listeningGenerator] publishing with ${registerOnTalks.length} Academic Talk(s) still below `
            + `the task's register after ${MAX_VERIFY_ATTEMPTS} verify attempts: `
            + registerOnTalks.map(({ finding }) => finding.id).join(", "),
        );
      }

      return {
        verdictFindings: lcrIssues.length + unanswerable.length + questionIssues.length
          + lcrQualityRepairs.length + questionQualityRepairs.length
          + (registerBlocksThisRound ? registerOnTalks.length : 0),
        passed,
        remediations: [
          // Wave 1: the two coarsest grains. They share a wave because an item id and a Stimulus id
          // are different populations; neither can moot the other.
          [
            VerifyRemediation.declare({
              category: "LCR item",
              pass: "wholesale",
              targets: lcrWholesale,
              apply: (current, targets) => regenerateFlaggedLcrItems(current, targets, run, onProgress),
            }),
            VerifyRemediation.declare({
              category: "stimulus",
              pass: "wholesale",
              targets: stimulusWholesale,
              claims: (stimulusId) => {
                const questionIds = questionIdsByStimulusId.get(stimulusId);
                return questionIds ? [stimulusId, ...questionIds] : [stimulusId];
              },
              apply: (current, targets) => regenerateFlaggedStimuli(current, targets, run, onProgress),
            }),
          ],
          // Wave 2: admitted against Wave 1's claims, so a question whose Stimulus is being
          // regenerated this round is not regenerated a second time.
          [
            VerifyRemediation.declare({
              category: "question",
              pass: "wholesale",
              targets: questionWholesale,
              apply: (current, targets) => regenerateRejectedListeningQuestions(current, targets, run, onProgress),
            }),
          ],
          // Wave 3: explanation-only rewrites, admitted against everything above, because each
          // remediation above writes new explanations itself. The loop dispatches every
          // `explanation` pass before every `wholesale` one.
          [
            VerifyRemediation.declare({
              category: "explanation",
              pass: "explanation",
              targets: explanationFromGate,
              apply: (current, targets) => regenerateFlaggedExplanations(current, targets, run, onProgress),
            }),
          ],
        ],
        // Ids only, never `.reason`, which may quote the transcript (see summarizeFlaggedIds).
        exhaustionParts: [
          ...(lcrIssues.length > 0 ? [summarizeFlaggedIds("Listen-and-Choose item(s) with issues", lcrIssues.map((i) => i.id))] : []),
          ...(unanswerable.length > 0 ? [summarizeFlaggedIds("unanswerable stimulus/stimuli", unanswerable.map((i) => i.id))] : []),
          ...(questionIssues.length > 0 ? [summarizeFlaggedIds("question(s) with issues", questionIssues.map((i) => i.id))] : []),
        ],
      };
    },
    describeExhaustion: ({ parts }) =>
      safeDiagnostic(`set validation failed: listening set still has unresolved issues after ${MAX_VERIFY_ATTEMPTS} verify attempts: `)
        + safeDiagnostic(parts.join(" | ")),
    finish: (set, violations) =>
      finishListeningSet(set, violations, survivingRegisterPositions, [...acceptedQuality.values()]),
  };
}

export async function verifyListeningSet(
  set: ListeningSet,
  run: SkillTaskRunner,
  onProgress: OnGenerationProgress | undefined,
  setId: string,
): Promise<ListeningSet> {
  return runVerifyLoop({
    set,
    policy: listeningVerifyPolicy({ run, onProgress }),
    run,
    onProgress,
    setId,
  });
}

// ---------------------------------------------------------------------------
// The candidate adapter
// ---------------------------------------------------------------------------

/**
 * The two ways a Listening candidate is rejected. `item-ids` is a duplicate or malformed Item id,
 * or a Stimulus id that clashes with another clip's (listeningClipIdProblem), from the generate
 * call: drift from one probabilistic call, so it consumes the attempt and retries rather than ending
 * the run. It carries no prompt hint.
 */
type ListeningRejection =
  | {
      /** The Upper Module reads no harder than the Lower; the next prompt carries the retry hint. */
      readonly rejection: "difficulty";
      readonly hint: true;
      readonly detail: string;
    }
  | {
      readonly rejection: "item-ids";
      readonly hint?: undefined;
      readonly message: string;
    };

/**
 * Listening's contribution to the shared candidate loop. The GENERATE call's output already IS the
 * final candidate shape, so `prepare` only overwrites every Speaker's rendering fields
 * (assignSpeakerRendering, synchronous, no provider call) and checks Item and Stimulus ids.
 */
export function listeningCandidateAdapter(
  plan: GenerationPlan,
): CandidateAdapter<ListeningGenerationInput, ListeningGenerationInput, ListeningRejection> {
  if (plan.kind !== "listening") {
    listeningFailure(safeDiagnostic("set validation failed: generation kind mismatch"));
  }
  const listeningPlan = plan;
  return {
    task: { task: "generate", context: "listening" },
    jsonSchema: toProviderJsonSchema(ListeningGenerationInputSchema),
    parseResponse: (value) => ListeningGenerationInputSchema.parse(value),
    parseCandidate: (value) =>
      ListeningGenerationInputSchema.parse({
        ...(value as object),
        id: "pending-candidate",
        source: "generated",
        createdAt: "1970-01-01T00:00:00.000Z",
      }),
    prompt: (hints) => listeningGenerationPrompt(listeningPlan, hints.difficulty ?? false),
    prepare: async ({ raw, ctx }) => {
      const candidate = assignSpeakerRendering(raw);
      let message: string | undefined;
      try {
        validateItemIds(candidate);
        // Stimulus ids too: each names a clip file, as a Listen and Choose a Response item's id
        // does, and two Stimuli sharing one would be verified as one unit. Checked here so a clash
        // costs this attempt rather than a Set's whole verify budget before the render refuses it.
        const clipIdProblem = listeningClipIdProblem(candidate);
        if (clipIdProblem) message = `set validation failed: ${clipIdProblem}`;
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      if (message !== undefined) {
        console.error(`[generator] listening candidate attempt ${ctx.attempt}/${ctx.attemptBudget} rejected (item-id validation): ${message}`);
        return { rejected: { rejection: "item-ids", message } };
      }
      return { candidate };
    },
    // The one property still worth a regeneration: the Upper Module must read harder than the Lower.
    decide: ({ candidate, ctx }) => {
      const difficulty = compareListeningModuleDifficulty(candidate);
      // A blocking finding rejects the candidate; the candidate loop regenerates while its budget
      // lasts, and the job fails when it runs out.
      if (!difficulty.upperIsHarder && blocksGeneration({ family: "module-difficulty", section: "listening" })) {
        const detail = moduleDifficultyDetail(difficulty);
        console.error(
          `[generator] listening candidate attempt ${ctx.attempt}/${ctx.attemptBudget} rejected: ${detail}`,
        );
        return { rejected: { rejection: "difficulty", hint: true, detail } };
      }
      const accepted: PlannedCandidate = { kind: "listening", candidate, plan: listeningPlan };
      return { accepted };
    },
    // Named by the attempt that spent the budget.
    describeExhaustion: ({ attempts, newest }) =>
      newest.rejection === "difficulty"
        ? `set validation failed: upper module is not harder than lower module after ${attempts} attempts\n${newest.detail}`
        : `generated content failed item-id validation on every attempt: ${newest.message}`,
  };
}
