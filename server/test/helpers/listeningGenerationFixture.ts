import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LISTENING_MODULE_COMPOSITION, ListeningSetSchema, type ListeningSet } from "@toefl-prep/shared";
import { config } from "../../src/lib/config.js";
import { spokenWordCount } from "../../src/services/listeningAudioRenderer.js";
import { TRANSCRIPT_DELIMITER } from "../../src/services/audioPrompt.js";
import { assignSpeakerRendering } from "../../src/services/listeningGenerator.js";
import type { TtsRequest } from "../../src/services/tts.js";

export { routed, skillSuccess } from "./skillResults.js";

// A gate-clean Listening candidate, its plan, and the fake TTS pair that lets `generateSet` render
// it without a network — the same content generator.listening.test.ts builds, for suites that drive
// the verify stage or the whole pipeline from their own file.

/** Exactly n whitespace tokens, each unique to `tag`, so word counts land where a test puts them. */
export function wordsOfLength(n: number, tag: string): string {
  const safeTag = tag.replace(/-/g, "");
  return Array.from({ length: n }, (_, i) => `${safeTag}${i}`).join(" ");
}

export function listeningMcq(id: string, correct: string) {
  return {
    id,
    stem: `Stem for ${id}?`,
    options: [
      { id: "a", text: "Option A" },
      { id: "b", text: "Option B" },
      { id: "c", text: "Option C" },
    ],
    correctOptionId: correct,
    skill: "detail" as const,
    explanationZh: `題目 ${id}:正解說明錄音明確提到的內容;其他選項與內容不符。`,
  };
}

let genderTick = 0;
function nextGender(): "male" | "female" {
  genderTick += 1;
  return genderTick % 2 === 0 ? "male" : "female";
}

function speaker(id: string, role: string, gender: "male" | "female") {
  return { id, role, gender, accent: "north-american" as const, voice: "placeholder", provider: "openai" as const };
}

function lcrEntry(id: string) {
  return {
    id, taskType: "listen_choose" as const,
    audio: "",
    speaker: speaker(`${id}-sp`, "student", nextGender()),
    utterance: "Could you close the door please",
    options: [
      { id: "a", text: "Sure, no problem." },
      { id: "b", text: "It closes at six." },
      { id: "c", text: "I already had one." },
      { id: "d", text: "That sounds delicious." },
    ],
    correctOptionId: "a",
    skill: "function" as const,
    explanationZh: `題目 ${id}:正解說明錄音明確提到請求關門;其他選項與內容不符。`,
  };
}

export function conversationEntry(id: string) {
  return {
    id, taskType: "conversation" as const,
    audio: "",
    setting: "campus dining hall",
    speakers: [speaker(`${id}-sp1`, "student", "male"), speaker(`${id}-sp2`, "cashier", "female")],
    transcript: [
      { speakerId: `${id}-sp1`, text: wordsOfLength(45, `${id}t1w`) },
      { speakerId: `${id}-sp2`, text: wordsOfLength(45, `${id}t2w`) },
    ],
    questions: [listeningMcq(`${id}-q1`, "a"), listeningMcq(`${id}-q2`, "b")],
  };
}

function announcementEntry(id: string) {
  return {
    id, taskType: "announcement" as const,
    audio: "",
    setting: "student union lobby",
    speaker: speaker(`${id}-sp`, "staff member", nextGender()),
    transcript: wordsOfLength(60, `${id}w`),
    questions: [listeningMcq(`${id}-q1`, "c"), listeningMcq(`${id}-q2`, "a")],
  };
}

function academicTalkEntry(id: string) {
  return {
    id, taskType: "academic_talk" as const,
    audio: "",
    discipline: "marine biology",
    speaker: speaker(`${id}-sp`, "professor", nextGender()),
    transcript: wordsOfLength(200, `${id}w`),
    questions: [
      listeningMcq(`${id}-q1`, "b"), listeningMcq(`${id}-q2`, "a"),
      listeningMcq(`${id}-q3`, "c"), listeningMcq(`${id}-q4`, "b"),
    ],
  };
}

function buildModule(moduleName: "router" | "lowerModule" | "upperModule") {
  const counts = LISTENING_MODULE_COMPOSITION[moduleName];
  const prefix = moduleName === "router" ? "r" : moduleName === "lowerModule" ? "lo" : "up";
  const timeLimitSec = moduleName === "router" ? 1080 : moduleName === "lowerModule" ? 420 : 660;
  return {
    timeLimitSec,
    listenChoose: Array.from({ length: counts.listenChoose }, (_, i) => lcrEntry(`lcr-${prefix}${i + 1}`)),
    conversations: Array.from({ length: counts.conversations }, (_, i) => conversationEntry(`conv-${prefix}${i + 1}`)),
    announcements: Array.from({ length: counts.announcements }, (_, i) => announcementEntry(`ann-${prefix}${i + 1}`)),
    academicTalks: Array.from({ length: counts.academicTalks }, (_, i) => academicTalkEntry(`talk-${prefix}${i + 1}`)),
  };
}

