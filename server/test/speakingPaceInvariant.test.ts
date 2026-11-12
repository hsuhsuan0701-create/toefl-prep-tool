import { describe, expect, it } from "vitest";

import {
  LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM,
  LISTEN_AND_REPEAT_ITEM_TARGET_WPM,
  LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC,
  LISTEN_AND_REPEAT_MAX_ITEM_WORDS,
} from "@toefl-prep/shared";
import { ABSOLUTE_DURATION_TOLERANCE_SEC } from "../src/services/audioPace.js";
import {
  LISTEN_AND_REPEAT_WORD_CEILINGS,
  listenAndRepeatPaceInvariantViolations,
  listenAndRepeatWordBudgetAtPace,
} from "../src/services/speakingConformance.js";
import { profileForSetId } from "../src/services/speakingAudioProfile.js";
import { listenAndRepeatItemBand } from "../src/services/speakingAudioRenderer.js";

// The composition invariant, asserted across the whole ramp. Without it a clip could sit inside its
// rate band and still run past the 5.0 s ceiling, because the bottom of the band was slower than the
// ceiling required; the corrective re-render would never fire, since nothing missed a band.
//
// The invariant has two halves, and only the first is obvious. `renderClipWithPaceCorrection` keys
// off `assessPace`'s verdict, and that verdict is `withinTolerance = inBand || |durationSec −
// targetDurationSec| <= ABSOLUTE_DURATION_TOLERANCE_SEC`. An invariant written against `minWpm`
// alone leaves a hole wherever the 0.4 s absolute term is the wider of the two: a clip could fail
// the band floor and still pass as close enough to its target duration.

const ITEMS = [0, 1, 2, 3, 4, 5, 6] as const;

// The word count item `index` is held to: listenAndRepeatViolations checks the published ceiling
// and the budget at pace independently, so the tighter of the two binds.
function listenAndRepeatEffectiveWordCeiling(index: number): number {
  return Math.min(LISTEN_AND_REPEAT_WORD_CEILINGS[index]!, listenAndRepeatWordBudgetAtPace());
}

describe("the pace band and the clip ceiling compose, at every item", () => {
  const band = (index: number) => listenAndRepeatItemBand(profileForSetId("spk-001"), index);

  it("a clip at the effective word ceiling cannot exceed 5.0 s while staying above the band floor", () => {
    for (const index of ITEMS) {
      const ceilingWords = listenAndRepeatEffectiveWordCeiling(index);
      // The rate at which exactly `ceilingWords` fills the whole clip ceiling. Anything slower runs
      // long, so the band floor must sit at or above it for the miss to be visible at all.
      const rateThatFillsTheCeiling =
        (ceilingWords * 60) / LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC;
      expect(
        rateThatFillsTheCeiling,
        `item ${index + 1}: ${ceilingWords} words need ${rateThatFillsTheCeiling.toFixed(1)} WPM ` +
          `to fit ${LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC.toFixed(1)}s, but the band floor is ${band(index).minWpm}`,
      ).toBeLessThanOrEqual(band(index).minWpm);
    }
  });

  it("the 0.4 s absolute duration tolerance cannot rescue an over-ceiling clip either", () => {
    for (const index of ITEMS) {
      const ceilingWords = listenAndRepeatEffectiveWordCeiling(index);
      // `assessPace` measures tolerance against the clip's own target duration, so the gap between
      // that target and the ceiling is the whole margin the tolerance term has to work with.
      const targetDurationAtCeiling = (ceilingWords * 60) / band(index).targetWpm;
      expect(
        LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC - targetDurationAtCeiling,
        `item ${index + 1}: ${ceilingWords} words target ${targetDurationAtCeiling.toFixed(2)}s, ` +
          `only ${(LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC - targetDurationAtCeiling).toFixed(2)}s below the ceiling — ` +
          `inside the ${ABSOLUTE_DURATION_TOLERANCE_SEC}s tolerance, so an over-ceiling clip reads as in-band`,
      ).toBeGreaterThan(ABSOLUTE_DURATION_TOLERANCE_SEC);
    }
  });

  it("states both halves as one check the module runs on itself at load", () => {
    expect(listenAndRepeatPaceInvariantViolations()).toEqual([]);
  });
});

