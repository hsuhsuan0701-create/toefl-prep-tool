import { describe, expect, it, vi } from "vitest";
import type { AnySet, JudgeReport, ScoreReport } from "@toefl-prep/shared";
import { readBankSet } from "./helpers/setFixtures.js";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { openDb } from "../src/db/db.js";
import type { aggregate as realAggregate } from "../src/services/arbiter.js";
import type { judgeEssay as realJudgeEssay } from "../src/services/judges/index.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// An Email or Academic Discussion with no words (nothing, or only whitespace) is the written
// counterpart of a recording with no speech: a deterministic 0 that says no Response was written,
// scored without a Judge or the Arbiter, and counted in the Band Estimate like any other 0
// (docs/adr/0018). A single word is an essay, and goes to the Judges.

const WRITING_SET_ID = "wri-77af733e";
const writing = readBankSet("writing", WRITING_SET_ID) as Extract<AnySet, { kind: "writing" }>;
const emailId = writing.email.id;
const discussionId = writing.academicDiscussion.id;

function judgeReport(judge: "gemini" | "openai", taskType: "email" | "discussion", itemId: string, score: number): JudgeReport {
  return { judge, taskType, items: [{ itemId, score, dimensions: [{ name: "d", score, evidence: "e" }], deductions: [] }] };
}

function scoreReport(taskType: "email" | "discussion", itemId: string, finalScore: number): ScoreReport {
  return {
    taskType,
    items: [{
      itemId, ownScore: finalScore, finalScore, maxScore: 5,
      dimensions: [{ name: "d", note: "n" }], deductions: [], reconciliationNote: "agreed", feedbackZh: "好。",
    }],
  };
}

function setup() {
  const db = openDb(":memory:");
  const repo = sqliteStores(db);
  const judgeEssay = vi.fn<typeof realJudgeEssay>(async (judge, input) => ({
    report: judgeReport(judge, input.taskType, input.taskType === "email" ? emailId : discussionId, 2),
    provider: judge === "gemini" ? "gemini-http" : "openai-http",
  }) as never);
  const aggregate = vi.fn<typeof realAggregate>(async (input) => ({
    report: scoreReport(input.taskType as "email" | "discussion", input.itemId, 2),
    provider: "claude" as const,
  }));
  const scoreDeps = { repo, judgeEssay, aggregate, judgeSpeaking: vi.fn(), aggregateSpeaking: vi.fn() };
  const app = buildAttemptsRoutes({ ...scoreDeps, ...createSpeakingCoordinators({ ...scoreDeps, hearRecording: vi.fn() }) });
  return { db, repo, app, judgeEssay, aggregate };
}
type Setup = ReturnType<typeof setup>;

async function createAttempt(s: Setup, mode: "drill" | "simulation") {
  const res = await s.app.request("/", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "writing", mode, setId: WRITING_SET_ID }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { attemptId: string }).attemptId;
}

