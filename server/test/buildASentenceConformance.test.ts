import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AnySetSchema, type WritingSet } from "@toefl-prep/shared";
import { config } from "../src/lib/config.js";
import {
  BUILD_A_SENTENCE_TILE_MAX,
  BUILD_A_SENTENCE_TILE_MIN,
  BUILD_A_SENTENCE_TILE_RAMP_FLOOR,
  buildASentenceViolations,
  type BuildASentenceViolation,
} from "../src/services/buildASentenceConformance.js";

// The reference Item: this project's own, in the shape of the one Item ETS publishes. Read from disk
// rather than inlined so the fixture stays the single copy every consumer checks against
// (sentenceFrame.test.ts reads the same file). Six blanks, seven tiles, one distractor: it must pass
// every check below.
const REFERENCE_ITEM = (JSON.parse(fs.readFileSync(
  path.join(config.projectRoot, "server/test/fixtures/build-a-sentence-reference-item.json"),
  "utf8",
)) as { item: BuildASentenceItem }).item;

// The three frame shapes the real exam uses (docs/adr/0009): a frame that begins with a blank, a
// frame that is nothing but blanks and the final period, and the conventional fixed-opening frame
// as the control. Hand-authored, and read from disk for the same reason as the reference Item: one
// copy, checked by the gate here and by the scorer in sentenceScorer.test.ts.
const REORDER_SHAPES = (JSON.parse(fs.readFileSync(
  path.join(config.projectRoot, "server/test/fixtures/build-a-sentence-reorder-shapes.json"),
  "utf8",
)) as { items: BuildASentenceItem[] }).items;

const shape = (id: string): BuildASentenceItem => {
  const found = REORDER_SHAPES.find((item) => item.id === id);
  if (!found) throw new Error(`reorder-shapes fixture has no item ${id}`);
  return found;
};

type BuildASentenceItem = {
  id: string;
  prompt: string;
  frame?: string;
  tiles: string[];
  answers: string[][];
};

/** A conforming Item that is not the reference one: six tiles, five blanks, one distractor. */
const CONFORMING_ITEM: BuildASentenceItem = {
  id: "bs1",
  prompt: "Why were you late?",
  frame: "The ___ ___ ___ ___ ___ this morning.",
  tiles: ["bus", "train", "broke down", "on my", "way here", "arrived"],
  answers: [["bus", "broke down", "on my", "way here", "train"]],
};

const itemWith = (overrides: Partial<BuildASentenceItem>): BuildASentenceItem =>
  ({ ...CONFORMING_ITEM, ...overrides });

/** A whole Writing Set built from one Item, repeated to the ten a Set carries. */
const setWith = (item: BuildASentenceItem): WritingSet => AnySetSchema.parse({
  id: "wri-conf1", kind: "writing", source: "generated", createdAt: "2026-08-22T00:00:00Z",
  buildASentence: { items: Array.from({ length: 10 }, (_, i) => ({ ...item, id: `bs${i + 1}` })) },
  email: {
    id: "em1", scenario: "s", to: "t@u.edu", subject: "x",
    bullets: ["1", "2", "3"], timeLimitSec: 420, wordGuidance: { min: 80, max: 120 },
  },
  academicDiscussion: {
    id: "ad1", courseTitle: "c", professorName: "p", professorPost: "q",
    studentPosts: [{ name: "A", post: "y" }, { name: "B", post: "n" }],
    timeLimitSec: 600, minWords: 100,
  },
}) as WritingSet;

/** Every violation the checker reports for one Item, wrapped in a Set on its own. */
const violationsOf = (item: BuildASentenceItem): BuildASentenceViolation[] =>
  buildASentenceViolations({ buildASentence: { items: [item] } });

const kindsOf = (item: BuildASentenceItem): string[] =>
  violationsOf(item).map((violation) => violation.kind);

describe("buildASentenceViolations — the conforming cases", () => {
  it("passes the reference Item, unchanged", () => {
    // Any rule that rejects an Item of the one shape ETS published is the wrong rule.
    expect(kindsOf(REFERENCE_ITEM)).toEqual([]);
  });

  it("passes a conforming Set of ten Items", () => {
    expect(buildASentenceViolations(setWith(CONFORMING_ITEM))).toEqual([]);
  });

  it("passes an Item whose blanks are written as longer underscore runs", () => {
    // parseSentenceFrame reads any run of three or more as one blank; the arithmetic must agree.
    expect(kindsOf(itemWith({ frame: "The ______ ______ ______ ______ ______ this morning." })))
      .toEqual([]);
  });

  it("passes an Item that legitimately repeats a tile in one answer", () => {
    expect(kindsOf(itemWith({
      frame: "I ___ ___ ___ ___ ___ tomorrow.",
      tiles: ["want", "to", "to", "go", "back", "went"],
      answers: [["want", "to", "go", "back", "to"]],
    }))).toEqual([]);
  });
});

