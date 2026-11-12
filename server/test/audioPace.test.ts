import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_DURATION_TOLERANCE_SEC,
  assessPace,
  countEnglishWords,
  FAR_BELOW_BAND_WPM,
  farBelowBand,
  inBand,
  paceWarning,
  SANITY_MAX_DURATION_RATIO,
  SANITY_MIN_DURATION_RATIO,
  targetDurationSec,
  wordsPerMinute,
  type PaceBand,
} from "../src/services/audioPace.js";

// A representative band, stated here rather than taken from a renderer's policy: audioPace.ts is the
// pure module both renderers depend on, and it and its tests depend on neither of them.
const BAND: PaceBand = { targetWpm: 160, minWpm: 150, maxWpm: 170 };

describe("countEnglishWords", () => {
  it("counts a contraction as one word", () => {
    expect(countEnglishWords("don't stop")).toBe(2);
  });

  it("counts a hyphenated word as one word", () => {
    expect(countEnglishWords("well-known fact")).toBe(2);
  });

  it("counts a word using the typographic apostrophe as one word", () => {
    expect(countEnglishWords("it’s fine")).toBe(2);
  });

  it("counts digit sequences as words", () => {
    expect(countEnglishWords("chapter 12 begins now")).toBe(4);
  });

  it("returns 0 for empty input", () => {
    expect(countEnglishWords("")).toBe(0);
  });

  it("returns 0 for input with no matchable words", () => {
    expect(countEnglishWords("   ...   —   ")).toBe(0);
  });
});

describe("wordsPerMinute / targetDurationSec round-trip", () => {
  it("recovers the same wpm from a duration computed by targetDurationSec", () => {
    const wordCount = 80;
    const duration = targetDurationSec(wordCount, BAND);
    expect(wordsPerMinute(wordCount, duration)).toBeCloseTo(BAND.targetWpm, 10);
  });

  it("computes wpm directly", () => {
    // 160 words in 60s = 160 wpm.
    expect(wordsPerMinute(160, 60)).toBeCloseTo(160, 10);
  });
});

describe("inBand", () => {
  it("is true at the band edges and inside", () => {
    expect(inBand(BAND.minWpm, BAND)).toBe(true);
    expect(inBand(BAND.maxWpm, BAND)).toBe(true);
    expect(inBand(BAND.targetWpm, BAND)).toBe(true);
  });

  it("is false outside the band", () => {
    expect(inBand(BAND.minWpm - 1, BAND)).toBe(false);
    expect(inBand(BAND.maxWpm + 1, BAND)).toBe(false);
  });
});

