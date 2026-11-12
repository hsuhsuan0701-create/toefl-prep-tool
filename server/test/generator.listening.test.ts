import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { skillSuccess } from "./helpers/skillResults.js";
import { readBankSet } from "./helpers/setFixtures.js";
import { AnySetSchema, LISTENING_MODULE_COMPOSITION, type ListeningModule, type ListeningSet } from "@toefl-prep/shared";
import { generateSet, type GenerationProgress } from "../src/services/generator.js";
import { createGenerationPlanner } from "../src/services/generationPlanner.js";
import { config } from "../src/lib/config.js";
import {
  assignSpeakerRendering,
  deterministicListeningPreChecks,
  LISTENING_MODULE_NAMES,
  LISTENING_UPPER_MODULE_DIRECTION,
  listeningContentViolations,
  listeningGenerationPrompt,
  rebalanceListeningOptionOrder,
  verifyListeningSet,
  type ListeningContentViolation,
  type SafeDiagnostic,
} from "../src/services/listeningGenerator.js";
import { UPPER_MODULE_HARDER_RETRY } from "../src/services/moduleDifficulty.js";
import { MAX_VERIFY_ATTEMPTS } from "../src/services/generationVerifyLoop.js";
import { spokenWordCount } from "../src/services/listeningAudioRenderer.js";
import { countEnglishWords } from "../src/services/audioPace.js";
import { TRANSCRIPT_DELIMITER } from "../src/services/audioPrompt.js";
import { GEMINI_VOICE_POOL_NAMES, GEMINI_VOICE_POOLS, type GeminiVoicePool } from "../src/services/geminiVoices.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import type { TtsRequest } from "../src/services/tts.js";

// Listening's content gate records its advisory-tier findings on the published Set, as Reading's
// does. No Listening content-gate kind has the plain `advisory` tier (each remediable kind is
// `repair-then-accept`), so the seam is exercised by overriding one kind's tier for one test. That
// is the promise ADR 0006 makes, that a tier change is one edit in one file; without the seam an
// advisory-tier finding would burn the whole verify budget, fail the job and record nothing.
//
// The override is inert for every other test in this file: `advisoryListeningKinds` is empty, so
// every classification delegates to the real policy.
const policyOverride = vi.hoisted(() => ({ advisoryListeningKinds: new Set<string>() }));
vi.mock("../src/services/generationCheckPolicy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/generationCheckPolicy.js")>();
  return {
    ...actual,
    classifyGenerationCheck: (check: Parameters<typeof actual.classifyGenerationCheck>[0]) =>
      check.family === "content-gate" && check.section === "listening"
        && policyOverride.advisoryListeningKinds.has(check.kind)
        ? { tier: "advisory" as const }
        : actual.classifyGenerationCheck(check),
  };
});

// Which duration Listening's render measures is pinned: `LISTENING_ROLE_POLICY`'s numbers are
// stated on the speech scale (silence at either end excluded), and reading them against file
// duration would misjudge every clip. Every other test in this file injects `probeDuration`
// explicitly, so these two spies are never called by them; they exist for the one test below that
// omits the injection and watches which default fires.
const transcodeSpies = vi.hoisted(() => {
  const readEncodedDuration = async (filePath: string): Promise<number> =>
    Number((await import("node:fs")).readFileSync(filePath, "utf8"));
  return {
    probeSpeechDurationSec: vi.fn(readEncodedDuration),
    probeDurationSec: vi.fn(readEncodedDuration),
  };
});
vi.mock("../src/services/transcode.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/transcode.js")>()),
  ...transcodeSpies,
}));

// Mirrors reasoning/skillContext.ts's SOURCE_PATHS registration for the three Listening task keys,
// as generator.reading.test.ts's block does for Reading: if either skill file goes missing or is
// moved, every real (non-fake-runner) Listening plan/generate/verify call fails at
// composeCapturedCodexSkillPrompt's readSource with ENOENT, and no other test here would catch it.
const LISTENING_SOURCE_PATHS: Readonly<Record<"plan:listening" | "generate:listening" | "verify:listening", readonly string[]>> = {
  "plan:listening": [
    ".claude/skills/toefl-listening/SKILL.md",
    ".claude/skills/toefl-listening/references/generation-guide.md",
  ],
  "generate:listening": [
    ".claude/skills/toefl-listening/SKILL.md",
    ".claude/skills/toefl-listening/references/generation-guide.md",
  ],
  "verify:listening": [
    ".claude/skills/toefl-listening/SKILL.md",
    ".claude/skills/toefl-listening/references/generation-guide.md",
  ],
};

describe("toefl-listening skill SOURCE_PATHS", () => {
  for (const [key, relativePaths] of Object.entries(LISTENING_SOURCE_PATHS)) {
    for (const relativePath of relativePaths) {
      it(`${key} source "${relativePath}" exists on disk`, () => {
        const absolutePath = path.join(config.projectRoot, relativePath);
        expect(fs.existsSync(absolutePath), `expected ${absolutePath} to exist`).toBe(true);
      });
    }
  }
});

