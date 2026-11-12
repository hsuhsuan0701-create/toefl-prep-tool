import fs from "node:fs";
import path from "node:path";
import type { ListeningAccent, ListeningModule, ListeningSet, SetAdvisoryNote } from "@toefl-prep/shared";
import { config } from "../lib/config.js";
import { countEnglishWords, paceWarning } from "./audioPace.js";
import { renderClipWithPaceCorrection } from "./audioPaceCorrection.js";
import { classifyGenerationCheck } from "./generationCheckPolicy.js";
import {
  ACCENT_DIRECTION,
  assertDeliveryPromptDelimitable,
  buildDeliveryPrompt,
  DIRECTOR_SECTION_LABELS,
  type DeliveryNotes,
} from "./audioPrompt.js";
import { markPublishedTakes, publishClipTake, recordClipTake, type ClipTakeRecord } from "./clipTakeManifest.js";
import { recordAdvisoryNotes } from "./setAdvisoryLedger.js";
import { renderClipsBounded } from "./ttsQueue.js";
import type { TtsRequest, TtsSpeaker } from "./tts.js";

// Renders a Listening Set's audio: one Gemini text-to-speech clip per Stimulus, each measured
// against its role's pace band, published with a manifest under data/audio/stimuli/<setId>/. The
// prompt comes from audioPrompt.ts, the pace-correction loop is shared with Speaking
// (audioPaceCorrection.ts), and synthesis is admitted through the process-wide TTS queue
// (ttsQueue.ts).

// ---------------------------------------------------------------------------
// Roles + pace policy
// ---------------------------------------------------------------------------

// Each Listening role's pace band, in words per minute of SPEECH: the clip less the silence at each
// end, as transcode.ts's `probeSpeechDurationSec` measures it. generator.ts injects that probe at
// both render call sites, and these numbers only mean anything against it: Gemini adds a near-fixed
// ~0.68 s of silence to every clip, which a file-duration rate charges hardest to the shortest
// clips.
//
// Gemini has no rate parameter, so pace is steered by prompt wording alone (audioPrompt.ts's
// `pacingDirection` picks a prose line by `targetWpm`; no number reaches the model). A clip that
// misses its band buys bounded corrective re-renders (LISTENING_PACE_CORRECTION_ROUNDS), and the best
// take is published either way, with an advisory note naming the clip if it is still out of band.
// Of the pace verdicts, only a malfunction (a truncated, empty or stuck synthesis) fails the render.
//
// ETS publishes no speech rate for TOEFL audio
// (docs/research/2026-08-23-listen-and-repeat-speech-rate.md §2.4), so these bands describe what
// this renderer delivers under its instructions, not an ETS target. The measurements behind them,
// and why three of the four were left where they were, are in
// docs/research/2026-08-23-listening-role-band-recentring.md.
export const LISTENING_ROLE_POLICY = {
  // Target 170 is the median of 140 measured first takes; 135-205 brackets their p10-p90. 170 is also
  // the top of pacingDirection's "easy, conversational pace" bucket (151-170), the instruction those
  // takes were rendered under: a target above 170 selects a different instruction and invalidates
  // the measurement, so a retune past it needs a re-measure. Pinned by listeningAudioRenderer.test.ts.
  "lcr-utterance": { targetWpm: 170, minWpm: 135, maxWpm: 205 },
  // `conversation` times the whole dialogue as one clip, pauses between speakers included. Do not fit
  // it to the manifest of a Set rendered by the retired per-turn pipeline (lsn-14659f38): those
  // turns were concatenated with a fixed 350 ms gap, which lowers the whole-conversation rate by
  // 9-11 WPM.
  conversation: { targetWpm: 162, minWpm: 150, maxWpm: 175 },
  announcement: { targetWpm: 150, minWpm: 140, maxWpm: 160 },
  "academic-talk": { targetWpm: 148, minWpm: 140, maxWpm: 155 },
} as const;
export type ListeningAudioRole = keyof typeof LISTENING_ROLE_POLICY;

