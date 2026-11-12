import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { AnySetSchema } from "@toefl-prep/shared";
import { generateSet } from "../src/services/generator.js";
import { createGenerationPlanner } from "../src/services/generationPlanner.js";
import type { SkillTaskRunner } from "../src/services/generationReasoning.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import {
  allOkListeningVerdict,
  buildListeningCandidate,
  buildListeningPlan,
  cleanupListeningArtifacts,
  fakeProbeDuration,
  fakeSynthesize,
  listeningDataDir,
  listeningMcq,
  listeningVerifyPayload,
  publishedListeningSetIds,
  publishedListeningSetPath,
  routed,
  skillSuccess,
  wordsOfLength,
} from "./helpers/listeningGenerationFixture.js";

// Item ids are the key a User's Response is stored under (`item_results` is keyed by attempt and
// item id), so two Items sharing an id means one Response silently overwrites the other. The
// candidate stage validates ids, but the verify stage can still replace content afterwards.

function itemIdsOf(set: ReturnType<typeof AnySetSchema.parse>): string[] {
  if (set.kind !== "listening") throw new Error("expected a listening set");
  return (["router", "lowerModule", "upperModule"] as const).flatMap((moduleName) => [
    ...set[moduleName].listenChoose.map((item) => item.id),
    ...set[moduleName].conversations.flatMap((c) => c.questions.map((q) => q.id)),
    ...set[moduleName].announcements.flatMap((a) => a.questions.map((q) => q.id)),
    ...set[moduleName].academicTalks.flatMap((t) => t.questions.map((q) => q.id)),
  ]);
}

/**
 * A run whose first verify round calls `conv-r1` unanswerable, and whose stimulus regeneration then
 * answers with the question ids of a different conversation: the model echoing ids it saw elsewhere.
 */
function collidingRegenerationRun(): SkillTaskRunner {
  let verifyRound = 0;
  return (async (request: SkillTaskRequest<unknown>) => {
    if (request.task.task === "plan") return skillSuccess(request.parse(buildListeningPlan()));
    if (request.task.task === "generate") {
      if (request.prompt.includes("```accepted-plan-json")) {
        return skillSuccess(request.parse(buildListeningCandidate()));
      }
      if (request.prompt.includes("```stimulus-regeneration")) {
        return routed(request, {
          transcript: [
            { speakerId: "conv-r1-sp1", text: wordsOfLength(45, "regenA") },
            { speakerId: "conv-r1-sp2", text: wordsOfLength(45, "regenB") },
          ],
          questions: [listeningMcq("conv-r2-q1", "a"), listeningMcq("conv-r2-q2", "b")],
        });
      }
      throw new Error(`unexpected generate call:\n${request.prompt.slice(0, 200)}`);
    }
    verifyRound += 1;
    const verdict = allOkListeningVerdict(request.prompt);
    if (verifyRound === 1) {
      const stimuli = verdict.stimuli.map((entry) =>
        entry.id === "conv-r1" ? { id: entry.id, verdict: "unanswerable" as const, reason: "q2 has no support" } : entry
      );
      return routed(request, { ...verdict, stimuli });
    }
    return routed(request, verdict);
  }) as SkillTaskRunner;
}

describe("item ids after the verify stage", () => {
  it("gives a regenerated Stimulus's questions the ids of the questions they replace", async () => {
    const dataDir = listeningDataDir();
    const before = publishedListeningSetIds();
    let outcome: { setId: string } | Error;
    try {
      outcome = await generateSet(
        "listening",
        {
          runSkillTask: collidingRegenerationRun(),
          planner: createGenerationPlanner({ dataDir }),
          tts: fakeSynthesize,
          probeDuration: fakeProbeDuration,
        },
      ).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }

    if (outcome instanceof Error) {
      expect([...publishedListeningSetIds()].filter((id) => !before.has(id))).toEqual([]);
      throw outcome;
    }
    try {
      const published = AnySetSchema.parse(JSON.parse(fs.readFileSync(publishedListeningSetPath(outcome.setId), "utf8")));
      const ids = itemIdsOf(published);
      expect(new Set(ids).size).toBe(ids.length);
      if (published.kind !== "listening") throw new Error("unreachable");
      const regenerated = published.router.conversations.find((c) => c.id === "conv-r1")!;
      expect(regenerated.questions.map((q) => q.id)).toEqual(["conv-r1-q1", "conv-r1-q2"]);
      // The replacement content landed — only its ids were taken from what it replaced.
      expect(JSON.stringify(regenerated.transcript)).toContain("regenA0");
      const untouched = published.router.conversations.find((c) => c.id === "conv-r2")!;
      expect(untouched.questions.map((q) => q.id)).toEqual(["conv-r2-q1", "conv-r2-q2"]);
    } finally {
      cleanupListeningArtifacts(outcome.setId);
    }
  });
});
