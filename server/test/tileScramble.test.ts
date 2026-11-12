import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AnySetSchema, type AnySet, type WritingSet } from "@toefl-prep/shared";
import { config } from "../src/lib/config.js";
import { isTileSubset, scoreSentence } from "../src/services/sentenceScorer.js";
import { scrambleBuildASentenceTiles, scrambleTileOrder } from "../src/services/tileScramble.js";
import { READING_FIXTURE } from "./fixtures/reading-set.fixture.js";

// A pinned rng: each call returns the next value, then repeats the last one forever so a test only
// has to write down the draws it cares about. Values are consumed by the Fisher-Yates loop, which
// makes one call per tile after the first — so one draw of N tiles costs N-1 values.
function pinnedRng(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)]!;
}

// The two rng values worth naming. `KEEP` makes Fisher-Yates pick j === i at every step, i.e. the
// identity permutation, which the re-draw gate has to reject when the stored order is the answer
// order. `SWAP_TO_FRONT` makes it pick j === 0 at every step.
const KEEP = 0.999;
const SWAP_TO_FRONT = 0;

const norm = (t: string) => t.trim().replace(/\s+/g, " ");
const sorted = (tiles: readonly string[]) => [...tiles].map(norm).sort();

describe("scrambleTileOrder", () => {
  const answer = ["The bakery", "that", "opened last week", "sells", "fresh bread."];

  it("permutes the tray with the injected rng and keeps exactly the same tiles", () => {
    const scrambled = scrambleTileOrder(answer, [answer], pinnedRng(SWAP_TO_FRONT));
    expect(scrambled).toEqual(["that", "opened last week", "sells", "fresh bread.", "The bakery"]);
    expect(sorted(scrambled)).toEqual(sorted(answer));
  });

  it("re-draws when the drawn order is exactly an accepted answer", () => {
    // The first draw is the identity, which for this Item is the answer, so the gate must fire and
    // draw again rather than serve the sentence already assembled.
    const scrambled = scrambleTileOrder(answer, [answer], pinnedRng(KEEP, KEEP, KEEP, KEEP, SWAP_TO_FRONT));
    expect(scrambled).not.toEqual(answer);
    expect(sorted(scrambled)).toEqual(sorted(answer));
  });

  it("re-draws when the answer tiles read in order with unused distractor tiles between them", () => {
    // The answer is 3 of the 5 tiles. Reading the tray left to right and ignoring the two
    // distractors still hands over the sentence, so an in-order subsequence must count as giving the
    // answer away even though the tray is not equal to any answer.
    const tiles = ["Nobody", "however", "answered", "at all", "the door"];
    const answers = [["Nobody", "answered", "the door"]];
    const scrambled = scrambleTileOrder(tiles, answers, pinnedRng(KEEP, KEEP, KEEP, KEEP, SWAP_TO_FRONT));
    expect(scrambled).toEqual(["however", "answered", "at all", "the door", "Nobody"]);
    expect(sorted(scrambled)).toEqual(sorted(tiles));
  });

  it("gates on every accepted answer, not just the first", () => {
    const tiles = ["a", "b", "c"];
    const answers = [["a", "b", "c"], ["b", "c", "a"]];
    // Draw 1 (j === 0 twice) is ["b","c","a"], the second accepted answer. Draw 2 is the identity,
    // the first accepted answer. Only draw 3 survives the gate.
    const scrambled = scrambleTileOrder(tiles, answers, pinnedRng(
      SWAP_TO_FRONT, SWAP_TO_FRONT,
      KEEP, KEEP,
      SWAP_TO_FRONT, 0.99,
    ));
    expect(scrambled).toEqual(["c", "b", "a"]);
  });

  it("compares tiles the way the scorer does, so stray whitespace cannot slip a give-away past the gate", () => {
    const tiles = ["The   dog", " ran ", "fast."];
    const answers = [["The dog", "ran", "fast."]];
    const scrambled = scrambleTileOrder(tiles, answers, pinnedRng(KEEP, KEEP, SWAP_TO_FRONT));
    expect(scrambled).toEqual([" ran ", "fast.", "The   dog"]);
  });

  it("gives up after a bounded number of draws when no order can clear the gate", () => {
    // Three identical tiles: every permutation reads as the answer, so the gate can never be
    // satisfied. It must terminate anyway, and returning a permutation is never worse than
    // returning the stored order, which reads as the answer too.
    let calls = 0;
    const counting = () => { calls += 1; return SWAP_TO_FRONT; };
    const scrambled = scrambleTileOrder(["go", "go", "go"], [["go", "go", "go"]], counting);
    expect(scrambled).toEqual(["go", "go", "go"]);
    expect(calls).toBeGreaterThan(0);
    expect(calls).toBeLessThan(1000);
  });

  it("leaves the caller's arrays untouched", () => {
    const tiles = ["a", "b", "c", "d"];
    const answers = [["a", "b", "c", "d"]];
    scrambleTileOrder(tiles, answers, pinnedRng(SWAP_TO_FRONT));
    expect(tiles).toEqual(["a", "b", "c", "d"]);
    expect(answers).toEqual([["a", "b", "c", "d"]]);
  });
});

