import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBankSet } from "./helpers/setFixtures.js";
import type { DeliveryReport, JudgeReport, ScoreReport } from "@toefl-prep/shared";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { openDb } from "../src/db/db.js";
import type { aggregate as realAggregate, aggregateSpeaking as realAggregateSpeaking } from "../src/services/arbiter.js";
import type { judgeEssay as realJudgeEssay } from "../src/services/judges/index.js";
import type { judgeSpeaking as realJudgeSpeaking } from "../src/services/judges/speaking.js";
import { resetJobAdmissionsForTests, stopJobAdmissions } from "../src/services/jobCancellation.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// A rescore through the real route and job runner over an in-memory database: the Response is
// recorded before the job runs, and a committed score is only ever replaced by a committed result.

const WRITING_SET_ID = "wri-77af733e";
const SPEAKING_SET_ID = "spk-e5b2b735";
const writing = readBankSet("writing", WRITING_SET_ID);
const speaking = readBankSet("speaking", SPEAKING_SET_ID);
const emailId = writing.email.id;
const lrIds = speaking.listenAndRepeat.items.map((i) => i.id);
const ESSAY = "Dear team, I am writing about the schedule.";
const OLD_SCORED_AT = "2026-01-01 00:00:00";

const deliveryReport: DeliveryReport = {
  paceWpm: 140, pauses: "none", intelligibility: "clear", suspectedMispronunciations: [], intonation: "flat",
};

function judgeReport(judge: "gemini" | "openai", taskType: JudgeReport["taskType"], itemIds: string[], score: number): JudgeReport {
  return {
    judge, taskType,
    items: itemIds.map((itemId) => ({ itemId, score, dimensions: [{ name: "d", score, evidence: `scored ${score}` }], deductions: [] })),
  };
}

function scoreReport(taskType: ScoreReport["taskType"], itemIds: string[], finalScore: number): ScoreReport {
  return {
    taskType,
    items: itemIds.map((itemId) => ({
      itemId, ownScore: finalScore, finalScore, maxScore: 5,
      dimensions: [{ name: "d", note: "n" }], deductions: [], reconciliationNote: "r", feedbackZh: "好。",
    })),
  };
}

function harness(repoOverrides: Record<string, unknown> = {}) {
  const db = openDb(":memory:");
  const stores = sqliteStores(db);
  const repo = { ...stores, ...repoOverrides } as typeof stores;
  const judgeEssay = vi.fn<typeof realJudgeEssay>();
  const aggregate = vi.fn<typeof realAggregate>();
  const judgeSpeaking = vi.fn<typeof realJudgeSpeaking>();
  const aggregateSpeaking = vi.fn<typeof realAggregateSpeaking>();
  const scoreDeps = { repo, judgeEssay, aggregate, judgeSpeaking, aggregateSpeaking };
  const coordinators = createSpeakingCoordinators({ ...scoreDeps, hearRecording: vi.fn() });
  const app = buildAttemptsRoutes({ ...scoreDeps, ...coordinators });

  const essayJudgesScore = (score: number) =>
    judgeEssay.mockImplementation(async (judge) => ({
      report: judgeReport(judge, "email", [emailId], score),
      provider: judge === "gemini" ? "gemini-http" : "openai-http",
    }) as never);
  const speakingJudgesScore = (score: number) =>
    judgeSpeaking.mockImplementation(async (judge) => ({
      report: judgeReport(judge, "listen_repeat", lrIds, score),
      mode: "audio",
      provider: judge === "gemini" ? "gemini-http" : "openai-http",
    }) as never);

  return { db, repo: stores, app, judgeEssay, aggregate, judgeSpeaking, aggregateSpeaking, essayJudgesScore, speakingJudgesScore };
}
type Harness = ReturnType<typeof harness>;

async function createAttempt(h: Harness, kind: "writing" | "speaking", setId: string) {
  const res = await h.app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, mode: "drill", setId }),
  });
  return ((await res.json()) as { attemptId: string }).attemptId;
}

