import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import * as shared from "@toefl-prep/shared";
import { config } from "../src/lib/config.js";
import {
  AnySetSchema,
  DeliveryReportSchema,
  EarsResultSchema,
  FocusRegionSchema,
  JudgeReportSchema,
  ScoreReportSchema,
  SpeakingAudioProfileSchema,
  SpeakingGenerationInputSchema,
  SpeakingSetSchema,
  stripAnswers,
} from "@toefl-prep/shared";
import type { WritingSet } from "@toefl-prep/shared";
import {
  speakingPlanFixture,
  speakingSetFixture,
  writingPlanFixture,
  writingSetFixture,
} from "./helpers/generationDiversityFixtures.js";

function diversitySchemas() {
  const candidates = shared as unknown as Record<string, z.ZodType>;
  expect(candidates.SpeakingGenerationPlanSchema).toBeDefined();
  expect(candidates.WritingGenerationPlanSchema).toBeDefined();
  expect(candidates.WritingGenerationInputSchema).toBeDefined();
  return candidates;
}

const audioProfile = {
  version: "ets-2026-v1",
  provider: "openai",
  model: "gpt-4o-mini-tts",
  listenAndRepeat: {
    accent: "british",
    voice: "marin",
    briefingTargetWpm: 165,
    itemTargetWpm: 180,
  },
  interview: {
    accent: "new-zealand",
    voice: "cedar",
    introTargetWpm: 165,
    questionTargetWpm: 155,
  },
};

const speakingSet = {
  id: "spk-001", kind: "speaking", source: "generated", createdAt: "2026-07-27T00:00:00Z",
  listenAndRepeat: {
    scenarioTitle: "At the campus bookstore",
    scenarioDescription: "You are helping a new student find course materials.",
    items: Array.from({ length: 7 }, (_, i) => ({
      id: `lr${i + 1}`, sentence: `Sentence number ${i + 1} for practice.`,
      audio: `stimuli/spk-001/lr${i + 1}.mp3`,
      responseWindowSec: i < 2 ? 8 : i < 5 ? 10 : 12,
    })),
  },
  interview: {
    scenarioTitle: "Campus research study", intro: "Thanks for joining us today.",
    introAudio: "stimuli/spk-001/int-intro.mp3",
    questions: Array.from({ length: 4 }, (_, i) => ({
      id: `iq${i + 1}`, type: i < 2 ? "factual" : "opinion",
      question: `Question ${i + 1}?`, audio: `stimuli/spk-001/iq${i + 1}.mp3`,
      responseWindowSec: 45,
    })),
  },
};

const writingSet: WritingSet = {
  id: "wri-001", kind: "writing", source: "generated", createdAt: "2026-07-27T00:00:00Z",
  buildASentence: {
    items: Array.from({ length: 10 }, (_, i) => ({
      id: `bs${i + 1}`, prompt: `Prompt ${i + 1}?`,
      tiles: ["that", "sounds", "good", "to me"],
      answers: [["that", "sounds", "good", "to me"]],
    })),
  },
  email: {
    id: "em1", scenario: "You need to ask housing about move-in.",
    to: "housing@university.edu", subject: "Move-in question",
    bullets: ["ask about dates", "explain your situation", "request a reply"],
    timeLimitSec: 420, wordGuidance: { min: 80, max: 120 },
  },
  academicDiscussion: {
    id: "ad1", courseTitle: "Economics", professorName: "Dr. Diaz",
    professorPost: "Should cities subsidize public transit?",
    studentPosts: [
      { name: "Claire", post: "Yes, it reduces traffic." },
      { name: "Paul", post: "No, it costs too much." },
    ],
    timeLimitSec: 600, minWords: 100,
  },
};

