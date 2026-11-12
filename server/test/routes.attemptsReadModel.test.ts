import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { framelessWritingSet } from "./helpers/setFixtures.js";
import type { AttemptDetailVM, AttemptListVM, ScoringJobDetailVM } from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import { config } from "../src/lib/config.js";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { at } from "./helpers/timestamps.js";

// What the User reads about their Attempts: the log (GET /), one Attempt's review (GET /:id) and
// a scoring job's live state (GET /:id/score-jobs/:jobId). All three are typed view models.

const SET_ID = "wri-readmodel1";
const writingSet = framelessWritingSet(SET_ID, { subject: "Order #4127 - damaged panel", courseTitle: "Urban Studies 210" });
const setFile = path.join(config.dataDir, "question-sets", "writing", `${SET_ID}.json`);

beforeAll(() => {
  fs.mkdirSync(path.dirname(setFile), { recursive: true });
  fs.writeFileSync(setFile, JSON.stringify(writingSet));
});
afterAll(() => {
  fs.rmSync(setFile, { force: true });
});

function harness() {
  const db = openDb(":memory:");
  const r = sqliteStores(db);
  const app = buildAttemptsRoutes({
    repo: r,
    transcriptionRecovery: { readAttemptSnapshot: () => new Map() },
    speakingFinalization: {},
    onScoringTerminal: async () => undefined,
  } as never);
  return { r, db, app };
}

