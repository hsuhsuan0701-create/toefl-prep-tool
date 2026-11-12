import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/db.js";
import { createSqliteRecordingStore } from "../src/db/stores/transcription.js";
import { intakeRecording } from "../src/services/recordingIntake.js";

// A recording intake refused for closed admissions (a server draining for shutdown, or one that has
// lost execution ownership) must leave the canonical take on disk exactly as the database still
// describes it. Driven at the intake seam with a fake transcoder, so no ffmpeg is spawned; the
// staging and renames run against a real temp directory because they are the behavior under test.

const ATTEMPT = "att-1";
const ITEM = "lr-1";

describe("recording intake with admissions closed", () => {
  let dataDir: string;
  let dir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "intake-admission-"));
    dir = path.join(dataDir, "audio/responses", ATTEMPT);
    fs.mkdirSync(dir, { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a re-record without touching the take already published for the Item", async () => {
    const webm = path.join(dir, `${ITEM}.webm`);
    const mp3 = path.join(dir, `${ITEM}.mp3`);
    fs.writeFileSync(webm, "take one webm");
    fs.writeFileSync(mp3, "take one mp3");
    const store = createSqliteRecordingStore(openDb(":memory:"));
    const admitRecording = vi.fn();
    const intake = (admissionsAreOpen: boolean) => intakeRecording(
      {
        store,
        transcriptionRecovery: { admitRecording },
        dataDir,
        transcode: async (_webm, mp3Path) => { fs.writeFileSync(mp3Path, "take two mp3"); },
        probeDurationSec: async () => 3,
        admissionsAreOpen: () => admissionsAreOpen,
      },
      { attemptId: ATTEMPT, itemId: ITEM, taskType: "listen_repeat", context: "ctx", bytes: new TextEncoder().encode("take two webm") },
    );

    expect(await intake(false)).toEqual({ outcome: "unavailable" });
    expect(fs.readFileSync(webm, "utf8")).toBe("take one webm");
    expect(fs.readFileSync(mp3, "utf8")).toBe("take one mp3");
    expect(fs.readdirSync(dir).sort()).toEqual([`${ITEM}.mp3`, `${ITEM}.webm`]);
    expect(admitRecording).not.toHaveBeenCalled();
    // The refusal released the Item's publication lock: the next upload is not turned away as busy.
    admitRecording.mockResolvedValue({ kind: "accepted", job: { jobId: "j" } });
    expect(await intake(true)).toMatchObject({ outcome: "transcription-pending" });
  });
});
