import { z } from "zod";
import { advisoryNotes } from "./advisoryNotes.js";
import { McqOptionSchema, mcqQuestionSchema } from "./multipleChoice.js";
import {
  boundedPlanText,
  boundedRequiredConcepts,
  distinctions,
  GenerationDomainFamilySchema,
  maxSupportableRequiredConcepts,
  noveltyKey,
  requiredConcepts,
} from "./planFields.js";
import { base, SafeIdSchema } from "./primitives.js";

// Listening: module composition and time limits, the Plan, the Set as persisted and the shape
// generation is shown.

export const ListeningSkillCategory = z.enum(["gist", "detail", "inference", "function", "attitude"]);

// The word range the Listening generation guide gives a Listen and Choose a Response utterance
// (typically 4 to 8 words, one clause): the input LISTENING_LCR_REQUIRED_CONCEPTS is derived from, not
// a gate. listeningGenerator.ts gates the utterance on an estimated syllable count instead.
export const LCR_UTTERANCE_DESIGN_WORD_RANGE = { min: 4, max: 8 } as const;

// Listen and Choose a Response's bound. The default 2–5 cannot be met by a 4–8-word utterance:
// maxSupportableRequiredConcepts gives 1 at 4 words and 2 at 8, hence 1–2. Conversation (80–150
// words), Announcement (40–85) and Academic Talk (175–250) keep the default; even 40 words supports 10.
const LISTENING_LCR_REQUIRED_CONCEPTS = boundedRequiredConcepts(
  maxSupportableRequiredConcepts(LCR_UTTERANCE_DESIGN_WORD_RANGE.min),
  maxSupportableRequiredConcepts(LCR_UTTERANCE_DESIGN_WORD_RANGE.max),
);

// How many Stimuli of each shape each Listening module holds. The generation plan lengths
// (listeningPlanEntryCount), the generation input schema and ScoreRequestSchema's bounds all read it.
// Like Reading's, it binds generation only (docs/adr/0005).
export const LISTENING_MODULE_COMPOSITION = {
  router: { listenChoose: 10, conversations: 3, announcements: 3, academicTalks: 1 },
  lowerModule: { listenChoose: 5, conversations: 2, announcements: 2, academicTalks: 0 },
  upperModule: { listenChoose: 5, conversations: 2, announcements: 0, academicTalks: 3 },
} as const;

// ETS's Listening module time limits, in seconds (18, 7 and 11 minutes). They bind only the generation
// input schema: the persisted ListeningModuleSchema accepts any positive integer, because narrowing a
// Set schema makes Sets on disk that disagree unloadable. A constant of its own because
// LISTENING_MODULE_COMPOSITION's values are summed across modules. A Listening module has no clock (its
// audio paces it); the Simulation intro reads the served budgets only to say how long the section takes.
export const LISTENING_MODULE_TIME_LIMITS_SEC = {
  router: 1080,      // 18 min
  lowerModule: 420,   // 7 min
  upperModule: 660,   // 11 min
} as const;

// A shape's Stimulus count summed over the three modules: the length of that shape's plan array and,
// with the per-Stimulus question counts, the bound on a score request.
export function listeningPlanEntryCount(
  shape: keyof (typeof LISTENING_MODULE_COMPOSITION)["router"],
): number {
  return LISTENING_MODULE_COMPOSITION.router[shape]
    + LISTENING_MODULE_COMPOSITION.lowerModule[shape]
    + LISTENING_MODULE_COMPOSITION.upperModule[shape];
}

// The same component fields as Reading's, extended per Task Type with the axes its novelty turns on.
// Plan entries are persisted in published Sets, so a required field added later would make every
// banked Listening Set unloadable.
const ListeningComponentPlanSchema = z.object({
  domain: GenerationDomainFamilySchema,
  noveltyKey,
  requiredConcepts,
  distinguishesFrom: distinctions,
});
const LcrPlanEntrySchema = ListeningComponentPlanSchema.extend({
  topic: boundedPlanText,
  speakerRole: boundedPlanText,           // "barista", "coworker" — one speaker per LCR item
  // Narrower than the default: see LISTENING_LCR_REQUIRED_CONCEPTS.
  requiredConcepts: LISTENING_LCR_REQUIRED_CONCEPTS,
});
const ConversationPlanEntrySchema = ListeningComponentPlanSchema.extend({
  setting: boundedPlanText,
  speakerRoles: z.tuple([boundedPlanText, boundedPlanText]), // one per speaker — a conversation has 2
});
const AnnouncementPlanEntrySchema = ListeningComponentPlanSchema.extend({
  setting: boundedPlanText,
  speakerRole: boundedPlanText,
});
const AcademicTalkPlanEntrySchema = ListeningComponentPlanSchema.extend({
  discipline: boundedPlanText,
  speakerRole: boundedPlanText,           // e.g. "professor" — discipline is the topic axis, this is who
});
// The plan a published Listening Set carries, its array lengths unpinned for the same reason as
// PublishedReadingGenerationPlanSchema's: retuning LISTENING_MODULE_COMPOSITION must not make the
// banked Sets unloadable and take every past Listening Attempt's review with them.
const PublishedListeningGenerationPlanSchema = z.object({
  version: z.literal("cross-set-diversity-v1"),
  kind: z.literal("listening"),
  listenChoose: z.array(LcrPlanEntrySchema),
  conversations: z.array(ConversationPlanEntrySchema),
  announcements: z.array(AnnouncementPlanEntrySchema),
  academicTalks: z.array(AcademicTalkPlanEntrySchema),
});

