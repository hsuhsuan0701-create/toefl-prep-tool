// ---------------------------------------------------------------------------
// Listen and Repeat conformance: do a Speaking Set's seven sentences stay inside the length ETS
// uses, and does any one of them run longer as speech than ETS's longest clip?
//
// Three official ETS item sets cap Listen and Repeat at 13–15 words: the Technical Manual's campus
// gym scenario (5/6/6/11/8/10/15), the zoo sample in the Updated TOEFL iBT Test Overview
// (6/9/11/12/9/11/13), and Teacher Practice Test 5, whose clips are measured in
// server/test/fixtures/ets-speaking-audio-calibration.json. In a verbatim-repeat task length is the
// difficulty, so an over-long sentence measures working-memory span rather than the syntax the ramp
// exists to measure (docs/research/2026-08-23-listen-and-repeat-speech-rate.md §2.2, §4.2).
//
// Two budgets, checked independently: a per-item word ceiling, and a clip budget — no clip may hold
// more than LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC of speech at the slowest rate its band accepts. The
// clip budget binds on the product of word count and rate, so a sentence inside its word ceiling
// can still run long (same research doc, §1.9).
//
// Both budgets are published to the model: each word ceiling is the top of a Length cell in the
// generation guide's ramp table, and the clip budget is that table's "Max words at pace" column.
// Neither is a gate-only tolerance; speakingConformance.test.ts parses the table and holds both
// equal to the code.
//
// These rules are server code rather than schema constraints for the reason
// buildASentenceConformance.ts gives: the bank holds sentences of up to 22 words, a Set file that
// fails the schema is skipped and its Attempts lose their review, and a violation has to be a
// report a generation run can act on, never a parse failure.
//
// Words are counted with audioPace.countEnglishWords and durations projected with audioPace's
// targetDurationSec, so this gate and the renderer cannot disagree about either.
//
// Only over-length is a violation. The guide's ramp permits ties and local dips (ETS's own campus
// gym ramp has both), so there is no monotonicity check and no minimum: a short sentence is easier
// practice, not a defect worth a regeneration.
//
// No Item content goes into a label or a detail: details reach retry prompts and logs.
// ---------------------------------------------------------------------------

import {
  LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM,
  LISTEN_AND_REPEAT_ITEM_TARGET_WPM,
  LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC,
  LISTEN_AND_REPEAT_MAX_ITEM_WORDS,
} from "@toefl-prep/shared";
import {
  ABSOLUTE_DURATION_TOLERANCE_SEC,
  countEnglishWords,
  targetDurationSec,
} from "./audioPace.js";

/**
 * Per-item word ceilings, items 1–7 in order — the top of each Length cell in the generation
 * guide's ramp table. Non-decreasing by construction, so a ramp that uses ETS's own dips (a
 * 9-word item 5 under a 12-word item 4) never fires anything.
 */
export const LISTEN_AND_REPEAT_WORD_CEILINGS = [9, 10, 12, 13, 13, 15, 16] as const;

/**
 * The clip budget in words: how many words a Listen and Repeat item can hold before its clip runs
 * past LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC, at the slow edge of its rate band. Taken at the band
 * floor rather than the target because the floor is the slowest delivery the renderer will not
 * correct; a budget at the target would let an in-band slow render run past the ceiling unflagged.
 *
 * One budget for all seven items, because the floor is one (LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM).
 * It binds at items 6 and 7, whose word ceilings of 15 and 16 are the only ones above it; items 1–5
 * are bound by their word ceiling. Floored, so the reported cap is a word count an item can hit.
 */
export function listenAndRepeatWordBudgetAtPace(): number {
  return Math.floor(
    (LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC * LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM) / 60,
  );
}

/**
 * The pace policy the invariant is checked against. Production uses only the live constants; taking
 * it as an argument lets a test put a proposed retune through the same check.
 */
