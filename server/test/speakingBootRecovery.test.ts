import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBankSet } from "./helpers/setFixtures.js";
import type { DeliveryReport, JudgeReport, ScoreReport } from "@toefl-prep/shared";
import { runAllBootRecovery } from "../src/index.js";
import { openDb } from "../src/db/db.js";
import { config } from "../src/lib/config.js";
import { sqliteTimestamp } from "../src/db/timestamps.js";
import { computeSectionEstimate } from "../src/services/sectionEstimates.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import {
  INTERRUPTED_BY_RESTART_ERROR,
  resetTranscriptionCoordinatorsForNewProcess,
} from "../src/services/transcriptionRecovery.js";
import type { hearRecording as realHearRecording } from "../src/services/ears.js";
import type { judgeSpeaking as realJudgeSpeaking } from "../src/services/judges/speaking.js";
import type { aggregateSpeaking as realAggregateSpeaking } from "../src/services/arbiter.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { at } from "./helpers/timestamps.js";

// What a restart does with the speaking and scoring work the previous process left behind. Boot
// recovery spends nothing — no Ears, no Judge, no Arbiter — so every stranded piece of work must end
// either finished for free (a reconciled Attempt, a recomputed estimate, a no-speech 0) or in a state
// the User can act on (a failed Item with Re-score, a failed transcription with Retry).

const SPEAKING_SET_ID = "spk-e5b2b735";
const speakingSet = readBankSet("speaking", SPEAKING_SET_ID);
const lrIds = speakingSet.listenAndRepeat.items.map((i) => i.id);
const intIds = speakingSet.interview.questions.map((q) => q.id);
const WRITING_SET_ID = "wri-77af733e";
const writingSet = readBankSet("writing", WRITING_SET_ID);

const deliveryReport: DeliveryReport = {
  paceWpm: 120, pauses: "none", intelligibility: "clear", suspectedMispronunciations: [], intonation: "natural",
};

let createdResponseDirs: string[] = [];
afterEach(() => {
  for (const dir of createdResponseDirs) fs.rmSync(dir, { recursive: true, force: true });
  createdResponseDirs = [];
});

function writeRecording(attemptId: string, itemId: string): { rel: string; sha: string } {
  const rel = path.join("audio/responses", attemptId, `${itemId}.webm`);
  const abs = path.join(config.dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(`recording of ${attemptId}/${itemId}`));
  createdResponseDirs.push(path.dirname(abs));
  return { rel, sha: crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex") };
}

function judgeReport(judge: "gemini" | "openai", itemIds: string[], taskType: "listen_repeat" | "interview"): JudgeReport {
  return {
    judge, taskType,
    items: itemIds.map((itemId) => ({ itemId, score: 4, dimensions: [{ name: "accuracy", score: 4, evidence: "ok" }], deductions: [] })),
  };
}

function scoreReport(itemIds: string[], taskType: "listen_repeat" | "interview"): ScoreReport {
  return {
    taskType,
    items: itemIds.map((itemId) => ({
      itemId, ownScore: 4, finalScore: 4, maxScore: 5 as const,
      dimensions: [{ name: "accuracy", note: "ok" }], deductions: [], reconciliationNote: "agreed", feedbackZh: "很好。",
    })),
  };
}

function setup() {
  resetTranscriptionCoordinatorsForNewProcess();
  const r = sqliteStores(openDb(":memory:"));
  const hearRecording = vi.fn<typeof realHearRecording>();
  const judgeSpeaking = vi.fn<typeof realJudgeSpeaking>();
  const aggregateSpeaking = vi.fn<typeof realAggregateSpeaking>();
  const judgeEssay = vi.fn();
  const aggregate = vi.fn();
  const coordinators = createSpeakingCoordinators({ repo: r, hearRecording, judgeSpeaking, aggregateSpeaking, judgeEssay, aggregate });
  const runDueAndReconcile = vi.spyOn(coordinators.transcriptionRecovery, "runDueAndReconcile");
  const paidSeams = [hearRecording, judgeSpeaking, aggregateSpeaking, judgeEssay, aggregate, runDueAndReconcile];
  async function boot() {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await runAllBootRecovery(r, coordinators);
    } finally {
      logSpy.mockRestore();
    }
    for (const seam of paidSeams) expect(seam).not.toHaveBeenCalled();
  }
  return { r, coordinators, boot, hearRecording, judgeSpeaking, aggregateSpeaking };
}

type Stores = ReturnType<typeof sqliteStores>;

function seedScored(r: Stores, attemptId: string, itemId: string, taskType: string, score: number): void {
  r.insertItemResult({
    attemptId, itemId, taskType,
    responseAudioPath: `audio/responses/${attemptId}/${itemId}.webm`,
    transcript: "the words the user said", deliveryReport: JSON.stringify(deliveryReport),
  });
  r.updateItemScore({ attemptId, itemId, score, scoreJson: JSON.stringify({ finalScore: score }), scoringStatus: "scored" });
}

