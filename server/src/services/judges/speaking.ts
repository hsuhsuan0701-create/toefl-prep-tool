import fs from "node:fs";
import type { JudgeReport } from "@toefl-prep/shared";
import { config } from "../../lib/config.js";
import { abortableDelay } from "../../lib/abortableDelay.js";
import { runOpenAiText as realRunOpenAiText } from "../reasoning/router.js";
import {
  JudgeError,
  openaiCall,
  runOpenAiJudgeText,
  safeResponseJson,
  safeParseReport,
  withJudgeRetries,
  type JudgeCallResult,
  type OpenAiTextJudgeDeps,
} from "./index.js";
import { composeSpeakingJudgePrompt, type SpeakingJudgeItem } from "./prompts.js";
import { recordHttpModelCall } from "../modelCallLog.js";

export { composeSpeakingJudgePrompt };
export type { SpeakingJudgeItem };

export type SpeakingJudgeResult = {
  report: JudgeReport;
  mode: "audio" | "text-fallback";
  provider: "gemini-http" | "openai-http" | "codex";
};

type SpeakingJudgeInput = { taskType: "listen_repeat" | "interview"; items: SpeakingJudgeItem[]; signal?: AbortSignal };
export type SpeakingJudgeDeps = OpenAiTextJudgeDeps;

/**
 * Scores every given Item of one Speaking Task Type in one call per Judge, from the recordings
 * themselves (ADR 0002). Gemini gets each recording inline and always returns mode "audio". OpenAI
 * gets each Item's mp3 as input_audio; only a structural audio failure (isAudioStructuralFailure)
 * sends it to Text Fallback, which scores from transcript and Delivery Report through the OpenAI
 * text route and returns mode "text-fallback". A 429, 5xx or auth failure is thrown, never degraded.
 */
export async function judgeSpeaking(
  judge: "gemini" | "openai",
  input: SpeakingJudgeInput,
  deps: SpeakingJudgeDeps = {}
): Promise<SpeakingJudgeResult> {
  const { fetchImpl = fetch, runOpenAiText = realRunOpenAiText, delay = abortableDelay } = deps;
  const prompt = composeSpeakingJudgePrompt(input.taskType, input.items);

  if (judge === "gemini") {
    const report = await requestSpeakingReport("gemini", prompt, (p) => geminiAudioCall(p, input.items, fetchImpl, input.signal), input.signal, delay);
    return {
      report: stamp(report, "gemini", input.taskType),
      mode: "audio",
      provider: "gemini-http",
    };
  }

  try {
    const report = await requestSpeakingReport("openai", prompt, (p) => openaiAudioCall(p, input.items, fetchImpl, input.signal), input.signal, delay);
    return {
      report: stamp(report, "openai", input.taskType),
      mode: "audio",
      provider: "openai-http",
    };
  } catch (err) {
    if (!(err instanceof JudgeError) || !isAudioStructuralFailure(err)) throw err;
    // Logged so a persistent degradation (a configured model that cannot take audio downgrades every
    // call) is visible in the server log, not only in each Judge Report's mode.
    console.warn(
      "openai audio judge degraded to text-fallback",
      { status: err.status }
    );
    // A separate prompt, not the audio one with the parts dropped: the audio prompt tells the Judge
    // to listen to the recording, and the text-fallback prompt says instead that no audio was sent.
    return judgeSpeakingTextFallback(input, {
      fetchImpl,
      runOpenAiText,
      delay,
    });
  }
}

