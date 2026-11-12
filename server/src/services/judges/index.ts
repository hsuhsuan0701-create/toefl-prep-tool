import { JudgeReportSchema, type JudgeReport } from "@toefl-prep/shared";
import { z } from "zod";
import { toProviderJsonSchema } from "../reasoning/jsonSchema.js";
import { abortableDelay } from "../../lib/abortableDelay.js";
import { config } from "../../lib/config.js";
import {
  type ProviderResult,
} from "../reasoning/contracts.js";
import {
  runOpenAiText as realRunOpenAiText,
} from "../reasoning/router.js";
import { composeJudgePrompt } from "./prompts.js";
// The prompt, not the JSON envelope around it, is what these rows store: the envelope's
// generationConfig/response_format are fixed per route and derivable from it, while the prompt is
// what the model actually saw — and it keeps an HTTP row readable next to a CLI one.
import { recordHttpModelCall } from "../modelCallLog.js";

export { composeJudgePrompt };

export type JudgeFailureHint = "audio-structural";

export type JudgeLabel = "gemini" | "openai" | "gemini-vision";
/** An HTTP status from the provider, or why no usable report came back. */
export type JudgeStatus = number | "config" | "invalid-json" | "unavailable";

function judgeErrorText(status: JudgeStatus): string {
  if (status === "config") return "configuration unavailable";
  if (status === "invalid-json") return "invalid structured output";
  if (status === "unavailable") return "structured reasoning unavailable";
  return "provider request failed";
}

/**
 * A Judge call that produced no report. The message is built only from the Judge, the status and a
 * fixed description: it reaches logs and job records, so it never carries a provider response body
 * or the model's output.
 */
export class JudgeError extends Error {
  readonly judge: JudgeLabel;
  readonly status: JudgeStatus;
  readonly hint?: JudgeFailureHint;

  /** `detail` is kept only when it is the audio-structural hint; any other text is dropped. */
  constructor(judge: JudgeLabel, status: JudgeStatus, detail?: string) {
    super(`judge ${judge} ${status}: ${judgeErrorText(status)}`);
    this.name = "JudgeError";
    this.judge = judge;
    this.status = status;
    if (detail === "audio-structural") this.hint = detail;
  }
}

// What every raw provider call returns, essay or speaking, Gemini or OpenAI, so all of them plug into
// withJudgeRetries.
export type JudgeCallResult =
  | { ok: true; text: string }
  | {
      ok: false;
      status: number;
      hint?: JudgeFailureHint;
    };

type JudgeInput = {
  taskType: "email" | "discussion";
  materials: object;
  responseText: string;
  signal?: AbortSignal;
};

export type EssayJudgeResult = {
  report: JudgeReport;
  provider: "gemini-http" | "codex" | "openai-http";
};

/** Test seams; each one defaults to the production implementation. */
export type OpenAiTextJudgeDeps = {
  fetchImpl?: typeof fetch;
  runOpenAiText?: typeof realRunOpenAiText;
  /** The wait before each HTTP retry (withJudgeRetries). */
  delay?: typeof abortableDelay;
};

type HttpReportRequest = (
  prompt: string,
  model: string
) => Promise<JudgeReport>;

/**
 * Scores one essay with one Judge. Gemini is called over HTTP; OpenAI goes through the OpenAI text
 * route (Codex CLI, then HTTP). Each HTTP call retries a 429/5xx and gets one JSON repair. Throws
 * JudgeError when no report comes back.
 */
