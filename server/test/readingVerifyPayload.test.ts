import { describe, expect, it } from "vitest";
import { verifyReadingSet } from "../src/services/readingGenerator.js";
import type { SkillTaskRunner } from "../src/services/generationReasoning.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import {
  allOkReadingVerdict,
  assembledReadingSet,
  readingVerifyPayload,
  routed,
  type ReadingVerifyPayload,
} from "./helpers/readingVerifyFixture.js";

// What the Reading Verifier is shown. It is asked whether each MCQ's correctOptionId is right, and
// that question has no answer without the text the question is about.

async function firstVerifyPayload(): Promise<{ payload: ReadingVerifyPayload; set: Awaited<ReturnType<typeof assembledReadingSet>> }> {
  const set = await assembledReadingSet();
  const prompts: string[] = [];
  const run = (async (request: SkillTaskRequest<unknown>) => {
    if (request.task.task !== "verify") throw new Error("unexpected non-verify call");
    prompts.push(request.prompt);
    return routed(request, allOkReadingVerdict(request.prompt));
  }) as SkillTaskRunner;
  await verifyReadingSet(set, run, undefined, set.id);
  expect(prompts.length).toBeGreaterThan(0);
  return { payload: readingVerifyPayload(prompts[0]!), set };
}

describe("verify:reading payload", () => {
  it("ships each MCQ beside the Daily Life text or Academic passage it is about", async () => {
    const { payload, set } = await firstVerifyPayload();
    const stimuli = new Map((payload.stimuli ?? []).map((stimulus) => [stimulus.id, stimulus]));

    const expected = (["router", "lowerModule", "upperModule"] as const).flatMap((moduleName) => [
      ...set[moduleName].dailyLife.map((text) => ({ text, taskType: "daily_life" })),
      ...set[moduleName].academic.map((text) => ({ text, taskType: "academic_passage" })),
    ]);
    expect(expected.length).toBeGreaterThan(0);

    for (const { text: stimulus, taskType } of expected) {
      for (const question of stimulus.questions) {
        const item = payload.mcqItems.find((entry) => entry.id === question.id);
        expect(item, question.id).toBeDefined();
        const shipped = stimuli.get(item!.stimulusId ?? "");
        expect(shipped, `${question.id} names no shipped stimulus`).toBeDefined();
        expect(shipped!.text).toBe(stimulus.text);
        expect(shipped!.taskType).toBe(taskType);
      }
    }
  });

  it("ships each text once, however many questions it carries", async () => {
    const { payload } = await firstVerifyPayload();
    const ids = (payload.stimuli ?? []).map((stimulus) => stimulus.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