describe("set schemas", () => {
  it("accepts legacy speaking sets without server-owned audio fields", () => {
    const parsed = SpeakingSetSchema.parse(speakingSet);
    expect(parsed.listenAndRepeat).not.toHaveProperty("introAudio");
    expect(parsed).not.toHaveProperty("audioProfile");
  });

  it("round-trips a full server-owned audio profile and the optional intro audio", () => {
    const enriched = {
      ...structuredClone(speakingSet),
      audioProfile,
      listenAndRepeat: {
        ...structuredClone(speakingSet.listenAndRepeat),
        introAudio: "stimuli/spk-001/lr-intro.mp3",
      },
    };

    expect(SpeakingSetSchema.parse(enriched)).toEqual(enriched);
  });

  it("strips and does not advertise server-owned audio fields in generation input", () => {
    const untrusted = {
      ...structuredClone(speakingSet),
      audioProfile,
      listenAndRepeat: {
        ...structuredClone(speakingSet.listenAndRepeat),
        introAudio: "untrusted-intro.mp3",
      },
    };

    const parsed = SpeakingGenerationInputSchema.parse(untrusted);
    expect(parsed).not.toHaveProperty("audioProfile");
    expect(parsed.listenAndRepeat).not.toHaveProperty("introAudio");

    const advertised = z.toJSONSchema(SpeakingGenerationInputSchema) as unknown as {
      properties: {
        listenAndRepeat: { properties: Record<string, unknown> };
      } & Record<string, unknown>;
    };
    expect(advertised.properties).not.toHaveProperty("audioProfile");
    expect(advertised.properties.listenAndRepeat.properties).not.toHaveProperty("introAudio");
  });

  it("accepts a valid writing set", () => {
    expect(AnySetSchema.parse(writingSet).kind).toBe("writing");
  });
  it("rejects a speaking set with 6 items", () => {
    const bad = structuredClone(speakingSet);
    bad.listenAndRepeat.items.pop();
    expect(() => AnySetSchema.parse(bad)).toThrow();
  });
  // An Item id becomes a filename (`<itemId>.webm` for a recording, `<itemId>.mp3` for a clip), and
  // the upload route checks only that the id belongs to the Set. The schema's id rule is what keeps a
  // crafted imported Set from naming a path; it matches the renderer's own (ITEM_ID in
  // speakingAudioRenderer.ts).
  it("rejects set and item ids that could become a filesystem path", () => {
    for (const unsafe of ["../evil", "lr-1/../../etc/passwd", "lr 1", "lr-1.mp3", "", "a".repeat(65)]) {
      const badItem = structuredClone(speakingSet);
      badItem.listenAndRepeat.items[0].id = unsafe;
      expect(() => AnySetSchema.parse(badItem)).toThrow();

      const badSet = structuredClone(speakingSet);
      badSet.id = unsafe;
      expect(() => AnySetSchema.parse(badSet)).toThrow();

      const badQuestion = structuredClone(speakingSet);
      badQuestion.interview.questions[0].id = unsafe;
      expect(() => AnySetSchema.parse(badQuestion)).toThrow();

      const badWriting = structuredClone(writingSet);
      badWriting.buildASentence.items[0].id = unsafe;
      expect(() => AnySetSchema.parse(badWriting)).toThrow();
    }
    // The shapes the generator actually produces still parse.
    expect(SpeakingSetSchema.parse(speakingSet).listenAndRepeat.items[0].id).toBe(speakingSet.listenAndRepeat.items[0].id);
  });
  it("rejects an invalid responseWindowSec", () => {
    const bad = structuredClone(speakingSet);
    bad.listenAndRepeat.items[0].responseWindowSec = 9;
    expect(() => AnySetSchema.parse(bad)).toThrow();
  });
  it("stripAnswers removes buildASentence answers only, leaving a writing set otherwise untouched", () => {
    const stripped = stripAnswers(AnySetSchema.parse(writingSet));
    if (stripped.kind !== "writing") throw new Error("kind changed");
    expect(stripped.buildASentence.items[0]).not.toHaveProperty("answers");
    expect(stripped.email.bullets).toHaveLength(3);
    expect(stripped.academicDiscussion.professorPost).toBe(writingSet.academicDiscussion.professorPost);
    // original untouched
    expect(writingSet.buildASentence.items[0].answers).toHaveLength(1);
  });

  it("stripAnswers preserves public audio, scene, and focus metadata without leaking speaking prompts", () => {
    const enriched = {
      ...structuredClone(speakingSet),
      audioProfile,
      listenAndRepeat: {
        ...structuredClone(speakingSet.listenAndRepeat),
        introAudio: "stimuli/spk-001/lr-intro.mp3",
        image: {
          file: "images/scenarios/spk-001.webp",
          prompt: "KEY OBJECTS: Sentence number 1 for practice.",
          model: "gpt-image-2",
        },
        items: speakingSet.listenAndRepeat.items.map((item, i) => ({
          ...item,
          ...(i === 0 ? { focusRegion: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } } : {}),
        })),
      },
    };
    const parsed = AnySetSchema.parse(enriched);
    const stripped = stripAnswers(parsed);
    if (stripped.kind !== "speaking") throw new Error("kind changed");

    for (const item of stripped.listenAndRepeat.items) expect(item).not.toHaveProperty("sentence");
    for (const q of stripped.interview.questions) expect(q).not.toHaveProperty("question");
    expect(stripped.listenAndRepeat.image).not.toHaveProperty("prompt");

    // audioProfile is renderer provenance (TTS provider and model id), and no API response names a
    // provider, so GET /api/sets/:id drops it for Speaking as for Listening. No client code reads it.
    expect(stripped).not.toHaveProperty("audioProfile");
    expect(stripped.listenAndRepeat.introAudio).toBe(enriched.listenAndRepeat.introAudio);
    expect(stripped.listenAndRepeat.image).toEqual({
      file: enriched.listenAndRepeat.image.file,
      model: enriched.listenAndRepeat.image.model,
    });
    expect(stripped.listenAndRepeat.items[0].focusRegion).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
    expect(stripped.listenAndRepeat.scenarioTitle).toBe(speakingSet.listenAndRepeat.scenarioTitle);
    expect(stripped.listenAndRepeat.scenarioDescription).toBe(speakingSet.listenAndRepeat.scenarioDescription);
    expect(stripped.listenAndRepeat.items).toHaveLength(7);
    expect(stripped.listenAndRepeat.items[0]).toMatchObject({
      id: "lr1", audio: "stimuli/spk-001/lr1.mp3", responseWindowSec: 8,
    });

    expect(stripped.interview.scenarioTitle).toBe(speakingSet.interview.scenarioTitle);
    expect(stripped.interview.intro).toBe(speakingSet.interview.intro);
    expect(stripped.interview.introAudio).toBe(speakingSet.interview.introAudio);
    expect(stripped.interview.questions).toHaveLength(4);
    expect(stripped.interview.questions[0]).toMatchObject({
      id: "iq1", type: "factual", audio: "stimuli/spk-001/iq1.mp3", responseWindowSec: 45,
    });

    // original untouched
    expect(parsed.kind === "speaking" && parsed.listenAndRepeat.items[0].sentence).toBe(
      "Sentence number 1 for practice."
    );
  });

  it("accepts only the trusted scene image model in an at-rest speaking set", () => {
    const withTrustedModel = {
      ...structuredClone(speakingSet),
      listenAndRepeat: {
        ...structuredClone(speakingSet.listenAndRepeat),
        image: {
          file: "images/scenarios/spk-001.webp",
          prompt: "trusted server prompt",
          model: "gpt-image-2",
        },
      },
    };
    expect(SpeakingSetSchema.parse(withTrustedModel).listenAndRepeat.image?.model).toBe("gpt-image-2");

    const withAnswerBearingModel = structuredClone(withTrustedModel);
    withAnswerBearingModel.listenAndRepeat.image.model = "Sentence number 1 for practice.";
    expect(() => SpeakingSetSchema.parse(withAnswerBearingModel)).toThrow();
  });

  it("accepts optional server-owned generation plans on persisted speaking and writing sets", () => {
    const schemas = diversitySchemas();
    const speaking = AnySetSchema.parse({
      ...speakingSetFixture(),
      generationPlan: speakingPlanFixture(),
    });
    const writing = AnySetSchema.parse({
      ...writingSetFixture(),
      generationPlan: writingPlanFixture(),
    });

    expect(speaking).toHaveProperty("generationPlan.kind", "speaking");
    expect(writing).toHaveProperty("generationPlan.kind", "writing");
    expect(schemas.SpeakingGenerationPlanSchema.parse(speakingPlanFixture()))
      .toEqual(speakingPlanFixture());
    expect(schemas.WritingGenerationPlanSchema.parse(writingPlanFixture()))
      .toEqual(writingPlanFixture());
  });

  it("caps a required concept at a short noun phrase, and advertises the cap in the JSON Schema", () => {
    const schemas = diversitySchemas();
    // A concept a planner did write: an instruction about the answer rather than the content itself
    // (the planner prompt lists it as a bad example), and longer than the cap.
    const directive =
      "A stated preference between cheaper fares and more frequent service, with a reason";
    const plan = speakingPlanFixture();
    plan.interview.requiredConcepts = [directive, "weekend trip"];

    expect(() => schemas.SpeakingGenerationPlanSchema.parse(plan)).toThrow();
    // A concrete noun phrase saying the same thing still passes.
    plan.interview.requiredConcepts = ["cheaper fares versus frequent service", "weekend trip"];
    expect(() => schemas.SpeakingGenerationPlanSchema.parse(plan)).not.toThrow();

    // The cap must reach the model, which sees only the JSON Schema: a zod refinement would be
    // dropped by z.toJSONSchema, and the planner would keep writing concepts the parse rejects.
    const json = JSON.stringify(z.toJSONSchema(schemas.SpeakingGenerationPlanSchema));
    expect(json).toContain(`"maxLength":${shared.REQUIRED_CONCEPT_MAX_CHARS}`);
  });

  it("does not advertise or retain generationPlan in model-facing input schemas", () => {
    const schemas = diversitySchemas();
    const speakingJson = z.toJSONSchema(
      shared.SpeakingGenerationInputSchema,
    ) as { properties?: Record<string, unknown> };
    const writingJson = z.toJSONSchema(
      schemas.WritingGenerationInputSchema,
    ) as { properties?: Record<string, unknown> };

    expect(speakingJson.properties).not.toHaveProperty("generationPlan");
    expect(writingJson.properties).not.toHaveProperty("generationPlan");
    expect(shared.SpeakingGenerationInputSchema.parse({
      ...speakingSetFixture(),
      generationPlan: speakingPlanFixture(),
    })).not.toHaveProperty("generationPlan");
    // The fixture is a persisted Set and carries no `frame`. The model-facing schema requires the key
    // (required-and-nullable is the only optional shape the strict routed schemas allow) and `null`
    // says an Item has none, so it is supplied here to keep the parse about generationPlan alone.
    const generationInput = writingSetFixture();
    expect(schemas.WritingGenerationInputSchema.parse({
      ...generationInput,
      buildASentence: {
        items: generationInput.buildASentence.items.map((item) => ({ ...item, frame: null })),
      },
      generationPlan: writingPlanFixture(),
    })).not.toHaveProperty("generationPlan");
  });

  it("stripAnswers removes generationPlan for both kinds", () => {
    const speaking = AnySetSchema.parse({
      ...speakingSetFixture(),
      generationPlan: speakingPlanFixture(),
    });
    const writing = AnySetSchema.parse({
      ...writingSetFixture(),
      generationPlan: writingPlanFixture(),
    });

    expect(speaking).toHaveProperty("generationPlan");
    expect(writing).toHaveProperty("generationPlan");
    expect(stripAnswers(speaking)).not.toHaveProperty("generationPlan");
    expect(stripAnswers(writing)).not.toHaveProperty("generationPlan");
  });

  it.each([
    {
      label: "control character",
      mutate: (plan: ReturnType<typeof speakingPlanFixture>) => {
        plan.listenAndRepeat.setting = "studio\u0000room";
      },
    },
    {
      label: "C1 control character",
      mutate: (plan: ReturnType<typeof speakingPlanFixture>) => {
        plan.listenAndRepeat.setting = "studio\u0085room";
      },
    },
    {
      label: "blank text",
      mutate: (plan: ReturnType<typeof speakingPlanFixture>) => {
        plan.listenAndRepeat.setting = "   ";
      },
    },
    {
      label: "overlong novelty key",
      mutate: (plan: ReturnType<typeof speakingPlanFixture>) => {
        plan.listenAndRepeat.noveltyKey = `a${"-long".repeat(20)}`;
      },
    },
    {
      label: "too few required concepts",
      mutate: (plan: ReturnType<typeof speakingPlanFixture>) => {
        plan.listenAndRepeat.requiredConcepts = ["kiln"];
      },
    },
    {
      label: "too many required concepts",
      mutate: (plan: ReturnType<typeof speakingPlanFixture>) => {
        plan.listenAndRepeat.requiredConcepts = ["a", "b", "c", "d", "e", "f"];
      },
    },
    {
      label: "too many distinctions",
      mutate: (plan: ReturnType<typeof speakingPlanFixture>) => {
        plan.listenAndRepeat.distinguishesFrom = Array.from(
          { length: 4 },
          (_, index) => ({
            setId: `spk-prior-${index}`,
            reason: "different purpose",
          }),
        );
      },
    },
    {
      label: "invalid distinction id",
      mutate: (plan: ReturnType<typeof speakingPlanFixture>) => {
        plan.listenAndRepeat.distinguishesFrom = [{
          setId: "../private",
          reason: "different purpose",
        }];
      },
    },
  ])("rejects a speaking plan with $label", ({ mutate }) => {
    const schemas = diversitySchemas();
    const plan = structuredClone(speakingPlanFixture());
    mutate(plan);
    expect(() => schemas.SpeakingGenerationPlanSchema.parse(plan)).toThrow();
  });

  it("rejects wrong versions, kinds, arc lengths, and writing situation counts", () => {
    const schemas = diversitySchemas();
    const wrongVersion = {
      ...speakingPlanFixture(),
      version: "cross-set-diversity-v2",
    };
    const wrongKind = { ...speakingPlanFixture(), kind: "writing" };
    const shortArc = structuredClone(speakingPlanFixture());
    shortArc.interview.questionArc.pop();
    const shortWriting = structuredClone(writingPlanFixture());
    shortWriting.buildASentence.situations.pop();

    expect(() => schemas.SpeakingGenerationPlanSchema.parse(wrongVersion)).toThrow();
    expect(() => schemas.SpeakingGenerationPlanSchema.parse(wrongKind)).toThrow();
    expect(() => schemas.SpeakingGenerationPlanSchema.parse(shortArc)).toThrow();
    expect(() => schemas.WritingGenerationPlanSchema.parse(shortWriting)).toThrow();
  });
});

