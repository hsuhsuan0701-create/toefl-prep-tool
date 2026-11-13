import { beforeEach, describe, expect, it } from "vitest";
import { readBankSet } from "./helpers/setFixtures.js";
import type { AnySet, AttemptDetailVM } from "@toefl-prep/shared";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { openDb } from "../src/db/db.js";
import { scoreBuildSentence } from "../src/services/scoreItems.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// Build a Sentence scoring through the real route over a private in-memory database. The Set is
// read from the seeded bank, exactly as the route reads it.

type WritingSet = Extract<AnySet, { kind: "writing" }>;

const SET_ID = "wri-77af733e";
const fixture = readBankSet("writing", SET_ID);
const [bas1, bas2] = fixture.buildASentence.items;

function harness() {
  const repo = sqliteStores(openDb(":memory:"));
  const app = buildAttemptsRoutes({
    repo,
    transcriptionRecovery: { readAttemptSnapshot: () => new Map() },
    speakingFinalization: {},
    onScoringTerminal: async () => undefined,
  } as never);
  return { repo, app };
}

async function createWritingAttempt(app: ReturnType<typeof buildAttemptsRoutes>, mode: "drill" | "simulation" = "drill"): Promise<string> {
  const res = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "writing", mode, setId: SET_ID }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { attemptId: string }).attemptId;
}

