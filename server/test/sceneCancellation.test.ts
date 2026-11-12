import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateSet, type Deps, type GenerationProgress } from "../src/services/generator.js";
import { JobCancelledError } from "../src/services/jobCancellation.js";
import { config } from "../src/lib/config.js";
import { validSpeakingSet } from "./helpers/setFixtures.js";
import { skillSuccess } from "./helpers/skillResults.js";
import { speakingPlanFixture } from "./helpers/generationDiversityFixtures.js";

// The scene image and the vision call that locates each sentence in it are two paid calls made after
// the audio. A job cancelled by then must buy neither: a cancel is checked before each, and both
// take the job's abort signal.

afterEach(() => {
  vi.restoreAllMocks();
});

function speakingRun(controller: AbortController) {
  const sceneImage = vi.fn(async (_setId: string, _lr: unknown, _deps?: { signal?: AbortSignal }) => (
    { file: "images/scenarios/stub.webp", prompt: "p", model: "gpt-image-2" as const }
  ));
  const focusRegions = vi.fn(async (_path: string, _sentences: string[], _deps?: { signal?: AbortSignal }) =>
    Array.from({ length: 7 }, () => null));
  const deps: Deps = {
    runSkillTask: vi.fn(async (request: { parse: (value: unknown) => unknown }) => skillSuccess(request.parse(validSpeakingSet("ignored")))) as never,
    planner: {
      reserve: vi.fn(async () => ({ reservationId: "reservation", ownerId: "owner", plan: speakingPlanFixture() })),
      release: vi.fn(),
    } as never,
    tts: vi.fn(async (_request: unknown, outPath: string) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, "stub-audio");
    }),
    probeDuration: vi.fn(async (filePath: string) => filePath.includes("iq") || filePath.includes("int-intro") ? 0.4 : 0.35),
    sceneImage: sceneImage as never,
    focusRegions: focusRegions as never,
    abortSignal: controller.signal,
  };
  return { deps, sceneImage, focusRegions };
}

function setIdOf(progress: GenerationProgress[]): string | undefined {
  return progress.map((event) => event.detail?.setId).find((id): id is string => typeof id === "string");
}

describe("a Speaking job cancelled after its audio", () => {
  it("buys no scene image when the cancel lands as the last clip finishes", async () => {
    const controller = new AbortController();
    const run = speakingRun(controller);
    const progress: GenerationProgress[] = [];
    const onProgress = (event: GenerationProgress): void => {
      progress.push(event);
      const detail = event.detail as { done?: number; total?: number } | undefined;
      if (event.stage === "rendering-audio" && detail?.done !== undefined && detail.done === detail.total) {
        controller.abort(new JobCancelledError("user"));
      }
    };

    const outcome = await generateSet("speaking", run.deps, onProgress).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(JobCancelledError);
    expect(run.sceneImage).not.toHaveBeenCalled();
    expect(run.focusRegions).not.toHaveBeenCalled();
    const setId = setIdOf(progress);
    expect(setId).toBeDefined();
    expect(fs.existsSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`))).toBe(false);
  });

  it("buys no vision call when the cancel lands during the image call, and hands both calls the signal", async () => {
    const controller = new AbortController();
    const run = speakingRun(controller);
    run.sceneImage.mockImplementationOnce(async (_setId, _lr, deps) => {
      expect(deps?.signal).toBe(controller.signal);
      controller.abort(new JobCancelledError("user"));
      return { file: "images/scenarios/stub.webp", prompt: "p", model: "gpt-image-2" as const };
    });

    const outcome = await generateSet("speaking", run.deps).catch((error: unknown) => error);

    expect(outcome).toBeInstanceOf(JobCancelledError);
    expect(run.sceneImage).toHaveBeenCalledTimes(1);
    expect(run.focusRegions).not.toHaveBeenCalled();
  });
});
