// Measures the speaking rate of ETS's own Speaking reference audio: Teacher Practice Test 5
// (`--source practice-test-5`) or the lesson-plan clips (`--source lesson-plan`), each clip's word
// count over its whole file duration. Reads local audio only and makes no paid call. Prints JSON;
// with `--out` the Practice Test 5 result is also written to that file
// (server/test/fixtures/ets-speaking-audio-calibration.json holds one such result).
//
// ETS licenses the clips and their transcripts, so neither is in the repository. The audio stays in
// the directory `--audio-dir` names, on the machine of whoever downloaded it from ETS; the tables
// below keep only each clip's word count, which countEnglishWords (audioPace.ts) gave for ETS's
// transcript of it. The script checks every clip is present before measuring any.
//
// The rates are FILE rates: edge silence counts as speech time. Every pace band in audioPace.ts is a
// speech rate (file less edge silence), so these read a little slower than the bands measure;
// ETS's clips carry about 0.14 s of edge silence each
// (docs/research/2026-08-23-ets-reference-audio-padding.md). The script keeps file duration because
// the committed fixture was measured that way and cannot be re-measured without the ETS audio, and it
// says so in its output.
//
//   npx tsx scripts/audit-ets-speaking-audio.ts --source practice-test-5 --audio-dir <absolute dir> --out <file>
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { median } from "../server/src/services/speakingAudioAudit.js";
import { parseEtsAuditArgs, writeAuditOutput } from "../server/src/services/etsAudioAuditCli.js";
import { MEDIA_TOOL_TIMEOUT_MS } from "../server/src/services/transcode.js";

const DURATION_BASIS =
  "WPM here is words over WHOLE-FILE duration (edge silence included); the pace bands in audioPace.ts are speech rates, so these figures read slightly slow against them.";

const SOURCE_URL = "https://www.ets.org/content/dam/ets-org/pdfs/toefl/teacher-practice-test-5-audio-files.zip";
const PROFILE_VERSION = "ets-2026-v1";
type Role = "lr-briefing" | "lr-item" | "interview-question";
type ReferenceClip = { sourceUrl: string; profileVersion: "ets-2026-v1"; role: Role; sourceFile: string; wordCount: number; durationSec: number; wpm: number };

/** Teacher Practice Test 5, as unzipped from SOURCE_URL: the gym scenario's directions and seven items, then the four interview questions. */
const PRACTICE_TEST_5: readonly { role: Role; sourceFile: string; wordCount: number }[] = [
  { role: "lr-briefing", sourceFile: "Listen and Repeat/Speaking_Listen_Repeat_Directions.ogg", wordCount: 23 },
  { role: "lr-item", sourceFile: "Listen and Repeat/Speaking_Listen_Repeat_1.ogg", wordCount: 9 },
  { role: "lr-item", sourceFile: "Listen and Repeat/Speaking_Listen_Repeat_2.ogg", wordCount: 8 },
  { role: "lr-item", sourceFile: "Listen and Repeat/Speaking_Listen_Repeat_3.ogg", wordCount: 11 },
  { role: "lr-item", sourceFile: "Listen and Repeat/Speaking_Listen_Repeat_4.ogg", wordCount: 9 },
  { role: "lr-item", sourceFile: "Listen and Repeat/Speaking_Listen_Repeat_5.ogg", wordCount: 9 },
  { role: "lr-item", sourceFile: "Listen and Repeat/Speaking_Listen_Repeat_6.ogg", wordCount: 13 },
  { role: "lr-item", sourceFile: "Listen and Repeat/Speaking_Listen_Repeat_7.ogg", wordCount: 14 },
  { role: "interview-question", sourceFile: "Interview/Speaking_Interview_1.mp4", wordCount: 48 },
  { role: "interview-question", sourceFile: "Interview/Speaking_Interview_2.mp4", wordCount: 20 },
  { role: "interview-question", sourceFile: "Interview/Speaking_Interview_3.mp4", wordCount: 47 },
  { role: "interview-question", sourceFile: "Interview/Speaking_Interview_4.mp4", wordCount: 40 },
];

