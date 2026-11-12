import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/lib/config.js";
import { isTileSubset, scoreSentence } from "../src/services/sentenceScorer.js";

type ReorderShapeItem = { id: string; tiles: string[]; answers: string[][] };

// The hand-authored reorder shapes, the same file buildASentenceConformance.test.ts checks the
// conformance gate against, so "the gate accepts it" and "the scorer scores it" are claims about
// one Item.
const REORDER_SHAPES = (JSON.parse(fs.readFileSync(
  path.join(config.projectRoot, "server/test/fixtures/build-a-sentence-reorder-shapes.json"),
  "utf8",
)) as { items: ReorderShapeItem[] }).items;

const shape = (id: string): ReorderShapeItem => {
  const found = REORDER_SHAPES.find((item) => item.id === id);
  if (!found) throw new Error(`reorder-shapes fixture has no item ${id}`);
  return found;
};

describe("scoreSentence", () => {
  const answers = [["The bakery", "that", "opened last week", "sells", "fresh bread."]];
  it("matches an accepted order exactly", () => {
    expect(scoreSentence(["The bakery", "that", "opened last week", "sells", "fresh bread."], answers))
      .toEqual({ correct: true, matchedAnswer: answers[0] });
  });
  it("rejects wrong order and wrong length", () => {
    expect(scoreSentence(["that", "The bakery", "opened last week", "sells", "fresh bread."], answers).correct).toBe(false);
    expect(scoreSentence(["The bakery", "that", "opened last week", "sells"], answers).correct).toBe(false);
  });
  it("normalizes stray whitespace but stays case-sensitive", () => {
    expect(scoreSentence([" The bakery ", "that", "opened  last week", "sells", "fresh bread."], answers).correct).toBe(true);
    expect(scoreSentence(["the bakery", "that", "opened last week", "sells", "fresh bread."], answers).correct).toBe(false);
  });
  it("accepts any of multiple accepted orders", () => {
    const multi = [["a", "b", "c"], ["c", "b", "a"]];
    expect(scoreSentence(["c", "b", "a"], multi).matchedAnswer).toEqual(["c", "b", "a"]);
  });
});

// The real exam can blank the start of the sentence and draws every tile lowercase, so the tile
// that opens the sentence is lowercase too: in the tray, in the arrangement the User hands in, and
// in the accepted answer on disk. normalizeTile is case-sensitive, so both halves can be tested.
describe("scoreSentence — a sentence whose first word is a lowercase tile", () => {
  it("scores the fixture's start-blanked arrangement correct", () => {
    const item = shape("bas-start-blanked");
    expect(item.answers[0][0]).toBe("we"); // the fixture's own precondition: lowercase, and first

    expect(scoreSentence([...item.answers[0]], item.answers).correct).toBe(true);
  });

  it("scores the same arrangement correct for a full reorder, where every word is a tile", () => {
    const item = shape("bas-full-reorder");
    expect(scoreSentence([...item.answers[0]], item.answers).correct).toBe(true);
  });

  it("does NOT accept a capitalised first word — the key is the tiles' own casing", () => {
    // The User cannot produce this arrangement: no such tile exists to place. It pins the authoring
    // side instead, a key that capitalises a lowercase tile, which `answer-not-from-tiles` catches
    // at generation time as fatal.
    const item = shape("bas-start-blanked");
    const recased = item.answers[0].map((token) => (token === "we" ? "We" : token));

    expect(scoreSentence(recased, item.answers).correct).toBe(false);
    expect(isTileSubset(recased, item.tiles)).toBe(false);
  });
});

describe("isTileSubset", () => {
  it("respects multiset counts with duplicate tiles", () => {
    expect(isTileSubset(["to", "to"], ["to", "go", "to"])).toBe(true);
    expect(isTileSubset(["to", "to", "to"], ["to", "go", "to"])).toBe(false);
    expect(isTileSubset(["made-up"], ["a", "b"])).toBe(false);
  });
});