// `listeningFailure` is the only place in listeningGenerator.ts allowed to construct an Error, so no
// thrown message can be built from unbranded (model-authored) text. The SafeDiagnostic type tests
// further down pin the branding; `listeningFailure` itself is not exported, so no behavioural test
// can reach it, and a source-text assertion pins it instead. Comment lines are excluded: the file
// documents the invariant in prose above the function, and those mentions are not construction
// sites.
describe("listeningGenerator.ts constructs Errors in exactly one place", () => {
  const source = fs.readFileSync(path.join(config.projectRoot, "server/src/services/listeningGenerator.ts"), "utf8");

  it("has exactly one non-comment `new Error(` — the one inside listeningFailure", () => {
    const constructions = source
      .split("\n")
      .filter((line) => line.includes("new Error(") && !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"));
    expect(constructions).toHaveLength(1);
    expect(constructions[0]).toContain("parts.join(");
  });
});

// SKILL.md is the model-visible contract for the GENERATE sub-calls, so it must describe the payloads
// they send: explanationRewritePrompt's `reason` (too long, or missing 繁體中文) and
// stimulusRegenerationPrompt's triggers, word count and transcript language among them. A payload
// change not mirrored into the skill file fails here.
describe("toefl-listening SKILL.md matches the actual GENERATE sub-call payloads", () => {
  const skillMd = fs.readFileSync(path.join(config.projectRoot, ".claude/skills/toefl-listening/SKILL.md"), "utf8");

  it("never mentions an `actualLength` field, which the explanation-rewrite payload does not send", () => {
    expect(skillMd).not.toContain("actualLength");
  });

  it("describes the explanation-rewrite sub-call's actual `reason`/`targetZh` fields, covering both a length trigger and a language trigger", () => {
    expect(skillMd).toContain("`reason`");
    expect(skillMd).toContain("targetZh");
    expect(skillMd.toLowerCase()).toContain("missing 繁體中文".toLowerCase());
  });

  it("describes Stimulus regeneration's unanswerable, word-count and wrong-language triggers", () => {
    const stimulusBullet = /\*\*Stimulus transcript regeneration\*\*[\s\S]*?(?=\n- \*\*|\n##)/.exec(skillMd)?.[0];
    expect(stimulusBullet, "expected to find the Stimulus transcript regeneration bullet").toBeDefined();
    expect(stimulusBullet).toContain("unanswerable");
    expect(stimulusBullet).toContain("word count");
    expect(stimulusBullet).toContain("wrong language");
  });

  it("never claims Stimulus transcript regeneration handles plan-conformance drift", () => {
    const stimulusBullet = /\*\*Stimulus transcript regeneration\*\*[\s\S]*?(?=\n- \*\*|\n##)/.exec(skillMd)?.[0];
    expect(stimulusBullet, "expected to find the Stimulus transcript regeneration bullet").toBeDefined();
    expect(stimulusBullet).not.toContain("drifted from its accepted plan entry");
  });
});

// assignSpeakerRendering assigns the gender of every Listen and Choose a Response, Announcement and
// Academic Talk speaker. A skill file that told the model to pick or balance gender could lead it
// to write gender-dependent content (a self-introduction by a gendered name) that the server then
// gives a contradicting voice. Pinned at text level: the model-visible contract must match
// assignSpeakerRendering's ownership split.
describe("toefl-listening gender contract matches assignSpeakerRendering", () => {
  const skillMd = fs.readFileSync(path.join(config.projectRoot, ".claude/skills/toefl-listening/SKILL.md"), "utf8");
  const guideMd = fs.readFileSync(path.join(config.projectRoot, ".claude/skills/toefl-listening/references/generation-guide.md"), "utf8");

  it("never tells the model to pick or balance gender for LCR/Announcement/Academic Talk speakers", () => {
    for (const doc of [skillMd, guideMd]) {
      expect(doc).not.toContain("pick whichever gender fits the role naturally");
      expect(doc).not.toMatch(/gender is yours to balance(?! ONLY)/);
    }
  });

  it("states gender is server-owned for the three single-speaker shapes, mirroring accent/voice/provider", () => {
    for (const doc of [skillMd, guideMd]) {
      expect(doc).toContain("server-owned");
      expect(doc.toLowerCase()).toContain("gender");
    }
  });

  it("tells the model never to let single-speaker content depend on the speaker's gender", () => {
    for (const doc of [skillMd, guideMd]) {
      expect(doc.toLowerCase()).toMatch(/never let.*gender|depend on.*gender/s);
    }
  });

  it("still treats a Conversation's gender pairing as the model's own, schema-enforced choice", () => {
    for (const doc of [skillMd, guideMd]) {
      expect(doc).toMatch(/one male and one female/);
    }
  });

  // Accent is server-owned for every Stimulus shape: assignSpeakerRendering's nextAccent()
  // overwrites it unconditionally for Listen and Choose a Response, Conversations, Announcements and
  // Academic Talks, as it does voice and provider. Both skill files must say so, and neither may
  // tell the model accent is its to vary, or the files would contradict the code and each other.
  it("states accent is server-owned for every Stimulus shape, in both files, with no contradicting 'yours to vary' claim anywhere", () => {
    for (const doc of [skillMd, guideMd]) {
      expect(doc).not.toMatch(/accent (is|stays) yours to vary/);
      expect(doc.toLowerCase()).toMatch(/accent[^.]*server-owned|server-owned[^.]*accent/s);
    }
  });
});

// The Listening generation guide carries the official difficulty specification: the per-task CEFR
// targets, the levers that make an upper module harder, and what an Academic Talk's language has to
// be.
//
// The target/gate split is what these tests protect. CEFR letters are ETS's own published targets
// and are model-visible; the numbers the checks use (LCR_MAX_ESTIMATED_SYLLABLES, the *_WORD_RANGE
// gate bounds, moduleDifficulty's Flesch-Kincaid index) are gate-only, for the reason
// UPPER_MODULE_HARDER_RETRY's doc comment states: "a model shown the number optimises the number".
// An edit that pastes a tolerance into this section fails here rather than teaching the model to
// game an index.
describe("toefl-listening generation guide: difficulty section", () => {
  const guideMd = fs.readFileSync(
    path.join(config.projectRoot, ".claude/skills/toefl-listening/references/generation-guide.md"),
    "utf8",
  );
  // Up to the next `##` heading — the `###` subsection on Academic Talks is deliberately inside it.
  const section = /\n## Difficulty:[\s\S]*?(?=\n## )/.exec(guideMd)?.[0];

  it("exists at all", () => {
    expect(section, "expected a '## Difficulty:' section in the listening generation guide").toBeDefined();
  });

  it("states the blueprint's per-task CEFR targets, all four", () => {
    expect(section).toContain("Listen and Choose a Response | A1–B2");
    expect(section).toContain("Listen to a Conversation | A2–C1");
    expect(section).toContain("Listen to an Announcement | A2–C1");
    expect(section).toContain("Listen to an Academic Talk | A2–C2");
  });

  it("states the Academic Talk vocabulary requirement and both named rhetorical patterns", () => {
    expect(section).toContain("uncommon, colloquial, or idiomatic");
    expect(section).toContain("compare/contrast");
    expect(section).toContain("cause–effect");
  });

  it("gives concrete upper-vs-lower levers, not just the name of the property", () => {
    for (const lever of ["Sentence length", "Information density", "Vocabulary", "Abstractness"]) {
      expect(section).toContain(lever);
    }
    // The one lever it must rule out: length is fixed per Task Type by the word targets, so a model
    // that "makes the upper module harder" by writing longer scripts trips a word-count violation
    // instead.
    expect(section).toContain("Length is not the lever");
  });

  it("carries no gate number: CEFR labels and the ETS report number are the only digits in it", () => {
    // Both exempt kinds are identifiers, not quantities a model could aim at: "A2–C1" is ETS's own
    // published target for the task, and "RR-25-12" is the Technical Manual's report number, cited so
    // the requirement is traceable. Everything else that could be a digit here would be a tolerance.
    const withoutLabels = section!.replace(/[ABC][12]/gu, "").replace(/RR-\d+-\d+/gu, "");
    expect(withoutLabels).not.toMatch(/\d/u);
    for (const gateWord of ["flesch", "kincaid", "grade", "syllable", "readability"]) {
      expect(section!.toLowerCase()).not.toContain(gateWord);
    }
  });
});

// The harder-upper direction rides on the base GENERATE prompt, so the model is told the property
// before the first paid candidate. UPPER_MODULE_HARDER_RETRY is added on top only once the relative
// gate has rejected one.
describe("listeningGenerationPrompt: the harder-upper direction is on the first prompt", () => {
  it("carries the direction on the BASE prompt, with no retry wording", () => {
    const prompt = listeningGenerationPrompt(buildPlan());
    expect(prompt).toContain(LISTENING_UPPER_MODULE_DIRECTION);
    expect(prompt).not.toContain("A previous attempt");
  });

  it("still adds the retry escalation on top once the gate has actually failed", () => {
    const prompt = listeningGenerationPrompt(buildPlan(), true);
    expect(prompt).toContain(LISTENING_UPPER_MODULE_DIRECTION);
    expect(prompt).toContain(UPPER_MODULE_HARDER_RETRY);
  });

  it("shows the model no number it could optimise instead of the prose", () => {
    expect(LISTENING_UPPER_MODULE_DIRECTION).not.toMatch(/\d/u);
    for (const gateWord of ["grade", "syllable", "flesch", "kincaid"]) {
      expect(LISTENING_UPPER_MODULE_DIRECTION.toLowerCase()).not.toContain(gateWord);
    }
  });
});

function emitRunning(request: SkillTaskRequest<unknown>): void {
  request.onEvent?.({ state: "running", provider: "claude" });
}

// Candidate content: canned text stamped onto every entry of a Stimulus shape, as in the Reading
// tests, so word counts are controlled rather than hand-counted. wordsOfLength produces exactly n
// whitespace-separated tokens, so the content gate's word-count checks land inside range without
// approximation.

// Hyphens are not part of the novelty token class (noveltySimilarity.ts's rawTokens splits on
// anything outside \p{L}\p{N}), so a tag built from a hyphenated Stimulus id ("ann-r1") would leak
// its suffix as a bare token ("r1w0", "r1w1", ...) shared by every entry at the same module-array
// position: a `talk-r1` and an `ann-r1` would both produce "r1w0".."r1w59" and collide as
// cross-shape containment. Stripping hyphens keeps every filler token a single unique run.
function wordsOfLength(n: number, tag: string): string {
  const safeTag = tag.replace(/-/g, "");
  return Array.from({ length: n }, (_, i) => `${safeTag}${i}`).join(" ");
}

const LCR_UTTERANCE = "Could you close the door please";

function mcq(id: string, correct: string) {
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
    // Names no option by its label: the position rule forbids that, and the option-order rebalance
    // would make it false.
    explanationZh: `題目 ${id}:正解說明錄音明確提到的內容;其他選項與內容不符。`,
  };
}

let genderTick = 0;
function nextGender(): "male" | "female" {
  genderTick += 1;
  return genderTick % 2 === 0 ? "male" : "female";
}

function speaker(id: string, role: string, gender: "male" | "female") {
  return {
    id, role, gender,
    accent: "north-american" as const,
    voice: "placeholder",
    provider: "openai" as const,
  };
}

function lcrEntry(id: string) {
  return {
    id, taskType: "listen_choose" as const,
    audio: "",
    speaker: speaker(`${id}-sp`, "student", nextGender()),
    utterance: LCR_UTTERANCE,
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

function conversationEntry(id: string) {
  return {
    id, taskType: "conversation" as const,
    audio: "",
    setting: "campus dining hall",
    speakers: [
      speaker(`${id}-sp1`, "student", "male" as const),
      speaker(`${id}-sp2`, "cashier", "female" as const),
    ] as [ReturnType<typeof speaker>, ReturnType<typeof speaker>],
    transcript: [
      { speakerId: `${id}-sp1`, text: wordsOfLength(45, `${id}t1w`) },
      { speakerId: `${id}-sp2`, text: wordsOfLength(45, `${id}t2w`) },
    ],
    questions: [mcq(`${id}-q1`, "a"), mcq(`${id}-q2`, "b")],
  };
}

function announcementEntry(id: string) {
  return {
    id, taskType: "announcement" as const,
    audio: "",
    setting: "student union lobby",
    speaker: speaker(`${id}-sp`, "staff member", nextGender()),
    transcript: wordsOfLength(60, `${id}w`),
    questions: [mcq(`${id}-q1`, "c"), mcq(`${id}-q2`, "a")],
  };
}

function academicTalkEntry(id: string) {
  return {
    id, taskType: "academic_talk" as const,
    audio: "",
    discipline: "marine biology",
    speaker: speaker(`${id}-sp`, "professor", nextGender()),
    transcript: wordsOfLength(200, `${id}w`), // mid-band of ACADEMIC_TALK_WORD_RANGE's 175-250
    questions: [mcq(`${id}-q1`, "b"), mcq(`${id}-q2`, "a"), mcq(`${id}-q3`, "c"), mcq(`${id}-q4`, "b")],
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

function buildCandidate() {
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

// Plan content: domains chosen so plannedDomainDrift's keyword classification of the Plan's prose
// agrees with the declared domain exactly ("campus"/"student" hit campus-academics; "biology" hits
// science-environment). requiredConcepts are literal substrings of the matching candidate content
// above. Nothing checks that relationship against the candidate; the fixtures keep it so this file
// stays a realistic example of well-formed candidate content.

function planEntryBase(slug: string, concepts: readonly string[]) {
  return {
    noveltyKey: `plan-${slug}`,
    // Copied, not aliased: `ListeningGenerationPlan` types this mutable, and the prompt tests above
    // hand a fixture plan straight to `listeningGenerationPrompt` rather than through a
    // `parse(value: unknown)` boundary that would erase the difference.
    requiredConcepts: [...concepts],
    distinguishesFrom: [],
  };
}

function lcrPlanEntry() {
  return {
    ...planEntryBase("lcr", ["close the door", "student"]),
    domain: "campus-academics" as const,
    topic: "a student asking a classmate to close the door",
    speakerRole: "student",
  };
}

function conversationPlanEntry() {
  return {
    ...planEntryBase("conv", ["campus dining hall", "student"]),
    domain: "campus-academics" as const,
    setting: "campus dining hall",
    speakerRoles: ["student", "cashier"] as [string, string],
  };
}

function announcementPlanEntry() {
  return {
    ...planEntryBase("ann", ["student union lobby", "staff member"]),
    domain: "campus-academics" as const,
    setting: "student union lobby",
    speakerRole: "staff member",
  };
}

function academicTalkPlanEntry() {
  return {
    ...planEntryBase("talk", ["marine biology", "professor"]),
    domain: "science-environment" as const,
    discipline: "marine biology",
    speakerRole: "professor",
  };
}

function buildPlan() {
  return {
    version: "cross-set-diversity-v1" as const,
    kind: "listening" as const,
    listenChoose: Array.from({ length: 20 }, () => lcrPlanEntry()),
    conversations: Array.from({ length: 7 }, () => conversationPlanEntry()),
    announcements: Array.from({ length: 5 }, () => announcementPlanEntry()),
    academicTalks: Array.from({ length: 4 }, () => academicTalkPlanEntry()),
  };
}

function allOkVerifyResponse(prompt: string) {
  const match = /```json\n([\s\S]*?)\n```/.exec(prompt);
  if (!match) throw new Error("fixture error: verify prompt is missing its ```json fence");
  const payload = JSON.parse(match[1]!) as {
    listenChooseItems: { id: string }[];
    stimuli: { id: string }[];
    questions: { id: string }[];
  };
  return {
    listenChooseItems: payload.listenChooseItems.map((i) => ({ id: i.id, verdict: "ok" as const })),
    stimuli: payload.stimuli.map((s) => ({ id: s.id, verdict: "ok" as const })),
    questions: payload.questions.map((q) => ({ id: q.id, verdict: "ok" as const })),
  };
}

function listeningDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "generation-listening-"));
  fs.mkdirSync(path.join(dir, "question-sets/listening"), { recursive: true });
  return dir;
}

function publishedSetPath(setId: string): string {
  return path.join(config.dataDir, "question-sets/listening", `${setId}.json`);
}

function audioDirPath(setId: string): string {
  return path.join(config.dataDir, "audio/stimuli", setId);
}

function cleanupSetArtifacts(setId: string): void {
  fs.rmSync(publishedSetPath(setId), { force: true });
  fs.rmSync(audioDirPath(setId), { recursive: true, force: true });
}

function assertStageOrder(stages: readonly string[]): void {
  const order = ["planning", "generating", "verifying", "rendering-audio", "saving"];
  let lastIndex = -1;
  for (const stage of order) {
    const index = stages.indexOf(stage);
    expect(index, `expected stage "${stage}" to appear in ${JSON.stringify(stages)}`).toBeGreaterThan(-1);
    expect(index).toBeGreaterThan(lastIndex);
    lastIndex = index;
  }
}

// TARGET_WPM sits inside every LISTENING_ROLE_POLICY band at once (lcr-utterance 135-205,
// conversation 150-175, announcement 140-160, academic-talk 140-155; intersection 150-155), so one
// fake pair can pass every role's pace check without knowing which role a given clip belongs to.
// Durations are encoded directly as the clip file's own content (a plain numeric string) rather
// than derived by the prober, so probeDuration reports exactly what synthesize decided.
const TARGET_WPM = 152;

// The renderer sends audioPrompt's full Audio Profile / Scene / Director's Notes prompt as `text`,
// so a fake that counted the whole request would measure the direction as if it were speech and
// push every clip past the sanity band. Count what the renderer itself counts: the spoken words
// after the transcript delimiter, minus a multi-speaker transcript's `Label:` prefixes.
function fakeSynthesize(req: TtsRequest, outPath: string): Promise<void> {
  const marker = req.text.indexOf(TRANSCRIPT_DELIMITER);
  if (marker === -1) throw new Error("fixture error: synthesis prompt is missing its transcript delimiter");
  const words = spokenWordCount(req.text.slice(marker + TRANSCRIPT_DELIMITER.length), req.speakers);
  const durationSec = (words / TARGET_WPM) * 60;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, String(durationSec));
  return Promise.resolve();
}

function fakeProbeDuration(filePath: string): Promise<number> {
  return Promise.resolve(Number(fs.readFileSync(filePath, "utf8")));
}

function buildRunSkillTask(plan: ReturnType<typeof buildPlan>, candidate: ReturnType<typeof buildCandidate>) {
  return vi.fn(async (request: SkillTaskRequest<unknown>) => {
    emitRunning(request);
    if (request.task.task === "plan") {
      return skillSuccess(request.parse(plan));
    }
    if (request.task.task === "generate") {
      if (request.prompt.includes("```accepted-plan-json")) {
        return skillSuccess(request.parse(candidate));
      }
      throw new Error(`unexpected generate:listening call:\n${request.prompt.slice(0, 200)}`);
    }
    return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
  });
}

describe("generateSet (listening)", () => {
  it("publishes a listening set end to end: plan -> generate -> verify -> render audio -> publish", async () => {
    const dataDir = listeningDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    const tasks: string[] = [];
    const stages: string[] = [];
    let renderCalls = 0;

    const runSkillTask = buildRunSkillTask(plan, candidate);
    const wrappedRunSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      tasks.push(`${request.task.task}:${request.task.context}`);
      return runSkillTask(request);
    });

    const progress: GenerationProgress[] = [];
    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet(
        "listening",
        {
          runSkillTask: wrappedRunSkillTask as never,
          planner,
          tts: (req, outPath) => {
            renderCalls += 1;
            return fakeSynthesize(req, outPath);
          },
          probeDuration: fakeProbeDuration,
        },
        (event) => {
          progress.push(event);
          stages.push(event.stage);
        },
      );
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(setId).toMatch(/^lsn-[0-9a-f]{8}$/);
      const publishedPath = publishedSetPath(setId);
      expect(fs.existsSync(publishedPath)).toBe(true);
      const published: unknown = JSON.parse(fs.readFileSync(publishedPath, "utf8"));
      const parsed = AnySetSchema.parse(published);
      expect(parsed.kind).toBe("listening");
      if (parsed.kind !== "listening") throw new Error("unreachable");
      expect(parsed.generationPlan).toBeDefined();
      expect(parsed.audioProfile).toBeDefined();

      // Every module's composition matches LISTENING_MODULE_COMPOSITION exactly.
      for (const moduleName of ["router", "lowerModule", "upperModule"] as const) {
        const module: ListeningModule = parsed[moduleName];
        const expected = LISTENING_MODULE_COMPOSITION[moduleName];
        expect(module.listenChoose).toHaveLength(expected.listenChoose);
        expect(module.conversations).toHaveLength(expected.conversations);
        expect(module.announcements).toHaveLength(expected.announcements);
        expect(module.academicTalks).toHaveLength(expected.academicTalks);
      }

      // Audio paths were filled in by the renderer (never "" post-publish) and the render actually
      // ran (renderListeningAudio calling deps.tts, injected as `tts` above).
      expect(renderCalls).toBeGreaterThan(0);
      const firstLcr = parsed.router.listenChoose[0]!;
      expect(firstLcr.audio).toBe(`stimuli/${setId}/${firstLcr.id}.mp3`);
      // The public `audio` field is "stimuli/<setId>/..." (no "audio/" prefix — same convention as
      // Speaking's audioPathPrefix); the real file lives one level up, under "audio/".
      expect(fs.existsSync(path.join(config.dataDir, "audio", firstLcr.audio))).toBe(true);
      const firstConversation = parsed.router.conversations[0]!;
      expect(firstConversation.audio).toBe(`stimuli/${setId}/${firstConversation.id}.mp3`);
      expect(fs.existsSync(path.join(config.dataDir, "audio", firstConversation.audio))).toBe(true);
      // A Conversation renders as one clip, so no per-turn file exists to allow turn-by-turn replay.
      expect(fs.existsSync(path.join(config.dataDir, "audio/stimuli", setId, `${firstConversation.id}-turn1.mp3`))).toBe(false);

      // Speaker rendering is assigned by the server: none of the fixture's "placeholder" values
      // survives into the published Set, and every Speaker gets a Gemini voice from the cast pools.
      expect(firstLcr.speaker.voice).not.toBe("placeholder");
      expect(firstLcr.speaker.provider).toBe("gemini");
      const allCastVoices = GEMINI_VOICE_POOL_NAMES.flatMap((pool) => [
        ...GEMINI_VOICE_POOLS[pool].female,
        ...GEMINI_VOICE_POOLS[pool].male,
      ]);
      expect(allCastVoices).toContain(firstLcr.speaker.voice);

      assertStageOrder(stages);
      expect(tasks[0]).toBe("plan:listening");
      expect(tasks).toContain("generate:listening");
      expect(tasks).toContain("verify:listening");

      fs.rmSync(publishedPath);
      fs.rmSync(audioDirPath(setId), { recursive: true, force: true });
    } catch (err) {
      cleanupSetArtifacts(setId!);
      throw err;
    }
  }, 30_000);

  // A candidate entry whose content contradicts its planned domain is recorded on the Set where it
  // is found, and the candidate publishes as it stands: no repair call, no second attempt.
  it("records a domain-drifted LCR entry as a plan-conformance note and publishes the first candidate unchanged", async () => {
    const dataDir = listeningDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();

    // Router's last LCR slot is global itemPosition 9. The utterance carries two services-travel
    // keywords, and neither it nor the speaker's role carries a campus-academics keyword,
    // contradicting the plan's declared domain.
    const driftedId = candidate.router.listenChoose[9]!.id;
    candidate.router.listenChoose[9] = {
      ...candidate.router.listenChoose[9]!,
      speaker: { ...candidate.router.listenChoose[9]!.speaker, role: "commuter" },
      utterance: "Could you find the bus station please",
      explanationZh: "說話者詢問公車站的位置,回答對方要找的地點是合理的回應;其餘回應與詢問無關。",
    };

    let candidateGenerateCalls = 0;
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") {
        return skillSuccess(request.parse(plan));
      }
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) {
          candidateGenerateCalls += 1;
          return skillSuccess(request.parse(candidate));
        }
        throw new Error(`unexpected generate:listening call:\n${request.prompt.slice(0, 200)}`);
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet(
        "listening",
        {
          runSkillTask: runSkillTask as never,
          planner,
          tts: fakeSynthesize,
          probeDuration: fakeProbeDuration,
        },
      );
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(candidateGenerateCalls).toBe(1);
      const parsed = AnySetSchema.parse(JSON.parse(fs.readFileSync(publishedSetPath(setId), "utf8")));
      if (parsed.kind !== "listening") throw new Error("unreachable");
      expect(parsed.router.listenChoose.find((item) => item.id === driftedId)!.utterance)
        .toBe("Could you find the bus station please");
      expect(parsed.advisoryNotes).toContainEqual({
        check: "plan-conformance",
        detail: "domain-drift",
        taskType: "listen_choose",
        itemPosition: 9,
      });
      cleanupSetArtifacts(setId);
    } catch (err) {
      cleanupSetArtifacts(setId!);
      throw err;
    }
  }, 30_000);

  // A word-count violation is remediable: a Conversation transcript a few words short of
  // CONVERSATION_WORD_RANGE.min (80) is repaired by a targeted whole-Stimulus regeneration inside
  // verify, so a long run is not discarded at the last gate before publish.
  it("repairs a Conversation transcript short of its word-count floor via remediation, instead of hard-failing the gate", async () => {
    const dataDir = listeningDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();

    const shortId = candidate.router.conversations[0]!.id;
    candidate.router.conversations[0] = {
      ...candidate.router.conversations[0]!,
      transcript: [
        { speakerId: `${shortId}-sp1`, text: wordsOfLength(38, `${shortId}shortt1w`) },
        { speakerId: `${shortId}-sp2`, text: wordsOfLength(39, `${shortId}shortt2w`) },
      ], // 77 words total, three short of CONVERSATION_WORD_RANGE.min (80).
    };

    let stimulusRepairCalls = 0;
    let verifyCalls = 0;
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") return skillSuccess(request.parse(plan));
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) return skillSuccess(request.parse(candidate));
        if (request.prompt.includes("```stimulus-regeneration")) {
          stimulusRepairCalls += 1;
          const payload = JSON.parse(/```stimulus-regeneration\n([\s\S]*?)\n```/.exec(request.prompt)![1]!) as { stimulusId: string; reason: string };
          expect(payload.stimulusId).toBe(shortId);
          expect(payload.reason).toContain("100 and 130 words");
          return skillSuccess(request.parse({
            transcript: [
              { speakerId: `${shortId}-sp1`, text: wordsOfLength(50, `${shortId}fixedt1w`) },
              { speakerId: `${shortId}-sp2`, text: wordsOfLength(50, `${shortId}fixedt2w`) },
            ],
            questions: [mcq(`${shortId}-q1`, "a"), mcq(`${shortId}-q2`, "b")],
          }));
        }
        throw new Error(`unexpected generate:listening call:\n${request.prompt.slice(0, 200)}`);
      }
      verifyCalls += 1;
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("listening", {
        runSkillTask: runSkillTask as never, planner,
        tts: fakeSynthesize, probeDuration: fakeProbeDuration,
      });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(stimulusRepairCalls).toBe(1);
      expect(verifyCalls).toBeGreaterThanOrEqual(2); // the round that found the violation, plus the clean re-check

      const published: unknown = JSON.parse(fs.readFileSync(publishedSetPath(setId), "utf8"));
      const parsed = AnySetSchema.parse(published);
      expect(parsed.kind).toBe("listening");
      if (parsed.kind !== "listening") throw new Error("unreachable");
      const repaired = parsed.router.conversations.find((c) => c.id === shortId)!;
      const words = repaired.transcript.reduce((sum, turn) => sum + countEnglishWords(turn.text), 0);
      expect(words).toBeGreaterThanOrEqual(80);
      expect(words).toBeLessThanOrEqual(150);

      cleanupSetArtifacts(setId);
    } catch (err) {
      cleanupSetArtifacts(setId!);
      throw err;
    }
  }, 30_000);

  // The Verifier must receive every Stimulus's transcript, or it cannot ground an "unanswerable"
  // verdict in what the audio says. Checked two ways: every `stimuli[]` entry in the verify payload
  // carries a non-empty `transcript`, and the fake's "unanswerable" verdict is keyed off a sentinel
  // planted inside one Announcement's transcript, so the fake cannot produce that verdict unless
  // the transcript reached it.
  it("verify:listening receives every stimulus's real transcript, and an 'unanswerable' verdict grounded in that transcript triggers a targeted stimulus regeneration", async () => {
    const dataDir = listeningDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();

    const UNANSWERABLE_SENTINEL = "UNANSWERABLESENTINEL";
    const announcementId = candidate.router.announcements[0]!.id;
    candidate.router.announcements[0] = {
      ...candidate.router.announcements[0]!,
      // 60 words total, same as the fixture default — stays inside ANNOUNCEMENT_WORD_RANGE so the
      // deterministic content gate never fires; only the LLM verify stage can catch this.
      transcript: `${wordsOfLength(59, `${announcementId}w`)} ${UNANSWERABLE_SENTINEL}`,
    };

    let verifyPayloadChecked = 0;
    let stimulusRepairCalls = 0;
    let sawUnanswerableVerdict = false;

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") return skillSuccess(request.parse(plan));
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) return skillSuccess(request.parse(candidate));
        if (request.prompt.includes("```stimulus-regeneration")) {
          stimulusRepairCalls += 1;
          const payload = JSON.parse(/```stimulus-regeneration\n([\s\S]*?)\n```/.exec(request.prompt)![1]!) as { stimulusId: string; reason: string };
          expect(payload.stimulusId).toBe(announcementId);
          return skillSuccess(request.parse({
            transcript: wordsOfLength(60, `${announcementId}fixedw`),
            questions: [mcq(`${announcementId}-q1`, "c"), mcq(`${announcementId}-q2`, "a")],
          }));
        }
        throw new Error(`unexpected generate:listening call:\n${request.prompt.slice(0, 200)}`);
      }

      // verify:listening
      const match = /```json\n([\s\S]*?)\n```/.exec(request.prompt);
      if (!match) throw new Error("fixture error: verify prompt is missing its ```json fence");
      const payload = JSON.parse(match[1]!) as {
        listenChooseItems: { id: string }[];
        stimuli: { id: string; taskType: string; transcript: unknown }[];
        questions: { id: string }[];
      };
      verifyPayloadChecked += 1;
      for (const s of payload.stimuli) {
        expect(s.transcript, `expected verify payload stimulus "${s.id}" to carry a non-empty transcript`).toBeTruthy();
        if (typeof s.transcript === "string") expect(s.transcript.length).toBeGreaterThan(0);
        else expect(Array.isArray(s.transcript) && s.transcript.length > 0).toBe(true);
      }
      const target = payload.stimuli.find((s) => s.id === announcementId)!;
      const isUnanswerable = typeof target.transcript === "string" && target.transcript.includes(UNANSWERABLE_SENTINEL);
      if (isUnanswerable) sawUnanswerableVerdict = true;
      return skillSuccess(request.parse({
        listenChooseItems: payload.listenChooseItems.map((i) => ({ id: i.id, verdict: "ok" as const })),
        stimuli: payload.stimuli.map((s) =>
          s.id === announcementId && isUnanswerable
            ? { id: s.id, verdict: "unanswerable" as const, reason: "the transcript never actually states the fact its question asks about" }
            : { id: s.id, verdict: "ok" as const },
        ),
        questions: payload.questions.map((q) => ({ id: q.id, verdict: "ok" as const })),
      }));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("listening", {
        runSkillTask: runSkillTask as never, planner,
        tts: fakeSynthesize, probeDuration: fakeProbeDuration,
      });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(verifyPayloadChecked).toBeGreaterThan(0);
      expect(sawUnanswerableVerdict).toBe(true);
      expect(stimulusRepairCalls).toBe(1);

      const published: unknown = JSON.parse(fs.readFileSync(publishedSetPath(setId), "utf8"));
      const parsed = AnySetSchema.parse(published);
      expect(parsed.kind).toBe("listening");
      if (parsed.kind !== "listening") throw new Error("unreachable");
      const repaired = parsed.router.announcements.find((a) => a.id === announcementId)!;
      expect(repaired.transcript).not.toContain(UNANSWERABLE_SENTINEL);

      cleanupSetArtifacts(setId);
    } catch (err) {
      cleanupSetArtifacts(setId!);
      throw err;
    }
  }, 30_000);

  // An LCR Item whose correctOptionId matches none of its own options, found on the fresh candidate
  // by the deterministic pre-checks, is repaired by the same targeted regeneration
  // (regenerateFlaggedLcrItems) a Verifier "issue" verdict triggers, rather than discarding a whole
  // generate call over one Item.
  it("repairs an LCR item whose correctOptionId doesn't match any of its own options via targeted regeneration, instead of hard-failing the gate", async () => {
    const dataDir = listeningDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();

    const brokenId = candidate.router.listenChoose[0]!.id;
    candidate.router.listenChoose[0] = {
      ...candidate.router.listenChoose[0]!,
      correctOptionId: "z", // not among options a/b/c/d
    };

    let lcrRepairCalls = 0;
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") return skillSuccess(request.parse(plan));
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) return skillSuccess(request.parse(candidate));
        if (request.prompt.includes("```lcr-regeneration")) {
          lcrRepairCalls += 1;
          const payload = JSON.parse(/```lcr-regeneration\n([\s\S]*?)\n```/.exec(request.prompt)![1]!) as { items: { id: string; reason: string }[] };
          expect(payload.items).toHaveLength(1);
          expect(payload.items[0]!.id).toBe(brokenId);
          expect(payload.items[0]!.reason).toContain("not among its own option ids");
          return skillSuccess(request.parse({
            items: [{
              id: brokenId,
              utterance: candidate.router.listenChoose[0]!.utterance,
              options: candidate.router.listenChoose[0]!.options,
              correctOptionId: "a",
              skill: "function",
              explanationZh: candidate.router.listenChoose[0]!.explanationZh,
            }],
          }));
        }
        throw new Error(`unexpected generate:listening call:\n${request.prompt.slice(0, 200)}`);
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("listening", {
        runSkillTask: runSkillTask as never, planner,
        tts: fakeSynthesize, probeDuration: fakeProbeDuration,
      });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(lcrRepairCalls).toBe(1);
      const published: unknown = JSON.parse(fs.readFileSync(publishedSetPath(setId), "utf8"));
      const parsed = AnySetSchema.parse(published);
      expect(parsed.kind).toBe("listening");
      if (parsed.kind !== "listening") throw new Error("unreachable");
      const repaired = parsed.router.listenChoose.find((item) => item.id === brokenId)!;
      // Not a literal "a": the option shuffle relabels every option's id to its final position as
      // the last step before publish, so which letter ends up correct cannot be read off the
      // regeneration response. What must hold is that the key is valid.
      expect(repaired.options.some((o) => o.id === repaired.correctOptionId)).toBe(true);
      cleanupSetArtifacts(setId);
    } catch (err) {
      cleanupSetArtifacts(setId!);
      throw err;
    }
  }, 30_000);

  // A duplicate Item id on a fresh candidate consumes that candidate attempt (logged, not silently
  // dropped) and the loop tries again, rather than ending the run with attempts still left.
  it("retries the candidate attempt loop (rather than crashing the run) when a fresh candidate has a duplicate item id", async () => {
    const dataDir = listeningDataDir();
    const plan = buildPlan();
    const cleanCandidate = buildCandidate();
    const dupedCandidate = buildCandidate();
    // Force a duplicate: the second LCR item's id collides with the first.
    dupedCandidate.router.listenChoose[1] = {
      ...dupedCandidate.router.listenChoose[1]!,
      id: dupedCandidate.router.listenChoose[0]!.id,
    };

    let candidateGenerateCalls = 0;
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") return skillSuccess(request.parse(plan));
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) {
          candidateGenerateCalls += 1;
          return skillSuccess(request.parse(candidateGenerateCalls === 1 ? dupedCandidate : cleanCandidate));
        }
        throw new Error(`unexpected generate:listening call:\n${request.prompt.slice(0, 200)}`);
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("listening", {
        runSkillTask: runSkillTask as never, planner,
        tts: fakeSynthesize, probeDuration: fakeProbeDuration,
      });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      // Attempt 1 (duplicate id, rejected) and attempt 2 (clean, accepted): the duplicate did not end
      // the run.
      expect(candidateGenerateCalls).toBe(2);
      expect(fs.existsSync(publishedSetPath(setId))).toBe(true);
      cleanupSetArtifacts(setId);
    } catch (err) {
      cleanupSetArtifacts(setId!);
      throw err;
    }
  }, 30_000);

  // A regeneration response that fails its own completeness check (here the LCR regeneration reply
  // omits the flagged Item) is retried in the next verify round, inside MAX_VERIFY_ATTEMPTS, rather
  // than ending the run while verify rounds remain.
  it("retries verify-stage remediation (rather than crashing the run) when a regeneration response omits the flagged item", async () => {
    const dataDir = listeningDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();

    const brokenId = candidate.router.listenChoose[0]!.id;
    candidate.router.listenChoose[0] = { ...candidate.router.listenChoose[0]!, correctOptionId: "z" };

    let lcrRepairCalls = 0;
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") return skillSuccess(request.parse(plan));
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) return skillSuccess(request.parse(candidate));
        if (request.prompt.includes("```lcr-regeneration")) {
          lcrRepairCalls += 1;
          if (lcrRepairCalls === 1) {
            // Schema-valid, but it omits the flagged Item and returns an id nobody asked about.
            return skillSuccess(request.parse({
              items: [{
                id: "some-other-id-not-flagged",
                utterance: "This item was never flagged for repair",
                options: candidate.router.listenChoose[0]!.options,
                correctOptionId: "a",
                skill: "function",
                explanationZh: candidate.router.listenChoose[0]!.explanationZh,
              }],
            }));
          }
          return skillSuccess(request.parse({
            items: [{
              id: brokenId,
              utterance: candidate.router.listenChoose[0]!.utterance,
              options: candidate.router.listenChoose[0]!.options,
              correctOptionId: "a",
              skill: "function",
              explanationZh: candidate.router.listenChoose[0]!.explanationZh,
            }],
          }));
        }
        throw new Error(`unexpected generate:listening call:\n${request.prompt.slice(0, 200)}`);
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("listening", {
        runSkillTask: runSkillTask as never, planner,
        tts: fakeSynthesize, probeDuration: fakeProbeDuration,
      });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      // Two LCR-regeneration calls: the first one's incomplete reply was caught and retried, not
      // left to crash the run.
      expect(lcrRepairCalls).toBe(2);
      const published: unknown = JSON.parse(fs.readFileSync(publishedSetPath(setId), "utf8"));
      const parsed = AnySetSchema.parse(published);
      expect(parsed.kind).toBe("listening");
      if (parsed.kind !== "listening") throw new Error("unreachable");
      const repaired = parsed.router.listenChoose.find((item) => item.id === brokenId)!;
      // Not a literal "a": the option shuffle relabels option ids before publish (see above).
      expect(repaired.options.some((o) => o.id === repaired.correctOptionId)).toBe(true);
      cleanupSetArtifacts(setId);
    } catch (err) {
      cleanupSetArtifacts(setId!);
      throw err;
    }
  }, 30_000);

  it("cleans up staged/audio artifacts via cleanupUnpublishedSetArtifacts when the audio render fails", async () => {
    const dataDir = listeningDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    const runSkillTask = buildRunSkillTask(plan, candidate);

    let capturedSetId: string | undefined;
    const onProgress = (event: GenerationProgress) => {
      if (event.detail?.setId) capturedSetId = event.detail.setId;
    };

    const planner = createGenerationPlanner({ dataDir });
    let thrown: unknown;
    try {
      await generateSet(
        "listening",
        {
          runSkillTask: runSkillTask as never,
          planner,
          tts: fakeSynthesize,
          // Far below even the wide sanity floor for every role -> renderListeningAudio throws
          // (genuine malfunction, not ordinary pace variance) on the very first clip.
          probeDuration: () => Promise.resolve(0.001),
        },
        onProgress,
      );
    } catch (err) {
      thrown = err;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("wildly outside its plausible duration");
    expect(capturedSetId).toBeDefined();
    // Nothing published, and the render's own output directory (created before the failing clip)
    // was removed by cleanupUnpublishedSetArtifacts's listening branch.
    expect(fs.existsSync(publishedSetPath(capturedSetId!))).toBe(false);
    expect(fs.existsSync(audioDirPath(capturedSetId!))).toBe(false);
  }, 30_000);

});