// A Set that fails AnySetSchema is skipped (and only reported, at GET /api/sets/unloadable), and
// every past Attempt against it loses its review, so a schema edit that narrows what a Build a
// Sentence Item may hold deletes practice history. This re-validates every committed Writing Set,
// read from this file's seeded copy of the bank (global-setup.ts seeds what git tracks, as the
// working tree holds it), so a Set generated locally and never committed cannot change the result.
describe("every banked Writing Set still parses", () => {
  const bank = path.join(config.dataDir, "question-sets/writing");
  const files = fs.readdirSync(bank).filter((name) => name.endsWith(".json"));

  it("finds Writing Sets to check at all", () => {
    // Without this the loop below passes vacuously if the bank moves or empties.
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("parses %s under AnySetSchema, unchanged", (file) => {
    const raw = fs.readFileSync(path.join(bank, file), "utf8");
    const parsed = AnySetSchema.safeParse(JSON.parse(raw));
    expect(parsed.success, `${file}: ${JSON.stringify(parsed.error?.issues ?? [])}`).toBe(true);
    if (!parsed.success) return;

    const set = parsed.data as WritingSet;
    expect(set.buildASentence.items).toHaveLength(10);
    for (const item of set.buildASentence.items) {
      // Sets are immutable: parsing must not quietly strip a key off one, which is what a narrowed
      // schema looks like from the outside.
      expect(item.tiles.length).toBeGreaterThan(0);
      expect(item.answers.length).toBeGreaterThan(0);
    }
  });
});

describe("focus region schema", () => {
  it.each([
    { x: 0.1, y: 0.2, w: 0, h: 0.3 },
    { x: 0.1, y: 0.2, w: 0.3, h: 0 },
  ])("rejects a zero-area region: %j", (region) => {
    expect(() => FocusRegionSchema.parse(region)).toThrow();
  });

  it.each([
    { x: 0.8, y: 0.2, w: 0.3, h: 0.3 },
    { x: 0.1, y: 0.8, w: 0.3, h: 0.3 },
    { x: 0.5, y: 0.2, w: 0.5000000000000002, h: 0.3 },
  ])("rejects a region that overflows an image edge: %j", (region) => {
    expect(() => FocusRegionSchema.parse(region)).toThrow();
  });

  it("accepts a positive region flush with the right and bottom edges", () => {
    const region = { x: 0.7, y: 0.6, w: 0.3, h: 0.4 };
    expect(FocusRegionSchema.parse(region)).toEqual(region);
  });
});

describe("judge report schema", () => {
  it("round-trips a judge report", () => {
    const report = {
      judge: "gemini", taskType: "email",
      items: [{
        itemId: "em1", score: 3.5,
        dimensions: [{ name: "elaboration", score: 4, evidence: "covers all bullets" }],
        deductions: [{ quote: "I want ask", issue: "missing 'to'", fix: "I want to ask", category: "grammar" }],
      }],
    };
    expect(JudgeReportSchema.parse(report).items[0].score).toBe(3.5);
  });
});

describe("score report schema", () => {
  it("round-trips self-arbitration on an email item", () => {
    const report = {
      taskType: "email",
      items: [{
        itemId: "em1",
        ownScore: 4,
        finalScore: 3.5,
        maxScore: 5,
        dimensions: [{ name: "elaboration", note: "covers all requested points" }],
        deductions: [],
        reconciliationNote: "The judges differed slightly on elaboration.",
        feedbackZh: "內容完整，細節可以再具體一些。",
        modelRewrite: "Dear Housing Office, ...",
        selfArbitrated: true,
      }],
    };

    expect(ScoreReportSchema.parse(report).items[0].selfArbitrated).toBe(true);
  });
});

import { ScoreRequestSchema } from "@toefl-prep/shared";

describe("score request schema", () => {
  it("accepts a build_sentence batch and an essay single", () => {
    expect(ScoreRequestSchema.parse({ taskType: "build_sentence", items: [{ itemId: "bs1", tileOrder: ["a", "b", "c"] }] }).taskType).toBe("build_sentence");
    expect(ScoreRequestSchema.parse({ taskType: "email", items: [{ itemId: "em1", text: "Dear…", secondsUsed: 300 }] }).items).toHaveLength(1);
  });
  it("rejects an essay batch of 2 and unknown taskType", () => {
    expect(() => ScoreRequestSchema.parse({ taskType: "email", items: [{ itemId: "a", text: "x", secondsUsed: 1 }, { itemId: "b", text: "y", secondsUsed: 1 }] })).toThrow();
    expect(() => ScoreRequestSchema.parse({ taskType: "nope", items: [] })).toThrow();
  });
});

describe("speaking ramp", () => {
  it("rejects a set whose windows are not 8/8/10/10/10/12/12", () => {
    const bad = structuredClone(speakingSet); // the existing valid fixture in this file
    bad.listenAndRepeat.items[0].responseWindowSec = 12;
    bad.listenAndRepeat.items[6].responseWindowSec = 8;
    expect(() => SpeakingSetSchema.parse(bad)).toThrow(/ramp/);
  });
});

describe("score request schema: speaking arms", () => {
  it("accepts a listen_repeat batch of 7 item ids", () => {
    const items = Array.from({ length: 7 }, (_, i) => ({ itemId: `lr${i + 1}` }));
    const parsed = ScoreRequestSchema.parse({ taskType: "listen_repeat", items });
    expect(parsed.taskType).toBe("listen_repeat");
    expect(parsed.items).toHaveLength(7);
  });
  it("rejects a listen_repeat batch of 8 item ids", () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ itemId: `lr${i + 1}` }));
    expect(() => ScoreRequestSchema.parse({ taskType: "listen_repeat", items })).toThrow();
  });
  it("accepts an interview batch of 4 item ids and rejects 5", () => {
    const items = Array.from({ length: 4 }, (_, i) => ({ itemId: `iq${i + 1}` }));
    expect(ScoreRequestSchema.parse({ taskType: "interview", items }).items).toHaveLength(4);
    const tooMany = Array.from({ length: 5 }, (_, i) => ({ itemId: `iq${i + 1}` }));
    expect(() => ScoreRequestSchema.parse({ taskType: "interview", items: tooMany })).toThrow();
  });
  it("rejects an empty listen_repeat batch", () => {
    expect(() => ScoreRequestSchema.parse({ taskType: "listen_repeat", items: [] })).toThrow();
  });
});

