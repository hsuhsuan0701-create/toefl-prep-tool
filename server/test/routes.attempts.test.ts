import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readBankSet } from "./helpers/setFixtures.js";
import { SKIPPED_ITEM_REASON, type DeliveryReport, type JudgeReport, type ScoreReport, type TranscriptionJobVM } from "@toefl-prep/shared";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { openSqliteStores } from "./helpers/sqliteStores.js";
import { at } from "./helpers/timestamps.js";
import { deferred } from "./helpers/deferred.js";
import { skillSuccess } from "./helpers/skillResults.js";
import { fakeMedia } from "./helpers/fakeMedia.js";
import { useFakeTimersInTest } from "./helpers/fakeTimers.js";
import { sqliteTimestamp } from "../src/db/timestamps.js";
import { config } from "../src/lib/config.js";
import { aggregate as realAggregate, aggregateSpeaking as realAggregateSpeaking } from "../src/services/arbiter.js";
import type { hearRecording as realHearRecording } from "../src/services/ears.js";
import { JudgeError } from "../src/services/judges/index.js";
import type { judgeSpeaking as realJudgeSpeaking } from "../src/services/judges/speaking.js";
import { providerState } from "../src/services/reasoning/providerState.js";
import { scoreItems, type ScoringProgress } from "../src/services/scoreItems.js";
import { createSpeakingCoordinators, SetUnavailable } from "../src/services/speakingFinalization.js";
import { CAPTURE_RETRY_BUDGET_MS, retryWithinBudget } from "../../client/src/lib/captureRetry.js";
import { EarsError } from "../src/services/ears.js";

type AggregateInput = Parameters<typeof realAggregate>[0];
type AggregateOptions = Parameters<typeof realAggregate>[1];
type AggregateSpeakingInput = Parameters<typeof realAggregateSpeaking>[0];

const flatDeliveryReport: DeliveryReport = {
  paceWpm: 140,
  pauses: "no notable pauses",
  intelligibility: "clear throughout",
  suspectedMispronunciations: [],
  intonation: "flat",
};
const SECRET =
  "ORCHESTRATION_LOG_CANARY sk-live-private-diagnostic";

const SET_ID = "wri-77af733e";
const fixture = readBankSet("writing", SET_ID);
const bas1 = fixture.buildASentence.items[0]; // "bas-1"
const bas2 = fixture.buildASentence.items[1]; // "bas-2"
const emailId = fixture.email.id; // "email-1"

const SPEAKING_SET_ID = "spk-e5b2b735";
const speakingFixture = readBankSet("speaking", SPEAKING_SET_ID);
const lr1Id = speakingFixture.listenAndRepeat.items[0].id; // "lr-1"
const lr1Sentence = speakingFixture.listenAndRepeat.items[0].sentence;
const int1Id = speakingFixture.interview.questions[0].id; // "int-1"
const int1Question = speakingFixture.interview.questions[0].question;

// Copied into a plain Uint8Array<ArrayBuffer> (not Node's Buffer, whose ArrayBufferLike can widen
// to SharedArrayBuffer) so it is assignable as a File/BlobPart under the strict DOM lib types.
const TINY_WEBM = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "fixtures/tiny.webm"))); // 635 bytes, real duration ~0.2s
// A real (silent) ~3s clip, for tests that need a duration above scoreItems.ts's
// MIN_PACE_DURATION_SEC (2s), so the paceWpm computation runs rather than its short-clip guard (see
// the "guards against absurd paceWpm" test below).
const THREE_SEC_WEBM = new Uint8Array(fs.readFileSync(path.join(import.meta.dirname, "fixtures/three-sec.webm")));

function makeJudgeReport(judge: "gemini" | "openai", score: number): JudgeReport {
  return {
    judge,
    taskType: "email",
    items: [
      {
        itemId: emailId,
        score,
        dimensions: [{ name: "mechanics", score, evidence: "clean spelling" }],
        deductions: [],
      },
    ],
  };
}

function essayJudgeResult(
  judge: "gemini" | "openai",
  score: number,
  provider:
    | "gemini-http"
    | "codex"
    | "openai-http" =
    judge === "gemini" ? "gemini-http" : "codex"
) {
  return {
    report: makeJudgeReport(judge, score),
    provider,
  };
}

const fixedScoreReport: ScoreReport = {
  taskType: "email",
  items: [
    {
      itemId: emailId,
      ownScore: 4,
      finalScore: 4,
      maxScore: 5,
      dimensions: [{ name: "mechanics", note: "solid" }],
      deductions: [],
      reconciliationNote: "judges agreed closely",
      feedbackZh: "寫得不錯。",
    },
  ],
};

function arbitration(report: ScoreReport, provider: "claude" | "codex" = "claude") {
  return { report, provider };
}

// The route factory takes the two speaking coordinators explicitly. They are the real
// implementations over this test's private `:memory:` database: a fake would have to reimplement
// admitRecording's claim-time item write, hash idempotency and snapshot rules, which is the
// behavior these route tests observe, and would let the route and the coordinators drift apart
// unnoticed. Their one seam to the outside world, `hearRecording`, is the fake that makes them
// deterministic.
function buildTestApp() {
  const testRepo = openSqliteStores();
  const judgeEssay = vi.fn();
  const aggregate = vi.fn<typeof realAggregate>(async (_input: AggregateInput) =>
    arbitration(fixedScoreReport)
  );
  const hearRecording = vi.fn<typeof realHearRecording>();
  const judgeSpeaking = vi.fn<typeof realJudgeSpeaking>();
  const aggregateSpeaking = vi.fn<typeof realAggregateSpeaking>();
  // In-process ffmpeg/ffprobe (helpers/fakeMedia.ts) for uploads and interview scoring alike: real
  // child processes are a per-call cost that grows with machine load until a test times out.
  const scoreDeps = {
    repo: testRepo, judgeEssay, aggregate, judgeSpeaking, aggregateSpeaking,
    probeDurationSec: fakeMedia.probeDurationSec,
  };
  // The composition point index.ts uses, so the callback cycle, the composition order and the
  // per-database singleton come from production rather than being restated here.
  const coordinators = createSpeakingCoordinators({ ...scoreDeps, hearRecording });
  const app = buildAttemptsRoutes({ ...scoreDeps, ...coordinators, transcode: fakeMedia.transcode });
  return {
    app, repo: testRepo, judgeEssay, aggregate, hearRecording, judgeSpeaking, aggregateSpeaking,
    ...coordinators,
  };
}

async function createAttempt(
  app: ReturnType<typeof buildAttemptsRoutes>,
  setId = SET_ID,
  kind: "writing" | "speaking" = "writing",
  mode: "drill" | "simulation" = "drill"
) {
  const res = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, mode, setId }),
  });
  return (await res.json()) as { attemptId: string; isRepeat: boolean };
}

async function uploadAudio(
  app: ReturnType<typeof buildAttemptsRoutes>,
  attemptId: string,
  itemId: string,
  bytes: Uint8Array<ArrayBuffer> = TINY_WEBM
) {
  const form = new FormData();
  form.append("file", new File([bytes], "rec.webm", { type: "audio/webm" }));
  return app.request(`/${attemptId}/items/${itemId}/audio`, { method: "POST", body: form });
}

function cleanupResponsesDir(attemptId: string) {
  fs.rmSync(path.join(config.dataDir, "audio/responses", attemptId), { recursive: true, force: true });
}

function renderedLogCalls(
  log: { mock: { calls: unknown[][] } }
): string {
  return log.mock.calls
    .flat()
    .map((value) => String(value))
    .join(" ");
}

type ScoreJobBody = { jobId: string; status: string; stage: string | null; progress: unknown; result?: unknown; error?: string };

