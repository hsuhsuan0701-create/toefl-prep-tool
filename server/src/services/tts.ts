import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "../lib/config.js";
import { killAfterTimeout, MEDIA_TOOL_TIMEOUT_MS } from "./transcode.js";

// The text-to-speech transport: one request in, one mp3 file out, with bounded retries. Gemini
// returns raw PCM, which a local ffmpeg encodes to mp3. Prompt structure (audioPrompt.ts), pace and
// admission (ttsQueue.ts) are the callers' business.

/**
 * A failed synthesis. `status` is the provider's HTTP status, or a local label: "validation",
 * "timeout", "network", "no-audio", "bad-mime", "ffmpeg" or "ffmpeg-stdin-write".
 */
export class TtsError extends Error {
  constructor(
    public provider: string,
    public status: number | string,
    msg: string,
    /** How long the provider asked the client to wait before retrying, when it said. */
    public retryAfterMs?: number,
  ) {
    super(`TTS ${provider} ${status}: ${msg}`);
  }
}

export type TtsSpeaker = { speaker: string; voice: string };
export type TtsRequest = {
  text: string;
  provider: "openai" | "gemini";
  voice: string;
  speakers?: TtsSpeaker[];
  instructions?: string;
  speed?: number;
};

/**
 * The transport's injectable edges, each defaulted to the real thing:
 *   - `spawn` starts the ffmpeg process pcmToMp3 feeds, so a test can read its argv and stdin;
 *   - `sleep` waits between retries, so a test can read the retry schedule without waiting it out;
 *   - `requestTimeoutMs` bounds one HTTP request, response body included;
 *   - `encodeTimeoutMs` bounds the ffmpeg encode (MEDIA_TOOL_TIMEOUT_MS by default).
 */
export type TtsTransportDeps = {
  spawn?: typeof spawn;
  sleep?: (ms: number) => Promise<void>;
  requestTimeoutMs?: number;
  encodeTimeoutMs?: number;
};

/**
 * Waits before each retry when the provider gives no Retry-After. Five retries, so six requests at
 * most, about a minute of waiting in all: long enough to ride out a per-minute rate limit, short
 * enough that a dead provider fails the render in minutes rather than hours.
 */
const RETRY_BACKOFF_MS = [2_000, 4_000, 8_000, 16_000, 30_000] as const;

/**
 * The longest provider-requested wait this transport honours. A 429 asking for longer is usually a
 * daily quota, which no retry inside one render can outlast, so it fails at once instead.
 */
const MAX_RETRY_AFTER_MS = 120_000;

/**
 * One synthesis request, start to finish. A long multi-speaker Conversation takes the provider tens
 * of seconds; a request still open after three minutes is stuck, and holding it would also hold the
 * process-wide TTS slot (ttsQueue.ts) every other clip is waiting on.
 */
const REQUEST_TIMEOUT_MS = 180_000;

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// OpenAI synthesis is used only by the scripts that synthesize test recordings
// (smoke-speaking-judges.ts, calibrate-speaking.ts); every Set renders through Gemini.
const OPENAI_TTS_MODEL = process.env.OPENAI_TTS_MODEL ?? "gpt-4o-mini-tts";

// Speakers validation, run before any network call. An absent or empty `speakers` array means the
// single-voice path. Error messages carry counts and field names only: never the request text, a
// speaker label or a voice name.
function validateSpeakers(req: TtsRequest): void {
  if (!req.speakers || req.speakers.length === 0) return;
  if (req.provider === "openai") {
    throw new TtsError("openai", "validation", "speakers is not supported for provider=openai (no multi-speaker mode)");
  }
  if (req.speakers.length > 2) {
    throw new TtsError("gemini", "validation", `speakers supports at most 2 entries, got count=${req.speakers.length}`);
  }
  const seen = new Set<string>();
  for (const s of req.speakers) {
    if (s.speaker.trim().length === 0) {
      throw new TtsError("gemini", "validation", "speakers entries must have a non-blank speaker label");
    }
    if (s.voice.trim().length === 0) {
      throw new TtsError("gemini", "validation", "speakers entries must have a non-blank voice");
    }
    if (seen.has(s.speaker)) {
      throw new TtsError("gemini", "validation", "speakers contains duplicate speaker labels");
    }
    seen.add(s.speaker);
  }
}

/**
 * Synthesizes `req` and writes the mp3 to `outPath`, creating its directory. Retries 429, 5xx,
 * timeouts, connection failures and Gemini's no-audio response, waiting as the provider asks (up to
 * two minutes) or on a fixed backoff; any other failure throws TtsError at once.
 */