// The checker takes the whole pace policy as an argument, so a hypothetical retune can be run
// through it here without editing the constants; that is how this file shows a retune cannot
// silently reopen the gap.
describe("listenAndRepeatPaceInvariantViolations rejects a policy that reopens the gap", () => {
  const policy = {
    targetWpm: [...LISTEN_AND_REPEAT_ITEM_TARGET_WPM],
    wordCeilings: [...LISTEN_AND_REPEAT_WORD_CEILINGS],
    bandFloorWpm: LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM,
    maxItemWords: LISTEN_AND_REPEAT_MAX_ITEM_WORDS,
    maxItemClipSec: LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC,
    toleranceSec: ABSOLUTE_DURATION_TOLERANCE_SEC,
  };

  // The v4 profile's per-item targets with the word budget taken at each item's target rate rather
  // than its band floor, and each floor at target − 25. Restated as literals so this case keeps
  // failing the check whatever the constants become:
  //   effective ceiling 9/10/12/13/13/14/14, band floor 175/183/190/155/153/151/150.
  //
  // Four positions fail the band half: items 4 (needs 156 WPM, floor 155), 5 (156 vs 153), 6 (168
  // vs 151) and 7 (168 vs 150). Items 6 and 7 also fail the tolerance half: 14 words target 4.77 s
  // and 4.80 s against the 5.0 s ceiling, margins of 0.23 s and 0.20 s, inside the 0.4 s absolute
  // term. So a fix to the floor alone would still leave those two.
  it("rejects the v4 profile's policy, budgeted at the target rate, at every unsatisfiable position, on both halves", () => {
    const violations = listenAndRepeatPaceInvariantViolations({
      ...policy,
      // Budget at the target rate: floor(5.0 × 176/60) = 14 at items 6 and 7.
      targetWpm: [200, 208, 215, 180, 178, 176, 175],
      maxItemWords: 14,
      bandFloorWpm: 0, // unused: the per-item floors below take over
      bandFloorWpmByItem: [175, 183, 190, 155, 153, 151, 150],
      wordCeilings: [9, 10, 12, 13, 13, 14, 14],
    });
    expect(violations.map((violation) => `${violation.item}:${violation.kind}`)).toEqual([
      "4:floor-below-ceiling-rate",
      "5:floor-below-ceiling-rate",
      "6:floor-below-ceiling-rate",
      "6:tolerance-covers-ceiling",
      "7:floor-below-ceiling-rate",
      "7:tolerance-covers-ceiling",
    ]);
  });

  it("rejects a policy where only the 0.4 s tolerance leaves the hole", () => {
    // Floor lifted high enough to satisfy the first half at item 7 (14 words need 168 WPM), but the
    // target left at 175: 14 words target 4.80 s, only 0.20 s below the 5.0 s ceiling, so a clip
    // that runs 5.0 s is still "within tolerance" of its target and never reaches the repair tier.
    const violations = listenAndRepeatPaceInvariantViolations({
      ...policy,
      targetWpm: [200, 208, 215, 180, 178, 176, 175],
      maxItemWords: 14,
      bandFloorWpm: 168,
      wordCeilings: [9, 10, 12, 13, 13, 14, 14],
    });
    expect(violations.map((violation) => `${violation.item}:${violation.kind}`)).toEqual([
      "6:tolerance-covers-ceiling",
      "7:tolerance-covers-ceiling",
    ]);
  });

  it("passes a policy that shortens sentences instead of lifting the floor", () => {
    // The other way to close the gap: a 12-word cap composes against the target − 25 floors above
    // without moving any band. Not the policy, because it buys the invariant by writing shorter
    // sentences than ETS's own.
    expect(
      listenAndRepeatPaceInvariantViolations({
        ...policy,
        targetWpm: [200, 208, 215, 180, 178, 176, 175],
        maxItemWords: 12,
        bandFloorWpm: 0,
        bandFloorWpmByItem: [175, 183, 190, 155, 153, 151, 150],
      }),
    ).toEqual([]);
  });

  // The tolerance half binds at items 4-7, which hold up to 13 words: 13 words at 170 WPM is
  // 4.588 s, 0.412 s under the 5.0 s ceiling and just over the 0.4 s tolerance, so 170 is the
  // slowest target those items can take. The live ramp (184) holds, 170 holds, and 169 reopens the
  // tolerance hole at all four.
  it("puts the tolerance boundary for 13-word items at 170 WPM: the live ramp and 170 pass, 169 fails at items 4-7", () => {
    expect(listenAndRepeatPaceInvariantViolations()).toEqual([]);
    expect(listenAndRepeatPaceInvariantViolations({ ...policy, targetWpm: [226, 226, 226, 170, 170, 170, 170] })).toEqual([]);
    const violations = listenAndRepeatPaceInvariantViolations({
      ...policy,
      targetWpm: [226, 226, 226, 169, 169, 169, 169],
    });
    expect(violations.map((violation) => `${violation.item}:${violation.kind}`)).toEqual([
      "4:tolerance-covers-ceiling",
      "5:tolerance-covers-ceiling",
      "6:tolerance-covers-ceiling",
      "7:tolerance-covers-ceiling",
    ]);
  });
});

describe("the published ramp the invariant is built on", () => {
  it("caps every item at ETS's own longest Listen and Repeat clip, in words", () => {
    // ETS's longest clip anywhere is 4.676 s: 13 words (Teacher Practice Test 5 item 6) and 14
    // (item 7). 13 is the count that fits 5.0 s at a rate the renderer demonstrably reaches.
    expect(LISTEN_AND_REPEAT_MAX_ITEM_WORDS).toBe(13);
    expect(ITEMS.map(listenAndRepeatEffectiveWordCeiling)).toEqual([9, 10, 12, 13, 13, 13, 13]);
  });

  it("derives the band floor from that cap and the clip ceiling, and round-trips back to it", () => {
    expect(LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM).toBe(156);
    expect(
      (LISTEN_AND_REPEAT_MAX_ITEM_WORDS * 60) / LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC,
    ).toBeLessThanOrEqual(LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM);
    // ...and the word budget taken back off that floor returns the cap it came from.
    for (const index of ITEMS) {
      expect(listenAndRepeatWordBudgetAtPace()).toBe(LISTEN_AND_REPEAT_MAX_ITEM_WORDS);
    }
  });
});
