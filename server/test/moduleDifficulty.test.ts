import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AnySetSchema, type ListeningSet, type ReadingSet } from "@toefl-prep/shared";
import {
  academicPassageBandDetail,
  compareListeningModuleDifficulty,
  compareReadingModuleDifficulty,
  estimateSyllables,
  listeningModuleText,
  moduleBandDetail,
  moduleDifficultyDetail,
  READING_MODULE_GRADE_BANDS,
  readingModuleBandVerdict,
  readingModuleText,
  textBandVerdict,
  textDifficulty,
  UPPER_MODULE_HARDER_RETRY,
} from "../src/services/moduleDifficulty.js";
import { blocksGeneration, classifyGenerationCheck } from "../src/services/generationCheckPolicy.js";
import { config } from "../src/lib/config.js";

// This file's copy of the seeded bank (global-setup.ts), not data/ itself, so untracked Sets there
// do not change what this asserts.
const BANK = path.join(config.dataDir, "question-sets");

function publishedSets<T>(kind: "reading" | "listening"): T[] {
  const dir = path.join(BANK, kind);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => AnySetSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"))) as T);
}

const SIMPLE = "The dog ran. The cat sat. We ate. It was fun. I go now.";
const COMPLEX =
  "The systematic reconsideration of institutional methodology, particularly where the underlying " +
  "epistemological assumptions remain substantially uninterrogated, necessitates a correspondingly " +
  "comprehensive re-evaluation of the accumulated evidentiary foundations.";

describe("the difficulty index", () => {
  it("rates dense, long-sentenced prose above short simple prose", () => {
    expect(textDifficulty([COMPLEX]).grade).toBeGreaterThan(textDifficulty([SIMPLE]).grade);
  });

  it("counts syllables by vowel group, discounting a silent trailing e", () => {
    expect(estimateSyllables("make")).toBe(1);
    expect(estimateSyllables("methodology")).toBe(5);
    expect(estimateSyllables("a")).toBe(1);
    // A number is a word to the word counter, so it must not score zero syllables, or whichever
    // module mentions more numbers would rate easier for a reason that is not difficulty.
    expect(estimateSyllables("1950")).toBe(1);
    // Nothing in it at all gets nothing. Unreachable through the word regex; asserted anyway.
    expect(estimateSyllables("!!!")).toBe(0);
  });

  it("returns a real number for empty text rather than NaN", () => {
    // A NaN grade compares false against everything, which would silently fail every Set.
    const empty = textDifficulty([]);
    expect(Number.isNaN(empty.grade)).toBe(false);
    expect(empty.grade).toBe(0);
    expect(textDifficulty(["", "  "]).grade).toBe(0);
  });

  it("is exercisable with no live model call", () => {
    // Why the measure is deterministic rather than Verifier-backed.
    expect(
      compareListeningModuleDifficulty({
        lowerModule: emptyListeningModule(SIMPLE),
        upperModule: emptyListeningModule(COMPLEX),
      }).upperIsHarder,
    ).toBe(true);
  });
});

function emptyListeningModule(transcript: string) {
  return {
    timeLimitSec: 300,
    listenChoose: [],
    conversations: [],
    announcements: [
      {
        id: "an-1",
        taskType: "announcement" as const,
        audio: "",
        setting: "",
        speaker: { id: "s1", role: "", gender: "female" as const, accent: "north-american" as const, voice: "v", provider: "gemini" as const },
        transcript,
        questions: [],
      },
    ],
    academicTalks: [],
  };
}

