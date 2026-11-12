import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LISTEN_AND_REPEAT_ITEM_TARGET_WPM,
  LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC,
} from "@toefl-prep/shared";
import { config } from "../src/lib/config.js";
import { pacingDirection } from "../src/services/audioPrompt.js";
import { GEMINI_VOICE_POOLS } from "../src/services/geminiVoices.js";
import {
  AUDIO_PROFILE_VERSION,
  profileForSetId,
  SPEAKING_DRAW_ACCENTS,
  speakingProfileV6,
} from "../src/services/speakingAudioProfile.js";

const poolMembers = (pool: keyof typeof GEMINI_VOICE_POOLS): readonly string[] => [
  ...GEMINI_VOICE_POOLS[pool].female,
  ...GEMINI_VOICE_POOLS[pool].male,
];

const spreadOfIds = (count: number) =>
  Array.from({ length: count }, (_, i) => `spk-${i.toString(16).padStart(8, "0")}`);

describe("profileForSetId", () => {
  it("is the current v6 profile, deterministic, and records the configured Gemini TTS model", () => {
    expect(AUDIO_PROFILE_VERSION).toBe("ets-2026-v6");
    const first = profileForSetId("spk-001");
    expect(profileForSetId("spk-001")).toEqual(first);
    expect(first).toEqual(speakingProfileV6("spk-001"));
    expect(first.version).toBe(AUDIO_PROFILE_VERSION);
    expect(first.provider).toBe("gemini");
    expect(first.model).toBe(config.geminiTtsModel);
  });

  // Every published Set that recorded the current version must still derive from its id. A pace
  // retune that edits v6's literals in place instead of adding a version breaks those Sets here.
  it("reproduces the v6 profile every published v6 Set recorded", () => {
    // The committed bank, as this file's seeded copy holds it.
    const speakingDir = path.join(config.dataDir, "question-sets/speaking");
    const recorded = fs.readdirSync(speakingDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(fs.readFileSync(path.join(speakingDir, file), "utf8")) as { id: string; audioProfile?: Record<string, unknown> & { version: string; model: string } })
      .filter((set) => set.audioProfile?.version === AUDIO_PROFILE_VERSION);
    expect(recorded.length).toBeGreaterThan(0);
    for (const { id, audioProfile } of recorded) {
      // `model` records whichever model rendered the Set, so it need not equal today's setting.
      const { model, ...recordedRest } = audioProfile!;
      const { model: _derivedModel, ...derivedRest } = speakingProfileV6(id);
      expect(recordedRest, `${id} no longer matches its derived profile`).toEqual(derivedRest);
      expect(typeof model === "string" && model.length > 0, `${id} records no TTS model`).toBe(true);
    }
  });

  // Deterministic over these ids, so this is a fixed fact, not a sample. The floor is a third of a
  // uniform share, far above what a dead pool member (0) could produce.
  it("draws each of ETS's three regions at a comparable rate, never new-zealand, and two different accents", () => {
    const ids = spreadOfIds(300);
    const counts = { listenAndRepeat: new Map<string, number>(), interview: new Map<string, number>() };
    for (const setId of ids) {
      const profile = profileForSetId(setId);
      expect(profile.interview.accent).not.toBe(profile.listenAndRepeat.accent);
      counts.listenAndRepeat.set(profile.listenAndRepeat.accent, (counts.listenAndRepeat.get(profile.listenAndRepeat.accent) ?? 0) + 1);
      counts.interview.set(profile.interview.accent, (counts.interview.get(profile.interview.accent) ?? 0) + 1);
    }
    for (const role of ["listenAndRepeat", "interview"] as const) {
      expect([...counts[role].keys()].sort()).toEqual([...SPEAKING_DRAW_ACCENTS].sort());
      for (const accent of SPEAKING_DRAW_ACCENTS) {
        expect(counts[role].get(accent)!, `${accent} is under-drawn for ${role}`).toBeGreaterThanOrEqual(ids.length / 9);
      }
    }
  });

  it("never gives both tasks the same voice, and reaches both genders of both pools", () => {
    const lrVoices = new Set<string>();
    const interviewVoices = new Set<string>();
    for (const setId of spreadOfIds(200)) {
      const profile = profileForSetId(setId);
      expect(profile.listenAndRepeat.voice).not.toBe(profile.interview.voice);
      lrVoices.add(profile.listenAndRepeat.voice);
      interviewVoices.add(profile.interview.voice);
    }
    expect([...lrVoices].sort()).toEqual([...poolMembers("authoritative")].sort());
    expect([...interviewVoices].sort()).toEqual([...poolMembers("service")].sort());
  });

  it("records the two-level pace policy, in speech words per minute", () => {
    const { listenAndRepeat, interview } = speakingProfileV6("spk-001");
    expect(listenAndRepeat.itemTargetWpms).toEqual([226, 226, 226, 184, 184, 184, 184]);
    expect([...listenAndRepeat.itemTargetWpms]).toEqual([...LISTEN_AND_REPEAT_ITEM_TARGET_WPM]);
    expect(listenAndRepeat.itemMaxClipSec).toBe(LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC);
    const targets = [...listenAndRepeat.itemTargetWpms];
    // Two levels, one per pacingDirection line: Gemini is paced by prose alone. Items 1-3 take the
    // fast line, items 4-7 the one aimed at ETS's measured tail mean of 184.3.
    expect(new Set(targets).size).toBe(2);
    expect(Math.min(...targets.slice(0, 3))).toBeGreaterThan(Math.max(...targets.slice(3)));
    expect(pacingDirection({ targetWpm: targets[0]!, minWpm: 0, maxWpm: 0 })).toContain("quickly");
    const tail = pacingDirection({ targetWpm: targets[6]!, minWpm: 0, maxWpm: 0 });
    expect(tail).toContain("continuous");
    expect(tail).not.toContain("conversational");
    expect(tail).not.toContain("brisk");
    expect(listenAndRepeat.briefingTargetWpm).toBe(165);
    expect(interview.introTargetWpm).toBe(165);
    expect(interview.questionTargetWpm).toBe(155);
  });

  it.each(["", "spk 001", "spk/001", "spk.001"])("rejects invalid set ID %j", (setId) => {
    expect(() => profileForSetId(setId)).toThrow();
  });
});
