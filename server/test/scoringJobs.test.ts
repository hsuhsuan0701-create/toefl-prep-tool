import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { readBankSet } from "./helpers/setFixtures.js";
import type { AnySet, DeliveryReport, JudgeReport, ScoreReport, ScoreRequest } from "@toefl-prep/shared";
import { at } from "./helpers/timestamps.js";
import { openSqliteStores } from "./helpers/sqliteStores.js";
import {
  abortScoringJob,
  enqueueScoringJob,
  failInterruptedJobs,
  parseItemIds,
  runScoringJob,
  wireBootRecovery,
  type BootRecoveryServer,
  type RecoveryScoringJobOptions,
  type RouteScoringJobOptions,
} from "../src/services/scoringJobs.js";
import { createSpeakingFinalization } from "../src/services/speakingFinalization.js";
import type { aggregate as realAggregate, aggregateSpeaking as realAggregateSpeaking } from "../src/services/arbiter.js";
import type { judgeSpeaking as realJudgeSpeaking } from "../src/services/judges/speaking.js";

type AggregateInput = Parameters<typeof realAggregate>[0];
type AggregateOptions = Parameters<typeof realAggregate>[1];
type AggregateSpeakingInput = Parameters<typeof realAggregateSpeaking>[0];

// A banked Writing Set. An email Item needs no audio, only Judge and Arbiter mocks, which keeps
// these tests on the job lifecycle rather than on scoreItems.ts's scoring logic, tested elsewhere.
const SET_ID = "wri-77af733e";
const set = readBankSet("writing", SET_ID);
const emailId = (set as Extract<AnySet, { kind: "writing" }>).email.id;

function makeJudgeReport(judge: "gemini" | "openai", score: number): JudgeReport {
  return {
    judge,
    taskType: "email",
    items: [{ itemId: emailId, score, dimensions: [{ name: "mechanics", score, evidence: "clean spelling" }], deductions: [] }],
  };
}