import { SpeakingWritingTaskType, ReadingTaskType, ListeningTaskType, AnyTaskType, ModulePath, isDeterministicTaskType } from "@toefl-prep/shared";

describe("task type enums", () => {
  it("keeps the five speaking/writing values under the new name", () => {
    expect(SpeakingWritingTaskType.options).toEqual(["listen_repeat", "interview", "build_sentence", "email", "discussion"]);
  });
  it("spans all twelve in AnyTaskType", () => {
    expect(AnyTaskType.options).toHaveLength(12);
    expect(AnyTaskType.options).toEqual(expect.arrayContaining([...ReadingTaskType.options, ...ListeningTaskType.options, ...SpeakingWritingTaskType.options]));
  });
  it("classifies deterministic task types", () => {
    expect(isDeterministicTaskType("build_sentence")).toBe(true);
    expect(isDeterministicTaskType("complete_words")).toBe(true);
    expect(isDeterministicTaskType("email")).toBe(false);
  });
  it("ModulePath is lower|upper", () => {
    expect(ModulePath.options).toEqual(["lower", "upper"]);
  });
  it("AnyTaskType is the 12-literal union at compile time, not string", () => {
    // type-level guard: AnyTaskType must stay the 12-literal union, not string
    const anyTaskTypeAccepts: AnyTaskType = "complete_words";
    // @ts-expect-error arbitrary strings must not be assignable to AnyTaskType
    const anyTaskTypeRejects: AnyTaskType = "not_a_task_type";
    void anyTaskTypeAccepts;
    void anyTaskTypeRejects;
  });
});

