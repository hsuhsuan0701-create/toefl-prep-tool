import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validWritingSet } from "./helpers/setFixtures.js";
import { config } from "../src/lib/config.js";
import { generateSet } from "../src/services/generator.js";
import { verifyReadingSet } from "../src/services/readingGenerator.js";
import { verifyListeningSet } from "../src/services/listeningGenerator.js";
import type { SkillTaskRunner } from "../src/services/generationReasoning.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import { allOkReadingVerdict, assembledReadingSet, routed as routedReading } from "./helpers/readingVerifyFixture.js";
import { allOkListeningVerdict, listeningSetForVerify, routed as routedListening } from "./helpers/listeningGenerationFixture.js";
import { writingPlanFixture } from "./helpers/generationDiversityFixtures.js";

// A Verifier verdict must cover exactly the ids it was sent. An id it skipped was never judged, so
// treating its absence as "ok" publishes a Set whose Items nobody checked; an id it invented is a
// verdict about something that is not in the Set. Either way the parse throws, which makes it a
// failed call (the router handles it like any invalid reply), never an implicit pass.

function verifyOnlyRun(answer: (request: SkillTaskRequest<unknown>) => unknown): SkillTaskRunner {
  return (async (request: SkillTaskRequest<unknown>) => {
    if (request.task.task !== "verify") throw new Error(`unexpected ${request.task.task} call`);
    return answer(request);
  }) as SkillTaskRunner;
}

describe("Reading verifier coverage", () => {
  it("fails the verify call when an MCQ id is missing from the verdict", async () => {
    const set = await assembledReadingSet();
    const run = verifyOnlyRun((request) => {
      const verdict = allOkReadingVerdict(request.prompt);
      return routedReading(request, { ...verdict, mcqItems: verdict.mcqItems.filter((item) => item.id !== "dl-r1-q1") });
    });
    await expect(verifyReadingSet(set, run, undefined, set.id)).rejects.toThrow(/dl-r1-q1/);
  });

  it("fails the verify call when the verdict names an id that was never sent", async () => {
    const set = await assembledReadingSet();
    const run = verifyOnlyRun((request) => {
      const verdict = allOkReadingVerdict(request.prompt);
      return routedReading(request, {
        ...verdict,
        ctwPassages: [...verdict.ctwPassages, { id: "ctw-ghost", verdict: "ok" }],
      });
    });
    await expect(verifyReadingSet(set, run, undefined, set.id)).rejects.toThrow(/ctw-ghost/);
  });
});

describe("Listening verifier coverage", () => {
  it("fails the verify call when a question id is missing from the verdict", async () => {
    const set = listeningSetForVerify();
    const run = verifyOnlyRun((request) => {
      const verdict = allOkListeningVerdict(request.prompt);
      return routedListening(request, { ...verdict, questions: verdict.questions.filter((q) => q.id !== "conv-r1-q2") });
    });
    await expect(verifyListeningSet(set, run, undefined, set.id)).rejects.toThrow(/conv-r1-q2/);
  });

  it("fails the verify call when one id is judged twice", async () => {
    const set = listeningSetForVerify();
    const run = verifyOnlyRun((request) => {
      const verdict = allOkListeningVerdict(request.prompt);
      return routedListening(request, {
        ...verdict,
        listenChooseItems: [...verdict.listenChooseItems, { id: "lcr-r1", verdict: "ok" }],
      });
    });
    await expect(verifyListeningSet(set, run, undefined, set.id)).rejects.toThrow(/lcr-r1/);
  });
});

describe("Build a Sentence verifier coverage", () => {
  it("fails the verify call when an Item id is missing from the verdict", async () => {
    const before = new Set(fs.existsSync(writingDir()) ? fs.readdirSync(writingDir()) : []);
    const run = (async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "generate") return routedReading(request, validWritingSet("ignored"));
      return routedReading(request, {
        items: Array.from({ length: 9 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok", answers: null })),
      });
    }) as SkillTaskRunner;
    const planner = {
      reserve: vi.fn().mockResolvedValue({ reservationId: "r-1", ownerId: "o-1", plan: writingPlanFixture() }),
      validateCandidate: vi.fn().mockReturnValue([]),
      release: vi.fn(),
    };
    await expect(generateSet("writing", { runSkillTask: run, planner: planner as never })).rejects.toThrow(/bs10/);
    const after = fs.existsSync(writingDir()) ? fs.readdirSync(writingDir()) : [];
    expect(after.filter((name) => !before.has(name))).toEqual([]);
  });
});

function writingDir(): string {
  return path.join(config.dataDir, "question-sets/writing");
}