describe("what a module's difficulty is measured over", () => {
  it("uses a Listening module's spoken text and not its questions or Explanations", () => {
    const module = emptyListeningModule("Attention students. The library closes early today.");
    expect(listeningModuleText(module)).toEqual(["Attention students. The library closes early today."]);
  });

  it("uses a Reading module's passages, including the ungapped CtW source paragraph", () => {
    const texts = readingModuleText({
      ctwPassages: [
        { id: "c1", taskType: "complete_words", topic: "t", segments: [], gaps: [], sourceParagraph: "CTW SOURCE" } as never,
      ],
      dailyLife: [{ id: "d1", taskType: "daily_life", genre: "notice", text: "DAILY", questions: [] } as never],
      academic: [{ id: "a1", taskType: "academic_passage", title: "T", discipline: "D", text: "ACADEMIC", questions: [] } as never],
    });
    expect(texts).toEqual(["CTW SOURCE", "DAILY", "ACADEMIC"]);
  });
});

describe("every Set already in the bank has an Upper Module harder than its Lower", () => {
  // A gate that fails the content that already exists is not a gate, it is an outage. These are the
  // only real Reading and Listening Sets there are, so this is the whole population.
  it("passes every published Reading Set", () => {
    const sets = publishedSets<ReadingSet>("reading").filter((set) => set.kind === "reading");
    expect(sets.length).toBeGreaterThan(0);
    for (const set of sets) {
      expect(compareReadingModuleDifficulty(set).upperIsHarder, set.id).toBe(true);
    }
  });

  it("passes every published Listening Set", () => {
    const sets = publishedSets<ListeningSet>("listening").filter((set) => set.kind === "listening");
    expect(sets.length).toBeGreaterThan(0);
    for (const set of sets) {
      expect(compareListeningModuleDifficulty(set).upperIsHarder, set.id).toBe(true);
    }
  });

  it("fails a Set whose modules are swapped — the check is not vacuous", () => {
    for (const set of publishedSets<ReadingSet>("reading").filter((s) => s.kind === "reading")) {
      const swapped = { lowerModule: set.upperModule, upperModule: set.lowerModule };
      expect(compareReadingModuleDifficulty(swapped).upperIsHarder, set.id).toBe(false);
    }
    for (const set of publishedSets<ListeningSet>("listening").filter((s) => s.kind === "listening")) {
      const swapped = { lowerModule: set.upperModule, upperModule: set.lowerModule };
      expect(compareListeningModuleDifficulty(swapped).upperIsHarder, set.id).toBe(false);
    }
  });
});

describe("the failure is fatal, and says so in numbers only", () => {
  it("is the one conformance check the policy still blocks on", () => {
    for (const section of ["reading", "listening"] as const) {
      expect(classifyGenerationCheck({ family: "module-difficulty", section }).tier).toBe("fatal");
      expect(blocksGeneration({ family: "module-difficulty", section })).toBe(true);
    }
  });

  it("reports grades and counts, never a word of the module's own prose", () => {
    const detail = moduleDifficultyDetail(
      compareListeningModuleDifficulty({
        lowerModule: emptyListeningModule(COMPLEX),
        upperModule: emptyListeningModule(SIMPLE),
      }),
    );
    expect(detail).toContain("upper module reads no harder than lower");
    expect(detail).toContain("grade");
    expect(detail).not.toContain("epistemological");
    expect(detail).not.toContain("dog");
  });

  it("tells a retry what to change without showing it the number it is graded on", () => {
    expect(UPPER_MODULE_HARDER_RETRY).toContain("no harder to understand");
    // Gate-only, exactly like EXPLANATION_HARD_LIMIT_CODE_POINTS: a model shown the index optimises
    // the index rather than writing genuinely harder prose.
    expect(UPPER_MODULE_HARDER_RETRY).not.toMatch(/\d/u);
    expect(UPPER_MODULE_HARDER_RETRY.toLowerCase()).not.toContain("grade");
    expect(UPPER_MODULE_HARDER_RETRY.toLowerCase()).not.toContain("syllable");
  });
});

// Absolute grade bands per Reading module: an advisory check, separate from the fatal relative
// ordering above.

/**
 * Grades measured with this file's own index, so the fixtures say what they are:
 *
 *   BELOW_ANY_BAND  -0.75  under the lowerModule floor (4.0)
 *   MEDIUM_PROSE     8.60  inside medium (7.4-10.5)
 *   HIGH_PROSE      14.90  inside high (10.5-20.0)
 *   COMPLEX         35.70  over the high ceiling (20.0) — declared at the top of this file
 */
