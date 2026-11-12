import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validSpeakingSet, validWritingSet } from "./helpers/setFixtures.js";
import { skillSuccess } from "./helpers/skillResults.js";
import {
  generateSet as generateSetWithPlanner,
  importSet,
  type Deps,
  type GenerationProgress,
} from "../src/services/generator.js";
import {
  callGenerationSkillTask,
} from "../src/services/generationReasoning.js";
import { createGenerationPlanner } from "../src/services/generationPlanner.js";
import { config } from "../src/lib/config.js";
import {
  BUILD_A_SENTENCE_TILE_MAX,
  BUILD_A_SENTENCE_TILE_MIN,
  BUILD_A_SENTENCE_TILE_RAMP_FLOOR,
} from "../src/services/buildASentenceConformance.js";
import { JudgeError } from "../src/services/judges/index.js";
import { sceneImageLocation, SceneImageError } from "../src/services/sceneImage.js";
import { profileForSetId } from "../src/services/speakingAudioProfile.js";
import { setTtsConcurrencyForTests } from "../src/services/ttsQueue.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import { expectEveryObjectPropertyRequired } from "./schemaAssertions.js";
import {
  alternativeWritingPlanFixture,
  alternativeWritingSetFixture,
  speakingPlanFixture,
  speakingSetFixture,
  writingPlanFixture,
  writingSetFixture,
} from "./helpers/generationDiversityFixtures.js";

// The scene illustration costs one image call plus at least one vision call, so every speaking test
// in this file injects both: an un-stubbed speaking generation would reach the real APIs. The stubs
// stand in for sceneImage.ts's contract: generateSceneImage returns the Set's `image` field, and
// locateFocusRegions returns exactly one entry per sentence (null = "no ring here").
const stubImage = { file: "images/scenarios/stub.webp", prompt: "stub prompt", model: "gpt-image-2" };
const stubRegion = { x: 0.1, y: 0.2, w: 0.3, h: 0.4 };
function sceneDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    sceneImage: vi.fn().mockResolvedValue(stubImage) as never,
    focusRegions: vi.fn().mockResolvedValue(Array.from({ length: 7 }, () => stubRegion)) as never,
    probeDuration: vi.fn(async (filePath: string) => filePath.includes("iq") || filePath.includes("int-intro") ? 0.4 : 0.35),
    ...overrides,
  } as unknown as Deps;
}

function calibratedTts() {
  return vi.fn(async (_request: unknown, outPath: string) => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, "stub-audio");
  });
}

// The fixed 0.4/0.35 stub above is tuned to validSpeakingSet's placeholder text ("d", "hi", "S1.").
// A realistic set has sentences of real length, so a fixed duration reports thousands of words per
// minute and every clip misses its correction band. This returns the duration that puts each clip
// at its role's AUDIO_ROLE_POLICY target, inside its band, whatever the text actually says.
function probeDurationForSet(set: {
  listenAndRepeat: {
    scenarioDescription: string;
    items: readonly { id: string; sentence: string }[];
  };
  interview: {
    intro: string;
    questions: readonly { id: string; question: string }[];
  };
}) {
  const targetWpmByFile = new Map<string, { text: string; targetWpm: number }>([
    ["briefing.mp3", { text: set.listenAndRepeat.scenarioDescription, targetWpm: 165 }],
    ["int-intro.mp3", { text: set.interview.intro, targetWpm: 165 }],
    ...set.listenAndRepeat.items.map((item) =>
      [`${item.id}.mp3`, { text: item.sentence, targetWpm: 180 }] as const
    ),
    ...set.interview.questions.map((question) =>
      [`${question.id}.mp3`, { text: question.question, targetWpm: 155 }] as const
    ),
  ]);
  return vi.fn(async (filePath: string) => {
    const entry = [...targetWpmByFile.entries()].find(([file]) =>
      path.basename(filePath).includes(file)
    )?.[1];
    if (!entry) throw new Error(`unexpected clip path ${filePath}`);
    const words = entry.text.split(/\s+/u).filter(Boolean).length;
    return (words / entry.targetWpm) * 60;
  });
}

function plannerHarness(kind: "speaking" | "writing") {
  const reservation = {
    reservationId: `reservation-${kind}`,
    ownerId: `owner-${kind}`,
    plan: kind === "speaking"
      ? speakingPlanFixture()
      : writingPlanFixture(),
  };
  const planner = {
    reserve: vi.fn().mockResolvedValue(reservation),
    release: vi.fn(),
  };
  return { planner, reservation };
}

function generateSet(
  kind: "speaking" | "writing",
  deps: Deps = {},
  onProgress?: Parameters<typeof generateSetWithPlanner>[2],
) {
  const effectiveDeps = deps.planner
    ? deps
    : { ...deps, planner: plannerHarness(kind).planner as never };
  return generateSetWithPlanner(kind, effectiveDeps, onProgress);
}

function speakingSetWithUntrustedScene(id: string) {
  const set = validSpeakingSet(id);
  return {
    ...set,
    listenAndRepeat: {
      ...set.listenAndRepeat,
      image: {
        file: "images/scenarios/untrusted.webp",
        prompt: "S1. S2. S3. S4. S5. S6. S7.",
        model: "S1. S2. S3. S4. S5. S6. S7.",
      },
      items: set.listenAndRepeat.items.map((item) => ({
        ...item,
        focusRegion: { x: 0.6, y: 0.6, w: 0.2, h: 0.2 },
      })),
    },
  };
}

const lifecycleSetIds = new Set<string>();

function trackLifecycleSetId(progress: GenerationProgress): void {
  if (progress.detail?.setId) lifecycleSetIds.add(progress.detail.setId);
}

function lifecycleDeps(imageModel: string = "gpt-image-2"): Deps {
  return {
    runSkillTask: vi.fn().mockResolvedValueOnce({
      ok: true,
      value: validSpeakingSet("ignored"),
      provider: "claude",
      attempts: [],
    }) as never,
    tts: vi.fn(async (_request: unknown, outPath: string) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, "stub-audio");
    }) as never,
    sceneImage: vi.fn(async (setId: string) => {
      const image = sceneImageLocation(setId);
      fs.mkdirSync(path.dirname(image.path), { recursive: true });
      fs.writeFileSync(image.path, "stub-scene");
      return { file: image.file, prompt: "trusted prompt", model: imageModel };
    }) as never,
    focusRegions: vi.fn().mockResolvedValue(Array.from({ length: 7 }, () => null)) as never,
    probeDuration: vi.fn(async (filePath: string) => filePath.includes("iq") || filePath.includes("int-intro") ? 0.4 : 0.35),
  };
}

function lifecyclePaths(setId: string) {
  return {
    final: path.join(config.dataDir, "question-sets/speaking", `${setId}.json`),
    staging: path.join(config.dataDir, "question-sets/.staging", `${setId}.json`),
    audio: path.join(config.dataDir, "audio/stimuli", setId),
    scene: sceneImageLocation(setId).path,
  };
}

function calibratedAudioDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    tts: calibratedTts() as never,
    probeDuration: vi.fn(async (filePath: string) => filePath.includes("iq") || filePath.includes("int-intro") ? 0.4 : 0.35),
    ...overrides,
  } as unknown as Deps;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const setId of lifecycleSetIds) {
    const paths = lifecyclePaths(setId);
    fs.rmSync(paths.final, { recursive: true, force: true });
    fs.rmSync(paths.staging, { recursive: true, force: true });
    fs.rmSync(paths.audio, { recursive: true, force: true });
    fs.rmSync(paths.scene, { force: true });
  }
  lifecycleSetIds.clear();
});

