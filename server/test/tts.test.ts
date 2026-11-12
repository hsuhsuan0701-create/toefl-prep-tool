import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { spawn as nodeSpawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { synthesizeToFile, TtsError } from "../src/services/tts.js";

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tts-")), "a/b/out.mp3");
/** Retries without waiting; the schedule itself is asserted in tts.retry.test.ts. */
const noWait = async () => {};

afterEach(() => vi.unstubAllGlobals());

// A minimal fake for node:child_process's spawn, used only by the Gemini path's pcmToMp3 step. It is
// injected through TtsTransportDeps.spawn (the real spawn by default), so a test can read the argv
// ffmpeg was spawned with without a process-level mock. `on`/`stdout`/`stdin` are
// EventEmitter-backed so the fake satisfies exactly what pcmToMp3 calls: `ff.stdout.on("data",
// ...)`, `ff.on("error"|"close", ...)`, `ff.stdin.on("error", ...)`, `ff.stdin.write(pcm, cb)`,
// `ff.stdin.end()`.
//
// `write` takes the completion callback through which a real stream can report a failed queued
// write. A successful callback does not model ffmpeg consuming every byte; the fake deliberately
// promises no such acknowledgement. `brokenPipe` models the locally observable failure: ffmpeg is
// gone, our write reports EPIPE, and the process still exits 0.
type FakeStdin = EventEmitter & {
  write: (data: Buffer, callback: (error?: Error | null) => void) => boolean;
  end: () => void;
};
function fakeFfmpeg(
  outputChunks: Buffer[] = [Buffer.from("fake-mp3-bytes")],
  options: { brokenPipe?: boolean; brokenPipeOnCalls?: readonly number[]; exitCode?: number } = {},
) {
  const calls: { command: string; args: string[] }[] = [];
  const written: Buffer[] = [];
  const spawnFn = vi.fn((command: string, args?: readonly string[]) => {
    calls.push({ command, args: [...(args ?? [])] });
    const callNumber = calls.length;
    const brokenPipe = options.brokenPipe || options.brokenPipeOnCalls?.includes(callNumber);
    const stdout = new EventEmitter();
    const stdin = new EventEmitter() as FakeStdin;
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stdin: FakeStdin };
    proc.stdout = stdout;
    proc.stdin = stdin;
    stdin.write = (data, callback) => {
      written.push(data);
      if (brokenPipe) {
        const error = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
        queueMicrotask(() => {
          stdin.emit("error", error);
          callback(error);
        });
        return false;
      }
      queueMicrotask(() => callback(null));
      return true;
    };
    stdin.end = () => {
      queueMicrotask(() => {
        for (const chunk of outputChunks) stdout.emit("data", chunk);
        proc.emit("close", options.exitCode ?? 0);
      });
    };
    return proc;
  }) as unknown as typeof nodeSpawn;
  return { spawnFn, calls, written };
}

function geminiAudioResponse(b64: string, mimeType?: string) {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { data: b64, ...(mimeType ? { mimeType } : {}) } }],
          },
        },
      ],
    }),
    { status: 200 }
  );
}

describe("synthesizeToFile", () => {
  it("posts to OpenAI speech API and writes the mp3 bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const fetchMock = vi.fn().mockResolvedValue(new Response(bytes, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = tmp();
    await synthesizeToFile({ text: "Hello.", provider: "openai", voice: "alloy", instructions: "warm, natural pace", speed: 1.2 }, out);
    expect(fs.readFileSync(out)).toEqual(Buffer.from(bytes));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("api.openai.com/v1/audio/speech");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: "gpt-4o-mini-tts", input: "Hello.", voice: "alloy", instructions: "warm, natural pace", speed: 1.2, response_format: "mp3" });
  });

  it.each([0.24, 4.01, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid speed %s before fetch", async (speed) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(synthesizeToFile({ text: "Hi", provider: "openai", voice: "alloy", speed }, tmp())).rejects.toBeInstanceOf(TtsError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits speed from OpenAI JSON when undefined", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await synthesizeToFile({ text: "Hi", provider: "openai", voice: "alloy" }, tmp());
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("speed");
  });

  it("retries on 429 then succeeds", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([9]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await synthesizeToFile({ text: "Hi", provider: "openai", voice: "alloy" }, tmp(), { sleep: noWait });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws TtsError after exhausting retries", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 500 })));
    await expect(synthesizeToFile({ text: "Hi", provider: "openai", voice: "alloy" }, tmp(), { sleep: noWait }))
      .rejects.toBeInstanceOf(TtsError);
  });
});

