import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { skillSuccess } from "./helpers/skillResults.js";
import { readBankSet } from "./helpers/setFixtures.js";
import {
  AnySetSchema,
  READING_MODULE_COMPOSITION,
  readingPlanEntryCount,
  type ReadingModule,
  type ReadingSet,
} from "@toefl-prep/shared";
import { generateSet, type GenerationProgress } from "../src/services/generator.js";
import { createGenerationPlanner } from "../src/services/generationPlanner.js";
import { config } from "../src/lib/config.js";
import { deriveCtwGaps } from "../src/services/ctest.js";
import { assembledReadingSet } from "./helpers/readingVerifyFixture.js";
import {
  contentWordLeakedGapIds,
  deterministicReadingPreChecks,
  leakedCtwGapIds,
  READING_MODULE_NAMES,
  readingContentViolations,
  rebalanceReadingOptionOrder,
  readingRemediationRoute,
  REMEDIABLE_VIOLATION_KINDS,
} from "../src/services/readingGenerator.js";
import { blocksGeneration, classifyGenerationCheck } from "../src/services/generationCheckPolicy.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";

/** A module carrying nothing, for the direct gate cases that exercise one module at a time. */
function emptyReadingModule(): ReadingModule {
  return { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] };
}

// The canned model output for every CtW passage in this suite: a paragraph written for these tests,
// the same text as test/ctest.test.ts's SAMPLE_CTW_PARAGRAPH, so the published gaps can be compared
// with the deterministic derivation that file pins by hand. What the tests below rely on:
//   • 75 words, inside the 70-100 budget, so OVER_LONG_CTW_PARAGRAPH can push it past the ceiling
//     with one added sentence;
//   • exactly ten gaps (long, that, trade, both, and, However, was, by, local, and);
//   • two gap words that also appear in plain text, "that" and "was", both function words, and no
//     repeated content word, so the ctw-gap-leak gate never fires on it;
//   • Flesch-Kincaid grade 11.50, above the router's and the lower module's 10.5 ceiling and inside
//     the upper module's high band, which fixes how many difficulty-band advisories a Set built
//     from buildCandidate carries.
const SAMPLE_CTW_PARAGRAPH =
  "Centuries before railways existed, merchants in medieval Europe moved most heavy goods on rivers " +
  "rather than over land. Historians long assumed that this trade was both cheap and simple. However, " +
  "it was controlled by many local authorities, and nearly every town along the banks collected tolls " +
  "from passing boats. Traders on longer journeys paid these charges repeatedly. Over time, the expense " +
  "encouraged them to form associations that bargained collectively with regional rulers for lower fees.";

// Sentence 1 intact ("Start now." — the boundary regex requires an uppercase letter right after the
// following whitespace, hence "One" capitalized), then exactly 18 eligible (length > 1) tokens after
// it — deriveCtwGaps gaps every 2nd one, so this derives to exactly floor(18/2) = 9 gaps, one short
// of the required 10. The derive-then-repair test below starts from it.
const NINE_GAP_PARAGRAPH =
  "Start now. One two three four five six seven eight nine ten eleven twelve thirteen fourteen " +
  "fifteen sixteen seventeen eighteen.";

const DAILY_LIFE_TEXT =
  "This notice explains paperless billing for the housing office. Residents may enroll through the " +
  "housing website or visit the front desk between nine and five on weekdays. Anyone who does not " +
  "enroll by the fifteenth will keep receiving a printed statement at the usual quarterly rate. " +
  "Direct any billing questions to the office manager rather than the mailroom.";

const ACADEMIC_TEXT =
  "Many adults experience a dip in alertness in the middle of the afternoon, regardless of how much " +
  "sleep they got the night before. Researchers have measured this dip using simple reaction-time " +
  "tasks: participants respond slightly slower to a flashing light around two oclock than they do at " +
  "ten in the morning or four in the afternoon. One explanation ties the dip to an internal rhythm " +
  "that runs roughly twice a day rather than once, producing a smaller trough after lunch in addition " +
  "to the larger one at night. A second explanation points to digestion, arguing that blood flow " +
  "shifts toward the stomach after a meal and briefly reduces alertness elsewhere. Neither explanation " +
  "fully accounts for the pattern on its own: the afternoon dip still appears, though smaller, in " +
  "volunteers who skip lunch entirely, which weakens the digestion account, while the rhythm account " +
  "struggles to explain why a short nap of ten to twenty minutes restores alertness almost " +
  "immediately. A brief nap, taken before the dip becomes severe, appears to be the most reliable " +
  "remedy studied so far, outperforming caffeine on tests of reaction time taken shortly afterward.";

/**
 * rd-6d02b750, a published Reading Set, read from this file's own copy of the bank. Two suites below
 * measure the content gate against it.
 */
function bankedReadingSet(): ReadingSet {
  const parsed = AnySetSchema.parse(readBankSet("reading", "rd-6d02b750"));
  if (parsed.kind !== "reading") throw new Error("fixture error: rd-6d02b750 is not a Reading Set");
  return parsed;
}

// Mirrors reasoning/skillContext.ts's SOURCE_PATHS for the three reading task keys ("plan:reading",
// "generate:reading", "verify:reading"). The Codex route composes its prompt from these files, so if
// either goes missing or moves, every reading plan, generate or verify call that reaches Codex fails
// reading its skill sources with ENOENT. No other test here would catch that: every other test
// injects runSkillTask directly and never touches skillContext.ts.
const READING_SOURCE_PATHS: Readonly<Record<"plan:reading" | "generate:reading" | "verify:reading", readonly string[]>> = {
  "plan:reading": [
    ".claude/skills/toefl-reading/SKILL.md",
    ".claude/skills/toefl-reading/references/generation-guide.md",
  ],
  "generate:reading": [
    ".claude/skills/toefl-reading/SKILL.md",
    ".claude/skills/toefl-reading/references/generation-guide.md",
  ],
  "verify:reading": [
    ".claude/skills/toefl-reading/SKILL.md",
    ".claude/skills/toefl-reading/references/generation-guide.md",
  ],
};

describe("toefl-reading skill SOURCE_PATHS", () => {
  for (const [key, relativePaths] of Object.entries(READING_SOURCE_PATHS)) {
    for (const relativePath of relativePaths) {
      it(`${key} source "${relativePath}" exists on disk`, () => {
        const absolutePath = path.join(config.projectRoot, relativePath);
        expect(fs.existsSync(absolutePath), `expected ${absolutePath} to exist`).toBe(true);
      });
    }
  }
});

// callGenerationSkillTask only turns a raw request into an onProgress event via the runner's own
// onEvent callback (see generationReasoning.ts) — a fake that never calls it produces no "planning"
// /"generating"/"verifying" progress at all, only the "saving" event generator.ts fires directly.
function emitRunning(request: SkillTaskRequest<unknown>): void {
  request.onEvent?.({ state: "running", provider: "claude" });
}

// ---------------------------------------------------------------------------
// Plan content — one shared shape per stimulus type, reused across every slot of that type. Novelty
// validation never checks same-Task-Type entries against each other within one plan (only
// cross-Task-Type and, for build_sentence only, intra-array balance — neither applies here), so
// four identical CtW plan entries and five identical daily-life plan entries are exactly as valid as
// distinct ones would be; keeping them identical keeps this fixture small.
// ---------------------------------------------------------------------------

function readingComponentPlanBase(slug: string, concepts: [string, string]) {
  return {
    noveltyKey: `plan-${slug}`,
    requiredConcepts: concepts,
    distinguishesFrom: [],
  };
}

function ctwPlanEntry() {
  return {
    ...readingComponentPlanBase("ctw", ["river tolls", "merchant associations"]),
    domain: "everyday-life" as const,
    topic: "medieval river tolls",
    angle: "why river trade in medieval Europe cost merchants more than it seemed",
  };
}

function dailyLifePlanEntry() {
  return {
    ...readingComponentPlanBase("dl", ["paperless billing", "housing office"]),
    // "office" is a workplace-business keyword (DOMAIN_KEYWORDS, generationDomains.ts), so this is the
    // domain the plan's own text classifies as; plannedDomainDrift (generationNovelty.ts) checks that.
    domain: "workplace-business" as const,
    genre: "notice",
    scenario: "a paperless billing notice from the housing office",
  };
}

function academicPlanEntry() {
  return {
    ...readingComponentPlanBase("ap", ["afternoon dip", "brief nap"]),
    domain: "everyday-life" as const,
    title: "The Afternoon Alertness Dip",
    discipline: "human physiology",
    angle: "why alertness dips in the afternoon and what remedies work",
  };
}

// Entry counts come from shared's own `readingPlanEntryCount` — the SAME derivation
// ReadingGenerationPlanSchema uses for its array lengths, not a local restatement of it — so a
// retune of READING_MODULE_COMPOSITION moves this fixture with it.
function buildPlan() {
  return {
    version: "cross-set-diversity-v1" as const,
    kind: "reading" as const,
    ctwPassages: Array.from({ length: readingPlanEntryCount("ctw") }, () => ctwPlanEntry()),
    dailyLifeTexts: Array.from({ length: readingPlanEntryCount("dailyLife") }, () => dailyLifePlanEntry()),
    academicPassages: Array.from({ length: readingPlanEntryCount("academic") }, () => academicPlanEntry()),
  };
}

// ---------------------------------------------------------------------------
// Candidate content (what the fake generate:reading call returns)
// ---------------------------------------------------------------------------

// The primary categories of the five skill slots an Academic Passage's 5 questions must cover
// (generation-guide.md's academic rule; ACADEMIC_SKILL_SLOTS in readingGenerator.ts checks it), in
// the order this fixture assigns them.
const ACADEMIC_SKILLS = ["detail", "inference", "vocabulary", "purpose", "organization"] as const;
type ReadingSkill = (typeof ACADEMIC_SKILLS)[number] | "main_idea";

function mcq(id: string, correctId: string, skill: ReadingSkill = "detail") {
  return {
    id,
    stem: `Stem for ${id}?`,
    // Exactly 4 options, like the exam: fewer draws the option-count advisory. This is a generic
    // well-formed MCQ, not a test of that rule; the direct option-count tests build their own sub-4
    // fixtures.
    options: [
      { id: "a", text: "Option A" },
      { id: "b", text: "Option B" },
      { id: "c", text: "Option C" },
      { id: "d", text: "Option D" },
    ],
    correctOptionId: correctId,
    skill,
    // The key is named by content, never by its option-id letter: the rebalance relabels ids by
    // position, so a letter reference would go stale, and `referencesOptionByPosition` flags one.
    explanationZh: `題目 ${id}:正解說明文中明確提到的內容;其他選項與原文不符。`,
  };
}

function ctwCandidateEntry(id: string, sourceParagraph: string = SAMPLE_CTW_PARAGRAPH) {
  return {
    id,
    taskType: "complete_words" as const,
    topic: "medieval river tolls",
    sourceParagraph,
  };
}

function dailyLifeCandidateEntry(id: string, q1: string, q2: string) {
  return {
    id,
    taskType: "daily_life" as const,
    genre: "notice",
    text: DAILY_LIFE_TEXT,
    questions: [mcq(q1, "a"), mcq(q2, "b")],
  };
}

function academicCandidateEntry(id: string, questionIds: readonly string[]) {
  const keys = ["b", "a", "c", "a", "b"];
  return {
    id,
    taskType: "academic_passage" as const,
    title: "The Afternoon Alertness Dip",
    discipline: "human physiology",
    text: ACADEMIC_TEXT,
    questions: questionIds.map((qid, i) => mcq(qid, keys[i]!, ACADEMIC_SKILLS[i] ?? "detail")),
  };
}

// Module composition as READING_MODULE_COMPOSITION fixes it: router 2 CtW + 3 daily-life + 1
// academic; lower 1+2+1; upper 1+0+1 — totals matching the plan's derived 4/5/3 array lengths. The
// Upper Module holds no Daily Life text (RR-25-12 Table 1: the upper path is Complete the Words and
// Academic Passage only).
//
// All three modules draw from the SAME three strings (SAMPLE_CTW_PARAGRAPH, DAILY_LIFE_TEXT,
// ACADEMIC_TEXT), so they read at nearly the same Flesch-Kincaid grade — router 11.18, lower 11.62,
// upper 13.38 — and the router and lower module therefore sit ABOVE the medium ceiling the absolute
// band gate enforces. That is deliberate: the shared prose is what makes every OTHER reading test
// deterministic (the CtW derive/repair cases compare against SAMPLE_CTW_PARAGRAPH's derivation), and
// rewriting one module's academic passage to move an index would trade that for nothing. What it
// buys instead is a free end-to-end proof of the tier: every pipeline test below still publishes,
// which is only true because `module-difficulty-band` is advisory. The gate's own in-band and
// out-of-band behaviour is pinned directly in
// "readingContentViolations: each module's absolute difficulty band".
function buildCandidate(overrides: { ctwParagraphs?: Record<string, string> } = {}) {
  const ctw = (id: string) => ctwCandidateEntry(id, overrides.ctwParagraphs?.[id] ?? SAMPLE_CTW_PARAGRAPH);
  return {
    id: "seed-candidate",
    kind: "reading" as const,
    source: "generated" as const,
    createdAt: "2026-08-09T00:00:00.000Z",
    router: {
      timeLimitSec: 1200,
      ctwPassages: [ctw("ctw-r1"), ctw("ctw-r2")],
      dailyLife: [
        dailyLifeCandidateEntry("dl-r1", "dl-r1-q1", "dl-r1-q2"),
        dailyLifeCandidateEntry("dl-r2", "dl-r2-q1", "dl-r2-q2"),
        dailyLifeCandidateEntry("dl-r3", "dl-r3-q1", "dl-r3-q2"),
      ],
      academic: [
        academicCandidateEntry("ap-r1", ["ap-r1-q1", "ap-r1-q2", "ap-r1-q3", "ap-r1-q4", "ap-r1-q5"]),
      ],
    },
    lowerModule: {
      timeLimitSec: 540,
      ctwPassages: [ctw("ctw-lo1")],
      dailyLife: [
        dailyLifeCandidateEntry("dl-lo1", "dl-lo1-q1", "dl-lo1-q2"),
        dailyLifeCandidateEntry("dl-lo2", "dl-lo2-q1", "dl-lo2-q2"),
      ],
      academic: [
        academicCandidateEntry("ap-lo1", ["ap-lo1-q1", "ap-lo1-q2", "ap-lo1-q3", "ap-lo1-q4", "ap-lo1-q5"]),
      ],
    },
    upperModule: {
      timeLimitSec: 540,
      ctwPassages: [ctw("ctw-up1")],
      dailyLife: [],
      academic: [
        academicCandidateEntry("ap-up1", ["ap-up1-q1", "ap-up1-q2", "ap-up1-q3", "ap-up1-q4", "ap-up1-q5"]),
      ],
    },
  };
}

// A candidate that drifts from its plan's domain: the router's third Daily Life text is rewritten as
// a museum and gallery notice, with six arts-culture keyword hits and no workplace-business hit, so
// domainCompatible finds it contradicting the "workplace-business" domain dailyLifePlanEntry
// declares. Candidate-stage domain drift is recorded on the Set, never rejected; the test that uses
// this fixture pins that the candidate is not rejected.
function domainDriftCandidate() {
  const candidate = buildCandidate();
  candidate.router.dailyLife[2] = {
    ...candidate.router.dailyLife[2]!,
    text: "This notice announces the museum's new gallery exhibit featuring student ceramic art work. " +
      "The theatre lobby will host a small festival display of paintings through the week.",
  };
  return candidate;
}

/**
 * A candidate whose UPPER module reads no harder than its LOWER module. This difficulty inversion is
 * the only reason Reading's candidate stage rejects a candidate; candidate-stage domain drift is
 * recorded on the Set instead (generationCandidateLoop.ts).
 *
 * Built by making the lower module's prose dense and the upper module's prose plain, which is exactly
 * the inversion moduleDifficulty.ts measures. Nothing here depends on the index's constants.
 */
const DENSE_PROSE =
  "The systematic reconsideration of institutional methodology, particularly where the underlying " +
  "epistemological assumptions remain substantially uninterrogated, necessitates a correspondingly " +
  "comprehensive re-evaluation of accumulated evidentiary foundations across the discipline.";
const PLAIN_PROSE = "The dog ran. The cat sat. We ate. It was fun. I go now. She is here. He can see.";

// The Upper Module has no Daily Life text, so the inversion is carried by the two modules' Academic
// Passages plus the lower module's dense Daily Life text. The upper module reads EASIER than the
// lower, and the fatal relative gate rejects it.
function invertedDifficultyCandidate() {
  const candidate = buildCandidate();
  candidate.lowerModule.dailyLife[0] = { ...candidate.lowerModule.dailyLife[0]!, text: DENSE_PROSE };
  candidate.upperModule.academic[0] = { ...candidate.upperModule.academic[0]!, text: PLAIN_PROSE };
  candidate.lowerModule.academic[0] = { ...candidate.lowerModule.academic[0]!, text: DENSE_PROSE };
  return candidate;
}

// ---------------------------------------------------------------------------
// Fake runSkillTask helpers — every sub-call goes through task {task:"generate", context:"reading"},
// so calls are told apart by the unique fenced marker each readingGenerator.ts prompt builder emits
// (see readingGenerationPrompt/ctwRepairPrompt/ctwExplanationsPrompt/readingVerifyPrompt).
// ---------------------------------------------------------------------------

// rebalanceReadingOptionOrder reorders every MCQ question's `options` array AND relabels every
// option's id to the position it occupies, with `correctOptionId` following its content — see
// shuffleMcqOptions's doc comment in generationVerifyRemediation.ts. So neither a published
// question's `options` ARRAY ORDER nor its option IDS (including which id `correctOptionId` names)
// are guaranteed identical to the candidate that produced it, even when every OTHER field — and
// every option's own TEXT — is untouched.
// Comparisons that want to assert "this question is otherwise byte-identical" normalize by CONTENT
// instead of position/id: sort `options` by TEXT (stable regardless of shuffle-and-relabel) and
// replace `correctOptionId` with the correct option's own TEXT, so a reordering-and-relabeling-only
// difference (the intended behavior) doesn't fail the assertion while any REAL content difference
// (changed text, a missing/extra option, or the wrong option actually marked correct) still does.
function withSortedOptions<Q extends { options: readonly { id: string; text: string }[]; correctOptionId: string }>(
  question: Q,
): Omit<Q, "options" | "correctOptionId"> & { options: { text: string }[]; correctOptionId: string } {
  const correctText = question.options.find((o) => o.id === question.correctOptionId)?.text ?? "<dangling correctOptionId>";
  return {
    ...question,
    options: [...question.options].map((o) => ({ text: o.text })).sort((a, b) => a.text.localeCompare(b.text)),
    correctOptionId: correctText,
  };
}

function extractFence(prompt: string, marker: string): unknown {
  return JSON.parse(extractRawFence(prompt, marker));
}

/** The same fence, unparsed — `current-paragraph` carries prose, not JSON. */
function extractRawFence(prompt: string, marker: string): string {
  const match = new RegExp("```" + marker + "\\n([\\s\\S]*?)\\n```").exec(prompt);
  if (!match) throw new Error(`fixture error: prompt is missing the \`\`\`${marker} fence`);
  return match[1]!;
}

function okExplanationsResponse(prompt: string): { explanations: { gapId: string; explanationZh: string }[] } {
  const payload = extractFence(prompt, "ctw-derived-gaps") as { gaps: { id: string }[] };
  return {
    explanations: payload.gaps.map((gap) => ({
      gapId: gap.id,
      explanationZh: `語意上只有這個答案符合上下文 (${gap.id})。`,
    })),
  };
}

function allOkVerifyResponse(prompt: string) {
  const payload = extractFence(prompt, "json") as {
    ctwPassages: { id: string }[];
    mcqItems: { id: string }[];
  };
  return {
    ctwPassages: payload.ctwPassages.map((p) => ({ id: p.id, verdict: "ok" as const })),
    mcqItems: payload.mcqItems.map((m) => ({ id: m.id, verdict: "ok" as const })),
  };
}

/**
 * An "ambiguous" verdict's `ambiguousGaps` for a passage in the verify payload: its first gap and a
 * different word that fits that blank exactly (same prefix, same number of missing letters), which
 * is the only kind of alternate the pipeline acts on.
 */
function typeableAmbiguity(passage: { id: string }) {
  const gap = (passage as unknown as { gaps: { id: string; prefix: string; completion: string }[] }).gaps[0]!;
  return [{ gapId: gap.id, alternate: `${gap.prefix}${"z".repeat(gap.completion.length)}` }];
}

function readingDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "generation-reading-"));
  fs.mkdirSync(path.join(dir, "question-sets/reading"), { recursive: true });
  return dir;
}

function publishedSetPath(setId: string): string {
  return path.join(config.dataDir, "question-sets/reading", `${setId}.json`);
}

function assertStageOrder(stages: readonly string[]): void {
  const order = ["planning", "generating", "verifying", "saving"];
  let lastIndex = -1;
  for (const stage of order) {
    const index = stages.indexOf(stage);
    expect(index, `expected stage "${stage}" to appear in ${JSON.stringify(stages)}`).toBeGreaterThan(-1);
    expect(index).toBeGreaterThan(lastIndex);
    lastIndex = index;
  }
}

