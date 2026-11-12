import { describe, expect, it } from "vitest";
import { isTypeableCtwAlternate, verifyReadingSet } from "../src/services/readingGenerator.js";
import type { SkillTaskRunner } from "../src/services/generationReasoning.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import {
  allOkReadingVerdict,
  assembledReadingSet,
  readingVerifyPayload,
  routed,
} from "./helpers/readingVerifyFixture.js";

// A Complete-the-Words blank shows its prefix followed by one box per missing letter, and the input
// accepts no more letters than that. A word of any other length cannot be typed into it, so it is
// not an alternate answer the exact-match scorer could wrongly reject, and a Verifier that calls a
// gap ambiguous over one would send a sound paragraph into a rewrite it does not need.

describe("isTypeableCtwAlternate", () => {
  // Alternates a Verifier has claimed in real generation jobs; none fits its blank.
  it.each([
    [{ prefix: "ne", completion: "xt" }, "new"],
    [{ prefix: "i", completion: "n" }, "into"],
    [{ prefix: "t", completion: "he" }, "their"],
  ])("rejects %o vs %s: a different number of letters than the blank", (gap, alternate) => {
    expect(isTypeableCtwAlternate({ ...gap, blankLength: gap.completion.length }, alternate)).toBe(false);
  });

  it("accepts a different word with the same prefix and exactly the blank's letter count", () => {
    expect(isTypeableCtwAlternate({ prefix: "ne", completion: "xt", blankLength: 2 }, "news")).toBe(true);
    expect(isTypeableCtwAlternate({ prefix: "Th", completion: "ey", blankLength: 2 }, "then")).toBe(true);
  });

  it("rejects the key itself and a word that does not start with the visible prefix", () => {
    expect(isTypeableCtwAlternate({ prefix: "ne", completion: "xt", blankLength: 2 }, "Next")).toBe(false);
    expect(isTypeableCtwAlternate({ prefix: "ne", completion: "xt", blankLength: 2 }, "text")).toBe(false);
  });
});

function ambiguityRun(
  alternateFor: (gap: { prefix: string; completion: string }) => string,
  calls: { generate: string[]; verify: number },
): SkillTaskRunner {
  return (async (request: SkillTaskRequest<unknown>) => {
    if (request.task.task === "generate") {
      calls.generate.push(request.prompt);
      throw new Error("no regeneration is expected in this test");
    }
    calls.verify += 1;
    const verdict = allOkReadingVerdict(request.prompt);
    if (calls.verify > 1) return routed(request, verdict);
    const passage = readingVerifyPayload(request.prompt).ctwPassages.find((p) => p.id === "ctw-r1")!;
    const gap = passage.gaps[2]!;
    return routed(request, {
      ...verdict,
      ctwPassages: verdict.ctwPassages.map((entry) =>
        entry.id === "ctw-r1"
          ? {
            id: entry.id,
            verdict: "ambiguous",
            ambiguousGaps: [{ gapId: gap.id, alternate: alternateFor(gap) }],
            reason: "another word fits",
          }
          : entry
      ),
    });
  }) as SkillTaskRunner;
}

describe("verify:reading — CtW ambiguity", () => {
  it("sends each gap's number of missing letters to the verifier", async () => {
    const set = await assembledReadingSet();
    const prompts: string[] = [];
    const run = (async (request: SkillTaskRequest<unknown>) => {
      prompts.push(request.prompt);
      return routed(request, allOkReadingVerdict(request.prompt));
    }) as SkillTaskRunner;
    await verifyReadingSet(set, run, undefined, set.id);
    const gaps = readingVerifyPayload(prompts[0]!).ctwPassages.flatMap((passage) => passage.gaps);
    expect(gaps.length).toBeGreaterThan(0);
    for (const gap of gaps) expect(gap.blankLength).toBe(gap.completion.length);
  });

  it("drops an ambiguity claim whose alternate cannot be typed into the blank, and publishes", async () => {
    const set = await assembledReadingSet();
    const calls = { generate: [] as string[], verify: 0 };
    // The key plus one more letter: the blank has no room for it.
    const run = ambiguityRun((gap) => `${gap.prefix}${gap.completion}s`, calls);
    const published = await verifyReadingSet(set, run, undefined, set.id);
    expect(calls.generate).toEqual([]);
    expect(published.router.ctwPassages[0]!.sourceParagraph).toBe(set.router.ctwPassages[0]!.sourceParagraph);
  });

  it("still rewrites a passage whose alternate fits the blank exactly", async () => {
    const set = await assembledReadingSet();
    const calls = { generate: [] as string[], verify: 0 };
    const run = ambiguityRun((gap) => `${gap.prefix}${"z".repeat(gap.completion.length)}`, calls);
    await verifyReadingSet(set, run, undefined, set.id).catch(() => undefined);
    expect(calls.generate.length).toBeGreaterThan(0);
    expect(calls.generate[0]).toContain("```repair-feedback");
  });
});