export async function synthesizeToFile(req: TtsRequest, outPath: string, deps: TtsTransportDeps = {}): Promise<void> {
  if (req.speed !== undefined && (!Number.isFinite(req.speed) || req.speed < 0.25 || req.speed > 4)) {
    throw new TtsError(req.provider, "validation", "speed must be a finite number from 0.25 to 4.0");
  }
  validateSpeakers(req);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const encoder = { spawn: deps.spawn ?? spawn, timeoutMs: deps.encodeTimeoutMs ?? MEDIA_TOOL_TIMEOUT_MS };
  const timeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const bytes = await withRetries(deps.sleep ?? realSleep, () =>
    req.provider === "openai"
      ? openaiTts(req, AbortSignal.timeout(timeoutMs))
      : geminiTts(req, encoder, AbortSignal.timeout(timeoutMs)),
  );
  fs.writeFileSync(outPath, bytes);
}

/**
 * Runs one HTTP exchange (the fetch and the read of its body) and turns a failure to get a response
 * into a TtsError the retry loop can classify: the timeout firing becomes "timeout", and the
 * TypeError fetch throws for a refused, reset or unresolvable connection becomes "network". Only the
 * error's name is kept, because a fetch error's message and cause can carry the request URL. A
 * response the provider did send but rejected arrives here already as a TtsError, untouched.
 */
async function exchange<T>(provider: string, signal: AbortSignal, request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (err) {
    if (err instanceof TtsError) throw err;
    if (signal.aborted) throw new TtsError(provider, "timeout", "request timed out");
    if (err instanceof TypeError) throw new TtsError(provider, "network", `request failed (${err.name})`);
    throw err;
  }
}

/**
 * Retried: rate limiting (429), provider errors (5xx), a request that timed out or never reached the
 * provider, and Gemini's documented "no-audio" response, which Google says to retry. Anything else is
 * a request the provider will keep refusing, so it fails at once.
 */
function isRetryable(err: unknown): err is TtsError {
  if (!(err instanceof TtsError)) return false;
  if (err.status === "no-audio" || err.status === "timeout" || err.status === "network") return true;
  return typeof err.status === "number" && (err.status === 429 || err.status >= 500);
}

async function withRetries(sleep: (ms: number) => Promise<void>, attempt: () => Promise<Buffer>): Promise<Buffer> {
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (err) {
      if (!isRetryable(err) || retry >= RETRY_BACKOFF_MS.length) throw err;
      if (err.retryAfterMs !== undefined && err.retryAfterMs > MAX_RETRY_AFTER_MS) throw err;
      await sleep(err.retryAfterMs ?? RETRY_BACKOFF_MS[retry]!);
    }
  }
}

/**
 * The wait a failed response asks for: OpenAI's `retry-after-ms`, the standard `Retry-After` (in
 * seconds or as an HTTP date), or Gemini's RetryInfo `retryDelay` ("12.5s") in the error body.
 * Undefined when the response names none.
 */
function retryAfterMs(res: Response, body: string): number | undefined {
  const ms = Number(res.headers.get("retry-after-ms"));
  if (res.headers.has("retry-after-ms") && Number.isFinite(ms) && ms >= 0) return ms;
  const header = res.headers.get("retry-after");
  if (header !== null) {
    if (/^\d+(\.\d+)?$/.test(header.trim())) return Number(header) * 1000;
    const date = Date.parse(header);
    if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  }
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return delay ? Number(delay[1]) * 1000 : undefined;
}

async function failedResponse(provider: string, res: Response): Promise<TtsError> {
  let errorText = "";
  try {
    errorText = await res.text();
  } catch {
    // Body might already be consumed (e.g., on retry with same Response object in tests)
    errorText = `HTTP ${res.status}`;
  }
  return new TtsError(provider, res.status, errorText, retryAfterMs(res, errorText));
}

function openaiTts(req: TtsRequest, signal: AbortSignal): Promise<Buffer> {
  return exchange("openai", signal, async () => {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${config.openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OPENAI_TTS_MODEL, input: req.text, voice: req.voice,
        ...(req.instructions ? { instructions: req.instructions } : {}),
        ...(req.speed !== undefined ? { speed: req.speed } : {}),
        response_format: "mp3",
      }),
      signal,
    });
    if (!res.ok) throw await failedResponse("openai", res);
    return Buffer.from(await res.arrayBuffer());
  });
}

// Gemini's documented PCM sample rate when inlineData.mimeType is missing or names no rate.
const DEFAULT_GEMINI_SAMPLE_RATE_HZ = 24000;

// Reads the rate from a mimeType such as "audio/L16;codec=pcm;rate=24000" (parameter name
// case-insensitive, whitespace tolerated). No mimeType, or no rate=, falls back to the default
// above. A rate= that is present but not a positive integer throws instead: encoding at a wrong rate
// gives a pitch-shifted clip of the wrong duration, which the pace check would record as a real
// measurement. A mimeType is a format descriptor, never transcript text, so the error may quote it.
function parseGeminiSampleRateHz(mimeType: string | undefined): number {
  if (!mimeType) return DEFAULT_GEMINI_SAMPLE_RATE_HZ;
  const match = /rate\s*=\s*([^;]*)/i.exec(mimeType);
  if (!match) return DEFAULT_GEMINI_SAMPLE_RATE_HZ;
  const raw = match[1]!.trim();
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new TtsError("gemini", "bad-mime", `mimeType has an invalid rate parameter: ${mimeType}`);
  }
  return Number(raw);
}

