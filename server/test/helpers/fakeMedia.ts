import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { TranscodeError } from "../../src/services/transcode.js";

/**
 * In-process stand-ins for services/transcode.ts's ffmpeg and ffprobe calls.
 *
 * A route test that uploads a recording would otherwise spawn two real processes per upload, and
 * routes.attempts.test.ts uploads many times; each spawn is a wall-clock cost that grows with
 * machine load until a test misses its timeout. transcode.test.ts is the one suite that runs the
 * real binaries, and it also checks that these fakes answer what the real ones do for every
 * recording they know.
 */

const FIXTURES = path.join(import.meta.dirname, "../fixtures");

/** What real ffprobe reports for the recordings under test/fixtures. */
export const FIXTURE_DURATIONS_SEC: Readonly<Record<string, number>> = {
  "tiny.webm": 0.208,
  "three-sec.webm": 3.008,
};

const sha256 = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");

const durationByContent = new Map(
  Object.entries(FIXTURE_DURATIONS_SEC).map(([name, seconds]) => [
    sha256(fs.readFileSync(path.join(FIXTURES, name))),
    seconds,
  ]),
);

// Every WebM file opens with the EBML magic number. It is what ffmpeg's demuxer probes first, and
// arbitrary bytes fail there ("EBML header parsing failed"), which is the rejection the corrupt
// upload tests rely on.
const EBML_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);

/** Accepts a WebM container and writes a stand-in mp3 beside it; refuses anything else, as ffmpeg does. */
export async function fakeTranscode(webmPath: string, mp3Path: string): Promise<void> {
  const bytes = fs.readFileSync(webmPath);
  if (!bytes.subarray(0, EBML_MAGIC.length).equals(EBML_MAGIC)) {
    throw new TranscodeError("fake ffmpeg: EBML header parsing failed");
  }
  fs.writeFileSync(mp3Path, `fake mp3 transcoded from ${sha256(bytes)}`);
}

/**
 * Reads the file at `filePath` (so a wrong path still fails the way ffprobe would) and answers the
 * duration real ffprobe reports for that recording. Content it does not know is refused, the way
 * ffprobe refuses a file it cannot read a duration from.
 */
export async function fakeProbeDurationSec(filePath: string): Promise<number> {
  const seconds = durationByContent.get(sha256(fs.readFileSync(filePath)));
  if (seconds === undefined) throw new TranscodeError(`fake ffprobe: no known duration for ${filePath}`);
  return seconds;
}

/** The seams intake and the attempt routes accept, filled with the fakes above. */
export const fakeMedia = { transcode: fakeTranscode, probeDurationSec: fakeProbeDurationSec };
