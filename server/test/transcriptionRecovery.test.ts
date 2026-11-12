import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBankSet } from "./helpers/setFixtures.js";
import { useFakeTimersInTest } from "./helpers/fakeTimers.js";
import type { DeliveryReport, JudgeReport, ScoreReport, TranscriptionFailureKind } from "@toefl-prep/shared";
import {
  isTerminalTranscriptionFailure,
  terminalTranscriptionMessage,
} from "../../client/src/lib/transcriptionFailure.js";
import { openSqliteStores } from "./helpers/sqliteStores.js";
import { at } from "./helpers/timestamps.js";
import type { SqliteTimestamp } from "../src/db/timestamps.js";
import { config } from "../src/lib/config.js";
import {
  createTranscriptionRecovery,
  failInterruptedTranscriptionJobs,
  INTERRUPTED_BY_RESTART_ERROR,
  resetTranscriptionCoordinatorsForNewProcess,
  TranscriptionAdmissionSuperseded,
  TranscriptionJobNotRetryable,
  wireTranscriptionInterruptionSweep,
  type AdmitRecordingResult,
  type TranscriptionRecoveryDeps,
} from "../src/services/transcriptionRecovery.js";
import { EarsError, hearRecording as callEars, type hearRecording as realHearRecording } from "../src/services/ears.js";
import type { aggregateSpeaking as realAggregateSpeaking } from "../src/services/arbiter.js";
import type { judgeSpeaking as realJudgeSpeaking } from "../src/services/judges/speaking.js";
import { setStore as realSetStore } from "../src/services/setStore.js";
import { fakeMedia } from "./helpers/fakeMedia.js";

type AggregateSpeakingInput = Parameters<typeof realAggregateSpeaking>[0];

// A banked Speaking Set: a retry rebuilds the Item's Ears context from the Set, not from a
// caller-supplied value, and a scoring handoff reads the Set too, so the Item ids must exist in a
// real one.
const SPEAKING_SET_ID = "spk-e5b2b735";
const speakingSet = readBankSet("speaking", SPEAKING_SET_ID);
const lr1Id = speakingSet.listenAndRepeat.items[0].id;
const int1Id = speakingSet.interview.questions[0].id;

const FIXTURE_WEBM = fs.readFileSync(path.join(import.meta.dirname, "fixtures/tiny.webm"));

const flatDeliveryReport: DeliveryReport = {
  paceWpm: 140,
  pauses: "no notable pauses",
  intelligibility: "clear throughout",
  suspectedMispronunciations: [],
  intonation: "flat",
};

function canonicalPath(attemptId: string, itemId: string): { abs: string; rel: string } {
  const rel = path.join("audio/responses", attemptId, `${itemId}.webm`);
  return { abs: path.join(config.dataDir, rel), rel };
}

let createdResponseDirs: string[] = [];

function writeRecording(attemptId: string, itemId: string, bytes: Buffer = FIXTURE_WEBM): string {
  const { abs, rel } = canonicalPath(attemptId, itemId);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, bytes);
  createdResponseDirs.push(path.join(config.dataDir, "audio/responses", attemptId));
  return rel;
}

function sha256Of(absPath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
}

afterEach(() => {
  for (const dir of createdResponseDirs) fs.rmSync(dir, { recursive: true, force: true });
  createdResponseDirs = [];
});

function makeSpeakingJudgeReport(taskType: "listen_repeat" | "interview", itemId: string, judgeName: "gemini" | "openai", score = 4): JudgeReport {
  return {
    judge: judgeName, taskType,
    items: [{ itemId, score, dimensions: [{ name: "intelligibility", score, evidence: "clear audio" }], deductions: [] }],
  };
}

function makeSpeakingScoreReport(taskType: "listen_repeat" | "interview", itemId: string, finalScore = 4): ScoreReport {
  return {
    taskType,
    items: [{
      itemId, ownScore: finalScore, finalScore, maxScore: 5,
      dimensions: [{ name: "intelligibility", note: "ok" }],
      deductions: [], reconciliationNote: "agreed", feedbackZh: "表現不錯。",
    }],
  };
}

function mockJudgesSucceed(
  ctx: { judgeSpeaking: ReturnType<typeof vi.fn>; aggregateSpeaking: ReturnType<typeof vi.fn> },
  taskType: "listen_repeat" | "interview",
  itemId: string,
): void {
  ctx.judgeSpeaking.mockImplementation(async (judgeName: "gemini" | "openai") => ({
    report: makeSpeakingJudgeReport(taskType, itemId, judgeName),
    mode: "audio" as const,
    provider: judgeName === "gemini" ? ("gemini-http" as const) : ("openai-http" as const),
  }));
  ctx.aggregateSpeaking.mockImplementation(async (_input: AggregateSpeakingInput) => ({
    report: makeSpeakingScoreReport(taskType, itemId),
    provider: "claude" as const,
  }));
}

const T0 = new Date("2026-07-30T00:00:00.000Z");

// The real SQLite stores over a private in-memory database: the coordinator's create-or-reuse, its
// claim, its two transactional persist writers and its scoring hand-off all run the statements
// production runs.
function buildHarness(overrides: Partial<TranscriptionRecoveryDeps> = {}) {
  const testRepo = openSqliteStores();
  const hearRecording = vi.fn<typeof realHearRecording>();
  const judgeSpeaking = vi.fn<typeof realJudgeSpeaking>();
  const aggregateSpeaking = vi.fn<typeof realAggregateSpeaking>();
  let currentTime = new Date(T0.getTime());
  const now = () => currentTime;
  const advance = (ms: number) => {
    currentTime = new Date(currentTime.getTime() + ms);
  };
  const recovery = createTranscriptionRecovery({
    repo: testRepo,
    hearRecording,
    judgeSpeaking,
    aggregateSpeaking,
    // In-process ffprobe for the interview scoring a recovered item hands off to.
    probeDurationSec: fakeMedia.probeDurationSec,
    now,
    // A no-op unless a test asks otherwise. The module's default re-drives runDueAndReconcile,
    // un-awaited, whenever a recovered Item's scoring job ends, and that detached pass can still be
    // running after its test has finished. The one test that exercises the re-drive passes
    // `onScoringTerminal: undefined` to get the module's default back.
    onScoringTerminal: () => {},
    ...overrides,
  });
  return { recovery, repo: testRepo, hearRecording, judgeSpeaking, aggregateSpeaking, now, advance };
}

function expectAccepted(result: AdmitRecordingResult): Extract<AdmitRecordingResult, { kind: "accepted" }> {
  if (result.kind !== "accepted") throw new Error(`expected 'accepted', got ${JSON.stringify(result)}`);
  return result;
}

describe("admitRecording", () => {
  it("aborts an active Ears call when execution ownership is lost and performs no post-expiry transcript write", async () => {
    let ready = true;
    const { recovery, repo: r, hearRecording } = buildHarness({ admissionReady: () => ready });
    const attemptId = "att-lease-loss";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => { started = resolve; });
    hearRecording.mockImplementation(async (input: { signal?: AbortSignal }) => {
      started();
      return new Promise<never>((_resolve, reject) => input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true }));
    });

    const admission = recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" });
    await inFlight;
    ready = false;
    recovery.abortActive?.();
    await expect(admission).rejects.toThrow("execution ownership unavailable");
    expect(r.getAttempt(attemptId)?.items[0]).toMatchObject({ transcript: null, scoring_status: "transcription_pending" });
    expect(r.getCurrentTranscriptionJobs(attemptId)[0]?.status).toBe("running");
  });

  it("immediate success stores transcript/report on item_results and returns {kind:'transcribed', transcript, deliveryReport}", async () => {
    const { recovery, repo: r, hearRecording } = buildHarness();
    const attemptId = "att-immediate-success";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockResolvedValue({ transcript: "hello world", deliveryReport: flatDeliveryReport });

    const result = await recovery.admitRecording({
      attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx",
    });
    expect(result).toEqual({ kind: "transcribed", transcript: "hello world", deliveryReport: flatDeliveryReport });

    const item = r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)!;
    expect(item.transcript).toBe("hello world");
    expect(JSON.parse(item.delivery_report!)).toEqual(flatDeliveryReport);
    expect(item.scoring_status).toBe("pending");
    expect(hearRecording).toHaveBeenCalledTimes(1);
  });

  it("transient initial failure returns {kind:'accepted', job} with exactly one job row, marks the item transcription_pending, and keeps the recording on disk", async () => {
    const { recovery, repo: r, hearRecording } = buildHarness();
    const attemptId = "att-transient-first-failure";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));

    const result = expectAccepted(await recovery.admitRecording({
      attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx",
    }));
    expect(result.job.status).toBe("retry_wait");
    expect(result.job.automaticAttempts).toBe(1);
    expect(result.job.failureKind).toBe("provider");
    expect(fs.existsSync(path.join(config.dataDir, rel))).toBe(true);

    expect(r.getCurrentTranscriptionJobs(attemptId)).toHaveLength(1);
    const item = r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)!;
    expect(item.scoring_status).toBe("transcription_pending");
    expect(item.transcript).toBeNull();
  });

  it("resubmitting the exact same attempt/item/hash reuses the same job and does not double-call Ears", async () => {
    const { recovery, repo: r, hearRecording } = buildHarness();
    const attemptId = "att-hash-reuse";
    hearRecording.mockResolvedValue({ transcript: "hi", deliveryReport: flatDeliveryReport });
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);

    const first = await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" });
    expect(first.kind).toBe("transcribed");
    expect(hearRecording).toHaveBeenCalledTimes(1);
    const jobsAfterFirst = r.getCurrentTranscriptionJobs(attemptId);
    expect(jobsAfterFirst).toHaveLength(1); // counts rows, not just the outcome

    const second = await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" });
    expect(second).toEqual(first);
    expect(hearRecording).toHaveBeenCalledTimes(1);
    const jobsAfterSecond = r.getCurrentTranscriptionJobs(attemptId);
    expect(jobsAfterSecond).toHaveLength(1);
    expect(jobsAfterSecond[0].id).toBe(jobsAfterFirst[0].id); // the same row, reused
  });

  it("a new hash for the same attempt/item supersedes the prior active job", async () => {
    const { recovery, repo: r, hearRecording } = buildHarness();
    const attemptId = "att-new-hash-supersedes";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel1 = writeRecording(attemptId, lr1Id, Buffer.from("first-take-bytes-000000000000000000000000000000"));
    hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));

    const firstResult = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel1, mimeType: "audio/webm", context: "ctx" }));
    expect(r.getTranscriptionJob(firstResult.job.jobId)?.status).toBe("retry_wait");

    const rel2 = writeRecording(attemptId, lr1Id, Buffer.from("second-take-different-bytes-1111111111111111111"));
    expect(rel2).toBe(rel1); // same canonical path, different content
    hearRecording.mockResolvedValue({ transcript: "second take", deliveryReport: flatDeliveryReport });
    const secondResult = await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel2, mimeType: "audio/webm", context: "ctx" });
    expect(secondResult).toEqual({ kind: "transcribed", transcript: "second take", deliveryReport: flatDeliveryReport });

    expect(r.getTranscriptionJob(firstResult.job.jobId)?.status).toBe("superseded");
  });

  it("does not persist or report a stale fresh success after a newer take supersedes it in flight", async () => {
    const { recovery, repo: r, hearRecording } = buildHarness();
    const attemptId = "att-fresh-success-race";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id, Buffer.from("first-take-bytes-000000000000000000000000000000"));

    let finishFirst!: (result: { transcript: string; deliveryReport: DeliveryReport }) => void;
    const firstEars = new Promise<{ transcript: string; deliveryReport: DeliveryReport }>((resolve) => {
      finishFirst = resolve;
    });
    hearRecording
      .mockImplementationOnce(() => firstEars)
      .mockResolvedValueOnce({ transcript: "current second take", deliveryReport: flatDeliveryReport });

    const firstAdmission = recovery.admitRecording({
      attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx",
    });
    await vi.waitFor(() => expect(hearRecording).toHaveBeenCalledTimes(1));

    writeRecording(attemptId, lr1Id, Buffer.from("second-take-different-bytes-1111111111111111111"));
    expect(await recovery.admitRecording({
      attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx",
    })).toEqual({ kind: "transcribed", transcript: "current second take", deliveryReport: flatDeliveryReport });

    finishFirst({ transcript: "stale first take", deliveryReport: flatDeliveryReport });
    await expect(firstAdmission).rejects.toBeInstanceOf(TranscriptionAdmissionSuperseded);
    expect(r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)!.transcript).toBe("current second take");
  });

  it("stale hash/path cannot persist a transcript: a superseded job never resurfaces even once its own retry_wait time would otherwise be due", async () => {
    const { recovery, repo: r, hearRecording, advance } = buildHarness();
    const attemptId = "att-stale-cannot-persist";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const relOld = writeRecording(attemptId, lr1Id, Buffer.from("old-recording-bytes-00000000000000000000000000"));
    hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    const oldResult = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: relOld, mimeType: "audio/webm", context: "ctx" }));

    const relNew = writeRecording(attemptId, lr1Id, Buffer.from("new-recording-bytes-11111111111111111111111111"));
    hearRecording.mockResolvedValue({ transcript: "the real answer", deliveryReport: flatDeliveryReport });
    const newResult = await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: relNew, mimeType: "audio/webm", context: "ctx" });
    expect(newResult).toEqual({ kind: "transcribed", transcript: "the real answer", deliveryReport: flatDeliveryReport });
    expect(r.getTranscriptionJob(oldResult.job.jobId)?.status).toBe("superseded");

    advance(20_000); // past the superseded job's 15s retry point
    hearRecording.mockClear();
    await recovery.runDueAndReconcile();
    expect(hearRecording).not.toHaveBeenCalled();
    expect(r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)!.transcript).toBe("the real answer");
  });
});