async function postScore(app: ReturnType<typeof buildAttemptsRoutes>, attemptId: string, requestBody: unknown) {
  return app.request(`/${attemptId}/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });
}

async function getScoreJob(app: ReturnType<typeof buildAttemptsRoutes>, attemptId: string, jobId: string) {
  const res = await app.request(`/${attemptId}/score-jobs/${jobId}`);
  return { status: res.status, body: (await res.json()) as ScoreJobBody };
}

// Posts a score request for a judged Task Type (every one but build_sentence, which scores
// synchronously), asserts the 202 + jobId answer, then polls GET /:id/score-jobs/:jobId until the job
// is terminal (done, failed, superseded or cancelled). Returns the jobId and the job's body in that
// terminal state; a 'done' job's `result` is the score payload.
async function scoreAsync(app: ReturnType<typeof buildAttemptsRoutes>, attemptId: string, requestBody: unknown) {
  const res = await postScore(app, attemptId, requestBody);
  expect(res.status).toBe(202);
  const { jobId } = (await res.json()) as { jobId: string };
  let job!: ScoreJobBody;
  await vi.waitFor(async () => {
    const current = await getScoreJob(app, attemptId, jobId);
    if (!["done", "failed", "superseded", "cancelled"].includes(current.body.status)) {
      throw new Error(`job ${jobId} not terminal yet: ${current.body.status}`);
    }
    job = current.body;
  }, { timeout: 2000, interval: 5 });
  return { jobId, job };
}

function makeSpeakingJudgeReport(judgeName: "gemini" | "openai", itemIds: string[], score: number): JudgeReport {
  return {
    judge: judgeName, taskType: "listen_repeat",
    items: itemIds.map((itemId) => ({
      itemId, score,
      dimensions: [{ name: "intelligibility", score, evidence: "clear audio" }],
      deductions: [],
    })),
  };
}

function makeSpeakingScoreReport(itemIds: string[], finalScore = 4): ScoreReport {
  return {
    taskType: "listen_repeat",
    items: itemIds.map((itemId) => ({
      itemId, ownScore: finalScore, finalScore, maxScore: 5,
      dimensions: [{ name: "intelligibility", note: "ok" }],
      deductions: [], reconciliationNote: "agreed", feedbackZh: "表現不錯。",
    })),
  };
}

async function uploadAllListenRepeat(
  ctx: ReturnType<typeof buildTestApp>,
  attemptId: string,
  transcript = "we open the front desk at six"
) {
  ctx.hearRecording.mockResolvedValue({ transcript, deliveryReport: flatDeliveryReport });
  for (const item of speakingFixture.listenAndRepeat.items) {
    const res = await uploadAudio(ctx.app, attemptId, item.id);
    expect(res.status).toBe(200);
  }
}

describe("attempts routes", () => {
  let ctx: ReturnType<typeof buildTestApp>;

  beforeEach(() => {
    ctx = buildTestApp();
  });

  it("creates an attempt (isRepeat false), then isRepeat true on a second attempt for the same set once the first is completed holding an Item", async () => {
    const first = await createAttempt(ctx.app);
    expect(typeof first.attemptId).toBe("string");
    expect(first.attemptId.length).toBeGreaterThan(0);
    expect(first.isRepeat).toBe(false);

    // An open Attempt with nothing scored is not a sitting of the Set
    // (routes.attempts.repeat.test.ts covers the rule).
    const res1 = await ctx.app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "writing", mode: "drill", setId: SET_ID }),
    });
    expect(res1.status).toBe(201);
    expect(((await res1.json()) as { isRepeat: boolean }).isRepeat).toBe(false);
    // Completed holding an Item, so it is a sitting even though nothing in it is scored.
    ctx.repo.insertItemResult({ attemptId: first.attemptId, itemId: "email-1", taskType: "email", responseText: "draft" });
    expect((await ctx.app.request(`/${first.attemptId}/complete`, { method: "POST" })).status).toBe(200);

    const second = await createAttempt(ctx.app);
    expect(second.isRepeat).toBe(true);
    expect(second.attemptId).not.toBe(first.attemptId);
  });

  it("404s an unknown setId, and 400s a kind that is not a section or does not match the Set", async () => {
    const notFound = await ctx.app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "writing", mode: "drill", setId: "no-such-set" }),
    });
    expect(notFound.status).toBe(404);

    const mismatchedKind = await ctx.app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "speaking", mode: "drill", setId: SET_ID }),
    });
    expect(mismatchedKind.status).toBe(400);

    const unknownKind = await ctx.app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "essay", mode: "drill", setId: SET_ID }),
    });
    expect(unknownKind.status).toBe(400);
    expect(ctx.repo.listAttempts()).toEqual([]);
  });

  it("scores build_sentence: item 1 correct, item 2 wrong, correctAnswers revealed, persisted 1/0 scored", async () => {
    const { attemptId } = await createAttempt(ctx.app);

    const res = await ctx.app.request(`/${attemptId}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskType: "build_sentence",
        items: [
          { itemId: bas1.id, tileOrder: bas1.answers[0] },
          { itemId: bas2.id, tileOrder: ["the photography exhibit.", "We", "enjoy"] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      taskType: string;
      items: { itemId: string; correct: boolean; matchedAnswer: string[] | null; correctAnswers: string[][] }[];
    };
    expect(body.taskType).toBe("build_sentence");
    expect(body.items[0].correct).toBe(true);
    expect(body.items[0].matchedAnswer).toEqual(bas1.answers[0]);
    expect(body.items[0].correctAnswers).toEqual(bas1.answers);
    expect(body.items[1].correct).toBe(false);
    expect(body.items[1].matchedAnswer).toBeNull();
    expect(body.items[1].correctAnswers).toEqual(bas2.answers);

    const attempt = ctx.repo.getAttempt(attemptId);
    expect(attempt?.items).toHaveLength(2);
    const item1 = attempt?.items.find((i) => i.item_id === bas1.id);
    const item2 = attempt?.items.find((i) => i.item_id === bas2.id);
    expect(item1?.score).toBe(1);
    expect(item1?.scoring_status).toBe("scored");
    expect(item2?.score).toBe(0);
    expect(item2?.scoring_status).toBe("scored");
  });

  it("scores email with both judges resolving and an arbiter stub: 202+jobId, job resolves done with report + judges + judgesFailed [], 2 judge_reports rows, item score = finalScore", async () => {
    const { attemptId } = await createAttempt(ctx.app);
    ctx.judgeEssay.mockImplementation(async (judge: "gemini" | "openai") =>
      judge === "gemini" ? essayJudgeResult("gemini", 4) : essayJudgeResult("openai", 3.5)
    );

    const { job } = await scoreAsync(ctx.app, attemptId, { taskType: "email", items: [{ itemId: emailId, text: "Dear team, ...", secondsUsed: 200 }] });
    expect(job.status).toBe("done");
    const body = job.result as {
      taskType: string;
      report: ScoreReport;
      judges: { judge: string; score: number }[];
      judgesFailed: string[];
    };
    expect(body.taskType).toBe("email");
    expect(body.report).toEqual(fixedScoreReport);
    expect(body.judges).toHaveLength(2);
    expect(body.judges.map((j) => j.judge).sort()).toEqual(["gemini", "openai"]);
    expect(body.judgesFailed).toEqual([]);
    for (const judge of body.judges) {
      expect(judge).not.toHaveProperty("provider");
    }

    const persistedJudgeReports =
      ctx.repo.getJudgeReports(attemptId);
    expect(persistedJudgeReports).toHaveLength(2);
    for (const row of persistedJudgeReports) {
      expect(JSON.parse(row.report_json)).not.toHaveProperty(
        "provider"
      );
    }
    const attempt = ctx.repo.getAttempt(attemptId);
    const item = attempt?.items.find((i) => i.item_id === emailId);
    expect(item?.score).toBe(fixedScoreReport.items[0].finalScore);
    expect(item?.scoring_status).toBe("scored");
  });

  it("persists Codex self-arbitration, includes it in the Band Estimate, and clears it only after an independent manual re-score", async () => {
    const { attemptId } = await createAttempt(ctx.app);
    let openaiProvider: "codex" | "openai-http" = "codex";
    let modelClaim = false;
    ctx.judgeEssay.mockImplementation(async (judge: "gemini" | "openai") =>
      judge === "gemini"
        ? essayJudgeResult("gemini", 4)
        : essayJudgeResult("openai", 4, openaiProvider)
    );
    ctx.aggregate.mockImplementation(async (aggregateInput, options) =>
      realAggregate(aggregateInput, {
        ...options,
        runSkillTask: async () => skillSuccess({
          ...fixedScoreReport,
          items: [{
            ...fixedScoreReport.items[0],
            selfArbitrated: modelClaim,
          }],
        }, "codex"),
      })
    );

    const scoreRequest = {
      taskType: "email",
      items: [{ itemId: emailId, text: "Dear team, ...", secondsUsed: 200 }],
    };
    const { job: selfArbitratedJob } = await scoreAsync(ctx.app, attemptId, scoreRequest);
    expect(selfArbitratedJob.status).toBe("done");
    expect(ctx.aggregate.mock.calls[0][0].openaiJudgeProvider).toBe("codex");
    expect((selfArbitratedJob.result as { report: ScoreReport }).report.items[0].selfArbitrated).toBe(true);

    let persisted = ctx.repo.getAttempt(attemptId)?.items.find((item) => item.item_id === emailId);
    expect(JSON.parse(persisted!.score_json!)).toMatchObject({ selfArbitrated: true });

    const reload = await ctx.app.request(`/${attemptId}`);
    const reloadedItem = ((await reload.json()) as {
      items: { itemId: string; scoreJson: { selfArbitrated?: boolean } }[];
    }).items.find((item) => item.itemId === emailId);
    expect(reloadedItem?.scoreJson.selfArbitrated).toBe(true);

    // A Writing band needs every Writing Task Type scored; the other two are seeded directly.
    ctx.repo.insertItemResult({ attemptId, itemId: bas1.id, taskType: "build_sentence" });
    ctx.repo.updateItemScore({ attemptId, itemId: bas1.id, score: 1, scoreJson: "{}", scoringStatus: "scored" });
    ctx.repo.insertItemResult({ attemptId, itemId: "disc-1", taskType: "discussion" });
    ctx.repo.updateItemScore({ attemptId, itemId: "disc-1", score: 4, scoreJson: "{}", scoringStatus: "scored" });

    const complete = await ctx.app.request(`/${attemptId}/complete`, { method: "POST" });
    const completion = (await complete.json()) as {
      estimate: {
        band: number;
        raw: number;
        coverage: { taskType: string; itemCount: number; skippedCount?: number }[];
      };
    };
    expect(completion.estimate.coverage).toContainEqual({ taskType: "email", itemCount: 1, skippedCount: 0 });
    // 0.5 * 1 + 0.25 * 0.8 (the self-arbitrated email) + 0.25 * 0.8 = 0.9 -> 5.5
    expect(completion.estimate.raw).toBeCloseTo(0.9);
    expect(completion.estimate.band).toBe(5.5);

    // Provider-circuit recovery is passive. Closing the real application-wide provider circuit
    // must not create a fresh scoring job or silently replace the disclosed result. A circuit
    // closes only through a request's probe once its cooldown has passed.
    const recoverCodex = async () => {
      if (!providerState.circuitOpen("codex")) return;
      const afterCooldown = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
      try {
        await providerState.checkCircuit("codex", {
          requestId: "recovery-probe",
          queuedAtMs: Date.now(),
          submittedWhileOpen: true,
        });
        providerState.recordExecution("codex", { ok: true, provider: "codex", value: undefined }, "recovery-probe");
      } finally {
        afterCooldown.mockRestore();
      }
    };
    const jobsBeforeRecovery = ctx.repo.listAllScoringJobs().length;
    try {
      providerState.recordPreflight("codex", { ok: false, kind: "quota" });
      expect(providerState.snapshot().find(({ provider }) => provider === "codex")?.availability)
        .toBe("circuit-open");
      await recoverCodex();
      expect(providerState.snapshot().find(({ provider }) => provider === "codex")?.availability)
        .toBe("available");
      await Promise.resolve();
      expect(ctx.repo.listAllScoringJobs()).toHaveLength(jobsBeforeRecovery);
      persisted = ctx.repo.getAttempt(attemptId)?.items.find((item) => item.item_id === emailId);
      expect(JSON.parse(persisted!.score_json!)).toMatchObject({ selfArbitrated: true });
    } finally {
      await recoverCodex();
    }

    // A user-initiated re-score with an independent OpenAI Judge report replaces score_json.
    openaiProvider = "openai-http";
    modelClaim = true;
    const { job: independentJob } = await scoreAsync(ctx.app, attemptId, scoreRequest);
    expect(independentJob.status).toBe("done");
    expect(ctx.aggregate.mock.calls[1][0].openaiJudgeProvider).toBe("openai-http");
    expect((independentJob.result as { report: ScoreReport }).report.items[0].selfArbitrated).toBeUndefined();

    persisted = ctx.repo.getAttempt(attemptId)?.items.find((item) => item.item_id === emailId);
    expect(JSON.parse(persisted!.score_json!)).not.toHaveProperty("selfArbitrated");
    const independentReload = await ctx.app.request(`/${attemptId}`);
    const independentReloadItem = ((await independentReload.json()) as {
      items: { itemId: string; scoreJson: { selfArbitrated?: boolean } }[];
    }).items.find((item) => item.itemId === emailId);
    expect(independentReloadItem).toBeDefined();
    expect(independentReloadItem!.scoreJson).not.toHaveProperty("selfArbitrated");
  });

  it("keeps the OpenAI essay report and its Codex provenance when progress reporting throws", async () => {
    const { attemptId } = await createAttempt(ctx.app);
    ctx.judgeEssay.mockImplementation(async (judge: "gemini" | "openai") =>
      judge === "gemini"
        ? essayJudgeResult("gemini", 4)
        : essayJudgeResult("openai", 4, "codex")
    );
    ctx.aggregate.mockImplementation(async (aggregateInput, options) =>
      realAggregate(aggregateInput, {
        ...options,
        runSkillTask: async () => skillSuccess({
          ...fixedScoreReport,
          items: [{
            ...fixedScoreReport.items[0],
            selfArbitrated: true,
          }],
        }, "codex"),
      })
    );
    const onProgress = vi.fn((progress: ScoringProgress) => {
      const done = progress.detail?.judgesDone;
      if (Array.isArray(done) && done.includes("openai")) {
        throw new Error("progress persistence failed");
      }
    });

    const result = await scoreItems(
      {
        repo: ctx.repo,
        judgeEssay: ctx.judgeEssay,
        aggregate: ctx.aggregate,
      },
      attemptId,
      fixture,
      {
        taskType: "email",
        items: [{ itemId: emailId, text: "Dear team, ...", secondsUsed: 200 }],
      },
      onProgress,
    );

    // The sink really threw, on the OpenAI Judge's settle.
    expect(onProgress.mock.results.some((r) => r.type === "throw")).toBe(true);
    expect(ctx.aggregate.mock.calls[0][0].judgeReports.map((report) => report.judge))
      .toEqual(["gemini", "openai"]);
    expect(ctx.aggregate.mock.calls[0][0].openaiJudgeProvider).toBe("codex");
    if (result.taskType !== "email") throw new Error("unexpected score result");
    expect(result.judgesFailed).toEqual([]);
    expect(result.report.items[0].selfArbitrated).toBe(true);
    const persisted = ctx.repo.getAttempt(attemptId)?.items.find((item) => item.item_id === emailId);
    expect(JSON.parse(persisted!.score_json!)).toMatchObject({ selfArbitrated: true });
  });

  it("scores email when gemini rejects: judgesFailed [gemini], arbiter receives only 1 report, report still present", async () => {
    const { attemptId } = await createAttempt(ctx.app);
    ctx.judgeEssay.mockImplementation(async (judge: "gemini" | "openai") => {
      if (judge === "gemini") throw new Error("gemini unavailable");
      return essayJudgeResult("openai", 3.5, "openai-http");
    });

    const { job } = await scoreAsync(ctx.app, attemptId, { taskType: "email", items: [{ itemId: emailId, text: "Dear team, ...", secondsUsed: 200 }] });
    expect(job.status).toBe("done");
    const body = job.result as { report: ScoreReport; judgesFailed: string[] };
    expect(body.judgesFailed).toEqual(["gemini"]);
    expect(body.report).toEqual(fixedScoreReport);

    expect(ctx.aggregate).toHaveBeenCalledTimes(1);
    const aggregateArg = ctx.aggregate.mock.calls[0][0];
    expect(aggregateArg.judgeReports).toHaveLength(1);
    expect(aggregateArg.judgeReports[0].judge).toBe("openai");
  });

  it.each([
    ["HTTP 401", () => new JudgeError("openai", 401, SECRET), "judge openai failed (401)"],
    ["HTTP 403", () => new JudgeError("openai", 403, SECRET), "judge openai failed (403)"],
    ["unknown error", () => new Error(SECRET), "judge openai failed (internal-failure)"],
  ])(
    "redacts essay judge %s diagnostics from orchestration logs",
    async (_label, makeError, expectedLog) => {
      const errorLog = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      try {
        const { attemptId } = await createAttempt(ctx.app);
        ctx.judgeEssay.mockImplementation(
          async (judge: "gemini" | "openai") => {
            if (judge === "openai") throw makeError();
            return essayJudgeResult("gemini", 4);
          }
        );

        const { job } = await scoreAsync(ctx.app, attemptId, {
          taskType: "email",
          items: [
            {
              itemId: emailId,
              text: "Dear team, ...",
              secondsUsed: 200,
            },
          ],
        });

        expect(job.status).toBe("done");
        expect(errorLog).toHaveBeenCalledTimes(1);
        expect(renderedLogCalls(errorLog)).not.toContain(SECRET);
        expect(renderedLogCalls(errorLog)).toContain(expectedLog);
      } finally {
        errorLog.mockRestore();
      }
    }
  );

  it("counts a terminal Codex+HTTP OpenAI route failure as one rejected OpenAI judge", async () => {
    const { attemptId } = await createAttempt(ctx.app);
    ctx.judgeEssay.mockImplementation(
      async (judge: "gemini" | "openai") => {
        if (judge === "openai") {
          throw new Error(
            "Structured reasoning unavailable: Codex (invalid-output) → OpenAI HTTP (authentication)."
          );
        }
        return essayJudgeResult("gemini", 4);
      }
    );

    const { job } = await scoreAsync(ctx.app, attemptId, {
      taskType: "email",
      items: [
        {
          itemId: emailId,
          text: "Dear team, ...",
          secondsUsed: 200,
        },
      ],
    });

    expect(job.status).toBe("done");
    expect(
      (job.result as { judgesFailed: string[] }).judgesFailed
    ).toEqual(["openai"]);
    expect(ctx.judgeEssay).toHaveBeenCalledTimes(2);
    expect(ctx.aggregate.mock.calls[0][0].judgeReports).toEqual([
      makeJudgeReport("gemini", 4),
    ]);
  });

  it("scores email when both judges reject: job ends failed, item persisted failed, no judge_reports rows", async () => {
    const { attemptId } = await createAttempt(ctx.app);
    ctx.judgeEssay.mockRejectedValue(new Error("down"));

    const { job } = await scoreAsync(ctx.app, attemptId, { taskType: "email", items: [{ itemId: emailId, text: "Dear team, ...", secondsUsed: 200 }] });
    expect(job.status).toBe("failed");
    expect(typeof job.error).toBe("string");
    expect(job.result).toBeUndefined();

    expect(ctx.aggregate).not.toHaveBeenCalled();
    expect(ctx.repo.getJudgeReports(attemptId)).toHaveLength(0);
    const attempt = ctx.repo.getAttempt(attemptId);
    const item = attempt?.items.find((i) => i.item_id === emailId);
    expect(item?.scoring_status).toBe("failed");
    expect(item?.score).toBeNull();
  });

  it("GET /:id returns an AttemptDetailVM: camelCased attempt + items with parsed scoreJson + judge reports parsed with judge/mode surfaced", async () => {
    const { attemptId } = await createAttempt(ctx.app);
    ctx.judgeEssay.mockImplementation(async (judge: "gemini" | "openai") =>
      judge === "gemini" ? essayJudgeResult("gemini", 4) : essayJudgeResult("openai", 3.5)
    );
    const { job } = await scoreAsync(ctx.app, attemptId, { taskType: "email", items: [{ itemId: emailId, text: "Dear team, ...", secondsUsed: 200 }] });
    expect(job.status).toBe("done");

    const res = await ctx.app.request(`/${attemptId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      attempt: { id: string; kind: string; mode: string; setId: string; isRepeat: boolean; captureFinishedAt: string | null };
      items: { itemId: string; taskType: string; scoreJson: unknown }[];
      judgeReports: { itemId: string; judge: string; mode?: string; report: JudgeReport | null }[];
      estimate: unknown | null;
      activeJobs: unknown[];
    };
    expect(body.attempt.id).toBe(attemptId);
    expect(body.attempt.kind).toBe("writing");
    expect(body.attempt.mode).toBe("drill");
    expect(body.attempt.setId).toBe(SET_ID);
    expect(body.attempt.isRepeat).toBe(false);
    expect(body.attempt.captureFinishedAt).toBeNull();

    // Written in sqliteTimestamp()'s space form, as every `*_at` column holds it...
    ctx.repo.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, now: at("2026-07-30 01:02:03"), placeholders: [] });
    const afterCapture = await ctx.app.request(`/${attemptId}`);
    // ...and served as the ISO instant it names: timestamps are normalised at the route boundary,
    // so the client never converts.
    expect(((await afterCapture.json()) as typeof body).attempt.captureFinishedAt).toBe("2026-07-30T01:02:03.000Z");

    const item = body.items.find((i) => i.itemId === emailId);
    expect(item?.taskType).toBe("email");
    expect(item?.scoreJson).toEqual(fixedScoreReport.items[0]);

    expect(Array.isArray(body.judgeReports)).toBe(true);
    expect(body.judgeReports).toHaveLength(2);
    const geminiReport = body.judgeReports.find((r) => r.judge === "gemini");
    expect(geminiReport?.itemId).toBe(emailId);
    expect(geminiReport?.mode).toBeUndefined(); // essay judge reports never carry a mode
    expect(geminiReport?.report).toEqual(makeJudgeReport("gemini", 4));

    // Attempt was never completed, so it never got a section estimate.
    expect(body.estimate).toBeNull();

    // The job finished (status 'done') before this GET fired, so it's no longer active.
    expect(body.activeJobs).toEqual([]);
  });

  it("GET /:id never 500s on corrupt persisted JSON: unparseable score_json/report_json parse to null instead", async () => {
    const { attemptId } = await createAttempt(ctx.app);
    ctx.repo.insertItemResult({ attemptId, itemId: emailId, taskType: "email", responseText: "Dear team, ..." });
    ctx.repo.updateItemScore({ attemptId, itemId: emailId, score: 4, scoreJson: "{not valid json", scoringStatus: "scored" });
    ctx.repo.insertJudgeReport({ attemptId, itemId: emailId, judge: "gemini", reportJson: "{also not valid json" });
    ctx.repo.insertJudgeReport({ attemptId, itemId: emailId, judge: "openai", reportJson: JSON.stringify(makeJudgeReport("openai", 3.5)) });

    const res = await ctx.app.request(`/${attemptId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { itemId: string; scoreJson: unknown }[];
      judgeReports: { judge: string; mode?: string; report: JudgeReport | null }[];
    };
    const item = body.items.find((i) => i.itemId === emailId);
    expect(item?.scoreJson).toBeNull();

    const geminiReport = body.judgeReports.find((r) => r.judge === "gemini");
    expect(geminiReport?.report).toBeNull();
    expect(geminiReport?.mode).toBeUndefined();
    const openaiReport = body.judgeReports.find((r) => r.judge === "openai");
    expect(openaiReport?.report).toEqual(makeJudgeReport("openai", 3.5));
  });

  it("completes an attempt", async () => {
    const { attemptId } = await createAttempt(ctx.app);
    const res = await ctx.app.request(`/${attemptId}/complete`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "completed" });
    expect(ctx.repo.getAttempt(attemptId)?.status).toBe("completed");
  });

  it("completing an attempt with scored items computes + persists a section estimate and includes it in the response", async () => {
    const { attemptId } = await createAttempt(ctx.app);
    // build_sentence: 1 correct, 1 wrong -> normalized avg 0.5 (weight 0.5). email: finalScore 4/5
    // (from the fixed arbiter stub) -> 0.8 (weight 0.25). discussion, seeded below: 4/5 -> 0.8
    // (weight 0.25). raw = 0.25 + 0.2 + 0.2 = 0.65 -> 1 + 3.25 = 4.25, an exact tie -> 4.5.
    await ctx.app.request(`/${attemptId}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskType: "build_sentence",
        items: [
          { itemId: bas1.id, tileOrder: bas1.answers[0] },
          { itemId: bas2.id, tileOrder: ["the photography exhibit.", "We", "enjoy"] },
        ],
      }),
    });
    ctx.judgeEssay.mockImplementation(async (judge: "gemini" | "openai") =>
      judge === "gemini" ? essayJudgeResult("gemini", 4) : essayJudgeResult("openai", 3.5)
    );
    const { job } = await scoreAsync(ctx.app, attemptId, { taskType: "email", items: [{ itemId: emailId, text: "Dear team, ...", secondsUsed: 200 }] });
    expect(job.status).toBe("done"); // must be scored before /complete reads item_results below
    ctx.repo.insertItemResult({ attemptId, itemId: "disc-1", taskType: "discussion" });
    ctx.repo.updateItemScore({ attemptId, itemId: "disc-1", score: 4, scoreJson: "{}", scoringStatus: "scored" });

    const res = await ctx.app.request(`/${attemptId}/complete`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      estimate: { band: number; raw: number; method: string; coverage: { taskType: string; itemCount: number; skippedCount?: number }[] };
    };
    expect(body.status).toBe("completed");
    expect(body.estimate.band).toBe(4.5);
    expect(body.estimate.raw).toBeCloseTo(0.65);
    expect(body.estimate.method).toBe("linear-v2");
    expect(body.estimate.coverage.sort((a, b) => a.taskType.localeCompare(b.taskType))).toEqual([
      { taskType: "build_sentence", itemCount: 2, skippedCount: 0 },
      { taskType: "discussion", itemCount: 1, skippedCount: 0 },
      { taskType: "email", itemCount: 1, skippedCount: 0 },
    ]);

    const persisted = ctx.repo.latestEstimate("writing");
    expect(persisted?.attemptId).toBe(attemptId);
    expect(persisted?.estimatedBand).toBe(4.5);
    expect(persisted?.method).toBe("linear-v2");
    expect(persisted?.mode).toBe("drill");

    // GET /:id serves the same estimate, read back from section_estimates rather than only returned
    // by /complete: the Attempt review page reads it from here.
    const getRes = await ctx.app.request(`/${attemptId}`);
    const getBody = (await getRes.json()) as {
      estimate: { section: string; band: number; raw: number; method: string; coverage: unknown[] } | null;
    };
    expect(getBody.estimate?.section).toBe("writing");
    expect(getBody.estimate?.band).toBe(4.5);
    expect(getBody.estimate?.raw).toBeCloseTo(0.65);
    expect(getBody.estimate?.method).toBe("linear-v2");
    expect(getBody.estimate?.coverage).toHaveLength(3);
  });

  it("POST /:id/flag sets the flagged column (idempotent on a second call), reflected on GET /:id; 404s for an unknown attempt", async () => {
    const { attemptId } = await createAttempt(ctx.app);

    const before = await ctx.app.request(`/${attemptId}`);
    expect(((await before.json()) as { attempt: { flagged: boolean } }).attempt.flagged).toBe(false);

    const res = await ctx.app.request(`/${attemptId}/flag`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "flagged" });

    const after = await ctx.app.request(`/${attemptId}`);
    expect(((await after.json()) as { attempt: { flagged: boolean } }).attempt.flagged).toBe(true);

    // A second flag call (e.g. the client re-firing on a second tab-leave) stays a harmless no-op,
    // not a toggle back to unflagged.
    const res2 = await ctx.app.request(`/${attemptId}/flag`, { method: "POST" });
    expect(res2.status).toBe(200);
    const after2 = await ctx.app.request(`/${attemptId}`);
    expect(((await after2.json()) as { attempt: { flagged: boolean } }).attempt.flagged).toBe(true);

    const notFound = await ctx.app.request("/no-such-attempt/flag", { method: "POST" });
    expect(notFound.status).toBe(404);
  });

  it("rescoring an essay after an arbiter rejection: job 1 ends failed + item failed + 2 judge_reports rows first, then retry (job 2) ends done scored with exactly 2 judge_reports rows (no duplicates)", async () => {
    const { attemptId } = await createAttempt(ctx.app);
    ctx.judgeEssay.mockImplementation(async (judge: "gemini" | "openai") =>
      judge === "gemini" ? essayJudgeResult("gemini", 4) : essayJudgeResult("openai", 3.5)
    );
    ctx.aggregate.mockRejectedValueOnce(new Error("arbiter down"));

    const scoreRequest = { taskType: "email", items: [{ itemId: emailId, text: "Dear team, ...", secondsUsed: 200 }] };

    const { job: job1 } = await scoreAsync(ctx.app, attemptId, scoreRequest);
    expect(job1.status).toBe("failed");
    expect(typeof job1.error).toBe("string");

    let attempt = ctx.repo.getAttempt(attemptId);
    let item = attempt?.items.find((i) => i.item_id === emailId);
    expect(item?.scoring_status).toBe("failed");
    expect(item?.score).toBeNull();
    expect(ctx.repo.getJudgeReports(attemptId)).toHaveLength(2);

    // Retry (e.g. via the client's Retry button): the arbiter stub now resolves. job1 is already
    // terminal ('failed') by the time this fires, so it has nothing left to supersede.
    const { job: job2 } = await scoreAsync(ctx.app, attemptId, scoreRequest);
    expect(job2.status).toBe("done");
    const body2 = job2.result as { report: ScoreReport };
    expect(body2.report).toEqual(fixedScoreReport);

    attempt = ctx.repo.getAttempt(attemptId);
    item = attempt?.items.find((i) => i.item_id === emailId);
    expect(item?.scoring_status).toBe("scored");
    expect(item?.score).toBe(fixedScoreReport.items[0].finalScore);
    expect(attempt?.items).toHaveLength(1);
    expect(ctx.repo.getJudgeReports(attemptId)).toHaveLength(2); // replaced, not appended (would be 4 if duplicated)
  });

  it("re-submitting the same build_sentence score request upserts the item_result instead of throwing (retry after e.g. a dropped response)", async () => {
    const { attemptId } = await createAttempt(ctx.app);
    const scoreBody = JSON.stringify({
      taskType: "build_sentence",
      items: [{ itemId: bas1.id, tileOrder: bas1.answers[0] }],
    });

    const res1 = await ctx.app.request(`/${attemptId}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: scoreBody,
    });
    expect(res1.status).toBe(200);

    const res2 = await ctx.app.request(`/${attemptId}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: scoreBody,
    });
    expect(res2.status).toBe(200);

    const attempt = ctx.repo.getAttempt(attemptId);
    expect(attempt?.items).toHaveLength(1);
    const item = attempt?.items.find((i) => i.item_id === bas1.id);
    expect(item?.score).toBe(1);
    expect(item?.scoring_status).toBe("scored");
  });

  it("GET / lists attempts as a page with a total, honors ?kind/?setId/?limit, and falls back to the default page size on a malformed ?limit", async () => {
    const { attemptId: writingId } = await createAttempt(ctx.app);
    const { attemptId: speakingId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    type Page = { items: { id: string; kind: string; setId: string }[]; total: number };

    const all = await ctx.app.request("/");
    expect(all.status).toBe(200);
    const allBody = (await all.json()) as Page;
    expect(allBody.total).toBe(2);
    expect(allBody.items.map((a) => a.id).sort()).toEqual([speakingId, writingId].sort());

    const speakingOnly = (await (await ctx.app.request("/?kind=speaking")).json()) as Page;
    expect(speakingOnly.total).toBe(1);
    expect(speakingOnly.items).toHaveLength(1);
    expect(speakingOnly.items[0].id).toBe(speakingId);
    expect(speakingOnly.items[0].kind).toBe("speaking");

    // Number("not-a-number") is NaN — must not be bound into the SQL LIMIT parameter (would throw
    // in better-sqlite3); falls back to the default page size instead.
    const badLimit = await ctx.app.request("/?limit=not-a-number");
    expect(badLimit.status).toBe(200);
    expect(((await badLimit.json()) as Page).items).toHaveLength(2);

    const limited = (await (await ctx.app.request("/?limit=1")).json()) as Page;
    expect(limited.items).toHaveLength(1);
    expect(limited.total).toBe(2);

    const bySet = (await (await ctx.app.request(`/?setId=${SPEAKING_SET_ID}`)).json()) as Page;
    expect(bySet.total).toBe(1);
    expect(bySet.items[0].id).toBe(speakingId);
    expect(bySet.items[0].setId).toBe(SPEAKING_SET_ID);
  });

  it("404s scoring an unknown attempt and completing an unknown attempt", async () => {
    const scoreRes = await ctx.app.request("/no-such-attempt/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskType: "build_sentence", items: [{ itemId: bas1.id, tileOrder: bas1.answers[0] }] }),
    });
    expect(scoreRes.status).toBe(404);

    const completeRes = await ctx.app.request("/no-such-attempt/complete", { method: "POST" });
    expect(completeRes.status).toBe(404);

    const getRes = await ctx.app.request("/no-such-attempt");
    expect(getRes.status).toBe(404);
  });
});

describe("speaking attempts (kind enum + set-kind match)", () => {
  let ctx: ReturnType<typeof buildTestApp>;
  beforeEach(() => {
    ctx = buildTestApp();
  });

  it("creates a speaking attempt against a speaking set", async () => {
    const { attemptId, isRepeat } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    expect(typeof attemptId).toBe("string");
    expect(isRepeat).toBe(false);
    expect(ctx.repo.getAttempt(attemptId)?.kind).toBe("speaking");
  });

  it("400s creating a writing-kind attempt against a speaking set", async () => {
    const res = await ctx.app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "writing", mode: "drill", setId: SPEAKING_SET_ID }),
    });
    expect(res.status).toBe(400);
  });
});

describe("speaking recording upload (POST /:id/items/:itemId/audio)", () => {
  let ctx: ReturnType<typeof buildTestApp>;
  beforeEach(() => {
    ctx = buildTestApp();
  });

  it("happy path: uploads the tiny fixture, transcribes via (stubbed) ears, upserts transcript+deliveryReport+audio path, writes webm AND mp3 to disk", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      ctx.hearRecording.mockResolvedValue({
        transcript: "we open the front desk at six",
        deliveryReport: flatDeliveryReport,
      });

      const res = await uploadAudio(ctx.app, attemptId, lr1Id);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { transcript: string; deliveryReport: DeliveryReport; durationSec: number };
      expect(body.transcript).toBe("we open the front desk at six");
      expect(body.deliveryReport).toEqual(flatDeliveryReport);
      expect(body.durationSec).toBeGreaterThan(0);

      expect(ctx.hearRecording).toHaveBeenCalledTimes(1);
      const call = ctx.hearRecording.mock.calls[0][0];
      expect(call.mimeType).toBe("audio/webm");
      // Never feed the L&R target sentence into the ears context (bias prevention).
      expect(call.context).not.toContain(lr1Sentence);

      const attempt = ctx.repo.getAttempt(attemptId);
      const item = attempt?.items.find((i) => i.item_id === lr1Id);
      expect(item?.task_type).toBe("listen_repeat");
      expect(item?.transcript).toBe("we open the front desk at six");
      expect(item?.delivery_report).toBe(JSON.stringify(flatDeliveryReport));
      expect(item?.response_audio_path).toBeTruthy();
      expect(item?.scoring_status).toBe("pending");
      expect(item?.score).toBeNull();

      // Stored relative to the data directory, so the row survives the directory moving
      // (server/src/lib/paths.ts).
      expect(item?.response_audio_path).toBe(path.join("audio/responses", attemptId, `${lr1Id}.webm`));
      expect(path.isAbsolute(item!.response_audio_path!)).toBe(false);

      const webmPath = path.join(config.dataDir, "audio/responses", attemptId, `${lr1Id}.webm`);
      const mp3Path = path.join(config.dataDir, "audio/responses", attemptId, `${lr1Id}.mp3`);
      expect(fs.existsSync(webmPath)).toBe(true);
      expect(fs.statSync(webmPath).size).toBeGreaterThan(0);
      expect(fs.existsSync(mp3Path)).toBe(true);
      expect(fs.statSync(mp3Path).size).toBeGreaterThan(0);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("passes task-appropriate context: L&R excludes the target sentence, interview includes the question text", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      ctx.hearRecording.mockResolvedValue({ transcript: "x", deliveryReport: flatDeliveryReport });

      await uploadAudio(ctx.app, attemptId, lr1Id);
      const lrCall = ctx.hearRecording.mock.calls[0][0];
      expect(lrCall.context).not.toContain(lr1Sentence);

      await uploadAudio(ctx.app, attemptId, int1Id);
      const intCall = ctx.hearRecording.mock.calls[1][0];
      expect(intCall.context).toContain(int1Question);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("re-recording an item (new audio) resets a prior score/scoring_status (full-row upsert, not a narrow patch)", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      ctx.hearRecording.mockResolvedValue({ transcript: "first take", deliveryReport: flatDeliveryReport });
      expect((await uploadAudio(ctx.app, attemptId, lr1Id)).status).toBe(200);

      // Stands in for a prior scoring pass, so the reset on re-upload is observable.
      ctx.repo.updateItemScore({
        attemptId, itemId: lr1Id, score: 4, scoreJson: JSON.stringify({ finalScore: 4 }), scoringStatus: "scored",
      });
      expect(ctx.repo.getAttempt(attemptId)?.items.find((i) => i.item_id === lr1Id)?.scoring_status).toBe("scored");

      // A genuine re-record is different audio with a different hash, which is what makes it a new
      // recording rather than a replayed request (the byte-identical case is the next test).
      ctx.hearRecording.mockResolvedValue({ transcript: "second take", deliveryReport: flatDeliveryReport });
      expect((await uploadAudio(ctx.app, attemptId, lr1Id, THREE_SEC_WEBM)).status).toBe(200);

      const item = ctx.repo.getAttempt(attemptId)?.items.find((i) => i.item_id === lr1Id);
      expect(item?.transcript).toBe("second take");
      expect(item?.score).toBeNull();
      expect(item?.score_json).toBeNull();
      expect(item?.scoring_status).toBe("pending");
      // scored_at resets too, or the stats route's recentScoredItemResults (which filters on
      // scored_at IS NOT NULL) would still count this unscored Item.
      expect(item?.scored_at).toBeNull();
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("re-POSTing the SAME accepted audio is idempotent: one Ears call, the stored transcript wins, and a prior score is not clobbered", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      ctx.hearRecording.mockResolvedValue({ transcript: "first take", deliveryReport: flatDeliveryReport });
      expect((await uploadAudio(ctx.app, attemptId, lr1Id)).status).toBe(200);
      ctx.repo.updateItemScore({
        attemptId, itemId: lr1Id, score: 4, scoreJson: JSON.stringify({ finalScore: 4 }), scoringStatus: "scored",
      });
      ctx.hearRecording.mockClear();

      // A client that lost the success response re-sends identical bytes. The same attempt, Item and
      // hash is the same transcription job, so the persisted row wins: no second paid Ears call, and
      // no reset of scoring state that has moved on since.
      ctx.hearRecording.mockResolvedValue({ transcript: "must not be used", deliveryReport: flatDeliveryReport });
      const res = await uploadAudio(ctx.app, attemptId, lr1Id);
      expect(res.status).toBe(200);
      expect((await res.json()).transcript).toBe("first take");
      expect(ctx.hearRecording).not.toHaveBeenCalled();

      const item = ctx.repo.getAttempt(attemptId)?.items.find((i) => i.item_id === lr1Id);
      expect(item?.transcript).toBe("first take");
      expect(item?.scoring_status).toBe("scored");
      expect(item?.score).toBe(4);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("rejects an older hash after a newer take succeeds before touching the newer published audio", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      const webmPath = path.join(config.dataDir, "audio/responses", attemptId, `${lr1Id}.webm`);
      const mp3Path = path.join(config.dataDir, "audio/responses", attemptId, `${lr1Id}.mp3`);
      const hash = (filePath: string) => crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");

      ctx.hearRecording.mockResolvedValueOnce({ transcript: "older take", deliveryReport: flatDeliveryReport });
      expect((await uploadAudio(ctx.app, attemptId, lr1Id, TINY_WEBM)).status).toBe(200);
      ctx.hearRecording.mockResolvedValueOnce({ transcript: "newer take", deliveryReport: flatDeliveryReport });
      expect((await uploadAudio(ctx.app, attemptId, lr1Id, THREE_SEC_WEBM)).status).toBe(200);
      const currentWebmHash = hash(webmPath);
      const currentMp3Hash = hash(mp3Path);
      const currentWebmInode = fs.statSync(webmPath).ino;
      const currentMp3Inode = fs.statSync(mp3Path).ino;

      ctx.hearRecording.mockClear();
      ctx.hearRecording.mockResolvedValue({ transcript: "must not run", deliveryReport: flatDeliveryReport });
      const stale = await uploadAudio(ctx.app, attemptId, lr1Id, TINY_WEBM);

      expect(stale.status).toBe(409);
      expect(await stale.json()).toEqual({ error: "recording superseded" });
      expect(ctx.hearRecording).not.toHaveBeenCalled();
      expect(hash(webmPath)).toBe(currentWebmHash);
      expect(hash(mp3Path)).toBe(currentMp3Hash);
      expect(fs.statSync(webmPath).ino).toBe(currentWebmInode);
      expect(fs.statSync(mp3Path).ino).toBe(currentMp3Inode);
      expect(fs.readdirSync(path.dirname(webmPath)).sort()).toEqual([`${lr1Id}.mp3`, `${lr1Id}.webm`]);
      const item = ctx.repo.getAttempt(attemptId)?.items.find((i) => i.item_id === lr1Id);
      expect(item?.transcript).toBe("newer take");
      expect(item?.scoring_status).toBe("pending");
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  // One server process publishes recordings into a data directory (the execution lease), so the
  // per-Item publication lock is held in memory: a second upload of the same Item, while the first is
  // still inside its transcription, is refused rather than interleaved with it.
  it("refuses a concurrent upload of the same Item while the first is still transcribing, and takes the next one after", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    const dir = path.join(config.dataDir, "audio/responses", attemptId);
    try {
      const { promise: firstHeard, resolve: releaseFirst } = deferred();
      ctx.hearRecording.mockImplementationOnce(async () => {
        await firstHeard;
        return { transcript: "first take", deliveryReport: flatDeliveryReport };
      });
      const first = uploadAudio(ctx.app, attemptId, lr1Id, TINY_WEBM);
      await vi.waitFor(() => expect(ctx.hearRecording).toHaveBeenCalledTimes(1));

      const second = await uploadAudio(ctx.app, attemptId, lr1Id, THREE_SEC_WEBM);

      expect(second.status).toBe(409);
      expect(await second.json()).toEqual({ error: "recording upload in progress" });
      expect(ctx.hearRecording).toHaveBeenCalledTimes(1);
      expect(fs.readdirSync(dir).sort()).toEqual([`${lr1Id}.mp3`, `${lr1Id}.webm`]);

      releaseFirst();
      expect((await first).status).toBe(200);
      ctx.hearRecording.mockResolvedValueOnce({ transcript: "second take", deliveryReport: flatDeliveryReport });
      expect((await uploadAudio(ctx.app, attemptId, lr1Id, THREE_SEC_WEBM)).status).toBe(200);
      expect(ctx.repo.getAttempt(attemptId)?.items.find((i) => i.item_id === lr1Id)?.transcript).toBe("second take");
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  // One byte under the 512-byte floor. A corrupt upload at or above it reaches the transcoder
  // instead (the "transcode failure" test below).
  it("rejects a near-empty (<512-byte) recording with 400 and never calls ears", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      const res = await uploadAudio(ctx.app, attemptId, lr1Id, new Uint8Array(511));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "no usable recording" });
      expect(ctx.hearRecording).not.toHaveBeenCalled();
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("rejects a request with no file field at all with 400", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      const res = await ctx.app.request(`/${attemptId}/items/${lr1Id}/audio`, {
        method: "POST",
        body: new FormData(),
      });
      expect(res.status).toBe(400);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("404s uploading to an unknown attempt", async () => {
    const res = await uploadAudio(ctx.app, "no-such-attempt", lr1Id);
    expect(res.status).toBe(404);
  });

  it("404s uploading audio against a writing attempt (not a speaking attempt)", async () => {
    const { attemptId } = await createAttempt(ctx.app); // writing/SET_ID default
    const res = await uploadAudio(ctx.app, attemptId, bas1.id);
    expect(res.status).toBe(404);
  });

  it("404s uploading to an item id that isn't in the set's L&R items or interview questions", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      const res = await uploadAudio(ctx.app, attemptId, "lr-does-not-exist");
      expect(res.status).toBe(404);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  // A retryable Ears failure does not fail the upload: the recording is accepted, stored, hashed and
  // owned by a durable transcription job, so a 5xx would misdescribe work the server is still doing.
  it("retryable ears failure: 202 {transcriptionPending:true, job}, item upserted scoring_status='transcription_pending' with transcript/delivery null, webm KEPT on disk", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      ctx.hearRecording.mockRejectedValue(new Error("gemini down"));

      const res = await uploadAudio(ctx.app, attemptId, int1Id);
      expect(res.status).toBe(202);
      const body = (await res.json()) as { transcriptionPending: boolean; job: TranscriptionJobVM };
      expect(body.transcriptionPending).toBe(true);
      expect(typeof body.job.jobId).toBe("string");
      expect(body.job.status).toBe("retry_wait");
      expect(body.job.automaticAttempts).toBe(1);
      expect(body.job.nextRetryAt).toBeTruthy();
      expect(body.job.failureKind).toBe("provider");
      expect(body.job.scoreJobId).toBeNull();

      const attempt = ctx.repo.getAttempt(attemptId);
      const item = attempt?.items.find((i) => i.item_id === int1Id);
      expect(item?.task_type).toBe("interview");
      expect(item?.scoring_status).toBe("transcription_pending");
      expect(item?.transcript).toBeNull();
      expect(item?.delivery_report).toBeNull();
      expect(item?.response_audio_path).toBeTruthy();

      const webmPath = path.join(config.dataDir, "audio/responses", attemptId, `${int1Id}.webm`);
      expect(fs.existsSync(webmPath)).toBe(true);
      expect(fs.statSync(webmPath).size).toBeGreaterThan(0);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  // The transcription_pending row has exactly one writer, admitRecording at claim time. Two writers
  // would race, and none would break every durable retry, whose persist path requires a row at
  // exactly 'transcription_pending'. The row is asserted while Ears has not settled, so it cannot
  // have come from a failure branch.
  it("the transcription_pending row is written at claim time, before Ears is even given a chance to fail", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      const ears = deferred<never>();
      const releaseEars = () => ears.reject(new Error("gemini down"));
      ctx.hearRecording.mockImplementation(() => ears.promise);

      const inFlight = uploadAudio(ctx.app, attemptId, lr1Id);
      await vi.waitFor(() => {
        const item = ctx.repo.getAttempt(attemptId)?.items.find((i) => i.item_id === lr1Id);
        expect(item?.scoring_status).toBe("transcription_pending");
      }, { timeout: 2000, interval: 5 });

      releaseEars();
      expect((await inFlight).status).toBe(202);
      // The failure leaves the claim-time row as it was: pending, with nothing transcribed.
      expect(ctx.repo.getAttempt(attemptId)?.items.find((i) => i.item_id === lr1Id)).toMatchObject({
        scoring_status: "transcription_pending", transcript: null, delivery_report: null,
      });
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("a transcode-rejected upload creates NO transcription job at all", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      const garbage = crypto.webcrypto.getRandomValues(new Uint8Array(600));
      const res = await uploadAudio(ctx.app, attemptId, lr1Id, garbage);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "unusable audio recording" });
      // Admission is only ever reached for an atomically published, validated recording.
      expect(ctx.repo.getCurrentTranscriptionJobs(attemptId)).toEqual([]);
      expect(ctx.repo.getAttempt(attemptId)?.items).toEqual([]);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("re-POSTing the same accepted-but-untranscribed audio returns the SAME job id (one lifecycle per attempt/item/hash)", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      ctx.hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));

      const first = await uploadAudio(ctx.app, attemptId, lr1Id);
      expect(first.status).toBe(202);
      const firstJob = ((await first.json()) as { job: TranscriptionJobVM }).job;

      ctx.hearRecording.mockClear();
      const second = await uploadAudio(ctx.app, attemptId, lr1Id);
      expect(second.status).toBe(202);
      const secondJob = ((await second.json()) as { job: TranscriptionJobVM }).job;

      expect(secondJob.jobId).toBe(firstJob.jobId);
      // The replay resolves purely from current durable state — it never re-enters the worker, so it
      // cannot spend a second paid transcription call or reset the attempt counter.
      expect(ctx.hearRecording).not.toHaveBeenCalled();
      expect(secondJob.automaticAttempts).toBe(1);
      expect(ctx.repo.getCurrentTranscriptionJobs(attemptId)).toHaveLength(1);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("transcode failure (corrupt but >=512B upload): 400 {error:'unusable audio recording'}, prior recording + DB row left fully intact, no leftover temp files", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      // Establish a previously-good recording + DB row first.
      ctx.hearRecording.mockResolvedValue({ transcript: "good take", deliveryReport: flatDeliveryReport });
      expect((await uploadAudio(ctx.app, attemptId, lr1Id)).status).toBe(200);

      const webmPath = path.join(config.dataDir, "audio/responses", attemptId, `${lr1Id}.webm`);
      const mp3Path = path.join(config.dataDir, "audio/responses", attemptId, `${lr1Id}.mp3`);
      const hash = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
      const webmHashBefore = hash(webmPath);
      const mp3HashBefore = hash(mp3Path);
      const itemBefore = ctx.repo.getAttempt(attemptId)?.items.find((i) => i.item_id === lr1Id);

      // 600 random bytes: past the size floor but not a WebM container, so the transcode refuses it
      // ("EBML header parsing failed", as ffmpeg does; helpers/fakeMedia.ts).
      const garbage = crypto.webcrypto.getRandomValues(new Uint8Array(600));
      ctx.hearRecording.mockClear();
      const res = await uploadAudio(ctx.app, attemptId, lr1Id, garbage);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "unusable audio recording" });
      expect(ctx.hearRecording).not.toHaveBeenCalled();

      // Prior recording bytes are byte-for-byte unchanged (staged temp file never got renamed over
      // the final path).
      expect(hash(webmPath)).toBe(webmHashBefore);
      expect(hash(mp3Path)).toBe(mp3HashBefore);

      // DB row (transcript/deliveryReport/scoring_status/etc.) is untouched too.
      const itemAfter = ctx.repo.getAttempt(attemptId)?.items.find((i) => i.item_id === lr1Id);
      expect(itemAfter).toEqual(itemBefore);

      // The failed upload's temp files were cleaned up, not left behind.
      const files = fs.readdirSync(path.join(config.dataDir, "audio/responses", attemptId));
      expect(files.sort()).toEqual([`${lr1Id}.mp3`, `${lr1Id}.webm`]);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });
});

describe("speaking scoring (POST /:id/score, listen_repeat/interview)", () => {
  let ctx: ReturnType<typeof buildTestApp>;
  const lrIds = speakingFixture.listenAndRepeat.items.map((i) => i.id);

  beforeEach(() => {
    ctx = buildTestApp();
  });

  it("full listen_repeat flow: 7 pre-uploaded items score via stubbed judges + arbiter, 14 judge_reports rows persisted, response carries judges[].items and per-item diff/target", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      await uploadAllListenRepeat(ctx, attemptId);

      ctx.judgeSpeaking.mockImplementation(async (judgeName) => ({
        report: makeSpeakingJudgeReport(judgeName, lrIds, judgeName === "gemini" ? 4 : 3.5),
        mode: "audio" as const,
        provider: judgeName === "gemini" ? "gemini-http" as const : "openai-http" as const,
      }));
      ctx.aggregateSpeaking.mockImplementation(async (aggInput: AggregateSpeakingInput) =>
        arbitration(makeSpeakingScoreReport(aggInput.items.map((i) => i.itemId))));

      const { job } = await scoreAsync(ctx.app, attemptId, { taskType: "listen_repeat", items: lrIds.map((itemId) => ({ itemId })) });
      expect(job.status).toBe("done");
      const body = job.result as {
        taskType: string;
        report: ScoreReport;
        judges: { judge: string; mode: string; items: { itemId: string; score: number }[] }[];
        judgesFailed: string[];
        items: { itemId: string; target?: string; diff?: unknown[] }[];
      };
      expect(body.taskType).toBe("listen_repeat");
      expect(body.report.items).toHaveLength(7);
      expect(body.judgesFailed).toEqual([]);
      expect(body.judges).toHaveLength(2);
      expect(body.judges.map((j) => j.judge).sort()).toEqual(["gemini", "openai"]);
      for (const j of body.judges) {
        expect(j.mode).toBe("audio");
        expect(j.items.map((i) => i.itemId).sort()).toEqual([...lrIds].sort());
        expect(j).not.toHaveProperty("provider");
      }
      expect(body.items).toHaveLength(7);
      const item1 = body.items.find((i) => i.itemId === lr1Id);
      expect(item1?.target).toBe(lr1Sentence);
      expect(Array.isArray(item1?.diff)).toBe(true);

      // gemini gets webm paths, openai gets mp3 paths (mimeTypeFor derives mime from extension).
      const geminiCall = ctx.judgeSpeaking.mock.calls.find((c) => c[0] === "gemini")!;
      const openaiCall = ctx.judgeSpeaking.mock.calls.find((c) => c[0] === "openai")!;
      expect(geminiCall[1].items.map((i) => path.basename(i.audioPath)).sort())
        .toEqual(lrIds.map((id) => `${id}.webm`).sort());
      expect(openaiCall[1].items.map((i) => path.basename(i.audioPath)).sort())
        .toEqual(lrIds.map((id) => `${id}.mp3`).sort());

      const persistedJudgeReports =
        ctx.repo.getJudgeReports(attemptId);
      expect(persistedJudgeReports).toHaveLength(14); // 7 items x 2 judges
      for (const persistedReport of persistedJudgeReports) {
        const parsed = JSON.parse(persistedReport.report_json);
        expect(parsed.mode).toBe("audio");
        expect(parsed).not.toHaveProperty("provider");
      }
      const attempt = ctx.repo.getAttempt(attemptId);
      const sentenceById = new Map(speakingFixture.listenAndRepeat.items.map((i) => [i.id, i.sentence]));
      for (const itemId of lrIds) {
        const row = attempt?.items.find((i) => i.item_id === itemId);
        expect(row?.scoring_status).toBe("scored");
        expect(row?.score).toBe(4);
        // score_json keeps a `meta` beside the report fields (for listen_repeat, the target sentence
        // and the word diff), so the Attempt review page can show the diff without re-scoring.
        const persisted = JSON.parse(row!.score_json!) as { meta?: { target?: string; diff?: unknown[]; question?: string } };
        expect(persisted.meta?.target).toBe(sentenceById.get(itemId));
        expect(Array.isArray(persisted.meta?.diff)).toBe(true);
        expect(persisted.meta?.question).toBeUndefined();
      }
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("marks every item in a Codex text-fallback plus Codex-arbitrated speaking batch", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      await uploadAllListenRepeat(ctx, attemptId);
      ctx.judgeSpeaking.mockImplementation(async (judgeName) => ({
        report: makeSpeakingJudgeReport(judgeName, lrIds, 4),
        mode: judgeName === "openai" ? "text-fallback" as const : "audio" as const,
        provider: judgeName === "openai" ? "codex" as const : "gemini-http" as const,
      }));
      ctx.aggregateSpeaking.mockImplementation(async (aggregateInput, options) =>
        realAggregateSpeaking(aggregateInput, {
          ...options,
          runSkillTask: async () => skillSuccess({
            ...makeSpeakingScoreReport(lrIds),
            items: makeSpeakingScoreReport(lrIds).items.map((item) => ({
              ...item,
              selfArbitrated: false,
            })),
          }, "codex"),
        })
      );

      const { job } = await scoreAsync(ctx.app, attemptId, {
        taskType: "listen_repeat",
        items: lrIds.map((itemId) => ({ itemId })),
      });
      expect(job.status).toBe("done");
      expect(ctx.aggregateSpeaking.mock.calls[0][0].openaiJudgeProvider).toBe("codex");
      const report = (job.result as { report: ScoreReport }).report;
      expect(report.items).toHaveLength(lrIds.length);
      expect(report.items.every((item) => item.selfArbitrated === true)).toBe(true);

      const attempt = ctx.repo.getAttempt(attemptId);
      expect(attempt?.items).toHaveLength(lrIds.length);
      expect(attempt?.items.every((item) =>
        JSON.parse(item.score_json!).selfArbitrated === true
      )).toBe(true);

      const reload = await ctx.app.request(`/${attemptId}`);
      const reloadedItems = ((await reload.json()) as {
        items: { scoreJson: { selfArbitrated?: boolean } }[];
      }).items;
      expect(reloadedItems).toHaveLength(lrIds.length);
      expect(reloadedItems.every((item) => item.scoreJson.selfArbitrated === true)).toBe(true);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("does not mark normal OpenAI audio judging plus Codex arbitration as self-arbitration", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      ctx.hearRecording.mockResolvedValue({
        transcript: "we open the front desk at six",
        deliveryReport: flatDeliveryReport,
      });
      expect((await uploadAudio(ctx.app, attemptId, lr1Id)).status).toBe(200);
      ctx.judgeSpeaking.mockImplementation(async (judgeName) => ({
        report: makeSpeakingJudgeReport(judgeName, [lr1Id], 4),
        mode: "audio" as const,
        provider: judgeName === "openai" ? "openai-http" as const : "gemini-http" as const,
      }));
      ctx.aggregateSpeaking.mockImplementation(async (aggregateInput, options) =>
        realAggregateSpeaking(aggregateInput, {
          ...options,
          runSkillTask: async () => skillSuccess({
            ...makeSpeakingScoreReport([lr1Id]),
            items: [{
              ...makeSpeakingScoreReport([lr1Id]).items[0],
              selfArbitrated: true,
            }],
          }, "codex"),
        })
      );

      const { job } = await scoreAsync(ctx.app, attemptId, {
        taskType: "listen_repeat",
        items: [{ itemId: lr1Id }],
      });
      expect(job.status).toBe("done");
      expect(ctx.aggregateSpeaking.mock.calls[0][0].openaiJudgeProvider).toBe("openai-http");
      expect((job.result as { report: ScoreReport }).report.items[0].selfArbitrated).toBeUndefined();

      const persisted = ctx.repo.getAttempt(attemptId)?.items.find((item) => item.item_id === lr1Id);
      expect(JSON.parse(persisted!.score_json!)).not.toHaveProperty("selfArbitrated");
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("keeps the OpenAI speaking report and its Codex provenance when progress reporting throws", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      await uploadAllListenRepeat(ctx, attemptId);
      ctx.judgeSpeaking.mockImplementation(async (judgeName) => ({
        report: makeSpeakingJudgeReport(judgeName, lrIds, 4),
        mode: judgeName === "openai" ? "text-fallback" as const : "audio" as const,
        provider: judgeName === "openai" ? "codex" as const : "gemini-http" as const,
      }));
      ctx.aggregateSpeaking.mockImplementation(async (aggregateInput, options) =>
        realAggregateSpeaking(aggregateInput, {
          ...options,
          runSkillTask: async () => skillSuccess({
            ...makeSpeakingScoreReport(lrIds),
            items: makeSpeakingScoreReport(lrIds).items.map((item) => ({
              ...item,
              selfArbitrated: true,
            })),
          }, "codex"),
        })
      );
      const onProgress = vi.fn((progress: ScoringProgress) => {
        const done = progress.detail?.judgesDone;
        if (Array.isArray(done) && done.includes("openai")) {
          throw new Error("progress persistence failed");
        }
      });

      const result = await scoreItems(
        {
          repo: ctx.repo,
          judgeSpeaking: ctx.judgeSpeaking,
          aggregateSpeaking: ctx.aggregateSpeaking,
        },
        attemptId,
        speakingFixture,
        {
          taskType: "listen_repeat",
          items: lrIds.map((itemId) => ({ itemId })),
        },
        onProgress,
      );

      // The sink really threw, on the OpenAI Judge's settle.
      expect(onProgress.mock.results.some((r) => r.type === "throw")).toBe(true);
      expect(ctx.aggregateSpeaking.mock.calls[0][0].judgeReports.map((report) => report.judge))
        .toEqual(["gemini", "openai"]);
      expect(ctx.aggregateSpeaking.mock.calls[0][0].openaiJudgeProvider).toBe("codex");
      if (result.taskType !== "listen_repeat") throw new Error("unexpected score result");
      expect(result.judgesFailed).toEqual([]);
      expect(result.report.items).toHaveLength(lrIds.length);
      expect(result.report.items.every((item) => item.selfArbitrated === true)).toBe(true);
      const attempt = ctx.repo.getAttempt(attemptId);
      expect(attempt?.items).toHaveLength(lrIds.length);
      expect(attempt?.items.every((item) =>
        JSON.parse(item.score_json!).selfArbitrated === true
      )).toBe(true);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("GET /:id on a scored speaking attempt surfaces judge report mode ('audio') parsed from the persisted JSON, not a DB column", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      await uploadAllListenRepeat(ctx, attemptId);
      ctx.judgeSpeaking.mockImplementation(async (judgeName) => ({
        report: makeSpeakingJudgeReport(judgeName, [lr1Id], judgeName === "gemini" ? 4 : 3.5),
        mode: "audio" as const,
        provider: judgeName === "gemini" ? "gemini-http" as const : "openai-http" as const,
      }));
      ctx.aggregateSpeaking.mockImplementation(async (aggInput: AggregateSpeakingInput) =>
        arbitration(makeSpeakingScoreReport(aggInput.items.map((i) => i.itemId))));
      const { job } = await scoreAsync(ctx.app, attemptId, { taskType: "listen_repeat", items: [{ itemId: lr1Id }] });
      expect(job.status).toBe("done");

      const res = await ctx.app.request(`/${attemptId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        judgeReports: { itemId: string; judge: string; mode?: string }[];
        items: { itemId: string; scoreJson: { meta?: { target?: string; diff?: unknown[] } } }[];
      };
      const geminiReport = body.judgeReports.find((r) => r.itemId === lr1Id && r.judge === "gemini");
      expect(geminiReport?.mode).toBe("audio");

      // scoreJson.meta reaches the AttemptDetailVM with the rest of the persisted report item; the
      // Attempt review page reads it from here.
      const lrItem = body.items.find((i) => i.itemId === lr1Id);
      expect(lrItem?.scoreJson.meta?.target).toBe(lr1Sentence);
      expect(Array.isArray(lrItem?.scoreJson.meta?.diff)).toBe(true);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("completing a speaking attempt after scoring only its 7 listen_repeat items completes it with NO Band Estimate — Interview has no scored Item", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      await uploadAllListenRepeat(ctx, attemptId);
      ctx.judgeSpeaking.mockImplementation(async (judgeName) => ({
        report: makeSpeakingJudgeReport(judgeName, lrIds, judgeName === "gemini" ? 4 : 3.5),
        mode: "audio" as const,
        provider: judgeName === "gemini" ? "gemini-http" as const : "openai-http" as const,
      }));
      ctx.aggregateSpeaking.mockImplementation(async (aggInput: AggregateSpeakingInput) =>
        arbitration(makeSpeakingScoreReport(aggInput.items.map((i) => i.itemId))));
      const { job } = await scoreAsync(ctx.app, attemptId, { taskType: "listen_repeat", items: lrIds.map((itemId) => ({ itemId })) });
      expect(job.status).toBe("done");

      const res = await ctx.app.request(`/${attemptId}/complete`, { method: "POST" });
      expect(res.status).toBe(200);
      // A band needs every Speaking Task Type scored; Listen and Repeat's weight is never
      // re-spread to stand in for the missing Interview.
      expect(await res.json()).toEqual({ status: "completed" });
      expect(ctx.repo.latestEstimate("speaking")).toBeUndefined();
      expect(ctx.repo.getSectionEstimate(attemptId)).toBeUndefined();
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("scores an interview item: response items carry question (not target/diff), and aggregateSpeaking receives a server-computed non-null paceWpm overriding the stored null estimate", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      ctx.hearRecording.mockResolvedValue({
        transcript: "I have been learning guitar for about two years now",
        deliveryReport: { ...flatDeliveryReport, paceWpm: null },
      });
      // THREE_SEC_WEBM's ~3s clears MIN_PACE_DURATION_SEC, so the short-clip guard tested below
      // does not mask the override this test is about.
      expect((await uploadAudio(ctx.app, attemptId, int1Id, THREE_SEC_WEBM)).status).toBe(200);

      ctx.judgeSpeaking.mockImplementation(async (judgeName) => ({
        report: {
          judge: judgeName, taskType: "interview",
          items: [{ itemId: int1Id, score: 4, dimensions: [{ name: "topical elaboration", score: 4, evidence: "clear" }], deductions: [] }],
        },
        mode: "audio" as const,
        provider: judgeName === "gemini" ? "gemini-http" as const : "openai-http" as const,
      }));
      ctx.aggregateSpeaking.mockImplementation(async (aggInput: AggregateSpeakingInput) => arbitration({
        taskType: "interview" as const,
        items: aggInput.items.map((i) => ({
          itemId: i.itemId, ownScore: 4, finalScore: 4, maxScore: 5 as const,
          dimensions: [{ name: "topical elaboration", note: "ok" }],
          deductions: [], reconciliationNote: "agreed", feedbackZh: "不錯。",
        })),
      }));

      const { job } = await scoreAsync(ctx.app, attemptId, { taskType: "interview", items: [{ itemId: int1Id }] });
      expect(job.status).toBe("done");
      const body = job.result as { taskType: string; items: { itemId: string; question?: string; target?: string }[] };
      expect(body.taskType).toBe("interview");
      expect(body.items).toEqual([{ itemId: int1Id, question: int1Question }]);

      // 10 words over THREE_SEC_WEBM's 3.008s.
      const aggCallArg = ctx.aggregateSpeaking.mock.calls[0][0] as AggregateSpeakingInput;
      expect(aggCallArg.items[0].deliveryReport.paceWpm).toBe(199);
      expect(aggCallArg.items[0].diff).toBeUndefined();

      // An interview Item's score_json carries meta.question; target and diff are listen_repeat's.
      const attempt = ctx.repo.getAttempt(attemptId);
      const row = attempt?.items.find((i) => i.item_id === int1Id);
      const persisted = JSON.parse(row!.score_json!) as { meta?: { target?: string; diff?: unknown[]; question?: string } };
      expect(persisted.meta?.question).toBe(int1Question);
      expect(persisted.meta?.target).toBeUndefined();
      expect(persisted.meta?.diff).toBeUndefined();
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("guards against absurd paceWpm from a near-instant clip: duration < 2s forces paceWpm null even when ears reported a non-null estimate", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      ctx.hearRecording.mockResolvedValue({
        transcript: "quick",
        deliveryReport: { ...flatDeliveryReport, paceWpm: 140 }, // ears' own (non-null) estimate
      });
      // TINY_WEBM lasts ~0.2s, well under scoreItems.ts's MIN_PACE_DURATION_SEC (2s).
      expect((await uploadAudio(ctx.app, attemptId, int1Id)).status).toBe(200);

      ctx.judgeSpeaking.mockImplementation(async (judgeName) => ({
        report: {
          judge: judgeName, taskType: "interview",
          items: [{ itemId: int1Id, score: 3, dimensions: [{ name: "topical elaboration", score: 3, evidence: "brief" }], deductions: [] }],
        },
        mode: "audio" as const,
        provider: judgeName === "gemini" ? "gemini-http" as const : "openai-http" as const,
      }));
      ctx.aggregateSpeaking.mockImplementation(async (aggInput: AggregateSpeakingInput) => arbitration({
        taskType: "interview" as const,
        items: aggInput.items.map((i) => ({
          itemId: i.itemId, ownScore: 3, finalScore: 3, maxScore: 5 as const,
          dimensions: [{ name: "topical elaboration", note: "ok" }],
          deductions: [], reconciliationNote: "agreed", feedbackZh: "不錯。",
        })),
      }));

      const { job } = await scoreAsync(ctx.app, attemptId, { taskType: "interview", items: [{ itemId: int1Id }] });
      expect(job.status).toBe("done");

      const aggCallArg = ctx.aggregateSpeaking.mock.calls[0][0] as AggregateSpeakingInput;
      // Null: not Ears' own 140 (the guard does not fall back to it), and not an extrapolation
      // from a fraction of a second of audio (one word in 0.2s reads as ~300 wpm).
      expect(aggCallArg.items[0].deliveryReport.paceWpm).toBeNull();
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("resolves an absolute response_audio_path inside the data directory for scoring and duration probing", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      // An older row stores an absolute response_audio_path, and nothing rewrites it. The upload
      // route writes only the dataDir-relative form, so the file and row are written directly here
      // (server/src/lib/paths.ts).
      const dir = path.join(config.dataDir, "audio/responses", attemptId);
      fs.mkdirSync(dir, { recursive: true });
      const absoluteWebmPath = path.join(dir, `${int1Id}.webm`);
      fs.writeFileSync(absoluteWebmPath, THREE_SEC_WEBM);
      ctx.repo.insertItemResult({
        attemptId, itemId: int1Id, taskType: "interview",
        responseAudioPath: absoluteWebmPath, // absolute, not dataDir-relative
        transcript: "a short transcript stored for this item",
        // No stored pace, so the only way paceWpm can be non-null below is a successful probe.
        deliveryReport: JSON.stringify({ ...flatDeliveryReport, paceWpm: null }),
      });

      ctx.judgeSpeaking.mockImplementation(async (judgeName) => ({
        report: {
          judge: judgeName, taskType: "interview",
          items: [{ itemId: int1Id, score: 3, dimensions: [{ name: "topical elaboration", score: 3, evidence: "ok" }], deductions: [] }],
        },
        mode: "audio" as const,
        provider: judgeName === "gemini" ? "gemini-http" as const : "openai-http" as const,
      }));
      ctx.aggregateSpeaking.mockImplementation(async (aggInput: AggregateSpeakingInput) => arbitration({
        taskType: "interview" as const,
        items: aggInput.items.map((i) => ({
          itemId: i.itemId, ownScore: 3, finalScore: 3, maxScore: 5 as const,
          dimensions: [{ name: "topical elaboration", note: "ok" }],
          deductions: [], reconciliationNote: "agreed", feedbackZh: "還可以。",
        })),
      }));

      const { job } = await scoreAsync(ctx.app, attemptId, { taskType: "interview", items: [{ itemId: int1Id }] });
      expect(job.status).toBe("done");

      // An absolute stored path inside the data directory resolves to itself.
      const judgeCallArg = ctx.judgeSpeaking.mock.calls[0][1] as { items: { audioPath: string }[] };
      expect(judgeCallArg.items[0].audioPath).toBe(absoluteWebmPath);

      // probeDurationSec resolved it too: 7 words over THREE_SEC_WEBM's 3.008s is 140 WPM. A failed
      // probe would have kept the stored null.
      const aggCallArg = ctx.aggregateSpeaking.mock.calls[0][0] as AggregateSpeakingInput;
      expect(aggCallArg.items[0].deliveryReport.paceWpm).toBe(140);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("409s with the pending itemIds when an item's transcription is still pending (ears failed on upload)", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      ctx.hearRecording.mockRejectedValue(new Error("gemini down"));
      const uploadRes = await uploadAudio(ctx.app, attemptId, lr1Id);
      expect(uploadRes.status).toBe(202); // accepted, with the Item at transcription_pending

      const res = await ctx.app.request(`/${attemptId}/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskType: "listen_repeat", items: [{ itemId: lr1Id }] }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; itemIds: string[] };
      expect(body.itemIds).toEqual([lr1Id]);
      expect(ctx.judgeSpeaking).not.toHaveBeenCalled();
      // The refusal comes before any scoring_jobs row exists: a 409 or 404 has no side effects.
      expect(ctx.repo.listAllScoringJobs()).toEqual([]);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("404s when an item was never uploaded (no transcript on record — client must upload first)", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      const res = await ctx.app.request(`/${attemptId}/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskType: "listen_repeat", items: [{ itemId: lr1Id }] }),
      });
      expect(res.status).toBe(404);
      expect(ctx.judgeSpeaking).not.toHaveBeenCalled();
      expect(ctx.repo.listAllScoringJobs()).toEqual([]);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("mixed request (one transcription_pending item + one never-uploaded item): 409 wins over 404, and itemIds names only the pending item", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      ctx.hearRecording.mockRejectedValue(new Error("gemini down"));
      const uploadRes = await uploadAudio(ctx.app, attemptId, lr1Id);
      expect(uploadRes.status).toBe(202); // lr1Id is now transcription_pending

      const neverUploadedId = speakingFixture.listenAndRepeat.items[1].id; // lr-2: no row at all
      const res = await ctx.app.request(`/${attemptId}/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskType: "listen_repeat", items: [{ itemId: lr1Id }, { itemId: neverUploadedId }] }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; itemIds: string[] };
      expect(body.itemIds).toEqual([lr1Id]); // only the pending item, not the never-uploaded one
      expect(ctx.judgeSpeaking).not.toHaveBeenCalled();
      expect(ctx.repo.listAllScoringJobs()).toEqual([]);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("both speaking judges failing: job ends failed, every requested item persisted failed, no judge_reports rows", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      await uploadAllListenRepeat(ctx, attemptId);
      ctx.judgeSpeaking.mockRejectedValue(new Error("both judges down"));

      const { job } = await scoreAsync(ctx.app, attemptId, { taskType: "listen_repeat", items: lrIds.map((itemId) => ({ itemId })) });
      expect(job.status).toBe("failed");
      expect(typeof job.error).toBe("string");
      expect(ctx.aggregateSpeaking).not.toHaveBeenCalled();
      expect(ctx.repo.getJudgeReports(attemptId)).toHaveLength(0);

      const attempt = ctx.repo.getAttempt(attemptId);
      for (const itemId of lrIds) {
        const row = attempt?.items.find((i) => i.item_id === itemId);
        expect(row?.scoring_status).toBe("failed");
        expect(row?.score).toBeNull();
      }
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("redacts invalid speaking model output from orchestration logs", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { attemptId } = await createAttempt(
      ctx.app,
      SPEAKING_SET_ID,
      "speaking"
    );
    try {
      await uploadAllListenRepeat(ctx, attemptId);
      ctx.judgeSpeaking.mockImplementation(
        async (judgeName) => {
          if (judgeName === "openai") {
            throw new JudgeError(
              "openai",
              "invalid-json",
              SECRET
            );
          }
          return {
            report: makeSpeakingJudgeReport(
              "gemini",
              lrIds,
              4
            ),
            mode: "audio" as const,
            provider: "gemini-http" as const,
          };
        }
      );
      ctx.aggregateSpeaking.mockImplementation(
        async (aggregateInput: AggregateSpeakingInput) =>
          arbitration(
            makeSpeakingScoreReport(
              aggregateInput.items.map((item) => item.itemId)
            )
          )
      );

      const { job } = await scoreAsync(ctx.app, attemptId, {
        taskType: "listen_repeat",
        items: lrIds.map((itemId) => ({ itemId })),
      });

      expect(job.status).toBe("done");
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(renderedLogCalls(errorLog)).toContain("invalid-json");
      expect(renderedLogCalls(errorLog)).not.toContain(SECRET);
    } finally {
      errorLog.mockRestore();
      cleanupResponsesDir(attemptId);
    }
  });

  it("rescoring after an Arbiter rejection replaces judge_reports rather than duplicating them", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      await uploadAllListenRepeat(ctx, attemptId);
      ctx.judgeSpeaking.mockImplementation(async (judgeName) => ({
        report: makeSpeakingJudgeReport(judgeName, lrIds, judgeName === "gemini" ? 4 : 3.5),
        mode: "audio" as const,
        provider: judgeName === "gemini" ? "gemini-http" as const : "openai-http" as const,
      }));
      ctx.aggregateSpeaking.mockRejectedValueOnce(new Error("arbiter down"));

      const scoreRequest = { taskType: "listen_repeat", items: lrIds.map((itemId) => ({ itemId })) };
      const { job: job1 } = await scoreAsync(ctx.app, attemptId, scoreRequest);
      expect(job1.status).toBe("failed");
      expect(ctx.repo.getJudgeReports(attemptId)).toHaveLength(14);
      let attempt = ctx.repo.getAttempt(attemptId);
      expect(attempt?.items.find((i) => i.item_id === lr1Id)?.scoring_status).toBe("failed");

      ctx.aggregateSpeaking.mockImplementation(async (aggInput: AggregateSpeakingInput) =>
        arbitration(makeSpeakingScoreReport(aggInput.items.map((i) => i.itemId))));
      const { job: job2 } = await scoreAsync(ctx.app, attemptId, scoreRequest);
      expect(job2.status).toBe("done");
      expect(ctx.repo.getJudgeReports(attemptId)).toHaveLength(14); // replaced, not duplicated (would be 28)

      attempt = ctx.repo.getAttempt(attemptId);
      for (const itemId of lrIds) {
        const row = attempt?.items.find((i) => i.item_id === itemId);
        expect(row?.scoring_status).toBe("scored");
        expect(row?.score).toBe(4);
      }
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("arbiter silently omitting a requested item from report.items: the 6 returned items score normally, the omitted 7th is persisted failed/rescorable (not left stale)", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      await uploadAllListenRepeat(ctx, attemptId);
      ctx.judgeSpeaking.mockImplementation(async (judgeName) => ({
        report: makeSpeakingJudgeReport(judgeName, lrIds, judgeName === "gemini" ? 4 : 3.5),
        mode: "audio" as const,
        provider: judgeName === "gemini" ? "gemini-http" as const : "openai-http" as const,
      }));
      const omittedId = lrIds[6]; // lr-7: both judges scored it, but the arbiter's report drops it
      const returnedIds = lrIds.filter((id) => id !== omittedId);
      ctx.aggregateSpeaking.mockImplementation(async () => arbitration(makeSpeakingScoreReport(returnedIds)));

      const { job } = await scoreAsync(ctx.app, attemptId, { taskType: "listen_repeat", items: lrIds.map((itemId) => ({ itemId })) });
      expect(job.status).toBe("done");
      const body = job.result as { report: ScoreReport };
      expect(body.report.items).toHaveLength(6);
      expect(body.report.items.map((i) => i.itemId)).not.toContain(omittedId);

      const attempt = ctx.repo.getAttempt(attemptId);
      for (const itemId of returnedIds) {
        const row = attempt?.items.find((i) => i.item_id === itemId);
        expect(row?.scoring_status).toBe("scored");
        expect(row?.score).toBe(4);
      }
      const omittedRow = attempt?.items.find((i) => i.item_id === omittedId);
      expect(omittedRow?.scoring_status).toBe("failed");
      expect(omittedRow?.score).toBeNull();
      expect(JSON.parse(omittedRow!.score_json!)).toEqual({ error: "arbiter omitted item" });
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });
});

describe("async scoring jobs (202 + polling, GET /:id/score-jobs/:jobId, supersede)", () => {
  let ctx: ReturnType<typeof buildTestApp>;
  beforeEach(() => {
    ctx = buildTestApp();
  });

  it("POST /:id/score for a non-build_sentence task type returns 202 with ONLY a jobId (a non-empty string) — no scored result inline", async () => {
    const { attemptId } = await createAttempt(ctx.app);
    // The Judges never resolve, so the response cannot have waited for one: the job runs in the
    // background.
    ctx.judgeEssay.mockImplementation(() => new Promise(() => {}));

    const res = await postScore(ctx.app, attemptId, { taskType: "email", items: [{ itemId: emailId, text: "Dear team, ...", secondsUsed: 200 }] });
    expect(res.status).toBe(202);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["jobId"]);
    expect(typeof body.jobId).toBe("string");
    expect((body.jobId as string).length).toBeGreaterThan(0);
  });

  it("build_sentence answers 200 with its scored result inline, and creates no scoring_jobs row", async () => {
    const { attemptId } = await createAttempt(ctx.app);
    const res = await postScore(ctx.app, attemptId, {
      taskType: "build_sentence",
      items: [{ itemId: bas1.id, tileOrder: bas1.answers[0] }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { taskType: string; items: { itemId: string; correct: boolean }[] };
    expect(body.taskType).toBe("build_sentence");
    expect(body.items[0].correct).toBe(true);
    expect(ctx.repo.listAllScoringJobs()).toEqual([]);
  });

  it("polls a job through real checkpoints: judging (batch start, no detail) -> judging (per-judge settle detail) -> aggregating -> done, with the terminal result attached", async () => {
    const { attemptId } = await createAttempt(ctx.app);

    const { promise: geminiGate, resolve: releaseGemini } = deferred<ReturnType<typeof essayJudgeResult>>();
    const { promise: openaiGate, resolve: releaseOpenai } = deferred<ReturnType<typeof essayJudgeResult>>();
    ctx.judgeEssay.mockImplementation(async (judge: "gemini" | "openai") => (judge === "gemini" ? geminiGate : openaiGate));

    const { promise: arbiterGate, resolve: releaseArbiter } = deferred<ReturnType<typeof arbitration>>();
    ctx.aggregate.mockImplementation(async (_input: AggregateInput, options?: AggregateOptions) => {
      options?.onEvent?.({ state: "queued", provider: "claude", queuePosition: 2 });
      options?.onEvent?.({
        state: "fallback",
        provider: "codex",
        fallbackFrom: "claude",
        failureKind: "quota",
      });
      options?.onEvent?.({ state: "running", provider: "codex", fallbackFrom: "claude" });
      return arbiterGate;
    });

    const res = await postScore(ctx.app, attemptId, { taskType: "email", items: [{ itemId: emailId, text: "Dear team, ...", secondsUsed: 200 }] });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };

    let current!: Awaited<ReturnType<typeof getScoreJob>>;
    await vi.waitFor(async () => {
      current = await getScoreJob(ctx.app, attemptId, jobId);
      expect(current.body.status).toBe("running");
    });
    expect(current.body.stage).toBe("judging");
    expect(current.body.progress).toBeNull(); // batch-start checkpoint: no per-judge detail yet

    // GET /:id lists the running job in activeJobs, which is how the client re-attaches to its
    // progress rather than showing the Item as not yet scored.
    const detailRes = await ctx.app.request(`/${attemptId}`);
    const detailBody = (await detailRes.json()) as { activeJobs: { jobId: string; taskType: string; itemIds: string[]; stage: string | null; status: string }[] };
    expect(detailBody.activeJobs).toEqual([{ jobId, taskType: "email", itemIds: ["email-1"], stage: "judging", status: "running" }]);

    releaseOpenai(essayJudgeResult("openai", 3.5, "codex"));
    await vi.waitFor(async () => {
      current = await getScoreJob(ctx.app, attemptId, jobId);
      expect(current.body.progress).toEqual({
        judgesDone: ["openai"],
        judgesFailed: [],
        openaiJudgeProvider: "codex",
      });
    });
    expect(current.body.stage).toBe("judging"); // gemini still gated — not aggregating yet

    releaseGemini(essayJudgeResult("gemini", 4));
    await vi.waitFor(async () => {
      current = await getScoreJob(ctx.app, attemptId, jobId);
      expect(current.body.stage).toBe("aggregating");
    });
    expect(current.body.status).toBe("running");
    expect(current.body.progress).toEqual({
      judgesDone: ["openai", "gemini"],
      judgesFailed: [],
      openaiJudgeProvider: "codex",
      arbiterProvider: "codex",
      fallbackFrom: "claude",
    });
    expect(current.body.progress).not.toHaveProperty("queuePosition");

    releaseArbiter(arbitration(fixedScoreReport, "codex"));
    await vi.waitFor(async () => {
      current = await getScoreJob(ctx.app, attemptId, jobId);
      expect(current.body.status).toBe("done");
    });
    expect(current.body.stage).toBe("persisting");
    expect((current.body.result as { report: ScoreReport }).report).toEqual(fixedScoreReport);
    expect(current.body.error).toBeUndefined();
  });

  it("GET /:id/score-jobs/:jobId 404s for an unknown jobId and for a job that belongs to a DIFFERENT attempt (200 for the correct attempt)", async () => {
    const { attemptId: attemptA } = await createAttempt(ctx.app);
    const { attemptId: attemptB } = await createAttempt(ctx.app);

    const unknown = await ctx.app.request(`/${attemptA}/score-jobs/does-not-exist`);
    expect(unknown.status).toBe(404);

    ctx.judgeEssay.mockImplementation(async (judge: "gemini" | "openai") =>
      judge === "gemini" ? essayJudgeResult("gemini", 4) : essayJudgeResult("openai", 3.5)
    );
    const { jobId, job } = await scoreAsync(ctx.app, attemptA, { taskType: "email", items: [{ itemId: emailId, text: "Dear team, ...", secondsUsed: 200 }] });
    expect(job.status).toBe("done");

    const wrongAttempt = await ctx.app.request(`/${attemptB}/score-jobs/${jobId}`);
    expect(wrongAttempt.status).toBe(404);

    const correct = await ctx.app.request(`/${attemptA}/score-jobs/${jobId}`);
    expect(correct.status).toBe(200);
    expect(((await correct.json()) as { jobId: string }).jobId).toBe(jobId);
  });

  it("answers validation failures (404 unknown item, 409 transcription pending) synchronously, and creates no scoring_jobs row", async () => {
    const { attemptId } = await createAttempt(ctx.app);
    const badItem = await postScore(ctx.app, attemptId, { taskType: "email", items: [{ itemId: "not-a-real-item", text: "x", secondsUsed: 10 }] });
    expect(badItem.status).toBe(404);
    expect(ctx.judgeEssay).not.toHaveBeenCalled();
    expect(ctx.repo.listAllScoringJobs()).toEqual([]);

    const { attemptId: speakingAttemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      ctx.hearRecording.mockRejectedValue(new Error("gemini down"));
      await uploadAudio(ctx.app, speakingAttemptId, lr1Id);
      const pending = await postScore(ctx.app, speakingAttemptId, { taskType: "listen_repeat", items: [{ itemId: lr1Id }] });
      expect(pending.status).toBe(409);
      expect(ctx.judgeSpeaking).not.toHaveBeenCalled();
      expect(ctx.repo.listAllScoringJobs()).toEqual([]);
    } finally {
      cleanupResponsesDir(speakingAttemptId);
    }
  });

  it("supersede: a second score request for the same task type marks the first job superseded, the new job's result is what's persisted, and the first job's later completion does NOT overwrite it", async () => {
    const { attemptId } = await createAttempt(ctx.app);

    // Job 1's Judges stay pending until the end, long after job 2 has committed: a slow first
    // request still in flight when the User resubmits an edited essay.
    const { promise: job1GeminiGate, resolve: releaseJob1Gemini } = deferred<ReturnType<typeof essayJudgeResult>>();
    const { promise: job1OpenaiGate, resolve: releaseJob1Openai } = deferred<ReturnType<typeof essayJudgeResult>>();
    ctx.judgeEssay
      .mockImplementationOnce(async () => job1GeminiGate)
      .mockImplementationOnce(async () => job1OpenaiGate);

    const res1 = await postScore(ctx.app, attemptId, { taskType: "email", items: [{ itemId: emailId, text: "First draft", secondsUsed: 100 }] });
    expect(res1.status).toBe(202);
    const { jobId: job1Id } = (await res1.json()) as { jobId: string };

    await vi.waitFor(async () => {
      const j = await getScoreJob(ctx.app, attemptId, job1Id);
      expect(j.body.status).toBe("running");
    });

    // Job 2 resubmits the same Task Type, and its Judges and Arbiter resolve at once.
    ctx.judgeEssay.mockImplementation(async (judge: "gemini" | "openai") =>
      judge === "gemini" ? essayJudgeResult("gemini", 5) : essayJudgeResult("openai", 5)
    );
    const job2Report: ScoreReport = {
      taskType: "email",
      items: [{ ...fixedScoreReport.items[0], finalScore: 5, ownScore: 5 }],
    };
    ctx.aggregate.mockResolvedValueOnce(arbitration(job2Report));

    const { jobId: job2Id, job: job2 } = await scoreAsync(ctx.app, attemptId, { taskType: "email", items: [{ itemId: emailId, text: "Final draft", secondsUsed: 150 }] });
    expect(job2.status).toBe("done");
    expect((job2.result as { report: ScoreReport }).report.items[0].finalScore).toBe(5);
    expect(job2Id).not.toBe(job1Id);

    // Creating job 2 cancelled job 1 as superseded: not failed, not left running.
    const job1AfterSupersede = await getScoreJob(ctx.app, attemptId, job1Id);
    expect(job1AfterSupersede.body).toMatchObject({ status: "cancelled", cancellationReason: "superseded" });

    // The Item holds job 2's result ("Final draft", 5). Job 1, still waiting on its Judges, has
    // written nothing.
    let item = ctx.repo.getAttempt(attemptId)?.items.find((i) => i.item_id === emailId);
    expect(item?.response_text).toBe("Final draft");
    expect(item?.score).toBe(5);
    expect(item?.scoring_status).toBe("scored");

    // Job 2's two Judge Reports are persisted, both scoring 5.
    let judgeReports = ctx.repo.getJudgeReports(attemptId);
    expect(judgeReports).toHaveLength(2);
    const scoreByJudge = (rows: typeof judgeReports) =>
      Object.fromEntries(rows.map((r) => [r.judge, (JSON.parse(r.report_json) as JudgeReport).items[0].score]));
    expect(scoreByJudge(judgeReports)).toEqual({ gemini: 5, openai: 5 });

    // Job 1's Judges resolve now. Cancellation stops it before its Arbiter, so the only aggregate
    // call is still job 2's.
    releaseJob1Gemini(essayJudgeResult("gemini", 4));
    releaseJob1Openai(essayJudgeResult("openai", 3.5, "openai-http"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(ctx.aggregate).toHaveBeenCalledTimes(1);

    // Job 1's row stays cancelled rather than moving to 'done'.
    const job1Final = await getScoreJob(ctx.app, attemptId, job1Id);
    expect(job1Final.body).toMatchObject({ status: "cancelled", cancellationReason: "superseded" });

    // Job 1's late completion did not overwrite job 2's committed result.
    item = ctx.repo.getAttempt(attemptId)?.items.find((i) => i.item_id === emailId);
    expect(item?.response_text).toBe("Final draft");
    expect(item?.score).toBe(5);
    expect(item?.scoring_status).toBe("scored");

    // Job 2's Judge Reports survive too, not job 1's 4 and 3.5: every Judge Report write checks
    // that its job is still running (createScoringSession).
    judgeReports = ctx.repo.getJudgeReports(attemptId);
    expect(judgeReports).toHaveLength(2);
    expect(scoreByJudge(judgeReports)).toEqual({ gemini: 5, openai: 5 });
  });

  it("supersede: a superseded job's LATE FAILURE (both judges failing, not just late success) also does not overwrite the newer job's already-persisted score", async () => {
    const { attemptId } = await createAttempt(ctx.app);

    // Job 1's Judges reject once released: a slow first request whose Judges both fail long after
    // it was superseded.
    const { promise: job1GeminiGate, reject: rejectJob1Gemini } = deferred<ReturnType<typeof essayJudgeResult>>();
    const { promise: job1OpenaiGate, reject: rejectJob1Openai } = deferred<ReturnType<typeof essayJudgeResult>>();
    ctx.judgeEssay
      .mockImplementationOnce(() => job1GeminiGate)
      .mockImplementationOnce(() => job1OpenaiGate);

    const res1 = await postScore(ctx.app, attemptId, { taskType: "email", items: [{ itemId: emailId, text: "First draft", secondsUsed: 100 }] });
    expect(res1.status).toBe(202);
    const { jobId: job1Id } = (await res1.json()) as { jobId: string };

    await vi.waitFor(async () => {
      const j = await getScoreJob(ctx.app, attemptId, job1Id);
      expect(j.body.status).toBe("running");
    });

    // Job 2 resubmits the same Task Type, and its Judges and Arbiter resolve at once.
    ctx.judgeEssay.mockImplementation(async (judge: "gemini" | "openai") =>
      judge === "gemini" ? essayJudgeResult("gemini", 5) : essayJudgeResult("openai", 5)
    );
    const job2Report: ScoreReport = {
      taskType: "email",
      items: [{ ...fixedScoreReport.items[0], finalScore: 5, ownScore: 5 }],
    };
    ctx.aggregate.mockResolvedValueOnce(arbitration(job2Report));

    const { jobId: job2Id, job: job2 } = await scoreAsync(ctx.app, attemptId, { taskType: "email", items: [{ itemId: emailId, text: "Final draft", secondsUsed: 150 }] });
    expect(job2.status).toBe("done");
    expect(job2Id).not.toBe(job1Id);

    const item2 = ctx.repo.getAttempt(attemptId)?.items.find((i) => i.item_id === emailId);
    expect(item2?.response_text).toBe("Final draft");
    expect(item2?.score).toBe(5);
    expect(item2?.scoring_status).toBe("scored");

    // Both of job 1's Judges reject, which takes scoreEssay's "both judges failed" branch. Marking
    // the Item failed there goes through the same still-running check, or it would turn job 2's
    // committed score into a false failure.
    rejectJob1Gemini(new Error("job 1 gemini down"));
    rejectJob1Openai(new Error("job 1 openai down"));
    // This branch never reaches the Arbiter, so there is no call to wait on: the wait gives the
    // in-process tail (settle, the both-failed branch, the job runner's catch) time to run.
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Job 1's row stays cancelled rather than moving to 'failed'.
    const job1Final = await getScoreJob(ctx.app, attemptId, job1Id);
    expect(job1Final.body).toMatchObject({ status: "cancelled", cancellationReason: "superseded" });

    // The Item is as job 2 left it, scored 5, not flipped to failed by job 1's late failure.
    const itemFinal = ctx.repo.getAttempt(attemptId)?.items.find((i) => i.item_id === emailId);
    expect(itemFinal?.response_text).toBe("Final draft");
    expect(itemFinal?.score).toBe(5);
    expect(itemFinal?.scoring_status).toBe("scored");
  });
});

// Speaking recovery and finalization as they are reachable over HTTP: the composed route over the
// real coordinators. The two timer-driven behaviours run through their real triggers (transcription
// recovery's durable retry schedule and the capture route's delayed re-reconcile), never by calling
// reconciliation by hand.
describe("speaking recovery lifecycle over HTTP", () => {
  let ctx: ReturnType<typeof buildTestApp>;
  const lrIds = speakingFixture.listenAndRepeat.items.map((i) => i.id);

  beforeEach(() => {
    ctx = buildTestApp();
  });

  // `uploadFailedItemIds` is the client's advisory hint about recordings it could not land.
  // Omitted by default, the common case.
  async function captureFinished(attemptId: string, uploadFailedItemIds?: string[]) {
    const res = await ctx.app.request(`/${attemptId}/capture-finished`, {
      method: "POST",
      ...(uploadFailedItemIds
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ uploadFailedItemIds }) }
        : {}),
    });
    return { status: res.status, body: (await res.json()) as { status: string; estimate?: { band: number } } };
  }

  async function getDetail(attemptId: string) {
    const res = await ctx.app.request(`/${attemptId}`);
    return {
      status: res.status,
      body: (await res.json()) as {
        attempt: { captureFinishedAt: string | null; status: string };
        items: { itemId: string; scoringStatus: string; transcriptionJob?: TranscriptionJobVM }[];
      },
    };
  }

  it("POST /:id/capture-finished 404s an unknown attempt and 400s a drill", async () => {
    expect((await ctx.app.request("/no-such-attempt/capture-finished", { method: "POST" })).status).toBe(404);

    const { attemptId: drillId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking", "drill");
    expect((await ctx.app.request(`/${drillId}/capture-finished`, { method: "POST" })).status).toBe(400);
  });

  // The hint body decides how a missing Item is classified, and it can never fail the request:
  // losing it costs one distinction on an Item that is already missing, while a 400 would leave the
  // Attempt with no capture marker, which nothing ever finalizes.
  it("POST /:id/capture-finished classifies missing items from the optional hint body, and tolerates every malformed form of it", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking", "simulation");
    const res = await captureFinished(attemptId, [lrIds[0]]);
    expect(res.status).toBe(200);

    const items = ctx.repo.getAttempt(attemptId)!.items;
    expect(items).toHaveLength(11); // every Listen and Repeat and Interview Item has a row
    const lost = items.find((i) => i.item_id === lrIds[0])!;
    expect(lost.scoring_status).toBe("failed");
    expect(JSON.parse(lost.score_json!)).toEqual({ error: "recording upload did not arrive" });
    for (const row of items.filter((i) => i.item_id !== lrIds[0])) {
      expect(row.scoring_status).toBe("scored");
      expect(row.score).toBe(0);
      expect(JSON.parse(row.score_json!)).toEqual({ skipped: true, reason: SKIPPED_ITEM_REASON });
    }

    // A body that is not JSON, and one that is JSON but fails the schema, both degrade to "no
    // hints" (200 + full reconciliation), never to a 4xx.
    for (const body of ["not json at all", JSON.stringify({ uploadFailedItemIds: "lr-1" })]) {
      const { attemptId: id } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking", "simulation");
      const bad = await ctx.app.request(`/${id}/capture-finished`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      expect(bad.status).toBe(200);
      const rows = ctx.repo.getAttempt(id)!.items;
      expect(rows).toHaveLength(11);
      for (const row of rows) expect(row.scoring_status).toBe("scored");
    }
  });

  // An unreadable Set must not strand a scored Simulation. markCaptureFinished throws SetUnavailable
  // before writing anything, and an Attempt without a capture marker is skipped by reconcileAttempt
  // and by the boot pass, so a 500 would leave it in progress forever with no Band Estimate. A schema
  // narrowing or one edited Set file is enough, since readSet answers undefined for either.
  it("a scored speaking simulation still completes and still gets its estimate when its question set is unreadable", async () => {
    for (const endpoint of ["complete", "capture-finished"] as const) {
      const brokenRepo = openSqliteStores();
      const attemptId = `att-no-set-${endpoint}`;
      brokenRepo.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
      // All seven Listen and Repeat Items and the first Interview question are scored; the other
      // three questions were never recorded.
      const allItems = [
        ...lrIds.map((itemId) => ({ itemId, taskType: "listen_repeat" })),
        { itemId: int1Id, taskType: "interview" },
      ];
      for (const { itemId, taskType } of allItems) {
        brokenRepo.insertItemResult({ attemptId, itemId, taskType, transcript: "a real answer", deliveryReport: "{}" });
        brokenRepo.updateItemScore({ attemptId, itemId, score: 4, scoreJson: JSON.stringify({ finalScore: 4 }), scoringStatus: "scored" });
      }
      const brokenApp = buildAttemptsRoutes({
        repo: brokenRepo,
        ...createSpeakingCoordinators({ repo: brokenRepo, setStore: { readSet: () => undefined } }),
      });

      const res = await brokenApp.request(`/${attemptId}/${endpoint}`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; estimate?: { band: number; section: string } };
      expect(body.status).toBe("completed");
      expect(body.estimate?.band).toBe(5); // every item at 4/5 -> raw 0.8 -> 5.0

      const attempt = brokenRepo.getAttempt(attemptId)!;
      expect(attempt.status).toBe("completed");
      expect(attempt.completed_at).toBeTruthy();
      expect(brokenRepo.getSectionEstimate(attemptId)?.estimatedBand).toBe(5);
      // Without a readable Set there is no expected Item list, so no missing-upload placeholders.
      expect(attempt.items).toHaveLength(8);
      // Both endpoints write the marker alone and then run the same gated reconciliation, so the
      // Attempt is visible to the boot pass. The two tests below prove the gate on each endpoint.
      expect(attempt.capture_finished_at).toBeTruthy();
    }
  });

  // The unreadable-Set path still answers 202 while work is outstanding. Completing early would
  // stamp completed_at, which never moves afterwards, and a completed Attempt is at once safe to
  // orphan-heal (orphanHealIsSafe), so a later reconcile could fail Items still being scored.
  it("capture-finished on an unreadable set HOLDS completion while work is active, and completes once it goes terminal", async () => {
    const brokenRepo = openSqliteStores();
    const attemptId = "att-no-set-active-work";
    brokenRepo.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    // Listen and Repeat is scored; the Interview Item is still being scored.
    for (const itemId of lrIds) {
      brokenRepo.insertItemResult({ attemptId, itemId, taskType: "listen_repeat", transcript: "a real answer", deliveryReport: "{}" });
      brokenRepo.updateItemScore({ attemptId, itemId, score: 4, scoreJson: JSON.stringify({ finalScore: 4 }), scoringStatus: "scored" });
    }
    brokenRepo.insertItemResult({ attemptId, itemId: int1Id, taskType: "interview", transcript: "an interview answer", deliveryReport: "{}" });
    brokenRepo.createScoringJob({ id: "interview-job", attemptId, taskType: "interview", itemIds: [int1Id] });
    brokenRepo.seedScoringJobState({ id: "interview-job", status: "running" });

    const brokenApp = buildAttemptsRoutes({
      repo: brokenRepo,
      ...createSpeakingCoordinators({ repo: brokenRepo, setStore: { readSet: () => undefined } }),
    });

    const held = await brokenApp.request(`/${attemptId}/capture-finished`, { method: "POST" });
    expect(held.status).toBe(202);
    expect(await held.json()).toEqual({ status: "finalizing" });
    expect(brokenRepo.getAttempt(attemptId)!.status).toBe("in_progress");
    expect(brokenRepo.getAttempt(attemptId)!.completed_at).toBeNull();
    expect(brokenRepo.getSectionEstimate(attemptId)).toBeUndefined();
    // The marker is written, which puts the Attempt under normal reconciliation and inside the
    // boot pass's query (listCaptureFinishedInProgressAttempts).
    expect(brokenRepo.getAttempt(attemptId)!.capture_finished_at).toBeTruthy();

    // The Interview score lands, and only now is completion due.
    brokenRepo.updateItemScore({ attemptId, itemId: int1Id, score: 3, scoreJson: JSON.stringify({ finalScore: 3 }), scoringStatus: "scored" });
    brokenRepo.seedScoringJobState({ id: "interview-job", status: "done" });

    const done = await brokenApp.request(`/${attemptId}/capture-finished`, { method: "POST" });
    expect(done.status).toBe(200);
    const body = (await done.json()) as { status: string; estimate: { band: number; coverage: { taskType: string }[] } };
    expect(body.status).toBe("completed");
    expect(brokenRepo.getAttempt(attemptId)!.status).toBe("completed");
    // The band covers both Task Types.
    expect(body.estimate.coverage.map((c) => c.taskType).sort()).toEqual(["interview", "listen_repeat"]);
  });

  // The same gate on /complete. A Speaking Simulation completes only through reconcileAttempt,
  // never through completeWithLocalEstimate, which has no active-work check.
  it("/complete on an unreadable Set holds completion while work is active, as capture-finished does", async () => {
    const brokenRepo = openSqliteStores();
    const attemptId = "att-no-set-active-work-complete";
    brokenRepo.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    for (const itemId of lrIds) {
      brokenRepo.insertItemResult({ attemptId, itemId, taskType: "listen_repeat", transcript: "a real answer", deliveryReport: "{}" });
      brokenRepo.updateItemScore({ attemptId, itemId, score: 4, scoreJson: JSON.stringify({ finalScore: 4 }), scoringStatus: "scored" });
    }
    brokenRepo.insertItemResult({ attemptId, itemId: int1Id, taskType: "interview", transcript: "an interview answer", deliveryReport: "{}" });
    brokenRepo.createScoringJob({ id: "interview-job-complete", attemptId, taskType: "interview", itemIds: [int1Id] });
    brokenRepo.seedScoringJobState({ id: "interview-job-complete", status: "running" });

    const brokenApp = buildAttemptsRoutes({
      repo: brokenRepo,
      ...createSpeakingCoordinators({ repo: brokenRepo, setStore: { readSet: () => undefined } }),
    });

    const held = await brokenApp.request(`/${attemptId}/complete`, { method: "POST" });
    expect(held.status).toBe(202);
    expect(await held.json()).toEqual({ status: "finalizing" });
    expect(brokenRepo.getAttempt(attemptId)!.status).toBe("in_progress");
    expect(brokenRepo.getAttempt(attemptId)!.completed_at).toBeNull();
    // No band while the Interview is still being scored.
    expect(brokenRepo.getSectionEstimate(attemptId)).toBeUndefined();
    // The marker is written, so the boot pass can still finalize the Attempt.
    expect(brokenRepo.getAttempt(attemptId)!.capture_finished_at).toBeTruthy();

    brokenRepo.updateItemScore({ attemptId, itemId: int1Id, score: 3, scoreJson: JSON.stringify({ finalScore: 3 }), scoringStatus: "scored" });
    brokenRepo.seedScoringJobState({ id: "interview-job-complete", status: "done" });

    const done = await brokenApp.request(`/${attemptId}/complete`, { method: "POST" });
    expect(done.status).toBe(200);
    const body = (await done.json()) as { status: string; estimate: { coverage: { taskType: string }[] } };
    expect(body.status).toBe("completed");
    expect(brokenRepo.getAttempt(attemptId)!.status).toBe("completed");
    expect(body.estimate.coverage.map((c) => c.taskType).sort()).toEqual(["interview", "listen_repeat"]);
  });

  // An unknown id is the client's 404. An existing Attempt with an unreadable Set is server state:
  // it is finalized, never reported as a missing id.
  it("SetUnavailable stays distinguishable from AttemptNotFound", async () => {
    const brokenRepo = openSqliteStores();
    brokenRepo.createAttempt({ id: "att-real", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    const brokenApp = buildAttemptsRoutes({
      repo: brokenRepo,
      ...createSpeakingCoordinators({ repo: brokenRepo, setStore: { readSet: () => undefined } }),
    });

    for (const endpoint of ["complete", "capture-finished"] as const) {
      const unknown = await brokenApp.request(`/att-does-not-exist/${endpoint}`, { method: "POST" });
      expect(unknown.status).toBe(404);
      expect(await unknown.json()).toEqual({ error: "unknown attempt" });

      const real = await brokenApp.request(`/att-real/${endpoint}`, { method: "POST" });
      expect(real.status).toBe(200);
      expect(((await real.json()) as { status: string }).status).toBe("completed");
    }
  });

  it("capture-finished returns 202 while real work is outstanding, and the route-created scoring job's own terminal event finishes the attempt with no further client call", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking", "simulation");
    try {
      await uploadAllListenRepeat(ctx, attemptId);
      ctx.judgeSpeaking.mockImplementation(async (judgeName) => ({
        report: makeSpeakingJudgeReport(judgeName, lrIds, judgeName === "gemini" ? 4 : 3.5),
        mode: "audio" as const,
        provider: judgeName === "gemini" ? ("gemini-http" as const) : ("openai-http" as const),
      }));
      const { promise: arbiterGate, resolve: releaseArbiter } = deferred();
      ctx.aggregateSpeaking.mockImplementation(async (aggInput: AggregateSpeakingInput) => {
        await arbiterGate;
        return arbitration(makeSpeakingScoreReport(aggInput.items.map((i) => i.itemId)));
      });

      // The client's ordering: every score submission before the capture marker.
      const scoreRes = await postScore(ctx.app, attemptId, { taskType: "listen_repeat", items: lrIds.map((itemId) => ({ itemId })) });
      expect(scoreRes.status).toBe(202);
      const { jobId } = (await scoreRes.json()) as { jobId: string };

      const marked = await captureFinished(attemptId);
      expect(marked.status).toBe(202);
      expect(marked.body.status).toBe("finalizing");
      expect(ctx.repo.getAttempt(attemptId)?.status).toBe("in_progress");
      // The marker is durable even though completion is not yet due.
      expect(ctx.repo.getAttempt(attemptId)?.capture_finished_at).toBeTruthy();

      // The scoring job finishes and nothing else is called: the completion comes from the job's own
      // terminal callback alone, which is what makes navigating away safe.
      releaseArbiter();
      await vi.waitFor(async () => {
        expect((await getScoreJob(ctx.app, attemptId, jobId)).body.status).toBe("done");
        expect(ctx.repo.getAttempt(attemptId)?.status).toBe("completed");
      }, { timeout: 3000, interval: 10 });

      const completed = ctx.repo.getAttempt(attemptId)!;
      expect(completed.completed_at).toBeTruthy();
      // No upload-failure hint was sent, so the four never-recorded Interview questions are
      // deliberate skips scored 0, and they count toward the band.
      const interviewRows = completed.items.filter((i) => i.task_type === "interview");
      expect(interviewRows).toHaveLength(4);
      for (const row of interviewRows) {
        expect(row.scoring_status).toBe("scored");
        expect(row.score).toBe(0);
        expect(JSON.parse(row.score_json!)).toEqual({ skipped: true, reason: SKIPPED_ITEM_REASON });
      }
      expect(ctx.repo.latestEstimate("speaking")?.attemptId).toBe(attemptId);

      // A repeated capture-finished on the completed Attempt answers 200 with the persisted estimate
      // and never moves completed_at. raw = 7/11 * 0.8 + 4/11 * 0 = 0.509 -> band 3.5.
      const replay = await captureFinished(attemptId);
      expect(replay.status).toBe(200);
      expect(replay.body.status).toBe("completed");
      expect(replay.body.estimate?.band).toBe(3.5);
      expect(ctx.repo.getAttempt(attemptId)?.completed_at).toBe(completed.completed_at);
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("an Attempt reconciled only inside the orphan grace window still finalizes in-process, via the route's own delayed re-reconcile", async () => {
    // Fake timers from the start, so the test advances the timer the capture route arms: the real
    // trigger, not a hand-called reconciliation.
    const clock = useFakeTimersInTest();
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking", "simulation");
    try {
      ctx.hearRecording.mockResolvedValue({ transcript: "an answer nobody ever scored", deliveryReport: flatDeliveryReport });
      expect((await uploadAudio(ctx.app, attemptId, lr1Id)).status).toBe(200);

      // lr-1 is pending with a transcript and no scoring job, which inside the grace margin is
      // indistinguishable from a healthy upload whose POST /score is on its way. Reconciliation
      // declines, and nothing else in process would look again without the delayed re-reconcile.
      const marked = await captureFinished(attemptId);
      expect(marked.status).toBe(202);
      expect(ctx.repo.getAttempt(attemptId)?.status).toBe("in_progress");
      expect(ctx.repo.getAttempt(attemptId)?.items.find((i) => i.item_id === lr1Id)?.scoring_status).toBe("pending");

      await clock.advanceBy(31_000);

      const healed = ctx.repo.getAttempt(attemptId)!;
      expect(healed.status).toBe("completed");
      expect(healed.completed_at).toBeTruthy();
      const item = healed.items.find((i) => i.item_id === lr1Id)!;
      expect(item.scoring_status).toBe("failed");
      expect(JSON.parse(item.score_json!)).toEqual({ error: "scoring request did not arrive" });
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  // A client polls capture-finished while it waits, so the grace timer must be one per Attempt,
  // not one per request.
  it("repeated capture-finished calls arm at most ONE grace reconcile for the attempt", async () => {
    const clock = useFakeTimersInTest();
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking", "simulation");
    try {
      ctx.hearRecording.mockResolvedValue({ transcript: "an answer nobody ever scored", deliveryReport: flatDeliveryReport });
      expect((await uploadAudio(ctx.app, attemptId, lr1Id)).status).toBe(200);

      const reconcileSpy = vi.spyOn(ctx.speakingFinalization, "reconcileAttempt");
      for (let poll = 0; poll < 5; poll += 1) {
        expect((await captureFinished(attemptId)).status).toBe(202);
      }
      const inlineReconciles = reconcileSpy.mock.calls.length; // one per request, by design
      expect(inlineReconciles).toBe(5);

      await clock.advanceBy(31_000);
      // Exactly one delayed reconcile fired.
      expect(reconcileSpy.mock.calls.length).toBe(inlineReconciles + 1);
      expect(ctx.repo.getAttempt(attemptId)?.status).toBe("completed");
      reconcileSpy.mockRestore();
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  // A Speaking Drill completes through completeWithLocalEstimate, and reconcileAttempt ignores a
  // Drill that is not yet completed. The Drill page disables Finish while scoring is in flight, so
  // the reconcile its last scoring job fires always runs too early. An Item covered only by a
  // superseded job would then stay pending with a transcript, with no Re-score button and no band,
  // until the next boot, unless /complete arms the delayed re-reconcile.
  it("a Speaking Drill's /complete arms the same grace reconcile, so an orphaned Item is healed without a restart", async () => {
    const clock = useFakeTimersInTest();
    const attemptId = "att-drill-orphan-heal";
    ctx.repo.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    // lr-1 to lr-6 were scored by the Drill's own end-of-task POST /score.
    for (const itemId of lrIds.slice(0, 6)) {
      ctx.repo.insertItemResult({ attemptId, itemId, taskType: "listen_repeat", transcript: "a real answer", deliveryReport: "{}" });
      ctx.repo.updateItemScore({ attemptId, itemId, score: 4, scoreJson: JSON.stringify({ finalScore: 4 }), scoringStatus: "scored" });
    }
    // lr-7 took a 202 and recovered mid-Drill, and recovery's one-Item job was superseded by the
    // client's request for the other six, which does not cover it.
    const orphanId = lrIds[6];
    ctx.repo.insertItemResult({ attemptId, itemId: orphanId, taskType: "listen_repeat", transcript: "a recovered answer", deliveryReport: "{}" });
    ctx.repo.createScoringJob({ id: "drill-recovery-lr7", attemptId, taskType: "listen_repeat", itemIds: [orphanId] });
    ctx.repo.replaceScoringJobAndSupersede({ id: "drill-client-rest", attemptId, taskType: "listen_repeat", itemIds: lrIds.slice(0, 6), now: sqliteTimestamp() });
    ctx.repo.seedScoringJobState({ id: "drill-client-rest", status: "done" });
    expect(ctx.repo.getScoringJob("drill-recovery-lr7")).toMatchObject({ status: "cancelled", cancellation_reason: "superseded" }); // the setup is real

    const res = await ctx.app.request(`/${attemptId}/complete`, { method: "POST" });
    expect(res.status).toBe(200);
    // The Drill still completes at once with its local estimate, and gets no capture marker (a
    // Simulation-only concept).
    const completed = ctx.repo.getAttempt(attemptId)!;
    expect(completed.status).toBe("completed");
    expect(completed.capture_finished_at).toBeNull();
    expect(completed.items.find((i) => i.item_id === orphanId)!.scoring_status).toBe("pending");

    await clock.advanceBy(31_000);

    // 'failed' is the one status a manual Re-score accepts, so the Item is visible and recoverable.
    const healed = ctx.repo.getAttempt(attemptId)!;
    expect(healed.items.find((i) => i.item_id === orphanId)!.scoring_status).toBe("failed");
    for (const itemId of lrIds.slice(0, 6)) {
      expect(healed.items.find((i) => i.item_id === itemId)!.scoring_status).toBe("scored");
    }
    expect(healed.completed_at).toBe(completed.completed_at); // reconcile never moves it
  });

  it("an exhausted transcription releases a capture-finished Simulation on its own durable schedule, without a restart", async () => {
    const clock = useFakeTimersInTest();
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking", "simulation");
    try {
      ctx.hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
      expect((await uploadAudio(ctx.app, attemptId, lr1Id)).status).toBe(202);

      // Active recovery blocks completion: the recording may still turn into a real answer.
      const marked = await captureFinished(attemptId);
      expect(marked.status).toBe(202);
      expect(ctx.repo.getAttempt(attemptId)?.status).toBe("in_progress");

      // Transcription recovery's own 15s/60s/5min schedule runs to exhaustion. The test calls no
      // reconciliation, so the completion can only come from the terminal-failure hook.
      await clock.advanceBy(15_000 + 60_000 + 300_000 + 2_000);

      expect(ctx.hearRecording).toHaveBeenCalledTimes(4); // admission + three durable retries
      const job = ctx.repo.getCurrentTranscriptionJobs(attemptId)[0];
      expect(job.status).toBe("failed");
      const attempt = ctx.repo.getAttempt(attemptId)!;
      expect(attempt.status).toBe("completed");
      // The exhausted Item stays visibly unscored rather than being given a score.
      expect(attempt.items.find((i) => i.item_id === lr1Id)?.scoring_status).toBe("transcription_pending");
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("POST /:id/transcription-jobs/:jobId/retry: 404s unknown/cross-attempt ids, 409s a job that is not manually retryable, and otherwise returns only safe job fields", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    const { attemptId: otherAttemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      ctx.hearRecording.mockRejectedValue(new EarsError(401, "authentication", "authentication unavailable (HTTP 401)"));
      const upload = await uploadAudio(ctx.app, attemptId, lr1Id);
      expect(upload.status).toBe(202);
      const job = ((await upload.json()) as { job: TranscriptionJobVM }).job;
      expect(job.status).toBe("failed"); // terminal kind: no automatic retries at all

      expect((await ctx.app.request(`/no-such-attempt/transcription-jobs/${job.jobId}/retry`, { method: "POST" })).status).toBe(404);
      expect((await ctx.app.request(`/${attemptId}/transcription-jobs/no-such-job/retry`, { method: "POST" })).status).toBe(404);
      // The job exists, but not for this Attempt, which reads the same as absent.
      const cross = await ctx.app.request(`/${otherAttemptId}/transcription-jobs/${job.jobId}/retry`, { method: "POST" });
      expect(cross.status).toBe(404);
      expect(ctx.hearRecording).toHaveBeenCalledTimes(1); // none of those spent anything

      // The retry body is empty: the server re-derives the stored path and hash itself.
      ctx.hearRecording.mockResolvedValue({ transcript: "recovered after the fault cleared", deliveryReport: flatDeliveryReport });
      const retried = await ctx.app.request(`/${attemptId}/transcription-jobs/${job.jobId}/retry`, { method: "POST" });
      expect(retried.status).toBe(200);
      const retriedBody = (await retried.json()) as { job: TranscriptionJobVM };
      expect(Object.keys(retriedBody.job).sort()).toEqual(
        ["automaticAttempts", "error", "failureKind", "jobId", "nextRetryAt", "scoreJobId", "status"],
      );
      expect(retriedBody.job.jobId).toBe(job.jobId);
      expect(ctx.repo.getAttempt(attemptId)?.items.find((i) => i.item_id === lr1Id)?.transcript)
        .toBe("recovered after the fault cleared");

      // The same job is no longer 'failed', so a second click is a conflict rather than a second
      // paid call.
      const again = await ctx.app.request(`/${attemptId}/transcription-jobs/${job.jobId}/retry`, { method: "POST" });
      expect(again.status).toBe(409);
      expect(await again.json()).toEqual({ error: "transcription job is not retryable" });
    } finally {
      cleanupResponsesDir(attemptId);
      cleanupResponsesDir(otherAttemptId);
    }
  });

  it("GET /:id carries attempt.captureFinishedAt and each item's current transcriptionJob, and leaks no path/hash/provider/scenario/question/target text", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking", "simulation");
    try {
      const before = await getDetail(attemptId);
      expect(before.body.attempt.captureFinishedAt).toBeNull();

      // An unclassified provider throw whose message quotes a raw response body, which an
      // `err.message` passthrough would carry to the client.
      ctx.hearRecording.mockRejectedValue(new Error(`gemini responded: ${SECRET}`));
      expect((await uploadAudio(ctx.app, attemptId, lr1Id)).status).toBe(202);

      const detail = await getDetail(attemptId);
      const item = detail.body.items.find((i) => i.itemId === lr1Id)!;
      expect(item.scoringStatus).toBe("transcription_pending");
      expect(item.transcriptionJob).toBeDefined();
      expect(Object.keys(item.transcriptionJob!).sort()).toEqual(
        ["automaticAttempts", "error", "failureKind", "jobId", "nextRetryAt", "scoreJobId", "status"],
      );
      expect(item.transcriptionJob!.status).toBe("retry_wait");

      // The recording path is a deliberate Item-level field (the review page plays the clip from
      // it), so it is asserted absent from the transcription job only; nothing else below may
      // appear anywhere in the document.
      const jobRow = ctx.repo.getCurrentTranscriptionJobs(attemptId)[0];
      expect(JSON.stringify(item.transcriptionJob)).not.toContain(jobRow.audio_path);
      const raw = JSON.stringify(detail.body);
      expect(raw).not.toContain(jobRow.audio_sha256);
      expect(raw).not.toContain(lr1Sentence);
      expect(raw).not.toContain(int1Question);
      expect(raw).not.toContain(speakingFixture.listenAndRepeat.scenarioDescription);
      expect(raw).not.toContain(speakingFixture.interview.scenarioTitle);
      expect(raw).not.toContain(SECRET);
      // The client gets transcription recovery's fixed descriptor instead.
      expect(item.transcriptionJob!.error).toBe("transcription failed unexpectedly");

      const marked = await captureFinished(attemptId);
      expect(marked.status).toBe(202);
      const after = await getDetail(attemptId);
      expect(after.body.attempt.captureFinishedAt).toBeTruthy();
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("a cleanly transcribed Item carries no transcriptionJob (the bookkeeping job is omitted once its result lands)", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking");
    try {
      ctx.hearRecording.mockResolvedValue({ transcript: "clean take", deliveryReport: flatDeliveryReport });
      expect((await uploadAudio(ctx.app, attemptId, lr1Id)).status).toBe(200);

      const detail = await getDetail(attemptId);
      const item = detail.body.items.find((i) => i.itemId === lr1Id);
      expect(item).toBeDefined();
      expect(item).not.toHaveProperty("transcriptionJob");
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("POST /:id/complete hands a Speaking Simulation to the durable finalizer, and completes Writing and a Speaking Drill at once", async () => {
    // Writing completes at once: 200 {status: 'completed'}, with no estimate since nothing is scored.
    const { attemptId: writingId } = await createAttempt(ctx.app);
    const writingRes = await ctx.app.request(`/${writingId}/complete`, { method: "POST" });
    expect(writingRes.status).toBe(200);
    expect(await writingRes.json()).toEqual({ status: "completed" });
    expect(ctx.repo.getAttempt(writingId)?.status).toBe("completed");

    // A Speaking Drill completes at once too, and gets no capture marker.
    const { attemptId: drillId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking", "drill");
    try {
      await uploadAllListenRepeat(ctx, drillId);
      ctx.judgeSpeaking.mockImplementation(async (judgeName) => ({
        report: makeSpeakingJudgeReport(judgeName, lrIds, judgeName === "gemini" ? 4 : 3.5),
        mode: "audio" as const,
        provider: judgeName === "gemini" ? ("gemini-http" as const) : ("openai-http" as const),
      }));
      ctx.aggregateSpeaking.mockImplementation(async (aggInput: AggregateSpeakingInput) =>
        arbitration(makeSpeakingScoreReport(aggInput.items.map((i) => i.itemId))));
      const { job } = await scoreAsync(ctx.app, drillId, { taskType: "listen_repeat", items: lrIds.map((itemId) => ({ itemId })) });
      expect(job.status).toBe("done");

      const drillRes = await ctx.app.request(`/${drillId}/complete`, { method: "POST" });
      expect(drillRes.status).toBe(200);
      // Only Listen and Repeat was sat, so the Drill completes with no Band Estimate.
      expect(await drillRes.json()).toEqual({ status: "completed" });
      expect(ctx.repo.getAttempt(drillId)?.capture_finished_at).toBeNull();
      // A Drill gets no missing-upload placeholders: the four Interview questions stay absent.
      expect(ctx.repo.getAttempt(drillId)?.items).toHaveLength(7);
    } finally {
      cleanupResponsesDir(drillId);
    }

    // A Speaking Simulation's /complete goes through markCaptureFinished and reconciliation, so it
    // lands on the same state as capture-finished, capture marker and placeholders included.
    const { attemptId: simId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking", "simulation");
    const simRes = await ctx.app.request(`/${simId}/complete`, { method: "POST" });
    expect(simRes.status).toBe(200);
    const simBody = (await simRes.json()) as { status: string; estimate?: { band: number; raw: number } };
    expect(simBody.status).toBe("completed");
    // /complete carries no upload-failure hint, so all 11 unrecorded Items are deliberate skips
    // scored 0, and a run in which nothing was said earns the floor band.
    expect(simBody.estimate?.raw).toBe(0);
    expect(simBody.estimate?.band).toBe(1);
    const sim = ctx.repo.getAttempt(simId)!;
    expect(sim.status).toBe("completed");
    expect(sim.capture_finished_at).toBeTruthy();
    expect(sim.items).toHaveLength(11);
    for (const row of sim.items) {
      expect(row.scoring_status).toBe("scored");
      expect(row.score).toBe(0);
    }
  });
});

// A 202 upload is safe only if the client keeps the accepted but untranscribed Item out of its Task
// Type's score request. These tests pin that contract from the server side, with the route's error
// mapping around it.
describe("the 202 upload contract", () => {
  let ctx: ReturnType<typeof buildTestApp>;
  const lrIds = speakingFixture.listenAndRepeat.items.map((i) => i.id);

  beforeEach(() => {
    ctx = buildTestApp();
  });

  it("a 202-accepted item must be excluded from its task's score request: including it rejects ALL seven, excluding it scores the six siblings", async () => {
    const { attemptId } = await createAttempt(ctx.app, SPEAKING_SET_ID, "speaking", "simulation");
    const pendingId = lrIds[2];
    try {
      for (const itemId of lrIds) {
        ctx.hearRecording.mockImplementation(async (input) =>
          input.audioPath.includes(`${pendingId}.webm`)
            ? Promise.reject(new EarsError(503, "provider", "provider unavailable (HTTP 503)"))
            : { transcript: "a healthy take", deliveryReport: flatDeliveryReport },
        );
        const res = await uploadAudio(ctx.app, attemptId, itemId);
        expect(res.status).toBe(itemId === pendingId ? 202 : 200);
      }

      // Why a 202 is not an upload success: the Judge ensemble's `admit` refuses the whole request
      // (TranscriptionPending) when one Item is pending, so a client that sends the 202 Item loses
      // the scoring job for every sibling, and reconciliation later fails the six healthy Items as
      // orphans.
      const poisoned = await postScore(ctx.app, attemptId, {
        taskType: "listen_repeat", items: lrIds.map((itemId) => ({ itemId })),
      });
      expect(poisoned.status).toBe(409);
      expect(((await poisoned.json()) as { itemIds: string[] }).itemIds).toEqual([pendingId]);
      expect(ctx.repo.listAllScoringJobs()).toEqual([]); // nothing scored, for any of the seven

      // What the client sends instead: the pending Item held back, and its six siblings score.
      ctx.judgeSpeaking.mockImplementation(async (judgeName) => ({
        report: makeSpeakingJudgeReport(judgeName, lrIds.filter((id) => id !== pendingId), judgeName === "gemini" ? 4 : 3.5),
        mode: "audio" as const,
        provider: judgeName === "gemini" ? ("gemini-http" as const) : ("openai-http" as const),
      }));
      ctx.aggregateSpeaking.mockImplementation(async (aggInput: AggregateSpeakingInput) =>
        arbitration(makeSpeakingScoreReport(aggInput.items.map((i) => i.itemId))));
      const { job } = await scoreAsync(ctx.app, attemptId, {
        taskType: "listen_repeat", items: lrIds.filter((id) => id !== pendingId).map((itemId) => ({ itemId })),
      });
      expect(job.status).toBe("done");

      const items = ctx.repo.getAttempt(attemptId)!.items;
      for (const id of lrIds.filter((x) => x !== pendingId)) {
        expect(items.find((i) => i.item_id === id)?.scoring_status).toBe("scored");
      }
      // The held-back Item keeps its own recovery lifecycle: it is the only one whose transcription
      // job has not finished.
      expect(items.find((i) => i.item_id === pendingId)?.scoring_status).toBe("transcription_pending");
      const jobStatusByItem = new Map(ctx.repo.getCurrentTranscriptionJobs(attemptId).map((j) => [j.item_id, j.status]));
      expect(jobStatusByItem.get(pendingId)).toBe("retry_wait");
      for (const id of lrIds.filter((x) => x !== pendingId)) expect(jobStatusByItem.get(id)).toBe("done");
    } finally {
      cleanupResponsesDir(attemptId);
    }
  });

  it("the retry endpoint reports a genuine server fault as 500, not as a 409 'not retryable'", async () => {
    const testRepo = openSqliteStores();
    testRepo.createAttempt({ id: "att-fault", kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    testRepo.createOrGetTranscriptionJob({
      id: "job-fault", attemptId: "att-fault", itemId: lr1Id, taskType: "listen_repeat",
      audioPath: `audio/responses/att-fault/${lr1Id}.webm`, audioSha256: "a".repeat(64), now: at("2026-07-30 00:00:00"),
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = buildAttemptsRoutes({
        repo: testRepo,
        // A database-level fault, not one of the module's two legitimate conflicts.
        transcriptionRecovery: {
          admitRecording: async () => { throw new Error("unused"); },
          retry: async () => { throw new Error(`SQLITE_IOERR: ${SECRET}`); },
          runDueAndReconcile: async () => {},
          readAttemptSnapshot: () => new Map(),
        },
        speakingFinalization: { markCaptureFinished: async () => {}, reconcileAttempt: async () => {} },
        onScoringTerminal: async () => {},
      });
      const res = await app.request("/att-fault/transcription-jobs/job-fault/retry", { method: "POST" });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "internal error" });
      expect(errorSpy.mock.calls.flat().map(String).join(" ")).not.toContain(SECRET);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("an unclassified finalization error becomes a 500 with a bounded log, never a raw rethrow into Hono's default handler", async () => {
    const testRepo = openSqliteStores();
    testRepo.createAttempt({ id: "att-boom", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const app = buildAttemptsRoutes({
        repo: testRepo,
        transcriptionRecovery: {
          admitRecording: async () => { throw new Error("unused"); },
          retry: async () => { throw new Error("unused"); },
          runDueAndReconcile: async () => {},
          readAttemptSnapshot: () => new Map(),
        },
        speakingFinalization: {
          // The shape a JSON.parse failure has: a SyntaxError quoting a fragment of the Set file,
          // which is scenario or question text.
          markCaptureFinished: async () => { throw new SyntaxError(`Unexpected token in JSON: ${SECRET}`); },
          reconcileAttempt: async () => {},
        },
        onScoringTerminal: async () => {},
      });

      for (const path of ["/att-boom/capture-finished", "/att-boom/complete"]) {
        const res = await app.request(path, { method: "POST" });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "internal error" });
      }
      const logged = errorSpy.mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("SyntaxError");
      expect(logged).not.toContain(SECRET);
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Both endpoints' SetUnavailable branches run inside the handler's catch, so each needs its own
  // try: a throw there would otherwise reach Hono's default handler, which logs the raw error value,
  // and a caught error's message is the field that tends to quote its input.
  it("a fault inside the capture-finished SetUnavailable branch answers 500 with a bounded log, as /complete does", async () => {
    const testRepo = openSqliteStores();
    testRepo.createAttempt({ id: "att-setgone", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const app = buildAttemptsRoutes({
        repo: testRepo,
        transcriptionRecovery: {
          admitRecording: async () => { throw new Error("unused"); },
          retry: async () => { throw new Error("unused"); },
          runDueAndReconcile: async () => {},
          readAttemptSnapshot: () => new Map(),
        },
        speakingFinalization: {
          // The unreadable-Set path both branches are written for...
          markCaptureFinished: async () => { throw new SetUnavailable("set is unreadable"); },
          // ...and then the degraded reconciliation itself faults, quoting its input.
          reconcileAttempt: async () => { throw new Error(`SQLITE_IOERR: ${SECRET}`); },
        },
        onScoringTerminal: async () => {},
      });

      for (const path of ["/att-setgone/capture-finished", "/att-setgone/complete"]) {
        const res = await app.request(path, { method: "POST" });
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: "internal error" });
      }
      // Each request went through its SetUnavailable branch, which warns and writes the capture
      // marker before the reconciliation faults; without the branch the 500 would come straight
      // from the outer catch and neither would happen.
      const warned = warnSpy.mock.calls.flat().map(String).join(" ");
      expect(warned).toContain("capture-finished: speaking simulation att-setgone has no readable question set");
      expect(warned).toContain("complete: speaking simulation att-setgone has no readable question set");
      expect(testRepo.getAttempt("att-setgone")!.capture_finished_at).toBeTruthy();
      // One bounded line per request, naming the site and never the error's text.
      const logged = errorSpy.mock.calls.flat().map(String).join(" ");
      expect(errorSpy).toHaveBeenCalledTimes(2);
      expect(logged).toContain("[attempts] capture-finished failed:");
      expect(logged).toContain("[attempts] complete failed:");
      expect(logged).not.toContain(SECRET);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

// The client's retry budget for POST /:id/capture-finished, pinned beside the route it retries. A
// Speaking Simulation whose capture marker never lands is skipped by reconcileAttempt and by the
// boot pass, so it never completes and never earns a band. A connection-refused fetch fails in
// milliseconds, so the budget is wall-clock time sized to outlive a `tsx watch` restart, not a
// count of attempts. The policy runs on a virtual clock: no real sleeping, no flake under load.
describe("capture-finished retry budget (client policy)", () => {
  function virtualClock() {
    let now = 0;
    return { now: () => now, sleep: async (ms: number) => { now += ms; }, at: () => now };
  }

  it("keeps trying across a whole dev-server restart when every attempt is refused instantly", async () => {
    const clock = virtualClock();
    const attemptedAt: number[] = [];
    const ok = await retryWithinBudget(async () => {
      attemptedAt.push(clock.at());
      throw new TypeError("Failed to fetch"); // what ECONNREFUSED looks like to fetch()
    }, clock);

    expect(ok).toBe(false);
    // Exponential backoff, with the last attempt at the far edge of the budget.
    expect(attemptedAt).toEqual([0, 2_000, 6_000, 14_000, 30_000]);
    expect(attemptedAt[attemptedAt.length - 1]).toBeGreaterThanOrEqual(CAPTURE_RETRY_BUDGET_MS);
  });

  it("reaches a server that comes back mid-restart, and stops immediately once it does", async () => {
    const clock = virtualClock();
    let calls = 0;
    const ok = await retryWithinBudget(async () => {
      calls += 1;
      if (clock.at() < 10_000) throw new TypeError("Failed to fetch");
    }, clock);

    expect(ok).toBe(true);
    expect(calls).toBe(4); // 0s, 2s, 6s refused; 14s lands
    expect(clock.at()).toBe(14_000); // and it does not keep spending the rest of the budget
  });

  it("costs exactly one POST when the very first attempt succeeds", async () => {
    const clock = virtualClock();
    let calls = 0;
    expect(await retryWithinBudget(async () => { calls += 1; }, clock)).toBe(true);
    expect(calls).toBe(1);
    expect(clock.at()).toBe(0);
  });
});

// An abandoned Attempt would otherwise stay 'in_progress' forever: boot recovery looks only at
// Attempts that posted a capture marker. Abort discards it, keeping its Items as history and granting
// no band.
describe("POST /:id/abort", () => {
  it("discards an abandoned attempt without touching its scores or granting it a band", async () => {
    const { app, repo: r } = buildTestApp();
    r.createAttempt({ id: "att-abandoned", kind: "writing", mode: "simulation", setId: SET_ID, isRepeat: false });
    // One scored Item of each Writing Task Type: enough for a Band Estimate had the Attempt been
    // completed, so the absence of one below is the abort's doing.
    const scored = [
      { itemId: bas1.id, taskType: "build_sentence", score: 1 },
      { itemId: emailId, taskType: "email", score: 4 },
      { itemId: fixture.academicDiscussion.id, taskType: "discussion", score: 4 },
    ];
    for (const item of scored) {
      r.insertItemResult({ attemptId: "att-abandoned", itemId: item.itemId, taskType: item.taskType, responseText: "a response", scoringStatus: "pending" });
      r.updateItemScore({ attemptId: "att-abandoned", itemId: item.itemId, score: item.score, scoreJson: "{}", scoringStatus: "scored" });
    }

    const res = await app.request("/att-abandoned/abort", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "aborted" });
    expect(r.getAttempt("att-abandoned")!.status).toBe("aborted");
    // The recorded work is kept as history, scores included; a partial run must not become a band.
    expect(r.getAttempt("att-abandoned")!.items.map((i) => [i.item_id, i.score, i.scoring_status]))
      .toEqual(scored.map((item) => [item.itemId, item.score, "scored"]));
    expect(r.countSectionEstimates("att-abandoned")).toBe(0);
  });

  it("refuses to un-complete a finished attempt, and 404s an unknown one", async () => {
    const { app, repo: r } = buildTestApp();
    r.createAttempt({ id: "att-done", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.completeAttempt("att-done");

    expect((await app.request("/att-done/abort", { method: "POST" })).status).toBe(409);
    expect(r.getAttempt("att-done")!.status).toBe("completed");
    expect((await app.request("/att-nope/abort", { method: "POST" })).status).toBe(404);
  });
});
