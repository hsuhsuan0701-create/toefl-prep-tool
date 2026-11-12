import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SpeakingSet } from "@toefl-prep/shared";
import { config } from "../src/lib/config.js";
import { countEnglishWords } from "../src/services/audioPace.js";
import { createSetStore } from "../src/services/setStore.js";
import { auditSpeakingSetAudio } from "../src/services/speakingAudioAudit.js";
import { AUDIO_ROLE_POLICY, buildSpeakingRenderPlan } from "../src/services/speakingAudioRenderer.js";
import { AUDIO_PROFILE_VERSION } from "../src/services/speakingAudioProfile.js";

// scripts/audit-speaking-audio.ts reports the pace of a published Set's clips. It has to reach the
// verdict the renderer reached: the same per-clip band (per Listen and Repeat item, read off the
// Set's own recorded profile), the same speech-span measurement, and the files the Set itself
// points at.

// This file's seeded copy of the committed bank. The suite seeds no stimulus audio, and the probe
// below is a stand-in that never reads a clip, so each clip the Set names is written here as an
// empty placeholder: the audit resolves every path to a real file under the audio root before it
// probes, and that containment check is part of what it does.
const DATA_DIR = config.dataDir;
const AUDIO_ROOT = path.join(DATA_DIR, "audio");

function clipPaths(set: SpeakingSet): string[] {
  return [
    set.listenAndRepeat.introAudio,
    ...set.listenAndRepeat.items.map((item) => item.audio),
    set.interview.introAudio,
    ...set.interview.questions.map((question) => question.audio),
  ].map((relative) => path.join(AUDIO_ROOT, relative!));
}

function writePlaceholderClips(set: SpeakingSet): void {
  for (const file of clipPaths(set)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, "");
  }
}

function bankedV6Set(): SpeakingSet {
  const set = createSetStore(DATA_DIR).scanBank().sets
    .map((banked) => banked.set)
    .find((s): s is SpeakingSet => s.kind === "speaking" && s.audioProfile?.version === AUDIO_PROFILE_VERSION);
  if (!set) throw new Error("the tracked bank has no Speaking Set on the current profile");
  return set;
}

describe("auditSpeakingSetAudio", () => {
  it("measures the files the Set references, against the band the renderer planned for each clip", async () => {
    const set = bankedV6Set();
    writePlaceholderClips(set);
    const probed: string[] = [];
    // Every clip measures as its own target pace, plus 10 WPM.
    const plan = buildSpeakingRenderPlan(set, set.audioProfile!);
    const probe = async (file: string) => {
      probed.push(file);
      const clip = plan[probed.length - 1]!;
      return (countEnglishWords(clip.text) / (clip.band.targetWpm + 10)) * 60;
    };

    const clips = await auditSpeakingSetAudio(set, AUDIO_ROOT, probe);

    expect(probed).toEqual(clipPaths(set));
    expect(clips.map((clip) => clip.targetWpm)).toEqual(plan.map((clip) => clip.band.targetWpm));
    // The first Listen and Repeat item is held to its own fast target, not AUDIO_ROLE_POLICY's flat
    // band for v1-v3 profiles.
    expect(clips[1]!.targetWpm).not.toBe(AUDIO_ROLE_POLICY["lr-item"].targetWpm);
    for (const clip of clips) {
      expect(clip.profile).toBe(AUDIO_PROFILE_VERSION);
      expect(clip.verdict).toBe("in-band");
    }
  });

  it("refuses a Set that records no audio profile", async () => {
    const { audioProfile: _audioProfile, ...legacy } = bankedV6Set();
    await expect(auditSpeakingSetAudio(legacy as SpeakingSet, AUDIO_ROOT, async () => 1))
      .rejects.toThrow("records no audio profile");
  });
});
