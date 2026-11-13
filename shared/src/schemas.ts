// The schemas the shared package exposes, from the modules under ./schemas/. Every name listed here is
// public; any other export of those modules is shared between schema modules only. stripAnswers and
// the served Set types are in ./servedSet.ts, which derives them from these schemas.

export {
  AnyTaskType,
  FULL_TEST_SECTION_ORDER,
  isDeterministicTaskType,
  ListeningTaskType,
  ModulePath,
  ReadingTaskType,
  SafeIdSchema,
  SpeakingWritingTaskType,
} from "./schemas/primitives.js";
export type {
  FullTestSection,
} from "./schemas/primitives.js";
export {
  MAX_SET_ADVISORY_NOTES,
  SetAdvisoryNoteSchema,
} from "./schemas/advisoryNotes.js";
export type {
  SetAdvisoryNote,
} from "./schemas/advisoryNotes.js";
export {
  GenerationDomainFamilySchema,
  maxSupportableRequiredConcepts,
  REQUIRED_CONCEPT_COVERAGE,
  REQUIRED_CONCEPT_MAX_CHARS,
} from "./schemas/planFields.js";
export type {
  GenerationDomainFamily,
} from "./schemas/planFields.js";
export {
  McqOptionSchema,
  mcqQuestionSchema,
} from "./schemas/multipleChoice.js";
export {
  LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM,
  LISTEN_AND_REPEAT_ITEM_TARGET_WPM,
  LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC,
  LISTEN_AND_REPEAT_MAX_ITEM_WORDS,
  SpeakingAudioProfileSchema,
  SpeakingAudioProfileV6Schema,
} from "./schemas/speakingAudioProfile.js";
export type {
  SpeakingAccent,
  SpeakingAudioProfile,
  SpeakingAudioProfileV6,
  SpeakingAudioProfileVersion,
} from "./schemas/speakingAudioProfile.js";
export {
  FocusRegionSchema,
  RESPONSE_WINDOW_RAMP,
  SpeakingGenerationInputSchema,
  SpeakingGenerationPlanSchema,
  SpeakingSetSchema,
} from "./schemas/speaking.js";
export type {
  FocusRegion,
  SpeakingGenerationInput,
  SpeakingGenerationPlan,
  SpeakingSet,
} from "./schemas/speaking.js";
export {
  BuildASentenceItemSchema,
  toPersistedWritingSet,
  WritingGenerationInputSchema,
  WritingGenerationPlanSchema,
  WritingSetSchema,
} from "./schemas/writing.js";
export type {
  WritingGenerationInput,
  WritingGenerationPlan,
  WritingSet,
} from "./schemas/writing.js";
export {
  READING_MODULE_COMPOSITION,
  READING_MODULE_TIME_LIMITS_SEC,
  ReadingGeneratedSetSchema,
  ReadingGenerationInputSchema,
  ReadingGenerationPlanSchema,
  readingPlanEntryCount,
  ReadingSetSchema,
  ReadingSkillCategory,
} from "./schemas/reading.js";
export type {
  PublicCtwSegment,
  ReadingGeneratedSet,
  ReadingGenerationInput,
  ReadingGenerationPlan,
  ReadingModule,
  ReadingSet,
} from "./schemas/reading.js";
export {
  LCR_UTTERANCE_DESIGN_WORD_RANGE,
  LISTENING_MODULE_COMPOSITION,
  LISTENING_MODULE_TIME_LIMITS_SEC,
  ListeningGenerationInputSchema,
  ListeningGenerationPlanSchema,
  ListeningSetSchema,
  ListeningSkillCategory,
} from "./schemas/listening.js";
export type {
  ListeningAccent,
  ListeningGenerationInput,
  ListeningGenerationPlan,
  ListeningModule,
  ListeningSet,
  Speaker,
} from "./schemas/listening.js";
export {
  CaptureFinishedRequestSchema,
  DeliveryReportSchema,
  EarsResultSchema,
  essayHasNoWords,
  isNotCapturedItemScoreJson,
  isSkippedItemScoreJson,
  JudgeReportSchema,
  MCQ_UNANSWERED_SENTINEL,
  NOT_CAPTURED_ITEM_ERROR,
  ScoreReportSchema,
  ScoreRequestSchema,
  SKIPPED_ITEM_REASON,
} from "./schemas/scoring.js";
export type {
  BuildSentenceItemScoreJson,
  DeliveryReport,
  DeterministicItemScoreJson,
  MarksWithheldReason,
  ServedBuildSentenceItemScoreJson,
  ServedDeterministicItemScoreJson,
  DeterministicScoreRequest,
  EarsResult,
  JudgeReport,
  ScoreReport,
  ScoreRequest,
  SkippedItemScoreJson,
} from "./schemas/scoring.js";
export {
  AnySetSchema,
  GenerationPlanSchema,
} from "./schemas/allSections.js";
export type {
  AnySet,
  GenerationPlan,
} from "./schemas/allSections.js";
