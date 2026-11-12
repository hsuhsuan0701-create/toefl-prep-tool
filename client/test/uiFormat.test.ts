import { describe, expect, it } from "vitest";
import { coverageText, formatBand, formatClock, formatDuration, formatPercent, formatWhen, targetGapText } from "../src/ui/format";
import { ATTEMPT_STATUS, FULL_TEST_RUN_STATUS, estimateMethod, humanize, itemScoringStatus } from "../src/ui/labels";

describe("ui/format", () => {
  it("formats durations in words, never raw seconds", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(420)).toBe("7 min");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(3600)).toBe("1 h");
    expect(formatDuration(4440)).toBe("1 h 14 min");
    expect(formatDuration(-1)).toBe("—");
  });

  it("formats a countdown clock", () => {
    expect(formatClock(724)).toBe("12:04");
    expect(formatClock(59.2)).toBe("1:00");
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(3729)).toBe("1:02:09");
  });

  it("formats when something happened relative to now", () => {
    const now = new Date(2026, 10, 12, 20, 30);
    expect(formatWhen(new Date(2026, 10, 12, 18, 14).toISOString(), now)).toBe("Today, 6:14 PM");
    expect(formatWhen(new Date(2026, 10, 11, 9, 2).toISOString(), now)).toBe("Yesterday, 9:02 AM");
    expect(formatWhen(new Date(2026, 8, 2, 18, 14).toISOString(), now)).toBe("Sep 2, 6:14 PM");
    expect(formatWhen(new Date(2025, 8, 2, 18, 14).toISOString(), now)).toBe("Sep 2, 2025");
    expect(formatWhen("not a date", now)).toBe("—");
  });

  it("never rounds accuracy up to a false 100%", () => {
    expect(formatPercent(0.86)).toBe("86%");
    expect(formatPercent(0.995)).toBe("99%");
    expect(formatPercent(1)).toBe("100%");
  });

  it("prints half-step bands without a trailing .0", () => {
    expect(formatBand(5)).toBe("5");
    expect(formatBand(5.5)).toBe("5.5");
  });

  it("names coverage by Task Type, not by code", () => {
    expect(coverageText({ taskType: "complete_words", itemCount: 30 })).toBe("Complete the Words · 30 Items");
    expect(coverageText({ taskType: "email", itemCount: 1, skippedCount: 1 })).toBe("Write an Email · 1 Item (1 skipped)");
  });

  it("states the distance from a Target in words", () => {
    expect(targetGapText(4.5, 5.5)).toBe("1 band below your Target");
    expect(targetGapText(5, 5.5)).toBe("0.5 band below your Target");
    expect(targetGapText(5.5, 5.5)).toBe("At your Target");
    expect(targetGapText(6, 4.5)).toBe("1.5 bands above your Target");
  });
});

describe("ui/labels", () => {
  it("keeps the same word apart across domains", () => {
    expect(ATTEMPT_STATUS.in_progress.label).toBe("Unfinished");
    expect(FULL_TEST_RUN_STATUS["in-progress"].label).toBe("In progress");
  });

  it("falls back to readable words for a scoring status it does not know", () => {
    expect(itemScoringStatus("scored").label).toBe("Scored");
    expect(itemScoringStatus("brand_new_state")).toMatchObject({ label: "Brand new state", tone: "neutral" });
    expect(humanize("retry_wait")).toBe("Retry wait");
  });

  it("describes every Band Estimate method CONTEXT.md names, and survives an unknown one", () => {
    for (const method of ["linear-v1", "linear-v2", "table3-v1", "mean-of-sections-v1"]) {
      expect(estimateMethod(method).label).not.toBe("Estimate");
    }
    expect(estimateMethod("linear-v9").label).toBe("Estimate");
  });
});
