import { describe, expect, it, vi } from "vitest";
import { readBankSet } from "./helpers/setFixtures.js";
import type { DeliveryReport, JudgeReport, ScoreReport } from "@toefl-prep/shared";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { openDb } from "../src/db/db.js";
import { sqliteTimestamp } from "../src/db/timestamps.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import { abortScoringJob, failInterruptedJobs } from "../src/services/scoringJobs.js";
import { resetTranscriptionCoordinatorsForNewProcess } from "../src/services/transcriptionRecovery.js";
import type { judgeSpeaking as realJudgeSpeaking } from "../src/services/judges/speaking.js";
import type { aggregateSpeaking as realAggregateSpeaking } from "../src/services/arbiter.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { at } from "./helpers/timestamps.js";

// A scoring job cancelled for any reason but supersession leaves its Items to nobody: the buffered
// Score Report is discarded and no replacement job covers them. They must end up failed and
// rescorable — never parked at 'pending', where no sweep, no Re-score button and no estimate sees
// them. Supersession is the one exception: its replacement scores the same Items.

const SPEAKING_SET_ID = "spk-e5b2b735";
const speakingSet = readBankSet("speaking", SPEAKING_SET_ID);
const [lr1, lr2] = speakingSet.listenAndRepeat.items;
const WRITING_SET_ID = "wri-77af733e";
const writingSet = readBankSet("writing", WRITING_SET_ID);

const deliveryReport: DeliveryReport = {
  paceWpm: 120, pauses: "none", intelligibility: "clear", suspectedMispronunciations: [], intonation: "natural",
};

function judgeReport(judge: "gemini" | "openai", itemIds: string[]): JudgeReport {
  return {
    judge, taskType: "listen_repeat",
    items: itemIds.map((itemId) => ({ itemId, score: 4, dimensions: [{ name: "accuracy", score: 4, evidence: "ok" }], deductions: [] })),
  };
}

function scoreReport(itemIds: string[]): ScoreReport {
  return {
    taskType: "listen_repeat",
    items: itemIds.map((itemId) => ({
      itemId, ownScore: 4, finalScore: 4, maxScore: 5 as const,
      dimensions: [{ name: "accuracy", note: "ok" }], deductions: [], reconciliationNote: "agreed", feedbackZh: "很好。",
    })),
  };
}

function setup(options: { hangJudges: boolean }) {
  const control = { ...options };
  resetTranscriptionCoordinatorsForNewProcess();
  const r = sqliteStores(openDb(":memory:"));
  let judgesStarted!: () => void;
  const started = new Promise<void>((resolve) => { judgesStarted = resolve; });
  const judgeSpeaking = vi.fn<typeof realJudgeSpeaking>(async (judge, input) => {
    judgesStarted();
    if (control.hangJudges) {
      const signal = input.signal!;
      await new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }
    return {
      report: judgeReport(judge, input.items.map((i) => i.itemId)),
      mode: "audio" as const,
      provider: judge === "gemini" ? ("gemini-http" as const) : ("openai-http" as const),
    };
  });
  const aggregateSpeaking = vi.fn<typeof realAggregateSpeaking>(async (input) => ({
    report: scoreReport(input.items.map((i) => i.itemId)),
    provider: "claude" as const,
  }));
  const coordinators = createSpeakingCoordinators({ repo: r, judgeSpeaking, aggregateSpeaking });
  const app = buildAttemptsRoutes({ repo: r, judgeSpeaking, aggregateSpeaking, ...coordinators });
  return { r, app, started, control, coordinators };
}

function seedSpokenItem(r: ReturnType<typeof sqliteStores>, attemptId: string, itemId: string, transcript: string): void {
  r.insertItemResult({
    attemptId, itemId, taskType: "listen_repeat",
    responseAudioPath: `audio/responses/${attemptId}/${itemId}.webm`,
    transcript, deliveryReport: JSON.stringify(deliveryReport),
  });
}

async function startScoring(app: ReturnType<typeof setup>["app"], attemptId: string): Promise<string> {
  const res = await app.request(`/${attemptId}/score`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskType: "listen_repeat", items: [{ itemId: lr1.id }, { itemId: lr2.id }] }),
  });
  expect(res.status).toBe(202);
  return ((await res.json()) as { jobId: string }).jobId;
}

function itemRow(r: ReturnType<typeof sqliteStores>, attemptId: string, itemId: string) {
  return r.getAttempt(attemptId)!.items.find((i) => i.item_id === itemId)!;
}