describe("retry schedule (fake clock)", () => {
  it("is exactly 15s, then 60s, then 5min, then terminal 'failed' on the 4th failure", async () => {
    const { recovery, repo: r, hearRecording, advance } = buildHarness();
    const attemptId = "att-retry-schedule";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));

    const admitted = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));
    const jobId = admitted.job.jobId;
    let job = r.getTranscriptionJob(jobId)!;
    expect(job.status).toBe("retry_wait");
    expect(job.automatic_attempts).toBe(1);
    expect(new Date(`${job.next_retry_at!.replace(" ", "T")}Z`).getTime() - T0.getTime()).toBe(15_000);

    // Not yet due at +14s — no second attempt.
    advance(14_000);
    await recovery.runDueAndReconcile();
    expect(hearRecording).toHaveBeenCalledTimes(1);
    expect(r.getTranscriptionJob(jobId)?.status).toBe("retry_wait");

    // Due at +15s total.
    advance(1_000);
    await recovery.runDueAndReconcile();
    job = r.getTranscriptionJob(jobId)!;
    expect(hearRecording).toHaveBeenCalledTimes(2);
    expect(job.automatic_attempts).toBe(2);
    expect(job.status).toBe("retry_wait");
    const t1 = T0.getTime() + 15_000;
    expect(new Date(`${job.next_retry_at!.replace(" ", "T")}Z`).getTime() - t1).toBe(60_000);

    advance(60_000);
    await recovery.runDueAndReconcile();
    job = r.getTranscriptionJob(jobId)!;
    expect(hearRecording).toHaveBeenCalledTimes(3);
    expect(job.automatic_attempts).toBe(3);
    expect(job.status).toBe("retry_wait");
    const t2 = t1 + 60_000;
    expect(new Date(`${job.next_retry_at!.replace(" ", "T")}Z`).getTime() - t2).toBe(300_000);

    advance(300_000);
    await recovery.runDueAndReconcile();
    job = r.getTranscriptionJob(jobId)!;
    expect(hearRecording).toHaveBeenCalledTimes(4);
    expect(job.automatic_attempts).toBe(4);
    expect(job.status).toBe("failed"); // exhausted — MAX_AUTOMATIC_ATTEMPTS reached
    expect(job.next_retry_at).toBeNull();
  });
});

describe("the durable retry timer is genuinely armed", () => {
  it("a LONE transiently-failed recording re-attempts on its OWN armed timer, with no external runDueAndReconcile call", async () => {
    // Every other scheduling test in this file drives runDueAndReconcile() by hand under the
    // injected clock, so they would all pass against a rescheduleTimer() that did nothing. This one
    // lets the timer fire.
    //
    // rescheduleTimer() skips jobs in inFlightJobIds, and the failure path
    // (finalizeAutomaticOrManualFailure) runs while the job is still in flight, so for a single
    // outstanding job it arms nothing. Only the re-arm in admitRecording's `finally`, after the job
    // leaves the set, schedules its retry; without it the job would sit at retry_wait, which
    // retry() refuses, until a restart. A second recoverable job would arm the timer for both and
    // hide the gap, so this test has exactly one.
    //
    // Only setTimeout/clearTimeout are faked: the injected `now` clock stays under `advance`'s
    // control, and better-sqlite3/Date are untouched.
    const fakeTimers = useFakeTimersInTest({ toFake: ["setTimeout", "clearTimeout"] });
      const { recovery, repo: r, hearRecording, advance } = buildHarness();
      const attemptId = "att-critical1-lone-job-timer";
      r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
      const rel = writeRecording(attemptId, lr1Id);
      hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));

      const admitted = expectAccepted(await recovery.admitRecording({
        attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx",
      }));
      const jobId = admitted.job.jobId;
      expect(r.getTranscriptionJob(jobId)?.status).toBe("retry_wait");
      expect(hearRecording).toHaveBeenCalledTimes(1);
      // The only recoverable job, so no other job's timer can carry its schedule.
      expect(r.listRecoverableTranscriptionJobs(at("9999-12-31 23:59:59"))).toHaveLength(1);

      advance(15_000); // the durable clock the worker reads
    await fakeTimers.advanceBy(15_000); // the real scheduling mechanism
    await fakeTimers.advanceBy(0); // drain the reconcile pass the timer kicked off

      expect(hearRecording).toHaveBeenCalledTimes(2);
      let job = r.getTranscriptionJob(jobId)!;
      expect(job.automatic_attempts).toBe(2);
      expect(job.status).toBe("retry_wait");

      // The next delay is armed the same way, so the chain continues unattended.
      advance(60_000);
    await fakeTimers.advanceBy(60_000);
    await fakeTimers.advanceBy(0);
      expect(hearRecording).toHaveBeenCalledTimes(3);
      expect(r.getTranscriptionJob(jobId)?.automatic_attempts).toBe(3);
  });

  it("a lone MANUAL retry that fails retryably also leaves a correctly armed schedule for whatever remains recoverable", async () => {
    // retry()'s `finally` re-arms the timer as admitRecording's does. A failed manual run returns
    // its job to 'failed', which is not recoverable, so what can be observed is that the timer is
    // still armed for the other, waiting job after retry() was the last to touch the scheduler.
    const fakeTimers = useFakeTimersInTest({ toFake: ["setTimeout", "clearTimeout"] });
      const { recovery, repo: r, hearRecording, advance } = buildHarness();
      const attemptFailed = "att-critical1-manual-retry";
      const attemptWaiting = "att-critical1-still-waiting";
      r.createAttempt({ id: attemptFailed, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
      r.createAttempt({ id: attemptWaiting, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
      const relFailed = writeRecording(attemptFailed, lr1Id);
      const relWaiting = writeRecording(attemptWaiting, lr1Id);

      // Job 1 fails terminally (manually retryable). Job 2 fails retryably and waits 15s.
      hearRecording.mockRejectedValueOnce(new EarsError(401, "authentication", "authentication unavailable (HTTP 401)"));
      const failed = expectAccepted(await recovery.admitRecording({ attemptId: attemptFailed, itemId: lr1Id, taskType: "listen_repeat", recordingPath: relFailed, mimeType: "audio/webm", context: "ctx" }));
      expect(r.getTranscriptionJob(failed.job.jobId)?.status).toBe("failed");
      hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
      const waiting = expectAccepted(await recovery.admitRecording({ attemptId: attemptWaiting, itemId: lr1Id, taskType: "listen_repeat", recordingPath: relWaiting, mimeType: "audio/webm", context: "ctx" }));
      expect(r.getTranscriptionJob(waiting.job.jobId)?.status).toBe("retry_wait");

      // The manual retry is the last thing to touch the scheduler before the 15s point.
      const vm = await recovery.retry(failed.job.jobId);
      expect(vm.status).toBe("failed");

      hearRecording.mockClear();
      advance(15_000);
    await fakeTimers.advanceBy(15_000);
    await fakeTimers.advanceBy(0);

      expect(hearRecording).toHaveBeenCalledTimes(1); // job 2's automatic retry still fired on its own
      expect(r.getTranscriptionJob(waiting.job.jobId)?.automatic_attempts).toBe(2);
  });
});

describe("an interrupted fresh admission is recoverable, not stranded", () => {
  it("a process death during a fresh admission's Ears call leaves state the boot sweep and the User's Retry recover — never resolved to 'superseded'", async () => {
    // The interrupted state comes from the module's own admission path, not from hand-inserted
    // rows. Admission writes the Item row, pointing at this recording, before it calls Ears, so the
    // retry after the restart finds the Item still current and transcribes it rather than writing
    // the job 'superseded' (terminal, refused by retry(), absent from readAttemptSnapshot).
    const { recovery, repo: r, hearRecording, judgeSpeaking, aggregateSpeaking } = buildHarness();
    const attemptId = "att-critical2-interrupted-admission";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);

    // Ears never settles: the process "dies" while the call is in flight. admitRecording runs
    // synchronously up to and including that call, so the database is already in the interrupted
    // state the moment the unawaited promise is created.
    hearRecording.mockImplementation(() => new Promise<never>(() => {}));
    const abandoned = recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" });
    void abandoned.catch(() => {});

    const interrupted = r.getCurrentTranscriptionJobs(attemptId);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0].status).toBe("running");
    const jobId = interrupted[0].id;

    // Restart: the boot sweep fails the row, and a new coordinator over the same database (with an
    // empty in-flight set) serves the User's Retry, as a fresh process would.
    const hearAfterRestart = vi.fn<typeof realHearRecording>().mockResolvedValue({ transcript: "recovered after restart", deliveryReport: flatDeliveryReport });
    mockJudgesSucceed({ judgeSpeaking, aggregateSpeaking }, "listen_repeat", lr1Id);
    resetTranscriptionCoordinatorsForNewProcess();
    const restarted = createTranscriptionRecovery({
      repo: r, hearRecording: hearAfterRestart, judgeSpeaking, aggregateSpeaking, onScoringTerminal: () => {},
    });
    expect(failInterruptedTranscriptionJobs(r)).toBe(1);
    await restarted.retry(jobId);

    const job = r.getTranscriptionJob(jobId)!;
    expect(job.status).not.toBe("superseded");
    expect(["awaiting_score", "done"]).toContain(job.status);
    expect(hearAfterRestart).toHaveBeenCalledTimes(1);
    expect(r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)!.transcript).toBe("recovered after restart");
    expect(fs.existsSync(path.join(config.dataDir, rel))).toBe(true);
  });

  it("a re-record interrupted mid-Ears never leaves the test taker scored on the take they replaced", async () => {
    // Take 1 succeeded (the Item holds its transcript at canonical path P, scoring_status
    // 'pending'). Take 2 is admitted with a new hash at the same path (the upload route always
    // reuses it, so take 1's job is 'done' and the supersede sweep leaves it alone), and the
    // process dies mid-Ears. If the Item row still held take 1 at 'pending', the retry would pass
    // checkItemStillCurrent and pay for Ears, and persistRecoveredTranscriptAndAwaitScore, which
    // requires 'transcription_pending', would refuse take 2's transcript, leaving the User scored
    // on the take they replaced.
    const { recovery, repo: r, hearRecording, judgeSpeaking, aggregateSpeaking } = buildHarness();
    const attemptId = "att-critical2-rerecord-interrupted";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });

    const rel1 = writeRecording(attemptId, lr1Id, Buffer.from("take-one-bytes-00000000000000000000000000000"));
    hearRecording.mockResolvedValueOnce({ transcript: "take one", deliveryReport: flatDeliveryReport });
    const first = await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel1, mimeType: "audio/webm", context: "ctx" });
    expect(first).toEqual({ kind: "transcribed", transcript: "take one", deliveryReport: flatDeliveryReport });
    const afterTakeOne = r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)!;
    expect(afterTakeOne.transcript).toBe("take one");
    expect(afterTakeOne.scoring_status).toBe("pending");

    const rel2 = writeRecording(attemptId, lr1Id, Buffer.from("take-two-bytes-11111111111111111111111111111"));
    expect(rel2).toBe(rel1); // same canonical path, different content — this is what defeats the path check
    hearRecording.mockImplementation(() => new Promise<never>(() => {}));
    const abandoned = recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel2, mimeType: "audio/webm", context: "ctx" });
    void abandoned.catch(() => {});

    // Admitting take 2 clears take 1's transcript when it claims the job: a re-record replaces the
    // prior take.
    const midFlight = r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)!;
    expect(midFlight.transcript).toBeNull();
    expect(midFlight.scoring_status).toBe("transcription_pending");

    const takeTwoJob = r.getCurrentTranscriptionJobs(attemptId).find((j) => j.status === "running")!;
    expect(takeTwoJob).toBeDefined();

    const hearAfterRestart = vi.fn<typeof realHearRecording>().mockResolvedValue({ transcript: "take two", deliveryReport: flatDeliveryReport });
    mockJudgesSucceed({ judgeSpeaking, aggregateSpeaking }, "listen_repeat", lr1Id);
    resetTranscriptionCoordinatorsForNewProcess();
    const restarted = createTranscriptionRecovery({
      repo: r, hearRecording: hearAfterRestart, judgeSpeaking, aggregateSpeaking, onScoringTerminal: () => {},
    });
    failInterruptedTranscriptionJobs(r);
    await restarted.retry(takeTwoJob.id);

    expect(r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)!.transcript).toBe("take two");
    const resolved = r.getTranscriptionJob(takeTwoJob.id)!;
    expect(resolved.status).not.toBe("running");
    expect(["awaiting_score", "done"]).toContain(resolved.status);
  });
});