function essayJudgeResult(
  judge: "gemini" | "openai",
  score: number
) {
  return {
    report: makeJudgeReport(judge, score),
    provider:
      judge === "gemini"
        ? "gemini-http" as const
        : "codex" as const,
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

function emailRequest(text = "Dear Sir, I am writing to..."): ScoreRequest {
  return { taskType: "email", items: [{ itemId: emailId, text, secondsUsed: 90 }] };
}

// The real SQLite stores over a private in-memory database: the claim, the progress writes, the
// conditional terminal writers and the buffered persistence's atomic commit are the statements
// production runs.
function buildDeps() {
  const testRepo = openSqliteStores();
  const judgeEssay = vi.fn();
  const aggregate = vi.fn(async (_input: AggregateInput, _options?: AggregateOptions) => ({
    report: fixedScoreReport,
    provider: "claude" as "claude" | "codex",
  }));
  const judgeSpeaking = vi.fn<typeof realJudgeSpeaking>();
  const aggregateSpeaking = vi.fn<typeof realAggregateSpeaking>();
  const deps = { repo: testRepo, judgeEssay, aggregate, judgeSpeaking, aggregateSpeaking };
  return { deps, repo: testRepo, judgeEssay, aggregate, judgeSpeaking, aggregateSpeaking };
}

// The scoring-plus-finalization integration's deps: the scoring job and the finalization its terminal
// callback fires share one database, as they do in production.
function buildFinalizationDeps() {
  const store = openSqliteStores();
  const judgeSpeaking = vi.fn<typeof realJudgeSpeaking>();
  const aggregateSpeaking = vi.fn<typeof realAggregateSpeaking>();
  const deps = { repo: store, judgeSpeaking, aggregateSpeaking };
  return { deps, repo: store, judgeSpeaking, aggregateSpeaking };
}

// enqueueScoringJob's recovery branch is Speaking-only, and recovery always sends exactly one Item.
// A banked Speaking Set (spk-e5b2b735, which global-setup.ts requires), read directly rather than
// through the upload route: these tests exercise the job lifecycle wiring, not scoreItems.ts's
// Speaking scoring, so item_results is seeded with a transcript and Delivery Report as if
// transcription had already completed.
const SPEAKING_SET_ID = "spk-e5b2b735";
const speakingSet = readBankSet("speaking", SPEAKING_SET_ID);
const lr1Id = speakingSet.listenAndRepeat.items[0].id;

const flatDeliveryReport: DeliveryReport = {
  paceWpm: 140,
  pauses: "no notable pauses",
  intelligibility: "clear throughout",
  suspectedMispronunciations: [],
  intonation: "flat",
};

function oneItemListenRepeatRequest(itemId = lr1Id): ScoreRequest {
  return { taskType: "listen_repeat", items: [{ itemId }] };
}

function seedTranscribedSpeakingItem(r: Pick<ReturnType<typeof openSqliteStores>, "insertItemResult">, attemptId: string, itemId = lr1Id): void {
  r.insertItemResult({
    attemptId, itemId, taskType: "listen_repeat",
    responseAudioPath: `audio/responses/${attemptId}/${itemId}.webm`,
    transcript: "we open the front desk at six",
    deliveryReport: JSON.stringify(flatDeliveryReport),
  });
}

function makeSpeakingJudgeReport(itemId: string, judgeName: "gemini" | "openai", score = 4): JudgeReport {
  return {
    judge: judgeName, taskType: "listen_repeat",
    items: [{ itemId, score, dimensions: [{ name: "intelligibility", score, evidence: "clear audio" }], deductions: [] }],
  };
}

function makeSpeakingScoreReport(itemId: string, finalScore = 4): ScoreReport {
  return {
    taskType: "listen_repeat",
    items: [{
      itemId, ownScore: finalScore, finalScore, maxScore: 5,
      dimensions: [{ name: "intelligibility", note: "ok" }],
      deductions: [], reconciliationNote: "agreed", feedbackZh: "表現不錯。",
    }],
  };
}

function mockSpeakingSuccess(
  ctx: { judgeSpeaking: ReturnType<typeof vi.fn>; aggregateSpeaking: ReturnType<typeof vi.fn> },
  itemId = lr1Id,
): void {
  ctx.judgeSpeaking.mockImplementation(async (judgeName: "gemini" | "openai") => ({
    report: makeSpeakingJudgeReport(itemId, judgeName),
    mode: "audio" as const,
    provider: judgeName === "gemini" ? ("gemini-http" as const) : ("openai-http" as const),
  }));
  ctx.aggregateSpeaking.mockImplementation(async (_input: AggregateSpeakingInput) => ({
    report: makeSpeakingScoreReport(itemId),
    provider: "claude" as const,
  }));
}

// The lifecycle every job family shares (queued no-op, cancel-before-start, mid-flight supersession,
// boot sweep idempotence) is tested once, for every family, in durableJobRunner.test.ts. This file
// covers scoring's adapter: which store writes each lifecycle step means for a scoring_jobs row, the
// buffered persistence, the progress detail shape, and the terminal callback's contract.
describe("runScoringJob", () => {
  it("propagates cancellation to every in-flight Judge and commits no score persistence", async () => {
    const { deps, repo: r, judgeEssay } = buildDeps();
    r.createAttempt({ id: "att-abort", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createScoringJob({ id: "job-abort", attemptId: "att-abort", taskType: "email", itemIds: [emailId] });
    const seenSignals: AbortSignal[] = [];
    let started = 0;
    let bothStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => { bothStarted = resolve; });
    judgeEssay.mockImplementation(async (_judge: "gemini" | "openai", input: { signal?: AbortSignal }) => {
      const signal = input.signal!;
      seenSignals.push(signal);
      started += 1;
      if (started === 2) bothStarted();
      await new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });

    const running = runScoringJob(deps, "job-abort", { attemptId: "att-abort", set, request: emailRequest() });
    await startedPromise;
    r.requestScoringJobCancellation({ id: "job-abort", reason: "user", now: at("2026-08-13 00:00:00") });
    expect(abortScoringJob("job-abort", "user")).toBe(true);
    await running;

    expect(seenSignals).toHaveLength(2);
    expect(seenSignals.every((signal) => signal.aborted)).toBe(true);
    expect(r.getScoringJob("job-abort")?.status).toBe("cancelled");
    // No score and no Judge Report reach the store; the Item is released as rescorable rather than
    // left 'pending' for a job that will never come back to it.
    expect(r.getAttempt("att-abort")!.items).toEqual([
      expect.objectContaining({
        item_id: emailId, scoring_status: "failed", score: null, score_json: JSON.stringify({ error: "scoring cancelled" }),
      }),
    ]);
    expect(r.getJudgeReports("att-abort")).toEqual([]);
  });

  it("marks the job running (a store write, visible before scoreItems settles), then done with the terminal result on success — and scoreItems' own persistence is unchanged", async () => {
    const { deps, repo: r, judgeEssay } = buildDeps();
    r.createAttempt({ id: "att-1", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createScoringJob({ id: "job-1", attemptId: "att-1", taskType: "email", itemIds: [emailId] });

    let releaseJudges!: () => void;
    const gate = new Promise<void>((resolve) => { releaseJudges = resolve; });
    judgeEssay.mockImplementation(async (judge: "gemini" | "openai") => {
      await gate;
      return essayJudgeResult(judge, 4);
    });

    const runPromise = runScoringJob(deps, "job-1", { attemptId: "att-1", set, request: emailRequest() });

    // runScoringJob writes status='running' before its first await, so the row reads running here,
    // while the Judges are still held at `gate`.
    const midFlight = r.getScoringJob("job-1");
    expect(midFlight?.status).toBe("running");
    expect(midFlight?.stage).toBe("judging");

    releaseJudges();
    await runPromise;

    const job = r.getScoringJob("job-1")!;
    expect(job.status).toBe("done");
    expect(job.error).toBeNull();
    const result = JSON.parse(job.result!) as { taskType: string; report: ScoreReport };
    expect(result.taskType).toBe("email");
    expect(result.report.items[0].finalScore).toBe(4);

    // The Item rows are scoreItems()'s writes; the job runner itself never touches item_results or
    // judge_reports.
    const items = r.getAttempt("att-1")!.items;
    expect(items[0].scoring_status).toBe("scored");
    expect(items[0].score).toBe(4);
  });

  it("marks the job failed with the thrown error's message when scoreItems rejects (both judges failed) — and scoreEssay's own failure-path persistence still runs", async () => {
    const { deps, repo: r, judgeEssay } = buildDeps();
    r.createAttempt({ id: "att-2", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createScoringJob({ id: "job-2", attemptId: "att-2", taskType: "email", itemIds: [emailId] });
    judgeEssay.mockRejectedValue(new Error("down"));

    await runScoringJob(deps, "job-2", { attemptId: "att-2", set, request: emailRequest() });

    const job = r.getScoringJob("job-2")!;
    expect(job.status).toBe("failed");
    expect(job.error).toBe("both judges failed");
    expect(job.result).toBeNull();

    expect(r.getAttempt("att-2")!.items[0].scoring_status).toBe("failed");
  });

  it("drops a failing run's buffered writes when a cancellation was recorded on its row first: the Item reads as cancelled, not as the run's failure", async () => {
    const { deps, repo: r, judgeEssay } = buildDeps();
    r.createAttempt({ id: "att-lost", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createScoringJob({ id: "job-lost", attemptId: "att-lost", taskType: "email", itemIds: [emailId] });
    judgeEssay.mockImplementation(async () => {
      // Recorded on the row only, as shutdown does before it aborts anything: this process's run is
      // not aborted, so it goes on to fail and reaches its fail hook still owning nothing.
      r.requestScoringJobCancellation({ id: "job-lost", reason: "user", now: at("2026-08-13 00:00:00") });
      throw new Error("down");
    });

    await runScoringJob(deps, "job-lost", { attemptId: "att-lost", set, request: emailRequest() });

    expect(r.getScoringJob("job-lost")).toMatchObject({ status: "cancelled", cancellation_reason: "user", error: null });
    expect(r.getAttempt("att-lost")!.items).toEqual([
      expect.objectContaining({
        item_id: emailId, scoring_status: "failed", score: null, score_json: JSON.stringify({ error: "scoring cancelled" }),
      }),
    ]);
    expect(r.getJudgeReports("att-lost")).toEqual([]);
  });

  it("persists live arbiter fallback progress without adding the arbiter provider to the result shape", async () => {
    const { deps, repo: r, judgeEssay, aggregate } = buildDeps();
    r.createAttempt({ id: "att-progress", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createScoringJob({ id: "job-progress", attemptId: "att-progress", taskType: "email", itemIds: [emailId] });
    judgeEssay.mockImplementation(async (judge: "gemini" | "openai") => essayJudgeResult(judge, 4));

    let releaseQueued!: () => void;
    const queuedGate = new Promise<void>((resolve) => { releaseQueued = resolve; });
    let queuedResolve!: () => void;
    const queued = new Promise<void>((resolve) => { queuedResolve = resolve; });
    let releaseAggregate!: () => void;
    const aggregateGate = new Promise<void>((resolve) => { releaseAggregate = resolve; });
    let runningResolve!: () => void;
    const running = new Promise<void>((resolve) => { runningResolve = resolve; });
    aggregate.mockImplementationOnce(async (_input: AggregateInput, options?: AggregateOptions) => {
      options?.onEvent?.({ state: "queued", provider: "claude", queuePosition: 2 });
      queuedResolve();
      await queuedGate;
      options?.onEvent?.({
        state: "fallback",
        provider: "codex",
        fallbackFrom: "claude",
        failureKind: "quota",
      });
      options?.onEvent?.({ state: "running", provider: "codex", fallbackFrom: "claude" });
      runningResolve();
      await aggregateGate;
      return { report: fixedScoreReport, provider: "codex" as const };
    });

    const runPromise = runScoringJob(deps, "job-progress", {
      attemptId: "att-progress",
      set,
      request: emailRequest(),
    });
    await queued;

    expect(JSON.parse(r.getScoringJob("job-progress")!.progress!)).toEqual({
      judgesDone: ["gemini", "openai"],
      judgesFailed: [],
      openaiJudgeProvider: "codex",
      arbiterProvider: "claude",
      queuePosition: 2,
    });

    releaseQueued();
    await running;

    const midFlight = r.getScoringJob("job-progress")!;
    expect(midFlight.stage).toBe("aggregating");
    expect(JSON.parse(midFlight.progress!)).toEqual({
      judgesDone: ["gemini", "openai"],
      judgesFailed: [],
      openaiJudgeProvider: "codex",
      arbiterProvider: "codex",
      fallbackFrom: "claude",
    });

    releaseAggregate();
    await runPromise;
    // The providers were live progress; the finished job keeps only which Judges finished.
    expect(JSON.parse(r.getScoringJob("job-progress")!.progress!)).toEqual({
      judgesDone: ["gemini", "openai"],
      judgesFailed: [],
    });
    const result = JSON.parse(r.getScoringJob("job-progress")!.result!) as Record<string, unknown>;
    expect(result).not.toHaveProperty("provider");
    expect(result).not.toHaveProperty("arbiterProvider");
  });

});

describe("runScoringJob's onTerminal callback", () => {
  it("invokes onTerminal exactly once, with the attemptId, only after the job row settles to 'done'", async () => {
    const { deps, repo: r, judgeEssay } = buildDeps();
    r.createAttempt({ id: "att-term-done", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createScoringJob({ id: "job-term-done", attemptId: "att-term-done", taskType: "email", itemIds: [emailId] });
    judgeEssay.mockImplementation(async (judge: "gemini" | "openai") => essayJudgeResult(judge, 4));

    const onTerminal = vi.fn();
    await runScoringJob(deps, "job-term-done", { attemptId: "att-term-done", set, request: emailRequest() }, onTerminal);

    expect(r.getScoringJob("job-term-done")?.status).toBe("done");
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith("att-term-done");
  });

  it("invokes onTerminal once the job row settles to 'failed'", async () => {
    const attemptId = "att-term-failed";
    const jobId = "job-term-failed";
    const { deps, repo: r, judgeEssay } = buildDeps();
    r.createAttempt({ id: attemptId, kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createScoringJob({ id: jobId, attemptId, taskType: "email", itemIds: [emailId] });
    judgeEssay.mockRejectedValue(new Error("down"));

    const onTerminal = vi.fn();
    await runScoringJob(deps, jobId, { attemptId, set, request: emailRequest() }, onTerminal);

    expect(r.getScoringJob(jobId)?.status).toBe("failed");
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(attemptId);
  });

  it("invokes onTerminal when the job is ALREADY superseded before this invocation even starts (the early no-op branch counts as 'remained superseded')", async () => {
    const { deps, repo: r, judgeEssay } = buildDeps();
    r.createAttempt({ id: "att-term-superseded", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createScoringJob({ id: "job-term-superseded", attemptId: "att-term-superseded", taskType: "email", itemIds: [emailId] });
    r.replaceScoringJobAndSupersede({ id: "job-term-next", attemptId: "att-term-superseded", taskType: "email", itemIds: [emailId], now: at("2026-08-13 00:00:00") });

    const onTerminal = vi.fn();
    await runScoringJob(deps, "job-term-superseded", { attemptId: "att-term-superseded", set, request: emailRequest() }, onTerminal);

    expect(judgeEssay).not.toHaveBeenCalled();
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith("att-term-superseded");
  });

  it("does NOT invoke onTerminal when the job id does not exist at all — nothing meaningful can be claimed about a nonexistent row", async () => {
    const { deps } = buildDeps();
    const onTerminal = vi.fn();
    await runScoringJob(deps, "does-not-exist-either", { attemptId: "att-none", set, request: emailRequest() }, onTerminal);
    expect(onTerminal).not.toHaveBeenCalled();
  });

  it("a throwing onTerminal callback is caught and logged, never rejects runScoringJob, and never mutates the already-committed job result", async () => {
    const { deps, repo: r, judgeEssay } = buildDeps();
    r.createAttempt({ id: "att-term-throws", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createScoringJob({ id: "job-term-throws", attemptId: "att-term-throws", taskType: "email", itemIds: [emailId] });
    judgeEssay.mockImplementation(async (judge: "gemini" | "openai") => essayJudgeResult(judge, 4));

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const onTerminal = vi.fn().mockRejectedValue(new Error("onTerminal blew up"));
    await expect(
      runScoringJob(deps, "job-term-throws", { attemptId: "att-term-throws", set, request: emailRequest() }, onTerminal)
    ).resolves.toBeUndefined();

    const job = r.getScoringJob("job-term-throws")!;
    expect(job.status).toBe("done");
    expect(JSON.parse(job.result!).report.items[0].finalScore).toBe(4);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("a throw from the finally block's own job re-read never REPLACES the error runScoringJob was already propagating", async () => {
    // The runner's finally re-reads the job row to decide whether to call onTerminal
    // (durableJobRunner.ts). A second failure there (SQLITE_BUSY, a closed database) must not
    // replace the error the try block is already propagating: runScoringJob is often launched
    // fire-and-forget, where that rejection is the only thing anyone sees.
    const { deps, repo: r } = buildDeps();
    r.createAttempt({ id: "att-term-finally-throws", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createScoringJob({ id: "job-term-finally-throws", attemptId: "att-term-finally-throws", taskType: "email", itemIds: [emailId] });

    let getCalls = 0;
    const throwingDeps = {
      ...deps,
      repo: {
        ...r,
        getScoringJob: (): never => {
          getCalls += 1;
          throw new Error(
            getCalls === 1
              ? "simulated ORIGINAL getScoringJob failure"
              : "simulated finally-internal failure — must NEVER be what this call rejects with",
          );
        },
      },
    };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      runScoringJob(throwingDeps, "job-term-finally-throws", { attemptId: "att-term-finally-throws", set, request: emailRequest() }, vi.fn()),
    ).rejects.toThrow("simulated ORIGINAL getScoringJob failure");
    // The finally's re-read did run and fail, and the guard caught it.
    expect(getCalls).toBeGreaterThan(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("terminal-callback dispatch failed"), expect.anything());
    errorSpy.mockRestore();
  });

  it("runs the job to 'done' when onTerminal is omitted", async () => {
    const { deps, repo: r, judgeEssay } = buildDeps();
    r.createAttempt({ id: "att-no-callback", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createScoringJob({ id: "job-no-callback", attemptId: "att-no-callback", taskType: "email", itemIds: [emailId] });
    judgeEssay.mockImplementation(async (judge: "gemini" | "openai") => essayJudgeResult(judge, 4));

    await runScoringJob(deps, "job-no-callback", { attemptId: "att-no-callback", set, request: emailRequest() });
    expect(r.getScoringJob("job-no-callback")?.status).toBe("done");
  });
});

describe("enqueueScoringJob", () => {
  it("route path (supersedeActive:true): creates the job BEFORE superseding older same-task-type work, launches the runner, and returns the new job id", async () => {
    const { deps, repo: r, judgeEssay } = buildDeps();
    judgeEssay.mockImplementation(async (judge: "gemini" | "openai") => essayJudgeResult(judge, 4));
    r.createAttempt({ id: "att-route", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    const olderJobId = "older-email-job";
    r.createScoringJob({ id: olderJobId, attemptId: "att-route", taskType: "email", itemIds: [emailId] });

    const options: RouteScoringJobOptions = { supersedeActive: true };
    const jobId = enqueueScoringJob(deps, { attemptId: "att-route", set, request: emailRequest() }, options);
    expect(typeof jobId).toBe("string");
    expect(jobId).not.toBe(olderJobId);

    // A superseded job ends 'cancelled', with 'superseded' as its reason.
    expect(r.getScoringJob(olderJobId)).toMatchObject({
      status: "cancelled",
      cancellation_reason: "superseded",
      cancelled_at: expect.any(String),
      terminal_at: expect.any(String),
    });

    await vi.waitFor(() => {
      expect(r.getScoringJob(jobId)?.status).toBe("done");
    });
  });

  it("route path never supersedes a DIFFERENT attempt or a different task type", async () => {
    const { deps, repo: r, judgeEssay } = buildDeps();
    judgeEssay.mockImplementation(async (judge: "gemini" | "openai") => essayJudgeResult(judge, 4));
    r.createAttempt({ id: "att-route-a", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createAttempt({ id: "att-route-b", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createScoringJob({ id: "other-attempt-job", attemptId: "att-route-b", taskType: "email", itemIds: [emailId] });

    const jobId = enqueueScoringJob(deps, { attemptId: "att-route-a", set, request: emailRequest() }, { supersedeActive: true });
    await vi.waitFor(() => { expect(r.getScoringJob(jobId)?.status).toBe("done"); });
    expect(r.getScoringJob("other-attempt-job")?.status).toBe("queued");
  });

  it("recovery path (supersedeActive:false): atomically creates+links a new scoring job from an awaiting_score transcription job, launches the runner, and the transcription job links to it", async () => {
    const { deps, repo: r, judgeSpeaking, aggregateSpeaking } = buildDeps();
    mockSpeakingSuccess({ judgeSpeaking, aggregateSpeaking });
    r.createAttempt({ id: "att-recovery", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedTranscribedSpeakingItem(r, "att-recovery");
    const tJob = r.seedTranscriptionJob({
      id: "trans-job-1", attempt_id: "att-recovery", item_id: lr1Id, status: "awaiting_score",
    });

    const onTerminal = vi.fn();
    const options: RecoveryScoringJobOptions = { supersedeActive: false, transcriptionJobId: tJob.id, onTerminal };
    const scoreJobId = enqueueScoringJob(deps, { attemptId: "att-recovery", set: speakingSet, request: oneItemListenRepeatRequest() }, options);
    expect(typeof scoreJobId).toBe("string");
    expect(JSON.parse(r.getScoringJob(scoreJobId!)!.item_ids)).toEqual([lr1Id]);
    // Linked in the transaction that created the job, before the runner has had a chance to run.
    expect(r.getTranscriptionJob(tJob.id)?.score_job_id).toBe(scoreJobId);
    expect(r.getTranscriptionJob(tJob.id)?.status).toBe("done");

    await vi.waitFor(() => { expect(r.getScoringJob(scoreJobId!)?.status).toBe("done"); });
    expect(onTerminal).toHaveBeenCalledWith("att-recovery");
  });

  it("recovery path reuses an already-linked scoring job id and launches NO second runner", async () => {
    const { deps, repo: r, judgeSpeaking, aggregateSpeaking } = buildDeps();
    mockSpeakingSuccess({ judgeSpeaking, aggregateSpeaking });
    r.createAttempt({ id: "att-reuse", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedTranscribedSpeakingItem(r, "att-reuse");
    const tJob = r.seedTranscriptionJob({
      id: "trans-job-reuse", attempt_id: "att-reuse", item_id: lr1Id, status: "awaiting_score",
    });

    const first = enqueueScoringJob(
      deps, { attemptId: "att-reuse", set: speakingSet, request: oneItemListenRepeatRequest() },
      { supersedeActive: false, transcriptionJobId: tJob.id },
    );
    await vi.waitFor(() => { expect(r.getScoringJob(first!)?.status).toBe("done"); });

    judgeSpeaking.mockClear();
    const second = enqueueScoringJob(
      deps, { attemptId: "att-reuse", set: speakingSet, request: oneItemListenRepeatRequest() },
      { supersedeActive: false, transcriptionJobId: tJob.id },
    );
    expect(second).toBe(first);
    // Give any accidental second runner a chance to start before asserting it never did.
    await new Promise((r2) => setTimeout(r2, 20));
    expect(judgeSpeaking).not.toHaveBeenCalled();
  });

  it("recovery path returns null and launches nothing when the transcription job is no longer the current awaiting_score job (stale/mismatched)", async () => {
    const { deps, repo: r, judgeSpeaking } = buildDeps();
    r.createAttempt({ id: "att-stale", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedTranscribedSpeakingItem(r, "att-stale");
    const tJob = r.seedTranscriptionJob({
      id: "trans-job-stale", attempt_id: "att-stale", item_id: lr1Id,
    });
    // Still 'queued', never awaiting_score, so createRecoveryScoringJobAndLink rejects it and
    // enqueueScoringJob returns null.
    const result = enqueueScoringJob(
      deps, { attemptId: "att-stale", set: speakingSet, request: oneItemListenRepeatRequest() },
      { supersedeActive: false, transcriptionJobId: tJob.id },
    );
    expect(result).toBeNull();
    expect(judgeSpeaking).not.toHaveBeenCalled();
    expect(r.getTranscriptionJob(tJob.id)?.score_job_id).toBeNull();
  });
});

describe("parseItemIds, which speakingFinalization's orphan check also reads coverage through", () => {
  it("parses a well-formed item_ids array", () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-parse", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    r.createScoringJob({ id: "job-parse", attemptId: "att-parse", taskType: "listen_repeat", itemIds: ["lr-1", "lr-2"] });
    const job = r.getScoringJob("job-parse")!;
    expect(parseItemIds(job)).toEqual(["lr-1", "lr-2"]);
  });

  it("returns [] and warns (never throws) for a corrupt item_ids column", () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-parse-corrupt", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    // No store writer can produce this (createScoringJob always JSON.stringifies an array), so the
    // row is seeded raw.
    r.seedScoringJob({
      id: "job-parse-corrupt", attempt_id: "att-parse-corrupt", task_type: "listen_repeat",
      item_ids: "{not valid json", status: "running",
    });
    const job = r.getScoringJob("job-parse-corrupt")!;

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let result: string[] = [];
    expect(() => { result = parseItemIds(job); }).not.toThrow();
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("job-parse-corrupt"));
    warnSpy.mockRestore();
  });
});

// Scoring crossing into speakingFinalization. The two assertions that carry the point: the Attempt is
// still 'in_progress' after the capture marker, and reaches 'completed' with a persisted linear-v2
// estimate only once the scoring job's own onTerminal fires.
describe("speakingFinalization's reconcileAttempt as the scoring terminal callback", () => {
  it("completes a capture-finished speaking simulation and saves its estimate once its ONLY scoring job reaches 'done' via runScoringJob's own onTerminal firing — the real event-driven trigger, not a direct reconcileAttempt() call", async () => {
    const { deps, repo: r, judgeSpeaking, aggregateSpeaking } = buildFinalizationDeps();
    mockSpeakingSuccess({ judgeSpeaking, aggregateSpeaking });
    const attemptId = "att-finalize-integration";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    // The row an upload (and its landed transcription) would have written — wider than the four
    // fields scoring itself may write, which is why it is seeded rather than scored in.
    r.insertItemResult({
      attemptId, itemId: lr1Id, taskType: "listen_repeat",
      responseAudioPath: `audio/responses/${attemptId}/${lr1Id}.webm`,
      transcript: "we open the front desk at six",
      deliveryReport: JSON.stringify(flatDeliveryReport),
    });

    const finalization = createSpeakingFinalization({ repo: r });
    await finalization.markCaptureFinished(attemptId);
    expect(r.getAttempt(attemptId)!.status).toBe("in_progress");

    const jobId = enqueueScoringJob(
      deps,
      { attemptId, set: speakingSet, request: oneItemListenRepeatRequest() },
      { supersedeActive: true, onTerminal: finalization.reconcileAttempt },
    );
    expect(typeof jobId).toBe("string");

    await vi.waitFor(() => {
      expect(r.getAttempt(attemptId)!.status).toBe("completed");
    });

    const estimate = r.getSectionEstimate(attemptId);
    expect(estimate?.section).toBe("speaking");
    expect(estimate?.method).toBe("linear-v2");
  });

  it("this callback is the only scoring-to-finalization dependency — scoreItems.ts never imports speakingFinalization", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const scoreItemsSrc = fs.readFileSync(path.join(here, "../src/services/scoreItems.ts"), "utf8");
    expect(scoreItemsSrc).not.toMatch(/speakingFinalization/);
  });
});

describe("failInterruptedJobs", () => {
  it("recovers a job left 'running' with its items still pending: the job flips to failed and its items to rescorable failed", () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-drill", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    r.insertItemResult({ attemptId: "att-drill", itemId: "lr-1", taskType: "listen_repeat", transcript: "hello world", deliveryReport: "{}" });
    r.insertItemResult({ attemptId: "att-drill", itemId: "lr-2", taskType: "listen_repeat", transcript: "goodbye now", deliveryReport: "{}" });
    // Both Judge Reports are present, as when the Arbiter never finished and no error path ran:
    // recovery does not depend on judge_reports being absent.
    r.insertJudgeReport({ attemptId: "att-drill", itemId: "lr-1", judge: "gemini", reportJson: "{}" });
    r.insertJudgeReport({ attemptId: "att-drill", itemId: "lr-1", judge: "openai", reportJson: "{}" });
    r.createScoringJob({ id: "job-1", attemptId: "att-drill", taskType: "listen_repeat", itemIds: ["lr-1", "lr-2"] });
    r.seedScoringJobState({ id: "job-1", status: "running", stage: "judging" });

    const summary = failInterruptedJobs({ repo: r });
    expect(summary).toEqual({ jobs: 1, items: 2 });

    const job = r.getScoringJob("job-1")!;
    expect(job.status).toBe("failed");
    expect(job.error).toBe("interrupted by server restart");

    for (const item of r.getAttempt("att-drill")!.items) {
      expect(item.scoring_status).toBe("failed");
      expect(JSON.parse(item.score_json!)).toEqual({ error: "scoring interrupted" });
    }
  });

  it("orphan sweep: settles a pending item with a transcript that NO job row covers the same way", () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-orphan", kind: "speaking", mode: "simulation", setId: "spk-001", isRepeat: false });
    r.insertItemResult({ attemptId: "att-orphan", itemId: "int-1", taskType: "interview", transcript: "my answer", deliveryReport: "{}" });
    // No scoring_jobs row covers this Item.

    const summary = failInterruptedJobs({ repo: r });
    expect(summary).toEqual({ jobs: 0, items: 1 });

    const item = r.getAttempt("att-orphan")!.items[0];
    expect(item.scoring_status).toBe("failed");
    expect(JSON.parse(item.score_json!)).toEqual({ error: "scoring interrupted" });
  });

  it("orphan sweep ignores pending items without a transcript (e.g. an essay still awaiting judges) — only transcript-bearing speaking items are stray", () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-essay", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.insertItemResult({ attemptId: "att-essay", itemId: emailId, taskType: "email", responseText: "hi" });

    const summary = failInterruptedJobs({ repo: r });
    expect(summary).toEqual({ jobs: 0, items: 0 });
    expect(r.getAttempt("att-essay")!.items[0].scoring_status).toBe("pending");
  });

  it("only flips items still 'pending' at recovery time — an item already scored/failed before the interruption is left exactly as it is", () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-partial", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    r.insertItemResult({ attemptId: "att-partial", itemId: "lr-1", taskType: "listen_repeat", transcript: "a", deliveryReport: "{}" });
    r.insertItemResult({ attemptId: "att-partial", itemId: "lr-2", taskType: "listen_repeat", transcript: "b", deliveryReport: "{}" });
    r.updateItemScore({ attemptId: "att-partial", itemId: "lr-1", score: 3, scoreJson: '{"finalScore":3}', scoringStatus: "scored" });
    r.createScoringJob({ id: "job-partial", attemptId: "att-partial", taskType: "listen_repeat", itemIds: ["lr-1", "lr-2"] });
    r.seedScoringJobState({ id: "job-partial", status: "running" });

    const summary = failInterruptedJobs({ repo: r });
    expect(summary).toEqual({ jobs: 1, items: 1 }); // only lr-2 flips

    const items = r.getAttempt("att-partial")!.items;
    expect(items.find((i) => i.item_id === "lr-1")!.scoring_status).toBe("scored");
    expect(items.find((i) => i.item_id === "lr-2")!.scoring_status).toBe("failed");
  });

  it("is idempotent: running recovery a second time (nothing left queued|running or orphaned) is a {jobs:0, items:0} no-op", () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-idem", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    r.insertItemResult({ attemptId: "att-idem", itemId: "lr-1", taskType: "listen_repeat", transcript: "hi", deliveryReport: "{}" });
    r.createScoringJob({ id: "job-idem", attemptId: "att-idem", taskType: "listen_repeat", itemIds: ["lr-1"] });
    r.seedScoringJobState({ id: "job-idem", status: "running" });
    r.createAttempt({ id: "att-orphan2", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    r.insertItemResult({ attemptId: "att-orphan2", itemId: "int-1", taskType: "interview", transcript: "orphan", deliveryReport: "{}" });

    const first = failInterruptedJobs({ repo: r });
    expect(first).toEqual({ jobs: 1, items: 2 });

    const second = failInterruptedJobs({ repo: r });
    expect(second).toEqual({ jobs: 0, items: 0 });

    // State from the first pass is untouched by the idempotent second pass.
    expect(r.getScoringJob("job-idem")?.status).toBe("failed");
    expect(r.getAttempt("att-idem")!.items[0].scoring_status).toBe("failed");
    expect(r.getAttempt("att-orphan2")!.items[0].scoring_status).toBe("failed");
  });

  it("leaves a finished job completely untouched — only queued|running jobs are recovered", () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-terminal", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
    r.createScoringJob({ id: "job-done", attemptId: "att-terminal", taskType: "email", itemIds: [emailId] });
    r.seedScoringJobState({ id: "job-done", status: "done", result: '{"ok":true}' });

    const summary = failInterruptedJobs({ repo: r });
    expect(summary).toEqual({ jobs: 0, items: 0 });
    const job = r.getScoringJob("job-done")!;
    expect(job.status).toBe("done");
    expect(job.result).toBe('{"ok":true}');
    expect(job.error).toBeNull();
  });

  it("a job row with corrupt item_ids JSON does not throw and does not block recovery of OTHER jobs (only its own items go unidentified)", () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-corrupt", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    // No transcript, so the orphan sweep (which looks only at Items with one) cannot recover this
    // Item either, and the test sees only this guard's job: not crashing, and not blocking other
    // jobs.
    r.insertItemResult({ attemptId: "att-corrupt", itemId: "lr-1", taskType: "listen_repeat" });
    // createScoringJob always JSON.stringifies an array, so a corrupt row (hand-edited data, say)
    // can only be seeded raw.
    r.seedScoringJob({
      id: "job-corrupt", attempt_id: "att-corrupt", task_type: "listen_repeat",
      item_ids: "{not valid json", status: "running",
    });

    // A second, healthy Attempt and job that recovery still has to process.
    r.createAttempt({ id: "att-ok", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    r.insertItemResult({ attemptId: "att-ok", itemId: "lr-2", taskType: "listen_repeat", transcript: "bye", deliveryReport: "{}" });
    r.createScoringJob({ id: "job-ok", attemptId: "att-ok", taskType: "listen_repeat", itemIds: ["lr-2"] });
    r.seedScoringJobState({ id: "job-ok", status: "running" });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    let summary: { jobs: number; items: number };
    expect(() => { summary = failInterruptedJobs({ repo: r }); }).not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("job-corrupt"));
    warnSpy.mockRestore();

    // The corrupt job is still marked failed: that write does not depend on parsing item_ids.
    expect(r.getScoringJob("job-corrupt")?.status).toBe("failed");
    // Its Item cannot be identified from the corrupt row, so this pass leaves it as it was.
    expect(r.getAttempt("att-corrupt")!.items[0].scoring_status).toBe("pending");

    // The healthy job and Item recover normally.
    expect(r.getScoringJob("job-ok")?.status).toBe("failed");
    expect(r.getAttempt("att-ok")!.items[0].scoring_status).toBe("failed");
    expect(summary!).toEqual({ jobs: 2, items: 1 });
  });
});

describe("wireBootRecovery", () => {
  it("does not run recovery at wiring time — only once the server fires 'listening' (confirming this process owns the port)", () => {
    const r = openSqliteStores();
    r.createAttempt({ id: "att-wire", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    r.insertItemResult({ attemptId: "att-wire", itemId: "lr-1", taskType: "listen_repeat", transcript: "hi", deliveryReport: "{}" });
    r.createScoringJob({ id: "job-wire", attemptId: "att-wire", taskType: "listen_repeat", itemIds: ["lr-1"] });
    r.seedScoringJobState({ id: "job-wire", status: "running" });

    // A minimal fake server: just enough of the 'on' surface for wireBootRecovery, with the
    // 'listening' listener captured so the test decides when it fires. No socket is bound.
    const listeners: Partial<Record<"listening", () => void>> = {};
    const fakeServer: BootRecoveryServer = {
      on: (event, listener) => { listeners[event] = listener; },
    };

    wireBootRecovery(fakeServer, r);

    // Wiring alone runs no recovery. A second process started while the first is alive (and the
    // second is retrying on EADDRINUSE) must not mark the first process's live job failed before it
    // has confirmed it owns the port.
    expect(r.getScoringJob("job-wire")?.status).toBe("running");

    // Recovery runs once the server confirms it is listening.
    listeners.listening!();
    expect(r.getScoringJob("job-wire")?.status).toBe("failed");
  });
});