// A Writing Set whose every Build a Sentence Item stores its tiles in answer order, so the
// Set-level behaviour is testable without the bank.
const answerOrderWritingSet: WritingSet = AnySetSchema.parse({
  id: "wri-scramble1", kind: "writing", source: "generated", createdAt: "2026-08-22T00:00:00Z",
  buildASentence: {
    items: Array.from({ length: 10 }, (_, i) => ({
      id: `bs${i + 1}`, prompt: `P${i + 1}?`,
      tiles: ["The bakery", "that", `opened last week ${i + 1}`, "sells", "fresh bread."],
      answers: [["The bakery", "that", `opened last week ${i + 1}`, "sells", "fresh bread."]],
    })),
  },
  email: { id: "em1", scenario: "s", to: "t@u.edu", subject: "x", bullets: ["1", "2", "3"], timeLimitSec: 420, wordGuidance: { min: 80, max: 120 } },
  academicDiscussion: { id: "ad1", courseTitle: "c", professorName: "p", professorPost: "q",
    studentPosts: [{ name: "A", post: "y" }, { name: "B", post: "n" }], timeLimitSec: 600, minWords: 100 },
}) as WritingSet;

describe("scrambleBuildASentenceTiles", () => {
  it("scrambles every Item while leaving answers and the rest of the Set untouched", () => {
    const before = JSON.stringify(answerOrderWritingSet);
    const scrambled = scrambleBuildASentenceTiles(answerOrderWritingSet, pinnedRng(SWAP_TO_FRONT)) as WritingSet;

    scrambled.buildASentence.items.forEach((item, i) => {
      const original = answerOrderWritingSet.buildASentence.items[i]!;
      expect(item.tiles).not.toEqual(original.answers[0]);
      expect(sorted(item.tiles)).toEqual(sorted(original.tiles));
      // Everything a scramble has no business touching, including the answer key scoring reads.
      expect(item.answers).toEqual(original.answers);
      expect(item.id).toBe(original.id);
      expect(item.prompt).toBe(original.prompt);
    });
    expect(scrambled.email).toEqual(answerOrderWritingSet.email);
    expect(scrambled.academicDiscussion).toEqual(answerOrderWritingSet.academicDiscussion);
    // The route hands it a copy `readSet` parsed for that request alone; the scramble still leaves
    // its input as it found it.
    expect(JSON.stringify(answerOrderWritingSet)).toBe(before);
  });

  it("draws a fresh order per Item rather than applying one permutation to the whole Set", () => {
    // Every Item here holds the same five tiles, so a single shared draw would return ten identical
    // trays. Under a real rng the ten orders must not all coincide.
    const uniform: WritingSet = {
      ...answerOrderWritingSet,
      buildASentence: {
        items: answerOrderWritingSet.buildASentence.items.map((item) => ({
          ...item, tiles: ["a", "b", "c", "d", "e"], answers: [["a", "b", "c", "d", "e"]],
        })),
      },
    };
    const scrambled = scrambleBuildASentenceTiles(uniform) as WritingSet;
    const distinct = new Set(scrambled.buildASentence.items.map((item) => item.tiles.join("|")));
    expect(distinct.size).toBeGreaterThan(1);
  });

  // The scramble is safe only because `answers` stores tile text, never indices, so the scorer
  // itself is asked about the arrangements the scrambled tray allows.
  it("leaves an accepted arrangement of the scrambled tray scoring correct", () => {
    const scrambled = scrambleBuildASentenceTiles(answerOrderWritingSet) as WritingSet;
    scrambled.buildASentence.items.forEach((item, i) => {
      const answers = answerOrderWritingSet.buildASentence.items[i]!.answers;
      for (const answer of answers) {
        // Still assemblable from the tray the User was handed, and still the accepted order.
        expect(isTileSubset(answer, item.tiles)).toBe(true);
        expect(scoreSentence(answer, answers).correct).toBe(true);
      }
    });
  });

  it("returns a Set of any other kind unchanged", () => {
    const reading: AnySet = READING_FIXTURE;
    expect(scrambleBuildASentenceTiles(reading, pinnedRng(SWAP_TO_FRONT))).toBe(reading);
  });

  // Measured against the committed bank (this file's seeded copy) rather than a fixture: every
  // banked Writing Set whose stored tiles give the answer away must serve scrambled.
  //
  // The give-away Sets are derived from the bank, which grows whenever a Set is contributed. The two
  // numbers written down are floors, set at what the committed bank holds: every one of its 32
  // Writing Sets stores all ten trays in answer order. A published Set is never edited or deleted
  // (a retired one stays on disk), so the counts can only grow, and a drop below either means the
  // test lost part of its subject, through a moved bank or a detector that stopped seeing give-away
  // trays, and should fail rather than pass on what is left.
  //
  // Real `Math.random`, deliberately: the gate is what makes the assertion hold, not a pinned draw.
  it("scrambles every banked Item whose stored tiles give the answer away", () => {
    const COMMITTED_GIVE_AWAY_SETS = 32;
    const COMMITTED_GIVE_AWAY_ITEMS = 320;
    const dir = path.join(config.dataDir, "question-sets", "writing");
    const banked = fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
      .map((f) => AnySetSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"))))
      .filter((set): set is WritingSet => set.kind === "writing");

    const givesAwayCount = (set: WritingSet) =>
      set.buildASentence.items.filter((item) => readsAsAnAnswer(item.tiles, item.answers)).length;
    const giveAwaySets = banked.filter((set) => givesAwayCount(set) > 0);
    expect(giveAwaySets.length).toBeGreaterThanOrEqual(COMMITTED_GIVE_AWAY_SETS);
    expect(giveAwaySets.reduce((total, set) => total + givesAwayCount(set), 0)).toBeGreaterThanOrEqual(COMMITTED_GIVE_AWAY_ITEMS);
    // The extreme case: at least one banked Set gives the answer away on every one of its 10 Items.
    expect(Math.max(...giveAwaySets.map(givesAwayCount))).toBe(10);

    for (const set of giveAwaySets) {
      const scrambled = scrambleBuildASentenceTiles(set) as WritingSet;
      expect(givesAwayCount(scrambled), `${set.id} still serves a give-away Item`).toBe(0);
      scrambled.buildASentence.items.forEach((item, i) => {
        expect(sorted(item.tiles)).toEqual(sorted(set.buildASentence.items[i]!.tiles));
      });
    }
  });
});

// The gate, re-implemented from its definition (the tray reads left to right as any accepted
// answer, including when unused distractor tiles sit between the answer tiles), so the assertions
// above measure the property rather than re-running the production predicate against itself.
function readsAsAnAnswer(tiles: readonly string[], answers: readonly (readonly string[])[]): boolean {
  return answers.some((answer) => {
    const want = answer.map(norm);
    let next = 0;
    for (const tile of tiles.map(norm)) if (next < want.length && tile === want[next]) next += 1;
    return next === want.length;
  });
}