describe("generateSet (reading)", () => {
  it("publishes a reading set end to end: plan -> generate -> derive gaps -> explanations -> verify -> publish", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    const tasks: string[] = [];
    const stages: string[] = [];

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      tasks.push(`${request.task.task}:${request.task.context}`);
      emitRunning(request);
      if (request.task.task === "plan") {
        return skillSuccess(request.parse(plan));
      }
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) {
          return skillSuccess(request.parse(candidate));
        }
        if (request.prompt.includes("```ctw-derived-gaps")) {
          return skillSuccess(request.parse(okExplanationsResponse(request.prompt)));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    const progress: GenerationProgress[] = [];
    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet(
        "reading",
        { runSkillTask: runSkillTask as never, planner },
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
      expect(setId).toMatch(/^rd-[0-9a-f]{8}$/);
      const publishedPath = publishedSetPath(setId);
      expect(fs.existsSync(publishedPath)).toBe(true);
      const published: unknown = JSON.parse(fs.readFileSync(publishedPath, "utf8"));
      const parsed = AnySetSchema.parse(published);
      expect(parsed.kind).toBe("reading");
      if (parsed.kind !== "reading") throw new Error("unreachable");
      expect(parsed.generationPlan).toBeDefined();

      const { gaps: goldenGaps } = deriveCtwGaps("golden-check", SAMPLE_CTW_PARAGRAPH);
      const firstPassage = parsed.router.ctwPassages[0]!;
      expect(firstPassage.sourceParagraph).toBe(SAMPLE_CTW_PARAGRAPH);
      expect(firstPassage.gaps.map((g) => [g.prefix, g.completion])).toEqual(
        goldenGaps.map((g) => [g.prefix, g.completion]),
      );
      expect(firstPassage.gaps.every((g) => g.explanationZh.length > 0)).toBe(true);

      // Module composition landed exactly as planned — read off READING_MODULE_COMPOSITION rather
      // than restated, so a retune moves this assertion with the table. The one count spelled out is
      // the Upper Module's: it carries NO Daily Life text.
      for (const moduleName of ["router", "lowerModule", "upperModule"] as const) {
        const expected = READING_MODULE_COMPOSITION[moduleName];
        expect(parsed[moduleName].ctwPassages, moduleName).toHaveLength(expected.ctw);
        expect(parsed[moduleName].dailyLife, moduleName).toHaveLength(expected.dailyLife);
        expect(parsed[moduleName].academic, moduleName).toHaveLength(expected.academic);
      }
      expect(parsed.upperModule.dailyLife).toHaveLength(0);

      assertStageOrder(stages);
      expect(tasks[0]).toBe("plan:reading");
      expect(tasks).toContain("generate:reading");
      expect(tasks).toContain("verify:reading");

      fs.rmSync(publishedPath);
    } catch (err) {
      // Even on assertion failure, don't leave the published file in the bank this file's other tests read.
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });

  it("regenerates a CtW passage when it derives the wrong gap count, then succeeds", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate({ ctwParagraphs: { "ctw-r1": NINE_GAP_PARAGRAPH } });
    let repairCalls = 0;

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") {
        return skillSuccess(request.parse(plan));
      }
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) {
          return skillSuccess(request.parse(candidate));
        }
        if (request.prompt.includes("```ctw-plan-entry")) {
          repairCalls += 1;
          expect(request.prompt).toContain("derived 9 gaps");
          return skillSuccess(request.parse({ sourceParagraph: SAMPLE_CTW_PARAGRAPH }));
        }
        if (request.prompt.includes("```ctw-derived-gaps")) {
          return skillSuccess(request.parse(okExplanationsResponse(request.prompt)));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(repairCalls).toBe(1);
      const published: unknown = JSON.parse(fs.readFileSync(publishedSetPath(setId), "utf8"));
      const parsed = AnySetSchema.parse(published);
      if (parsed.kind !== "reading") throw new Error("unreachable");
      const repaired = parsed.router.ctwPassages[0]!;
      expect(repaired.sourceParagraph).toBe(SAMPLE_CTW_PARAGRAPH);
      expect(repaired.gaps).toHaveLength(10);
      fs.rmSync(publishedSetPath(setId));
    } catch (err) {
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });

  it("regenerates a CtW passage the verifier flags as ambiguous, then re-verifies clean", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    let verifyCalls = 0;
    let repairCalls = 0;
    let repairPrompt: string | undefined;

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") {
        return skillSuccess(request.parse(plan));
      }
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) {
          return skillSuccess(request.parse(candidate));
        }
        if (request.prompt.includes("```ctw-plan-entry")) {
          repairCalls += 1;
          repairPrompt = request.prompt;
          expect(request.prompt).toContain("AMBIGUOUS");
          return skillSuccess(request.parse({ sourceParagraph: SAMPLE_CTW_PARAGRAPH }));
        }
        if (request.prompt.includes("```ctw-derived-gaps")) {
          return skillSuccess(request.parse(okExplanationsResponse(request.prompt)));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      // verify:reading
      verifyCalls += 1;
      const payload = extractFence(request.prompt, "json") as {
        ctwPassages: { id: string }[];
        mcqItems: { id: string }[];
      };
      if (verifyCalls === 1) {
        const [flagged, ...rest] = payload.ctwPassages;
        return skillSuccess(request.parse({
          ctwPassages: [
            {
              id: flagged!.id, verdict: "ambiguous" as const, ambiguousGaps: typeableAmbiguity(flagged!),
              reason: 'gap g6 (prefix "re" -> "lax") also completes to "rest" in this context',
            },
            ...rest.map((p) => ({ id: p.id, verdict: "ok" as const })),
          ],
          mcqItems: payload.mcqItems.map((m) => ({ id: m.id, verdict: "ok" as const })),
        }));
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(verifyCalls).toBe(2);
      expect(repairCalls).toBe(1);
      // Gap POSITIONS are deterministic (ctest.ts), so the only legitimate remedy is rewording the
      // paragraph. The feedback must therefore carry
      // the verifier's own competing completion verbatim AND state the uniqueness bar the rewrite
      // has to clear, rather than a generic "make it unambiguous".
      expect(repairPrompt).toContain('also completes to "rest"');
      expect(repairPrompt).toMatch(/exactly one|only one|unique/i);
      expect(repairPrompt).toContain("same length");
      const published: unknown = JSON.parse(fs.readFileSync(publishedSetPath(setId), "utf8"));
      const parsed = AnySetSchema.parse(published);
      if (parsed.kind !== "reading") throw new Error("unreachable");
      expect(parsed.router.ctwPassages[0]!.gaps).toHaveLength(10);
      fs.rmSync(publishedSetPath(setId));
    } catch (err) {
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });

  // The Verifier also checks each gap's explanationZh, separately from CtW ambiguity: a passage can
  // derive an unambiguous, perfectly fine paragraph and still carry an explanation that misattributes
  // or misexplains a gap. That verdict regenerates ONLY the explanations (re-running the same second,
  // distinct generate:reading call assembleReadingContent made), never the paragraph.
  it("regenerates only the explanations for a CtW passage the verifier flags as unfaithful, then re-verifies clean", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    let verifyCalls = 0;
    let paragraphRepairCalls = 0;
    let regenerationSawFeedback = false;
    const explanationCallsByPassage = new Map<string, number>();

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") {
        return skillSuccess(request.parse(plan));
      }
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) {
          return skillSuccess(request.parse(candidate));
        }
        if (request.prompt.includes("```ctw-plan-entry")) {
          // An "unfaithful-explanation" verdict must NEVER trigger a paragraph repair call — the
          // paragraph and gaps are fine; only the Explanation prose is wrong.
          paragraphRepairCalls += 1;
          return skillSuccess(request.parse({ sourceParagraph: SAMPLE_CTW_PARAGRAPH }));
        }
        if (request.prompt.includes("```ctw-derived-gaps")) {
          const payload = extractFence(request.prompt, "ctw-derived-gaps") as {
            passageId: string;
            gaps: { id: string }[];
          };
          explanationCallsByPassage.set(
            payload.passageId,
            (explanationCallsByPassage.get(payload.passageId) ?? 0) + 1,
          );
          const hasFeedback = request.prompt.includes("```explanation-feedback");
          if (hasFeedback) {
            regenerationSawFeedback = request.prompt.includes("gap 3's explanation actually justifies gap 7's word");
          }
          return skillSuccess(request.parse({
            explanations: payload.gaps.map((gap) => ({
              gapId: gap.id,
              explanationZh: hasFeedback
                ? `REGENERATED 語意解析 (${gap.id})`
                : `語意上只有這個答案符合上下文 (${gap.id})。`,
            })),
          }));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      // verify:reading
      verifyCalls += 1;
      const payload = extractFence(request.prompt, "json") as {
        ctwPassages: { id: string }[];
        mcqItems: { id: string }[];
      };
      if (verifyCalls === 1) {
        const [flagged, ...rest] = payload.ctwPassages;
        return skillSuccess(request.parse({
          ctwPassages: [
            {
              id: flagged!.id, verdict: "unfaithful-explanation" as const,
              gapIds: [`${flagged!.id}-g3`, `${flagged!.id}-g7`],
              reason: "gap 3's explanation actually justifies gap 7's word, not gap 3's",
            },
            ...rest.map((p) => ({ id: p.id, verdict: "ok" as const })),
          ],
          mcqItems: payload.mcqItems.map((m) => ({ id: m.id, verdict: "ok" as const })),
        }));
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(verifyCalls).toBe(2);
      expect(paragraphRepairCalls).toBe(0);
      expect(regenerationSawFeedback).toBe(true);
      // Router's first CtW slot ("ctw-r1", the first entry in the flattened verify payload) got a
      // SECOND explanation call; every other passage got exactly its original one.
      expect(explanationCallsByPassage.get("ctw-r1")).toBe(2);
      for (const id of ["ctw-r2", "ctw-lo1", "ctw-up1"]) {
        expect(explanationCallsByPassage.get(id)).toBe(1);
      }

      const published: unknown = JSON.parse(fs.readFileSync(publishedSetPath(setId), "utf8"));
      const parsed = AnySetSchema.parse(published);
      if (parsed.kind !== "reading") throw new Error("unreachable");
      // Paragraph and gaps untouched — still SAMPLE_CTW_PARAGRAPH's golden derivation.
      const passage = parsed.router.ctwPassages[0]!;
      expect(passage.sourceParagraph).toBe(SAMPLE_CTW_PARAGRAPH);
      expect(passage.gaps).toHaveLength(10);
      // Every explanationZh for that passage was replaced by the regeneration call.
      for (const gap of passage.gaps) expect(gap.explanationZh).toContain("REGENERATED");
      fs.rmSync(publishedSetPath(setId));
    } catch (err) {
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });

  // When a CtW passage is BOTH flagged "ambiguous" by the Verifier AND carries an over-long gap
  // explanation the deterministic gate caught in the same round, regenerateOverlongCtwExplanations's
  // rewrite of that passage's explanations would be wasted: regenerateWholesalePassages rewrites the
  // whole paragraph (hence fresh gaps, hence fresh explanations) in the same round. The wholesale
  // rewrite claims the passage, so the length-remediation call skips it.
  it("skips the over-long-explanation remediation for a CtW passage the SAME round also regenerates wholesale as ambiguous", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    let verifyCalls = 0;
    let repairCalls = 0;
    let overlongRemediationCalls = 0;
    const explanationCallsByPassage = new Map<string, number>();

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") {
        return skillSuccess(request.parse(plan));
      }
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) {
          return skillSuccess(request.parse(candidate));
        }
        if (request.prompt.includes("```ctw-plan-entry")) {
          repairCalls += 1;
          return skillSuccess(request.parse({ sourceParagraph: SAMPLE_CTW_PARAGRAPH }));
        }
        if (request.prompt.includes("```ctw-derived-gaps")) {
          if (request.prompt.includes("ran far too long")) overlongRemediationCalls += 1;
          const payload = extractFence(request.prompt, "ctw-derived-gaps") as {
            passageId: string;
            gaps: { id: string }[];
          };
          const priorCalls = explanationCallsByPassage.get(payload.passageId) ?? 0;
          explanationCallsByPassage.set(payload.passageId, priorCalls + 1);
          // Only the very FIRST explanation call for ctw-r1 (assembling the initial candidate)
          // returns an over-long explanation for its first gap, so the deterministic gate flags it
          // at the top of verify round 1. Every later call (a length-remediation call, if one were
          // wrongly made, or the ambiguous regeneration's fresh explanations) returns short, valid
          // text, so the Set publishes either way and only the call counts tell the two apart.
          const isInitialCtwR1Call = payload.passageId === "ctw-r1" && priorCalls === 0;
          return skillSuccess(request.parse({
            explanations: payload.gaps.map((gap, i) => ({
              gapId: gap.id,
              explanationZh: isInitialCtwR1Call && i === 0
                ? zhExplanation(210)
                : `語意上只有這個答案符合上下文 (${gap.id})。`,
            })),
          }));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      // verify:reading
      verifyCalls += 1;
      const payload = extractFence(request.prompt, "json") as {
        ctwPassages: { id: string }[];
        mcqItems: { id: string }[];
      };
      if (verifyCalls === 1) {
        const [flagged, ...rest] = payload.ctwPassages;
        return skillSuccess(request.parse({
          ctwPassages: [
            {
              id: flagged!.id, verdict: "ambiguous" as const, ambiguousGaps: typeableAmbiguity(flagged!),
              reason: "gap g6 also completes to a same-length alternate word in context",
            },
            ...rest.map((p) => ({ id: p.id, verdict: "ok" as const })),
          ],
          mcqItems: payload.mcqItems.map((m) => ({ id: m.id, verdict: "ok" as const })),
        }));
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(verifyCalls).toBe(2);
      expect(repairCalls).toBe(1);
      // The whole point: no wasted length-remediation call for a passage about to be regenerated
      // wholesale in the same round.
      expect(overlongRemediationCalls).toBe(0);
      // One explanation call to assemble the initial (over-long) candidate, one more when the
      // ambiguous regeneration derives fresh gaps -- not a third, wasted one in between.
      expect(explanationCallsByPassage.get("ctw-r1")).toBe(2);
      fs.rmSync(publishedSetPath(setId));
    } catch (err) {
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });

  // Same mechanism as the test above, for the other wholesale CtW verdict: "unfaithful-explanation"
  // rewrites every explanation of the flagged passage too, so a length remediation beside it would be
  // equally wasted.
  it("skips the over-long-explanation remediation for a CtW passage the SAME round also flags unfaithful", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    let verifyCalls = 0;
    let paragraphRepairCalls = 0;
    let overlongRemediationCalls = 0;
    const explanationCallsByPassage = new Map<string, number>();

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") {
        return skillSuccess(request.parse(plan));
      }
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) {
          return skillSuccess(request.parse(candidate));
        }
        if (request.prompt.includes("```ctw-plan-entry")) {
          paragraphRepairCalls += 1;
          return skillSuccess(request.parse({ sourceParagraph: SAMPLE_CTW_PARAGRAPH }));
        }
        if (request.prompt.includes("```ctw-derived-gaps")) {
          if (request.prompt.includes("ran far too long")) overlongRemediationCalls += 1;
          const payload = extractFence(request.prompt, "ctw-derived-gaps") as {
            passageId: string;
            gaps: { id: string }[];
          };
          const priorCalls = explanationCallsByPassage.get(payload.passageId) ?? 0;
          explanationCallsByPassage.set(payload.passageId, priorCalls + 1);
          const isInitialCtwR1Call = payload.passageId === "ctw-r1" && priorCalls === 0;
          return skillSuccess(request.parse({
            explanations: payload.gaps.map((gap, i) => ({
              gapId: gap.id,
              explanationZh: isInitialCtwR1Call && i === 0
                ? zhExplanation(210)
                : `語意上只有這個答案符合上下文 (${gap.id})。`,
            })),
          }));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      // verify:reading
      verifyCalls += 1;
      const payload = extractFence(request.prompt, "json") as {
        ctwPassages: { id: string }[];
        mcqItems: { id: string }[];
      };
      if (verifyCalls === 1) {
        const [flagged, ...rest] = payload.ctwPassages;
        return skillSuccess(request.parse({
          ctwPassages: [
            {
              id: flagged!.id, verdict: "unfaithful-explanation" as const,
              gapIds: [`${flagged!.id}-g3`],
              reason: "gap 3's explanation actually justifies a different gap's word",
            },
            ...rest.map((p) => ({ id: p.id, verdict: "ok" as const })),
          ],
          mcqItems: payload.mcqItems.map((m) => ({ id: m.id, verdict: "ok" as const })),
        }));
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(verifyCalls).toBe(2);
      expect(paragraphRepairCalls).toBe(0);
      expect(overlongRemediationCalls).toBe(0);
      expect(explanationCallsByPassage.get("ctw-r1")).toBe(2);
      fs.rmSync(publishedSetPath(setId));
    } catch (err) {
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });

  // A Verifier "issue" verdict on an MCQ is repaired surgically, like the two CtW verdicts above, not
  // by discarding the Set: ONE generate:reading call per affected Stimulus, batching every flagged
  // question of that Stimulus together, never one call per question.
  it("regenerates flagged MCQ questions across two different stimuli in one round, then re-verifies clean", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    let verifyCalls = 0;
    const mcqRegenPrompts: { stimulusId: string; flaggedQuestions: { id: string; reason: string }[] }[] = [];

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") {
        return skillSuccess(request.parse(plan));
      }
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) {
          return skillSuccess(request.parse(candidate));
        }
        if (request.prompt.includes("```ctw-derived-gaps")) {
          return skillSuccess(request.parse(okExplanationsResponse(request.prompt)));
        }
        if (request.prompt.includes("```mcq-regeneration")) {
          const payload = extractFence(request.prompt, "mcq-regeneration") as {
            stimulusId: string;
            flaggedQuestions: {
              id: string;
              options: { id: string; text: string }[];
              correctOptionId: string;
              skill: string;
              reason: string;
            }[];
          };
          mcqRegenPrompts.push(payload);
          return skillSuccess(request.parse({
            questions: payload.flaggedQuestions.map((q) => ({
              id: q.id,
              stem: `REGENERATED stem for ${q.id}`,
              options: q.options,
              correctOptionId: q.correctOptionId,
              skill: q.skill,
              explanationZh: `REGENERATED 解析 (${q.id})`,
            })),
          }));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      // verify:reading
      verifyCalls += 1;
      const payload = extractFence(request.prompt, "json") as {
        ctwPassages: { id: string }[];
        mcqItems: { id: string }[];
      };
      if (verifyCalls === 1) {
        return skillSuccess(request.parse({
          ctwPassages: payload.ctwPassages.map((p) => ({ id: p.id, verdict: "ok" as const })),
          mcqItems: payload.mcqItems.map((m) => {
            // dl-r1-q1 AND dl-r1-q2 flagged on the SAME stimulus ("dl-r1") — must batch into one
            // regeneration call carrying both, not two separate calls.
            if (m.id === "dl-r1-q1") {
              return { id: m.id, verdict: "issue" as const, reason: "distractor B is not attractively wrong" };
            }
            if (m.id === "dl-r1-q2") {
              return { id: m.id, verdict: "issue" as const, reason: "correctOptionId key is stale" };
            }
            if (m.id === "ap-lo1-q3") {
              return { id: m.id, verdict: "issue" as const, reason: "correctOptionId text mismatches the passage" };
            }
            return { id: m.id, verdict: "ok" as const };
          }),
        }));
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(verifyCalls).toBe(2);
      // Exactly one call per affected stimulus (router daily-life "dl-r1", lower-module academic
      // "ap-lo1") — NOT one call per flagged question — each carrying ONLY its own stimulus's
      // flagged question(s) + reasons. "dl-r1" has two flagged questions batched into its one call.
      expect(mcqRegenPrompts).toHaveLength(2);
      expect(mcqRegenPrompts).toContainEqual(
        expect.objectContaining({
          stimulusId: "dl-r1",
          flaggedQuestions: [
            expect.objectContaining({ id: "dl-r1-q1", reason: "distractor B is not attractively wrong" }),
            expect.objectContaining({ id: "dl-r1-q2", reason: "correctOptionId key is stale" }),
          ],
        }),
      );
      expect(mcqRegenPrompts).toContainEqual(
        expect.objectContaining({
          stimulusId: "ap-lo1",
          flaggedQuestions: [expect.objectContaining({ id: "ap-lo1-q3", reason: "correctOptionId text mismatches the passage" })],
        }),
      );

      const published: unknown = JSON.parse(fs.readFileSync(publishedSetPath(setId), "utf8"));
      const parsed = AnySetSchema.parse(published);
      if (parsed.kind !== "reading") throw new Error("unreachable");

      const dlR1 = parsed.router.dailyLife.find((t) => t.id === "dl-r1")!;
      expect(dlR1.questions[0]!.id).toBe("dl-r1-q1");
      expect(dlR1.questions[0]!.stem).toBe("REGENERATED stem for dl-r1-q1");
      expect(dlR1.questions[1]!.id).toBe("dl-r1-q2");
      expect(dlR1.questions[1]!.stem).toBe("REGENERATED stem for dl-r1-q2");
      // An entirely untouched stimulus is byte-identical apart from the option rebalance (see
      // withSortedOptions's own doc comment).
      expect({
        ...parsed.router.dailyLife[1],
        questions: parsed.router.dailyLife[1]!.questions.map(withSortedOptions),
      }).toEqual({
        ...candidate.router.dailyLife[1],
        questions: candidate.router.dailyLife[1]!.questions.map(withSortedOptions),
      });

      const apLo1 = parsed.lowerModule.academic.find((p) => p.id === "ap-lo1")!;
      expect(apLo1.questions[2]!.id).toBe("ap-lo1-q3");
      expect(apLo1.questions[2]!.stem).toBe("REGENERATED stem for ap-lo1-q3");
      expect(withSortedOptions(apLo1.questions[0]!)).toEqual(withSortedOptions(candidate.lowerModule.academic[0]!.questions[0]!));
      expect(withSortedOptions(apLo1.questions[4]!)).toEqual(withSortedOptions(candidate.lowerModule.academic[0]!.questions[4]!));

      fs.rmSync(publishedSetPath(setId));
    } catch (err) {
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });

  // regenerateFlaggedQuestions filters the model's response down to the REQUESTED flagged ids before
  // consuming it. An over-inclusive response — the model also returns a
  // "replacement" for an unrequested sibling question, despite the prompt's "keep every other
  // question untouched" instruction — must never overwrite that sibling, and the sibling's dangling
  // correctOptionId must never reach (or defeat) checkMcqOptions since it was never a candidate for
  // substitution in the first place.
  it("ignores an over-inclusive MCQ regeneration response: an unrequested sibling replacement never overwrites the untouched question", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    let verifyCalls = 0;

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") {
        return skillSuccess(request.parse(plan));
      }
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) {
          return skillSuccess(request.parse(candidate));
        }
        if (request.prompt.includes("```ctw-derived-gaps")) {
          return skillSuccess(request.parse(okExplanationsResponse(request.prompt)));
        }
        if (request.prompt.includes("```mcq-regeneration")) {
          const payload = extractFence(request.prompt, "mcq-regeneration") as {
            flaggedQuestions: {
              id: string;
              options: { id: string; text: string }[];
              correctOptionId: string;
              skill: string;
            }[];
          };
          return skillSuccess(request.parse({
            questions: [
              // The legitimate, requested replacement.
              ...payload.flaggedQuestions.map((q) => ({
                id: q.id,
                stem: `REGENERATED stem for ${q.id}`,
                options: q.options,
                correctOptionId: q.correctOptionId,
                skill: q.skill,
                explanationZh: `REGENERATED 解析 (${q.id})`,
              })),
              // NEVER requested: "dl-r1-q2" was not flagged. A well-behaved model would omit it; this
              // one over-includes it, with a changed stem AND a dangling correctOptionId ("z" is not
              // among its own options) — proving the extra entry is dropped rather than substituted
              // (which would otherwise both corrupt an untouched question and smuggle a
              // never-pre-checked dangling key past checkMcqOptions).
              {
                id: "dl-r1-q2",
                stem: "SNEAKY unrequested stem for dl-r1-q2",
                options: [
                  { id: "a", text: "Option A" },
                  { id: "b", text: "Option B" },
                  { id: "c", text: "Option C" },
                ],
                correctOptionId: "z",
                skill: "detail" as const,
                explanationZh: "sneaky unrequested explanation",
              },
            ],
          }));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      // verify:reading — round 1 flags only dl-r1-q1 (dl-r1-q2 is never flagged); round 2 is clean,
      // proving the round-1 regeneration produced an acceptable replacement.
      verifyCalls += 1;
      const payload = extractFence(request.prompt, "json") as {
        ctwPassages: { id: string }[];
        mcqItems: { id: string }[];
      };
      if (verifyCalls === 1) {
        return skillSuccess(request.parse({
          ctwPassages: payload.ctwPassages.map((p) => ({ id: p.id, verdict: "ok" as const })),
          mcqItems: payload.mcqItems.map((m) =>
            m.id === "dl-r1-q1"
              ? { id: m.id, verdict: "issue" as const, reason: "distractor B is not attractively wrong" }
              : { id: m.id, verdict: "ok" as const },
          ),
        }));
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      const published: unknown = JSON.parse(fs.readFileSync(publishedSetPath(setId), "utf8"));
      const parsed = AnySetSchema.parse(published);
      if (parsed.kind !== "reading") throw new Error("unreachable");
      const dlR1 = parsed.router.dailyLife.find((t) => t.id === "dl-r1")!;
      expect(dlR1.questions[0]!.stem).toBe("REGENERATED stem for dl-r1-q1");
      // The unrequested sibling is byte-identical to the original (apart from the option rebalance —
      // see withSortedOptions) — the sneaky replacement (and its dangling correctOptionId) never
      // landed.
      expect(withSortedOptions(dlR1.questions[1]!)).toEqual(withSortedOptions(candidate.router.dailyLife[0]!.questions[1]!));
      fs.rmSync(publishedSetPath(setId));
    } catch (err) {
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });

  // The MCQ-side counterpart of the CtW "skips the over-long-explanation remediation..." tests above.
  // When an MCQ item's explanationZh is BOTH over the 200-字 gate limit AND flagged "issue" by the
  // Verifier in the SAME round, rewriteOverlongExplanations's explanation-only rewrite would be
  // wasted: regenerateRejectedMcqs replaces the WHOLE question (stem, options, correctOptionId, AND
  // explanationZh) in the same round. The wholesale regeneration claims the question, so it gets one
  // mcq-regeneration call and no mcq-explanation-rewrite call.
  it("skips the over-long-MCQ-explanation remediation for a question the SAME round also regenerates as an issue", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    // dl-r1-q1's explanationZh starts over the 200-字 gate limit.
    candidate.router.dailyLife[0]!.questions[0]!.explanationZh = zhExplanation(210);
    let verifyCalls = 0;
    let explanationRewriteCalls = 0;
    let mcqRegenCalls = 0;
    const mcqRegenPrompts: { stimulusId: string; flaggedQuestions: { id: string }[] }[] = [];

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") return skillSuccess(request.parse(plan));
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) return skillSuccess(request.parse(candidate));
        if (request.prompt.includes("```ctw-derived-gaps")) return skillSuccess(request.parse(okExplanationsResponse(request.prompt)));
        if (request.prompt.includes("```mcq-explanation-rewrite")) {
          explanationRewriteCalls += 1;
          const payload = extractFence(request.prompt, "mcq-explanation-rewrite") as { overlongExplanations: { id: string }[] };
          return skillSuccess(request.parse({
            explanations: payload.overlongExplanations.map((q) => ({ id: q.id, explanationZh: "精簡後的解析" })),
          }));
        }
        if (request.prompt.includes("```mcq-regeneration")) {
          mcqRegenCalls += 1;
          const payload = extractFence(request.prompt, "mcq-regeneration") as {
            stimulusId: string;
            flaggedQuestions: { id: string; options: { id: string; text: string }[]; correctOptionId: string; skill: string }[];
          };
          mcqRegenPrompts.push(payload);
          return skillSuccess(request.parse({
            questions: payload.flaggedQuestions.map((q) => ({
              id: q.id, stem: `REGENERATED stem for ${q.id}`, options: q.options,
              correctOptionId: q.correctOptionId, skill: q.skill, explanationZh: `REGENERATED 解析 (${q.id})`,
            })),
          }));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      verifyCalls += 1;
      const payload = extractFence(request.prompt, "json") as { ctwPassages: { id: string }[]; mcqItems: { id: string }[] };
      if (verifyCalls === 1) {
        return skillSuccess(request.parse({
          ctwPassages: payload.ctwPassages.map((p) => ({ id: p.id, verdict: "ok" as const })),
          mcqItems: payload.mcqItems.map((m) => m.id === "dl-r1-q1"
            ? { id: m.id, verdict: "issue" as const, reason: "distractor B is not attractively wrong" }
            : { id: m.id, verdict: "ok" as const }),
        }));
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(verifyCalls).toBe(2);
      // The whole point: no wasted explanation-only rewrite for a question about to be regenerated
      // wholesale in the same round.
      expect(explanationRewriteCalls).toBe(0);
      expect(mcqRegenCalls).toBe(1);
      expect(mcqRegenPrompts[0]!.stimulusId).toBe("dl-r1");
      expect(mcqRegenPrompts[0]!.flaggedQuestions.map((q) => q.id)).toEqual(["dl-r1-q1"]);

      const parsed = readPublishedReadingSet(setId);
      const dlR1 = parsed.router.dailyLife.find((t) => t.id === "dl-r1")!;
      expect(dlR1.questions[0]!.stem).toBe("REGENERATED stem for dl-r1-q1");
      expect(dlR1.questions[0]!.explanationZh).toBe("REGENERATED 解析 (dl-r1-q1)");
      fs.rmSync(publishedSetPath(setId));
    } catch (err) {
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });

  it("runs a CtW-ambiguity regeneration and an MCQ regeneration in the same mixed verify round, then publishes on a clean re-verify", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    let verifyCalls = 0;
    let repairCalls = 0;
    let mcqRegenCalls = 0;

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") {
        return skillSuccess(request.parse(plan));
      }
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) {
          return skillSuccess(request.parse(candidate));
        }
        if (request.prompt.includes("```ctw-plan-entry")) {
          repairCalls += 1;
          expect(request.prompt).toContain("AMBIGUOUS");
          return skillSuccess(request.parse({ sourceParagraph: SAMPLE_CTW_PARAGRAPH }));
        }
        if (request.prompt.includes("```ctw-derived-gaps")) {
          return skillSuccess(request.parse(okExplanationsResponse(request.prompt)));
        }
        if (request.prompt.includes("```mcq-regeneration")) {
          mcqRegenCalls += 1;
          const payload = extractFence(request.prompt, "mcq-regeneration") as {
            flaggedQuestions: {
              id: string;
              options: { id: string; text: string }[];
              correctOptionId: string;
              skill: string;
            }[];
          };
          return skillSuccess(request.parse({
            questions: payload.flaggedQuestions.map((q) => ({
              id: q.id,
              stem: `REGENERATED stem for ${q.id}`,
              options: q.options,
              correctOptionId: q.correctOptionId,
              skill: q.skill,
              explanationZh: `REGENERATED 解析 (${q.id})`,
            })),
          }));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      // verify:reading
      verifyCalls += 1;
      const payload = extractFence(request.prompt, "json") as {
        ctwPassages: { id: string }[];
        mcqItems: { id: string }[];
      };
      if (verifyCalls === 1) {
        const [flaggedCtw, ...restCtw] = payload.ctwPassages;
        return skillSuccess(request.parse({
          ctwPassages: [
            { id: flaggedCtw!.id, verdict: "ambiguous" as const, ambiguousGaps: typeableAmbiguity(flaggedCtw!), reason: "the deleted letters have a plausible alternate word" },
            ...restCtw.map((p) => ({ id: p.id, verdict: "ok" as const })),
          ],
          mcqItems: payload.mcqItems.map((m) =>
            m.id === "dl-r1-q1"
              ? { id: m.id, verdict: "issue" as const, reason: "distractor B is not attractively wrong" }
              : { id: m.id, verdict: "ok" as const },
          ),
        }));
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(verifyCalls).toBe(2);
      expect(repairCalls).toBe(1);
      expect(mcqRegenCalls).toBe(1);
      const published: unknown = JSON.parse(fs.readFileSync(publishedSetPath(setId), "utf8"));
      const parsed = AnySetSchema.parse(published);
      if (parsed.kind !== "reading") throw new Error("unreachable");
      expect(parsed.router.ctwPassages[0]!.gaps).toHaveLength(10);
      expect(parsed.router.dailyLife[0]!.questions[0]!.stem).toBe("REGENERATED stem for dl-r1-q1");
      fs.rmSync(publishedSetPath(setId));
    } catch (err) {
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });

  it("fails cleanly on a duplicate item id, before any verify call and without publishing", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    // Collide an MCQ id across two different daily-life texts in different modules — collectItemIds
    // flattens ids across all three modules, so this is caught set-wide, not just within one module.
    candidate.lowerModule.dailyLife[0]!.questions[0]!.id = "dl-r1-q1";

    // Spied rather than diffed against a directory listing: the claim is that THIS run wrote
    // nothing, which a spy on its own fs calls states directly whatever else the bank holds.
    const writeFile = vi.spyOn(fs, "writeFileSync");
    const rename = vi.spyOn(fs, "renameSync");

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "plan") {
        return skillSuccess(request.parse(plan));
      }
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) {
          return skillSuccess(request.parse(candidate));
        }
        if (request.prompt.includes("```ctw-derived-gaps")) {
          return skillSuccess(request.parse(okExplanationsResponse(request.prompt)));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      throw new Error("verify:reading must not be reached when the item-id pre-check fails");
    });

    try {
      const planner = createGenerationPlanner({ dataDir });
      await expect(
        generateSet("reading", { runSkillTask: runSkillTask as never, planner }),
      ).rejects.toThrow(/duplicate item id "dl-r1-q1"/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      writeFile.mockRestore();
      rename.mockRestore();
    }

    expect(runSkillTask.mock.calls.some((call) => call[0].task.task === "verify")).toBe(false);
    // No publish: nothing was ever staged or renamed into place — the failure lands before setId is
    // even minted (mintSetId only runs once a candidate is accepted), so there is nothing to clean up.
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
  });

  // setArtifacts.ts's cleanupUnpublishedSetArtifacts must clean up after a failed Reading job too;
  // if it skipped the reading kind, every failed reading job would leave its staging file behind.
  // This is a POST-MINT failure (unlike the duplicate-id test above, which fails before mintSetId
  // runs): the candidate is fully valid, so the pipeline reaches finalizeAndPublishSet with a real
  // rd- setId. crypto.randomUUID is pinned so the setId — and therefore the exact staging path
  // finalizeAndPublishSet's catch block must clean — is known up front; a leftover staging file is
  // pre-seeded there so cleanup has something real to remove, mirroring generator.test.ts's
  // "preserves a pre-existing audio target..." tests for speaking.
  //
  // The failure: the Verifier flags one MCQ "issue" every round, and every regeneration reply has a
  // correctOptionId that is not among its own options. checkMcqOptions (the same helper
  // deterministicReadingPreChecks runs on every fresh candidate) re-runs on each replacement and
  // rejects it, so no repair lands and the run ends on the verify-exhaustion path.
  it("cleans up staging artifacts for the minted rd- setId when an MCQ replacement has a dangling correctOptionId, and does not publish", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();

    const fixedUuid = "abcdef12-3456-7890-abcd-ef1234567890" as ReturnType<typeof crypto.randomUUID>;
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue(fixedUuid);
    const setId = "rd-abcdef12";
    const stagingPath = path.join(config.dataDir, "question-sets/.staging", `${setId}.json`);
    fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
    fs.writeFileSync(stagingPath, "leftover-from-a-different-crash");
    const publishedPath = publishedSetPath(setId);

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "plan") {
        return skillSuccess(request.parse(plan));
      }
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) {
          return skillSuccess(request.parse(candidate));
        }
        if (request.prompt.includes("```ctw-derived-gaps")) {
          return skillSuccess(request.parse(okExplanationsResponse(request.prompt)));
        }
        if (request.prompt.includes("```mcq-regeneration")) {
          const payload = extractFence(request.prompt, "mcq-regeneration") as {
            flaggedQuestions: {
              id: string;
              options: { id: string; text: string }[];
              skill: string;
            }[];
          };
          return skillSuccess(request.parse({
            questions: payload.flaggedQuestions.map((q) => ({
              id: q.id,
              stem: `REGENERATED stem for ${q.id}`,
              options: q.options,
              // Dangling: "z" is not one of this replacement's own option ids.
              correctOptionId: "z",
              skill: q.skill,
              explanationZh: `REGENERATED 解析 (${q.id})`,
            })),
          }));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      // verify:reading — flag exactly one MCQ item as an issue; every CtW passage is fine.
      const payload = extractFence(request.prompt, "json") as {
        ctwPassages: { id: string }[];
        mcqItems: { id: string }[];
      };
      const [badItem, ...restItems] = payload.mcqItems;
      return skillSuccess(request.parse({
        ctwPassages: payload.ctwPassages.map((p) => ({ id: p.id, verdict: "ok" as const })),
        mcqItems: [
          { id: badItem!.id, verdict: "issue" as const, reason: "correctOptionId does not match the text" },
          ...restItems.map((m) => ({ id: m.id, verdict: "ok" as const })),
        ],
      }));
    });

    try {
      const planner = createGenerationPlanner({ dataDir });
      // Each remediation call is wrapped, so a schema-valid but broken regeneration reply costs one
      // bounded retry instead of ending a paid run on the first miss. The mock returns the same
      // broken reply every round, so the run fails through the exhaustion path, with the cleanup and
      // the "nothing published" guarantee this test pins. The error names the root-cause CLASS —
      // the remediation category plus the error CLASS name, no message and no value — so an operator
      // whose paid run died to a persistently malformed reply has something to act on.
      await expect(
        generateSet("reading", { runSkillTask: runSkillTask as never, planner }),
      ).rejects.toThrow(/still has unresolved issues after \d+ verify attempts[\s\S]*remediation failures: MCQ wholesale \(Error\) x\d+/);
      // …and still no content: the offending option id/text never reaches the error string.
      await expect(
        generateSet("reading", { runSkillTask: runSkillTask as never, planner }),
      ).rejects.not.toThrow(/correctOptionId "z"/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      randomUUID.mockRestore();
    }

    // The leftover staging file for this exact rd- setId is gone (cleanupUnpublishedSetArtifacts
    // actually ran for a Reading Set, not just that it was reachable), and nothing was ever
    // published at the final path.
    expect(fs.existsSync(stagingPath)).toBe(false);
    expect(fs.existsSync(publishedPath)).toBe(false);
  });

  // MCQ remediation shares the CtW verdicts' MAX_VERIFY_ATTEMPTS budget, not an independent one — a
  // verifier that never accepts a replacement must still exhaust and hard-fail (with the same
  // post-mint cleanup as every other exhaustion path), not retry forever.
  it("exhausts MAX_VERIFY_ATTEMPTS when the same MCQ item is rejected every round, then hard-fails with cleanup", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    let verifyCalls = 0;
    let mcqRegenCalls = 0;

    const fixedUuid = "11111111-2222-3333-4444-555555555555" as ReturnType<typeof crypto.randomUUID>;
    const randomUUID = vi.spyOn(crypto, "randomUUID").mockReturnValue(fixedUuid);
    const setId = "rd-11111111";
    const stagingPath = path.join(config.dataDir, "question-sets/.staging", `${setId}.json`);
    fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
    fs.writeFileSync(stagingPath, "leftover-from-a-different-crash");
    const publishedPath = publishedSetPath(setId);

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "plan") {
        return skillSuccess(request.parse(plan));
      }
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) {
          return skillSuccess(request.parse(candidate));
        }
        if (request.prompt.includes("```ctw-derived-gaps")) {
          return skillSuccess(request.parse(okExplanationsResponse(request.prompt)));
        }
        if (request.prompt.includes("```mcq-regeneration")) {
          mcqRegenCalls += 1;
          const payload = extractFence(request.prompt, "mcq-regeneration") as {
            flaggedQuestions: {
              id: string;
              options: { id: string; text: string }[];
              correctOptionId: string;
              skill: string;
            }[];
          };
          // A schema-valid, pre-check-clean replacement — the verifier just never accepts it.
          return skillSuccess(request.parse({
            questions: payload.flaggedQuestions.map((q) => ({
              id: q.id,
              stem: `STILL BAD stem for ${q.id} (round ${mcqRegenCalls})`,
              options: q.options,
              correctOptionId: q.correctOptionId,
              skill: q.skill,
              explanationZh: `仍然不夠好的解析 (${q.id})`,
            })),
          }));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      // verify:reading — always flags the SAME MCQ item, every round.
      verifyCalls += 1;
      const payload = extractFence(request.prompt, "json") as {
        ctwPassages: { id: string }[];
        mcqItems: { id: string }[];
      };
      const [badItem, ...restItems] = payload.mcqItems;
      return skillSuccess(request.parse({
        ctwPassages: payload.ctwPassages.map((p) => ({ id: p.id, verdict: "ok" as const })),
        mcqItems: [
          { id: badItem!.id, verdict: "issue" as const, reason: `still an implausible distractor (round ${verifyCalls})` },
          ...restItems.map((m) => ({ id: m.id, verdict: "ok" as const })),
        ],
      }));
    });

    try {
      const planner = createGenerationPlanner({ dataDir });
      await expect(
        generateSet("reading", { runSkillTask: runSkillTask as never, planner }),
      // The exhaustion message lists each unresolved source rather than saying "verify:reading
      // flagged", because the branch is also reachable with an all-"ok" verify verdict
      // (deterministic content-gate violations alone). The budget is MAX_VERIFY_ATTEMPTS, 5.
      //
      // buildCandidate's three modules share their prose by construction (see its own comment), so
      // advisory band violations come ahead of the MCQ clause, labeled "not the cause of this
      // failure", which is exactly what an advisory kind must look like on an exhaustion path. Both
      // clauses are pinned, in order.
      //
      // The 7 advisory violations are three kinds measuring different units of the same fixture:
      //   • 2 module-difficulty-band: the router (FK 11.18) and the lower module (11.62) both read
      //     above their 10.5 ceiling; the upper module (13.38) is inside its high band.
      //   • 3 ctw-paragraph-difficulty-band: all four CtW passages carry SAMPLE_CTW_PARAGRAPH (FK
      //     11.50), above the router's and the lower module's ceiling, so the three router/lower
      //     paragraphs each report. The upper module's copy is silent — 11.50 is inside the high
      //     band — so each paragraph is read against ITS OWN module's band.
      //   • 2 passage-difficulty-band: the shared ACADEMIC_TEXT reads FK 15.62, so the router's and
      //     the lower module's academic passages are each out of band. The upper module's IDENTICAL
      //     passage is in band, so the per-passage kind is not merely restating the module-level one.
      // Every advisory kind is pinned by name and in push order (module → CtW paragraph → academic
      // passage, per module) rather than loosening the assertion: an advisory appearing here must
      // stay a deliberate, counted change.
      ).rejects.toThrow(
        /still has unresolved issues after 5 verify attempts: 7 advisory violation\(s\) also unresolved \(not the cause of this failure\): module-difficulty-band.*ctw-paragraph-difficulty-band.*passage-difficulty-band.*\| 1 MCQ item\(s\) with issues/s,
      );
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
      randomUUID.mockRestore();
    }

    expect(verifyCalls).toBe(5);
    // Regenerated after attempts 1-4; attempt 5 hits the exhaustion branch and throws instead.
    expect(mcqRegenCalls).toBe(4);
    expect(fs.existsSync(stagingPath)).toBe(false);
    expect(fs.existsSync(publishedPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The deterministic pre-publish content gate.
//
// generation-guide.md states rules a model does not always follow: an academic passage covers every
// skill slot, MCQ stems are English, and an explanationZh stays near its 120-字 target. Each is
// checkable without an LLM, so readingContentViolations runs on every verify round — including AFTER
// a remediation, so a replacement is measured again before it publishes. The gate enforces 200 字,
// a runaway guard; 120 is only the target the prompts state.
//
// The tests below all drive the same pipeline shape and differ only in what one sub-call returns, so
// they share one fake builder rather than restating the whole runSkillTask switch each time.
// ---------------------------------------------------------------------------

type McqRewritePayload = {
  stimulusId: string;
  overlongExplanations: { id: string; explanationZh: string; actualLength: number }[];
};

function contentGateRunner(options: {
  plan: ReturnType<typeof buildPlan>;
  candidate: ReturnType<typeof buildCandidate>;
  explanations?: (payload: { passageId: string; gaps: { id: string }[] }, prompt: string) =>
    { gapId: string; explanationZh: string }[];
  mcqExplanationRewrite?: (payload: McqRewritePayload) => { id: string; explanationZh: string }[];
  /**
   * A CtW passage repair (ctwRepairPrompt). Defaults to handing BACK the paragraph it was given — a
   * repair that never lands, so a gap leak survives every round and the Set publishes with it
   * recorded as an advisory note.
   */
  ctwRepair?: (currentParagraph: string, prompt: string) => string;
}) {
  const calls = {
    verify: 0,
    explanationPrompts: [] as string[],
    mcqRewritePayloads: [] as McqRewritePayload[],
    mcqRewritePrompts: [] as string[],
    ctwRepairPrompts: [] as string[],
  };
  const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
    emitRunning(request);
    if (request.task.task === "plan") {
      return skillSuccess(request.parse(options.plan));
    }
    if (request.task.task === "generate") {
      if (request.prompt.includes("```accepted-plan-json")) {
        return skillSuccess(request.parse(options.candidate));
      }
      if (request.prompt.includes("```ctw-derived-gaps")) {
        calls.explanationPrompts.push(request.prompt);
        const payload = extractFence(request.prompt, "ctw-derived-gaps") as {
          passageId: string;
          gaps: { id: string }[];
        };
        const explanations = options.explanations?.(payload, request.prompt)
          ?? payload.gaps.map((gap) => ({
            gapId: gap.id,
            explanationZh: `語意上只有這個答案符合上下文 (${gap.id})。`,
          }));
        return skillSuccess(request.parse({ explanations }));
      }
      if (request.prompt.includes("```current-paragraph")) {
        calls.ctwRepairPrompts.push(request.prompt);
        const currentParagraph = extractRawFence(request.prompt, "current-paragraph");
        const sourceParagraph = options.ctwRepair?.(currentParagraph, request.prompt) ?? currentParagraph;
        return skillSuccess(request.parse({ sourceParagraph }));
      }
      if (request.prompt.includes("```mcq-explanation-rewrite")) {
        const payload = extractFence(request.prompt, "mcq-explanation-rewrite") as McqRewritePayload;
        calls.mcqRewritePayloads.push(payload);
        calls.mcqRewritePrompts.push(request.prompt);
        if (!options.mcqExplanationRewrite) {
          throw new Error("fixture error: an MCQ explanation rewrite was not expected in this test");
        }
        return skillSuccess(request.parse({ explanations: options.mcqExplanationRewrite(payload) }));
      }
      throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
    }
    calls.verify += 1;
    return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
  });
  return { runSkillTask, calls };
}

