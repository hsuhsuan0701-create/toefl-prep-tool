import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { WritingSet } from "@toefl-prep/shared";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { config } from "../src/lib/config.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import {
  censusRouterItems,
  scoreDeterministicItems,
  type AttemptWithItems,
} from "../src/services/deterministicScoring.js";
import { NotFound } from "../src/services/scoreItems.js";
import { LISTENING_FIXTURE } from "./fixtures/listening-set.fixture.js";
import { READING_FIXTURE } from "./fixtures/reading-set.fixture.js";

// LISTENING_FIXTURE under this file's own Set id, written into this file's copy of the bank. Every
// Item id (lcr-1, conv-1-q1/q2, ann-1-q1/q2, talk-1-q1..q4, lcr-lo-1, talk-up-1-q1..q4) is the
// fixture's.
const SET_ID = "lsn-l2attempts1";
const LISTENING_SET = { ...LISTENING_FIXTURE, id: SET_ID };

// A minimal Writing Set, for the test that submits a Listening Task Type against an Attempt of
// another kind (deterministicScoring.ts's KindMismatchError).
const WRITING_SET_ID = "wri-l2kindtest1";
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

beforeAll(() => {
  const listeningDir = path.join(config.dataDir, "question-sets/listening");
  fs.mkdirSync(listeningDir, { recursive: true });
  fs.writeFileSync(path.join(listeningDir, `${SET_ID}.json`), JSON.stringify(LISTENING_SET));
  const writingDir = path.join(config.dataDir, "question-sets/writing");
  fs.mkdirSync(writingDir, { recursive: true });
  fs.writeFileSync(path.join(writingDir, `${WRITING_SET_ID}.json`), JSON.stringify(WRITING_SET));
  return () => {
    fs.rmSync(path.join(listeningDir, `${SET_ID}.json`), { force: true });
    fs.rmSync(path.join(writingDir, `${WRITING_SET_ID}.json`), { force: true });
  };
});

// The routes.attempts.test.ts harness, pared down: Listening scoring touches no Judge, Arbiter or
// transcription.
function buildTestApp() {
  const testRepo = sqliteStores(openDb(":memory:"));
  const coordinators = createSpeakingCoordinators({ repo: testRepo });
  const app = buildAttemptsRoutes({ repo: testRepo, ...coordinators });
  return { app, repo: testRepo };
}

