import { describe, expect, it, vi } from "vitest";
import { readBankSet } from "./helpers/setFixtures.js";
import type { AnySet, ScoreReport, ScoreRequest } from "@toefl-prep/shared";
import { sqliteTimestamp, type SqliteTimestamp } from "../src/db/timestamps.js";
import { failInterruptedJobs, runScoringJob } from "../src/services/scoringJobs.js";
import {
  failInterruptedGenerationJobs,
  runGenerationBatch as runGenerationBatchWithPlanner,
  runGenerationJob as runGenerationJobWithPlanner,
} from "../src/services/generationJobs.js";
import { isTerminalJobStatus } from "../src/services/durableJobRunner.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import { speakingPlanFixture, writingPlanFixture } from "./helpers/generationDiversityFixtures.js";
import { openSqliteStores } from "./helpers/sqliteStores.js";
import { at } from "./helpers/timestamps.js";

/**
 * The lifecycle every durable job family shares. Each fact here is owned by durableJobRunner.ts, so
 * it holds for scoring, generation and the generation batch parent at once; the family suites keep
 * only their adapter concerns (which store writers a step means, what is cleaned up, what the
 * progress detail carries).
 *
 * Each fact gets one `it` per family rather than a parametrized adapter, because the fixtures differ
 * (a scoring job needs Judges and a Set, a generation job a planner and a skill route) while the
 * assertion does not.
 *
 * Transcription is not a runner family (see the scope note in durableJobRunner.ts);
 * transcriptionRecovery.test.ts covers it.
 *
 * Both families run on the real SQLite stores over a private in-memory database, so every
 * conditional writer the runner relies on is the statement production runs.
 */

// Scoring fixtures: the Email Set routes.attempts.test.ts uses. An Email needs no audio, only Judge
// and Arbiter mocks, which keeps these tests on the job lifecycle rather than on scoreItems.ts.
const SET_ID = "wri-77af733e";
const writingSet = readBankSet("writing", SET_ID);
const emailId = (writingSet as Extract<AnySet, { kind: "writing" }>).email.id;

const scoreReport: ScoreReport = {
  taskType: "email",
  items: [{
    itemId: emailId, ownScore: 4, finalScore: 4, maxScore: 5,
    dimensions: [{ name: "mechanics", note: "solid" }], deductions: [],
    reconciliationNote: "judges agreed closely", feedbackZh: "寫得不錯。",
  }],
};

function emailRequest(): ScoreRequest {
  return { taskType: "email", items: [{ itemId: emailId, text: "Dear Sir, I am writing to...", secondsUsed: 90 }] };
}

function scoringWorld() {
  const r = openSqliteStores();
  const judgeEssay = vi.fn();
  const aggregate = vi.fn(async () => ({ report: scoreReport, provider: "claude" as const }));
  const deps = { repo: r, judgeEssay, aggregate, judgeSpeaking: vi.fn(), aggregateSpeaking: vi.fn() };
  return { r, deps, judgeEssay };
}

function judgeSuccess(judge: "gemini" | "openai") {
  return {
    report: {
      judge, taskType: "email" as const,
      items: [{ itemId: emailId, score: 4, dimensions: [{ name: "mechanics", score: 4, evidence: "clean spelling" }], deductions: [] }],
    },
    provider: judge === "gemini" ? ("gemini-http" as const) : ("codex" as const),
  };
}

// Generation fixtures. Every reasoning fake is the facade seam, so no test here executes a real CLI.
function generationWorld() {
  const r = openSqliteStores();
  const runSkillTask = vi.fn();
  const planner = {
    reserve: vi.fn(async (input: { kind: "speaking" | "writing" | "reading" | "listening"; ownerId: string }) => ({
      reservationId: `reservation-${input.ownerId}`,
      ownerId: input.ownerId,
      plan: input.kind === "speaking" ? speakingPlanFixture() : writingPlanFixture(),
    })),
    validateCandidate: vi.fn().mockReturnValue([]),
    release: vi.fn(),
  };
  const deps = { repo: r, runSkillTask, planner };
  return {
    r,
    runSkillTask,
    runJob: (jobId: string, kind: "writing" = "writing") => runGenerationJobWithPlanner(deps, jobId, { kind }),
    runBatch: (batchId: string) => runGenerationBatchWithPlanner({ ...deps, batchConcurrency: 1 }, batchId),
  };
}