function seedTranscribed(r: Stores, attemptId: string, itemId: string, taskType: string, transcript: string): void {
  r.insertItemResult({
    attemptId, itemId, taskType,
    responseAudioPath: `audio/responses/${attemptId}/${itemId}.webm`,
    transcript, deliveryReport: JSON.stringify(deliveryReport),
  });
}

function itemRow(r: Stores, attemptId: string, itemId: string) {
  return r.getAttempt(attemptId)!.items.find((i) => i.item_id === itemId)!;
}

// What recomputeSectionEstimate leaves for the Attempt as it stands: the row for the band its scored
// Items give, or no row at all when the band rule withholds one (an unscored Item, or a Task Type
// of the section with no Item).
function expectedEstimate(r: Stores, attemptId: string) {
  const attempt = r.getAttempt(attemptId)!;
  const result = computeSectionEstimate(attempt);
  if (result.status !== "estimated") return undefined;
  const { section, raw, coverage, band, method } = result.estimate;
  return {
    section, rawDetail: JSON.stringify({ raw, coverage }), estimatedBand: band, method, modulePath: attempt.module_path ?? null,
    // getSectionEstimate reads the Attempt's current Items back with the row, for the band rule.
    items: attempt.items.map(({ task_type, score, scoring_status, score_json }) => ({ task_type, score, scoring_status, score_json })),
  };
}

const STALE_ESTIMATE = { section: "speaking", rawDetail: JSON.stringify({ raw: 0, coverage: [] }), estimatedBand: 1, method: "linear-v2" };

