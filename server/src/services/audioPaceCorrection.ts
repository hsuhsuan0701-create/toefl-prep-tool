// The bounded corrective re-render loop both audio renderers share. A clip that misses its pace band
// is re-rendered with a prompt telling the model which way to move, and the better take is published
// either way: a missed band never fails a Set (the repair-then-accept tier of ADR 0006).
//
// How many re-renders is the caller's budget, one by default. After the first, a round is bought only
// while the clip is still far below its band (audioPace.ts's farBelowBand), and each round's wording
// pushes harder (audioPrompt.ts's escalation ladder), because re-asking in the same words buys the
// same take again. Listening raises the budget (LISTENING_PACE_CORRECTION_ROUNDS); Speaking keeps the
// default.
//
// The loop lives here rather than in either renderer so the two sections cannot behave differently
// (audioPaceParity.test.ts); they differ only in the budget they pass.

import type { SetAdvisoryNote } from "@toefl-prep/shared";
import { assessPace, farBelowBand, type PaceAssessment, type PaceBand } from "./audioPace.js";
import { classifyGenerationCheck } from "./generationCheckPolicy.js";
import { type PaceCorrection, type PaceDirection } from "./audioPrompt.js";

/**
 * Which way to nudge a clip that missed its band. Above the ceiling means slow down; anything else
 * that is out of band means speed up.
 *
 * `inBand` is false for BOTH directions, so the ceiling is what distinguishes them — not `wpm` versus
 * `targetWpm`, which would call a clip inside its band but above target "too fast" and correct a clip
 * that never needed correcting.
 */
export function paceDirectionFor(
  assessment: PaceAssessment,
  band: PaceBand,
): PaceDirection {
  return assessment.wpm > band.maxWpm ? "slower" : "faster";
}

/**
 * The budget a caller that passes none gets: one corrective re-render, then accept. Listening raises
 * it at its own call site, so a section that has not measured an escalation does not pay for one.
 */
export const DEFAULT_MAX_CORRECTION_ROUNDS = 1;

export type PaceCorrectionOutcome<Take = void> = {
  /** The take that should be published, and the assessment that describes it. */
  readonly publishPath: string;
  readonly assessment: PaceAssessment;
  /** Whether a corrective re-render was bought at all. */
  readonly corrected: boolean;
  /**
   * Whatever `onTake` returned for the published take. This module alone decides which take ships
   * (the better one, not the newer), so the caller marks that take published from this handle rather
   * than re-deriving the choice from `correctionCount` or `publishPath`. Every take is recorded as
   * discarded when measured, so only the winner needs naming.
   */
  readonly publishedTake: Take;
  /**
   * Set only when the published take is still outside its band: the advisory note naming the
   * measured rate and the band. A clip that ends in band publishes with no note.
   */
  readonly note?: SetAdvisoryNote;
};

/**
 * Renders one clip, then re-renders it, at most `maxCorrectionRounds` times, while it misses its band.
 *
 * `synthesize` gets the correction to apply (undefined on the first take) and the path to write.
 * `onTake` fires for every take, discarded ones included, so a correction that failed is on record;
 * `correctionCount` is 0 for the first take and the round number for each re-render.
 *
 * Round 1 is bought for any out-of-band first take. Each later round only while the take that would
 * publish is still `farBelowBand`: a clip already within one nudge of its band has had the nudge that
 * can move it.
 *
 * Never fails over pace. A malfunctioning FIRST take is returned for the caller to reject (the policy
 * calls it fatal). Once the first take is merely out of band, something always publishes: a
 * corrective take that throws or malfunctions is discarded and the better earlier take kept.
 */
