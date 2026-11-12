import type { AnySet } from "@toefl-prep/shared";
import { normalizeTile } from "./sentenceScorer.js";

// ---------------------------------------------------------------------------
// Build a Sentence tile order, drawn each time a Set is served (GET /api/sets/:id).
//
// A generation model emits tiles in the order of the sentence it just wrote, so a stored tray often
// reads left to right as an accepted answer, and the User reads the answer off the tray instead of
// building it. This is not an anti-cheat measure: the key sits in data/question-sets/writing/*.json,
// which the User can open. It makes the drill require assembling the sentence.
//
// Drawn at serve time rather than at generation because that reaches Sets from every source (import
// included), fixes banked Sets without editing immutable Set JSON, and draws a fresh order on every
// re-attempt, so a remembered tray is no shortcut.
//
// Scoring cannot desynchronise: `answers` holds tile TEXT, not indices (sentenceScorer.ts), scoring
// reads the Set from disk rather than what was served, and only the order of `tiles` changes.
// ---------------------------------------------------------------------------

// How many orders to draw before serving the last one. An Item has at least three tiles and an
// answer at least three, so a draw reads as a given answer at most 1 time in 3! and the gate almost
// always clears in a draw or two. An Item whose tiles are identical after normalization (["go","go",
// "go"]) reads as the answer in every order, so the loop needs an end; serving the last draw is no
// worse than serving the stored order.
const MAX_DRAWS = 50;

/**
 * Does this tray order hand over `answer` when read left to right? Not equality: with distractor
 * tiles between them, answer tiles in answer order still read out plainly, so the test is an
 * in-order subsequence, greedily matched. Tiles compare through the scorer's own `normalizeTile`, so
 * the gate and the scorer agree on when two tiles are the same.
 */
function readsAsAnswer(tiles: readonly string[], answer: readonly string[]): boolean {
  // The schema forbids an empty answer, which would match every order vacuously; treated as no
  // constraint, so such an Item is served after one draw instead of fifty.
  if (answer.length === 0) return false;
  const want = answer.map(normalizeTile);
  let next = 0;
  for (const tile of tiles) {
    if (normalizeTile(tile) === want[next]) {
      next += 1;
      if (next === want.length) return true;
    }
  }
  return false;
}

function permute(tiles: readonly string[], rng: () => number): string[] {
  const out = [...tiles];
  // Fisher-Yates, with the index clamped so an rng returning exactly 1 (or anything out of range)
  // cannot index past the end of the array.
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.min(Math.max(Math.floor(rng() * (i + 1)), 0), i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * A tray order for one Build a Sentence Item: a uniform random permutation of `tiles`, re-drawn
 * while it still reads left to right as any accepted answer. Returns a new array; `tiles` and
 * `answers` are never mutated. `rng` defaults to `Math.random` in production and is injected by
 * tests so the drawn order is assertable.
 */
export function scrambleTileOrder(
  tiles: readonly string[],
  answers: readonly (readonly string[])[],
  rng: () => number = Math.random,
): string[] {
  let drawn = permute(tiles, rng);
  for (let draw = 1; draw < MAX_DRAWS && answers.some((answer) => readsAsAnswer(drawn, answer)); draw += 1) {
    drawn = permute(tiles, rng);
  }
  return drawn;
}

/**
 * The serve-time scramble applied to a whole Set: every Build a Sentence Item gets its own draw (one
 * permutation shared across Items would be a pattern of its own), and everything else is carried
 * through untouched. Sets of the other kinds have no tray and are returned as they are.
 *
 * Must run before `stripAnswers`: the re-draw gate reads the answer keys that `stripAnswers` removes.
 */
export function scrambleBuildASentenceTiles(set: AnySet, rng: () => number = Math.random): AnySet {
  if (set.kind !== "writing") return set;
  return {
    ...set,
    buildASentence: {
      ...set.buildASentence,
      items: set.buildASentence.items.map((item) => ({
        ...item,
        tiles: scrambleTileOrder(item.tiles, item.answers, rng),
      })),
    },
  };
}