async function getJson<T>(app: ReturnType<typeof harness>["app"], url: string): Promise<T> {
  const res = await app.request(url);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

describe("GET / — the Attempt log", () => {
  it("is a page of typed view models with a total, newest first", async () => {
    const { r, db, app } = harness();
    r.createAttempt({ id: "att-old", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createAttempt({ id: "att-new", kind: "writing", mode: "simulation", setId: SET_ID, isRepeat: true });
    db.prepare("UPDATE attempts SET started_at=? WHERE id='att-old'").run("2026-08-01 10:00:00");
    db.prepare("UPDATE attempts SET started_at=? WHERE id='att-new'").run("2026-08-02 10:00:00");
    r.completeAttempt("att-old", at("2026-08-01 10:30:00"));

    const page = await getJson<AttemptListVM>(app, "/");
    expect(page.total).toBe(2);
    expect(page.items.map((a) => a.id)).toEqual(["att-new", "att-old"]);
    expect(page.items[1]).toEqual({
      id: "att-old",
      kind: "writing",
      mode: "drill",
      setId: SET_ID,
      setTitle: "Order #4127 - damaged panel",
      isRepeat: false,
      status: "completed",
      startedAt: "2026-08-01T10:00:00.000Z",
      completedAt: "2026-08-01T10:30:00.000Z",
      captureFinishedAt: null,
      flagged: false,
      modulePath: null,
      routerRaw: null,
      estimate: null,
      missingBand: null,
      fullTestRun: null,
    });
    expect(page.items[0].isRepeat).toBe(true);
  });

  // The log marks a completed Attempt that should have a band and has none. A Simulation always
  // should; a Drill only when it is Speaking or Writing and took every Task Type its section needs,
  // since a Drill of the email alone gives no band by the User's own choice. A Repeat never becomes a
  // headline band, and an unfinished Attempt or one with its band is not marked.
  it("says which completed Attempts are missing a band they were meant to give", async () => {
    const { r, app } = harness();
    const writingItems = (attemptId: string) => {
      for (const taskType of ["build_sentence", "email", "discussion"]) {
        r.insertItemResult({ attemptId, itemId: `${taskType}-1`, taskType, scoringStatus: "failed" });
      }
    };
    r.createAttempt({ id: "sim", kind: "writing", mode: "simulation", setId: SET_ID, isRepeat: false });
    writingItems("sim");
    r.createAttempt({ id: "email-only", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.insertItemResult({ attemptId: "email-only", itemId: "email-1", taskType: "email", scoringStatus: "failed" });
    r.createAttempt({ id: "whole", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    writingItems("whole");
    r.createAttempt({ id: "rd-drill", kind: "reading", mode: "drill", setId: "rd-elsewhere", isRepeat: false });
    r.createAttempt({ id: "repeat", kind: "writing", mode: "simulation", setId: SET_ID, isRepeat: true });
    writingItems("repeat");
    r.createAttempt({ id: "open", kind: "writing", mode: "simulation", setId: SET_ID, isRepeat: false });
    writingItems("open");
    for (const id of ["sim", "email-only", "whole", "rd-drill", "repeat"]) r.completeAttempt(id);
    // A band on record: every Item scored, settled as /complete settles it.
    r.createAttempt({ id: "banded", kind: "writing", mode: "simulation", setId: SET_ID, isRepeat: false });
    for (const [itemId, taskType, score] of [["bs-1", "build_sentence", 1], ["email-1", "email", 4], ["discussion-1", "discussion", 4]] as const) {
      r.insertItemResult({ attemptId: "banded", itemId, taskType, responseText: "[]" });
      r.updateItemScore({ attemptId: "banded", itemId, score, scoreJson: "{}", scoringStatus: "scored" });
    }
    const banded = r.settleAttempt({ attemptId: "banded" })?.estimate;
    expect(banded).toBeTruthy();

    const page = await getJson<AttemptListVM>(app, "/");
    expect(Object.fromEntries(page.items.map((a) => [a.id, a.missingBand]))).toEqual({
      sim: "incomplete",
      "email-only": null,
      whole: "incomplete",
      "rd-drill": null,
      repeat: null,
      open: null,
      banded: null,
    });
    expect(page.items.find((a) => a.id === "banded")?.estimate).not.toBeNull();
  });

  // A Writing Simulation's /complete lands while both essay jobs are still queued. Until they end the
  // row is still scoring, by the rule the Attempt review uses, and never "missing a band"; once the
  // job has ended failed, the band is missing.
  it("reads a completed Simulation with a queued scoring job as still scoring, then as missing once the job fails", async () => {
    const { r, app } = harness();
    r.createAttempt({ id: "sim", kind: "writing", mode: "simulation", setId: SET_ID, isRepeat: false });
    r.insertItemResult({ attemptId: "sim", itemId: "bs-1", taskType: "build_sentence", responseText: "[]" });
    r.updateItemScore({ attemptId: "sim", itemId: "bs-1", score: 1, scoreJson: "{}", scoringStatus: "scored" });
    r.insertItemResult({ attemptId: "sim", itemId: "email-1", taskType: "email", responseText: "Dear team," });
    r.insertItemResult({ attemptId: "sim", itemId: "discussion-1", taskType: "discussion", responseText: "I think" });
    r.createScoringJob({ id: "job-email", attemptId: "sim", taskType: "email", itemIds: ["email-1"] });
    r.createScoringJob({ id: "job-discussion", attemptId: "sim", taskType: "discussion", itemIds: ["discussion-1"] });
    r.completeAttempt("sim");

    const scoring = await getJson<AttemptListVM>(app, "/");
    const review = await getJson<AttemptDetailVM>(app, "/sim");
    expect(scoring.items[0].missingBand).toBe("scoring");
    expect(review.bandStatus.status).toBe("scoring");

    for (const [jobId, itemId] of [["job-email", "email-1"], ["job-discussion", "discussion-1"]]) {
      r.seedScoringJobState({ id: jobId, status: "failed", error: "no Judge available" });
      r.updateItemScore({ attemptId: "sim", itemId, score: null, scoreJson: "{}", scoringStatus: "failed" });
    }
    const settled = await getJson<AttemptListVM>(app, "/");
    expect(settled.items[0].missingBand).toBe("incomplete");
    expect((await getJson<AttemptDetailVM>(app, "/sim")).bandStatus.status).toBe("incomplete");
  });

  it("pages with limit and offset while total keeps counting the whole log", async () => {
    const { r, db, app } = harness();
    for (let i = 0; i < 56; i++) {
      r.createAttempt({ id: `att-${i}`, kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
      db.prepare("UPDATE attempts SET started_at=? WHERE id=?").run(`2026-08-01 10:${String(i).padStart(2, "0")}:00`, `att-${i}`);
    }

    const first = await getJson<AttemptListVM>(app, "/?limit=25");
    expect(first.total).toBe(56);
    expect(first.items).toHaveLength(25);
    expect(first.items[0].id).toBe("att-55");

    const last = await getJson<AttemptListVM>(app, "/?limit=25&offset=50");
    expect(last.total).toBe(56);
    expect(last.items.map((a) => a.id)).toEqual(["att-5", "att-4", "att-3", "att-2", "att-1", "att-0"]);
  });

  it("filters by kind and setId, and the total follows the filter", async () => {
    const { r, app } = harness();
    r.createAttempt({ id: "w1", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createAttempt({ id: "s1", kind: "speaking", mode: "drill", setId: "spk-elsewhere", isRepeat: false });
    r.createAttempt({ id: "s2", kind: "speaking", mode: "drill", setId: "spk-elsewhere", isRepeat: true });

    const speaking = await getJson<AttemptListVM>(app, "/?kind=speaking");
    expect(speaking.total).toBe(2);
    expect(speaking.items.every((a) => a.kind === "speaking")).toBe(true);

    const bySet = await getJson<AttemptListVM>(app, `/?setId=${SET_ID}`);
    expect(bySet).toMatchObject({ total: 1, items: [{ id: "w1" }] });
  });

  it("labels an Attempt whose Set can no longer be read with a null title instead of failing", async () => {
    const { r, app } = harness();
    r.createAttempt({ id: "gone", kind: "writing", mode: "drill", setId: "wri-nosuchset", isRepeat: false });
    const page = await getJson<AttemptListVM>(app, "/");
    expect(page.items[0]).toMatchObject({ setId: "wri-nosuchset", setTitle: null });
  });

  it("falls back to its defaults for a malformed limit or offset", async () => {
    const { r, app } = harness();
    r.createAttempt({ id: "only", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    const page = await getJson<AttemptListVM>(app, "/?limit=abc&offset=-3");
    expect(page).toMatchObject({ total: 1, items: [{ id: "only" }] });
  });
});

describe("GET /:id — the review", () => {
  it("lists Items in the Set's own order — Build a Sentence, then Email, then Academic Discussion", async () => {
    const { r, app } = harness();
    r.createAttempt({ id: "sim", kind: "writing", mode: "simulation", setId: SET_ID, isRepeat: false });
    // Persisted in the order a Writing Simulation actually lands them.
    r.insertItemResult({ attemptId: "sim", itemId: "em1", taskType: "email", responseText: "email" });
    for (const id of ["bs2", "bs1", "bs3"]) r.insertItemResult({ attemptId: "sim", itemId: id, taskType: "build_sentence", responseText: "[]" });
    r.insertItemResult({ attemptId: "sim", itemId: "ad1", taskType: "discussion", responseText: "post" });
    r.insertItemResult({ attemptId: "sim", itemId: "retired-item", taskType: "build_sentence", responseText: "[]" });

    const detail = await getJson<AttemptDetailVM>(app, "/sim");
    expect(detail.items.map((i) => i.itemId)).toEqual(["bs1", "bs2", "bs3", "em1", "ad1", "retired-item"]);
    expect(detail.attempt.setTitle).toBe("Order #4127 - damaged panel");
  });

  it("keeps persisted order when the Set cannot be read", async () => {
    const { r, app } = harness();
    r.createAttempt({ id: "orphan", kind: "writing", mode: "drill", setId: "wri-nosuchset", isRepeat: false });
    r.insertItemResult({ attemptId: "orphan", itemId: "em1", taskType: "email", responseText: "x" });
    r.insertItemResult({ attemptId: "orphan", itemId: "bs1", taskType: "build_sentence", responseText: "[]" });
    const detail = await getJson<AttemptDetailVM>(app, "/orphan");
    expect(detail.items.map((i) => i.itemId)).toEqual(["em1", "bs1"]);
    expect(detail.attempt.setTitle).toBeNull();
  });

  it("names the Items each active scoring job covers", async () => {
    const { r, app } = harness();
    r.createAttempt({ id: "spk", kind: "speaking", mode: "drill", setId: "spk-elsewhere", isRepeat: false });
    r.createScoringJob({ id: "job-1", attemptId: "spk", taskType: "listen_repeat", itemIds: ["lr3"] });

    const detail = await getJson<AttemptDetailVM>(app, "/spk");
    expect(detail.activeJobs).toEqual([
      { jobId: "job-1", taskType: "listen_repeat", itemIds: ["lr3"], stage: null, status: "queued" },
    ]);
  });
});

describe("GET /:id/score-jobs/:jobId", () => {
  it("names the Items the job covers", async () => {
    const { r, app } = harness();
    r.createAttempt({ id: "spk", kind: "speaking", mode: "drill", setId: "spk-elsewhere", isRepeat: false });
    r.createScoringJob({ id: "job-2", attemptId: "spk", taskType: "interview", itemIds: ["iq2", "iq4"] });

    const job = await getJson<ScoringJobDetailVM>(app, "/spk/score-jobs/job-2");
    expect(job).toMatchObject({ jobId: "job-2", taskType: "interview", itemIds: ["iq2", "iq4"], status: "queued" });
  });
});
