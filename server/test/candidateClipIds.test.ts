import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSet } from "../src/services/generator.js";
import { GenerationCandidateExhaustedError } from "../src/services/generationCandidateLoop.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import { config } from "../src/lib/config.js";
import { validSpeakingSet } from "./helpers/setFixtures.js";
import { skillSuccess } from "./helpers/skillResults.js";
import { speakingPlanFixture } from "./helpers/generationDiversityFixtures.js";
import {
  allOkListeningVerdict,
  buildListeningCandidate,
  buildListeningPlan,
  cleanupListeningArtifacts,
  fakeProbeDuration,
  fakeSynthesize,
  routed,
} from "./helpers/listeningGenerationFixture.js";

// Every Listening Stimulus and Listen and Choose a Response item, and every Speaking Item, is one
// clip file named by its id. The candidate stage rejects an id that names another's file, before a
// Listening Set spends its verify budget or a Speaking Set its renders, and the rejection costs one
// candidate attempt, as a duplicate Item id does (ADR 0006).

afterEach(() => {
  vi.restoreAllMocks();
});

function plannerFor(plan: unknown) {
  return {
    reserve: vi.fn(async (input: { ownerId: string }) => ({ reservationId: `reservation-${input.ownerId}`, ownerId: input.ownerId, plan })),
    release: vi.fn(),
  };
}

type ListeningCandidate = ReturnType<typeof buildListeningCandidate>;

async function generateListening(candidates: ListeningCandidate[]) {
  let generateCalls = 0;
  const verifiedStimuli: string[][] = [];
  const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
    if (request.task.task === "generate") {
      const candidate = candidates[Math.min(generateCalls, candidates.length - 1)]!;
      generateCalls += 1;
      return skillSuccess(request.parse(candidate));
    }
    const verdict = allOkListeningVerdict(request.prompt);
    verifiedStimuli.push(verdict.stimuli.map((stimulus) => stimulus.id));
    return routed(request, verdict);
  });
  const outcome = await generateSet("listening", {
    runSkillTask: runSkillTask as never,
    planner: plannerFor(buildListeningPlan()) as never,
    tts: fakeSynthesize,
    probeDuration: fakeProbeDuration,
  }).catch((error: unknown): Error => (error instanceof Error ? error : new Error(String(error))));
  if (!(outcome instanceof Error)) cleanupListeningArtifacts(outcome.setId);
  return { outcome, generateCalls, verifiedStimuli };
}

describe("a Listening candidate whose ids name one clip file twice", () => {
  it.each([
    ["two Stimuli share an id", (candidate: ListeningCandidate) => { candidate.router.conversations[1]!.id = candidate.router.conversations[0]!.id; }],
    ["a Stimulus id differs from a Listen and Choose a Response item's only by case", (candidate: ListeningCandidate) => {
      candidate.lowerModule.announcements[0]!.id = candidate.router.listenChoose[0]!.id.toUpperCase();
    }],
  ] as const)("is rejected at the candidate stage when %s, and the next attempt publishes", async (_case, collide) => {
    const colliding = buildListeningCandidate();
    collide(colliding);
    const { outcome, generateCalls, verifiedStimuli } = await generateListening([colliding, buildListeningCandidate()]);

    expect(outcome).not.toBeInstanceOf(Error);
    expect(generateCalls).toBe(2);
    // Nothing of the colliding candidate reached the Verifier.
    expect(verifiedStimuli).toHaveLength(1);
    expect(new Set(verifiedStimuli[0]).size).toBe(verifiedStimuli[0]!.length);
  });

  it("fails the job with the clash named once every attempt collides, before any verify call", async () => {
    const colliding = buildListeningCandidate();
    colliding.upperModule.academicTalks[0]!.id = colliding.router.conversations[0]!.id;
    const { outcome, generateCalls, verifiedStimuli } = await generateListening([colliding]);

    expect(outcome).toBeInstanceOf(GenerationCandidateExhaustedError);
    expect((outcome as Error).message).toContain(`stimulus ID "${colliding.router.conversations[0]!.id}" is not unique across the Set`);
    expect(generateCalls).toBe(3);
    expect(verifiedStimuli).toEqual([]);
  });
});

describe("a Speaking candidate whose ids name one clip file twice", () => {
  function speakingDeps(candidates: ReturnType<typeof validSpeakingSet>[]) {
    let generateCalls = 0;
    const tts = vi.fn(async (_request: unknown, outPath: string) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, "stub-audio");
    });
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      const candidate = candidates[Math.min(generateCalls, candidates.length - 1)]!;
      generateCalls += 1;
      return skillSuccess(request.parse(candidate));
    });
    return {
      deps: {
        runSkillTask: runSkillTask as never,
        planner: plannerFor(speakingPlanFixture()) as never,
        tts,
        probeDuration: vi.fn(async (filePath: string) => filePath.includes("iq") || filePath.includes("int-intro") ? 0.4 : 0.35),
        sceneImage: vi.fn().mockResolvedValue({ file: "images/scenarios/stub.webp", prompt: "p", model: "gpt-image-2" }) as never,
        focusRegions: vi.fn().mockResolvedValue(Array.from({ length: 7 }, () => null)) as never,
      },
      tts,
      generateCalls: () => generateCalls,
    };
  }

  it.each([
    ["an Interview question id differs from a Listen and Repeat id only by case", (set: ReturnType<typeof validSpeakingSet>) => { set.interview.questions[0]!.id = "LR1"; }],
    ["an id is the reserved briefing clip", (set: ReturnType<typeof validSpeakingSet>) => { set.listenAndRepeat.items[0]!.id = "briefing"; }],
  ] as const)("is rejected at the candidate stage when %s, and the next attempt publishes", async (_case, collide) => {
    const colliding = validSpeakingSet("ignored");
    collide(colliding);
    const run = speakingDeps([colliding, validSpeakingSet("ignored")]);

    const { setId } = await generateSet("speaking", run.deps);

    expect(run.generateCalls()).toBe(2);
    const published = JSON.parse(fs.readFileSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`), "utf8"));
    expect(published.interview.questions[0].id).toBe("iq1");
    fs.rmSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`), { force: true });
    fs.rmSync(path.join(config.dataDir, "audio/stimuli", setId), { recursive: true, force: true });
  });

  it("fails the job once every attempt collides, before any synthesis", async () => {
    const colliding = validSpeakingSet("ignored");
    colliding.interview.questions[1]!.id = "Iq1";
    const run = speakingDeps([colliding]);

    const outcome = await generateSet("speaking", run.deps).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(GenerationCandidateExhaustedError);
    expect((outcome as Error).message).toContain(`item IDs "iq1" and "Iq1" name the same clip file`);
    expect(run.generateCalls()).toBe(3);
    expect(run.tts).not.toHaveBeenCalled();
  });
});
