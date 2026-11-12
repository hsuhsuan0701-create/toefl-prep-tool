import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readBankSet } from "./helpers/setFixtures.js";
import type { DeliveryReport, JudgeReport, ScoreReport } from "@toefl-prep/shared";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { openDb } from "../src/db/db.js";
import { aggregate as realAggregate, aggregateSpeaking as realAggregateSpeaking } from "../src/services/arbiter.js";
import type { judgeEssay as realJudgeEssay } from "../src/services/judges/index.js";
import type { judgeSpeaking as realJudgeSpeaking } from "../src/services/judges/speaking.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// What an Arbiter result may write, through the real route and the real job runner over an
// in-memory database. Judges are fakes; the Arbiter is the real aggregate/aggregateSpeaking with
// only its reasoning call (runSkillTask) replaced, so the checks under test are the shipped ones.

const WRITING_SET_ID = "wri-77af733e";
const SPEAKING_SET_ID = "spk-e5b2b735";
const writing = readBankSet("writing", WRITING_SET_ID);
const speaking = readBankSet("speaking", SPEAKING_SET_ID);
const emailId = writing.email.id;
const lrIds = speaking.listenAndRepeat.items.map((i) => i.id);

const deliveryReport: DeliveryReport = {
  paceWpm: 140, pauses: "none", intelligibility: "clear", suspectedMispronunciations: [], intonation: "flat",
};

function judgeReport(judge: "gemini" | "openai", taskType: JudgeReport["taskType"], itemIds: string[], score = 4): JudgeReport {
  return {
    judge, taskType,
    items: itemIds.map((itemId) => ({ itemId, score, dimensions: [{ name: "d", score, evidence: "e" }], deductions: [] })),
  };
}

function scoreReport(taskType: ScoreReport["taskType"], itemIds: string[], finalScore = 4): ScoreReport {
  return {
    taskType,
    items: itemIds.map((itemId) => ({
      itemId, ownScore: finalScore, finalScore, maxScore: 5,
      dimensions: [{ name: "d", note: "n" }], deductions: [], reconciliationNote: "r", feedbackZh: "好。",
    })),
  };
}

// The real Arbiter, answering with `value` (or failing with `error`) instead of calling a CLI.
function arbiterAnswering(outcome: { value: ScoreReport } | { error: string }) {
  const runSkillTask = async () => ("value" in outcome
    ? { ok: true as const, value: outcome.value, provider: "claude" as const, attempts: [] }
    : { ok: false as const, error: outcome.error, failureKind: "unavailable", attempts: [] }) as never;
  return {
    aggregate: vi.fn<typeof realAggregate>((input, opts) => realAggregate(input, { ...opts, runSkillTask })),
    aggregateSpeaking: vi.fn<typeof realAggregateSpeaking>((input, opts) => realAggregateSpeaking(input, { ...opts, runSkillTask })),
  };
}

function harness(arbiter: ReturnType<typeof arbiterAnswering>) {
  const repo = sqliteStores(openDb(":memory:"));
  const judgeEssay = vi.fn<typeof realJudgeEssay>(async (judge) => ({
    report: judgeReport(judge, "email", [emailId]),
    provider: judge === "gemini" ? "gemini-http" : "openai-http",
  }) as never);
  const judgeSpeaking = vi.fn<typeof realJudgeSpeaking>(async (judge) => ({
    report: judgeReport(judge, "listen_repeat", lrIds),
    mode: "audio",
    provider: judge === "gemini" ? "gemini-http" : "openai-http",
  }) as never);
  const scoreDeps = { repo, judgeEssay, judgeSpeaking, ...arbiter };
  const coordinators = createSpeakingCoordinators({ ...scoreDeps, hearRecording: vi.fn() });
  const app = buildAttemptsRoutes({ ...scoreDeps, ...coordinators });
  return { repo, app };
}

async function createAttempt(app: ReturnType<typeof buildAttemptsRoutes>, kind: "writing" | "speaking", setId: string) {
  const res = await app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, mode: "drill", setId }),
  });
  return ((await res.json()) as { attemptId: string }).attemptId;
}

// A transcribed Listen and Repeat take for every Item, as the upload endpoint leaves it.
function seedTranscribedTakes(repo: ReturnType<typeof sqliteStores>, attemptId: string) {
  for (const itemId of lrIds) {
    repo.insertItemResult({
      attemptId, itemId, taskType: "listen_repeat",
      responseAudioPath: `audio/responses/${attemptId}/${itemId}.webm`,
      transcript: "we open the front desk at six",
      deliveryReport: JSON.stringify(deliveryReport),
    });
  }
}