// The most corrective re-renders one Listening clip may buy: one for any miss, then up to two more
// only while the clip stays far below its band (audioPace.ts's FAR_BELOW_BAND_WPM, which on the
// recorded bank selects mostly `lcr-utterance` clips). Three is a spend bound matched to the three
// rungs of audioPrompt.ts's escalation ladder; a fourth round would repeat the third's wording. All
// rounds run inside the clip's one TTS slot (ttsQueue.ts), so raising this never raises how many
// syntheses are in flight. Speaking passes no budget and keeps audioPaceCorrection's default of one,
// because the escalation was measured on Listening's bank only.
export const LISTENING_PACE_CORRECTION_ROUNDS = 3;

// ---------------------------------------------------------------------------
// Delivery direction (audioPrompt.ts's Audio Profile / Scene / Style, per role)
// ---------------------------------------------------------------------------

type RoleDelivery = {
  /** audioPrompt.ts's "Audio Profile" line — what kind of recording this is. */
  readonly audioProfile: string;
  /** The default "Scene" line. A Conversation overrides it per Stimulus — see buildRenderPlan. */
  readonly scene: string;
  /** audioPrompt.ts's "Style" director's note. */
  readonly style: string;
};

// Every string here is read by the model as direction, so they are written as real prose rather
// than shorthand. `accent` and `band` are not in this table: accent comes from the Speaker and the
// band from LISTENING_ROLE_POLICY above.
const ROLE_DELIVERY: Readonly<Record<ListeningAudioRole, RoleDelivery>> = {
  "lcr-utterance": {
    audioProfile: "one short line of speech recorded for an English listening exam",
    scene: "a single speaker, no background, close mic",
    style: "natural and unforced, as if said once in ordinary conversation",
  },
  conversation: {
    audioProfile: "a two-person conversation recorded for an English listening exam",
    // Only reached when a Conversation's own `setting` is blank — buildRenderPlan otherwise builds
    // the scene from that field plus which label is voicing which speaker.
    scene: "a two-person conversation on a university campus",
    style: "natural turn-taking, each speaker distinct, unforced",
  },
  announcement: {
    audioProfile: "a public announcement recorded for an English listening exam",
    scene: "a campus public-address announcement",
    style: "clear and even, informative rather than dramatic",
  },
  "academic-talk": {
    audioProfile: "an excerpt from a university lecture recorded for an English listening exam",
    scene: "a lecture hall, mid-talk",
    style: "engaged and explanatory, addressing a room",
  },
};

// ---------------------------------------------------------------------------
// buildRenderPlan
// ---------------------------------------------------------------------------

// One clip to synthesize; every Stimulus is exactly one clip. `scene` is this clip's Scene line:
// fixed prose from ROLE_DELIVERY, or for a Conversation its own `setting` plus who is voicing whom,
// so reading Set content stays inside buildRenderPlan. `speakers` is set only on a Conversation: the
// two label/voice pairs Gemini's multi-speaker config is built from (tts.ts).
//
// On a Conversation clip `voice`, `accent` and `speakerId` hold the FIRST speaker's values only.
// tts.ts ignores `voice` on a multi-speaker request (it is set because TtsRequest requires it);
// `accent` becomes the prompt's single `Accent:` line while both speakers' accents travel in `scene`;
// `speakerId` only attributes the clip. Nothing derives pace, publication or measurement from them.
//
// `setting` and a Speaker's `role` are learner-visible avatar-card text, so they may enter a
// synthesis prompt; neither reaches a log line, an error message or clip_measurements.
export type ClipSpec = {
  file: string;
  role: ListeningAudioRole;
  voice: string;
  accent: ListeningAccent;
  text: string;
  scene: string;
  speakerId: string;
  stimulusId: string;
  speakers?: TtsSpeaker[];
};

// Provider is a renderer-wide invariant. Keeping it off ClipSpec prevents a validated all-Gemini
// plan from later carrying contradictory per-clip provider state into synthesis.
const LISTENING_TTS_PROVIDER = "gemini" as const;

const SAFE_FILENAME_SEGMENT = /^[A-Za-z0-9_-]+$/;

function clipFile(setId: string, stimulusId: string): string {
  return path.posix.join("stimuli", setId, `${stimulusId}.mp3`);
}