describe("delivery report / ears result schema", () => {
  it("round-trips a delivery report", () => {
    const report = {
      paceWpm: 142.5,
      pauses: "one long pause before the final clause",
      intelligibility: "clear throughout",
      suspectedMispronunciations: ["fantastic"],
      intonation: "flat, little pitch variation",
    };
    expect(DeliveryReportSchema.parse(report)).toEqual(report);
  });
  it("allows paceWpm to be null", () => {
    const report = {
      paceWpm: null,
      pauses: "n/a", intelligibility: "n/a",
      suspectedMispronunciations: [], intonation: "n/a",
    };
    expect(DeliveryReportSchema.parse(report).paceWpm).toBeNull();
  });
  it("round-trips an ears result (transcript + delivery report)", () => {
    const result = {
      transcript: "the, um, bakery sells fresh bread",
      deliveryReport: {
        paceWpm: 130, pauses: "brief hesitation after 'um'",
        intelligibility: "mostly clear", suspectedMispronunciations: [],
        intonation: "natural",
      },
    };
    expect(EarsResultSchema.parse(result)).toEqual(result);
  });
});

// The Speaking audio profile is a discriminated union on `version`, one member per pace or accent
// policy, because a Set file that fails AnySetSchema is skipped: it leaves the practice-set picker
// and its Attempts lose their review. Changing a version's literals in place would do that to every
// banked Set recording it, so each version keeps every literal it has and a policy change arrives as
// a new member. v1 is the OpenAI renderer's; v2 and v3 share a shape, v3's version string changing
// the accent draw; v4 replaces the flat item target with a per-item ramp; v5 and v6 retune it.
describe("SpeakingAudioProfileSchema (v1 / v2 / v3 / v4 discriminated union)", () => {
  const v2 = {
    version: "ets-2026-v2",
    provider: "gemini",
    model: "gemini-3.1-flash-tts-preview",
    listenAndRepeat: { accent: "british", voice: "Gacrux", briefingTargetWpm: 165, itemTargetWpm: 180 },
    interview: { accent: "new-zealand", voice: "Despina", introTargetWpm: 165, questionTargetWpm: 155 },
  };
  const v3 = {
    ...structuredClone(v2),
    version: "ets-2026-v3",
    listenAndRepeat: { ...v2.listenAndRepeat, voice: "Charon" },
    interview: { ...v2.interview, accent: "australian", voice: "Sulafat" },
  };
  const v4 = {
    ...structuredClone(v3),
    version: "ets-2026-v4",
    listenAndRepeat: {
      accent: "british",
      voice: "Charon",
      briefingTargetWpm: 165,
      itemTargetWpms: [200, 208, 215, 180, 178, 176, 175],
      itemMaxClipSec: 5,
    },
  };
  // v6's targets are the live constant's (LISTEN_AND_REPEAT_ITEM_TARGET_WPM); v4's and v5's stay
  // pinned to the policy each records. All three must keep parsing, which is why each retune is a new
  // version rather than a retarget in place.
  const v5 = {
    ...structuredClone(v4),
    version: "ets-2026-v5",
    listenAndRepeat: {
      ...structuredClone(v4.listenAndRepeat),
      itemTargetWpms: [226, 226, 226, 170, 170, 170, 170],
    },
  };
  const v6 = {
    ...structuredClone(v5),
    version: "ets-2026-v6",
    listenAndRepeat: {
      ...structuredClone(v5.listenAndRepeat),
      itemTargetWpms: [226, 226, 226, 184, 184, 184, 184],
    },
  };

  it("keeps v4's and v5's retired targets parseable beside v6's live ones", () => {
    expect(SpeakingAudioProfileSchema.parse(v4)).toEqual(v4);
    expect(SpeakingAudioProfileSchema.parse(v5)).toEqual(v5);
    expect(SpeakingAudioProfileSchema.parse(v6)).toEqual(v6);
    // v5's tail target is 170 and the live constant's 184: a v5 profile carrying 184 is rejected,
    // exactly as a v4 carrying v5's targets is below.
    expect(SpeakingAudioProfileSchema.safeParse({
      ...structuredClone(v5),
      listenAndRepeat: { ...structuredClone(v5.listenAndRepeat), itemTargetWpms: [226, 226, 226, 184, 184, 184, 184] },
    }).success).toBe(false);
    // What this guards: retargeting v4's literals in place would make every banked v4 Set fail
    // AnySetSchema and drop out of the picker (listSets skips what does not parse).
    expect(() =>
      SpeakingAudioProfileSchema.parse({
        ...v4,
        listenAndRepeat: { ...v4.listenAndRepeat, itemTargetWpms: [226, 226, 226, 170, 170, 170, 170] },
      }),
    ).toThrow();
  });

  it("parses a v1, a v2, a v3 and a v4 profile, both bare and inside a Set", () => {
    expect(SpeakingAudioProfileSchema.parse(audioProfile)).toEqual(audioProfile);
    expect(SpeakingAudioProfileSchema.parse(v2)).toEqual(v2);
    expect(SpeakingAudioProfileSchema.parse(v3)).toEqual(v3);
    expect(SpeakingAudioProfileSchema.parse(v4)).toEqual(v4);
    for (const profile of [audioProfile, v2, v3, v4]) {
      const parsed = AnySetSchema.parse({ ...structuredClone(speakingSet), audioProfile: profile });
      expect(parsed.kind === "speaking" && parsed.audioProfile).toEqual(profile);
    }
  });

  // Each version requires its own pace policy and carries only that one: v1/v2/v3 keep the flat
  // literal, v4 the ramp, and neither shape survives being written into the other. A retune that
  // edited an existing version's literals instead of adding a version fails here.
  it("requires the flat item target on v1/v2/v3 and the per-item ramp on v4, and never carries both", () => {
    for (const profile of [audioProfile, v2, v3]) {
      expect(profile.listenAndRepeat.itemTargetWpm).toBe(180);
      const { itemTargetWpm: _dropped, ...withoutFlat } = profile.listenAndRepeat;
      expect(SpeakingAudioProfileSchema.safeParse({
        ...structuredClone(profile),
        listenAndRepeat: { ...withoutFlat, itemTargetWpms: [200, 208, 215, 180, 178, 176, 175], itemMaxClipSec: 5 },
      }).success, `${profile.version} must still require its flat target`).toBe(false);
      // Written alongside the flat target, the ramp is dropped by the parse, so a v1/v2/v3 Set never
      // carries two disagreeing answers about how it was paced.
      const parsed = SpeakingAudioProfileSchema.parse({
        ...structuredClone(profile),
        listenAndRepeat: { ...profile.listenAndRepeat, itemTargetWpms: [1, 2, 3, 4, 5, 6, 7], itemMaxClipSec: 9 },
      });
      expect(parsed.listenAndRepeat).not.toHaveProperty("itemTargetWpms");
      expect(parsed.listenAndRepeat).not.toHaveProperty("itemMaxClipSec");
    }

    for (const key of ["itemTargetWpms", "itemMaxClipSec"] as const) {
      const { [key]: _dropped, ...withoutOne } = v4.listenAndRepeat;
      expect(SpeakingAudioProfileSchema.safeParse({
        ...structuredClone(v4), listenAndRepeat: withoutOne,
      }).success, `v4 must require ${key}`).toBe(false);
    }
    const parsedV4 = SpeakingAudioProfileSchema.parse({
      ...structuredClone(v4),
      listenAndRepeat: { ...v4.listenAndRepeat, itemTargetWpm: 180 },
    });
    expect(parsedV4.listenAndRepeat).not.toHaveProperty("itemTargetWpm");
  });

  // The seven targets are literals, as the flat one is, and the tuple is exactly seven long, one per
  // Item. A silent widening to z.number() or z.array() would let a retune ship a Set whose recorded
  // pace policy no longer says what the renderer did.
  it("pins every one of v4's seven per-item targets, the clip ceiling, and the tuple's length", () => {
    for (const index of [0, 1, 2, 3, 4, 5, 6]) {
      const itemTargetWpms = [...v4.listenAndRepeat.itemTargetWpms];
      itemTargetWpms[index] += 1;
      expect(
        SpeakingAudioProfileSchema.safeParse({
          ...structuredClone(v4),
          listenAndRepeat: { ...v4.listenAndRepeat, itemTargetWpms },
        }).success,
        `target ${index + 1} is not pinned`,
      ).toBe(false);
    }
    for (const itemTargetWpms of [
      v4.listenAndRepeat.itemTargetWpms.slice(0, 6),
      [...v4.listenAndRepeat.itemTargetWpms, 175],
      [],
    ]) {
      expect(SpeakingAudioProfileSchema.safeParse({
        ...structuredClone(v4),
        listenAndRepeat: { ...v4.listenAndRepeat, itemTargetWpms },
      }).success).toBe(false);
    }
    expect(SpeakingAudioProfileSchema.safeParse({
      ...structuredClone(v4),
      listenAndRepeat: { ...v4.listenAndRepeat, itemMaxClipSec: 6 },
    }).success).toBe(false);
    // The other three target WPMs stay pinned in v4 too.
    for (const [key, value] of [["briefingTargetWpm", 170]] as const) {
      expect(SpeakingAudioProfileSchema.safeParse({
        ...structuredClone(v4),
        listenAndRepeat: { ...v4.listenAndRepeat, [key]: value },
      }).success).toBe(false);
    }
    for (const [key, value] of [["introTargetWpm", 160], ["questionTargetWpm", 150]] as const) {
      expect(SpeakingAudioProfileSchema.safeParse({
        ...structuredClone(v4),
        interview: { ...v4.interview, [key]: value },
      }).success).toBe(false);
    }
  });

  // New Speaking Sets never draw new-zealand, but the read side must keep accepting it, or the banked
  // Sets that record it would fail AnySetSchema, drop out of the picker and lose their Attempts'
  // review. routes.sets.test.ts parses the banked Speaking Sets themselves; this pins the schema
  // property for every version, v3 included, where the exclusion is enforced only at the draw.
  it("keeps new-zealand parseable in every version — the accent exclusion is draw-only", () => {
    const withNz = (profile: typeof audioProfile | typeof v2 | typeof v3 | typeof v4) => ({
      ...structuredClone(profile),
      listenAndRepeat: { ...profile.listenAndRepeat, accent: "new-zealand" },
    });
    for (const profile of [audioProfile, v2, v3, v4]) {
      expect(SpeakingAudioProfileSchema.safeParse(withNz(profile)).success).toBe(true);
    }
  });

  it("rejects an unknown profile version", () => {
    for (const version of ["ets-2026-v7", "old", "ets-2026-listening-v1", ""]) {
      expect(SpeakingAudioProfileSchema.safeParse({ ...v2, version }).success).toBe(false);
    }
  });

  it("rejects a v2/v3/v4 profile that claims the OpenAI provider, or a non-Gemini-shaped model", () => {
    for (const profile of [v2, v3, v4]) {
      expect(SpeakingAudioProfileSchema.safeParse({ ...profile, provider: "openai" }).success).toBe(false);
      expect(SpeakingAudioProfileSchema.safeParse({ ...profile, model: "" }).success).toBe(false);
    }
  });

  // Every literal v1 has, one assertion each, the four target WPMs included. This catches a silent
  // widening of v1 (a literal quietly becoming z.string() or z.number() while the suite stays green),
  // so a field left out here is a field that can widen unnoticed.
  it("keeps every v1 literal pinned — model, provider, both voices and all four target WPMs", () => {
    expect(SpeakingAudioProfileSchema.safeParse({ ...audioProfile, model: "gemini-3.1-flash-tts-preview" }).success).toBe(false);
    expect(SpeakingAudioProfileSchema.safeParse({ ...audioProfile, provider: "gemini" }).success).toBe(false);
    expect(SpeakingAudioProfileSchema.safeParse({
      ...audioProfile,
      listenAndRepeat: { ...audioProfile.listenAndRepeat, voice: "Gacrux" },
    }).success).toBe(false);
    expect(SpeakingAudioProfileSchema.safeParse({
      ...audioProfile,
      interview: { ...audioProfile.interview, voice: "Despina" },
    }).success).toBe(false);
    expect(SpeakingAudioProfileSchema.safeParse({
      ...audioProfile, listenAndRepeat: { ...audioProfile.listenAndRepeat, briefingTargetWpm: 170 },
    }).success).toBe(false);
    expect(SpeakingAudioProfileSchema.safeParse({
      ...audioProfile, listenAndRepeat: { ...audioProfile.listenAndRepeat, itemTargetWpm: 175 },
    }).success).toBe(false);
    expect(SpeakingAudioProfileSchema.safeParse({
      ...audioProfile, interview: { ...audioProfile.interview, introTargetWpm: 160 },
    }).success).toBe(false);
    expect(SpeakingAudioProfileSchema.safeParse({
      ...audioProfile, interview: { ...audioProfile.interview, questionTargetWpm: 150 },
    }).success).toBe(false);
  });

  it("keeps the four target-WPM numbers as literals in v2 and v3 — neither the provider change nor the draw change moves them", () => {
    for (const profile of [v2, v3]) {
      expect(SpeakingAudioProfileSchema.safeParse({
        ...profile, listenAndRepeat: { ...profile.listenAndRepeat, briefingTargetWpm: 170 },
      }).success).toBe(false);
      expect(SpeakingAudioProfileSchema.safeParse({
        ...profile, listenAndRepeat: { ...profile.listenAndRepeat, itemTargetWpm: 175 },
      }).success).toBe(false);
      expect(SpeakingAudioProfileSchema.safeParse({
        ...profile, interview: { ...profile.interview, introTargetWpm: 160 },
      }).success).toBe(false);
      expect(SpeakingAudioProfileSchema.safeParse({
        ...profile, interview: { ...profile.interview, questionTargetWpm: 150 },
      }).success).toBe(false);
    }
  });

});

