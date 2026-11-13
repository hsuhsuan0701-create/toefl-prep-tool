import { z } from "zod";
import {
  ACADEMIC_TALK_QUESTIONS_PER_STIMULUS,
  ANNOUNCEMENT_QUESTIONS_PER_STIMULUS,
  CONVERSATION_QUESTIONS_PER_STIMULUS,
  listeningPlanEntryCount,
} from "./listening.js";
import { ListeningTaskType, ReadingTaskType, SpeakingWritingTaskType } from "./primitives.js";

// Scoring: what the Judges, the Arbiter and Ears return, the score request every Task Type posts,
// and the markers a Speaking Simulation's missing Items are scored with.

const DeductionCategory = z.enum([
  "grammar", "vocab", "elaboration", "register", "coherence",
  "pronunciation-proxy", "content", "completeness",
]);

const halfStep05 = z.number().min(0).max(5).multipleOf(0.5);

const DeductionSchema = z.object({
  quote: z.string(), issue: z.string(), fix: z.string(), category: DeductionCategory,
});

export const JudgeReportSchema = z.object({
  judge: z.enum(["gemini", "openai"]),
  taskType: SpeakingWritingTaskType,
  items: z.array(z.object({
    itemId: z.string(),
    score: halfStep05,
    dimensions: z.array(z.object({ name: z.string(), score: halfStep05, evidence: z.string() })),
    deductions: z.array(DeductionSchema),
  })).min(1),
});
export type JudgeReport = z.infer<typeof JudgeReportSchema>;

export const ScoreReportSchema = z.object({
  taskType: SpeakingWritingTaskType,
  items: z.array(z.object({
    itemId: z.string(),
    ownScore: halfStep05,
    finalScore: halfStep05,
    maxScore: z.literal(5),
    dimensions: z.array(z.object({ name: z.string(), note: z.string() })),
    deductions: z.array(DeductionSchema),
    reconciliationNote: z.string(),
    feedbackZh: z.string(),
    modelRewrite: z.string().optional(),
    singleJudge: z.boolean().optional(),
    lowConfidence: z.boolean().optional(),
    selfArbitrated: z.boolean().optional(),
  })).min(1),
});
export type ScoreReport = z.infer<typeof ScoreReportSchema>;

/**
 * The `selectedOptionId` a client sends for a multiple-choice question left unanswered. The server
 * scores it incorrect whatever the question's options are, as the exam scores an unanswered
 * question, and a review shows it as unanswered rather than as a wrong choice.
 */
export const MCQ_UNANSWERED_SENTINEL = "__none__";

export const ScoreRequestSchema = z.discriminatedUnion("taskType", [
  z.object({
    taskType: z.literal("build_sentence"),
    items: z.array(z.object({ itemId: z.string(), tileOrder: z.array(z.string()) })).min(1).max(10),
  }),
  z.object({
    taskType: z.literal("email"),
    items: z.array(z.object({ itemId: z.string(), text: z.string(), secondsUsed: z.number().min(0) })).length(1),
  }),
  z.object({
    taskType: z.literal("discussion"),
    items: z.array(z.object({ itemId: z.string(), text: z.string(), secondsUsed: z.number().min(0) })).length(1),
  }),
  z.object({
    taskType: z.literal("listen_repeat"),
    items: z.array(z.object({ itemId: z.string() })).min(1).max(7),
  }),
  z.object({
    taskType: z.literal("interview"),
    items: z.array(z.object({ itemId: z.string() })).min(1).max(4),
  }),
  // Reading and Listening are scored from the key. Listening's bounds are the Set-wide count of
  // scoreable ids for the shape, derived from LISTENING_MODULE_COMPOSITION and the per-Stimulus
  // question counts, so retuning the composition cannot leave a full submission over its cap.
  z.object({
    taskType: z.literal("complete_words"),
    items: z.array(z.object({ itemId: z.string(), typed: z.string() })).min(1).max(30),
  }),
  z.object({
    taskType: z.literal("daily_life"),
    items: z.array(z.object({ itemId: z.string(), selectedOptionId: z.string() })).min(1).max(20),
  }),
  z.object({
    taskType: z.literal("academic_passage"),
    items: z.array(z.object({ itemId: z.string(), selectedOptionId: z.string() })).min(1).max(20),
  }),
  z.object({
    taskType: z.literal("listen_choose"),
    items: z.array(z.object({ itemId: z.string(), selectedOptionId: z.string() })).min(1).max(listeningPlanEntryCount("listenChoose")),
  }),
  z.object({
    taskType: z.literal("conversation"),
    items: z.array(z.object({ itemId: z.string(), selectedOptionId: z.string() }))
      .min(1).max(listeningPlanEntryCount("conversations") * CONVERSATION_QUESTIONS_PER_STIMULUS),
  }),
  z.object({
    taskType: z.literal("announcement"),
    items: z.array(z.object({ itemId: z.string(), selectedOptionId: z.string() }))
      .min(1).max(listeningPlanEntryCount("announcements") * ANNOUNCEMENT_QUESTIONS_PER_STIMULUS),
  }),
  z.object({
    taskType: z.literal("academic_talk"),
    items: z.array(z.object({ itemId: z.string(), selectedOptionId: z.string() }))
      .min(1).max(listeningPlanEntryCount("academicTalks") * ACADEMIC_TALK_QUESTIONS_PER_STIMULUS),
  }),
]);
export type ScoreRequest = z.infer<typeof ScoreRequestSchema>;

