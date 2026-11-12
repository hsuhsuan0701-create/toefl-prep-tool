import { describe, expect, it } from "vitest";
import { AnyTaskType, isDeterministicTaskType } from "@toefl-prep/shared";
import {
  ALL_TASK_TYPES,
  TASK_TYPES,
  TREND_TASKS,
  taskTypeEntry,
  taskTypeLabel,
  type ReviewRendererKind,
} from "../src/lib/taskTypes";
import { scaleFor } from "../src/lib/taskTypeScale";

// The Task Type registry: one row per Task Type, carrying its label, section, trend scale and review
// renderer. A Task Type with no review renderer would render its card heading in review and then
// nothing at all: no error, no fallback, a blank section.
//
// `Record<AnyTaskType, ...>` makes an omitted row a `tsc` failure, which is the real guarantee. This
// suite is the second line: it checks the resolved value of every field for all twelve, so the
// compile-time table cannot be satisfied with a row that resolves to an empty label or a renderer
// nothing draws, and so the labels and axes keep rendering identically.

const REVIEW_RENDERERS: ReviewRendererKind[] = ["build_sentence", "essay", "speaking", "deterministic"];
const SECTIONS = ["speaking", "writing", "reading", "listening"];

// The golden table: what each Task Type renders as. `label` is the full name; `shortLabel` is the
// trend strip's label.
const EXPECTED: Record<string, { label: string; shortLabel: string; section: string; review: ReviewRendererKind }> = {
  build_sentence: { label: "Build a Sentence", shortLabel: "Build a Sentence", section: "writing", review: "build_sentence" },
  email: { label: "Write an Email", shortLabel: "Write an Email", section: "writing", review: "essay" },
  discussion: { label: "Academic Discussion", shortLabel: "Academic Discussion", section: "writing", review: "essay" },
  listen_repeat: { label: "Listen and Repeat", shortLabel: "Listen and Repeat", section: "speaking", review: "speaking" },
  interview: { label: "Interview", shortLabel: "Interview", section: "speaking", review: "speaking" },
  complete_words: { label: "Complete the Words", shortLabel: "Complete the Words", section: "reading", review: "deterministic" },
  daily_life: { label: "Read in Daily Life", shortLabel: "Read in Daily Life", section: "reading", review: "deterministic" },
  academic_passage: { label: "Read an Academic Passage", shortLabel: "Read an Academic Passage", section: "reading", review: "deterministic" },
  listen_choose: { label: "Listen and Choose a Response", shortLabel: "Listen and Choose", section: "listening", review: "deterministic" },
  conversation: { label: "Listen to a Conversation", shortLabel: "Conversation", section: "listening", review: "deterministic" },
  announcement: { label: "Listen to an Announcement", shortLabel: "Announcement", section: "listening", review: "deterministic" },
  academic_talk: { label: "Listen to an Academic Talk", shortLabel: "Academic Talk", section: "listening", review: "deterministic" },
};

describe("Task Type registry", () => {
  it("carries a row for every Task Type and no row for anything else", () => {
    expect([...ALL_TASK_TYPES].sort()).toEqual([...AnyTaskType.options].sort());
    expect(Object.keys(TASK_TYPES).sort()).toEqual([...AnyTaskType.options].sort());
    expect(ALL_TASK_TYPES).toHaveLength(12);
  });

  it("resolves every Task Type to a label, a section, a scale and a review renderer", () => {
    for (const taskType of AnyTaskType.options) {
      const entry = taskTypeEntry(taskType);
      expect(entry, taskType).toBeDefined();
      expect(entry!.label.length, taskType).toBeGreaterThan(0);
      expect(entry!.shortLabel.length, taskType).toBeGreaterThan(0);
      expect(SECTIONS, taskType).toContain(entry!.section);
      expect([1, 5], taskType).toContain(entry!.scale.max);
      expect(REVIEW_RENDERERS, taskType).toContain(entry!.review);
    }
  });

  it("renders each Task Type's label exactly as it did before the registry", () => {
    for (const taskType of AnyTaskType.options) {
      const entry = taskTypeEntry(taskType)!;
      expect({ label: entry.label, shortLabel: entry.shortLabel, section: entry.section, review: entry.review }, taskType).toEqual(
        EXPECTED[taskType],
      );
      expect(taskTypeLabel(taskType), taskType).toBe(EXPECTED[taskType].label);
    }
  });

  it("takes each Task Type's trend scale from the shared deterministic predicate, never a second list", () => {
    for (const taskType of AnyTaskType.options) {
      const entry = taskTypeEntry(taskType)!;
      expect(entry.scale, taskType).toEqual(scaleFor(taskType));
      expect(entry.scale, taskType).toEqual(
        isDeterministicTaskType(taskType) ? { max: 1, kind: "accuracy" } : { max: 5, kind: "rubric" },
      );
    }
  });

  it("sends every Task Type to a review renderer, so no card can render a heading over nothing", () => {
    const covered = new Set(AnyTaskType.options.map((t) => taskTypeEntry(t)!.review));
    expect([...covered].sort()).toEqual([...REVIEW_RENDERERS].sort());
  });

  it("keeps the trend strip's Task Types, order and labels", () => {
    expect(TREND_TASKS).toEqual([
      { section: "writing", taskType: "build_sentence", label: "Build a Sentence" },
      { section: "writing", taskType: "email", label: "Write an Email" },
      { section: "writing", taskType: "discussion", label: "Academic Discussion" },
      { section: "speaking", taskType: "listen_repeat", label: "Listen and Repeat" },
      { section: "speaking", taskType: "interview", label: "Interview" },
      { section: "reading", taskType: "complete_words", label: "Complete the Words" },
      { section: "reading", taskType: "daily_life", label: "Read in Daily Life" },
      { section: "reading", taskType: "academic_passage", label: "Read an Academic Passage" },
      { section: "listening", taskType: "listen_choose", label: "Listen and Choose" },
      { section: "listening", taskType: "conversation", label: "Conversation" },
      { section: "listening", taskType: "announcement", label: "Announcement" },
      { section: "listening", taskType: "academic_talk", label: "Academic Talk" },
    ]);
  });

  it("reads an unknown Task Type back as its own code rather than blank", () => {
    expect(taskTypeEntry("not_a_task_type")).toBeUndefined();
    expect(taskTypeLabel("not_a_task_type")).toBe("not_a_task_type");
  });
});
