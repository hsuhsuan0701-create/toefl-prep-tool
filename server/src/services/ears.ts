import fs from "node:fs";
import { EarsResultSchema, type EarsResult } from "@toefl-prep/shared";
import { abortableDelay } from "../lib/abortableDelay.js";
import { config } from "../lib/config.js";
import { recordHttpModelCall } from "./modelCallLog.js";

// The failure kinds Ears can report: a subset of TranscriptionFailureKind (shared/src/viewModels.ts),
// so an EarsError's `kind` is assignable there directly. The three kinds this leaves out
// (unsafe-path, missing-recording, corrupt-recording) come from transcription recovery's own
// validation of the stored recording before Ears is called.
export type EarsFailureKind =
  | "network"
  | "timeout"
  | "rate-limit"
  | "provider"
  | "invalid-output"
  | "authentication"
  | "configuration"
  | "unsupported-audio";

// `safeMessage` is the only text this error surfaces to logs and persistence: bounded, normalized,
// and never provider output. `message` mirrors it, so code reading `.message` off a caught Error
// cannot leak provider text either.
export class EarsError extends Error {
  constructor(
    public readonly status: number | string,
    public readonly kind: EarsFailureKind,
    public readonly safeMessage: string,
  ) {
    super(safeMessage);
  }
}

// Takes only the task-framing context, never a target sentence: Ears must transcribe what was said,
// and a target in the prompt would bias the model toward "correcting" the verbatim transcript to it.
export function composeEarsPrompt(context?: string): string {
  return [
    `You are transcribing a TOEFL iBT speaking test taker's spoken audio response.`,
    context ? `## Task context\n${context}` : undefined,
    `## Instructions`,
    `Produce a VERBATIM transcript of exactly what the speaker said. Preserve all disfluencies — um, uh, false starts, repetitions, self-corrections — exactly as spoken; do not clean up the wording, do not paraphrase, and do not correct grammar or word choice.`,
    `Also produce a Delivery Report describing HOW it was delivered (not what it means):`,
    `- paceWpm: estimated speaking rate in words per minute (a number, or null if it cannot be estimated from the audio)`,
    `- pauses: description of pause patterns (length and location of notable pauses)`,
    `- intelligibility: overall intelligibility of the speech`,
    `- suspectedMispronunciations: array of words or phrases that sounded mispronounced`,
    `- intonation: description of intonation and prosody`,
    `## Output`,
    `Return ONLY a JSON object, no prose, matching exactly:`,
    `{"transcript":"<verbatim transcript, disfluencies included>","deliveryReport":{"paceWpm":<number|null>,"pauses":"...","intelligibility":"...","suspectedMispronunciations":["..."],"intonation":"..."}}`,
  ].filter((line): line is string => Boolean(line)).join("\n\n");
}

/**
 * How long one hearRecording call may take, its in-call retries and its repair request included.
 * A Speaking Response is at most about a minute of audio, which Gemini answers in seconds, so this
 * leaves room for the full retry sequence (up to six requests) at about half a minute each. Without
 * it, a request that never answers would wait out undici's own 300 s limit per phase.
 */
export const EARS_CALL_TIMEOUT_MS = 180_000;

/**
 * Transcribes one recording verbatim and produces its Delivery Report through Gemini. A status that
 * classifies as rate-limit, provider or timeout is retried in-call after 1s and then 4s; output that
 * fails EarsResultSchema gets one repair request. The whole call ends at `timeoutMs`
 * (EARS_CALL_TIMEOUT_MS by default) with a retryable 'timeout', as an HTTP 408 would; the caller's
 * `signal` still cancels it sooner. Every failure is thrown as an EarsError carrying a normalized
 * kind and a safe message.
 */
