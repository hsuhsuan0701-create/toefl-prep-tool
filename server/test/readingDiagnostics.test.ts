import { describe, expect, it, vi } from "vitest";
import { deriveCtwGaps } from "../src/services/ctest.js";
import { verifyReadingSet } from "../src/services/readingGenerator.js";
import type { SkillTaskRunner } from "../src/services/generationReasoning.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import { allOkReadingVerdict, assembledReadingSet, readingVerifyPayload, routed } from "./helpers/readingVerifyFixture.js";

// What Reading's verify stage throws reaches `job.error` and the Dashboard, so it carries ids, kinds
// and counts, never Set text or Verifier prose (generationVerifyLoop.ts's diagnostic contract).

// Three content words ("robot", "battery") repeated past sentence 1, so the gap-leak gate fires.
const LEAKY_PARAGRAPH =
  "Robotics teams build small delivery robots for crowded town paths. " +
  "Each robot carries a rechargeable battery pack that powers its sensors and wheels through a " +
  "long shift, and every robot reports its own battery level back to a central office every " +
  "few minutes so a technician can swap a battery before a robot ever stalls out on a path far " +
  "from the nearest charging station near the main building where people often gather.";

function runner(answer: (request: SkillTaskRequest<unknown>) => unknown): SkillTaskRunner {
  return (async (request: SkillTaskRequest<unknown>) => answer(request)) as SkillTaskRunner;
}

describe("Reading verify diagnostics carry no Set text", () => {
  it("names a failing gate's violations by id and kind, never by the stem, option, explanation or leaked word", async () => {
    const set = await assembledReadingSet();
    const stem = "這份通知的主要目的是什麼";
    const option = "以上皆非之選項";
    const explanation = "Only the housing office text supports this answer";
    const question = set.router.dailyLife[0]!.questions[0]!;
    question.stem = stem;
    question.options = question.options.map((o, i) => (i === 1 ? { ...o, text: option } : o));
    question.explanationZh = explanation;
    const { segments, gaps } = deriveCtwGaps("ctw-r1", LEAKY_PARAGRAPH);
    set.router.ctwPassages[0] = {
      ...set.router.ctwPassages[0]!,
      sourceParagraph: LEAKY_PARAGRAPH,
      segments,
      gaps: gaps.map((gap) => ({ ...gap, explanationZh: "只有這個字符合上下文。" })),
    };
    // A module one Daily Life text short is the fatal `composition` kind, so the gate throws with
    // every violation it found before any model call.
    set.router.dailyLife.pop();
    let calls = 0;
    const run = runner(() => {
      calls += 1;
      throw new Error("no model call is expected before the gate fails");
    });

    const error = await verifyReadingSet(set, run, undefined, set.id).then(
      () => undefined,
      (err: unknown) => err as Error,
    );

    expect(calls).toBe(0);
    expect(error?.message).toMatch(/composition/);
    expect(error?.message).toMatch(/item-language .*"dl-r1-q1"/);
    expect(error?.message).toMatch(/explanation-language .*"dl-r1-q1"/);
    expect(error?.message).toMatch(/ctw-gap-leak .*"ctw-r1": gap\(s\) ctw-r1-/);
    for (const content of [stem, option, explanation, "robot", "battery"]) {
      expect(error?.message).not.toContain(content);
    }
  });

  it("still names the leaked words to the model that repairs the paragraph", async () => {
    const set = await assembledReadingSet();
    const { segments, gaps } = deriveCtwGaps("ctw-r1", LEAKY_PARAGRAPH);
    set.router.ctwPassages[0] = {
      ...set.router.ctwPassages[0]!,
      sourceParagraph: LEAKY_PARAGRAPH,
      segments,
      gaps: gaps.map((gap) => ({ ...gap, explanationZh: "只有這個字符合上下文。" })),
    };
    const repairPrompts: string[] = [];
    const run = runner((request) => {
      if (request.task.task === "verify") return routed(request, allOkReadingVerdict(request.prompt));
      if (request.prompt.includes("```ctw-plan-entry")) {
        repairPrompts.push(request.prompt);
        // A failed repair keeps the paragraph, which is all this test needs.
        return { ok: false as const, error: "repair declined", attempts: [] };
      }
      throw new Error(`unexpected call:\n${request.prompt.slice(0, 200)}`);
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await verifyReadingSet(set, run, undefined, set.id);

    expect(repairPrompts.length).toBeGreaterThan(0);
    expect(repairPrompts[0]).toMatch(/word\(s\): [^)]*robot/);
    expect(repairPrompts[0]).toMatch(/word\(s\): [^)]*battery/);
    vi.restoreAllMocks();
  });

  it("names unresolved Verifier findings by id at exhaustion, never by the Verifier's reason", async () => {
    const set = await assembledReadingSet();
    const reason = "the distractor about the quarterly printed statement is implausible";
    const run = runner((request) => {
      if (request.task.task === "verify") {
        const payload = readingVerifyPayload(request.prompt);
        const verdict = allOkReadingVerdict(request.prompt);
        return routed(request, {
          ...verdict,
          mcqItems: payload.mcqItems.map((item) =>
            item.id === "dl-r1-q1" ? { id: item.id, verdict: "issue" as const, reason } : { id: item.id, verdict: "ok" as const }),
        });
      }
      // Every regeneration fails, so the same finding survives the whole budget.
      return { ok: false as const, error: "regeneration unavailable", attempts: [] };
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const error = await verifyReadingSet(set, run, undefined, set.id).then(
      () => undefined,
      (err: unknown) => err as Error,
    );

    expect(error?.message).toMatch(/1 MCQ item\(s\) with issues: dl-r1-q1/);
    expect(error?.message).not.toContain(reason);
    vi.restoreAllMocks();
  });
});
