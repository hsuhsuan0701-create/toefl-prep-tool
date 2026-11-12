import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validWritingSet } from "./helpers/setFixtures.js";
import { config } from "../src/lib/config.js";
import { generateSet } from "../src/services/generator.js";
import { verifyReadingSet } from "../src/services/readingGenerator.js";
import type { SkillTaskRunner } from "../src/services/generationReasoning.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import { allOkReadingVerdict, assembledReadingSet, routed } from "./helpers/readingVerifyFixture.js";
import { writingPlanFixture } from "./helpers/generationDiversityFixtures.js";

// A verify call that fails on the provider side (both CLIs timed out, say) comes after the whole
// candidate has been generated and assembled, so failing the job there discards everything already
// paid for. One failed call gets one more try. The retry is bounded: a second failure ends the job,
// and a cancelled call is never retried.

const PROVIDER_FAILURE = {
  ok: false as const,
  error: "Structured reasoning unavailable: Claude (timeout) → Codex (timeout).",
  attempts: [
    { provider: "claude" as const, kind: "timeout" as const },
    { provider: "codex" as const, kind: "timeout" as const },
  ],
};

function readingVerifyRun(outcomes: readonly ("fail" | "cancel" | "ok")[], calls: { verify: number }): SkillTaskRunner {
  return (async (request: SkillTaskRequest<unknown>) => {
    if (request.task.task !== "verify") throw new Error(`unexpected ${request.task.task} call`);
    const outcome = outcomes[Math.min(calls.verify, outcomes.length - 1)];
    calls.verify += 1;
    if (outcome === "fail") return PROVIDER_FAILURE;
    if (outcome === "cancel") {
      return { ok: false as const, cancelled: true as const, reason: "user" as const, error: "cancelled", attempts: [] };
    }
    return routed(request, allOkReadingVerdict(request.prompt));
  }) as SkillTaskRunner;
}

describe("a failed verify call", () => {
  it("is retried once, and the Set publishes when the retry succeeds", async () => {
    const set = await assembledReadingSet();
    const calls = { verify: 0 };
    await expect(verifyReadingSet(set, readingVerifyRun(["fail", "ok"], calls), undefined, set.id)).resolves.toBeDefined();
    expect(calls.verify).toBe(2);
  });

  it("fails the job when the retry fails too, after exactly two calls", async () => {
    const set = await assembledReadingSet();
    const calls = { verify: 0 };
    await expect(verifyReadingSet(set, readingVerifyRun(["fail", "fail", "ok"], calls), undefined, set.id))
      .rejects.toThrow(/Structured reasoning unavailable/);
    expect(calls.verify).toBe(2);
  });

  it("is not retried when it was cancelled", async () => {
    const set = await assembledReadingSet();
    const calls = { verify: 0 };
    await expect(verifyReadingSet(set, readingVerifyRun(["cancel", "ok"], calls), undefined, set.id)).rejects.toThrow();
    expect(calls.verify).toBe(1);
  });

  it("is retried once for Build a Sentence too", async () => {
    let verifyCalls = 0;
    const run = (async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "generate") return routed(request, validWritingSet("ignored"));
      verifyCalls += 1;
      if (verifyCalls === 1) return PROVIDER_FAILURE;
      return routed(request, {
        items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok", answers: null })),
      });
    }) as SkillTaskRunner;
    const planner = {
      reserve: vi.fn().mockResolvedValue({ reservationId: "r-1", ownerId: "o-1", plan: writingPlanFixture() }),
      validateCandidate: vi.fn().mockReturnValue([]),
      release: vi.fn(),
    };
    const result = await generateSet("writing", { runSkillTask: run, planner: planner as never })
      .catch((error: unknown) => error as Error);
    if (!(result instanceof Error)) {
      fs.rmSync(path.join(config.dataDir, "question-sets/writing", `${result.setId}.json`), { force: true });
    }
    expect(result).not.toBeInstanceOf(Error);
    expect(verifyCalls).toBe(2);
  });
});

