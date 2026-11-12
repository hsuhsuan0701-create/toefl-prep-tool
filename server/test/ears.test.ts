import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hearRecording, composeEarsPrompt, EarsError } from "../src/services/ears.js";
import { config } from "../src/lib/config.js";
import type { ModelCallInsert } from "../src/db/rows.js";
import { virtualDelay } from "./helpers/virtualDelay.js";
import {
  resetModelCallSink,
  setModelCallSink,
} from "../src/services/modelCallLog.js";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures/tiny.webm");

const validResult = {
  transcript: "um so I think that the, the campus should build a new library",
  deliveryReport: {
    paceWpm: 132,
    pauses: "brief pause after 'the'",
    intelligibility: "clear throughout",
    suspectedMispronunciations: [],
    intonation: "flat, slightly rising at the end",
  },
};

const geminiWrap = (o: unknown) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(o) }] } }] }), { status: 200 });

// Google's error envelope, the shape the Gemini API answers a refused request with.
const googleError = (code: number, status: string, message: string, reason?: string) =>
  new Response(
    JSON.stringify({
      error: {
        code, message, status,
        ...(reason ? { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "googleapis.com" }] } : {}),
      },
    }),
    { status: code, headers: { "Content-Type": "application/json" } },
  );

const input = { audioPath: FIXTURE, mimeType: "audio/webm" as const, context: "test taker repeating a heard sentence" };

describe("composeEarsPrompt", () => {
  it("takes no target-sentence parameter (context is task framing only)", () => {
    // Arity check: the compose function accepts exactly one parameter (context). Adding a
    // target-sentence parameter here would risk biasing the verbatim transcript.
    expect(composeEarsPrompt.length).toBe(1);
  });

  it("demands a verbatim transcript that is not cleaned up", () => {
    const p = composeEarsPrompt("test taker repeating a heard sentence");
    expect(p).toContain("do not clean up");
    expect(p).toContain("test taker repeating a heard sentence");
  });

  it("requests all Delivery Report fields", () => {
    const p = composeEarsPrompt();
    expect(p).toContain("paceWpm");
    expect(p).toContain("pauses");
    expect(p).toContain("intelligibility");
    expect(p).toContain("suspectedMispronunciations");
    expect(p).toContain("intonation");
  });
});

describe("Ears transcript recording", () => {
  afterEach(() => resetModelCallSink());

  it("records the prompt and the returned transcript, but never the inlined recording", async () => {
    const rows: ModelCallInsert[] = [];
    setModelCallSink((row) => rows.push(row));
    const f = vi.fn().mockResolvedValue(geminiWrap(validResult));

    await hearRecording(input, f as never);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ route: "ears", provider: "gemini-http", outcome: "succeeded" });
    expect(rows[0].prompt).toContain("VERBATIM transcript");
    expect(rows[0].response).toContain(validResult.transcript);
    // The clip is the User's own recording, already on disk under a path the Item's row knows.
    // Copying its base64 into every transcription row would make this table the largest thing in
    // the database by an order of magnitude.
    const audioB64 = fs.readFileSync(FIXTURE).toString("base64");
    expect(JSON.stringify(rows[0])).not.toContain(audioB64);
  });
});

