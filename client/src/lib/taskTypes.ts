import type { AnyTaskType, Section } from "@toefl-prep/shared";
import { scaleFor, type TaskTypeScale } from "./taskTypeScale";

// The Task Type registry: one table turning a Task Type into everything the UI needs to render it,
// namely its name, its section, the scale its scores are out of, and which Attempt-review renderer
// it uses. Adding a Task Type means adding one row here.
//
// It lives in the client, not in `shared`, because every field is a rendering concern: `review` is
// a React dispatch key with no meaning on the server, and `label`/`shortLabel` are copy no server
// response carries. What is shared is imported, never restated: the `AnyTaskType` union keys the
// table, and `scale` comes from `isDeterministicTaskType` through scaleFor() rather than per row.
//
// Exhaustive by construction: `ROWS` is typed `Record<AnyTaskType, TaskTypeRow>`, so adding a Task
// Type to `AnyTaskType` (shared/src/schemas/primitives.ts) without a row here fails `tsc`.
// taskTypes.test.ts pins the resolved label, section, scale and renderer of all twelve.

/**
 * Which Attempt-review renderer an Item's Task Type uses (AttemptReview.tsx groups Items by it
 * through reviewGroups in components/review/reviewText.ts). Four kinds for twelve Task Types: only
 * Build a Sentence has a renderer of its own.
 */
export type ReviewRendererKind = "build_sentence" | "essay" | "speaking" | "deterministic";

export type TaskTypeEntry = {
  /** The Task Type's full name, as Attempt review and the Drill pickers show it. */
  label: string;
  /**
   * The compact name the trend cards show (TrendsSection.tsx), where the section heading above
   * already supplies the context ("Listen to a Conversation" under a "Listening" heading is just
   * "Conversation"). Equal to `label` for the eight Task Types whose full name already fits.
   */
  shortLabel: string;
  section: Section;
  /** 0-1 accuracy or 0-5 rubric — derived, never restated. See taskTypeScale.ts. */
  scale: TaskTypeScale;
  review: ReviewRendererKind;
};

/**
 * One authored row. `shortLabel` is omitted wherever it would repeat `label`, so the four genuine
 * divergences are visible as divergences and the other eight cannot drift apart by half an edit.
 */
type TaskTypeRow = Omit<TaskTypeEntry, "scale" | "shortLabel"> & { shortLabel?: string };

// Declaration order is the order of the trend cards within a section (TREND_TASKS below reads it);
// TrendsSection.tsx orders the sections themselves.
const ROWS: Record<AnyTaskType, TaskTypeRow> = {
  build_sentence: { label: "Build a Sentence", section: "writing", review: "build_sentence" },
  email: { label: "Write an Email", section: "writing", review: "essay" },
  discussion: { label: "Academic Discussion", section: "writing", review: "essay" },
  listen_repeat: { label: "Listen and Repeat", section: "speaking", review: "speaking" },
  interview: { label: "Interview", section: "speaking", review: "speaking" },
  complete_words: { label: "Complete the Words", section: "reading", review: "deterministic" },
  daily_life: { label: "Read in Daily Life", section: "reading", review: "deterministic" },
  academic_passage: { label: "Read an Academic Passage", section: "reading", review: "deterministic" },
  listen_choose: { label: "Listen and Choose a Response", shortLabel: "Listen and Choose", section: "listening", review: "deterministic" },
  conversation: { label: "Listen to a Conversation", shortLabel: "Conversation", section: "listening", review: "deterministic" },
  announcement: { label: "Listen to an Announcement", shortLabel: "Announcement", section: "listening", review: "deterministic" },
  academic_talk: { label: "Listen to an Academic Talk", shortLabel: "Academic Talk", section: "listening", review: "deterministic" },
};

/**
 * The registry. Index it with a Task Type literal (`TASK_TYPES.complete_words.label`) for a
 * compile-time-checked lookup; use `taskTypeEntry()` for a value that is only a `string` at the type
 * level, which is what every view model carries (`taskType: string`).
 */
export const TASK_TYPES: Record<AnyTaskType, TaskTypeEntry> = Object.fromEntries(
  Object.entries(ROWS).map(([taskType, row]) => [
    taskType,
    { ...row, shortLabel: row.shortLabel ?? row.label, scale: scaleFor(taskType) },
  ]),
) as Record<AnyTaskType, TaskTypeEntry>;

/** Every Task Type in registry order, grouped by section. */
export const ALL_TASK_TYPES = Object.keys(ROWS) as AnyTaskType[];

/**
 * The registry row for a runtime `taskType`, or undefined for a code the registry does not know.
 * Undefined is not a hypothetical the callers must handle gracefully so much as one they must not
 * silently swallow: it can only mean an Attempt persisted under a Task Type this build has no row
 * for.
 */
export function taskTypeEntry(taskType: string): TaskTypeEntry | undefined {
  return (TASK_TYPES as Record<string, TaskTypeEntry | undefined>)[taskType];
}

/** The canonical name, falling back to the raw code so an unknown Task Type still reads as itself. */
export function taskTypeLabel(taskType: string): string {
  return taskTypeEntry(taskType)?.label ?? taskType;
}

/**
 * Every Task Type a trend is tracked for, in registry order. The Progress page's TrendsSection.tsx
 * filters it by section and renders one card per row, under `shortLabel`.
 */
export const TREND_TASKS: { section: Section; taskType: string; label: string }[] = ALL_TASK_TYPES.map(
  (taskType) => ({
    section: TASK_TYPES[taskType].section,
    taskType,
    label: TASK_TYPES[taskType].shortLabel,
  }),
);