export function buildListeningCandidate() {
  genderTick = 0;
  return {
    id: "seed-candidate",
    kind: "listening" as const,
    source: "generated" as const,
    createdAt: "2026-08-10T00:00:00.000Z",
    router: buildModule("router"),
    lowerModule: buildModule("lowerModule"),
    upperModule: buildModule("upperModule"),
  };
}

function planBase(slug: string, concepts: readonly string[]) {
  return { noveltyKey: `plan-${slug}`, requiredConcepts: [...concepts], distinguishesFrom: [] };
}

export function buildListeningPlan() {
  return {
    version: "cross-set-diversity-v1" as const,
    kind: "listening" as const,
    listenChoose: Array.from({ length: 20 }, () => ({
      ...planBase("lcr", ["close the door", "student"]),
      domain: "campus-academics" as const,
      topic: "a student asking a classmate to close the door",
      speakerRole: "student",
    })),
    conversations: Array.from({ length: 7 }, () => ({
      ...planBase("conv", ["campus dining hall", "student"]),
      domain: "campus-academics" as const,
      setting: "campus dining hall",
      speakerRoles: ["student", "cashier"] as [string, string],
    })),
    announcements: Array.from({ length: 5 }, () => ({
      ...planBase("ann", ["student union lobby", "staff member"]),
      domain: "campus-academics" as const,
      setting: "student union lobby",
      speakerRole: "staff member",
    })),
    academicTalks: Array.from({ length: 4 }, () => ({
      ...planBase("talk", ["marine biology", "professor"]),
      domain: "science-environment" as const,
      discipline: "marine biology",
      speakerRole: "professor",
    })),
  };
}

/** The candidate as verifyListeningSet receives it: speakers rendered, plan attached, not yet voiced. */
export function listeningSetForVerify(): ListeningSet {
  return ListeningSetSchema.parse({
    ...assignSpeakerRendering(buildListeningCandidate() as never),
    id: "lsn-fixture1",
    generationPlan: buildListeningPlan(),
  });
}

export type ListeningVerifyPayload = {
  listenChooseItems: { id: string }[];
  stimuli: { id: string; taskType: string; transcript: unknown }[];
  questions: { id: string; stimulusId: string }[];
};

export function listeningVerifyPayload(prompt: string): ListeningVerifyPayload {
  const match = /```json\n([\s\S]*?)\n```/.exec(prompt);
  if (!match) throw new Error("fixture error: verify prompt is missing its ```json fence");
  return JSON.parse(match[1]!) as ListeningVerifyPayload;
}

export function allOkListeningVerdict(prompt: string) {
  const payload = listeningVerifyPayload(prompt);
  return {
    listenChooseItems: payload.listenChooseItems.map((i) => ({ id: i.id, verdict: "ok" as const })),
    stimuli: payload.stimuli.map((s) => ({ id: s.id, verdict: "ok" as const })),
    questions: payload.questions.map((q) => ({ id: q.id, verdict: "ok" as const })),
  };
}

export function listeningDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "generation-listening-"));
  fs.mkdirSync(path.join(dir, "question-sets/listening"), { recursive: true });
  return dir;
}

export function publishedListeningSetPath(setId: string): string {
  return path.join(config.dataDir, "question-sets/listening", `${setId}.json`);
}

export function cleanupListeningArtifacts(setId: string): void {
  fs.rmSync(publishedListeningSetPath(setId), { force: true });
  fs.rmSync(path.join(config.dataDir, "audio/stimuli", setId), { recursive: true, force: true });
}

/** Every published Listening Set id in this test file's data dir right now. */
export function publishedListeningSetIds(): Set<string> {
  const dir = path.join(config.dataDir, "question-sets/listening");
  if (!fs.existsSync(dir)) return new Set();
  return new Set(fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)));
}

// A rate inside every Listening role's pace band at once, so one fake pair passes every clip.
const TARGET_WPM = 152;

export function fakeSynthesize(req: TtsRequest, outPath: string): Promise<void> {
  const marker = req.text.indexOf(TRANSCRIPT_DELIMITER);
  if (marker === -1) throw new Error("fixture error: synthesis prompt is missing its transcript delimiter");
  const words = spokenWordCount(req.text.slice(marker + TRANSCRIPT_DELIMITER.length), req.speakers);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, String((words / TARGET_WPM) * 60));
  return Promise.resolve();
}

export function fakeProbeDuration(filePath: string): Promise<number> {
  return Promise.resolve(Number(fs.readFileSync(filePath, "utf8")));
}