export type ListenAndRepeatPacePolicy = {
  readonly targetWpm: readonly number[];
  readonly wordCeilings: readonly number[];
  /** The uniform slow edge. Ignored when `bandFloorWpmByItem` is given. */
  readonly bandFloorWpm: number;
  /** A per-item slow edge, for checking a policy that has one per item. */
  readonly bandFloorWpmByItem?: readonly number[];
  readonly maxItemWords: number;
  readonly maxItemClipSec: number;
  readonly toleranceSec: number;
};

export type PaceInvariantViolation = {
  /** 1-based item position, so it reads as the ramp table does. */
  readonly item: number;
  readonly kind: "floor-below-ceiling-rate" | "tolerance-covers-ceiling";
  readonly detail: string;
};

const LIVE_PACE_POLICY: ListenAndRepeatPacePolicy = {
  targetWpm: LISTEN_AND_REPEAT_ITEM_TARGET_WPM,
  wordCeilings: LISTEN_AND_REPEAT_WORD_CEILINGS,
  bandFloorWpm: LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM,
  maxItemWords: LISTEN_AND_REPEAT_MAX_ITEM_WORDS,
  maxItemClipSec: LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC,
  toleranceSec: ABSOLUTE_DURATION_TOLERANCE_SEC,
};

/**
 * THE INVARIANT: for every item, a clip at that item's effective word ceiling that runs past the
 * clip ceiling must be visible to `renderClipWithPaceCorrection` as a miss. Every failing position
 * is reported, so a retune hears about all of them at once. Two halves:
 *
 *  1. `ceilingWords × 60 ÷ maxItemClipSec ≤ bandFloor`. The rate at which the longest permitted
 *     sentence exactly fills the clip ceiling must be inside the band's slow edge; otherwise a
 *     render can sit in band and still publish an over-ceiling clip.
 *
 *  2. `maxItemClipSec − ceilingWords × 60 ÷ target > toleranceSec`. `assessPace` does not gate on
 *     the band alone: `withinTolerance = inBand || |durationSec − targetDurationSec| ≤
 *     ABSOLUTE_DURATION_TOLERANCE_SEC`, and the repair keys off that OR. Wherever an item's target
 *     duration at its ceiling sits within that tolerance of the clip ceiling, a clip can break the
 *     ceiling, fall below the floor, and still read as in band.
 *
 * Pure and total: it computes and never throws. `assertListenAndRepeatPaceInvariant` is the half
 * that throws.
 */
export function listenAndRepeatPaceInvariantViolations(
  policy: ListenAndRepeatPacePolicy = LIVE_PACE_POLICY,
): PaceInvariantViolation[] {
  const violations: PaceInvariantViolation[] = [];
  policy.wordCeilings.forEach((wordCeiling, index) => {
    const floor = policy.bandFloorWpmByItem?.[index] ?? policy.bandFloorWpm;
    const ceilingWords = Math.min(wordCeiling, policy.maxItemWords);
    const rateThatFillsTheCeiling = (ceilingWords * 60) / policy.maxItemClipSec;
    if (rateThatFillsTheCeiling > floor) {
      violations.push({
        item: index + 1,
        kind: "floor-below-ceiling-rate",
        detail:
          `${ceilingWords} words need ${rateThatFillsTheCeiling.toFixed(1)} WPM to fit ` +
          `${policy.maxItemClipSec.toFixed(1)}s, but the band floor is ${floor} WPM — ` +
          `an in-band clip can run past the clip ceiling`,
      });
    }
    const target = policy.targetWpm[Math.min(index, policy.targetWpm.length - 1)]!;
    const margin = policy.maxItemClipSec - (ceilingWords * 60) / target;
    if (margin <= policy.toleranceSec) {
      violations.push({
        item: index + 1,
        kind: "tolerance-covers-ceiling",
        detail:
          `${ceilingWords} words target ${((ceilingWords * 60) / target).toFixed(2)}s, only ` +
          `${margin.toFixed(2)}s below the ${policy.maxItemClipSec.toFixed(1)}s clip ceiling — ` +
          `inside the ${policy.toleranceSec}s absolute duration tolerance, which would wave an ` +
          `over-ceiling clip through as in-band`,
      });
    }
  });
  return violations;
}