// The one Item ETS publishes fixes words in its frame, but the task is a reorder: ETS's technical
// manual (RR-25-12, II-5) describes words or phrases in the wrong order that the User moves to
// form a grammatical sentence, and the real exam blanks the start, blanks most of the sentence
// and draws every tile lowercase. A frame need fix no word at all (docs/adr/0009).
describe("buildASentenceViolations — the reorder shapes the real exam uses", () => {
  it("passes all three hand-authored shapes, unchanged", () => {
    for (const item of REORDER_SHAPES) {
      expect(kindsOf(item), item.id).toEqual([]);
    }
  });

  it("passes a whole Set built from the full-reorder shape", () => {
    expect(buildASentenceViolations(setWith(shape("bas-full-reorder")))).toEqual([]);
  });

  it("passes a frame that BEGINS with a blank, so the sentence's first word is a tile", () => {
    expect(shape("bas-start-blanked").frame).toMatch(/^___/);
    expect(kindsOf(shape("bas-start-blanked"))).toEqual([]);
  });

  it("passes a frame that is nothing but blanks and the sentence-final punctuation", () => {
    // A full reorder is the end state of the generation guide's ramp, not a degenerate Item.
    expect(kindsOf(itemWith({
      frame: "___ ___ ___ ___ ___.",
      tiles: ["bus", "train", "broke down", "on my", "way here", "arrived"],
      answers: [["bus", "broke down", "on my", "way here", "train"]],
    }))).toEqual([]);

    // Same for a frame whose only literal text is punctuation and spacing.
    expect(kindsOf(itemWith({ frame: "___, ___ ___ ___ ___!" }))).toEqual([]);
  });
});

describe("buildASentenceViolations — a frame is present and non-empty", () => {
  it("rejects an Item with no frame at all", () => {
    const { frame: _dropped, ...frameless } = CONFORMING_ITEM;
    expect(kindsOf(frameless as BuildASentenceItem)).toEqual(["frame-missing"]);
  });

  it("rejects a frame that is only whitespace", () => {
    expect(kindsOf(itemWith({ frame: "   \n " }))).toEqual(["frame-missing"]);
  });

  it("rejects a frame that cannot be parsed into blanks, without throwing", () => {
    // Defence in depth: BuildASentenceItemSchema already refuses these, so reaching one here means
    // the checker was handed an unparsed Item. It must still report rather than throw.
    expect(kindsOf(itemWith({ frame: "The bus broke down this morning." })))
      .toEqual(["frame-unparseable"]);
    expect(kindsOf(itemWith({ frame: "The __ ___ ___ ___ ___ this morning." })))
      .toEqual(["frame-unparseable"]);
  });

  it("still reports the tile-side defects of an Item whose frame is missing", () => {
    // A missing frame makes the blank count unknown, but the checks that do not need it still run,
    // so a regeneration prompt can name every defect at once.
    const { frame: _dropped, ...frameless } = CONFORMING_ITEM;
    expect(kindsOf({ ...frameless, tiles: ["Bus", "train", "broke down", "on my", "way here."] } as BuildASentenceItem))
      .toEqual(expect.arrayContaining(["frame-missing", "tile-initial-capital", "tile-final-punctuation"]));
  });
});

