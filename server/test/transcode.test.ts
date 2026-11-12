import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  transcodeWebmToMp3,
  probeDurationSec,
  probeSpeechDurationSec,
  speechDurationFrom,
  TranscodeError,
} from "../src/services/transcode.js";
import { assessPace } from "../src/services/audioPace.js";
import { classifyGenerationCheck } from "../src/services/generationCheckPolicy.js";
import { FIXTURE_DURATIONS_SEC, fakeProbeDurationSec, fakeTranscode } from "./helpers/fakeMedia.js";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/tiny.webm");

let tmpDir: string | undefined;
afterEach(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = undefined;
});

function tmpPath(name: string): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcode-test-"));
  return path.join(tmpDir, name);
}

describe("transcodeWebmToMp3", () => {
  it("transcodes the tiny fixture to a real mp3 file on disk", async () => {
    const out = tmpPath("out.mp3");
    await transcodeWebmToMp3(FIXTURE, out);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.statSync(out).size).toBeGreaterThan(0);
  });

  it("overwrites an existing mp3 (re-transcode is idempotent, no -y prompt hang)", async () => {
    const out = tmpPath("out.mp3");
    await transcodeWebmToMp3(FIXTURE, out);
    const firstSize = fs.statSync(out).size;
    await transcodeWebmToMp3(FIXTURE, out);
    expect(fs.statSync(out).size).toBe(firstSize);
  });

  it("rejects with TranscodeError on a non-existent input file", async () => {
    const out = tmpPath("out.mp3");
    await expect(transcodeWebmToMp3(path.join(os.tmpdir(), "does-not-exist.webm"), out)).rejects.toBeInstanceOf(
      TranscodeError
    );
  });
});

describe("probeDurationSec", () => {
  it("returns a positive duration for the tiny fixture", async () => {
    const sec = await probeDurationSec(FIXTURE);
    expect(sec).toBeGreaterThan(0);
  });

  it("rejects with TranscodeError on a non-existent file", async () => {
    await expect(probeDurationSec(path.join(os.tmpdir(), "does-not-exist.webm"))).rejects.toBeInstanceOf(
      TranscodeError
    );
  });
});

// `speechDurationFrom` is the parsing half of probeSpeechDurationSec, split out so the rule can be
// tested without a subprocess. The rule: remove silence that touches an edge, keep everything
// interior, and fall back to the full file duration only when nothing usable was measured.
describe("speechDurationFrom", () => {
  // A real ffmpeg run, from data/audio/stimuli/spk-7546a04e/lr-6.mp3: 5.976 s of file holding
  // 0.283 s of leading and 0.425 s of trailing silence around 5.268 s of speech, plus seven interior
  // pauses that must all survive.
  const REAL_STDERR = [
    "[silencedetect @ 0x1] silence_start: 0",
    "[silencedetect @ 0x1] silence_end: 0.282917 | silence_duration: 0.282917",
    "[silencedetect @ 0x1] silence_start: 1.958583",
    "[silencedetect @ 0x1] silence_end: 2.129917 | silence_duration: 0.171333",
    "[silencedetect @ 0x1] silence_start: 4.75675",
    "[silencedetect @ 0x1] silence_end: 4.882833 | silence_duration: 0.126083",
    "[silencedetect @ 0x1] silence_start: 5.551208",
    "[silencedetect @ 0x1] silence_end: 5.976 | silence_duration: 0.424792",
  ].join("\n");

  it("removes both edges and keeps every interior pause", () => {
    expect(speechDurationFrom(REAL_STDERR, 5.976)).toBeCloseTo(5.268, 3);
  });

  it("removes only the leading pad when the clip ends on speech", () => {
    const stderr = "silence_start: 0\nsilence_end: 0.32\nsilence_start: 1.5\nsilence_end: 1.7";
    expect(speechDurationFrom(stderr, 3.0)).toBeCloseTo(2.68, 3);
  });

  it("removes only the trailing pad when the clip opens on speech", () => {
    const stderr = "silence_start: 2.6\nsilence_end: 3.0";
    expect(speechDurationFrom(stderr, 3.0)).toBeCloseTo(2.6, 3);
  });

  it("returns the file duration when ffmpeg found no silence at all", () => {
    expect(speechDurationFrom("", 2.5)).toBe(2.5);
  });

  // A take that is mostly silence, of about the length its text should take, is the case that
  // matters on a paid path. Given its file duration it reads as in-band speech and publishes. Given
  // the speech it holds, it reads fast: out of band, which buys a corrective take (repair, then
  // accept), or a malfunction when almost nothing was spoken.
  it("measures a clip that is mostly edge silence as the speech it holds, so its pace check fails", () => {
    const band = { targetWpm: 162, minWpm: 150, maxWpm: 175 };
    const words = 20;
    const fileSec = (words / band.targetWpm) * 60; // 7.41 s: exactly the length 20 words should take
    const stderr = `silence_start: 0\nsilence_end: 0.3\nsilence_start: 3.5\nsilence_end: ${fileSec.toFixed(3)}`;

    const speechSec = speechDurationFrom(stderr, fileSec);

    expect(speechSec).toBeCloseTo(3.2, 2);
    const assessment = assessPace({ wordCount: words, durationSec: speechSec, band });
    expect(assessment.verdict).toBe("out-of-band");
    expect(classifyGenerationCheck({ family: "audio-pace", section: "listening", verdict: assessment.verdict }))
      .toEqual({ tier: "repair-then-accept", unrepaired: "advisory" });
  });

  it("measures a clip with no speech at all as 0, which its pace check calls a malfunction", () => {
    const stderr = "silence_start: 0\nsilence_end: 3.0 | silence_duration: 3.0";
    expect(speechDurationFrom(stderr, 3.0)).toBe(0);
    expect(assessPace({ wordCount: 8, durationSec: 0, band: { targetWpm: 162, minWpm: 150, maxWpm: 175 } }).verdict)
      .toBe("malfunction");
  });

  it("passes a non-positive or non-finite file duration straight through", () => {
    expect(speechDurationFrom(REAL_STDERR, 0)).toBe(0);
    expect(Number.isNaN(speechDurationFrom(REAL_STDERR, Number.NaN))).toBe(true);
  });

  it("ignores an unparseable timestamp rather than producing NaN", () => {
    expect(speechDurationFrom("silence_start: 0\nsilence_end: not-a-number", 2.0)).toBe(2.0);
  });
});