const BELOW_ANY_BAND =
  "The store opens at nine. It closes at six. We sell bread and milk. Come see us. The staff can " +
  "help you. Parking is free.";
const MEDIUM_PROSE =
  "The city council opened a new library branch near the river last spring. Residents can borrow " +
  "books, join a reading group, or use the study rooms on the second floor. Staff report that " +
  "afternoon visits have doubled since the branch began offering free tutoring for local students.";
const HIGH_PROSE =
  "The sediment record appears continuous, but the intervals separating successive volcanic layers " +
  "imply a depositional break. That break complicates any simple chronological reading of the sequence.";

/** The structural minimum readingModuleText reads — one academic passage carrying the whole text. */
function readingModuleOf(text: string) {
  return { ctwPassages: [], dailyLife: [], academic: [{ text }] };
}

describe("each Reading module against its own absolute band", () => {
  it("encodes ETS's published medium and high bands, and one documented [ours] floor", () => {
    // The Router Module is moderate only: it gets the medium band, both ends.
    expect(READING_MODULE_GRADE_BANDS.router).toMatchObject({ min: 7.4, max: 10.5 });
    // Upper is the high band. Its floor is the medium ceiling, so the two bands meet rather than
    // leaving a gap no module could legally occupy.
    expect(READING_MODULE_GRADE_BANDS.upperModule).toMatchObject({ min: 10.5, max: 20.0 });
    expect(READING_MODULE_GRADE_BANDS.upperModule.min).toBe(READING_MODULE_GRADE_BANDS.router.max);
    // "At or below medium": ETS publishes no band under medium, so the ceiling is ETS's and the
    // floor is ours. See READING_MODULE_GRADE_BANDS' own derivation.
    expect(READING_MODULE_GRADE_BANDS.lowerModule).toMatchObject({ min: 4.0, max: 10.5 });
    expect(READING_MODULE_GRADE_BANDS.lowerModule.max).toBe(READING_MODULE_GRADE_BANDS.router.max);
  });

  it("stays quiet on a module sitting inside its own band", () => {
    expect(readingModuleBandVerdict("router", readingModuleOf(MEDIUM_PROSE))?.placement).toBe("in-band");
    expect(readingModuleBandVerdict("lowerModule", readingModuleOf(MEDIUM_PROSE))?.placement).toBe("in-band");
    expect(readingModuleBandVerdict("upperModule", readingModuleOf(HIGH_PROSE))?.placement).toBe("in-band");
  });

  // "Moderate only" is a range, not a floor, so a router is flagged on either side of it.
  it("flags a router that reads harder than moderate, and one that reads easier", () => {
    expect(readingModuleBandVerdict("router", readingModuleOf(HIGH_PROSE))?.placement).toBe("above-band");
    expect(readingModuleBandVerdict("router", readingModuleOf(BELOW_ANY_BAND))?.placement).toBe("below-band");
  });

  // A banked Lower Module measures FK 12.14, inside the high band: the case this flag exists for.
  it("flags a lower module that reads as high difficulty", () => {
    expect(readingModuleBandVerdict("lowerModule", readingModuleOf(HIGH_PROSE))?.placement).toBe("above-band");
  });

  it("flags a lower module that has fallen under the documented [ours] floor", () => {
    expect(readingModuleBandVerdict("lowerModule", readingModuleOf(BELOW_ANY_BAND))?.placement).toBe("below-band");
  });

  // An Upper Module that never reached the high band is as far out of design as a Lower Module that
  // overshot it, and the relative gate cannot see it: a Set whose Upper Module reads 9.0 against a
  // Lower Module at 8.0 satisfies `upperIsHarder` while neither module is where ETS puts it.
  it("flags an upper module that never left the medium band, which the relative gate cannot see", () => {
    expect(readingModuleBandVerdict("upperModule", readingModuleOf(MEDIUM_PROSE))?.placement).toBe("below-band");
    expect(
      compareReadingModuleDifficulty({
        lowerModule: readingModuleOf(BELOW_ANY_BAND),
        upperModule: readingModuleOf(MEDIUM_PROSE),
      }).upperIsHarder,
    ).toBe(true);
  });

  it("flags an upper module past the top of the high band", () => {
    expect(readingModuleBandVerdict("upperModule", readingModuleOf(COMPLEX))?.placement).toBe("above-band");
  });

  // A wordless module is already a fatal `composition` violation, and textDifficulty's grade-0 floor
  // there is a divide-by-zero guard rather than a measurement. Reporting it as "below band" would be
  // a second, noisier account of a defect the fatal gate has caught — and, because every direct
  // readingContentViolations test in generator.reading.test.ts builds empty modules for the two it is
  // not exercising, it would also flood every one of those with band violations.
  it("measures nothing at all for a module with no text", () => {
    expect(readingModuleBandVerdict("router", { ctwPassages: [], dailyLife: [], academic: [] })).toBeUndefined();
  });

  it("reports grades, counts and band edges — never a word of the module's own prose", () => {
    const detail = moduleBandDetail(readingModuleBandVerdict("router", readingModuleOf(HIGH_PROSE))!);
    expect(detail).toContain("above the router band 7.4-10.5");
    expect(detail).toContain("(medium, TextEvaluator 800-1100)");
    expect(detail).toContain("grade 14.90");
    expect(detail).not.toContain("sediment");
    expect(detail).not.toContain("volcanic");
  });

  it("is advisory, and never blocks a job — unlike the relative gate beside it", () => {
    const check = { family: "content-gate", section: "reading", kind: "module-difficulty-band" } as const;
    expect(classifyGenerationCheck(check).tier).toBe("advisory");
    expect(blocksGeneration(check)).toBe(false);
    // The relative ordering stays the one fatal conformance check.
    expect(blocksGeneration({ family: "module-difficulty", section: "reading" })).toBe(true);
  });

  // "A gate that fails the content that already exists is not a gate, it is an outage", the rule
  // stated above, has a deliberate exception at the ceiling: banked routers measure FK 8.88-12.47
  // (three of five over the medium ceiling) and one Lower Module 12.14, and adopting ETS's design
  // means saying so. Nothing re-gates a published Set (the check runs at generation only), so the
  // bank is unaffected.
  //
  // The floor is different, because 4.0 is ours to choose: one that condemned a banked module would
  // be exactly that outage. The easiest Lower Module in the bank measures 4.48.
  it("clears every published lower module over the [ours] floor", () => {
    const sets = publishedSets<ReadingSet>("reading").filter((set) => set.kind === "reading");
    expect(sets.length).toBeGreaterThan(0);
    for (const set of sets) {
      expect(
        textDifficulty(readingModuleText(set.lowerModule)).grade,
        set.id,
      ).toBeGreaterThanOrEqual(READING_MODULE_GRADE_BANDS.lowerModule.min);
    }
  });
});