const ROUTE_EXHAUSTED = {
  ok: false as const,
  error: "Structured reasoning unavailable: Claude (quota) → Codex (timeout).",
  attempts: [
    { provider: "claude" as const, kind: "quota" as const },
    { provider: "codex" as const, kind: "timeout" as const },
  ],
};

describe("the shared durable-job lifecycle", () => {
  // A durable runner is launched fire-and-forget, so by the time it starts its row may have vanished
  // or been moved on by someone else. Neither is this invocation's to write, and neither may cost a
  // paid call.
  describe("queued no-op", () => {
    it("scoring: an unknown job id and an already-superseded job both run nothing and touch no row", async () => {
      const { r, deps, judgeEssay } = scoringWorld();
      r.createAttempt({ id: "att-noop", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });

      await runScoringJob(deps, "does-not-exist", { attemptId: "att-noop", set: writingSet, request: emailRequest() });
      expect(judgeEssay).not.toHaveBeenCalled();

      r.createScoringJob({ id: "job-noop", attemptId: "att-noop", taskType: "email", itemIds: [emailId] });
      r.replaceScoringJobAndSupersede({ id: "job-noop-next", attemptId: "att-noop", taskType: "email", itemIds: [emailId], now: at("2026-08-13 00:00:00") });
      const before = r.getScoringJob("job-noop");
      await runScoringJob(deps, "job-noop", { attemptId: "att-noop", set: writingSet, request: emailRequest() });

      expect(judgeEssay).not.toHaveBeenCalled();
      expect(r.getScoringJob("job-noop")).toEqual(before);
      expect(before).toMatchObject({ status: "cancelled", cancellation_reason: "superseded" });
    });

    it("generation: an unknown job id and an already-failed job both run nothing and touch no row", async () => {
      const { r, runSkillTask, runJob } = generationWorld();

      await runJob("does-not-exist");
      expect(runSkillTask).not.toHaveBeenCalled();

      r.createGenerationJob({ id: "gen-noop", kind: "writing" });
      r.updateGenerationJob({ id: "gen-noop", status: "failed", error: "already dead" });
      await runJob("gen-noop");

      expect(runSkillTask).not.toHaveBeenCalled();
      expect(r.getGenerationJob("gen-noop")?.status).toBe("failed");
      expect(r.getGenerationJob("gen-noop")?.error).toBe("already dead");
    });

    it("generation batch parent: an unknown batch and an already-running batch admit no child", async () => {
      const { r, runSkillTask, runBatch } = generationWorld();

      await runBatch("does-not-exist");
      expect(runSkillTask).not.toHaveBeenCalled();

      r.createGenerationBatch({ id: "batch-noop", total: 1 });
      r.updateGenerationBatch({ id: "batch-noop", status: "running" });
      r.createGenerationJob({ id: "bn0", kind: "writing", batchId: "batch-noop", batchIndex: 0 });

      await runBatch("batch-noop");
      expect(runSkillTask).not.toHaveBeenCalled();
      expect(r.getGenerationJob("bn0")?.status).toBe("queued"); // untouched
    });
  });

  // A cancellation recorded while the row is still 'queued' makes the claim refuse with
  // 'cancel_requested'. No other code is coming for that row, so the run that called the claim owes
  // it a terminal state now; treating the refusal as "not mine" would leave it non-terminal, with a
  // null terminal_at, until the next boot's sweep. And it must not spend a Judge, Arbiter or
  // reasoning call on work the User asked to stop.
  describe("cancel-before-start", () => {
    it("scoring: a cancel-stamped queued job is terminalized without a single Judge or Arbiter call", async () => {
      const { r, deps, judgeEssay } = scoringWorld();
      r.createAttempt({ id: "att-precancel", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
      r.createScoringJob({ id: "job-precancel", attemptId: "att-precancel", taskType: "email", itemIds: [emailId] });
      r.requestScoringJobCancellation({ id: "job-precancel", reason: "user", now: sqliteTimestamp() });
      expect(r.getScoringJob("job-precancel")?.status).toBe("queued"); // still genuinely queued

      const onTerminal = vi.fn();
      await runScoringJob(
        deps,
        "job-precancel",
        { attemptId: "att-precancel", set: writingSet, request: emailRequest() },
        onTerminal,
      );

      const job = r.getScoringJob("job-precancel")!;
      expect(job.status).toBe("cancelled");
      expect(job.terminal_at).not.toBeNull(); // terminal in this run, not at the next boot
      expect(job.cancelled_at).not.toBeNull();
      expect(job.cancellation_reason).toBe("user");
      expect(judgeEssay).not.toHaveBeenCalled();
      expect(deps.aggregate).not.toHaveBeenCalled();
      // Nothing was scored.
      expect(job.result).toBeNull();
      expect(r.getJudgeReports("att-precancel")).toEqual([]);
      // The terminal callback still fires: the row reached a terminal status, which is the only
      // question the runner asks before dispatching it.
      expect(onTerminal).toHaveBeenCalledExactlyOnceWith("att-precancel");
    });

    it("generation: a cancel recorded after admission but before the running claim is terminalized, not stranded", async () => {
      const { r, runSkillTask } = generationWorld();
      r.createGenerationJob({ id: "gen-claim-race", kind: "writing" });

      // Wrapping the claim is the only way to land a cancel in this gap: the runner crosses no await
      // between reading the row and claiming it, and better-sqlite3 is synchronous, so nothing in
      // this process can interleave there. The claim then sees the same row a cancel recorded before
      // admission leaves, which is the point: when the cancel arrived does not change what the
      // runner owes the row.
      const racingRepo = {
        ...r,
        claimGenerationJobRunning: (id: string, now: SqliteTimestamp = sqliteTimestamp()) => {
          r.requestGenerationJobCancellation({ id, reason: "user", now });
          return r.claimGenerationJobRunning(id, now);
        },
      };

      await runGenerationJobWithPlanner(
        { repo: racingRepo, runSkillTask, planner: { reserve: vi.fn(), release: vi.fn() } },
        "gen-claim-race",
        { kind: "writing" },
      );

      const job = r.getGenerationJob("gen-claim-race")!;
      expect(job.status).toBe("cancelled");
      expect(job.terminal_at).not.toBeNull();
      expect(job.cancelled_at).not.toBeNull();
      expect(job.cancellation_reason).toBe("user");
      expect(runSkillTask).not.toHaveBeenCalled(); // refused before a single reasoning call
    });
  });

  // Every terminal write sits behind a still-running guard, so a job whose row was moved on while
  // its work was in flight is never resurrected: not to 'done' with a result nobody asked for, and
  // not to 'failed' over an error raised on the way out.
  describe("mid-flight supersession", () => {
    it("scoring: a job superseded while its Judges are in flight is not flipped to 'done', and persists nothing", async () => {
      const { r, deps, judgeEssay } = scoringWorld();
      r.createAttempt({ id: "att-mid", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
      r.createScoringJob({ id: "job-mid", attemptId: "att-mid", taskType: "email", itemIds: [emailId] });
      r.insertItemResult({ attemptId: "att-mid", itemId: emailId, taskType: "email", responseText: "hello" });

      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started = 0;
      let bothStarted!: () => void;
      const startedPromise = new Promise<void>((resolve) => { bothStarted = resolve; });
      judgeEssay.mockImplementation(async (judge: "gemini" | "openai") => {
        started += 1;
        if (started === 2) bothStarted();
        await gate;
        return judgeSuccess(judge);
      });

      const running = runScoringJob(deps, "job-mid", { attemptId: "att-mid", set: writingSet, request: emailRequest() });
      await startedPromise;
      expect(r.getScoringJob("job-mid")?.status).toBe("running");
      // A newer score request for the same Attempt and Task Type lands while the Judges are out.
      r.replaceScoringJobAndSupersede({ id: "job-mid-next", attemptId: "att-mid", taskType: "email", itemIds: [emailId], now: at("2026-08-13 00:00:00") });
      release();
      await running;

      const job = r.getScoringJob("job-mid")!;
      // Left exactly as the replacement left it.
      expect(job).toMatchObject({ status: "cancelled", cancellation_reason: "superseded" });
      expect(job.result).toBeNull();
      // Scores are buffered and committed only inside the terminal 'done' transaction, so a
      // superseded job's score never reaches item_results or judge_reports.
      expect(r.getAttempt("att-mid")?.items).toEqual([
        expect.objectContaining({ item_id: emailId, scoring_status: "pending", score: null }),
      ]);
      expect(r.getJudgeReports("att-mid")).toEqual([]);
    });

    it("generation: a job moved on while generateSet is in flight is not flipped to 'failed'", async () => {
      const { r, runSkillTask, runJob } = generationWorld();
      r.createGenerationJob({ id: "gen-mid", kind: "writing" });

      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let generateStartedResolve!: () => void;
      const generateStarted = new Promise<void>((resolve) => { generateStartedResolve = resolve; });
      runSkillTask.mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        request.onEvent?.({ state: "running", provider: "claude" });
        generateStartedResolve();
        await gate;
        return ROUTE_EXHAUSTED;
      });

      const running = runJob("gen-mid");
      await generateStarted;
      expect(r.getGenerationJob("gen-mid")?.status).toBe("running");
      // Stands for a shutdown abort's durable write, or any other owner moving this row on.
      r.updateGenerationJob({ id: "gen-mid", status: "cancelled" });
      release();
      await running;

      const job = r.getGenerationJob("gen-mid")!;
      expect(job.status).toBe("cancelled"); // not overwritten with the route-exhaustion failure
      expect(job.error).toBeNull();
    });
  });

  // The boot sweeps heal whatever the runner never got to write. Both are bookkeeping only (neither
  // re-runs paid work), and both must be safe to run on every boot.
  describe("idempotent boot sweep", () => {
    it("scoring: a second pass finds nothing queued|running or orphaned and is a {jobs:0, items:0} no-op", () => {
      const r = openSqliteStores();
      r.createAttempt({ id: "att-idem", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
      r.createScoringJob({ id: "job-idem", attemptId: "att-idem", taskType: "email", itemIds: [emailId] });
      r.insertItemResult({ attemptId: "att-idem", itemId: emailId, taskType: "email", responseText: "hello" });
      r.seedScoringJobState({ id: "job-idem", status: "running" });

      expect(failInterruptedJobs({ repo: r })).toEqual({ jobs: 1, items: 1 });
      expect(failInterruptedJobs({ repo: r })).toEqual({ jobs: 0, items: 0 });

      expect(r.getScoringJob("job-idem")?.status).toBe("failed");
      expect(r.getAttempt("att-idem")?.items[0].scoring_status).toBe("failed");
    });

    it("generation: a second pass finds nothing queued|running and is a {jobs:0, cleaned:0} no-op", () => {
      const r = openSqliteStores();
      r.createGenerationJob({ id: "gen-idem", kind: "writing" });
      r.updateGenerationJob({ id: "gen-idem", status: "running" });

      expect(failInterruptedGenerationJobs({ repo: r })).toEqual({ jobs: 1, cleaned: 0 });
      expect(failInterruptedGenerationJobs({ repo: r })).toEqual({ jobs: 0, cleaned: 0 });

      expect(r.getGenerationJob("gen-idem")?.status).toBe("failed");
    });

    it("generation batch parents are swept idempotently too, and an already-terminal parent is left alone", () => {
      const r = openSqliteStores();
      r.createGenerationBatch({ id: "batch-idem", total: 2 });
      r.createGenerationJob({ id: "bi0", kind: "writing", batchId: "batch-idem", batchIndex: 0 });
      r.createGenerationJob({ id: "bi1", kind: "writing", batchId: "batch-idem", batchIndex: 1 });
      r.updateGenerationJob({ id: "bi0", status: "done" });
      r.updateGenerationJob({ id: "bi1", status: "running" });

      failInterruptedGenerationJobs({ repo: r });
      expect(r.getGenerationBatch("batch-idem")?.status).toBe("partial");

      expect(failInterruptedGenerationJobs({ repo: r })).toEqual({ jobs: 0, cleaned: 0 });
      expect(r.getGenerationBatch("batch-idem")?.status).toBe("partial");
    });
  });

  // The runner's own definition of "settled", shared by every family's terminal callback dispatch.
  describe("terminal statuses", () => {
    it("covers every terminal status any family can reach, and no non-terminal one", () => {
      for (const status of ["done", "failed", "cancelled", "partial"]) {
        expect(isTerminalJobStatus(status)).toBe(true);
      }
      for (const status of ["queued", "running", "retry_wait", undefined]) {
        expect(isTerminalJobStatus(status)).toBe(false);
      }
    });
  });
});
