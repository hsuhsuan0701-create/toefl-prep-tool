import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { skillSuccess } from "./helpers/skillResults.js";
import { deferred } from "./helpers/deferred.js";
import { readingPlanEntryCount, REQUIRED_CONCEPT_MAX_CHARS } from "@toefl-prep/shared";
import type {
  GenerationPlan,
  ListeningGenerationPlan,
  ReadingGenerationPlan,
  SpeakingGenerationPlan,
} from "@toefl-prep/shared";
import {
  createGenerationPlanner,
  productionGenerationPlanner,
} from "../src/services/generationPlanner.js";
import { PHYSICAL_SETTING_TERMS } from "../src/services/generationNovelty.js";
import { generateSet } from "../src/services/generator.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import { LISTENING_FIXTURE } from "./fixtures/listening-set.fixture.js";
import { READING_FIXTURE } from "./fixtures/reading-set.fixture.js";
import {
  speakingPlanFixture,
  speakingSetFixture,
  writingPlanFixture,
  writingSetFixture,
} from "./helpers/generationDiversityFixtures.js";
import { expectEveryObjectPropertyRequired } from "./schemaAssertions.js";

const scratchDirs: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

function scratchBank(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "generation-planner-"));
  scratchDirs.push(dataDir);
  fs.mkdirSync(path.join(dataDir, "question-sets/speaking"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dataDir, "question-sets/writing"), {
    recursive: true,
  });
  return dataDir;
}

function alternativeSpeakingPlan(): SpeakingGenerationPlan {
  const plan = speakingPlanFixture();
  plan.listenAndRepeat = {
    ...plan.listenAndRepeat,
    domain: "science-environment",
    setting: "campus climate laboratory",
    speakerRole: "laboratory coordinator",
    communicativePurpose: "prepare a habitat survey team",
    noveltyKey: "climate-laboratory-habitat-survey",
    requiredConcepts: ["climate laboratory", "habitat survey", "sample log"],
  };
  plan.interview = {
    ...plan.interview,
    domain: "technology-media",
    topic: "producing a student science podcast",
    premise: "a media survey about learning through recorded interviews",
    questionArc: [
      "usual source of podcast topics",
      "experience recording an interview",
      "scripted versus spontaneous episodes",
      "whether colleges should fund podcast studios",
    ],
    noveltyKey: "student-science-podcast-production",
    requiredConcepts: ["science podcast", "recorded interview", "episode"],
  };
  return plan;
}

function studyBreakSpeakingPlan(): SpeakingGenerationPlan {
  const plan = speakingPlanFixture();
  plan.interview = {
    ...plan.interview,
    domain: "campus-academics",
    topic: "planned study breaks and concentration",
    premise: "a campus survey about breaks during difficult assignments",
    questionArc: [
      "usual study break schedule",
      "experience regaining concentration",
      "fixed versus flexible breaks",
      "whether colleges should teach break planning",
    ],
    noveltyKey: "study-break-concentration",
    requiredConcepts: [
      "study break",
      "concentration",
      "difficult assignment",
    ],
  };
  return plan;
}

// Six of ten situations in one domain: past the per-domain cap and short of five distinct domains.
// The situations keep their own wording, so nothing else about the plan is wrong.
function unbalancedWritingPlan() {
  const plan = writingPlanFixture();
  const first = plan.buildASentence.situations[0]!;
  plan.buildASentence.situations = plan.buildASentence.situations.map((situation, i) =>
    i < 6 ? { ...situation, domain: first.domain, situation: `${first.situation} (${i})` } : situation
  ) as typeof plan.buildASentence.situations;
  return plan;
}

// Distinct saved Writing sets, ordered oldest to newest by index, so a recency-bounded prompt has
// something unambiguous to keep and something unambiguous to drop.
function writingSetFixtureWithId(setId: string, index: number) {
  const writing = writingSetFixture();
  writing.id = setId;
  writing.createdAt = `2026-0${index + 1}-01T00:00:00Z`;
  writing.buildASentence.items = writing.buildASentence.items.map((item, position) => ({
    ...item,
    id: `bas-${index}-${position}`,
    prompt: `${item.prompt} (bank ${index})`,
  }));
  return writing;
}

// A schema-valid Listening plan whose every entry's own prose classifies as the domain it declares
// (the strings of generator.listening.test.ts's buildPlan(), which clear plannedDomainDrift).
// `listeningSetFixtureWithPlan` below stores this same plan on a saved Set, and a saved Set's Catalog
// entries come from its stored Plan (entriesFromSet), so planning against that Set fires every
// cross-set overlap kind at once while nothing blocks.
function listeningPlanFixture(): ListeningGenerationPlan {
  const planEntryBase = (slug: string, concepts: readonly string[]) => ({
    noveltyKey: `plan-${slug}`,
    requiredConcepts: [...concepts],
    distinguishesFrom: [],
  });
  return {
    version: "cross-set-diversity-v1" as const,
    kind: "listening" as const,
    listenChoose: Array.from({ length: 20 }, () => ({
      ...planEntryBase("lcr", ["close the door", "student"]),
      domain: "campus-academics" as const,
      topic: "a student asking a classmate to close the door",
      speakerRole: "student",
    })),
    conversations: Array.from({ length: 7 }, () => ({
      ...planEntryBase("conv", ["campus dining hall", "student"]),
      domain: "campus-academics" as const,
      setting: "campus dining hall",
      speakerRoles: ["student", "cashier"] as [string, string],
    })),
    announcements: Array.from({ length: 5 }, () => ({
      ...planEntryBase("ann", ["student union lobby", "staff member"]),
      domain: "campus-academics" as const,
      setting: "student union lobby",
      speakerRole: "staff member",
    })),
    academicTalks: Array.from({ length: 4 }, () => ({
      ...planEntryBase("talk", ["marine biology", "professor"]),
      domain: "science-environment" as const,
      discipline: "marine biology",
      speakerRole: "professor",
    })),
  };
}