describe("generateSet (writing)", () => {
  it("reserves, generates, verifies, publishes, and releases in order", async () => {
    const order: string[] = [];
    const { planner, reservation } = plannerHarness("writing");
    planner.reserve.mockImplementation(async () => {
      order.push("reserve");
      return reservation;
    });
    planner.release.mockImplementation(() => {
      order.push("release");
    });
    const runSkillTask = vi.fn(
      async (request: SkillTaskRequest<unknown>) => {
        if (request.task.context === "writing") {
          order.push("generate");
          return skillSuccess(request.parse(validWritingSet("ignored")));
        }
        order.push("verify");
        return skillSuccess(request.parse({
          items: Array.from({ length: 10 }, (_, index) => ({
            id: `bs${index + 1}`,
            verdict: "ok",
            answers: null,
          })),
        }));
      },
    );
    const originalRename = fs.renameSync;
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(
      (from, to) => {
        order.push("publish");
        return originalRename(from, to);
      },
    );

    const { setId } = await generateSet("writing", {
      runSkillTask: runSkillTask as never,
      planner: planner as never,
      generationOwnerId: "durable-job",
    } as never);

    expect(order).toEqual([
      "reserve",
      "generate",
      "verify",
      "publish",
      "release",
    ]);
    expect(planner.reserve).toHaveBeenCalledWith(expect.objectContaining({
      kind: "writing",
      ownerId: "durable-job",
    }));
    const written = JSON.parse(fs.readFileSync(
      path.join(config.dataDir, "question-sets/writing", `${setId}.json`),
      "utf8",
    ));
    expect(written.generationPlan).toEqual(reservation.plan);
    rename.mockRestore();
    fs.rmSync(
      path.join(config.dataDir, "question-sets/writing", `${setId}.json`),
    );
  });

  // What plan admission recorded rides on the reservation and is written onto the Set at mint time;
  // it never costs a candidate attempt.
  it("records the notes plan admission carried on the published Set, with one candidate call", async () => {
    const { planner, reservation } = plannerHarness("writing");
    const admitted = {
      ...reservation,
      advisoryNotes: [
        { check: "catalog-novelty" as const, detail: "containment", taskType: "email", conflictingSetIds: ["wri-saved"], score: 0.82 },
      ],
    };
    planner.reserve.mockResolvedValue(admitted);
    const requests: SkillTaskRequest<unknown>[] = [];
    const runSkillTask = vi.fn(
      async (request: SkillTaskRequest<unknown>) => {
        requests.push(request);
        if (request.task.context === "writing") {
          return skillSuccess(request.parse(validWritingSet("ignored")));
        }
        return skillSuccess(request.parse({
          items: Array.from({ length: 10 }, (_, index) => ({
            id: `bs${index + 1}`,
            verdict: "ok",
            answers: null,
          })),
        }));
      },
    );

    const { setId } = await generateSet("writing", {
      runSkillTask: runSkillTask as never,
      planner: planner as never,
    });

    // One candidate call, and the downstream verification still runs exactly once.
    expect(requests.filter(({ task }) => task.context === "writing")).toHaveLength(1);
    expect(requests.filter(({ task }) => task.context === "build_sentence")).toHaveLength(1);
    expect(requests[0]!.prompt).toContain(JSON.stringify(reservation.plan));
    // The generate prompt never names a prior Set.
    expect(requests[0]!.prompt).not.toContain("wri-saved");

    const written = JSON.parse(fs.readFileSync(
      path.join(config.dataDir, "question-sets/writing", `${setId}.json`),
      "utf8",
    )) as { advisoryNotes?: unknown[] };
    expect(written.advisoryNotes).toEqual(admitted.advisoryNotes);
    expect(planner.release).toHaveBeenCalledTimes(1);
    fs.rmSync(path.join(config.dataDir, "question-sets/writing", `${setId}.json`));
  });


  it("keeps imports planner-free even when a planner is supplied", async () => {
    const { planner } = plannerHarness("writing");
    const runSkillTask = vi.fn()
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) =>
        skillSuccess(request.parse(validWritingSet("ignored")))
      )
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) =>
        skillSuccess(request.parse({
          items: Array.from({ length: 10 }, (_, index) => ({
            id: `bs${index + 1}`,
            verdict: "ok",
            answers: null,
          })),
        }))
      );

    const { setId } = await importSet(
      "writing",
      "preserved source",
      { runSkillTask: runSkillTask as never, planner: planner as never },
    );

    expect(planner.reserve).not.toHaveBeenCalled();
    expect(planner.release).not.toHaveBeenCalled();
    fs.rmSync(
      path.join(config.dataDir, "question-sets/writing", `${setId}.json`),
    );
  });

  it("routes GENERATE and VERIFY independently with exact descriptors, parsers, and provider events", async () => {
    const requests: SkillTaskRequest<unknown>[] = [];
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      requests.push(request);
      if (request.task.context === "writing") {
        request.onEvent?.({ state: "running", provider: "claude" });
        return {
          ok: true as const,
          value: request.parse(validWritingSet("ignored")),
          provider: "claude" as const,
          attempts: [],
        };
      }
      request.onEvent?.({
        state: "running",
        provider: "codex",
        fallbackFrom: "claude",
      });
      return {
        ok: true as const,
        value: request.parse({
          items: Array.from({ length: 10 }, (_, i) => ({
            id: `bs${i + 1}`,
            verdict: "ok",
            answers: null,
          })),
        }),
        provider: "codex" as const,
        attempts: [{ provider: "claude" as const, kind: "quota" as const }],
      };
    });
    const events: GenerationProgress[] = [];

    const { setId } = await generateSet(
      "writing",
      { runSkillTask: runSkillTask as never },
      (progress) => events.push(progress),
    );

    expect(requests).toHaveLength(2);
    expect(requests[0].task).toEqual({ task: "generate", context: "writing" });
    expect(requests[0].prompt).toMatch(/^\/toefl-writing\nGENERATE writing/);
    expect(requests[0].jsonSchema).toMatchObject({ type: "object" });
    expect(requests[1].task).toEqual({ task: "verify", context: "build_sentence" });
    // `frame` is in the payload: the Verifier cannot judge whether a completed sentence reads
    // naturally without the words the frame supplies.
    const verifierPayload = validWritingSet("ignored").buildASentence.items.map(
      ({ id, prompt, frame, tiles, answers }) => ({ id, prompt, frame, tiles, answers }),
    );
    expect(requests[1].prompt).toBe(
      `/toefl-writing\nVERIFY build_sentence\n\nFor each item, drop its answer tiles into the frame's blanks in order and ask exactly three questions: (1) does the completed sentence read naturally, (2) is there a legitimate alternate order the answer key misses, (3) does the unused distractor tile genuinely discriminate. Do not rewrite frames, tiles or prompts.\n\nReturn {"items":[{"id","verdict":"ok","answers":null}|{"id","verdict":"fix","answers":[[...]]}]} with one item for every payload item. For "fix", "answers" must be the non-empty full replacement list.\n\n\`\`\`json\n${JSON.stringify(verifierPayload)}\n\`\`\``,
    );
    expect(requests[1].jsonSchema).toMatchObject({ type: "object" });
    expectEveryObjectPropertyRequired(requests[1].jsonSchema);
    expect(() => requests[1].parse({
      items: [{ id: "bs1", verdict: "ok" }],
    })).toThrow();
    expect(() => requests[1].parse({
      items: [{ id: "bs1", verdict: "fix", answers: null }],
    })).toThrow();
    expect(() => requests[1].parse({
      items: [{ id: "bs1", verdict: "fix", answers: [] }],
    })).toThrow();
    expect(() => requests[1].parse({
      items: [{ id: "bs1", verdict: "ok", answers: [["a", "b", "c"]] }],
    })).toThrow();
    type VerifierItemBranch = {
      properties: {
        id: Record<string, unknown>;
        verdict: { const?: string; enum?: string[] };
        answers: Record<string, unknown>;
      };
    };
    const verifierItemSchema = (requests[1].jsonSchema as {
      properties: {
        items: {
          items: {
            anyOf?: VerifierItemBranch[];
            oneOf?: VerifierItemBranch[];
          };
        };
      };
    }).properties.items.items;
    expect(verifierItemSchema).toHaveProperty("anyOf");
    expect(verifierItemSchema).not.toHaveProperty("oneOf");
    const verifierBranches = verifierItemSchema.anyOf;
    expect(verifierBranches).toHaveLength(2);
    const branchFor = (verdict: "ok" | "fix") => verifierBranches?.find((branch) => {
      const verdictSchema = branch.properties.verdict;
      return verdictSchema.const === verdict || verdictSchema.enum?.includes(verdict);
    });
    expect(branchFor("ok")?.properties.answers).toMatchObject({ type: "null" });
    expect(branchFor("fix")?.properties.answers).toMatchObject({
      type: "array",
      minItems: 1,
    });
    expect(events).toEqual(expect.arrayContaining([
      {
        stage: "generating",
        detail: {
          provider: "claude",
          generationAttempt: 1,
          maxDiversityAttempts: 3,
        },
      },
      {
        stage: "verifying",
        detail: { provider: "codex", fallbackFrom: "claude", setId },
      },
    ]));

    const file = path.join(config.dataDir, "question-sets/writing", `${setId}.json`);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written.buildASentence.items[0].answers).toEqual([["a", "b", "c", "d", "e"]]);
    fs.rmSync(file);
  });

  it("routes IMPORT with the import descriptor", async () => {
    const requests: SkillTaskRequest<unknown>[] = [];
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      requests.push(request);
      return request.task.context === "writing"
        ? {
            ok: true as const,
            value: request.parse(validWritingSet("ignored")),
            provider: "claude" as const,
            attempts: [],
          }
        : {
            ok: true as const,
            value: request.parse({
              items: Array.from({ length: 10 }, (_, i) => ({
                id: `bs${i + 1}`,
                verdict: "ok",
                answers: null,
              })),
            }),
            provider: "claude" as const,
            attempts: [],
          };
    });

    const { setId } = await importSet("writing", "source material", { runSkillTask } as never);

    expect(requests[0].task).toEqual({ task: "import", context: "writing" });
    expect(requests[0].prompt).toContain("\nIMPORT writing\n");
    fs.rmSync(path.join(config.dataDir, "question-sets/writing", `${setId}.json`));
  });

  // A generated Set cannot carry an unparseable frame this far: `frame-unparseable` is a fatal
  // conformance kind and the gate runs before verification. An import shares verifyBuildASentence
  // but neither protection: it validates with WritingGenerationInputSchema, whose Item shape has no
  // frame-parse refinement, and it runs no conformance gate, on purpose. So the blank-count check
  // skips a frame it cannot parse rather than let the parser throw, and the Set then fails where
  // every other malformed Set fails, at the schema, instead of ending a paid import with a raw
  // SentenceFrameError.
  it("does not let an unparseable imported frame throw out of Build a Sentence verification", async () => {
    const imported = validWritingSet("ignored");
    // Transcribed as the finished sentence with no blanks marked at all. Plausible rather than
    // contrived: the import prompt asks for the original wording to be preserved exactly.
    imported.buildASentence.items[0].frame = "The bakery sells fresh bread.";

    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) =>
      request.task.context === "writing"
        ? { ok: true as const, value: request.parse(imported), provider: "claude" as const, attempts: [] }
        : {
            ok: true as const,
            value: request.parse({
              items: Array.from({ length: 10 }, (_, i) => ({
                id: `bs${i + 1}`,
                // A "fix" verdict is what reaches the blank-count check at all, and it is the likely
                // one here: the answers cannot line up with blanks that were never marked.
                verdict: i === 0 ? "fix" : "ok",
                answers: i === 0 ? [["a", "b", "c", "d", "e"]] : null,
              })),
            }),
            provider: "claude" as const,
            attempts: [],
          });

    const error = await importSet("writing", "source material", { runSkillTask } as never)
      .then(() => null, (e: unknown) => e as Error);

    expect(error).not.toBeNull();
    // The parser's own error must not escape verification.
    expect(error?.name).not.toBe("SentenceFrameError");
    expect(String(error?.message)).toContain("frame");
  });

  it("generates, verifies, and writes a validated set atomically", async () => {
    const fakeRun = vi.fn()
      // 1st call: GENERATE returns the set (id will be replaced by generator)
      .mockResolvedValueOnce(skillSuccess(validWritingSet("ignored")))
      // 2nd call: VERIFY returns per-item verdicts, one correction
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => skillSuccess(request.parse({
        items: [
          { id: "bs1", verdict: "fix", answers: [["a", "b", "c", "d", "e"], ["e", "d", "c", "b", "a"]] },
          ...Array.from({ length: 9 }, (_, i) => ({
            id: `bs${i + 2}`,
            verdict: "ok",
            answers: null,
          })),
        ],
      })));
    const { setId } = await generateSet("writing", { runSkillTask: fakeRun as never });
    const file = path.join(config.dataDir, "question-sets/writing", `${setId}.json`);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written.id).toBe(setId);
    expect(written.buildASentence.items[0].answers).toHaveLength(2); // verifier correction applied
    // This call's own staging file must be gone (moved by renameSync), but the shared .staging
    // dir itself is not asserted either way: a concurrent generateSet call may still have its own
    // temp file in flight there, so the generator must never bulk-delete that shared directory.
    expect(fs.existsSync(path.join(config.dataDir, "question-sets/.staging", `${setId}.json`))).toBe(false);
    fs.rmSync(file);
  });

  it("fails cleanly when routed output is invalid", async () => {
    const fakeRun = vi.fn().mockResolvedValue(skillSuccess({ nonsense: true }));
    await expect(generateSet("writing", { runSkillTask: fakeRun as never })).rejects.toThrow(/validation/i);
  });

  it("rejects an item id that would escape its directory as an mp3 filename segment", async () => {
    const bad = validWritingSet("ignored");
    bad.buildASentence.items[0].id = "../evil";
    const fakeRun = vi.fn().mockResolvedValue(skillSuccess(bad));
    await expect(generateSet("writing", { runSkillTask: fakeRun as never })).rejects.toThrow(/validation/i);
  });

  it("rejects duplicate item ids within the same set", async () => {
    const bad = validWritingSet("ignored");
    bad.buildASentence.items[1].id = bad.buildASentence.items[0].id;
    const fakeRun = vi.fn().mockResolvedValue(skillSuccess(bad));
    await expect(generateSet("writing", { runSkillTask: fakeRun as never })).rejects.toThrow(/validation/i);
  });

  it("rejects verifier replacements whose order contains tiles not in the item", async () => {
    const fakeRun = vi.fn()
      .mockResolvedValueOnce(skillSuccess(validWritingSet("ignored")))
      // VERIFY returns a fix naming "z", which is not one of this item's tiles
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => skillSuccess(request.parse({
        items: [
          { id: "bs1", verdict: "fix", answers: [["z", "b", "c", "d", "e"]] },
          ...Array.from({ length: 9 }, (_, i) => ({
            id: `bs${i + 2}`,
            verdict: "ok",
            answers: null,
          })),
        ],
      })));
    await expect(generateSet("writing", { runSkillTask: fakeRun as never })).rejects.toThrow(/subset/i);
  });

  // The Build a Sentence conformance gate, as the candidate loop runs it.
  //
  // A helper rather than ten literals: every case below is "the same Set, with one thing wrong",
  // which is what makes the tier the test is about legible.
  const writingSetWithItems = (
    overrides: Partial<{ frame: string | null; tiles: string[]; answers: string[][] }>,
  ) => {
    const set = validWritingSet("ignored");
    return {
      ...set,
      buildASentence: {
        items: set.buildASentence.items.map((item) => ({ ...item, ...overrides })),
      },
    };
  };

  const okVerdicts = {
    items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok", answers: null })),
  };

  it("regenerates a candidate whose Items break the format, naming every defect at once", async () => {
    const requests: SkillTaskRequest<unknown>[] = [];
    let generates = 0;
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      requests.push(request);
      if (request.task.context !== "writing") return skillSuccess(request.parse(okVerdicts));
      generates += 1;
      // Attempt 1 is wrong in two independent ways at once: a tile carrying the sentence's full stop
      // (a position leak) and, because the answer now names a tile the Item does not offer, a broken
      // answer key. Attempt 2 is the conforming Set.
      return skillSuccess(request.parse(
        generates === 1
          ? writingSetWithItems({ tiles: ["a", "b", "c", "d", "e", "f."] })
          : validWritingSet("ignored"),
      ));
    });

    const { setId } = await generateSet("writing", { runSkillTask: runSkillTask as never });

    const generateRequests = requests.filter(({ task }) => task.context === "writing");
    expect(generateRequests).toHaveLength(2);
    // The retry prompt carries the whole violation list, so one regeneration can fix everything
    // rather than trading one defect for another across three attempts.
    const retryPrompt = generateRequests[1]!.prompt;
    expect(retryPrompt).toContain("build-a-sentence-conformance-retry");
    expect(retryPrompt).toContain("tile-final-punctuation");
    expect(retryPrompt).toContain("buildASentence/items[9]");
    // Positions and counts only — a frame, a tile and a prompt are all Item content.
    expect(retryPrompt.split("build-a-sentence-conformance-retry")[1]).not.toContain("this morning");
    // The preamble restates the tile band from the named constants, so the one prompt whose job is
    // to name the format the next attempt must hit cannot drift from what the gate checks.
    //
    // The floor it names is the guide's ramp floor, not the gate's `BUILD_A_SENTENCE_TILE_MIN`. That
    // four is a gate-only tolerance, and a prompt that published it would hand the model the slack
    // to write to, the leak optionQuality.ts's header forbids. The second assertion is the
    // load-bearing half: the tolerance must not reach this prompt by any route.
    expect(retryPrompt).toContain(
      `${BUILD_A_SENTENCE_TILE_RAMP_FLOOR}-${BUILD_A_SENTENCE_TILE_MAX} tiles`,
    );
    // Read back off the sentence itself, so the floor is asserted to be the target and asserted not
    // to be the tolerance. The fenced block below it carries each violation's `detail` verbatim; the
    // test after this one holds `tile-count`'s detail to the same rule.
    const band = /conforming Item has (\d+)-(\d+) tiles/u.exec(retryPrompt);
    expect(band, "the retry preamble states no tile band").not.toBeNull();
    expect(Number(band![1])).toBe(BUILD_A_SENTENCE_TILE_RAMP_FLOOR);
    expect(Number(band![1])).not.toBe(BUILD_A_SENTENCE_TILE_MIN);
    expect(Number(band![2])).toBe(BUILD_A_SENTENCE_TILE_MAX);

    const written = JSON.parse(fs.readFileSync(
      path.join(config.dataDir, "question-sets/writing", `${setId}.json`),
      "utf8",
    )) as { advisoryNotes?: unknown; buildASentence: { items: { frame?: string }[] } };
    expect(written.advisoryNotes).toBeUndefined();
    expect(written.buildASentence.items[0].frame).toBe("The ___ ___ ___ ___ ___ this morning.");
    fs.rmSync(path.join(config.dataDir, "question-sets/writing", `${setId}.json`));
  });

  it("tells the retry the authoring tile range, never the gate's floor, in the violation details too", async () => {
    const requests: SkillTaskRequest<unknown>[] = [];
    let generates = 0;
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      requests.push(request);
      if (request.task.context !== "writing") return skillSuccess(request.parse(okVerdicts));
      generates += 1;
      // Attempt 1: eleven tiles for ten blanks, so `tile-count` fires and its detail rides into the
      // retry's fenced block. Attempt 2 conforms.
      return skillSuccess(request.parse(
        generates === 1
          ? writingSetWithItems({
            frame: "The ___ ___ ___ ___ ___ ___ ___ ___ ___ ___ this morning.",
            tiles: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"],
            answers: [["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]],
          })
          : validWritingSet("ignored"),
      ));
    });

    const { setId } = await generateSet("writing", { runSkillTask: runSkillTask as never });

    const retryPrompt = requests.filter(({ task }) => task.context === "writing")[1]!.prompt;
    const fenced = retryPrompt.split("build-a-sentence-conformance-retry")[1]!;
    expect(fenced).toContain("tile-count");
    expect(fenced).toContain(`${BUILD_A_SENTENCE_TILE_RAMP_FLOOR}–${BUILD_A_SENTENCE_TILE_MAX}`);
    // The gate's floor, in either dash, appears nowhere the model reads.
    for (const range of [
      `${BUILD_A_SENTENCE_TILE_MIN}–${BUILD_A_SENTENCE_TILE_MAX}`,
      `${BUILD_A_SENTENCE_TILE_MIN}-${BUILD_A_SENTENCE_TILE_MAX}`,
    ]) {
      expect(retryPrompt).not.toContain(range);
    }
    fs.rmSync(path.join(config.dataDir, "question-sets/writing", `${setId}.json`));
  });

  it("publishes a Set whose surviving defects only change its difficulty, recording them on it", async () => {
    let generates = 0;
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      if (request.task.context !== "writing") return skillSuccess(request.parse(okVerdicts));
      generates += 1;
      // Eleven tiles for ten blanks: above the gate's 4-10 band on every attempt. Every other rule
      // holds (one distractor, no capital or final stop on a tile), so the Item is fully
      // practisable and, after the regeneration budget, is recorded and published rather than
      // discarded. Only the ceiling can be exceeded this way: the floor of four is the shortest Item
      // the schema's three-token `answers` minimum admits.
      return skillSuccess(request.parse(writingSetWithItems({
        frame: "The ___ ___ ___ ___ ___ ___ ___ ___ ___ ___ this morning.",
        tiles: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"],
        answers: [["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]],
      })));
    });

    const { setId } = await generateSet("writing", { runSkillTask: runSkillTask as never });

    expect(generates).toBe(3);
    const written = JSON.parse(fs.readFileSync(
      path.join(config.dataDir, "question-sets/writing", `${setId}.json`),
      "utf8",
    )) as { advisoryNotes?: { check: string; detail: string; taskType?: string; itemPosition?: number }[] };
    expect(written.advisoryNotes).toHaveLength(10);
    expect(written.advisoryNotes?.[3]).toEqual({
      check: "content-gate",
      detail: "tile-count",
      taskType: "build_sentence",
      itemPosition: 3,
    });
    fs.rmSync(path.join(config.dataDir, "question-sets/writing", `${setId}.json`));
  });

  it("fails the job when an Item stays unattemptable after the regeneration budget", async () => {
    let generates = 0;
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      if (request.task.context !== "writing") return skillSuccess(request.parse(okVerdicts));
      generates += 1;
      // `null` is how the model says "no frame" under a required-and-nullable key. A frameless Item
      // renders a notice instead of an interaction, so it cannot be practised at all.
      return skillSuccess(request.parse(writingSetWithItems({ frame: null })));
    });

    await expect(generateSet("writing", { runSkillTask: runSkillTask as never }))
      .rejects.toThrow(/build a sentence items are unusable/i);
    expect(generates).toBe(3);
  });

  it("rejects a verifier replacement that does not fill every blank exactly once", async () => {
    const fakeRun = vi.fn()
      .mockResolvedValueOnce(skillSuccess(validWritingSet("ignored")))
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => skillSuccess(request.parse({
        items: [
          // Every token is one of the Item's tiles, so the subset check beside this one passes; the
          // order is three tokens short of the frame's five blanks.
          { id: "bs1", verdict: "fix", answers: [["a", "b"]] },
          ...Array.from({ length: 9 }, (_, i) => ({ id: `bs${i + 2}`, verdict: "ok", answers: null })),
        ],
      })));

    await expect(generateSet("writing", { runSkillTask: fakeRun as never }))
      .rejects.toThrow(/fill every blank/i);
  });

  it("accepts verifier replacements whose orders are tile subsets", async () => {
    const fakeRun = vi.fn()
      .mockResolvedValueOnce(skillSuccess(validWritingSet("ignored")))
      // VERIFY returns a fix that is a permutation of the accepted order — a valid tile subset, and
      // still one token per blank
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => skillSuccess(request.parse({
        items: [
          { id: "bs1", verdict: "fix", answers: [["e", "d", "c", "b", "a"]] },
          ...Array.from({ length: 9 }, (_, i) => ({
            id: `bs${i + 2}`,
            verdict: "ok",
            answers: null,
          })),
        ],
      })));
    const { setId } = await generateSet("writing", { runSkillTask: fakeRun as never });
    const file = path.join(config.dataDir, "question-sets/writing", `${setId}.json`);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written.buildASentence.items[0].answers).toEqual([["e", "d", "c", "b", "a"]]);
    fs.rmSync(file);
  });
});

