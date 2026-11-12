/**
 * The audio files behind the demo's spoken Responses. The review page plays each recording from
 * `audio/responses/<attemptId>/<itemId>.webm`, so every recorded Item gets a real, short, playable
 * file: a quiet tone with soft edges for a Response, silence for the one with no speech. Not a voice:
 * the demo has no recordings of anyone.
 *
 * Synthesized with ffmpeg when it is on PATH, with bit-exact flags so the bytes, and the sha256 the
 * transcription jobs record for them, are the same on every run with the same ffmpeg. Without ffmpeg
 * the rows are written the same way and the files are simply absent: the page's player then has
 * nothing to load and shows no playable audio, and everything else on the page is unaffected.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type DemoRecordings = {
  /** A Listen and Repeat Response: about four seconds. */
  sentence: Buffer;
  /** An Interview answer: about forty seconds. */
  answer: Buffer;
  /** A recording with no speech in it. */
  silence: Buffer;
};

function synthesize(ffmpeg: string, dir: string, name: string, source: string, filter: string | null): Buffer | null {
  const out = path.join(dir, `${name}.webm`);
  const result = spawnSync(
    ffmpeg,
    [
      "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", source,
      ...(filter ? ["-af", filter] : []),
      "-c:a", "libopus", "-b:a", "24k",
      "-fflags", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1",
      "-y", out,
    ],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0 || !fs.existsSync(out)) return null;
  return fs.readFileSync(out);
}

/**
 * The three clips, or null when ffmpeg is missing or cannot encode Opus. `ffmpeg` overrides the
 * binary looked up on PATH.
 */
export function synthesizeRecordings(ffmpeg = "ffmpeg"): DemoRecordings | null {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toefl-demo-audio-"));
  try {
    const tone = (seconds: number) =>
      [`sine=frequency=220:sample_rate=48000:duration=${seconds}`, `volume=0.08,afade=t=in:d=0.4,afade=t=out:st=${seconds - 0.6}:d=0.6`] as const;
    const sentence = synthesize(ffmpeg, dir, "sentence", ...tone(4));
    const answer = sentence && synthesize(ffmpeg, dir, "answer", ...tone(40));
    const silence = answer && synthesize(ffmpeg, dir, "silence", "anullsrc=channel_layout=mono:sample_rate=48000:duration=40", null);
    return sentence && answer && silence ? { sentence, answer, silence } : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