// A speaker LABEL is what Gemini matches against the `Label:` prefixes in the transcript, so it has
// to be stable, distinct, and safe to drop into a prompt. It is derived from the Speaker's `role`, a
// model-written phrase ("student", "teaching assistant", "café staff"), so a degenerate role is
// expected input: it falls back to these labels and never throws.
const FALLBACK_SPEAKER_LABELS: readonly [string, string] = ["SpeakerA", "SpeakerB"];

function deriveSpeakerLabel(role: string): string {
  const firstToken = role.trim().split(/\s+/)[0] ?? "";
  const letters = firstToken.replace(/[^A-Za-z]/g, "");
  if (letters.length === 0) return "";
  return letters[0]!.toUpperCase() + letters.slice(1);
}

/**
 * True when a label would make its own transcript line read as a director's-notes section: a role
 * whose first token is "Style", "Scene", "Accent" or "Pacing" yields the line `Style: …`, which
 * audioPrompt's contamination check rejects. Catching it here lets the Conversation fall back to
 * neutral labels; caught by buildDeliveryPrompt instead, it would throw inside the paid render loop
 * and discard every clip already bought.
 *
 * Matches the constructed line prefix rather than the bare label, the same startsWith test
 * audioPrompt applies, so it follows any change to that label set.
 */
function labelShadowsDirectorSection(label: string): boolean {
  return DIRECTOR_SECTION_LABELS.some((candidate) => `${label}: `.startsWith(candidate));
}

/**
 * The two labels a Conversation's turns are prefixed with, derived from the speakers' `role`
 * fields: first whitespace-delimited token, letters only, first letter capitalized.
 *
 * Falls back to SpeakerA/SpeakerB for BOTH speakers when either derivation comes out empty, the two
 * collide, or either would shadow a director's-notes label. Never a mixed pair (one derived, one
 * fallback): the labels are read as a set by the model, and "Student:" alongside "SpeakerB:" reads
 * as an inconsistency in the direction rather than as two names.
 */
export function conversationSpeakerLabels(roles: readonly [string, string]): [string, string] {
  const first = deriveSpeakerLabel(roles[0]);
  const second = deriveSpeakerLabel(roles[1]);
  const unusable =
    first.length === 0 ||
    second.length === 0 ||
    first === second ||
    labelShadowsDirectorSection(first) ||
    labelShadowsDirectorSection(second);
  if (unusable) {
    return [FALLBACK_SPEAKER_LABELS[0], FALLBACK_SPEAKER_LABELS[1]];
  }
  return [first, second];
}

/**
 * The word count pace is measured on. For a single-speaker clip that is the transcript; for a
 * Conversation it is the spoken words only, with each line's `Label:` prefix removed, because the
 * labels address the model and nobody hears them. Counting them would inflate a Conversation's WPM by
 * about one word per turn, which would both skew its recorded pace and steer its correction loop.
 *
 * Prefixes are matched at line start against the exact labels this render planned, never a general
 * `Word:` pattern: buildRenderPlan writes every Conversation line as `${label}: ${turn.text}`, so
 * ordinary prose containing a colon is untouched.
 */
export function spokenWordCount(text: string, speakers?: readonly TtsSpeaker[]): number {
  if (!speakers || speakers.length === 0) return countEnglishWords(text);
  const prefixes = speakers.map((speaker) => `${speaker.speaker}:`);
  const spoken = text
    .split("\n")
    .map((line) => {
      const prefix = prefixes.find((candidate) => line.startsWith(candidate));
      return prefix === undefined ? line : line.slice(prefix.length);
    })
    .join("\n");
  return countEnglishWords(spoken);
}

/**
 * The id a speech-rate note names each clip by, in plan order: its role and its 1-based position
 * among that role's clips across the Set, router then lower then upper module ("lcr-utterance-7",
 * "conversation-2"). Derived by the server, so a note carries no model-written Stimulus id, and
 * unique across roles, so the client's grouping of notes by clip never merges two clips.
 */
export function speechRateClipLabels(clips: readonly Pick<ClipSpec, "role">[]): string[] {
  const countByRole = new Map<ListeningAudioRole, number>();
  return clips.map(({ role }) => {
    const position = (countByRole.get(role) ?? 0) + 1;
    countByRole.set(role, position);
    return `${role}-${position}`;
  });
}

