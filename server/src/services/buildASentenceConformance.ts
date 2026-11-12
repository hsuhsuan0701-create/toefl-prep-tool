// ---------------------------------------------------------------------------
// Build a Sentence conformance: do a Writing Set's Items match the task format ETS publishes?
//
// ETS's RR-25-12 technical manual describes the task as reordering words or phrases into a
// grammatical sentence or question. Here a Frame supplies whatever text is fixed plus the
// sentence-final punctuation, its blanks take one tile each, and exactly one tile is left over as
// the distractor. The Frame may fix a lot, a little, or nothing but the final punctuation,
// and every tile is lowercase (docs/adr/0009). The fixtures
// server/test/fixtures/build-a-sentence-reference-item.json (the shape of ETS's one published
// sample) and build-a-sentence-reorder-shapes.json hold the accepted shapes.
//
// These rules are server code rather than schema constraints because a violation has to be
// something a generation run can repair by regenerating, never a parse failure: a Set file that
// fails `AnySetSchema` is skipped (and listed by GET /api/sets/unloadable) and its Attempts lose
// their review, so narrowing the schema costs practice history. BuildASentenceItemSchema's comment
// in shared/src/schemas/writing.ts covers the schema side of this split.
//
// Every rule is decidable by counting, so no model call is involved. The function reports every
// violation rather than throwing on the first: writingGenerator.ts turns the whole list into one
// regeneration prompt, and a function that never throws can run over an Item that has not been
// through the schema.
//
// No Item content goes into a label or a detail. These strings reach job errors and logs, and a
// frame, a tile and a prompt are all Item content; positions and counts identify the defect, and
// the model that fixes it is handed the Item itself.
// ---------------------------------------------------------------------------

import { SentenceFrameError, parseSentenceFrame } from "@toefl-prep/shared";
// The scorer's own tile equality (trimmed, inner whitespace collapsed, case-sensitive, duplicates
// counted as a multiset), so the gate and the scorer cannot disagree about what "the same tile"
// means.
import { isTileSubset } from "./sentenceScorer.js";

/**
 * The tile range the gate accepts.
 *
 * Four is the lowest count the format can express: four tiles leave three blanks (one tile is the
 * distractor), and three is the schema's minimum `answers` length. Banked Items use it.
 *
 * Ten: the format specifications state no tile count, and the exam blanks far more of the sentence
 * than seven tiles can express — at the top of the ramp, every word (docs/adr/0009). Ten is where a
 * full reorder of an ordinary B1–B2 sentence lands, and past it an Item measures how many fragments
 * a User can hold at once rather than grammar.
 */
export const BUILD_A_SENTENCE_TILE_MIN = 4;
export const BUILD_A_SENTENCE_TILE_MAX = 10;

/**
 * The floor the MODEL is asked for: five, not the gate's four.
 *
 * `BUILD_A_SENTENCE_TILE_MIN` is a gate-only TOLERANCE and must never appear in a prompt: told
 * "4-10", a model writes to the slack and hands back four-tile Items a full step below the ramp the
 * generation guide asks for, which the gate cannot object to. This is the target/tolerance divider
 * optionQuality.ts's header states, applied to Writing: a model-visible TARGET and a gate-only
 * TOLERANCE never leak into each other in either direction.
 *
 * Five is the guide's own ramp floor ("**5-10 tiles**", ramping `5 → 5 → 6 → 6 → 7 → 7 → 8 → 8 →
 * 9 → 10`), so a retry prompt that restates it discloses nothing new. The ceiling is shared: ten is
 * both what the guide asks for and what the gate enforces. buildASentenceConformance.test.ts parses
 * the guide and holds it to these constants.
 */
export const BUILD_A_SENTENCE_TILE_RAMP_FLOOR = 5;

/**
 * Sentence-final punctuation, optionally behind a closing quote or bracket so that a frame ending
 * `…this morning."` still counts as ending its sentence. Straight and curly quotes both, since the
 * model emits either.
 */