// Every Speaker is cast on Gemini, from the three role-constrained pools in geminiVoices.ts
// (GEMINI_VOICE_POOLS). `poolOfVoice` looks up which pool a rendered voice came from, from the
// published cast alone; geminiVoices.test.ts proves the three pools are pairwise disjoint, so the
// lookup is unambiguous.
function poolOfVoice(voice: string): GeminiVoicePool {
  for (const pool of GEMINI_VOICE_POOL_NAMES) {
    if (GEMINI_VOICE_POOLS[pool].female.includes(voice) || GEMINI_VOICE_POOLS[pool].male.includes(voice)) return pool;
  }
  throw new Error(`fixture error: voice "${voice}" is not in any GEMINI_VOICE_POOLS pool`);
}

function collectAllSpeakers(candidate: ReturnType<typeof assignSpeakerRendering>) {
  return (["router", "lowerModule", "upperModule"] as const).flatMap((moduleName) => {
    const module = candidate[moduleName];
    return [
      ...module.listenChoose.map((item) => item.speaker),
      ...module.conversations.flatMap((conversation) => conversation.speakers),
      ...module.announcements.map((announcement) => announcement.speaker),
      ...module.academicTalks.map((talk) => talk.speaker),
    ];
  });
}

describe("assignSpeakerRendering", () => {
  it("overwrites every Speaker's accent deterministically and assigns provider \"gemini\" unconditionally — never OpenAI, regardless of Stimulus shape", () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    for (const speaker of collectAllSpeakers(candidate)) {
      expect(["north-american", "british", "australian"]).toContain(speaker.accent);
      expect(speaker.provider).toBe("gemini");
    }
  });

  it("draws each single-speaker Stimulus's voice from the pool its shape maps to (academicTalks -> authoritative, announcements -> service), and each Conversation's speakers[0]/speakers[1] from young/service respectively", () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    for (const moduleName of ["router", "lowerModule", "upperModule"] as const) {
      const module = candidate[moduleName];
      for (const talk of module.academicTalks) expect(poolOfVoice(talk.speaker.voice)).toBe("authoritative");
      for (const announcement of module.announcements) expect(poolOfVoice(announcement.speaker.voice)).toBe("service");
      for (const conversation of module.conversations) {
        const [first, second] = conversation.speakers;
        expect(poolOfVoice(first!.voice)).toBe("young");
        expect(poolOfVoice(second!.voice)).toBe("service");
      }
    }
  });

  it("rotates listenChoose's own pool draw authoritative -> young -> service, by its own tick, in Set-traversal order", () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    const lcrPools = (["router", "lowerModule", "upperModule"] as const).flatMap((moduleName) =>
      candidate[moduleName].listenChoose.map((item) => poolOfVoice(item.speaker.voice)),
    );
    // 20 LCR items total (10 router + 5 lowerModule + 5 upperModule); the tick is one continuous
    // counter across all three modules, so it does not reset per module.
    expect(lcrPools.length).toBe(20);
    for (let i = 0; i < lcrPools.length; i += 1) {
      expect(lcrPools[i]).toBe((["authoritative", "young", "service"] as const)[i % 3]);
    }
  });

  it("every Speaker's voice always matches that Speaker's own gender, including a Conversation's model-chosen (not ticked) gender", () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    for (const speaker of collectAllSpeakers(candidate)) {
      const pool = poolOfVoice(speaker.voice);
      expect(GEMINI_VOICE_POOLS[pool][speaker.gender]).toContain(speaker.voice);
    }
  });

  it("every Conversation's two speakers get different voices, over a whole Set — guaranteed by the pools being disjoint (young vs. service), independent of gender", () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    for (const moduleName of ["router", "lowerModule", "upperModule"] as const) {
      for (const conversation of candidate[moduleName].conversations) {
        const [first, second] = conversation.speakers;
        expect(first!.voice).not.toBe(second!.voice);
      }
    }
  });

  it("rotates within a pool: across a full Set, the set of distinct voices used is larger than one per (pool, gender) wherever that combination is drawn more than once", () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    const distinctByGroup = new Map<string, Set<string>>();
    const countByGroup = new Map<string, number>();
    for (const speaker of collectAllSpeakers(candidate)) {
      const key = `${poolOfVoice(speaker.voice)}:${speaker.gender}`;
      countByGroup.set(key, (countByGroup.get(key) ?? 0) + 1);
      const distinct = distinctByGroup.get(key) ?? new Set<string>();
      distinct.add(speaker.voice);
      distinctByGroup.set(key, distinct);
    }
    let sawARotatingGroup = false;
    for (const [key, count] of countByGroup) {
      if (count > 1) {
        sawARotatingGroup = true;
        expect(distinctByGroup.get(key)!.size, `expected "${key}" (drawn ${count} times) to rotate across more than one voice`).toBeGreaterThan(1);
      }
    }
    // Sanity check on the fixture itself: a full Set draws every (pool, gender) combination more
    // than once (every real GEMINI_VOICE_POOLS list has >= 3 members, so this is never vacuous).
    expect(sawARotatingGroup).toBe(true);
  });

  it("is deterministic: calling assignSpeakerRendering twice on the same input yields deeply equal output", () => {
    const input = buildCandidate();
    expect(assignSpeakerRendering(input)).toEqual(assignSpeakerRendering(input));
  });

  // assignSpeakerRendering balances gender by construction over every single-speaker Stimulus, so
  // lopsided model choices can never cost a run. The test starts from the most lopsided input there
  // is (every single-speaker gender forced to "male") and asserts the output is still balanced: the
  // code overwrites gender for these three shapes whatever the model wrote, as it does accent and
  // provider.
  it("balances gender by construction across every single-speaker Stimulus, even when every model-chosen input gender is identical, while leaving a Conversation's own M/F pairing untouched", () => {
    const allMaleInput = (module: ListeningModule): ListeningModule => ({
      ...module,
      listenChoose: module.listenChoose.map((item) => ({ ...item, speaker: { ...item.speaker, gender: "male" as const } })),
      announcements: module.announcements.map((a) => ({ ...a, speaker: { ...a.speaker, gender: "male" as const } })),
      academicTalks: module.academicTalks.map((t) => ({ ...t, speaker: { ...t.speaker, gender: "male" as const } })),
    });
    const input = buildCandidate();
    const lopsided = {
      ...input,
      router: allMaleInput(input.router),
      lowerModule: allMaleInput(input.lowerModule),
      upperModule: allMaleInput(input.upperModule),
    };
    const candidate = assignSpeakerRendering(lopsided);

    let male = 0;
    let female = 0;
    for (const moduleName of ["router", "lowerModule", "upperModule"] as const) {
      const module = candidate[moduleName];
      for (const item of module.listenChoose) item.speaker.gender === "male" ? (male += 1) : (female += 1);
      for (const a of module.announcements) a.speaker.gender === "male" ? (male += 1) : (female += 1);
      for (const t of module.academicTalks) t.speaker.gender === "male" ? (male += 1) : (female += 1);
      // A Conversation's own M/F pairing stays the model's: assignSpeakerRendering never overwrites
      // it.
      for (const conversation of module.conversations) {
        const genders = conversation.speakers.map((s) => s.gender).sort();
        expect(genders).toEqual(["female", "male"]);
      }
    }
    // 29 free single-speaker slots (20 LCR + 5 announcements + 4 academic talks) split 15/14
    // regardless of the all-male input above — proof the server, not the model, decided this.
    expect(male + female).toBe(29);
    expect(Math.abs(male - female)).toBeLessThanOrEqual(1);
  });
});

