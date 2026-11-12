import { describe, expect, it } from "vitest";
import { ListeningTaskType, ReadingTaskType } from "@toefl-prep/shared";
import {
  estimateBand,
  estimateBandTable3,
  LOWER_PATH_BAND_CAP,
  maxScoreFor,
  meanBand,
  missingTaskTypes,
  requiredTaskTypes,
  SECTION_WEIGHTS,
  type BandEstimate,
  type BandEstimateResult,
  type BandEstimatorItem,
} from "../src/services/bandEstimator.js";

function estimated(result: BandEstimateResult): BandEstimate {
  if (result.status !== "estimated") throw new Error(`expected a band, got missing ${result.missingTaskTypes.join(",")}`);
  return result.estimate;
}

const scored = (taskType: string, score: number, maxScore: number, skipped?: boolean): BandEstimatorItem =>
  skipped ? { taskType, score, maxScore, skipped } : { taskType, score, maxScore };

/** A Writing section with exactly the official layout: ten Build a Sentence items, one Email, one Discussion. */
function writing(bsCorrect: number, email: number, discussion: number): BandEstimatorItem[] {
  return [
    ...Array.from({ length: 10 }, (_, i) => scored("build_sentence", i < bsCorrect ? 1 : 0, 1)),
    scored("email", email, 5),
    scored("discussion", discussion, 5),
  ];
}

/**
 * Reading/Listening items cycling through every Task Type of the section, the first `correct` of them
 * right — table3-v1 is unweighted percent-correct, so which Task Type carries which right answer does
 * not move the band, and cycling keeps every Task Type covered.
 */
function rlItems(section: "reading" | "listening", correct: number, total: number): BandEstimatorItem[] {
  const taskTypes = section === "reading" ? ReadingTaskType.options : ListeningTaskType.options;
  return Array.from({ length: total }, (_, i) => scored(taskTypes[i % taskTypes.length], i < correct ? 1 : 0, 1));
}