type Encoder = { spawn: typeof spawn; timeoutMs: number };

async function geminiTts(req: TtsRequest, encoder: Encoder, signal: AbortSignal): Promise<Buffer> {
  // An empty speakers array is treated as absent, as in validateSpeakers.
  const speakers = req.speakers && req.speakers.length > 0 ? req.speakers : undefined;
  // Google rejects a body carrying both voiceConfig and multiSpeakerVoiceConfig, so on a
  // multi-speaker request `req.voice` is ignored and each speaker's own voice is used.
  const speechConfig = speakers
    ? {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: speakers.map((s) => ({
            speaker: s.speaker,
            voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice } },
          })),
        },
      }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voice } } };

  type GeminiAudioResponse = {
    candidates?: { content?: { parts?: { inlineData?: { data?: string; mimeType?: string } }[] } }[];
  };
  const json = await exchange("gemini", signal, async () => {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiTtsModel}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.geminiKey ?? "" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: (req.instructions ? `${req.instructions}: ` : "") + req.text }] }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig,
          },
        }),
        signal,
      }
    );
    if (!res.ok) throw await failedResponse("gemini", res);
    return (await res.json()) as GeminiAudioResponse;
  });
  // A response can carry a text part before the audio part, so take the first part with inline
  // data rather than parts[0].
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const audioPart = parts.find((p) => typeof p.inlineData?.data === "string");
  const b64 = audioPart?.inlineData?.data;
  if (!b64) throw new TtsError("gemini", "no-audio", "response had no inline audio data");
  const sampleRateHz = parseGeminiSampleRateHz(audioPart!.inlineData!.mimeType);
  // Gemini returns raw mono 16-bit PCM at the rate above. A failed ffmpeg stdin write is retried
  // once with the same in-memory buffer and a fresh process. Not through withRetries, which would pay
  // for the synthesis again.
  const pcm = Buffer.from(b64, "base64");
  try {
    return await pcmToMp3(pcm, sampleRateHz, encoder);
  } catch (error) {
    if (!(error instanceof TtsError) || error.status !== "ffmpeg-stdin-write") throw error;
    return pcmToMp3(pcm, sampleRateHz, encoder);
  }
}

// Encodes mono 16-bit PCM to mp3 with a local ffmpeg. The exit code alone is not trusted: if the
// stdin pipe breaks while PCM is still being written (EPIPE), ffmpeg can exit 0 having encoded only a
// prefix, and nothing downstream reliably catches a short clip (the pace check's sanity window is
// 0.3x-3x, so a Conversation cut in half publishes with a warning). A write failure Node reports
// therefore rejects with `ffmpeg-stdin-write`, which geminiTts retries once; a non-zero exit rejects
// with `ffmpeg`. A successful write callback only means Node accepted the buffer: this proves neither
// that ffmpeg consumed every byte nor that Gemini's payload was complete.
//
// An encode still running after `encoder.timeoutMs` is killed and rejects with `ffmpeg`, which
// withRetries does not retry: the synthesis it would buy again was not the part that failed.
function pcmToMp3(pcm: Buffer, sampleRateHz: number, encoder: Encoder): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = encoder.spawn("ffmpeg", ["-f", "s16le", "-ar", String(sampleRateHz), "-ac", "1", "-i", "pipe:0", "-f", "mp3", "pipe:1"]);
    const chunks: Buffer[] = [];
    let stdinWriteFailed = false;
    let settled = false;
    const cancelTimeout = killAfterTimeout(ff, encoder.timeoutMs, () => {
      settled = true;
      reject(new TtsError("gemini", "ffmpeg", `encode timed out after ${encoder.timeoutMs} ms and was killed`));
    });
    ff.stdout.on("data", (d) => chunks.push(d));
    ff.on("error", (error) => {
      cancelTimeout();
      reject(error);
    });
    ff.on("close", (code) => {
      cancelTimeout();
      if (settled) return;
      if (code !== 0) {
        reject(new TtsError("gemini", "ffmpeg", `exit ${code}`));
        return;
      }
      if (stdinWriteFailed) {
        reject(new TtsError(
          "gemini",
          "ffmpeg-stdin-write",
          "ffmpeg exited 0 after its PCM stdin write failed — refusing possibly truncated output",
        ));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    // A listener must be attached, or a stream 'error' crashes the process. It records the same fact
    // as the write callback.
    ff.stdin.on("error", () => { stdinWriteFailed = true; });
    ff.stdin.write(pcm, (error) => {
      if (error) stdinWriteFailed = true;
    });
    ff.stdin.end();
  });
}