async function createAttempt(
  app: ReturnType<typeof buildAttemptsRoutes>,
  opts: { kind: "listening" | "writing"; mode: "drill" | "simulation"; setId: string }
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

// The fixture's Router Module holds 9 Items: lcr-1, conv-1's 2 questions, ann-1's 2 and talk-1's 4.
// This answers 6 right, a mix across all four Task Types rather than all correct, so a census that
// counted rows instead of correct rows would be caught. 6/9 = 0.667 clears
// ROUTER_PROMOTION_THRESHOLD (0.6), so the Attempt routes "upper".
async function scoreAllRouterItemsSixOfNineCorrect(app: ReturnType<typeof buildAttemptsRoutes>, attemptId: string) {
  await postScore(app, attemptId, { taskType: "listen_choose", items: [{ itemId: "lcr-1", selectedOptionId: "a" }] }); // correct
  await postScore(app, attemptId, {
    taskType: "conversation",
    items: [
      { itemId: "conv-1-q1", selectedOptionId: "a" }, // correct
      { itemId: "conv-1-q2", selectedOptionId: "a" }, // correct is "b" — wrong
    ],
  });
  await postScore(app, attemptId, {
    taskType: "announcement",
    items: [
      { itemId: "ann-1-q1", selectedOptionId: "c" }, // correct
      { itemId: "ann-1-q2", selectedOptionId: "b" }, // correct is "a" — wrong
    ],
  });
  await postScore(app, attemptId, {
    taskType: "academic_talk",
    items: [
      { itemId: "talk-1-q1", selectedOptionId: "b" }, // correct
      { itemId: "talk-1-q2", selectedOptionId: "a" }, // correct
      { itemId: "talk-1-q3", selectedOptionId: "c" }, // correct
      { itemId: "talk-1-q4", selectedOptionId: "a" }, // correct is "b" — wrong
    ],
  });
}

describe("listening deterministic scoring route", () => {
  // A Listen and Choose a Response utterance is never shown as text, even after the answer, as on
  // the exam. So unlike the other three Listening Task Types below, its scored Item carries no
  // `transcript` key at all.
  it("scores a drill listen_choose item with key + 錯題解析, and NO transcript (the utterance is never rendered as text, ETS rule)", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "listening", mode: "drill", setId: SET_ID });
    const res = await postScore(app, attemptId, {
      taskType: "listen_choose",
      items: [{ itemId: "lcr-1", selectedOptionId: "b" }], // correct is "a" — wrong
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items).toEqual([
      {
        itemId: "lcr-1", correct: false, key: "a",
        explanationZh: LISTENING_FIXTURE.router.listenChoose[0]!.explanationZh,
      },
    ]);
    expect(body.items[0]).not.toHaveProperty("transcript");
  });

  it("scores drill conversation items with the SAME formatted role transcript for every question in the conversation", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "listening", mode: "drill", setId: SET_ID });
    const res = await postScore(app, attemptId, {
      taskType: "conversation",
      items: [
        { itemId: "conv-1-q1", selectedOptionId: "a" }, // correct
        { itemId: "conv-1-q2", selectedOptionId: "b" }, // correct
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { itemId: string; transcript?: string; explanationZh?: string }[] };
    const expectedTranscript = "student: Could I still get the lunch special after two o'clock.\ncashier: We stop serving it at one-thirty, sorry about that.";
    expect(body.items).toEqual([
      { itemId: "conv-1-q1", correct: true, key: "a", explanationZh: expect.stringContaining("題目"), transcript: expectedTranscript },
      { itemId: "conv-1-q2", correct: true, key: "b", explanationZh: expect.stringContaining("題目"), transcript: expectedTranscript },
    ]);
  });

  it("scores drill announcement items with the flat prose transcript", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "listening", mode: "drill", setId: SET_ID });
    const res = await postScore(app, attemptId, {
      taskType: "announcement",
      items: [{ itemId: "ann-1-q1", selectedOptionId: "c" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { itemId: string; transcript?: string }[] };
    expect(body.items[0]).toMatchObject({
      itemId: "ann-1-q1", correct: true, key: "c",
      transcript: LISTENING_FIXTURE.router.announcements[0]!.transcript,
    });
  });

  it("scores drill academic_talk items — all four questions of one talk share its one transcript", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "listening", mode: "drill", setId: SET_ID });
    const res = await postScore(app, attemptId, {
      taskType: "academic_talk",
      items: [
        { itemId: "talk-1-q1", selectedOptionId: "b" },
        { itemId: "talk-1-q3", selectedOptionId: "x" }, // wrong (unanswered-shaped, still scored false)
      ],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { itemId: string; correct: boolean; transcript?: string }[] };
    const expectedTranscript = LISTENING_FIXTURE.router.academicTalks[0]!.transcript;
    expect(body.items[0]).toMatchObject({ itemId: "talk-1-q1", correct: true, transcript: expectedTranscript });
    expect(body.items[1]).toMatchObject({ itemId: "talk-1-q3", correct: false, transcript: expectedTranscript });
  });

  it("returns bare correctness in simulation mode — no key, no explanationZh, no transcript", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "listening", mode: "simulation", setId: SET_ID });
    const res = await postScore(app, attemptId, {
      taskType: "listen_choose",
      items: [{ itemId: "lcr-1", selectedOptionId: "a" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[] };
    expect(body.items[0]).toEqual({ itemId: "lcr-1", correct: true });
  });

  it("404s on an unknown itemId, before any write", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "listening", mode: "drill", setId: SET_ID });
    const res = await postScore(app, attemptId, {
      taskType: "announcement",
      items: [{ itemId: "ann-1-q1", selectedOptionId: "c" }, { itemId: "no-such-item", selectedOptionId: "c" }],
    });
    expect(res.status).toBe(404);
    expect(testRepo.getAttempt(attemptId)!.items).toHaveLength(0);
  });

  it("409s on re-scoring an already-scored listening item, marked alreadyScored:true (same contract as Reading)", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "listening", mode: "drill", setId: SET_ID });
    const first = await postScore(app, attemptId, { taskType: "listen_choose", items: [{ itemId: "lcr-1", selectedOptionId: "a" }] });
    expect(first.status).toBe(200);
    const second = await postScore(app, attemptId, { taskType: "listen_choose", items: [{ itemId: "lcr-1", selectedOptionId: "b" }] });
    expect(second.status).toBe(409);
    expect((await second.json()) as { alreadyScored?: boolean }).toMatchObject({ alreadyScored: true });
  });

  it("409s a listening task type submitted against a non-listening (writing) attempt", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "writing", mode: "drill", setId: WRITING_SET_ID });
    const res = await postScore(app, attemptId, {
      taskType: "listen_choose",
      items: [{ itemId: "lcr-1", selectedOptionId: "a" }],
    });
    expect(res.status).toBe(409);
    expect((await res.json()) as { alreadyScored?: boolean }).not.toHaveProperty("alreadyScored");
  });

  it("tags score_json with correct/skill/module/answer for a listening item, module reflecting router vs lower vs upper", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "listening", mode: "drill", setId: SET_ID });

    await postScore(app, attemptId, { taskType: "listen_choose", items: [{ itemId: "lcr-1", selectedOptionId: "a" }] }); // router
    await postScore(app, attemptId, { taskType: "listen_choose", items: [{ itemId: "lcr-lo-1", selectedOptionId: "c" }] }); // lowerModule
    await postScore(app, attemptId, { taskType: "academic_talk", items: [{ itemId: "talk-up-1-q2", selectedOptionId: "b" }] }); // upperModule

    const items = testRepo.getAttempt(attemptId)!.items;
    const byId = new Map(items.map((i) => [i.item_id, JSON.parse(i.score_json!) as Record<string, unknown>]));

    expect(byId.get("lcr-1")).toEqual({ correct: true, skill: "function", module: "router", answer: "a" });
    expect(byId.get("lcr-lo-1")).toEqual({ correct: false, skill: "function", module: "lower", answer: "c" });
    expect(byId.get("talk-up-1-q2")).toEqual({ correct: true, skill: "detail", module: "upper", answer: "b" });
  });
});