function listeningSetFixtureWithPlan(setId: string) {
  return { ...LISTENING_FIXTURE, id: setId, generationPlan: listeningPlanFixture() };
}

function parsePayload(prompt: string): {
  kind: string;
  attempt: number;
  maxAttempts: number;
  catalog: Array<{ setId: string; taskType: string }>;
  retry: unknown;
} {
  const match = prompt.match(/```json\n([\s\S]*?)\n```/u);
  if (!match) throw new Error("planner prompt has no JSON payload");
  return JSON.parse(match[1]) as ReturnType<typeof parsePayload>;
}

describe("generation planner calls and retries", () => {
  it.each([
    ["speaking", speakingPlanFixture],
    ["writing", writingPlanFixture],
  ] as const)(
    "packages and parses a complete %s planning request",
    async (kind, planFixture) => {
      const dataDir = scratchBank();
      const requests: SkillTaskRequest<unknown>[] = [];
      const runSkillTask = vi.fn(
        async (request: SkillTaskRequest<unknown>) => {
          requests.push(request);
          request.onEvent?.({ state: "running", provider: "claude" });
          return skillSuccess(request.parse(planFixture()));
        },
      );
      const progress: unknown[] = [];
      const planner = createGenerationPlanner({
        dataDir,
        randomUUID: () => `${kind}-reservation`,
      });

      const reservation = await planner.reserve({
        kind,
        ownerId: `${kind}-job`,
        runSkillTask: runSkillTask as never,
        onProgress: (event) => progress.push(event),
      });

      expect(reservation).toEqual({
        reservationId: `${kind}-reservation`,
        ownerId: `${kind}-job`,
        plan: planFixture(),
      });
      expect(requests).toHaveLength(1);
      expect(requests[0].task).toEqual({ task: "plan", context: kind });
      expect(requests[0].prompt).toMatch(new RegExp(`^PLAN ${kind}\\n`));
      expectEveryObjectPropertyRequired(requests[0].jsonSchema);
      const payload = parsePayload(requests[0].prompt);
      expect(payload).toMatchObject({
        kind,
        attempt: 1,
        maxAttempts: 3,
        catalog: [],
        retry: null,
      });
      expect(progress).toEqual([{
        stage: "planning",
        detail: {
          provider: "claude",
          planningAttempt: 1,
          maxDiversityAttempts: 3,
        },
      }]);
    },
  );

  it("replans a fatal plan once, with bounded retry metadata and the unchanged catalog", async () => {
    const dataDir = scratchBank();
    const saved = speakingSetFixture();
    saved.id = "spk-saved";
    saved.generationPlan = speakingPlanFixture();
    fs.writeFileSync(
      path.join(dataDir, "question-sets/speaking/spk-saved.json"),
      JSON.stringify(saved),
    );
    const placeless = speakingPlanFixture();
    placeless.listenAndRepeat.setting = "the abstract value of creativity";
    const requests: SkillTaskRequest<unknown>[] = [];
    const plans: GenerationPlan[] = [placeless, alternativeSpeakingPlan()];
    const runSkillTask = vi.fn(
      async (request: SkillTaskRequest<unknown>) => {
        requests.push(request);
        return skillSuccess(request.parse(plans[requests.length - 1]));
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const planner = createGenerationPlanner({ dataDir });

    const reservation = await planner.reserve({
      kind: "speaking",
      ownerId: "retry-job",
      runSkillTask: runSkillTask as never,
    });

    expect(reservation.plan).toEqual(alternativeSpeakingPlan());
    expect(requests).toHaveLength(2);
    const first = parsePayload(requests[0].prompt);
    const second = parsePayload(requests[1].prompt);
    expect(second.catalog).toEqual(first.catalog);
    expect(second.retry).toEqual(expect.objectContaining({
      taskTypes: expect.arrayContaining(["listen_repeat"]),
      collisionKinds: expect.arrayContaining(["plan-drift"]),
    }));
    expect(JSON.stringify(second.retry)).not.toContain("creativity");
    expect(JSON.stringify(second.retry)).not.toContain("distinguishesFrom");
  });

  // Every other test here reserves a plan whose distinguishesFrom is already `[]`, so this is the one
  // that exercises stripInvalidDistinctions: removing its call from reserve() would leave the rest
  // green. A citation naming a setId absent from an empty bank is stripped at ingest, not spent as a
  // planner retry.
  it("strips an invalid distinguishesFrom citation at ingest instead of rejecting the plan", async () => {
    const dataDir = scratchBank();
    const plan = speakingPlanFixture();
    plan.interview.distinguishesFrom = [{
      setId: "spk-does-not-exist-yet",
      reason: "would distinguish from a prior interview, but none exists yet",
    }];
    const requests: SkillTaskRequest<unknown>[] = [];
    const runSkillTask = vi.fn(
      async (request: SkillTaskRequest<unknown>) => {
        requests.push(request);
        return skillSuccess(request.parse(plan));
      },
    );
    const planner = createGenerationPlanner({ dataDir });

    const reservation = await planner.reserve({
      kind: "speaking",
      ownerId: "strip-job",
      runSkillTask: runSkillTask as never,
    });

    // No retry was spent: the invalid citation never rejected the plan.
    expect(requests).toHaveLength(1);
    // The reservation's own plan, which generator.ts and the published Set both see, carries the
    // citation stripped, not merely tolerated.
    if (reservation.plan.kind !== "speaking") throw new Error("unreachable");
    expect(reservation.plan.interview.distinguishesFrom).toEqual([]);
  });

  // Entry text from generator.reading.test.ts's ctwPlanEntry(), dailyLifePlanEntry() and
  // academicPlanEntry(), which classifies as each entry's declared `domain`, so the plan clears
  // plannedDomainDrift. Each entry gets its own noveltyKey. Entry counts come from shared's
  // `readingPlanEntryCount`, the derivation ReadingGenerationPlanSchema uses for its array lengths:
  // a plan whose arrays disagree with the composition table does not parse, so a literal here would
  // break whenever the table is retuned. The indexes the tests below touch (dailyLifeTexts[2],
  // academicPassages[0]) must stay in range.
  function readingPlanFixture(): ReadingGenerationPlan {
    return {
      version: "cross-set-diversity-v1" as const,
      kind: "reading" as const,
      ctwPassages: Array.from({ length: readingPlanEntryCount("ctw") }, (_, i) => ({
        domain: "everyday-life" as const,
        noveltyKey: `plan-ctw-${i}`,
        requiredConcepts: ["cave drawings", "group activity"],
        distinguishesFrom: [],
        topic: "prehistoric cave dancing",
        angle: "why early humans recorded group dance activity in cave drawings",
      })),
      dailyLifeTexts: Array.from({ length: readingPlanEntryCount("dailyLife") }, (_, i) => ({
        domain: "workplace-business" as const,
        noveltyKey: `plan-dl-${i}`,
        requiredConcepts: ["paperless billing", "housing office"],
        distinguishesFrom: [],
        genre: "notice",
        scenario: "a paperless billing notice from the housing office",
      })),
      academicPassages: Array.from({ length: readingPlanEntryCount("academic") }, (_, i) => ({
        domain: "everyday-life" as const,
        noveltyKey: `plan-ap-${i}`,
        requiredConcepts: ["afternoon dip", "brief nap"],
        distinguishesFrom: [],
        title: "The Afternoon Alertness Dip",
        discipline: "human physiology",
        angle: "why alertness dips in the afternoon and what remedies work",
      })),
    };
  }

  it("names the exact plan slot and kind in the reading retry prompt after a domain drift", async () => {
    const dataDir = scratchBank();
    const driftedPlan = readingPlanFixture();
    // No keyword support for the declared `workplace-business`, and two science-environment keywords.
    driftedPlan.dailyLifeTexts[2] = {
      ...driftedPlan.dailyLifeTexts[2]!,
      requiredConcepts: ["laboratory experiment", "habitat biodiversity"],
      scenario: "a laboratory experiment on habitat biodiversity",
    };
    const fixedPlan = readingPlanFixture();

    const requests: SkillTaskRequest<unknown>[] = [];
    const plans: GenerationPlan[] = [driftedPlan, fixedPlan];
    const runSkillTask = vi.fn(
      async (request: SkillTaskRequest<unknown>) => {
        requests.push(request);
        return skillSuccess(request.parse(plans[requests.length - 1]));
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const planner = createGenerationPlanner({ dataDir });

    const reservation = await planner.reserve({
      kind: "reading",
      ownerId: "reading-retry-job",
      runSkillTask: runSkillTask as never,
    });

    expect(reservation.plan).toEqual(fixedPlan);
    expect(requests).toHaveLength(2);
    const retry = parsePayload(requests[1].prompt).retry as {
      collisionKinds: string[];
      entries: { taskType: string; kind: string; itemPosition?: number; planLabel?: string }[];
    };
    expect(retry.collisionKinds).toContain("domain-drift");
    const drifted = retry.entries.filter((entry) => entry.taskType === "daily_life");
    // Exactly the one entry that drifted, by position, with its own plan text for the model.
    expect(drifted).toEqual([{
      taskType: "daily_life",
      kind: "domain-drift",
      itemPosition: 2,
      planLabel: "notice: a laboratory experiment on habitat biodiversity",
    }]);
  });

  // The planner's log lines and its exhaustion error go through planIssueDetail, which must scrub
  // plan text (scrubDiversityIssues) like every other channel. The same domain drift as the test
  // above, on every attempt, so the planner runs to exhaustion and both console.error and the final
  // throw fire.
  it("never leaks the plan's raw scenario/concept text into the log or the exhaustion error", async () => {
    const dataDir = scratchBank();
    const sentinelPlanLabel = "notice: a laboratory experiment on habitat biodiversity";
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      const plan = readingPlanFixture();
      // The leak check is about what an exhaustion error may carry, so it needs a fatal check: a
      // domain contradiction, with no keyword support for the declared `workplace-business` and two
      // science-environment keywords. Overlap with the Catalog is advisory and would never exhaust.
      plan.dailyLifeTexts[2] = {
        ...plan.dailyLifeTexts[2]!,
        requiredConcepts: ["laboratory experiment", "habitat biodiversity"],
        scenario: "a laboratory experiment on habitat biodiversity",
      };
      return skillSuccess(request.parse(plan));
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const planner = createGenerationPlanner({ dataDir });

    let thrown: Error | undefined;
    try {
      await planner.reserve({
        kind: "reading",
        ownerId: "leak-check-job",
        runSkillTask: runSkillTask as never,
      });
    } catch (err) {
      thrown = err as Error;
    }

    // Read the spy's call history before restoring it: mockRestore() also clears .mock.calls.
    const logged = errorSpy.mock.calls.filter((call) =>
      String(call[0]).includes("plan attempt"),
    );
    errorSpy.mockRestore();

    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain(
      "no plan could be admitted after 3 attempts",
    );
    // itemPosition alone still names the failing slot (daily_life position 2, as the test above
    // shows).
    expect(thrown!.message).toContain('"itemPosition":2');
    expect(thrown!.message).not.toContain(sentinelPlanLabel);
    expect(thrown!.message).not.toContain("planLabel");
    expect(thrown!.message).not.toContain("failedConcepts");

    expect(logged.length).toBeGreaterThan(0);
    for (const call of logged) {
      const detail = String(call[1]);
      expect(detail).not.toContain(sentinelPlanLabel);
      expect(detail).not.toContain("planLabel");
    }
  });

  it("admits a plan that only overlaps the Catalog on its first attempt, carrying the overlap as notes", async () => {
    const dataDir = scratchBank();
    const saved = speakingSetFixture();
    saved.id = "spk-saved";
    saved.generationPlan = speakingPlanFixture();
    fs.writeFileSync(
      path.join(dataDir, "question-sets/speaking/spk-saved.json"),
      JSON.stringify(saved),
    );
    const runSkillTask = vi.fn(
      async (request: SkillTaskRequest<unknown>) =>
        skillSuccess(request.parse(speakingPlanFixture())),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const planner = createGenerationPlanner({ dataDir });

    const reservation = await planner.reserve({
      kind: "speaking",
      ownerId: "overlapping-job",
      runSkillTask: runSkillTask as never,
    });

    expect(runSkillTask).toHaveBeenCalledTimes(1);
    expect(reservation.plan).toEqual(speakingPlanFixture());
    expect(reservation.advisoryNotes?.length).toBeGreaterThan(0);
    expect(reservation.advisoryNotes!.every((note) =>
      note.check === "catalog-novelty" &&
      note.detail === "containment" &&
      note.conflictingSetIds?.includes("spk-saved")
    )).toBe(true);
  });

  it("admits a Reading plan that repeats a banked Set on its first attempt too", async () => {
    const readingDir = scratchBank();
    fs.mkdirSync(path.join(readingDir, "question-sets/reading"), { recursive: true });
    fs.writeFileSync(
      path.join(readingDir, "question-sets/reading/rd-prior.json"),
      JSON.stringify({ ...READING_FIXTURE, id: "rd-prior", generationPlan: readingPlanFixture() }),
    );
    const readingRuns = vi.fn(async (request: SkillTaskRequest<unknown>) =>
      skillSuccess(request.parse(readingPlanFixture()))
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const reading = await createGenerationPlanner({ dataDir: readingDir }).reserve({
      kind: "reading",
      ownerId: "reading-first-attempt",
      runSkillTask: readingRuns as never,
    });
    expect(readingRuns).toHaveBeenCalledTimes(1);
    expect(reading.advisoryNotes).toContainEqual(expect.objectContaining({
      check: "catalog-novelty",
      detail: "containment",
      conflictingSetIds: ["rd-prior"],
      itemPosition: 0,
    }));
  });

  // A plan whose component contradicts its declared domain costs a replan in every section; a
  // banked Set it repeats does not.
  it("replans a Listening plan over a domain drift, not over the prior Set it repeats", async () => {
    const dataDir = scratchBank();
    fs.mkdirSync(path.join(dataDir, "question-sets/listening"), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "question-sets/listening/lsn-14659f38.json"),
      JSON.stringify(listeningSetFixtureWithPlan("lsn-14659f38")),
    );
    // Zero support for the declared domain and two keywords pointing elsewhere: a contradiction.
    const drifted = listeningPlanFixture();
    drifted.academicTalks[0] = {
      ...drifted.academicTalks[0]!,
      domain: "arts-culture",
      discipline: "marine biology",
      requiredConcepts: ["habitat loss along the coast", "climate shifts in biodiversity"],
    };
    const clean = listeningPlanFixture();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const plans: GenerationPlan[] = [drifted, clean];
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) =>
      skillSuccess(request.parse(plans.shift()!))
    );
    const reservation = await createGenerationPlanner({ dataDir }).reserve({
      kind: "listening",
      ownerId: "measured-shape",
      runSkillTask: runSkillTask as never,
    });

    expect(runSkillTask).toHaveBeenCalledTimes(2);
    const replanned = errorSpy.mock.calls.find((call) => String(call[0]).includes("plan attempt 1/3"));
    expect(String(replanned?.[1])).toContain("domain-drift");
    expect(reservation.plan).toEqual(clean);
    expect((reservation.advisoryNotes ?? []).some((note) => note.detail === "domain-drift")).toBe(false);
  });

  it("leaves the Set a run replaces out of the Catalog it is measured against", async () => {
    const dataDir = scratchBank();
    fs.mkdirSync(path.join(dataDir, "question-sets/reading"), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "question-sets/reading/rd-replaced.json"),
      JSON.stringify({ ...READING_FIXTURE, id: "rd-replaced", generationPlan: readingPlanFixture() }),
    );
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) =>
      skillSuccess(request.parse(readingPlanFixture()))
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const replacing = await createGenerationPlanner({ dataDir }).reserve({
      kind: "reading",
      ownerId: "replacement-run",
      supersedesSetId: "rd-replaced",
      runSkillTask: runSkillTask as never,
    });
    const ordinary = await createGenerationPlanner({ dataDir }).reserve({
      kind: "reading",
      ownerId: "ordinary-run",
      runSkillTask: runSkillTask as never,
    });

    expect(replacing.advisoryNotes).toBeUndefined();
    expect(ordinary.advisoryNotes?.length).toBeGreaterThan(0);
  });

  // Build a Sentence's domain spread is repaired by replanning: a balanced replan is taken as-is.
  it("takes a balanced Build a Sentence replan as-is, with no note", async () => {
    const dataDir = scratchBank();
    const plans: GenerationPlan[] = [unbalancedWritingPlan(), writingPlanFixture()];
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) =>
      skillSuccess(request.parse(plans.shift()!))
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const reservation = await createGenerationPlanner({ dataDir }).reserve({
      kind: "writing",
      ownerId: "balanced-second-attempt",
      runSkillTask: runSkillTask as never,
    });

    expect(runSkillTask).toHaveBeenCalledTimes(2);
    expect(reservation.plan).toEqual(writingPlanFixture());
    expect(reservation.advisoryNotes).toBeUndefined();
  });

  it("admits the first unbalanced Build a Sentence plan once every replan is spent, with a note", async () => {
    const dataDir = scratchBank();
    const first = unbalancedWritingPlan();
    const later = unbalancedWritingPlan();
    later.email = { ...later.email, noveltyKey: "a-later-email-key" };
    const plans: GenerationPlan[] = [first, later, later];
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) =>
      skillSuccess(request.parse(plans.shift()!))
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const reservation = await createGenerationPlanner({ dataDir }).reserve({
      kind: "writing",
      ownerId: "unbalanced-job",
      runSkillTask: runSkillTask as never,
    });

    expect(runSkillTask).toHaveBeenCalledTimes(3);
    expect(reservation.plan).toEqual(first);
    expect(reservation.advisoryNotes).toContainEqual({
      check: "catalog-novelty",
      detail: "domain-balance",
      taskType: "build_sentence",
    });
  });

  // Neither the admission warning nor the residual payload may carry the plan's own scenario, topic
  // or title text: the residual reaches the UI through generation_jobs.progress, and Set content
  // reaches the client only through GET /api/sets/:id.
  it("never leaks plan text into the tolerated-residual warning or its progress payload", async () => {
    const dataDir = scratchBank();
    const saved = speakingSetFixture();
    saved.id = "spk-saved";
    saved.generationPlan = speakingPlanFixture();
    fs.writeFileSync(
      path.join(dataDir, "question-sets/speaking/spk-saved.json"),
      JSON.stringify(saved),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const progress: unknown[] = [];

    await createGenerationPlanner({ dataDir }).reserve({
      kind: "speaking",
      ownerId: "leak-check-residual",
      runSkillTask: vi.fn(async (request: SkillTaskRequest<unknown>) =>
        skillSuccess(request.parse(speakingPlanFixture()))
      ) as never,
      onProgress: (event) => progress.push(event),
    });

    const warned = warnSpy.mock.calls.map((call) => call.map(String).join(" "));
    warnSpy.mockRestore();

    const residualEvents = progress.filter((event) =>
      JSON.stringify(event).includes("noveltyResidual")
    );
    expect(residualEvents.length).toBeGreaterThan(0);
    for (const text of [...warned, ...residualEvents.map((e) => JSON.stringify(e))]) {
      expect(text).not.toContain("planLabel");
      expect(text).not.toContain("clinic");
      expect(text).not.toContain("requiredConcepts");
      expect(text).not.toContain("noveltyKey");
    }
  });

  it("shows the catalog to the planner, and records the overlap when the model ignores it", async () => {
    const dataDir = scratchBank();
    const saved = speakingSetFixture();
    saved.id = "spk-study-break-saved";
    saved.generationPlan = studyBreakSpeakingPlan();
    fs.writeFileSync(
      path.join(
        dataDir,
        "question-sets/speaking/spk-study-break-saved.json",
      ),
      JSON.stringify(saved),
    );
    const requests: SkillTaskRequest<unknown>[] = [];
    const runSkillTask = vi.fn(
      async (request: SkillTaskRequest<unknown>) => {
        requests.push(request);
        return skillSuccess(request.parse(studyBreakSpeakingPlan()));
      },
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const planner = createGenerationPlanner({ dataDir });

    const reservation = await planner.reserve({
      kind: "speaking",
      ownerId: "catalog-ignoring-model",
      runSkillTask: runSkillTask as never,
    });
    expect(reservation.advisoryNotes?.some((note) =>
      note.conflictingSetIds?.includes("spk-study-break-saved")
    )).toBe(true);

    expect(requests).toHaveLength(1);
    expect(parsePayload(requests[0].prompt).catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ setId: "spk-study-break-saved" }),
      ]),
    );
  });

  it("rebuilds the catalog for every planning attempt", async () => {
    const dataDir = scratchBank();
    const placeless = speakingPlanFixture();
    placeless.listenAndRepeat.setting = "the abstract value of creativity";
    const requests: SkillTaskRequest<unknown>[] = [];
    const runSkillTask = vi.fn(
      async (request: SkillTaskRequest<unknown>) => {
        requests.push(request);
        if (requests.length === 1) {
          // A concurrent job publishes between attempt one and attempt two.
          const saved = speakingSetFixture();
          saved.id = "spk-published-midway";
          saved.generationPlan = speakingPlanFixture();
          fs.writeFileSync(
            path.join(dataDir, "question-sets/speaking/spk-published-midway.json"),
            JSON.stringify(saved),
          );
          return skillSuccess(request.parse(placeless));
        }
        return skillSuccess(request.parse(alternativeSpeakingPlan()));
      },
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const planner = createGenerationPlanner({ dataDir });

    await planner.reserve({
      kind: "speaking",
      ownerId: "concurrent-publish-job",
      runSkillTask: runSkillTask as never,
    });

    expect(requests).toHaveLength(2);
    expect(parsePayload(requests[0].prompt).catalog.map(({ setId }) => setId))
      .not.toContain("spk-published-midway");
    expect(parsePayload(requests[1].prompt).catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ setId: "spk-published-midway" }),
      ]),
    );
  });

  it("hands the planner the domain vocabulary its plan is graded against", async () => {
    const dataDir = scratchBank();
    const requests: SkillTaskRequest<unknown>[] = [];
    const runSkillTask = vi.fn(
      async (request: SkillTaskRequest<unknown>) => {
        requests.push(request);
        return skillSuccess(request.parse(writingPlanFixture()));
      },
    );

    await createGenerationPlanner({ dataDir }).reserve({
      kind: "writing",
      ownerId: "vocabulary-job",
      runSkillTask: runSkillTask as never,
    });

    const payload = JSON.parse(
      requests[0].prompt.match(/```json\n([\s\S]*?)\n```/u)?.[1] ?? "{}",
    ) as {
      domainKeywords: Record<string, string[]>;
      buildSentenceRules: { minimumInPreferredDomains: number };
      requiredConceptRules: { maxCharacters: number; form: string; good: string[]; bad: string[] };
    };
    // Plan-time validation classifies a plan's own prose with this table, and a plan cannot satisfy
    // a vocabulary the planner is never shown.
    expect(payload.domainKeywords["health-wellbeing"]).toContain("clinic");
    expect(payload.domainKeywords["campus-academics"]).toContain("student");
    expect(payload.buildSentenceRules.minimumInPreferredDomains).toBe(5);

    // The planner is told to write each required concept as content, not as an instruction about
    // the response: a concept phrased as an instruction ("stated", "preference", "described")
    // produces worse generated prose. And a length cap the model never sees is one it cannot meet.
    expect(payload.requiredConceptRules.maxCharacters).toBe(REQUIRED_CONCEPT_MAX_CHARS);
    expect(payload.requiredConceptRules.form).toMatch(/noun phrase/i);
    expect(payload.requiredConceptRules.good.every((c) => c.length <= REQUIRED_CONCEPT_MAX_CHARS)).toBe(true);
    expect(payload.requiredConceptRules.bad.every((c) => c.length > REQUIRED_CONCEPT_MAX_CHARS)).toBe(true);
  });

  // The same rule as the domain vocabulary test above, for Listen and Repeat's `setting` field.
  // Asserted by equality with generationNovelty.ts's PHYSICAL_SETTING_TERMS, the list
  // validateGenerationPlan's physical-setting check is built from, rather than a hand-copied sample,
  // so the prompt and the check cannot drift apart.
  it("hands the planner the physical-setting vocabulary its L&R plan is graded against", async () => {
    const dataDir = scratchBank();
    const requests: SkillTaskRequest<unknown>[] = [];
    const runSkillTask = vi.fn(
      async (request: SkillTaskRequest<unknown>) => {
        requests.push(request);
        return skillSuccess(request.parse(speakingPlanFixture()));
      },
    );

    await createGenerationPlanner({ dataDir }).reserve({
      kind: "speaking",
      ownerId: "physical-setting-vocabulary-job",
      runSkillTask: runSkillTask as never,
    });

    const payload = JSON.parse(
      requests[0].prompt.match(/```json\n([\s\S]*?)\n```/u)?.[1] ?? "{}",
    ) as { physicalSettingTerms: string[] };

    expect(payload.physicalSettingTerms).toEqual(PHYSICAL_SETTING_TERMS);
  });

  it("keeps saved Sets in the prompt catalog however many reservations are in flight", async () => {
    const dataDir = scratchBank();
    fs.mkdirSync(path.join(dataDir, "question-sets/listening"), { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "question-sets/listening/lsn-saved1.json"),
      JSON.stringify(listeningSetFixtureWithPlan("lsn-saved1")),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const planner = createGenerationPlanner({ dataDir });
    const prompts: string[] = [];
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
      prompts.push(request.prompt);
      return skillSuccess(request.parse(listeningPlanFixture()));
    });

    // Three reservations held at once: sixty pending Listen and Choose a Response entries, more than
    // the forty the prompt carries for one Task Type.
    for (const ownerId of ["in-flight-1", "in-flight-2", "in-flight-3", "fourth"]) {
      await planner.reserve({ kind: "listening", ownerId, runSkillTask: runSkillTask as never });
    }

    const listenChoose = parsePayload(prompts[3]!).catalog.filter(({ taskType }) => taskType === "listen_choose");
    expect(listenChoose).toHaveLength(40);
    expect(listenChoose.filter(({ setId }) => setId === "lsn-saved1")).toHaveLength(20);
    expect(listenChoose.filter(({ setId }) => setId.startsWith("pending:"))).toHaveLength(20);
  });

  it("bounds the prompt catalog and discloses what it left out", async () => {
    const dataDir = scratchBank();
    for (let index = 0; index < 6; index += 1) {
      const writing = writingSetFixtureWithId(`wri-bank-${index}`, index);
      fs.writeFileSync(
        path.join(dataDir, `question-sets/writing/wri-bank-${index}.json`),
        JSON.stringify(writing),
      );
    }
    const requests: SkillTaskRequest<unknown>[] = [];
    const runSkillTask = vi.fn(
      async (request: SkillTaskRequest<unknown>) => {
        requests.push(request);
        return skillSuccess(request.parse(speakingPlanFixture()));
      },
    );

    await createGenerationPlanner({ dataDir }).reserve({
      kind: "speaking",
      ownerId: "bounded-prompt-job",
      runSkillTask: runSkillTask as never,
    });

    const payload = JSON.parse(
      requests[0].prompt.match(/```json\n([\s\S]*?)\n```/u)?.[1] ?? "{}",
    ) as {
      catalog: { taskType: string; setId: string; descriptor: string }[];
      catalogOmittedByTaskType: Record<string, number>;
      domainCountsByTaskType: Record<string, Record<string, number>>;
    };
    const buildSentence = payload.catalog.filter(
      ({ taskType }) => taskType === "build_sentence",
    );

    // Sixty saved exchanges, forty in the prompt, and the count of the twenty it dropped — a partial
    // bank is never presented as the whole bank. Domain counts stay complete and unsampled.
    expect(buildSentence).toHaveLength(40);
    expect(payload.catalogOmittedByTaskType.build_sentence).toBe(20);
    expect(
      Object.values(payload.domainCountsByTaskType.build_sentence)
        .reduce((sum, count) => sum + count, 0),
    ).toBe(60);
    // Newest first: the topics the User saw most recently are the ones the planner must avoid.
    expect(buildSentence.every(({ setId }) => setId >= "wri-bank-2")).toBe(true);
    for (const item of payload.catalog) {
      expect(item.descriptor.length).toBeLessThanOrEqual(240);
      expect(item.descriptor.endsWith(" ")).toBe(false);
    }
  });

  it("reuses a parsed catalog until the bank changes on disk", async () => {
    const dataDir = scratchBank();
    const saved = speakingSetFixture();
    saved.id = "spk-cached";
    const savedPath = path.join(
      dataDir,
      "question-sets/speaking/spk-cached.json",
    );
    fs.writeFileSync(savedPath, JSON.stringify(saved));
    const planner = createGenerationPlanner({ dataDir });
    const reserve = () => planner.reserve({
      kind: "speaking",
      ownerId: "cache-job",
      runSkillTask: vi.fn(async (request: SkillTaskRequest<unknown>) =>
        skillSuccess(request.parse(speakingPlanFixture()))
      ) as never,
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const readFile = vi.spyOn(fs, "readFileSync");

    await reserve();
    const firstReads = readFile.mock.calls.length;
    await reserve();
    const cachedReads = readFile.mock.calls.length;

    // Rebuilding the Catalog from scratch costs about 200 ms at a hundred Sets, on the one event
    // loop that also serves scoring-job polling.
    expect(firstReads).toBeGreaterThan(0);
    expect(cachedReads).toBe(firstReads);

    const changed = speakingSetFixture();
    changed.id = "spk-cached";
    changed.listenAndRepeat.scenarioTitle = "A Second Visit to the Clinic";
    fs.writeFileSync(savedPath, JSON.stringify(changed));
    fs.utimesSync(savedPath, new Date(), new Date(Date.now() + 1000));
    await reserve();

    expect(readFile.mock.calls.length).toBeGreaterThan(cachedReads);
  });

  it("surfaces a sanitized provider failure without a planner retry", async () => {
    const planner = createGenerationPlanner({ dataDir: scratchBank() });
    const runSkillTask = vi.fn().mockResolvedValue({
      ok: false,
      error: "Structured reasoning unavailable: Claude (quota) → Codex (timeout).",
      attempts: [
        { provider: "claude", kind: "quota" },
        { provider: "codex", kind: "timeout" },
      ],
    });

    await expect(planner.reserve({
      kind: "speaking",
      ownerId: "failed-provider-job",
      runSkillTask: runSkillTask as never,
    })).rejects.toThrow(
      "Structured reasoning unavailable: Claude (quota) → Codex (timeout).",
    );
    expect(runSkillTask).toHaveBeenCalledTimes(1);
  });
});