// The plan a fresh Plan call is shown and parsed against (generationPlanner.ts): the published shape,
// with array lengths derived from LISTENING_MODULE_COMPOSITION.
export const ListeningGenerationPlanSchema = PublishedListeningGenerationPlanSchema.extend({
  listenChoose: z.array(LcrPlanEntrySchema).length(listeningPlanEntryCount("listenChoose")),
  conversations: z.array(ConversationPlanEntrySchema).length(listeningPlanEntryCount("conversations")),
  announcements: z.array(AnnouncementPlanEntrySchema).length(listeningPlanEntryCount("announcements")),
  academicTalks: z.array(AcademicTalkPlanEntrySchema).length(listeningPlanEntryCount("academicTalks")),
});

export type ListeningGenerationPlan =
  z.infer<typeof ListeningGenerationPlanSchema>;

// The three accent regions ETS's 2026 documents give for Listening speakers: North America, the United
// Kingdom and Australia (Technical Manual RR-25-12 §II-4; Test Specifications 2026 p. 10). Speaking's
// draw uses the same three; SpeakingAccentSchema keeps a fourth only to read banked Sets. Sourcing:
// docs/research/2026-08-23-listen-and-repeat-speech-rate.md §4.4.
const ListeningAccentSchema = z.enum(["north-american", "british", "australian"]);
export type ListeningAccent = z.infer<typeof ListeningAccentSchema>;

// A Listening speaker, shown as an avatar card keyed on role, gender and accent (no generated image).
// `voice` and `provider` record how the clip was rendered and are stripped before serving.
const SpeakerSchema = z.object({
  id: SafeIdSchema,
  role: z.string(),                          // "professor", "librarian" — avatar card label
  gender: z.enum(["male", "female"]),
  accent: ListeningAccentSchema,             // kept — avatar flavor, not an answer
  voice: z.string(),                         // TTS voice id — stripped (render provenance)
  provider: z.enum(["openai", "gemini"]),    // stripped (provenance; never score-bearing)
});
export type Speaker = z.infer<typeof SpeakerSchema>;

const ListeningMcqQuestionSchema = mcqQuestionSchema(ListeningSkillCategory);

// Questions per Stimulus: read by the Stimulus schemas below and by ScoreRequestSchema's bounds
// (scoring.ts).
export const CONVERSATION_QUESTIONS_PER_STIMULUS = 2;
export const ANNOUNCEMENT_QUESTIONS_PER_STIMULUS = 2;
export const ACADEMIC_TALK_QUESTIONS_PER_STIMULUS = 4;

const ListenChooseItemSchema = z.object({
  id: SafeIdSchema, taskType: z.literal("listen_choose"),
  audio: z.string(),                         // "stimuli/<setId>/lcr-01.mp3"
  speaker: SpeakerSchema,
  utterance: z.string().min(1),              // ≤6 stressed syllables — stripped (NEVER rendered, ETS rule)
  options: z.array(McqOptionSchema).length(4),
  correctOptionId: SafeIdSchema,             // stripped
  skill: ListeningSkillCategory,             // stripped
  explanationZh: z.string().min(1),          // stripped — may quote the utterance (post-answer only)
});

const ConversationSchema = z.object({
  id: SafeIdSchema, taskType: z.literal("conversation"),
  audio: z.string(), setting: z.string(),    // "campus dining hall" — avatar card backdrop text
  speakers: z.array(SpeakerSchema).length(2),                                   // M/F pair, verified
  transcript: z.array(z.object({ speakerId: SafeIdSchema, text: z.string() })), // stripped
  questions: z.array(ListeningMcqQuestionSchema).length(CONVERSATION_QUESTIONS_PER_STIMULUS),
}).superRefine((conversation, ctx) => {
  // A conversation is one male and one female speaker, and every transcript turn names one of them.
  const genders = new Set(conversation.speakers.map((speaker) => speaker.gender));
  if (genders.size !== 2) {
    ctx.addIssue({
      code: "custom", path: ["speakers"],
      message: "conversation speakers must be one male and one female",
    });
  }
  const speakerIds = new Set(conversation.speakers.map((speaker) => speaker.id));
  conversation.transcript.forEach((turn, i) => {
    if (!speakerIds.has(turn.speakerId)) {
      ctx.addIssue({
        code: "custom", path: ["transcript", i, "speakerId"],
        message: `transcript turn references unknown speakerId "${turn.speakerId}"`,
      });
    }
  });
});