/**
 * Runs the invariant on the live constants and throws if it does not hold. Called at module load
 * below: everything it reads is a compile-time constant, so it can fail only because someone
 * retuned the ramp, and then it fails on the first import — in every test file and at server boot —
 * rather than inside a paid render.
 */
function assertListenAndRepeatPaceInvariant(): void {
  const violations = listenAndRepeatPaceInvariantViolations();
  if (violations.length === 0) return;
  throw new Error(
    "Listen and Repeat pace policy does not compose: " +
      violations.map((violation) => `item ${violation.item}: ${violation.detail}`).join("; "),
  );
}

assertListenAndRepeatPaceInvariant();

/**
 * The projected duration of `wordCount` words read at the slowest rate a Listen and Repeat clip's
 * band accepts: the longest a sentence of that length can run without any gate seeing a miss (see
 * `listenAndRepeatWordBudgetAtPace` for why the floor, not the target).
 *
 * Goes through audioPace's own `targetDurationSec`, so this gate and the renderer that measures the
 * finished clip agree on what "duration at a rate" means. The band handed to it is a point, because
 * one specific rate is being projected and a min/max would imply a tolerance this check lacks.
 */
function listenAndRepeatClipSecAtBandFloor(wordCount: number): number {
  const floor = LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM;
  return targetDurationSec(wordCount, { targetWpm: floor, minWpm: floor, maxWpm: floor });
}

/** A rendered Listen and Repeat clip that holds more speech than its clip ceiling allows. */
export type PublishedClipCeilingBreach = {
  /** The clip file this describes, e.g. "lr-7.mp3" — a filename, never sentence text. */
  readonly file: string;
  readonly wordCount: number;
  readonly speechDurationSec: number;
  readonly maxItemClipSec: number;
  /** Operator-readable, and with no clip content in it — it travels into logs and error messages. */
  readonly detail: string;
};

/**
 * The clip-ceiling check on a clip that has already been rendered and measured. The invariant above
 * is about the policy — at the word ceiling, read at the band floor, a clip fits — so it cannot see
 * a clip delivered below the band floor that runs past the ceiling anyway. This takes a
 * measurement, the only Listen and Repeat check that does.
 *
 * A breach does not fail the job (`audio-clip-ceiling` is repair-then-accept ending in advisory, in
 * generationCheckPolicy.ts): a clip past the ceiling makes its item harder than designed, not
 * unusable, and the Response is still judged on what the User said. The repair is the one corrective
 * re-render the clip already had, and the Set publishes with a note naming the item.
 *
 * No tolerance: a breach is strictly `>` the ceiling. A grace margin would rebuild the
 * `tolerance-covers-ceiling` hole the invariant's second half closes.
 *
 * Pure and total. The renderer decides what a breach leads to, and that only `lr-item` clips carry
 * a ceiling at all.
 */
