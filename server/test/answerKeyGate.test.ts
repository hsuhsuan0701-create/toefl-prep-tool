import { describe, expect, it } from "vitest";
import { classifyGenerationCheck } from "../src/services/generationCheckPolicy.js";
import { GenerationVerifyExhaustedError } from "../src/services/generationVerifyLoop.js";
import { verifyReadingSet } from "../src/services/readingGenerator.js";
import { verifyListeningSet } from "../src/services/listeningGenerator.js";
import type { SkillTaskRunner } from "../src/services/generationReasoning.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import { allOkReadingVerdict, assembledReadingSet, fence, routed } from "./helpers/readingVerifyFixture.js";
import { allOkListeningVerdict, listeningSetForVerify } from "./helpers/listeningGenerationFixture.js";

// An MCQ whose key names none of its options cannot mark any Response right, and one with two
// options sharing an id cannot say which of them the key or a Response means. Either leaves the Set
// unusable, so the question is regenerated, and the job fails only if it is still wrong when the
// repairs run out (ADR 0006). This holds for a candidate fresh from the generate call, not only for a
// regeneration's reply.

type Option = { id: string; text: string };
type FlaggedQuestion = { id: string; reason: string; options: Option[]; correctOptionId: string };

const FIXED_OPTIONS: Option[] = [
  { id: "a", text: "Option A" }, { id: "b", text: "Option B" }, { id: "c", text: "Option C" }, { id: "d", text: "Option D" },
];

function runner(answer: (request: SkillTaskRequest<unknown>) => unknown): SkillTaskRunner {
  return (async (request: SkillTaskRequest<unknown>) => answer(request)) as SkillTaskRunner;
}

describe("the tier of an unusable answer key", () => {
  it.each(["reading", "listening"] as const)("is repair-then-accept ending in fatal in %s", (section) => {
    expect(classifyGenerationCheck({ family: "content-gate", section, kind: "invalid-answer-key" }))
      .toEqual({ tier: "repair-then-accept", unrepaired: "fatal" });
  });
});

describe("a Reading MCQ with an unusable key, fresh from the generate call", () => {
  it.each([
    ["names none of its options", (q: { correctOptionId: string }) => { q.correctOptionId = "z"; }],
    ["has two options sharing an id", (q: { options: Option[] }) => { q.options[1] = { ...q.options[1]!, id: "a" }; }],
  ] as const)("is regenerated when its key %s, and the Set publishes", async (_case, breakIt) => {
    const set = await assembledReadingSet();
    const question = set.router.dailyLife[0]!.questions[0]!;
    breakIt(question as never);
    const reasons: string[] = [];
    const run = runner((request) => {
      if (request.task.task === "verify") return routed(request, allOkReadingVerdict(request.prompt));
      const payload = fence(request.prompt, "mcq-regeneration") as { flaggedQuestions: FlaggedQuestion[] };
      reasons.push(...payload.flaggedQuestions.map((q) => `${q.id}: ${q.reason}`));
      return routed(request, {
        questions: payload.flaggedQuestions.map(({ reason: _reason, ...q }) => ({ ...q, options: FIXED_OPTIONS, correctOptionId: "b" })),
      });
    });

    const published = await verifyReadingSet(set, run, undefined, set.id);

    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(new RegExp(`^${question.id}: `));
    const repaired = published.router.dailyLife[0]!.questions[0]!;
    expect(new Set(repaired.options.map((option) => option.id)).size).toBe(repaired.options.length);
    expect(repaired.options.map((option) => option.id)).toContain(repaired.correctOptionId);
  });

  it("fails the job when the key is still unusable after every repair round", async () => {
    const set = await assembledReadingSet();
    set.router.dailyLife[0]!.questions[0]!.correctOptionId = "z";
    let regenerations = 0;
    const run = runner((request) => {
      if (request.task.task === "verify") return routed(request, allOkReadingVerdict(request.prompt));
      regenerations += 1;
      const payload = fence(request.prompt, "mcq-regeneration") as { flaggedQuestions: FlaggedQuestion[] };
      return routed(request, { questions: payload.flaggedQuestions.map(({ reason: _reason, ...q }) => q) });
    });

    const outcome = await verifyReadingSet(set, run, undefined, set.id).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(GenerationVerifyExhaustedError);
    expect((outcome as Error).message).toContain("invalid-answer-key");
    expect(regenerations).toBe(4);
  });
});

describe("a Listening item with two options sharing an id, fresh from the generate call", () => {
  it("regenerates the question and publishes", async () => {
    const set = listeningSetForVerify();
    const question = set.router.conversations[0]!.questions[0]!;
    question.options[1] = { ...question.options[1]!, id: "a" };
    const flagged: string[] = [];
    const run = runner((request) => {
      if (request.task.task === "verify") return routed(request, allOkListeningVerdict(request.prompt));
      const payload = fence(request.prompt, "question-regeneration") as { flaggedQuestions: FlaggedQuestion[] };
      flagged.push(...payload.flaggedQuestions.map((q) => q.id));
      return routed(request, {
        questions: payload.flaggedQuestions.map(({ reason: _reason, ...q }) => ({ ...q, options: FIXED_OPTIONS.slice(0, 3), correctOptionId: "c" })),
      });
    });

    const published = await verifyListeningSet(set, run, undefined, set.id);

    expect(flagged).toEqual([question.id]);
    const repaired = published.router.conversations[0]!.questions[0]!;
    expect(new Set(repaired.options.map((option) => option.id)).size).toBe(3);
  });

  it("regenerates a Listen and Choose a Response item the same way", async () => {
    const set = listeningSetForVerify();
    const item = set.router.listenChoose[0]!;
    item.options[2] = { ...item.options[2]!, id: "b" };
    const flagged: string[] = [];
    const run = runner((request) => {
      if (request.task.task === "verify") return routed(request, allOkListeningVerdict(request.prompt));
      const payload = fence(request.prompt, "lcr-regeneration") as { items: { id: string; reason: string }[] };
      flagged.push(...payload.items.map((entry) => entry.id));
      return routed(request, {
        items: payload.items.map(({ id }) => ({
          id, utterance: item.utterance, options: FIXED_OPTIONS, correctOptionId: "a", skill: item.skill, explanationZh: item.explanationZh,
        })),
      });
    });

    const published = await verifyListeningSet(set, run, undefined, set.id);

    expect(flagged).toEqual([item.id]);
    expect(new Set(published.router.listenChoose[0]!.options.map((option) => option.id)).size).toBe(4);
  });
});
