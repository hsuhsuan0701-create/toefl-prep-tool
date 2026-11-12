import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryReport, EarsResult } from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import { createSqliteStores } from "../src/db/stores/index.js";
import { config } from "../src/lib/config.js";
import { jobFamilyShutdown } from "../src/index.js";
import { EarsError, type hearRecording as realHearRecording } from "../src/services/ears.js";
import { resetJobAdmissionsForTests } from "../src/services/jobCancellation.js";
import { runShutdownProtocol } from "../src/services/shutdownCoordinator.js";
import {
  createTranscriptionRecovery,
  INTERRUPTED_BY_RESTART_ERROR,
  TranscriptionExecutionUnavailable,
} from "../src/services/transcriptionRecovery.js";
import { deferred } from "./helpers/deferred.js";
import { fakeMedia } from "./helpers/fakeMedia.js";
import { readBankSet } from "./helpers/setFixtures.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// A graceful shutdown (Ctrl-C, or `npm run dev` restarting on a save) treats transcription like the
// other two job families: no Ears call starts once admissions close, the drain waits for the calls
// already running, and one still running when the drain ends is recorded as interrupted, where the
// User can Retry it, rather than left 'running' for the next boot to fail. Driven through index.ts's
// own shutdown wiring, the real coordinator and the real SQLite stores, with an Ears call held open.

const SPEAKING_SET_ID = "spk-e5b2b735";
const itemId = readBankSet("speaking", SPEAKING_SET_ID).listenAndRepeat.items[0].id;
const FIXTURE_WEBM = fs.readFileSync(path.join(import.meta.dirname, "fixtures/tiny.webm"));
const deliveryReport: DeliveryReport = {
  paceWpm: 120, pauses: "none", intelligibility: "clear", suspectedMispronunciations: [], intonation: "flat",
};

const createdDirs: string[] = [];
afterEach(() => {
  resetJobAdmissionsForTests();
  for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const db = openDb(":memory:");
  const stores = createSqliteStores(db);
  const repo = sqliteStores(db);
  let currentTime = new Date("2026-11-12T00:00:00.000Z");
  const hearRecording = vi.fn<typeof realHearRecording>();
  const recovery = createTranscriptionRecovery({
    repo,
    hearRecording,
    judgeSpeaking: vi.fn(),
    aggregateSpeaking: vi.fn(),
    probeDurationSec: fakeMedia.probeDurationSec,
    now: () => currentTime,
    onScoringTerminal: () => {},
    // The execution owner stays ready through a graceful drain; only admissions close.
    admissionReady: () => true,
  });
  const shutdown = (drainMs: number) =>
    runShutdownProtocol({
      ...jobFamilyShutdown(stores, recovery),
      flushRecorder: () => undefined,
      drainMs,
      recorderFlushMs: 10,
      pollMs: 5,
    });
  return { repo, recovery, hearRecording, shutdown, advance: (ms: number) => { currentTime = new Date(currentTime.getTime() + ms); } };
}

function recordingFor(repo: ReturnType<typeof sqliteStores>, attemptId: string): string {
  repo.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
  const rel = path.join("audio/responses", attemptId, `${itemId}.webm`);
  fs.mkdirSync(path.dirname(path.join(config.dataDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(config.dataDir, rel), FIXTURE_WEBM);
  createdDirs.push(path.join(config.dataDir, "audio/responses", attemptId));
  return rel;
}

// An Ears call that answers only when the test says so, and rejects when its signal aborts, as
// fetch does.
function holdEars(hearRecording: ReturnType<typeof harness>["hearRecording"]) {
  const started = deferred<void>();
  const answer = deferred<EarsResult>();
  hearRecording.mockImplementation((input) => {
    started.resolve();
    return new Promise<EarsResult>((resolve, reject) => {
      input.signal?.addEventListener("abort", () => reject(input.signal?.reason), { once: true });
      void answer.promise.then(resolve);
    });
  });
  return { started: started.promise, answer: answer.resolve };
}

describe("shutdown and transcription", () => {
  it("drains an Ears call already running and persists its transcript", async () => {
    const { repo, recovery, hearRecording, shutdown } = harness();
    const rel = recordingFor(repo, "att-drain");
    const ears = holdEars(hearRecording);

    const admission = recovery.admitRecording({ attemptId: "att-drain", itemId, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" });
    await ears.started;

    let drained = false;
    const protocol = shutdown(5_000).then(() => { drained = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The drain is waiting on the call, not exiting under it.
    expect(drained).toBe(false);

    ears.answer({ transcript: "finished during the drain", deliveryReport });
    await protocol;
    await expect(admission).resolves.toMatchObject({ kind: "transcribed", transcript: "finished during the drain" });
    expect(repo.getCurrentTranscriptionJobs("att-drain")[0]).toMatchObject({ status: "done" });
    expect(repo.getAttempt("att-drain")!.items[0]).toMatchObject({ transcript: "finished during the drain", scoring_status: "pending" });
  });

  it("records a call still running when the drain ends as interrupted and retryable, never 'running'", async () => {
    const { repo, recovery, hearRecording, shutdown } = harness();
    const rel = recordingFor(repo, "att-interrupted");
    const ears = holdEars(hearRecording);

    const admission = recovery.admitRecording({ attemptId: "att-interrupted", itemId, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" });
    const rejected = expect(admission).rejects.toBeInstanceOf(TranscriptionExecutionUnavailable);
    await ears.started;

    await shutdown(30);
    await rejected;

    // The call was aborted, not left to finish after the process has gone.
    const call = hearRecording.mock.calls[0]![0];
    expect(call.signal?.aborted).toBe(true);
    const [job] = repo.getCurrentTranscriptionJobs("att-interrupted");
    expect(job).toMatchObject({ status: "failed", failure_kind: "provider", error: INTERRUPTED_BY_RESTART_ERROR, next_retry_at: null });
    expect(repo.getAttempt("att-interrupted")!.items[0]).toMatchObject({ scoring_status: "transcription_pending", transcript: null });
  });

  it("starts no Ears call once admissions close, from the retry timer or from a Retry", async () => {
    const { repo, recovery, hearRecording, shutdown, advance } = harness();
    const rel = recordingFor(repo, "att-waiting");
    hearRecording.mockRejectedValueOnce(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));
    const admitted = await recovery.admitRecording({ attemptId: "att-waiting", itemId, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" });
    expect(admitted).toMatchObject({ kind: "accepted", job: { status: "retry_wait" } });
    expect(hearRecording).toHaveBeenCalledTimes(1);

    await shutdown(30);
    advance(60_000);
    // What the timer runs once the retry is due.
    await recovery.runDueAndReconcile();

    expect(hearRecording).toHaveBeenCalledTimes(1);
    expect(repo.getCurrentTranscriptionJobs("att-waiting")[0]).toMatchObject({ status: "retry_wait" });
    await expect(recovery.admitRecording({ attemptId: "att-waiting", itemId, taskType: "listen_repeat", recordingPath: rel, mimeType: "audio/webm", context: "ctx" }))
      .rejects.toBeInstanceOf(TranscriptionExecutionUnavailable);
  });
});