describe("probeSpeechDurationSec", () => {
  it("measures a real file and never exceeds its full duration", async () => {
    const mp3 = tmpPath("speech.mp3");
    await transcodeWebmToMp3(FIXTURE, mp3);
    const [speech, file] = await Promise.all([probeSpeechDurationSec(mp3), probeDurationSec(mp3)]);
    expect(speech).toBeGreaterThan(0);
    expect(speech).toBeLessThanOrEqual(file);
  });

  // An unreadable clip is unmeasurable, and says so: a resolved 0 would read as a measurement, and the
  // render would report a "truncated or stuck synthesis" that never happened. A first take that
  // cannot be measured fails the render, as a malfunctioning one does, and a corrective take that
  // cannot be measured is discarded for the best take so far.
  it("rejects with TranscodeError when the file cannot be read", async () => {
    await expect(
      probeSpeechDurationSec(path.join(os.tmpdir(), "no-such-clip.mp3")),
    ).rejects.toThrow(/ffprobe failed to read duration/);
  });
});

// The in-process fakes every other suite uses instead of these binaries (helpers/fakeMedia.ts) are
// only as good as their agreement with the real ones, and this is the one suite that runs both.
describe("the fakes other suites use stand in for ffmpeg and ffprobe faithfully", () => {
  const fixture = (name: string) => path.resolve(import.meta.dirname, "fixtures", name);

  it("answers the duration real ffprobe reports for every recording it knows", async () => {
    for (const [name, seconds] of Object.entries(FIXTURE_DURATIONS_SEC)) {
      expect(await probeDurationSec(fixture(name)), name).toBeCloseTo(seconds, 3);
      expect(await fakeProbeDurationSec(fixture(name)), name).toBe(seconds);
    }
  });

  it("accepts the recordings real ffmpeg accepts and refuses the bytes it refuses", async () => {
    const dir = path.dirname(tmpPath("scratch"));
    for (const name of Object.keys(FIXTURE_DURATIONS_SEC)) {
      await expect(transcodeWebmToMp3(fixture(name), path.join(dir, `${name}.real.mp3`)), name).resolves.toBeUndefined();
      await expect(fakeTranscode(fixture(name), path.join(dir, `${name}.fake.mp3`)), name).resolves.toBeUndefined();
    }
    // The shape of the corrupt-upload route tests: past the size floor, but no WebM container.
    const garbage = path.join(dir, "garbage.webm");
    fs.writeFileSync(garbage, crypto.webcrypto.getRandomValues(new Uint8Array(600)));
    await expect(transcodeWebmToMp3(garbage, `${garbage}.real.mp3`)).rejects.toBeInstanceOf(TranscodeError);
    await expect(fakeTranscode(garbage, `${garbage}.fake.mp3`)).rejects.toBeInstanceOf(TranscodeError);
  });
});