/**
 * The same index and the same bands, read over one academic passage.
 *
 * The function under test is `textBandVerdict`, shared with the CtW paragraph block below: the two
 * granularities belong to the caller, not the measurement, so each keeps its own suite while one
 * implementation serves both.
 *
 * Grades of the fixtures used below, by this repo's own index: MEDIUM_PROSE 8.60, HIGH_PROSE 14.90,
 * COMPLEX 35.70, BELOW_ANY_BAND -0.75.
 */
describe("each academic passage against its own module's band", () => {
  it("holds a passage to its module's row, never to a per-passage table of its own", () => {
    // No second, looser threshold exists for the model to drift toward. Identity, not equality:
    // there is one table.
    for (const module of ["router", "lowerModule", "upperModule"] as const) {
      expect(textBandVerdict(module, HIGH_PROSE)?.band).toBe(READING_MODULE_GRADE_BANDS[module]);
    }
  });

  it("stays quiet on a passage sitting inside its module's band", () => {
    expect(textBandVerdict("router", MEDIUM_PROSE)?.placement).toBe("in-band");
    expect(textBandVerdict("lowerModule", MEDIUM_PROSE)?.placement).toBe("in-band");
    expect(textBandVerdict("upperModule", HIGH_PROSE)?.placement).toBe("in-band");
  });

  it("flags a router or lower-module passage that reads as high difficulty, and one under the floor", () => {
    expect(textBandVerdict("router", HIGH_PROSE)?.placement).toBe("above-band");
    expect(textBandVerdict("lowerModule", COMPLEX)?.placement).toBe("above-band");
    expect(textBandVerdict("lowerModule", BELOW_ANY_BAND)?.placement).toBe("below-band");
  });

  // The failure this check exists for. `readingModuleText` pools CtW, Daily Life and academic
  // prose, so a dense CtW paragraph can carry a whole Upper Module over the high floor while its
  // academic passage (the Task Type ETS puts at B1-C2, the widest span of the three) never left
  // medium.
  // Here the pooled module measures 10.79 (in band) and its academic passage 8.60 (below it).
  it("sees an off-band passage the pooled per-module measure cannot", () => {
    const upperModule = {
      ctwPassages: [{ sourceParagraph: HIGH_PROSE }],
      dailyLife: [],
      academic: [{ text: MEDIUM_PROSE }],
    };
    expect(readingModuleBandVerdict("upperModule", upperModule)?.placement).toBe("in-band");
    expect(textBandVerdict("upperModule", MEDIUM_PROSE)?.placement).toBe("below-band");
  });

  // Same reason readingModuleBandVerdict skips a wordless module: an empty passage is already a
  // fatal `word-count` violation, and grade 0 over zero words is textDifficulty's divide-by-zero
  // floor rather than a measurement.
  it("measures nothing at all for a passage with no words", () => {
    expect(textBandVerdict("router", "")).toBeUndefined();
    expect(textBandVerdict("router", "   ")).toBeUndefined();
  });

  it("names the unit, the grade and the band edges — never a word of the passage's own prose", () => {
    const detail = academicPassageBandDetail(textBandVerdict("router", HIGH_PROSE)!);
    expect(detail).toMatch(/^academic passage reads grade 14\.90/u);
    expect(detail).toContain("above the router band 7.4-10.5");
    expect(detail).toContain("(medium, TextEvaluator 800-1100)");
    expect(detail).not.toContain("sediment");
    expect(detail).not.toContain("volcanic");
  });

  it("is advisory, and never blocks a job — exactly like the per-module band beside it", () => {
    const check = { family: "content-gate", section: "reading", kind: "passage-difficulty-band" } as const;
    expect(classifyGenerationCheck(check).tier).toBe("advisory");
    expect(blocksGeneration(check)).toBe(false);
  });
});