// This guard is the contract between Speaking finalization, which writes the skip marker, and the
// readers that act on it (sectionEstimates.ts and the review page's zero-score note). A false
// positive would present a judged 0 as "nothing was recorded", a different and worse claim about the
// User than the data supports.
describe("isSkippedItemScoreJson", () => {
  it("accepts the marker the finalizer writes", () => {
    expect(shared.isSkippedItemScoreJson({ skipped: true, reason: shared.SKIPPED_ITEM_REASON })).toBe(true);
  });

  it("rejects every other shape item_results.score_json can hold", () => {
    // A judged 0 — the case that must never be mistaken for a skip.
    expect(shared.isSkippedItemScoreJson({ itemId: "int-1", finalScore: 0, dimensions: [] })).toBe(false);
    // The infrastructure-failure placeholder.
    expect(shared.isSkippedItemScoreJson({ error: "recording upload did not arrive" })).toBe(false);
    // A deterministic Reading/Listening result.
    expect(shared.isSkippedItemScoreJson({ correct: false, module: "router", answer: "__none__" })).toBe(false);
    expect(shared.isSkippedItemScoreJson(null)).toBe(false);
    expect(shared.isSkippedItemScoreJson("skipped")).toBe(false);
    // `skipped` is a literal true, so a falsy or non-boolean value is not the marker.
    expect(shared.isSkippedItemScoreJson({ skipped: false, reason: "x" })).toBe(false);
    expect(shared.isSkippedItemScoreJson({ skipped: true })).toBe(false);
  });
});

