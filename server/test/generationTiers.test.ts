import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { blocksGeneration, classifyGenerationCheck } from "../src/services/generationCheckPolicy.js";
import { createGenerationPlanner } from "../src/services/generationPlanner.js";
import { verifyReadingSet } from "../src/services/readingGenerator.js";
import { verifyListeningSet } from "../src/services/listeningGenerator.js";
import { positionReferenceInstruction } from "../src/services/optionQuality.js";
import type { SkillTaskRunner } from "../src/services/generationReasoning.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import { allOkReadingVerdict, assembledReadingSet, fence, routed } from "./helpers/readingVerifyFixture.js";
import { allOkListeningVerdict, listeningSetForVerify } from "./helpers/listeningGenerationFixture.js";
import { writingPlanFixture } from "./helpers/generationDiversityFixtures.js";

// ADR-0006's rule: a check may stop a Set only when the Set would be unusable or would teach a wrong
// answer. These checks fail that test — each leaves every Item answerable and correctly keyed — so
// each is repaired where a repair path exists and otherwise recorded on the Set and published.

const advisoryEnding = { tier: "repair-then-accept", unrepaired: "advisory" } as const;

describe("tiers", () => {
  it.each(["academic-coverage", "word-count"] as const)("records Reading %s rather than repairing or failing", (kind) => {
    expect(classifyGenerationCheck({ family: "content-gate", section: "reading", kind })).toEqual({ tier: "advisory" });
  });

  it.each([
    "item-language", "explanation-language", "explanation-length-ctw", "explanation-length-mcq", "option-length-bias",
  ] as const)("repairs Reading %s, then publishes with a note", (kind) => {
    expect(classifyGenerationCheck({ family: "content-gate", section: "reading", kind })).toEqual(advisoryEnding);
  });

  it.each([
    "word-count", "syllable-estimate", "item-language", "explanation-language", "explanation-length", "option-length-bias",
  ] as const)("repairs Listening %s, then publishes with a note", (kind) => {
    expect(classifyGenerationCheck({ family: "content-gate", section: "listening", kind })).toEqual(advisoryEnding);
  });

  // Still blocking, because the Set would be unusable: a key naming no option, a transcript the
  // English voice cannot read, a module that does not have the exam's shape.
  it("keeps a missing answer key, a non-English transcript and a wrong module shape blocking", () => {
    for (const kind of ["invalid-answer-key", "transcript-language"] as const) {
      expect(blocksGeneration({ family: "content-gate", section: "listening", kind }), kind).toBe(true);
    }
    expect(blocksGeneration({ family: "content-gate", section: "listening", kind: "composition" })).toBe(true);
    expect(blocksGeneration({ family: "content-gate", section: "reading", kind: "composition" })).toBe(true);
  });

  it("replans an unbalanced Build a Sentence plan, then accepts the least unbalanced one", () => {
    expect(classifyGenerationCheck({ family: "plan-diversity", kind: "domain-balance", taskType: "build_sentence" }))
      .toEqual(advisoryEnding);
  });
});

function verifyOnly(answer: (request: SkillTaskRequest<unknown>) => unknown): SkillTaskRunner {
  return (async (request: SkillTaskRequest<unknown>) => answer(request)) as SkillTaskRunner;
}

