import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createGenerationPlanner, type ReservedGenerationPlan } from "../src/services/generationPlanner.js";
import type { SkillTaskRunner } from "../src/services/generationReasoning.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import { buildListeningPlan, routed } from "./helpers/listeningGenerationFixture.js";

// The planner's admission lock exists so two concurrent reservations cannot both commit plans that
// collide with each other unseen. It covers the Catalog read, the validation and the commit, not the
// plan call between them, which takes minutes: held across that call, it would serialize a batch's
// planning one child after another.

async function until(condition: () => boolean, ticks = 200): Promise<void> {
  for (let i = 0; i < ticks && !condition(); i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe("planner admission", () => {
  it("lets two reservations plan at once, and validates the second against the first's commit", async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "planner-admission-"));
    fs.mkdirSync(path.join(dataDir, "question-sets/listening"), { recursive: true });
    const pendingCalls: (() => void)[] = [];
    // Long enough wording for the containment measure to have something to compare.
    const plan = buildListeningPlan();
    plan.listenChoose = plan.listenChoose.map((entry) => ({
      ...entry,
      topic: "a student asking a classmate to close the lecture hall door before the seminar begins",
    }));
    const run = (async (request: SkillTaskRequest<unknown>) => {
      await new Promise<void>((resolve) => pendingCalls.push(resolve));
      return routed(request, plan);
    }) as SkillTaskRunner;
    const planner = createGenerationPlanner({ dataDir });
    const firstProgress: unknown[] = [];
    const secondProgress: unknown[] = [];

    const first = planner.reserve({
      kind: "listening", ownerId: "first-owner", runSkillTask: run,
      onProgress: (event) => firstProgress.push(event),
    });
    const second = planner.reserve({
      kind: "listening", ownerId: "second-owner", runSkillTask: run,
      onProgress: (event) => secondProgress.push(event),
    });
    const settled: Promise<ReservedGenerationPlan>[] = [first, second];
    try {
      await until(() => pendingCalls.length === 2);
      expect(pendingCalls).toHaveLength(2);

      pendingCalls[0]!();
      const firstReservation = await first;
      expect(firstReservation.advisoryNotes).toBeUndefined();

      pendingCalls[1]!();
      const secondReservation = await second;
      // The identical plan, validated after the first committed, sees the first's reservation.
      expect(secondReservation.advisoryNotes?.length).toBeGreaterThan(0);
      expect(JSON.stringify(secondProgress)).toContain("pending:first-owner");
      expect(JSON.stringify(firstProgress)).not.toContain("noveltyResidual");
    } finally {
      // With the lock held across the plan call, the second call would start only once the first
      // reservation returns; keep releasing until both settle so a failing run cannot hang.
      let done = false;
      void Promise.allSettled(settled).then(() => { done = true; });
      for (let i = 0; i < 50 && !done; i += 1) {
        pendingCalls.forEach((release) => release());
        await new Promise((resolve) => setImmediate(resolve));
      }
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
