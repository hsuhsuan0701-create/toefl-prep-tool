import { describe, expect, it } from "vitest";
import { ReadingTaskType, ListeningTaskType } from "@toefl-prep/shared";
import { axisTicks, formatAxisTick, formatScore, scaleFor } from "../src/lib/taskTypeScale";

// Two scales share one `avgScore` field: the eight deterministic Task Types report a 0-1 proportion
// correct, the four judged ones a 0-5 rubric score. Drawn on a 0-5 axis, a deterministic chart sits
// squashed in the bottom fifth and reads as a flat line. A real database shows the two ranges with
// `select task_type, min(score), max(score) from item_results group by task_type`.
const ACCURACY_TASK_TYPES = ["build_sentence", ...ReadingTaskType.options, ...ListeningTaskType.options];
const RUBRIC_TASK_TYPES = ["email", "discussion", "listen_repeat", "interview"];

describe("taskTypeScale", () => {
  it("puts every deterministic Task Type on the 0-1 accuracy scale", () => {
    for (const taskType of ACCURACY_TASK_TYPES) {
      expect(scaleFor(taskType), taskType).toEqual({ max: 1, kind: "accuracy" });
    }
  });

  it("puts every judge-scored Task Type on the 0-5 rubric scale", () => {
    for (const taskType of RUBRIC_TASK_TYPES) {
      expect(scaleFor(taskType), taskType).toEqual({ max: 5, kind: "rubric" });
    }
  });

  it("never gives an accuracy Task Type an axis that runs to 5", () => {
    for (const taskType of ACCURACY_TASK_TYPES) {
      const ticks = axisTicks(taskType);
      expect(ticks[ticks.length - 1], taskType).toBe(1);
    }
    for (const taskType of RUBRIC_TASK_TYPES) {
      const ticks = axisTicks(taskType);
      expect(ticks[ticks.length - 1], taskType).toBe(5);
    }
  });

  it("reads an accuracy score as a percentage and a rubric score against its denominator", () => {
    expect(formatScore("complete_words", 0.75)).toBe("75%");
    expect(formatScore("build_sentence", 0.6)).toBe("60%");
    expect(formatScore("academic_talk", 1)).toBe("100%");
    expect(formatScore("email", 3.5)).toBe("3.50 / 5");
    expect(formatScore("listen_repeat", 4.166)).toBe("4.17 / 5");
  });

  it("labels axis ticks in the same units as the tooltip", () => {
    expect(axisTicks("complete_words").map((t) => formatAxisTick("complete_words", t))).toEqual([
      "0%",
      "25%",
      "50%",
      "75%",
      "100%",
    ]);
    expect(axisTicks("email").map((t) => formatAxisTick("email", t))).toEqual(["0", "1", "2", "3", "4", "5"]);
  });
});