describe("failure classification", () => {
  const retryableCases: [string, () => EarsError][] = [
    ["network", () => new EarsError("network", "network", "network error contacting provider")],
    ["timeout", () => new EarsError("network", "timeout", "request timed out")],
    ["rate-limit", () => new EarsError(429, "rate-limit", "rate limited (HTTP 429)")],
    ["provider (5xx)", () => new EarsError(503, "provider", "provider unavailable (HTTP 503)")],
    ["invalid-output", () => new EarsError("invalid-json", "invalid-output", "invalid structured output from provider")],
  ];

  it.each(retryableCases)("%s is retryable: one failure schedules a durable retry, not a terminal failure", async (_label, makeErr) => {
    const { recovery, repo: r, hearRecording } = buildHarness();
    const attemptId = `att-retryable-${_label.replace(/[^a-z0-9]/gi, "")}`;
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValue(makeErr());

    const result = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));
    expect(result.job.status).toBe("retry_wait");
    expect(result.job.nextRetryAt).not.toBeNull();
    // An ISO instant, not the raw SQLite column value: the client renders it with a bare
    // `new Date(...)`, which reads the space-separated form as local time.
    expect(result.job.nextRetryAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  const terminalEarsCases: [string, () => EarsError][] = [
    ["authentication", () => new EarsError(401, "authentication", "authentication unavailable (HTTP 401)")],
    ["configuration", () => new EarsError("config", "configuration", "configuration unavailable (GEMINI_JUDGE_MODEL not set)")],
    ["unsupported-audio", () => new EarsError(400, "unsupported-audio", "request rejected (HTTP 400)")],
  ];

  it.each(terminalEarsCases)("%s is terminal on the very first attempt: job goes straight to 'failed', no retry scheduled", async (_label, makeErr) => {
    const built = buildHarness();
    const attemptId = `att-terminal-${_label.replace(/[^a-z0-9]/gi, "")}`;
    built.repo.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    built.hearRecording.mockRejectedValue(makeErr());

    const result = expectAccepted(await built.recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));
    expect(result.job.status).toBe("failed");
    expect(result.job.failureKind).toBe(
      _label === "authentication" ? "authentication" : _label === "configuration" ? "configuration" : "unsupported-audio"
    );
    expect(result.job.nextRetryAt).toBeNull();
    expect(result.job.automaticAttempts).toBe(1);
  });

  it("a legacy absolute item_results.response_audio_path resolving OUTSIDE dataDir is caught and classified unsafe-path (terminal), never thrown from inside the worker", async () => {
    const { recovery, repo: r, hearRecording, advance } = buildHarness();
    const attemptId = "att-unsafe-path";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    const admitted = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));

    // A legacy absolute path resolving outside dataDir (a backup restored from another machine,
    // say) makes resolveAudioPath throw. attemptEars must classify it rather than let it escape
    // from what is, in production, a timer callback.
    r.insertItemResult({
      attemptId, itemId: lr1Id, taskType: "listen_repeat",
      responseAudioPath: "/completely/outside/dataDir/evil.webm", scoringStatus: "transcription_pending",
    });

    advance(15_000);
    hearRecording.mockClear();
    await expect(recovery.runDueAndReconcile()).resolves.toBeUndefined();
    expect(hearRecording).not.toHaveBeenCalled();
    const job = r.getTranscriptionJob(admitted.job.jobId)!;
    expect(job.status).toBe("failed");
    expect(job.failure_kind).toBe("unsafe-path");
  });

  it("a recording deleted from disk between admission and a durable retry is classified missing-recording (terminal)", async () => {
    const { recovery, repo: r, hearRecording, advance } = buildHarness();
    const attemptId = "att-missing-recording";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    const admitted = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));

    fs.rmSync(path.join(config.dataDir, rel));
    advance(15_000);
    await recovery.runDueAndReconcile();
    const job = r.getTranscriptionJob(admitted.job.jobId)!;
    expect(job.status).toBe("failed");
    expect(job.failure_kind).toBe("missing-recording");
  });

  it("a recording whose bytes changed without going through admission (hash no longer matches the accepted job) is classified corrupt-recording (terminal)", async () => {
    const { recovery, repo: r, hearRecording, advance } = buildHarness();
    const attemptId = "att-corrupt-recording";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    const admitted = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));

    fs.writeFileSync(path.join(config.dataDir, rel), Buffer.from("tampered-bytes-different-content-000000000000"));
    advance(15_000);
    await recovery.runDueAndReconcile();
    const job = r.getTranscriptionJob(admitted.job.jobId)!;
    expect(job.status).toBe("failed");
    expect(job.failure_kind).toBe("corrupt-recording");
  });
});

describe("scheduler claim safety", () => {
  it("two concurrent scheduler passes cannot claim and process the same due job twice", async () => {
    const { recovery, repo: r, hearRecording, advance } = buildHarness();
    const attemptId = "att-claim-race";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValueOnce(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    const admitted = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));
    expect(r.getTranscriptionJob(admitted.job.jobId)?.status).toBe("retry_wait");

    advance(15_000);
    hearRecording.mockClear(); // count only the calls made during the race, not admission's
    let releaseEars!: () => void;
    const gate = new Promise<void>((resolve) => { releaseEars = resolve; });
    hearRecording.mockImplementation(async () => {
      await gate;
      return { transcript: "resolved once", deliveryReport: flatDeliveryReport };
    });

    const call1 = recovery.runDueAndReconcile();
    const call2 = recovery.runDueAndReconcile();
    releaseEars();
    await Promise.all([call1, call2]);

    expect(hearRecording).toHaveBeenCalledTimes(1);
  });
});

describe("a global runDueAndReconcile pass (no attemptId)", () => {
  it("processes an already-due retry_wait job and resumes awaiting_score coordination in one pass", async () => {
    const { recovery, repo: r, hearRecording, judgeSpeaking, aggregateSpeaking } = buildHarness();

    // Job B: already-due retry_wait.
    const attemptB = "att-boot-due";
    r.createAttempt({ id: attemptB, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const relB = writeRecording(attemptB, lr1Id);
    r.insertItemResult({ attemptId: attemptB, itemId: lr1Id, taskType: "listen_repeat", responseAudioPath: relB, scoringStatus: "transcription_pending" });
    const jobB = r.createOrGetTranscriptionJob({ id: "boot-job-b", attemptId: attemptB, itemId: lr1Id, taskType: "listen_repeat", audioPath: relB, audioSha256: sha256Of(path.join(config.dataDir, relB)), now: at("2026-07-30 00:00:00") });
    r.updateTranscriptionJob({ id: jobB.id, status: "retry_wait", automaticAttempts: 1, nextRetryAt: at("2026-07-29 23:59:59"), now: at("2026-07-30 00:00:00") });

    // Job C: already awaiting_score (transcribed, waiting for scoring handoff — e.g. crashed right
    // after persisting the transcript but before the scoring job was created and linked).
    const attemptC = "att-boot-awaiting";
    r.createAttempt({ id: attemptC, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const relC = writeRecording(attemptC, int1Id);
    r.insertItemResult({ attemptId: attemptC, itemId: int1Id, taskType: "interview", responseAudioPath: relC, transcript: "already transcribed", deliveryReport: JSON.stringify(flatDeliveryReport) });
    const jobC = r.createOrGetTranscriptionJob({ id: "boot-job-c", attemptId: attemptC, itemId: int1Id, taskType: "interview", audioPath: relC, audioSha256: sha256Of(path.join(config.dataDir, relC)), now: at("2026-07-30 00:00:00") });
    r.updateTranscriptionJob({ id: jobC.id, status: "awaiting_score", now: at("2026-07-30 00:00:00") });

    hearRecording.mockResolvedValue({ transcript: "boot recovered", deliveryReport: flatDeliveryReport });
    mockJudgesSucceed({ judgeSpeaking, aggregateSpeaking }, "interview", int1Id);

    await recovery.runDueAndReconcile(); // no attemptId => global pass, as the scheduler's timer runs it

    // B was retried and successfully transcribed.
    const finalB = r.getTranscriptionJob(jobB.id)!;
    expect(["awaiting_score", "done"]).toContain(finalB.status);

    // C's handoff was resumed: exactly one scoring job created and linked.
    await vi.waitFor(() => {
      expect(r.getTranscriptionJob(jobC.id)?.status).toBe("done");
    });
    const finalC = r.getTranscriptionJob(jobC.id)!;
    expect(finalC.score_job_id).not.toBeNull();
    expect(JSON.parse(r.getScoringJob(finalC.score_job_id!)!.item_ids)).toEqual([int1Id]);
  });
});

describe("a 'running' row the coordinator did not claim", () => {
  it("is left alone by every pass, including a restarted coordinator's first — no second paid Ears call for one recording", async () => {
    // A 'running' row this coordinator never claimed belongs to a run that is still live (a
    // previous process's leftovers are failed by the boot sweep before admissions open). Resuming
    // it would pay Ears a second time for the same recording.
    const { recovery, repo: r, hearRecording, judgeSpeaking, aggregateSpeaking, now } = buildHarness();
    const attemptId = "att-running-elsewhere";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    r.insertItemResult({ attemptId, itemId: lr1Id, taskType: "listen_repeat", responseAudioPath: rel, scoringStatus: "transcription_pending" });
    const job = r.createOrGetTranscriptionJob({ id: "running-elsewhere", attemptId, itemId: lr1Id, taskType: "listen_repeat", audioPath: rel, audioSha256: sha256Of(path.join(config.dataDir, rel)), now: at("2026-07-30 00:00:00") });
    r.claimTranscriptionJob({ id: job.id, now: at("2026-07-30 00:00:00") });

    await recovery.runDueAndReconcile();
    await recovery.runDueAndReconcile(attemptId);
    resetTranscriptionCoordinatorsForNewProcess();
    const restarted = createTranscriptionRecovery({
      repo: r, hearRecording, judgeSpeaking, aggregateSpeaking, now, onScoringTerminal: () => {},
    });
    await restarted.runDueAndReconcile();

    expect(r.getTranscriptionJob(job.id)?.status).toBe("running");
    expect(hearRecording).not.toHaveBeenCalled();
  });
});

describe("score-job handoff coordination", () => {
  it("successful recovery waits while an active same-task scoring job is queued/running, then completes the handoff — creating exactly ONE one-item scoring job — once that job goes terminal", async () => {
    const { recovery, repo: r, hearRecording, judgeSpeaking, aggregateSpeaking, advance } = buildHarness();
    const attemptId = "att-wait-then-handoff";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValueOnce(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    const admitted = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));

    // Another scoring job for the same Attempt and Task Type is already in flight (a different Item
    // of that Task Type mid-scoring), which defers this handoff.
    r.createScoringJob({ id: "active-blocking-job", attemptId, taskType: "listen_repeat", itemIds: ["some-other-item"] });

    advance(15_000);
    hearRecording.mockResolvedValue({ transcript: "recovered", deliveryReport: flatDeliveryReport });
    await recovery.runDueAndReconcile();

    let job = r.getTranscriptionJob(admitted.job.jobId)!;
    expect(job.status).toBe("awaiting_score"); // transcribed, but handoff deferred
    expect(job.score_job_id).toBeNull();
    expect(judgeSpeaking).not.toHaveBeenCalled();

    // Once the blocking job clears, the next reconcile pass completes the handoff.
    r.seedScoringJobState({ id: "active-blocking-job", status: "done" });
    mockJudgesSucceed({ judgeSpeaking, aggregateSpeaking }, "listen_repeat", lr1Id);
    await recovery.runDueAndReconcile();

    await vi.waitFor(() => {
      job = r.getTranscriptionJob(admitted.job.jobId)!;
      expect(job.status).toBe("done");
    });
    expect(job.score_job_id).not.toBeNull();
    expect(JSON.parse(r.getScoringJob(job.score_job_id!)!.item_ids)).toEqual([lr1Id]);
    // Counts rows: the blocking job plus exactly one created by the handoff.
    expect(r.listAllScoringJobs().filter((j) => j.attempt_id === attemptId && j.task_type === "listen_repeat")).toHaveLength(2);
  });

  it("an already-scored item makes its awaiting_score job 'done' without creating any scoring job", async () => {
    // Seeded through the store: a successful recovery hands off to scoring as soon as nothing
    // blocks it, so through the public interface an 'awaiting_score' job with nothing linked is
    // transient. It is the state a crash between persisting the transcript and creating the
    // scoring job leaves.
    const { recovery, repo: r, judgeSpeaking } = buildHarness();
    const attemptId = "att-already-scored";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    r.insertItemResult({ attemptId, itemId: lr1Id, taskType: "listen_repeat", responseAudioPath: rel, transcript: "already transcribed", deliveryReport: JSON.stringify(flatDeliveryReport) });
    r.updateItemScore({ attemptId, itemId: lr1Id, score: 4, scoreJson: "{}", scoringStatus: "scored" });
    const job = r.createOrGetTranscriptionJob({ id: "already-scored-job", attemptId, itemId: lr1Id, taskType: "listen_repeat", audioPath: rel, audioSha256: sha256Of(path.join(config.dataDir, rel)), now: at("2026-07-30 00:00:00") });
    r.updateTranscriptionJob({ id: job.id, status: "awaiting_score", now: at("2026-07-30 00:00:00") });

    await recovery.runDueAndReconcile();
    expect(r.getTranscriptionJob(job.id)?.status).toBe("done");
    expect(r.getTranscriptionJob(job.id)?.score_job_id).toBeNull();
    expect(judgeSpeaking).not.toHaveBeenCalled();
  });

  it("a deferred handoff (blocked behind another same-task scoring job) completes WITHOUT a restart, once the blocking job goes terminal", async () => {
    // Two Items of one Task Type recover in the same reconcile pass. Item 1's handoff creates and
    // links scoring job S1; item 2's finds S1 active and defers at 'awaiting_score', which
    // rescheduleTimer never schedules. The default onScoringTerminal re-drives
    // runDueAndReconcile(attemptId) when S1 ends, so item 2 completes with no further call here.
    //
    // S1's Judges wait on a gate this test controls. Without it, S1's detached runScoringJob and
    // item 2's handoff race on the microtask queue, and item 2 does not always see S1 as active.
    // buildHarness defaults onScoringTerminal to a no-op; passing `undefined` here wins over that
    // in the merged deps and falls through to createTranscriptionRecovery's own default.
    const { recovery, repo: r, hearRecording, judgeSpeaking, aggregateSpeaking, advance } = buildHarness({ onScoringTerminal: undefined });
    const attemptId = "att-deferred-handoff-no-restart";
    const lr2Id = speakingSet.listenAndRepeat.items[1].id;
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel1 = writeRecording(attemptId, lr1Id);
    const rel2 = writeRecording(attemptId, lr2Id);
    hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    const admitted1 = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel1, mimeType: "audio/webm", context: "ctx" }));
    const admitted2 = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr2Id, taskType: "listen_repeat", recordingPath: rel2, mimeType: "audio/webm", context: "ctx" }));

    advance(15_000);
    hearRecording.mockResolvedValue({ transcript: "recovered", deliveryReport: flatDeliveryReport });

    let releaseBlockingJob!: () => void;
    const blockingGate = new Promise<void>((resolve) => { releaseBlockingJob = resolve; });
    judgeSpeaking.mockImplementation(async (
      judgeName: "gemini" | "openai",
      input: { taskType: "listen_repeat" | "interview"; items: { itemId: string }[] },
    ) => {
      await blockingGate;
      return {
        report: {
          judge: judgeName, taskType: input.taskType,
          items: input.items.map((it) => ({ itemId: it.itemId, score: 4, dimensions: [{ name: "intelligibility", score: 4, evidence: "clear audio" }], deductions: [] })),
        },
        mode: "audio" as const,
        provider: judgeName === "gemini" ? ("gemini-http" as const) : ("openai-http" as const),
      };
    });
    aggregateSpeaking.mockImplementation(async (input: AggregateSpeakingInput) => ({
      report: {
        taskType: input.taskType,
        items: input.items.map((it) => ({
          itemId: it.itemId, ownScore: 4, finalScore: 4, maxScore: 5,
          dimensions: [{ name: "intelligibility", note: "ok" }],
          deductions: [], reconciliationNote: "agreed", feedbackZh: "表現不錯。",
        })),
      },
      provider: "claude" as const,
    }));

    await recovery.runDueAndReconcile(); // item 2 defers behind item 1's gated scoring job

    // Item 2 is blocked: item 1's scoring job is still running, and item 2 sits at awaiting_score
    // with nothing linked yet.
    expect(r.getTranscriptionJob(admitted1.job.jobId)?.status).toBe("done");
    const blockingScoreJobId = r.getTranscriptionJob(admitted1.job.jobId)!.score_job_id!;
    expect(r.getScoringJob(blockingScoreJobId)?.status).toBe("running");
    expect(r.getTranscriptionJob(admitted2.job.jobId)?.status).toBe("awaiting_score");
    expect(r.getTranscriptionJob(admitted2.job.jobId)?.score_job_id).toBeNull();

    releaseBlockingJob();

    // No further calls to runDueAndReconcile or retry from here: only the event-driven re-drive.
    await vi.waitFor(() => {
      expect(r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr2Id)!.scoring_status).toBe("scored");
    }, { timeout: 2000 });
    expect(r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)!.scoring_status).toBe("scored");
    expect(r.getTranscriptionJob(admitted1.job.jobId)?.status).toBe("done");
    expect(r.getTranscriptionJob(admitted2.job.jobId)?.status).toBe("done");
    expect(r.getTranscriptionJob(admitted2.job.jobId)?.score_job_id).not.toBeNull();
  });
});