describe("estimateBand", () => {
  it("pins ETS Table 2's raw-point shares as integer numerators over one denominator", () => {
    // Speaking raw 0-55 = 7 L&R x 5 + 4 Interview x 5 -> 35/55 = 7/11 and 20/55 = 4/11.
    // Writing raw 0-20 = 10 Build a Sentence x 1 + Email 5 + Discussion 5 -> 2/4, 1/4, 1/4.
    expect(SECTION_WEIGHTS.speaking).toEqual({ denominator: 11, shares: { listen_repeat: 7, interview: 4 } });
    expect(SECTION_WEIGHTS.writing).toEqual({ denominator: 4, shares: { build_sentence: 2, email: 1, discussion: 1 } });
  });

  it("worked example: speaking raw 9/11 -> band 5.0", () => {
    const e = estimated(estimateBand("speaking", [scored("listen_repeat", 5, 5), scored("interview", 2.5, 5)]));
    // raw = 7/11 * 1.0 + 4/11 * 0.5 = 9/11; band = 1 + 45/11 = 5.09 -> 5.0.
    expect(e.raw).toBeCloseTo(9 / 11);
    expect(e.band).toBe(5.0);
    expect(e.method).toBe("linear-v2");
    expect(e.coverage).toEqual([
      { taskType: "listen_repeat", itemCount: 1, skippedCount: 0 },
      { taskType: "interview", itemCount: 1, skippedCount: 0 },
    ]);
  });

  it("worked example: writing raw 0.7 -> band 4.5", () => {
    const e = estimated(estimateBand("writing", [
      ...[1, 1, 1, 1, 0].map((s) => scored("build_sentence", s, 1)),
      scored("email", 3, 5),
      scored("discussion", 3, 5),
    ]));
    // raw = 0.5 * 0.8 + 0.25 * 0.6 + 0.25 * 0.6 = 0.7; band = 1 + 3.5 = 4.5.
    expect(e.raw).toBeCloseTo(0.7);
    expect(e.band).toBe(4.5);
  });

  it("averages multiple items of the same Task Type before applying its weight", () => {
    const e = estimated(estimateBand("speaking", [
      scored("interview", 5, 5),
      scored("interview", 0, 5),
      scored("listen_repeat", 5, 5),
    ]));
    expect(e.raw).toBeCloseTo(9 / 11);
    expect(e.band).toBe(5.0);
    expect(e.coverage).toEqual([
      { taskType: "listen_repeat", itemCount: 1, skippedCount: 0 },
      { taskType: "interview", itemCount: 2, skippedCount: 0 },
    ]);
  });

  describe("coverage: a band needs every weighted Task Type scored at least once", () => {
    it("names the missing Task Type instead of re-spreading its weight over the others", () => {
      // Spreading Build a Sentence's weight over the two essays would read this as a 3.5.
      const result = estimateBand("writing", [scored("email", 5, 5), scored("discussion", 0, 5)]);
      expect(result).toEqual({
        status: "incomplete",
        method: "linear-v2",
        missingTaskTypes: ["build_sentence"],
        coverage: [
          { taskType: "email", itemCount: 1, skippedCount: 0 },
          { taskType: "discussion", itemCount: 1, skippedCount: 0 },
        ],
      });
      expect(result).not.toHaveProperty("estimate");
    });

    it("Build a Sentence alone is not a Writing band (the essay-scoring-failed case)", () => {
      const result = estimateBand("writing", Array.from({ length: 10 }, () => scored("build_sentence", 1, 1)));
      expect(result.status).toBe("incomplete");
      if (result.status === "incomplete") expect(result.missingTaskTypes).toEqual(["email", "discussion"]);
    });

    it("three skipped Interview Items and no scored Listen and Repeat are not a Speaking 1.0", () => {
      const result = estimateBand("speaking", [
        scored("interview", 3, 5),
        scored("interview", 0, 5, true),
        scored("interview", 0, 5, true),
        scored("interview", 0, 5, true),
      ]);
      expect(result.status).toBe("incomplete");
      if (result.status === "incomplete") {
        expect(result.missingTaskTypes).toEqual(["listen_repeat"]);
        expect(result.coverage).toEqual([{ taskType: "interview", itemCount: 4, skippedCount: 3 }]);
      }
    });

    it("nothing scored at all is every Task Type missing", () => {
      expect(estimateBand("speaking", [])).toEqual({
        status: "incomplete",
        method: "linear-v2",
        missingTaskTypes: ["listen_repeat", "interview"],
        coverage: [],
      });
    });

    it("ignores items of a Task Type outside the section's weight table", () => {
      const result = estimateBand("speaking", [scored("email", 3, 5)]);
      expect(result.status).toBe("incomplete");
      if (result.status === "incomplete") expect(result.coverage).toEqual([]);
    });

    it("a skipped item covers its Task Type — an unanswered Item scores 0, as on the exam", () => {
      const e = estimated(estimateBand("speaking", [scored("listen_repeat", 5, 5), scored("interview", 0, 5, true)]));
      expect(e.coverage[1]).toEqual({ taskType: "interview", itemCount: 1, skippedCount: 1 });
    });
  });

  it("counts a skipped item as a plain 0 in the weighted mean", () => {
    const answered = estimated(estimateBand("speaking", [scored("listen_repeat", 5, 5), scored("interview", 0, 5)]));
    const skipped = estimated(estimateBand("speaking", [scored("listen_repeat", 5, 5), scored("interview", 0, 5, true)]));
    expect(skipped.raw).toBeCloseTo(answered.raw);
    expect(skipped.band).toBe(answered.band);
  });

  it("tallies skipped items per Task Type in coverage without moving them out of itemCount", () => {
    const e = estimated(estimateBand("speaking", [
      scored("listen_repeat", 5, 5),
      scored("listen_repeat", 0, 5, true),
      scored("interview", 0, 5, true),
      scored("interview", 0, 5, true),
    ]));
    expect(e.coverage).toEqual([
      { taskType: "listen_repeat", itemCount: 2, skippedCount: 1 },
      { taskType: "interview", itemCount: 2, skippedCount: 2 },
    ]);
  });

  describe("round-half-up on the exact value", () => {
    it("Build a Sentence 7/10, Email 2.0, Discussion 2.0 is exactly 3.75 and rounds up to 4.0", () => {
      // 1 + 5 * (0.5 * 0.7 + 0.25 * 0.4 + 0.25 * 0.4) = 3.75. In floating point the weighted sum is
      // 0.5499999…, the band 3.7499…, and it would round down to 3.5.
      expect(estimated(estimateBand("writing", writing(7, 2, 2))).band).toBe(4);
    });

    it("every official-layout Writing outcome rounds the way integer arithmetic says it should", () => {
      // With ten Build a Sentence items the band is 1 + (correct + email + discussion) / 4, so twice
      // the band in quarter-points is (8 + 2c + E + D) / 4 with E, D the essay scores in half-points.
      // Round-half-up of that is floor((10 + 2c + E + D) / 4): an exact reference, no floats.
      const wrong: string[] = [];
      for (let c = 0; c <= 10; c++) {
        for (let E = 0; E <= 10; E++) {
          for (let D = 0; D <= 10; D++) {
            const expected = Math.min(Math.max(Math.floor((10 + 2 * c + E + D) / 4) / 2, 1), 6);
            const actual = estimated(estimateBand("writing", writing(c, E / 2, D / 2))).band;
            if (actual !== expected) wrong.push(`c=${c} e=${E / 2} d=${D / 2}: ${actual} != ${expected}`);
          }
        }
      }
      expect(wrong).toEqual([]);
    });

    it("rounds a non-tie both down and up", () => {
      // 1 + (5 + 2 + 1.5) / 4 = 3.125 -> 3.0; 1 + (5 + 2.5 + 2) / 4 = 3.375 -> 3.5.
      expect(estimated(estimateBand("writing", writing(5, 2, 1.5))).band).toBe(3.0);
      expect(estimated(estimateBand("writing", writing(5, 2.5, 2))).band).toBe(3.5);
    });

    it("pins the exact-tie convention at a .25 boundary: round-half-up-toward-+Infinity", () => {
      // raw exactly 0.25 -> 1 + 1.25 = 2.25, halfway between 2.0 and 2.5 -> 2.5.
      const e = estimated(estimateBand("writing", [
        ...[1, 0, 0, 0].map((s) => scored("build_sentence", s, 1)),
        scored("email", 1.5, 5),
        scored("discussion", 1, 5),
      ]));
      expect(e.raw).toBeCloseTo(0.25);
      expect(e.band).toBe(2.5);
    });
  });

  it("clamps the band to [1, 6] even given out-of-range (defensive) input", () => {
    expect(estimated(estimateBand("writing", [scored("build_sentence", 1, 1), scored("email", 50, 5), scored("discussion", 5, 5)])).band).toBe(6);
    expect(estimated(estimateBand("writing", [scored("build_sentence", 0, 1), scored("email", -50, 5), scored("discussion", 0, 5)])).band).toBe(1);
  });

  // Pins linear-v2 to its anchor: a weight change is a new method string, so a persisted linear-v2
  // band is never silently reinterpreted.
  it("linear-v2 for speaking matches the anchor", () => {
    const e = estimated(estimateBand("speaking", [scored("listen_repeat", 5, 5), scored("interview", 2.5, 5)]));
    expect(e.raw).toBeCloseTo(9 / 11);
    expect(e.band).toBe(5.0);
    expect(e.method).toBe("linear-v2");
  });
});

