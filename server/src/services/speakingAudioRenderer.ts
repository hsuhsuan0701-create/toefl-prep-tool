import fs from "node:fs";
import path from "node:path";
import {
  LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM,
  LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC,
  type SetAdvisoryNote,
  type SpeakingAccent,
  type SpeakingAudioProfile,
  type SpeakingSet,
} from "@toefl-prep/shared";
import { countEnglishWords, paceWarning, type PaceBand } from "./audioPace.js";
import { renderClipWithPaceCorrection } from "./audioPaceCorrection.js";
import { classifyGenerationCheck } from "./generationCheckPolicy.js";
import { listenAndRepeatPublishedClipBreach } from "./speakingConformance.js";
import { assertDeliveryPromptDelimitable, buildDeliveryPrompt, type DeliveryNotes } from "./audioPrompt.js";
import { profileForSetId } from "./speakingAudioProfile.js";
import { markPublishedTakes, publishClipTake, recordClipTake, type ClipTakeRecord } from "./clipTakeManifest.js";
import { recordAdvisoryNotes } from "./setAdvisoryLedger.js";
import { renderClipsBounded } from "./ttsQueue.js";
import type { TtsRequest } from "./tts.js";

// Renders a Speaking Set's thirteen clips (the Listen and Repeat briefing and seven sentences, the
// Interview intro and four questions) with Gemini text-to-speech into the Set's audio directory,
// measuring each against its pace band. Shares its prompt builder (audioPrompt.ts), pace-correction
// loop (audioPaceCorrection.ts) and TTS queue (ttsQueue.ts) with listeningAudioRenderer.ts.

type Role = "lr-briefing" | "lr-item" | "interview-intro" | "interview-question";

/** `synthesize` is the paid TTS call; `probeDuration` should measure speech duration (audioPace.ts). */
export type SpeakingAudioRendererDeps = {
  synthesize(request: TtsRequest, outPath: string): Promise<void>;
  probeDuration(filePath: string): Promise<number>;
};
export type SpeakingAudioRenderTarget = { setId: string; outputDir: string; audioPathPrefix: string };
export type ClipMeasurement = { role: Role; file: string; wordCount: number; durationSec: number; wpm: number };
export type SpeakingAudioRenderResult = { set: SpeakingSet; profile: SpeakingAudioProfile; measurements: ClipMeasurement[] };
export type SpeakingAudioProgress = { done: number; total: 13; setId: string };
/** The output directory already exists or cannot be created; the render leaves it untouched. */
export class SpeakingAudioOutputCollisionError extends Error {
  constructor() { super("speaking audio render output directory already exists or cannot be acquired"); this.name = "SpeakingAudioOutputCollisionError"; }
}

/**
 * The pace band for each Speaking clip role, in words per minute of speech. Verdicts come from
 * audioPace.ts, the same function Listening uses. A clip that misses its band gets one corrective
 * re-render (audioPaceCorrection.ts's default budget) and is published either way, with an advisory
 * note if it still misses; of the pace verdicts only a malfunction (a truncated, empty or stuck
 * synthesis) fails the render.
 *
 * The `lr-item` row is the flat band of the v1-v3 profiles. A Set on v4 or later paces each Listen
 * and Repeat item to its own target instead (listenAndRepeatItemBand).
 */
export const AUDIO_ROLE_POLICY: Record<Role, PaceBand> = {
  "lr-briefing": { targetWpm: 165, minWpm: 145, maxWpm: 195 },
  "lr-item": { targetWpm: 180, minWpm: 150, maxWpm: 225 },
  "interview-intro": { targetWpm: 165, minWpm: 145, maxWpm: 195 },
  "interview-question": { targetWpm: 155, minWpm: 130, maxWpm: 180 },
};

/**
 * How far above its own target a Listen and Repeat item's band reaches. One margin for all seven
 * items, so retuning the targets carries the tolerance with them. The slow edge is not this margin:
 * it is the shared LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM, derived from the clip ceiling, because the
 * slow edge is the one an over-length clip falls out of. How long a clip runs, which is what makes an
 * item hard to repeat, is held by that ceiling rather than by this edge.
 */