export async function judgeEssay(
  judge: "gemini" | "openai",
  input: JudgeInput,
  deps: OpenAiTextJudgeDeps = {}
): Promise<EssayJudgeResult> {
  const { fetchImpl = fetch, runOpenAiText = realRunOpenAiText, delay = abortableDelay } = deps;
  const prompt = composeJudgePrompt(
    input.taskType,
    input.materials,
    input.responseText
  );

  if (judge === "gemini") {
    const report = await requestEssayReport("gemini", prompt, (value) =>
      geminiCall(value, fetchImpl, input.signal), input.signal, delay
    );
    return {
      report: stampEssay(report, "gemini", input.taskType),
      provider: "gemini-http",
    };
  }

  const routed = await runOpenAiJudgeText(
    prompt,
    runOpenAiText,
    (value, model) =>
      requestEssayReport(
        "openai",
        value,
        (requestPrompt) => openaiCall(requestPrompt, fetchImpl, model, input.signal),
        input.signal,
        delay,
      ),
    input.signal,
  );
  return {
    report: stampEssay(routed.report, "openai", input.taskType),
    provider: routed.provider,
  };
}

function stampEssay(
  report: JudgeReport,
  judge: "gemini" | "openai",
  taskType: "email" | "discussion"
): JudgeReport {
  return { ...report, judge, taskType };
}

async function requestEssayReport(
  judge: "gemini" | "openai",
  prompt: string,
  call: (prompt: string) => Promise<JudgeCallResult>,
  signal?: AbortSignal,
  delay?: typeof abortableDelay,
): Promise<JudgeReport> {
  let currentPrompt = prompt;
  for (let repair = 0; ; repair += 1) {
    const text = await withJudgeRetries(judge, () => call(currentPrompt), signal, delay);
    const parsed = safeParseReport(text);
    if (parsed) return parsed;
    if (repair >= 1) {
      throw new JudgeError(judge, "invalid-json");
    }
    currentPrompt =
      `${currentPrompt}\n\n` +
      "Your previous output was invalid. Output ONLY the JSON object.";
  }
}

export type OpenAiTextJudgeRouteResult = {
  report: JudgeReport;
  provider: "codex" | "openai-http";
};

/**
 * The OpenAI Judge's text call, shared by essay judging and Speaking's Text Fallback. The Judge
 * prompt goes to Codex as is (no skill packaging). The HTTP leg runs `requestHttpReport` with the
 * model the route resolved and reports a thrown JudgeError as that leg's failure kind. Any route
 * failure, or a route that throws, becomes JudgeError("openai", "unavailable").
 */
export async function runOpenAiJudgeText(
  prompt: string,
  runOpenAiText: typeof realRunOpenAiText,
  requestHttpReport: HttpReportRequest,
  signal?: AbortSignal,
): Promise<OpenAiTextJudgeRouteResult> {
  let result;
  try {
    result = await runOpenAiText(
      {
        prompt,
        jsonSchema: toProviderJsonSchema(JudgeReportSchema),
        parse: (value) => JudgeReportSchema.parse(value),
        ...(signal ? { signal } : {}),
      },
      {
        runHttp: async ({ prompt: httpPrompt, model }) => {
          try {
            const report = await requestHttpReport(
              httpPrompt,
              model
            );
            return {
              ok: true,
              value: report,
              provider: "openai-http",
            };
          } catch (error) {
            return normalizeOpenAiHttpError(error);
          }
        },
      }
    );
  } catch {
    throw new JudgeError("openai", "unavailable");
  }

  if (!result.ok) {
    throw new JudgeError("openai", "unavailable");
  }
  return { report: result.value, provider: result.provider };
}

/** Maps an error thrown on the OpenAI HTTP leg to the reasoning route's failure kinds. */
export function normalizeOpenAiHttpError<T>(
  error: unknown
): ProviderResult<T, "openai-http"> {
  let kind:
    | "configuration"
    | "authentication"
    | "rate-limit"
    | "provider"
    | "invalid-output"
    | "application" = "application";

  if (error instanceof JudgeError) {
    if (error.status === "config") {
      kind = "configuration";
    } else if (error.status === "invalid-json") {
      kind = "invalid-output";
    } else if (
      error.status === 401 ||
      error.status === 403
    ) {
      kind = "authentication";
    } else if (error.status === 429) {
      kind = "rate-limit";
    } else if (typeof error.status === "number") {
      kind = "provider";
    }
  }

  return {
    ok: false,
    failure: {
      provider: "openai-http",
      kind,
      source: "call",
    },
  };
}

