// ffmpeg and ffprobe helpers: transcoding a recorded Response to mp3, and measuring a clip's file or
// speech duration. Every process they start is killed if it outlives MEDIA_TOOL_TIMEOUT_MS.
import { spawn, type ChildProcess } from "node:child_process";

export class TranscodeError extends Error {
  constructor(msg: string) {
    super(`transcode ffmpeg: ${msg}`);
  }
}

/**
 * How long one ffmpeg or ffprobe process may run. Every job here takes seconds: transcoding the
 * longest recording the 25 MB upload cap admits, probing a file, scanning a clip for silence,
 * encoding one synthesized clip. A process still running after two minutes is stuck (waiting on
 * input that never comes, or on a filesystem that stopped answering), and a caller awaiting it would
 * hold its job, and for a clip its TTS slot, forever.
 */
export const MEDIA_TOOL_TIMEOUT_MS = 120_000;

/** How long a caller lets one media process run; MEDIA_TOOL_TIMEOUT_MS unless it says otherwise. */
export type MediaToolOptions = { timeoutMs?: number };

/**
 * Kills `child` with SIGKILL if it is still running after `timeoutMs`, then calls `onTimeout`. The
 * returned function cancels the timer; call it as soon as the child exits. tts.ts uses the same
 * bound for the ffmpeg that encodes each synthesized clip.
 */
export function killAfterTimeout(child: ChildProcess, timeoutMs: number, onTimeout: () => void): () => void {
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    onTimeout();
  }, timeoutMs);
  return () => clearTimeout(timer);
}

/**
 * Runs `command` to completion and resolves its exit code and output; a spawn failure or the
 * timeout rejects with TranscodeError. Nothing is written to stdin, which is closed at once.
 */
function runMediaTool(
  command: "ffmpeg" | "ffprobe",
  args: readonly string[],
  options: MediaToolOptions,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? MEDIA_TOOL_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      cancelTimeout();
      finish();
    };
    const cancelTimeout = killAfterTimeout(child, timeoutMs, () =>
      settle(() => reject(new TranscodeError(`${command} timed out after ${timeoutMs} ms and was killed`))),
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => settle(() => reject(new TranscodeError(err.message))));
    // Nothing is written to stdin, but without an 'error' listener an EPIPE after the process exits
    // early would crash the server.
    child.stdin.on("error", () => {});
    child.stdin.end();
    child.on("close", (code) => settle(() => resolve({ code, stdout, stderr })));
  });
}

/** Transcodes a recorded Response to an mp3 file beside it, file to file. Rejects with TranscodeError. */
export async function transcodeWebmToMp3(
  webmPath: string,
  mp3Path: string,
  options: MediaToolOptions = {},
): Promise<void> {
  // -y: overwrite an existing mp3 without prompting.
  const { code, stderr } = await runMediaTool("ffmpeg", ["-y", "-i", webmPath, "-f", "mp3", mp3Path], options);
  if (code !== 0) throw new TranscodeError(`ffmpeg exited ${code}: ${stderr.slice(-500)}`);
}

/** A file's whole duration in seconds, from ffprobe. Rejects with TranscodeError. */
export async function probeDurationSec(filePath: string, options: MediaToolOptions = {}): Promise<number> {
  const { code, stdout, stderr } = await runMediaTool(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", filePath],
    options,
  );
  const sec = Number.parseFloat(stdout.trim());
  if (code !== 0 || !Number.isFinite(sec)) {
    throw new TranscodeError(`ffprobe failed to read duration (exit ${code}): ${stderr.slice(-500)}`);
  }
  return sec;
}

/**
 * The duration of the SPEECH in a clip: its file duration less the silence at each end. Every pace
 * band is stated in speech rate (see audioPace.ts), because Gemini pads each clip with a
 * near-constant ~0.68 s of silence that ETS's reference audio does not have, and the clip ceiling is
 * the speech the learner has to hold. Measurements:
 * docs/research/2026-08-23-ets-reference-audio-padding.md.
 *
 * If silence detection fails or reports nothing usable it falls back to the file duration, which can
 * only make a clip read slower. A clip that is mostly silence at its edges is measured as the speech
 * it holds, which reads fast: out of band, which buys a corrective take, or a malfunction when almost
 * nothing is spoken (audioPace.ts). If ffprobe cannot read the file duration either, the clip is
 * unmeasurable and this rejects with TranscodeError, as probeDurationSec does; it never resolves a
 * number that is not a measurement. A renderer's first take then fails the render with that error,
 * the same tier as a malfunctioning clip (generationCheckPolicy.ts), and a corrective take is
 * discarded for the best take so far (audioPaceCorrection.ts). The thresholds (-40 dB, 50 ms) are the
 * ones docs/research/2026-08-23-listening-role-band-recentring.md measured the Listening bank with.
 */
export async function probeSpeechDurationSec(filePath: string, options: MediaToolOptions = {}): Promise<number> {
  let silence: { code: number | null; stderr: string } | undefined;
  try {
    silence = await runMediaTool(
      "ffmpeg",
      ["-v", "info", "-i", filePath, "-af", "silencedetect=noise=-40dB:d=0.05", "-f", "null", "-"],
      options,
    );
  } catch {
    // A silence scan that could not run or timed out leaves the file duration as the answer.
  }
  const fileDuration = await probeDurationSec(filePath, options);
  return silence?.code === 0 ? speechDurationFrom(silence.stderr, fileDuration) : fileDuration;
}

/**
 * The parsing half of probeSpeechDurationSec, separate so it can be tested without a subprocess.
 *
 * Only silence that touches an edge is removed; a pause between clauses is delivery, which a WPM band
 * is meant to count. ffmpeg reports a run as `silence_start` then `silence_end`: a run starting at 0
 * is the leading pad, and one ending at the file's end is the trailing pad.
 *
 * Returns the full file duration when nothing was parsed or the result is not a finite number. A clip
 * that is more silence than speech is NOT given its file duration: that would report its sliver of
 * speech as a whole clip's worth, and a mostly silent take of plausible length would read as in-band
 * speech and publish. It is measured as what it is, and a clip with no speech at all measures 0.
 */
export function speechDurationFrom(ffmpegStderr: string, fileDurationSec: number): number {
  if (!Number.isFinite(fileDurationSec) || fileDurationSec <= 0) return fileDurationSec;
  const events: { kind: "start" | "end"; at: number }[] = [];
  for (const match of ffmpegStderr.matchAll(/silence_(start|end):\s*(-?[0-9.]+)/gu)) {
    const at = Number.parseFloat(match[2]!);
    if (Number.isFinite(at)) events.push({ kind: match[1] as "start" | "end", at });
  }
  let lead = 0;
  if (events[0]?.kind === "start" && events[0].at <= 0.001) {
    lead = events.find((event) => event.kind === "end")?.at ?? 0;
  }
  let trail = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.kind !== "end") continue;
    // ffmpeg rounds the closing timestamp to the frame, so "ends at the end" needs a tolerance.
    if (Math.abs(event.at - fileDurationSec) < 0.02 && events[i - 1]?.kind === "start") {
      trail = fileDurationSec - events[i - 1]!.at;
    }
    break;
  }
  const speech = fileDurationSec - lead - trail;
  if (!Number.isFinite(speech)) return fileDurationSec;
  return Math.max(speech, 0);
}
