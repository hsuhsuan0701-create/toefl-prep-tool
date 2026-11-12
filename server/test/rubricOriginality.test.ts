import { describe, expect, it } from "vitest";
import {
  MAX_SHARED_RUN,
  MAX_SIX_GRAM_SHARE,
  compareOriginality,
  longestSharedRun,
  sharedNGramShare,
  words,
} from "../../scripts/lib/originality.js";

// The measure scripts/check-rubric-originality.ts applies to a shipped rubric and the official copy
// installed beside it. Every text here is invented for the test: none is ETS's.

const ORIGINAL = [
  "The lighthouse keeper climbed the spiral stairs every evening at dusk, carrying a can of oil and a",
  "rag for the brass. From the gallery she could see the fishing boats turning for harbour, their",
  "wakes bending around the reef that had claimed two ships in her grandfather's time.",
].join(" ");

/** The same passage with one or two words changed per sentence: the edit a rewrite must not be. */
const LIGHTLY_EDITED = [
  "The lighthouse keeper went up the spiral stairs every evening at dusk, carrying a can of oil and a",
  "cloth for the brass. From the gallery she could watch the fishing boats turning for harbour, their",
  "wakes curving around the reef that had claimed two ships in her grandfather's day.",
].join(" ");

/** A description of the same scene in independent words. */
const REWRITTEN = [
  "Each night, as the light faded, she oiled and polished the lamp's brass fittings at the top of the",
  "tower. Below, boats came home past the rocks that had wrecked two vessels when her grandfather kept",
  "the light.",
].join(" ");

describe("words", () => {
  it("keeps only what a reader would recognise as wording", () => {
    expect(words("**Score: 5** — see <https://example.org/guide.pdf> and `SpeakingSetSchema`, p. 17."))
      .toEqual(["score", "see", "and", "p"]);
    expect(words("The writer’s point isn't lost")).toEqual(["the", "writer's", "point", "isn't", "lost"]);
  });
});

describe("longestSharedRun and sharedNGramShare", () => {
  it("find the longest stretch both texts share, in order", () => {
    expect(longestSharedRun(words("a b c d e f"), words("x c d e y"))).toEqual(["c", "d", "e"]);
    expect(longestSharedRun(words("a b"), words("c d"))).toEqual([]);
  });

  it("count the shipped text's n-grams, with repeats, that the official text contains", () => {
    expect(sharedNGramShare(words("a b c a b c"), words("a b c"), 3)).toBe(2 / 4);
    expect(sharedNGramShare(words("a b"), words("a b"), 6)).toBe(0);
  });
});

describe("compareOriginality", () => {
  it("fails a verbatim copy", () => {
    const result = compareOriginality(ORIGINAL, ORIGINAL);
    expect(result.passes).toBe(false);
    expect(result.sixGramShare).toBe(1);
  });

  it("fails a passage edited only a word or two per sentence, because its clauses survive intact", () => {
    const result = compareOriginality(LIGHTLY_EDITED, ORIGINAL);
    expect(result.sharedRun.length).toBeGreaterThan(MAX_SHARED_RUN);
    expect(result.passes).toBe(false);
  });

  it("fails the same light edit even when it is a small part of an otherwise original file", () => {
    const file = `${REWRITTEN.repeat(8)} ${LIGHTLY_EDITED}`;
    expect(compareOriginality(file, ORIGINAL).passes).toBe(false);
  });

  it("passes an independent description of the same content", () => {
    const result = compareOriginality(REWRITTEN, ORIGINAL);
    expect(result.sharedRun.length).toBeLessThanOrEqual(MAX_SHARED_RUN);
    expect(result.sixGramShare).toBeLessThanOrEqual(MAX_SIX_GRAM_SHARE);
    expect(result.passes).toBe(true);
  });
});