describe("listeningContentViolations", () => {
  it("finds no violations on a well-formed candidate", () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    expect(listeningContentViolations(candidate)).toEqual([]);
  });

  it("flags a wrong module composition", () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    const broken = { ...candidate, router: { ...candidate.router, listenChoose: candidate.router.listenChoose.slice(1) } };
    const violations = listeningContentViolations(broken);
    expect(violations.some((v) => v.kind === "composition" && v.id === "router")).toBe(true);
  });

  it("flags an over-long explanation as remediable, distinct from a blocking violation", () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    const overlong = "字".repeat(210);
    const broken = {
      ...candidate,
      router: {
        ...candidate.router,
        listenChoose: [
          { ...candidate.router.listenChoose[0]!, explanationZh: overlong },
          ...candidate.router.listenChoose.slice(1),
        ],
      },
    };
    const violations = listeningContentViolations(broken);
    const found = violations.find((v) => v.kind === "explanation-length");
    expect(found).toBeDefined();
    expect(found!.id).toBe(candidate.router.listenChoose[0]!.id);
  });

  // The Academic Talk word gate enforces ETS's published 175-250 band (the Technical Manual's
  // "short (175–250 words)"). Both bounds are pinned: one word below the floor and one above the
  // ceiling are flagged, and both edges of the band stay quiet. The gate runs at generation time
  // only; a published Set never passes through it again, so a banked talk under 175 words stays
  // valid.
  it("flags an Academic Talk outside the 175-250 ETS band and stays quiet at both edges of it", () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    const withTalkOf = (words: number) => {
      const talk = candidate.router.academicTalks[0]!;
      return {
        ...candidate,
        router: {
          ...candidate.router,
          academicTalks: [{ ...talk, transcript: wordsOfLength(words, `${talk.id}n${words}w`) }],
        },
      };
    };
    const wordCountViolations = (words: number) =>
      listeningContentViolations(withTalkOf(words)).filter((v) => v.kind === "word-count");

    const below = wordCountViolations(174);
    expect(below).toHaveLength(1);
    expect(below[0]!.id).toBe(candidate.router.academicTalks[0]!.id);
    expect(String(below[0]!.detail)).toContain("expected 175-250");

    expect(wordCountViolations(251)).toHaveLength(1);

    expect(wordCountViolations(175)).toEqual([]);
    expect(wordCountViolations(250)).toEqual([]);
  });
});

// Answer-key position, balanced by construction (rebalanceListeningOptionOrder): a model writes its
// keys at a favourite position, so every option list is shuffled before publish.
describe("rebalanceListeningOptionOrder spreads answer keys across positions", () => {
  it("constant rng=0 produces a real, non-identity permutation of ALL options AND relabels ids to position (a full Fisher–Yates plus relabel)", () => {
    // Hand-traced (Reading shares the algorithm, shuffleMcqOptions in generationVerifyRemediation.ts):
    // rng() always 0 left-rotates the content by one, so the text originally at index 0 ("a") ends
    // up at index 3 and is relabelled "d". Every fixture LCR Item's correctOptionId is "a" (index 0);
    // see lcrEntry() above.
    const candidate = assignSpeakerRendering(buildCandidate());
    const rebalanced = rebalanceListeningOptionOrder(candidate, () => 0);
    const item = rebalanced.router.listenChoose[0]!;
    const originalItem = candidate.router.listenChoose[0]!;
    expect(item.options.map((o) => o.id)).toEqual(["a", "b", "c", "d"]); // labels always canonical
    expect(item.correctOptionId).toBe("d"); // the originally correct text now carries label "d"
    expect(item.options.find((o) => o.id === "d")!.text).toBe(originalItem.options.find((o) => o.id === "a")!.text);
  });

  it("preserves the full CONTENT (option texts) and which text is correct — only which id/position that text carries changes, for both LCR items and Stimulus MCQ questions", () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    const rebalanced = rebalanceListeningOptionOrder(candidate, () => 0.42);
    const item = rebalanced.router.listenChoose[0]!;
    const originalItem = candidate.router.listenChoose[0]!;
    expect(new Set(item.options.map((o) => o.id))).toEqual(new Set(originalItem.options.map((o) => o.id))); // same label set
    expect(new Set(item.options.map((o) => o.text))).toEqual(new Set(originalItem.options.map((o) => o.text))); // same texts
    expect(item.options.find((o) => o.id === item.correctOptionId)!.text).toBe(
      originalItem.options.find((o) => o.id === originalItem.correctOptionId)!.text,
    );

    const question = rebalanced.router.conversations[0]!.questions[0]!;
    const originalQuestion = candidate.router.conversations[0]!.questions[0]!;
    expect(new Set(question.options.map((o) => o.id))).toEqual(new Set(originalQuestion.options.map((o) => o.id)));
    expect(question.options.find((o) => o.id === question.correctOptionId)!.text).toBe(
      originalQuestion.options.find((o) => o.id === originalQuestion.correctOptionId)!.text,
    );
  });

  it("breaks a 'pick option N for question N' pattern: q1's and q2's keys do not land at the same fixed index every time", () => {
    // Real Math.random (the production path): a constant rng applied to identically shaped
    // (4-option) Items would produce the same permutation for all of them, defeating the test's
    // point. Uses all 10 router LCR Items rather than one Conversation's 2 questions, so the "not all
    // identical" assertion is not itself flaky (2 samples at 3 options coincide 1 time in 3; 10
    // independent 4-option draws all coinciding is vanishingly unlikely).
    const candidate = assignSpeakerRendering(buildCandidate());
    const rebalanced = rebalanceListeningOptionOrder(candidate);
    const positions = rebalanced.router.listenChoose.map((item) => item.options.findIndex((o) => o.id === item.correctOptionId));
    expect(new Set(positions).size).toBeGreaterThan(1);
  });

  it("leaves a dangling correctOptionId untouched — checkOptionKey's violation to catch, not this function's", () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    const broken = {
      ...candidate,
      router: {
        ...candidate.router,
        listenChoose: [
          { ...candidate.router.listenChoose[0]!, correctOptionId: "z" },
          ...candidate.router.listenChoose.slice(1),
        ],
      },
    };
    const rebalanced = rebalanceListeningOptionOrder(broken, () => 0.99);
    expect(rebalanced.router.listenChoose[0]!.options).toEqual(broken.router.listenChoose[0]!.options);
    expect(rebalanced.router.listenChoose[0]!.correctOptionId).toBe("z");
  });

  // The id-order attack, run against the real production path over LCR Items: guess the option
  // whose removal leaves the other ids sorted. Relabelling makes ids always canonically ordered, so
  // the attack degenerates to chance; that is worth pinning rather than assuming.
  it("leaves an id-order attack on LCR Items at chance: guessing from id order alone does no better", () => {
    function isSortedIds(ids: string[]): boolean {
      for (let i = 1; i < ids.length; i += 1) if (ids[i]! < ids[i - 1]!) return false;
      return true;
    }
    function idOrderAttackGuess(ids: string[]): string {
      const candidates = ids.filter((_, i) => isSortedIds(ids.filter((_, j) => j !== i)));
      const pool = candidates.length > 0 ? candidates : ids;
      return pool[Math.floor(Math.random() * pool.length)]!;
    }

    const TRIALS = 500;
    let hits = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const candidate = assignSpeakerRendering(buildCandidate());
      const rebalanced = rebalanceListeningOptionOrder(candidate); // real Math.random
      const item = rebalanced.router.listenChoose[0]!;
      const guess = idOrderAttackGuess(item.options.map((o) => o.id));
      if (guess === item.correctOptionId) hits += 1;
    }
    const accuracy = hits / TRIALS;
    expect(accuracy).toBeGreaterThan(0.15);
    expect(accuracy).toBeLessThan(0.37);
  });

  // The id-identity attack: always guess the same label. Shuffling content alone would leave a model's
  // favourite key label in place, so the shuffle also relabels the key to the position it lands in.
  // Every LCR Item here starts with its key at "a" (see lcrEntry()), the most biased input there is.
  // Real Math.random.
  it("closes the id-IDENTITY attack for LCR items: even when every item's INPUT key is biased toward one label, the OUTPUT key's label is uniform, not still skewed", () => {
    const TRIALS = 2000;
    const labelCounts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const candidate = assignSpeakerRendering(buildCandidate());
      const rebalanced = rebalanceListeningOptionOrder(candidate); // real Math.random
      const item = rebalanced.router.listenChoose[0]!; // input correctOptionId is always "a"
      labelCounts[item.correctOptionId] = (labelCounts[item.correctOptionId] ?? 0) + 1;
    }
    const guessAAccuracy = labelCounts.a! / TRIALS;
    expect(guessAAccuracy).toBeGreaterThan(0.15);
    expect(guessAAccuracy).toBeLessThan(0.37);
    for (const label of ["a", "b", "c", "d"]) {
      const share = labelCounts[label]! / TRIALS;
      expect(share).toBeGreaterThan(0.15);
      expect(share).toBeLessThan(0.37);
    }
  });
});

