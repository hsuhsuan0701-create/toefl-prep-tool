import { z } from "zod";

// How a Speaking Set's clips were rendered (its audio profile, one version per policy), and the
// Listen and Repeat pace policy the current version records.

// The accents a recorded Speaking audio profile may name. New Speaking Sets draw only ETS's three
// regions (SPEAKING_DRAW_ACCENTS in server/src/services/speakingAudioProfile.ts); "new-zealand" stays
// readable because banked Sets record it, and a narrower enum would make them fail AnySetSchema.
const SpeakingAccentSchema = z.enum([
  "north-american", "british", "new-zealand", "australian",
]);
// A Speaking audio profile records how a Set's clips were rendered, one version per change of pace or
// accent policy. Every version stays in the union, its literals unchanged, for as long as a banked Set
// records it: a Set that fails AnySetSchema cannot be loaded or reviewed (it is listed at
// GET /api/sets/unloadable instead). v1 is the OpenAI renderer's profile.
const SpeakingAudioProfileV1Schema = z.object({
  version: z.literal("ets-2026-v1"),
  provider: z.literal("openai"),
  model: z.literal("gpt-4o-mini-tts"),
  listenAndRepeat: z.object({
    accent: SpeakingAccentSchema,
    voice: z.literal("marin"),
    briefingTargetWpm: z.literal(165),
    itemTargetWpm: z.literal(180),
  }),
  interview: z.object({
    accent: SpeakingAccentSchema,
    voice: z.literal("cedar"),
    introTargetWpm: z.literal(165),
    questionTargetWpm: z.literal(155),
  }),
});

// v2 renders with Gemini. `model` and `voice` record what actually rendered the Set rather than pinning
// a literal, so a profile cannot disagree with the configured model; voices come from Gemini's
// prebuilt pools (server/src/services/geminiVoices.ts). The target WPM values stay literals: they are
// the pace the profile promises.
const SpeakingAudioProfileV2Schema = z.object({
  version: z.literal("ets-2026-v2"),
  provider: z.literal("gemini"),
  model: z.string().min(1),
  listenAndRepeat: z.object({
    accent: SpeakingAccentSchema,
    voice: z.string().min(1),
    briefingTargetWpm: z.literal(165),
    itemTargetWpm: z.literal(180),
  }),
  interview: z.object({
    accent: SpeakingAccentSchema,
    voice: z.string().min(1),
    introTargetWpm: z.literal(165),
    questionTargetWpm: z.literal(155),
  }),
});

// v3 has v2's shape. The version string is the hash input of the accent and voice draw
// (sha256("<version>:<setId>") in speakingAudioProfile.ts), so narrowing the accent pool to ETS's three
// regions needed a new version: under the old string, a banked Set's recorded draw would no longer be
// reproducible from its id. The accent fields keep the permissive SpeakingAccentSchema; the exclusion
// is enforced at the draw.
const SpeakingAudioProfileV3Schema = SpeakingAudioProfileV2Schema.extend({
  version: z.literal("ets-2026-v3"),
});

/**
 * The Listen and Repeat speech-rate target for items 1–7, in speech words per minute (the silence at
 * either end of a clip excluded).
 *
 * Gemini's speech API has no rate parameter. A target only selects which of
 * `audioPrompt.pacingDirection`'s prose instructions a clip is rendered with, and centres the band
 * whose miss buys the clip one corrective re-render. So the ramp has two levels, one per instruction:
 * 226 and 184 are the means of ETS's measured speech rates over items 1–3 and 4–7
 * (Teacher Practice Test 5; docs/research/2026-08-23-ets-reference-audio-padding.md). 226 selects the
 * "quickly and lightly" instruction; 184 selects the "ordinary talk, one continuous phrase" one, whose
 * delivered spread has been measured on a single pilot Set only.
 *
 * The current audio profile (v6) takes its literals from this constant, so retuning it needs a new
 * profile version.
 */
export const LISTEN_AND_REPEAT_ITEM_TARGET_WPM = [226, 226, 226, 184, 184, 184, 184] as const;

/**
 * The most speech one Listen and Repeat clip may hold, in seconds. How long a sentence takes to say is
 * what makes a repeat-back item hard, ahead of its word count or rate alone, and ETS's longest measured
 * clip runs 4.68 s. The ceiling bounds the product of word count and rate, which neither of those
 * budgets sees alone. server/src/services/speakingConformance.ts checks it at generation, before any
 * paid render.
 */
export const LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC = 5 as const;

/**
 * The longest a Listen and Repeat sentence may be, in words. ETS's longest items run 13–14 words; 13
 * is what the renderer fits inside LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC, where 14-word clips have run
 * close to 6 s. With the clip ceiling it fixes the slow edge of the rate band below.
 */
export const LISTEN_AND_REPEAT_MAX_ITEM_WORDS = 13 as const;