export async function renderClipWithPaceCorrection<Take>(input: {
  /** The section rendering the clip: the pace tier is asked of generationCheckPolicy per section. */
  section: "speaking" | "listening";
  band: PaceBand;
  wordCount: number;
  /**
   * Where the take for one round is written: round 0 is the first take, 1…`maxCorrectionRounds` each
   * corrective re-render. Every round MUST get its own path — both takes of a comparison exist on
   * disk at once, so a reused path would overwrite the take being compared against.
   */
  takePath: (round: number) => string;
  /**
   * How many corrective re-renders this clip may buy, at most; truncated to an integer, one by
   * default. Values below one are read as one: this loop's contract is that an out-of-band clip gets
   * a correction.
   */
  maxCorrectionRounds?: number;
  synthesize: (correction: PaceCorrection | undefined, outPath: string) => Promise<void>;
  probeDuration: (filePath: string) => Promise<number>;
  /**
   * Fires for EVERY take. Whatever it returns is this module's HANDLE on that take, opaque here and
   * handed straight back as `publishedTake` for the one that wins — see PaceCorrectionOutcome.
   */
  onTake: (assessment: PaceAssessment, correctionCount: number) => Take;
  /** Identifies the clip in its advisory note. A server-owned role label, never content. */
  role: string;
  /**
   * Which clip, for the advisory note, so a Set with twenty Listen and Choose a Response clips says
   * which one is slow. An id the server derives (listeningAudioRenderer's speechRateClipLabels),
   * never a model-written one and never content; it must satisfy SafeIdSchema. Omitted, the note
   * names only the role.
   */
  clipId?: string;
  discardTake: (filePath: string) => void;
}): Promise<PaceCorrectionOutcome<Take>> {
  const measure = async (filePath: string): Promise<PaceAssessment> => {
    const durationSec = await input.probeDuration(filePath);
    return assessPace({ wordCount: input.wordCount, durationSec, band: input.band });
  };
  const budget = Math.max(1, Math.trunc(input.maxCorrectionRounds ?? DEFAULT_MAX_CORRECTION_ROUNDS));

  const firstPath = input.takePath(0);
  await input.synthesize(undefined, firstPath);
  const first = await measure(firstPath);

  // The take that would publish if the loop stopped now: the best seen, never the newest. Whether to
  // buy another round, which way to nudge, and what the note says all read it.
  let best = { path: firstPath, assessment: first, take: input.onTake(first, 0), round: 0 };
  let rounds = 0;

  // Only an out-of-band verdict is repairable: in-band needs nothing, and a malfunction is fatal at
  // the caller. Asked of generationCheckPolicy rather than matched here, so the tiers have one home.
  const repairable = (assessment: PaceAssessment): boolean =>
    classifyGenerationCheck({ family: "audio-pace", section: input.section, verdict: assessment.verdict })
      .tier === "repair-then-accept";

  // The loop ends when the budget runs out, when the take that would publish is no longer
  // repairable, or when a bought round throws (the `break` below: a provider that just refused a call
  // is not one to spend the rest of the budget on). A retake that comes back MALFUNCTIONING does not
  // end it: that says nothing about the pace of the take that would publish, so the retake just loses
  // the comparison and the loop keeps spending, still bounded by the budget. Pinned by
  // audioPaceCorrection.test.ts.
  while (
    rounds < budget &&
    repairable(best.assessment) &&
    // Round 1 for any miss; rounds 2+ only for a miss one nudge could not have closed.
    (rounds === 0 || farBelowBand(best.assessment, input.band))
  ) {
    rounds += 1;
    const retakePath = input.takePath(rounds);
    let retake: PaceAssessment;
    // A corrective call can fail (a 429, a 5xx, a probe that finds no file). Letting it propagate
    // would make the renderer delete every clip the Set has already paid for, over a clip that was
    // merely off pace.
    try {
      // The nudge is relative to the take that would publish, not the last one: that is the gap being
      // closed. Each synthesis is stateless, so "the last take" in the prompt is direction only.
      await input.synthesize(
        { direction: paceDirectionFor(best.assessment, input.band), round: rounds },
        retakePath,
      );
      retake = await measure(retakePath);
    } catch (error) {
      // The best take so far is on disk and publishable: keep it and stop buying.
      input.discardTake(retakePath);
      console.warn(
        `[audioPaceCorrection] corrective re-render failed for role=${input.role}; keeping the best take so far: ${
          error instanceof Error ? error.name : "unknown"
        }`,
      );
      break;
    }
    const retakeTake = input.onTake(retake, rounds);

    // Which take wins: the better one, not the newer. A nudge can overshoot (a 172 WPM clip against a
    // 150-170 band can come back at 95, inside the sanity window but far worse), and the loser of each
    // comparison is deleted so it cannot be published by accident.
    //
    // "Better" is the verdict first, band distance only as a tie-break. The verdict also admits a clip
    // within ABSOLUTE_DURATION_TOLERANCE_SEC of its target, which on a clip of about six words or
    // fewer can sit past the band edge in WPM: ranked on distance alone, such a retake would lose to
    // an out-of-band first take that is nearer the band. Written symmetrically, although `best` is
    // always out of band when a round runs, so the rule holds if the loop guard ever changes.
    const retakeInBand = retake.verdict === "in-band";
    const bestInBand = best.assessment.verdict === "in-band";
    const keepBest = retake.verdict === "malfunction" ||
      (retakeInBand === bestInBand
        ? bandDistance(retake, input.band) >= bandDistance(best.assessment, input.band)
        : bestInBand);
    if (keepBest) {
      input.discardTake(retakePath);
    } else {
      input.discardTake(best.path);
      best = { path: retakePath, assessment: retake, take: retakeTake, round: rounds };
    }
  }

  return {
    publishPath: best.path,
    assessment: best.assessment,
    corrected: rounds > 0,
    publishedTake: best.take,
    // No note for a clip that ended in band, nor for a malfunction, which the caller rejects.
    ...(rounds > 0 && best.assessment.verdict === "out-of-band"
      ? {
        note: paceNote(
          best.assessment,
          input.band,
          input.role,
          best.round === 0 ? "first" : "retake",
          input.clipId,
        ),
      }
      : {}),
  };
}

/**
 * How far outside its WPM band a clip sits; zero inside it. Only the tie-break between two takes
 * whose verdicts agree, never the ranking: the verdict also admits a clip within
 * ABSOLUTE_DURATION_TOLERANCE_SEC of its target, which this does not see. Measured from the band
 * edge rather than the target, so a clip inside the band never loses to one nearer the middle.
 */
function bandDistance(assessment: PaceAssessment, band: PaceBand): number {
  if (assessment.wpm < band.minWpm) return band.minWpm - assessment.wpm;
  if (assessment.wpm > band.maxWpm) return assessment.wpm - band.maxWpm;
  return 0;
}

/**
 * The note a still-missed band leaves on the published Set. Numbers, a role label and a Stimulus id
 * only — the same discipline SetAdvisoryNoteSchema enforces structurally, since a clip's transcript
 * must never reach a channel that renders in the UI. The id is server-generated and constrained to a
 * safe filename segment, so naming the clip adds an identifier and not a word of its content.
 */
function paceNote(
  assessment: PaceAssessment,
  band: PaceBand,
  role: string,
  // Which take was published, so the UI can tell a kept re-recording from an original whose
  // re-recordings came back worse or failed. "retake" covers every corrective round; how many were
  // bought is in clip_measurements and the manifest.
  take: "first" | "retake",
  clipId: string | undefined,
): SetAdvisoryNote {
  return {
    check: "speech-rate",
    detail: role,
    ...(clipId ? { clipId } : {}),
    take,
    measuredWpm: Number(assessment.wpm.toFixed(1)),
    targetWpm: band.targetWpm,
    minWpm: band.minWpm,
    maxWpm: band.maxWpm,
  };
}