async function generateReadingSet(runSkillTask: ReturnType<typeof vi.fn>): Promise<string> {
  const dataDir = readingDataDir();
  try {
    const planner = createGenerationPlanner({ dataDir });
    const result = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
    return result.setId;
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

async function expectReadingGenerationToFail(
  runSkillTask: ReturnType<typeof vi.fn>,
  matcher: RegExp,
): Promise<void> {
  const dataDir = readingDataDir();
  try {
    const planner = createGenerationPlanner({ dataDir });
    await expect(
      generateSet("reading", { runSkillTask: runSkillTask as never, planner }),
    ).rejects.toThrow(matcher);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function readPublishedReadingSet(setId: string) {
  const parsed = AnySetSchema.parse(JSON.parse(fs.readFileSync(publishedSetPath(setId), "utf8")));
  if (parsed.kind !== "reading") throw new Error("unreachable");
  return parsed;
}

/** A 繁體中文 explanation of exactly `codePoints` code points (and the same UTF-16 length). */
function zhExplanation(codePoints: number): string {
  return "解".repeat(codePoints);
}

describe("reading deterministic content gate", () => {
  // The gate's explanation limit is a RUNAWAY guard at 200 字, not the 120-字 authoring target. A
  // 128-字 rationale harms nobody, so it must not cost a rewrite; rambling far past 200 字 is what the
  // gate exists to stop. The two numbers are deliberately different — see the constants' comment in
  // generationVerifyRemediation.ts.
  it("publishes an explanationZh between the 120-字 target and the 200-字 limit without any rewrite", async () => {
    const plan = buildPlan();
    const candidate = buildCandidate();
    // 128 字: over the target, under the limit.
    const overTarget = zhExplanation(128);
    candidate.router.dailyLife[0]!.questions[0]!.explanationZh = overTarget;

    // No mcqExplanationRewrite hook: the fake throws if the gate wrongly triggers a rewrite.
    const { runSkillTask, calls } = contentGateRunner({ plan, candidate });
    const setId = await generateReadingSet(runSkillTask);
    try {
      expect(calls.mcqRewritePayloads).toHaveLength(0);
      expect(calls.verify).toBe(1);
      const parsed = readPublishedReadingSet(setId);
      expect(parsed.router.dailyLife[0]!.questions[0]!.explanationZh).toBe(overTarget);
    } finally {
      fs.rmSync(publishedSetPath(setId), { force: true });
    }
  });

  it("regenerates a CtW passage's explanations when one gap's explanationZh runs past 200 字, then publishes", async () => {
    const plan = buildPlan();
    const candidate = buildCandidate();
    // 231 字: past the 200-字 limit.
    const overlong = zhExplanation(231);
    expect([...overlong].length).toBe(231);

    const { runSkillTask, calls } = contentGateRunner({
      plan,
      candidate,
      explanations: (payload, prompt) => {
        const remediation = prompt.includes("```explanation-feedback");
        return payload.gaps.map((gap, i) => ({
          gapId: gap.id,
          explanationZh: !remediation && payload.passageId === "ctw-r1" && i === 0
            ? overlong
            : `語意上只有這個答案符合上下文 (${gap.id})。`,
        }));
      },
    });

    const setId = await generateReadingSet(runSkillTask);
    try {
      // The gate flagged the over-long gap, the CtW explanation call re-ran for ONLY that passage,
      // and its feedback named the offending gapId with its ACTUAL count and the limit (a model
      // cannot count 字 for itself, so the number has to come from the gate).
      const feedbackPrompts = calls.explanationPrompts.filter((p) => p.includes("```explanation-feedback"));
      expect(feedbackPrompts).toHaveLength(1);
      expect(feedbackPrompts[0]).toContain("ctw-r1-g1");
      // The measured count, because a model cannot count its own 字...
      expect(feedbackPrompts[0]).toContain("231");
      // ...the 120-字 TARGET, which the model is meant to see and aim at...
      expect(feedbackPrompts[0]).toContain("120");
      // ...and never the 200-字 TOLERANCE. A model lands just above whatever number it is given, so
      // showing it the gate's ceiling would park every explanation at 200 instead of near 120.
      expect(feedbackPrompts[0]).not.toContain("200");
      expect(calls.verify).toBe(2);

      const parsed = readPublishedReadingSet(setId);
      const passage = parsed.router.ctwPassages[0]!;
      expect(passage.id).toBe("ctw-r1");
      for (const gap of passage.gaps) expect([...gap.explanationZh].length).toBeLessThanOrEqual(120);
      expect(passage.gaps[0]!.explanationZh).not.toBe(overlong);
    } finally {
      fs.rmSync(publishedSetPath(setId), { force: true });
    }
  });

  it("rewrites ONLY a runaway MCQ explanationZh, leaving every other field byte-identical, then publishes", async () => {
    const plan = buildPlan();
    const candidate = buildCandidate();
    const overlong = zhExplanation(210);
    candidate.router.dailyLife[0]!.questions[0]!.explanationZh = overlong;
    const original = structuredClone(candidate.router.dailyLife[0]!.questions[0]!);

    const { runSkillTask, calls } = contentGateRunner({
      plan,
      candidate,
      mcqExplanationRewrite: (payload) =>
        payload.overlongExplanations.map((item) => ({
          id: item.id,
          explanationZh: `精簡後的解析 (${item.id})`,
        })),
    });

    const setId = await generateReadingSet(runSkillTask);
    try {
      expect(calls.mcqRewritePayloads).toHaveLength(1);
      expect(calls.mcqRewritePayloads[0]!.stimulusId).toBe("dl-r1");
      expect(calls.mcqRewritePayloads[0]!.overlongExplanations).toEqual([
        expect.objectContaining({ id: "dl-r1-q1", actualLength: 210 }),
      ]);
      // Same target/tolerance split as the CtW path: show the 120 target, never the 200 ceiling.
      expect(calls.mcqRewritePrompts[0]).toContain("120");
      expect(calls.mcqRewritePrompts[0]).not.toContain("200");
      expect(calls.verify).toBe(2);

      const parsed = readPublishedReadingSet(setId);
      const question = parsed.router.dailyLife.find((t) => t.id === "dl-r1")!.questions[0]!;
      expect(question.explanationZh).toBe("精簡後的解析 (dl-r1-q1)");
      // An explanation-only rewrite: swapping the original explanation back in reproduces the
      // question exactly — stem, options, correctOptionId and skill were never touched (apart from
      // the option rebalance — see withSortedOptions).
      expect(withSortedOptions({ ...question, explanationZh: original.explanationZh })).toEqual(withSortedOptions(original));
      // A sibling question on the same stimulus is untouched too.
      expect(withSortedOptions(parsed.router.dailyLife[0]!.questions[1]!)).toEqual(withSortedOptions(candidate.router.dailyLife[0]!.questions[1]!));
    } finally {
      fs.rmSync(publishedSetPath(setId), { force: true });
    }
  });

  it("publishes with a note when an MCQ explanation rewrite comes back STILL past 200 字 after every round", async () => {
    const plan = buildPlan();
    const candidate = buildCandidate();
    candidate.router.dailyLife[0]!.questions[0]!.explanationZh = zhExplanation(240);

    const { runSkillTask, calls } = contentGateRunner({
      plan,
      candidate,
      // Schema-valid, still runaway every time.
      mcqExplanationRewrite: (payload) =>
        payload.overlongExplanations.map((item) => ({ id: item.id, explanationZh: zhExplanation(205) })),
    });

    const setId = await generateReadingSet(runSkillTask);
    try {
      // Rewritten after rounds 1-4; round 5 is the last, so the finding is recorded, not repaired.
      expect(calls.mcqRewritePayloads).toHaveLength(4);
      // Verified in round 1, and again in round 2 at the rewritten text. Every later rewrite returns
      // that same text, which already passed, so it is not re-sent.
      expect(calls.verify).toBe(2);
      const parsed = readPublishedReadingSet(setId);
      expect(parsed.advisoryNotes).toContainEqual(
        expect.objectContaining({ check: "content-gate", detail: "explanation-length-mcq", taskType: "daily_life" }),
      );
    } finally {
      fs.rmSync(publishedSetPath(setId), { force: true });
    }
  });

  it("publishes an academic passage missing the \"organization\" category, with a note, without a repair call", async () => {
    const plan = buildPlan();
    const candidate = buildCandidate();
    // ap-lo1's fifth question is retagged "detail": the passage asks detail twice, and no question
    // covers the idea-relationship slot.
    candidate.lowerModule.academic[0]!.questions[4]!.skill = "detail";

    const { runSkillTask, calls } = contentGateRunner({ plan, candidate });
    const setId = await generateReadingSet(runSkillTask);
    try {
      expect(calls.verify).toBe(1);
      expect(calls.mcqRewritePayloads).toHaveLength(0);
      expect(readPublishedReadingSet(setId).advisoryNotes).toContainEqual(
        expect.objectContaining({ check: "content-gate", detail: "academic-coverage", taskType: "academic_passage" }),
      );
    } finally {
      fs.rmSync(publishedSetPath(setId), { force: true });
    }
  });

  // deterministicReadingPreChecks reports the remediable violations too, not only the one it failed
  // on: an operator who fixed only the named defect would otherwise pay for another full run before
  // learning about the rest. A wrong module shape is the one Reading content-gate kind that blocks.
  it("includes both the blocking violation it hard-failed on and any remediable violations found in the same candidate, clearly distinguished", async () => {
    const set = await assembledReadingSet();
    set.lowerModule.dailyLife = set.lowerModule.dailyLife.slice(0, 1);
    set.router.dailyLife[0]!.questions[0]!.explanationZh = zhExplanation(210);

    let thrown: Error | undefined;
    try {
      deterministicReadingPreChecks(set);
    } catch (err) {
      thrown = err as Error;
    }
    expect(thrown).toBeDefined();
    const message = thrown!.message;
    expect(message).toContain("composition");
    expect(message).toContain("lowerModule");
    expect(message).toContain("explanation-length-mcq");
    expect(message).toContain('"dl-r1-q1"');
    expect(message).toContain("210");
    expect(message).toMatch(/blocking/i);
    expect(message).toMatch(/remediable/i);
    expect(message.indexOf("composition")).toBeLessThan(message.indexOf("explanation-length-mcq"));
  });

  it("counts explanationZh by CODE POINTS, not UTF-16 units: a 200-code-point explanation with a surrogate pair publishes", async () => {
    const plan = buildPlan();
    const candidate = buildCandidate();
    // One astral emoji (1 code point, 2 UTF-16 units) + 199 BMP characters.
    const borderline = `🧪${zhExplanation(199)}`;
    expect([...borderline].length).toBe(200);   // exactly on the limit by 字 count
    expect(borderline.length).toBe(201);        // a naive .length would have wrongly rejected it
    candidate.router.dailyLife[0]!.questions[0]!.explanationZh = borderline;

    // No mcqExplanationRewrite hook: the fake throws if the gate wrongly triggers a rewrite.
    const { runSkillTask, calls } = contentGateRunner({ plan, candidate });
    const setId = await generateReadingSet(runSkillTask);
    try {
      expect(calls.mcqRewritePayloads).toHaveLength(0);
      expect(calls.verify).toBe(1);
      const parsed = readPublishedReadingSet(setId);
      expect(parsed.router.dailyLife[0]!.questions[0]!.explanationZh).toBe(borderline);
    } finally {
      fs.rmSync(publishedSetPath(setId), { force: true });
    }
  });
});

// Every rejected candidate attempt gets its own log line, as every rejected plan attempt does in
// generationPlanner.reserve(). Only the last attempt's reason reaches the exhaustion error, and a
// rejected candidate has already cost a full generate call plus one explanation call per CtW
// passage, so without the log an earlier rejection would vanish with its reason.
describe("reading candidate rejection observability", () => {
  // Driven by the difficulty inversion, the only reason Reading's candidate stage rejects (domain
  // drift is recorded on the Set instead). EVERY rejected attempt is logged, not just the last, and
  // nothing the log carries is the plan's own prose.
  it("logs every rejected candidate, and carries the last attempt's reason into the exhaustion error", async () => {
    const plan = buildPlan();
    const { runSkillTask, calls } = contentGateRunner({ plan, candidate: invertedDifficultyCandidate() });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await expectReadingGenerationToFail(
        runSkillTask,
        /upper module is not harder than lower module after 3 attempts/,
      );

      const logged = errorSpy.mock.calls.filter((call) =>
        String(call[0]).includes("reading candidate attempt"),
      );
      // One line per rejected attempt, not just the last.
      expect(logged).toHaveLength(3);
      expect(String(logged[0]![0])).toContain("attempt 1/3");
      expect(String(logged[2]![0])).toContain("attempt 3/3");
      // The line says which way the comparison went and by how much, in grades and counts.
      const detail = String(logged[0]![0]);
      expect(detail).toContain("upper module reads no harder than lower");
      expect(detail).toContain("grade");
      // The plan's own scenario text must never reach a log or a thrown message, error paths
      // included (diversityIssues.ts states the rule for planLabel). "notice: a paperless billing
      // notice from the housing office" is the raw planLabel (genre: scenario) generationCatalog.ts
      // builds for a Daily Life slot of this plan.
      expect(detail).not.toContain("notice: a paperless billing notice from the housing office");
      expect(detail).not.toContain("planLabel");
    } finally {
      errorSpy.mockRestore();
    }

    // Rejected before verification, so the log lines above are each rejection's only trace.
    expect(calls.verify).toBe(0);
  });

  // The inverse guarantee, and the one that matters more often — a candidate whose ONLY problems are
  // advisory is published, carrying them, instead of costing more generate calls.
  it("publishes a candidate whose only problem is domain drift, recording it as an advisory note", async () => {
    const plan = buildPlan();
    const { runSkillTask, calls } = contentGateRunner({ plan, candidate: domainDriftCandidate() });
    const dataDir = readingDataDir();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const planner = createGenerationPlanner({ dataDir });
      const { setId } = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
      expect(setId).toBeTruthy();
      // Verification ran, which only happens once a candidate has been ACCEPTED — the drift never
      // cost a retry and never blocked publication.
      expect(calls.verify).toBeGreaterThan(0);
    } finally {
      warnSpy.mockRestore();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // The thrown exhaustion message becomes job.error, which the job API returns and the client
  // displays, so it must carry none of the plan's own prose: not its scenario/topic/title text
  // (planLabel) and not its raw requiredConcepts strings. Captures the full thrown message directly
  // (rather than a `toThrow` substring match) so the absence is actually pinned, not just the
  // presence of the parts that survive.
  it("never leaks the plan's raw scenario/concept text into the thrown exhaustion message", async () => {
    const plan = buildPlan();
    // Driven by the difficulty inversion, the only reason Reading's candidate stage rejects. Its
    // detail is built entirely out of grades and counts, so there is no prose in it to leak.
    const { runSkillTask } = contentGateRunner({ plan, candidate: invertedDifficultyCandidate() });
    const dataDir = readingDataDir();
    let thrown: Error | undefined;
    try {
      const planner = createGenerationPlanner({ dataDir });
      await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
    } catch (err) {
      thrown = err as Error;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("upper module is not harder than lower module after 3 attempts");
    expect(thrown!.message).toContain("grade");
    expect(thrown!.message).not.toContain("notice: a paperless billing notice from the housing office");
    expect(thrown!.message).not.toContain("planLabel");
    expect(thrown!.message).not.toContain("failedConcepts");
    // Nor any of the candidate's own passage text, which is what the comparison actually read.
    expect(thrown!.message).not.toContain("epistemological");
  });

  // The one retry a Reading candidate can earn: a difficulty inversion on attempt 1 produces an
  // attempt-2 prompt that tells the model to make the upper module harder.
  it("executes readingGenerationPrompt's difficulty-retry branch: a candidate rejected on attempt 1 produces an attempt-2 prompt demanding a harder upper module", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const attempt1Candidate = invertedDifficultyCandidate();
    const attempt2Candidate = buildCandidate();

    let retryPrompt: string | undefined;
    let generateCallCount = 0;

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") {
        return skillSuccess(request.parse(plan));
      }
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) {
          generateCallCount += 1;
          if (request.prompt.includes("UPPER MODULE")) {
            retryPrompt = request.prompt;
            return skillSuccess(request.parse(attempt2Candidate));
          }
          return skillSuccess(request.parse(attempt1Candidate));
        }
        if (request.prompt.includes("```ctw-derived-gaps")) {
          return skillSuccess(request.parse(okExplanationsResponse(request.prompt)));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(generateCallCount).toBe(2);
      expect(retryPrompt).toBeDefined();
      expect(retryPrompt).toContain("no harder to understand");
      expect(retryPrompt).toContain("change the LEVEL of the language");
      // Gate-only: the model is told WHAT to change, never the index it is graded on.
      expect(retryPrompt).not.toContain("grade");
      expect(retryPrompt).not.toContain("syllable");
      // Two calls also means attempt 1 carried no retry direction: had its prompt said "UPPER
      // MODULE", the fake would have answered with the good candidate and published on one call.
      expect(generateCallCount).toBe(2);

      fs.rmSync(publishedSetPath(setId));
    } catch (err) {
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });
});

// Module composition is unreachable through generateSet — ReadingGenerationInputSchema already pins
// each module's array lengths (schemas.reading.test.ts covers that). ReadingSetSchema, which is what
// every remediation re-parses against, pins neither composition nor the CtW paragraph's 70–100-word
// band, so the gate still has to check both; these cases pin its boundaries and messages directly.
// The over-ceiling side is also exercised end to end in "reading content gate — advisory tiers".
describe("readingContentViolations (direct)", () => {
  function emptyModule(): ReadingModule {
    return { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] };
  }

  it("flags every module whose composition does not match READING_MODULE_COMPOSITION", () => {
    const violations = readingContentViolations({
      router: emptyModule(),
      lowerModule: emptyModule(),
      upperModule: emptyModule(),
    });
    expect(violations.filter((v) => v.kind === "composition")).toHaveLength(3);
    expect(violations.map((v) => v.detail).join(" ")).toContain("expected 2 CtW + 3 daily-life + 1 academic");
    // The Upper Module's expectation is 1 + 0 + 1: the upper path carries no Daily Life text.
    const upper = violations.find((v) => v.kind === "composition" && v.label === "upperModule");
    expect(upper?.detail).toContain("expected 1 CtW + 0 daily-life + 1 academic");
  });

  // The other half: an Upper Module with no Daily Life text draws no composition violation, so the
  // gate reads READING_MODULE_COMPOSITION rather than a copy of it.
  it("does not flag an upper module that carries no daily-life text", () => {
    const upperModule: ReadingModule = {
      ...emptyModule(),
      ctwPassages: [{
        id: "ctw-up1", taskType: "complete_words", topic: "topic",
        segments: [], sourceParagraph: SAMPLE_CTW_PARAGRAPH, gaps: [],
      }],
      academic: [academicCandidateEntry("ap-up1", ["q1", "q2", "q3", "q4", "q5"])],
    };
    const violations = readingContentViolations({
      router: emptyModule(), lowerModule: emptyModule(), upperModule,
    });
    expect(violations.some((v) => v.kind === "composition" && v.label === "upperModule")).toBe(false);
  });

  it("flags a CtW source paragraph outside the 70-100 word band", () => {
    const module = emptyModule();
    module.ctwPassages = [{
      id: "ctw-x1",
      taskType: "complete_words",
      topic: "too short",
      segments: [],
      sourceParagraph: "Far too short to be a real Complete the Words paragraph.",
      gaps: [],
    }];
    const violations = readingContentViolations({
      router: module,
      lowerModule: emptyModule(),
      upperModule: emptyModule(),
    });
    const wordCount = violations.find((v) => v.kind === "word-count");
    expect(wordCount?.id).toBe("ctw-x1");
    expect(wordCount?.detail).toContain("expected 70-100");
  });

  // The other end of the same band is a DIFFERENT kind, `ctw-word-count-over`, so a note says which
  // side of the range the paragraph missed. Both kinds are advisory: a paragraph that reaches the
  // gate has already derived its 10 gaps.
  it("flags a CtW source paragraph past the ceiling as its own kind, not word-count", () => {
    const module = emptyModule();
    module.ctwPassages = [{
      id: "ctw-long",
      taskType: "complete_words",
      topic: "too long",
      segments: [],
      // 101 words: one past the ceiling.
      sourceParagraph: Array.from({ length: 101 }, (_, i) => `word${i}`).join(" "),
      gaps: [],
    }];
    const violations = readingContentViolations({
      router: module,
      lowerModule: emptyModule(),
      upperModule: emptyModule(),
    });
    // The CtW upper bound is its OWN kind; `word-count` must not fire for it.
    expect(violations.find((v) => v.kind === "word-count")).toBeUndefined();
    const over = violations.find((v) => v.kind === "ctw-word-count-over");
    expect(over?.id).toBe("ctw-long");
    expect(over?.detail).toContain("101 words");
  });

  // The guide's "exactly 4 options per question" is the mechanism; this deterministic check is the
  // backstop. Advisory by tier (generationCheckPolicy.test.ts pins that): a 3-option question is
  // usable — worse guessing odds, not a wrong answer — so it must be flagged here without ever
  // blocking.
  it("flags a sub-4-option MCQ as option-count and stays quiet on an exactly-4-option one", () => {
    const mcqWithOptions = (id: string, texts: readonly string[]) => ({
      id, stem: `Stem for ${id}?`,
      // Same-length texts so the set-wide option-length-bias check cannot co-fire and muddy this.
      options: texts.map((text, i) => ({ id: "abcd"[i]!, text })),
      correctOptionId: "b", skill: "detail" as const,
      explanationZh: "正解說明文中提到的內容;其他選項與原文不符。",
    });
    const module = emptyModule();
    module.dailyLife = [{
      id: "dl-x1", taskType: "daily_life", genre: "notice", text: "A short notice text.",
      questions: [
        mcqWithOptions("dl-x1-q1", ["Option A", "Option B", "Option C"]),
        mcqWithOptions("dl-x1-q2", ["Option A", "Option B", "Option C", "Option D"]),
      ],
    }];
    const violations = readingContentViolations({
      router: module,
      lowerModule: emptyModule(),
      upperModule: emptyModule(),
    });
    const optionCount = violations.filter((v) => v.kind === "option-count");
    expect(optionCount).toHaveLength(1);
    expect(optionCount[0]!.id).toBe("dl-x1-q1");
    expect(optionCount[0]!.label).toBe("router/daily_life/dl-x1");
    expect(optionCount[0]!.detail).toContain("has 3 options, expected exactly 4");
  });

  // Every OTHER test in this describe block hands two empty modules to the checker, so this is also
  // the pin that a wordless module contributes no band violation — see placeAgainstBand's comment
  // (moduleDifficulty.ts) for why that is deliberate rather than convenient.
  it("measures nothing for the empty modules every other case in this block passes in", () => {
    const violations = readingContentViolations({
      router: emptyModule(),
      lowerModule: emptyModule(),
      upperModule: emptyModule(),
    });
    expect(violations.filter((v) => v.kind === "module-difficulty-band")).toEqual([]);
  });
});

/**
 * The absolute per-module difficulty bands, seen through the content gate that publishes them.
 *
 * moduleDifficulty.test.ts pins the measurement and the tier; this pins the WIRING: that
 * readingContentViolations actually consults the bands, once per module, and reports the result as a
 * `module-difficulty-band` violation labelled with the module it belongs to.
 *
 * Grades of the fixtures below, by this repo's own index: MEDIUM_MODULE_PROSE 8.60 (inside medium,
 * 7.4-10.5), HIGH_MODULE_PROSE 14.90 (inside high, 10.5-20.0).
 */
describe("readingContentViolations: each module's absolute difficulty band", () => {
  const MEDIUM_MODULE_PROSE =
    "The city council opened a new library branch near the river last spring. Residents can borrow " +
    "books, join a reading group, or use the study rooms on the second floor. Staff report that " +
    "afternoon visits have doubled since the branch began offering free tutoring for local students.";
  const HIGH_MODULE_PROSE =
    "The sediment record appears continuous, but the intervals separating successive volcanic layers " +
    "imply a depositional break. That break complicates any simple chronological reading of the sequence.";

  function moduleReading(text: string, id = "ap-x1"): ReadingModule {
    return {
      timeLimitSec: 540,
      ctwPassages: [],
      dailyLife: [],
      academic: [{
        id,
        taskType: "academic_passage",
        title: "A Title",
        discipline: "life science",
        text,
        questions: [],
      }],
    } as never;
  }

  function bandViolations(set: {
    router: ReadingModule;
    lowerModule: ReadingModule;
    upperModule: ReadingModule;
  }) {
    return readingContentViolations(set).filter((v) => v.kind === "module-difficulty-band");
  }

  // The shape ETS's design asks for: a moderate router, an at-or-below-moderate lower module, a high
  // upper module. Nothing is reported, even though every module here is otherwise malformed (no CtW,
  // no questions) — proving the band check is independent of the rest of the gate.
  it("stays quiet when every module sits inside its own band", () => {
    expect(bandViolations({
      router: moduleReading(MEDIUM_MODULE_PROSE),
      lowerModule: moduleReading(MEDIUM_MODULE_PROSE),
      upperModule: moduleReading(HIGH_MODULE_PROSE),
    })).toEqual([]);
  });

  // The router is held to the medium band at both ends: prose harder than moderate is flagged.
  it("flags a router that reads harder than moderate", () => {
    const flagged = bandViolations({
      router: moduleReading(HIGH_MODULE_PROSE),
      lowerModule: moduleReading(MEDIUM_MODULE_PROSE),
      upperModule: moduleReading(HIGH_MODULE_PROSE),
    });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.label).toBe("router");
    expect(flagged[0]!.id).toBe("router");
    expect(flagged[0]!.detail).toContain("above the router band 7.4-10.5");
    expect(flagged[0]!.detail).toContain("(medium, TextEvaluator 800-1100)");
  });

  // A lower module must never read at high difficulty: its band ends where the high band begins.
  it("flags a lower module that reads as high difficulty", () => {
    const flagged = bandViolations({
      router: moduleReading(MEDIUM_MODULE_PROSE),
      lowerModule: moduleReading(HIGH_MODULE_PROSE),
      upperModule: moduleReading(HIGH_MODULE_PROSE),
    });
    expect(flagged.map((v) => v.label)).toEqual(["lowerModule"]);
    expect(flagged[0]!.detail).toContain("above the lowerModule band 4.0-10.5");
  });

  // The upper module's own failure mode, which the RELATIVE gate is blind to: it passes as long as
  // upper is not easier than lower, no matter that neither reached the high band.
  it("flags an upper module that never left the medium band", () => {
    const flagged = bandViolations({
      router: moduleReading(MEDIUM_MODULE_PROSE),
      lowerModule: moduleReading(MEDIUM_MODULE_PROSE),
      upperModule: moduleReading(MEDIUM_MODULE_PROSE),
    });
    expect(flagged.map((v) => v.label)).toEqual(["upperModule"]);
    expect(flagged[0]!.detail).toContain("below the upperModule band 10.5-20.0");
  });

  it("reports each offending module once, and names no passage text", () => {
    const flagged = bandViolations({
      router: moduleReading(HIGH_MODULE_PROSE),
      lowerModule: moduleReading(HIGH_MODULE_PROSE),
      upperModule: moduleReading(MEDIUM_MODULE_PROSE),
    });
    expect(flagged.map((v) => v.label)).toEqual(["router", "lowerModule", "upperModule"]);
    // `detail` reaches job.error and the Dashboard — numbers and enum-shaped words only.
    for (const violation of flagged) {
      expect(violation.detail).not.toContain("sediment");
      expect(violation.detail).not.toContain("library");
    }
  });

  /**
   * The same bands, per academic passage, seen through the content gate.
   *
   * moduleDifficulty.test.ts pins the measurement, the band reuse and the tier; this pins the
   * WIRING: that readingContentViolations consults the passage bands once per academic passage and
   * reports the result as a `passage-difficulty-band` violation labelled with the passage, not the
   * module.
   */
  describe("the per-academic-passage band", () => {
    function passageBandViolations(set: {
      router: ReadingModule;
      lowerModule: ReadingModule;
      upperModule: ReadingModule;
    }) {
      return readingContentViolations(set).filter((v) => v.kind === "passage-difficulty-band");
    }

    it("stays quiet when every academic passage sits inside its module's band", () => {
      expect(passageBandViolations({
        router: moduleReading(MEDIUM_MODULE_PROSE),
        lowerModule: moduleReading(MEDIUM_MODULE_PROSE),
        upperModule: moduleReading(HIGH_MODULE_PROSE),
      })).toEqual([]);
    });

    // Labelled with the PASSAGE, three segments — which is what makes the note it becomes carry
    // `taskType: academic_passage`, the thing the whole-module kind deliberately cannot say.
    it("flags an upper-module passage that never left the medium band, naming the passage", () => {
      const flagged = passageBandViolations({
        router: moduleReading(MEDIUM_MODULE_PROSE),
        lowerModule: moduleReading(MEDIUM_MODULE_PROSE),
        upperModule: moduleReading(MEDIUM_MODULE_PROSE),
      });
      expect(flagged).toHaveLength(1);
      expect(flagged[0]!.label).toBe("upperModule/academic/ap-x1");
      expect(flagged[0]!.id).toBe("ap-x1");
      expect(flagged[0]!.detail).toContain("academic passage reads grade");
      expect(flagged[0]!.detail).toContain("below the upperModule band 10.5-20.0");
      expect(flagged[0]!.detail).not.toContain("library");
    });

    it("flags a router passage that reads harder than moderate", () => {
      const flagged = passageBandViolations({
        router: moduleReading(HIGH_MODULE_PROSE),
        lowerModule: moduleReading(MEDIUM_MODULE_PROSE),
        upperModule: moduleReading(HIGH_MODULE_PROSE),
      });
      expect(flagged.map((v) => v.label)).toEqual(["router/academic/ap-x1"]);
      expect(flagged[0]!.detail).toContain("above the router band 7.4-10.5");
    });

    // The independence proof: the module's pooled text (a dense CtW paragraph plus this passage)
    // reads 10.79, inside the upper module's high band, while the passage itself reads 8.60 and is
    // below it. The per-module check reports nothing here; the per-passage check reports the passage.
    it("catches a passage the pooled per-module check clears", () => {
      const upperModule = {
        ...moduleReading(MEDIUM_MODULE_PROSE),
        ctwPassages: [{
          id: "ctw-x1", taskType: "complete_words", topic: "t",
          segments: [], gaps: [], sourceParagraph: HIGH_MODULE_PROSE,
        }],
      } as ReadingModule;
      const set = {
        router: moduleReading(MEDIUM_MODULE_PROSE),
        lowerModule: moduleReading(MEDIUM_MODULE_PROSE),
        upperModule,
      };
      expect(readingContentViolations(set).filter((v) => v.kind === "module-difficulty-band")).toEqual([]);
      expect(passageBandViolations(set).map((v) => v.id)).toEqual(["ap-x1"]);
    });

    // `itemPosition` is the index into the PLAN's own `academicPassages` array — router entries
    // first, then lowerModule, then upperModule, the same coordinate generationCatalog.ts's
    // entriesFromReadingPlan assigns and the same convention `ctw-paragraph-difficulty-band` uses.
    // The lower module's passage is IN band and reports nothing, yet still consumes position 1: the
    // counter walks every passage, so a note's position stays a plan coordinate rather than a rank
    // among violations.
    it("addresses each passage by its slot in the plan's own academicPassages array", () => {
      const flagged = passageBandViolations({
        router: moduleReading(HIGH_MODULE_PROSE, "ap-r1"),
        lowerModule: moduleReading(MEDIUM_MODULE_PROSE, "ap-lo1"),
        upperModule: moduleReading(MEDIUM_MODULE_PROSE, "ap-up1"),
      });
      expect(flagged.map((v) => [v.id, v.itemPosition])).toEqual([["ap-r1", 0], ["ap-up1", 2]]);
    });

    it("measures nothing for modules with no academic passage", () => {
      expect(passageBandViolations({
        router: emptyReadingModule(),
        lowerModule: emptyReadingModule(),
        upperModule: emptyReadingModule(),
      })).toEqual([]);
    });
  });
});

/**
 * The academic-coverage gate and its skill-slot rotation.
 *
 * The rule ACADEMIC_SKILL_SLOTS encodes: five slots, five questions, and three of the slots accept a
 * ROTATION ALTERNATE in place of their primary category. The two properties worth pinning are that a
 * passage using only the primary categories (or main_idea for detail) passes, and that an alternate
 * genuinely SATISFIES its slot rather than merely being parseable.
 */
describe("readingContentViolations: academic skill-slot coverage and rotation", () => {
  function academicWith(skills: readonly string[]): ReadingModule {
    return {
      timeLimitSec: 540,
      ctwPassages: [],
      dailyLife: [],
      academic: [{
        id: "ap-x1",
        taskType: "academic_passage",
        title: "A Title",
        discipline: "life science",
        // In band for the router (FK 8.60), so nothing here also trips the passage band advisory.
        text:
          "The city council opened a new library branch near the river last spring. Residents can "
          + "borrow books, join a reading group, or use the study rooms on the second floor. Staff "
          + "report that afternoon visits have doubled since the branch began offering free tutoring "
          + "for local students.",
        questions: skills.map((skill, i) => ({
          id: `ap-x1-q${i + 1}`,
          stem: `Stem ${i + 1}`,
          options: [
            { id: "a", text: "Option A" }, { id: "b", text: "Option B" },
            { id: "c", text: "Option C" }, { id: "d", text: "Option D" },
          ],
          correctOptionId: "a",
          skill,
          explanationZh: `題目 ${i + 1}:正解說明文中明確提到的內容;其他選項與原文不符。`,
        })),
      }],
    } as never;
  }

  function coverageViolations(skills: readonly string[]) {
    return readingContentViolations({
      router: academicWith(skills),
      lowerModule: emptyReadingModule(),
      upperModule: emptyReadingModule(),
    }).filter((v) => v.kind === "academic-coverage");
  }

  const PRIMARIES = ["organization", "purpose", "inference", "vocabulary", "detail"] as const;

  it("accepts the five primary categories, and main_idea in place of detail", () => {
    expect(coverageViolations(PRIMARIES)).toEqual([]);
    expect(coverageViolations(["organization", "purpose", "inference", "vocabulary", "main_idea"])).toEqual([]);
  });

  it("accepts each rotation alternate standing in for its own slot's primary", () => {
    expect(coverageViolations(["rhetorical_structure", "purpose", "inference", "vocabulary", "detail"])).toEqual([]);
    expect(coverageViolations(["organization", "purpose", "inference", "figurative_language", "detail"])).toEqual([]);
    expect(coverageViolations(["organization", "purpose", "inference", "vocabulary", "grammatical_complexity"])).toEqual([]);
    // All three at once — still five questions, still five covered slots.
    expect(coverageViolations([
      "rhetorical_structure", "purpose", "inference", "figurative_language", "grammatical_complexity",
    ])).toEqual([]);
  });

  // Rotation, not accumulation: an alternate REPLACES its slot's primary, so using one to cover a
  // slot that is already covered leaves a different slot empty — and that is still flagged.
  it("still fails a passage that leaves a slot uncovered, however the five tags are spent", () => {
    const flagged = coverageViolations([
      "vocabulary", "figurative_language", "purpose", "inference", "detail",
    ]);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.detail).toContain("idea-relationship");
    // Names what to add — the primary first, then the alternates that would also satisfy the slot.
    expect(flagged[0]!.detail).toContain('needs "organization" or one of its rotation alternates "rhetorical_structure"');
    expect(flagged[0]!.detail).toContain("present: vocabulary, figurative_language, purpose, inference, detail");
  });

  it("keeps the two slots that have no alternate un-substitutable", () => {
    // `rhetorical_structure` covers the idea-relationship slot, NOT purpose — letting one question
    // claim both would let a passage stop asking about purpose entirely.
    const noPurpose = coverageViolations([
      "organization", "rhetorical_structure", "inference", "vocabulary", "detail",
    ]);
    expect(noPurpose.map((v) => v.detail.split(":")[0])).toEqual(["has no author's-purpose question"]);
    expect(noPurpose[0]!.detail).toContain('needs "purpose"');
    expect(noPurpose[0]!.detail).not.toContain("rotation alternates");
  });

  it("reports every uncovered slot, in table order, and still counts the five questions", () => {
    const flagged = coverageViolations(["detail", "detail", "detail"]);
    expect(flagged.map((v) => v.detail.split(":")[0])).toEqual([
      "has 3 questions, expected 5",
      "has no idea-relationship question",
      "has no author's-purpose question",
      "has no inference question",
      "has no word-meaning question",
    ]);
  });

  // An uncovered slot leaves every question answerable and keyed correctly — a blueprint miss — so
  // it is recorded on the Set rather than failing it (ADR-0006).
  it("records academic-coverage rather than blocking on it", () => {
    const check = { family: "content-gate", section: "reading", kind: "academic-coverage" } as const;
    expect(classifyGenerationCheck(check).tier).toBe("advisory");
    expect(blocksGeneration(check)).toBe(false);
  });
});

/**
 * The same bands, asked of one Complete the Words paragraph at a time.
 *
 * moduleDifficulty.test.ts pins the measurement and the tier; this pins the WIRING: that
 * readingContentViolations consults the bands once per CtW passage, names the passage it asked about,
 * and addresses it positionally for the published note.
 *
 * What is NOT under test here, and must never be: the gap derivation. ctest.ts reproduces ETS's own
 * algorithm (RR-25-12 §II-3 — intact first sentence, second half of every 2nd token, 10 gaps), the
 * 70-100 word budget is a separate check, and this check reads `sourceParagraph` before a single
 * letter is deleted from it. The fixtures below therefore carry no gaps at all.
 *
 * Grades of the fixtures, by this repo's own index: MEDIUM_PARAGRAPH 8.60 (inside medium, 7.4-10.5),
 * HIGH_PARAGRAPH 14.90 (inside high, 10.5-20.0).
 */
describe("readingContentViolations: each CtW paragraph's difficulty band", () => {
  const MEDIUM_PARAGRAPH =
    "The city council opened a new library branch near the river last spring. Residents can borrow " +
    "books, join a reading group, or use the study rooms on the second floor. Staff report that " +
    "afternoon visits have doubled since the branch began offering free tutoring for local students.";
  const HIGH_PARAGRAPH =
    "The sediment record appears continuous, but the intervals separating successive volcanic layers " +
    "imply a depositional break. That break complicates any simple chronological reading of the sequence.";

  function moduleWithCtw(
    paragraphs: readonly (readonly [string, string])[],
    pooling: { readonly dailyLife?: readonly string[]; readonly academic?: readonly string[] } = {},
  ): ReadingModule {
    return {
      timeLimitSec: 540,
      ctwPassages: paragraphs.map(([id, sourceParagraph]) => ({
        id, taskType: "complete_words", topic: "a topic", sourceParagraph, segments: [], gaps: [],
      })),
      dailyLife: (pooling.dailyLife ?? []).map((text, i) => ({
        id: `dl-${i}`, taskType: "daily_life", genre: "notice", text, questions: [],
      })),
      academic: (pooling.academic ?? []).map((text, i) => ({
        id: `ap-${i}`, taskType: "academic_passage", title: "A Title", discipline: "life science",
        text, questions: [],
      })),
    } as never;
  }

  function paragraphBandViolations(set: {
    router: ReadingModule;
    lowerModule: ReadingModule;
    upperModule: ReadingModule;
  }) {
    return readingContentViolations(set).filter((v) => v.kind === "ctw-paragraph-difficulty-band");
  }

  it("stays quiet when every paragraph sits inside its own module's band", () => {
    expect(paragraphBandViolations({
      router: moduleWithCtw([["ctw-r1", MEDIUM_PARAGRAPH], ["ctw-r2", MEDIUM_PARAGRAPH]]),
      lowerModule: moduleWithCtw([["ctw-lo1", MEDIUM_PARAGRAPH]]),
      upperModule: moduleWithCtw([["ctw-up1", HIGH_PARAGRAPH]]),
    })).toEqual([]);
  });

  // The upper module's paragraph is the one ETS writes at the register of an adapted authentic
  // source; one that never left the medium band is the defect the generation guide's upper-module CtW
  // rule exists to prevent, and this advisory is how it gets reported.
  it("flags an upper-module paragraph that never left the medium band, naming that paragraph", () => {
    const flagged = paragraphBandViolations({
      router: moduleWithCtw([["ctw-r1", MEDIUM_PARAGRAPH], ["ctw-r2", MEDIUM_PARAGRAPH]]),
      lowerModule: moduleWithCtw([["ctw-lo1", MEDIUM_PARAGRAPH]]),
      upperModule: moduleWithCtw([["ctw-up1", MEDIUM_PARAGRAPH]]),
    });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.label).toBe("upperModule/ctw/ctw-up1");
    expect(flagged[0]!.id).toBe("ctw-up1");
    expect(flagged[0]!.detail).toContain("source paragraph reads grade 8.60");
    expect(flagged[0]!.detail).toContain("below the upperModule band 10.5-20.0");
    expect(flagged[0]!.detail).toContain("(high, TextEvaluator 1100-1360+)");
  });

  // The router and lower module are held to their own bands by the same call — a paragraph is measured
  // against the band ITS module is designed for, never against one shared paragraph band.
  it("holds a router and a lower-module paragraph to their own bands", () => {
    const flagged = paragraphBandViolations({
      router: moduleWithCtw([["ctw-r1", HIGH_PARAGRAPH], ["ctw-r2", MEDIUM_PARAGRAPH]]),
      lowerModule: moduleWithCtw([["ctw-lo1", HIGH_PARAGRAPH]]),
      upperModule: moduleWithCtw([["ctw-up1", HIGH_PARAGRAPH]]),
    });
    expect(flagged.map((v) => v.id)).toEqual(["ctw-r1", "ctw-lo1"]);
    expect(flagged[0]!.detail).toContain("above the router band 7.4-10.5");
    expect(flagged[1]!.detail).toContain("above the lowerModule band 4.0-10.5");
  });

  // The whole reason for the second granularity: this router pools to FK 9.93, comfortably inside
  // medium, so the module-level check reports nothing at all — while the paragraph
  // carrying ten of that module's items reads a full band above where it belongs.
  it("sees an out-of-band paragraph inside a module whose pooled text is in band", () => {
    const set = {
      router: moduleWithCtw([["ctw-r1", HIGH_PARAGRAPH]], {
        dailyLife: [MEDIUM_PARAGRAPH],
        academic: [MEDIUM_PARAGRAPH],
      }),
      lowerModule: moduleWithCtw([["ctw-lo1", MEDIUM_PARAGRAPH]]),
      upperModule: moduleWithCtw([["ctw-up1", HIGH_PARAGRAPH]]),
    };
    expect(
      readingContentViolations(set).filter((v) => v.kind === "module-difficulty-band" && v.id === "router"),
    ).toEqual([]);
    expect(paragraphBandViolations(set).map((v) => v.id)).toEqual(["ctw-r1"]);
  });

  // `itemPosition` is the index into the PLAN's own `ctwPassages` array — router entries first, then
  // lowerModule, then upperModule, the order the generation guide fixes. It is what lets the published
  // note say WHICH paragraph without carrying a producer-authored id (see contentGateNotes).
  it("addresses each paragraph by its slot in the plan's own ctwPassages array", () => {
    const flagged = paragraphBandViolations({
      router: moduleWithCtw([["ctw-r1", HIGH_PARAGRAPH], ["ctw-r2", HIGH_PARAGRAPH]]),
      lowerModule: moduleWithCtw([["ctw-lo1", HIGH_PARAGRAPH]]),
      upperModule: moduleWithCtw([["ctw-up1", MEDIUM_PARAGRAPH]]),
    });
    expect(flagged.map((v) => [v.id, v.itemPosition])).toEqual([
      ["ctw-r1", 0], ["ctw-r2", 1], ["ctw-lo1", 2], ["ctw-up1", 3],
    ]);
  });

  it("names grades, counts and band edges — never a word of the paragraph's own prose", () => {
    const flagged = paragraphBandViolations({
      router: moduleWithCtw([["ctw-r1", HIGH_PARAGRAPH]]),
      lowerModule: moduleWithCtw([["ctw-lo1", HIGH_PARAGRAPH]]),
      upperModule: moduleWithCtw([["ctw-up1", MEDIUM_PARAGRAPH]]),
    });
    // `detail` reaches job.error and the Dashboard — numbers and enum-shaped words only.
    for (const violation of flagged) {
      expect(violation.detail).not.toContain("sediment");
      expect(violation.detail).not.toContain("library");
    }
  });

  // Every other case in this block hands the checker paragraphs; this is the pin that a module with no
  // CtW passage at all contributes nothing, which is what keeps the other direct blocks (all of which
  // build empty modules for the two they are not exercising) free of band noise.
  it("measures nothing for a module with no CtW passages", () => {
    expect(paragraphBandViolations({
      router: moduleWithCtw([]),
      lowerModule: moduleWithCtw([]),
      upperModule: moduleWithCtw([]),
    })).toEqual([]);
  });
});