export const LR_ITEM_BAND_FAST_MARGIN_WPM = 25;

/**
 * The pace band for Listen and Repeat item `index` (0-based) under `profile`.
 *
 * Read off the Set's recorded profile, not a module constant, so an audit or re-render of an older
 * Set gets the policy it was made under. A profile with one flat `itemTargetWpm` (v1-v3) gets the
 * flat AUDIO_ROLE_POLICY band; one with per-item `itemTargetWpms` (v4 on) gets the shared floor and
 * this item's target plus LR_ITEM_BAND_FAST_MARGIN_WPM. The fork is on the field, not on version
 * strings, so a later version with the same shape needs no change here. An index outside 0-6 is
 * clamped to the nearest item rather than skipped.
 */
export function listenAndRepeatItemBand(profile: SpeakingAudioProfile, index: number): PaceBand {
  if (!("itemTargetWpms" in profile.listenAndRepeat)) return AUDIO_ROLE_POLICY["lr-item"];
  const targets = profile.listenAndRepeat.itemTargetWpms;
  const targetWpm = targets[Math.min(Math.max(index, 0), targets.length - 1)];
  return {
    targetWpm,
    minWpm: LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM,
    maxWpm: targetWpm + LR_ITEM_BAND_FAST_MARGIN_WPM,
  };
}

/**
 * The speech-duration ceiling, in seconds, that a Set's Listen and Repeat item clips are held to.
 * Read off the profile like listenAndRepeatItemBand. A v1-v3 profile records no ceiling and gets the
 * current constant, the strict choice: nothing should ship over the ceiling because its profile
 * predates it.
 */
export function listenAndRepeatClipCeilingSec(profile: SpeakingAudioProfile): number {
  return "itemMaxClipSec" in profile.listenAndRepeat
    ? profile.listenAndRepeat.itemMaxClipSec
    : LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC;
}

// ---------------------------------------------------------------------------
// Delivery direction (audioPrompt.ts's Audio Profile / Scene / Style, per role)
// ---------------------------------------------------------------------------

type RoleDelivery = {
  /** audioPrompt.ts's "Audio Profile" line — what kind of recording this is. */
  readonly audioProfile: string;
  /** audioPrompt.ts's "Scene" line. */
  readonly scene: string;
  /** audioPrompt.ts's "Style" director's note. */
  readonly style: string;
};

// Every string here is read by the model as direction, so they are written as real prose rather
// than shorthand. `accent` and `band` are not in this table: the accent comes from the Set's audio
// profile and the band from the render plan.
const ROLE_DELIVERY: Readonly<Record<Role, RoleDelivery>> = {
  "lr-briefing": {
    audioProfile: "spoken directions for an English speaking exam",
    scene: "a proctor setting up the task",
    style: "calm and instructional, unhurried",
  },
  // The learner hears this sentence once and repeats it back, so its delivery is the exercise: read
  // at the wrong speed, or over-enunciated like a dictation, it is a different task from ETS's.
  "lr-item": {
    audioProfile: "one sentence a test taker will hear once and repeat",
    scene: "a single clear model sentence",
    style: "natural and unforced, clearly articulated without sounding dictated",
  },
  "interview-intro": {
    audioProfile: "spoken directions opening an interview task",
    scene: "an interviewer greeting the candidate",
    style: "warm and welcoming, at ease",
  },
  "interview-question": {
    audioProfile: "one interview question a test taker will answer aloud",
    scene: "an interviewer asking a question",
    style: "conversational and genuinely curious, as if the answer matters",
  },
};

export type SpeakingClipSpec = {
  role: Role;
  file: string;
  text: string;
  voice: string;
  accent: SpeakingAccent;
  /**
   * This clip's own pace band. On the plan rather than looked up from `role` because the seven
   * Listen and Repeat items share one role but carry their own targets. The delivery prompt, the
   * correction loop and the assessment all read this one band.
   */
  band: PaceBand;
};

