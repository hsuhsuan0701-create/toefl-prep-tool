import { createHash } from "node:crypto";
import {
  LISTEN_AND_REPEAT_ITEM_TARGET_WPM,
  LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC,
  SpeakingAudioProfileV6Schema,
  type SpeakingAccent,
  type SpeakingAudioProfile,
  type SpeakingAudioProfileV6,
} from "@toefl-prep/shared";
import { config } from "../lib/config.js";
import { GEMINI_VOICE_POOLS, type GeminiVoicePool } from "./geminiVoices.js";

/**
 * The profile version a newly rendered Speaking Set records.
 *
 * It is also a HASH INPUT (see `digestFor` below): accents and voices are picked from
 * sha256("<version>:<setId>"), so bumping the version re-casts every set id. That only ever affects
 * new renders: a published Set keeps the profile recorded in its own JSON, and nothing re-derives an
 * older Set's profile from its id.
 *
 * The pace targets recorded under this version are schema literals (SpeakingAudioProfileV6Schema),
 * which is why a pace retune needs a new version rather than an edit: changing the literals in place
 * would make every Set published under them fail AnySetSchema and drop out of the bank.
 */
export const AUDIO_PROFILE_VERSION = "ets-2026-v6" as const;

/**
 * The accent pool a new Speaking Set draws from: ETS's three regions. Both ETS 2025/2026 documents
 * give exactly these and exclude New Zealand: Technical Manual (RR-25-12) §II-4 p. 12 and Test
 * Specifications 2026 p. 10 (sourcing on ListeningAccentSchema in shared/src/schemas/listening.ts and in
 * docs/research/2026-08-23-listen-and-repeat-speech-rate.md §4.4). Order is a hash-modulus input.
 */
export const SPEAKING_DRAW_ACCENTS = [
  "north-american",
  "british",
  "australian",
] as const satisfies readonly SpeakingAccent[];

/**
 * Which Gemini voice pool each task draws from. The pools themselves live in geminiVoices.ts — one
 * cast list, shared with Listening; this module owns only the choice of pool per task, exactly as
 * listeningGenerator.ts owns its own per-Stimulus-shape choice.
 *
 * Listen and Repeat reads the sentences the learner repeats back, so it draws from `authoritative`:
 * a clear instructional voice IS the task. The Interview asks the questions, so it draws from
 * `service`: warm and conversational fits an interviewer.
 */
export const SPEAKING_V2_VOICE_POOLS = {
  listenAndRepeat: "authoritative",
  interview: "service",
} as const satisfies Readonly<Record<"listenAndRepeat" | "interview", GeminiVoicePool>>;

const VALID_SET_ID = /^[A-Za-z0-9_-]+$/;

function digestFor(version: string, setId: string): Buffer {
  if (!VALID_SET_ID.test(setId)) {
    throw new Error(`Invalid speaking set ID: ${setId}`);
  }
  return createHash("sha256").update(`${version}:${setId}`).digest();
}

/** Bytes 0 and 1 pick the two accents; the Interview accent is always a different one. */
function accentsFor(
  digest: Buffer,
  pool: readonly SpeakingAccent[],
): { listenAndRepeat: SpeakingAccent; interview: SpeakingAccent } {
  const listenAndRepeat = pool[digest[0] % pool.length];
  const remaining = pool.filter((accent) => accent !== listenAndRepeat);
  return { listenAndRepeat, interview: remaining[digest[1] % remaining.length] };
}

/**
 * A pool's full membership in a stable declared order — every female voice, then every male one, in
 * the order geminiVoices.ts declares them. Both genders, because a Speaking profile's voice carries
 * no gender requirement (unlike a Listening Speaker, whose gender the model chose in the script).
 */
function poolVoices(pool: GeminiVoicePool): readonly string[] {
  return [...GEMINI_VOICE_POOLS[pool].female, ...GEMINI_VOICE_POOLS[pool].male];
}

/**
 * The current profile. Accents come from SPEAKING_DRAW_ACCENTS (digest bytes 0 and 1) and one voice
 * per task from its pool (bytes 2 and 3), all hashed with the version string. The pace policy is two
 * Listen and Repeat levels — items 1-3 fast, items 4-7 at ETS's measured tail mean — measured in
 * speech rather than file duration, plus the clip ceiling.
 *
 * The targets come from `shared`, which is also where the v6 schema's literals come from, so this
 * cannot stamp a policy the schema would reject: it would throw here rather than publish.
 */
export function speakingProfileV6(setId: string): SpeakingAudioProfileV6 {
  const digest = digestFor(AUDIO_PROFILE_VERSION, setId);
  const accents = accentsFor(digest, SPEAKING_DRAW_ACCENTS);
  const listenAndRepeatVoices = poolVoices(SPEAKING_V2_VOICE_POOLS.listenAndRepeat);
  const interviewVoices = poolVoices(SPEAKING_V2_VOICE_POOLS.interview);
  const listenAndRepeatVoice = listenAndRepeatVoices[digest[2] % listenAndRepeatVoices.length];
  const interviewVoice = interviewVoices[digest[3] % interviewVoices.length];
  // The two pools are pairwise disjoint (geminiVoices.test.ts asserts it), so this cannot fire
  // today — it fires the day someone moves a voice from one pool to the other, which would
  // otherwise silently read a Set's sentences and its interview questions in the same voice.
  if (listenAndRepeatVoice === interviewVoice) {
    throw new Error(`Speaking profile v6 drew one voice for both tasks: ${setId}`);
  }

  return SpeakingAudioProfileV6Schema.parse({
    version: AUDIO_PROFILE_VERSION,
    provider: "gemini",
    model: config.geminiTtsModel,
    listenAndRepeat: {
      accent: accents.listenAndRepeat,
      voice: listenAndRepeatVoice,
      briefingTargetWpm: 165,
      itemTargetWpms: [...LISTEN_AND_REPEAT_ITEM_TARGET_WPM],
      itemMaxClipSec: LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC,
    },
    interview: {
      accent: accents.interview,
      voice: interviewVoice,
      introTargetWpm: 165,
      questionTargetWpm: 155,
    },
  });
}

/** The profile a Set rendered NOW gets. */
export function profileForSetId(setId: string): SpeakingAudioProfile {
  return speakingProfileV6(setId);
}
