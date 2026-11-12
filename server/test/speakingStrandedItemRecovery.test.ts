import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readBankSet } from "./helpers/setFixtures.js";
import type { DeliveryReport } from "@toefl-prep/shared";
import type Database from "better-sqlite3";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { config } from "../src/lib/config.js";
import {
  createTranscriptionRecovery,
  resetTranscriptionCoordinatorsForNewProcess,
} from "../src/services/transcriptionRecovery.js";
import { EarsError, type hearRecording as realHearRecording } from "../src/services/ears.js";
import type { aggregateSpeaking as realAggregateSpeaking } from "../src/services/arbiter.js";
import type { judgeSpeaking as realJudgeSpeaking } from "../src/services/judges/speaking.js";

// One stranded Speaking Item recovers without damaging its siblings. The shape: a Speaking
// Simulation left `in_progress` with `completed_at` NULL, ten of its eleven Items `scored`, and the
// third Listen and Repeat Item at `transcription_pending` with no transcript and no score. Its
// recording was accepted, and nothing would ever transcribe it.
//
// The test rebuilds that shape in a private `:memory:` database (Ears, the Judges and the Arbiter
// are `vi.fn`s) and drives the durable recovery path, checking two things:
//
//   1. the stranded Item walks transcription_pending -> retry_wait -> awaiting_score -> scored;
//   2. its ten siblings are neither re-scored nor overwritten meanwhile.
//
// The second matters most: one Item's recovery must not heal its siblings to `failed`, or pull them
// into a new paid Judge run that overwrites scores already landed.

// An invented id for the Simulation the shape above describes.
const STRANDED_ATTEMPT_ID = "att-one-stranded-item";
const SPEAKING_SET_ID = "spk-e5b2b735";

const speakingSet = readBankSet("speaking", SPEAKING_SET_ID);

// This Set's Item ids: lr-1..lr-7 and int-1..int-4.
const LR_ITEM_IDS = speakingSet.listenAndRepeat.items.map((i) => i.id);
const INT_ITEM_IDS = speakingSet.interview.questions.map((q) => q.id);
const STRANDED_ITEM_ID = LR_ITEM_IDS[2]; // lr-3 — the item stuck at transcription_pending
const SIBLING_ITEM_IDS = [
  ...LR_ITEM_IDS.filter((id) => id !== STRANDED_ITEM_ID), // lr-1, lr-2, lr-4..lr-7
  ...INT_ITEM_IDS, // int-1..int-4
];

const FIXTURE_WEBM = fs.readFileSync(path.join(import.meta.dirname, "fixtures/tiny.webm"));

const flatDeliveryReport: DeliveryReport = {
  paceWpm: 140,
  pauses: "no notable pauses",
  intelligibility: "clear throughout",
  suspectedMispronunciations: [],
  intonation: "flat",
};

let createdResponseDirs: string[] = [];

afterEach(() => {
  for (const dir of createdResponseDirs) fs.rmSync(dir, { recursive: true, force: true });
  createdResponseDirs = [];
});

function writeRecording(attemptId: string, itemId: string): string {
  const rel = path.join("audio/responses", attemptId, `${itemId}.webm`);
  const abs = path.join(config.dataDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, FIXTURE_WEBM);
  createdResponseDirs.push(path.join(config.dataDir, "audio/responses", attemptId));
  return rel;
}

/**
 * Maps one observed `item_results.scoring_status / transcription_jobs.status` pair onto a lifecycle
 * milestone, or null for an intermediate pair that is none. The two ends of the lifecycle are Item
 * statuses and the two middle milestones job statuses. The job status is checked first, so an Item
 * still at `transcription_pending` under a waiting or replaying job cannot mask them.
 */