async function scoreToTerminal(app: ReturnType<typeof buildAttemptsRoutes>, attemptId: string, request: unknown) {
  const res = await app.request(`/${attemptId}/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  expect(res.status).toBe(202);
  const { jobId } = (await res.json()) as { jobId: string };
  let job!: { status: string; error?: string };
  await vi.waitFor(async () => {
    job = await (await app.request(`/${attemptId}/score-jobs/${jobId}`)).json() as typeof job;
    if (!["done", "failed", "superseded", "cancelled"].includes(job.status)) throw new Error(job.status);
  }, { timeout: 2000, interval: 5 });
  return job;
}

const listenRepeatRequest = { taskType: "listen_repeat", items: lrIds.map((itemId) => ({ itemId })) };
const emailRequest = { taskType: "email", items: [{ itemId: emailId, text: "Dear team, ...", secondsUsed: 200 }] };

describe("Arbiter output is accepted only for the requested Items", () => {
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorLog.mockRestore();
  });

  it("an Item id nobody asked for fails the arbitration and writes nothing under that id", async () => {
    const h = harness(arbiterAnswering({ value: scoreReport("listen_repeat", [...lrIds, "lr-intruder"]) }));
    const attemptId = await createAttempt(h.app, "speaking", SPEAKING_SET_ID);
    seedTranscribedTakes(h.repo, attemptId);

    const job = await scoreToTerminal(h.app, attemptId, listenRepeatRequest);

    expect(job.status).toBe("failed");
    const rows = h.repo.getAttempt(attemptId)!.items;
    expect(rows.map((r) => r.item_id)).not.toContain("lr-intruder");
    for (const row of rows) {
      expect(row.scoring_status).toBe("failed");
      expect(row.score).toBeNull();
    }
  });

  it("a requested Item reported twice fails the arbitration instead of letting the later copy win", async () => {
    const report = scoreReport("listen_repeat", lrIds, 4);
    report.items.push({ ...report.items[0], ownScore: 1, finalScore: 1 });
    const h = harness(arbiterAnswering({ value: report }));
    const attemptId = await createAttempt(h.app, "speaking", SPEAKING_SET_ID);
    seedTranscribedTakes(h.repo, attemptId);

    const job = await scoreToTerminal(h.app, attemptId, listenRepeatRequest);

    expect(job.status).toBe("failed");
    expect(h.repo.getAttempt(attemptId)!.items.every((r) => r.scoring_status === "failed" && r.score === null)).toBe(true);
  });

  it("an essay arbitration answering for a different Item fails instead of scoring the essay", async () => {
    const h = harness(arbiterAnswering({ value: scoreReport("email", ["email-someone-else"]) }));
    const attemptId = await createAttempt(h.app, "writing", WRITING_SET_ID);

    const job = await scoreToTerminal(h.app, attemptId, emailRequest);

    expect(job.status).toBe("failed");
    const row = h.repo.getAttempt(attemptId)!.items.find((r) => r.item_id === emailId)!;
    expect(row.scoring_status).toBe("failed");
    expect(row.score).toBeNull();
  });
});

describe("an Arbiter failure leaves no provider name in score-bearing state", () => {
  let errorLog: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorLog.mockRestore();
  });

  const routeFailure = { error: "Structured reasoning unavailable: Claude (quota) → Codex (timeout)." };

  it.each([
    ["essay", "writing", WRITING_SET_ID, emailRequest],
    ["speaking", "speaking", SPEAKING_SET_ID, listenRepeatRequest],
  ] as const)("%s: score_json and the job error both read 'arbitration failed'", async (_label, kind, setId, request) => {
    const h = harness(arbiterAnswering(routeFailure));
    const attemptId = await createAttempt(h.app, kind, setId);
    if (kind === "speaking") seedTranscribedTakes(h.repo, attemptId);

    const job = await scoreToTerminal(h.app, attemptId, request);

    expect(job.status).toBe("failed");
    expect(job.error).toBe("arbitration failed");
    const rows = h.repo.getAttempt(attemptId)!.items;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.scoring_status).toBe("failed");
      expect(JSON.parse(row.score_json!)).toEqual({ error: "arbitration failed" });
    }
    const persisted = JSON.stringify({ rows, job });
    expect(persisted).not.toMatch(/claude|codex/i);
  });
});