describe("generateSet (speaking)", () => {
  // Each paid step runs exactly once, never per attempt, for a Set admitted with notes.
  it("runs TTS, image, and regions exactly once for a plan admitted with notes", async () => {
    const { planner, reservation } = plannerHarness("speaking");
    planner.reserve.mockResolvedValue({
      ...reservation,
      advisoryNotes: [
        { check: "catalog-novelty", detail: "containment", taskType: "interview", conflictingSetIds: ["spk-saved"], score: 0.8 },
        { check: "catalog-novelty", detail: "containment", taskType: "listen_repeat", score: 0.9 },
      ],
    });
    const candidateCalls: SkillTaskRequest<unknown>[] = [];
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      if (request.task.task === "generate") candidateCalls.push(request);
      return skillSuccess(request.parse(validSpeakingSet("ignored")));
    });
    const tts = calibratedTts();
    const sceneImage = vi.fn().mockResolvedValue(stubImage);
    const focusRegions = vi.fn().mockResolvedValue(Array.from({ length: 7 }, () => null));

    const { setId } = await generateSet("speaking", {
      runSkillTask: runSkillTask as never,
      planner: planner as never,
      tts: tts as never,
      probeDuration: probeDurationForSet(validSpeakingSet("ignored")),
      sceneImage: sceneImage as never,
      focusRegions: focusRegions as never,
    });

    expect(candidateCalls).toHaveLength(1);
    expect(sceneImage).toHaveBeenCalledTimes(1);
    expect(focusRegions).toHaveBeenCalledTimes(1);
    // 13 base clips, one paid synthesis each, no retries anywhere.
    expect(tts).toHaveBeenCalledTimes(13);
    const written = JSON.parse(fs.readFileSync(
      path.join(config.dataDir, "question-sets/speaking", `${setId}.json`),
      "utf8",
    )) as { advisoryNotes?: unknown[] };
    expect(written.advisoryNotes).toHaveLength(2);
    fs.rmSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`));
    fs.rmSync(path.join(config.dataDir, "audio/stimuli", setId), { recursive: true, force: true });
  });

  // An item 7 past the ramp table's 16-word ceiling. The gate runs before the TTS and image renders,
  // so the regeneration spends only a generate call, never a paid render.
  const overlongSpeakingSet = () => {
    const set = validSpeakingSet("ignored");
    // 17 words, one past item 7's published 16-word ceiling, and still short enough to be delivered
    // both inside its rate band and inside the 5.0 s clip ceiling (at 206 WPM, 4.95 s; the band tops
    // out at 209 WPM). That lets one fixture cover both the clip that fits and, through
    // `overlongProbe`, the clip that does not.
    set.listenAndRepeat.items[6].sentence =
      "The staff member who covers the evening desk can help you find the forms before you leave.";
    return set;
  };

  /**
   * `probeDurationForSet` reports every Listen and Repeat clip at a flat 180 WPM, which for an
   * over-long item means a clip past the 5.0 s ceiling and a third, render-time note. This puts item
   * 7 at the given duration instead: at 4.95 s it sits inside its band and fits the ceiling, so a
   * test sees only the content gate's notes (projections made before any spend); at 5.667 s it
   * drives the render-time breach deliberately.
   */
  const overlongProbe = (itemSevenSec: number) => {
    const base = probeDurationForSet(overlongSpeakingSet());
    return vi.fn(async (filePath: string) =>
      path.basename(filePath).startsWith("lr7.") || path.basename(filePath).startsWith(".lr7.") ? itemSevenSec : base(filePath),
    );
  };

  it("regenerates a candidate whose Listen and Repeat item runs past its word ceiling, then publishes clean", async () => {
    const { planner } = plannerHarness("speaking");
    const generateCalls: SkillTaskRequest<unknown>[] = [];
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      generateCalls.push(request);
      return skillSuccess(request.parse(
        generateCalls.length === 1 ? overlongSpeakingSet() : validSpeakingSet("ignored"),
      ));
    });
    const tts = calibratedTts();

    const { setId } = await generateSet("speaking", {
      runSkillTask: runSkillTask as never,
      planner: planner as never,
      tts: tts as never,
      probeDuration: probeDurationForSet(validSpeakingSet("ignored")),
      sceneImage: vi.fn().mockResolvedValue(stubImage) as never,
      focusRegions: vi.fn().mockResolvedValue(Array.from({ length: 7 }, () => null)) as never,
    });

    expect(generateCalls).toHaveLength(2);
    // The second attempt is told exactly which item broke which ceiling, as a format retry, and by
    // position only, never by quoting the sentence.
    const retryPrompt = generateCalls[1].prompt;
    expect(retryPrompt).toContain("listen-and-repeat-conformance-retry");
    expect(retryPrompt).toContain("lr-word-count-over");
    expect(retryPrompt).toContain("listenAndRepeat/items[6]");
    expect(retryPrompt).not.toContain("evening desk");
    // 13 base clips rendered once each: the rejected candidate never reached TTS.
    expect(tts).toHaveBeenCalledTimes(13);
    const written = JSON.parse(fs.readFileSync(
      path.join(config.dataDir, "question-sets/speaking", `${setId}.json`),
      "utf8",
    )) as { advisoryNotes?: unknown[] };
    expect(written.advisoryNotes).toBeUndefined();
    fs.rmSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`));
    fs.rmSync(path.join(config.dataDir, "audio/stimuli", setId), { recursive: true, force: true });
  });

  it("publishes an over-long Listen and Repeat item after the regeneration budget, with a content-gate advisory note", async () => {
    const { planner } = plannerHarness("speaking");
    const generateCalls: SkillTaskRequest<unknown>[] = [];
    // Every attempt reproduces the defect — the ADR-0006 ending is a recorded note on the
    // published Set, never a discarded job.
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      generateCalls.push(request);
      return skillSuccess(request.parse(overlongSpeakingSet()));
    });
    const tts = calibratedTts();

    const { setId } = await generateSet("speaking", {
      runSkillTask: runSkillTask as never,
      planner: planner as never,
      tts: tts as never,
      probeDuration: overlongProbe(4.95) as never,
      sceneImage: vi.fn().mockResolvedValue(stubImage) as never,
      focusRegions: vi.fn().mockResolvedValue(Array.from({ length: 7 }, () => null)) as never,
    });

    expect(generateCalls).toHaveLength(3);
    // The accepted candidate still renders in full — 13 clips, one paid synthesis each.
    expect(tts).toHaveBeenCalledTimes(13);
    const written = JSON.parse(fs.readFileSync(
      path.join(config.dataDir, "question-sets/speaking", `${setId}.json`),
      "utf8",
    )) as {
      advisoryNotes?: unknown[];
      listenAndRepeat: { items: { sentence: string }[] };
    };
    // The over-long sentence is published as-is (the render was paid for), carrying the durable
    // record: a position and a server-authored kind, no content. It breaks both published budgets,
    // item 7's word ceiling and, at the slowest rate its band accepts, the 5.0 s clip ceiling, and
    // each is recorded on its own because they are separate budgets a reader of the Set should be
    // able to tell apart.
    //
    // `lr-clip-duration-over` is a projection, taken at the band floor before anything is spent,
    // and deliberately pessimistic: it says this sentence would run long at the slowest rate nobody
    // would correct. Here the clip came back at 206 WPM and 4.95 s, inside the ceiling, so no
    // render-time note joins the two and the Set publishes, disclosing that it was close.
    expect(written.listenAndRepeat.items[6].sentence).toContain("evening desk");
    expect(written.advisoryNotes).toEqual([
      {
        check: "content-gate",
        detail: "lr-word-count-over",
        taskType: "listen_repeat",
        itemPosition: 6,
      },
      {
        check: "content-gate",
        detail: "lr-clip-duration-over",
        taskType: "listen_repeat",
        itemPosition: 6,
      },
    ]);
    fs.rmSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`));
    fs.rmSync(path.join(config.dataDir, "audio/stimuli", setId), { recursive: true, force: true });
  });

  /**
   * The other side of the test above: same Set, same tolerated content-gate violations, and the only
   * difference is what the clip measured. Here item 7 comes back at 5.667 s, past the 5.0 s ceiling,
   * after the corrective re-render. That is a harder item than designed, not an unusable one, so the
   * Set publishes and the measured breach is recorded beside the projected one.
   */
  it("publishes with a note when the over-long item's clip is DELIVERED past the 5.0s ceiling", async () => {
    const { planner } = plannerHarness("speaking");
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) =>
      skillSuccess(request.parse(overlongSpeakingSet())),
    );

    const { setId } = await generateSet("speaking", {
      runSkillTask: runSkillTask as never,
      planner: planner as never,
      tts: calibratedTts() as never,
      probeDuration: overlongProbe(5.667) as never,
      sceneImage: vi.fn().mockResolvedValue(stubImage) as never,
      focusRegions: vi.fn().mockResolvedValue(Array.from({ length: 7 }, () => null)) as never,
    });

    try {
      const written = JSON.parse(fs.readFileSync(
        path.join(config.dataDir, "question-sets/speaking", `${setId}.json`),
        "utf8",
      )) as { advisoryNotes?: unknown[] };
      expect(written.advisoryNotes).toContainEqual({
        check: "content-gate", detail: "lr-clip-over-ceiling", taskType: "listen_repeat", itemPosition: 6,
      });
    } finally {
      fs.rmSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`), { force: true });
      fs.rmSync(path.join(config.dataDir, "audio/stimuli", setId), { recursive: true, force: true });
    }
  });

  it("PLAN and GENERATE can independently fall back Claude to Codex without an HTTP route", async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "generation-fallback-integration-"),
    );
    fs.mkdirSync(path.join(dataDir, "question-sets/speaking"), {
      recursive: true,
    });
    fs.mkdirSync(path.join(dataDir, "question-sets/writing"), {
      recursive: true,
    });
    const planner = createGenerationPlanner({ dataDir });
    const requests: SkillTaskRequest<unknown>[] = [];
    const events: GenerationProgress[] = [];
    const runSkillTask = vi.fn(
      async (request: SkillTaskRequest<unknown>) => {
        requests.push(request);
        request.onEvent?.({
          state: "fallback",
          provider: "codex",
          fallbackFrom: "claude",
          failureKind: "quota",
        });
        request.onEvent?.({
          state: "running",
          provider: "codex",
          fallbackFrom: "claude",
        });
        const value = request.task.task === "plan"
          ? speakingPlanFixture()
          : speakingSetFixture();
        return {
          ok: true as const,
          value: request.parse(value),
          provider: "codex" as const,
          attempts: [{
            provider: "claude" as const,
            kind: "quota" as const,
          }],
        };
      },
    );

    try {
      const { setId } = await generateSet("speaking", {
        runSkillTask: runSkillTask as never,
        planner,
        ...sceneDeps({
          probeDuration: probeDurationForSet(speakingSetFixture()),
        } as Partial<Deps>),
        tts: calibratedTts(),
      }, (event) => events.push(event));

      expect(requests.map(({ task }) => task.task)).toEqual([
        "plan",
        "generate",
      ]);
      expect(events).toEqual(expect.arrayContaining([
        {
          stage: "planning",
          detail: {
            provider: "codex",
            fallbackFrom: "claude",
            planningAttempt: 1,
            maxDiversityAttempts: 3,
          },
        },
        {
          stage: "generating",
          detail: {
            provider: "codex",
            fallbackFrom: "claude",
            generationAttempt: 1,
            maxDiversityAttempts: 3,
          },
        },
      ]));
      expect(JSON.stringify(events)).not.toContain("openai-http");
      fs.rmSync(
        path.join(config.dataDir, "question-sets/speaking", `${setId}.json`),
      );
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  // End to end through the real planner and the real novelty checks, against a bank that already
  // holds a saved Writing Set, with realistic content: ordinary Build a Sentence wording that carries
  // no domain-classifier signal at all. The unit fixtures plant a classifier keyword in each Item,
  // so only content like this shows that wording without one costs no regeneration.
  it("publishes a realistic Writing set in one PLAN and one GENERATE against a non-empty bank", async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "generation-realistic-writing-"),
    );
    fs.mkdirSync(path.join(dataDir, "question-sets/speaking"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "question-sets/writing"), { recursive: true });
    const saved = writingSetFixture();
    saved.id = "wri-already-saved";
    fs.writeFileSync(
      path.join(dataDir, "question-sets/writing/wri-already-saved.json"),
      JSON.stringify(saved),
    );
    const planner = createGenerationPlanner({ dataDir });
    const tasks: string[] = [];
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      tasks.push(request.task.task);
      if (request.task.task === "plan") {
        return skillSuccess(request.parse(alternativeWritingPlanFixture()));
      }
      if (request.task.task === "verify") {
        return skillSuccess(request.parse({
          items: alternativeWritingSetFixture().buildASentence.items.map((item) => ({
            id: item.id,
            verdict: "ok" as const,
            answers: null,
          })),
        }));
      }
      return skillSuccess(request.parse(alternativeWritingSetFixture()));
    });

    try {
      const { setId } = await generateSet("writing", {
        runSkillTask: runSkillTask as never,
        planner,
      });

      expect(tasks).toEqual(["plan", "generate", "verify"]);
      const published = JSON.parse(fs.readFileSync(
        path.join(config.dataDir, "question-sets/writing", `${setId}.json`),
        "utf8",
      )) as { generationPlan?: unknown; buildASentence: { items: unknown[] } };
      expect(published.generationPlan).toBeDefined();
      expect(published.buildASentence.items).toHaveLength(10);
      fs.rmSync(
        path.join(config.dataDir, "question-sets/writing", `${setId}.json`),
      );
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("does not advertise or retain server-owned scene fields in the routed generation input", async () => {
    const fakeRun = vi.fn().mockImplementationOnce(async (opts: SkillTaskRequest<unknown> & { jsonSchema: Record<string, any> }) => {
      expect(opts.task).toEqual({ task: "generate", context: "speaking" });
      const lr = opts.jsonSchema.properties.listenAndRepeat;
      expect(lr.properties).not.toHaveProperty("image");
      expect(lr.properties.items.items.properties).not.toHaveProperty("focusRegion");
      return skillSuccess(speakingSetWithUntrustedScene("ignored"));
    });
    const scene = sceneDeps();
    const { setId } = await generateSet("speaking", {
      runSkillTask: fakeRun as never,
      tts: calibratedTts(),
      ...scene,
    });

    const input = (scene.sceneImage as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(input).not.toHaveProperty("image");
    expect(input.items.every((item: { focusRegion?: unknown }) => !item.focusRegion)).toBe(true);
    fs.rmSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`));
  });

  it("routes speaking IMPORT with its exact descriptor and slash-prefixed prompt", async () => {
    const fakeRun = vi.fn().mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
      expect(request.task).toEqual({ task: "import", context: "speaking" });
      expect(request.prompt).toMatch(/^\/toefl-speaking\nIMPORT speaking/);
      return skillSuccess(validSpeakingSet("ignored"));
    });
    const { setId } = await importSet(
      "speaking",
      "source material",
      {
        runSkillTask: fakeRun as never,
        tts: calibratedTts(),
        ...sceneDeps(),
      },
    );
    fs.rmSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`));
  });

  it("renders TTS for all 13 stimuli before publishing", async () => {
    const speakingSet = validSpeakingSet("x");
    const fakeRun = vi.fn().mockResolvedValueOnce(skillSuccess(speakingSet));
    const fakeTts = calibratedTts();
    const { setId } = await generateSet("speaking", { runSkillTask: fakeRun as never, tts: fakeTts, ...sceneDeps() });
    expect(fakeTts).toHaveBeenCalledTimes(13); // briefing + 7 LR + intro + 4 questions
    const file = path.join(config.dataDir, "question-sets/speaking", `${setId}.json`);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(written.listenAndRepeat.items[0].audio).toBe(`stimuli/${setId}/lr1.mp3`);
    fs.rmSync(file);
  });

  it("removes orphaned audio and does not publish when TTS fails mid-batch", async () => {
    const speakingSet = validSpeakingSet("x");
    const fakeRun = vi.fn().mockResolvedValueOnce(skillSuccess(speakingSet));
    let calls = 0;
    // Call 1 is the briefing and calls 2-8 are the 7 Listen and Repeat items; call 9 is the interview
    // intro. It fails there, after real files were written, so cleanup has something to remove.
    const fakeTts = vi.fn().mockImplementation(async (_req: unknown, outPath: string) => {
      calls++;
      if (calls === 9) throw new Error("tts boom");
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, "stub-audio");
    });
    const scene = sceneDeps();
    await expect(
      generateSet("speaking", { runSkillTask: fakeRun as never, tts: fakeTts, ...scene })
    ).rejects.toThrow("tts boom");
    // The image is generated after the audio, so a mid-batch TTS failure never spends the paid image
    // call on a Set that will not exist.
    expect(scene.sceneImage).not.toHaveBeenCalled();
    expect(fakeTts).toHaveBeenCalledTimes(9);
    const stimuliDir = path.dirname(fakeTts.mock.calls[0][1] as string);
    const setId = path.basename(stimuliDir);
    expect(fs.existsSync(stimuliDir)).toBe(false); // the mp3s from calls 1-8 were removed
    expect(fs.existsSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`))).toBe(false);
  });
});

describe("direct speaking set lifecycle cleanup", () => {
  it("preserves a pre-existing audio target on a typed renderer collision while cleaning this attempt's staging and scene artifacts", async () => {
    const setId = "spk-audio-co";
    vi.spyOn(crypto, "randomUUID").mockReturnValue("audio-collision-0000-0000-0000-000000000000");
    const paths = lifecyclePaths(setId); fs.mkdirSync(paths.audio, { recursive: true }); fs.writeFileSync(path.join(paths.audio, "sentinel.txt"), "owner");
    fs.mkdirSync(path.dirname(paths.staging), { recursive: true }); fs.writeFileSync(paths.staging, "staging");
    fs.mkdirSync(path.dirname(paths.scene), { recursive: true }); fs.writeFileSync(paths.scene, "scene");
    await expect(generateSet("speaking", lifecycleDeps())).rejects.toMatchObject({ name: "SpeakingAudioOutputCollisionError", message: "speaking audio render output directory already exists or cannot be acquired" });
    expect(fs.readFileSync(path.join(paths.audio, "sentinel.txt"), "utf8")).toBe("owner");
    expect(fs.existsSync(paths.staging)).toBe(false); expect(fs.existsSync(paths.scene)).toBe(false);
    fs.rmSync(paths.audio, { recursive: true, force: true });
  });

  it("preserves a pre-existing audio target for importSet collisions too", async () => {
    const setId = "spk-import-c";
    vi.spyOn(crypto, "randomUUID").mockReturnValue("import-collision-0000-0000-0000-000000000000");
    const paths = lifecyclePaths(setId); fs.mkdirSync(paths.audio, { recursive: true }); fs.writeFileSync(path.join(paths.audio, "sentinel.txt"), "owner");
    fs.mkdirSync(path.dirname(paths.staging), { recursive: true }); fs.writeFileSync(paths.staging, "staging");
    fs.mkdirSync(path.dirname(paths.scene), { recursive: true }); fs.writeFileSync(paths.scene, "scene");
    await expect(importSet("speaking", "source", lifecycleDeps())).rejects.toMatchObject({ name: "SpeakingAudioOutputCollisionError", message: "speaking audio render output directory already exists or cannot be acquired" });
    expect(fs.readFileSync(path.join(paths.audio, "sentinel.txt"), "utf8")).toBe("owner");
    expect(fs.existsSync(paths.staging)).toBe(false); expect(fs.existsSync(paths.scene)).toBe(false);
    fs.rmSync(paths.audio, { recursive: true, force: true });
  });

  it("generateSet removes staging JSON, rendered audio, and the canonical scene when final rename fails", async () => {
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("simulated final rename failure");
    });

    await expect(
      generateSet("speaking", lifecycleDeps(), trackLifecycleSetId),
    ).rejects.toThrow("simulated final rename failure");

    expect(rename).toHaveBeenCalledTimes(1);
    expect(lifecycleSetIds.size).toBe(1);
    const [setId] = lifecycleSetIds;
    const paths = lifecyclePaths(setId);
    expect(fs.existsSync(paths.final)).toBe(false);
    expect(fs.existsSync(paths.staging)).toBe(false);
    expect(fs.existsSync(paths.audio)).toBe(false);
    expect(fs.existsSync(paths.scene)).toBe(false);
  });

  it("importSet removes rendered audio and the canonical scene when final schema validation fails", async () => {
    await expect(
      importSet("speaking", "source material", lifecycleDeps("untrusted-model"), trackLifecycleSetId),
    ).rejects.toThrow();

    expect(lifecycleSetIds.size).toBe(1);
    const [setId] = lifecycleSetIds;
    const paths = lifecyclePaths(setId);
    expect(fs.existsSync(paths.final)).toBe(false);
    expect(fs.existsSync(paths.staging)).toBe(false);
    expect(fs.existsSync(paths.audio)).toBe(false);
    expect(fs.existsSync(paths.scene)).toBe(false);
  });

  it("importSet preserves a staging directory collision, propagates its original validation error, and cleans later artifacts", async () => {
    let collisionPath = "";
    const onProgress = (progress: GenerationProgress) => {
      trackLifecycleSetId(progress);
      if (progress.stage !== "saving" || !progress.detail?.setId) return;
      collisionPath = lifecyclePaths(progress.detail.setId).staging;
      fs.mkdirSync(collisionPath, { recursive: true });
      fs.writeFileSync(path.join(collisionPath, "owner.txt"), "unrelated collision");
    };

    await expect(
      importSet("speaking", "source material", lifecycleDeps("untrusted-model"), onProgress),
    ).rejects.toThrow(/gpt-image-2|model/i);

    expect(collisionPath).not.toBe("");
    expect(fs.lstatSync(collisionPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(collisionPath, "owner.txt"), "utf8")).toBe("unrelated collision");
    const [setId] = lifecycleSetIds;
    const paths = lifecyclePaths(setId);
    expect(fs.existsSync(paths.audio)).toBe(false);
    expect(fs.existsSync(paths.scene)).toBe(false);
    expect(fs.existsSync(paths.final)).toBe(false);
  });

  it("importSet removes all attempt artifacts when the staging JSON write fails", async () => {
    const writeFile = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation(((file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
      if (String(file).includes("question-sets/.staging/")) {
        throw new Error("simulated staging write failure");
      }
      return writeFile(file, data, options);
    }) as typeof fs.writeFileSync);

    await expect(
      importSet("speaking", "source material", lifecycleDeps(), trackLifecycleSetId),
    ).rejects.toThrow("simulated staging write failure");

    expect(lifecycleSetIds.size).toBe(1);
    const [setId] = lifecycleSetIds;
    const paths = lifecyclePaths(setId);
    expect(fs.existsSync(paths.final)).toBe(false);
    expect(fs.existsSync(paths.staging)).toBe(false);
    expect(fs.existsSync(paths.audio)).toBe(false);
    expect(fs.existsSync(paths.scene)).toBe(false);
  });

  it("keeps an unrelated directory collision at the final JSON path but removes all attempt artifacts", async () => {
    let collisionPath = "";
    const onProgress = (progress: GenerationProgress) => {
      trackLifecycleSetId(progress);
      if (progress.stage !== "saving" || !progress.detail?.setId) return;
      collisionPath = lifecyclePaths(progress.detail.setId).final;
      fs.mkdirSync(collisionPath, { recursive: true });
      fs.writeFileSync(path.join(collisionPath, "owner.txt"), "unrelated collision");
    };

    await expect(
      generateSet("speaking", lifecycleDeps(), onProgress),
    ).rejects.toThrow();

    expect(collisionPath).not.toBe("");
    expect(fs.lstatSync(collisionPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(collisionPath, "owner.txt"), "utf8")).toBe("unrelated collision");
    const [setId] = lifecycleSetIds;
    const paths = lifecyclePaths(setId);
    expect(fs.existsSync(paths.staging)).toBe(false);
    expect(fs.existsSync(paths.audio)).toBe(false);
    expect(fs.existsSync(paths.scene)).toBe(false);
  });
});

// The scene illustration. Every test here asserts on the published Set file, because what matters
// about this phase is what a Set ends up carrying and, above all, that the Set is published at all
// whatever the two paid calls do.
describe("generateSet (speaking) scene illustration", () => {
  async function runSpeaking(scene: Deps, routedSet = validSpeakingSet("ignored")) {
    const fakeRun = vi.fn().mockResolvedValueOnce({
      ok: true,
      value: routedSet,
      provider: "claude",
      attempts: [],
    });
    const fakeTts = calibratedTts();
    const { setId } = await generateSet("speaking", { runSkillTask: fakeRun as never, tts: fakeTts, ...scene });
    const file = path.join(config.dataDir, "question-sets/speaking", `${setId}.json`);
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.rmSync(file);
    return { setId, written };
  }

  it("attaches the image and one focusRegion per item, calling the vision pass with the real file path and the seven sentences", async () => {
    const scene = sceneDeps();
    const { setId, written } = await runSpeaking(scene);

    expect(written.listenAndRepeat.image).toEqual(stubImage);
    expect(written.listenAndRepeat.items.map((i: { focusRegion?: unknown }) => i.focusRegion))
      .toEqual(Array.from({ length: 7 }, () => stubRegion));

    // The prompt is composed from the Set's own Listen and Repeat block, and the vision call gets the
    // image as a filesystem path (image.file is dataDir-relative, since it is also the URL path).
    // Neither call is handed a signal here: this run has no job to cancel.
    expect(scene.sceneImage).toHaveBeenCalledWith(setId, expect.objectContaining({ scenarioTitle: "t" }), {});
    expect(scene.focusRegions).toHaveBeenCalledWith(
      path.join(config.dataDir, stubImage.file),
      ["S1.", "S2.", "S3.", "S4.", "S5.", "S6.", "S7."],
      {},
    );
  });

  it("leaves an item with a null region alone rather than inventing one (partial coverage is authentic)", async () => {
    const regions = Array.from({ length: 7 }, (_, i) => (i === 2 || i === 5 ? null : stubRegion));
    const { written } = await runSpeaking(sceneDeps({ focusRegions: vi.fn().mockResolvedValue(regions) as never }));

    expect(written.listenAndRepeat.items[2]).not.toHaveProperty("focusRegion");
    expect(written.listenAndRepeat.items[5]).not.toHaveProperty("focusRegion");
    expect(written.listenAndRepeat.items.filter((i: { focusRegion?: unknown }) => i.focusRegion)).toHaveLength(5);
  });

  it("still publishes the set when the image call fails, and never calls the vision pass with an image that was never written", async () => {
    // The point of the phase's error handling: thirteen TTS renders are already paid for, and a Set
    // with audio and no picture is fully practisable, so losing it to a 500 would be far worse.
    const scene = sceneDeps({
      sceneImage: vi.fn().mockRejectedValue(new SceneImageError(500, "upstream on fire")) as never,
    });
    const { written } = await runSpeaking(scene, speakingSetWithUntrustedScene("ignored"));

    expect(written.listenAndRepeat.image).toBeUndefined();
    expect(written.listenAndRepeat.items.every((i: { focusRegion?: unknown }) => !i.focusRegion)).toBe(true);
    expect(written.listenAndRepeat.items[0].audio).toMatch(/^stimuli\//); // the audio survived intact
    // locateFocusRegions would throw "unreadable-image" here, so it must not be reached at all.
    expect(scene.focusRegions).not.toHaveBeenCalled();
  });

  it("publishes WITH the image and without regions when the vision pass fails (the picture alone is still useful)", async () => {
    // JudgeError, not SceneImageError: the vision path reuses the Judges' retry helper, so catching
    // only SceneImageError would swallow nothing and let this kill the job.
    const scene = sceneDeps({
      focusRegions: vi.fn().mockRejectedValue(new JudgeError("gemini-vision", "invalid-json", "…")) as never,
    });
    const { written } = await runSpeaking(scene, speakingSetWithUntrustedScene("ignored"));

    expect(written.listenAndRepeat.image).toEqual(stubImage);
    expect(written.listenAndRepeat.items.every((i: { focusRegion?: unknown }) => !i.focusRegion)).toBe(true);
  });

  it("survives a failure that is neither SceneImageError nor JudgeError (the handler is a catch-all)", async () => {
    const { written } = await runSpeaking(
      sceneDeps({ sceneImage: vi.fn().mockRejectedValue(new TypeError("fetch failed")) as never })
    );
    expect(written.listenAndRepeat.image).toBeUndefined();
  });

  it("the VISION handler is a catch-all too, not just the image one", async () => {
    // A catch narrowed to `instanceof JudgeError` would still pass the test above, which throws only
    // a JudgeError. SceneImageError is the realistic escapee (locateFocusRegions throws it when the
    // image file is unreadable), and letting it out costs the whole Set, including thirteen TTS
    // renders already paid for.
    const scene = sceneDeps({
      focusRegions: vi.fn().mockRejectedValue(new SceneImageError("unreadable-image", "gone")) as never,
    });
    const { written } = await runSpeaking(scene);

    expect(written.listenAndRepeat.image).toEqual(stubImage);
    expect(written.listenAndRepeat.items.every((i: { focusRegion?: unknown }) => !i.focusRegion)).toBe(true);
  });
});

// generateSet's onProgress seam. fakeRun below simulates reasoning-router provider events rather
// than exercising real CLIs, so these tests isolate the generator's progress translation.
describe("generateSet onProgress", () => {
  it("writing: fires generating -> verifying -> saving in order, with setId attached from verifying onward (not on the very first 'generating' event, before setId is minted)", async () => {
    const events: GenerationProgress[] = [];
    const fakeRun = vi.fn()
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        request.onEvent?.({ state: "running", provider: "claude" });
        return { ok: true, value: validWritingSet("ignored"), provider: "claude", attempts: [] };
      })
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        request.onEvent?.({ state: "running", provider: "claude" });
        return {
          ok: true,
          value: { items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok" })) },
          provider: "claude",
          attempts: [],
        };
      });
    const { setId } = await generateSet("writing", { runSkillTask: fakeRun as never }, (p) => events.push(p));

    expect(events.map((e) => e.stage)).toEqual(["generating", "verifying", "saving"]);
    expect(events[0].detail?.setId).toBeUndefined(); // setId not minted yet at this checkpoint
    expect(events[1].detail?.setId).toBe(setId);
    expect(events[2]).toEqual({ stage: "saving", detail: { setId } });

    fs.rmSync(path.join(config.dataDir, "question-sets/writing", `${setId}.json`));
  });

  it("writing: a provider call queued behind another reports provider plus queuePosition and legacy position before its real stage", async () => {
    const events: GenerationProgress[] = [];
    const fakeRun = vi.fn()
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        request.onEvent?.({ state: "queued", provider: "claude", queuePosition: 2 });
        request.onEvent?.({ state: "running", provider: "claude" });
        return { ok: true, value: validWritingSet("ignored"), provider: "claude", attempts: [] };
      })
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        request.onEvent?.({ state: "running", provider: "codex", fallbackFrom: "claude" });
        return {
          ok: true,
          value: { items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok" })) },
          provider: "codex",
          attempts: [{ provider: "claude", kind: "quota" }],
        };
      });
    const { setId } = await generateSet("writing", { runSkillTask: fakeRun as never }, (p) => events.push(p));

    expect(events.map((e) => e.stage)).toEqual(["queued", "generating", "verifying", "saving"]);
    expect(events[0].detail).toEqual({
      provider: "claude",
      queuePosition: 2,
      position: 2,
      generationAttempt: 1,
      maxDiversityAttempts: 3,
    });
    expect(events[2].detail).toEqual({ provider: "codex", fallbackFrom: "claude", setId });

    fs.rmSync(path.join(config.dataDir, "question-sets/writing", `${setId}.json`));
  });

  it("speaking: delegates all thirteen ordered profiled clips to the calibrated renderer", async () => {
    const fakeRun = vi.fn().mockResolvedValueOnce(skillSuccess(validSpeakingSet("ignored")));
    const audio = calibratedAudioDeps();
    const { setId } = await generateSet("speaking", { runSkillTask: fakeRun as never, ...audio, ...sceneDeps() });
    const outputDir = path.join(config.dataDir, "audio/stimuli", setId);
    const saved = JSON.parse(fs.readFileSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`), "utf8"));

    expect((audio.tts as ReturnType<typeof vi.fn>).mock.calls.map((call) => path.basename(call[1]).replace(/^\.(.+)\.tmp$/, "$1"))).toEqual([
      "briefing.mp3", "lr1.mp3", "lr2.mp3", "lr3.mp3", "lr4.mp3", "lr5.mp3", "lr6.mp3", "lr7.mp3",
      "int-intro.mp3", "iq1.mp3", "iq2.mp3", "iq3.mp3", "iq4.mp3",
    ]);
    expect(saved.listenAndRepeat.introAudio).toBe(`stimuli/${setId}/briefing.mp3`);
    expect(saved.audioProfile).toEqual(profileForSetId(setId));
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, "audio-manifest.json"), "utf8"))).toMatchObject({ baseClipCount: 13 });
    fs.rmSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`));
    fs.rmSync(outputDir, { recursive: true, force: true });
  });

  it("speaking: reports generating, then rendering-audio {done:0} carrying the setId before any clip renders (so an interrupted job names the directory cleanup removes), then 13 increasing checkpoints, one per finished clip in Item order, then saving", async () => {
    const events: GenerationProgress[] = [];
    const fakeRun = vi.fn().mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
      request.onEvent?.({ state: "running", provider: "claude" });
      return { ok: true, value: validSpeakingSet("ignored"), provider: "claude", attempts: [] };
    });
    const fakeTts = calibratedTts();
    const { setId } = await generateSet("speaking", { runSkillTask: fakeRun as never, tts: fakeTts, ...sceneDeps() }, (p) => events.push(p));

    expect(events[0].stage).toBe("generating");
    const audioEvents = events.filter((e) => e.stage === "rendering-audio");
    // 14 total: the leading {done:0} announce, then the 13 base-clip completions.
    expect(audioEvents).toHaveLength(14);
    expect(audioEvents[0]).toEqual({ stage: "rendering-audio", detail: { done: 0, total: 13, setId } });
    expect(audioEvents.slice(1).map((e) => e.detail?.done)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    // The {done:0} announce is the second event overall (right after "generating") and comes before
    // fakeTts is ever called, so setId reaches the job row before the stimuli directory exists and
    // an interrupted job can always name the directory orphan cleanup must remove.
    expect(events[1]).toBe(audioEvents[0]);
    expect(audioEvents.every((e) => e.detail?.total === 13)).toBe(true);
    expect(audioEvents.every((e) => e.detail?.setId === setId)).toBe(true);
    expect(events.at(-1)).toEqual({
      stage: "saving",
      detail: {
        setId,
        scene: { image: "succeeded", regions: "succeeded" },
      },
    });

    fs.rmSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`));
  });

  it("speaking: the two scene checkpoints fire in order between the audio and saving, both carrying setId", async () => {
    const events: GenerationProgress[] = [];
    const fakeRun = vi.fn().mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
      request.onEvent?.({ state: "running", provider: "claude" });
      return { ok: true, value: validSpeakingSet("ignored"), provider: "claude", attempts: [] };
    });
    const { setId } = await generateSet(
      "speaking",
      { runSkillTask: fakeRun as never, tts: calibratedTts(), ...sceneDeps() },
      (p) => events.push(p)
    );

    const stages = events.map((e) => e.stage);
    const tail = events.slice(stages.lastIndexOf("rendering-audio") + 1);
    expect(tail).toEqual([
      { stage: "rendering-image", detail: { setId } },
      { stage: "locating-regions", detail: { setId } },
      {
        stage: "saving",
        detail: {
          setId,
          scene: { image: "succeeded", regions: "succeeded" },
        },
      },
    ]);

    fs.rmSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`));
  });

  it("speaking: a failed image skips the locating-regions checkpoint entirely and still reaches saving", async () => {
    const events: GenerationProgress[] = [];
    const fakeRun = vi.fn().mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
      request.onEvent?.({ state: "running", provider: "claude" });
      return { ok: true, value: validSpeakingSet("ignored"), provider: "claude", attempts: [] };
    });
    const { setId } = await generateSet(
      "speaking",
      {
        runSkillTask: fakeRun as never,
        tts: calibratedTts(),
        ...sceneDeps({ sceneImage: vi.fn().mockRejectedValue(new SceneImageError(500, "boom")) as never }),
      },
      (p) => events.push(p)
    );

    expect(events.map((e) => e.stage)).toContain("rendering-image");
    expect(events.map((e) => e.stage)).not.toContain("locating-regions");
    expect(events.at(-1)).toEqual({
      stage: "saving",
      detail: {
        setId,
        scene: { image: "failed", regions: "skipped" },
      },
    });

    fs.rmSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`));
  });

  it("speaking: a failed vision pass reports image success and regions failure at saving", async () => {
    const events: GenerationProgress[] = [];
    const fakeRun = vi.fn().mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
      request.onEvent?.({ state: "running", provider: "claude" });
      return { ok: true, value: validSpeakingSet("ignored"), provider: "claude", attempts: [] };
    });
    const { setId } = await generateSet(
      "speaking",
      {
        runSkillTask: fakeRun as never,
        tts: calibratedTts(),
        ...sceneDeps({
          focusRegions: vi.fn().mockRejectedValue(new JudgeError("gemini-vision", "invalid-json", "boom")) as never,
        }),
      },
      (p) => events.push(p),
    );

    expect(events.map((e) => e.stage)).toContain("locating-regions");
    expect(events.at(-1)).toEqual({
      stage: "saving",
      detail: {
        setId,
        scene: { image: "succeeded", regions: "failed" },
      },
    });

    fs.rmSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`));
  });
});

describe("shared generation reasoning progress", () => {
  it.each([
    ["planning", { planningAttempt: 2 as const }],
    ["generating", { generationAttempt: 3 as const }],
    ["verifying", {}],
  ] as const)(
    "translates queued, fallback, and running events for %s",
    async (stage, attempts) => {
      const events: GenerationProgress[] = [];
      const run = vi.fn(async (request: SkillTaskRequest<unknown>) => {
        request.onEvent?.({
          state: "queued",
          provider: "claude",
          queuePosition: 4,
        });
        request.onEvent?.({
          state: "fallback",
          provider: "codex",
          fallbackFrom: "claude",
          failureKind: "quota",
        });
        request.onEvent?.({
          state: "running",
          provider: "codex",
          fallbackFrom: "claude",
        });
        return skillSuccess(request.parse({ accepted: true }), "codex");
      });

      const result = await callGenerationSkillTask({
        run: run as never,
        task: { task: "plan", context: "speaking" },
        prompt: "bounded prompt",
        jsonSchema: { type: "object" },
        parse: (value) => value as { accepted: boolean },
        stage,
        onProgress: (progress) => events.push(progress),
        setId: "spk-progress",
        ...attempts,
      });

      expect(result.ok).toBe(true);
      const attemptDetail = Object.keys(attempts).length > 0
        ? { ...attempts, maxDiversityAttempts: 3 }
        : {};
      expect(events).toEqual([
        {
          stage: "queued",
          detail: {
            provider: "claude",
            queuePosition: 4,
            position: 4,
            setId: "spk-progress",
            ...attemptDetail,
          },
        },
        {
          stage,
          detail: {
            provider: "codex",
            fallbackFrom: "claude",
            setId: "spk-progress",
            ...attemptDetail,
          },
        },
      ]);
      expect(JSON.stringify(events)).not.toContain("bounded prompt");
      expect(JSON.stringify(events)).not.toContain("accepted");
    },
  );
});

// Where the batch's finalization gate sits, from the Speaking side. generator.reading.test.ts pins
// that VERIFY is outside it; Reading has no renders and no TTS, so only this file can pin the
// renders.
//
// The gate serializes only the publish. What bounds the renders is ttsQueue.ts, process-wide under
// TTS_CONCURRENCY. Both halves are pinned below: the renders overlap when the queue allows it, they
// do not when it does not, and the publish is one at a time either way.
describe("the batch finalization gate, and what bounds the renders", () => {
  afterEach(() => setTtsConcurrencyForTests());

  /** The same admission chain runGenerationBatch builds for a batch's children. */
  function admissionChain() {
    let tail = Promise.resolve();
    return async <T>(run: () => Promise<T>): Promise<T> => {
      const admitted = tail.then(run, run);
      tail = admitted.then(() => undefined, () => undefined);
      return admitted;
    };
  }

  /**
   * A TTS stub shared by two children: it records which child called it and meters how many
   * syntheses are in flight at once across both. In-flight count is the property under test, not
   * call order: the queue admits FIFO, so a child that reaches its render first submits all thirteen
   * of its clips before the other submits any. That ordering is harmless, since the bound stays
   * saturated either way, which is where the wall-clock saving comes from.
   */
  function sharedTts(order: string[]) {
    let inFlight = 0;
    let peak = 0;
    const forChild = (label: string) =>
      vi.fn(async (_request: unknown, outPath: string) => {
        order.push(label);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Yields the event loop. Without this the stub resolves synchronously and nothing could ever
        // be observed in flight beside it, so the test could not fail.
        await new Promise((resolve) => setTimeout(resolve, 2));
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, "stub-audio");
        inFlight -= 1;
      });
    return { forChild, peak: () => peak };
  }

  const transitions = (order: string[]): number =>
    order.filter((label, i) => i > 0 && label !== order[i - 1]).length;

  it("does not serialize the renders: the queue's whole bound is in flight at once", async () => {
    setTtsConcurrencyForTests(4);
    const finalizationAdmission = admissionChain();
    const order: string[] = [];
    const tts = sharedTts(order);

    await Promise.all([
      generateSet("speaking", { ...lifecycleDeps(), tts: tts.forChild("A") as never, finalizationAdmission }, trackLifecycleSetId),
      generateSet("speaking", { ...lifecycleDeps(), tts: tts.forChild("B") as never, finalizationAdmission }, trackLifecycleSetId),
    ]);

    expect(order).toHaveLength(26);
    // A peak of 4 is reachable only if the renders are serialized neither inside a child nor
    // between children.
    expect(tts.peak(), `TTS calls never overlapped: ${order.join("")}`).toBe(4);
  });

  it("hands that bound to the TTS queue: at a bound of 1 nothing overlaps at all", async () => {
    setTtsConcurrencyForTests(1);
    const finalizationAdmission = admissionChain();
    const order: string[] = [];
    const tts = sharedTts(order);

    await Promise.all([
      generateSet("speaking", { ...lifecycleDeps(), tts: tts.forChild("A") as never, finalizationAdmission }, trackLifecycleSetId),
      generateSet("speaking", { ...lifecycleDeps(), tts: tts.forChild("B") as never, finalizationAdmission }, trackLifecycleSetId),
    ]);

    expect(order).toHaveLength(26);
    // At TTS_CONCURRENCY's default of 1 the queue alone serializes the renders, so an operator who
    // never sets the variable gets one child's thirteen clips, then the other's, one at a time.
    expect(tts.peak()).toBe(1);
    expect(transitions(order), `TTS call order was interleaved: ${order.join("")}`).toBe(1);
  });

  it("still serializes the PUBLISH, and only the publish", async () => {
    setTtsConcurrencyForTests(4);
    const finalizationAdmission = admissionChain();
    const events: string[] = [];
    const order: string[] = [];
    const tts = sharedTts(order);

    let releaseA!: () => void;
    const aReleased = new Promise<void>((resolve) => { releaseA = resolve; });
    let announceAHolding!: () => void;
    const aHolding = new Promise<void>((resolve) => { announceAHolding = resolve; });
    let announceBRendered!: () => void;
    const bRendered = new Promise<void>((resolve) => { announceBRendered = resolve; });

    const bTts = tts.forChild("B");
    const bTtsCounting = vi.fn(async (request: unknown, outPath: string) => {
      await bTts(request, outPath);
      if (order.filter((label) => label === "B").length === 13) announceBRendered();
    });

    const first = generateSet("speaking", {
      ...lifecycleDeps(),
      tts: tts.forChild("A") as never,
      finalizationAdmission,
      commitPublication: async () => {
        events.push("A:publish-enter");
        announceAHolding();
        await aReleased;
        events.push("A:publish-exit");
        return true;
      },
    }, trackLifecycleSetId);

    // A is inside the gate, publishing, and will not leave until we say so.
    await aHolding;

    const second = generateSet("speaking", {
      ...lifecycleDeps(),
      tts: bTtsCounting as never,
      finalizationAdmission,
      commitPublication: async () => {
        events.push("B:publish-enter");
        return true;
      },
    }, trackLifecycleSetId);

    // B renders all thirteen of its clips while A is still holding the gate: the gate holds only the
    // publish.
    await Promise.race([
      bRendered,
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("B never finished rendering while A held the gate")), 30_000).unref?.();
      }),
    ]);
    expect(events).toEqual(["A:publish-enter"]);

    releaseA();
    await Promise.all([first, second]);

    // B's publish waited for A's to finish, which is what the gate is for.
    expect(events).toEqual(["A:publish-enter", "A:publish-exit", "B:publish-enter"]);
  });
});