async function postScore(h: Harness, attemptId: string, request: unknown) {
  return h.app.request(`/${attemptId}/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
}

async function scoreToTerminal(h: Harness, attemptId: string, request: unknown) {
  const res = await postScore(h, attemptId, request);
  expect(res.status).toBe(202);
  const { jobId } = (await res.json()) as { jobId: string };
  let job!: { status: string; error?: string };
  await vi.waitFor(async () => {
    job = await (await h.app.request(`/${attemptId}/score-jobs/${jobId}`)).json() as typeof job;
    if (!["done", "failed", "superseded", "cancelled"].includes(job.status)) throw new Error(job.status);
  }, { timeout: 2000, interval: 5 });
  return job;
}

const emailRequest = (text = ESSAY) => ({ taskType: "email", items: [{ itemId: emailId, text, secondsUsed: 200 }] });
const listenRepeatRequest = { taskType: "listen_repeat", items: lrIds.map((itemId) => ({ itemId })) };

// What a rescore must leave alone: the score, its report, when it was scored, its status, and the
// Judge Reports it was arbitrated from.
function committedState(h: Harness, attemptId: string) {
  return {
    items: h.repo.getAttempt(attemptId)!.items.map(({ item_id, response_text, score, score_json, scored_at, scoring_status }) =>
      ({ item_id, response_text, score, score_json, scored_at, scoring_status })),
    judgeReports: h.repo.getJudgeReports(attemptId),
  };
}

async function scoredEssay(h: Harness) {
  const attemptId = await createAttempt(h, "writing", WRITING_SET_ID);
  h.essayJudgesScore(4);
  h.aggregate.mockResolvedValueOnce({ report: scoreReport("email", [emailId], 4), provider: "claude" });
  expect((await scoreToTerminal(h, attemptId, emailRequest())).status).toBe("done");
  h.db.prepare("UPDATE item_results SET scored_at=? WHERE attempt_id=?").run(OLD_SCORED_AT, attemptId);
  return attemptId;
}

async function scoredListenRepeat(h: Harness) {
  const attemptId = await createAttempt(h, "speaking", SPEAKING_SET_ID);
  for (const itemId of lrIds) {
    h.repo.insertItemResult({
      attemptId, itemId, taskType: "listen_repeat",
      responseAudioPath: `audio/responses/${attemptId}/${itemId}.webm`,
      transcript: "we open the front desk at six",
      deliveryReport: JSON.stringify(deliveryReport),
    });
  }
  h.speakingJudgesScore(4);
  h.aggregateSpeaking.mockResolvedValueOnce({ report: scoreReport("listen_repeat", lrIds, 4), provider: "claude" });
  expect((await scoreToTerminal(h, attemptId, listenRepeatRequest)).status).toBe("done");
  h.db.prepare("UPDATE item_results SET scored_at=? WHERE attempt_id=?").run(OLD_SCORED_AT, attemptId);
  return attemptId;
}

describe("a rescore never erases a committed score it has not replaced", () => {
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorLog.mockRestore();
  });

  it("essay: a rescore whose Arbiter fails leaves the score and its Judge Reports exactly as they were", async () => {
    const h = harness();
    const attemptId = await scoredEssay(h);
    const before = committedState(h, attemptId);
    expect(before.items[0]).toMatchObject({ score: 4, scoring_status: "scored", scored_at: OLD_SCORED_AT });

    h.essayJudgesScore(2);
    h.aggregate.mockRejectedValueOnce(new Error("arbiter down"));
    const job = await scoreToTerminal(h, attemptId, emailRequest());

    expect(job.status).toBe("failed");
    expect(committedState(h, attemptId)).toEqual(before);
  });

  it("essay: a rescore whose Judges both fail leaves the score as it was", async () => {
    const h = harness();
    const attemptId = await scoredEssay(h);
    const before = committedState(h, attemptId);

    h.judgeEssay.mockRejectedValue(new Error("judges down"));
    const job = await scoreToTerminal(h, attemptId, emailRequest());

    expect(job.status).toBe("failed");
    expect(committedState(h, attemptId)).toEqual(before);
  });

  it("essay: while the rescore is running, the Attempt still reads the committed score", async () => {
    const h = harness();
    const attemptId = await scoredEssay(h);
    const before = committedState(h, attemptId);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.judgeEssay.mockImplementation(async (judge) => {
      await gate;
      return { report: judgeReport(judge, "email", [emailId], 3), provider: judge === "gemini" ? "gemini-http" : "openai-http" } as never;
    });
    h.aggregate.mockResolvedValueOnce({ report: scoreReport("email", [emailId], 3), provider: "claude" });
    const res = await postScore(h, attemptId, emailRequest());
    expect(res.status).toBe(202);

    const detail = (await (await h.app.request(`/${attemptId}`)).json()) as { items: { itemId: string; score: number | null; scoringStatus: string }[] };
    expect(detail.items.find((i) => i.itemId === emailId)).toMatchObject({ score: 4, scoringStatus: "scored" });
    expect(committedState(h, attemptId)).toEqual(before);

    release();
    await vi.waitFor(() => {
      expect(h.repo.getAttempt(attemptId)!.items[0].score).toBe(3);
    }, { timeout: 2000, interval: 5 });
  });

  it("essay: a successful rescore replaces the score and the Judge Reports together", async () => {
    const h = harness();
    const attemptId = await scoredEssay(h);

    h.essayJudgesScore(3);
    h.aggregate.mockResolvedValueOnce({ report: scoreReport("email", [emailId], 3), provider: "claude" });
    expect((await scoreToTerminal(h, attemptId, emailRequest())).status).toBe("done");

    const after = committedState(h, attemptId);
    expect(after.items[0]).toMatchObject({ score: 3, scoring_status: "scored" });
    expect(after.items[0].scored_at).not.toBe(OLD_SCORED_AT);
    expect(after.judgeReports.map((r) => (JSON.parse(r.report_json) as JudgeReport).items[0].score)).toEqual([3, 3]);
  });

  it("essay: different text is a new Response, so the old score no longer describes it", async () => {
    const h = harness();
    const attemptId = await scoredEssay(h);

    h.judgeEssay.mockRejectedValue(new Error("judges down"));
    const job = await scoreToTerminal(h, attemptId, emailRequest("A rewritten email."));

    expect(job.status).toBe("failed");
    expect(h.repo.getAttempt(attemptId)!.items[0]).toMatchObject({
      response_text: "A rewritten email.", score: null, scoring_status: "failed", scored_at: null,
    });
  });

  it("speaking: a rescore whose Arbiter fails leaves every scored Item and its Judge Reports as they were", async () => {
    const h = harness();
    const attemptId = await scoredListenRepeat(h);
    const before = committedState(h, attemptId);
    expect(before.items.every((i) => i.scoring_status === "scored")).toBe(true);

    h.speakingJudgesScore(2);
    h.aggregateSpeaking.mockRejectedValueOnce(new Error("arbiter down"));
    const job = await scoreToTerminal(h, attemptId, listenRepeatRequest);

    expect(job.status).toBe("failed");
    expect(committedState(h, attemptId)).toEqual(before);
  });

  it("speaking: an Item the rescore's Arbiter leaves out keeps its committed score; the rest are replaced", async () => {
    const h = harness();
    const attemptId = await scoredListenRepeat(h);
    const [omitted, ...returned] = lrIds;
    const before = committedState(h, attemptId);

    h.speakingJudgesScore(2);
    h.aggregateSpeaking.mockResolvedValueOnce({ report: scoreReport("listen_repeat", returned, 2), provider: "claude" });
    expect((await scoreToTerminal(h, attemptId, listenRepeatRequest)).status).toBe("done");

    const after = committedState(h, attemptId);
    expect(after.items.find((i) => i.item_id === omitted)).toEqual(before.items.find((i) => i.item_id === omitted));
    expect(after.judgeReports.filter((r) => r.item_id === omitted)).toEqual(before.judgeReports.filter((r) => r.item_id === omitted));
    for (const itemId of returned) {
      expect(after.items.find((i) => i.item_id === itemId)).toMatchObject({ score: 2, scoring_status: "scored" });
    }
  });
});

// A client that stopped waiting for the first answer, or reloaded before it recorded it, sends the
// same essay again. That must not abort the Judges already at work and buy the run a second time.
describe("the same essay sent again while it is being scored", () => {
  function heldJudges(h: Harness, score: number) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.judgeEssay.mockImplementation(async (judge) => {
      await gate;
      return { report: judgeReport(judge, "email", [emailId], score), provider: judge === "gemini" ? "gemini-http" : "openai-http" } as never;
    });
    h.aggregate.mockResolvedValue({ report: scoreReport("email", [emailId], score), provider: "claude" });
    return release;
  }
  const jobs = (h: Harness, attemptId: string) =>
    h.db.prepare("SELECT id, status FROM scoring_jobs WHERE attempt_id=? ORDER BY created_at, rowid").all(attemptId) as { id: string; status: string }[];

  it("joins the job already scoring it: one job, each Judge called once", async () => {
    const h = harness();
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID);
    const release = heldJudges(h, 4);

    const first = await postScore(h, attemptId, emailRequest());
    const second = await postScore(h, attemptId, emailRequest());
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const firstJob = ((await first.json()) as { jobId: string }).jobId;
    expect(((await second.json()) as { jobId: string }).jobId).toBe(firstJob);
    expect(jobs(h, attemptId)).toHaveLength(1);

    release();
    await vi.waitFor(() => expect(h.repo.getAttempt(attemptId)!.items[0].score).toBe(4), { timeout: 2000, interval: 5 });
    expect(jobs(h, attemptId)).toEqual([{ id: firstJob, status: "done" }]);
    expect(h.judgeEssay).toHaveBeenCalledTimes(2);
    expect(h.aggregate).toHaveBeenCalledTimes(1);
  });

  it("still replaces the job when the text has changed", async () => {
    const h = harness();
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID);
    const release = heldJudges(h, 4);

    const first = ((await (await postScore(h, attemptId, emailRequest())).json()) as { jobId: string }).jobId;
    const second = ((await (await postScore(h, attemptId, emailRequest(`${ESSAY} One more sentence.`))).json()) as { jobId: string }).jobId;
    expect(second).not.toBe(first);
    expect(h.repo.getScoringJob(first)).toMatchObject({ status: "cancelled", cancellation_reason: "superseded" });

    release();
    await vi.waitFor(() => expect(h.repo.getScoringJob(second)!.status).toBe("done"), { timeout: 2000, interval: 5 });
  });

  it("starts a new job once the first has ended, which is how a Re-score is asked for", async () => {
    const h = harness();
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID);
    h.essayJudgesScore(4);
    h.aggregate.mockResolvedValue({ report: scoreReport("email", [emailId], 4), provider: "claude" });
    await scoreToTerminal(h, attemptId, emailRequest());

    await scoreToTerminal(h, attemptId, emailRequest());
    expect(jobs(h, attemptId).map((job) => job.status)).toEqual(["done", "done"]);
  });
});

describe("the essay Response is recorded by the route, before its scoring job runs", () => {
  afterEach(() => {
    resetJobAdmissionsForTests();
  });

  it("is persisted even when the job runner never gets to run the job", async () => {
    // A runner that cannot claim the job exits before scoring starts, so the Response can only come
    // from the route itself.
    const h = harness({ claimScoringJobRunning: () => "unclaimable" });
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID);

    const res = await postScore(h, attemptId, emailRequest());

    expect(res.status).toBe(202);
    expect(h.judgeEssay).not.toHaveBeenCalled();
    expect(h.repo.getAttempt(attemptId)!.items).toEqual([
      expect.objectContaining({ item_id: emailId, task_type: "email", response_text: ESSAY, scoring_status: "pending" }),
    ]);
  });

  it("is not written for a request the route refuses", async () => {
    const h = harness();
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID);

    const unknownItem = await postScore(h, attemptId, { taskType: "email", items: [{ itemId: "email-nope", text: ESSAY, secondsUsed: 1 }] });
    expect(unknownItem.status).toBe(404);
    stopJobAdmissions();
    const shuttingDown = await postScore(h, attemptId, emailRequest());
    expect(shuttingDown.status).toBe(503);

    expect(h.repo.getAttempt(attemptId)!.items).toEqual([]);
  });
});

describe("the Response upsert", () => {
  function scoredRow(h: Harness, row: { itemId: string; taskType: string; responseText?: string; responseAudioPath?: string; transcript?: string }) {
    h.repo.insertItemResult({ attemptId: "att", ...row });
    h.repo.updateItemScore({ attemptId: "att", itemId: row.itemId, score: 4, scoreJson: "{}", scoringStatus: "scored" });
  }
  const row = (h: Harness, itemId: string) => h.repo.getAttempt("att")!.items.find((i) => i.item_id === itemId)!;

  it("resets a scored take when the Item is re-recorded, even onto the same canonical path", () => {
    const h = harness();
    h.repo.createAttempt({ id: "att", kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const audio = "audio/responses/att/lr-1.webm";
    scoredRow(h, { itemId: "lr-1", taskType: "listen_repeat", responseAudioPath: audio, transcript: "old take" });

    h.repo.insertItemResult({ attemptId: "att", itemId: "lr-1", taskType: "listen_repeat", responseAudioPath: audio, scoringStatus: "transcription_pending" });

    expect(row(h, "lr-1")).toMatchObject({ score: null, score_json: null, scored_at: null, transcript: null, scoring_status: "transcription_pending" });
  });

  it("keeps a committed score only for the same text; a failed Item written again goes back to pending", () => {
    const h = harness();
    h.repo.createAttempt({ id: "att", kind: "writing", mode: "drill", setId: WRITING_SET_ID, isRepeat: false });
    scoredRow(h, { itemId: "email-1", taskType: "email", responseText: ESSAY });
    h.repo.insertItemResult({ attemptId: "att", itemId: "disc-1", taskType: "discussion", responseText: ESSAY });
    h.repo.updateItemScore({ attemptId: "att", itemId: "disc-1", score: null, scoreJson: '{"error":"x"}', scoringStatus: "failed" });

    h.repo.insertItemResult({ attemptId: "att", itemId: "email-1", taskType: "email", responseText: ESSAY });
    h.repo.insertItemResult({ attemptId: "att", itemId: "disc-1", taskType: "discussion", responseText: ESSAY });

    expect(row(h, "email-1")).toMatchObject({ score: 4, scoring_status: "scored" });
    expect(row(h, "disc-1")).toMatchObject({ score: null, score_json: null, scoring_status: "pending" });
  });
});