describe("CaptureFinishedRequestSchema", () => {
  it("accepts an absent list — a client that sends no hints is still served", () => {
    expect(shared.CaptureFinishedRequestSchema.parse({})).toEqual({});
  });

  it("rejects a non-array list and an over-long one, so a malformed body cannot become unbounded work", () => {
    expect(shared.CaptureFinishedRequestSchema.safeParse({ uploadFailedItemIds: "lr-1" }).success).toBe(false);
    expect(
      shared.CaptureFinishedRequestSchema.safeParse({ uploadFailedItemIds: Array(65).fill("lr-1") }).success,
    ).toBe(false);
    // A Speaking Set has 11 items, comfortably inside the cap.
    expect(
      shared.CaptureFinishedRequestSchema.safeParse({ uploadFailedItemIds: Array(11).fill("lr-1") }).success,
    ).toBe(true);
  });
});

/**
 * ReadingSkillCategory only ever gains values. `listSets` skips a Set file that fails AnySetSchema
 * (reporting it only at GET /api/sets/unloadable), so a narrowed or renamed value would take banked
 * Sets out of the practice-set picker and strand their past Attempts: the failure
 * SpeakingAccentSchema's comment describes for accents.
 */
describe("ReadingSkillCategory", () => {
  it("holds the six core categories and the three RR-25-12 rotation alternates", () => {
    expect(shared.ReadingSkillCategory.options).toEqual([
      "main_idea", "detail", "inference", "vocabulary", "purpose", "organization",
      "figurative_language", "grammatical_complexity", "rhetorical_structure",
    ]);
  });

  it("parses every reading Set in the bank, so no published Set can vanish from listSets", () => {
    const dir = path.join(config.dataDir, "question-sets/reading");
    const files = fs.readdirSync(dir).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      expect(() => AnySetSchema.parse(raw), file).not.toThrow();
    }
  });
});