// The same bands, one CtW source paragraph at a time.

/**
 * The prose fixtures above are reused verbatim as "paragraphs": textBandVerdict takes a bare
 * string and measures nothing but its grade, so a fixture's word count is irrelevant here (the 70-100
 * word budget is a separate, unrelated bound in readingGenerator's own gate).
 */
describe("each CtW source paragraph against its own module's band", () => {
  it("introduces no per-paragraph number: the bands are READING_MODULE_GRADE_BANDS unchanged", () => {
    for (const module of ["router", "lowerModule", "upperModule"] as const) {
      expect(textBandVerdict(module, MEDIUM_PROSE)?.band).toBe(
        READING_MODULE_GRADE_BANDS[module],
      );
    }
  });

  // Why the check exists at this granularity. The router module below pools to FK 9.93, inside
  // medium, so readingModuleBandVerdict says nothing, while the CtW paragraph carrying ten of its
  // Items reads 14.90, a full band above where it belongs.
  it("sees an out-of-band paragraph inside a module whose POOLED text is in band", () => {
    const module = {
      ctwPassages: [{ sourceParagraph: HIGH_PROSE }],
      dailyLife: [{ text: MEDIUM_PROSE }],
      academic: [{ text: MEDIUM_PROSE }],
    };
    expect(readingModuleBandVerdict("router", module)?.placement).toBe("in-band");
    expect(textBandVerdict("router", HIGH_PROSE)?.placement).toBe("above-band");
  });

  // ETS writes the Upper Module's paragraph at the register of an adapted authentic source, so a
  // paragraph that never left the medium band is the failure to catch.
  it("flags an upper-module paragraph that never left the medium band", () => {
    expect(textBandVerdict("upperModule", MEDIUM_PROSE)?.placement).toBe("below-band");
    expect(textBandVerdict("upperModule", HIGH_PROSE)?.placement).toBe("in-band");
  });

  it("holds the router to moderate and the lower module to at-or-below-moderate", () => {
    expect(textBandVerdict("router", MEDIUM_PROSE)?.placement).toBe("in-band");
    expect(textBandVerdict("router", HIGH_PROSE)?.placement).toBe("above-band");
    expect(textBandVerdict("router", BELOW_ANY_BAND)?.placement).toBe("below-band");
    expect(textBandVerdict("lowerModule", MEDIUM_PROSE)?.placement).toBe("in-band");
    expect(textBandVerdict("lowerModule", HIGH_PROSE)?.placement).toBe("above-band");
  });

  // Same rule as the module-level check: a measurement of nothing is not a measurement. An empty
  // paragraph is already a schema failure (`sourceParagraph` is `.min(1)`), so reporting it as
  // "below band" would only add noise to a defect that was caught long before this.
  it("measures nothing at all for a paragraph with no words", () => {
    expect(textBandVerdict("upperModule", "")).toBeUndefined();
    expect(textBandVerdict("upperModule", "   ")).toBeUndefined();
  });

  // The tier is load-bearing: a 70-100 word paragraph is a much smaller sample than a module, so the
  // index is noisier on it. That is affordable only while the outcome is a note.
  it("is advisory, and never blocks a job", () => {
    const check = {
      family: "content-gate",
      section: "reading",
      kind: "ctw-paragraph-difficulty-band",
    } as const;
    expect(classifyGenerationCheck(check).tier).toBe("advisory");
    expect(blocksGeneration(check)).toBe(false);
  });
});

