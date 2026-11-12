import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readBankSet } from "./helpers/setFixtures.js";
import type { ScoreReport } from "@toefl-prep/shared";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import {
  aggregate as realAggregate,
  type ArbitrationOptions,
} from "../src/services/arbiter.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";

const SET_ID = "wri-77af733e";
const fixture = readBankSet("writing", SET_ID);
const emailId = fixture.email.id;

function judgeReport(judge: "gemini" | "openai", score: number) {
  return {
    judge,
    taskType: "email" as const,
    items: [{
      itemId: emailId,
      score,
      dimensions: [{ name: "mechanics", score, evidence: "clean spelling" }],
      deductions: [],
    }],
  };
}

const routedReport: ScoreReport = {
  taskType: "email",
  items: [{
    itemId: emailId,
    ownScore: 4,
    finalScore: 4,
    maxScore: 5,
    dimensions: [{ name: "mechanics", note: "solid" }],
    deductions: [],
    reconciliationNote: "judges agreed closely",
    feedbackZh: "寫得不錯。",
  }],
};

describe("composed route -> scoreItems -> aggregate skill-facade path", () => {
  it("scores a writing email without changing the HTTP/result/persistence shape", async () => {
    const testRepo = sqliteStores(openDb(":memory:"));
    const judgeEssay = vi.fn(async (judge: "gemini" | "openai") =>
      judge === "gemini"
        ? {
            report: judgeReport("gemini", 4),
            provider: "gemini-http" as const,
          }
        : {
            report: judgeReport("openai", 3.5),
            provider: "codex" as const,
          });
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<ScoreReport>) => {
      request.onEvent?.({ state: "running", provider: "claude" });
      return {
        ok: true as const,
        value: request.parse({
          ...routedReport,
          items: routedReport.items.map((item) => ({
            ...item,
            modelRewrite: null,
          })),
        }),
        provider: "claude" as const,
        attempts: [],
      };
    });
    const aggregate = (
      input: Parameters<typeof realAggregate>[0],
      options?: ArbitrationOptions,
    ) => realAggregate(input, { ...options, runSkillTask });
    // The coordinators come from the composition point production uses. No coordinator acts on a
    // Writing Attempt, but hand-rolled wiring can drop a callback (such as the recovery re-drive in
    // `onScoringTerminal`) without any test noticing, and a test file is a template others copy.
    const app = buildAttemptsRoutes({
      repo: testRepo, judgeEssay, aggregate, ...createSpeakingCoordinators({ repo: testRepo }),
    });

    const createRes = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "writing", mode: "drill", setId: SET_ID }),
    });
    expect(createRes.status).toBe(201);
    const { attemptId } = (await createRes.json()) as { attemptId: string };

    const scoreRes = await app.request(`/${attemptId}/score`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskType: "email",
        items: [{ itemId: emailId, text: "Dear team, ...", secondsUsed: 200 }],
      }),
    });
    expect(scoreRes.status).toBe(202);
    const { jobId } = (await scoreRes.json()) as { jobId: string };

    let job!: {
      status: string;
      result?: {
        taskType: string;
        report: ScoreReport;
        judgesFailed: string[];
        provider?: string;
      };
    };
    await vi.waitFor(async () => {
      const response = await app.request(`/${attemptId}/score-jobs/${jobId}`);
      job = (await response.json()) as typeof job;
      if (job.status !== "done") throw new Error(`job not done: ${job.status}`);
    });

    expect(runSkillTask).toHaveBeenCalledTimes(1);
    expect(runSkillTask.mock.calls[0][0].task).toEqual({
      task: "aggregate",
      context: "email",
    });
    expect(runSkillTask.mock.calls[0][0].prompt).toMatch(/^\/toefl-writing\nAGGREGATE email/);

    const result = job.result!;
    expect(result.taskType).toBe("email");
    expect(result.report).toEqual(routedReport);
    expect(result.judgesFailed).toEqual([]);
    expect(result).not.toHaveProperty("provider");

    const item = testRepo.getAttempt(attemptId)?.items.find((row) => row.item_id === emailId);
    expect(item?.score).toBe(4);
    expect(item?.scoring_status).toBe("scored");
    expect(testRepo.getJudgeReports(attemptId)).toHaveLength(2);
  });
});