describe("Reading checks that never fail the job", () => {
  it("publishes an Academic Passage that leaves a skill slot uncovered, with a note", async () => {
    const set = await assembledReadingSet();
    const passage = set.router.academic[0]!;
    passage.questions = passage.questions.map((q) => (q.skill === "purpose" ? { ...q, skill: "detail" } : q));
    const published = await verifyReadingSet(set, verifyOnly((request) => routed(request, allOkReadingVerdict(request.prompt))), undefined, set.id);
    expect(published.advisoryNotes).toContainEqual(
      expect.objectContaining({ check: "content-gate", detail: "academic-coverage", taskType: "academic_passage" }),
    );
  });

  it("publishes a Daily Life text outside its word range, with a note", async () => {
    const set = await assembledReadingSet();
    set.router.dailyLife[0]!.text = "The housing office closes early on Friday for staff training only.";
    const published = await verifyReadingSet(set, verifyOnly((request) => routed(request, allOkReadingVerdict(request.prompt))), undefined, set.id);
    expect(published.advisoryNotes).toContainEqual(
      expect.objectContaining({ check: "content-gate", detail: "word-count", taskType: "daily_life" }),
    );
  });

  it("regenerates an MCQ whose stem is not in English, and publishes the English one", async () => {
    const set = await assembledReadingSet();
    set.router.dailyLife[0]!.questions[0]!.stem = "這份通知的主要目的是什麼？";
    const regenerated: string[] = [];
    const run = verifyOnly((request) => {
      if (request.task.task === "verify") return routed(request, allOkReadingVerdict(request.prompt));
      const payload = fence(request.prompt, "mcq-regeneration") as { flaggedQuestions: { id: string; reason: string }[] };
      regenerated.push(...payload.flaggedQuestions.map((q) => q.id));
      return routed(request, {
        questions: payload.flaggedQuestions.map(({ reason: _reason, ...q }) => ({ ...q, stem: "What is the notice mainly about?" })),
      });
    });
    const published = await verifyReadingSet(set, run, undefined, set.id);
    expect(regenerated).toEqual(["dl-r1-q1"]);
    expect(published.router.dailyLife[0]!.questions[0]!.stem).toBe("What is the notice mainly about?");
    expect(published.advisoryNotes ?? []).not.toContainEqual(expect.objectContaining({ detail: "item-language" }));
  });

  it("hands every gate reason for one question to its single regeneration", async () => {
    const set = await assembledReadingSet();
    const question = set.router.dailyLife[0]!.questions[0]!;
    question.stem = "這份通知的主要目的是什麼？";
    question.options = question.options.map((option, i) => (i === 2 ? { ...option, text: "以上皆非" } : option));
    const reasons: string[] = [];
    const run = verifyOnly((request) => {
      if (request.task.task === "verify") return routed(request, allOkReadingVerdict(request.prompt));
      const payload = fence(request.prompt, "mcq-regeneration") as {
        flaggedQuestions: { id: string; reason: string; options: { id: string; text: string }[] }[];
      };
      reasons.push(...payload.flaggedQuestions.map((q) => q.reason));
      return routed(request, {
        questions: payload.flaggedQuestions.map(({ reason: _reason, ...q }) => ({
          ...q, stem: "What is the notice mainly about?",
          options: q.options.map((option, i) => (i === 2 ? { ...option, text: "Option C" } : option)),
        })),
      });
    });
    await verifyReadingSet(set, run, undefined, set.id);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("stem is not English");
    expect(reasons[0]).toContain(`option "${question.options[2]!.id}" is not English`);
  });

  it("rewrites a CtW gap explanation written without 繁體中文", async () => {
    const set = await assembledReadingSet();
    set.router.ctwPassages[0]!.gaps[0]!.explanationZh = "Only this word fits the sentence.";
    const feedback: string[] = [];
    const run = verifyOnly((request) => {
      if (request.task.task === "verify") return routed(request, allOkReadingVerdict(request.prompt));
      const payload = fence(request.prompt, "ctw-derived-gaps") as { gaps: { id: string }[] };
      feedback.push(/```explanation-feedback\n([\s\S]*?)\n```/.exec(request.prompt)?.[1] ?? "");
      return routed(request, {
        explanations: payload.gaps.map((gap) => ({ gapId: gap.id, explanationZh: `只有這個字符合上下文 (${gap.id})。` })),
      });
    });
    const published = await verifyReadingSet(set, run, undefined, set.id);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toContain(set.router.ctwPassages[0]!.gaps[0]!.id);
    expect(published.router.ctwPassages[0]!.gaps[0]!.explanationZh).toMatch(/[一-鿿]/u);
  });

  it("publishes, with a note, an MCQ explanation that is still too long after every rewrite", async () => {
    const set = await assembledReadingSet();
    const overlong = "解析".repeat(110);
    set.router.dailyLife[0]!.questions[0]!.explanationZh = overlong;
    const rewritePrompts: string[] = [];
    const run = verifyOnly((request) => {
      if (request.task.task === "verify") return routed(request, allOkReadingVerdict(request.prompt));
      rewritePrompts.push(request.prompt);
      const payload = fence(request.prompt, "mcq-explanation-rewrite") as { overlongExplanations: { id: string }[] };
      return routed(request, { explanations: payload.overlongExplanations.map(({ id }) => ({ id, explanationZh: overlong })) });
    });
    const published = await verifyReadingSet(set, run, undefined, set.id);
    // A rewrite writes an explanation, so it carries the position rule whatever it was asked for.
    expect(rewritePrompts.length).toBeGreaterThan(0);
    for (const prompt of rewritePrompts) expect(prompt).toContain(positionReferenceInstruction());
    expect(published.advisoryNotes).toContainEqual(
      expect.objectContaining({ check: "content-gate", detail: "explanation-length-mcq", taskType: "daily_life" }),
    );
  });
});

describe("Listening checks that never fail the job", () => {
  it("publishes, with a note, an explanation that is still too long after every rewrite", async () => {
    const set = listeningSetForVerify();
    const overlong = "解析".repeat(110);
    set.router.listenChoose[0]!.explanationZh = overlong;
    const rewritePrompts: string[] = [];
    const run = verifyOnly((request) => {
      if (request.task.task === "verify") return routed(request, allOkListeningVerdict(request.prompt));
      rewritePrompts.push(request.prompt);
      const payload = fence(request.prompt, "explanation-rewrite") as { flagged: { id: string }[] };
      return routed(request, { explanations: payload.flagged.map(({ id }) => ({ id, explanationZh: overlong })) });
    });
    const published = await verifyListeningSet(set, run, undefined, set.id);
    expect(rewritePrompts.length).toBeGreaterThan(0);
    for (const prompt of rewritePrompts) {
      expect(prompt).toContain(`In every explanationZh you write: ${positionReferenceInstruction()}`);
    }
    expect(published.advisoryNotes).toContainEqual(
      expect.objectContaining({ check: "content-gate", detail: "explanation-length", taskType: "listen_choose" }),
    );
  });
});

describe("Build a Sentence plan domain balance", () => {
  it("admits an unbalanced plan once every planning attempt is spent", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "generation-tiers-"));
    fs.mkdirSync(path.join(dataDir, "question-sets/writing"), { recursive: true });
    const plan = writingPlanFixture();
    const first = plan.buildASentence.situations[0]!;
    // Six situations in one domain: past the per-domain cap and short of five distinct domains.
    plan.buildASentence.situations = plan.buildASentence.situations.map((situation, i) =>
      i < 6 ? { ...situation, domain: first.domain, situation: `${first.situation} (${i})` } : situation
    ) as typeof plan.buildASentence.situations;
    let planCalls = 0;
    const run = verifyOnly((request) => {
      planCalls += 1;
      return routed(request, plan);
    });
    try {
      const planner = createGenerationPlanner({ dataDir });
      const reservation = await planner.reserve({ kind: "writing", ownerId: "owner-1", runSkillTask: run });
      expect(planCalls).toBe(3);
      expect(reservation.advisoryNotes).toContainEqual(
        expect.objectContaining({ taskType: "build_sentence", detail: "domain-balance" }),
      );
      planner.release(reservation.reservationId);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
