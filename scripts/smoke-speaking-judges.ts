// Live smoke test for the Speaking Judges, not part of `npm test`. Makes one paid call each to
// OpenAI TTS and the OpenAI audio Judge (OPENAI_API_KEY), and to Ears and the Gemini Judge
// (GEMINI_API_KEY). Needs no running server. From the repo root:
//   npx tsx --env-file=.env scripts/smoke-speaking-judges.ts
//
// Reads ETS's sample Speaking Set, which is not in the public repository (docs/official-rubrics.md);
// it stops before any call when the Set is missing.
//
// Synthesizes one Listen and Repeat sentence to mp3, runs Ears on it for a transcript and Delivery
// Report, computes the word diff, then runs both Speaking Judges once on it as a one-Item batch.
// Both Judges get the mp3 itself: Gemini as audio/mpeg, OpenAI in its native mp3 format. The mp3 is
// written to a temporary directory, removed when the run ends.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { synthesizeToFile } from "../server/src/services/tts.js";
import { withTtsSlot } from "../server/src/services/ttsQueue.js";
import { hearRecording } from "../server/src/services/ears.js";
import { wordDiff } from "../server/src/services/wordDiff.js";
import { judgeSpeaking } from "../server/src/services/judges/speaking.js";
import { ETS_SPEAKING_SET_ID, etsSetPath, requireEtsMaterial } from "./lib/etsLocal.js";

const setPath = etsSetPath("speaking", ETS_SPEAKING_SET_ID);
requireEtsMaterial([setPath]);
const set = JSON.parse(fs.readFileSync(setPath, "utf8"));
const item = set.listenAndRepeat.items[0];
console.log("Seeded set:", set.id, "| item:", item.id, "| target sentence:", JSON.stringify(item.sentence));

const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "toefl-smoke-speaking-judges-"));
const mp3Path = path.join(scratchDir, "speaking-judges-lr1.mp3");
try {
  await withTtsSlot(() => synthesizeToFile({ text: item.sentence, provider: "openai", voice: "alloy" }, mp3Path));
  console.log("\nTTS wrote", mp3Path, "(", fs.statSync(mp3Path).size, "bytes )");

  const ears = await hearRecording({ audioPath: mp3Path, mimeType: "audio/mpeg", context: "test taker repeating a heard sentence" });
  console.log("\n--- hearRecording (live) ---");
  console.log(JSON.stringify(ears, null, 2));

  const diff = wordDiff(item.sentence, ears.transcript);
  console.log("\n--- wordDiff(target, transcript) ---");
  console.log(JSON.stringify(diff, null, 2));

  const judgeItem = {
    itemId: item.id,
    audioPath: mp3Path,
    transcript: ears.transcript,
    deliveryReport: ears.deliveryReport,
    target: item.sentence,
    diff,
  };

  for (const judge of ["gemini", "openai"] as const) {
    const result = await judgeSpeaking(judge, { taskType: "listen_repeat", items: [judgeItem] });
    console.log(`\n--- judgeSpeaking(${judge}) ---`);
    console.log("mode:", result.mode);
    console.log(JSON.stringify(result.report, null, 2));
  }
} finally {
  fs.rmSync(scratchDir, { recursive: true, force: true });
}
