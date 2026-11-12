import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryReport, TranscriptionJobVM } from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import {
  intakeRecording,
  type RecordingIntakeOutcome,
  type RecordingStore,
} from "../src/services/recordingIntake.js";
import { TranscodeError } from "../src/services/transcode.js";
import {
  TranscriptionAdmissionSuperseded,
  TranscriptionExecutionUnavailable,
  type AdmitRecordingInput,
  type AdmitRecordingResult,
} from "../src/services/transcriptionRecovery.js";
import { deferred } from "./helpers/deferred.js";

// Recording intake over the real recording store, a fake admission and a fake transcoder: no HTTP,
// no ffmpeg, no Ears. The three conflict semantics and the per-Item publication lock are observable
// without any of the machinery intake normally runs inside. A real temp directory is used because
// staging and the two canonical renames are the behavior under test.

const ATTEMPT = "att-1";
const ITEM = "lr-1";
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

const deliveryReport: DeliveryReport = {
  paceWpm: 140,
  pauses: "no notable pauses",
  intelligibility: "clear throughout",
  suspectedMispronunciations: [],
  intonation: "flat",
};

// The real recording store. `supersededHashes` are takes a later re-record replaced: each gets a
// transcription job, and a newer job for the same Item supersedes it.
function realStore(options: { supersededHashes?: string[] } = {}): RecordingStore {
  const stores = sqliteStores(openDb(":memory:"));
  stores.createAttempt({ id: ATTEMPT, kind: "speaking", mode: "simulation", setId: "spk-1", isRepeat: false });
  const audioPath = path.join("audio/responses", ATTEMPT, `${ITEM}.webm`);
  for (const [i, sha] of [...(options.supersededHashes ?? []), ...(options.supersededHashes?.length ? ["f".repeat(64)] : [])].entries()) {
    stores.createOrGetTranscriptionJob({ id: `job-${i}`, attemptId: ATTEMPT, itemId: ITEM, taskType: "listen_repeat", audioPath, audioSha256: sha, now: `2026-08-01 00:00:0${i}` });
  }
  return stores;
}