describe("manual retry", () => {
  it("an exhausted (automatically-failed) job remains manually retryable, and manual retry never touches automatic_attempts", async () => {
    const { recovery, repo: r, hearRecording, advance } = buildHarness();
    const attemptId = "att-manual-after-exhausted";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    const admitted = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));
    const jobId = admitted.job.jobId;

    advance(15_000); await recovery.runDueAndReconcile();
    advance(60_000); await recovery.runDueAndReconcile();
    advance(300_000); await recovery.runDueAndReconcile();
    expect(r.getTranscriptionJob(jobId)?.status).toBe("failed");
    expect(r.getTranscriptionJob(jobId)?.automatic_attempts).toBe(4);

    hearRecording.mockResolvedValue({ transcript: "manual success", deliveryReport: flatDeliveryReport });
    const vm = await recovery.retry(jobId);
    // Nothing blocks handoff here, so it proceeds all the way through awaiting_score to 'done' with
    // a linked scoring job within this same manual retry call.
    expect(vm.status).toBe("done");
    expect(vm.scoreJobId).not.toBeNull();
    expect(r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)!.transcript).toBe("manual success");
    // A manual retry neither resets nor increments automatic_attempts.
    expect(r.getTranscriptionJob(jobId)?.automatic_attempts).toBe(4);
  });

  it("retry(jobId) revalidates the canonical path/hash before calling Ears — a tampered recording is refused without ever reaching Ears, and returns to 'failed'", async () => {
    const { recovery, repo: r, hearRecording } = buildHarness();
    const attemptId = "att-manual-revalidate";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValueOnce(new EarsError(401, "authentication", "authentication unavailable (HTTP 401)"));
    const admitted = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));
    expect(r.getTranscriptionJob(admitted.job.jobId)?.status).toBe("failed");

    fs.writeFileSync(path.join(config.dataDir, rel), Buffer.from("tampered-after-failure-bytes-00000000000000"));
    hearRecording.mockClear();
    const vm = await recovery.retry(admitted.job.jobId);
    expect(vm.status).toBe("failed");
    expect(vm.failureKind).toBe("corrupt-recording");
    expect(hearRecording).not.toHaveBeenCalled();
  });

  it("retry(jobId) rejects an unknown job id", async () => {
    const { recovery } = buildHarness();
    await expect(recovery.retry("does-not-exist")).rejects.toThrow();
  });

  it("retry(jobId) rejects a superseded job — manual retry never revives a stale job", async () => {
    const { recovery, repo: r, hearRecording } = buildHarness();
    const attemptId = "att-manual-rejects-superseded";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel1 = writeRecording(attemptId, lr1Id, Buffer.from("take-one-bytes-000000000000000000000000000000"));
    // Retryable, so the first job settles at 'retry_wait': still active, and so superseded by
    // createOrGetTranscriptionJob's sweep below, which leaves a 'failed' job alone.
    hearRecording.mockRejectedValueOnce(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    const first = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel1, mimeType: "audio/webm", context: "ctx" }));
    expect(r.getTranscriptionJob(first.job.jobId)?.status).toBe("retry_wait");

    const rel2 = writeRecording(attemptId, lr1Id, Buffer.from("take-two-bytes-000000000000000000000000000000"));
    hearRecording.mockResolvedValue({ transcript: "second take", deliveryReport: flatDeliveryReport });
    await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel2, mimeType: "audio/webm", context: "ctx" });
    expect(r.getTranscriptionJob(first.job.jobId)?.status).toBe("superseded");

    await expect(recovery.retry(first.job.jobId)).rejects.toThrow();
  });

  it("retry(jobId) rejects a 'failed' job that is no longer the CURRENT job for its item, even though the old job itself was never superseded", async () => {
    // The store's supersede sweep touches only active statuses (queued, running, retry_wait,
    // awaiting_score) and leaves a 'failed' job alone. A failure followed by a successful re-record
    // therefore leaves the old job at 'failed', where a status check alone would let retry() run a
    // take the User has replaced.
    const { recovery, repo: r, hearRecording } = buildHarness();
    const attemptId = "att-retry-rejects-non-current";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel1 = writeRecording(attemptId, lr1Id, Buffer.from("take-one-terminal-bytes-0000000000000000000000"));
    hearRecording.mockRejectedValueOnce(new EarsError(400, "unsupported-audio", "request rejected (HTTP 400)"));
    const first = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel1, mimeType: "audio/webm", context: "ctx" }));
    expect(r.getTranscriptionJob(first.job.jobId)?.status).toBe("failed");

    const rel2 = writeRecording(attemptId, lr1Id, Buffer.from("take-two-succeeds-bytes-0000000000000000000000"));
    hearRecording.mockResolvedValue({ transcript: "second take", deliveryReport: flatDeliveryReport });
    await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel2, mimeType: "audio/webm", context: "ctx" });
    // Job 1 stays 'failed', not superseded: the case this test is about.
    expect(r.getTranscriptionJob(first.job.jobId)?.status).toBe("failed");

    await expect(recovery.retry(first.job.jobId)).rejects.toThrow();
  });

  it("retry(jobId) claims its own row before anything else can run, so no scheduler pass ever takes a manual retry as automatic work", async () => {
    // The row retry() queues is 'running' by the time retry() first yields, so a scheduler pass
    // made while the manual run is in flight finds nothing to claim, and the run ends without
    // charging the automatic budget.
    const { recovery, repo: r, hearRecording } = buildHarness();
    const attemptId = "att-item1-marks-during-run";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValueOnce(new EarsError("config", "configuration", "configuration unavailable (GEMINI_JUDGE_MODEL not set)"));
    const admitted = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));
    const jobId = admitted.job.jobId;
    expect(r.getTranscriptionJob(jobId)?.status).toBe("failed");
    const budgetBefore = r.getTranscriptionJob(jobId)!.automatic_attempts;

    let releaseEars!: () => void;
    const gate = new Promise<void>((resolve) => { releaseEars = resolve; });
    hearRecording.mockImplementation(async () => {
      await gate;
      return { transcript: "manual retry succeeded", deliveryReport: flatDeliveryReport };
    });

    const retryPromise = recovery.retry(jobId);
    // retry()'s queue-then-claim runs to completion before its first suspension point (inside
    // Ears' own await), so no polling is needed to observe the row mid-flight.
    expect(r.getTranscriptionJob(jobId)?.status).toBe("running");
    await recovery.runDueAndReconcile();
    expect(hearRecording).toHaveBeenCalledTimes(2); // the admission and the manual retry, nothing else

    releaseEars();
    await retryPromise;
    expect(r.getTranscriptionJob(jobId)?.automatic_attempts).toBe(budgetBefore);
  });
});