// Goes through the real generateSet pipeline, never calling rebalanceListeningOptionOrder directly,
// so a generator that stopped wiring in the rebalance step fails here.
describe("generateSet (listening) rebalances option order before publishing", () => {
  it("actually calls the rebalance step: a published LCR item's option CONTENT order and correctOptionId differ from the candidate's own", async () => {
    // Ids are relabelled to canonical position order after every shuffle, so comparing by id cannot
    // detect the rebalance; compare by text order and by correctOptionId instead.
    const dataDir = listeningDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    const originalTextOrder = candidate.router.listenChoose[0]!.options.map((o) => o.text);
    const originalCorrectOptionId = candidate.router.listenChoose[0]!.correctOptionId;
    const runSkillTask = buildRunSkillTask(plan, candidate);

    const spy = vi.spyOn(Math, "random").mockReturnValue(0); // -> a real, computable left-rotate-by-1
    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet(
        "listening",
        {
          runSkillTask: runSkillTask as never,
          planner,
          tts: fakeSynthesize,
          probeDuration: fakeProbeDuration,
        },
      );
      setId = result.setId;
    } finally {
      spy.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
    try {
      const published: unknown = JSON.parse(fs.readFileSync(publishedSetPath(setId), "utf8"));
      const parsed = AnySetSchema.parse(published);
      if (parsed.kind !== "listening") throw new Error("unreachable");
      const item = parsed.router.listenChoose[0]!;
      const publishedTextOrder = item.options.map((o) => o.text);
      expect(publishedTextOrder).not.toEqual(originalTextOrder);
      expect(item.correctOptionId).not.toBe(originalCorrectOptionId);
      expect(new Set(publishedTextOrder)).toEqual(new Set(originalTextOrder));
      expect(item.options.map((o) => o.id)).toEqual(["a", "b", "c", "d"]);
      cleanupSetArtifacts(setId);
    } catch (err) {
      cleanupSetArtifacts(setId!);
      throw err;
    }
  });
});

// Option-length bias, detected directly: a key that is systematically the longest option is a cue
// the User can learn instead of the content.
describe("listeningContentViolations: option-length-bias", () => {
  function withBiasedOptionLength<Q extends { options: { id: string; text: string }[]; correctOptionId: string }>(question: Q): Q {
    return {
      ...question,
      options: question.options.map((o) => ({
        ...o,
        text: o.id === question.correctOptionId ? "x".repeat(80) : "short",
      })),
    };
  }

  it("flags option-length-bias when the correct option is the strictly-longest choice for MOST of the 60-item population, capped per round", () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    const biasModule = (module: ListeningModule): ListeningModule => ({
      ...module,
      listenChoose: module.listenChoose.map(withBiasedOptionLength),
      conversations: module.conversations.map((c) => ({ ...c, questions: c.questions.map(withBiasedOptionLength) })),
      announcements: module.announcements.map((a) => ({ ...a, questions: a.questions.map(withBiasedOptionLength) })),
      academicTalks: module.academicTalks.map((t) => ({ ...t, questions: t.questions.map(withBiasedOptionLength) })),
    });
    const biased = {
      ...candidate,
      router: biasModule(candidate.router),
      lowerModule: biasModule(candidate.lowerModule),
      upperModule: biasModule(candidate.upperModule),
    };
    const violations = listeningContentViolations(biased);
    const bias = violations.filter((v) => v.kind === "option-length-bias");
    expect(bias).toHaveLength(12); // MAX_LONGEST_OPTION_REMEDIATIONS_PER_ROUND; the rest defer, not skipped
    // Every group is fully biased here, so all are offending and the round-robin draw pulls from more
    // than one. `detail` names the group and its own size, never a pooled count over the Set. A group
    // is "the whole Set", a module, a taker path ("router+lowerModule"), or a Task Type, optionally
    // narrowed to "<module>/<taskType>" or "<module>/<taskType>/<n>-option".
    expect(bias.every((v) => /within "(?:the whole Set|router|lowerModule|upperModule|router\+(?:lower|upper)Module|(?:[a-zA-Z]+\/)?(?:listen_choose|conversation|announcement|academic_talk)(?:\/\d-option)?)", \d+ of \d+/.test(v.detail))).toBe(true);
    const buckets = new Set(bias.map((v) => /within "([^"]+)"/.exec(v.detail)?.[1]));
    expect(buckets.size).toBeGreaterThan(1); // round-robin drew from more than one offending group
  });

  it("does not flag a well-formed candidate whose option lengths are not systematically tied to correctness", () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    const violations = listeningContentViolations(candidate);
    expect(violations.filter((v) => v.kind === "option-length-bias")).toHaveLength(0);
  });
});

// The per-round remediation cap defers rather than skips: round 2 flags a different batch than
// round 1, so Items over the cap are taken in a later round instead of dropped.
describe("generateSet (listening): option-length-bias remediation defers over its cap", () => {
  it("flags a different batch of LCR ids in round 2 than in round 1, neither the same ones again nor none", async () => {
    const dataDir = listeningDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    const biasLcr = <Q extends { options: { id: string; text: string }[]; correctOptionId: string }>(item: Q): Q => ({
      ...item,
      options: item.options.map((o) => ({ ...o, text: o.id === item.correctOptionId ? "x".repeat(80) : "short" })),
    });
    // Every LCR Item is 4-option. Biasing all 20 puts more of them over the ceiling than one round's
    // cap of 12 can remediate, so the first round cannot clear them all.
    const lcrRefs: { moduleName: "router" | "lowerModule" | "upperModule"; index: number }[] = [];
    for (const moduleName of ["router", "lowerModule", "upperModule"] as const) {
      candidate[moduleName].listenChoose.forEach((_, i) => lcrRefs.push({ moduleName, index: i }));
    }
    expect(lcrRefs.length).toBe(20);
    for (const ref of lcrRefs) {
      candidate[ref.moduleName].listenChoose[ref.index] = biasLcr(candidate[ref.moduleName].listenChoose[ref.index]!);
    }

    let verifyCalls = 0;
    const flaggedIdsByRound: string[][] = [];
    let currentRoundIds: string[] = [];
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") return skillSuccess(request.parse(plan));
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) return skillSuccess(request.parse(candidate));
        if (request.prompt.includes("```lcr-regeneration")) {
          const payload = JSON.parse(/```lcr-regeneration\n([\s\S]*?)\n```/.exec(request.prompt)![1]!) as { items: { id: string; options: { id: string; text: string }[]; correctOptionId: string; skill: string }[] };
          currentRoundIds.push(...payload.items.map((i) => i.id));
          return skillSuccess(request.parse({
            items: payload.items.map((i) => ({
              id: i.id, utterance: LCR_UTTERANCE,
              options: i.options.map((o) => ({ id: o.id, text: "same-length-ish" })),
              correctOptionId: i.correctOptionId, skill: i.skill, explanationZh: `解析 ${i.id}`,
            })),
          }));
        }
        throw new Error(`unexpected generate:listening call:\n${request.prompt.slice(0, 200)}`);
      }
      if (verifyCalls > 0) {
        flaggedIdsByRound.push(currentRoundIds);
        currentRoundIds = [];
      }
      verifyCalls += 1;
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet(
        "listening",
        { runSkillTask: runSkillTask as never, planner, tts: fakeSynthesize, probeDuration: fakeProbeDuration },
      );
      setId = result.setId;
      flaggedIdsByRound.push(currentRoundIds);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      const nonEmptyRounds = flaggedIdsByRound.filter((ids) => ids.length > 0);
      expect(nonEmptyRounds.length).toBeGreaterThanOrEqual(2);
      const round1 = new Set(nonEmptyRounds[0]);
      const round2 = new Set(nonEmptyRounds[1]);
      expect(round1.size).toBeGreaterThan(0);
      expect(round2.size).toBeGreaterThan(0);
      for (const id of round2) expect(round1.has(id)).toBe(false);
      fs.rmSync(publishedSetPath(setId));
      fs.rmSync(audioDirPath(setId), { recursive: true, force: true });
    } catch (err) {
      cleanupSetArtifacts(setId!);
      throw err;
    }
  });
});

// A question flagged for a question-grain reason (here option-length-bias) whose Stimulus is also
// regenerated wholesale in the same round must not be regenerated a second time moments after being
// replaced.
describe("generateSet (listening): a question regenerated with its Stimulus is not regenerated again", () => {
  it("never sends a question-regeneration call for a question whose own Stimulus is wholesale-regenerated the same round", async () => {
    const dataDir = listeningDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();

    // Shrink router's first Conversation below the word-count floor (a `word-count` violation, which
    // regenerates the whole Stimulus) and bias every Conversation's q1 toward option-length-bias,
    // the shrunk Conversation's own q1 included. Conversation questions are 3-option (mcq()'s
    // default).
    const shrunk = candidate.router.conversations[0]!;
    shrunk.transcript = [
      { speakerId: shrunk.speakers[0].id, text: wordsOfLength(20, "shortA") },
      { speakerId: shrunk.speakers[1].id, text: wordsOfLength(20, "shortB") },
    ]; // 40 words total, below CONVERSATION_WORD_RANGE.min (80)
    const biasQuestion = <Q extends { options: { id: string; text: string }[]; correctOptionId: string }>(q: Q): Q => ({
      ...q, options: q.options.map((o) => ({ ...o, text: o.id === q.correctOptionId ? "x".repeat(80) : "short" })),
    });
    const conversations = candidate.router.conversations
      .concat(candidate.lowerModule.conversations, candidate.upperModule.conversations);
    expect(conversations.length).toBe(7); // 3 router + 2 lower + 2 upper = 14 questions total
    for (const conv of conversations) conv.questions[0] = biasQuestion(conv.questions[0]!);
    const shrunkQuestionId = shrunk.questions[0]!.id;
    // The precondition that makes this test able to fail: the content gate flags the shrunk
    // Conversation for its word count AND its q1 for option-length bias in the same measurement, so
    // round 1 asks for both a Stimulus and a question regeneration that cover the same question.
    const before = listeningContentViolations(assignSpeakerRendering(structuredClone(candidate)));
    expect(before).toContainEqual(expect.objectContaining({ kind: "word-count", id: shrunk.id }));
    expect(before).toContainEqual(expect.objectContaining({ kind: "option-length-bias", id: shrunkQuestionId }));

    const stimulusRegenCalls: string[] = [];
    const questionRegenCalls: string[] = [];
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") return skillSuccess(request.parse(plan));
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) return skillSuccess(request.parse(candidate));
        if (request.prompt.includes("```stimulus-regeneration")) {
          const payload = JSON.parse(/```stimulus-regeneration\n([\s\S]*?)\n```/.exec(request.prompt)![1]!) as { stimulusId: string };
          stimulusRegenCalls.push(payload.stimulusId);
          return skillSuccess(request.parse({
            stimulusId: payload.stimulusId,
            transcript: [
              { speakerId: shrunk.speakers[0].id, text: wordsOfLength(45, "fixedA") },
              { speakerId: shrunk.speakers[1].id, text: wordsOfLength(45, "fixedB") },
            ],
            questions: shrunk.questions.map((q) => ({
              id: q.id, stem: q.stem,
              options: q.options.map((o) => ({ id: o.id, text: "same-length-ish" })),
              correctOptionId: q.correctOptionId, skill: q.skill, explanationZh: q.explanationZh,
            })),
          }));
        }
        if (request.prompt.includes("```question-regeneration")) {
          const payload = JSON.parse(/```question-regeneration\n([\s\S]*?)\n```/.exec(request.prompt)![1]!) as { flaggedQuestions: { id: string; options: { id: string; text: string }[]; correctOptionId: string; skill: string }[] };
          questionRegenCalls.push(...payload.flaggedQuestions.map((q) => q.id));
          return skillSuccess(request.parse({
            questions: payload.flaggedQuestions.map((q) => ({
              id: q.id, stem: `FIXED stem for ${q.id}`,
              options: q.options.map((o) => ({ id: o.id, text: "same-length-ish" })),
              correctOptionId: q.correctOptionId, skill: q.skill, explanationZh: `解析 ${q.id}`,
            })),
          }));
        }
        throw new Error(`unexpected generate:listening call:\n${request.prompt.slice(0, 200)}`);
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet(
        "listening",
        { runSkillTask: runSkillTask as never, planner, tts: fakeSynthesize, probeDuration: fakeProbeDuration },
      );
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(stimulusRegenCalls).toContain(shrunk.id);
      // The question regeneration ran, for the other biased questions, so its payload is evidence.
      expect(questionRegenCalls.length).toBeGreaterThan(0);
      // The shrunk Conversation's own question is never regenerated separately: its Stimulus
      // regeneration already replaced it.
      expect(questionRegenCalls).not.toContain(shrunkQuestionId);
      fs.rmSync(publishedSetPath(setId));
      fs.rmSync(audioDirPath(setId), { recursive: true, force: true });
    } catch (err) {
      cleanupSetArtifacts(setId!);
      throw err;
    }
  });
});

