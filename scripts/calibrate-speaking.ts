/**
 * Live calibration of the Speaking scoring pipeline, in two layers. Makes paid calls.
 *
 * ETS's material is not in the public repository (docs/official-rubrics.md). This script reads ETS's
 * officially scored Speaking samples from server/test/fixtures/ets-samples/ and, for Layer 1, ETS's
 * sample Speaking Set (data/question-sets/speaking/spk-8d9ee619.json); both stay on the machine of
 * whoever holds them, ignored by git, and the script stops before spending anything when a layer's
 * material is missing.
 *
 * ETS published transcripts but no audio for its 2026 Speaking samples, so no one run can check
 * both that the real audio pipeline works and that scores land near ETS's. Hence two layers, each
 * printing what it does and does not prove:
 *
 *   Layer 1: audio-pipeline validity (shape, not score truth).
 *     Synthesizes the Set's seven Listen and Repeat sentences as perfect repetitions, uploads each
 *     through the real upload route (POST /api/attempts/:id/items/:itemId/audio: transcode, Ears)
 *     and scores the batch through the real score route (both audio Judges, the Arbiter). A clean
 *     reading of the exact sentence should score 4 or more with both Judges in "audio" mode; a 3 or
 *     less points at a pipeline defect. It proves nothing about agreement with ETS's scores.
 *
 *   Layer 2: transcript-level calibration against ETS's official scores.
 *     Sends the four interview-5-* official transcripts (ETS scored each 5) through both Judges'
 *     text paths (Gemini's direct call; OpenAI's Codex-first `judgeSpeakingTextFallback`) and the
 *     real `aggregateSpeaking` Arbiter. It checks the scorer's content judgment against ETS; it does
 *     not exercise Ears, transcode, upload or any audio-derived dimension, so every item carries a
 *     "not available" Delivery Report.
 *
 * Before Layer 1 spends anything, the seven fixtures' `promptSentence` is compared verbatim with the
 * Set's own sentences. Layer 1 needs no ETS truth, so on a mismatch it prints the difference and
 * proceeds with the Set's sentences.
 *
 * Needs:
 *   - Layer 1: a running server (`npm start` or `npm run dev`; CALIBRATE_BASE_URL, or PORT,
 *     replaces http://localhost:8787) that serves the ETS Set and has its own keys and CLIs, ffmpeg
 *     on PATH, and OPENAI_API_KEY here for the TTS. It writes its scratch audio to a temporary
 *     directory it removes, and leaves a Speaking Drill Attempt in the server's database, which it
 *     names when it ends. Every upload must come back transcribed: an Item whose transcription the
 *     server deferred (HTTP 202) stops the run before scoring.
 *   - Layer 2: GEMINI_API_KEY and OPENAI_API_KEY in .env, and the Claude and Codex CLIs signed in
 *     (the Arbiter runs Claude, then Codex; the OpenAI text Judge runs Codex, then OpenAI HTTP).
 *
 * Usage, from the repo root:
 *   npx tsx --env-file=.env scripts/calibrate-speaking.ts             # both layers
 *   npx tsx --env-file=.env scripts/calibrate-speaking.ts layer1      # Layer 1 only
 *   npx tsx --env-file=.env scripts/calibrate-speaking.ts layer2      # Layer 2 only
 * One layer can be rerun without paying for the other.
 *
 * Exits 2 when ETS's material is missing, and 1 if Layer 1 stops on an upload left untranscribed or
 * finds an item scoring 3 or less, a Judge failure, a Judge not in "audio" mode or a missing item, or
 * if Layer 2 finds an item more than 1.0 from its official score or a Judge failure.
 *
 * Cost, all paid calls: Layer 1 is 7 TTS + 7 Ears (through upload) + 2 Judge calls (7 Items each) +
 * 1 Arbiter call. Layer 2 is 2 text Judge calls (4 Items each) + 1 Arbiter call.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { DeliveryReport, JudgeReport, ScoreReport } from "@toefl-prep/shared";
import { synthesizeToFile } from "../server/src/services/tts.js";
import { withTtsSlot } from "../server/src/services/ttsQueue.js";
import { killAfterTimeout, MEDIA_TOOL_TIMEOUT_MS } from "../server/src/services/transcode.js";
import {
  composeSpeakingJudgePrompt,
  judgeSpeakingTextFallback,
  requestSpeakingReport,
  type SpeakingJudgeItem,
} from "../server/src/services/judges/speaking.js";
import { geminiCall } from "../server/src/services/judges/index.js";
import { aggregateSpeaking, type SpeakingAggregateItem } from "../server/src/services/arbiter.js";
import {
  parseAcceptedScoringJob,
  parseListenRepeatScoreResult,
  pollScoringJobResult,
  type ListenRepeatScoreResponse,
} from "./lib/scoringJob.js";
import { ETS_SAMPLE_FIXTURES_DIR, ETS_SPEAKING_SET_ID, etsSetPath, requireEtsMaterial } from "./lib/etsLocal.js";
import { rubricsSource } from "../server/src/services/skillReferences.js";

const BASE_URL = process.env.CALIBRATE_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const SET_ID = ETS_SPEAKING_SET_ID;
const SET_PATH = etsSetPath("speaking", SET_ID);
const FIXTURES_DIR = ETS_SAMPLE_FIXTURES_DIR;
const TARGET_DELTA = 0.5;
const HARD_BOUND_DELTA = 1.0;

const layerArg = process.argv[2];
if (layerArg && layerArg !== "layer1" && layerArg !== "layer2") {
  console.error(`unknown arg ${JSON.stringify(layerArg)} — expected "layer1", "layer2", or no arg (both layers)`);
  process.exit(2);
}
const RUN_LAYER1 = layerArg !== "layer2";
const RUN_LAYER2 = layerArg !== "layer1";

requireEtsMaterial([
  ...(RUN_LAYER1 ? [SET_PATH, ...Array.from({ length: 7 }, (_, i) => `${FIXTURES_DIR}/listen_repeat-5-${i + 1}.json`)] : []),
  ...(RUN_LAYER2 ? Array.from({ length: 4 }, (_, i) => `${FIXTURES_DIR}/interview-5-${i + 1}.json`) : []),
]);

function readJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

type SpeakingSetOnDisk = {
  id: string;
  listenAndRepeat: { items: { id: string; sentence: string; responseWindowSec: number }[] };
};

type LRFixture = {
  taskType: "listen_repeat";
  materials: { itemIndex: number; promptSentence: string };
  officialScore: number;
};

// The upload route stores the bytes as `<itemId>.webm`, and Ears and the Gemini Judge are told
// "audio/webm" from that name whatever the bytes are. So the TTS mp3 is converted to real webm/opus
// before upload, which is what a browser's MediaRecorder sends; uploading the mp3 as-is would hand
// both of them mislabelled audio. (The OpenAI Judge reads the server's own transcoded mp3.)
function mp3ToWebm(mp3Path: string, webmPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-y", "-i", mp3Path, "-c:a", "libopus", "-f", "webm", webmPath]);
    const cancelTimeout = killAfterTimeout(ff, MEDIA_TOOL_TIMEOUT_MS, () =>
      reject(new Error(`ffmpeg mp3->webm timed out after ${MEDIA_TOOL_TIMEOUT_MS} ms and was killed`)),
    );
    let stderr = "";
    ff.stderr.on("data", (d) => (stderr += d.toString()));
    ff.on("error", (error) => {
      cancelTimeout();
      reject(error);
    });
    ff.stdin.on("error", () => {});
    ff.stdin.end();
    ff.on("close", (code) => {
      cancelTimeout();
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg mp3->webm exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

function checkMaterialsMatch(set: SpeakingSetOnDisk, fixtures: LRFixture[]): boolean {
  console.log(`\n=== Layer 1 materials-match check: ${SET_ID} L&R sentences vs listen_repeat-5-* fixtures ===`);
  let allMatch = true;
  for (let i = 0; i < 7; i++) {
    const setItem = set.listenAndRepeat.items[i];
    const fixture = fixtures.find((f) => f.materials.itemIndex === i + 1);
    if (!fixture) {
      console.log(`  item ${i + 1} (${setItem.id}): NO MATCHING FIXTURE (itemIndex ${i + 1} not found)`);
      allMatch = false;
      continue;
    }
    const exact = setItem.sentence === fixture.materials.promptSentence;
    const normalized =
      setItem.sentence.replace(/[‘’]/g, "'") === fixture.materials.promptSentence.replace(/[‘’]/g, "'");
    if (exact) {
      console.log(`  item ${i + 1} (${setItem.id}): MATCH — "${setItem.sentence}"`);
    } else {
      allMatch = false;
      console.log(`  item ${i + 1} (${setItem.id}): MISMATCH${normalized ? " (apostrophe glyph only, semantically identical)" : ""}`);
      console.log(`    set:     ${JSON.stringify(setItem.sentence)}`);
      console.log(`    fixture: ${JSON.stringify(fixture.materials.promptSentence)}`);
    }
  }
  console.log(
    allMatch
      ? `-> VERDICT: all 7 sentences match the ETS listen_repeat fixtures verbatim. Layer 1 TTS-reads the ETS-official target text.`
      : `-> VERDICT: at least one mismatch (see above). Layer 1 proceeds with the Set's own sentences: it compares each ` +
          `score with the sentence that was read, not with an ETS score, so it needs no ETS wording (it proves pipeline ` +
          `shape, not score truth). The mismatched item(s) are not the byte-exact ETS wording.`
  );
  return allMatch;
}

// The Attempt Layer 1 creates stays in the server's database; the run names it when it ends.
const attemptsCreated: string[] = [];

async function createAttempt(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/attempts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "speaking", mode: "drill", setId: SET_ID }),
  });
  if (!res.ok) throw new Error(`POST /api/attempts failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { attemptId: string; isRepeat: boolean };
  attemptsCreated.push(body.attemptId);
  return body.attemptId;
}

function reportAttemptsLeft(): void {
  if (attemptsCreated.length === 0) return;
  console.log(
    `\nThis run left Speaking Drill Attempt ${attemptsCreated.join(", ")} on ${SET_ID} in the server's database, ` +
      `where it shows in your Attempt history.`,
  );
}

type UploadResult = { transcript: string; deliveryReport: DeliveryReport; durationSec: number | null };

// HTTP 202 from the upload route: the server stored the recording, but Ears did not transcribe it
// in the request, and a durable transcription job now owns it (retried on a schedule, then scored
// on its own once it lands).
type TranscriptionPending = {
  transcriptionPending: true;
  job?: { jobId?: string; status?: string; failureKind?: string | null; error?: string | null };
};

async function uploadItem(attemptId: string, itemId: string, webmPath: string): Promise<UploadResult> {
  const bytes = fs.readFileSync(webmPath);
  const form = new FormData();
  form.append("file", new File([bytes], `${itemId}.webm`, { type: "audio/webm" }));
  const res = await fetch(`${BASE_URL}/api/attempts/${attemptId}/items/${itemId}/audio`, { method: "POST", body: form });
  const body = await res.json();
  if (!res.ok) throw new Error(`POST .../items/${itemId}/audio failed: ${res.status} ${JSON.stringify(body)}`);
  // A 202 is an HTTP success with no transcript. The Item cannot join the batch POST /score until
  // its transcription lands (the route refuses a batch holding an Item still transcribing, as the
  // client knows when it keeps such an Item out), and when it lands the server scores that Item
  // by itself. Layer 1 checks the whole pipeline on all seven Items in one batch, so it stops here
  // rather than score a partial batch or wait on a retry schedule.
  if (res.status === 202) {
    const job = (body as TranscriptionPending).job;
    const detail = [job?.jobId && `job ${job.jobId}`, job?.status, job?.failureKind].filter(Boolean).join(", ");
    throw new Error(
      `${itemId}: the server stored the recording but did not transcribe it in the upload` +
        `${detail ? ` (transcription ${detail})` : ""}. Layer 1 needs every Item transcribed at upload, so it ` +
        `stops before scoring; the server retries the transcription and scores that Item on its own. Check ` +
        `that Ears is answering (GEMINI_API_KEY, GEMINI_JUDGE_MODEL on the server), then rerun Layer 1.`,
    );
  }
  if (res.status !== 200) throw new Error(`POST .../items/${itemId}/audio answered HTTP ${res.status}, expected 200`);
  return body as UploadResult;
}

async function scoreListenRepeat(
  attemptId: string,
  itemIds: string[]
): Promise<ListenRepeatScoreResponse> {
  const res = await fetch(`${BASE_URL}/api/attempts/${attemptId}/score`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ taskType: "listen_repeat", items: itemIds.map((itemId) => ({ itemId })) }),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error(
      `POST .../score returned malformed JSON (HTTP ${res.status}).`
    );
  }
  if (!res.ok) {
    throw new Error(`POST .../score failed with HTTP ${res.status}.`);
  }
  const jobId = parseAcceptedScoringJob(res.status, body);
  console.log(`  accepted scoring job ${jobId}; polling up to 10 minutes...`);
  return pollScoringJobResult(
    BASE_URL,
    attemptId,
    jobId,
    parseListenRepeatScoreResult
  );
}

async function runLayer1(): Promise<boolean> {
  console.log(`\n########## LAYER 1: audio-pipeline validity (TTS -> real upload -> real score, set ${SET_ID}) ##########`);
  console.log(
    `Proves: upload -> transcode -> ears -> both AUDIO-native judges -> arbiter all work end to end on real bytes.\n` +
      `Does NOT prove: that scores match ETS ground truth — no ETS audio exists to compare against, and TTS is not a human test-taker.`
  );

  const set = readJson<SpeakingSetOnDisk>(SET_PATH);
  const lrFixtures = Array.from({ length: 7 }, (_, i) =>
    readJson<LRFixture>(path.join(FIXTURES_DIR, `listen_repeat-5-${i + 1}.json`))
  );
  checkMaterialsMatch(set, lrFixtures);

  // The synthesized mp3 and webm are scratch, removed whether or not the uploads succeed; the
  // uploaded copies live under the server's data/audio/responses/<attemptId>/ like any Attempt's.
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "toefl-calibrate-speaking-"));

  const attemptId = await createAttempt();
  console.log(`\nattempt: ${attemptId}`);

  const items = set.listenAndRepeat.items;
  try {
    for (const item of items) {
      const mp3Path = path.join(scratchDir, `${item.id}.mp3`);
      const webmPath = path.join(scratchDir, `${item.id}.webm`);
      await withTtsSlot(() => synthesizeToFile({ text: item.sentence, provider: "openai", voice: "alloy" }, mp3Path));
      await mp3ToWebm(mp3Path, webmPath);
      console.log(`\n${item.id}: TTS+transcode "${item.sentence}" -> ${fs.statSync(webmPath).size} bytes webm`);
      const uploadResult = await uploadItem(attemptId, item.id, webmPath);
      console.log(`  uploaded -> transcript: ${JSON.stringify(uploadResult.transcript)}`);
      console.log(`  deliveryReport: ${JSON.stringify(uploadResult.deliveryReport)}`);
      console.log(`  durationSec: ${uploadResult.durationSec}`);
    }
  } finally {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  }

  console.log(`\nscoring full 7-item listen_repeat batch (1 batched call per judge + 1 arbiter call)...`);
  const started = Date.now();
  const result = await scoreListenRepeat(attemptId, items.map((i) => i.id));
  const elapsedSec = Math.round((Date.now() - started) / 1000);

  console.log(`\n--- raw score response (elapsed ${elapsedSec}s) ---`);
  console.log(JSON.stringify(result, null, 2));

  if (result.judgesFailed.length > 0) console.log(`\nJUDGES FAILED: ${result.judgesFailed.join(", ")}`);
  if (result.report.items.length !== items.length) {
    console.log(`\nWARNING: arbiter returned ${result.report.items.length} items, expected ${items.length}`);
  }

  console.log(`\n--- Layer 1 per-item summary ---`);
  let allModeAudio = true;
  for (const j of result.judges) {
    console.log(`judge ${j.judge}: mode=${j.mode}`);
    if (j.mode !== "audio") allModeAudio = false;
  }
  let minScore = Infinity;
  const defects: string[] = [];
  const belowTarget: string[] = [];
  for (const reportItem of result.report.items) {
    const target = result.items.find((i) => i.itemId === reportItem.itemId)?.target;
    console.log(`  ${reportItem.itemId}: finalScore=${reportItem.finalScore} ownScore=${reportItem.ownScore} target=${JSON.stringify(target)}`);
    minScore = Math.min(minScore, reportItem.finalScore);
    if (reportItem.finalScore <= 3) defects.push(reportItem.itemId);
    else if (reportItem.finalScore < 4) belowTarget.push(reportItem.itemId);
  }

  console.log(`\nmin finalScore across ${result.report.items.length} items: ${minScore}`);
  console.log(`both judges mode "audio": ${allModeAudio}`);
  if (belowTarget.length > 0) {
    console.log(
      `below target (above 3, under 4): [${belowTarget.join(", ")}]. A clean exact repetition should score 4 or more; ` +
        `only 3 or less counts as a pipeline defect.`,
    );
  }
  if (defects.length > 0) {
    console.log(`PIPELINE DEFECT: item(s) [${defects.join(", ")}] scored <=3 on a clean TTS exact repetition — investigate before accepting.`);
  }

  const pass = defects.length === 0 && allModeAudio && result.judgesFailed.length === 0 && result.report.items.length === items.length;
  console.log(pass ? `\n-> LAYER 1 PASS (all items >=4, mode audio for both judges, no judge failures)` : `\n-> LAYER 1 CONCERN/FAIL — see above`);
  return pass;
}

type InterviewFixture = {
  taskType: "interview";
  materials: { questionIndex: number; interviewerQuestion: string };
  responseText: string;
  officialScore: number;
  scoringComment: string;
};

const NO_AUDIO_DELIVERY: DeliveryReport = {
  paceWpm: null,
  pauses: "not available — Layer 2 is a text-only calibration; no audio was synthesized or delivered for these items.",
  intelligibility: "not available — text-only calibration, no audio.",
  suspectedMispronunciations: [],
  intonation: "not available — text-only calibration, no audio.",
};

async function textJudgeInterview(judge: "gemini" | "openai", items: SpeakingJudgeItem[]): Promise<JudgeReport> {
  // "text-fallback" mode: Layer 2 sends no audio, and the "audio" mode's prompt would tell the Judge
  // to listen to audio it never received. This is the prompt production's Text Fallback sends.
  const prompt = composeSpeakingJudgePrompt("interview", items, "text-fallback");
  if (judge === "gemini") {
    const report = await requestSpeakingReport(
      "gemini",
      prompt,
      (value) => geminiCall(value, fetch)
    );
    return { ...report, judge, taskType: "interview" };
  }
  const result = await judgeSpeakingTextFallback({
    taskType: "interview",
    items,
  });
  console.log(`OpenAI text calibration provider: ${result.provider}`);
  return result.report;
}

async function runLayer2(): Promise<boolean> {
  console.log(`\n########## LAYER 2: transcript-level score calibration vs. official ETS scores (interview) ##########`);
  console.log(
    `Proves: the judges'/arbiter's TEXT/content judgment calibrates against ETS's official human scores.\n` +
      `Does NOT prove: anything about ears, transcode, upload, or audio-derived dimensions (pace/pauses/intelligibility/` +
      `pronunciation) — deliveryReport below is a documented "not available" placeholder for every item.`
  );

  // Layer 2 scores in this process, so it reads the rubric copy this checkout resolves.
  console.log(`rubric source scored with: ${rubricsSource()}`);
  const fixtures = Array.from({ length: 4 }, (_, i) => readJson<InterviewFixture>(path.join(FIXTURES_DIR, `interview-5-${i + 1}.json`)));

  const judgeItems: SpeakingJudgeItem[] = fixtures.map((f) => ({
    itemId: `int-${f.materials.questionIndex}`,
    // Never read on the text paths; present to satisfy SpeakingJudgeItem's shape.
    audioPath: "(no audio — Layer 2 text-only calibration)",
    transcript: f.responseText,
    deliveryReport: NO_AUDIO_DELIVERY,
    question: f.materials.interviewerQuestion,
  }));

  console.log(`\nrunning both judges through the TEXT-only path (1 batched 4-item call each)...`);
  const judges = ["gemini", "openai"] as const;
  const judgeSettled = await Promise.allSettled(judges.map((j) => textJudgeInterview(j, judgeItems)));
  judgeSettled.forEach((s, i) => {
    if (s.status === "rejected") console.error(`judge ${judges[i]} failed`);
  });
  const judgeReports = judgeSettled
    .filter((s): s is PromiseFulfilledResult<JudgeReport> => s.status === "fulfilled")
    .map((s) => s.value);
  const judgesFailed = judges.filter((_, i) => judgeSettled[i].status === "rejected");

  console.log(`\n--- raw judge reports ---`);
  console.log(JSON.stringify(judgeReports, null, 2));
  if (judgesFailed.length > 0) console.log(`JUDGES FAILED: ${judgesFailed.join(", ")}`);

  if (judgeReports.length === 0) {
    console.log(`\n-> LAYER 2 FAIL: both judges failed, cannot aggregate.`);
    return false;
  }

  const aggregateItems: SpeakingAggregateItem[] = judgeItems.map((it) => ({
    itemId: it.itemId,
    question: it.question,
    transcript: it.transcript,
    deliveryReport: it.deliveryReport,
  }));

  console.log(`\nrunning arbiter (aggregateSpeaking, 1 batched call)...`);
  const started = Date.now();
  const { report } = await aggregateSpeaking({
    taskType: "interview",
    items: aggregateItems,
    judgeReports,
  });
  const elapsedSec = Math.round((Date.now() - started) / 1000);

  console.log(`\n--- raw arbiter ScoreReport (elapsed ${elapsedSec}s) ---`);
  console.log(JSON.stringify(report, null, 2));

  console.log(`\n--- Layer 2 per-item official vs scored ---`);
  let allPass = true;
  for (const fixture of fixtures) {
    const itemId = `int-${fixture.materials.questionIndex}`;
    const reportItem = report.items.find((i) => i.itemId === itemId);
    if (!reportItem) {
      console.log(`  ${itemId}: MISSING from arbiter output — FAIL`);
      allPass = false;
      continue;
    }
    const perJudge = judgeReports.map((r) => {
      const ji = r.items.find((i) => i.itemId === itemId);
      return `${r.judge}=${ji?.score ?? "?"}`;
    });
    const delta = Math.abs(reportItem.finalScore - fixture.officialScore);
    if (delta > HARD_BOUND_DELTA) allPass = false;
    console.log(`  ${itemId}:`);
    console.log(`    official:   ${fixture.officialScore}  (${fixture.scoringComment})`);
    console.log(`    judges:     ${perJudge.join(", ")}`);
    console.log(`    ownScore:   ${reportItem.ownScore}`);
    console.log(`    finalScore: ${reportItem.finalScore}`);
    console.log(`    delta:      ${delta}`);
    console.log(
      `    -> ${
        delta <= TARGET_DELTA
          ? `PASS (within target +/-${TARGET_DELTA})`
          : delta <= HARD_BOUND_DELTA
            ? `PASS (within hard bound +/-${HARD_BOUND_DELTA}, outside target +/-${TARGET_DELTA})`
            : `FAIL (exceeds hard bound +/-${HARD_BOUND_DELTA})`
      }`
    );
  }

  const pass = allPass && judgesFailed.length === 0;
  console.log(pass ? `\n-> LAYER 2 PASS (all 4 items within +/-${HARD_BOUND_DELTA} hard bound)` : `\n-> LAYER 2 FAIL`);
  return pass;
}

let layer1Pass = true;
let layer2Pass = true;
try {
  if (RUN_LAYER1) layer1Pass = await runLayer1();
  if (RUN_LAYER2) layer2Pass = await runLayer2();
} catch (error) {
  reportAttemptsLeft();
  throw error;
}

console.log(`\n########## SUMMARY ##########`);
if (RUN_LAYER1) console.log(`Layer 1 (audio-pipeline validity):       ${layer1Pass ? "PASS" : "CONCERN/FAIL"}`);
if (RUN_LAYER2) console.log(`Layer 2 (transcript-level vs official):  ${layer2Pass ? "PASS" : "FAIL"}`);
console.log(
  `\nLayer 1 proves the REAL audio pipeline (upload / transcode / ears / audio-native judges / arbiter) works end to end;\n` +
    `it does NOT prove ETS-level score truth (no ETS audio exists, TTS is not a human test-taker).\n` +
    `Layer 2 proves the scorer's text/content judgment calibrates against ETS's official scores;\n` +
    `it does NOT exercise ears, transcode, upload, or any audio-derived dimension.\n` +
    `Together they cover the pipeline; neither alone does.`
);
reportAttemptsLeft();

if ((RUN_LAYER1 && !layer1Pass) || (RUN_LAYER2 && !layer2Pass)) {
  console.error(`\nFAIL: see CONCERN/FAIL layer(s) above.`);
  process.exit(1);
}
console.log(`\nAll run layers passed.`);