/** The score request of a Task Type scored from the key alone: every Reading and Listening one. */
export type DeterministicScoreRequest = Extract<
  ScoreRequest,
  { taskType: z.infer<typeof ReadingTaskType> | z.infer<typeof ListeningTaskType> }
>;

export const DeliveryReportSchema = z.object({
  // Ears' estimate, which scoreItems.ts replaces for an Interview Response whose clip it can probe
  // with window-time WPM: transcript words over the whole clip's duration, pauses and edge silence
  // included (a truer rate would divide by speaking time only). Null for a clip under 2 s
  // (MIN_PACE_DURATION_SEC there), too short for a meaningful rate.
  paceWpm: z.number().nullable(),
  pauses: z.string(),
  intelligibility: z.string(),
  suspectedMispronunciations: z.array(z.string()),
  intonation: z.string(),
});
export type DeliveryReport = z.infer<typeof DeliveryReportSchema>;

export const EarsResultSchema = z.object({
  transcript: z.string(),
  deliveryReport: DeliveryReportSchema,
});
export type EarsResult = z.infer<typeof EarsResultSchema>;

// ---------------------------------------------------------------------------------------------
// An essay with no words (docs/adr/0018).
//
// The boundary is whitespace: an Email or Academic Discussion Response that is empty once its
// whitespace is trimmed has no words, scores a deterministic 0 and never reaches a Judge, the written
// counterpart of a recording with no speech. Anything else, a single word or a lone punctuation mark
// included, is an essay and goes to the Judges, who score how little it says. The server's scoring
// and the editor's "hand in an empty essay?" question both read this one rule.
// ---------------------------------------------------------------------------------------------
export function essayHasNoWords(text: string): boolean {
  return text.trim() === "";
}

// ---------------------------------------------------------------------------------------------
// A deliberately skipped Speaking Simulation Item.
//
// An Item the User never recorded in a Simulation scores a deterministic 0, as an unanswered item does
// on the real test; no Judge is called. A marker rather than a Score Report with finalScore 0, so the
// review and the band disclosure can say "0 because nothing was recorded", not "0 because it was
// judged badly". A recording that was made but whose upload or scoring failed is a different state
// (scoring_status 'failed', an `{ error }` score_json) that leaves the Attempt without a Band Estimate
// (docs/adr/0010); speakingFinalization.ts classifies the two.
// ---------------------------------------------------------------------------------------------
export const SKIPPED_ITEM_REASON =
  "No recording was made for this item, so it scores 0 — the same as leaving a question unanswered on the real test.";

const SkippedItemScoreJsonSchema = z.object({
  // A literal rather than a boolean: the marker must be unmistakable in a column that also holds
  // Score Reports and `{ error }` failure notes, and `skipped: false` has no meaning worth storing.
  skipped: z.literal(true),
  reason: z.string(),
});
export type SkippedItemScoreJson = z.infer<typeof SkippedItemScoreJsonSchema>;

/**
 * Is this parsed `item_results.score_json` value the deliberate-skip marker?
 *
 * Takes an already-parsed value (not a JSON string) because both call sites already hold one: the
 * server parses the DB column, the client receives `scoreJson` pre-parsed in the view model.
 */
export function isSkippedItemScoreJson(v: unknown): v is SkippedItemScoreJson {
  return SkippedItemScoreJsonSchema.safeParse(v).success;
}

/**
 * The `error` written on a Speaking Item whose recording never reached the server (speakingFinalization,
 * at capture-finished). Shared because the band rule counts such Items apart from scoring failures —
 * nothing can re-score them — and the review explains them in those terms.
 */
export const NOT_CAPTURED_ITEM_ERROR = "recording upload did not arrive";

/** Is this parsed `item_results.score_json` value the never-captured marker? */
export function isNotCapturedItemScoreJson(v: unknown): boolean {
  return typeof v === "object" && v !== null && (v as { error?: unknown }).error === NOT_CAPTURED_ITEM_ERROR;
}

/**
 * Body of POST /api/attempts/:id/capture-finished. Every field is optional and the body may be absent:
 * the expected Item list always comes from the immutable Set.
 *
 * `uploadFailedItemIds` are Items this browser recorded but could not land on the server, the one
 * thing the server cannot observe for itself. Advisory: naming an id can only move that Item from
 * "skipped, scored 0" to "never captured", which leaves the Attempt without a Band Estimate, and an
 * unknown id is ignored. Bounded so one request cannot become unbounded work (a Speaking Set has 11
 * Items).
 */
export const CaptureFinishedRequestSchema = z.object({
  uploadFailedItemIds: z.array(z.string().max(200)).max(64).optional(),
});