describe("generation planner reservation lifetime", () => {
  // The admission lock covers the Catalog read, validation and commit, not the plan call, so two
  // reservations plan at once; generationPlannerAdmission.test.ts pins that the later commit is
  // validated against the earlier one.
  it("plans two reservations at once, and commits both", async () => {
    const dataDir = scratchBank();
    const firstGate = deferred<GenerationPlan>();
    const secondGate = deferred<GenerationPlan>();
    const planner = createGenerationPlanner({
      dataDir,
      randomUUID: (() => {
        let next = 0;
        return () => `reservation-${++next}`;
      })(),
    });
    const firstRun = vi.fn(async (request: SkillTaskRequest<unknown>) =>
      skillSuccess(request.parse(await firstGate.promise)));
    const secondRun = vi.fn(async (request: SkillTaskRequest<unknown>) =>
      skillSuccess(request.parse(await secondGate.promise)));

    const firstPromise = planner.reserve({
      kind: "speaking",
      ownerId: "first-owner",
      runSkillTask: firstRun as never,
    });
    const secondPromise = planner.reserve({
      kind: "speaking",
      ownerId: "second-owner",
      runSkillTask: secondRun as never,
    });
    await vi.waitFor(() => expect(firstRun).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(secondRun).toHaveBeenCalledTimes(1));

    firstGate.resolve(speakingPlanFixture());
    const first = await firstPromise;
    expect(first.ownerId).toBe("first-owner");

    secondGate.resolve(alternativeSpeakingPlan());
    const second = await secondPromise;
    expect(second.ownerId).toBe("second-owner");
    expect(second.reservationId).not.toBe(first.reservationId);
  });

  it("release is idempotent and removes a failed caller's reservation", async () => {
    const dataDir = scratchBank();
    const planner = createGenerationPlanner({ dataDir });
    const first = await planner.reserve({
      kind: "speaking",
      ownerId: "released-owner",
      runSkillTask: vi.fn(async (request: SkillTaskRequest<unknown>) =>
        skillSuccess(request.parse(speakingPlanFixture()))
      ) as never,
    });
    planner.release(first.reservationId);
    planner.release(first.reservationId);
    planner.release("unknown-reservation");
    const prompts: string[] = [];

    await planner.reserve({
      kind: "speaking",
      ownerId: "next-owner",
      runSkillTask: vi.fn(async (request: SkillTaskRequest<unknown>) => {
        prompts.push(request.prompt);
        return skillSuccess(request.parse(speakingPlanFixture()));
      }) as never,
    });

    expect(parsePayload(prompts[0]).catalog.some(
      ({ setId }) => setId === "pending:released-owner",
    )).toBe(false);
  });

  // An in-flight reservation is visible to the next one, and the overlap is recorded rather than
  // replanned over. Its id names nothing a User could look at, so it reaches the job row's residual
  // but not the Set's notes.
  it("sees an active reservation with no Set JSON yet, and admits the second run carrying that overlap", async () => {
    const dataDir = scratchBank();
    const planner = createGenerationPlanner({ dataDir });
    const first = await planner.reserve({
      kind: "speaking",
      ownerId: "unpublished-first",
      runSkillTask: vi.fn(async (request: SkillTaskRequest<unknown>) =>
        skillSuccess(request.parse(speakingPlanFixture()))
      ) as never,
    });
    const secondRun = vi.fn(async (request: SkillTaskRequest<unknown>) =>
      skillSuccess(request.parse(speakingPlanFixture()))
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const progress: unknown[] = [];

    const second = await planner.reserve({
      kind: "speaking",
      ownerId: "unpublished-second",
      runSkillTask: secondRun as never,
      onProgress: (event) => progress.push(event),
    });

    expect(secondRun).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(progress)).toContain("pending:unpublished-first");
    expect(second.advisoryNotes?.length).toBeGreaterThan(0);
    expect(JSON.stringify(second.advisoryNotes)).not.toContain("pending:");
    expect(fs.readdirSync(
      path.join(dataDir, "question-sets/speaking"),
    )).toEqual([]);
    planner.release(first.reservationId);
  });

  it("keeps reservations local to the planner instance that made them", async () => {
    const dataDir = scratchBank();
    const firstPlanner = createGenerationPlanner({ dataDir });
    const secondPlanner = createGenerationPlanner({ dataDir });
    await firstPlanner.reserve({
      kind: "speaking",
      ownerId: "isolated-owner",
      runSkillTask: vi.fn(async (request: SkillTaskRequest<unknown>) =>
        skillSuccess(request.parse(speakingPlanFixture()))
      ) as never,
    });
    const prompts: string[] = [];

    await secondPlanner.reserve({
      kind: "speaking",
      ownerId: "other-instance-owner",
      runSkillTask: vi.fn(async (request: SkillTaskRequest<unknown>) => {
        prompts.push(request.prompt);
        return skillSuccess(request.parse(speakingPlanFixture()));
      }) as never,
    });

    expect(parsePayload(prompts[0]).catalog.some(
      ({ setId }) => setId === "pending:isolated-owner",
    )).toBe(false);
  });

  // Reservations are instance-local, so concurrent jobs see each other's pending Plans only when
  // they reserve through the same planner. generateSet with no `planner` dependency, which is how
  // every production job calls it, must reserve through productionGenerationPlanner.
  it("makes productionGenerationPlanner the planner generateSet reserves through when none is passed", async () => {
    const held = await productionGenerationPlanner.reserve({
      kind: "speaking",
      ownerId: "concurrent-job",
      runSkillTask: vi.fn(async (request: SkillTaskRequest<unknown>) =>
        skillSuccess(request.parse(speakingPlanFixture()))
      ) as never,
    });
    const prompts: string[] = [];
    try {
      // Fails the plan call, so generateSet stops after the one prompt this test reads.
      const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => {
        prompts.push(request.prompt);
        return { ok: false as const, error: "stopped after planning", attempts: [] };
      });
      await expect(generateSet("speaking", { runSkillTask: runSkillTask as never }))
        .rejects.toThrow("stopped after planning");
    } finally {
      productionGenerationPlanner.release(held.reservationId);
    }

    expect(prompts).toHaveLength(1);
    expect(parsePayload(prompts[0]).catalog.some(
      ({ setId }) => setId === "pending:concurrent-job",
    )).toBe(true);
  });
});