describe("buildASentenceViolations — 4 to 10 tiles", () => {
  // Three tiles leave two blanks, and the schema needs three tokens in an answer, so a three-tile
  // Item has no legal form: the floor of four is the format's own arithmetic.
  it("rejects fewer than four tiles", () => {
    expect(kindsOf(itemWith({
      frame: "The ___ ___ this morning.",
      tiles: ["bus", "broke down", "on my"],
      answers: [["bus", "broke down"]],
    }))).toEqual(["tile-count"]);
  });

  // The ceiling is ten, not the seven of ETS's one sample Item: the real exam blanks far more of the
  // sentence than seven tiles can express.
  it("rejects more than ten tiles", () => {
    expect(kindsOf(itemWith({
      frame: "___ ___ ___ ___ ___ ___ ___ ___ ___ ___.",
      tiles: [
        "our", "professor", "extended", "the", "deadline",
        "by", "another", "two", "weeks", "again", "extending",
      ],
      answers: [[
        "our", "professor", "extended", "the", "deadline",
        "by", "another", "two", "weeks", "again",
      ]],
    }))).toEqual(["tile-count"]);
  });

  // The gate accepts four, below the guide's floor of five, because banked Items use it: a short
  // sentence like "Daniel wrote it." has no legal form at five, and forcing one produces
  // single-word tiles that test word order, not grammar.
  it("accepts both ends of the range", () => {
    expect(kindsOf(itemWith({
      frame: "The ___ ___ ___ this morning.",
      tiles: ["bus", "broke down", "on my", "way here"],
      answers: [["bus", "broke down", "on my"]],
    }))).toEqual([]);
    expect(kindsOf(shape("bas-full-reorder"))).toEqual([]); // ten
  });

  it("accepts the upper counts, 8, 9 and 10 tiles", () => {
    for (const tileCount of [8, 9, 10]) {
      const tiles = Array.from({ length: tileCount }, (_, i) => `w${i}`);
      expect(kindsOf(itemWith({
        frame: `The ${"___ ".repeat(tileCount - 1).trim()} this morning.`,
        tiles,
        answers: [tiles.slice(0, tileCount - 1)],
      })), `${tileCount} tiles`).toEqual([]);
    }
  });
});

describe("buildASentenceViolations — exactly one distractor", () => {
  it("rejects a frame with too few blanks for its tiles", () => {
    expect(kindsOf(itemWith({
      frame: "The ___ ___ ___ ___ this morning.",
      answers: [["bus", "broke down", "on my", "way here"]],
    }))).toEqual(["distractor-count"]);
  });

  it("rejects a frame with a blank for every tile — no distractor at all", () => {
    expect(kindsOf(itemWith({
      frame: "The ___ ___ ___ ___ ___ ___ this morning.",
      answers: [["bus", "broke down", "on my", "way here", "train", "arrived"]],
    }))).toEqual(["distractor-count"]);
  });
});

describe("buildASentenceViolations — answers match the blanks and the tiles", () => {
  it("rejects an accepted answer shorter or longer than the blank count", () => {
    expect(kindsOf(itemWith({ answers: [["bus", "broke down", "on my", "way here"]] })))
      .toEqual(["answer-length"]);
    expect(kindsOf(itemWith({
      answers: [["bus", "broke down", "on my", "way here", "train", "arrived"]],
    }))).toEqual(["answer-length"]);
  });

  it("checks every accepted answer, not just the first", () => {
    expect(kindsOf(itemWith({
      answers: [
        ["bus", "broke down", "on my", "way here", "train"],
        ["train", "broke down", "on my", "way here"],
      ],
    }))).toEqual(["answer-length"]);
  });

  it("rejects an answer token that is not one of this Item's tiles", () => {
    expect(kindsOf(itemWith({
      answers: [["bus", "broke down", "on my", "way there", "train"]],
    }))).toEqual(["answer-not-from-tiles"]);
  });

  it("rejects an answer that reuses a tile more often than `tiles` lists it", () => {
    expect(kindsOf(itemWith({
      answers: [["bus", "broke down", "on my", "on my", "train"]],
    }))).toEqual(["answer-not-from-tiles"]);
  });
});

describe("buildASentenceViolations — the frame carries the final punctuation", () => {
  it("rejects a frame that does not end in sentence-final punctuation", () => {
    expect(kindsOf(itemWith({ frame: "The ___ ___ ___ ___ ___ this morning" })))
      .toEqual(["frame-final-punctuation"]);
  });

  it("rejects a frame that ends on a blank, leaving the period to a tile", () => {
    expect(kindsOf(itemWith({
      frame: "The bus ___ ___ ___ ___ ___",
      tiles: ["broke", "down", "on my", "way here", "today", "arrived"],
      answers: [["broke", "down", "on my", "way here", "today"]],
    }))).toEqual(["frame-final-punctuation"]);
  });

  it("accepts a question mark, an exclamation mark, and a closing quotation mark", () => {
    expect(kindsOf(itemWith({ frame: "Was the ___ ___ ___ ___ ___ this morning?" }))).toEqual([]);
    expect(kindsOf(itemWith({ frame: "The ___ ___ ___ ___ ___ this morning!" }))).toEqual([]);
    expect(kindsOf(itemWith({ frame: "She said, \"the ___ ___ ___ ___ ___ this morning.\"" })))
      .toEqual([]);
  });
});