/**
 * The slow edge of every Listen and Repeat item's rate band: the rate at which
 * LISTEN_AND_REPEAT_MAX_ITEM_WORDS exactly fills LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC. Derived, so the
 * invariant holds by construction: a sentence within the word cap, delivered at or above this rate,
 * cannot run past the clip ceiling. speakingConformance.ts takes its word budget back off this floor
 * and asserts the invariant at module load.
 *
 * The fast edge is per item (`target + LR_ITEM_BAND_FAST_MARGIN_WPM` in speakingAudioRenderer.ts):
 * only the slow edge answers to the clip ceiling.
 */
export const LISTEN_AND_REPEAT_ITEM_BAND_FLOOR_WPM = Math.ceil(
  (LISTEN_AND_REPEAT_MAX_ITEM_WORDS * 60) / LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC,
);

// v4 records a per-item Listen and Repeat target (`itemTargetWpms`, items 1–7) and the clip ceiling the
// Set was generated under, in place of one flat `itemTargetWpm`. Draws are as in v3.
const SpeakingAudioProfileV4Schema = SpeakingAudioProfileV3Schema.extend({
  version: z.literal("ets-2026-v4"),
  listenAndRepeat: z.object({
    accent: SpeakingAccentSchema,
    voice: z.string().min(1),
    briefingTargetWpm: z.literal(165),
    // Literals, not LISTEN_AND_REPEAT_ITEM_TARGET_WPM: the constant has since been retuned, and the
    // banked v4 Sets must keep parsing.
    itemTargetWpms: z.tuple([
      z.literal(200),
      z.literal(208),
      z.literal(215),
      z.literal(180),
      z.literal(178),
      z.literal(176),
      z.literal(175),
    ]),
    itemMaxClipSec: z.literal(LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC),
  }),
});

// v5 records the two-level target 226 / 170 and measures it as speech rather than file duration
// (transcode.probeSpeechDurationSec), so a recorded target and a recorded measurement denote the same
// quantity; `itemMaxClipSec` likewise counts seconds of speech. Draws are as in v3, but the version
// string is their hash input, so v5 casts a given set id differently from v4.
const SpeakingAudioProfileV5Schema = SpeakingAudioProfileV4Schema.extend({
  version: z.literal("ets-2026-v5"),
  listenAndRepeat: z.object({
    accent: SpeakingAccentSchema,
    voice: z.string().min(1),
    briefingTargetWpm: z.literal(165),
    // Literals: the live constant has since moved the tail target to 184.
    itemTargetWpms: z.tuple([
      z.literal(226),
      z.literal(226),
      z.literal(226),
      z.literal(170),
      z.literal(170),
      z.literal(170),
      z.literal(170),
    ]),
    itemMaxClipSec: z.literal(LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC),
  }),
});

// v6, the current profile: the Listen and Repeat tail target is 184 (see
// LISTEN_AND_REPEAT_ITEM_TARGET_WPM), which selects a pacing instruction of its own. Same shape and
// draws as v5.
export const SpeakingAudioProfileV6Schema = SpeakingAudioProfileV5Schema.extend({
  version: z.literal("ets-2026-v6"),
  listenAndRepeat: z.object({
    accent: SpeakingAccentSchema,
    voice: z.string().min(1),
    briefingTargetWpm: z.literal(165),
    // Derived from the live constant, as is the profile speakingAudioProfile.ts builds, so the two
    // always agree. Retuning the constant therefore needs a new version that pins these values as
    // literals first: otherwise every banked v6 Set stops matching and fails AnySetSchema.
    itemTargetWpms: z.tuple([
      z.literal(LISTEN_AND_REPEAT_ITEM_TARGET_WPM[0]),
      z.literal(LISTEN_AND_REPEAT_ITEM_TARGET_WPM[1]),
      z.literal(LISTEN_AND_REPEAT_ITEM_TARGET_WPM[2]),
      z.literal(LISTEN_AND_REPEAT_ITEM_TARGET_WPM[3]),
      z.literal(LISTEN_AND_REPEAT_ITEM_TARGET_WPM[4]),
      z.literal(LISTEN_AND_REPEAT_ITEM_TARGET_WPM[5]),
      z.literal(LISTEN_AND_REPEAT_ITEM_TARGET_WPM[6]),
    ]),
    itemMaxClipSec: z.literal(LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC),
  }),
});

export const SpeakingAudioProfileSchema = z.discriminatedUnion("version", [
  SpeakingAudioProfileV1Schema,
  SpeakingAudioProfileV2Schema,
  SpeakingAudioProfileV3Schema,
  SpeakingAudioProfileV4Schema,
  SpeakingAudioProfileV5Schema,
  SpeakingAudioProfileV6Schema,
]);
export type SpeakingAccent = z.infer<typeof SpeakingAccentSchema>;
export type SpeakingAudioProfile = z.infer<typeof SpeakingAudioProfileSchema>;
export type SpeakingAudioProfileV6 = z.infer<typeof SpeakingAudioProfileV6Schema>;
export type SpeakingAudioProfileVersion = SpeakingAudioProfile["version"];
