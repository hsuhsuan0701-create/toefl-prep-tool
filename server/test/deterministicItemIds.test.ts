import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AnySetSchema, type AttemptDetailVM, type ReadingSet } from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import { config } from "../src/lib/config.js";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { DuplicateItemIdError, indexDeterministicItems } from "../src/services/deterministicScoring.js";
import { setItemOrder } from "../src/services/setItemOrder.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import { READING_FIXTURE } from "./fixtures/reading-set.fixture.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// A Reading or Listening Item is looked up by id across all three Modules, and its row is keyed by
// id. Two Items sharing an id would let a Response be scored against the other Item's key, so the
// lookup refuses such a Set rather than letting the later Item replace the earlier one. The Set
// schema does not check it on load: narrowing a Set schema would make a banked Set unloadable.

const DUPLICATE_SET_ID = "rd-dupids1";
// The Upper Module's first question takes the id of a Router question, with a different key.
const DUPLICATE_SET: ReadingSet = {
  ...READING_FIXTURE,
  id: DUPLICATE_SET_ID,
  upperModule: {
    ...READING_FIXTURE.upperModule,
    dailyLife: READING_FIXTURE.upperModule.dailyLife.map((text, t) => ({
      ...text,
      questions: text.questions.map((question, q) => (t === 0 && q === 0 ? { ...question, id: "dl-1-q1" } : question)),
    })),
  },
};

beforeAll(() => {
  const file = path.join(config.dataDir, "question-sets", "reading", `${DUPLICATE_SET_ID}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(DUPLICATE_SET));
  return () => fs.rmSync(file, { force: true });
});

function harness() {
  const repo = sqliteStores(openDb(":memory:"));
  const app = buildAttemptsRoutes({ repo, ...createSpeakingCoordinators({ repo }) });
  return { repo, app };
}

async function createAttempt(app: ReturnType<typeof harness>["app"], mode: "drill" | "simulation"): Promise<string> {
  const res = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "reading", mode, setId: DUPLICATE_SET_ID }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { attemptId: string }).attemptId;
}

describe("indexDeterministicItems", () => {
  it("refuses a Set two of whose Items share an id, naming the Set and the id", () => {
    expect(() => indexDeterministicItems(DUPLICATE_SET)).toThrow(DuplicateItemIdError);
    expect(() => indexDeterministicItems(DUPLICATE_SET)).toThrow(expect.objectContaining({ setId: DUPLICATE_SET_ID, itemId: "dl-1-q1" }));
  });

  it("indexes every banked Reading and Listening Set: no banked Set has two Items with one id", () => {
    let checked = 0;
    for (const kind of ["reading", "listening"] as const) {
      const dir = path.join(config.dataDir, "question-sets", kind);
      for (const file of fs.readdirSync(dir).filter((name) => name.endsWith(".json") && name !== `${DUPLICATE_SET_ID}.json`)) {
        const set = AnySetSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")));
        if (set.kind !== "reading" && set.kind !== "listening") continue;
        expect(() => indexDeterministicItems(set), file).not.toThrow();
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("still orders such a Set for display: ordering a review is not scoring", () => {
    expect(setItemOrder(DUPLICATE_SET).filter((id) => id === "dl-1-q1")).toHaveLength(2);
  });
});

describe("a Set two of whose Items share an id, through the Attempt routes", () => {
  it("is refused at scoring with a bare 500, and nothing is written", async () => {
    const { repo, app } = harness();
    const attemptId = await createAttempt(app, "simulation");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app.request(`/${attemptId}/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskType: "daily_life", items: [{ itemId: "dl-1-q1", selectedOptionId: "a" }, { itemId: "dl-1-q2", selectedOptionId: "b" }] }),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal error" });
      expect(errors).toHaveBeenCalledWith("[attempts] score failed:", "DuplicateItemIdError");
    } finally {
      errors.mockRestore();
    }
    expect(repo.getAttempt(attemptId)?.items).toEqual([]);
  });

  it("leaves the key review out of a completed Attempt's readback, and still reads the rest back", async () => {
    const { repo, app } = harness();
    const attemptId = await createAttempt(app, "drill");
    repo.scoreDeterministicItemsBatch([
      { attemptId, itemId: "dl-1-q1", taskType: "daily_life", score: 1, scoreJson: JSON.stringify({ correct: true, module: "router", answer: "a" }) },
    ]);
    expect((await app.request(`/${attemptId}/complete`, { method: "POST" })).status).toBe(200);

    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await app.request(`/${attemptId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as AttemptDetailVM;
      expect(body.items.map((item) => item.itemId)).toEqual(["dl-1-q1"]);
      expect(body).not.toHaveProperty("deterministicReview");
    } finally {
      errors.mockRestore();
    }
  });
});