// The OpenAI Judge's Text Fallback, through runOpenAiJudgeText (Codex CLI, then HTTP). Called on a
// structural audio failure above, and by the speaking calibration script.
export async function judgeSpeakingTextFallback(
  input: SpeakingJudgeInput,
  deps: SpeakingJudgeDeps = {}
): Promise<SpeakingJudgeResult> {
  const { fetchImpl = fetch, runOpenAiText = realRunOpenAiText, delay = abortableDelay } = deps;
  const fallbackPrompt = composeSpeakingJudgePrompt(
    input.taskType,
    input.items,
    "text-fallback"
  );
  const routed = await runOpenAiJudgeText(
    fallbackPrompt,
    runOpenAiText,
    (prompt, model) =>
      requestSpeakingReport(
        "openai",
        prompt,
        (value) => openaiCall(value, fetchImpl, model, input.signal),
        input.signal,
        delay,
      ),
    input.signal,
  );
  return {
    report: stamp(routed.report, "openai", input.taskType),
    mode: "text-fallback",
    provider: routed.provider,
  };
}

function stamp(report: JudgeReport, judge: "gemini" | "openai", taskType: "listen_repeat" | "interview"): JudgeReport {
  return { ...report, judge, taskType };
}

// The 429/5xx backoff (withJudgeRetries) plus one JSON repair that re-sends the call with a
// correction note appended, over any raw call: Gemini audio, OpenAI audio, or the Text Fallback's
// HTTP leg. Exported for the speaking calibration script.
export async function requestSpeakingReport(
  judge: "gemini" | "openai",
  prompt: string,
  call: (prompt: string) => Promise<JudgeCallResult>,
  signal?: AbortSignal,
  delay?: OpenAiTextJudgeDeps["delay"],
): Promise<JudgeReport> {
  let p = prompt;
  for (let repair = 0; ; repair++) {
    const text = await withJudgeRetries(judge, () => call(p), signal, delay);
    const parsed = safeParseReport(text);
    if (parsed) return parsed;
    if (repair >= 1) {
      throw new JudgeError(judge, "invalid-json");
    }
    p = `${p}\n\nYour previous output was invalid. Output ONLY the JSON object.`;
  }
}

// The statuses with which the endpoint refuses a request's content rather than its credentials, its
// rate or its own health: a bad request, an unsupported media type, an unprocessable body.
const AUDIO_REJECTION_STATUSES: ReadonlySet<number> = new Set([400, 415, 422]);

/**
 * Whether a failed audio call says this model cannot take this audio input: one of
 * AUDIO_REJECTION_STATUSES, with an error that names the audio (`audio`, `input_audio`) or the
 * `modalities` it was sent. The configured model's own name is removed first: an audio model's name
 * contains "audio", and an error about the model itself (a 400 or 404 for a name that does not
 * exist, say) is configuration, which Text Fallback would only hide. Anything else, a 404 or 408
 * included, is not structural, so it is thrown rather than degraded.
 */
function isAudioInputRejection(status: number, body: string, model: string): boolean {
  if (!AUDIO_REJECTION_STATUSES.has(status)) return false;
  const withoutModel = model ? body.split(model).join("") : body;
  return /audio|modalit/i.test(withoutModel);
}

// openaiAudioCall reads the body and keeps only the hint isAudioInputRejection gave it, so this
// predicate never sees provider text.
function isAudioStructuralFailure(err: JudgeError): boolean {
  return typeof err.status === "number" && AUDIO_REJECTION_STATUSES.has(err.status) && err.hint === "audio-structural";
}

// The declared mime follows the file read: normally the browser's webm upload, but a script may hand
// Gemini an mp3, which it accepts as audio/mpeg.
function mimeTypeFor(audioPath: string): "audio/webm" | "audio/mpeg" {
  return audioPath.toLowerCase().endsWith(".mp3") ? "audio/mpeg" : "audio/webm";
}

/**
 * What the transcript log stores for an audio judge call: the prompt, plus a manifest of the clips
 * that were attached to it. The clips themselves are megabytes of base64 and already exist on disk —
 * copying them into a row would bloat the database without adding anything a path does not, and the
 * recording is the one artifact here that is genuinely large.
 */
function audioPromptRecord(prompt: string, items: SpeakingJudgeItem[]): string {
  return [
    prompt,
    "",
    "[attached audio]",
    ...items.map((item) => `${item.itemId}: ${item.audioPath}`),
  ].join("\n");
}