describe("requiredTaskTypes / missingTaskTypes", () => {
  it("Speaking and Writing need every weighted Task Type", () => {
    expect(requiredTaskTypes("speaking", null)).toEqual(["listen_repeat", "interview"]);
    expect(requiredTaskTypes("writing", null)).toEqual(["build_sentence", "email", "discussion"]);
  });

  it("Reading and Listening need the Task Types of the Modules taken — and the Router Module alone carries all of them", () => {
    // Every routed Attempt takes the Router Module. Because it already carries every Task Type of
    // its section, a check that knows only the section (a persisted row read back without its
    // Attempt's Module Path) asks for exactly what a check that knows the path asks for. A Module
    // composition that took a Task Type out of the Router would fail here.
    for (const modulePath of [null, "lower", "upper"] as const) {
      expect(requiredTaskTypes("reading", modulePath)).toEqual([...ReadingTaskType.options]);
      expect(requiredTaskTypes("listening", modulePath)).toEqual([...ListeningTaskType.options]);
    }
  });

  it("missingTaskTypes reads a coverage list, in the section's canonical order, and ignores zero-count entries", () => {
    expect(missingTaskTypes("writing", [{ taskType: "discussion", itemCount: 1 }], null)).toEqual(["build_sentence", "email"]);
    expect(missingTaskTypes("speaking", [
      { taskType: "listen_repeat", itemCount: 0 },
      { taskType: "interview", itemCount: 4 },
    ], null)).toEqual(["listen_repeat"]);
    expect(missingTaskTypes("reading", [
      { taskType: "complete_words", itemCount: 30 },
      { taskType: "daily_life", itemCount: 10 },
      { taskType: "academic_passage", itemCount: 10 },
    ], "upper")).toEqual([]);
  });
});

