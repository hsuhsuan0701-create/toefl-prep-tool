// The Gemini prebuilt-voice cast: which of Gemini's published voices this app uses, grouped into
// pools. Listening (listeningGenerator.ts) and Speaking (speakingAudioProfile.ts) both cast from
// this one list.
//
// Names are Gemini API values, spelled exactly as Google publishes them: a typo here is a runtime
// failure on a paid synthesis call, not a compile error.
//
// This module owns only the cast. Which pool a Stimulus or task draws from, and the rotation that
// picks a voice within a pool, belong to each consumer.

/** The three role-constrained voice pools this app casts from. */
export type GeminiVoicePool = "authoritative" | "young" | "service";

export type SpeakerGender = "male" | "female";

export interface VoicePoolMembers {
  readonly female: readonly string[];
  readonly male: readonly string[];
}

// authoritative — a lecturer, a professor, an official voice.
// young        — a student, a peer.
// service      — campus staff, front desk, an announcer.
//
// The three pools are pairwise disjoint (asserted in geminiVoices.test.ts) — no voice appears in two
// of them — which is what guarantees a Conversation's two speakers (drawn from different pools) get
// different voices.
export const GEMINI_VOICE_POOLS: Readonly<Record<GeminiVoicePool, VoicePoolMembers>> = {
  authoritative: {
    female: ["Gacrux", "Kore", "Erinome"],
    male: ["Sadaltager", "Charon", "Rasalgethi", "Alnilam", "Orus"],
  },
  young: {
    female: ["Leda", "Autonoe", "Zephyr", "Laomedeia"],
    male: ["Puck", "Zubenelgenubi", "Fenrir"],
  },
  service: {
    female: ["Vindemiatrix", "Sulafat", "Callirrhoe", "Despina"],
    male: ["Achird", "Iapetus", "Umbriel", "Algieba"],
  },
};

/**
 * Every named pool, in a stable order: the list to iterate or rotate through (listeningGenerator's
 * LCR_POOL_ROTATION is this array), so a pool added above is drawn from without a second list to
 * update.
 */
export const GEMINI_VOICE_POOL_NAMES: readonly GeminiVoicePool[] = ["authoritative", "young", "service"];