async function geminiAudioCall(prompt: string, items: SpeakingJudgeItem[], fetchImpl: typeof fetch, signal?: AbortSignal): Promise<JudgeCallResult> {
  if (!config.geminiJudgeModel) throw new JudgeError("gemini", "config");
  const parts: Array<{ text: string } | { inline_data: { mime_type: string; data: string } }> = [{ text: prompt }];
  for (const item of items) {
    parts.push({ text: `Item ${item.itemId} audio:` });
    parts.push({
      inline_data: { mime_type: mimeTypeFor(item.audioPath), data: fs.readFileSync(item.audioPath).toString("base64") },
    });
  }
  const startedAt = Date.now();
  const res = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiJudgeModel}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": config.geminiKey ?? "" },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseMimeType: "application/json" } }),
      ...(signal ? { signal } : {}),
    }
  );
  if (!res.ok) {
    recordHttpModelCall({
      provider: "gemini-http", route: "gemini-speaking-judge", model: config.geminiJudgeModel,
      requestBody: audioPromptRecord(prompt, items), ok: false,
      failureKind: `http-${res.status}`, durationMs: Date.now() - startedAt,
    });
    return { ok: false as const, status: res.status };
  }
  const json = await safeResponseJson<{
    candidates?: {
      content?: { parts?: { text?: string }[] };
    }[];
  }>(res);
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  recordHttpModelCall({
    provider: "gemini-http", route: "gemini-speaking-judge", model: config.geminiJudgeModel,
    requestBody: audioPromptRecord(prompt, items), responseBody: text, ok: true,
    durationMs: Date.now() - startedAt,
  });
  return { ok: true as const, text };
}

// Chat Completions, because the Responses API rejects input_audio, and no response_format, because
// structured outputs do not combine with audio input on this model family; the prompt asks for
// JSON and requestSpeakingReport repairs it (docs/research/2026-07-28-audio-judge-apis.md).
async function openaiAudioCall(prompt: string, items: SpeakingJudgeItem[], fetchImpl: typeof fetch, signal?: AbortSignal): Promise<JudgeCallResult> {
  if (!config.openaiAudioJudgeModel) throw new JudgeError("openai", "config");
  const content: Array<{ type: "text"; text: string } | { type: "input_audio"; input_audio: { data: string; format: "mp3" } }> = [
    { type: "text", text: prompt },
  ];
  for (const item of items) {
    content.push({ type: "text", text: `Item ${item.itemId} audio:` });
    content.push({ type: "input_audio", input_audio: { data: fs.readFileSync(item.audioPath).toString("base64"), format: "mp3" } });
  }
  const startedAt = Date.now();
  const res = await fetchImpl("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${config.openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.openaiAudioJudgeModel, modalities: ["text"], messages: [{ role: "user", content }] }),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    let diagnostic = "";
    try {
      diagnostic = await res.text();
    } catch {
      diagnostic = "";
    }
    recordHttpModelCall({
      provider: "openai-http", route: "openai-audio-judge", model: config.openaiAudioJudgeModel,
      requestBody: audioPromptRecord(prompt, items), ok: false,
      failureKind: `http-${res.status}`, durationMs: Date.now() - startedAt,
    });
    return {
      ok: false as const,
      status: res.status,
      ...(isAudioInputRejection(res.status, diagnostic, config.openaiAudioJudgeModel)
        ? { hint: "audio-structural" as const }
        : {}),
    };
  }
  const json = await safeResponseJson<{
    choices?: { message?: { content?: string } }[];
  }>(res);
  const text = json?.choices?.[0]?.message?.content ?? "";
  recordHttpModelCall({
    provider: "openai-http", route: "openai-audio-judge", model: config.openaiAudioJudgeModel,
    requestBody: audioPromptRecord(prompt, items), responseBody: text, ok: true,
    durationMs: Date.now() - startedAt,
  });
  return { ok: true as const, text };
}
