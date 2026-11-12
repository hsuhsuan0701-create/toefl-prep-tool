import { describe, expect, it, vi } from "vitest";
import type { AnySet, JudgeReport, ScoreReport, ScoreRequest } from "@toefl-prep/shared";
import { readBankSet } from "./helpers/setFixtures.js";
import { openSqliteStores } from "./helpers/sqliteStores.js";
import { abortScoringJob, runScoringJob } from "../src/services/scoringJobs.js";
import type { aggregate as realAggregate } from "../src/services/arbiter.js";

// Which provider is working on a job is live progress, shown while the job runs. Once the job is
// finished its persisted progress names no provider: every terminal write drops the fields, and a
// progress checkpoint arriving after the job ended never lands on its row.

type AggregateInput = Parameters<typeof realAggregate>[0];
type AggregateOptions = Parameters<typeof realAggregate>[1];

const SET_ID = "wri-77af733e";
const set = readBankSet("writing", SET_ID);
const emailId = (set as Extract<AnySet, { kind: "writing" }>).email.id;

const report: ScoreReport = {
  taskType: "email",
  items: [{
    itemId: emailId, ownScore: 4, finalScore: 4, maxScore: 5, dimensions: [{ name: "mechanics", note: "solid" }],
    deductions: [], reconciliationNote: "judges agreed", feedbackZh: "寫得不錯。",
  }],
};

function judgeReport(judge: "gemini" | "openai"): JudgeReport {
  return { judge, taskType: "email", items: [{ itemId: emailId, score: 4, dimensions: [{ name: "mechanics", score: 4, evidence: "clean" }], deductions: [] }] };
}

const request: ScoreRequest = { taskType: "email", items: [{ itemId: emailId, text: "Dear Sir, I am writing to...", secondsUsed: 90 }] };

const PROVIDER_FIELDS = ["openaiJudgeProvider", "arbiterProvider", "fallbackFrom"];

function harness(jobId: string) {
  const repo = openSqliteStores();
  repo.createAttempt({ id: "att", kind: "writing", mode: "drill", setId: SET_ID, isRepeat: false });
  repo.createScoringJob({ id: jobId, attemptId: "att", taskType: "email", itemIds: [emailId] });
  const judgeEssay = vi.fn(async (judge: "gemini" | "openai") => ({ report: judgeReport(judge), provider: judge === "gemini" ? "gemini-http" as const : "codex" as const }));
  const aggregate = vi.fn(async (_input: AggregateInput, options?: AggregateOptions) => {
    options?.onEvent?.({ state: "fallback", provider: "codex", fallbackFrom: "claude", failureKind: "quota" });
    options?.onEvent?.({ state: "running", provider: "codex", fallbackFrom: "claude" });
    return { report, provider: "codex" as "claude" | "codex" };
  });
  const deps = { repo, judgeEssay, aggregate, judgeSpeaking: vi.fn(), aggregateSpeaking: vi.fn() };
  const progress = () => {
    const raw = repo.getScoringJob(jobId)!.progress;
    return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
  };
  return { repo, deps, aggregate, progress };
}

describe("a finished scoring job's progress", () => {
  it("names no provider once the job is done, and keeps which Judges finished", async () => {
    const h = harness("job-done");
    await runScoringJob(h.deps, "job-done", { attemptId: "att", set, request });

    expect(h.repo.getScoringJob("job-done")!.status).toBe("done");
    expect(h.progress()).toEqual({ judgesDone: expect.arrayContaining(["gemini", "openai"]), judgesFailed: [] });
  });

  it("names no provider once the job has failed", async () => {
    const h = harness("job-failed");
    h.aggregate.mockImplementationOnce(async (_input: AggregateInput, options?: AggregateOptions) => {
      options?.onEvent?.({ state: "running", provider: "claude" });
      throw new Error("arbiter unavailable");
    });
    await runScoringJob(h.deps, "job-failed", { attemptId: "att", set, request });

    expect(h.repo.getScoringJob("job-failed")!.status).toBe("failed");
    for (const field of PROVIDER_FIELDS) expect(h.progress()).not.toHaveProperty(field);
    expect(h.progress()).toHaveProperty("judgesDone");
  });

  it("names no provider once the job is cancelled", async () => {
    const h = harness("job-cancel");
    let running!: () => void;
    const started = new Promise<void>((resolve) => { running = resolve; });
    h.aggregate.mockImplementationOnce((_input: AggregateInput, options?: AggregateOptions) => {
      options?.onEvent?.({ state: "running", provider: "claude" });
      running();
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });
    const run = runScoringJob(h.deps, "job-cancel", { attemptId: "att", set, request });
    await started;
    expect(h.progress()).toMatchObject({ arbiterProvider: "claude" });

    h.repo.requestScoringJobCancellation({ id: "job-cancel", reason: "user", now: "2026-08-13 00:00:00" });
    abortScoringJob("job-cancel", "user");
    await run;

    expect(h.repo.getScoringJob("job-cancel")!.status).toBe("cancelled");
    for (const field of PROVIDER_FIELDS) expect(h.progress()).not.toHaveProperty(field);
  });

  it("is not rewritten by a superseded run that keeps reporting progress", async () => {
    const h = harness("job-old");
    let emit!: (event: Parameters<NonNullable<NonNullable<AggregateOptions>["onEvent"]>>[0]) => void;
    let finish!: () => void;
    const reached = new Promise<void>((resolve) => {
      h.aggregate.mockImplementationOnce(async (_input: AggregateInput, options?: AggregateOptions) => {
        emit = (event) => options?.onEvent?.(event);
        options?.onEvent?.({ state: "running", provider: "claude" });
        resolve();
        await new Promise<void>((done) => { finish = done; });
        return { report, provider: "claude" as const };
      });
    });
    const run = runScoringJob(h.deps, "job-old", { attemptId: "att", set, request });
    await reached;

    h.repo.replaceScoringJobAndSupersede({ id: "job-new", attemptId: "att", taskType: "email", itemIds: [emailId], now: "2026-08-13 00:00:00" });
    const settled = h.repo.getScoringJob("job-old")!;
    expect(settled.status).toBe("cancelled");
    for (const field of PROVIDER_FIELDS) expect(h.progress()).not.toHaveProperty(field);

    emit({ state: "fallback", provider: "codex", fallbackFrom: "claude", failureKind: "quota" });
    expect(h.repo.getScoringJob("job-old")).toMatchObject({ progress: settled.progress, stage: settled.stage });

    finish();
    await run;
  });
});