/** The canonical ordered work list shared by preflight validation and paid rendering. */
export function buildSpeakingRenderPlan(
  set: SpeakingSet,
  profile: SpeakingAudioProfile,
): SpeakingClipSpec[] {
  return [
    { role: "lr-briefing", file: "briefing.mp3", text: set.listenAndRepeat.scenarioDescription, voice: profile.listenAndRepeat.voice, accent: profile.listenAndRepeat.accent, band: AUDIO_ROLE_POLICY["lr-briefing"] },
    ...set.listenAndRepeat.items.map((item, index) => ({ role: "lr-item" as const, file: `${item.id}.mp3`, text: item.sentence, voice: profile.listenAndRepeat.voice, accent: profile.listenAndRepeat.accent, band: listenAndRepeatItemBand(profile, index) })),
    { role: "interview-intro", file: "int-intro.mp3", text: set.interview.intro, voice: profile.interview.voice, accent: profile.interview.accent, band: AUDIO_ROLE_POLICY["interview-intro"] },
    ...set.interview.questions.map((question) => ({ role: "interview-question" as const, file: `${question.id}.mp3`, text: question.question, voice: profile.interview.voice, accent: profile.interview.accent, band: AUDIO_ROLE_POLICY["interview-question"] })),
  ];
}

/** The Audio Profile / Scene / Director's Notes audioPrompt.ts turns into this clip's prompt. */
export function deliveryNotes(clip: Pick<SpeakingClipSpec, "role" | "accent" | "band">): DeliveryNotes {
  const delivery = ROLE_DELIVERY[clip.role];
  return {
    audioProfile: delivery.audioProfile,
    scene: delivery.scene,
    style: delivery.style,
    accent: clip.accent,
    band: clip.band,
  };
}

function removeOutput(outputDir: string): void { fs.rmSync(outputDir, { recursive: true, force: true }); }

/**
 * Everything one clip contributes to the render, returned rather than pushed into shared arrays:
 * clips render concurrently, and the manifest's clip order is read downstream (`lr-1`…`lr-7` are a
 * difficulty ramp). `takes` holds every take the clip bought, in order, whichever one shipped.
 */
type RenderedClip = {
  measurement: ClipMeasurement;
  takes: ClipTakeRecord[];
  note?: SetAdvisoryNote;
  ceilingNote?: SetAdvisoryNote;
};

const ITEM_ID = /^[A-Za-z0-9_-]+$/;
const RESERVED_BASENAMES = new Set(["briefing", "int-intro", "audio-manifest"]);

/**
 * Why the Set's Item ids could not each name a clip file of their own, or `undefined` when they
 * can. Every Listen and Repeat item and Interview question is one clip, `<id>.mp3`, in one directory
 * beside `briefing.mp3`, `int-intro.mp3` and `audio-manifest.json`, so each id must be a safe
 * filename segment, must not be one of those names, and must differ from every other id compared
 * without case, because the directory may sit on a case-insensitive filesystem.
 *
 * The candidate stage asks this before anything is rendered (speakingCandidateAdapter), and
 * validateRenderInput asks it again before any synthesis. Ids only in the message.
 */
export function speakingClipIdProblem(set: Pick<SpeakingSet, "listenAndRepeat" | "interview">): string | undefined {
  const seen = new Map<string, string>();
  for (const item of [...set.listenAndRepeat.items, ...set.interview.questions]) {
    if (!ITEM_ID.test(item.id)) return `item ID "${item.id}" is not a safe filename segment`;
    const basename = item.id.toLowerCase();
    if (RESERVED_BASENAMES.has(basename)) return `item ID "${item.id}" is a reserved clip name`;
    const clash = seen.get(basename);
    if (clash !== undefined) return `item IDs "${clash}" and "${item.id}" name the same clip file`;
    seen.set(basename, item.id);
  }
  return undefined;
}