describe("meanBand", () => {
  it("is ETS's mean-then-round: 5.125 reports as 5.0, an exact .25 tie rounds up", () => {
    expect(meanBand([5.5, 5, 5, 5])).toBe(5);
    expect(meanBand([6, 6, 5, 4])).toBe(5.5); // 5.25 -> 5.5
    expect(meanBand([4, 5.5])).toBe(5); // 4.75 -> 5.0
    expect(meanBand([4.5, 5, 6])).toBe(5); // 5.1666 -> 5.0
  });
});

describe("maxScoreFor", () => {
  it("is 1 for every deterministic task type (build_sentence + the seven R/L slugs)", () => {
    for (const taskType of ["build_sentence", ...ReadingTaskType.options, ...ListeningTaskType.options]) {
      expect(maxScoreFor(taskType)).toBe(1);
    }
  });

  it("is 5 for every judged task type", () => {
    for (const taskType of ["listen_repeat", "interview", "email", "discussion"]) {
      expect(maxScoreFor(taskType)).toBe(5);
    }
  });
});

describe("estimateBandTable3", () => {
  const band = (section: "reading" | "listening", correct: number, total: number, modulePath: "lower" | "upper" = "upper") =>
    estimated(estimateBandTable3(section, rlItems(section, correct, total), { modulePath })).band;

  it("reads bands off the official tables", () => {
    // 20/32 = 0.625 -> scaled 18.75 -> 19 -> reading band 4.0
    expect(band("reading", 20, 32)).toBe(4);
    expect(band("reading", 30, 30)).toBe(6);
    // listening boundary: 17/30 -> 4; 16/30 -> 3.5
    expect(band("listening", 17, 30)).toBe(4);
    expect(band("listening", 16, 30)).toBe(3.5);
  });

  it("rounds the 0-30 projection half up", () => {
    // 23/60 * 30 = 11.5 exactly -> 12, the floor of reading's 3.5 row; 22/60 * 30 = 11 -> 3.0.
    expect(band("reading", 23, 60)).toBe(3.5);
    expect(band("reading", 22, 60)).toBe(3);
  });

  it("caps lower-path attempts at LOWER_PATH_BAND_CAP", () => {
    const e = estimated(estimateBandTable3("reading", rlItems("reading", 30, 30), { modulePath: "lower" }));
    expect(e.band).toBe(4.5);
    expect(e.method).toBe("table3-v1");
    expect(LOWER_PATH_BAND_CAP).toBe(4.5);
  });

  it("does not cap an upper-path attempt, nor a lower-path one already under the cap", () => {
    expect(band("reading", 30, 30, "upper")).toBe(6);
    expect(band("reading", 18, 30, "lower")).toBe(4);
  });

  it("reports raw as the 0-1 percent-correct, not the intermediate 0-30 scaled value", () => {
    expect(estimated(estimateBandTable3("reading", rlItems("reading", 15, 30), { modulePath: "upper" })).raw).toBeCloseTo(0.5);
  });

  it("names the missing Task Types instead of reading a band off part of the Modules taken", () => {
    const result = estimateBandTable3("reading", [
      scored("complete_words", 1, 1),
      scored("daily_life", 1, 1),
    ], { modulePath: "upper" });
    expect(result).toEqual({
      status: "incomplete",
      method: "table3-v1",
      missingTaskTypes: ["academic_passage"],
      coverage: [
        { taskType: "complete_words", itemCount: 1, skippedCount: 0 },
        { taskType: "daily_life", itemCount: 1, skippedCount: 0 },
      ],
    });
  });

  it("nothing scoreable is every Task Type missing", () => {
    expect(estimateBandTable3("reading", [], { modulePath: "upper" })).toMatchObject({
      status: "incomplete",
      missingTaskTypes: ["complete_words", "daily_life", "academic_passage"],
    });
    expect(estimateBandTable3("reading", [scored("daily_life", 0, 0)], { modulePath: "upper" })).toMatchObject({
      status: "incomplete",
      coverage: [],
    });
  });

  it("groups coverage by Task Type in the section's canonical order, regardless of input order", () => {
    const e = estimated(estimateBandTable3("reading", [
      scored("academic_passage", 1, 1),
      scored("complete_words", 1, 1),
      scored("academic_passage", 0, 1),
      scored("daily_life", 1, 1),
    ], { modulePath: "upper" }));
    expect(e.coverage).toEqual([
      { taskType: "complete_words", itemCount: 1, skippedCount: 0 },
      { taskType: "daily_life", itemCount: 1, skippedCount: 0 },
      { taskType: "academic_passage", itemCount: 2, skippedCount: 0 },
    ]);
  });

  it("appends any Task Type outside the section's canonical list alphabetically (defensive)", () => {
    const e = estimated(estimateBandTable3("reading", [
      scored("zzz_unexpected", 1, 1),
      ...rlItems("reading", 3, 3),
      scored("aaa_unexpected", 1, 1),
    ], { modulePath: "upper" }));
    expect(e.coverage.map((c) => c.taskType)).toEqual([
      "complete_words", "daily_life", "academic_passage", "aaa_unexpected", "zzz_unexpected",
    ]);
  });

  // Every boundary from both official Table 3 tables, transcribed independently of the
  // implementation's TABLE3 constant so a transcription bug there still fails here. total=30 makes
  // scaled === correct exactly, isolating the lookup from the scaling.
  const READING_ROWS: Array<{ minScaled: number; band: number }> = [
    { minScaled: 29, band: 6 },
    { minScaled: 27, band: 5.5 },
    { minScaled: 24, band: 5 },
    { minScaled: 22, band: 4.5 },
    { minScaled: 18, band: 4 },
    { minScaled: 12, band: 3.5 },
    { minScaled: 6, band: 3 },
    { minScaled: 4, band: 2.5 },
    { minScaled: 3, band: 2 },
    { minScaled: 2, band: 1.5 },
    { minScaled: 0, band: 1 },
  ];
  const LISTENING_ROWS: Array<{ minScaled: number; band: number }> = [
    { minScaled: 28, band: 6 },
    { minScaled: 26, band: 5.5 },
    { minScaled: 22, band: 5 },
    { minScaled: 20, band: 4.5 },
    { minScaled: 17, band: 4 },
    { minScaled: 13, band: 3.5 },
    { minScaled: 9, band: 3 },
    { minScaled: 6, band: 2.5 },
    { minScaled: 4, band: 2 },
    { minScaled: 2, band: 1.5 },
    { minScaled: 0, band: 1 },
  ];

  describe.each([
    ["reading", READING_ROWS] as const,
    ["listening", LISTENING_ROWS] as const,
  ])("%s — all 11 official Table 3 rows", (section, rows) => {
    it.each(rows.map((r) => [r.minScaled, r.band] as const))("scaled=%d (row floor) -> band %s", (minScaled, expected) => {
      expect(band(section, minScaled, 30)).toBe(expected);
    });

    it.each(rows.slice(0, -1).map((r, i) => [r.minScaled - 1, rows[i + 1].band] as const))(
      "scaled=%d (one below the row floor) -> the next row down's band %s",
      (scaled, expected) => {
        expect(band(section, scaled, 30)).toBe(expected);
      },
    );
  });
});
