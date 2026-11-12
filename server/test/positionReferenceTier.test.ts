import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyGenerationCheck } from "../src/services/generationCheckPolicy.js";
import { verifyReadingSet } from "../src/services/readingGenerator.js";
import { verifyListeningSet } from "../src/services/listeningGenerator.js";
import type { SkillTaskRunner } from "../src/services/generationReasoning.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import { allOkReadingVerdict, assembledReadingSet, fence, routed } from "./helpers/readingVerifyFixture.js";
import { allOkListeningVerdict, listeningSetForVerify } from "./helpers/listeningGenerationFixture.js";

// An explanation that names an option by its slot ("選項A正確") is wrong as soon as the options are
// shuffled, and the shuffle is the last thing that happens to a Set. The rewrite gets every repair
// round the loop has. If it never lands, the Set still publishes: the Item is answerable and keyed
// correctly. Its options are left in the order the explanation describes, so the explanation stays
// true, and the Set carries a note saying so.

const POSITIONAL = "選項A正確，其他選項與原文不符。";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("explanation-position-reference tier", () => {
  it.each(["reading", "listening"] as const)("is repair-then-accept with an advisory ending in %s", (section) => {
    expect(classifyGenerationCheck({ family: "content-gate", section, kind: "explanation-position-reference" }))
      .toEqual({ tier: "repair-then-accept", unrepaired: "advisory" });
  });
});

describe("an explanation whose position reference never gets repaired", () => {
  it("publishes a Reading Set with the Item's options in the order its explanation names, and a note", async () => {
    // Every shuffle draws j = 0, which moves every option: an unexempted Item cannot keep its order.
    vi.spyOn(Math, "random").mockReturnValue(0);
    const set = await assembledReadingSet();
    const question = set.router.dailyLife[0]!.questions[0]!;
    question.explanationZh = POSITIONAL;
    const run = (async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "verify") return routed(request, allOkReadingVerdict(request.prompt));
      const payload = fence(request.prompt, "mcq-position-reference-rewrite") as { flagged: { id: string }[] };
      return routed(request, { explanations: payload.flagged.map(({ id }) => ({ id, explanationZh: POSITIONAL })) });
    }) as SkillTaskRunner;

    const published = await verifyReadingSet(set, run, undefined, set.id);
    const kept = published.router.dailyLife[0]!.questions[0]!;
    expect(kept.explanationZh).toBe(POSITIONAL);
    expect(kept.options).toEqual(question.options);
    expect(kept.correctOptionId).toBe(question.correctOptionId);
    const sibling = published.router.dailyLife[0]!.questions[1]!;
    expect(sibling.options).not.toEqual(set.router.dailyLife[0]!.questions[1]!.options);
    expect(published.advisoryNotes).toContainEqual(
      expect.objectContaining({ check: "content-gate", detail: "explanation-position-reference", taskType: "daily_life" }),
    );
  });

  it("publishes a Listening Set the same way", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const set = listeningSetForVerify();
    const item = set.router.listenChoose[0]!;
    item.explanationZh = POSITIONAL;
    const run = (async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "verify") return routed(request, allOkListeningVerdict(request.prompt));
      const payload = fence(request.prompt, "explanation-rewrite") as { flagged: { id: string }[] };
      return routed(request, { explanations: payload.flagged.map(({ id }) => ({ id, explanationZh: POSITIONAL })) });
    }) as SkillTaskRunner;

    const published = await verifyListeningSet(set, run, undefined, set.id);
    const kept = published.router.listenChoose[0]!;
    expect(kept.options).toEqual(item.options);
    expect(kept.correctOptionId).toBe(item.correctOptionId);
    expect(published.router.listenChoose[1]!.options).not.toEqual(set.router.listenChoose[1]!.options);
    expect(published.advisoryNotes).toContainEqual(
      expect.objectContaining({ check: "content-gate", detail: "explanation-position-reference" }),
    );
  });
});