function validateRenderInput(
  set: SpeakingSet,
  target: SpeakingAudioRenderTarget,
  clips: readonly SpeakingClipSpec[],
): void {
  if (set.id !== target.setId) throw new Error("speaking set ID does not match render target");
  if (set.listenAndRepeat.items.length !== 7 || set.interview.questions.length !== 4) {
    throw new Error("speaking audio render requires exactly 7 Listen and Repeat items and 4 Interview questions");
  }
  const clipIdProblem = speakingClipIdProblem(set);
  if (clipIdProblem) throw new Error(`speaking audio render ${clipIdProblem}`);
  // Each clip's text is checked here, before any spend, for the two things that would otherwise fail
  // the render inside the paid loop and discard every clip already bought: a prompt
  // buildDeliveryPrompt refuses (a line that reads as a director's-notes section, such as
  // "Style: …"), and no English words to measure pace by. The prompt check is the same function
  // buildDeliveryPrompt calls, over this clip's real notes, so it cannot be narrower than the
  // render-time throw. listeningAudioRenderer's buildRenderPlan makes the same two checks.
  if (clips.length !== 13) throw new Error("speaking audio render requires exactly 13 clips");
  for (const clip of clips) {
    // Throws TranscriptContaminationError, whose message carries no clip text.
    assertDeliveryPromptDelimitable(deliveryNotes(clip), clip.text);
    if (!countEnglishWords(clip.text)) {
      throw new Error(`audio clip ${path.posix.basename(clip.file, ".mp3")} has no English words`);
    }
  }
}

/**
 * Renders the Set's thirteen clips into `target.outputDir` and returns the Set with its audio paths,
 * its audioProfile, and an advisory note for each clip that still misses its pace band or (a Listen
 * and Repeat item) its clip ceiling. Every take is recorded in the manifest and in
 * clip_measurements. `onProgress` reports a count of finished clips, not an index.
 *
 * All or nothing on disk: any failure deletes the output directory before rethrowing. A
 * pre-existing directory is a SpeakingAudioOutputCollisionError and is left untouched.
 */