describe("readAttemptSnapshot", () => {
  it("a stale 'failed' job never hides a successful re-record in the public snapshot", async () => {
    // The supersede sweep leaves a 'failed' job alone, so the old failed job and the new 'done' job
    // both appear in getCurrentTranscriptionJobs. The snapshot resolves each Item to its newest job
    // before applying its omission rule; otherwise the stale failure would stand in for a good
    // transcript.
    const { recovery, repo: r, hearRecording } = buildHarness();
    const attemptId = "att-stale-failed-hides-success";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel1 = writeRecording(attemptId, lr1Id, Buffer.from("take-one-terminal-bytes-1111111111111111111111"));
    hearRecording.mockRejectedValueOnce(new EarsError(400, "unsupported-audio", "request rejected (HTTP 400)"));
    await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel1, mimeType: "audio/webm", context: "ctx" });
    expect(r.getCurrentTranscriptionJobs(attemptId).find((j) => j.item_id === lr1Id)?.status).toBe("failed");

    const rel2 = writeRecording(attemptId, lr1Id, Buffer.from("take-two-succeeds-bytes-1111111111111111111111"));
    hearRecording.mockResolvedValue({ transcript: "the real answer", deliveryReport: flatDeliveryReport });
    const second = await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel2, mimeType: "audio/webm", context: "ctx" });
    expect(second.kind).toBe("transcribed");

    // Both rows exist, so the case is real.
    const jobsForItem = r.getCurrentTranscriptionJobs(attemptId).filter((j) => j.item_id === lr1Id);
    expect(jobsForItem.map((j) => j.status).sort()).toEqual(["done", "failed"]);

    // The newest job is a clean immediate success, so the snapshot shows neither the stale failure
    // nor a 'done' entry for the Item.
    expect(recovery.readAttemptSnapshot(attemptId).has(lr1Id)).toBe(false);
  });
  it("exposes only the approved safe TranscriptionJobVM fields", async () => {
    const { recovery, repo: r, hearRecording } = buildHarness();
    const attemptId = "att-snapshot-safe-fields";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" });

    const snapshot = recovery.readAttemptSnapshot(attemptId);
    const vm = snapshot.get(lr1Id)!;
    expect(Object.keys(vm).sort()).toEqual(
      ["automaticAttempts", "error", "failureKind", "jobId", "nextRetryAt", "scoreJobId", "status"].sort()
    );
    expect(vm).not.toHaveProperty("audioPath");
    expect(vm).not.toHaveProperty("audioSha256");
    expect(vm).not.toHaveProperty("attemptId");
    expect(vm).not.toHaveProperty("itemId");
    expect(vm).not.toHaveProperty("taskType");
    expect(vm).not.toHaveProperty("createdAt");
    expect(vm).not.toHaveProperty("updatedAt");
  });

  it("omits a clean immediate-success bookkeeping job, but keeps a recovered job (linked score id) visible until the linked scoring result actually lands", async () => {
    const { recovery, repo: r, hearRecording, judgeSpeaking, aggregateSpeaking, advance } = buildHarness();
    const attemptId = "att-snapshot-visibility";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });

    // Item A (listen_repeat): clean immediate success — omitted from the snapshot.
    const relA = writeRecording(attemptId, lr1Id);
    hearRecording.mockResolvedValueOnce({ transcript: "clean", deliveryReport: flatDeliveryReport });
    await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: relA, mimeType: "audio/webm", context: "ctx" });
    expect(recovery.readAttemptSnapshot(attemptId).has(lr1Id)).toBe(false);

    // Item B (interview — different task type, so its own scoring job doesn't collide with A's):
    // recovered via a durable retry, then handed off to scoring.
    const relB = writeRecording(attemptId, int1Id);
    hearRecording.mockRejectedValueOnce(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    const admittedB = expectAccepted(await recovery.admitRecording({ attemptId, itemId: int1Id, taskType: "interview", recordingPath: relB, mimeType: "audio/webm", context: "ctx" }));

    advance(15_000);
    hearRecording.mockResolvedValue({ transcript: "recovered", deliveryReport: flatDeliveryReport });
    mockJudgesSucceed({ judgeSpeaking, aggregateSpeaking }, "interview", int1Id);
    await recovery.runDueAndReconcile();

    const snapBeforeScored = recovery.readAttemptSnapshot(attemptId);
    expect(snapBeforeScored.has(int1Id)).toBe(true);
    expect(snapBeforeScored.get(int1Id)!.status).toBe("done");
    expect(snapBeforeScored.get(int1Id)!.scoreJobId).not.toBeNull();

    await vi.waitFor(() => {
      expect(r.getAttempt(attemptId)!.items.find((i) => i.item_id === int1Id)!.scoring_status).toBe("scored");
    });
    expect(recovery.readAttemptSnapshot(attemptId).has(int1Id)).toBe(false);
    expect(admittedB.job.jobId).toBeTruthy();
  });

  it("a linked recovered job also drops out of the snapshot once the linked item's scoring result lands as 'failed', not only 'scored'", () => {
    // Seeded through the store. 'scored' and 'failed' are the two `scoring_status` values that mean
    // a result landed; the test above covers 'scored', this one 'failed'.
    const { recovery, repo: r } = buildHarness();
    const attemptId = "att-snapshot-failed-lands-too";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    r.insertItemResult({ attemptId, itemId: lr1Id, taskType: "listen_repeat", responseAudioPath: rel, transcript: "recovered", deliveryReport: JSON.stringify(flatDeliveryReport) });
    const job = r.createOrGetTranscriptionJob({ id: "snapshot-failed-job", attemptId, itemId: lr1Id, taskType: "listen_repeat", audioPath: rel, audioSha256: sha256Of(path.join(config.dataDir, rel)), now: at("2026-07-30 00:00:00") });
    r.updateTranscriptionJob({ id: job.id, status: "awaiting_score", now: at("2026-07-30 00:00:01") });
    r.createRecoveryScoringJobAndLink({ transcriptionJobId: job.id, scoringJobId: "linked-then-failed", attemptId, taskType: "listen_repeat", itemId: lr1Id, now: at("2026-07-30 00:00:02") });
    expect(r.getTranscriptionJob(job.id)?.status).toBe("done");
    expect(r.getTranscriptionJob(job.id)?.score_job_id).toBe("linked-then-failed");

    // Still visible while the linked scoring job hasn't resolved the item yet.
    expect(recovery.readAttemptSnapshot(attemptId).has(lr1Id)).toBe(true);

    // The linked scoring job's result lands as 'failed', which is still a landed result.
    r.updateItemScore({ attemptId, itemId: lr1Id, score: null, scoreJson: '{"error":"both judges failed"}', scoringStatus: "failed" });

    expect(recovery.readAttemptSnapshot(attemptId).has(lr1Id)).toBe(false);
  });

  it("a recovered job whose LINKED SCORING JOB a re-score superseded drops out of the snapshot while its Item waits on the new job, instead of pinning a spinner forever", () => {
    // A POST /score for the Item's Task Type supersedes every active job for it, the recovery job
    // linked here included: that job ends 'cancelled' without writing a result, and the Item stays
    // 'pending' under the job that replaced it. The snapshot judges the link by the linked job's own
    // status, so the finished transcription job stops showing a transcribing spinner for work that
    // is now the new scoring job's.
    const { recovery, repo: r } = buildHarness();
    const attemptId = "att-snapshot-superseded-score-job";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    r.insertItemResult({ attemptId, itemId: lr1Id, taskType: "listen_repeat", responseAudioPath: rel, transcript: "recovered", deliveryReport: JSON.stringify(flatDeliveryReport) });
    const job = r.createOrGetTranscriptionJob({ id: "snapshot-superseded-score-job", attemptId, itemId: lr1Id, taskType: "listen_repeat", audioPath: rel, audioSha256: sha256Of(path.join(config.dataDir, rel)), now: at("2026-07-30 00:00:00") });
    r.updateTranscriptionJob({ id: job.id, status: "awaiting_score", now: at("2026-07-30 00:00:01") });
    r.createRecoveryScoringJobAndLink({ transcriptionJobId: job.id, scoringJobId: "linked-then-superseded", attemptId, taskType: "listen_repeat", itemId: lr1Id, now: at("2026-07-30 00:00:02") });

    // Visible while the linked scoring job is still outstanding.
    expect(r.getScoringJob("linked-then-superseded")?.status).toBe("queued");
    expect(recovery.readAttemptSnapshot(attemptId).has(lr1Id)).toBe(true);

    // The re-score's own write: a new job for the Task Type, which cancels the linked one.
    expect(r.replaceScoringJobAndSupersede({ id: "rescore-job", attemptId, taskType: "listen_repeat", itemIds: [lr1Id], now: at("2026-07-30 00:00:03") }))
      .toEqual(["linked-then-superseded"]);
    expect(r.getScoringJob("linked-then-superseded")).toMatchObject({ status: "cancelled", cancellation_reason: "superseded" });
    expect(r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)!.scoring_status).toBe("pending");
    expect(recovery.readAttemptSnapshot(attemptId).has(lr1Id)).toBe(false);
  });
});

describe("a refused transcript persist", () => {
  it("persistRecoveredTranscriptAndAwaitScore refusing for a reason OTHER than supersession (item resolved via another path while Ears was in flight) resolves the job to 'done', NEVER a false 'failed'/'corrupt-recording' — the recording itself was fine", async () => {
    const { recovery, repo: r, hearRecording, advance } = buildHarness();
    const attemptId = "att-persist-refused-other-reason";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValueOnce(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    const admitted = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));

    // Another path scores this Item while it sits at 'transcription_pending', moving scoring_status
    // off that value without touching response_audio_path or the hash. The identity and hash checks
    // of persistRecoveredTranscriptAndAwaitScore still pass; only its final
    // `WHERE scoring_status='transcription_pending'` UPDATE affects 0 rows, a refusal that is not a
    // supersession.
    r.updateItemScore({ attemptId, itemId: lr1Id, score: 3, scoreJson: "{}", scoringStatus: "scored" });

    advance(15_000);
    hearRecording.mockResolvedValue({ transcript: "recovered too late", deliveryReport: flatDeliveryReport });
    await recovery.runDueAndReconcile();

    const job = r.getTranscriptionJob(admitted.job.jobId)!;
    expect(job.status).not.toBe("running"); // never stranded
    // Ears succeeded; only the Item's score was resolved elsewhere, so the job is 'done', not
    // 'failed'. A 'failed' job would offer a Retry that pays for Ears on every click and is refused
    // by the same precondition every time.
    expect(job.status).toBe("done");
    expect(job.failure_kind).toBeNull();
    expect(job.error).toBeNull();
    expect(job.next_retry_at).toBeNull();

    // 'done' is not manually retryable, so nothing can start another paid Ears call for an Item
    // that is already resolved.
    await expect(recovery.retry(admitted.job.jobId)).rejects.toThrow();
  });
});

describe("an automatic retry_wait schedule", () => {
  it("charges each automatic run to the automatic budget and keeps the job waiting", async () => {
    const { recovery, repo: r, hearRecording, advance } = buildHarness();
    const attemptId = "att-item4-marker-cleared-on-schedule";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    const admitted = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));
    const jobId = admitted.job.jobId;
    expect(r.getTranscriptionJob(jobId)?.status).toBe("retry_wait");

    advance(15_000);
    await recovery.runDueAndReconcile(); // ordinary automatic durable retry, fails again
    const job = r.getTranscriptionJob(jobId)!;
    expect(job.status).toBe("retry_wait");
    expect(job.automatic_attempts).toBe(2);
  });
});

