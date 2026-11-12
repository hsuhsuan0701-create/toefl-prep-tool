import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { median } from "../src/services/speakingAudioAudit.js";

const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures/ets-speaking-audio-calibration.json"), "utf8"));

describe("ETS speaking audio calibration fixture", () => {
  it("stores reproducible WPM values and the approved official reference ranges", () => {
    expect(fixture.clips).toHaveLength(12);
    for (const clip of fixture.clips) {
      expect(clip.wpm).toBeCloseTo(clip.wordCount / clip.durationSec * 60, 10);
      expect(clip.sourceUrl).toBe("https://www.ets.org/content/dam/ets-org/pdfs/toefl/teacher-practice-test-5-audio-files.zip");
      expect(clip.profileVersion).toBe("ets-2026-v1");
    }
    const briefing = fixture.clips.find((clip: { role: string }) => clip.role === "lr-briefing");
    const lr = fixture.clips.filter((clip: { role: string }) => clip.role === "lr-item").map((clip: { wpm: number }) => clip.wpm);
    const interview = fixture.clips.filter((clip: { role: string }) => clip.role === "interview-question").map((clip: { wpm: number }) => clip.wpm);
    expect(briefing.wpm).toBeCloseTo(158, 0);
    expect(Math.min(...lr)).toBeGreaterThanOrEqual(166);
    expect(Math.max(...lr)).toBeLessThanOrEqual(220);
    expect(median(lr)).toBeCloseTo(180, 0);
    expect(Math.min(...interview)).toBeGreaterThanOrEqual(137);
    expect(Math.max(...interview)).toBeLessThanOrEqual(165);
    expect(median(interview)).toBeCloseTo(157, 0);
    expect(fixture.groupMedians).toEqual({ listenAndRepeatItems: median(lr), interviewQuestions: median(interview) });
  });
});