// The JSON object in a Judge's output, parsed against JudgeReportSchema, or null. judges/speaking.ts
// uses the same parse.
export function safeParseReport(text: string): JudgeReport | null {
  try {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first === -1 || last <= first) return null;
    return JudgeReportSchema.parse(
      JSON.parse(text.slice(first, last + 1))
    );
  } catch {
    return null;
  }
}

// The 429/5xx backoff loop shared by every HTTP Judge call (and the scene-image vision check): two
// retries, 1s then 4s apart, then a JudgeError. Any other failed status throws at once. `delay` is
// the wait itself; tests pass one that returns at once.
export async function withJudgeRetries(
  judge: JudgeLabel,
  call: () => Promise<JudgeCallResult>,
  signal?: AbortSignal,
  delay: typeof abortableDelay = abortableDelay,
): Promise<string> {
  const delays = [1000, 4000];
  for (let i = 0; ; i += 1) {
    signal?.throwIfAborted();
    const result = await call();
    if (result.ok) return result.text;
    const retryable =
      result.status === 429 || result.status >= 500;
    if (!retryable || i >= delays.length) {
      throw new JudgeError(
        judge,
        result.status,
        result.hint
      );
    }
    await delay(delays[i]!, signal);
  }
}

// The Gemini text-only Judge call. Exported for the speaking calibration script's text-only path.
export async function geminiCall(
  prompt: string,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<JudgeCallResult> {
  if (!config.geminiJudgeModel) throw new JudgeError("gemini", "config");
  const startedAt = Date.now();
  const response = await fetchImpl(
    `https://generativelanguage.googleapis.com/v1beta/models/${config.geminiJudgeModel}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": config.geminiKey ?? "",
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
        },
      }),
      ...(signal ? { signal } : {}),
    }
  );
  if (!response.ok) {
    recordHttpModelCall({
      provider: "gemini-http",
      route: "gemini-essay-judge",
      model: config.geminiJudgeModel,
      requestBody: prompt,
      ok: false,
      failureKind: `http-${response.status}`,
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: false,
      status: response.status,
    };
  }
  const json = await safeResponseJson<{
    candidates?: {
      content?: { parts?: { text?: string }[] };
    }[];
  }>(response);
  const text = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  recordHttpModelCall({
    provider: "gemini-http",
    route: "gemini-essay-judge",
    model: config.geminiJudgeModel,
    requestBody: prompt,
    responseBody: text,
    ok: true,
    durationMs: Date.now() - startedAt,
  });
  return { ok: true, text };
}

// `model` is the one the OpenAI text route resolved for its HTTP leg; a direct caller may omit it
// and get the configured Judge model.
export async function openaiCall(
  prompt: string,
  fetchImpl: typeof fetch,
  model?: string,
  signal?: AbortSignal,
): Promise<JudgeCallResult> {
  const selectedModel = model ?? config.openaiJudgeModel;
  if (!selectedModel) throw new JudgeError("openai", "config");
  const startedAt = Date.now();
  const response = await fetchImpl(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: selectedModel,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
      ...(signal ? { signal } : {}),
    }
  );
  if (!response.ok) {
    recordHttpModelCall({
      provider: "openai-http",
      route: "openai-text-judge",
      model: selectedModel,
      requestBody: prompt,
      ok: false,
      failureKind: `http-${response.status}`,
      durationMs: Date.now() - startedAt,
    });
    return {
      ok: false,
      status: response.status,
    };
  }
  const json = await safeResponseJson<{
    choices?: { message?: { content?: string } }[];
  }>(response);
  const text = json?.choices?.[0]?.message?.content ?? "";
  recordHttpModelCall({
    provider: "openai-http",
    route: "openai-text-judge",
    model: selectedModel,
    requestBody: prompt,
    responseBody: text,
    ok: true,
    durationMs: Date.now() - startedAt,
  });
  return { ok: true, text };
}

export async function safeResponseJson<T>(
  response: Response
): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}