function admissionReturning(result: AdmitRecordingResult | Error) {
  const admitRecording = vi.fn(async (_input: AdmitRecordingInput) => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { admitRecording };
}

const acceptedJob = { id: "job-1", status: "queued" } as unknown as TranscriptionJobVM;

describe("recordingIntake", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-"));
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const responsesDir = () => path.join(dataDir, "audio/responses", ATTEMPT);

  // A transcoder that just writes a plausible mp3 next to the staged webm, like the real one does.
  const okTranscode = async (_webm: string, mp3: string) => { fs.writeFileSync(mp3, "mp3"); };

  async function run(
    overrides: Partial<Parameters<typeof intakeRecording>[0]> & { store: RecordingStore },
    itemId = ITEM,
  ): Promise<RecordingIntakeOutcome> {
    return intakeRecording(
      {
        transcriptionRecovery: admissionReturning({ kind: "transcribed", transcript: "hi", deliveryReport }),
        dataDir,
        transcode: okTranscode,
        probeDurationSec: async () => 3,
        ...overrides,
      },
      { attemptId: ATTEMPT, itemId, taskType: "listen_repeat", context: "ctx", bytes: BYTES },
    );
  }

  // The Item's publication lock is free again: a fresh upload of it is not turned away as busy.
  async function expectLockReleased(store: RecordingStore): Promise<void> {
    expect(await run({ store })).not.toEqual({ outcome: "conflict", conflict: "publication-in-progress" });
  }

  it("publishes the canonical webm/mp3 pair, hands a dataDir-RELATIVE path to admission, and reports the transcript", async () => {
    const store = realStore();
    const admission = admissionReturning({ kind: "transcribed", transcript: "the bus leaves at nine", deliveryReport });

    const outcome = await run({ store, transcriptionRecovery: admission });

    expect(outcome).toEqual({
      outcome: "transcribed",
      transcript: "the bus leaves at nine",
      deliveryReport,
      durationSec: 3,
    });
    expect(fs.readdirSync(responsesDir()).sort()).toEqual([`${ITEM}.mp3`, `${ITEM}.webm`]);
    expect(admission.admitRecording.mock.calls[0][0].recordingPath).toBe(path.join("audio/responses", ATTEMPT, `${ITEM}.webm`));
    expect(path.isAbsolute(admission.admitRecording.mock.calls[0][0].recordingPath)).toBe(false);
    // The lock is always released, success or not: nothing may be left holding this (attempt,item).
    await expectLockReleased(store);
  });

  it("a duration probe failure degrades to durationSec: null rather than failing a good upload", async () => {
    const store = realStore();

    const outcome = await run({ store, probeDurationSec: async () => { throw new Error("ffprobe missing"); } });

    expect(outcome).toEqual({ outcome: "transcribed", transcript: "hi", deliveryReport, durationSec: null });
  });

  it("an admission that only ACCEPTS the recording is 'transcription-pending' with its job, not a failure", async () => {
    const store = realStore();

    const outcome = await run({ store, transcriptionRecovery: admissionReturning({ kind: "accepted", job: acceptedJob }) });

    expect(outcome).toEqual({ outcome: "transcription-pending", job: acceptedJob });
    expect(fs.readdirSync(responsesDir()).sort()).toEqual([`${ITEM}.mp3`, `${ITEM}.webm`]);
  });

  describe("transcode", () => {
    it("a TranscodeError is 'unusable-recording', leaves no temp files, and never reaches admission or the lock", async () => {
      const store = realStore();
      const admission = admissionReturning({ kind: "transcribed", transcript: "hi", deliveryReport });

      const outcome = await run({
        store,
        transcriptionRecovery: admission,
        transcode: async () => { throw new TranscodeError("not audio"); },
      });

      expect(outcome).toEqual({ outcome: "unusable-recording" });
      expect(fs.readdirSync(responsesDir())).toEqual([]);
      expect(admission.admitRecording).not.toHaveBeenCalled();
      await expectLockReleased(store);
    });

    it("an UNCLASSIFIED transcoder fault propagates instead of being reported as one of the outcomes", async () => {
      const store = realStore();

      await expect(
        run({ store, transcode: async () => { throw new Error("spawn EACCES"); } }),
      ).rejects.toThrow("spawn EACCES");
      expect(fs.readdirSync(responsesDir())).toEqual([]);
    });
  });

  describe("the three conflict semantics", () => {
    it("publication-in-progress: a second upload of the same Item while the first is still publishing is refused, with nothing of it published", async () => {
      const store = realStore();
      const firstAdmitted = deferred<AdmitRecordingResult>();
      const first = run({ store, transcriptionRecovery: { admitRecording: () => firstAdmitted.promise } });
      // The first upload is inside admission, holding the Item's lock, its pair already renamed.
      await vi.waitFor(() => expect(fs.readdirSync(responsesDir()).sort()).toEqual([`${ITEM}.mp3`, `${ITEM}.webm`]));
      const secondAdmission = admissionReturning({ kind: "transcribed", transcript: "must not run", deliveryReport });

      const second = await run({ store, transcriptionRecovery: secondAdmission });

      expect(second).toEqual({ outcome: "conflict", conflict: "publication-in-progress" });
      expect(secondAdmission.admitRecording).not.toHaveBeenCalled();
      // The second upload's staged files are gone; only the first's canonical pair is on disk.
      expect(fs.readdirSync(responsesDir()).sort()).toEqual([`${ITEM}.mp3`, `${ITEM}.webm`]);

      firstAdmitted.resolve({ kind: "transcribed", transcript: "first take", deliveryReport });
      expect(await first).toMatchObject({ outcome: "transcribed", transcript: "first take" });
      await expectLockReleased(store);
    });

    it("the lock is per Item: another Item of the same Attempt publishes while the first is still in admission", async () => {
      const store = realStore();
      const firstAdmitted = deferred<AdmitRecordingResult>();
      const first = run({ store, transcriptionRecovery: { admitRecording: () => firstAdmitted.promise } });
      await vi.waitFor(() => expect(fs.readdirSync(responsesDir())).toContain(`${ITEM}.webm`));

      expect(await run({ store }, "lr-2")).toMatchObject({ outcome: "transcribed" });

      firstAdmitted.resolve({ kind: "transcribed", transcript: "first take", deliveryReport });
      await first;
    });

    it("superseded-recording: a replayed hash is refused BEFORE either canonical rename", async () => {
      // The hash is taken off the staged webm, so a byte-identical replay of a superseded take is
      // recognised without ever consulting the canonical pair.
      const stagedSha = crypto.createHash("sha256").update(BYTES).digest("hex");
      const store = realStore({ supersededHashes: [stagedSha] });
      const asked = vi.spyOn(store, "isSupersededTranscriptionHash");
      const admission = admissionReturning({ kind: "transcribed", transcript: "must not run", deliveryReport });

      const outcome = await run({ store, transcriptionRecovery: admission });

      expect(outcome).toEqual({ outcome: "conflict", conflict: "superseded-recording" });
      expect(asked.mock.calls[0][0]).toEqual({ attemptId: ATTEMPT, itemId: ITEM, audioSha256: stagedSha });
      expect(admission.admitRecording).not.toHaveBeenCalled();
      // No canonical pair was ever written, and no staged file survives.
      expect(fs.readdirSync(responsesDir())).toEqual([]);
    });

    it("superseded-admission: publication succeeded, then admission lost the race to a newer take", async () => {
      const store = realStore();

      const outcome = await run({
        store,
        transcriptionRecovery: admissionReturning(new TranscriptionAdmissionSuperseded("newer recording won")),
      });

      expect(outcome).toEqual({ outcome: "conflict", conflict: "superseded-admission" });
      // Distinguishes it from superseded-recording: the canonical pair IS published here.
      expect(fs.readdirSync(responsesDir()).sort()).toEqual([`${ITEM}.mp3`, `${ITEM}.webm`]);
      await expectLockReleased(store);
    });
  });

  describe("unavailability", () => {
    it("closed job admissions answer 'unavailable' without calling admission", async () => {
      const store = realStore();
      const admission = admissionReturning({ kind: "transcribed", transcript: "must not run", deliveryReport });

      const outcome = await run({ store, transcriptionRecovery: admission, admissionsAreOpen: () => false });

      expect(outcome).toEqual({ outcome: "unavailable" });
      expect(admission.admitRecording).not.toHaveBeenCalled();
      await expectLockReleased(store);
    });

    it("TranscriptionExecutionUnavailable from admission answers 'unavailable' too — the endpoint's second 503 source", async () => {
      const store = realStore();

      const outcome = await run({
        store,
        transcriptionRecovery: admissionReturning(new TranscriptionExecutionUnavailable()),
      });

      expect(outcome).toEqual({ outcome: "unavailable" });
    });

    it("an unexpected admission fault propagates rather than being flattened into a conflict", async () => {
      const store = realStore();

      await expect(
        run({ store, transcriptionRecovery: admissionReturning(new Error("SQLITE_BUSY")) }),
      ).rejects.toThrow("SQLITE_BUSY");
      // The finally block still ran: no leftover temp files, and no stranded lock.
      expect(fs.readdirSync(responsesDir()).sort()).toEqual([`${ITEM}.mp3`, `${ITEM}.webm`]);
      await expectLockReleased(store);
    });
  });
});