async function scoreTiles(app: ReturnType<typeof buildAttemptsRoutes>, attemptId: string, items: unknown[]) {
  return app.request(`/${attemptId}/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskType: "build_sentence", items }),
  });
}

describe("Build a Sentence scoring", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it("persists the Item's frame, exactly as the Set carries it, in score_json", async () => {
    expect(bas1.frame).toEqual(expect.any(String));
    const attemptId = await createWritingAttempt(h.app);

    const res = await scoreTiles(h.app, attemptId, [
      { itemId: bas1.id, tileOrder: bas1.answers[0] },
      { itemId: bas2.id, tileOrder: [...bas2.answers[0]].reverse() },
    ]);
    expect(res.status).toBe(200);

    const rows = h.repo.getAttempt(attemptId)!.items;
    const row1 = rows.find((r) => r.item_id === bas1.id)!;
    const row2 = rows.find((r) => r.item_id === bas2.id)!;
    expect(JSON.parse(row1.score_json!)).toEqual({ correct: true, correctAnswers: bas1.answers, frame: bas1.frame });
    expect(JSON.parse(row2.score_json!)).toEqual({ correct: false, correctAnswers: bas2.answers, frame: bas2.frame });
    expect(row1.response_text).toBe(JSON.stringify(bas1.answers[0]));
  });

  it("keeps the live response shape: the frame is persisted, not returned", async () => {
    const attemptId = await createWritingAttempt(h.app);
    const res = await scoreTiles(h.app, attemptId, [{ itemId: bas1.id, tileOrder: bas1.answers[0] }]);
    const body = (await res.json()) as { taskType: string; items: Record<string, unknown>[] };
    expect(body).toEqual({
      taskType: "build_sentence",
      items: [{ itemId: bas1.id, correct: true, matchedAnswer: bas1.answers[0], correctAnswers: bas1.answers }],
    });
  });

  it("omits the frame key for an Item that has no frame", () => {
    const { frame: _dropped, ...frameless } = bas1;
    const set: WritingSet = {
      ...fixture,
      buildASentence: { ...fixture.buildASentence, items: [frameless, ...fixture.buildASentence.items.slice(1)] },
    };
    h.repo.createAttempt({ id: "att-frameless", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });

    scoreBuildSentence(h.repo, h.repo.getAttempt("att-frameless")!, set, {
      taskType: "build_sentence",
      items: [{ itemId: bas1.id, tileOrder: bas1.answers[0] }],
    });

    const row = h.repo.getAttempt("att-frameless")!.items[0];
    expect(JSON.parse(row.score_json!)).toEqual({ correct: true, correctAnswers: bas1.answers });
    expect(Object.hasOwn(JSON.parse(row.score_json!), "frame")).toBe(false);
  });

  it("refuses a request naming an unknown Item before writing any of its Items", async () => {
    const attemptId = await createWritingAttempt(h.app);

    const res = await scoreTiles(h.app, attemptId, [
      { itemId: bas1.id, tileOrder: bas1.answers[0] },
      { itemId: "bas-does-not-exist", tileOrder: ["a"] },
    ]);

    expect(res.status).toBe(404);
    expect(h.repo.getAttempt(attemptId)!.items).toHaveLength(0);
  });

  it("writes a request's Items in one transaction: a failure on a later Item leaves none of them", () => {
    h.repo.createAttempt({ id: "att-batch", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    const row = (itemId: string, attemptId = "att-batch") => ({
      attemptId, itemId, responseText: "[]", score: 1, scoreJson: "{}",
    });

    // The third row names an Attempt that does not exist, so its insert fails the foreign key.
    expect(() => h.repo.scoreBuildSentenceItems([row("bas-1"), row("bas-2"), row("bas-3", "no-such-attempt")]))
      .toThrow(/FOREIGN KEY/);
    expect(h.repo.getAttempt("att-batch")!.items).toHaveLength(0);

    h.repo.scoreBuildSentenceItems([row("bas-1"), row("bas-2")]);
    expect(h.repo.getAttempt("att-batch")!.items.map((i) => [i.item_id, i.scoring_status, i.response_text]))
      .toEqual([["bas-1", "scored", "[]"], ["bas-2", "scored", "[]"]]);
  });
});

// A Simulation's score responses carry bare correctness, and its keys reach the client only after
// the Attempt completes (CLAUDE.md, "Sets and answers"). Build a Sentence persists its key in
// score_json, so both the score response and the Attempt review have to hold it back.
describe("Build a Sentence in a Simulation", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  const request = () => [
    { itemId: bas1.id, tileOrder: bas1.answers[0] },
    { itemId: bas2.id, tileOrder: [...bas2.answers[0]].reverse() },
  ];

  it("answers with each Item's id and correctness, and no key", async () => {
    const attemptId = await createWritingAttempt(h.app, "simulation");
    const res = await scoreTiles(h.app, attemptId, request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      taskType: "build_sentence",
      items: [{ itemId: bas1.id, correct: true }, { itemId: bas2.id, correct: false }],
    });
    // The key is still persisted, for the review of the completed Attempt.
    const row = h.repo.getAttempt(attemptId)!.items.find((r) => r.item_id === bas1.id)!;
    expect(JSON.parse(row.score_json!).correctAnswers).toEqual(bas1.answers);
  });

  it("withholds the key and the marks from the Attempt review until the Attempt completes, then shows them", async () => {
    const attemptId = await createWritingAttempt(h.app, "simulation");
    await scoreTiles(h.app, attemptId, request());

    // In progress: each scored Item keeps its Response and frame, and neither its key, its
    // correctness nor its score leaves the server (CLAUDE.md, "Sets and answers").
    const during = (await (await h.app.request(`/${attemptId}`)).json()) as AttemptDetailVM;
    expect(during.marksWithheld).toBe("attempt-in-progress");
    const duringItems = during.items.filter((i) => i.taskType === "build_sentence");
    expect(duringItems).toHaveLength(2);
    for (const item of duringItems) {
      expect(item.scoringStatus).toBe("scored");
      expect(item.score).toBeNull();
      expect(item.scoreJson).toEqual({ frame: expect.any(String) });
    }
    expect(JSON.stringify(during)).not.toContain("correctAnswers");
    expect(JSON.stringify(during)).not.toContain('"correct"');

    expect((await h.app.request(`/${attemptId}/complete`, { method: "POST" })).status).toBe(200);
    const after = (await (await h.app.request(`/${attemptId}`)).json()) as AttemptDetailVM;
    expect(after).not.toHaveProperty("marksWithheld");
    const reviewed = after.items.find((i) => i.itemId === bas1.id)!;
    expect(reviewed.score).toBe(1);
    expect(reviewed.scoreJson).toEqual({ correct: true, correctAnswers: bas1.answers, frame: bas1.frame });
  });

  it("answers a repeat of a scored request from the stored rows, and writes nothing", async () => {
    const attemptId = await createWritingAttempt(h.app, "simulation");
    const first = await (await scoreTiles(h.app, attemptId, request())).json();
    const before = h.repo.getAttempt(attemptId)!.items.map((r) => [r.item_id, r.response_text, r.score, r.score_json, r.scored_at]);

    // The same request again (a retry after a lost response) and a changed answer alike.
    const retry = await scoreTiles(h.app, attemptId, request());
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(first);
    const changed = await scoreTiles(h.app, attemptId, [
      { itemId: bas1.id, tileOrder: [...bas1.answers[0]].reverse() },
      { itemId: bas2.id, tileOrder: bas2.answers[0] },
    ]);
    expect(changed.status).toBe(200);
    expect(await changed.json()).toEqual(first);

    const after = h.repo.getAttempt(attemptId)!.items.map((r) => [r.item_id, r.response_text, r.score, r.score_json, r.scored_at]);
    expect(after).toEqual(before);
  });

  it("refuses with 409, unmarked, a request mixing scored and unscored Items, and writes nothing", async () => {
    const attemptId = await createWritingAttempt(h.app, "simulation");
    await scoreTiles(h.app, attemptId, [{ itemId: bas1.id, tileOrder: bas1.answers[0] }]);
    const before = h.repo.getAttempt(attemptId)!.items.map((r) => [r.item_id, r.response_text, r.score_json]);

    const res = await scoreTiles(h.app, attemptId, [
      { itemId: bas1.id, tileOrder: [...bas1.answers[0]].reverse() },
      { itemId: bas2.id, tileOrder: bas2.answers[0] },
    ]);
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.alreadyScored).toBeUndefined();
    expect(h.repo.getAttempt(attemptId)!.items.map((r) => [r.item_id, r.response_text, r.score_json])).toEqual(before);
  });

  it("leaves a Drill as it was: keys in the response and in the review, and a repeat re-scores", async () => {
    const attemptId = await createWritingAttempt(h.app, "drill");
    await scoreTiles(h.app, attemptId, request());
    const detail = (await (await h.app.request(`/${attemptId}`)).json()) as AttemptDetailVM;
    expect(detail).not.toHaveProperty("marksWithheld");
    expect(detail.items.find((i) => i.itemId === bas1.id)!).toMatchObject({ score: 1, scoreJson: { correct: true, correctAnswers: bas1.answers } });

    const again = await scoreTiles(h.app, attemptId, [{ itemId: bas2.id, tileOrder: bas2.answers[0] }]);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      taskType: "build_sentence",
      items: [{ itemId: bas2.id, correct: true, matchedAnswer: bas2.answers[0], correctAnswers: bas2.answers }],
    });
    expect(h.repo.getAttempt(attemptId)!.items.find((r) => r.item_id === bas2.id)!.score).toBe(1);
  });
});