/**
 * lsn-14659f38, a retired Listening Set that never passed the position-reference or word-count
 * check, read from this file's own copy of the bank (retirement leaves the file in place). Two
 * suites below measure real defects in it.
 */
function retiredListeningSet(): ListeningSet {
  const parsed = AnySetSchema.parse(readBankSet("listening", "lsn-14659f38"));
  if (parsed.kind !== "listening") throw new Error("fixture error: lsn-14659f38 is not a Listening Set");
  return parsed;
}

// An Explanation must never name an option by position: the option shuffle runs after the last
// verify round, so a position named in `explanationZh` describes a slot the shuffle may reassign.
describe("listeningContentViolations: explanation-position-reference", () => {
  function moduleWith(overrides: { listenChoose?: ReturnType<typeof lcrEntry>[]; conversations?: ReturnType<typeof conversationEntry>[] }): ListeningModule {
    return {
      timeLimitSec: 540,
      listenChoose: overrides.listenChoose ?? [],
      conversations: overrides.conversations ?? [],
      announcements: [], academicTalks: [],
    };
  }
  function emptyModule(): ListeningModule {
    return { timeLimitSec: 540, listenChoose: [], conversations: [], announcements: [], academicTalks: [] };
  }

  it("flags an LCR item's explanation that names the key by Chinese ordinal (即選項二)", () => {
    const item = { ...lcrEntry("lcr-1"), explanationZh: "說話者的請求已被滿足,即選項二為合理回應。" };
    const violations = listeningContentViolations({
      router: moduleWith({ listenChoose: [item] }), lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    const flagged = violations.filter((v) => v.kind === "explanation-position-reference");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.id).toBe("lcr-1");
  });

  it("flags an MCQ question's explanation that names a WRONG option by ordinal, not just the key", () => {
    const conversation = conversationEntry("conv-1");
    conversation.questions[0]!.explanationZh = "答案為選項一。選項二、三未在對話中提及,屬臆測。";
    const violations = listeningContentViolations({
      router: moduleWith({ conversations: [conversation] }), lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    const flagged = violations.filter((v) => v.kind === "explanation-position-reference");
    expect(flagged.map((v) => v.id)).toContain(conversation.questions[0]!.id);
  });

  it("does NOT flag content-relative phrasing (其餘選項/所有選項) that names no specific slot", () => {
    const item = { ...lcrEntry("lcr-1"), explanationZh: "說話者的請求已被滿足,回應直接同意;其餘選項均答非所問。" };
    const violations = listeningContentViolations({
      router: moduleWith({ listenChoose: [item] }), lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    expect(violations.filter((v) => v.kind === "explanation-position-reference")).toHaveLength(0);
  });

  // The detector flags any option named by position, key or distractor, since a distractor's stated
  // position is as invalidated by the shuffle as the key's. The retired Set names an option by
  // ordinal in every one of its 60 Explanations, one of them (`talk-up1-q4`) through other
  // connecting words ("可推知選項二為正確答案"); all 60 are flagged.
  it("flags all 60 Explanations of a retired Set that names an option by ordinal in every one", () => {
    const parsed = retiredListeningSet();
    const violations = listeningContentViolations(parsed);
    const flagged = violations.filter((v) => v.kind === "explanation-position-reference");
    expect(flagged).toHaveLength(60);
  });

  // What the position-reference gate prevents, measured against the real
  // `rebalanceListeningOptionOrder` rather than a hand-rolled shuffle: shuffling the retired Set 200
  // times leaves most ordinal-bearing Explanations naming the wrong option.
  it("shows why: rebalancing that Set leaves most ordinal-bearing Explanations naming the wrong option", () => {
    const parsed = retiredListeningSet();

    const ordinalMap: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3 };
    let trials = 0;
    let desynced = 0;
    for (let t = 0; t < 200; t += 1) {
      const rebalanced = rebalanceListeningOptionOrder(parsed);
      const allOriginal = LISTENING_MODULE_NAMES.flatMap((m) => [
        ...parsed[m].listenChoose, ...parsed[m].conversations.flatMap((c) => c.questions),
        ...parsed[m].announcements.flatMap((a) => a.questions), ...parsed[m].academicTalks.flatMap((tk) => tk.questions),
      ]);
      const allRebalanced = new Map(LISTENING_MODULE_NAMES.flatMap((m) => [
        ...rebalanced[m].listenChoose, ...rebalanced[m].conversations.flatMap((c) => c.questions),
        ...rebalanced[m].announcements.flatMap((a) => a.questions), ...rebalanced[m].academicTalks.flatMap((tk) => tk.questions),
      ]).map((item) => [item.id, item]));
      for (const original of allOriginal) {
        const statedMatch = /選項([一二三四])/u.exec(original.explanationZh);
        if (!statedMatch) continue;
        const statedPosition = ordinalMap[statedMatch[1]!]!;
        const after = allRebalanced.get(original.id)!;
        const newPosition = after.options.findIndex((o) => o.id === after.correctOptionId);
        trials += 1;
        if (statedPosition !== newPosition) desynced += 1;
      }
    }
    const desyncRate = desynced / trials;
    // After a uniform shuffle a stated position still matches the key about one time in three or
    // four, so a desync rate above 50% shows the shuffle invalidates most stated positions, without
    // pinning an exact figure.
    expect(desyncRate).toBeGreaterThan(0.5);
  });
});

// A position-referencing Explanation is repaired through the generic explanation-rewrite path,
// rather than blocking the run or publishing as it stands.
describe("generateSet (listening) — explanation-position-reference remediation", () => {
  // Both tests below are written so they cannot pass against a context-free prompt. A fake that
  // returned a hard-coded explanation would pass whether or not the prompt carried the Item, so the
  // reply is derived from content extracted out of the real prompt, and the published Explanation is
  // asserted to contain that content. A prompt carrying only `{id, reason}` makes the extraction
  // fail and the test fail on its own assertions.
  function parseRewritePayload(prompt: string): {
    flagged: {
      id: string; reason: string; taskType: string;
      utterance?: string; stem?: string; stimulusId?: string;
      options: { id: string; text: string }[]; correctOptionId: string; explanationZh: string;
    }[];
    stimuli: { id: string; taskType: string; transcript: unknown }[];
  } {
    return JSON.parse(/```explanation-rewrite\n([\s\S]*?)\n```/.exec(prompt)![1]!);
  }

  it("sends the flagged LCR item's own utterance, options, key and current explanation — and rewrites from them", async () => {
    const dataDir = listeningDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    const target = candidate.router.listenChoose[0]!;
    target.explanationZh = "說話者的請求已被滿足,即選項二為合理回應。";
    const targetId = target.id;
    const targetUtterance = target.utterance;
    const keyText = target.options.find((o) => o.id === target.correctOptionId)!.text;

    let rewriteCalls = 0;
    let derivedExplanation = "";
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") return skillSuccess(request.parse(plan));
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) return skillSuccess(request.parse(candidate));
        if (request.prompt.includes("```explanation-rewrite")) {
          rewriteCalls += 1;
          const payload = parseRewritePayload(request.prompt);
          expect(payload.flagged.map((f) => f.id)).toEqual([targetId]);
          const entry = payload.flagged[0]!;
          expect(entry.reason).toContain("POSITION");
          // The whole Item is present, so the model can rewrite from it.
          expect(entry.taskType).toBe("listen_choose");
          expect(entry.utterance).toBe(targetUtterance);
          expect(entry.correctOptionId).toBe(target.correctOptionId);
          expect(entry.options.map((o) => o.text)).toEqual(target.options.map((o) => o.text));
          expect(entry.explanationZh).toBe("說話者的請求已被滿足,即選項二為合理回應。");
          // The instruction the model is given names the required form and the forbidden class.
          expect(request.prompt).toContain("唯一允許的寫法");
          expect(request.prompt).toContain("最後一個選項");
          // Derive the reply from what the prompt actually carried: name the key by its content.
          const key = entry.options.find((o) => o.id === entry.correctOptionId)!;
          derivedExplanation = `正解是「${key.text}」,直接回應了錄音內容;其餘選項答非所問。`;
          return skillSuccess(request.parse({ explanations: [{ id: entry.id, explanationZh: derivedExplanation }] }));
        }
        throw new Error(`unexpected generate:listening call:\n${request.prompt.slice(0, 200)}`);
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet(
        "listening",
        { runSkillTask: runSkillTask as never, planner, tts: fakeSynthesize, probeDuration: fakeProbeDuration },
      );
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(rewriteCalls).toBe(1);
      const publishedPath = publishedSetPath(setId);
      const parsed = AnySetSchema.parse(JSON.parse(fs.readFileSync(publishedPath, "utf8")));
      if (parsed.kind !== "listening") throw new Error("unreachable");
      const publishedItem = parsed.router.listenChoose.find((i) => i.id === targetId)!;
      // The published Explanation names the key by its own text, which is possible only because the
      // prompt carried the options. A context-free prompt cannot produce this string.
      expect(publishedItem.explanationZh).toBe(derivedExplanation);
      expect(publishedItem.explanationZh).toContain(keyText);
      expect(publishedItem.utterance).toBe(targetUtterance);
      expect(listeningContentViolations(parsed).filter((v) => v.kind === "explanation-position-reference")).toHaveLength(0);
      fs.rmSync(publishedPath);
      fs.rmSync(audioDirPath(setId), { recursive: true, force: true });
    } catch (err) {
      cleanupSetArtifacts(setId!);
      throw err;
    }
  });

  it("sends a flagged Stimulus QUESTION its stem, options, key, explanation AND its Stimulus's transcript", async () => {
    const dataDir = listeningDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    const conversation = candidate.router.conversations[0]!;
    const target = conversation.questions[0]!;
    target.explanationZh = "對話明確提到該時間,答案為選項一。";
    const targetId = target.id;

    let rewriteCalls = 0;
    let derivedExplanation = "";
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") return skillSuccess(request.parse(plan));
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) return skillSuccess(request.parse(candidate));
        if (request.prompt.includes("```explanation-rewrite")) {
          rewriteCalls += 1;
          const payload = parseRewritePayload(request.prompt);
          const entry = payload.flagged.find((f) => f.id === targetId)!;
          expect(entry.taskType).toBe("conversation");
          expect(entry.stem).toBe(target.stem);
          expect(entry.options.map((o) => o.text)).toEqual(target.options.map((o) => o.text));
          expect(entry.explanationZh).toBe("對話明確提到該時間,答案為選項一。");
          // The owning Stimulus's transcript rides along once, resolvable by stimulusId, the same
          // shape the verify payload uses.
          expect(entry.stimulusId).toBe(conversation.id);
          const stimulus = payload.stimuli.find((s) => s.id === conversation.id)!;
          expect(stimulus.transcript).toEqual(conversation.transcript);
          // Derived from the stem and the transcript the prompt carried, not from a literal. This
          // fixture's option texts are "Option A"/"Option B", which are themselves label-shaped, so
          // quoting one would trip the position detector on the way back in; the assertions just
          // above prove the options are present.
          const firstTurn = (stimulus.transcript as { text: string }[])[0]!.text.slice(0, 24);
          derivedExplanation = `題幹「${entry.stem}」的正解對應對話開頭「${firstTurn}」;其餘選項未被提及。`;
          return skillSuccess(request.parse({ explanations: [{ id: entry.id, explanationZh: derivedExplanation }] }));
        }
        throw new Error(`unexpected generate:listening call:\n${request.prompt.slice(0, 200)}`);
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet(
        "listening",
        { runSkillTask: runSkillTask as never, planner, tts: fakeSynthesize, probeDuration: fakeProbeDuration },
      );
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(rewriteCalls).toBe(1);
      const publishedPath = publishedSetPath(setId);
      const parsed = AnySetSchema.parse(JSON.parse(fs.readFileSync(publishedPath, "utf8")));
      if (parsed.kind !== "listening") throw new Error("unreachable");
      const publishedQuestion = parsed.router.conversations
        .flatMap((c) => c.questions)
        .find((q) => q.id === targetId)!;
      expect(publishedQuestion.explanationZh).toBe(derivedExplanation);
      expect(publishedQuestion.explanationZh).toContain(target.stem);
      expect(publishedQuestion.explanationZh).toContain(conversation.transcript[0]!.text.slice(0, 24));
      expect(listeningContentViolations(parsed).filter((v) => v.kind === "explanation-position-reference")).toHaveLength(0);
      fs.rmSync(publishedPath);
      fs.rmSync(audioDirPath(setId), { recursive: true, force: true });
    } catch (err) {
      cleanupSetArtifacts(setId!);
      throw err;
    }
  });
});

// The word-count check counts words, not whitespace tokens, so a stray punctuation token cannot
// lift a transcript over its floor. The retired Set lsn-14659f38 carries a real case.
describe("listeningContentViolations: word count counts words, not whitespace tokens", () => {
  it("flags a retired Set's 79-word Conversation under the 80-word floor, which a whitespace split would count as 81", () => {
    const parsed = retiredListeningSet();

    const convLo2 = LISTENING_MODULE_NAMES.flatMap((m) => parsed[m].conversations).find((c) => c.id === "conv-lo2");
    expect(convLo2, "fixture error: conv-lo2 not found in lsn-14659f38.json").toBeDefined();

    const realWordCount = convLo2!.transcript.reduce(
      (sum, turn) => sum + turn.text.trim().split(/\s+/u).filter((t) => /\p{L}|\p{N}/u.test(t)).length,
      0,
    );
    const naiveTokenCount = convLo2!.transcript.reduce(
      (sum, turn) => sum + turn.text.trim().split(/\s+/u).filter(Boolean).length,
      0,
    );
    expect(realWordCount).toBe(79);
    expect(naiveTokenCount).toBe(81); // a whitespace split would clear the 80-word floor

    // The whole published Set goes through the gate, so the content gate itself, not a hand-rolled
    // count, is what flags it.
    const violations = listeningContentViolations(parsed);
    const wordCountViolation = violations.find((v) => v.kind === "word-count" && v.id === "conv-lo2");
    expect(wordCountViolation).toBeDefined();
    expect(wordCountViolation!.detail).toContain("79 words");
  });
});