describe("hearRecording", () => {
  it("parses a valid gemini response into an EarsResult", async () => {
    const f = vi.fn().mockResolvedValue(geminiWrap(validResult));
    const r = await hearRecording(input, f as never);
    expect(r.transcript).toBe(validResult.transcript);
    expect(r.deliveryReport.paceWpm).toBe(132);
    expect((f.mock.calls[0][0] as string)).toContain("generativelanguage.googleapis.com");
  });

  it("sends the audio file base64-inlined with the right mime type", async () => {
    const f = vi.fn().mockResolvedValue(geminiWrap(validResult));
    await hearRecording(input, f as never);
    const [url, init] = f.mock.calls[0];
    expect(url).toContain("generateContent");
    expect((init as RequestInit).headers).toMatchObject({ "x-goog-api-key": expect.any(String) });
    const body = JSON.parse((init as RequestInit).body as string);
    const parts = body.contents[0].parts as { text?: string; inline_data?: { mime_type: string; data: string } }[];
    const audioPart = parts.find((p) => p.inline_data);
    expect(audioPart).toBeTruthy();
    expect(audioPart!.inline_data!.mime_type).toBe("audio/webm");
    expect(audioPart!.inline_data!.data).toBe(fs.readFileSync(FIXTURE).toString("base64"));
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json" });
  });

  it("repairs once on invalid JSON then succeeds", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(geminiWrap("not valid json result"))
      .mockResolvedValueOnce(geminiWrap(validResult));
    const r = await hearRecording(input, f as never);
    expect(r.transcript).toBe(validResult.transcript);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("gives up after the one JSON repair retry (invalid JSON twice)", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(geminiWrap("still not a result"))
      .mockResolvedValueOnce(geminiWrap("still not a result"));
    await expect(hearRecording(input, f as never)).rejects.toBeInstanceOf(EarsError);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("retries 429 then succeeds; gives up on 400 without retrying", async () => {
    const clock1 = virtualDelay();
    const f1 = vi.fn()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(geminiWrap(validResult));
    await expect(hearRecording(input, f1 as never, clock1.delay)).resolves.toBeTruthy();
    expect(f1).toHaveBeenCalledTimes(2);
    expect(clock1.waits).toEqual([1000]);

    const clock2 = virtualDelay();
    const f2 = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
    await expect(hearRecording(input, f2 as never, clock2.delay)).rejects.toBeInstanceOf(EarsError);
    expect(f2).toHaveBeenCalledTimes(1);
    expect(clock2.waits).toEqual([]);
  });
});

describe("EarsError normalization (no provider text, bounded classification)", () => {
  // Every call runs on virtual time; `waits` is the backoff schedule the call asked for.
  async function captureEarsError(fetchImpl: typeof fetch, clock = virtualDelay()): Promise<EarsError> {
    try {
      await hearRecording(input, fetchImpl, clock.delay);
    } catch (err) {
      expect(err).toBeInstanceOf(EarsError);
      return err as EarsError;
    }
    throw new Error("expected hearRecording to reject");
  }

  it("classifies HTTP 401/403 as authentication (terminal, not retried)", async () => {
    const f401 = vi.fn().mockResolvedValue(new Response("SECRET-KEY-abc123 invalid", { status: 401 }));
    const err401 = await captureEarsError(f401 as never);
    expect(err401.kind).toBe("authentication");
    expect(err401.safeMessage).toBe("authentication unavailable (HTTP 401)");
    expect(f401).toHaveBeenCalledTimes(1);

    const f403 = vi.fn().mockResolvedValue(new Response("forbidden body", { status: 403 }));
    const err403 = await captureEarsError(f403 as never);
    expect(err403.kind).toBe("authentication");
    expect(f403).toHaveBeenCalledTimes(1);
  });

  it("classifies HTTP 429 as rate-limit (retryable) and HTTP 5xx as provider (retryable)", async () => {
    const clock429 = virtualDelay();
    const f429 = vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }));
    const err429 = await captureEarsError(f429 as never, clock429);
    expect(err429.kind).toBe("rate-limit");
    expect(err429.safeMessage).toBe("rate limited (HTTP 429)");
    expect(f429).toHaveBeenCalledTimes(3); // initial + 2 backoff retries, per requestEarsJson's own delays
    expect(clock429.waits).toEqual([1000, 4000]);

    const clock500 = virtualDelay();
    const f500 = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    const err500 = await captureEarsError(f500 as never, clock500);
    expect(err500.kind).toBe("provider");
    expect(err500.safeMessage).toBe("provider unavailable (HTTP 503)");
    expect(clock500.waits).toEqual([1000, 4000]);
  });

  it("classifies HTTP 408 as timeout and HTTP 425 as provider, both retryable, not terminal 'unsupported-audio'", async () => {
    // 408 Request Timeout and 425 Too Early are transient: a retry can succeed. Classified as
    // 'unsupported-audio' they would fail the recording for good.
    const f408 = vi.fn().mockResolvedValue(new Response("request timeout", { status: 408 }));
    const err408 = await captureEarsError(f408 as never);
    expect(err408.kind).toBe("timeout");
    expect(err408.safeMessage).toBe("request timed out (HTTP 408)");
    expect(f408).toHaveBeenCalledTimes(3); // retried in-call, like every other transient kind

    const f425 = vi.fn().mockResolvedValue(new Response("too early", { status: 425 }));
    const err425 = await captureEarsError(f425 as never);
    expect(err425.kind).toBe("provider");
    expect(err425.safeMessage).toBe("provider unavailable (HTTP 425)");
    expect(f425).toHaveBeenCalledTimes(3);
  });

  it("classifies an HTTP 400 whose error names the audio as terminal 'unsupported-audio' and never retries it", async () => {
    const f400 = vi.fn().mockResolvedValue(googleError(400, "INVALID_ARGUMENT", "Unable to process input audio: the audio stream could not be decoded."));
    const err400 = await captureEarsError(f400 as never);
    expect(err400.kind).toBe("unsupported-audio");
    expect(err400.safeMessage).toBe("the provider could not process this recording's audio (HTTP 400)");
    expect(err400.safeMessage).not.toContain("decoded");
    expect(f400).toHaveBeenCalledTimes(1);

    const f415 = vi.fn().mockResolvedValue(new Response("unsupported media type", { status: 415 }));
    expect(await captureEarsError(f415 as never)).toMatchObject({ kind: "unsupported-audio" });
    expect(f415).toHaveBeenCalledTimes(1);
  });

  // Gemini answers 400 for faults of the request as well as of the media. Setup only checks that a
  // key is present, so a mistyped key reaches Ears; read as 'unsupported-audio' it would fail every
  // recording for good, and Attempt review would refuse to retry them once the key was fixed.
  it("classifies a 400 that names the API key as a repairable configuration fault whose message says what to fix", async () => {
    const leakedKey = "AIzaSy-not-a-real-key-123";
    const f = vi.fn().mockResolvedValue(googleError(400, "INVALID_ARGUMENT", `API key not valid. Please pass a valid API key. (${leakedKey})`, "API_KEY_INVALID"));
    const err = await captureEarsError(f as never);
    expect(err.kind).toBe("configuration");
    expect(err.safeMessage).toContain("GEMINI_API_KEY");
    expect(err.safeMessage).not.toContain(leakedKey);
    expect(err.safeMessage).not.toContain("not valid");
    // Never retried in-call: no backoff repairs a key.
    expect(f).toHaveBeenCalledTimes(1);

    const expired = vi.fn().mockResolvedValue(googleError(400, "INVALID_ARGUMENT", "API key expired. Please renew the API key.", "API_KEY_INVALID"));
    expect(await captureEarsError(expired as never)).toMatchObject({ kind: "configuration" });
  });

  it("classifies a 400 FAILED_PRECONDITION (an unsupported region) as a repairable configuration fault", async () => {
    const f = vi.fn().mockResolvedValue(googleError(400, "FAILED_PRECONDITION", "User location is not supported for the API use."));
    const err = await captureEarsError(f as never);
    expect(err.kind).toBe("configuration");
    expect(err.safeMessage).toContain("failed precondition");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("keeps a 400 it does not recognise retryable by the User, never terminal and never retried in-call", async () => {
    for (const response of [
      () => googleError(400, "INVALID_ARGUMENT", "Request contains an invalid argument."),
      () => new Response("bad request", { status: 400 }),
      // About the model's modalities, not these bytes: a GEMINI_JUDGE_MODEL that takes no audio.
      () => googleError(400, "INVALID_ARGUMENT", `Audio input modality is not enabled for models/${config.geminiJudgeModel}`),
    ]) {
      const f = vi.fn().mockImplementation(async () => response());
      const err = await captureEarsError(f as never);
      expect(err.kind).toBe("configuration");
      expect(err.safeMessage).toBe("Gemini rejected the request (HTTP 400); check GEMINI_API_KEY and GEMINI_JUDGE_MODEL, then retry");
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  // Gemini answers 404 for a wrong GEMINI_JUDGE_MODEL and 422 for a request it understood but would
  // not process. Those are configuration faults the User can repair, so they stay manually
  // retryable. As 'unsupported-audio', which is terminal and offers no Retry in Attempt review
  // (client/src/lib/transcriptionFailure.ts), a one-setting fix would leave the recording stranded.
  it("classifies HTTP 404 and 422 as a repairable configuration fault, not terminal 'unsupported-audio'", async () => {
    const f404 = vi.fn().mockResolvedValue(new Response("models/wrong-name is not found", { status: 404 }));
    const err404 = await captureEarsError(f404 as never);
    expect(err404.kind).toBe("configuration");
    expect(err404.safeMessage).toBe("configuration unavailable (HTTP 404)");
    // Not retried in-call: no backoff repairs a wrong model name. The recovery is a manual retry
    // once the setting is fixed, which is why 'configuration' stays out of the client's
    // UNRETRYABLE_FAILURE_KINDS.
    expect(f404).toHaveBeenCalledTimes(1);
    expect(err404.safeMessage).not.toContain("wrong-name");

    const f422 = vi.fn().mockResolvedValue(new Response("unprocessable entity", { status: 422 }));
    const err422 = await captureEarsError(f422 as never);
    expect(err422.kind).toBe("configuration");
    expect(err422.safeMessage).toBe("configuration unavailable (HTTP 422)");
    expect(f422).toHaveBeenCalledTimes(1);
  });

  it("classifies invalid/unparseable structured output as invalid-output without embedding the provider's actual text", async () => {
    const leaked = "PROVIDER_SECRET_LEAK_abcdef this is not json";
    const f = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: leaked }] } }] }), { status: 200 })
    );
    const err = await captureEarsError(f as never);
    expect(err.kind).toBe("invalid-output");
    expect(err.safeMessage).not.toContain("PROVIDER_SECRET_LEAK_abcdef");
    expect(err.safeMessage).not.toContain(leaked);
  });

  it("classifies a missing GEMINI_JUDGE_MODEL as configuration, without calling the provider", async () => {
    const original = config.geminiJudgeModel;
    config.geminiJudgeModel = "";
    try {
      const f = vi.fn();
      const err = await captureEarsError(f as never);
      expect(err.kind).toBe("configuration");
      expect(f).not.toHaveBeenCalled();
    } finally {
      config.geminiJudgeModel = original;
    }
  });

  it("classifies an aborted fetch as timeout and a generic network exception as network", async () => {
    const abortErr = new DOMException("aborted", "AbortError");
    const fTimeout = vi.fn().mockRejectedValue(abortErr);
    const errTimeout = await captureEarsError(fTimeout as never);
    expect(errTimeout.kind).toBe("timeout");
    expect(errTimeout.safeMessage).toBe("request timed out");

    const fNetwork = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const errNetwork = await captureEarsError(fNetwork as never);
    expect(errNetwork.kind).toBe("network");
    expect(errNetwork.safeMessage).toBe("network error contacting provider");
  });

  // A request that never answers: it settles only when its signal aborts, as undici's fetch does.
  function hangingFetch() {
    return vi.fn((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      }));
  }

  it("ends a request that never answers at the call's deadline, as a retryable timeout", async () => {
    const f = hangingFetch();
    const err = await hearRecording({ ...input, timeoutMs: 30 }, f as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EarsError);
    expect(err).toMatchObject({ kind: "timeout", safeMessage: "request timed out" });
    expect(f).toHaveBeenCalledTimes(1);
  }, 2_000);

  it("ends the call at its deadline while it waits to retry, as a timeout rather than an unclassified abort", async () => {
    const f = vi.fn().mockImplementation(async () => new Response("busy", { status: 503 }));
    // The real backoff (1 s before the first retry), which the 30 ms deadline cuts short.
    const err = await hearRecording({ ...input, timeoutMs: 30 }, f as never).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "timeout", safeMessage: "request timed out" });
    expect(f).toHaveBeenCalledTimes(1);
  }, 2_000);

  it("still ends at once on the caller's own signal, long before the deadline", async () => {
    const f = hangingFetch();
    const caller = new AbortController();
    const pending = hearRecording({ ...input, signal: caller.signal, timeoutMs: 60_000 }, f as never).catch((e: unknown) => e);
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    caller.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(EarsError);
    expect((f.mock.calls[0]![1] as RequestInit).signal?.aborted).toBe(true);
  }, 2_000);

  it("never puts a provider response body into safeMessage for any HTTP failure", async () => {
    const f = vi.fn().mockResolvedValue(new Response("ORCHESTRATION_LOG_CANARY sk-live-private-diagnostic", { status: 401 }));
    const err = await captureEarsError(f as never);
    expect(err.safeMessage).not.toContain("ORCHESTRATION_LOG_CANARY");
    expect(err.safeMessage).not.toContain("sk-live-private-diagnostic");
  });
});
