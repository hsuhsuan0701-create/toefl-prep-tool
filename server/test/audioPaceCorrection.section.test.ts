import { describe, expect, it, vi } from "vitest";

import { renderClipWithPaceCorrection } from "../src/services/audioPaceCorrection.js";
import { classifyGenerationCheck } from "../src/services/generationCheckPolicy.js";

// The pace tier is asked of generationCheckPolicy per section. Speaking and Listening share a tier,
// so no rendered outcome can show which section was asked; this file watches the question itself,
// through the real policy wrapped in a spy.
vi.mock("../src/services/generationCheckPolicy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/generationCheckPolicy.js")>();
  return { ...actual, classifyGenerationCheck: vi.fn(actual.classifyGenerationCheck) };
});

const BAND = { targetWpm: 160, minWpm: 150, maxWpm: 170 };
const WORDS = 160;

describe("renderClipWithPaceCorrection asks the policy about its own section", () => {
  it.each(["speaking", "listening"] as const)("asks about the %s section", async (section) => {
    vi.mocked(classifyGenerationCheck).mockClear();
    // An out-of-band first take (120 WPM), then an in-band retake.
    const durations = [(WORDS / 120) * 60, 60];
    await renderClipWithPaceCorrection({
      section,
      band: BAND,
      wordCount: WORDS,
      takePath: (round) => `/tmp/take${round}.mp3`,
      role: "lr-item",
      synthesize: async () => undefined,
      probeDuration: async () => durations.shift()!,
      discardTake: () => undefined,
      onTake: () => undefined,
    });
    const sections = vi.mocked(classifyGenerationCheck).mock.calls.map(([check]) =>
      check.family === "audio-pace" ? check.section : undefined);
    expect(sections.length).toBeGreaterThan(0);
    expect(new Set(sections)).toEqual(new Set([section]));
  });
});