// A violation's `detail` flows through formatListeningViolations into thrown Error messages, and
// from there into job.error, the API response and the Dashboard, so it never carries Set content:
// no Explanation, stem or option text, and above all no Listen and Choose a Response utterance,
// which is never shown as text. The text the model needs to fix a flagged Item or Stimulus travels
// in the regeneration prompt, which serializes the Item itself. Both tests use a CJK sentinel so
// the language check (CJK_RE) genuinely fires; an ASCII-only sentinel would trigger nothing.
describe("content-leak prevention", () => {
  const CONTENT_SENTINEL = "機密SENTINEL_LEAK_TOKEN";

  it("never embeds flagged content text — especially the LCR utterance — in a thrown deterministicListeningPreChecks message, even when a content-bearing violation is 'also present' alongside a blocking one", () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    const original = candidate.router.listenChoose[0]!;
    const flaggedId = original.id;
    const broken = {
      ...candidate,
      router: {
        ...candidate.router,
        listenChoose: [
          { ...original, utterance: `${original.utterance} ${CONTENT_SENTINEL}` },
          // Drops one entry too, so router's listenChoose length does not match
          // LISTENING_MODULE_COMPOSITION: a blocking "composition" violation, which is what makes
          // deterministicListeningPreChecks throw. The item-language violation above is remediable
          // and would not throw by itself, and the error lists it as "also present", which is where
          // its content could leak.
          ...candidate.router.listenChoose.slice(2),
        ],
      },
    };

    let thrown: unknown;
    try {
      deterministicListeningPreChecks(broken);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).not.toContain(CONTENT_SENTINEL);
    // Diagnostic addressability survives the scrub: kind, label and id are still fully named.
    expect(message).toContain("item-language");
    expect(message).toContain(flaggedId);
    expect(message).toContain("composition");
  });

  it("sends the flagged content to the model on the regeneration prompt, though the diagnostic detail does not carry it", async () => {
    const candidate = assignSpeakerRendering(buildCandidate());
    const original = candidate.router.listenChoose[0]!;
    const flaggedId = original.id;
    const broken = {
      ...candidate,
      router: {
        ...candidate.router,
        listenChoose: [
          { ...original, utterance: `${original.utterance} ${CONTENT_SENTINEL}` },
          ...candidate.router.listenChoose.slice(1),
        ],
      },
    };

    let sawSentinelOnGenerateCall = false;
    const run = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "verify") {
        const match = /```json\n([\s\S]*?)\n```/.exec(request.prompt)!;
        const payload = JSON.parse(match[1]!) as {
          listenChooseItems: { id: string }[]; stimuli: { id: string }[]; questions: { id: string }[];
        };
        return skillSuccess(request.parse({
          listenChooseItems: payload.listenChooseItems.map((i) => ({ id: i.id, verdict: "ok" as const })),
          stimuli: payload.stimuli.map((s) => ({ id: s.id, verdict: "ok" as const })),
          questions: payload.questions.map((q) => ({ id: q.id, verdict: "ok" as const })),
        }));
      }
      // generate:listening — the only remediation this fixture can trigger is the LCR
      // conformance-free "regenerate this one item" call (regenerateFlaggedLcrItems).
      if (request.prompt.includes(CONTENT_SENTINEL)) sawSentinelOnGenerateCall = true;
      return skillSuccess(request.parse({
        items: [{
          id: flaggedId,
          utterance: original.utterance, // sentinel-free replacement
          options: original.options,
          correctOptionId: original.correctOptionId,
          skill: original.skill,
          explanationZh: original.explanationZh,
        }],
      }));
    });

    const result = await verifyListeningSet(broken, run as never, undefined, "lsn-test");
    expect(sawSentinelOnGenerateCall).toBe(true);
    const repaired = result.router.listenChoose.find((item) => item.id === flaggedId)!;
    expect(repaired.utterance).not.toContain(CONTENT_SENTINEL);
  });
});

// The Verifier's `reason` strings are model-authored and, grounded in full transcripts, can quote a
// transcript line, so they must never reach verifyListeningSet's exhaustion error (and from it
// job.error, the API and the Dashboard). `SafeDiagnostic`, a branded string type, makes
// interpolating a plain string into a thrown message in listeningGenerator.ts a compile-time error,
// and `summarizeFlaggedIds` is the only sanctioned way to describe flagged entries there: ids and
// counts only. Sentinels are planted in all three Verifier reason channels at once (an LCR "issue",
// a Stimulus "unanswerable" and a question "issue"), so the test covers the class, not one site.
describe("verify-exhaustion diagnostic boundary", () => {
  it("never lets a Verifier-authored reason (LCR issue, unanswerable stimulus, or question issue) reach the verify-exhaustion throw, even though every one of the three keeps being re-flagged for all 5 rounds", async () => {
    const SENTINEL_LCR = "機密LCR_REASON_SENTINEL";
    const SENTINEL_STIM = "機密STIMULUS_REASON_SENTINEL";
    const SENTINEL_Q = "機密QUESTION_REASON_SENTINEL";

    const set = assignSpeakerRendering(buildCandidate());
    const lcrId = set.router.listenChoose[0]!.id;
    const stimulusId = set.router.announcements[0]!.id;
    const questionId = set.router.conversations[0]!.questions[0]!.id;

    let verifyCalls = 0;
    const run = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "verify") {
        verifyCalls += 1;
        const match = /```json\n([\s\S]*?)\n```/.exec(request.prompt)!;
        const payload = JSON.parse(match[1]!) as {
          listenChooseItems: { id: string }[]; stimuli: { id: string }[]; questions: { id: string }[];
        };
        // Re-flags the same three targets every round, whatever they currently hold, so all 5 rounds
        // are spent and the exhaustion error fires: the test exercises that error, not a mid-loop
        // remediation path.
        return skillSuccess(request.parse({
          listenChooseItems: payload.listenChooseItems.map((i) =>
            i.id === lcrId
              ? { id: i.id, verdict: "issue" as const, reason: `the utterance quotes itself: "${SENTINEL_LCR}"` }
              : { id: i.id, verdict: "ok" as const },
          ),
          stimuli: payload.stimuli.map((s) =>
            s.id === stimulusId
              ? { id: s.id, verdict: "unanswerable" as const, reason: `the transcript only says "${SENTINEL_STIM}"` }
              : { id: s.id, verdict: "ok" as const },
          ),
          questions: payload.questions.map((q) =>
            q.id === questionId
              ? { id: q.id, verdict: "issue" as const, reason: `the key contradicts the line "${SENTINEL_Q}"` }
              : { id: q.id, verdict: "ok" as const },
          ),
        }));
      }
      // generate:listening. Every regeneration reply is schema-valid, complete and sentinel-free, so
      // the loop proceeds normally; it is the verify fake above, not these replies, that keeps
      // re-flagging the same three targets every round.
      if (request.prompt.includes("```lcr-regeneration")) {
        const target = set.router.listenChoose[0]!;
        return skillSuccess(request.parse({
          items: [{ id: lcrId, utterance: target.utterance, options: target.options, correctOptionId: target.correctOptionId, skill: target.skill, explanationZh: target.explanationZh }],
        }));
      }
      if (request.prompt.includes("```stimulus-regeneration")) {
        return skillSuccess(request.parse({
          transcript: wordsOfLength(60, `${stimulusId}fixedw`),
          questions: [mcq(`${stimulusId}-q1`, "c"), mcq(`${stimulusId}-q2`, "a")],
        }));
      }
      if (request.prompt.includes("```question-regeneration")) {
        return skillSuccess(request.parse({ questions: [mcq(questionId, "a")] }));
      }
      throw new Error(`unexpected generate:listening call:\n${request.prompt.slice(0, 200)}`);
    });

    let thrown: unknown;
    try {
      await verifyListeningSet(set, run as never, undefined, "lsn-test");
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain("unresolved issues after 5 verify attempts");
    // None of the three sentinels, one per Verifier reason channel, reaches the thrown message.
    expect(message).not.toContain(SENTINEL_LCR);
    expect(message).not.toContain(SENTINEL_STIM);
    expect(message).not.toContain(SENTINEL_Q);
    // Diagnostic addressability survives: every flagged id is still named.
    expect(message).toContain(lcrId);
    expect(message).toContain(stimulusId);
    expect(message).toContain(questionId);
    expect(verifyCalls).toBe(5);
  });
});

// regenerateFlaggedStimuli is not batched, so its cost is bounded by a per-round cap
// (MAX_STIMULUS_REPAIRS_PER_ROUND, 4). Skipping every flagged Stimulus above the cap would be a
// guaranteed failure: verifyListeningSet re-measures the same unchanged transcript each round. The
// cap must therefore defer, not drop: regenerate up to the cap every round so the flagged set
// converges across rounds.
describe("regenerateFlaggedStimuli defers what is over its per-round cap", () => {
  it("regenerates 4 of 5 flagged Stimuli in round 1 and the fifth in round 2, then passes", async () => {
    const set = assignSpeakerRendering(buildCandidate());
    // Five real Stimuli, one more than the cap, all flagged "unanswerable" until repaired: the
    // router's 3 Conversations and its Academic Talk, and the Lower Module's first Conversation.
    const targetIds = [
      set.router.conversations[0]!.id,
      set.router.conversations[1]!.id,
      set.router.conversations[2]!.id,
      set.router.academicTalks[0]!.id,
      set.lowerModule.conversations[0]!.id,
    ];
    expect(new Set(targetIds).size).toBe(5);

    const repaired = new Set<string>();
    // The verify round each regeneration call happened after, by Stimulus id.
    const repairedInRound = new Map<string, number>();
    let verifyCalls = 0;
    const run = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "verify") {
        verifyCalls += 1;
        const match = /```json\n([\s\S]*?)\n```/.exec(request.prompt)!;
        const payload = JSON.parse(match[1]!) as {
          listenChooseItems: { id: string }[]; stimuli: { id: string }[]; questions: { id: string }[];
        };
        return skillSuccess(request.parse({
          listenChooseItems: payload.listenChooseItems.map((i) => ({ id: i.id, verdict: "ok" as const })),
          stimuli: payload.stimuli.map((s) =>
            targetIds.includes(s.id) && !repaired.has(s.id)
              ? { id: s.id, verdict: "unanswerable" as const, reason: "stuck until repaired, for this test" }
              : { id: s.id, verdict: "ok" as const },
          ),
          questions: payload.questions.map((q) => ({ id: q.id, verdict: "ok" as const })),
        }));
      }
      if (request.prompt.includes("```stimulus-regeneration")) {
        const payload = JSON.parse(/```stimulus-regeneration\n([\s\S]*?)\n```/.exec(request.prompt)![1]!) as {
          stimulusId: string; taskType: "conversation" | "announcement" | "academic_talk";
        };
        expect(repairedInRound.has(payload.stimulusId), `${payload.stimulusId} regenerated twice`).toBe(false);
        repairedInRound.set(payload.stimulusId, verifyCalls);
        repaired.add(payload.stimulusId);
        if (payload.taskType === "conversation") {
          return skillSuccess(request.parse({
            transcript: [
              { speakerId: `${payload.stimulusId}-sp1`, text: wordsOfLength(45, `${payload.stimulusId}fixedt1w`) },
              { speakerId: `${payload.stimulusId}-sp2`, text: wordsOfLength(45, `${payload.stimulusId}fixedt2w`) },
            ],
            questions: [mcq(`${payload.stimulusId}-q1`, "a"), mcq(`${payload.stimulusId}-q2`, "b")],
          }));
        }
        return skillSuccess(request.parse({
          transcript: wordsOfLength(200, `${payload.stimulusId}fixedw`), // inside the 175-250 talk gate
          questions: [mcq(`${payload.stimulusId}-q1`, "b"), mcq(`${payload.stimulusId}-q2`, "a"), mcq(`${payload.stimulusId}-q3`, "c"), mcq(`${payload.stimulusId}-q4`, "b")],
        }));
      }
      throw new Error(`unexpected generate:listening call:\n${request.prompt.slice(0, 200)}`);
    });

    const result = await verifyListeningSet(set, run as never, undefined, "lsn-test");

    // Round 1 regenerates exactly the cap's worth, round 2 the one it deferred, and round 3 finds
    // nothing left to flag.
    const inRound = (round: number) => targetIds.filter((id) => repairedInRound.get(id) === round);
    expect(inRound(1)).toHaveLength(4);
    expect(inRound(2)).toHaveLength(1);
    expect([...inRound(1), ...inRound(2)].sort()).toEqual([...targetIds].sort());
    expect(verifyCalls).toBe(3);
    expect(result).toBeDefined();
  });
});

// The sentinel tests above cover the sites that exist; only a type-level pin catches a new one. A
// plain string, such as a template literal interpolating a Verifier `.reason`, must not be
// assignable where a SafeDiagnostic feeds a thrown message, and the compiler is what rejects it. If
// either assignment below ever stops being a type error (a refactor widening `detail` or `parts`
// back to `string`), its expect-error directive itself fails to compile, which a runtime assertion
// could never detect.
describe("SafeDiagnostic boundary is enforced at compile time, not by convention", () => {
  it("rejects a plain string assigned to ListeningContentViolation.detail", () => {
    const modelText = "the utterance quotes itself: 機密LEAK_TOKEN"; // stands in for a Verifier .reason or any raw model text
    const violation: ListeningContentViolation = {
      kind: "item-language",
      label: "router/listen_choose/lcr-r1",
      id: "lcr-r1",
      // @ts-expect-error a plain string (e.g. a Verifier .reason, or any unbranded template literal)
      // must not be assignable to `detail`: it is what a content-gate check would write if it put
      // raw model text into a diagnostic.
      detail: modelText,
    };
    void violation;
  });

  it("rejects a raw template literal interpolating `.reason` where a SafeDiagnostic[] feeding a thrown message is expected", () => {
    const fakeIssues = [{ id: "ann-r2", reason: 'the transcript only says "X"' }];
    // Build a message by interpolating `.reason` into a template literal, and try to put it where
    // the exhaustion error's `parts: SafeDiagnostic[]` array expects only vetted, branded fragments.
    const parts: SafeDiagnostic[] = [
      // @ts-expect-error a raw template literal interpolating a Verifier `.reason` is a plain
      // `string`, not SafeDiagnostic, so it must not typecheck in a thrown message's parts.
      `${fakeIssues.length} unanswerable stimulus/stimuli: ${fakeIssues.map((i) => `${i.id} (${i.reason})`).join("; ")}`,
    ];
    void parts;
  });
});

describe("listening content gate: advisory tier", () => {
  it("publishes a Set whose surviving violation is advisory, and records it as a content-gate note", async () => {
    policyOverride.advisoryListeningKinds.add("item-language");
    const dataDir = listeningDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    // 繁體中文 in a non-key option: `item-language`'s exact trigger, placed on an option that cannot
    // also trip the set-wide option-length-bias check by becoming the longest one.
    candidate.router.conversations[0]!.questions[0]!.options[1]!.text = "Option 乙";
    const runSkillTask = buildRunSkillTask(plan, candidate);

    let setId = "";
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("listening", {
        runSkillTask: runSkillTask as never,
        planner,
        tts: fakeSynthesize,
        probeDuration: fakeProbeDuration,
      });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      policyOverride.advisoryListeningKinds.delete("item-language");
    }

    try {
      // An advisory finding publishes the Set and is recorded on it, rather than failing a fully paid
      // run with "unresolved issues after 5 verify attempts".
      const parsed = AnySetSchema.parse(JSON.parse(fs.readFileSync(publishedSetPath(setId), "utf8")));
      const notes = (parsed.advisoryNotes ?? []).filter((note) => note.check === "content-gate");
      expect(notes.map((note) => note.detail)).toContain("item-language");
      // Read back off the violation's own `${module}/${taskType}/${id}` label, exactly as Reading does.
      expect(notes.find((note) => note.detail === "item-language")?.taskType).toBe("conversation");
      // And the loop does not wait on it: one verify round, not the full budget. An advisory kind has
      // no remediation route, so counting it as unresolved would only spend five paid calls
      // re-finding it unchanged.
      const verifyCalls = runSkillTask.mock.calls.filter(([request]) => request.task.task === "verify");
      expect(verifyCalls).toHaveLength(1);
    } finally {
      cleanupSetArtifacts(setId);
    }
  });
});

