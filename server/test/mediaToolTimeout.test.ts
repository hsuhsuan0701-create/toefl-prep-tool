import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  killAfterTimeout,
  probeDurationSec,
  probeSpeechDurationSec,
  transcodeWebmToMp3,
  TranscodeError,
} from "../src/services/transcode.js";
import { synthesizeToFile, TtsError } from "../src/services/tts.js";

// A stuck ffmpeg or ffprobe must not hold a scoring or generation job forever: each media process is
// killed after its timeout and the call fails with a clear error. No real ffmpeg runs here
// (transcode.test.ts is the one file that does): PATH points at stand-ins that never exit, and the
// encode's spawn is a Node child that never exits.

const scratch: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A directory holding `ffmpeg` and `ffprobe` stand-ins that never exit, put first on PATH. */
function hangingMediaTools(): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hanging-media-"));
  scratch.push(dir);
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const script = path.join(dir, tool);
    fs.writeFileSync(script, "#!/bin/sh\nexec sleep 30\n");
    fs.chmodSync(script, 0o755);
  }
  vi.stubEnv("PATH", `${dir}${path.delimiter}${process.env.PATH ?? ""}`);
}

/** A real child process that reads nothing and never exits on its own. */
function hangingChild(): ChildProcess {
  return nodeSpawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
}

/** The signal `child` ended with, waiting for it to end if it has not yet. */
function endingSignal(child: ChildProcess): Promise<NodeJS.Signals | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.signalCode);
  return new Promise((resolve) => child.once("exit", (_code, signal) => resolve(signal)));
}

describe("killAfterTimeout", () => {
  it("kills a process still running at its timeout, and reports it once", async () => {
    const child = hangingChild();
    const onTimeout = vi.fn();
    killAfterTimeout(child, 100, onTimeout);
    expect(await endingSignal(child)).toBe("SIGKILL");
    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does nothing once cancelled", async () => {
    const child = hangingChild();
    const onTimeout = vi.fn();
    const cancel = killAfterTimeout(child, 100, onTimeout);
    cancel();
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(child.exitCode === null && child.signalCode === null).toBe(true);
    expect(onTimeout).not.toHaveBeenCalled();
    child.kill("SIGKILL");
  });
});

describe("media calls give up on a process that never finishes", () => {
  it("rejects a transcode with TranscodeError", async () => {
    hangingMediaTools();
    const error = await transcodeWebmToMp3("in.webm", "out.mp3", { timeoutMs: 150 }).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(TranscodeError);
    expect((error as Error).message).toMatch(/ffmpeg timed out after 150 ms and was killed/);
  });

  it("rejects a duration probe with TranscodeError", async () => {
    hangingMediaTools();
    await expect(probeDurationSec("clip.mp3", { timeoutMs: 150 })).rejects.toThrow(/ffprobe timed out after 150 ms/);
  });

  it("rejects a speech-duration probe once the silence scan and the duration probe both time out", async () => {
    hangingMediaTools();
    // The silence scan's timeout falls back to the file duration, whose probe times out too.
    await expect(probeSpeechDurationSec("clip.mp3", { timeoutMs: 150 })).rejects.toThrow(/ffprobe timed out/);
  });

  it("kills a TTS encode, failing the clip without buying the synthesis again", async () => {
    const pcm = Buffer.alloc(4800).toString("base64");
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: pcm, mimeType: "audio/L16;codec=pcm;rate=24000" } }] } }] }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const encoders: ChildProcess[] = [];
    const spawnHanging = ((..._args: unknown[]) => {
      const child = hangingChild();
      encoders.push(child);
      return child;
    }) as unknown as typeof nodeSpawn;
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tts-timeout-")), "out.mp3");
    scratch.push(path.dirname(out));

    const error = await synthesizeToFile(
      { text: "Hello.", provider: "gemini", voice: "Kore" },
      out,
      { spawn: spawnHanging, encodeTimeoutMs: 150, sleep: async () => {} },
    ).then(() => undefined, (err: unknown) => err);

    expect(error).toBeInstanceOf(TtsError);
    expect((error as TtsError).status).toBe("ffmpeg");
    expect((error as Error).message).toMatch(/timed out after 150 ms/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(out)).toBe(false);
    expect(encoders).toHaveLength(1);
    expect(await endingSignal(encoders[0]!)).toBe("SIGKILL");
  });
});
