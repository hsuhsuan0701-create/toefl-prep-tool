import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { AttemptDetailVM, AttemptListVM, ReadingSet, StatsSummaryVM, WritingSet } from "@toefl-prep/shared";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { buildStatsRoutes } from "../src/routes/stats.js";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { config } from "../src/lib/config.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import { LOWER_PATH_BAND_CAP } from "../src/services/bandEstimator.js";
import { READING_FIXTURE } from "./fixtures/reading-set.fixture.js";
import { listSets } from "../src/routes/sets.js";
import {
  createRepoSupersededSetIdsReader,
  setSupersededSetIdsReader,
  supersededSetIds,
} from "../src/services/supersession.js";

// READING_FIXTURE under this file's own Set id, written into this file's copy of the bank, with its
// second Modules completed to the Module composition (READING_MODULE_COMPOSITION). The shared
// fixture's Lower and Upper Modules hold one Daily Life text each, and a band needs every Module an
// Attempt took to carry an Item of each Task Type its composition names. The added Stimuli copy the
// Router's under ids of their own (ctw-lo-1-g1..g10 and ap-lo-1-q1..5 in the Lower Module,
// ctw-up-1-* and ap-up-1-* in the Upper); every other Item id (dl-1-q1, ctw-1-g1..g10, ap-1-q1..5,
// dl-lo-1-*, dl-up-1-*) is the fixture's. The Upper Module keeps its Daily Life text, as older banked
// Sets do.
const SET_ID = "rd-r7attempts1";
function renamed<T>(stimulus: T, from: string, to: string): T {
  return JSON.parse(JSON.stringify(stimulus).replaceAll(`"${from}`, `"${to}`)) as T;
}
const ROUTER = READING_FIXTURE.router;
const READING_SET: ReadingSet = {
  ...READING_FIXTURE,
  id: SET_ID,
  lowerModule: {
    ...READING_FIXTURE.lowerModule,
    ctwPassages: [renamed(ROUTER.ctwPassages[0]!, "ctw-1", "ctw-lo-1")],
    academic: [renamed(ROUTER.academic[0]!, "ap-1", "ap-lo-1")],
  },
  upperModule: {
    ...READING_FIXTURE.upperModule,
    ctwPassages: [renamed(ROUTER.ctwPassages[0]!, "ctw-1", "ctw-up-1")],
    academic: [renamed(ROUTER.academic[0]!, "ap-1", "ap-up-1")],
  },
};

// A minimal Writing Set, for the tests that need an Attempt whose kind is not reading.
const WRITING_SET_ID = "wri-r7kindtest1";
const WRITING_SET: WritingSet = {
  id: WRITING_SET_ID, kind: "writing", source: "generated", createdAt: "2026-08-09T00:00:00.000Z",
  buildASentence: {
    items: Array.from({ length: 10 }, (_, i) => ({
      id: `bs${i + 1}`, prompt: `P${i + 1}?`, tiles: ["a", "b", "c"], answers: [["a", "b", "c"]],
    })),
  },
  email: { id: "email1", scenario: "s", to: "t@u.edu", subject: "x", bullets: ["1", "2", "3"], timeLimitSec: 420, wordGuidance: { min: 80, max: 120 } },
  academicDiscussion: {
    id: "ad1", courseTitle: "c", professorName: "p", professorPost: "q",
    studentPosts: [{ name: "A", post: "y" }, { name: "B", post: "n" }], timeLimitSec: 600, minWords: 100,
  },
};

// A Set whose Router Module is empty. The persisted ReadingModuleSchema bounds no Stimulus count
// (generation does), so a malformed Set can reach the route with no router Items. Routing it is a
// 500: never decidePath(0, 0)'s NaN routerRaw read as a "lower" decision, and never a 409 for
// missing Items.
const EMPTY_ROUTER_SET_ID = "rd-r8emptyrouter1";
const EMPTY_ROUTER_SET: ReadingSet = {
  id: EMPTY_ROUTER_SET_ID, kind: "reading", source: "generated", createdAt: "2026-08-09T00:00:00.000Z",
  router: { timeLimitSec: 1200, ctwPassages: [], dailyLife: [], academic: [] },
  lowerModule: { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] },
  upperModule: { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] },
};

beforeAll(() => {
  const readingDir = path.join(config.dataDir, "question-sets/reading");
  fs.mkdirSync(readingDir, { recursive: true });
  fs.writeFileSync(path.join(readingDir, `${SET_ID}.json`), JSON.stringify(READING_SET));
  fs.writeFileSync(path.join(readingDir, `${EMPTY_ROUTER_SET_ID}.json`), JSON.stringify(EMPTY_ROUTER_SET));
  const writingDir = path.join(config.dataDir, "question-sets/writing");
  fs.mkdirSync(writingDir, { recursive: true });
  fs.writeFileSync(path.join(writingDir, `${WRITING_SET_ID}.json`), JSON.stringify(WRITING_SET));
  return () => {
    fs.rmSync(path.join(readingDir, `${SET_ID}.json`), { force: true });
    fs.rmSync(path.join(readingDir, `${EMPTY_ROUTER_SET_ID}.json`), { force: true });
    fs.rmSync(path.join(writingDir, `${WRITING_SET_ID}.json`), { force: true });
  };
});