describe("buildASentenceViolations — tiles leak no position", () => {
  it("rejects a tile carrying sentence-final punctuation", () => {
    expect(kindsOf(itemWith({
      tiles: ["bus", "train", "broke down", "on my", "way here.", "arrived"],
      answers: [["bus", "broke down", "on my", "way here.", "train"]],
    }))).toEqual(["tile-final-punctuation"]);
  });

  it("rejects a tile carrying a sentence-initial capital", () => {
    expect(kindsOf(itemWith({
      tiles: ["bus", "train", "broke down", "on my", "Way here", "arrived"],
      answers: [["bus", "broke down", "on my", "Way here", "train"]],
    }))).toEqual(["tile-initial-capital"]);
  });

  it("reports both defects on the same tile", () => {
    expect(kindsOf(itemWith({
      tiles: ["bus", "train", "broke down", "on my", "Way here.", "arrived"],
      answers: [["bus", "broke down", "on my", "Way here.", "train"]],
    }))).toEqual(["tile-final-punctuation", "tile-initial-capital"]);
  });

  it("flags a capital that leaks nothing, deliberately", () => {
    // "I" is capitalised wherever it stands, so it gives no position away on its own. It is still
    // rejected: the rule is the exam's, and the exam draws every tile lowercase.
    expect(kindsOf(itemWith({
      frame: "The bus ___ ___ ___ ___ ___ this morning.",
      tiles: ["broke down", "before", "I", "could", "board it", "arrived"],
      answers: [["broke down", "before", "I", "could", "board it"]],
    }))).toEqual(["tile-initial-capital"]);
  });

  // The exam draws every tile lowercase so that the tile starting the sentence is not given away,
  // which is the point of blanking the start.
  it("accepts a sentence-initial tile written lowercase, and flags the same tile capitalised", () => {
    const startBlanked = shape("bas-start-blanked");
    expect(kindsOf(startBlanked)).toEqual([]);

    const capitalised = startBlanked.tiles.map((tile) => (tile === "we" ? "We" : tile));
    expect(kindsOf({
      ...startBlanked,
      tiles: capitalised,
      answers: [startBlanked.answers[0].map((token) => (token === "we" ? "We" : token))],
    })).toEqual(["tile-initial-capital"]);
  });

  // The other half of the casing rule: `answers` must be reproducible from `tiles` verbatim.
  // Scoring compares tile text with case intact (normalizeTile in sentenceScorer.ts folds only
  // whitespace), so an answer that capitalises a lowercase tile names a tile the Item does not
  // offer, and no arrangement the User can build would ever equal the key.
  it("rejects an accepted answer that re-cases a tile", () => {
    const startBlanked = shape("bas-start-blanked");
    expect(kindsOf({
      ...startBlanked,
      answers: [startBlanked.answers[0].map((token) => (token === "we" ? "We" : token))],
    })).toEqual(["answer-not-from-tiles"]);
  });

  it("leaves a mid-tile comma, apostrophe or hyphen alone", () => {
    expect(kindsOf(itemWith({
      tiles: ["bus", "train", "broke down,", "on my", "way-here's", "arrived"],
      answers: [["bus", "broke down,", "on my", "way-here's", "train"]],
    }))).toEqual([]);
  });
});

