import { z } from "zod";

// The vocabulary every schema module shares: the Task Types and the sections they belong to, the
// Module Path, the id rule and the fields every Set starts with. Imports nothing else in schemas/.

const SetSource = z.enum(["ets-sample", "generated", "imported"]);
export const SpeakingWritingTaskType = z.enum(["listen_repeat", "interview", "build_sentence", "email", "discussion"]);
export type SpeakingWritingTaskType = z.infer<typeof SpeakingWritingTaskType>;
export const ReadingTaskType = z.enum(["complete_words", "daily_life", "academic_passage"]);
export const ListeningTaskType = z.enum(["listen_choose", "conversation", "announcement", "academic_talk"]);
export const AnyTaskType = z.enum([
  ...SpeakingWritingTaskType.options, ...ReadingTaskType.options, ...ListeningTaskType.options,
] as [string, ...string[]]);
export type AnyTaskType =
  | z.infer<typeof SpeakingWritingTaskType>
  | z.infer<typeof ReadingTaskType>
  | z.infer<typeof ListeningTaskType>;

export const ModulePath = z.enum(["lower", "upper"]);
export type ModulePath = z.infer<typeof ModulePath>;

const DETERMINISTIC_TASK_TYPES: ReadonlySet<string> = new Set(["build_sentence", ...ReadingTaskType.options, ...ListeningTaskType.options]);
/** Whether a Task Type is scored from its answer key, with no Judge: Build a Sentence and every
 * Reading and Listening Task Type. */
export function isDeterministicTaskType(taskType: string): boolean {
  return DETERMINISTIC_TASK_TYPES.has(taskType);
}

// Set and Item ids become filesystem path segments (a recording is stored as
// audio/responses/<attemptId>/<itemId>.webm, rendered clips under stimuli/<setId>/), so every id is
// held to a safe filename segment here, where an imported Set cannot get around it.
export const SafeIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "id must be 1-64 chars of A-Z a-z 0-9 _ -");

/** The fields every Set schema starts with. */
export const base = { id: SafeIdSchema, source: SetSource, createdAt: z.string() };

/**
 * The four sections of one sitting, in the order ETS delivers them.
 *
 * The ONE definition of that order: the server orders a Run's sections by it, the Run page renders
 * by it, and the section handoff (`POST /api/full-tests/:id/advance`) steps through it. Two copies
 * of a sequence like this drift silently — the page would still look right while the handoff went
 * somewhere else.
 */
export const FULL_TEST_SECTION_ORDER = ["reading", "listening", "writing", "speaking"] as const;
export type FullTestSection = (typeof FULL_TEST_SECTION_ORDER)[number];