const SENTENCE_END_RE = /[.!?]["'”’)\]]*\s*$/u;

/** A capital in any script, not just A–Z: the leak is the capitalisation, not the alphabet. */
const INITIAL_CAPITAL_RE = /^\p{Lu}/u;

// A Frame whose only fixed text is the sentence-final punctuation is a full reorder, the top of the
// ramp, so it is not a violation (docs/adr/0009). `generationCheckPolicy.ts` restates this union,
// and generationCheckPolicy.test.ts pins the two to each other by a mutual-assignability assertion.
export type BuildASentenceViolationKind =
  /** No frame at all, or a frame that is only whitespace. */
  | "frame-missing"
  /** A frame present but unrenderable — no blanks, or a blank written with too few underscores. */
  | "frame-unparseable"
  /** The frame leaves its terminal period to a tile, which then can only be last. */
  | "frame-final-punctuation"
  /** Outside the 4–10 range. */
  | "tile-count"
  /** blanks ≠ tiles − 1: no distractor, or more than one. */
  | "distractor-count"
  /** An accepted answer does not fill every blank exactly once. */
  | "answer-length"
  /** An accepted answer names a tile this Item does not offer, or reuses one too often. */
  | "answer-not-from-tiles"
  /** A tile ends the sentence, so it can only be the last blank. */
  | "tile-final-punctuation"
  /** A tile carries a capital, which gives away that it is the tile the sentence starts with. */
  | "tile-initial-capital";

export type BuildASentenceViolation = {
  readonly kind: BuildASentenceViolationKind;
  /** Where it was found, e.g. "buildASentence/items[3]" — a position, never content. */
  readonly label: string;
  /** The offending Item's id. */
  readonly id: string;
  /** Actual vs expected, in operator-readable terms and with no Item content in it. */
  readonly detail: string;
};

/**
 * The Item shape these checks need, structurally rather than by importing the schema's type: it lets
 * a test state one Item as a literal, and it documents that nothing here reads `prompt`. A
 * `WritingSet`'s Build a Sentence Items satisfy it.
 */
export type BuildASentenceItemLike = {
  readonly id: string;
  readonly frame?: string;
  readonly tiles: readonly string[];
  readonly answers: readonly (readonly string[])[];
};

/**
 * Every way a Writing Set's Build a Sentence Items depart from the published task format, in Item
 * order. An empty array means the Set conforms.
 *
 * The checks that need a blank count are skipped for an Item with no usable frame — the count is
 * unknown, not zero, and reporting `distractor-count: 0 blanks` would send a regeneration after the
 * wrong defect. Everything that does NOT need one (tile count, tile membership, the two position
 * leaks) is still reported, so one pass names every problem the Item has.
 */
export function buildASentenceViolations(set: {
  readonly buildASentence: { readonly items: readonly BuildASentenceItemLike[] };
}): BuildASentenceViolation[] {
  const violations: BuildASentenceViolation[] = [];

  set.buildASentence.items.forEach((item, index) => {
    const label = `buildASentence/items[${index}]`;
    const push = (kind: BuildASentenceViolationKind, detail: string): void => {
      violations.push({ kind, label, id: item.id, detail });
    };

    // --- the frame -------------------------------------------------------
    let blanks: number | undefined;
    if (item.frame === undefined || item.frame.trim() === "") {
      push(
        "frame-missing",
        "Item has no frame; the frame is what supplies the fixed words and the sentence-final punctuation",
      );
    } else {
      try {
        // How MUCH the frame fixes is not checked, at either end: fixing nothing but the final
        // punctuation is the full reorder the exam sets at the top of the ramp, and fixing a lot is
        // the ETS sample's own shape. Only the blank COUNT is read off the parse.
        const segments = parseSentenceFrame(item.frame);
        blanks = segments.filter((segment) => segment.type === "blank").length;
      } catch (err) {
        // The schema refuses these, so an unparseable frame here means the Item never went through
        // it. Report rather than throw: this function is a report, and a caller mid-generation has
        // nowhere useful to catch.
        push(
          "frame-unparseable",
          `frame could not be parsed into blanks: ${err instanceof SentenceFrameError ? err.message : "unknown parse failure"}`,
        );
      }
      // Deliberately outside the try: how a frame ENDS is a property of the raw string, and an
      // Item with two frame defects should hear about both.
      if (!SENTENCE_END_RE.test(item.frame)) {
        push(
          "frame-final-punctuation",
          "frame does not end in sentence-final punctuation (. ! ?); the frame supplies it so that no tile has to",
        );
      }
    }

    // --- the tiles -------------------------------------------------------
    // The detail states the authoring range the generation guide teaches, not the gate's: every
    // detail is embedded in the next attempt's prompt (conformanceRetryDetail), and the gate's floor
    // is a tolerance the model must not learn.
    if (item.tiles.length < BUILD_A_SENTENCE_TILE_MIN || item.tiles.length > BUILD_A_SENTENCE_TILE_MAX) {
      push(
        "tile-count",
        `Item offers ${item.tiles.length} tiles; an Item is written with ${BUILD_A_SENTENCE_TILE_RAMP_FLOOR}–${BUILD_A_SENTENCE_TILE_MAX}`,
      );
    }

    if (blanks !== undefined && blanks !== item.tiles.length - 1) {
      push(
        "distractor-count",
        `frame has ${blanks} blank(s) for ${item.tiles.length} tiles; a conforming Item leaves exactly one distractor, so blanks must equal tiles − 1`,
      );
    }

    item.tiles.forEach((tile, tileIndex) => {
      const text = tile.trim();
      // A tile that ends the sentence can only be the last blank, which hands the User a position
      // for free. The frame supplies the terminal period so no tile has to. Same trade for a tile
      // like "U.S.".
      if (SENTENCE_END_RE.test(text)) {
        push(
          "tile-final-punctuation",
          `tile ${tileIndex} ends in sentence-final punctuation, so it can only be the last blank`,
        );
      }
      // The exam draws every tile lowercase, including the one that opens the sentence, so that a
      // blanked start hides which tile begins it; one capitalised tile in the tray gives that away.
      //
      // This also fires on a word capitalised everywhere — a proper noun ("Tokyo"), "I", an acronym —
      // because no counting rule can tell it from a sentence-initial capital, and under the
      // lowercase-tile rule the tray is lowercase either way. The generator authors the frame and
      // the tiles together, so such a word goes in the frame or the sentence is written without it.
      // This kind never fails a job (generationCheckPolicy.ts).
      //
      // A key that re-cases a tile is caught by `answer-not-from-tiles` instead (isTileSubset is
      // case-sensitive), and that kind does fail the job if a regeneration does not fix it.
      if (INITIAL_CAPITAL_RE.test(text)) {
        push(
          "tile-initial-capital",
          `tile ${tileIndex} begins with a capital; the exam draws every tile lowercase, so a capital gives away which tile the sentence starts with`,
        );
      }
    });

    // --- the accepted answers --------------------------------------------
    item.answers.forEach((answer, answerIndex) => {
      if (blanks !== undefined && answer.length !== blanks) {
        push(
          "answer-length",
          `accepted answer ${answerIndex} has ${answer.length} token(s) for ${blanks} blank(s); every accepted answer fills every blank exactly once`,
        );
      }
      if (!isTileSubset([...answer], [...item.tiles])) {
        push(
          "answer-not-from-tiles",
          `accepted answer ${answerIndex} names a tile this Item does not offer, or reuses one more often than \`tiles\` lists it`,
        );
      }
    });
  });

  return violations;
}