export async function hearRecording(
  input: { audioPath: string; mimeType: "audio/webm" | "audio/mpeg"; context?: string; signal?: AbortSignal; timeoutMs?: number },
  fetchImpl: typeof fetch = fetch,
  // The wait before each in-call retry. Tests pass one that returns at once and records the wait.
  delay: typeof abortableDelay = abortableDelay,
): Promise<EarsResult> {
  const deadline = AbortSignal.timeout(input.timeoutMs ?? EARS_CALL_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const audioB64 = fs.readFileSync(input.audioPath).toString("base64");
  const prompt = composeEarsPrompt(input.context);
  try {
    let text = await requestEarsJson(prompt, audioB64, input.mimeType, fetchImpl, delay, signal);
    for (let repair = 0; ; repair++) {
      const parsed = safeParseEarsResult(text);
      if (parsed) return parsed;
      // A fixed message, never the invalid text: that is provider output and may quote the transcript.
      if (repair >= 1) throw new EarsError("invalid-json", "invalid-output", "invalid structured output from provider");
      text = await requestEarsJson(
        `${prompt}\n\nYour previous output was invalid. Output ONLY the JSON object.`,
        audioB64,
        input.mimeType,
        fetchImpl,
        delay,
        signal,
      );
    }
  } catch (err) {
    // The deadline, not the caller, ended the call, wherever it was: in a request, reading a body, or
    // waiting to retry. Transient, like an HTTP 408, so transcription recovery retries it on its own
    // schedule.
    if (deadline.aborted && !input.signal?.aborted) throw new EarsError("timeout", "timeout", "request timed out");
    throw err;
  }
}

function safeParseEarsResult(text: string): EarsResult | null {
  try {
    const first = text.indexOf("{"), last = text.lastIndexOf("}");
    if (first === -1 || last <= first) return null;
    return EarsResultSchema.parse(JSON.parse(text.slice(first, last + 1)));
  } catch {
    return null;
  }
}

/**
 * What a rejected request's error body says went wrong, read from Google's error envelope
 * (`{"error":{"status","message","details":[{"reason"}]}}`). Gemini answers 400 for request-level
 * faults as well as for media it cannot process:
 *
 *   api-key       a detail reason starting `API_KEY_` (`API_KEY_INVALID` for a mistyped or expired
 *                 key), or a message that names the API key.
 *   precondition  `FAILED_PRECONDITION`: the request is well formed but cannot be served for this
 *                 account, chiefly an unsupported region.
 *   audio         a message that names the audio or its media type, and not the model or its
 *                 modalities: "this model takes no audio" is a GEMINI_JUDGE_MODEL fault, which a
 *                 setting repairs. The configured model's own name is removed first, as in the
 *                 speaking Judge's audio check, because a model name can contain "audio".
 *   unrecognized  anything else, an unreadable body included.
 *
 * Only `audio` is taken to be about the recording itself.
 */
type RejectedRequestCause = "api-key" | "precondition" | "audio" | "unrecognized";

const AUDIO_REJECTION_PATTERN = /audio|mime|media/i;
const MODEL_FAULT_PATTERN = /\bmodels?\b|modalit/i;

function classifyRejectedRequest(body: string, model: string): RejectedRequestCause {
  let error: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    const candidate = typeof parsed === "object" && parsed !== null ? (parsed as { error?: unknown }).error : undefined;
    error = typeof candidate === "object" && candidate !== null ? (candidate as Record<string, unknown>) : undefined;
  } catch {
    error = undefined;
  }
  if (!error) return "unrecognized";
  const status = typeof error.status === "string" ? error.status : "";
  const message = typeof error.message === "string" ? error.message : "";
  const reasons = Array.isArray(error.details)
    ? error.details.flatMap((detail: unknown) => {
        const reason = typeof detail === "object" && detail !== null ? (detail as { reason?: unknown }).reason : undefined;
        return typeof reason === "string" ? [reason] : [];
      })
    : [];
  if (reasons.some((reason) => reason.startsWith("API_KEY_")) || /api[\s_-]?key/i.test(message)) return "api-key";
  if (status === "FAILED_PRECONDITION") return "precondition";
  const withoutModel = model ? message.split(model).join("") : message;
  if (AUDIO_REJECTION_PATTERN.test(withoutModel) && !MODEL_FAULT_PATTERN.test(withoutModel)) return "audio";
  return "unrecognized";
}

// HTTP status (and, for a 400, its error body) -> normalized kind. The kind decides what recovers
// the recording:
// - 408 (timeout), 429 (rate-limit), and 425 Too Early and 5xx (provider): transient, retried
//   in-call and then on transcription recovery's automatic schedule.
// - 401/403 (authentication), and 404/422 and every 400 that is not about the audio
//   (configuration; a wrong GEMINI_JUDGE_MODEL answers 404, a mistyped GEMINI_API_KEY answers 400):
//   no backoff repairs them, so they are not retried automatically, but Attempt review keeps the
//   User's manual Retry for after the key or setting is fixed. A 400 the body does not explain lands
//   here too, so an unrecognised rejection can never strand a recording or loop on paid calls.
// - a 400 whose error names the audio, 413 Payload Too Large and 415 Unsupported Media Type
//   (unsupported-audio): Gemini cannot process these bytes and a retry would send the same bytes,
//   so it is terminal and Attempt review offers no Retry.
// - any other status: configuration, for the same reason as an unrecognised 400.
function classifyHttpStatus(status: number, cause: RejectedRequestCause | undefined): EarsFailureKind {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate-limit";
  if (status === 408) return "timeout";
  if (status === 425) return "provider";
  if (status >= 500) return "provider";
  if (status === 413 || status === 415) return "unsupported-audio";
  if (status === 400 && cause === "audio") return "unsupported-audio";
  return "configuration";
}