describe("POST /:id/route — listening fixture", () => {
  it("computes and persists path+routerRaw over the listening router's 9 items across all four Task Types", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "listening", mode: "simulation", setId: SET_ID });
    await scoreAllRouterItemsSixOfNineCorrect(app, attemptId);

    const res = await postRoute(app, attemptId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { path: string; routerRaw: number };
    expect(body).toEqual({ path: "upper", routerRaw: 6 / 9 });

    const attempt = testRepo.getAttempt(attemptId)!;
    expect(attempt.module_path).toBe("upper");
    expect(attempt.router_raw).toBe(6 / 9);
  });

  it("409s when the router module is not fully scored, listing the missing count", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "listening", mode: "simulation", setId: SET_ID });
    // Only lcr-1 is scored; conv-1's 2, ann-1's 2 and talk-1's 4 (8 in all) are not.
    await postScore(app, attemptId, { taskType: "listen_choose", items: [{ itemId: "lcr-1", selectedOptionId: "a" }] });
    const res = await postRoute(app, attemptId);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/8/);
    expect(testRepo.getAttempt(attemptId)!.module_path).toBeNull();
  });

  it("locks the router module once routed: scoring a router item returns 409", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "listening", mode: "simulation", setId: SET_ID });
    testRepo.setAttemptRouting(attemptId, "upper", 0.7);

    const res = await postScore(app, attemptId, {
      taskType: "listen_choose",
      items: [{ itemId: "lcr-1", selectedOptionId: "a" }], // router item — never scored
    });
    expect(res.status).toBe(409);
  });

  it("locks out the NON-selected module once routed", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "listening", mode: "simulation", setId: SET_ID });
    testRepo.setAttemptRouting(attemptId, "upper", 0.7);

    const res = await postScore(app, attemptId, {
      taskType: "listen_choose",
      items: [{ itemId: "lcr-lo-1", selectedOptionId: "a" }], // lowerModule item, routed to upper
    });
    expect(res.status).toBe(409);
  });

  it("allows scoring the SELECTED module's items once routed", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "listening", mode: "simulation", setId: SET_ID });
    testRepo.setAttemptRouting(attemptId, "upper", 0.7);

    const res = await postScore(app, attemptId, {
      taskType: "academic_talk",
      items: [{ itemId: "talk-up-1-q1", selectedOptionId: "a" }], // upperModule item, routed to upper
    });
    expect(res.status).toBe(200);
  });
});