describe("buildASentenceViolations — the report", () => {
  it("reports every violation it finds, not just the first", () => {
    const { frame: _dropped, ...frameless } = CONFORMING_ITEM;
    const kinds = kindsOf({
      ...frameless,
      // Eleven tiles: one past the ceiling of ten.
      tiles: [
        "Bus", "train", "broke down", "on my", "way here.", "arrived",
        "again", "already", "today", "somehow", "nearly",
      ],
      answers: [["Bus", "broke down", "on my", "way here.", "nowhere"]],
    } as BuildASentenceItem);

    expect(new Set(kinds)).toEqual(new Set([
      "frame-missing",
      "tile-count",
      "answer-not-from-tiles",
      "tile-final-punctuation",
      "tile-initial-capital",
    ]));
  });

  it("names the offending Item by id and by its position in the Set", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ ...CONFORMING_ITEM, id: `bs${i + 1}` }));
    // Seven tiles for five blanks: two distractors where a conforming Item has exactly one.
    items[3] = { ...items[3], tiles: [...CONFORMING_ITEM.tiles, "today"] };

    const violations = buildASentenceViolations({ buildASentence: { items } });
    expect(violations).toHaveLength(1);
    expect(violations[0].id).toBe("bs4");
    expect(violations[0].label).toBe("buildASentence/items[3]");
    expect(violations[0].detail).toMatch(/blank/);
  });

  it("quotes no Item content in any label or detail", () => {
    // The rule parseSentenceFrame and setStore.ts's safeSetErrorDescriptor follow: a frame, a tile
    // and a prompt are all Item content, and these strings travel into job errors and logs.
    const violations = violationsOf(itemWith({
      prompt: "Why was the secretword late?",
      frame: "The secretword ___ ___",
      tiles: ["Secretword.", "train", "broke down", "on my", "way here", "arrived"],
      answers: [["Secretword.", "broke down", "on my", "way here", "train"]],
    }));

    expect(violations.length).toBeGreaterThan(3);
    for (const violation of violations) {
      expect(`${violation.label} ${violation.detail}`.toLowerCase()).not.toContain("secretword");
    }
  });

  it("is pure: it neither throws on nor mutates a legacy frameless Set", () => {
    // A Set banked before frames existed parses (the frame is optional), and the checker only
    // reports on it; nothing in the read path consults the checker.
    //
    // The Set comes from a committed fixture, not from the data directory: every banked Set carries
    // frames, and the directory is a scratch copy that other test files publish into and delete
    // from while this one runs. The fixture is a real frameless Writing Set, and nothing else
    // reads it.
    const raw = fs.readFileSync(
      path.join(config.projectRoot, "server/test/fixtures/legacy-frameless-writing-set.json"),
      "utf8",
    );
    const set = AnySetSchema.parse(JSON.parse(raw)) as WritingSet;

    // The fixture's own precondition: with a frame in it, this test would pass and test nothing.
    expect(set.buildASentence.items.length).toBeGreaterThan(0);
    expect(set.buildASentence.items.every((item) => item.frame === undefined)).toBe(true);

    expect(() => buildASentenceViolations(set)).not.toThrow();
    expect(JSON.stringify(set)).toBe(JSON.stringify(AnySetSchema.parse(JSON.parse(raw))));
  });
});

// A number the generation guide publishes to the model and a number the gate enforces are held
// equal by a test, or a change to one drifts away from the other in silence
// (speakingConformance.test.ts and moduleDifficulty.test.ts do the same for Speaking and Reading).
//
// The two ends are different kinds of number:
// - the ceiling is shared: ten is what the guide asks for and what the gate rejects past, so it is
//   `BUILD_A_SENTENCE_TILE_MAX` on both sides;
// - the floor is not: the guide's five is a model-visible target
//   (`BUILD_A_SENTENCE_TILE_RAMP_FLOOR`) and the gate's four is a tolerance for banked Items
//   (`BUILD_A_SENTENCE_TILE_MIN`) that must never appear in a prompt, because a model told the
//   tolerance writes to it.
describe("the generation guide's published tile band is the target constants, digit for digit", () => {
  const guideMd = fs.readFileSync(
    path.join(config.projectRoot, ".claude/skills/toefl-writing/references/generation-guide.md"),
    "utf8",
  );

  it("states the band the model is asked for as the ramp floor and the gate ceiling", () => {
    const band = /\*\*(\d+)-(\d+) tiles\*\*/u.exec(guideMd);
    expect(band, "the guide states no bolded tile band").not.toBeNull();
    expect(Number(band![1])).toBe(BUILD_A_SENTENCE_TILE_RAMP_FLOOR);
    expect(Number(band![2])).toBe(BUILD_A_SENTENCE_TILE_MAX);
    // The tolerance floor never appears as the published band.
    expect(band![1]).not.toBe(String(BUILD_A_SENTENCE_TILE_MIN));
  });

  it("ramps the ten items from that floor to that ceiling, never outside the gate's band", () => {
    // The one code-span line that is nothing but arrow-separated numbers.
    const rampLine = guideMd
      .split("\n")
      .find((line) => /^`\d+(?:\s*→\s*\d+)+`$/u.test(line.trim()));
    expect(rampLine, "the guide publishes no tile-count ramp").toBeDefined();
    const ramp = (rampLine!.match(/\d+/gu) ?? []).map(Number);

    expect(ramp).toHaveLength(10);
    expect(ramp[0]).toBe(BUILD_A_SENTENCE_TILE_RAMP_FLOOR);
    expect(ramp.at(-1)).toBe(BUILD_A_SENTENCE_TILE_MAX);
    // A ramp never goes backwards, and every step of it is an Item the gate accepts.
    for (const [index, count] of ramp.entries()) {
      expect(count).toBeGreaterThanOrEqual(index === 0 ? BUILD_A_SENTENCE_TILE_RAMP_FLOOR : ramp[index - 1]!);
      expect(count).toBeLessThanOrEqual(BUILD_A_SENTENCE_TILE_MAX);
    }
  });
});