/** The lesson-plan clips: Speaking_8.1 is the book-shop scenario's directions, 8.2–8.9 its eight items. */
const LESSON_PLAN: readonly { sourceFile: string; wordCount: number }[] =
  [21, 5, 5, 8, 7, 10, 14, 15, 13].map((wordCount, i) => ({ sourceFile: `Speaking_8.${i + 1}.mp3`, wordCount }));

function probe(file: string): number {
  const value = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file], { encoding: "utf8", timeout: MEDIA_TOOL_TIMEOUT_MS, killSignal: "SIGKILL" }).trim());
  if (!Number.isFinite(value) || value <= 0) throw new Error(`invalid duration: ${file}`); return value;
}
/** Exits with status 2, before probing anything, unless every clip is under `audioDir`. */
function requireClips(audioDir: string, sourceFiles: readonly string[], obtainFrom: string): void {
  const missing = sourceFiles.filter((sourceFile) => !fs.existsSync(path.join(audioDir, sourceFile)));
  if (missing.length === 0) return;
  console.error([
    `This script measures ETS's own audio, which is not part of the repository. Missing under ${audioDir}:`,
    ...missing.map((sourceFile) => `  ${sourceFile}`),
    `Get the clips from ${obtainFrom} and pass the directory that holds them as --audio-dir.`,
  ].join("\n"));
  process.exit(2);
}
const { source, audioDir, out, noWrite, force } = parseEtsAuditArgs(process.argv.slice(2));
if (source === "lesson-plan") {
  requireClips(audioDir, LESSON_PLAN.map((c) => c.sourceFile), "ETS's Speaking lesson-plan audio");
  const clips = LESSON_PLAN.map(({ sourceFile, wordCount }) => { const durationSec = probe(path.join(audioDir, sourceFile)); return { sourceFile, wordCount, durationSec, wpm: wordCount / durationSec * 60 }; });
  // 8.1 is the briefing; the eight repeatable items intentionally determine these comparison stats.
  const itemRates = clips.slice(1).map(c => c.wpm); const repeatableItemMedianWpm = median(itemRates); const repeatableItemRangeWpm = { min: Math.min(...itemRates), max: Math.max(...itemRates) };
  console.log(JSON.stringify({ source, clips, repeatableItemMedianWpm, repeatableItemRangeWpm }, null, 2));
  console.log(`Lesson-plan items: ${Math.round(Math.min(...itemRates))}–${Math.round(Math.max(...itemRates))} WPM; median approximately ${Math.round(repeatableItemMedianWpm)}`);
  console.log(DURATION_BASIS); process.exit(0);
}
requireClips(audioDir, PRACTICE_TEST_5.map((c) => c.sourceFile), SOURCE_URL);
const clips: ReferenceClip[] = PRACTICE_TEST_5.map(({ role, sourceFile, wordCount }) => {
  const durationSec = probe(path.join(audioDir, sourceFile));
  return { sourceUrl: SOURCE_URL, profileVersion: PROFILE_VERSION, role, sourceFile, wordCount, durationSec, wpm: wordCount / durationSec * 60 };
});
const result = { clips, groupMedians: { listenAndRepeatItems: median(clips.filter(c => c.role === "lr-item").map(c => c.wpm)), interviewQuestions: median(clips.filter(c => c.role === "interview-question").map(c => c.wpm)) } };
console.log(JSON.stringify(result, null, 2));
const briefing = clips[0].wpm; const lrRates = clips.filter(c => c.role === "lr-item").map(c => c.wpm); const interviewRates = clips.filter(c => c.role === "interview-question").map(c => c.wpm);
console.log(`L&R briefing: approximately ${Math.round(briefing)} WPM`);
console.log(`L&R items: ${Math.round(Math.min(...lrRates))}–${Math.round(Math.max(...lrRates))} WPM; median approximately ${Math.round(result.groupMedians.listenAndRepeatItems)}`);
console.log(`Interview questions: ${Math.round(Math.min(...interviewRates))}–${Math.round(Math.max(...interviewRates))} WPM; median approximately ${Math.round(result.groupMedians.interviewQuestions)}`);
console.log(DURATION_BASIS);
if (!noWrite) { fs.mkdirSync(path.dirname(out!), { recursive: true }); writeAuditOutput(out!, JSON.stringify(result, null, 2) + "\n", force); }