// Fixed text per kind and cause, e.g. "authentication unavailable (HTTP 401)"; never provider-supplied
// text, and never the key itself. Attempt review shows it as the failure's reason, so a fault the
// User can repair says what to repair.
function safeStatusMessage(status: number, kind: EarsFailureKind, cause: RejectedRequestCause | undefined): string {
  if (kind === "authentication") return `authentication unavailable (HTTP ${status})`;
  if (kind === "rate-limit") return `rate limited (HTTP ${status})`;
  if (kind === "provider") return `provider unavailable (HTTP ${status})`;
  if (kind === "timeout") return `request timed out (HTTP ${status})`;
  if (kind === "unsupported-audio") return `the provider could not process this recording's audio (HTTP ${status})`;
  if (status === 400 && cause === "api-key") return `Gemini rejected the API key (HTTP ${status}); check GEMINI_API_KEY, then retry`;
  if (status === 400 && cause === "precondition") {
    return `Gemini refused the request for this account (HTTP ${status}, failed precondition), for example from an unsupported region; retry once the Gemini API is available`;
  }
  if (status === 400) return `Gemini rejected the request (HTTP ${status}); check GEMINI_API_KEY and GEMINI_JUDGE_MODEL, then retry`;
  return `configuration unavailable (HTTP ${status})`;
}

// Parallels withJudgeRetries (judges/index.ts) on purpose rather than sharing it: Ears retries by
// normalized kind, which adds 408 and 425 to the Judges' 429/5xx, and its errors carry a kind and
// no Judge name.
async function requestEarsJson(
  prompt: string,
  audioB64: string,
  mimeType: "audio/webm" | "audio/mpeg",
  fetchImpl: typeof fetch,
  delay: typeof abortableDelay,
  signal?: AbortSignal,
): Promise<string> {
  const delays = [1000, 4000];
  for (let i = 0; ; i++) {
    signal?.throwIfAborted();
    const res = await geminiEarsCall(prompt, audioB64, mimeType, fetchImpl, signal);
    if (res.ok) return res.text;
    const kind = classifyHttpStatus(res.status, res.cause);
    // "timeout" here can only be an HTTP 408: geminiEarsCall throws its own abort/network failures
    // rather than returning a status.
    const retryable = kind === "rate-limit" || kind === "provider" || kind === "timeout";
    if (!retryable || i >= delays.length) {
      throw new EarsError(res.status, kind, safeStatusMessage(res.status, kind, res.cause));
    }
    await delay(delays[i]!, signal);
  }
}

async function geminiEarsCall(
  prompt: string,
  audioB64: string,
  mimeType: "audio/webm" | "audio/mpeg",
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<{ ok: true; text: string } | { ok: false; status: number; cause?: RejectedRequestCause }> {
  if (!config.geminiJudgeModel) {
    throw new EarsError("config", "configuration", "configuration unavailable (GEMINI_JUDGE_MODEL not set)");
  }
  let res: Response;
  try {
    res = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiJudgeModel}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": config.geminiKey ?? "" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: audioB64 } }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
        ...(signal ? { signal } : {}),
      }
    );
  } catch (err) {
    // fetch itself threw: an abort of the caller's signal (classified as timeout) or a network
    // failure (DNS, connection refused, TLS). Both kinds are retryable on transcription recovery's
    // schedule, though recovery discards the error of a call it aborted itself at shutdown.
    const isAbort = err instanceof Error && err.name === "AbortError";
    throw new EarsError(
      "network",
      isAbort ? "timeout" : "network",
      isAbort ? "request timed out" : "network error contacting provider"
    );
  }
  // The prompt only: the clip is the caller's own recording, already on disk, and inlining its
  // base64 here would be the largest thing in the database by an order of magnitude.
  if (!res.ok) {
    recordHttpModelCall({
      provider: "gemini-http", route: "ears", model: config.geminiJudgeModel,
      requestBody: prompt, ok: false, failureKind: `http-${res.status}`,
    });
    if (res.status !== 400) return { ok: false as const, status: res.status };
    // Only a 400's body is read, and only its classification leaves this function: the body is
    // provider text and never reaches a message, a log or the job row.
    let body = "";
    try {
      body = await res.text();
    } catch {
      body = "";
    }
    return { ok: false as const, status: res.status, cause: classifyRejectedRequest(body, config.geminiJudgeModel) };
  }
  const json = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  recordHttpModelCall({
    provider: "gemini-http", route: "ears", model: config.geminiJudgeModel,
    requestBody: prompt, responseBody: text, ok: true,
  });
  return { ok: true as const, text };
}