describe("assessPace", () => {
  it("resolves a clip inside its band to in-band", () => {
    const wordCount = 160;
    const durationSec = targetDurationSec(wordCount, BAND); // wpm === targetWpm
    const result = assessPace({ wordCount, durationSec, band: BAND });
    expect(result.verdict).toBe("in-band");
    expect(result.inBand).toBe(true);
    expect(result.withinTolerance).toBe(true);
    expect(result.withinSanity).toBe(true);
  });

  it("a short clip outside its band but inside the absolute duration floor is in-band via tolerance, not the band itself", () => {
    // 7 words, 150-170 wpm band: target duration is 7/160*60 = 2.625s. A duration past the fast
    // edge of the band (< 7/170*60 = 2.4706s) but still within ABSOLUTE_DURATION_TOLERANCE_SEC of
    // the target (2.625 - 0.4 = 2.225s) is in band overall while failing the band check itself: the
    // short-clip near-miss the tolerance exists to accept.
    const wordCount = 7;
    const target = targetDurationSec(wordCount, BAND);
    const durationSec = target - ABSOLUTE_DURATION_TOLERANCE_SEC + 0.05; // inside the tolerance
    const wpm = wordsPerMinute(wordCount, durationSec);
    expect(inBand(wpm, BAND)).toBe(false); // sanity-check the fixture actually misses the band

    const result = assessPace({ wordCount, durationSec, band: BAND });
    expect(result.verdict).toBe("in-band");
    expect(result.inBand).toBe(false);
    expect(result.withinTolerance).toBe(true);
    expect(result.withinSanity).toBe(true);
  });

  it("a long clip outside its band and outside the absolute floor is out-of-band, not a malfunction", () => {
    // 200 words: target = 200/160*60 = 75s. A duration far enough past the max-wpm edge to also
    // clear the 0.4s absolute tolerance, but nowhere near the sanity ratio.
    const wordCount = 200;
    const target = targetDurationSec(wordCount, BAND); // 200/160*60 = 75s
    const durationSec = target - 10; // 65s -> 184.6 wpm, above maxWpm and 10s > 0.4s tolerance
    const wpm = wordsPerMinute(wordCount, durationSec);
    expect(inBand(wpm, BAND)).toBe(false);

    const result = assessPace({ wordCount, durationSec, band: BAND });
    expect(result.verdict).toBe("out-of-band");
    expect(result.withinSanity).toBe(true);
    expect(result.inBand).toBe(false);
    expect(result.withinTolerance).toBe(false);
  });

  it("a clip faster than the sanity floor is a malfunction", () => {
    const wordCount = 100;
    const target = targetDurationSec(wordCount, BAND);
    const durationSec = target * SANITY_MIN_DURATION_RATIO - 0.01;
    const result = assessPace({ wordCount, durationSec, band: BAND });
    expect(result.verdict).toBe("malfunction");
    expect(result.withinSanity).toBe(false);
  });

  it("a clip slower than the sanity ceiling is a malfunction", () => {
    const wordCount = 100;
    const target = targetDurationSec(wordCount, BAND);
    const durationSec = target * SANITY_MAX_DURATION_RATIO + 0.01;
    const result = assessPace({ wordCount, durationSec, band: BAND });
    expect(result.verdict).toBe("malfunction");
    expect(result.withinSanity).toBe(false);
  });

  it("treats durationSec <= 0 as a malfunction with no NaN/Infinity anywhere", () => {
    const result = assessPace({ wordCount: 50, durationSec: 0, band: BAND });
    assertCleanMalfunction(result);

    const negative = assessPace({ wordCount: 50, durationSec: -3, band: BAND });
    assertCleanMalfunction(negative);
  });

  it("treats a non-finite durationSec as a malfunction with no NaN/Infinity anywhere", () => {
    assertCleanMalfunction(assessPace({ wordCount: 50, durationSec: Number.NaN, band: BAND }));
    assertCleanMalfunction(assessPace({ wordCount: 50, durationSec: Number.POSITIVE_INFINITY, band: BAND }));
  });

  it("treats wordCount <= 0 as a malfunction with no NaN/Infinity anywhere", () => {
    assertCleanMalfunction(assessPace({ wordCount: 0, durationSec: 5, band: BAND }));
    assertCleanMalfunction(assessPace({ wordCount: -1, durationSec: 5, band: BAND }));
  });

  // A non-finite wordCount (NaN or +Infinity) would otherwise reach wpm and targetDurationSec through
  // ordinary division; like a non-finite duration, it resolves to a clean malfunction.
  it("treats a non-finite wordCount as a malfunction with no NaN/Infinity anywhere", () => {
    assertCleanMalfunction(assessPace({ wordCount: Number.NaN, durationSec: 5, band: BAND }));
    assertCleanMalfunction(assessPace({ wordCount: Number.POSITIVE_INFINITY, durationSec: 5, band: BAND }));
  });

  function assertCleanMalfunction(result: ReturnType<typeof assessPace>): void {
    expect(result.verdict).toBe("malfunction");
    expect(result.wpm).toBe(0);
    expect(result.targetDurationSec).toBe(0);
    expect(result.inBand).toBe(false);
    expect(result.withinTolerance).toBe(false);
    expect(result.withinSanity).toBe(false);
    for (const value of Object.values(result)) {
      if (typeof value === "number") {
        expect(Number.isNaN(value)).toBe(false);
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  }
});

/**
 * The gate-only threshold that decides whether a miss is worth escalating. One prompt nudge moves a
 * clip about 7 WPM (median |Δ|, n=75), so a gap two to four times that cannot close in one round;
 * those are the clips audioPaceCorrection buys further rounds for.
 */
describe("farBelowBand", () => {
  const at = (wpm: number) => assessPace({ wordCount: 160, durationSec: (160 / wpm) * 60, band: BAND });

  it("is the band floor less the tolerance, and nothing else", () => {
    expect(FAR_BELOW_BAND_WPM).toBe(15);
    // The floor is 150, so the line sits at 135: one WPM either side of it answers differently.
    expect(farBelowBand(at(BAND.minWpm - FAR_BELOW_BAND_WPM - 1), BAND)).toBe(true);
    expect(farBelowBand(at(BAND.minWpm - FAR_BELOW_BAND_WPM + 1), BAND)).toBe(false);
  });

  it("is never true for a clip that is in band, at or inside either edge", () => {
    for (const wpm of [BAND.minWpm, BAND.targetWpm, BAND.maxWpm]) {
      expect(farBelowBand(at(wpm), BAND)).toBe(false);
    }
  });

  it("is never true ABOVE the band, however far above", () => {
    // Below only: the recorded misses are slow ones, and an escalation ladder is worth spending only
    // where it has a measured population to work on. A clip far above its ceiling gets one
    // correction and publishes with a note.
    expect(farBelowBand(at(BAND.maxWpm + 200), BAND)).toBe(false);
  });

  it("is never true for a clip the absolute duration tolerance already rescued", () => {
    // 7 words at 2.376s is 176.8 WPM against a 150-170 band: outside it, but 0.249s from its own
    // target duration, so assessPace calls it in band. Nothing is wrong with that clip, and buying it
    // a correction round would spend on a repair with nothing to repair.
    const rescued = assessPace({ wordCount: 7, durationSec: 2.376, band: BAND });
    expect(rescued.inBand).toBe(false);
    expect(rescued.verdict).toBe("in-band");
    expect(farBelowBand(rescued, BAND)).toBe(false);
  });

  it("is never true for a malfunction — a truncated or stuck synthesis is not a slow one", () => {
    const malfunction = assessPace({ wordCount: 160, durationSec: 0, band: BAND });
    expect(malfunction.verdict).toBe("malfunction");
    expect(farBelowBand(malfunction, BAND)).toBe(false);
  });
});

describe("paceWarning", () => {
  it("contains the role and file", () => {
    const assessment = assessPace({ wordCount: 200, durationSec: 100, band: BAND });
    const warning = paceWarning(assessment, { role: "announcement", file: "stimuli/set-1/ann-1.mp3" });
    expect(warning).toContain("announcement");
    expect(warning).toContain("stimuli/set-1/ann-1.mp3");
  });

  it("says the clip was kept and published", () => {
    const assessment = assessPace({ wordCount: 200, durationSec: 100, band: BAND });
    const warning = paceWarning(assessment, { role: "announcement", file: "stimuli/set-1/ann-1.mp3" });
    expect(warning.toLowerCase()).toContain("kept");
    expect(warning.toLowerCase()).toContain("published");
  });

  // Nothing but role, file and numbers reaches a log line. The signature enforces the inputs
  // (`context` has exactly two string fields, so transcript text has no way in); the line's content
  // is pinned here, so a new interpolated field or a reformatted number fails this assertion rather
  // than sliding into a log a human reads while a paid render is in flight.
  it("emits exactly the whitelisted fields, byte for byte", () => {
    const assessment = assessPace({ wordCount: 200, durationSec: 100, band: BAND });
    const warning = paceWarning(assessment, { role: "announcement", file: "stimuli/set-1/ann-1.mp3" });
    expect(warning).toBe(
      "pace out-of-band, clip kept and published: role=announcement file=stimuli/set-1/ann-1.mp3 " +
        "wordCount=200 durationSec=100.000 wpm=120.0 targetDurationSec=75.000",
    );
  });
});