describe("synthesizeToFile — gemini", () => {
  it("produces the multiSpeakerVoiceConfig body shape with both labels and voice names, and no voiceConfig key", async () => {
    const b64 = Buffer.from([1, 2, 3]).toString("base64");
    const fetchMock = vi.fn().mockResolvedValue(geminiAudioResponse(b64, "audio/L16;codec=pcm;rate=24000"));
    vi.stubGlobal("fetch", fetchMock);
    const { spawnFn } = fakeFfmpeg();
    await synthesizeToFile(
      {
        text: "Interviewer: Hi.\nStudent: Hello.",
        provider: "gemini",
        voice: "ignored-single-voice",
        speakers: [
          { speaker: "Interviewer", voice: "voiceA" },
          { speaker: "Student", voice: "voiceB" },
        ],
      },
      tmp(),
      { spawn: spawnFn }
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.generationConfig.speechConfig).toEqual({
      multiSpeakerVoiceConfig: {
        speakerVoiceConfigs: [
          { speaker: "Interviewer", voiceConfig: { prebuiltVoiceConfig: { voiceName: "voiceA" } } },
          { speaker: "Student", voiceConfig: { prebuiltVoiceConfig: { voiceName: "voiceB" } } },
        ],
      },
    });
    expect(body.generationConfig.speechConfig).not.toHaveProperty("voiceConfig");
  });

  it("keeps the single-voice gemini body shape unchanged (no multiSpeakerVoiceConfig key)", async () => {
    const b64 = Buffer.from([1]).toString("base64");
    const fetchMock = vi.fn().mockResolvedValue(geminiAudioResponse(b64, "audio/L16;codec=pcm;rate=24000"));
    vi.stubGlobal("fetch", fetchMock);
    const { spawnFn } = fakeFfmpeg();
    await synthesizeToFile({ text: "Hello.", provider: "gemini", voice: "Kore" }, tmp(), { spawn: spawnFn });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.generationConfig.speechConfig).toEqual({
      voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } },
    });
    expect(body.generationConfig.speechConfig).not.toHaveProperty("multiSpeakerVoiceConfig");
  });

  // A "no-audio" response (text tokens instead of audio, a degenerate case Google documents and says
  // to retry) is retried, and the next success returns audio.
  it("retries a no-audio response and returns audio from the subsequent success", async () => {
    const noAudio = new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: "oops, no audio this time" }] } }] }),
      { status: 200 }
    );
    const b64 = Buffer.from([9]).toString("base64");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(noAudio)
      .mockResolvedValueOnce(geminiAudioResponse(b64, "audio/L16;codec=pcm;rate=24000"));
    vi.stubGlobal("fetch", fetchMock);
    const { spawnFn } = fakeFfmpeg();
    const out = tmp();
    await synthesizeToFile({ text: "Hi", provider: "gemini", voice: "Kore" }, out, { spawn: spawnFn, sleep: noWait });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fs.existsSync(out)).toBe(true);
  });

  // A text part before the audio part is not a no-audio response: every part of the first candidate
  // is scanned for the first one carrying inlineData.data.
  it("finds inline audio data at a non-zero part index (text part first)", async () => {
    const b64 = Buffer.from([7]).toString("base64");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  { text: "here is your audio" },
                  { inlineData: { data: b64, mimeType: "audio/L16;codec=pcm;rate=24000" } },
                ],
              },
            },
          ],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const { spawnFn } = fakeFfmpeg();
    const out = tmp();
    await synthesizeToFile({ text: "Hi", provider: "gemini", voice: "Kore" }, out, { spawn: spawnFn });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(out)).toBe(true);
  });

  // The sample rate in mimeType reaches ffmpeg's argv; a missing rate= falls back to 24000; rate=abc
  // is a fault (bad-mime), not a fallback.
  describe("sample rate parsing from mimeType", () => {
    it("passes a parsed rate=48000 to ffmpeg's argv", async () => {
      const b64 = Buffer.from([1]).toString("base64");
      const fetchMock = vi.fn().mockResolvedValue(geminiAudioResponse(b64, "audio/L16;codec=pcm;rate=48000"));
      vi.stubGlobal("fetch", fetchMock);
      const { spawnFn, calls } = fakeFfmpeg();
      await synthesizeToFile({ text: "Hi", provider: "gemini", voice: "Kore" }, tmp(), { spawn: spawnFn });
      expect(calls[0]!.args).toEqual(expect.arrayContaining(["-ar", "48000"]));
    });

    it("falls back to 24000 when mimeType has no rate parameter", async () => {
      const b64 = Buffer.from([1]).toString("base64");
      const fetchMock = vi.fn().mockResolvedValue(geminiAudioResponse(b64, "audio/L16;codec=pcm"));
      vi.stubGlobal("fetch", fetchMock);
      const { spawnFn, calls } = fakeFfmpeg();
      await synthesizeToFile({ text: "Hi", provider: "gemini", voice: "Kore" }, tmp(), { spawn: spawnFn });
      expect(calls[0]!.args).toEqual(expect.arrayContaining(["-ar", "24000"]));
    });

    it("falls back to 24000 when mimeType is entirely missing", async () => {
      const b64 = Buffer.from([1]).toString("base64");
      const fetchMock = vi.fn().mockResolvedValue(geminiAudioResponse(b64));
      vi.stubGlobal("fetch", fetchMock);
      const { spawnFn, calls } = fakeFfmpeg();
      await synthesizeToFile({ text: "Hi", provider: "gemini", voice: "Kore" }, tmp(), { spawn: spawnFn });
      expect(calls[0]!.args).toEqual(expect.arrayContaining(["-ar", "24000"]));
    });

    it("throws bad-mime when rate= is present but not a positive integer, without spawning ffmpeg", async () => {
      const b64 = Buffer.from([1]).toString("base64");
      const fetchMock = vi.fn().mockResolvedValue(geminiAudioResponse(b64, "audio/L16;codec=pcm;rate=abc"));
      vi.stubGlobal("fetch", fetchMock);
      const { spawnFn, calls } = fakeFfmpeg();
      await expect(
        synthesizeToFile({ text: "Hi", provider: "gemini", voice: "Kore" }, tmp(), { spawn: spawnFn })
      ).rejects.toMatchObject({ status: "bad-mime" });
      expect(calls.length).toBe(0);
    });
  });

  // A broken pipe must not produce a short clip. ffmpeg exiting or dying while pcmToMp3 is still
  // feeding it breaks our end of the pipe: the write fails with EPIPE, and ffmpeg can still exit 0
  // having encoded only what it read. Nothing downstream reliably catches that: a Conversation
  // truncated to half its length sits inside the deliberately wide 0.3x-3.0x pace sanity window, so
  // it would be warned about once and then published.
  describe("partial write to ffmpeg", () => {
    it("retries the local transcode once with the same PCM buffer without repeating the Gemini request", async () => {
      const pcm = Buffer.alloc(4096, 7);
      const fetchMock = vi.fn().mockResolvedValue(
        geminiAudioResponse(pcm.toString("base64"), "audio/L16;codec=pcm;rate=24000"),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { spawnFn, calls, written } = fakeFfmpeg(
        [Buffer.from("complete-mp3")],
        { brokenPipeOnCalls: [1] },
      );
      const out = tmp();

      await synthesizeToFile({ text: "Hi", provider: "gemini", voice: "Kore" }, out, { spawn: spawnFn });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(2);
      expect(written).toHaveLength(2);
      expect(written[0]).toEqual(pcm);
      expect(written[1]).toBe(written[0]);
      expect(fs.readFileSync(out)).toEqual(Buffer.from("complete-mp3"));
    });

    it("fails with an honest stdin-write diagnostic when ffmpeg exits 0 after a broken pipe", async () => {
      const pcm = Buffer.alloc(4096, 7);
      const fetchMock = vi.fn().mockResolvedValue(
        geminiAudioResponse(pcm.toString("base64"), "audio/L16;codec=pcm;rate=24000"),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { spawnFn, calls } = fakeFfmpeg([Buffer.from("truncated-mp3")], { brokenPipe: true });
      const out = tmp();

      const error = await synthesizeToFile({ text: "Hi", provider: "gemini", voice: "Kore" }, out, { spawn: spawnFn })
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(TtsError);
      expect((error as TtsError).status).toBe("ffmpeg-stdin-write");
      expect((error as TtsError).message).toBe(
        "TTS gemini ffmpeg-stdin-write: ffmpeg exited 0 after its PCM stdin write failed — " +
        "refusing possibly truncated output",
      );
      // The paid request is never retried; only the same in-memory PCM gets one second local feed.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(2);
      // Nothing is written: a short mp3 on disk is the outcome this exists to prevent.
      expect(fs.existsSync(out)).toBe(false);
    });

    it("writes the mp3 when the PCM write callback succeeds", async () => {
      const pcm = Buffer.alloc(4096, 7);
      const fetchMock = vi.fn().mockResolvedValue(
        geminiAudioResponse(pcm.toString("base64"), "audio/L16;codec=pcm;rate=24000"),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { spawnFn, written } = fakeFfmpeg();
      const out = tmp();

      await synthesizeToFile({ text: "Hi", provider: "gemini", voice: "Kore" }, out, { spawn: spawnFn });

      expect(Buffer.concat(written)).toEqual(pcm);
      expect(fs.readFileSync(out)).toEqual(Buffer.from("fake-mp3-bytes"));
    });

    it("keeps reporting a non-zero exit code as its own failure rather than as a truncation", async () => {
      const b64 = Buffer.from([1, 2, 3]).toString("base64");
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(geminiAudioResponse(b64, "audio/L16;codec=pcm;rate=24000")));
      const { spawnFn } = fakeFfmpeg([], { brokenPipe: true, exitCode: 1 });

      await expect(
        synthesizeToFile({ text: "Hi", provider: "gemini", voice: "Kore" }, tmp(), { spawn: spawnFn }),
      ).rejects.toMatchObject({ status: "ffmpeg" });
    });
  });

  describe("speakers validation", () => {
    it.each<[string, Parameters<typeof synthesizeToFile>[0]]>([
      [
        "speakers on an openai request",
        {
          text: "Hi",
          provider: "openai",
          voice: "alloy",
          speakers: [
            { speaker: "A", voice: "v1" },
            { speaker: "B", voice: "v2" },
          ],
        },
      ],
      [
        "more than 2 speakers",
        {
          text: "Hi",
          provider: "gemini",
          voice: "v",
          speakers: [
            { speaker: "A", voice: "v1" },
            { speaker: "B", voice: "v2" },
            { speaker: "C", voice: "v3" },
          ],
        },
      ],
      [
        "duplicate speaker labels",
        {
          text: "Hi",
          provider: "gemini",
          voice: "v",
          speakers: [
            { speaker: "A", voice: "v1" },
            { speaker: "A", voice: "v2" },
          ],
        },
      ],
      [
        "a blank speaker label",
        {
          text: "Hi",
          provider: "gemini",
          voice: "v",
          speakers: [
            { speaker: "   ", voice: "v1" },
            { speaker: "B", voice: "v2" },
          ],
        },
      ],
      [
        "a blank voice",
        {
          text: "Hi",
          provider: "gemini",
          voice: "v",
          speakers: [
            { speaker: "A", voice: "" },
            { speaker: "B", voice: "v2" },
          ],
        },
      ],
    ])("rejects %s before any fetch call", async (_label, req) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      await expect(synthesizeToFile(req, tmp())).rejects.toBeInstanceOf(TtsError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // The transport never emits req.text, not even inside a validation error.
  it("never includes req.text in a validation rejection's message", async () => {
    const sentinel = "SENTINEL-UTTERANCE-DO-NOT-LEAK-93af";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    let caught: unknown;
    try {
      await synthesizeToFile(
        {
          text: sentinel,
          provider: "openai",
          voice: "alloy",
          speakers: [{ speaker: "A", voice: "v1" }],
        },
        tmp()
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TtsError);
    expect((caught as TtsError).message).not.toContain(sentinel);
  });
});