describe("a scoring job cancelled by something other than supersession", () => {
  it("leaves its Items failed and rescorable when a graceful shutdown cancels it mid-judging", async () => {
    const { r, app, started } = setup({ hangJudges: true });
    r.createAttempt({ id: "att-shutdown", kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    seedSpokenItem(r, "att-shutdown", lr1.id, "the words the user said");
    seedSpokenItem(r, "att-shutdown", lr2.id, "more words the user said");
    const jobId = await startScoring(app, "att-shutdown");
    await started;

    // What the shutdown protocol does: record the cancellation durably, then abort in-process work.
    r.requestScoringJobCancellation({ id: jobId, reason: "shutdown", now: sqliteTimestamp() });
    expect(abortScoringJob(jobId, "shutdown")).toBe(true);
    await vi.waitFor(() => expect(r.getScoringJob(jobId)?.status).toBe("cancelled"));

    for (const item of [lr1, lr2]) {
      const row = itemRow(r, "att-shutdown", item.id);
      expect(row.scoring_status).toBe("failed");
      expect(JSON.parse(row.score_json!)).toEqual({ error: "scoring interrupted" });
    }
  });

  it("leaves its Items failed and rescorable when the user cancels it", async () => {
    const { r, app, started } = setup({ hangJudges: true });
    r.createAttempt({ id: "att-user", kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    seedSpokenItem(r, "att-user", lr1.id, "the words the user said");
    seedSpokenItem(r, "att-user", lr2.id, "");
    const jobId = await startScoring(app, "att-user");
    await started;

    expect((await app.request(`/att-user/score-jobs/${jobId}/cancel`, { method: "POST" })).status).toBe(200);
    await vi.waitFor(() => expect(r.getScoringJob(jobId)?.status).toBe("cancelled"));

    const judged = itemRow(r, "att-user", lr1.id);
    expect(judged.scoring_status).toBe("failed");
    expect(JSON.parse(judged.score_json!)).toEqual({ error: "scoring cancelled" });
    // lr2's empty transcript is a no-speech Response. Its deterministic 0 was buffered with the rest
    // and discarded, and settling the cancelled job's Items applies the same rule again.
    expect(itemRow(r, "att-user", lr2.id)).toMatchObject({ scoring_status: "scored", score: 0 });
  });

  it("does not touch the Items of a job its replacement supersedes", async () => {
    const { r, app, started, control } = setup({ hangJudges: true });
    r.createAttempt({ id: "att-superseded", kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    seedSpokenItem(r, "att-superseded", lr1.id, "the words the user said");
    seedSpokenItem(r, "att-superseded", lr2.id, "more words the user said");
    const first = await startScoring(app, "att-superseded");
    await started;
    control.hangJudges = false;
    const second = await startScoring(app, "att-superseded");

    await vi.waitFor(() => expect(r.getScoringJob(second)?.status).toBe("done"));
    expect(r.getScoringJob(first)).toMatchObject({ status: "cancelled", cancellation_reason: "superseded" });
    for (const item of [lr1, lr2]) expect(itemRow(r, "att-superseded", item.id)).toMatchObject({ scoring_status: "scored", score: 4 });
  });
});

describe("boot recovery and reconciliation after a cancellation that settled before the restart", () => {
  function seedSettledCancellation(r: ReturnType<typeof sqliteStores>, jobId: string, attemptId: string, taskType: string, itemIds: string[]) {
    r.createScoringJob({ id: jobId, attemptId, taskType, itemIds });
    r.requestScoringJobCancellation({ id: jobId, reason: "shutdown", now: at("2026-08-23 16:30:10") });
    expect(r.finishScoringJobCancellation({ id: jobId, now: at("2026-08-23 16:30:11") })).toBe(true);
  }

  it("fails the still-pending Items of a shutdown-cancelled job at boot, with or without a transcript", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-boot-speaking", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedSpokenItem(r, "att-boot-speaking", lr1.id, "the words the user said");
    seedSettledCancellation(r, "job-boot-speaking", "att-boot-speaking", "listen_repeat", [lr1.id]);
    r.createAttempt({ id: "att-boot-writing", kind: "writing", mode: "drill", setId: WRITING_SET_ID, isRepeat: false });
    r.insertItemResult({ attemptId: "att-boot-writing", itemId: writingSet.email.id, taskType: "email", responseText: "Dear team," });
    seedSettledCancellation(r, "job-boot-writing", "att-boot-writing", "email", [writingSet.email.id]);

    failInterruptedJobs({ repo: r });

    expect(itemRow(r, "att-boot-speaking", lr1.id).scoring_status).toBe("failed");
    expect(itemRow(r, "att-boot-writing", writingSet.email.id).scoring_status).toBe("failed");
    // Idempotent: the second boot finds nothing pending to fail.
    expect(failInterruptedJobs({ repo: r }).items).toBe(0);
  });

  it("does not count a shutdown-cancelled job as coverage when a Simulation is reconciled", async () => {
    resetTranscriptionCoordinatorsForNewProcess();
    const r = sqliteStores(openDb(":memory:"));
    const { speakingFinalization } = createSpeakingCoordinators({ repo: r });
    r.createAttempt({ id: "att-reconcile", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedSpokenItem(r, "att-reconcile", lr1.id, "the words the user said");
    seedSettledCancellation(r, "job-reconcile", "att-reconcile", "listen_repeat", [lr1.id]);
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId: "att-reconcile", now: at("2026-08-23 16:30:00"), placeholders: [] });

    await speakingFinalization.reconcileAttempt("att-reconcile");

    expect(r.getAttempt("att-reconcile")!.status).toBe("completed");
    expect(itemRow(r, "att-reconcile", lr1.id).scoring_status).toBe("failed");
  });
});