async function post(s: Setup, path: string, body?: unknown) {
  return s.app.request(path, {
    method: "POST",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
}

async function scoreEssay(s: Setup, attemptId: string, taskType: "email" | "discussion", text: string) {
  const itemId = taskType === "email" ? emailId : discussionId;
  const res = await post(s, `/${attemptId}/score`, { taskType, items: [{ itemId, text, secondsUsed: 30 }] });
  expect(res.status).toBe(202);
  const { jobId } = (await res.json()) as { jobId: string };
  let job!: { status: string; result?: { report: ScoreReport; judges: unknown[]; judgesFailed: unknown[] } };
  await vi.waitFor(async () => {
    job = (await (await s.app.request(`/${attemptId}/score-jobs/${jobId}`)).json()) as typeof job;
    expect(["done", "failed"]).toContain(job.status);
  });
  return job;
}

function itemRow(s: Setup, attemptId: string, itemId: string) {
  return s.repo.getAttempt(attemptId)!.items.find((i) => i.item_id === itemId)!;
}

function diagnosticRows(s: Setup): number {
  return (s.db.prepare("SELECT (SELECT COUNT(*) FROM route_invocations) + (SELECT COUNT(*) FROM provider_executions) + (SELECT COUNT(*) FROM model_attempts) AS n").get() as { n: number }).n;
}

describe("an essay with no words", () => {
  it.each([
    ["empty", ""],
    ["whitespace-only", "   \n\n   \t  "],
  ])("scores a deterministic 0 with no Judge or Arbiter call when it is %s", async (_label, text) => {
    const s = setup();
    const attemptId = await createAttempt(s, "drill");

    const job = await scoreEssay(s, attemptId, "email", text);

    expect(job.status).toBe("done");
    expect(s.judgeEssay).not.toHaveBeenCalled();
    expect(s.aggregate).not.toHaveBeenCalled();
    expect(diagnosticRows(s)).toBe(0);

    // The Response is stored as sent, and the Item ends scored 0 with a Score Report that says no
    // Response was written, names no provider, and has no Judge Report behind it.
    const row = itemRow(s, attemptId, emailId);
    expect(row).toMatchObject({ response_text: text, scoring_status: "scored", score: 0 });
    const scoreJson = JSON.parse(row.score_json!);
    expect(scoreJson).toEqual({
      itemId: emailId, ownScore: 0, finalScore: 0, maxScore: 5, dimensions: [], deductions: [],
      reconciliationNote: expect.stringMatching(/No Response was written/), feedbackZh: expect.any(String),
      noWordsWritten: true,
    });
    expect(row.score_json).not.toMatch(/claude|codex|gemini|openai/i);
    expect(s.repo.getJudgeReports(attemptId)).toEqual([]);

    // The job's own result carries the 0, so the Drill renders it like any scored essay.
    expect(job.result).toMatchObject({ report: { items: [{ itemId: emailId, finalScore: 0, noWordsWritten: true }] }, judges: [], judgesFailed: [] });
    expect(JSON.stringify(job)).not.toMatch(/claude|codex|gemini|openai/i);

    // And the Attempt detail the review renders from carries it as an ordinary scored Item.
    const detail = (await (await s.app.request(`/${attemptId}`)).json()) as {
      items: Array<{ itemId: string; scoringStatus: string; score: number | null; scoreJson: Record<string, unknown> }>;
    };
    expect(detail.items.find((i) => i.itemId === emailId)).toMatchObject({
      scoringStatus: "scored", score: 0, scoreJson: { finalScore: 0, noWordsWritten: true },
    });
  });

  it("is a boundary at whitespace: a one-word essay still goes to the Judges and the Arbiter", async () => {
    const s = setup();
    const attemptId = await createAttempt(s, "drill");

    const job = await scoreEssay(s, attemptId, "discussion", "  Agree.\n");

    expect(job.status).toBe("done");
    expect(s.judgeEssay).toHaveBeenCalledTimes(2);
    expect(s.aggregate).toHaveBeenCalledTimes(1);
    const row = itemRow(s, attemptId, discussionId);
    expect(row).toMatchObject({ scoring_status: "scored", score: 2 });
    expect(JSON.parse(row.score_json!).noWordsWritten).toBeUndefined();
  });

  it("lets a completed Writing Simulation whose only gap was an empty essay have its Band Estimate", async () => {
    const s = setup();
    const attemptId = await createAttempt(s, "simulation");

    const bas = await post(s, `/${attemptId}/score`, {
      taskType: "build_sentence",
      items: writing.buildASentence.items.map((item) => ({ itemId: item.id, tileOrder: item.answers[0] })),
    });
    expect(bas.status).toBe(200);
    expect((await scoreEssay(s, attemptId, "email", "")).status).toBe("done");
    expect((await scoreEssay(s, attemptId, "discussion", "I agree with Kelly, because a shared schedule helps everyone plan.")).status).toBe("done");

    const completed = await post(s, `/${attemptId}/complete`);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ status: "completed", estimate: { section: "writing" } });
    expect(s.repo.getSectionEstimate(attemptId)).toBeDefined();
    // Only the discussion reached the Judges.
    expect(s.judgeEssay.mock.calls.map((call) => call[1].taskType)).toEqual(["discussion", "discussion"]);
  });

  it("is scored 0 by a Re-score too, which calls no Judge", async () => {
    const s = setup();
    const attemptId = await createAttempt(s, "simulation");
    // An empty essay that failed scoring before this rule existed: the review offers it a Re-score,
    // which re-sends the stored text.
    s.repo.insertItemResult({ attemptId, itemId: emailId, taskType: "email", responseText: " " });
    s.repo.updateItemScore({ attemptId, itemId: emailId, score: null, scoreJson: JSON.stringify({ error: "both judges failed" }), scoringStatus: "failed" });
    s.repo.insertJudgeReport({ attemptId, itemId: emailId, judge: "gemini", reportJson: "{}" });
    // Completed, so this is the review's Re-score of a completed Attempt.
    expect((await post(s, `/${attemptId}/complete`)).status).toBe(200);
    expect(s.repo.getAttempt(attemptId)!.status).toBe("completed");

    const job = await scoreEssay(s, attemptId, "email", " ");

    expect(job.status).toBe("done");
    expect(s.judgeEssay).not.toHaveBeenCalled();
    expect(s.aggregate).not.toHaveBeenCalled();
    expect(itemRow(s, attemptId, emailId)).toMatchObject({ scoring_status: "scored", score: 0 });
    expect(s.repo.getJudgeReports(attemptId)).toEqual([]);
  });
});