describe("scheduler resilience", () => {
  it("an unexpected synchronous throw while processing one due job does not abort the pass for other due jobs, and the call still resolves", async () => {
    let readSetCalls = 0;
    const throwingReadSet = (id: string) => {
      readSetCalls += 1;
      if (readSetCalls === 1) throw new Error("simulated unexpected failure reading the set");
      return realSetStore.readSet(id);
    };
    const { recovery, repo: r, hearRecording, advance } = buildHarness({ setStore: { readSet: throwingReadSet } });

    const attemptThrows = "att-minor7-throws";
    const attemptOk = "att-minor7-ok";
    r.createAttempt({ id: attemptThrows, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    r.createAttempt({ id: attemptOk, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const relThrows = writeRecording(attemptThrows, lr1Id);
    const relOk = writeRecording(attemptOk, lr1Id);
    hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    await recovery.admitRecording({ attemptId: attemptThrows, itemId: lr1Id, taskType: "listen_repeat", recordingPath: relThrows, mimeType: "audio/webm", context: "ctx" });
    await recovery.admitRecording({ attemptId: attemptOk, itemId: lr1Id, taskType: "listen_repeat", recordingPath: relOk, mimeType: "audio/webm", context: "ctx" });

    advance(15_000);
    hearRecording.mockResolvedValue({ transcript: "recovered", deliveryReport: flatDeliveryReport });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(recovery.runDueAndReconcile()).resolves.toBeUndefined();
    errorSpy.mockRestore();

    // The job whose buildContext -> readSet call hits the injected throw (attemptThrows was
    // admitted first, and created_at ties are broken by insertion order, so its job is claimed
    // first) is recorded as an ordinary retryable ('provider') failure and scheduled for its next
    // automatic attempt, rather than left 'running' or aborting the pass. The other due job still
    // recovers in the same pass.
    const throwingJob = r.getCurrentTranscriptionJobs(attemptThrows)[0];
    expect(throwingJob?.status).toBe("retry_wait");
    expect(throwingJob?.automatic_attempts).toBe(2);
    expect(r.getAttempt(attemptOk)!.items.find((i) => i.item_id === lr1Id)!.transcript).toBe("recovered");
    expect(readSetCalls).toBeGreaterThanOrEqual(2); // the throw did not stop the second job's own readSet call
  });
});

describe("stranding-proof processing throws", () => {
  it("a job whose worker attempt throws unexpectedly is never left stranded at 'running' — it is classified as a normal retryable failure, scheduled, and eventually exhausts to 'failed' (still manually retryable) rather than spinning forever", async () => {
    let shouldThrow = true;
    const throwingReadSet = (id: string) => {
      if (shouldThrow) throw new Error("simulated unexpected failure reading the set (e.g. EACCES/EIO/a DB blip)");
      return realSetStore.readSet(id);
    };
    const { recovery, repo: r, hearRecording, advance } = buildHarness({ setStore: { readSet: throwingReadSet } });
    const attemptId = "att-item1-strand-proof";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    const admitted = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));
    const jobId = admitted.job.jobId;
    expect(r.getTranscriptionJob(jobId)?.status).toBe("retry_wait");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Three more reconcile passes, each hitting the injected throw instead of a classified Ears
    // failure: an infrastructure fault rather than an ordinary provider error.
    advance(15_000);
    await recovery.runDueAndReconcile();
    let job = r.getTranscriptionJob(jobId)!;
    expect(job.status).not.toBe("running"); // not stranded, here or after the passes below
    expect(job.status).toBe("retry_wait");
    expect(job.automatic_attempts).toBe(2);

    advance(60_000);
    await recovery.runDueAndReconcile();
    job = r.getTranscriptionJob(jobId)!;
    expect(job.status).toBe("retry_wait");
    expect(job.automatic_attempts).toBe(3);

    advance(300_000);
    await recovery.runDueAndReconcile();
    job = r.getTranscriptionJob(jobId)!;
    expect(job.status).toBe("failed"); // exhausted: a terminal state, not a permanent spinner
    expect(job.automatic_attempts).toBe(4);
    errorSpy.mockRestore();

    // Still manually retryable once the underlying fault clears.
    shouldThrow = false;
    hearRecording.mockResolvedValue({ transcript: "recovered after fault cleared", deliveryReport: flatDeliveryReport });
    const vm = await recovery.retry(jobId);
    expect(vm.status).not.toBe("failed");
    expect(vm.status).not.toBe("running");
  });
});

describe("an unexpected throw during a CLAIMED attempt is classified, never stranded at 'running'", () => {
  it("admitRecording: a throw from the claim-time item write leaves the job classified and SCHEDULED, and still reports the recording as accepted", async () => {
    // A throw during the claimed run, here from the claim-time Item write (repo.insertItemResult),
    // must go through the ordinary failure path. A row left 'running' is not listed by
    // listRecoverableTranscriptionJobs and is refused by retry(), so the recording would show as
    // transcribing until a restart.
    const baseRepo = openSqliteStores();
    let insertCalls = 0;
    const throwingRepo = {
      ...baseRepo,
      insertItemResult: ((i: Parameters<typeof baseRepo.insertItemResult>[0]) => {
        insertCalls += 1;
        if (insertCalls === 1) throw Object.assign(new Error("EIO: i/o error, write"), { code: "EIO" });
        return baseRepo.insertItemResult(i);
      }) as typeof baseRepo.insertItemResult,
    };
    const attemptId = "att-final1-admit-throws";
    baseRepo.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    const hearRecording = vi.fn<typeof realHearRecording>();
    const recovery = createTranscriptionRecovery({
      repo: throwingRepo, hearRecording, judgeSpeaking: vi.fn(), aggregateSpeaking: vi.fn(), onScoringTerminal: () => {},
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // The recording is durably accepted and scheduled, so 'accepted' is the truthful answer: a
    // rejection would tell the upload route the recording was lost while the server retries it.
    await expect(recovery.admitRecording({
      attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx",
    })).resolves.toMatchObject({ kind: "accepted" });
    errorSpy.mockRestore();

    const job = baseRepo.getCurrentTranscriptionJobs(attemptId)[0];
    expect(job.status).not.toBe("running");
    expect(job.status).toBe("retry_wait"); // the ordinary failure path
    expect(job.failure_kind).toBe("provider");
    expect(job.automatic_attempts).toBe(1);
    expect(job.next_retry_at).not.toBeNull();
    expect(hearRecording).not.toHaveBeenCalled(); // no paid call was made
  });

  it("retry(): a throw during the manual attempt returns the job to 'failed' rather than stranding it at 'running', and it stays manually retryable", async () => {
    let shouldThrow = false;
    const throwingReadSet = (id: string) => {
      if (shouldThrow) throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
      return realSetStore.readSet(id);
    };
    const { recovery, repo: r, hearRecording } = buildHarness({ setStore: { readSet: throwingReadSet } });
    const attemptId = "att-final1-retry-throws";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    // admitRecording passes its own adhocContext, so readSet is never called during admission —
    // only the manual retry below reaches buildContext.
    hearRecording.mockRejectedValueOnce(new EarsError(401, "authentication", "authentication unavailable (HTTP 401)"));
    const admitted = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));
    const jobId = admitted.job.jobId;
    expect(r.getTranscriptionJob(jobId)?.status).toBe("failed");

    shouldThrow = true;
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const vm = await recovery.retry(jobId);
    errorSpy.mockRestore();

    expect(vm.status).toBe("failed");
    expect(vm.failureKind).toBe("provider");
    const job = r.getTranscriptionJob(jobId)!;
    expect(job.status).not.toBe("running");
    expect(job.automatic_attempts).toBe(1); // a manual run never touches it
    expect(job.next_retry_at).toBeNull(); // and starts no new automatic cycle

    // Still manually retryable once the underlying fault clears.
    shouldThrow = false;
    hearRecording.mockResolvedValue({ transcript: "recovered after the fault cleared", deliveryReport: flatDeliveryReport });
    const second = await recovery.retry(jobId);
    expect(second.status).not.toBe("failed");
    expect(second.status).not.toBe("running");
  });
});

describe("'no item row' is never read as staleness", () => {
  it("a claimed job whose item row does not exist at all is re-established and transcribed, never resolved to 'superseded'", async () => {
    // A death between claiming a job and its claim-time Item write, or a throw from that write (as
    // the admitRecording test above injects), leaves a durable job with no Item row. A missing row
    // is not staleness; only an Item that points at another recording is. Reading the absence as
    // stale would write the job 'superseded' (terminal, refused by retry(), absent from the
    // snapshot) and strand an accepted recording.
    const { recovery, repo: r, hearRecording, judgeSpeaking, aggregateSpeaking } = buildHarness();
    const attemptId = "att-final2-no-item-row";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    // A durable job at 'running' with no item_results row.
    const job = r.createOrGetTranscriptionJob({ id: "final2-orphan-job", attemptId, itemId: lr1Id, taskType: "listen_repeat", audioPath: rel, audioSha256: sha256Of(path.join(config.dataDir, rel)), now: at("2026-07-30 00:00:00") });
    r.claimTranscriptionJob({ id: job.id, now: at("2026-07-30 00:00:00") });
    expect(r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)).toBeUndefined();

    hearRecording.mockResolvedValue({ transcript: "recovered despite the missing item row", deliveryReport: flatDeliveryReport });
    mockJudgesSucceed({ judgeSpeaking, aggregateSpeaking }, "listen_repeat", lr1Id);
    failInterruptedTranscriptionJobs(r);
    await recovery.retry(job.id);

    const resolved = r.getTranscriptionJob(job.id)!;
    expect(resolved.status).not.toBe("superseded");
    expect(["awaiting_score", "done"]).toContain(resolved.status);
    expect(hearRecording).toHaveBeenCalledTimes(1);
    // The transcript lands: re-creating the Item row satisfies
    // persistRecoveredTranscriptAndAwaitScore's precondition, so the paid call is not wasted.
    expect(r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)!.transcript).toBe("recovered despite the missing item row");
  });

  it("an item row that genuinely points somewhere ELSE is still treated as stale and still supersedes", async () => {
    // The case `skip` exists for: the Item row points at another recording.
    const { recovery, repo: r, hearRecording } = buildHarness();
    const attemptId = "att-final2-points-elsewhere";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    const job = r.createOrGetTranscriptionJob({ id: "final2-stale-job", attemptId, itemId: lr1Id, taskType: "listen_repeat", audioPath: rel, audioSha256: sha256Of(path.join(config.dataDir, rel)), now: at("2026-07-30 00:00:00") });
    r.claimTranscriptionJob({ id: job.id, now: at("2026-07-30 00:00:00") });
    // The Item row exists and points at a different recording.
    r.insertItemResult({ attemptId, itemId: lr1Id, taskType: "listen_repeat", responseAudioPath: "audio/responses/somewhere/else.webm", scoringStatus: "transcription_pending" });

    failInterruptedTranscriptionJobs(r);
    await recovery.retry(job.id);

    expect(r.getTranscriptionJob(job.id)?.status).toBe("superseded");
    expect(hearRecording).not.toHaveBeenCalled();
  });
});

describe("rescheduleTimer guard", () => {
  it("a throw inside rescheduleTimer's own body (called from runDueAndReconcile's finally) is caught and logged — it never masks (replaces) the ORIGINAL error the reconcile pass itself hit, and never propagates further", async () => {
    const baseRepo = openSqliteStores();
    let awaitingScoreCalls = 0;
    let farFutureRecoverableCalls = 0;
    // Two injected failures at two call sites: listAwaitingScoreTranscriptionJobs (the error the
    // pass itself hits) and listRecoverableTranscriptionJobs with the far-future cutoff, which only
    // rescheduleTimer passes (from the pass's `finally`). The due query's call with `nowStr` still
    // works, so only rescheduleTimer's body is broken.
    const throwingRepo = {
      ...baseRepo,
      listAwaitingScoreTranscriptionJobs: () => {
        awaitingScoreCalls += 1;
        throw new Error("simulated listAwaitingScoreTranscriptionJobs failure (the ORIGINAL error)");
      },
      listRecoverableTranscriptionJobs: (nowArg: SqliteTimestamp) => {
        if (nowArg === "9999-12-31 23:59:59") {
          farFutureRecoverableCalls += 1;
          throw new Error("simulated rescheduleTimer-internal failure — must NEVER be what this call rejects with");
        }
        return baseRepo.listRecoverableTranscriptionJobs(nowArg);
      },
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const recovery = createTranscriptionRecovery({
      repo: throwingRepo, judgeSpeaking: vi.fn(), aggregateSpeaking: vi.fn(), onScoringTerminal: () => {},
    });

    // An unguarded throw from rescheduleTimer in the `finally` would replace this rejection.
    await expect(recovery.runDueAndReconcile()).rejects.toThrow(
      "simulated listAwaitingScoreTranscriptionJobs failure (the ORIGINAL error)"
    );
    expect(awaitingScoreCalls).toBe(1);
    // rescheduleTimer did run and fail inside, and its guard caught the failure.
    expect(farFutureRecoverableCalls).toBeGreaterThan(0);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("rescheduleTimer"), expect.anything());
    errorSpy.mockRestore();
  });
});