const AnnouncementSchema = z.object({
  id: SafeIdSchema, taskType: z.literal("announcement"),
  audio: z.string(), setting: z.string(), speaker: SpeakerSchema,
  transcript: z.string(),                    // 40–85 words — stripped
  questions: z.array(ListeningMcqQuestionSchema).length(ANNOUNCEMENT_QUESTIONS_PER_STIMULUS),
});

const AcademicTalkSchema = z.object({
  id: SafeIdSchema, taskType: z.literal("academic_talk"),
  audio: z.string(), discipline: z.string(), speaker: SpeakerSchema,
  transcript: z.string(),                    // 175–250 words — stripped
  questions: z.array(ListeningMcqQuestionSchema).length(ACADEMIC_TALK_QUESTIONS_PER_STIMULUS),
});

// The persisted module: array counts and `timeLimitSec` are loose so Sets banked under an older
// composition keep loading. Generation binds both (listeningModuleGenerationInputSchema).
const ListeningModuleSchema = z.object({
  timeLimitSec: z.number().int().positive(),
  listenChoose: z.array(ListenChooseItemSchema),
  conversations: z.array(ConversationSchema),
  announcements: z.array(AnnouncementSchema),
  academicTalks: z.array(AcademicTalkSchema),
});
export type ListeningModule = z.infer<typeof ListeningModuleSchema>;

// How a Listening Set's clips were rendered; stripped before serving. A new Set renders with Gemini
// only: listeningAudioRenderer's buildRenderPlan rejects any non-Gemini Speaker before the first
// synthesis call. `provider` stays an enum because a banked Set (lsn-14659f38) was rendered by OpenAI
// and records "openai"; `model` records the configured model rather than promising a literal.
const ListeningAudioProfileSchema = z.object({
  version: z.literal("ets-2026-listening-v1"),
  provider: z.enum(["openai", "gemini"]),
  model: z.string().min(1),
});

export const ListeningSetSchema = z.object({
  ...base, kind: z.literal("listening"),
  advisoryNotes,
  router: ListeningModuleSchema, lowerModule: ListeningModuleSchema, upperModule: ListeningModuleSchema,
  audioProfile: ListeningAudioProfileSchema.optional(),     // stripped
  generationPlan: PublishedListeningGenerationPlanSchema.optional(), // stripped
});

// What Listening generation is shown and parsed against. The model writes every Stimulus in its
// persisted shape except `audio`, which it leaves "" for the renderer to fill; audioProfile and
// generationPlan are added by the server. Each module's arrays are bound to their exact composition
// count and `timeLimitSec` to the official value, so a candidate with a wrong count fails to parse at
// once (generationCandidateLoop.ts's parseCandidate), and the JSON Schema the provider sees states
// the exact counts.
function listeningModuleGenerationInputSchema(
  counts: { listenChoose: number; conversations: number; announcements: number; academicTalks: number },
  timeLimitSec: number,
) {
  return z.object({
    timeLimitSec: z.literal(timeLimitSec),
    listenChoose: z.array(ListenChooseItemSchema).length(counts.listenChoose),
    conversations: z.array(ConversationSchema).length(counts.conversations),
    announcements: z.array(AnnouncementSchema).length(counts.announcements),
    academicTalks: z.array(AcademicTalkSchema).length(counts.academicTalks),
  });
}
export const ListeningGenerationInputSchema = z.object({
  ...base, kind: z.literal("listening"),
  router: listeningModuleGenerationInputSchema(
    LISTENING_MODULE_COMPOSITION.router, LISTENING_MODULE_TIME_LIMITS_SEC.router,
  ),
  lowerModule: listeningModuleGenerationInputSchema(
    LISTENING_MODULE_COMPOSITION.lowerModule, LISTENING_MODULE_TIME_LIMITS_SEC.lowerModule,
  ),
  upperModule: listeningModuleGenerationInputSchema(
    LISTENING_MODULE_COMPOSITION.upperModule, LISTENING_MODULE_TIME_LIMITS_SEC.upperModule,
  ),
});
export type ListeningGenerationInput = z.infer<typeof ListeningGenerationInputSchema>;

export type ListeningSet = z.infer<typeof ListeningSetSchema>;