// censusRouterItems and scoreDeterministicItems refuse an Attempt whose Set is of another kind
// (`set.kind !== attempt.kind`). Checking each against "reading or listening" separately would let a
// Listening Attempt paired with a Reading Set through, to fail later as a misleading "unknown item".
// POST / already refuses such a pairing when the Attempt is created, so this is defence in depth,
// and the functions are called directly because no request can build the pairing.
describe("deterministicScoring: the Attempt kind must match the Set kind", () => {
  function fakeListeningAttempt(): AttemptWithItems {
    return {
      id: "fake-listening-attempt", kind: "listening", mode: "drill", set_id: "irrelevant",
      is_repeat: 0, status: "in_progress", started_at: "2026-08-09T00:00:00.000Z",
      completed_at: null, capture_finished_at: null, flagged: 0, module_path: null, router_raw: null,
      items: [],
    };
  }

  it("scoreDeterministicItems 404s a listening attempt paired with a READING Set, with a kind-mismatch message — not 'unknown item'", () => {
    const { repo: testRepo } = buildTestApp();
    const call = () =>
      scoreDeterministicItems({
        repo: testRepo, // never reached — the pairing guard throws before any repo call
        attempt: fakeListeningAttempt(),
        set: READING_FIXTURE,
        request: { taskType: "listen_choose", items: [{ itemId: "lcr-1", selectedOptionId: "a" }] },
      });
    expect(call).toThrow(NotFound);
    expect(call).toThrow(/requires a listening set/);
    try {
      call();
    } catch (err) {
      expect((err as Error).message).not.toMatch(/unknown item/);
    }
  });

  it("censusRouterItems 404s a listening attempt paired with a READING Set, with a kind-mismatch message", () => {
    const call = () => censusRouterItems(READING_FIXTURE, fakeListeningAttempt());
    expect(call).toThrow(NotFound);
    expect(call).toThrow(/requires a listening set/);
  });
});

// A completed Listening Attempt's review, as routes.attempts.reading.test.ts pins Reading's, plus
// the transcript: each Item's DeterministicReviewItemVM.transcript is its Stimulus's transcript, and
// a Listen and Choose a Response Item has none.
describe("GET /:id — deterministicReview for Listening", () => {
  it("attaches key + 錯題解析 + transcript once completed, but listen_choose carries NO transcript key at all", async () => {
    const { app } = buildTestApp();
    const { attemptId } = await createAttempt(app, { kind: "listening", mode: "drill", setId: SET_ID });
    await postScore(app, attemptId, { taskType: "listen_choose", items: [{ itemId: "lcr-1", selectedOptionId: "a" }] }); // correct
    await postScore(app, attemptId, {
      taskType: "conversation",
      items: [
        { itemId: "conv-1-q1", selectedOptionId: "a" }, // correct
        { itemId: "conv-1-q2", selectedOptionId: "c" }, // correct is "b" — wrong
      ],
    });
    await postScore(app, attemptId, { taskType: "announcement", items: [{ itemId: "ann-1-q1", selectedOptionId: "c" }] }); // correct
    await postScore(app, attemptId, { taskType: "academic_talk", items: [{ itemId: "talk-1-q1", selectedOptionId: "b" }] }); // correct

    const before = await app.request(`/${attemptId}`);
    const beforeBody = (await before.json()) as { deterministicReview?: unknown };
    expect(beforeBody.deterministicReview).toBeUndefined();

    const completeRes = await postComplete(app, attemptId);
    expect(completeRes.status).toBe(200);

    const after = await app.request(`/${attemptId}`);
    const afterBody = (await after.json()) as {
      deterministicReview?: Array<{ itemId: string; taskType: string; correct: boolean; key?: string; explanationZh?: string; transcript?: string }>;
    };
    expect(afterBody.deterministicReview).toBeDefined();
    const byId = new Map(afterBody.deterministicReview!.map((i) => [i.itemId, i]));

    // listen_choose has its key and Explanation as normal, and no `transcript` key at all: not an
    // empty or null one either, which toMatchObject would not notice.
    const lcr = byId.get("lcr-1");
    expect(lcr).toMatchObject({ taskType: "listen_choose", correct: true, key: "a" });
    expect(Object.hasOwn(lcr!, "transcript")).toBe(false);

    // A Conversation's two questions share its transcript, one "<role>: <text>" line per turn
    // (formatConversationTranscript in deterministicScoring.ts).
    const convTranscript =
      "student: Could I still get the lunch special after two o'clock.\ncashier: We stop serving it at one-thirty, sorry about that.";
    expect(byId.get("conv-1-q1")).toMatchObject({ taskType: "conversation", correct: true, transcript: convTranscript });
    expect(byId.get("conv-1-q2")).toMatchObject({ taskType: "conversation", correct: false, key: "b", transcript: convTranscript });

    // An Announcement's or Academic Talk's transcript is the Stimulus's prose, verbatim.
    expect(byId.get("ann-1-q1")).toMatchObject({
      taskType: "announcement",
      correct: true,
      transcript:
        "Attention residents, the elevator on the east wing will be closed for maintenance starting tomorrow morning until further notice.",
    });
    expect(byId.get("talk-1-q1")).toMatchObject({
      taskType: "academic_talk",
      correct: true,
      transcript:
        "Today we will look at how tidal pools support a surprising range of organisms despite their harsh, constantly changing conditions.",
    });
  });
});