/**
 * Every bound in READING_MODULE_GRADE_BANDS is stated verbatim in the Reading generation guide's
 * difficulty tables, one per module and one per academic passage. Retuning a band without
 * republishing it, or publishing a number the gate does not enforce, fails here.
 */
describe("the guide's difficulty tables state exactly the band constants", () => {
  const guideMd = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../.claude/skills/toefl-reading/references/generation-guide.md"),
    "utf8",
  );

  it("every published Flesch-Kincaid range, per module and per academic passage, is that band's own numbers", () => {
    // Any table row whose first cell names a module and whose last cell is an en-dashed range.
    const published = new Map<string, string[]>();
    for (const line of guideMd.split("\n")) {
      const row = /^\|\s*`(router|lowerModule|upperModule)`[^|]*\|.*\|\s*([0-9.]+–[0-9.]+)\s*\|\s*$/u.exec(line);
      if (!row) continue;
      published.set(row[1]!, [...(published.get(row[1]!) ?? []), row[2]!]);
    }
    for (const [module, band] of Object.entries(READING_MODULE_GRADE_BANDS)) {
      const rows = published.get(module);
      expect(rows, `${module} has no Flesch-Kincaid row in the generation guide`).toBeDefined();
      // Two rows per module. The count is a floor so a third table would not fail here, but every row
      // that exists carries this band, digit for digit.
      expect(rows!.length, `${module} is published in fewer places than expected`).toBeGreaterThanOrEqual(2);
      for (const range of rows!) {
        expect(range, `${module}'s published range`).toBe(`${band.min.toFixed(1)}–${band.max.toFixed(1)}`);
      }
    }
  });
});