function milestoneOf(pair: string): string | null {
  const [itemStatus, jobStatus] = pair.split("/");
  if (jobStatus === "retry_wait") return "retry_wait";
  if (jobStatus === "awaiting_score") return "awaiting_score";
  if (itemStatus === "scored") return "scored";
  if (itemStatus === "transcription_pending") return "transcription_pending";
  return null;
}

describe("one stranded speaking item recovers without damaging its siblings", () => {
  it("walks transcription_pending -> retry_wait -> awaiting_score -> scored and leaves all ten siblings byte-identical", async () => {
    resetTranscriptionCoordinatorsForNewProcess();

    const db = openDb(":memory:") as unknown as Database.Database;
    const baseRepo = sqliteStores(db as never);

    // Lifecycle trace. Every committed transition goes through a store method, so recording after
    // each call yields the full ordered sequence rather than a sample. `awaiting_score` is a window
    // between two store calls (the persist, then the atomic scoring handoff) with no seam visible
    // to the test, so sampling around the public API would miss it.
    const trace: string[] = [];
    const readJobStatus = db.prepare(
      "SELECT status FROM transcription_jobs WHERE attempt_id=? AND item_id=? ORDER BY rowid DESC LIMIT 1",
    );
    const readItemStatus = db.prepare(
      "SELECT scoring_status FROM item_results WHERE attempt_id=? AND item_id=?",
    );
    const record = (): void => {
      const job = readJobStatus.get(STRANDED_ATTEMPT_ID, STRANDED_ITEM_ID) as { status: string } | undefined;
      const item = readItemStatus.get(STRANDED_ATTEMPT_ID, STRANDED_ITEM_ID) as
        | { scoring_status: string }
        | undefined;
      const state = `${item?.scoring_status ?? "-"}/${job?.status ?? "-"}`;
      if (trace[trace.length - 1] !== state) trace.push(state);
    };
    const observedRepo = new Proxy(baseRepo as object, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          record();
          return out;
        };
      },
    }) as typeof baseRepo;

    const hearRecording = vi.fn<typeof realHearRecording>();
    const judgeSpeaking = vi.fn<typeof realJudgeSpeaking>();
    const aggregateSpeaking = vi.fn<typeof realAggregateSpeaking>();
    let currentTime = new Date("2026-07-30T07:04:23.000Z");
    const advance = (ms: number): void => {
      currentTime = new Date(currentTime.getTime() + ms);
    };

    const recovery = createTranscriptionRecovery({
      repo: observedRepo,
      hearRecording,
      judgeSpeaking,
      aggregateSpeaking,
      now: () => currentTime,
      onScoringTerminal: () => {},
    });

    // A Speaking Simulation whose ten other Items have already landed.
    baseRepo.createAttempt({
      id: STRANDED_ATTEMPT_ID,
      kind: "speaking",
      mode: "simulation",
      setId: SPEAKING_SET_ID,
      isRepeat: false,
    });

    const seedSibling = db.prepare(
      `INSERT INTO item_results
         (attempt_id, item_id, task_type, response_audio_path, transcript, score, score_json,
          scoring_status, delivery_report, scored_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'scored', ?, ?, ?)`,
    );
    for (const [index, itemId] of SIBLING_ITEM_IDS.entries()) {
      const taskType = LR_ITEM_IDS.includes(itemId) ? "listen_repeat" : "interview";
      seedSibling.run(
        STRANDED_ATTEMPT_ID,
        itemId,
        taskType,
        path.join("audio/responses", STRANDED_ATTEMPT_ID, `${itemId}.webm`),
        `sibling transcript ${index}`,
        // Distinct scores, so an overwrite by a uniform re-judge run cannot coincidentally match.
        3 + (index % 3) * 0.5,
        JSON.stringify({ itemId, finalScore: 3 + (index % 3) * 0.5, sentinel: `original-${index}` }),
        JSON.stringify(flatDeliveryReport),
        "2026-07-30 07:20:00",
        "2026-07-30 07:10:00",
      );
    }

    const readAllItems = db.prepare("SELECT * FROM item_results WHERE attempt_id=? ORDER BY item_id");
    const siblingsBefore = (readAllItems.all(STRANDED_ATTEMPT_ID) as Record<string, unknown>[]).filter(
      (row) => row.item_id !== STRANDED_ITEM_ID,
    );
    expect(siblingsBefore).toHaveLength(10);
    expect(siblingsBefore.every((row) => row.scoring_status === "scored")).toBe(true);

    // The accepted recording. The first Ears call fails retryably (HTTP 503), leaving the Item at
    // transcription_pending.
    const recordingPath = writeRecording(STRANDED_ATTEMPT_ID, STRANDED_ITEM_ID);
    hearRecording.mockRejectedValueOnce(new EarsError(503, "provider", "provider unavailable (HTTP 503)"));

    const admitted = await recovery.admitRecording({
      attemptId: STRANDED_ATTEMPT_ID,
      itemId: STRANDED_ITEM_ID,
      taskType: "listen_repeat",
      recordingPath,
      mimeType: "audio/webm",
      context: "ctx",
    });
    if (admitted.kind !== "accepted") throw new Error(`expected 'accepted', got ${admitted.kind}`);

    // The recording is durably owned: the Item awaits transcription, the job waits for its retry.
    expect(readItemStatus.get(STRANDED_ATTEMPT_ID, STRANDED_ITEM_ID)).toMatchObject({
      scoring_status: "transcription_pending",
    });
    expect(baseRepo.getTranscriptionJob(admitted.job.jobId)?.status).toBe("retry_wait");

    // The durable replay succeeds. The Judges score only what they are handed, so a request widened
    // to the siblings would show in the assertions below.
    advance(15_000);
    hearRecording.mockResolvedValue({ transcript: "recovered transcript", deliveryReport: flatDeliveryReport });
    judgeSpeaking.mockImplementation(async (
      judgeName: "gemini" | "openai",
      input: { taskType: "listen_repeat" | "interview"; items: { itemId: string }[] },
    ) => ({
      report: {
        judge: judgeName,
        taskType: input.taskType,
        items: input.items.map((it) => ({
          itemId: it.itemId,
          score: 5,
          dimensions: [{ name: "intelligibility", score: 5, evidence: "clear audio" }],
          deductions: [],
        })),
      },
      mode: "audio" as const,
      provider: judgeName === "gemini" ? ("gemini-http" as const) : ("openai-http" as const),
    }));
    aggregateSpeaking.mockImplementation(async (input: Parameters<typeof realAggregateSpeaking>[0]) => ({
      report: {
        taskType: input.taskType,
        items: input.items.map((it) => ({
          itemId: it.itemId,
          ownScore: 5,
          finalScore: 5,
          maxScore: 5,
          dimensions: [{ name: "intelligibility", note: "ok" }],
          deductions: [],
          reconciliationNote: "agreed",
          feedbackZh: "表現不錯。",
        })),
      },
      provider: "claude" as const,
    }));

    await recovery.runDueAndReconcile();
    await vi.waitFor(
      () => {
        expect(readItemStatus.get(STRANDED_ATTEMPT_ID, STRANDED_ITEM_ID)).toMatchObject({
          scoring_status: "scored",
        });
      },
      { timeout: 2_000 },
    );

    // The lifecycle, in order, each milestone once. The whole committed sequence is pinned: every
    // entry was written by a store call, so nothing can happen between two of them, and the
    // ordered-milestone check below adds to the pin rather than filtering out a surprise state.
    //
    //   -/queued                           job row created, no Item row yet
    //   -/running                          claimed for its first attempt
    //   transcription_pending/running      Item row written at claim, so a crash is recoverable
    //   transcription_pending/retry_wait   Ears 503: retryable, durable retry armed
    //   transcription_pending/running      the durable replay claims the same job
    //   pending/awaiting_score             transcript persisted; job waits for the scoring handoff
    //   pending/done                       atomic handoff: job done, one scoring job queued
    //   scored/done                        that scoring job landed
    expect(trace).toEqual([
      "-/queued",
      "-/running",
      "transcription_pending/running",
      "transcription_pending/retry_wait",
      "transcription_pending/running",
      "pending/awaiting_score",
      "pending/done",
      "scored/done",
    ]);

    // The four milestones as an ordered subsequence of that trace. The Item re-enters
    // `transcription_pending` while the replay runs, so this is not an equality; the exact pin
    // above already rules out anything else.
    const CANONICAL = ["transcription_pending", "retry_wait", "awaiting_score", "scored"] as const;
    const firstIndexOf = (milestone: string): number =>
      trace.findIndex((pair) => milestoneOf(pair) === milestone);
    const indices = CANONICAL.map(firstIndexOf);
    expect(indices.every((i) => i >= 0)).toBe(true); // all four milestones occurred
    for (let i = 1; i < indices.length; i += 1) {
      expect(indices[i]).toBeGreaterThan(indices[i - 1]); // in order
    }

    // The recovered Item is complete, not merely labelled so.
    const recoveredJob = baseRepo.getTranscriptionJob(admitted.job.jobId)!;
    expect(recoveredJob.status).toBe("done");
    expect(recoveredJob.score_job_id).not.toBeNull();
    const recoveredItem = readAllItems
      .all(STRANDED_ATTEMPT_ID)
      .find((r) => (r as Record<string, unknown>).item_id === STRANDED_ITEM_ID) as Record<string, unknown>;
    expect(recoveredItem.transcript).toBe("recovered transcript");
    expect(recoveredItem.score).not.toBeNull();

    // The siblings. Not overwritten: every column of all ten sibling rows is unchanged. That covers
    // score, score_json, transcript, scoring_status, scored_at and delivery_report at once, so an
    // orphan heal to `failed` or a silent re-score would both fail here.
    const siblingsAfter = (readAllItems.all(STRANDED_ATTEMPT_ID) as Record<string, unknown>[]).filter(
      (row) => row.item_id !== STRANDED_ITEM_ID,
    );
    expect(siblingsAfter).toEqual(siblingsBefore);

    // Not re-scored: no sibling reached a Judge or the Arbiter. A re-judge that happened to produce
    // the same numbers would still be a second paid run, which a value comparison cannot catch.
    const judgedItemIds = new Set<string>();
    for (const call of judgeSpeaking.mock.calls) {
      for (const item of (call[1] as { items: { itemId: string }[] }).items) judgedItemIds.add(item.itemId);
    }
    for (const call of aggregateSpeaking.mock.calls) {
      for (const item of (call[0] as { items: { itemId: string }[] }).items) judgedItemIds.add(item.itemId);
    }
    expect([...judgedItemIds]).toEqual([STRANDED_ITEM_ID]);

    // Recovery touched one Item: one transcription job for the Attempt, and one scoring job whose
    // Items are exactly the stranded one.
    const jobRows = db
      .prepare("SELECT item_id FROM transcription_jobs WHERE attempt_id=?")
      .all(STRANDED_ATTEMPT_ID) as { item_id: string }[];
    expect(jobRows.map((r) => r.item_id)).toEqual([STRANDED_ITEM_ID]);

    const scoringJobs = db
      .prepare("SELECT id, item_ids FROM scoring_jobs WHERE attempt_id=?")
      .all(STRANDED_ATTEMPT_ID) as { id: string; item_ids: string }[];
    expect(scoringJobs).toHaveLength(1);
    expect(JSON.parse(scoringJobs[0].item_ids)).toEqual([STRANDED_ITEM_ID]);

    // One Ears call per run of the stranded Item, and none for any sibling.
    expect(hearRecording).toHaveBeenCalledTimes(2); // the 503, then the successful replay
  });
});