export async function renderSpeakingAudio(set: SpeakingSet, target: SpeakingAudioRenderTarget, deps: SpeakingAudioRendererDeps, onProgress?: (progress: SpeakingAudioProgress) => void): Promise<SpeakingAudioRenderResult> {
  // The one source of provider, model, voice and accent: the TTS request's provider is read off this
  // object below, so the audio and the audioProfile recorded on the Set cannot disagree.
  const profile = profileForSetId(target.setId);
  const clips = buildSpeakingRenderPlan(set, profile);
  validateRenderInput(set, target, clips);
  let done = 0;
  onProgress?.({ done, total: 13, setId: target.setId });
  // Owned exclusively by this call. Nothing links to these clips until the caller publishes the Set
  // JSON that names them.
  fs.mkdirSync(path.dirname(target.outputDir), { recursive: true });
  try {
    fs.mkdirSync(target.outputDir);
  } catch {
    throw new SpeakingAudioOutputCollisionError();
  }
  const measurements: ClipMeasurement[] = [];
  // One entry per synthesis attempt, discarded ones included, written into this render's manifest
  // so the measurements travel with the audio (clipTakeManifest.ts).
  const takes: ClipTakeRecord[] = [];
  const paceNotes: SetAdvisoryNote[] = [];
  // Logs these eight fields and nothing else: never the clip text, the scenario, the interview
  // question, the built prompt or a provider payload. On failure the catch below deletes the
  // manifest with the audio, leaving this line and the clip_measurements rows as the record of what
  // the render measured. `pass` means within the WPM-or-duration tolerance; a clip logged pass:false
  // is still published.
  const logClip = (measurement: ClipMeasurement, accent: string, pass: boolean): void => {
    console.log(`[speakingAudioRenderer] ${JSON.stringify({
      setId: target.setId,
      role: measurement.role,
      wordCount: measurement.wordCount,
      durationSec: Number(measurement.durationSec.toFixed(3)),
      wpm: Number(measurement.wpm.toFixed(1)),
      accent,
      profileVersion: profile.version,
      pass,
    })}`);
  };
  try {
    // renderClipsBounded returns results in clip order, starts no new clip once one has failed, and
    // settles every in-flight clip before rethrowing, so the catch below deletes a directory nothing
    // is still writing to (ttsQueue.ts). At a TTS_CONCURRENCY of 1 it is a serial loop.
    const renderedClips = await renderClipsBounded(clips, async (clip): Promise<RenderedClip> => {
      const band = clip.band;
      const words = countEnglishWords(clip.text);
      // validateRenderInput has already rejected a wordless clip; this guards the division below.
      if (!words) throw new Error(`audio clip ${clip.file} has no English words`);
      const clipTakes: ClipTakeRecord[] = [];

      const temp = path.join(target.outputDir, `.${clip.file}.tmp`);
      const retake = path.join(target.outputDir, `.${clip.file}.retake.tmp`);
      // No `maxCorrectionRounds`: Speaking keeps the default of one, so a clip has at most these two
      // take paths.
      const outcome = await renderClipWithPaceCorrection({
        section: "speaking",
        band,
        wordCount: words,
        takePath: (round) => (round === 0 ? temp : retake),
        role: clip.role,
        synthesize: async (correction, outPath) => {
          // The whole prompt goes in `text`; `instructions` stays unset, and every Speaking clip is
          // single-speaker.
          const text = buildDeliveryPrompt(
            { ...deliveryNotes(clip), ...(correction ? { paceCorrection: correction } : {}) },
            clip.text,
          );
          await deps.synthesize({ text, provider: profile.provider, voice: clip.voice }, outPath);
        },
        // Measure the file the User actually hears.
        probeDuration: (filePath) => deps.probeDuration(filePath),
        discardTake: (filePath) => fs.rmSync(filePath, { force: true }),
        onTake: (taken, correctionCount) => {
          // Every take is recorded, discarded ones included, as 'discarded'. The returned record
          // comes back as `publishedTake` for the take that ships, and publishClipTake below marks
          // it.
          const take = recordClipTake({
            setId: target.setId, role: clip.role, file: clip.file, wordCount: words,
            durationSec: taken.durationSec, wpm: taken.wpm,
            // Always 1: pace is steered by the prompt and Gemini has no rate parameter.
            speed: 1, correctionCount,
            accent: clip.accent,
            profileVersion: profile.version, inBand: taken.inBand,
          });
          clipTakes.push(take);
          logClip(
            { role: clip.role, file: clip.file, wordCount: words, durationSec: taken.durationSec, wpm: taken.wpm },
            clip.accent,
            taken.withinTolerance,
          );
          return take;
        },
      });
      const assessment = outcome.assessment;
      const measurement: ClipMeasurement = {
        role: clip.role, file: clip.file, wordCount: words,
        durationSec: assessment.durationSec, wpm: assessment.wpm,
      };

      // generationCheckPolicy.ts decides which verdicts stop the job; today only "malfunction" does
      // (a truncated, empty or stuck synthesis, or a probe that returned no usable duration).
      const pacePolicy = classifyGenerationCheck({ family: "audio-pace", section: "speaking", verdict: assessment.verdict });
      if (pacePolicy.tier === "fatal") {
        throw new Error(
          `speaking audio clip ${clip.file} is wildly outside its plausible duration ` +
          `(measured ${assessment.durationSec.toFixed(3)}s / ${assessment.wpm.toFixed(1)} WPM, ` +
          `target ${assessment.targetDurationSec.toFixed(3)}s at ${band.targetWpm} WPM) — this is not ordinary ` +
          `pace variance; likely a truncated or stuck synthesis`,
        );
      }
      if (assessment.verdict === "out-of-band") {
        // Never a failure: pace is exam realism, not correctness. The clip has spent its one
        // correction and publishes with the advisory note the loop returned. This warning is for a
        // human watching the log; the miss is also in clip_measurements (inBand:false).
        console.warn(`[speakingAudioRenderer] ${paceWarning(assessment, { role: clip.role, file: clip.file })}`);
      }

      // The last check before publishing: does a Listen and Repeat item's delivered speech exceed the
      // Set's clip ceiling? An in-band clip fits the ceiling by construction (shared's
      // LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM), but one that ended below the band floor may not.
      // Only `lr-item` clips carry the ceiling: it budgets the sentence the learner holds in memory
      // and repeats back. The correction is spent and speech cannot be trimmed, so the policy decides
      // between failing the render and publishing with a note naming the item. Either message
      // carries a filename and numbers, never clip text.
      let ceilingNote: SetAdvisoryNote | undefined;
      if (clip.role === "lr-item") {
        const breach = listenAndRepeatPublishedClipBreach({
          file: clip.file,
          wordCount: words,
          speechDurationSec: assessment.durationSec,
          maxItemClipSec: listenAndRepeatClipCeilingSec(profile),
        });
        const ceilingPolicy = classifyGenerationCheck({ family: "audio-clip-ceiling", section: "speaking" });
        if (breach && ceilingPolicy.tier === "fatal") {
          throw new Error(
            `speaking audio clip ${breach.file} exceeds the Listen and Repeat clip ceiling: ${breach.detail}`,
          );
        }
        if (breach) {
          console.warn(`[speakingAudioRenderer] publishing ${breach.file} past the Listen and Repeat clip ceiling: ${breach.detail}`);
          const itemPosition = set.listenAndRepeat.items.findIndex((item) => `${item.id}.mp3` === clip.file);
          ceilingNote = {
            check: "content-gate", detail: "lr-clip-over-ceiling", taskType: "listen_repeat",
            ...(itemPosition >= 0 ? { itemPosition } : {}),
          };
        }
      }

      fs.renameSync(outcome.publishPath, path.join(target.outputDir, clip.file));
      // Marks the take in the manifest record; its database row is marked after the manifest is
      // written (markPublishedTakes below).
      publishClipTake(outcome.publishedTake);
      // A count of finished clips, not a plan index: clips finish out of order.
      done += 1;
      onProgress?.({ done, total: 13, setId: target.setId });
      return {
        measurement, takes: clipTakes,
        ...(outcome.note ? { note: outcome.note } : {}),
        ...(ceilingNote ? { ceilingNote } : {}),
      };
    });
    // `renderedClips` is in plan order, whatever order the clips finished in.
    for (const clip of renderedClips) {
      measurements.push(clip.measurement);
      takes.push(...clip.takes);
      if (clip.note) paceNotes.push(clip.note);
      if (clip.ceilingNote) paceNotes.push(clip.ceilingNote);
    }
    // The manifest travels with the audio into any checkout, so it records every synthesis attempt
    // and which one shipped, not only the thirteen published clips. `renderedAt` is ISO-8601: a
    // manifest is JSON, not a SQLite row.
    const manifest = {
      profile, clips: measurements, baseClipCount: 13,
      setId: target.setId, renderedAt: new Date().toISOString(), takes,
    };
    const tempManifest = path.join(target.outputDir, ".audio-manifest.tmp");
    fs.writeFileSync(tempManifest, JSON.stringify(manifest)); fs.renameSync(tempManifest, path.join(target.outputDir, "audio-manifest.json"));
    markPublishedTakes(takes);
    const lrItems = set.listenAndRepeat.items.map((item) => ({ ...item, audio: path.posix.join(target.audioPathPrefix, `${item.id}.mp3`) }));
    const questions = set.interview.questions.map((question) => ({ ...question, audio: path.posix.join(target.audioPathPrefix, `${question.id}.mp3`) }));
    // Pace and ceiling notes are appended after whatever generation already recorded, through the
    // ledger, which caps the list at the schema's maximum so a long note list cannot make publishSet's
    // parse throw away a fully rendered Set (setAdvisoryLedger.ts).
    const rendered: SpeakingSet = { ...set, audioProfile: profile, listenAndRepeat: { ...set.listenAndRepeat, introAudio: path.posix.join(target.audioPathPrefix, "briefing.mp3"), items: lrItems }, interview: { ...set.interview, introAudio: path.posix.join(target.audioPathPrefix, "int-intro.mp3"), questions } };
    return { set: recordAdvisoryNotes(rendered, paceNotes, "speaking audio render"), profile, measurements };
  } catch (error) { removeOutput(target.outputDir); throw error; }
}