// The rebalanceReadingOptionOrder tests below call it DIRECTLY, and the "byte-identical" pipeline
// assertions above are order-insensitive (withSortedOptions), so neither pins that the real publish
// path CALLS it: finishReadingSet hands it to finishVerifiedSet as the `rebalance` hook. This test
// goes through the REAL `generateSet` pipeline (no direct call to the function under test) and
// asserts the PUBLISHED Set's option order differs from what the candidate itself specified, which is
// only true if that wiring holds.
describe("generateSet (reading) rebalances option order before publishing", () => {
  it("actually calls the rebalance step: a published question's option CONTENT order and correctOptionId differ from the candidate's own", async () => {
    // Ids are relabelled to canonical position order after every shuffle, so
    // `options.map(o => o.id)` is ALWAYS ["a","b","c","d"] and cannot distinguish "rebalanced" from
    // "untouched" — comparing by TEXT order (the actual content permutation) and by correctOptionId
    // (which label the correct content carries) is what detects the wiring.
    const plan = buildPlan();
    const candidate = buildCandidate();
    const { runSkillTask } = contentGateRunner({ plan, candidate });
    const originalTextOrder = candidate.router.dailyLife[0]!.questions[0]!.options.map((o) => o.text);
    const originalCorrectOptionId = candidate.router.dailyLife[0]!.questions[0]!.correctOptionId;

    const spy = vi.spyOn(Math, "random").mockReturnValue(0); // -> a real, computable left-rotate-by-1
    let setId: string;
    try {
      setId = await generateReadingSet(runSkillTask);
    } finally {
      spy.mockRestore();
    }
    try {
      const parsed = readPublishedReadingSet(setId);
      const question = parsed.router.dailyLife[0]!.questions[0]!;
      const publishedTextOrder = question.options.map((o) => o.text);
      // If finishReadingSet stopped rebalancing, both of these would equal the originals exactly,
      // and this would fail.
      expect(publishedTextOrder).not.toEqual(originalTextOrder);
      expect(question.correctOptionId).not.toBe(originalCorrectOptionId);
      expect(new Set(publishedTextOrder)).toEqual(new Set(originalTextOrder)); // still the same option texts
      expect(question.options.map((o) => o.id)).toEqual(["a", "b", "c", "d"]); // ids always canonical post-relabel
      fs.rmSync(publishedSetPath(setId));
    } catch (err) {
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Answer-key position, fixed by construction (rebalanceReadingOptionOrder).
// ---------------------------------------------------------------------------

describe("rebalanceReadingOptionOrder spreads answer keys across positions", () => {
  function mcqAt(id: string, correctIndex: number, optionCount = 4) {
    const letters = ["a", "b", "c", "d"].slice(0, optionCount);
    return {
      id,
      stem: `Stem ${id}`,
      options: letters.map((letter) => ({ id: letter, text: `Option ${letter.toUpperCase()}` })),
      correctOptionId: letters[correctIndex]!,
      skill: "detail" as const,
      explanationZh: `解析 ${id}`,
    };
  }

  function emptyModule(): ReadingModule {
    return { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] };
  }

  function setWithQuestions(questions: ReturnType<typeof mcqAt>[]) {
    return {
      id: "rd-fixture", kind: "reading" as const, source: "generated" as const,
      createdAt: "2026-08-09T00:00:00.000Z",
      router: { ...emptyModule(), dailyLife: [{ id: "dl-1", taskType: "daily_life" as const, genre: "notice", text: "text", questions }] },
      lowerModule: emptyModule(),
      upperModule: emptyModule(),
    };
  }

  it("constant rng=0 produces a real, non-identity permutation of ALL options AND relabels ids to position (a full Fisher–Yates plus relabel, not just a move of the key)", () => {
    // Hand-traced: with rng() always 0, every swap step picks j=0, which is a left-rotate-by-1 —
    // content order [a,b,c,d] -> [b,c,d,a] (i.e. option "a"'s TEXT ends up at array index 3). The
    // relabel step then reassigns the ORIGINAL label sequence (a,b,c,d) by POSITION, so whatever
    // content sits at index 3 (originally "a"'s text) is now labelled "d" — and correctOptionId
    // follows the TEXT, becoming "d". Pinning the whole array AND correctOptionId's new value is
    // what distinguishes "permuted order only" from "relabeled too".
    const set = setWithQuestions([mcqAt("q1", 0)]); // correct ("a") starts at index 0
    const rebalanced = rebalanceReadingOptionOrder(set, () => 0);
    const question = rebalanced.router.dailyLife[0]!.questions[0]!;
    expect(question.options.map((o) => o.id)).toEqual(["a", "b", "c", "d"]); // labels always canonical
    expect(question.options.map((o) => o.text)).toEqual(["Option B", "Option C", "Option D", "Option A"]);
    expect(question.correctOptionId).toBe("d"); // the correct TEXT ("Option A") now carries label "d"
    expect(question.options.find((o) => o.id === "d")!.text).toBe("Option A");
  });

  it("constant rng just under 1 is the identity permutation (every swap picks the top of its own shrinking range) — relabeling is then a true no-op", () => {
    // Hand-traced: rng() -> just under 1 always picks j=i (Math.floor((1-ε)*(i+1)) === i), so every
    // "swap" is a no-op, and the relabel step reassigns each option its OWN original label right back.
    const set = setWithQuestions([mcqAt("q1", 0)]);
    const rebalanced = rebalanceReadingOptionOrder(set, () => 0.999999);
    const question = rebalanced.router.dailyLife[0]!.questions[0]!;
    expect(question.options.map((o) => o.id)).toEqual(["a", "b", "c", "d"]);
    expect(question.options.map((o) => o.text)).toEqual(["Option A", "Option B", "Option C", "Option D"]);
    expect(question.correctOptionId).toBe("a");
  });

  it("preserves the full CONTENT (option texts) and which text is correct — only which id/position that text carries changes", () => {
    const set = setWithQuestions([mcqAt("q1", 2)]); // correct is "c" ("Option C")
    const rebalanced = rebalanceReadingOptionOrder(set, () => 0.42);
    const question = rebalanced.router.dailyLife[0]!.questions[0]!;
    expect(new Set(question.options.map((o) => o.id))).toEqual(new Set(["a", "b", "c", "d"])); // same label set
    expect(new Set(question.options.map((o) => o.text))).toEqual(new Set(["Option A", "Option B", "Option C", "Option D"])); // same texts
    // correctOptionId still designates "Option C"'s text, whatever label it now carries.
    expect(question.options.find((o) => o.id === question.correctOptionId)!.text).toBe("Option C");
  });

  it("leaves an item with a dangling correctOptionId untouched — checkMcqOptions's violation to catch, not this function's", () => {
    const broken = mcqAt("q1", 0);
    broken.correctOptionId = "z";
    const set = setWithQuestions([broken]);
    const rebalanced = rebalanceReadingOptionOrder(set, () => 0.99);
    expect(rebalanced.router.dailyLife[0]!.questions[0]!.options).toEqual(broken.options);
    expect(rebalanced.router.dailyLife[0]!.questions[0]!.correctOptionId).toBe("z");
  });

  it("defaults to Math.random when no rng is supplied (production behavior)", () => {
    const set = setWithQuestions([mcqAt("q1", 0)]);
    const spy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const rebalanced = rebalanceReadingOptionOrder(set);
      const question = rebalanced.router.dailyLife[0]!.questions[0]!;
      expect(question.options.map((o) => o.text)).toEqual(["Option B", "Option C", "Option D", "Option A"]);
      expect(question.correctOptionId).toBe("d");
    } finally {
      spy.mockRestore();
    }
  });

  // The id-ORDER attack: a shuffle that moved only the key and preserved distractor order would
  // deliver a sorted id sequence with exactly one element displaced — always the key. This runs that
  // attack (guess uniformly among whichever ids' removal would restore sorted order) against the REAL
  // production path over many trials. Relabeling makes ids ALWAYS canonically sorted (options[0] is
  // always labelled "a", etc.), so the attack degenerates to "every id is a candidate" — pure chance
  // — which is itself worth pinning, not just assuming.
  it("id-ORDER attack: guessing from id order alone is at chance", () => {
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
      const set = setWithQuestions([mcqAt("q1", 0)]);
      const rebalanced = rebalanceReadingOptionOrder(set); // real Math.random, the production path
      const question = rebalanced.router.dailyLife[0]!.questions[0]!;
      const guess = idOrderAttackGuess(question.options.map((o) => o.id));
      if (guess === question.correctOptionId) hits += 1;
    }
    const accuracy = hits / TRIALS;
    expect(accuracy).toBeGreaterThan(0.15);
    expect(accuracy).toBeLessThan(0.37);
  });

  // The id-IDENTITY attack — "always guess id `a`" — is the channel a shuffle that only permutes
  // leaves open. Every input item here starts biased at "a" (correctOptionId "a" on every one), so a
  // shuffleMcqOptions that left `correctOptionId`'s VALUE untouched would make this test measure ~100%
  // for "guess a", not chance. Real Math.random, the production path.
  it("closes the id-IDENTITY attack: even when every item's INPUT key is biased toward one label, the OUTPUT key's label is uniform, not still skewed", () => {
    const TRIALS = 2000;
    const labelCounts: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const set = setWithQuestions([mcqAt("q1", 0)]); // input correctOptionId is ALWAYS "a"
      const rebalanced = rebalanceReadingOptionOrder(set); // real Math.random
      const question = rebalanced.router.dailyLife[0]!.questions[0]!;
      labelCounts[question.correctOptionId] = (labelCounts[question.correctOptionId] ?? 0) + 1;
    }
    // "Always guess a" attack accuracy — chance is 25%; a shuffle that never remapped
    // correctOptionId would measure ~100% here, since every input was seeded at "a".
    const guessAAccuracy = labelCounts.a! / TRIALS;
    expect(guessAAccuracy).toBeGreaterThan(0.15);
    expect(guessAAccuracy).toBeLessThan(0.37);
    // Every label gets a roughly equal share of the 2000 draws — not just "a" avoided, genuinely
    // uniform across all four.
    for (const label of ["a", "b", "c", "d"]) {
      const share = labelCounts[label]! / TRIALS;
      expect(share).toBeGreaterThan(0.15);
      expect(share).toBeLessThan(0.37);
    }
  });

  it("spreads a Set whose keys are ALL at index 0 across more than one index", () => {
    // Real Math.random (the production path), not a constant rng: a constant rng applied to 8
    // identically-shaped (4-option) questions would deterministically produce the SAME permutation
    // for every one of them, which would defeat this test's own point.
    const questions = Array.from({ length: 8 }, (_, i) => mcqAt(`q${i}`, 0));
    const set = setWithQuestions(questions);
    const rebalanced = rebalanceReadingOptionOrder(set);
    const positions = rebalanced.router.dailyLife[0]!.questions.map(
      (q) => q.options.findIndex((o) => o.id === q.correctOptionId),
    );
    expect(new Set(positions).size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// Option-length bias (direct detection). The detection itself is optionQuality.ts's
// optionLengthBiasFlags, shared with Listening.
// ---------------------------------------------------------------------------

describe("readingContentViolations: option-length bias", () => {
  // 4 options, not 3 — every Reading MCQ has 4 (28/28 on the published `rd-6d02b750`), and each
  // group's ceiling derives from its Items' own chance rate (1/n, times 1.4), so a 3-option fixture
  // would exercise a looser ceiling than the one Reading's real generations are held to.
  function mcqOfLengths(id: string, lengths: number[], correctIndex: number) {
    return {
      id,
      stem: `Stem ${id}`,
      options: lengths.map((len, i) => ({ id: `o${i}`, text: "x".repeat(len) })),
      correctOptionId: `o${correctIndex}`,
      skill: "detail" as const,
      explanationZh: `解析 ${id}`,
    };
  }

  function moduleWithQuestions(questions: ReturnType<typeof mcqOfLengths>[]): ReadingModule {
    return {
      timeLimitSec: 540, ctwPassages: [], academic: [],
      dailyLife: [{ id: "dl-1", taskType: "daily_life", genre: "notice", text: "text", questions }],
    };
  }

  // A variant that splits `questions` across BOTH task-type buckets, for the per-bucket tests below
  // — `dailyLife` gets the first `dailyLifeCount`, `academic` gets the rest.
  function moduleWithBuckets(
    questions: ReturnType<typeof mcqOfLengths>[],
    dailyLifeCount: number,
  ): ReadingModule {
    return {
      timeLimitSec: 540, ctwPassages: [],
      dailyLife: [{ id: "dl-1", taskType: "daily_life", genre: "notice", text: "text", questions: questions.slice(0, dailyLifeCount) }],
      academic: [{ id: "ap-1", taskType: "academic_passage", title: "Title", discipline: "biology", text: "text", questions: questions.slice(dailyLifeCount) }],
    };
  }

  function emptyModule(): ReadingModule {
    return { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] };
  }

  // Flags only a group's EXCESS over its own ceiling, not every flagged item in it, so a marginal
  // group does not send all its Items for regeneration. 10 of 10 biased; the group's own chance count
  // is 10 * 0.25 = 2.5 and its effect-size ceiling is 2.5 * 1.4 = 3.5, so bringing it back to the
  // ceiling takes 10 - floor(3.5) = 7 fixes, not 10.
  it("flags only the EXCESS over the group's own ceiling, not every item in the offending group", () => {
    const questions = Array.from({ length: 10 }, (_, i) => mcqOfLengths(`q${i}`, [50, 20, 20, 20], 0));
    const violations = readingContentViolations({
      router: moduleWithQuestions(questions), lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    const bias = violations.filter((v) => v.kind === "option-length-bias");
    expect(bias).toHaveLength(7);
    expect(bias.every((v) => v.detail.includes("10 of 10"))).toBe(true);
    expect(new Set(bias.map((v) => v.id)).size).toBe(7); // distinct offending items, not repeats
    // The property that makes 7 the right number: fixing exactly these leaves the group AT its own
    // ceiling, so a second round is not needed for this group.
    const remaining = questions.filter((q) => !bias.some((v) => v.id === q.id));
    const stillBiased = remaining.filter((q) => q.options.every((o) => o.id === q.correctOptionId || o.text.length < 50));
    expect(stillBiased).toHaveLength(3);
  });

  it("caps the per-round draw at MAX_LONGEST_OPTION_REMEDIATIONS_PER_ROUND and DEFERS the rest to a later round", () => {
    // 30 of 30 biased: the excess alone is 30 - floor(30 * 0.25 * 1.4) = 20, past the per-round cap.
    const questions = Array.from({ length: 30 }, (_, i) => mcqOfLengths(`q${i}`, [50, 20, 20, 20], 0));
    const violations = readingContentViolations({
      router: moduleWithQuestions(questions), lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    const bias = violations.filter((v) => v.kind === "option-length-bias");
    expect(bias).toHaveLength(12); // MAX_LONGEST_OPTION_REMEDIATIONS_PER_ROUND
    expect(new Set(bias.map((v) => v.id)).size).toBe(12);
  });

  it("does not flag anything when the share is near the ~25% neutral rate (inside the per-bucket 0.35 ceiling for an all-4-option bucket)", () => {
    const questions = [
      ...Array.from({ length: 3 }, (_, i) => mcqOfLengths(`long${i}`, [50, 20, 20, 20], 0)),
      // correct option is NOT the longest here (index 0, but option 1 is longest)
      ...Array.from({ length: 7 }, (_, i) => mcqOfLengths(`short${i}`, [20, 50, 20, 20], 0)),
    ];
    const violations = readingContentViolations({
      router: moduleWithQuestions(questions), lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    expect(violations.filter((v) => v.kind === "option-length-bias")).toHaveLength(0);
  });

  // 4 of 10 is a 1-in-4.5 event under chance (P(X>=4 | n=10, p=0.25) = 0.224), so flagging it would
  // mean flagging a quarter of all chance-neutral 10-item groups. The noise bound (NEUTRAL_TAIL_ALPHA
  // in optionQuality.ts) declines it, while a skew in a group big enough to establish it is still
  // flagged; that constant's comment gives the real-Set case it is set to catch. This test is the
  // false-positive half of that trade.
  it("does NOT flag a 40% share on 10 items — a 1-in-4.5 event under chance is not evidence of a cue", () => {
    const questions = [
      ...Array.from({ length: 4 }, (_, i) => mcqOfLengths(`long${i}`, [50, 20, 20, 20], 0)),
      ...Array.from({ length: 6 }, (_, i) => mcqOfLengths(`short${i}`, [20, 50, 20, 20], 0)),
    ];
    const violations = readingContentViolations({
      router: moduleWithQuestions(questions), lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    expect(violations.filter((v) => v.kind === "option-length-bias")).toHaveLength(0);
  });

  // One item whose key happens to be its longest option is a 1-in-4 event under chance, so the noise
  // bound declines it. Flagging single-item groups would flood chance-neutral Sets with false
  // positives and make the finer group levels unaffordable.
  it("does NOT flag a single-item population — one key being longest is a 1-in-4 event, not a cue", () => {
    const violations = readingContentViolations({
      router: moduleWithQuestions([mcqOfLengths("q1", [50, 20, 20, 20], 0)]),
      lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    expect(violations.filter((v) => v.kind === "option-length-bias")).toHaveLength(0);
  });

  // A Set-wide aggregate can pass while one bucket (task type) is far past its own neutral rate.
  // daily_life: 8 of 10 biased (80%, well past its own 0.35). academic: 0 of 10 biased (0%). The
  // pooled 20-item group (8 of 20) is plausible under chance and is not flagged, so every flag comes
  // from the daily_life group: daily_life is flagged AND academic contributes nothing.
  it("flags the offending bucket (daily_life) while the clean bucket (academic) contributes nothing, rather than one Set-wide aggregate verdict", () => {
    const questions = [
      ...Array.from({ length: 8 }, (_, i) => mcqOfLengths(`dl-long${i}`, [50, 20, 20, 20], 0)),
      ...Array.from({ length: 2 }, (_, i) => mcqOfLengths(`dl-short${i}`, [20, 50, 20, 20], 0)),
      ...Array.from({ length: 10 }, (_, i) => mcqOfLengths(`ap-short${i}`, [20, 50, 20, 20], 0)),
    ];
    const violations = readingContentViolations({
      router: moduleWithBuckets(questions, 10), lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    const bias = violations.filter((v) => v.kind === "option-length-bias");
    expect(bias.length).toBeGreaterThan(0);
    expect(bias.every((v) => v.id.startsWith("dl-long"))).toBe(true);
    expect(bias.every((v) => v.detail.includes(`"daily_life"`))).toBe(true);
  });

  // daily_life alone is at 90% (9 of 10, way past 0.35), academic alone at 0% (0 of 10). Every flag's
  // `detail` attributes the finding to daily_life specifically, with that bucket's own 9 of 10, not
  // to "the Set" — the message an operator and a regeneration prompt actually need.
  it("attributes the finding to its own bucket in `detail`, by bucket name and that bucket's own N of M", () => {
    const questions = [
      ...Array.from({ length: 9 }, (_, i) => mcqOfLengths(`dl-long${i}`, [50, 20, 20, 20], 0)),
      ...Array.from({ length: 1 }, (_, i) => mcqOfLengths(`dl-short${i}`, [20, 50, 20, 20], 0)),
      ...Array.from({ length: 10 }, (_, i) => mcqOfLengths(`ap-short${i}`, [20, 50, 20, 20], 0)),
    ];
    const violations = readingContentViolations({
      router: moduleWithBuckets(questions, 10), lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    const bias = violations.filter((v) => v.kind === "option-length-bias");
    expect(bias.length).toBeGreaterThan(0);
    expect(bias.every((v) => v.detail.includes(`within "daily_life", 9 of 10`))).toBe(true);
  });

  // One bucket concentrated well past ITS ceiling while the pooled share stays within its own:
  // 30 daily_life items, none biased, + 30 academic items, 21 biased (70%, over academic's own 0.35).
  // The CLEAN bucket contributes ZERO flagged items even though the OTHER bucket is over its own
  // ceiling — the check is genuinely PER-BUCKET, not a single pooled measurement that also flags
  // daily_life items once academic pulls the pooled share up.
  it("a clean bucket contributes ZERO flagged items even while a different bucket is over its own ceiling — proving the check is per-bucket, not pooled", () => {
    // daily_life is fully clean so that the pooled 60-item group stays inside its OWN ceiling (21 of
    // 60, against a chance count of 15 and a ceiling of exactly 21). A pooled group over its ceiling
    // would legitimately draw items from both buckets, leaving this property untestable.
    const questions = [
      ...Array.from({ length: 30 }, (_, i) => mcqOfLengths(`dl-short${i}`, [20, 50, 20, 20], 0)),
      ...Array.from({ length: 21 }, (_, i) => mcqOfLengths(`ap-long${i}`, [50, 20, 20, 20], 0)),
      ...Array.from({ length: 9 }, (_, i) => mcqOfLengths(`ap-short${i}`, [20, 50, 20, 20], 0)),
    ];
    const violations = readingContentViolations({
      router: moduleWithBuckets(questions, 30), lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    const bias = violations.filter((v) => v.kind === "option-length-bias");
    expect(bias.length).toBeGreaterThan(0);
    expect(bias.some((v) => v.id.startsWith("dl-"))).toBe(false); // daily_life (0%) is clean
    expect(bias.every((v) => v.id.startsWith("ap-long"))).toBe(true); // only academic's offenders
  });

  // Pins the round-robin draw itself — two DIFFERENT offending buckets, each with more flagged items
  // than half the per-round cap, must both contribute, rather than the first-traversed bucket
  // (daily_life) consuming the whole cap and starving academic entirely. Traversal order would leave
  // the residual bias in whatever was traversed last.
  it("draws the per-round cap round-robin across offending buckets, not traversal order — both buckets contribute", () => {
    const questions = [
      ...Array.from({ length: 10 }, (_, i) => mcqOfLengths(`dl-long${i}`, [50, 20, 20, 20], 0)),
      ...Array.from({ length: 10 }, (_, i) => mcqOfLengths(`ap-long${i}`, [50, 20, 20, 20], 0)),
    ];
    const violations = readingContentViolations({
      router: moduleWithBuckets(questions, 10), lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    const bias = violations.filter((v) => v.kind === "option-length-bias");
    // Each bucket's own excess is 10 - floor(10 * 0.25 * 1.4) = 7, and the pooled 20-item group's is
    // 20 - floor(20 * 0.25 * 1.4) = 13, so 17 distinct items are eligible and the per-round cap of 12
    // binds — the point being HOW the 12 are drawn, not that 12 is the number.
    expect(bias).toHaveLength(12);
    const dailyLifeCount = bias.filter((v) => v.id.startsWith("dl-")).length;
    const academicCount = bias.filter((v) => v.id.startsWith("ap-")).length;
    expect(dailyLifeCount).toBeGreaterThan(0);
    expect(academicCount).toBeGreaterThan(0);
  });

  // The MODULE axis. `academic` pooled across all three modules is 5 of 30 (16.7%) — comfortably
  // under its own ceiling, so the pooled group passes. But every one of those 5 sits in upperModule,
  // whose own group is 5 of 5 at 100%. Modules are what a test taker actually meets (a
  // router-plus-upper taker sees exactly two of the three), so an upper-module concentration is fully
  // exploitable by the learners who reach it.
  it("catches a concentration confined to ONE module even though the pooled task-type group passes", () => {
    const clean = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => mcqOfLengths(`${prefix}${i}`, [20, 50, 20, 20], 0));
    const biased = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => mcqOfLengths(`${prefix}${i}`, [50, 20, 20, 20], 0));
    const academicModule = (id: string, questions: ReturnType<typeof mcqOfLengths>[]): ReadingModule => ({
      timeLimitSec: 540, ctwPassages: [], dailyLife: [],
      academic: [{ id, taskType: "academic_passage", title: "Title", discipline: "biology", text: "text", questions }],
    });
    const violations = readingContentViolations({
      router: academicModule("ap-r1", clean("r-clean", 10)),
      lowerModule: academicModule("ap-lo1", clean("lo-clean", 15)),
      upperModule: academicModule("ap-up1", biased("up-long", 5)),
    });
    const bias = violations.filter((v) => v.kind === "option-length-bias");
    expect(bias.length).toBeGreaterThan(0);
    expect(bias.every((v) => v.id.startsWith("up-long"))).toBe(true);
    // On this fixture the upper module's `module`, `module+task-type` and option-count groups share
    // membership, so they are tested once and the first level's name is reported; the pattern
    // accepts any of the three.
    expect(bias.every((v) => /within "upperModule(?:\/academic(?:\/4-option)?)?"/.test(v.detail))).toBe(true);
    // And the pooled task-type group really does pass on its own — otherwise this test would prove
    // nothing about the module split.
    expect(bias.some((v) => /within "academic",/.test(v.detail))).toBe(false);
  });

  // The correct option is the strictly-longest by WORD COUNT (3 words vs. 1 word each) despite NOT
  // being the strictly-longest by character length (all four options are the same length): the gate
  // measures both, so a word-count cue is caught on its own.
  it("flags a bucket biased by WORD COUNT alone, with every option the same CHARACTER length", () => {
    const wordsOfCount = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const questions = Array.from({ length: 10 }, (_, i) => ({
      id: `q${i}`,
      stem: `Stem q${i}`,
      // Every option is padded to the SAME character length; only word count differs.
      options: [
        { id: "o0", text: wordsOfCount(3).padEnd(20, ".") },
        { id: "o1", text: wordsOfCount(1).padEnd(20, ".") },
        { id: "o2", text: wordsOfCount(1).padEnd(20, ".") },
        { id: "o3", text: wordsOfCount(1).padEnd(20, ".") },
      ],
      correctOptionId: "o0",
      skill: "detail" as const,
      explanationZh: `解析 q${i}`,
    }));
    for (const q of questions) {
      expect(new Set(q.options.map((o) => o.text.length)).size).toBe(1); // sanity: chars tie
    }
    const violations = readingContentViolations({
      router: moduleWithQuestions(questions), lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    expect(violations.filter((v) => v.kind === "option-length-bias").length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Pipeline-level proof that option-length bias is remediable, not blocking.
// ---------------------------------------------------------------------------

describe("generateSet (reading) repairs option-length bias", () => {
  it("regenerates the flagged MCQ questions and still publishes, rather than hard-failing the run", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    // Make every daily-life/academic MCQ's correct option the strictly-longest choice across the
    // WHOLE candidate, so every group the gate tests is far past its ceiling.
    const bias = (q: ReturnType<typeof mcq>) => ({
      ...q,
      options: q.options.map((o, i) => ({ ...o, text: o.id === q.correctOptionId ? "x".repeat(80) : `short${i}` })),
    });
    for (const moduleName of ["router", "lowerModule", "upperModule"] as const) {
      candidate[moduleName].dailyLife = candidate[moduleName].dailyLife.map((t) => ({ ...t, questions: t.questions.map(bias) }));
      candidate[moduleName].academic = candidate[moduleName].academic.map((p) => ({ ...p, questions: p.questions.map(bias) }));
    }

    let verifyCalls = 0;
    const mcqRegenPrompts: { stimulusId: string; flaggedQuestions: { id: string; reason: string }[] }[] = [];
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") return skillSuccess(request.parse(plan));
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) return skillSuccess(request.parse(candidate));
        if (request.prompt.includes("```ctw-derived-gaps")) return skillSuccess(request.parse(okExplanationsResponse(request.prompt)));
        if (request.prompt.includes("```mcq-regeneration")) {
          const payload = extractFence(request.prompt, "mcq-regeneration") as {
            stimulusId: string;
            flaggedQuestions: { id: string; options: { id: string; text: string }[]; correctOptionId: string; skill: string; reason: string }[];
          };
          mcqRegenPrompts.push(payload);
          return skillSuccess(request.parse({
            questions: payload.flaggedQuestions.map((q) => ({
              id: q.id,
              stem: `FIXED-LENGTH stem for ${q.id}`,
              // Comparable option lengths this time — the fix a real model call would make.
              options: q.options.map((o) => ({ id: o.id, text: "same-length-ish" })),
              correctOptionId: q.correctOptionId,
              skill: q.skill,
              explanationZh: `解析 ${q.id}`,
            })),
          }));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      verifyCalls += 1;
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      // The run PUBLISHED: option-length bias is a distribution property, repaired rather than
      // blocking. It took at least 2 verify rounds (round 1 measures the skew and triggers
      // remediation; a later round confirms it cleared).
      expect(verifyCalls).toBeGreaterThanOrEqual(2);
      expect(mcqRegenPrompts.length).toBeGreaterThan(0);
      // Every regeneration call carried at least one flagged question.
      for (const call of mcqRegenPrompts) {
        expect(call.flaggedQuestions.length).toBeGreaterThan(0);
      }
      const parsed = readPublishedReadingSet(setId!);
      const allQuestions = [
        ...READING_MODULE_NAMES.flatMap((m) => parsed[m].dailyLife.flatMap((t) => t.questions)),
        ...READING_MODULE_NAMES.flatMap((m) => parsed[m].academic.flatMap((p) => p.questions)),
      ];
      const stillStrictlyLongest = allQuestions.filter((q) => {
        const lengths = q.options.map((o) => o.text.length);
        const max = Math.max(...lengths);
        const correctLength = q.options.find((o) => o.id === q.correctOptionId)!.text.length;
        return correctLength === max && lengths.filter((l) => l === max).length === 1;
      });
      // The published Set is no longer skewed: at most half its keys are the strictly longest option.
      expect(stillStrictlyLongest.length / allQuestions.length).toBeLessThanOrEqual(0.5);
      fs.rmSync(publishedSetPath(setId!));
    } catch (err) {
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });

  // The per-round cap DEFERS rather than skips: an Item the cap leaves out is flagged in a later
  // round. Pinning that needs a second round of flagging, so the fixture must hold more offenders
  // than one round clears. It biases EVERY scoreable MCQ in the Set (25: both task types, all three
  // modules, 100%). Round 1 flags the cap's 12 and leaves 13 of 25 still biased, which keeps the
  // whole-Set group far over its ceiling, so round 2 must flag a different batch. The count is
  // asserted so a composition retune fails here loudly rather than silently skipping the property.
  it("a ceiling that defers: round 2 flags a DIFFERENT batch of ids than round 1, not the same ones re-flagged or nothing at all", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    // The biased questions keep 3 options, a 1/3 chance rate each. That shape also fires the
    // option-count check, which is `advisory` (recorded on the Set, never blocking, no remediation
    // route), so it cannot change the rounds this test measures.
    const bias = (q: ReturnType<typeof mcq>) => ({
      ...q,
      options: q.options.slice(0, 3).map((o, i) => ({ ...o, text: o.id === q.correctOptionId ? "x".repeat(80) : `short${i}` })),
    });
    const biasedQuestionRefs: {
      moduleName: "router" | "lowerModule" | "upperModule";
      shape: "dailyLife" | "academic";
      stimulusIndex: number;
      questionIndex: number;
    }[] = [];
    for (const moduleName of ["router", "lowerModule", "upperModule"] as const) {
      for (const shape of ["dailyLife", "academic"] as const) {
        candidate[moduleName][shape].forEach((t, si) =>
          t.questions.forEach((_, qi) => biasedQuestionRefs.push({ moduleName, shape, stimulusIndex: si, questionIndex: qi })));
      }
    }
    expect(biasedQuestionRefs.length).toBe(25); // every scoreable MCQ in the Set
    for (const ref of biasedQuestionRefs) {
      const stimulus = candidate[ref.moduleName][ref.shape][ref.stimulusIndex]!;
      stimulus.questions[ref.questionIndex] = bias(stimulus.questions[ref.questionIndex]!);
    }

    let verifyCalls = 0;
    const flaggedIdsByRound: string[][] = [];
    let currentRoundIds: string[] = [];
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") return skillSuccess(request.parse(plan));
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) return skillSuccess(request.parse(candidate));
        if (request.prompt.includes("```ctw-derived-gaps")) return skillSuccess(request.parse(okExplanationsResponse(request.prompt)));
        if (request.prompt.includes("```mcq-regeneration")) {
          const payload = extractFence(request.prompt, "mcq-regeneration") as {
            stimulusId: string;
            flaggedQuestions: { id: string; options: { id: string; text: string }[]; correctOptionId: string; skill: string; reason: string }[];
          };
          currentRoundIds.push(...payload.flaggedQuestions.map((q) => q.id));
          return skillSuccess(request.parse({
            questions: payload.flaggedQuestions.map((q) => ({
              id: q.id, stem: `FIXED stem for ${q.id}`,
              options: q.options.map((o) => ({ id: o.id, text: "same-length-ish" })),
              correctOptionId: q.correctOptionId, skill: q.skill, explanationZh: `解析 ${q.id}`,
            })),
          }));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      // A new verify call starts a new round — snapshot and reset the accumulator BEFORE this
      // round's own remediation (triggered by ITS OWN violations, computed just below in
      // readingGenerator.ts) appends into it.
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
      const result = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
      setId = result.setId;
      flaggedIdsByRound.push(currentRoundIds); // the last round's own remediation (before the clean re-verify)
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
      // The core "defer, not skip" property: round 2's ids are NOT the same set as round 1's — a
      // skip-shaped bug would either re-flag the exact same batch every round or flag nothing at all
      // once the cap was hit once.
      for (const id of round2) expect(round1.has(id)).toBe(false);
      fs.rmSync(publishedSetPath(setId));
    } catch (err) {
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// Pipeline-level proof that a position-referencing explanation is remediated (rewritten in place, via
// the mcq-position-reference-rewrite path) rather than blocking the run or silently publishing — so
// no position reference survives for the rebalance's shuffle to make false.
// ---------------------------------------------------------------------------

describe("generateSet (reading) rewrites an explanation that names an option by position", () => {
  it("rewrites ONLY the flagged explanation via mcq-position-reference-rewrite, leaving every other field byte-identical, then publishes", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const candidate = buildCandidate();
    // Flag exactly one question's explanationZh with a positional reference.
    const target = candidate.router.dailyLife[0]!.questions[0]!;
    target.explanationZh = "答案為選項二,因為文中明確提到相關內容。";
    const targetId = target.id;

    let rewriteCalls = 0;
    let derivedExplanation = "";
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") return skillSuccess(request.parse(plan));
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) return skillSuccess(request.parse(candidate));
        if (request.prompt.includes("```ctw-derived-gaps")) return skillSuccess(request.parse(okExplanationsResponse(request.prompt)));
        if (request.prompt.includes("```mcq-position-reference-rewrite")) {
          rewriteCalls += 1;
          const payload = extractFence(request.prompt, "mcq-position-reference-rewrite") as {
            stimulusText: string;
            flagged: { id: string; stem: string; correctOptionId: string; explanationZh: string; options: { id: string; text: string }[] }[];
          };
          expect(payload.flagged.map((q) => q.id)).toEqual([targetId]);
          // Asserting over ids alone would pass against a payload carrying nothing else. This asserts
          // the whole question and its Stimulus are present and DERIVES its reply from that content,
          // the same shape the listening test uses, so a prompt that dropped the question's content
          // fails here.
          const entry = payload.flagged[0]!;
          expect(entry.stem).toBe(target.stem);
          expect(entry.explanationZh).toBe("答案為選項二,因為文中明確提到相關內容。");
          expect(entry.options.map((o) => o.text)).toEqual(target.options.map((o) => o.text));
          expect(payload.stimulusText).toBe(candidate.router.dailyLife[0]!.text);
          expect(request.prompt).toContain("唯一允許的寫法");
          expect(request.prompt).toContain("最後一個選項");
          derivedExplanation = `正解對應題幹「${entry.stem}」所問的內容,其餘選項與原文不符。`;
          return skillSuccess(request.parse({ explanations: [{ id: entry.id, explanationZh: derivedExplanation }] }));
        }
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      expect(rewriteCalls).toBe(1);
      const parsed = readPublishedReadingSet(setId!);
      const publishedQuestion = parsed.router.dailyLife[0]!.questions.find((q) => q.id === targetId)!;
      expect(publishedQuestion.explanationZh).toBe(derivedExplanation);
      expect(publishedQuestion.explanationZh).toContain(target.stem); // only possible if the prompt carried it
      // Every other field of the SAME question survives untouched (stem, skill) — only the
      // explanation was rewritten, like the other explanation-only remediations.
      expect(publishedQuestion.stem).toBe(target.stem);
      expect(publishedQuestion.skill).toBe(target.skill);
      // Zero position-reference violations survive on the published Set, so the rebalance shuffled
      // nothing an explanation still pointed at (a question still flagged would keep its order).
      expect(readingContentViolations(parsed).filter((v) => v.kind === "explanation-position-reference")).toHaveLength(0);
      fs.rmSync(publishedSetPath(setId));
    } catch (err) {
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });
});

// The CtW gap-leak gate is remediable in practice, not just non-blocking on paper: a passage with
// three content-word leaks (two past the tolerance) gets ONE surgical repair call (not a
// from-scratch rewrite) and the run still PUBLISHES. The repair is per passage, never a reason to
// discard the run.
describe("generateSet (reading) repairs a CtW gap leak", () => {
  // The fake model EXTRACTS the paragraph from the real `current-paragraph` fence in the prompt and
  // derives the fix BY EDITING THAT EXTRACTED TEXT, never from a literal of its own. If the fence were
  // empty, missing, or stale, the extraction (or the derived-gap-count check a few lines down) would
  // fail, so the test passes only when the repair prompt carries the paragraph it asks the model to
  // edit.
  it("repairs a passage with excess content-word leaks via a surgical single-word-swap call, sending the model the paragraph it is asked to edit, then publishes", async () => {
    const dataDir = readingDataDir();
    const plan = buildPlan();
    const leakyParagraph =
      "Robotics teams build small delivery robots for crowded town paths. " +
      "Each robot carries a rechargeable battery pack that powers its sensors and wheels through a " +
      "long shift, and every robot reports its own battery level back to a central office every " +
      "few minutes so a technician can swap a battery before a robot ever stalls out on a path far " +
      "from the nearest charging station near the main building where people often gather.";
    const candidate = buildCandidate({ ctwParagraphs: { "ctw-r1": leakyParagraph } });
    let repairCalls = 0;
    let repairPrompt = "";
    let extractedCurrentParagraph = "";
    let verifyCalls = 0;

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      if (request.task.task === "plan") return skillSuccess(request.parse(plan));
      if (request.task.task === "generate") {
        if (request.prompt.includes("```accepted-plan-json")) return skillSuccess(request.parse(candidate));
        if (request.prompt.includes("```ctw-plan-entry")) {
          repairCalls += 1;
          repairPrompt = request.prompt;
          // Pull the paragraph to edit OUT OF THE PROMPT ITSELF — the same information a real model
          // would have, and nothing more. A test-author-privileged literal never appears here.
          const fenceMatch = /```current-paragraph\n([\s\S]*?)\n```/.exec(request.prompt);
          if (!fenceMatch) throw new Error("fixture error: repair prompt is missing its current-paragraph fence");
          extractedCurrentParagraph = fenceMatch[1]!;
          // The surgical fix: keep the FIRST occurrence of each repeated content word (the one that
          // will end up gapped is chosen by the deterministic deriver, not by this fixture), and vary
          // every LATER occurrence to a different synonym — applied to the EXTRACTED text, not a
          // hand-written literal, so this fix is genuinely derived from what the prompt contained.
          const varyRepeats = (text: string, word: string, synonyms: string[]): string => {
            let occurrence = 0;
            return text.replace(new RegExp(`\\b${word}\\b`, "g"), () => {
              const replacement = occurrence === 0 ? word : synonyms[(occurrence - 1) % synonyms.length]!;
              occurrence += 1;
              return replacement;
            });
          };
          let fixed = varyRepeats(extractedCurrentParagraph, "robot", ["unit", "machine", "device"]);
          fixed = varyRepeats(fixed, "battery", ["power source", "charge"]);
          return skillSuccess(request.parse({ sourceParagraph: fixed }));
        }
        if (request.prompt.includes("```ctw-derived-gaps")) return skillSuccess(request.parse(okExplanationsResponse(request.prompt)));
        throw new Error(`unexpected generate:reading call:\n${request.prompt.slice(0, 200)}`);
      }
      verifyCalls += 1;
      return skillSuccess(request.parse(allOkVerifyResponse(request.prompt)));
    });

    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("reading", { runSkillTask: runSkillTask as never, planner });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    try {
      // The run PUBLISHED — the whole point. It took a real repair round (this is remediable, not
      // an unconditional pass), and the repair prompt was SURGICAL (named the specific repeated
      // words, asked for a targeted swap) rather than an open-ended rewrite instruction.
      expect(repairCalls).toBe(1);
      // The prompt actually contains the paragraph being edited, byte for byte — not just an
      // instruction that presupposes it.
      expect(extractedCurrentParagraph).toBe(leakyParagraph);
      expect(repairPrompt).toContain("```current-paragraph");
      expect(repairPrompt).toContain("Starting from that EXACT text: for each named word, KEEP its first occurrence");
      // The instruction says WHICH occurrence to change (keep the first, vary every later one)
      // rather than leaving "the repeat is the problem" implicit.
      expect(repairPrompt).toContain("do not replace every occurrence of a named word");
      expect(repairPrompt).toMatch(/robot|battery/);
      expect(verifyCalls).toBeGreaterThanOrEqual(1);

      const parsed = readPublishedReadingSet(setId!);
      const ctwR1 = parsed.router.ctwPassages.find((p) => p.id === "ctw-r1")!;
      expect(contentWordLeakedGapIds(ctwR1).length).toBeLessThanOrEqual(1);
      fs.rmSync(publishedSetPath(setId!));
    } catch (err) {
      fs.rmSync(publishedSetPath(setId!), { force: true });
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// explanationZh must never name an option by POSITION: the answer-key rebalance runs AFTER the last
// verify round, and its shuffle would make such a reference false.
// ---------------------------------------------------------------------------

describe("explanation-position-reference `detail` carries no content", () => {
  it("names the defect and the fix, never the offending explanation — `detail` reaches job.error and the Dashboard", () => {
    const secret = "答案為選項二,因為公告寫明週六上午九點在中央公園集合。";
    const violations = readingContentViolations({
      router: {
        timeLimitSec: 540, ctwPassages: [], academic: [],
        dailyLife: [{
          id: "dl-1", taskType: "daily_life", genre: "notice", text: "text",
          questions: [{
            id: "dl-1-q1", stem: "Stem?", skill: "detail" as const,
            options: [
              { id: "a", text: "aaaa" }, { id: "b", text: "bbbb" },
              { id: "c", text: "cccc" }, { id: "d", text: "dddd" },
            ],
            correctOptionId: "a", explanationZh: secret,
          }],
        }],
      },
      lowerModule: { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] },
      upperModule: { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] },
    });
    const flagged = violations.filter((v) => v.kind === "explanation-position-reference");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.detail).not.toContain(secret);
    expect(flagged[0]!.detail).not.toContain("中央公園");
    expect(flagged[0]!.detail).toContain("POSITION");
  });
});

describe("verifyReadingSet's remediation routing is exhaustive", () => {
  it("every remediable violation kind resolves to a route, and every route is one the loop collects", () => {
    // Reading's remediations are per granularity (CtW passage, MCQ question, explanation only), so
    // there is no generic remedy: a kind added to REMEDIABLE_VIOLATION_KINDS without a route would
    // be collected nowhere and remediated never — the loop logs it, re-flags it every round, spends
    // all five verify attempts, and publishes it as a note. `readingRemediationRoute` is the single
    // source of the loop's own decision, so a kind with no case there has no branch in the loop.
    const unrouted = [...REMEDIABLE_VIOLATION_KINDS].filter((kind) => readingRemediationRoute(kind) === undefined);
    expect(unrouted).toEqual([]);
    // …and no kind the loop never remediates may claim a route it would never reach. `composition`
    // is fatal and fails the Set before verification; every other kind in this list is advisory,
    // recorded and published rather than repaired. Either way, no route.
    const unremediatedKinds = [
      "composition", "word-count", "ctw-word-count-over", "academic-coverage",
      "option-count", "module-difficulty-band", "passage-difficulty-band", "ctw-paragraph-difficulty-band",
    ] as const;
    expect(unremediatedKinds.filter((kind) => readingRemediationRoute(kind) !== undefined)).toEqual([]);
    // Every route the function can return is one of the collections the loop actually fills.
    const routes = new Set([...REMEDIABLE_VIOLATION_KINDS].map((kind) => readingRemediationRoute(kind)!));
    expect([...routes].sort()).toEqual([
      "ctw-explanation-length", "ctw-gap-leak", "explanation-language", "mcq-explanation-length",
      "mcq-position-reference", "mcq-wholesale",
    ]);
  });
});

describe("readingContentViolations: an explanation that names an option by position", () => {
  function mcqWithExplanation(id: string, explanationZh: string) {
    return {
      id, stem: `Stem ${id}`,
      options: [{ id: "a", text: "Option A" }, { id: "b", text: "Option B" }, { id: "c", text: "Option C" }, { id: "d", text: "Option D" }],
      correctOptionId: "b", skill: "detail" as const, explanationZh,
    };
  }
  function moduleWith(question: ReturnType<typeof mcqWithExplanation>): ReadingModule {
    return { timeLimitSec: 540, ctwPassages: [], academic: [], dailyLife: [{ id: "dl-1", taskType: "daily_life", genre: "notice", text: "text", questions: [question] }] };
  }
  function emptyModule(): ReadingModule {
    return { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] };
  }

  it("flags an explanation that names the key by Chinese ordinal (選項二)", () => {
    const violations = readingContentViolations({
      router: moduleWith(mcqWithExplanation("q1", "答案為選項二,因為文中明確提到相關內容。")),
      lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    const flagged = violations.filter((v) => v.kind === "explanation-position-reference");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.id).toBe("q1");
  });

  it("flags an explanation that names a WRONG option by ordinal, not just the key", () => {
    const violations = readingContentViolations({
      router: moduleWith(mcqWithExplanation("q1", "此為正確描述。選項三與文中所述矛盾,不成立。")),
      lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    expect(violations.filter((v) => v.kind === "explanation-position-reference")).toHaveLength(1);
  });

  it("does NOT flag content-relative phrasing (其餘選項/所有選項) that names no specific slot", () => {
    const violations = readingContentViolations({
      router: moduleWith(mcqWithExplanation("q1", "文中明確提到相關敘述,其餘選項均與原文不符,所有選項皆經過檢視。")),
      lowerModule: emptyModule(), upperModule: emptyModule(),
    });
    expect(violations.filter((v) => v.kind === "explanation-position-reference")).toHaveLength(0);
  });

  // "Is REMEDIABLE, not blocking" is proven end to end by the generateSet pipeline test above (the
  // run PUBLISHES rather than hard-failing) — the stronger, harder-to-fake claim than a direct check
  // against an unexported blocking-set helper.

  // Every real published passage and explanation on rd-6d02b750 avoids naming a position (they use
  // 「其餘選項」), so this gate adds no finding on data that already publishes, while still catching
  // the ordinal pattern a model reaches for unprompted.
  it("the real published rd-6d02b750.json has ZERO position-reference explanations (0 of 28)", () => {
    const parsed = bankedReadingSet();
    const violations = readingContentViolations(parsed);
    expect(violations.filter((v) => v.kind === "explanation-position-reference")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CtW gap leak (direct), including the REAL published Set's measured 12/40.
// ---------------------------------------------------------------------------

describe("readingContentViolations: CtW gap leak", () => {
  // The gate counts content words only: a closed-class function word like "the"/"and"/"that"
  // repeating is not a real cue — it is inferable from the prefix and basic grammar, and is
  // near-universal in ordinary English. CTW_CONTENT_LEAK_TOLERANCE_PER_PASSAGE is 1 (its own doc
  // comment says why), so a passage is flagged once it has MORE THAN 1 content-word leak.
  // SAMPLE_CTW_PARAGRAPH passes (its 2 leaks, "that" and "was", are both function words; pinned at
  // the end of this block). This paragraph deliberately leaks THREE gaps over two content words
  // ("robot" twice, "battery" once) — past the tolerance — to prove the gate catches a genuinely
  // excessive case.
  it("flags a synthetic passage with THREE content-word leaks — past the tolerance, not merely present", () => {
    const paragraph =
      "Robotics teams build small delivery robots for crowded campus paths. " +
      "Each robot carries a rechargeable battery pack that powers its sensors and wheels through a " +
      "long shift, and every robot reports its own battery level back to a central server every " +
      "few minutes so a technician can swap a battery before a robot ever stalls out on a path far " +
      "from the nearest charging station near the library entrance where students often gather.";
    const { segments, gaps } = deriveCtwGaps("ctw-leak", paragraph);
    const module: ReadingModule = {
      timeLimitSec: 540, dailyLife: [], academic: [],
      ctwPassages: [{
        id: "ctw-leak", taskType: "complete_words", topic: "delivery robots",
        sourceParagraph: paragraph, segments,
        gaps: gaps.map((g) => ({ ...g, explanationZh: "解析" })),
      }],
    };
    // Direct check of the underlying detector: 3 content-word leaks, none of them stopwords.
    expect(contentWordLeakedGapIds(module.ctwPassages[0]!)).toHaveLength(3);
    const violations = readingContentViolations({ router: module, lowerModule: emptyModuleFor(), upperModule: emptyModuleFor() });
    const leak = violations.find((v) => v.kind === "ctw-gap-leak");
    expect(leak).toBeDefined();
    expect(leak!.id).toBe("ctw-leak");
    expect(leak!.detail).toMatch(/gap\(s\).*visible in plain text elsewhere/);
    // `detail` reaches job.error, so it names the gaps by id and never their words, which are answer
    // keys. The repair prompt reads the words from the Set (readingDiagnostics.test.ts).
    expect(leak!.kind === "ctw-gap-leak" && leak!.leakedGapIds).toHaveLength(3);
    expect(leak!.detail).not.toContain("robot");
    expect(leak!.detail).not.toContain("battery");
  });

  it("does NOT flag a passage with exactly ONE content-word leak — AT the tolerance", () => {
    // Exactly one content word ("receiver") repeated once as plain text and once as a gap; every
    // other repeated token in the paragraph is a stopword or unique.
    const paragraph =
      "Engineers built a small radio receiver for a weekend campus workshop demonstration. " +
      "The receiver picked up a faint signal from a nearby transmitter tower during testing, and " +
      "the team recorded steady clear readings for almost an hour before the device finally lost " +
      "power completely, ending the demonstration earlier than planned but still producing useful notes.";
    const { segments, gaps } = deriveCtwGaps("ctw-one-leak", paragraph);
    const module: ReadingModule = {
      timeLimitSec: 540, dailyLife: [], academic: [],
      ctwPassages: [{
        id: "ctw-one-leak", taskType: "complete_words", topic: "radio receivers",
        sourceParagraph: paragraph, segments,
        gaps: gaps.map((g) => ({ ...g, explanationZh: "解析" })),
      }],
    };
    // Direct check of the underlying detector: exactly 1 content-word leak — AT the tolerance, not
    // under it, so this test actually exercises the boundary rather than a comfortably clean case.
    expect(contentWordLeakedGapIds(module.ctwPassages[0]!)).toHaveLength(1);
    const violations = readingContentViolations({ router: module, lowerModule: emptyModuleFor(), upperModule: emptyModuleFor() });
    expect(violations.filter((v) => v.kind === "ctw-gap-leak")).toHaveLength(0);
  });

  it("DOES flag a passage with exactly TWO content-word leaks — past the tolerance, not just present", () => {
    // Same paragraph as the ONE-leak case above, with a second content word ("signal") also
    // repeated once as plain text and once as a gap — nothing else changes.
    const paragraph =
      "Engineers built a small radio receiver for a weekend campus workshop demonstration. " +
      "The receiver picked up a faint signal from a nearby transmitter tower during testing, and " +
      "the team recorded steady signal readings for almost an hour before the device finally lost " +
      "power completely, ending the demonstration earlier than planned but still producing useful notes.";
    const { segments, gaps } = deriveCtwGaps("ctw-two-leak", paragraph);
    const module: ReadingModule = {
      timeLimitSec: 540, dailyLife: [], academic: [],
      ctwPassages: [{
        id: "ctw-two-leak", taskType: "complete_words", topic: "radio receivers",
        sourceParagraph: paragraph, segments,
        gaps: gaps.map((g) => ({ ...g, explanationZh: "解析" })),
      }],
    };
    expect(contentWordLeakedGapIds(module.ctwPassages[0]!)).toHaveLength(2);
    const violations = readingContentViolations({ router: module, lowerModule: emptyModuleFor(), upperModule: emptyModuleFor() });
    const leak = violations.find((v) => v.kind === "ctw-gap-leak");
    expect(leak).toBeDefined();
    expect(leak!.id).toBe("ctw-two-leak");
  });

  it("does not flag a passage whose gapped words never repeat elsewhere in the visible text", () => {
    const { segments, gaps } = deriveCtwGaps("ctw-clean", NINE_GAP_ONLY_UNIQUE_WORDS_PARAGRAPH);
    const module: ReadingModule = {
      timeLimitSec: 540, dailyLife: [], academic: [],
      ctwPassages: [{
        id: "ctw-clean", taskType: "complete_words", topic: "numbers",
        sourceParagraph: NINE_GAP_ONLY_UNIQUE_WORDS_PARAGRAPH, segments,
        gaps: gaps.map((g) => ({ ...g, explanationZh: "解析" })),
      }],
    };
    const violations = readingContentViolations({ router: module, lowerModule: emptyModuleFor(), upperModule: emptyModuleFor() });
    expect(violations.filter((v) => v.kind === "ctw-gap-leak")).toHaveLength(0);
  });

  it("reproduces the REAL leaked gaps measured in the published rd-6d02b750.json (12 of 40, function+content combined) AND flags exactly the 2-of-4 real passages that sit past its tolerance", () => {
    // Confirms the raw detector finds leaks by RECONSTRUCTING what the learner sees (segments + each
    // gap's own prefix) — not by re-scanning sourceParagraph, which would find every gap's own word
    // at its own location too and over-report. The published Set is immutable and never read for
    // anything but this measurement.
    const parsed = bankedReadingSet();

    const allCtwPassages = READING_MODULE_NAMES.flatMap((m) => parsed[m].ctwPassages);
    expect(allCtwPassages).toHaveLength(4);
    // The RAW measurement (function + content words combined) reproduces exactly 12 of 40 — the
    // ground truth the gate is calibrated AGAINST.
    const allLeakCounts = allCtwPassages.map((p) => leakedCtwGapIds(p).length);
    expect(allLeakCounts.reduce((a, b) => a + b, 0)).toBe(12);
    // The content-word-only measurement, per passage: 1, 2, 2, 1 (ctw-r1, ctw-r2, ctw-lo1, ctw-up1
    // respectively). A tolerance of 2 would clear all four by construction; the tolerance of 1
    // (CTW_CONTENT_LEAK_TOLERANCE_PER_PASSAGE) discriminates within these same 4 passages.
    const contentLeakCounts = allCtwPassages.map((p) => contentWordLeakedGapIds(p).length);
    expect(contentLeakCounts).toEqual([1, 2, 2, 1]);

    // The gate itself: at tolerance 1, the 2 passages with 2 content-word leaks (ctw-r2, ctw-lo1)
    // are flagged for repair, and the 2 passages with only 1 (ctw-r1, ctw-up1) still pass without
    // spending a call — the gate catches real leaks on real data without firing on a paragraph
    // whose only repeats are function words (next test).
    const violations = readingContentViolations(parsed);
    const leakViolations = violations.filter((v) => v.kind === "ctw-gap-leak");
    expect(leakViolations).toHaveLength(2);
    expect(leakViolations.map((v) => v.id).sort()).toEqual(["ctw-lo1", "ctw-r2"]);
  });

  it("does not flag a well-formed paragraph whose only repeated gap words are function words ('that', 'was')", () => {
    // A gate that rejected an ordinary, well-formed Complete the Words paragraph would be
    // mis-calibrated. SAMPLE_CTW_PARAGRAPH shows "that" (gap 2) again in its last sentence and "was"
    // (gap 7) as plain token 7; both are in CTW_LEAK_STOPWORDS, and no content word repeats.
    const { segments, gaps } = deriveCtwGaps("ctw-sample", SAMPLE_CTW_PARAGRAPH);
    const passage = {
      id: "ctw-sample", taskType: "complete_words" as const, topic: "medieval river tolls",
      sourceParagraph: SAMPLE_CTW_PARAGRAPH, segments,
      gaps: gaps.map((g) => ({ ...g, explanationZh: "解析" })),
    };
    expect(leakedCtwGapIds(passage)).toEqual(["ctw-sample-g2", "ctw-sample-g7"]);
    expect(gaps[1]!.prefix + gaps[1]!.completion).toBe("that");
    expect(gaps[6]!.prefix + gaps[6]!.completion).toBe("was");
    expect(contentWordLeakedGapIds(passage)).toHaveLength(0);
    const module: ReadingModule = { timeLimitSec: 540, dailyLife: [], academic: [], ctwPassages: [passage] };
    const violations = readingContentViolations({ router: module, lowerModule: emptyModuleFor(), upperModule: emptyModuleFor() });
    expect(violations.filter((v) => v.kind === "ctw-gap-leak")).toHaveLength(0);
  });
});

const NINE_GAP_ONLY_UNIQUE_WORDS_PARAGRAPH =
  "Start now with a brand new plan. Zebras quietly juggle mango puzzles beneath violet kites, " +
  "gravity hardly bothers curious walruses, and forgotten umbrellas dance across empty rooftops " +
  "whenever northern winds pass through sleepy coastal villages near ancient lighthouses.";

function emptyModuleFor(): ReadingModule {
  return { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] };
}

// ---------------------------------------------------------------------------
// word-count counts WORDS, not whitespace tokens (the same rule as Listening's).
// ---------------------------------------------------------------------------

describe("readingContentViolations: word count counts words, not whitespace tokens", () => {
  it("does not let two standalone em dashes inflate a short CtW paragraph over the 70-word floor", () => {
    // Sentence 1 (4 real words) + 64 filler words + "end" (1 real word) = 69 REAL words — one short
    // of the 70-word floor. Two standalone "—" tokens (spaced on both sides, a natural spoken-
    // register interruption marker) push a plain whitespace-split count to 71, which would clear the
    // >= 70 floor and hide the shortfall.
    const filler = Array.from({ length: 64 }, (_, i) => `alpha${i}`).join(" ");
    const paragraph = `First sentence here now. ${filler} — — end.`;
    const namingRealWordCount = paragraph.split(/\s+/u).filter((t) => /\p{L}|\p{N}/u.test(t)).length;
    const namingNaiveTokenCount = paragraph.trim().split(/\s+/u).filter(Boolean).length;
    expect(namingRealWordCount).toBe(69);
    expect(namingNaiveTokenCount).toBe(71); // what a plain whitespace split counts
    const module: ReadingModule = {
      timeLimitSec: 540, dailyLife: [], academic: [],
      ctwPassages: [{
        id: "ctw-dash", taskType: "complete_words", topic: "t",
        sourceParagraph: paragraph, segments: [], gaps: [],
      }],
    };
    const violations = readingContentViolations({ router: module, lowerModule: emptyModuleFor(), upperModule: emptyModuleFor() });
    const wordCountViolation = violations.find((v) => v.kind === "word-count" && v.id === "ctw-dash");
    expect(wordCountViolation).toBeDefined();
    expect(wordCountViolation!.detail).toContain("69 words");
  });
});

// ---------------------------------------------------------------------------
// The content gate's advisory tiers, end to end.
//
// A finding that leaves every Item answerable and correctly keyed never costs the run: a CtW
// Stimulus past its word ceiling, a 3-option MCQ, an out-of-band module or Stimulus, or a gap leak
// that survived every repair round is recorded as a note on a Set that publishes. Every CtW repair
// request also states the word budget and the no-repeat rule, so a repair that fixes one finding
// does not introduce another.
// ---------------------------------------------------------------------------

// 101 words: SAMPLE_CTW_PARAGRAPH's 75 plus one 26-word sentence that repeats none of its gap words,
// so the ONLY thing wrong with it is its length.
const OVER_LONG_CTW_PARAGRAPH = SAMPLE_CTW_PARAGRAPH
  + " Surviving account books from several Rhine ports record hundreds of separate payments, revealing"
  + " how quickly modest charges accumulated during a single voyage downstream toward coastal markets.";

// Every content word appears exactly twice, so whichever tokens deriveCtwGaps selects, each gapped
// word is also readable in plain text elsewhere — a leak far past the per-passage tolerance, and one
// no repair can fix because the fixture's repair hands the same paragraph straight back.
const LEAK_WORDS = [
  "harbor", "lantern", "meadow", "granite", "compass", "thicket", "cellar", "beacon", "furrow",
  "quarry", "trellis", "cavern", "pasture", "anvil", "bramble", "cistern", "dovecote", "estuary",
  "foundry", "gantry", "hedgerow", "inlet", "jetty", "kiln", "lagoon", "millpond", "netting",
  "orchard", "paddock", "quayside", "rookery", "sawmill", "tannery", "vineyard", "windmill",
];
const LEAKY_CTW_PARAGRAPH = `Start now. ${
  LEAK_WORDS.flatMap((word, i) => (i === 0 ? [word.replace(/^./, (c) => c.toUpperCase()), word] : [word, word])).join(" ")
}`;

describe("reading content gate — advisory tiers", () => {
  it("publishes a Set whose CtW Stimulus runs past the word ceiling, and records it", async () => {
    const plan = buildPlan();
    const candidate = buildCandidate({ ctwParagraphs: { "ctw-r1": OVER_LONG_CTW_PARAGRAPH } });
    const { runSkillTask } = contentGateRunner({ plan, candidate });

    // The whole point: the Set publishes instead of failing the content gate.
    const setId = await generateReadingSet(runSkillTask);
    try {
      const parsed = readPublishedReadingSet(setId);
      const notes = (parsed.advisoryNotes ?? []).filter((note) => note.check === "content-gate");
      expect(notes.map((note) => note.detail)).toContain("ctw-word-count-over");
      expect(notes.find((note) => note.detail === "ctw-word-count-over")?.taskType).toBe("complete_words");
    } finally {
      fs.rmSync(publishedSetPath(setId), { force: true });
    }
  });

  // Same shape as the test above — the Set publishes, the finding rides along as a note. A 3-option
  // question is usable practice, so it must never cost the run; the guide's "exactly 4 options per
  // question" is the mechanism and this gate is the backstop.
  it("publishes a Set carrying a 3-option MCQ, and records it", async () => {
    const plan = buildPlan();
    const candidate = buildCandidate();
    const question = candidate.router.dailyLife[0]!.questions[0]!;
    candidate.router.dailyLife[0]!.questions[0] = { ...question, options: question.options.slice(0, 3) };
    const { runSkillTask } = contentGateRunner({ plan, candidate });

    const setId = await generateReadingSet(runSkillTask);
    try {
      const parsed = readPublishedReadingSet(setId);
      const notes = (parsed.advisoryNotes ?? []).filter((note) => note.check === "content-gate");
      expect(notes.map((note) => note.detail)).toContain("option-count");
      expect(notes.find((note) => note.detail === "option-count")?.taskType).toBe("daily_life");
    } finally {
      fs.rmSync(publishedSetPath(setId), { force: true });
    }
  });

  // buildCandidate needs no doctoring here: its three modules share their prose, so the router and
  // lower module both read above the medium ceiling (see
  // buildCandidate's own comment). The Set publishes anyway, with one note per offending module and
  // no `taskType` on either — the band is a property of the whole module, not of a Task Type inside
  // it — which is the end-to-end proof that the tier is advisory and that the label shape reaches the
  // note correctly.
  it("publishes a Set whose modules read outside their absolute bands, and records it", async () => {
    const plan = buildPlan();
    const { runSkillTask } = contentGateRunner({ plan, candidate: buildCandidate() });

    const setId = await generateReadingSet(runSkillTask);
    try {
      const parsed = readPublishedReadingSet(setId);
      const notes = (parsed.advisoryNotes ?? []).filter((note) => note.check === "content-gate");
      const band = notes.filter((note) => note.detail === "module-difficulty-band");
      expect(band).toHaveLength(2);
      expect(band.every((note) => note.taskType === undefined)).toBe(true);
    } finally {
      fs.rmSync(publishedSetPath(setId), { force: true });
    }
  });

  // The same free end-to-end proof as the test above, per CtW paragraph: buildCandidate gives all four
  // CtW passages the same SAMPLE_CTW_PARAGRAPH (FK 11.50), which is above the router's medium
  // ceiling and above the lower module's, and inside the upper module's high band. So three of the
  // four report, the fourth does not, and the Set publishes anyway — the tier is advisory. Unlike
  // the module-level note, this one carries BOTH a `taskType` and an `itemPosition`: the paragraph is
  // addressable in the plan's own `complete_words` array, and that position is how a note names it
  // without carrying the model-authored passage id.
  it("publishes a Set whose CtW paragraphs read outside their modules' bands, and records which ones", async () => {
    const plan = buildPlan();
    const { runSkillTask } = contentGateRunner({ plan, candidate: buildCandidate() });

    const setId = await generateReadingSet(runSkillTask);
    try {
      const parsed = readPublishedReadingSet(setId);
      const notes = (parsed.advisoryNotes ?? []).filter((note) => note.check === "content-gate");
      const paragraphBand = notes.filter((note) => note.detail === "ctw-paragraph-difficulty-band");
      // Positions 0 and 1 are the router's two paragraphs, 2 the lower module's; position 3 — the
      // upper module's — is absent because 11.50 is inside the high band it is measured against.
      expect(paragraphBand.map((note) => note.itemPosition)).toEqual([0, 1, 2]);
      expect(paragraphBand.every((note) => note.taskType === "complete_words")).toBe(true);
    } finally {
      fs.rmSync(publishedSetPath(setId), { force: true });
    }
  });

  // The same end-to-end proof, per academic passage: buildCandidate gives all three modules the same
  // ACADEMIC_TEXT, so the router's and the lower module's passages read above their medium ceilings
  // while the upper module's sits inside its high band. The published notes carry `itemPosition`
  // exactly as the CtW ones do, so each note locates the passage it is about.
  it("publishes a Set whose academic passages read outside their modules' bands, and records which ones", async () => {
    const plan = buildPlan();
    const { runSkillTask } = contentGateRunner({ plan, candidate: buildCandidate() });

    const setId = await generateReadingSet(runSkillTask);
    try {
      const parsed = readPublishedReadingSet(setId);
      const notes = (parsed.advisoryNotes ?? []).filter((note) => note.check === "content-gate");
      const passageBand = notes.filter((note) => note.detail === "passage-difficulty-band");
      // Positions index the plan's own `academicPassages` array: 0 the router's passage, 1 the lower
      // module's, 2 the upper module's (absent — in band).
      expect(passageBand.map((note) => note.itemPosition)).toEqual([0, 1]);
      expect(passageBand.every((note) => note.taskType === "academic_passage")).toBe(true);
    } finally {
      fs.rmSync(publishedSetPath(setId), { force: true });
    }
  });

  it("publishes a Set whose gap leak survived every repair round, and records it", async () => {
    const plan = buildPlan();
    const candidate = buildCandidate({ ctwParagraphs: { "ctw-r1": LEAKY_CTW_PARAGRAPH } });
    // No `ctwRepair` override: the fixture hands the same leaky paragraph back every round, so the
    // repair budget is spent in full and never lands.
    const { runSkillTask, calls } = contentGateRunner({ plan, candidate });

    const setId = await generateReadingSet(runSkillTask);
    try {
      // The repair rounds still RAN — the advisory ending changes only how the run ends, not the
      // detection or the effort.
      expect(calls.ctwRepairPrompts.length).toBeGreaterThan(0);
      const parsed = readPublishedReadingSet(setId);
      const notes = (parsed.advisoryNotes ?? []).filter((note) => note.check === "content-gate");
      expect(notes.map((note) => note.detail)).toContain("ctw-gap-leak");
    } finally {
      fs.rmSync(publishedSetPath(setId), { force: true });
    }
  });

  it("states the word budget and the no-repeat rule in every CtW repair request", async () => {
    const plan = buildPlan();
    const candidate = buildCandidate({ ctwParagraphs: { "ctw-r1": LEAKY_CTW_PARAGRAPH } });
    const { runSkillTask, calls } = contentGateRunner({ plan, candidate });

    const setId = await generateReadingSet(runSkillTask);
    try {
      expect(calls.ctwRepairPrompts.length).toBeGreaterThan(0);
      for (const prompt of calls.ctwRepairPrompts) {
        // The budget, stated as the model-visible target the skill reference already publishes.
        expect(prompt).toContain("70-100 words");
        // The no-repeat rule, so a repair does not put a gapped word back into plain text.
        expect(prompt).toMatch(/do NOT repeat any distinctive content word/i);
      }
      // A gate-only tolerance must never ride along. The per-passage leak tolerance is the one this
      // prompt sits closest to; naming it would tell the model how many leaks it can get away with.
      for (const prompt of calls.ctwRepairPrompts) {
        expect(prompt).not.toContain("tolerance");
      }
    } finally {
      fs.rmSync(publishedSetPath(setId), { force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Where the batch's finalization gate sits.
//
// runGenerationBatch serializes one step of each child's tail, the publish, behind the previous
// child's; children plan, generate, verify and render in parallel. A gate around the whole of
// finalizeAndPublishGeneratedSet would also serialize the verify stage inside it, leaving a child
// idle while its siblings verify, render and publish — and nothing in the diagnostics would point at
// a queue, because its own scheduler queue time stays near zero.
//
// Reading has no renders, so what this file pins is the verify side: verify runs outside the gate.
// generator.test.ts pins the render and publish sides from Speaking, where there is audio to observe.
// ---------------------------------------------------------------------------
describe("the batch finalization gate", () => {
  it("admits only the publish, so verify runs outside it", async () => {
    const plan = buildPlan();
    const candidate = buildCandidate();
    const { runSkillTask } = contentGateRunner({ plan, candidate });
    const events: string[] = [];
    const recordingRunner = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "verify") events.push("verify");
      return runSkillTask(request);
    });
    const finalizationAdmission = async <T>(run: () => Promise<T>): Promise<T> => {
      events.push("gate:enter");
      try {
        return await run();
      } finally {
        events.push("gate:exit");
      }
    };

    const dataDir = readingDataDir();
    let setId: string;
    try {
      const planner = createGenerationPlanner({ dataDir });
      const result = await generateSet("reading", {
        runSkillTask: recordingRunner as never,
        planner,
        finalizationAdmission,
      });
      setId = result.setId;
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
    try {
      // The gate still runs — this is not "delete the serialization".
      expect(events).toContain("gate:enter");
      // …but every verify call comes before it, not inside it. A verify after "gate:enter" would
      // make a sibling wait out this child's whole verify loop.
      expect(events.indexOf("verify")).toBeGreaterThanOrEqual(0);
      expect(events.indexOf("verify")).toBeLessThan(events.indexOf("gate:enter"));
    } finally {
      fs.rmSync(publishedSetPath(setId!), { force: true });
    }
  });

  it("lets a second child verify while the first is still holding the gate", async () => {
    const events: string[] = [];
    // The EXACT admission chain runGenerationBatch builds for a batch's children.
    let finalizationTail = Promise.resolve();
    const finalizationAdmission = async <T>(run: () => Promise<T>): Promise<T> => {
      const admitted = finalizationTail.then(run, run);
      finalizationTail = admitted.then(() => undefined, () => undefined);
      return admitted;
    };

    let announceFirstInTail!: () => void;
    const firstInTail = new Promise<void>((resolve) => { announceFirstInTail = resolve; });
    let releaseFirst!: () => void;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });

    let announceBVerified!: () => void;
    const bVerified = new Promise<void>((resolve) => { announceBVerified = resolve; });

    function runnerFor(label: string) {
      const { runSkillTask } = contentGateRunner({ plan: buildPlan(), candidate: buildCandidate() });
      return vi.fn(async (request: SkillTaskRequest<unknown>) => {
        if (request.task.task === "verify") {
          events.push(`verify:${label}`);
          if (label === "B") announceBVerified();
        }
        return runSkillTask(request);
      });
    }

    // Separate planners: a batch's children share the finalization gate, not a reservation, and two
    // reservations for the same fixture plan would collide on novelty, which has nothing to do with
    // the gate.
    const dirA = readingDataDir();
    const dirB = readingDataDir();
    let idA: string | undefined;
    let idB: string | undefined;
    try {
      const first = generateSet("reading", {
        runSkillTask: runnerFor("A") as never,
        planner: createGenerationPlanner({ dataDir: dirA }),
        finalizationAdmission,
        commitPublication: async () => {
          events.push("A:gate-held");
          announceFirstInTail();
          await firstReleased;
          return true;
        },
      });

      // A is now inside the gate and will not leave until we say so.
      await firstInTail;

      const second = generateSet("reading", {
        runSkillTask: runnerFor("B") as never,
        planner: createGenerationPlanner({ dataDir: dirB }),
        finalizationAdmission,
      });

      // THE ASSERTION: B reaches and finishes verification while A still holds the gate. With verify
      // inside the gate, B could not verify until A had fully published.
      // Event-driven, not polled: B signals the moment it verifies. A wall-clock poll made this
      // sensitive to how loaded the machine is when both workspaces' suites run at once, and the
      // property under test has nothing to do with elapsed time.
      await Promise.race([
        bVerified,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("B never verified while A held the gate")), 30_000).unref?.();
        }),
      ]);
      expect(events.indexOf("A:gate-held")).toBeLessThan(events.indexOf("verify:B"));

      releaseFirst();
      idA = (await first).setId;
      idB = (await second).setId;
    } finally {
      fs.rmSync(dirA, { recursive: true, force: true });
      fs.rmSync(dirB, { recursive: true, force: true });
      if (idA) fs.rmSync(publishedSetPath(idA), { force: true });
      if (idB) fs.rmSync(publishedSetPath(idB), { force: true });
    }
  });
});