// The routes.attempts.test.ts harness, pared down: Reading scoring touches no Judge, Arbiter or
// transcription, so the coordinators need nothing but the repo.
function buildTestApp() {
  const testRepo = sqliteStores(openDb(":memory:"));
  const coordinators = createSpeakingCoordinators({ repo: testRepo });
  const app = buildAttemptsRoutes({ repo: testRepo, ...coordinators });
  return { app, repo: testRepo };
}

async function createAttempt(
  app: ReturnType<typeof buildAttemptsRoutes>,
  opts: { kind: "reading" | "writing"; mode: "drill" | "simulation"; setId: string }
) {
  const res = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  return (await res.json()) as { attemptId: string; isRepeat: boolean };
}

async function postScore(app: ReturnType<typeof buildAttemptsRoutes>, attemptId: string, body: unknown) {
  return app.request(`/${attemptId}/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function postRoute(app: ReturnType<typeof buildAttemptsRoutes>, attemptId: string) {
  return app.request(`/${attemptId}/route`, { method: "POST" });
}

async function postComplete(app: ReturnType<typeof buildAttemptsRoutes>, attemptId: string) {
  return app.request(`/${attemptId}/complete`, { method: "POST" });
}

// The fixture's Router Module holds 17 Items: ctw-1's 10 gaps, dl-1's 2 questions and ap-1's 5.
// This answers 11 right (7 gaps, 0 of dl-1, 4 of ap-1), a mix rather than all correct, so a census
// that counted rows instead of correct rows would be caught. 11/17 = 0.647 clears
// ROUTER_PROMOTION_THRESHOLD (0.6), so the Attempt routes "upper".
async function scoreAllRouterItemsElevenOfSeventeenCorrect(
  app: ReturnType<typeof buildAttemptsRoutes>,
  attemptId: string
) {
  await postScore(app, attemptId, {
    taskType: "daily_life",
    items: [
      { itemId: "dl-1-q1", selectedOptionId: "b" }, // correct is "a" — wrong
      { itemId: "dl-1-q2", selectedOptionId: "a" }, // correct is "b" — wrong
    ],
  });
  await postScore(app, attemptId, {
    taskType: "academic_passage",
    items: [
      { itemId: "ap-1-q1", selectedOptionId: "a" }, // correct is "b" — wrong
      { itemId: "ap-1-q2", selectedOptionId: "a" }, // correct
      { itemId: "ap-1-q3", selectedOptionId: "c" }, // correct
      { itemId: "ap-1-q4", selectedOptionId: "a" }, // correct
      { itemId: "ap-1-q5", selectedOptionId: "b" }, // correct
    ],
  });
  const completions = ["ght", "vival", "wings", "oup", "ivity", "pose", "sic", "vine", "esion", "ncing"];
  await postScore(app, attemptId, {
    taskType: "complete_words",
    items: completions.map((completion, i) => ({
      itemId: `ctw-1-g${i + 1}`,
      typed: i < 7 ? completion : "WRONG", // g1..g7 correct, g8..g10 wrong
    })),
  });
}

// Answers 10 of the 17 router Items right (both of dl-1, all 5 of ap-1, 3 of ctw-1's gaps). 10/17
// = 0.588 is just under ROUTER_PROMOTION_THRESHOLD (0.6): the most a router can score and still
// route "lower".
async function scoreAllRouterItemsTenOfSeventeenCorrect(
  app: ReturnType<typeof buildAttemptsRoutes>,
  attemptId: string
) {
  await postScore(app, attemptId, {
    taskType: "daily_life",
    items: [
      { itemId: "dl-1-q1", selectedOptionId: "a" }, // correct
      { itemId: "dl-1-q2", selectedOptionId: "b" }, // correct
    ],
  });
  await postScore(app, attemptId, {
    taskType: "academic_passage",
    items: [
      { itemId: "ap-1-q1", selectedOptionId: "b" }, // correct
      { itemId: "ap-1-q2", selectedOptionId: "a" }, // correct
      { itemId: "ap-1-q3", selectedOptionId: "c" }, // correct
      { itemId: "ap-1-q4", selectedOptionId: "a" }, // correct
      { itemId: "ap-1-q5", selectedOptionId: "b" }, // correct
    ],
  });
  const completions = ["ght", "vival", "wings", "oup", "ivity", "pose", "sic", "vine", "esion", "ncing"];
  await postScore(app, attemptId, {
    taskType: "complete_words",
    items: completions.map((completion, i) => ({
      itemId: `ctw-1-g${i + 1}`,
      typed: i < 3 ? completion : "WRONG", // g1..g3 correct, g4..g10 wrong
    })),
  });
}

// Answers every Item of one second Module right: its Daily Life text's 2 questions, its 10 gaps and
// its Academic Passage's 5 questions, 17 in all.
async function scoreWholeSecondModuleCorrectly(app: ReturnType<typeof buildAttemptsRoutes>, attemptId: string, module: "lower" | "upper") {
  const tag = module === "lower" ? "lo" : "up";
  const dailyLifeKeys = module === "lower" ? ["c", "a"] : ["b", "c"];
  const responses = [
    await postScore(app, attemptId, {
      taskType: "daily_life",
      items: dailyLifeKeys.map((key, i) => ({ itemId: `dl-${tag}-1-q${i + 1}`, selectedOptionId: key })),
    }),
    await postScore(app, attemptId, {
      taskType: "complete_words",
      items: ["ght", "vival", "wings", "oup", "ivity", "pose", "sic", "vine", "esion", "cing"].map((typed, i) => ({ itemId: `ctw-${tag}-1-g${i + 1}`, typed })),
    }),
    await postScore(app, attemptId, {
      taskType: "academic_passage",
      items: ["b", "a", "c", "a", "b"].map((key, i) => ({ itemId: `ap-${tag}-1-q${i + 1}`, selectedOptionId: key })),
    }),
  ];
  for (const res of responses) expect(res.status).toBe(200);
}

describe("reading deterministic scoring route", () => {
  it("scores a drill MCQ batch synchronously with keys and 錯題解析", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "drill", setId: SET_ID });
    const res = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [
        { itemId: "dl-1-q1", selectedOptionId: "a" },
        { itemId: "dl-1-q2", selectedOptionId: "c" },
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([
      expect.objectContaining({ itemId: "dl-1-q1", correct: true, key: "a" }),
      expect.objectContaining({ itemId: "dl-1-q2", correct: false, key: "b", explanationZh: expect.stringContaining("題目") }),
    ]);
  });

  it("returns bare correctness in simulation mode — no key, no explanationZh", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
    const res = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-1-q1", selectedOptionId: "a" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items[0]).toEqual({ itemId: "dl-1-q1", correct: true });
  });

  it("scores typed CtW gaps case-sensitively", async () => {
    const { app: appWrong } = buildTestApp();
    const { attemptId: wrongAttempt } = await createAttempt(appWrong, { kind: "reading", mode: "drill", setId: SET_ID });
    const wrongRes = await postScore(appWrong, wrongAttempt, {
      taskType: "complete_words",
      items: [{ itemId: "ctw-1-g1", typed: "Ght" }], // completion is "ght" — wrong case
    });
    expect(wrongRes.status).toBe(200);
    expect(((await wrongRes.json()) as { items: { correct: boolean }[] }).items[0]).toMatchObject({ correct: false });

    const { app: appRight } = buildTestApp();
    const { attemptId: rightAttempt } = await createAttempt(appRight, { kind: "reading", mode: "drill", setId: SET_ID });
    const rightRes = await postScore(appRight, rightAttempt, {
      taskType: "complete_words",
      items: [{ itemId: "ctw-1-g1", typed: "ght" }],
    });
    expect(rightRes.status).toBe(200);
    const rightBody = (await rightRes.json()) as { items: { correct: boolean; key: string }[] };
    expect(rightBody.items[0]).toMatchObject({ correct: true, key: "ght" });
  });

  it("scores the unanswered sentinel as wrong", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "drill", setId: SET_ID });
    const res = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-1-q1", selectedOptionId: "__none__" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { correct: boolean }[] };
    expect(body.items[0]).toMatchObject({ itemId: "dl-1-q1", correct: false });
  });

  it("404s on an unknown itemId, before any write", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "drill", setId: SET_ID });
    const res = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-1-q1", selectedOptionId: "a" }, { itemId: "no-such-item", selectedOptionId: "a" }],
    });
    expect(res.status).toBe(404);
    // No partial write: dl-1-q1, ahead of the unknown id, is not scored either.
    expect(testRepo.getAttempt(attemptId)!.items).toHaveLength(0);
  });

  it("409s on re-scoring an already-scored item, marked alreadyScored:true", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "drill", setId: SET_ID });
    const first = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-1-q1", selectedOptionId: "a" }],
    });
    expect(first.status).toBe(200);
    const second = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-1-q1", selectedOptionId: "b" }],
    });
    expect(second.status).toBe(409);
    // The marker lets a retrying client tell "the server already has this" (accepted) from a real
    // conflict it must not swallow, a kind mismatch or a locked Module (both below).
    expect((await second.json()) as { alreadyScored?: boolean }).toMatchObject({ alreadyScored: true });
  });

  it("does NOT mark a KindMismatchError 409 as alreadyScored — a genuine conflict, not evidence the data landed", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "writing", mode: "drill", setId: WRITING_SET_ID });
    const res = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-1-q1", selectedOptionId: "a" }],
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { alreadyScored?: boolean }).not.toHaveProperty("alreadyScored");
  });

  it("does NOT mark a ModuleLockedError 409 as alreadyScored — a genuine conflict, not evidence the data landed", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
    testRepo.setAttemptRouting(attemptId, "upper", 0.7);
    const res = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-1-q1", selectedOptionId: "a" }], // router item — locked out post-routing
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { alreadyScored?: boolean }).not.toHaveProperty("alreadyScored");
  });

  // A Simulation sits its Modules in order, so nothing of a second Module can be scored before the
  // Router has decided which one the User takes.
  it("refuses a second-Module Item before a Simulation has routed, and writes nothing", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
    const res = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-up-1-q1", selectedOptionId: "b" }],
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { alreadyScored?: boolean }).not.toHaveProperty("alreadyScored");
    expect(testRepo.getAttempt(attemptId)!.items).toHaveLength(0);
  });

  it("holds a Drill to no Module order: it has no Module Path to be routed to", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "drill", setId: SET_ID });
    const res = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-up-1-q1", selectedOptionId: "b" }],
    });
    expect(res.status).toBe(200);
  });

  // The band is the percent correct over the Modules the Attempt took. A row tagged with the Module
  // it was not routed to belongs to no part of this sitting and must not move the band.
  it("leaves an Item of the Module the Attempt was not routed to out of the band", async () => {
    const sitLowerPath = async (withStrayUpperRow: boolean) => {
      const { app, repo: testRepo } = buildTestApp();
      const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
      await scoreAllRouterItemsTenOfSeventeenCorrect(app, attemptId);
      expect(((await (await postRoute(app, attemptId)).json()) as { path: string }).path).toBe("lower");
      await scoreWholeSecondModuleCorrectly(app, attemptId, "lower");
      if (withStrayUpperRow) {
        testRepo.scoreDeterministicItemsBatch([
          { attemptId, itemId: "ap-up-1-q1", taskType: "academic_passage", score: 0, scoreJson: JSON.stringify({ correct: false, module: "upper", answer: "a" }) },
        ]);
      }
      const completed = (await (await postComplete(app, attemptId)).json()) as { estimate: { raw: number; band: number } | null };
      return completed.estimate;
    };

    const clean = await sitLowerPath(false);
    const withStray = await sitLowerPath(true);
    expect(clean).not.toBeNull();
    expect(withStray).toEqual(clean);
  });

  it("409s the WHOLE request when only ONE of several items is already scored — no partial writes", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "drill", setId: SET_ID });
    const first = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-1-q1", selectedOptionId: "a" }],
    });
    expect(first.status).toBe(200);

    const second = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [
        { itemId: "dl-1-q2", selectedOptionId: "b" }, // fresh — would otherwise score fine
        { itemId: "dl-1-q1", selectedOptionId: "a" }, // already scored — conflicts
      ],
    });
    expect(second.status).toBe(409);
    // dl-1-q2 was never written despite being scoreable on its own.
    const items = testRepo.getAttempt(attemptId)!.items;
    expect(items.map((i) => i.item_id)).toEqual(["dl-1-q1"]);
  });

  it("409s a reading task type submitted against a non-reading attempt", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "writing", mode: "drill", setId: WRITING_SET_ID });
    const res = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-1-q1", selectedOptionId: "a" }],
    });
    expect(res.status).toBe(409);
  });

  it("tags score_json with correct/skill/module/answer, module reflecting router vs lower vs upper, skill omitted for CtW", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "drill", setId: SET_ID });

    await postScore(app, attemptId, { taskType: "daily_life", items: [{ itemId: "dl-1-q1", selectedOptionId: "a" }] }); // router
    await postScore(app, attemptId, { taskType: "daily_life", items: [{ itemId: "dl-lo-1-q1", selectedOptionId: "c" }] }); // lowerModule
    await postScore(app, attemptId, { taskType: "daily_life", items: [{ itemId: "dl-up-1-q1", selectedOptionId: "b" }] }); // upperModule
    await postScore(app, attemptId, { taskType: "complete_words", items: [{ itemId: "ctw-1-g1", typed: "ght" }] }); // router, CtW

    const items = testRepo.getAttempt(attemptId)!.items;
    const byId = new Map(items.map((i) => [i.item_id, JSON.parse(i.score_json!) as Record<string, unknown>]));

    expect(byId.get("dl-1-q1")).toEqual({ correct: true, skill: "detail", module: "router", answer: "a" });
    expect(byId.get("dl-lo-1-q1")).toEqual({ correct: true, skill: "detail", module: "lower", answer: "c" });
    expect(byId.get("dl-up-1-q1")).toEqual({ correct: true, skill: "detail", module: "upper", answer: "b" });
    expect(byId.get("ctw-1-g1")).toEqual({ correct: true, module: "router", answer: "ght" });
    expect(byId.get("ctw-1-g1")).not.toHaveProperty("skill");
  });
});

describe("POST /:id/route", () => {
  it("404s for an unknown attempt", async () => {
    const { app } = buildTestApp();
    const res = await postRoute(app, "no-such-attempt");
    expect(res.status).toBe(404);
  });

  it("409s for a drill-mode attempt — routing is simulation-only", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "drill", setId: SET_ID });
    const res = await postRoute(app, attemptId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/simulation-only/);
    expect(testRepo.getAttempt(attemptId)!.module_path).toBeNull();
  });

  it("409s when the router module is not fully scored, listing the missing count (not ids)", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
    // Only dl-1's 2 router items are scored; ap-1's 5 and ctw-1's 10 (15 total) are not.
    await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [
        { itemId: "dl-1-q1", selectedOptionId: "a" },
        { itemId: "dl-1-q2", selectedOptionId: "b" },
      ],
    });
    const res = await postRoute(app, attemptId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/15/);
    expect(testRepo.getAttempt(attemptId)!.module_path).toBeNull();
  });

  it("computes and persists path+routerRaw once every router item is scored", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
    await scoreAllRouterItemsElevenOfSeventeenCorrect(app, attemptId);

    const res = await postRoute(app, attemptId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; routerRaw: number };
    expect(body).toEqual({ path: "upper", routerRaw: 11 / 17 });

    const attempt = testRepo.getAttempt(attemptId)!;
    expect(attempt.module_path).toBe("upper");
    expect(attempt.router_raw).toBe(11 / 17);

    const getRes = await app.request(`/${attemptId}`);
    const detail = (await getRes.json()) as { attempt: { modulePath: string; routerRaw: number } };
    expect(detail.attempt.modulePath).toBe("upper");
    expect(detail.attempt.routerRaw).toBe(11 / 17);
  });

  it("is idempotent: a second POST returns the SAME body, without recomputing or rewriting", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
    await scoreAllRouterItemsElevenOfSeventeenCorrect(app, attemptId);

    const first = await postRoute(app, attemptId);
    expect(first.status).toBe(200);
    const firstBody = await first.json();

    // Counts calls to the real repo's routing write, which a second POST must not make. The route
    // holds this same `testRepo` and reads `setAttemptRouting` off it per call, so reassigning the
    // property is visible to the route.
    let setAttemptRoutingCalls = 0;
    const original = testRepo.setAttemptRouting.bind(testRepo);
    testRepo.setAttemptRouting = ((...args: Parameters<typeof testRepo.setAttemptRouting>) => {
      setAttemptRoutingCalls += 1;
      return original(...args);
    }) as typeof testRepo.setAttemptRouting;

    // One more Item in the selected Module between the two POSTs (scoring stays open there after
    // routing) must not move the second POST's routerRaw.
    const midScore = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-up-1-q1", selectedOptionId: "b" }],
    });
    expect(midScore.status).toBe(200);

    const second = await postRoute(app, attemptId);
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody).toEqual(firstBody);
    expect(setAttemptRoutingCalls).toBe(0);
  });

  it("409s for a completed or discarded Simulation that was never routed, and writes no Module Path", async () => {
    const { app, repo: testRepo } = buildTestApp();
    for (const end of ["complete", "abort"] as const) {
      const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
      // Every Router Item scored, so only the Attempt's status stands between it and a decision.
      await scoreAllRouterItemsElevenOfSeventeenCorrect(app, attemptId);
      const ended = await app.request(`/${attemptId}/${end}`, { method: "POST" });
      expect(ended.status).toBe(200);

      const res = await postRoute(app, attemptId);
      expect(res.status).toBe(409);
      const attempt = testRepo.getAttempt(attemptId)!;
      expect(attempt.module_path).toBeNull();
      expect(attempt.router_raw).toBeNull();
    }
  });

  it("still answers a routed Attempt's stored decision after it has ended", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
    await scoreAllRouterItemsElevenOfSeventeenCorrect(app, attemptId);
    const first = await postRoute(app, attemptId);
    expect(first.status).toBe(200);
    expect((await postComplete(app, attemptId)).status).toBe(200);

    const replay = await postRoute(app, attemptId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ path: "upper", routerRaw: 11 / 17 });
  });

  it("locks the router module once routed: scoring a router item returns 409", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
    testRepo.setAttemptRouting(attemptId, "upper", 0.7);

    const res = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-1-q1", selectedOptionId: "a" }], // router item — never scored
    });
    expect(res.status).toBe(409);
  });

  it("locks out the NON-selected module once routed", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
    testRepo.setAttemptRouting(attemptId, "upper", 0.7);

    const res = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-lo-1-q1", selectedOptionId: "c" }], // lowerModule item, routed to upper
    });
    expect(res.status).toBe(409);
  });

  it("allows scoring the SELECTED module's items once routed", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
    testRepo.setAttemptRouting(attemptId, "upper", 0.7);

    const res = await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-up-1-q1", selectedOptionId: "b" }], // upperModule item, routed to upper
    });
    expect(res.status).toBe(200);
  });

  it("500s (never a silent NaN/false 'lower') when the router census is empty — an invariant violation, not a routing decision", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: EMPTY_ROUTER_SET_ID });
    const res = await postRoute(app, attemptId);
    expect(res.status).toBe(500);
    expect(testRepo.getAttempt(attemptId)!.module_path).toBeNull();
  });
});

// /complete estimates a Reading (or Listening) Attempt with Table 3 (table3-v1), and only a routed
// Simulation, one POST /:id/route gave a module_path, gets a Band Estimate (ADR 0005). A Drill, or a
// Simulation never routed, completes with no estimate row.
describe("POST /:id/complete — reading dispatch", () => {
  it("a routed simulation persists a table3-v1 section_estimates row using the attempt's own module_path", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
    // 11/17 router Items correct -> routes "upper".
    await scoreAllRouterItemsElevenOfSeventeenCorrect(app, attemptId);
    const routeRes = await postRoute(app, attemptId);
    expect(routeRes.status).toBe(200);
    expect(testRepo.getAttempt(attemptId)!.module_path).toBe("upper");

    // All 17 Upper Module Items right: 28/34 correct -> scaled round(28/34 * 30) = 25 -> Table 3's
    // reading row {minScaled: 24, band: 5} (the next row up, minScaled 27, is not reached).
    await scoreWholeSecondModuleCorrectly(app, attemptId, "upper");

    const res = await postComplete(app, attemptId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; estimate?: { section: string; band: number; method: string; raw: number } };
    expect(body.status).toBe("completed");
    expect(body.estimate).toMatchObject({ section: "reading", band: 5, method: "table3-v1" });
    expect(body.estimate!.raw).toBeCloseTo(28 / 34);

    const persisted = testRepo.getSectionEstimate(attemptId);
    expect(persisted).toBeDefined();
    expect(persisted!.section).toBe("reading");
    expect(persisted!.estimatedBand).toBe(5);
    expect(persisted!.method).toBe("table3-v1");
  });

  it("a reading DRILL completes with items scored, but persists NO section_estimates row", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "drill", setId: SET_ID });
    await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-1-q1", selectedOptionId: "a" }],
    });

    const res = await postComplete(app, attemptId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; estimate?: unknown };
    expect(body).toEqual({ status: "completed" });
    expect(body.estimate).toBeUndefined();
    expect(testRepo.getSectionEstimate(attemptId)).toBeUndefined();
    expect(testRepo.getAttempt(attemptId)!.status).toBe("completed");
  });

  it("a simulation completed BEFORE routing (module_path still null) persists NO section_estimates row", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
    // Router Items scored, but POST /:id/route never called: module_path stays null.
    await postScore(app, attemptId, {
      taskType: "daily_life",
      items: [{ itemId: "dl-1-q1", selectedOptionId: "a" }],
    });
    expect(testRepo.getAttempt(attemptId)!.module_path).toBeNull();

    const res = await postComplete(app, attemptId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; estimate?: unknown };
    expect(body).toEqual({ status: "completed" });
    expect(testRepo.getSectionEstimate(attemptId)).toBeUndefined();
  });

  // bandEstimator.test.ts proves estimateBandTable3 applies LOWER_PATH_BAND_CAP; this proves
  // /complete hands it the Attempt's module_path ("lower").
  it("a routed LOWER-path simulation caps its table3-v1 Band Estimate at LOWER_PATH_BAND_CAP even though raw performance would otherwise clear it", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });

    // 10/17 router Items correct, just under the 0.6 Promotion Threshold -> routes "lower".
    await scoreAllRouterItemsTenOfSeventeenCorrect(app, attemptId);
    const routeRes = await postRoute(app, attemptId);
    expect(routeRes.status).toBe(200);
    expect(testRepo.getAttempt(attemptId)!.module_path).toBe("lower");

    // All 17 Lower Module Items answered right through the real endpoint: 27/34 correct -> scaled
    // round(27/34 * 30) = 24 -> Table 3's row {minScaled: 24, band: 5}. Uncapped the band would be
    // 5, so the 4.5 below is the cap itself.
    await scoreWholeSecondModuleCorrectly(app, attemptId, "lower");

    const res = await postComplete(app, attemptId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      estimate?: { section: string; band: number; method: string; raw: number };
    };
    expect(body.status).toBe("completed");
    expect(LOWER_PATH_BAND_CAP).toBe(4.5); // the constant this test's premise rests on
    expect(body.estimate).toMatchObject({ section: "reading", band: LOWER_PATH_BAND_CAP, method: "table3-v1" });
    expect(body.estimate!.raw).toBeCloseTo(27 / 34);

    const persisted = testRepo.getSectionEstimate(attemptId);
    expect(persisted).toBeDefined();
    expect(persisted!.section).toBe("reading");
    expect(persisted!.estimatedBand).toBe(LOWER_PATH_BAND_CAP);
    expect(persisted!.method).toBe("table3-v1");
  });
});

// A routed Simulation's band needs Items of both Modules it took. The Router Module carries every
// Task Type of the section, so a Simulation routed and then finished ("Finish and score" in the
// Attempt log) before its second Module would otherwise read as a whole sitting: a perfect Router
// alone would be band 6 and the section's headline.
describe("a routed Simulation finished before its second Module", () => {
  async function routedRouterOnly(app: ReturnType<typeof buildAttemptsRoutes>) {
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
    await scoreAllRouterItemsElevenOfSeventeenCorrect(app, attemptId);
    expect(await (await postRoute(app, attemptId)).json()).toMatchObject({ path: "upper" });
    return attemptId;
  }

  const UPPER_NEVER_SAT = {
    status: "incomplete",
    unscored: [],
    absent: [],
    moduleShortfalls: [{ module: "upper", sat: false, absent: ["complete_words", "academic_passage"] }],
  };

  it("completes with no band, and its review names the Module it never sat", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const attemptId = await routedRouterOnly(app);

    const res = await postComplete(app, attemptId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "completed" });
    expect(testRepo.getSectionEstimate(attemptId)).toBeUndefined();

    const detail = (await (await app.request(`/${attemptId}`)).json()) as AttemptDetailVM;
    expect(detail.estimate).toBeNull();
    expect(detail.bandStatus).toEqual(UPPER_NEVER_SAT);
  });

  it("a band persisted for it under the section-wide rule surfaces nowhere: review, Attempt log or Dashboard", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const stats = buildStatsRoutes({ repo: testRepo });
    const attemptId = await routedRouterOnly(app);
    expect((await postComplete(app, attemptId)).status).toBe(200);
    // The row the section-wide rule wrote for this Attempt: its coverage spans every Task Type.
    testRepo.saveSectionEstimate({
      attemptId,
      section: "reading",
      rawDetail: JSON.stringify({ raw: 11 / 17, coverage: ["complete_words", "daily_life", "academic_passage"].map((taskType) => ({ taskType, itemCount: 1, skippedCount: 0 })) }),
      estimatedBand: 4,
      method: "table3-v1",
    });

    const detail = (await (await app.request(`/${attemptId}`)).json()) as AttemptDetailVM;
    expect(detail.estimate).toBeNull();
    expect(detail.bandStatus).toEqual(UPPER_NEVER_SAT);
    const log = (await (await app.request("/")).json()) as AttemptListVM;
    expect(log.items.find((a) => a.id === attemptId)!.estimate).toBeNull();
    const summary = (await (await stats.request("/summary")).json()) as StatsSummaryVM;
    expect(summary.sections.find((s) => s.section === "reading")).toBeUndefined();
    expect(summary.overall.missingSections).toContain("reading");
  });
});

// GET /:id attaches deterministicReview (each Item's key and 錯題解析, re-derived from the Set) for
// every Item once the Attempt is completed. Before that, a Drill gets it for the Items it has
// scored (its own score responses showed them already), and a Simulation gets none: its keys and
// Explanations reach the client only after the Attempt completes.
describe("GET /:id — deterministicReview", () => {
  it("is absent for an in-progress Drill with nothing scored, and for an unfinished Simulation", async () => {
    const { app } = buildTestApp();
    const { attemptId: drillId } = await createAttempt(app, { kind: "reading", mode: "drill", setId: SET_ID });
    const drillBody = (await (await app.request(`/${drillId}`)).json()) as { deterministicReview?: unknown };
    expect(drillBody).not.toHaveProperty("deterministicReview");

    const { attemptId: simId } = await createAttempt(app, { kind: "reading", mode: "simulation", setId: SET_ID });
    const scored = await postScore(app, simId, { taskType: "daily_life", items: [{ itemId: "dl-1-q1", selectedOptionId: "b" }] });
    expect(scored.status).toBe(200);
    const simBody = (await (await app.request(`/${simId}`)).json()) as AttemptDetailVM;
    expect(simBody.items.map((item) => item.itemId)).toContain("dl-1-q1");
    expect(simBody).not.toHaveProperty("deterministicReview");

    // A discarded Simulation stays without it too.
    expect((await app.request(`/${simId}/abort`, { method: "POST" })).status).toBe(200);
    const abortedBody = (await (await app.request(`/${simId}`)).json()) as AttemptDetailVM;
    expect(abortedBody.attempt.status).toBe("aborted");
    expect(abortedBody).not.toHaveProperty("deterministicReview");
  });

  it("covers an unfinished Drill's scored Items only, and every Item once completed", async () => {
    const { app, repo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "drill", setId: SET_ID });
    await postScore(app, attemptId, { taskType: "daily_life", items: [{ itemId: "dl-1-q1", selectedOptionId: "b" }] }); // wrong (key is "a")
    await postScore(app, attemptId, { taskType: "complete_words", items: [{ itemId: "ctw-1-g1", typed: "ght" }] }); // correct
    // An Item of the Set that has a row but no score: its key and Explanation were never shown.
    const unscored = READING_FIXTURE.router.academic[0].questions[0].id;
    repo.insertItemResult({ attemptId, itemId: unscored, taskType: "academic_passage", scoringStatus: "pending" });

    const before = await app.request(`/${attemptId}`);
    const beforeBody = (await before.json()) as AttemptDetailVM;
    expect(beforeBody.attempt.status).toBe("in_progress");
    expect(beforeBody.items.map((item) => item.itemId)).toContain(unscored);
    expect(beforeBody.deterministicReview!.map((i) => i.itemId).sort()).toEqual(["ctw-1-g1", "dl-1-q1"]);
    const reviewBefore = new Map(beforeBody.deterministicReview!.map((i) => [i.itemId, i]));
    expect(reviewBefore.get("dl-1-q1")).toMatchObject({ taskType: "daily_life", correct: false, key: "a" });
    expect(reviewBefore.get("dl-1-q1")!.explanationZh).toMatch(/題目/);
    expect(JSON.stringify(beforeBody)).not.toContain(READING_FIXTURE.router.academic[0].questions[0].explanationZh);

    // The same holds once the Drill is discarded: what it scored stays reviewable.
    const { attemptId: discardedId } = await createAttempt(app, { kind: "reading", mode: "drill", setId: SET_ID });
    await postScore(app, discardedId, { taskType: "daily_life", items: [{ itemId: "dl-1-q1", selectedOptionId: "a" }] });
    expect((await app.request(`/${discardedId}/abort`, { method: "POST" })).status).toBe(200);
    const discarded = (await (await app.request(`/${discardedId}`)).json()) as AttemptDetailVM;
    expect(discarded.attempt.status).toBe("aborted");
    expect(discarded.deterministicReview).toEqual([expect.objectContaining({ itemId: "dl-1-q1", correct: true, key: "a" })]);

    const completeRes = await postComplete(app, attemptId);
    expect(completeRes.status).toBe(200);

    const after = await app.request(`/${attemptId}`);
    const afterBody = (await after.json()) as {
      deterministicReview?: Array<{ itemId: string; taskType: string; correct: boolean; key?: string; explanationZh?: string }>;
    };
    expect(afterBody.deterministicReview).toBeDefined();
    const byId = new Map(afterBody.deterministicReview!.map((i) => [i.itemId, i]));
    expect(byId.get("dl-1-q1")).toMatchObject({ taskType: "daily_life", correct: false, key: "a" });
    expect(byId.get("dl-1-q1")!.explanationZh).toMatch(/題目/);
    expect(byId.get("ctw-1-g1")).toMatchObject({ taskType: "complete_words", correct: true, key: "ght" });
  });

  // A retired Set leaves the picker, and past Attempts on it keep their review. The handler omits
  // deterministicReview when readSet comes back empty, so that a display detail never 500s an
  // Attempt; if supersession ever hid a Set from readSet as it does from listSets, every retired
  // Set's 錯題解析 would vanish from review with nothing failing. Both halves are asserted together,
  // since a broken implementation can satisfy either alone.
  it("survives its Set being superseded: hidden from the picker, still fully reviewable", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "reading", mode: "drill", setId: SET_ID });
    await postScore(app, attemptId, { taskType: "daily_life", items: [{ itemId: "dl-1-q1", selectedOptionId: "b" }] });
    expect((await postComplete(app, attemptId)).status).toBe(200);

    // The Set is in the picker first, so the `not.toContain` below cannot pass merely because the
    // fixture never reached the data directory.
    expect(listSets(config.dataDir).map((s) => s.id)).toContain(SET_ID);

    const retirementRepo = sqliteStores(openDb(":memory:"));
    retirementRepo.supersedeSet({ setId: SET_ID, supersededBy: "rd-r7attempts1-replacement" });
    setSupersededSetIdsReader(createRepoSupersededSetIdsReader(retirementRepo));
    try {
      // Gone from the practice picker...
      expect(listSets(config.dataDir, supersededSetIds()).map((s) => s.id)).not.toContain(SET_ID);

      // ...and the past Attempt reviews exactly as it did before, key and 錯題解析 included.
      const body = (await (await app.request(`/${attemptId}`)).json()) as {
        deterministicReview?: Array<{ itemId: string; correct: boolean; key?: string; explanationZh?: string }>;
      };
      expect(body.deterministicReview).toBeDefined();
      const item = body.deterministicReview!.find((i) => i.itemId === "dl-1-q1");
      expect(item).toMatchObject({ correct: false, key: "a" });
      expect(item!.explanationZh).toMatch(/題目/);
    } finally {
      setSupersededSetIdsReader(null);
    }
  });

  it("is absent for a completed writing attempt (deterministic review is Reading/Listening-only)", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "writing", mode: "drill", setId: WRITING_SET_ID });
    const completeRes = await postComplete(app, attemptId);
    expect(completeRes.status).toBe(200);

    const res = await app.request(`/${attemptId}`);
    const body = (await res.json()) as { deterministicReview?: unknown };
    expect(body.deterministicReview).toBeUndefined();
  });
});
