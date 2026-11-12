import { ReadingSetSchema, readingPlanEntryCount, type ReadingSet } from "@toefl-prep/shared";
import { assembleReadingContent } from "../../src/services/readingGenerator.js";
import type { SkillTaskRunner } from "../../src/services/generationReasoning.js";
import type { SkillTaskRequest } from "../../src/services/reasoning/router.js";
import { skillSuccess } from "./skillResults.js";

export { routed, skillSuccess } from "./skillResults.js";

// A fully assembled, gate-clean Reading Set and the fake-runner plumbing the verify-stage suites
// need to drive `verifyReadingSet` directly, without a plan or generate call in front of it.
//
// The prose is the same three canned texts generator.reading.test.ts uses (its SAMPLE_CTW_PARAGRAPH,
// written for these tests, for every CtW paragraph), so a Set built here derives exactly the gaps
// that suite pins. Daily-life and academic texts are given distinct per-stimulus suffixes so a test
// can tell, from the verify payload alone, which text a question was shipped beside.

export const SAMPLE_CTW_PARAGRAPH =
  "Centuries before railways existed, merchants in medieval Europe moved most heavy goods on rivers " +
  "rather than over land. Historians long assumed that this trade was both cheap and simple. However, " +
  "it was controlled by many local authorities, and nearly every town along the banks collected tolls " +
  "from passing boats. Traders on longer journeys paid these charges repeatedly. Over time, the expense " +
  "encouraged them to form associations that bargained collectively with regional rulers for lower fees.";

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

const ACADEMIC_SKILLS = ["detail", "inference", "vocabulary", "purpose", "organization"] as const;

export function mcq(id: string, correctId: string, skill: string = "detail") {
  return {
    id,
    stem: `Stem for ${id}?`,
    options: [
      { id: "a", text: "Option A" },
      { id: "b", text: "Option B" },
      { id: "c", text: "Option C" },
      { id: "d", text: "Option D" },
    ],
    correctOptionId: correctId,
    skill,
    explanationZh: `題目 ${id}:正解說明文中明確提到的內容;其他選項與原文不符。`,
  };
}

function dailyLife(id: string) {
  return {
    id,
    taskType: "daily_life" as const,
    genre: "notice",
    text: `${DAILY_LIFE_TEXT} Reference ${id.replace(/-/g, "")}.`,
    questions: [mcq(`${id}-q1`, "a"), mcq(`${id}-q2`, "b")],
  };
}

function academic(id: string) {
  const keys = ["b", "a", "c", "a", "b"];
  return {
    id,
    taskType: "academic_passage" as const,
    title: "The Afternoon Alertness Dip",
    discipline: "human physiology",
    text: `${ACADEMIC_TEXT} Reference ${id.replace(/-/g, "")}.`,
    questions: keys.map((key, i) => mcq(`${id}-q${i + 1}`, key, ACADEMIC_SKILLS[i])),
  };
}

function ctw(id: string) {
  return { id, taskType: "complete_words" as const, topic: "medieval river tolls", sourceParagraph: SAMPLE_CTW_PARAGRAPH };
}

export function buildReadingCandidate() {
  return {
    id: "seed-candidate",
    kind: "reading" as const,
    source: "generated" as const,
    createdAt: "2026-08-09T00:00:00.000Z",
    router: {
      timeLimitSec: 1200,
      ctwPassages: [ctw("ctw-r1"), ctw("ctw-r2")],
      dailyLife: [dailyLife("dl-r1"), dailyLife("dl-r2"), dailyLife("dl-r3")],
      academic: [academic("ap-r1")],
    },
    lowerModule: {
      timeLimitSec: 540,
      ctwPassages: [ctw("ctw-lo1")],
      dailyLife: [dailyLife("dl-lo1"), dailyLife("dl-lo2")],
      academic: [academic("ap-lo1")],
    },
    upperModule: {
      timeLimitSec: 540,
      ctwPassages: [ctw("ctw-up1")],
      dailyLife: [],
      academic: [academic("ap-up1")],
    },
  };
}

function planBase(slug: string, concepts: [string, string]) {
  return { noveltyKey: `plan-${slug}`, requiredConcepts: concepts, distinguishesFrom: [] };
}

export function buildReadingPlan() {
  return {
    version: "cross-set-diversity-v1" as const,
    kind: "reading" as const,
    ctwPassages: Array.from({ length: readingPlanEntryCount("ctw") }, () => ({
      ...planBase("ctw", ["river tolls", "merchant associations"]),
      domain: "everyday-life" as const,
      topic: "medieval river tolls",
      angle: "why river trade in medieval Europe cost merchants more than it seemed",
    })),
    dailyLifeTexts: Array.from({ length: readingPlanEntryCount("dailyLife") }, () => ({
      ...planBase("dl", ["paperless billing", "housing office"]),
      domain: "workplace-business" as const,
      genre: "notice",
      scenario: "a paperless billing notice from the housing office",
    })),
    academicPassages: Array.from({ length: readingPlanEntryCount("academic") }, () => ({
      ...planBase("ap", ["afternoon dip", "brief nap"]),
      domain: "everyday-life" as const,
      title: "The Afternoon Alertness Dip",
      discipline: "human physiology",
      angle: "why alertness dips in the afternoon and what remedies work",
    })),
  };
}

/** The fenced block `marker` in `prompt`, parsed as JSON. */
export function fence(prompt: string, marker: string): unknown {
  const match = new RegExp("```" + marker + "\\n([\\s\\S]*?)\\n```").exec(prompt);
  if (!match) throw new Error(`fixture error: prompt is missing the \`\`\`${marker} fence`);
  return JSON.parse(match[1]!);
}

export function ctwExplanationsResponse(prompt: string) {
  const payload = fence(prompt, "ctw-derived-gaps") as { gaps: { id: string }[] };
  return {
    explanations: payload.gaps.map((gap) => ({
      gapId: gap.id,
      explanationZh: `語意上只有這個答案符合上下文 (${gap.id})。`,
    })),
  };
}

export type ReadingVerifyPayload = {
  ctwPassages: { id: string; gaps: { id: string; prefix: string; completion: string; blankLength?: number }[] }[];
  mcqItems: { id: string; stimulusId?: string }[];
  stimuli?: { id: string; taskType: string; text: string }[];
};

export function readingVerifyPayload(prompt: string): ReadingVerifyPayload {
  return fence(prompt, "json") as ReadingVerifyPayload;
}

export function allOkReadingVerdict(prompt: string) {
  const payload = readingVerifyPayload(prompt);
  return {
    ctwPassages: payload.ctwPassages.map((p) => ({ id: p.id, verdict: "ok" as const })),
    mcqItems: payload.mcqItems.map((m) => ({ id: m.id, verdict: "ok" as const })),
  };
}


/** A gate-clean, fully assembled ReadingSet with its plan attached — what verifyReadingSet receives. */
export async function assembledReadingSet(): Promise<ReadingSet> {
  const plan = buildReadingPlan();
  const run = (async (request: SkillTaskRequest<unknown>) => {
    if (request.prompt.includes("```ctw-derived-gaps")) {
      return skillSuccess(request.parse(ctwExplanationsResponse(request.prompt)));
    }
    throw new Error(`fixture error: unexpected call during assembly:\n${request.prompt.slice(0, 200)}`);
  }) as SkillTaskRunner;
  const assembled = await assembleReadingContent({ raw: buildReadingCandidate() as never, plan: plan as never, run });
  return ReadingSetSchema.parse({ ...assembled, id: "rd-fixture1", generationPlan: plan });
}