/**
 * Why the Set's clips could not each get a file of their own, or `undefined` when they can. Every
 * Listen and Choose a Response item and every Stimulus is one clip, `<id>.mp3`, in one directory,
 * so each of those ids must be a safe filename segment and must differ from every other, compared
 * without case because the directory may sit on a case-insensitive filesystem. Two Stimuli sharing
 * an id would also be verified as one unit (listeningGenerator's listeningVerifyUnits).
 *
 * The candidate stage asks this before verification is paid for (listeningCandidateAdapter), and
 * buildRenderPlan asks it again before any synthesis. Ids only in the message: they are what the
 * model wrote, but never Set text.
 */
export function listeningClipIdProblem(
  set: Pick<ListeningSet, "router" | "lowerModule" | "upperModule">,
): string | undefined {
  const seen = new Map<string, string>();
  for (const module of [set.router, set.lowerModule, set.upperModule]) {
    const ids = [
      ...module.listenChoose.map((item) => item.id),
      ...module.conversations.map((conversation) => conversation.id),
      ...module.announcements.map((announcement) => announcement.id),
      ...module.academicTalks.map((talk) => talk.id),
    ];
    for (const id of ids) {
      if (!SAFE_FILENAME_SEGMENT.test(id)) return `stimulus ID "${id}" is not a safe filename segment`;
      const clash = seen.get(id.toLowerCase());
      if (clash !== undefined) {
        return clash === id
          ? `stimulus ID "${id}" is not unique across the Set`
          : `stimulus IDs "${clash}" and "${id}" name the same clip file and are not unique across the Set`;
      }
      seen.set(id.toLowerCase(), id);
    }
  }
  return undefined;
}

/**
 * Plans one clip per Stimulus and validates the whole plan, synchronously, before
 * renderListeningAudio touches the filesystem or spends a synthesis call. Throws if a Stimulus id is
 * not a safe, unique filename segment, if any Speaker is not a Gemini speaker, if a Conversation turn
 * names an unknown speaker, if any clip's prompt could not be delimited (TranscriptContaminationError)
 * or if a clip has no words to speak.
 */
