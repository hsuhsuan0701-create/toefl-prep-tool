import type { SpeakingSet } from "@toefl-prep/shared";
import { resolveRealPathWithinBase } from "../lib/paths.js";
import { assessPace, countEnglishWords, type PaceVerdict } from "./audioPace.js";
import { buildSpeakingRenderPlan } from "./speakingAudioRenderer.js";

/** The median of a non-empty list. */
export function median(values: readonly number[]): number {
  if (!values.length) throw new Error("cannot calculate median of no values");
  const sorted = [...values].sort((a, b) => a - b); const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * One published clip's pace, as scripts/audit-speaking-audio.ts reports it. Measurements and
 * provenance only: never the sentence, question or scenario text the clip speaks.
 */
export type SpeakingClipAudit = {
  role: string;
  file: string;
  wordCount: number;
  durationSec: number;
  wpm: number;
  targetWpm: number;
  minWpm: number;
  maxWpm: number;
  /** assessPace's `withinTolerance`: in band, or within the absolute duration tolerance. */
  pass: boolean;
  /** The stricter WPM-band answer alone. */
  inBand: boolean;
  verdict: PaceVerdict;
  profile: string;
  accent: string;
};

/**
 * Re-measures a published Speaking Set's clips the way the renderer measured them when it rendered
 * them: each clip's band comes from buildSpeakingRenderPlan over the Set's OWN recorded profile (so
 * each Listen and Repeat item gets its own target), the duration from `probe` (the renderer's speech
 * span, transcode.probeSpeechDurationSec, in production), and the verdict from assessPace. The files
 * measured are the ones the Set points at, resolved under `audioRoot` (`<dataDir>/audio`).
 */
export async function auditSpeakingSetAudio(
  set: SpeakingSet,
  audioRoot: string,
  probe: (filePath: string) => Promise<number>,
): Promise<SpeakingClipAudit[]> {
  const profile = set.audioProfile;
  if (!profile) throw new Error(`speaking set ${set.id} records no audio profile, so it has no rendered pace to audit`);
  const plan = buildSpeakingRenderPlan(set, profile);
  // Same order as the plan: briefing, the seven items, the interview intro, the four questions.
  const audio = [
    set.listenAndRepeat.introAudio,
    ...set.listenAndRepeat.items.map((item) => item.audio),
    set.interview.introAudio,
    ...set.interview.questions.map((question) => question.audio),
  ];
  if (audio.length !== plan.length) throw new Error(`speaking set ${set.id} does not have one audio file per planned clip`);

  const clips: SpeakingClipAudit[] = [];
  for (const [index, clip] of plan.entries()) {
    const relative = audio[index];
    if (!relative) throw new Error(`speaking set ${set.id} has no audio for ${clip.file}`);
    const durationSec = await probe(resolveRealPathWithinBase(relative, audioRoot));
    const wordCount = countEnglishWords(clip.text);
    const assessment = assessPace({ wordCount, durationSec, band: clip.band });
    clips.push({
      role: clip.role,
      file: clip.file,
      wordCount,
      durationSec,
      wpm: assessment.wpm,
      targetWpm: clip.band.targetWpm,
      minWpm: clip.band.minWpm,
      maxWpm: clip.band.maxWpm,
      pass: assessment.withinTolerance,
      inBand: assessment.inBand,
      verdict: assessment.verdict,
      profile: profile.version,
      accent: clip.accent,
    });
  }
  return clips;
}