export function listenAndRepeatPublishedClipBreach(input: {
  readonly file: string;
  readonly wordCount: number;
  /** SPEECH seconds (transcode.probeSpeechDurationSec), the quantity the ceiling is stated in. */
  readonly speechDurationSec: number;
  /**
   * The ceiling from the Set's own recorded audio profile where it records one, so a re-render of an
   * older Set is held to the policy that Set was made under — the same rule `listenAndRepeatItemBand`
   * follows for the band. Profiles v1–v3 record none, and the caller passes the live constant.
   */
  readonly maxItemClipSec: number;
}): PublishedClipCeilingBreach | undefined {
  // A non-finite or non-positive measurement is `assessPace`'s "malfunction" to fail, not this
  // check's to guess at: reporting it as a breach would relabel a truncated synthesis as an
  // over-long clip, and reporting it as clean would be a claim this function cannot support.
  if (!Number.isFinite(input.speechDurationSec) || input.speechDurationSec <= 0) return undefined;
  if (input.speechDurationSec <= input.maxItemClipSec) return undefined;
  return {
    file: input.file,
    wordCount: input.wordCount,
    speechDurationSec: input.speechDurationSec,
    maxItemClipSec: input.maxItemClipSec,
    detail:
      `${input.wordCount} words came back as ${input.speechDurationSec.toFixed(3)}s of speech, ` +
      `past the ${input.maxItemClipSec.toFixed(1)}s clip ceiling after the corrective re-render`,
  };
}

export type SpeakingViolationKind =
  /** A Listen and Repeat sentence runs past its item's published word ceiling. */
  | "lr-word-count-over"
  /**
   * A Listen and Repeat sentence would run past the published clip-duration ceiling when read at
   * the slowest rate its band accepts, even though it may sit inside its word ceiling.
   */
  | "lr-clip-duration-over";

export type SpeakingViolation = {
  readonly kind: SpeakingViolationKind;
  /** Where it was found, e.g. "listenAndRepeat/items[6]" — a position, never content. */
  readonly label: string;
  /** The offending Item's id. */
  readonly id: string;
  /** Actual vs expected, in operator-readable terms and with no sentence content in it. */
  readonly detail: string;
};

/**
 * The Item shape this check needs, structurally rather than by importing the schema's type: a test
 * can state one Item as a literal, and it documents that nothing here reads `audio` or
 * `responseWindowSec`. A SpeakingGenerationInput's Listen and Repeat item satisfies it.
 */
export type ListenAndRepeatItemLike = {
  readonly id: string;
  readonly sentence: string;
};

/**
 * Both Listen and Repeat budgets, every violating item reported at once and never a throw, so
 * speakingGenerator.ts can turn the whole list into one regeneration prompt — the same contract
 * buildASentenceViolations keeps. Item order, and within an item the word budget before the clip
 * budget.
 *
 * The two budgets are checked independently rather than one suppressing the other: an item can
 * violate either without the other, and a regeneration told one fact at a time spends a
 * regeneration per fact.
 *
 * The schema fixes the array at exactly 7 items; if a caller hands more, the extras are measured
 * against the last item's word ceiling rather than skipped, so nothing escapes by position.
 */
export function listenAndRepeatViolations(
  items: readonly ListenAndRepeatItemLike[],
): SpeakingViolation[] {
  const violations: SpeakingViolation[] = [];
  items.forEach((item, index) => {
    const label = `listenAndRepeat/items[${index}]`;
    const ceiling =
      LISTEN_AND_REPEAT_WORD_CEILINGS[
        Math.min(index, LISTEN_AND_REPEAT_WORD_CEILINGS.length - 1)
      ];
    const words = countEnglishWords(item.sentence);
    if (words > ceiling) {
      violations.push({
        kind: "lr-word-count-over",
        label,
        id: item.id,
        detail: `${words} words against a ceiling of ${ceiling} for item ${index + 1}`,
      });
    }
    // Projected at the band floor, the same rate listenAndRepeatWordBudgetAtPace quotes, so the
    // check and the cap named in its detail agree.
    const seconds = listenAndRepeatClipSecAtBandFloor(words);
    if (seconds > LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC) {
      violations.push({
        kind: "lr-clip-duration-over",
        label,
        id: item.id,
        detail:
          `${words} words runs about ${seconds.toFixed(1)}s at the slowest pace item ${index + 1}'s ` +
          `band accepts, past the ${LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC.toFixed(1)}s clip ceiling ` +
          `(at most ${listenAndRepeatWordBudgetAtPace()} words for item ${index + 1})`,
      });
    }
  });
  return violations;
}