describe("privacy-safe error logging", () => {
  it("no raw error text (e.g. a JSON-parse fragment embedding scenario/question content) ever reaches a log — only a bounded, safe descriptor does", async () => {
    // readSet can throw on this module's error paths (buildContext, coordinateScoringHandoff), and
    // a malformed Set file is the realistic case. JSON.parse's SyntaxError embeds the first few
    // characters of the text it failed on (`Unexpected token 'O', "ORCHESTRAT"... is not valid
    // JSON`), so a raw message would put Set content in the log. ears.test.ts uses the same canary
    // convention for provider text.
    const canary = "ORCHESTRATION_LOG_CANARY_sk_live_secret_scenario_text";
    const throwingReadSet = (): never => {
      JSON.parse(canary); // throws a real SyntaxError embedding a fragment of `canary` in .message
      throw new Error("unreachable");
    };
    const { recovery, repo: r, hearRecording, advance } = buildHarness({ setStore: { readSet: throwingReadSet } });
    const attemptId = "att-item2-privacy-log";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValueOnce(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" });

    advance(15_000);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await recovery.runDueAndReconcile(); // durable retry -> buildContext -> readSet -> throws
    const calls = errorSpy.mock.calls.length;
    // Node's console.error renders an Error argument by its name, message and stack (util.inspect),
    // not by JSON.stringify: message and stack are not own-enumerable, so JSON.stringify(someError)
    // yields "{}" and would hide the very leak this test looks for. Reproduce the real rendering.
    const loggedText = errorSpy.mock.calls
      .flat(2)
      .map((v) => (v instanceof Error ? `${v.name}: ${v.message}\n${v.stack ?? ""}` : typeof v === "string" ? v : JSON.stringify(v)))
      .join(" ");
    errorSpy.mockRestore();

    expect(calls).toBeGreaterThan(0); // the throwing path ran
    expect(loggedText).not.toContain(canary);
    expect(loggedText).not.toContain("ORCHESTRAT"); // the fragment Node embeds in the message
    expect(loggedText).toContain("SyntaxError"); // the bounded descriptor still names the error kind
  });

  it("an enum-shaped `code` (EACCES/EIO/ENOENT) survives into the log so filesystem faults stay diagnosable, while the message that quotes a path still does not", async () => {
    // The error's name alone cannot tell a permissions fault from a corrupt database or a bad Set
    // file, since most error classes here do not override `.name`. A POSIX code is an enum-shaped
    // identifier with no user content, so it is logged; the message, which quotes the path, is not.
    const secretPath = "/private/SCENARIO_TEXT_CANARY/interview-question.json";
    const throwingReadSet = (): never => {
      throw Object.assign(new Error(`EACCES: permission denied, open '${secretPath}'`), { code: "EACCES" });
    };
    const { recovery, repo: r, hearRecording, advance } = buildHarness({ setStore: { readSet: throwingReadSet } });
    const attemptId = "att-minor10-error-code";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValueOnce(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" });

    advance(15_000);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await recovery.runDueAndReconcile(); // durable retry -> buildContext -> readSet -> throws
    const loggedText = errorSpy.mock.calls
      .flat(2)
      .map((v) => (v instanceof Error ? `${v.name}: ${v.message}\n${v.stack ?? ""}` : typeof v === "string" ? v : JSON.stringify(v)))
      .join(" ");
    errorSpy.mockRestore();

    expect(loggedText).toContain("Error (EACCES)"); // the code makes the fault identifiable
    expect(loggedText).not.toContain(secretPath);
    expect(loggedText).not.toContain("SCENARIO_TEXT_CANARY");
    expect(loggedText).not.toContain("permission denied"); // no message text at all, only the descriptor
  });
});

// One coordinator per database: two would each run a retry timer over the same jobs and abort only
// their own Ears calls when execution ownership is lost. A second call for a database that already
// has a coordinator gets that coordinator back, with a warning.
describe("process-singleton memoization", () => {
  it("gives each private :memory: database its own coordinator, and hands the SAME instance back for a repeat call", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const repoA = openSqliteStores();
      const repoB = openSqliteStores();
      const a = createTranscriptionRecovery({ repo: repoA, onScoringTerminal: () => {} });
      const b = createTranscriptionRecovery({ repo: repoB, onScoringTerminal: () => {} });
      expect(a).not.toBe(b); // separate databases cannot race
      expect(warnSpy).not.toHaveBeenCalled();

      const again = createTranscriptionRecovery({ repo: repoA, onScoringTerminal: () => {} });
      expect(again).toBe(a);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain("returning the existing coordinator");
    } finally {
      warnSpy.mockRestore();
    }
  });

  // Object identity alone misses the likeliest duplicate: a second store opened on the same
  // database file, a distinct object behind a distinct handle.
  it("returns the existing coordinator for two DISTINCT repo objects that open the same database FILE, and never builds a second live one", async () => {
    // Two handles on one real database file: distinct store objects whose `dbFile` names the same
    // database, which is the shape this guards against.
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "singleton-guard-"));
    const dbPath = path.join(dbDir, "db.sqlite");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    resetTranscriptionCoordinatorsForNewProcess();
    try {
      const first = openSqliteStores(dbPath);
      const second = openSqliteStores(dbPath);
      expect(second).not.toBe(first); // different objects, so identity alone would miss it

      const firstHear = vi.fn<typeof realHearRecording>();
      const secondHear = vi.fn<typeof realHearRecording>();
      const coordinator = createTranscriptionRecovery({ repo: first, hearRecording: firstHear, onScoringTerminal: () => {} });
      const duplicate = createTranscriptionRecovery({ repo: second, hearRecording: secondHear, onScoringTerminal: () => {} });

      expect(duplicate).toBe(coordinator);
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // The second call built no coordinator of its own, so its Ears seam is never reached. A guard
      // that only logged would leave `secondHear` wired into a second worker with its own retry
      // timer over the same jobs.
      const attemptId = "att-shared-file";
      first.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
      const rel = writeRecording(attemptId, lr1Id);
      firstHear.mockResolvedValue({ transcript: "only one worker exists", deliveryReport: flatDeliveryReport });
      await duplicate.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" });
      expect(firstHear).toHaveBeenCalledTimes(1);
      expect(secondHear).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      resetTranscriptionCoordinatorsForNewProcess();
      fs.rmSync(dbDir, { recursive: true, force: true });
    }
  });
});

// A transcription that ends 'failed' produces no scoring job, so without this hook nothing
// in-process tells the finalizer the Item will never be scored, and a capture-finished Simulation
// waits for the next boot. Driven through the module's own durable schedule.
describe("onTranscriptionTerminal", () => {
  it("fires once the automatic budget is exhausted, and not for any intermediate retry_wait", async () => {
    const onTranscriptionTerminal = vi.fn();
    const { recovery, repo: r, hearRecording, advance } = buildHarness({ onTranscriptionTerminal });
    const attemptId = "att-terminal-hook";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    hearRecording.mockRejectedValue(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));

    await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" });
    expect(onTranscriptionTerminal).not.toHaveBeenCalled(); // retry_wait is not terminal

    for (const delay of [15_000, 60_000]) {
      advance(delay);
      await recovery.runDueAndReconcile();
      expect(onTranscriptionTerminal).not.toHaveBeenCalled();
    }

    advance(300_000);
    await recovery.runDueAndReconcile(); // attempt 4 of 4 -> exhausted -> 'failed'
    expect(r.getTranscriptionJob(r.getCurrentTranscriptionJobs(attemptId)[0].id)?.status).toBe("failed");
    expect(onTranscriptionTerminal).toHaveBeenCalledTimes(1);
    expect(onTranscriptionTerminal).toHaveBeenCalledWith(attemptId);
  });

  it("fires for a terminal failure kind on the very first admission, and a throwing hook never breaks the worker", async () => {
    const onTranscriptionTerminal = vi.fn(() => {
      throw new Error("finalizer exploded");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { recovery, repo: r, hearRecording } = buildHarness({ onTranscriptionTerminal });
      const attemptId = "att-terminal-hook-throws";
      r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
      const rel = writeRecording(attemptId, lr1Id);
      hearRecording.mockRejectedValue(new EarsError(401, "authentication", "authentication unavailable (HTTP 401)"));

      const result = expectAccepted(
        await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }),
      );
      expect(result.job.status).toBe("failed");
      expect(onTranscriptionTerminal).toHaveBeenCalledTimes(1);
      // The recording is still accepted and still manually retryable: a broken callback does not
      // change the outcome the module already recorded.
      expect(r.getTranscriptionJob(result.job.jobId)?.status).toBe("failed");
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// Two branches end a job 'done' without creating a scoring job: the handoff finds the Item already
// scored, or the recovered transcript's persist is refused. No scoring job's onTerminal will fire
// for that Item, so this hook must. Otherwise a capture-finished Simulation waiting only on it is
// left to the one grace reconcile, 31 s after capture finished, and to the next boot if the
// transcription settles after that (the durable retry schedule runs to 5 minutes).
describe("onTranscriptionTerminal on terminal 'done' with no scoring job", () => {
  it("fires when a recovered item turns out to be already scored, and not while the handoff is merely deferred", async () => {
    const onTranscriptionTerminal = vi.fn();
    const { recovery, repo: r, hearRecording, advance } = buildHarness({ onTranscriptionTerminal });
    const attemptId = "att-done-no-score-job";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);

    hearRecording.mockRejectedValueOnce(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" });
    onTranscriptionTerminal.mockClear();

    // An active scoring job of the same Task Type blocks the handoff, so the durable retry's
    // success lands the job at 'awaiting_score': work is still pending and the hook stays silent.
    r.createScoringJob({ id: "blocking-job", attemptId, taskType: "listen_repeat", itemIds: ["lr-2"] });
    hearRecording.mockResolvedValue({ transcript: "recovered", deliveryReport: flatDeliveryReport });
    advance(15_000);
    await recovery.runDueAndReconcile();

    const jobId = r.getCurrentTranscriptionJobs(attemptId)[0].id;
    expect(r.getTranscriptionJob(jobId)?.status).toBe("awaiting_score");
    expect(onTranscriptionTerminal).not.toHaveBeenCalled();

    // Now the blocking job finishes and the Item is scored by another path (a Re-score that covered
    // it, say). The handoff creates nothing and marks the job 'done', and the hook fires.
    r.seedScoringJobState({ id: "blocking-job", status: "done" });
    r.updateItemScore({ attemptId, itemId: lr1Id, score: 4, scoreJson: JSON.stringify({ finalScore: 4 }), scoringStatus: "scored" });
    await recovery.runDueAndReconcile();

    const settled = r.getTranscriptionJob(jobId)!;
    expect(settled.status).toBe("done");
    expect(settled.score_job_id).toBeNull(); // nothing downstream exists to fire for this item
    expect(onTranscriptionTerminal).toHaveBeenCalledWith(attemptId);
  });

  it("fires once, not twice, when a landed transcript's handoff finds the Item already scored", async () => {
    const onTranscriptionTerminal = vi.fn();
    const base = openSqliteStores();
    const attemptId = "att-handoff-once";
    // The real store, with the Item scored by another path the moment the recovered transcript lands:
    // the handoff that follows finds it scored and ends the job 'done' with no scoring job.
    const repo = {
      ...base,
      persistRecoveredTranscriptAndAwaitScore: (input: Parameters<typeof base.persistRecoveredTranscriptAndAwaitScore>[0]) => {
        const landed = base.persistRecoveredTranscriptAndAwaitScore(input);
        if (landed) base.updateItemScore({ attemptId, itemId: lr1Id, score: 4, scoreJson: JSON.stringify({ finalScore: 4 }), scoringStatus: "scored" });
        return landed;
      },
    };
    const { recovery, hearRecording, advance } = buildHarness({ repo, onTranscriptionTerminal });
    base.createAttempt({ id: attemptId, kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);

    hearRecording.mockRejectedValueOnce(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" });
    hearRecording.mockResolvedValue({ transcript: "recovered", deliveryReport: flatDeliveryReport });
    advance(15_000);
    await recovery.runDueAndReconcile();

    expect(base.getCurrentTranscriptionJobs(attemptId)[0]).toMatchObject({ status: "done", score_job_id: null });
    expect(onTranscriptionTerminal).toHaveBeenCalledTimes(1);
    expect(onTranscriptionTerminal).toHaveBeenCalledWith(attemptId);
  });
});

// The client's terminal-failure policy (client/src/lib/transcriptionFailure.ts), tested here beside
// the failure kinds it interprets, as generationJobs.test.ts does for progressUtils. Retry is
// hidden for 'unsupported-audio', a paid call per click that cannot succeed. It stays for a
// repairable fault: ears.ts classifies a 404 or 422 (a wrong GEMINI_JUDGE_MODEL answers 404) as
// 'configuration', not 'unsupported-audio'.
describe("the terminal-failure policy in client/src/lib/transcriptionFailure.ts", () => {
  const failed = (failureKind: TranscriptionFailureKind, error: string | null = null) =>
    ({ status: "failed" as const, failureKind, error });

  it("hides Retry for 'unsupported-audio' (a paid Ears call per click that can never succeed)", () => {
    expect(isTerminalTranscriptionFailure(failed("unsupported-audio", "the provider could not process this recording's audio (HTTP 400)"))).toBe(true);
    // Each with copy that names its own cause.
    expect(terminalTranscriptionMessage("unsupported-audio")).toContain("rejected this recording");
    expect(terminalTranscriptionMessage("missing-recording")).toContain("can no longer be read");
  });

  it("keeps Retry for a repairable fault: 'configuration' (a wrong model id answers 404), 'authentication', 'provider'", () => {
    // A wrong GEMINI_JUDGE_MODEL answers 404, classified 'configuration': fixing one setting
    // repairs it, so Retry stays.
    expect(isTerminalTranscriptionFailure(failed("configuration"))).toBe(false);
    expect(isTerminalTranscriptionFailure(failed("authentication"))).toBe(false);
    expect(isTerminalTranscriptionFailure(failed("provider"))).toBe(false);
  });

  it("never hides Retry for a job that is not actually failed", () => {
    expect(isTerminalTranscriptionFailure({ status: "retry_wait", failureKind: "unsupported-audio", error: null })).toBe(false);
    expect(isTerminalTranscriptionFailure({ status: "failed", failureKind: null, error: null })).toBe(false);
  });

  // A job failed 'unsupported-audio' with this message was classified from a 400's status alone,
  // so a mistyped key could have put it there. It keeps Retry, which is how a recording refused
  // that way is transcribed once the key is fixed.
  it("keeps Retry for an 'unsupported-audio' job whose 400 was never read", () => {
    expect(isTerminalTranscriptionFailure(failed("unsupported-audio", "request rejected (HTTP 400)"))).toBe(false);
  });
});

// A mistyped or expired GEMINI_API_KEY passes setup, which only checks that a key is present, and
// Gemini answers it with a 400. Through the real Ears call and the real coordinator, that recording
// must end where the User can retry it once the key is fixed, not as a terminal audio fault.
describe("a recording refused for its API key", () => {
  it("fails retryably, is not retried automatically, and transcribes on the User's Retry once the key works", async () => {
    let keyFixed = false;
    const fetchImpl = vi.fn(async () => keyFixed
      ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ transcript: "hello there", deliveryReport: flatDeliveryReport }) }] } }] }), { status: 200 })
      : new Response(JSON.stringify({
          error: {
            code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key.",
            details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID", domain: "googleapis.com" }],
          },
        }), { status: 400 }));
    const { recovery, repo: r, advance } = buildHarness({
      hearRecording: (input) => callEars(input, fetchImpl as never, async () => undefined),
    });
    const attemptId = "att-bad-key";
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);

    const admitted = expectAccepted(await recovery.admitRecording({ attemptId, itemId: lr1Id, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }));
    expect(admitted.job).toMatchObject({ status: "failed", failureKind: "configuration", nextRetryAt: null });
    expect(admitted.job.error).toContain("GEMINI_API_KEY");
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Nothing retries it on a schedule: no backoff repairs a key, and each try is a paid call.
    advance(600_000);
    await recovery.runDueAndReconcile();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Attempt review offers Retry for it.
    const shown = recovery.readAttemptSnapshot(attemptId).get(lr1Id)!;
    expect(isTerminalTranscriptionFailure(shown)).toBe(false);

    keyFixed = true;
    await recovery.retry(admitted.job.jobId);
    expect(r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)).toMatchObject({ transcript: "hello there" });
  });
});

