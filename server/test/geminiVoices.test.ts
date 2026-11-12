import { describe, expect, it } from "vitest";
import { GEMINI_VOICE_POOL_NAMES, GEMINI_VOICE_POOLS, type GeminiVoicePool, type SpeakerGender } from "../src/services/geminiVoices.js";

// Google's published list of the 30 prebuilt Gemini TTS voices, and this suite's reference table of
// each one's gender. The table only checks the pool split in geminiVoices.ts; the app does not use
// all 30 voices.
const ALL_GEMINI_VOICES: readonly string[] = [
  "Achernar", "Achird", "Algenib", "Algieba", "Alnilam", "Aoede", "Autonoe", "Callirrhoe", "Charon",
  "Despina", "Enceladus", "Erinome", "Fenrir", "Gacrux", "Iapetus", "Kore", "Laomedeia", "Leda",
  "Orus", "Pulcherrima", "Puck", "Rasalgethi", "Sadachbia", "Sadaltager", "Schedar", "Sulafat",
  "Umbriel", "Vindemiatrix", "Zephyr", "Zubenelgenubi",
];

const GENDER_OF_ALL_GEMINI_VOICES: Readonly<Record<string, SpeakerGender>> = {
  Achernar: "female", Achird: "male", Algenib: "male", Algieba: "male", Alnilam: "male",
  Aoede: "female", Autonoe: "female", Callirrhoe: "female", Charon: "male", Despina: "female",
  Enceladus: "male", Erinome: "female", Fenrir: "male", Gacrux: "female", Iapetus: "male",
  Kore: "female", Laomedeia: "female", Leda: "female", Orus: "male", Pulcherrima: "female",
  Puck: "male", Rasalgethi: "male", Sadachbia: "male", Sadaltager: "male", Schedar: "male",
  Sulafat: "female", Umbriel: "male", Vindemiatrix: "female", Zephyr: "female", Zubenelgenubi: "male",
};

describe("GEMINI_VOICE_POOLS", () => {
  it("has exactly the three named pools", () => {
    expect(Object.keys(GEMINI_VOICE_POOLS).sort()).toEqual(["authoritative", "service", "young"]);
    expect(GEMINI_VOICE_POOL_NAMES.slice().sort()).toEqual(["authoritative", "service", "young"]);
  });

  it("every voice name used is one of Gemini's 30 published voices", () => {
    for (const pool of GEMINI_VOICE_POOL_NAMES) {
      for (const gender of ["female", "male"] as const) {
        for (const voice of GEMINI_VOICE_POOLS[pool][gender]) {
          expect(ALL_GEMINI_VOICES, `${pool}/${gender} voice "${voice}" is not one of Gemini's 30`).toContain(voice);
        }
      }
    }
  });

  it("no pool mixes genders — every name in a `female` list is female, and every name in a `male` list is male, per the reference table", () => {
    for (const pool of GEMINI_VOICE_POOL_NAMES) {
      for (const voice of GEMINI_VOICE_POOLS[pool].female) {
        expect(GENDER_OF_ALL_GEMINI_VOICES[voice], `expected "${voice}" (in ${pool}.female) to be female`).toBe("female");
      }
      for (const voice of GEMINI_VOICE_POOLS[pool].male) {
        expect(GENDER_OF_ALL_GEMINI_VOICES[voice], `expected "${voice}" (in ${pool}.male) to be male`).toBe("male");
      }
    }
  });

  it("the three pools are pairwise disjoint — no voice name appears in more than one pool", () => {
    const seen = new Map<string, GeminiVoicePool>();
    for (const pool of GEMINI_VOICE_POOL_NAMES) {
      for (const gender of ["female", "male"] as const) {
        for (const voice of GEMINI_VOICE_POOLS[pool][gender]) {
          const owner = seen.get(voice);
          expect(owner, `"${voice}" appears in both "${owner}" and "${pool}"`).toBeUndefined();
          seen.set(voice, pool);
        }
      }
    }
  });

  it("has no duplicate voice within a single (pool, gender) list", () => {
    for (const pool of GEMINI_VOICE_POOL_NAMES) {
      for (const gender of ["female", "male"] as const) {
        const list = GEMINI_VOICE_POOLS[pool][gender];
        expect(new Set(list).size).toBe(list.length);
      }
    }
  });
});