// The Academic Talk register check.
//
// The guide tells the model an Academic Talk needs "vocabulary that is sometimes uncommon,
// colloquial, or idiomatic" and a rhetorical pattern (ETS RR-25-12). No deterministic detector for
// lexical rarity exists that would not be an invented number, and moduleDifficulty.ts's header rules
// out an absolute readability band for Listening ("ETS publishes CEFR levels for its Listening tasks
// but no readability range for spoken text"). So the check rides the Verifier call that already
// reads every transcript, as a third `stimuli` verdict.
//
// Its tier is the point. A talk in plain vocabulary is usable and teaches nothing wrong, so ADR 0006
// forbids blocking on it ("Similarity and taste are recorded, never fatal"), but a finding that
// never buys a repair is not a check either. `repair-then-accept -> advisory`: counted as
// outstanding while repair rounds remain, not counted on the last one.
describe("verify: Academic Talk register verdict", () => {
  it("asks the Verifier for the register verdict, on Academic Talks only", async () => {
    const set = assignSpeakerRendering(buildCandidate());
    let verifyPrompt = "";
    const run = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "verify") {
        verifyPrompt = request.prompt;
        return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
      }
      throw new Error(`unexpected generate:listening call:\n${request.prompt.slice(0, 200)}`);
    });

    await verifyListeningSet(set, run as never, undefined, "lsn-test");

    expect(verifyPrompt).toContain("\"register\"");
    expect(verifyPrompt).toContain("uncommon, colloquial or idiomatic");
    expect(verifyPrompt).toContain("compare/contrast");
    expect(verifyPrompt).toContain("academic_talk");
    // Conversations and Announcements are A2-C1 tasks with no such requirement, and their transcripts
    // are a fraction of a talk's — asking about their register would only manufacture repairs.
    expect(verifyPrompt).toContain("Never give \"register\" to a Conversation or an Announcement.");
  });

  it("regenerates a talk flagged \"register\", carrying the Verifier's own reason into the repair", async () => {
    const set = assignSpeakerRendering(buildCandidate());
    const talkId = set.router.academicTalks[0]!.id;
    const repaired = new Set<string>();
    const regenerated: { stimulusId: string; taskType: string; reason: string }[] = [];

    const run = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "verify") {
        const payload = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(request.prompt)![1]!) as {
          listenChooseItems: { id: string }[]; stimuli: { id: string }[]; questions: { id: string }[];
        };
        return skillSuccess(request.parse({
          listenChooseItems: payload.listenChooseItems.map((i) => ({ id: i.id, verdict: "ok" as const })),
          stimuli: payload.stimuli.map((s) =>
            s.id === talkId && !repaired.has(s.id)
              ? { id: s.id, verdict: "register" as const, reason: "every word is high-frequency; no idiom and no compare/contrast" }
              : { id: s.id, verdict: "ok" as const },
          ),
          questions: payload.questions.map((q) => ({ id: q.id, verdict: "ok" as const })),
        }));
      }
      const payload = JSON.parse(/```stimulus-regeneration\n([\s\S]*?)\n```/.exec(request.prompt)![1]!) as {
        stimulusId: string; taskType: string; reason: string;
      };
      regenerated.push(payload);
      repaired.add(payload.stimulusId);
      return skillSuccess(request.parse({
        transcript: wordsOfLength(200, `${payload.stimulusId}fixedw`),
        questions: [mcq(`${payload.stimulusId}-q1`, "b"), mcq(`${payload.stimulusId}-q2`, "a"), mcq(`${payload.stimulusId}-q3`, "c"), mcq(`${payload.stimulusId}-q4`, "b")],
      }));
    });

    const result = await verifyListeningSet(set, run as never, undefined, "lsn-test");

    // One repair, through the same whole-Stimulus route "unanswerable" uses: a fresh
    // transcript needs fresh questions, because the old ones answered the old talk.
    expect(regenerated).toHaveLength(1);
    expect(regenerated[0]!.stimulusId).toBe(talkId);
    expect(regenerated[0]!.taskType).toBe("academic_talk");
    expect(regenerated[0]!.reason).toContain("no idiom");
    expect(result.router.academicTalks[0]!.transcript).toContain("fixedw");
    // A finding the repair cleared is not a finding the Set publishes with. The policy assigns its
    // surviving-register state every round, so round 2's clean verdict wipes round 1's.
    expect(result.advisoryNotes).toBeUndefined();
  });

  it("publishes the Set — never fails the job — when the flag survives every repair round, and records it", async () => {
    const set = assignSpeakerRendering(buildCandidate());
    const talkId = set.router.academicTalks[0]!.id;
    let regenerationCalls = 0;
    let verifyCalls = 0;

    // Never cleared: the model rewrites the talk each round and the Verifier is unconvinced each
    // round. This is the exact shape that would burn a fully paid run if the verdict blocked.
    const run = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "verify") {
        verifyCalls += 1;
        const payload = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(request.prompt)![1]!) as {
          listenChooseItems: { id: string }[]; stimuli: { id: string }[]; questions: { id: string }[];
        };
        return skillSuccess(request.parse({
          listenChooseItems: payload.listenChooseItems.map((i) => ({ id: i.id, verdict: "ok" as const })),
          stimuli: payload.stimuli.map((s) =>
            s.id === talkId
              ? { id: s.id, verdict: "register" as const, reason: "still plain, for this test" }
              : { id: s.id, verdict: "ok" as const },
          ),
          questions: payload.questions.map((q) => ({ id: q.id, verdict: "ok" as const })),
        }));
      }
      regenerationCalls += 1;
      const payload = JSON.parse(/```stimulus-regeneration\n([\s\S]*?)\n```/.exec(request.prompt)![1]!) as {
        stimulusId: string;
      };
      return skillSuccess(request.parse({
        transcript: wordsOfLength(200, `${payload.stimulusId}fixedw`),
        questions: [mcq(`${payload.stimulusId}-q1`, "b"), mcq(`${payload.stimulusId}-q2`, "a"), mcq(`${payload.stimulusId}-q3`, "c"), mcq(`${payload.stimulusId}-q4`, "b")],
      }));
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let result;
    // Read the calls before restoring: mockRestore also resets the recorded calls.
    let warnCalls: unknown[][] = [];
    try {
      result = await verifyListeningSet(set, run as never, undefined, "lsn-test");
      warnCalls = warn.mock.calls;
    } finally {
      warn.mockRestore();
    }

    // It got every repair round the blocking verdicts get. The loop never dispatches remediations on
    // the final round, so that is MAX_VERIFY_ATTEMPTS - 1 attempts at fixing it...
    //
    // This also pins the tier arithmetic at both ends. The verdict is counted as outstanding on every
    // round but the loop's own last one; if that ever inverts (a budget change, a termination change,
    // an off-by-one in the tier), the loop reaches its final round with a finding it must treat as
    // blocking and throws instead of resolving here.
    expect(verifyCalls).toBe(MAX_VERIFY_ATTEMPTS);
    expect(regenerationCalls).toBe(MAX_VERIFY_ATTEMPTS - 1);
    // ...and then the Set publishes anyway, which is the whole difference from "unanswerable".
    expect(result).toBeDefined();
    // Recorded, not merely warned about: ADR 0006's advisory tier records the issue on the Set, and
    // a console line is gone by the time anyone opens the Set. Positions and a server-authored label
    // only, no id and no Verifier prose.
    expect(result.advisoryNotes).toEqual([
      { check: "talk-register", detail: "below-task-register", taskType: "academic_talk", itemPosition: 0 },
    ]);
    expect(JSON.stringify(result.advisoryNotes)).not.toContain("still plain, for this test");
    // Never silent for the operator either: ids and counts, never the Verifier's own `.reason`
    // (transcript-quoting prose).
    const warned = warnCalls.map((call) => call.join(" ")).join("\n");
    expect(warned).toContain(talkId);
    expect(warned).toContain("below");
    expect(warned).not.toContain("still plain, for this test");
  });

  // The note names its talk by global position, in the router-then-lower-then-upper order every
  // other Listening itemPosition uses (the Plan arrays the diversity checks index into). A
  // per-module index would put the upper module's second talk at 1, which is the router's talk to
  // anything that reads the note back.
  it("names the surviving talk by its position in the Set, not within its own module", async () => {
    const set = assignSpeakerRendering(buildCandidate());
    const talkId = set.upperModule.academicTalks[1]!.id;

    const run = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "verify") {
        const payload = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(request.prompt)![1]!) as {
          listenChooseItems: { id: string }[]; stimuli: { id: string }[]; questions: { id: string }[];
        };
        return skillSuccess(request.parse({
          listenChooseItems: payload.listenChooseItems.map((i) => ({ id: i.id, verdict: "ok" as const })),
          stimuli: payload.stimuli.map((s) =>
            s.id === talkId
              ? { id: s.id, verdict: "register" as const, reason: "still plain, for this test" }
              : { id: s.id, verdict: "ok" as const },
          ),
          questions: payload.questions.map((q) => ({ id: q.id, verdict: "ok" as const })),
        }));
      }
      const payload = JSON.parse(/```stimulus-regeneration\n([\s\S]*?)\n```/.exec(request.prompt)![1]!) as {
        stimulusId: string;
      };
      return skillSuccess(request.parse({
        transcript: wordsOfLength(200, `${payload.stimulusId}fixedw`),
        questions: [mcq(`${payload.stimulusId}-q1`, "b"), mcq(`${payload.stimulusId}-q2`, "a"), mcq(`${payload.stimulusId}-q3`, "c"), mcq(`${payload.stimulusId}-q4`, "b")],
      }));
    });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let result;
    try {
      result = await verifyListeningSet(set, run as never, undefined, "lsn-test");
    } finally {
      warn.mockRestore();
    }

    // router 1 talk + lowerModule 0 + upperModule index 1 => 2.
    expect(result.advisoryNotes?.map((note) => note.itemPosition)).toEqual([2]);
  });

  // "Academic Talks only" is enforced in code, not only in the verify prompt's prose: the schema arm
  // takes a bare string id, and a model gives the verdict to other Stimuli anyway. Honoured, a stray
  // "register" verdict would buy up to four paid whole-Stimulus regenerations of clean content, each
  // a fresh chance at an unanswerable transcript, hold off the loop's early return for those rounds,
  // and block that Stimulus's cheaper question and explanation repairs meanwhile.
  for (const population of ["conversations", "announcements"] as const) {
    it(`drops a "register" verdict on a ${population.slice(0, -1)} id instead of paying to regenerate it`, async () => {
      const set = assignSpeakerRendering(buildCandidate());
      const strayId = set.router[population][0]!.id;
      let verifyCalls = 0;

      const run = vi.fn(async (request: SkillTaskRequest<unknown>) => {
        if (request.task.task !== "verify") {
          // A dropped verdict must cost nothing: any regeneration call reaching this fixture fails
          // the test.
          throw new Error(`unexpected regeneration call:\n${request.prompt.slice(0, 200)}`);
        }
        verifyCalls += 1;
        const payload = JSON.parse(/```json\n([\s\S]*?)\n```/.exec(request.prompt)![1]!) as {
          listenChooseItems: { id: string }[]; stimuli: { id: string }[]; questions: { id: string }[];
        };
        return skillSuccess(request.parse({
          listenChooseItems: payload.listenChooseItems.map((i) => ({ id: i.id, verdict: "ok" as const })),
          stimuli: payload.stimuli.map((s) =>
            s.id === strayId
              ? { id: s.id, verdict: "register" as const, reason: "this reason quotes the transcript verbatim" }
              : { id: s.id, verdict: "ok" as const },
          ),
          questions: payload.questions.map((q) => ({ id: q.id, verdict: "ok" as const })),
        }));
      });

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let result;
      let warnCalls: unknown[][] = [];
      try {
        result = await verifyListeningSet(set, run as never, undefined, "lsn-test");
        warnCalls = warn.mock.calls;
      } finally {
        warn.mockRestore();
      }

      // Not counted: the round is clean, so the loop returns on the first verify call rather than
      // spending its whole budget re-finding a verdict it can never satisfy.
      expect(verifyCalls).toBe(1);
      expect(run).toHaveBeenCalledTimes(1);
      // Not merged into the regeneration targets either: the transcript is byte-identical.
      expect(result.router[population][0]!.transcript).toEqual(set.router[population][0]!.transcript);
      // Dropped, but never silently: a structured operator diagnostic of ids and counts, and never
      // the Verifier's own `.reason` (transcript-quoting prose).
      const warned = warnCalls.map((call) => call.join(" ")).join("\n");
      expect(warned).toContain("dropping");
      expect(warned).toContain(strayId);
      expect(warned).not.toContain("quotes the transcript verbatim");
      // And it is not a finding about the Set either: nothing to record, so nothing recorded.
      expect(result.advisoryNotes).toBeUndefined();
    });
  }
});

// The pace bands and the duration they are measured against belong together, and this is where
// that is enforced. `LISTENING_ROLE_POLICY`'s numbers denote speech rate. Measuring the file
// instead counts about 0.68 s of Gemini's fixed padding as speech, about 24% of a Listen and Choose
// a Response utterance, so clips would read slow and buy corrective re-renders that cannot land.
// Changing either the bands or the measurement without the other recreates that futile spend.
//
// So this test omits `probeDuration` from the deps, the only test in this file that does, and
// watches which of the two transcode probes the production default reaches for.
// listeningAudioRenderer.test.ts pins the band values; between them the pair cannot drift apart
// silently.
describe("generateSet (listening): the render measures speech duration by default", () => {
  it("uses probeSpeechDurationSec, never probeDurationSec, when the caller injects no prober", async () => {
    transcodeSpies.probeSpeechDurationSec.mockClear();
    transcodeSpies.probeDurationSec.mockClear();
    const dataDir = listeningDataDir();
    const runSkillTask = buildRunSkillTask(buildPlan(), buildCandidate());

    let setId = "";
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("listening", {
        runSkillTask: runSkillTask as never,
        planner,
        tts: fakeSynthesize,
        // probeDuration omitted: the production default is the subject here.
      });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(transcodeSpies.probeSpeechDurationSec.mock.calls.length).toBeGreaterThan(0);
      expect(transcodeSpies.probeDurationSec).not.toHaveBeenCalled();
      // Every clip of the Set went through it, not just the first: measuring some roles on one scale
      // and some on the other would be worse than either.
      const manifest = JSON.parse(
        fs.readFileSync(path.join(audioDirPath(setId), "audio-manifest.json"), "utf8"),
      ) as { clips: { file: string }[] };
      const probedFiles = new Set(transcodeSpies.probeSpeechDurationSec.mock.calls.map(([file]) => file));
      expect(probedFiles.size).toBe(manifest.clips.length);
    } finally {
      cleanupSetArtifacts(setId);
    }
  }, 30_000);
});