export function buildRenderPlan(set: ListeningSet): ClipSpec[] {
  const clipIdProblem = listeningClipIdProblem(set);
  if (clipIdProblem) throw new Error(`listening audio render ${clipIdProblem}`);
  const clips: ClipSpec[] = [];
  const seenFiles = new Set<string>();

  const claimFile = (file: string): void => {
    if (seenFiles.has(file)) {
      throw new Error(`listening audio render produced a duplicate clip path "${file}"`);
    }
    seenFiles.add(file);
  };
  // SpeakerSchema still admits an OpenAI speaker, but this renderer synthesizes only through Gemini
  // (multi-speaker Conversations are Gemini-only), so every Speaker in the Set is checked here,
  // before any spend.
  const claimGeminiSpeaker = (provider: string, stimulusId: string): void => {
    if (provider !== LISTENING_TTS_PROVIDER) {
      throw new Error(
        `listening audio render stimulus "${stimulusId}" has a non-Gemini speaker (provider "${provider}") — this renderer synthesizes only through Gemini`,
      );
    }
  };

  for (const module of [set.router, set.lowerModule, set.upperModule]) {
    for (const item of module.listenChoose) {
      claimGeminiSpeaker(item.speaker.provider, item.id);
      const file = clipFile(set.id, item.id);
      claimFile(file);
      clips.push({
        file, role: "lcr-utterance", voice: item.speaker.voice,
        accent: item.speaker.accent, text: item.utterance, scene: ROLE_DELIVERY["lcr-utterance"].scene,
        speakerId: item.speaker.id, stimulusId: item.id,
      });
    }
    for (const conversation of module.conversations) {
      const [first, second] = conversation.speakers;
      claimGeminiSpeaker(first!.provider, conversation.id);
      claimGeminiSpeaker(second!.provider, conversation.id);
      const labels = conversationSpeakerLabels([first!.role, second!.role]);
      const labelBySpeakerId = new Map([
        [first!.id, labels[0]],
        [second!.id, labels[1]],
      ]);
      const file = clipFile(set.id, conversation.id);
      claimFile(file);
      // ONE clip for the whole dialogue, from a single native multi-speaker call: Gemini voices both
      // parts in one take, which sounds like two people talking rather than two monologues glued
      // together. It also keeps play-once structural: the audio route serves any mp3 under
      // audio/stimuli/<setId>/, so a per-turn file on disk would allow turn-by-turn replay.
      //
      // Each turn is one `Label: text` line, so the whitespace inside a turn is collapsed to single
      // spaces first: a line break the model left inside a turn would otherwise start a line with no
      // speaker label, which the multi-speaker call has no voice for and spokenWordCount would
      // count as spoken. The prompt check below reads this same string.
      const text = conversation.transcript
        .map((turn) => {
          const label = labelBySpeakerId.get(turn.speakerId);
          if (!label) {
            throw new Error(
              `listening audio render conversation "${conversation.id}" turn references unknown speaker "${turn.speakerId}"`,
            );
          }
          return `${label}: ${turn.text.replace(/\s+/gu, " ").trim()}`;
        })
        .join("\n");
      // The Scene tells the model who it is voicing: the Conversation's `setting`, then which label is
      // which role. Both are model-written and may be blank, so each falls back to fixed prose.
      //
      // It also names BOTH speakers' accents. The Director's Notes have one `Accent:` line (speaker
      // 1's), and listeningGenerator's assignSpeakerRendering gives a Conversation's two speakers
      // consecutive accents from a three-accent rotation, so they always differ; without this the
      // second speaker would be voiced in the first's accent while its avatar card names its own.
      // The wording is audioPrompt's ACCENT_DIRECTION, reused so the two cannot drift.
      const setting = conversation.setting.trim();
      const attribute = (label: string, speakerRole: string, accent: ListeningAccent): string => {
        const trimmed = speakerRole.trim();
        const who = trimmed.length > 0 ? `${label} is the ${trimmed}` : `${label} is one of the two speakers`;
        return `${who}, speaking ${ACCENT_DIRECTION[accent]}`;
      };
      clips.push({
        file, role: "conversation", voice: first!.voice,
        accent: first!.accent, text,
        scene: `${setting.length > 0 ? setting : ROLE_DELIVERY.conversation.scene}. ` +
          `${attribute(labels[0], first!.role, first!.accent)}; ` +
          `${attribute(labels[1], second!.role, second!.accent)}.`,
        speakerId: first!.id, stimulusId: conversation.id,
        speakers: [
          { speaker: labels[0], voice: first!.voice },
          { speaker: labels[1], voice: second!.voice },
        ],
      });
    }
    for (const announcement of module.announcements) {
      claimGeminiSpeaker(announcement.speaker.provider, announcement.id);
      const file = clipFile(set.id, announcement.id);
      claimFile(file);
      clips.push({
        file, role: "announcement", voice: announcement.speaker.voice,
        accent: announcement.speaker.accent, text: announcement.transcript, scene: ROLE_DELIVERY.announcement.scene,
        speakerId: announcement.speaker.id, stimulusId: announcement.id,
      });
    }
    for (const talk of module.academicTalks) {
      claimGeminiSpeaker(talk.speaker.provider, talk.id);
      const file = clipFile(set.id, talk.id);
      claimFile(file);
      clips.push({
        file, role: "academic-talk", voice: talk.speaker.voice,
        accent: talk.speaker.accent, text: talk.transcript, scene: ROLE_DELIVERY["academic-talk"].scene,
        speakerId: talk.speaker.id, stimulusId: talk.id,
      });
    }
  }

  // Every check that can be decided from Set content runs here, before any spend: a throw inside the
  // render loop deletes every clip already bought. The prompt check is the same function
  // buildDeliveryPrompt calls, over the same notes and text the loop will pass, so it cannot be
  // narrower than the render-time throw. It covers the notes as well as the transcript because a
  // Conversation's Scene line is built from model-written `setting` and `role` text. Runs over the
  // finished plan, so it covers every role.
  for (const clip of clips) {
    // Throws TranscriptContaminationError, whose message deliberately carries no Set text.
    assertDeliveryPromptDelimitable(deliveryNotes(clip), clip.text);
    if (!spokenWordCount(clip.text, clip.speakers)) {
      throw new Error(`listening audio clip ${clip.file} has no English words`);
    }
  }
  return clips;
}