// Boot recovery spends no money, so transcription work a restart left unfinished is never resumed
// at boot. It must instead end where the User can act on it: a job a restart caught mid-Ears stays
// 'running', which arms no timer and which retry() refuses (its contract is `status === 'failed'`).
// These tests pin the bookkeeping-only sweep that settles it.
describe("boot interruption sweep", () => {
  // Exactly what a process death mid-Ears leaves behind: a durable job at 'running', its item row
  // already written at claim time (runClaimedAttempt's freshAdmission branch), no transcript.
  function strandRunningJob(r: ReturnType<typeof openSqliteStores>, attemptId: string): string {
    r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    const rel = writeRecording(attemptId, lr1Id);
    r.insertItemResult({ attemptId, itemId: lr1Id, taskType: "listen_repeat", responseAudioPath: rel, scoringStatus: "transcription_pending" });
    const job = r.createOrGetTranscriptionJob({
      id: `tj-${attemptId}`, attemptId, itemId: lr1Id, taskType: "listen_repeat",
      audioPath: rel, audioSha256: sha256Of(path.join(config.dataDir, rel)), now: at("2026-07-30 00:00:00"),
    });
    r.claimTranscriptionJob({ id: job.id, now: at("2026-07-30 00:00:00") }); // -> 'running', then the process died
    return job.id;
  }

  it("moves a row left 'running' by a restart to terminal 'failed', with a reason that names the restart and spends nothing", () => {
    const { repo: r, hearRecording } = buildHarness();
    const jobId = strandRunningJob(r, "att-30-swept");
    expect(r.getTranscriptionJob(jobId)!.status).toBe("running");

    expect(failInterruptedTranscriptionJobs(r)).toBe(1);

    const swept = r.getTranscriptionJob(jobId)!;
    expect(swept.status).toBe("failed");
    // The reason has to be distinguishable from a genuine transcription failure, which always
    // describes the recording or the provider ("recording is missing", an Ears safeMessage,
    // "transcription failed unexpectedly"). It is persisted on the row, so it survives to retry()
    // and to the review page's TranscriptionJobPanel, which shows job.error.
    expect(swept.error).toBe(INTERRUPTED_BY_RESTART_ERROR);
    expect(swept.next_retry_at).toBeNull(); // never a pending automatic retry that will not arrive
    // Nothing paid: no Ears call, and the sweep never even looks at the recording on disk.
    expect(hearRecording).not.toHaveBeenCalled();
    // ...and the client offers Retry rather than an honest dead end (the failure kind is retryable).
    expect(isTerminalTranscriptionFailure({ status: swept.status, failureKind: swept.failure_kind, error: swept.error })).toBe(false);
  });

  it("makes the swept row retryable through the normal User-facing retry — which retry() refuses beforehand", async () => {
    const { recovery, repo: r, hearRecording, judgeSpeaking, aggregateSpeaking } = buildHarness();
    const attemptId = "att-30-retry";
    const jobId = strandRunningJob(r, attemptId);

    // Before the sweep, the User-facing retry refuses a 'running' row.
    await expect(recovery.retry(jobId)).rejects.toBeInstanceOf(TranscriptionJobNotRetryable);
    expect(hearRecording).not.toHaveBeenCalled();

    failInterruptedTranscriptionJobs(r);

    hearRecording.mockResolvedValue({ transcript: "retried after the restart", deliveryReport: flatDeliveryReport });
    mockJudgesSucceed({ judgeSpeaking, aggregateSpeaking }, "listen_repeat", lr1Id);
    const vm = await recovery.retry(jobId);

    expect(hearRecording).toHaveBeenCalledTimes(1);
    expect(["awaiting_score", "done"]).toContain(vm.status);
    expect(r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)!.transcript).toBe("retried after the restart");
  });

  it("is idempotent across repeated boots: a row it already failed is not re-swept, re-counted, or rewritten", () => {
    const r = openSqliteStores();
    const jobId = strandRunningJob(r, "att-30-idempotent");

    expect(failInterruptedTranscriptionJobs(r, () => new Date("2026-07-30T00:01:00.000Z"))).toBe(1);
    const afterFirstBoot = r.getTranscriptionJob(jobId)!;

    // Second boot, later clock. A re-sweep would bump updated_at even where every other column is
    // already correct, so comparing the whole row is what proves it touched nothing.
    expect(failInterruptedTranscriptionJobs(r, () => new Date("2026-07-30T00:02:00.000Z"))).toBe(0);
    expect(r.getTranscriptionJob(jobId)).toEqual(afterFirstBoot);
  });

  it("never clobbers a row the User has already retried back into a good state", async () => {
    const { recovery, repo: r, hearRecording, judgeSpeaking, aggregateSpeaking } = buildHarness();
    const attemptId = "att-30-no-clobber";
    const jobId = strandRunningJob(r, attemptId);
    failInterruptedTranscriptionJobs(r);

    hearRecording.mockResolvedValue({ transcript: "recovered by the user", deliveryReport: flatDeliveryReport });
    mockJudgesSucceed({ judgeSpeaking, aggregateSpeaking }, "listen_repeat", lr1Id);
    await recovery.retry(jobId);
    const afterRetry = r.getTranscriptionJob(jobId)!;
    expect(afterRetry.status).not.toBe("failed");

    // The next boot must leave that alone — the recording is no longer interrupted.
    expect(failInterruptedTranscriptionJobs(r)).toBe(0);
    expect(r.getTranscriptionJob(jobId)).toEqual(afterRetry);
    expect(r.getAttempt(attemptId)!.items.find((i) => i.item_id === lr1Id)!.transcript).toBe("recovered by the user");
  });

  it("fails queued and waiting work too, closes a landed transcript's handoff as 'done', and leaves terminal rows alone", () => {
    const r = openSqliteStores();
    const shaFor = (n: number) => String(n).repeat(64).slice(0, 64);
    const make = (attemptId: string, id: string, sha: string) => {
      r.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
      return r.createOrGetTranscriptionJob({
        id, attemptId, itemId: lr1Id, taskType: "listen_repeat",
        audioPath: path.join("audio/responses", attemptId, `${lr1Id}.webm`), audioSha256: sha, now: at("2026-07-30 00:00:00"),
      }).id;
    };

    // Nothing in the new process will ever pick these up without paid work, so they fail with Retry.
    const queued = make("att-30-queued", "tj-queued", shaFor(1));
    const retryWait = make("att-30-retrywait", "tj-retrywait", shaFor(2));
    r.updateTranscriptionJob({ id: retryWait, status: "retry_wait", nextRetryAt: at("2026-07-30 00:05:00"), now: at("2026-07-30 00:00:00") });
    // 'awaiting_score' is never reported as a transcription failure: Ears already succeeded and the
    // transcript is on the Item. Only the paid scoring handoff is left undone, so the job is closed.
    const awaitingScore = make("att-30-awaiting", "tj-awaiting", shaFor(3));
    r.insertItemResult({ attemptId: "att-30-awaiting", itemId: lr1Id, taskType: "listen_repeat", transcript: "landed", deliveryReport: "{}" });
    r.updateTranscriptionJob({ id: awaitingScore, status: "awaiting_score", now: at("2026-07-30 00:00:00") });
    const done = make("att-30-done", "tj-done", shaFor(4));
    r.updateTranscriptionJob({ id: done, status: "done", now: at("2026-07-30 00:00:00") });
    const alreadyFailed = make("att-30-failed", "tj-failed", shaFor(5));
    r.updateTranscriptionJob({ id: alreadyFailed, status: "failed", failureKind: "network", error: "a genuine transcription failure", now: at("2026-07-30 00:00:00") });
    const superseded = make("att-30-superseded", "tj-superseded", shaFor(6));
    r.updateTranscriptionJob({ id: superseded, status: "superseded", now: at("2026-07-30 00:00:00") });

    const terminalBefore = [done, alreadyFailed, superseded].map((id) => r.getTranscriptionJob(id));
    expect(failInterruptedTranscriptionJobs(r)).toBe(3);

    for (const id of [queued, retryWait]) {
      expect(r.getTranscriptionJob(id)).toMatchObject({ status: "failed", error: INTERRUPTED_BY_RESTART_ERROR, failure_kind: "provider", next_retry_at: null });
    }
    expect(r.getTranscriptionJob(awaitingScore)).toMatchObject({ status: "done", score_job_id: null });
    expect(r.getAttempt("att-30-awaiting")!.items[0]).toMatchObject({ scoring_status: "failed", transcript: "landed" });
    expect([done, alreadyFailed, superseded].map((id) => r.getTranscriptionJob(id))).toEqual(terminalBefore);
  });

  it("wires to 'listening' only, and a fault inside it can never take down the boot passes registered after it", () => {
    const r = openSqliteStores();
    const jobId = strandRunningJob(r, "att-30-wired");
    const listeners: (() => void)[] = [];
    const server = { on: (_event: "listening", listener: () => void) => { listeners.push(listener); } };

    wireTranscriptionInterruptionSweep(server, r);
    // Registration alone must do nothing — the "every 'running' row is an orphan" invariant only
    // holds once this process has confirmed it owns the port.
    expect(r.getTranscriptionJob(jobId)!.status).toBe("running");

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const listener of listeners) listener();
    expect(r.getTranscriptionJob(jobId)!.status).toBe("failed");
    expect(logSpy.mock.calls.flat(2).join(" ")).toContain("transcription boot sweep");
    logSpy.mockRestore();

    // Node aborts every remaining 'listening' listener the instant one throws, so this sweep must
    // swallow its own faults (SQLITE_BUSY from a predecessor `tsx watch` process is the realistic
    // trigger) rather than suppress the passes registered after it.
    const canary = "SWEEP_THROW_CANARY_row_contents";
    const brokenRepo = {
      ...r,
      listInterruptedTranscriptionJobs: () => {
        throw Object.assign(new Error(`database is locked: ${canary}`), { code: "SQLITE_BUSY" });
      },
    } as unknown as TranscriptionRecoveryDeps["repo"];
    const brokenListeners: (() => void)[] = [];
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    wireTranscriptionInterruptionSweep({ on: (_e, l) => { brokenListeners.push(l); } }, brokenRepo);
    expect(() => { for (const listener of brokenListeners) listener(); }).not.toThrow();
    const loggedErrorText = errorSpy.mock.calls.flat(2).map((v) => (v instanceof Error ? v.message : String(v))).join(" ");
    expect(loggedErrorText).not.toContain(canary); // bounded safe descriptor only, never the message
    expect(loggedErrorText).toContain("SQLITE_BUSY");
    errorSpy.mockRestore();
  });
});
