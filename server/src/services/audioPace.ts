// Pace measurement and the pace verdict for synthesized clips, shared by both audio renderers:
// count a clip's words, compare its speech rate with its role's band, and decide whether it is in
// band, out of band, or a malfunction. Every comparison of a clip against its band lives here, so
// Speaking and Listening reach the same verdict from the same numbers; audioPaceParity.test.ts fails
// if a service or script defines its own copy of one of these pace constants or functions.

export type PaceBand = { readonly targetWpm: number; readonly minWpm: number; readonly maxWpm: number };

/**
 * Word count for pace math. A contraction or hyphenated word counts once, with either apostrophe:
 * TTS scripts use the ASCII ' but some generated transcripts carry the typographic ’, and splitting a
 * contraction in two would over-count words and overstate WPM.
 */
export function countEnglishWords(text: string): number {
  return text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g)?.length ?? 0;
}

/**
 * Words per minute. `durationSec` is SPEECH duration, the file less the silence at each end: both
 * renderers are given transcode.ts's `probeSpeechDurationSec` by generator.ts, and every pace band
 * in the codebase is stated in speech rate. Gemini opens and closes every clip with a near-constant ~0.68 s of
 * silence, and a fixed cost counted as speech understates the rate most on the shortest clips.
 * Interior pauses are kept: a pause between clauses is delivery, which is what a WPM band measures.
 * The padding measurements are in docs/research/2026-08-23-ets-reference-audio-padding.md.
 */
export function wordsPerMinute(wordCount: number, durationSec: number): number {
  return (wordCount / durationSec) * 60;
}

export function targetDurationSec(wordCount: number, band: PaceBand): number {
  return (wordCount / band.targetWpm) * 60;
}

export function inBand(wpm: number, band: PaceBand): boolean {
  return wpm >= band.minWpm && wpm <= band.maxWpm;
}

// The sanity window, as multiples of a clip's target duration. A clip outside it is a malfunction
// (empty, truncated, or a stuck or looping synthesis) and fails the render; inside it, pace is only
// ever a band question. Wide on purpose: narrowing it toward the band would turn ordinary pace
// variance into a hard failure.
export const SANITY_MIN_DURATION_RATIO = 0.3;
export const SANITY_MAX_DURATION_RATIO = 3.0;

// A clip is also within tolerance when its duration is within this many seconds of its target
// duration, whatever its WPM. A WPM band is a duration window that narrows with clip length (at 7
// words a 150-170 band spans 330 ms), so without this an imperceptible timing difference on a short
// clip counts as a miss. 0.4 s is sized to cover a recorded 7-word clip 0.249 s from its target with
// about 1.6x headroom. Once a band's duration half-width exceeds 0.4 s the band is the tighter
// test and this never applies.
export const ABSOLUTE_DURATION_TOLERANCE_SEC = 0.4;

// How far below its band floor, in WPM, a clip must sit before one prompt nudge is no longer a
// plausible repair. audioPaceCorrection buys further, escalating rounds only for such clips. A nudge
// was measured to move an `lcr-utterance` clip about 7 WPM (median, n=75), and a miss within 15 WPM
// of an edge was judged within one nudge's reach
// (docs/research/2026-08-23-listening-role-band-recentring.md). Below the floor only, because the
// recorded misses are slow ones; a clip far above its ceiling still gets one correction. On the
// recorded Listening bank this selects about 18 % of `lcr-utterance` first takes and almost no
// other clip.
//
// Gate-only: nothing derived from it reaches a prompt (audioPrompt.ts words every pace instruction
// as prose), so the model cannot aim at it.
export const FAR_BELOW_BAND_WPM = 15;

export type PaceVerdict = "in-band" | "out-of-band" | "malfunction";

export type PaceAssessment = {
  readonly wordCount: number;
  readonly durationSec: number;
  readonly wpm: number;
  readonly targetDurationSec: number;
  readonly inBand: boolean;
  readonly withinTolerance: boolean;
  readonly withinSanity: boolean;
  readonly verdict: PaceVerdict;
};

/**
 * The pace verdict for one clip, from three checks in order of authority:
 *   1. withinSanity — the only hard failure (verdict "malfunction"): a truncated, empty or
 *      stuck synthesis. Pace variance never fails it.
 *   2. inBand — the WPM band itself.
 *   3. withinTolerance — inBand OR within ABSOLUTE_DURATION_TOLERANCE_SEC of the target duration.
 *      The verdict is "in-band" when this holds, else "out-of-band".
 *
 * A non-positive or non-finite `wordCount` or `durationSec` is a malfunction too, returned rather than
 * thrown so a render loop fails the clip instead of crashing mid-run. No field of the result is ever
 * NaN or Infinity, the echoed inputs included.
 */
export function assessPace(input: {
  wordCount: number;
  durationSec: number;
  band: PaceBand;
}): PaceAssessment {
  const { wordCount, durationSec, band } = input;

  if (!Number.isFinite(wordCount) || wordCount <= 0 || !Number.isFinite(durationSec) || durationSec <= 0) {
    return {
      wordCount: Number.isFinite(wordCount) ? wordCount : 0,
      durationSec: Number.isFinite(durationSec) ? durationSec : 0,
      wpm: 0,
      targetDurationSec: 0,
      inBand: false,
      withinTolerance: false,
      withinSanity: false,
      verdict: "malfunction",
    };
  }

  const wpm = wordsPerMinute(wordCount, durationSec);
  const target = targetDurationSec(wordCount, band);
  const withinSanity =
    durationSec >= SANITY_MIN_DURATION_RATIO * target && durationSec <= SANITY_MAX_DURATION_RATIO * target;
  const bandOk = inBand(wpm, band);
  const withinTolerance = bandOk || Math.abs(durationSec - target) <= ABSOLUTE_DURATION_TOLERANCE_SEC;
  const verdict: PaceVerdict = !withinSanity ? "malfunction" : withinTolerance ? "in-band" : "out-of-band";

  return {
    wordCount,
    durationSec,
    wpm,
    targetDurationSec: target,
    inBand: bandOk,
    withinTolerance,
    withinSanity,
    verdict,
  };
}

/**
 * Whether this clip is far enough below its band that one prompt nudge cannot plausibly repair it
 * (see FAR_BELOW_BAND_WPM). Reads the verdict rather than re-deriving "out of band", so a clip that
 * ABSOLUTE_DURATION_TOLERANCE_SEC puts in band is never far below anything and never buys a round.
 */
export function farBelowBand(assessment: PaceAssessment, band: PaceBand): boolean {
  return assessment.verdict === "out-of-band" && assessment.wpm < band.minWpm - FAR_BELOW_BAND_WPM;
}

/**
 * The one line a renderer logs for an out-of-band clip. It takes only a role and a file name, so no
 * transcript, scenario or prompt text can reach the log. It says the clip was kept and published,
 * so the warning is not mistaken for a lost clip.
 */
export function paceWarning(
  assessment: PaceAssessment,
  context: { role: string; file: string }
): string {
  return (
    `pace out-of-band, clip kept and published: role=${context.role} file=${context.file} ` +
    `wordCount=${assessment.wordCount} durationSec=${assessment.durationSec.toFixed(3)} ` +
    `wpm=${assessment.wpm.toFixed(1)} targetDurationSec=${assessment.targetDurationSec.toFixed(3)}`
  );
}