/**
 * The Audio Profile / Scene / Director's Notes audioPrompt.ts turns into this clip's prompt. On a
 * Conversation the `Accent:` line carries the first speaker's accent; both speakers' accents are in
 * `scene` (see buildRenderPlan).
 */
export function deliveryNotes(clip: ClipSpec): DeliveryNotes {
  const delivery = ROLE_DELIVERY[clip.role];
  return {
    audioProfile: delivery.audioProfile,
    scene: clip.scene,
    style: delivery.style,
    accent: clip.accent,
    band: LISTENING_ROLE_POLICY[clip.role],
  };
}

// ---------------------------------------------------------------------------
// renderListeningAudio
// ---------------------------------------------------------------------------

/**
 * What renderListeningAudio needs from outside: `synthesize` (the paid TTS call, tts.ts in
 * production) and `probeDuration` (generator.ts passes transcode.ts's speech-duration probe; see
 * LISTENING_ROLE_POLICY). `dataDir` defaults to config.dataDir; tests point it at a temporary
 * directory.
 */
export type RenderDeps = {
  synthesize(request: TtsRequest, outPath: string): Promise<void>;
  probeDuration(filePath: string): Promise<number>;
  dataDir?: string;
};

export type ClipMeasurement = {
  role: ListeningAudioRole;
  file: string;
  stimulusId: string;
  wordCount: number;
  durationSec: number;
  wpm: number;
};

/**
 * Thrown when the Set's output directory already exists or cannot be created. The renderer never
 * deletes a directory it did not create, so a collision leaves whatever is there untouched.
 */
export class ListeningAudioOutputCollisionError extends Error {
  constructor() {
    super("listening audio render output directory already exists or cannot be acquired");
    this.name = "ListeningAudioOutputCollisionError";
  }
}

// The pipeline tag recorded on the rendered Set's audioProfile and its manifest. Every clip this
// renderer produces is Gemini (claimGeminiSpeaker), so `provider` is always "gemini"; the schema's
// provider enum still admits "openai" so the retired pre-Gemini Set (lsn-14659f38) keeps loading for
// review. The version did not change with the move to Gemini: ListeningAudioProfileSchema pins it as
// a literal, provider plus model already tell the two pipelines apart, and a new version would need a
// schema union or that Set would fail to load.
export const LISTENING_AUDIO_PROFILE_VERSION = "ets-2026-listening-v1" as const;

function removeOutput(outputDir: string): void {
  fs.rmSync(outputDir, { recursive: true, force: true });
}

/**
 * Everything one clip contributes to the render, returned rather than pushed into shared arrays:
 * clips render concurrently, and pushing would order them by completion instead of by plan.
 */
type RenderedClip = {
  measurement: ClipMeasurement;
  takes: ClipTakeRecord[];
  note?: SetAdvisoryNote;
};

function withAudio(module: ListeningModule, audioByStimulus: Map<string, string>): ListeningModule {
  const audioFor = (id: string): string => {
    const audio = audioByStimulus.get(id);
    if (!audio) throw new Error(`listening audio render has no rendered audio for stimulus "${id}"`);
    return audio;
  };
  return {
    ...module,
    listenChoose: module.listenChoose.map((item) => ({ ...item, audio: audioFor(item.id) })),
    conversations: module.conversations.map((conversation) => ({ ...conversation, audio: audioFor(conversation.id) })),
    announcements: module.announcements.map((announcement) => ({ ...announcement, audio: audioFor(announcement.id) })),
    academicTalks: module.academicTalks.map((talk) => ({ ...talk, audio: audioFor(talk.id) })),
  };
}

/**
 * Renders every Stimulus of `set` into data/audio/stimuli/<setId>/ and returns the Set with each
 * Stimulus's `audio` path, its audioProfile, and an advisory note for every clip still outside its
 * pace band. Clips are admitted through the process-wide TTS queue in plan order and may finish in
 * any order; the manifest and the returned Set list them in plan order. Every take is recorded in
 * the manifest and in clip_measurements.
 *
 * All or nothing on disk: any failure deletes the output directory before rethrowing, so a Set never
 * has half its audio. A pre-existing output directory is a ListeningAudioOutputCollisionError and is
 * left untouched.
 */
