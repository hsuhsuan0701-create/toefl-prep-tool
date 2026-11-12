import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { placeholderSpeakingSet } from "./helpers/setFixtures.js";
import {
  LISTEN_AND_REPEAT_ITEM_TARGET_WPM,
  ListeningSetSchema,
  type ListeningSet,
} from "@toefl-prep/shared";
import { resetClipMeasurementSink, setClipMeasurementSink } from "../src/services/clipMeasurementLog.js";
import { renderListeningAudio } from "../src/services/listeningAudioRenderer.js";
import { renderSpeakingAudio } from "../src/services/speakingAudioRenderer.js";
import type { TtsRequest } from "../src/services/tts.js";

// A clip_measurements row is marked 'published' only once its render's audio-manifest.json is on
// disk. Before that the render can still fail and delete its whole output directory, and a row
// marked published for audio that never shipped could not be told apart from a true one.

const dirs: string[] = [];
const tmpDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clip-publication-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  resetClipMeasurementSink();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Records every promotion, and whether the render's manifest existed at that moment. */
function watchPromotions(manifestPath: () => string) {
  const promotions: { disposition: string; manifestOnDisk: boolean }[] = [];
  setClipMeasurementSink({
    insert: () => undefined,
    markTake: (_id, disposition) => {
      promotions.push({ disposition, manifestOnDisk: fs.existsSync(manifestPath()) });
    },
  });
  return promotions;
}

/** Durations that put every Speaking clip inside its band, so each clip has exactly one take. */
const SPEAKING_IN_BAND = [
  1.8,
  ...LISTEN_AND_REPEAT_ITEM_TARGET_WPM.map((targetWpm) => Number(((7 / targetWpm) * 60).toFixed(3))),
  2.2,
  ...Array(4).fill(3.1),
];

function speakingDeps(onSynthesize: (callNumber: number, outPath: string) => void = () => undefined) {
  let calls = 0;
  let probes = 0;
  return {
    synthesize: async (_request: TtsRequest, outPath: string) => {
      calls += 1;
      fs.writeFileSync(outPath, "audio");
      onSynthesize(calls, outPath);
    },
    probeDuration: async () => SPEAKING_IN_BAND[probes++]!,
  };
}

function listeningSet(): ListeningSet {
  return ListeningSetSchema.parse({
    id: "lsn-001", kind: "listening", source: "generated", createdAt: "2026-01-01T00:00:00.000Z",
    router: {
      timeLimitSec: 100,
      listenChoose: [{
        id: "lcr-1", taskType: "listen_choose", audio: "",
        speaker: { id: "sp-1", role: "student", gender: "female", accent: "north-american", voice: "Kore", provider: "gemini" },
        utterance: "This is a test utterance with eight words",
        options: [
          { id: "a", text: "Option A" }, { id: "b", text: "Option B" },
          { id: "c", text: "Option C" }, { id: "d", text: "Option D" },
        ],
        correctOptionId: "a", skill: "function", explanationZh: "測試解釋文字內容足夠長度以通過驗證。",
      }],
      conversations: [], announcements: [], academicTalks: [],
    },
    lowerModule: { timeLimitSec: 50, listenChoose: [], conversations: [], announcements: [], academicTalks: [] },
    upperModule: { timeLimitSec: 50, listenChoose: [], conversations: [], announcements: [], academicTalks: [] },
  }) as ListeningSet;
}

function listeningDeps(dataDir: string, onSynthesize: (outPath: string) => void = () => undefined) {
  return {
    dataDir,
    synthesize: async (_request: TtsRequest, outPath: string) => {
      fs.writeFileSync(outPath, "audio");
      onSynthesize(outPath);
    },
    // Eight words at 155 WPM: inside the Listen and Choose a Response band.
    probeDuration: async () => (8 / 155) * 60,
  };
}

/** Puts a directory where the renderer writes its temporary manifest, so that write fails. */
const blockManifestWrite = (outputDir: string) => fs.mkdirSync(path.join(outputDir, ".audio-manifest.tmp"));

describe("speaking render", () => {
  it("marks the shipped takes published only after the manifest is written", async () => {
    const outputDir = path.join(tmpDir(), "target");
    const promotions = watchPromotions(() => path.join(outputDir, "audio-manifest.json"));
    await renderSpeakingAudio(placeholderSpeakingSet(), { setId: "spk-001", outputDir, audioPathPrefix: "stimuli/spk-001" }, speakingDeps());
    expect(promotions).toHaveLength(13);
    expect(promotions.every((p) => p.disposition === "published" && p.manifestOnDisk)).toBe(true);
  });

  it("marks nothing published when the render fails writing its manifest", async () => {
    const outputDir = path.join(tmpDir(), "target");
    const promotions = watchPromotions(() => path.join(outputDir, "audio-manifest.json"));
    const deps = speakingDeps((callNumber) => { if (callNumber === 13) blockManifestWrite(outputDir); });
    await expect(renderSpeakingAudio(placeholderSpeakingSet(), { setId: "spk-001", outputDir, audioPathPrefix: "stimuli/spk-001" }, deps))
      .rejects.toThrow();
    expect(fs.existsSync(outputDir)).toBe(false);
    expect(promotions).toEqual([]);
  });
});

describe("listening render", () => {
  it("marks the shipped takes published only after the manifest is written", async () => {
    const dataDir = tmpDir();
    const outputDir = path.join(dataDir, "audio/stimuli/lsn-001");
    const promotions = watchPromotions(() => path.join(outputDir, "audio-manifest.json"));
    await renderListeningAudio(listeningSet(), listeningDeps(dataDir));
    expect(promotions).toEqual([{ disposition: "published", manifestOnDisk: true }]);
  });

  it("marks nothing published when the render fails writing its manifest", async () => {
    const dataDir = tmpDir();
    const outputDir = path.join(dataDir, "audio/stimuli/lsn-001");
    const promotions = watchPromotions(() => path.join(outputDir, "audio-manifest.json"));
    await expect(renderListeningAudio(listeningSet(), listeningDeps(dataDir, () => blockManifestWrite(outputDir))))
      .rejects.toThrow();
    expect(promotions).toEqual([]);
  });
});