describe("boot recovery", () => {
  it("recomputes the estimate of a completed Attempt whose Items it resolved", async () => {
    const { r, boot } = setup();
    // A completed Speaking Simulation whose Interview re-score was interrupted by the restart.
    r.createAttempt({ id: "att-a3-speaking", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    for (const id of lrIds) seedScored(r, "att-a3-speaking", id, "listen_repeat", 4);
    for (const id of intIds.slice(0, 3)) seedScored(r, "att-a3-speaking", id, "interview", 3);
    seedTranscribed(r, "att-a3-speaking", intIds[3], "interview", "an answer the judges never finished");
    r.createScoringJob({ id: "job-a3-speaking", attemptId: "att-a3-speaking", taskType: "interview", itemIds: [intIds[3]] });
    r.seedScoringJobState({ id: "job-a3-speaking", status: "running" });
    r.completeAttempt("att-a3-speaking", at("2026-08-23 16:30:04"));
    r.saveSectionEstimate({ attemptId: "att-a3-speaking", ...STALE_ESTIMATE });

    // A completed Writing Simulation whose essay job was interrupted the same way.
    r.createAttempt({ id: "att-a3-writing", kind: "writing", mode: "simulation", setId: WRITING_SET_ID, isRepeat: false });
    for (const item of writingSet.buildASentence.items) {
      r.insertItemResult({ attemptId: "att-a3-writing", itemId: item.id, taskType: "build_sentence", responseText: "[]" });
      r.updateItemScore({ attemptId: "att-a3-writing", itemId: item.id, score: 1, scoreJson: "{}", scoringStatus: "scored" });
    }
    r.insertItemResult({ attemptId: "att-a3-writing", itemId: writingSet.email.id, taskType: "email", responseText: "Dear team," });
    r.createScoringJob({ id: "job-a3-writing", attemptId: "att-a3-writing", taskType: "email", itemIds: [writingSet.email.id] });
    r.completeAttempt("att-a3-writing", at("2026-08-23 16:30:04"));
    const writingBefore = { ...STALE_ESTIMATE, section: "writing" };
    r.saveSectionEstimate({ attemptId: "att-a3-writing", ...writingBefore });

    await boot();

    expect(itemRow(r, "att-a3-speaking", intIds[3]).scoring_status).toBe("failed");
    expect(r.getSectionEstimate("att-a3-speaking")).toEqual(expectedEstimate(r, "att-a3-speaking"));
    expect(r.getSectionEstimate("att-a3-speaking")).not.toEqual(STALE_ESTIMATE);
    expect(itemRow(r, "att-a3-writing", writingSet.email.id).scoring_status).toBe("failed");
    expect(r.getSectionEstimate("att-a3-writing")).toEqual(expectedEstimate(r, "att-a3-writing"));
  });

  it("completes a capture-finished Speaking Simulation the restart left in progress", async () => {
    const { r, boot } = setup();
    r.createAttempt({ id: "att-capture", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    for (const id of lrIds) seedScored(r, "att-capture", id, "listen_repeat", 4);
    for (const id of intIds) seedScored(r, "att-capture", id, "interview", 3);
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId: "att-capture", now: at("2026-08-23 16:30:00"), placeholders: [] });

    await boot();

    expect(r.getAttempt("att-capture")!.status).toBe("completed");
    expect(r.getSectionEstimate("att-capture")).toEqual(expectedEstimate(r, "att-capture"));
  });

  it("fails queued and waiting transcriptions with a Retry the User can press, and hands no recording to Ears", async () => {
    const { r, coordinators, boot } = setup();
    r.createAttempt({ id: "att-tx", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    const jobs: string[] = [];
    for (const [index, itemId] of lrIds.slice(0, 2).entries()) {
      const { rel, sha } = writeRecording("att-tx", itemId);
      r.insertItemResult({ attemptId: "att-tx", itemId, taskType: "listen_repeat", responseAudioPath: rel, scoringStatus: "transcription_pending" });
      const job = r.createOrGetTranscriptionJob({
        id: `tj-${itemId}`, attemptId: "att-tx", itemId, taskType: "listen_repeat", audioPath: rel, audioSha256: sha, now: sqliteTimestamp(),
      });
      if (index === 1) {
        r.updateTranscriptionJob({
          id: job.id, status: "retry_wait", automaticAttempts: 1, failureKind: "network",
          nextRetryAt: sqliteTimestamp(new Date(Date.now() + 60_000)), now: sqliteTimestamp(),
        });
      }
      jobs.push(job.id);
    }

    await boot();

    for (const jobId of jobs) {
      const job = r.getTranscriptionJob(jobId)!;
      expect(job).toMatchObject({ status: "failed", failure_kind: "provider", error: INTERRUPTED_BY_RESTART_ERROR, next_retry_at: null });
    }
    expect(coordinators.transcriptionRecovery.readAttemptSnapshot("att-tx").get(lrIds[0])?.status).toBe("failed");
    expect(itemRow(r, "att-tx", lrIds[0]).scoring_status).toBe("transcription_pending");
  });

  it("closes a recovered transcript's handoff without scoring it: the Item becomes rescorable, or a no-speech 0", async () => {
    const { r, boot } = setup();
    r.createAttempt({ id: "att-handoff", kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    for (const [itemId, transcript] of [[lrIds[0], "a recovered transcript"], [lrIds[1], " "]] as const) {
      const { rel, sha } = writeRecording("att-handoff", itemId);
      r.insertItemResult({ attemptId: "att-handoff", itemId, taskType: "listen_repeat", responseAudioPath: rel, scoringStatus: "transcription_pending" });
      const job = r.createOrGetTranscriptionJob({
        id: `tj-${itemId}`, attemptId: "att-handoff", itemId, taskType: "listen_repeat", audioPath: rel, audioSha256: sha, now: sqliteTimestamp(),
      });
      r.claimTranscriptionJob({ id: job.id, now: sqliteTimestamp() });
      expect(r.persistRecoveredTranscriptAndAwaitScore({
        jobId: job.id, attemptId: "att-handoff", itemId, audioPath: rel, audioSha256: sha,
        transcript, deliveryReport: JSON.stringify(deliveryReport), now: sqliteTimestamp(),
      })).toBe(true);
    }

    await boot();

    expect(r.listAllScoringJobs()).toEqual([]);
    for (const itemId of lrIds.slice(0, 2)) expect(r.getTranscriptionJob(`tj-${itemId}`)).toMatchObject({ status: "done", score_job_id: null });
    const judgeable = itemRow(r, "att-handoff", lrIds[0]);
    expect(judgeable.scoring_status).toBe("failed");
    expect(JSON.parse(judgeable.score_json!)).toEqual({ error: "scoring interrupted" });
    expect(itemRow(r, "att-handoff", lrIds[1])).toMatchObject({ scoring_status: "scored", score: 0 });
  });

  it("scores a silent Item left failed its deterministic 0 and refreshes the estimate, and leaves a lost upload's placeholder alone", async () => {
    const { r, boot } = setup();
    r.createAttempt({ id: "att-legacy", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    for (const id of lrIds.slice(0, 5)) seedScored(r, "att-legacy", id, "listen_repeat", 4);
    for (const id of intIds) seedScored(r, "att-legacy", id, "interview", 3);
    seedTranscribed(r, "att-legacy", lrIds[5], "listen_repeat", "");
    r.updateItemScore({
      attemptId: "att-legacy", itemId: lrIds[5], score: null,
      scoreJson: JSON.stringify({ error: "scoring request did not arrive" }), scoringStatus: "failed",
    });
    r.markCaptureFinishedWithMissingItemPlaceholders({
      attemptId: "att-legacy", now: at("2026-08-11 14:32:40"),
      placeholders: [{ itemId: lrIds[6], taskType: "listen_repeat", scoreJson: JSON.stringify({ error: "recording upload did not arrive" }), scoringStatus: "failed" }],
    });
    r.completeAttempt("att-legacy", at("2026-08-11 14:35:33"));
    r.saveSectionEstimate({ attemptId: "att-legacy", ...STALE_ESTIMATE });

    await boot();

    const healed = itemRow(r, "att-legacy", lrIds[5]);
    expect(healed).toMatchObject({ scoring_status: "scored", score: 0 });
    expect(JSON.parse(healed.score_json!)).toMatchObject({ noSpeechDetected: true, meta: { target: speakingSet.listenAndRepeat.items[5].sentence } });
    expect(itemRow(r, "att-legacy", lrIds[6])).toMatchObject({ scoring_status: "failed", transcript: null });
    expect(r.getSectionEstimate("att-legacy")).toEqual(expectedEstimate(r, "att-legacy"));
  });

  it("gives a saved recording that never got a transcription job a Retry that transcribes and scores it", async () => {
    const { r, coordinators, boot, hearRecording, judgeSpeaking, aggregateSpeaking } = setup();
    r.createAttempt({ id: "att-b9", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    const { rel } = writeRecording("att-b9", lrIds[0]);
    r.insertItemResult({ attemptId: "att-b9", itemId: lrIds[0], taskType: "listen_repeat", responseAudioPath: rel, scoringStatus: "transcription_pending" });
    // The same shape, but the recording itself is gone from disk.
    r.insertItemResult({
      attemptId: "att-b9", itemId: lrIds[1], taskType: "listen_repeat",
      responseAudioPath: `audio/responses/att-b9/${lrIds[1]}.webm`, scoringStatus: "transcription_pending",
    });
    for (const id of lrIds.slice(2)) seedScored(r, "att-b9", id, "listen_repeat", 4);
    for (const id of intIds) seedScored(r, "att-b9", id, "interview", 3);
    r.completeAttempt("att-b9", at("2026-07-30 07:10:00"));
    // Nothing score-bearing changes for this Attempt, so its estimate keeps the method it was
    // computed under rather than being recomputed by the boot reconcile.
    const historical = { section: "speaking", rawDetail: JSON.stringify({ raw: 0.6, coverage: [] }), estimatedBand: 4, method: "linear-v1" };
    r.saveSectionEstimate({ attemptId: "att-b9", ...historical });

    await boot();

    expect(r.getSectionEstimate("att-b9")).toMatchObject({ ...historical, modulePath: null });

    const job = coordinators.transcriptionRecovery.readAttemptSnapshot("att-b9").get(lrIds[0]);
    expect(job).toMatchObject({ status: "failed", failureKind: "provider" });
    expect(itemRow(r, "att-b9", lrIds[0]).scoring_status).toBe("transcription_pending");
    const missing = itemRow(r, "att-b9", lrIds[1]);
    expect(missing.scoring_status).toBe("failed");
    expect(JSON.parse(missing.score_json!)).toEqual({ error: "recording is missing" });

    hearRecording.mockResolvedValue({ transcript: "transcribed at last", deliveryReport });
    judgeSpeaking.mockImplementation(async (judge, input) => ({
      report: judgeReport(judge, input.items.map((i) => i.itemId), input.taskType),
      mode: "audio" as const, provider: judge === "gemini" ? ("gemini-http" as const) : ("openai-http" as const),
    }));
    aggregateSpeaking.mockImplementation(async (input) => ({ report: scoreReport(input.items.map((i) => i.itemId), input.taskType), provider: "claude" as const }));
    await coordinators.transcriptionRecovery.retry(job!.jobId);

    expect(hearRecording).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(itemRow(r, "att-b9", lrIds[0])).toMatchObject({ scoring_status: "scored", score: 4 }));
  });

  it("is idempotent: a second boot changes nothing the first one settled", async () => {
    const { r, boot } = setup();
    r.createAttempt({ id: "att-idem", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedTranscribed(r, "att-idem", lrIds[0], "listen_repeat", "");
    seedTranscribed(r, "att-idem", lrIds[1], "listen_repeat", "words");
    const { rel } = writeRecording("att-idem", lrIds[2]);
    r.insertItemResult({ attemptId: "att-idem", itemId: lrIds[2], taskType: "listen_repeat", responseAudioPath: rel, scoringStatus: "transcription_pending" });
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId: "att-idem", now: at("2026-08-23 16:30:00"), placeholders: [] });

    await boot();
    const snapshot = { attempt: r.getAttempt("att-idem"), jobs: r.getCurrentTranscriptionJobs("att-idem"), estimate: r.getSectionEstimate("att-idem") };
    await boot();

    expect({ attempt: r.getAttempt("att-idem"), jobs: r.getCurrentTranscriptionJobs("att-idem"), estimate: r.getSectionEstimate("att-idem") }).toEqual(snapshot);
  });
});