export async function renderListeningAudio(set: ListeningSet, deps: RenderDeps): Promise<ListeningSet> {
  const clips = buildRenderPlan(set);

  const dataDir = deps.dataDir ?? config.dataDir;
  const outputDir = path.join(dataDir, "audio/stimuli", set.id);
  fs.mkdirSync(path.dirname(outputDir), { recursive: true });
  try {
    fs.mkdirSync(outputDir);
  } catch {
    // Outside the try below on purpose: a directory this call did not create must never be deleted
    // by its cleanup.
    throw new ListeningAudioOutputCollisionError();
  }

  // Logs these seven fields and nothing else: never clip text, the built prompt or a provider
  // payload. On failure the catch below deletes the manifest with the audio, leaving this line and
  // the clip_measurements rows as the record of what the render measured. `pass` means within the
  // WPM-or-duration tolerance; a clip logged pass:false is still published.
  const logClip = (measurement: ClipMeasurement, pass: boolean): void => {
    console.log(`[listeningAudioRenderer] ${JSON.stringify({
      setId: set.id,
      stimulusId: measurement.stimulusId,
      role: measurement.role,
      wordCount: measurement.wordCount,
      durationSec: Number(measurement.durationSec.toFixed(3)),
      wpm: Number(measurement.wpm.toFixed(1)),
      pass,
    })}`);
  };

  try {
    const measurements: ClipMeasurement[] = [];
    // One entry per synthesis attempt, discarded ones included, written into this render's manifest
    // so the measurements travel with the audio (clipTakeManifest.ts).
    const takes: ClipTakeRecord[] = [];
    const paceNotes: SetAdvisoryNote[] = [];
    const audioByStimulus = new Map<string, string>();

    // renderClipsBounded returns results in clip order, starts no new clip once one has failed, and
    // settles every in-flight clip before rethrowing, so the catch below deletes a directory nothing
    // is still writing to (ttsQueue.ts).
    const clipLabels = speechRateClipLabels(clips);
    const rendered = await renderClipsBounded(clips, async (clip, index): Promise<RenderedClip> => {
      const band = LISTENING_ROLE_POLICY[clip.role];
      const words = spokenWordCount(clip.text, clip.speakers);
      // buildRenderPlan has already rejected a wordless clip; this guards the division below.
      if (!words) throw new Error(`listening audio clip ${clip.file} has no English words`);
      const clipTakes: ClipTakeRecord[] = [];

      const basename = path.posix.basename(clip.file);
      // One temp path per round (0 is the first take). The winning take is renamed into place below
      // and every losing one is deleted.
      const takePath = (round: number): string =>
        path.join(outputDir, round === 0 ? `.${basename}.tmp` : `.${basename}.retake${round === 1 ? "" : round}.tmp`);

      // The pace check runs on the probed file the User hears. It catches a truncated or stuck
      // synthesis only within the wide 0.3x-3x sanity window: a Conversation cut to half its length
      // is published with a pace warning, not rejected. The whole take cycle, every round included,
      // runs inside this clip's one TTS slot.
      const outcome = await renderClipWithPaceCorrection({
        section: "listening",
        band,
        wordCount: words,
        takePath,
        maxCorrectionRounds: LISTENING_PACE_CORRECTION_ROUNDS,
        role: clip.role,
        clipId: clipLabels[index]!,
        synthesize: async (correction, outPath) => {
          // The whole prompt goes in `text`; `instructions` stays unset.
          const text = buildDeliveryPrompt(
            { ...deliveryNotes(clip), ...(correction ? { paceCorrection: correction } : {}) },
            clip.text,
          );
          await deps.synthesize(
            {
              text,
              provider: LISTENING_TTS_PROVIDER,
              voice: clip.voice,
              ...(clip.speakers ? { speakers: clip.speakers } : {}),
            },
            outPath,
          );
        },
        probeDuration: (filePath) => deps.probeDuration(filePath),
        discardTake: (filePath) => fs.rmSync(filePath, { force: true }),
        onTake: (taken, correctionCount) => {
          // Every take is recorded, discarded ones included. `speed` is always 1: pace is steered by
          // the prompt and Gemini has no rate parameter. The returned record is what publishClipTake
          // later marks as the take that shipped.
          const take = recordClipTake({
            setId: set.id, role: clip.role, file: clip.file, wordCount: words,
            durationSec: taken.durationSec, wpm: taken.wpm,
            speed: 1, correctionCount,
            accent: clip.accent,
            profileVersion: LISTENING_AUDIO_PROFILE_VERSION, inBand: taken.inBand,
          });
          clipTakes.push(take);
          logClip(
            {
              role: clip.role, file: clip.file, stimulusId: clip.stimulusId, wordCount: words,
              durationSec: taken.durationSec, wpm: taken.wpm,
            },
            taken.withinTolerance,
          );
          return take;
        },
      });
      const assessment = outcome.assessment;
      const measurement: ClipMeasurement = {
        role: clip.role, file: clip.file, stimulusId: clip.stimulusId, wordCount: words,
        durationSec: assessment.durationSec, wpm: assessment.wpm,
      };

      // generationCheckPolicy.ts decides which verdicts stop the job; today only "malfunction" does
      // (a truncated, empty or stuck synthesis, or a probe that returned no usable duration).
      const pacePolicy = classifyGenerationCheck({ family: "audio-pace", section: "listening", verdict: assessment.verdict });
      if (pacePolicy.tier === "fatal") {
        throw new Error(
          `listening audio clip ${clip.file} is wildly outside its plausible duration ` +
          `(measured ${assessment.durationSec.toFixed(3)}s / ${assessment.wpm.toFixed(1)} WPM, ` +
          `target ${assessment.targetDurationSec.toFixed(3)}s at ${band.targetWpm} WPM) — this is not ordinary ` +
          `pace variance; likely a truncated or stuck synthesis`,
        );
      }
      if (assessment.verdict === "out-of-band") {
        // Never a failure: pace is exam realism, not correctness. The clip has spent its correction
        // budget and publishes with the advisory note the loop returned. This warning is for a human
        // watching the log; the miss is also in clip_measurements (inBand:false).
        console.warn(`[listeningAudioRenderer] ${paceWarning(assessment, { role: clip.role, file: clip.file })}`);
      }

      fs.renameSync(outcome.publishPath, path.join(outputDir, basename));
      // Marks the take in the manifest record; its database row is marked after the manifest is
      // written (markPublishedTakes below).
      publishClipTake(outcome.publishedTake);
      return { measurement, takes: clipTakes, ...(outcome.note ? { note: outcome.note } : {}) };
    });
    // `rendered` is in plan order, whatever order the clips finished in.
    for (const clip of rendered) {
      measurements.push(clip.measurement);
      takes.push(...clip.takes);
      if (clip.note) paceNotes.push(clip.note);
      audioByStimulus.set(clip.measurement.stimulusId, clip.measurement.file);
    }

    // The manifest travels with the audio into any checkout, so it records every synthesis attempt
    // and which one shipped, not only the published clips (clipTakeManifest.ts).
    const manifest = {
      version: LISTENING_AUDIO_PROFILE_VERSION,
      clips: measurements,
      baseClipCount: clips.length,
      setId: set.id,
      renderedAt: new Date().toISOString(),
      takes,
    };
    const tempManifest = path.join(outputDir, ".audio-manifest.tmp");
    fs.writeFileSync(tempManifest, JSON.stringify(manifest));
    fs.renameSync(tempManifest, path.join(outputDir, "audio-manifest.json"));
    markPublishedTakes(takes);

    // Pace notes are appended after whatever generation already recorded, through the ledger, which
    // caps the list at the schema's maximum so a long note list cannot make publishSet's parse throw
    // away a fully rendered Set (setAdvisoryLedger.ts).
    return recordAdvisoryNotes({
      ...set,
      audioProfile: {
        version: LISTENING_AUDIO_PROFILE_VERSION,
        provider: LISTENING_TTS_PROVIDER,
        // The configured model, so a published Set names the voice model that actually made it.
        model: config.geminiTtsModel,
      },
      router: withAudio(set.router, audioByStimulus),
      lowerModule: withAudio(set.lowerModule, audioByStimulus),
      upperModule: withAudio(set.upperModule, audioByStimulus),
    }, paceNotes, "listening audio render");
  } catch (error) {
    removeOutput(outputDir);
    throw error;
  }
}
