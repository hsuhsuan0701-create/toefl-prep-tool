import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { spawn as nodeSpawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { synthesizeToFile, TtsError } from "../src/services/tts.js";

// The transport's retry policy: which failures are retried, how long it waits between attempts,
// when it refuses to wait, and that no single request can hang a render. Every test injects `sleep`
// so the schedule is read off the calls rather than waited out.

const dirs: string[] = [];
const out = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-retry-"));
  dirs.push(dir);
  return path.join(dir, "out.mp3");
};
afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function recordingSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => { waits.push(ms); } };
}

/** ffmpeg stand-in for the Gemini path: accepts the PCM and emits a fixed mp3 body. */
function fakeFfmpeg(): typeof nodeSpawn {
  return vi.fn(() => {
    const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stdin: EventEmitter & { write: (d: Buffer, cb: (e?: Error | null) => void) => boolean; end: () => void } };
    proc.stdout = new EventEmitter();
    const stdin = new EventEmitter() as typeof proc.stdin;
    stdin.write = (_data, callback) => { queueMicrotask(() => callback(null)); return true; };
    stdin.end = () => queueMicrotask(() => { proc.stdout.emit("data", Buffer.from("mp3")); proc.emit("close", 0); });
    proc.stdin = stdin;
    return proc;
  }) as unknown as typeof nodeSpawn;
}

const geminiAudio = () => new Response(
  JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from([1]).toString("base64") } }] } }] }),
  { status: 200 },
);

const openai = { text: "Hi", provider: "openai" as const, voice: "alloy" };
const gemini = { text: "Hi", provider: "gemini" as const, voice: "Kore" };

describe("tts retry policy", () => {
  it("backs off 2, 4, 8, 16 then 30 seconds when the provider gives no hint, then gives up", async () => {
    const fetchMock = vi.fn(async () => new Response("boom", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const { waits, sleep } = recordingSleep();
    const failure = await synthesizeToFile(openai, out(), { sleep }).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(TtsError);
    expect((failure as TtsError).status).toBe(503);
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 30_000]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("waits what a Retry-After header asks for", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429, headers: { "Retry-After": "7" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { waits, sleep } = recordingSleep();
    await synthesizeToFile(openai, out(), { sleep });
    expect(waits).toEqual([7_000]);
  });

  it("waits what Gemini's RetryInfo asks for when there is no header", async () => {
    const quota = JSON.stringify({
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "12.5s" }],
      },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(quota, { status: 429 }))
      .mockResolvedValueOnce(geminiAudio());
    vi.stubGlobal("fetch", fetchMock);
    const { waits, sleep } = recordingSleep();
    await synthesizeToFile(gemini, out(), { sleep, spawn: fakeFfmpeg() });
    expect(waits).toEqual([12_500]);
  });

  it("does not wait at all when the provider asks for longer than the retry ceiling", async () => {
    const fetchMock = vi.fn(async () => new Response("daily quota", { status: 429, headers: { "Retry-After": "3600" } }));
    vi.stubGlobal("fetch", fetchMock);
    const { waits, sleep } = recordingSleep();
    await expect(synthesizeToFile(openai, out(), { sleep })).rejects.toMatchObject({ status: 429 });
    expect(waits).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a request the provider rejected as invalid", async () => {
    const fetchMock = vi.fn(async () => new Response("bad voice", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const { waits, sleep } = recordingSleep();
    await expect(synthesizeToFile(openai, out(), { sleep })).rejects.toMatchObject({ status: 400 });
    expect(waits).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts a request that outlives its timeout and retries it", async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    }));
    vi.stubGlobal("fetch", fetchMock);
    const { waits, sleep } = recordingSleep();
    await expect(synthesizeToFile(openai, out(), { sleep, requestTimeoutMs: 5 })).rejects.toMatchObject({ status: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(waits).toHaveLength(5);
  });

  it("retries a request that failed before any response arrived", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { waits, sleep } = recordingSleep();
    const file = out();
    await synthesizeToFile(openai, file, { sleep });
    expect(waits).toEqual([2_000]);
    expect(fs.readFileSync(file)).toEqual(Buffer.from([1]));
  });
});

describe("gemini request authentication", () => {
  it("sends the key in the x-goog-api-key header, never in the URL", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => geminiAudio());
    vi.stubGlobal("fetch", fetchMock);
    await synthesizeToFile(gemini, out(), { spawn: fakeFfmpeg() });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).not.toMatch(/[?&]key=/);
    expect(new Headers(init.headers).has("x-goog-api-key")).toBe(true);
  });
});
