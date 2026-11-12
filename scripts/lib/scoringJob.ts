// The calibration scripts' client for a scoring job: read the 202 that starts it, poll
// GET /api/attempts/:id/score-jobs/:jobId until it ends, and validate the result's shape.
import { ScoreReportSchema, type ScoreReport } from "@toefl-prep/shared";
import { z } from "zod";

export type ListenRepeatScoreResponse = {
  taskType: "listen_repeat";
  report: ScoreReport;
  judges: {
    judge: "gemini" | "openai";
    mode: "audio" | "text-fallback";
    items: { itemId: string; score: number }[];
  }[];
  judgesFailed: string[];
  items: { itemId: string; target?: string; diff?: unknown[] }[];
};

const ListenRepeatScoreResponseSchema = z.object({
  taskType: z.literal("listen_repeat"),
  report: ScoreReportSchema,
  judges: z.array(
    z.object({
      judge: z.enum(["gemini", "openai"]),
      mode: z.enum(["audio", "text-fallback"]),
      items: z.array(
        z.object({
          itemId: z.string(),
          score: z.number(),
        })
      ),
    })
  ),
  judgesFailed: z.array(z.string()),
  items: z.array(
    z.object({
      itemId: z.string(),
      target: z.string().optional(),
      diff: z.array(z.unknown()).optional(),
    })
  ),
});

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

/** The job id from POST .../score's response; throws unless it is a 202 carrying a job id. */
export function parseAcceptedScoringJob(
  responseStatus: number,
  value: unknown
): string {
  if (responseStatus !== 202) {
    throw new Error(
      `POST .../score returned unexpected HTTP ${responseStatus}; expected 202.`
    );
  }
  if (
    !isRecord(value) ||
    typeof value.jobId !== "string" ||
    value.jobId.trim().length === 0
  ) {
    throw new Error(
      "POST .../score returned an invalid accepted response: missing jobId."
    );
  }
  return value.jobId;
}

export function parseListenRepeatScoreResult(
  value: unknown
): ListenRepeatScoreResponse {
  const parsed = ListenRepeatScoreResponseSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.report.taskType !== "listen_repeat"
  ) {
    throw new Error(
      "Scoring job returned an invalid result."
    );
  }
  return parsed.data;
}

/** What a finished Write an Email or Academic Discussion scoring job returns (scoreItems.ts). */
export type EssayScoreResponse = {
  taskType: "email" | "discussion";
  report: ScoreReport;
  judges: { judge: "gemini" | "openai"; score: number }[];
  judgesFailed: string[];
};

const EssayScoreResponseSchema = z.object({
  taskType: z.enum(["email", "discussion"]),
  report: ScoreReportSchema,
  judges: z.array(z.object({ judge: z.enum(["gemini", "openai"]), score: z.number() })),
  judgesFailed: z.array(z.string()),
});

export function parseEssayScoreResult(value: unknown): EssayScoreResponse {
  const parsed = EssayScoreResponseSchema.safeParse(value);
  if (!parsed.success || parsed.data.report.taskType !== parsed.data.taskType || parsed.data.report.items.length !== 1) {
    throw new Error("Scoring job returned an invalid result.");
  }
  return parsed.data;
}

type PollScoringJobOptions = {
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutError(
  jobId: string,
  timeoutMs: number
): Error {
  return new Error(
    `Scoring job ${jobId} timed out after ${timeoutMs}ms.`
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(
      "Scoring job poll returned malformed JSON."
    );
  }
}

/**
 * Polls the job until it is done and returns its result through `parseResult`. Throws when the job
 * fails or is cancelled, on any malformed reply, and when the deadline passes, which also aborts a
 * poll still in flight.
 */
export async function pollScoringJobResult<T>(
  baseUrl: string,
  attemptId: string,
  jobId: string,
  parseResult: (value: unknown) => T,
  options: PollScoringJobOptions = {}
): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const intervalMs =
    options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const startedAt = now();
  const deadlineAt = startedAt + timeoutMs;
  const url =
    `${baseUrl}/api/attempts/` +
    `${encodeURIComponent(attemptId)}/score-jobs/` +
    encodeURIComponent(jobId);

  while (true) {
    const pollRemaining = deadlineAt - now();
    if (pollRemaining <= 0) {
      throw timeoutError(jobId, timeoutMs);
    }

    const controller = new AbortController();
    const deadlineTimer = setTimeout(
      () => controller.abort(),
      pollRemaining
    );
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `Scoring job ${jobId} poll failed with HTTP ${response.status}.`
        );
      }
      const body = await readJson(response);
      if (
        controller.signal.aborted ||
        now() >= deadlineAt
      ) {
        throw timeoutError(jobId, timeoutMs);
      }
      if (!isRecord(body) || typeof body.status !== "string") {
        throw new Error(
          `Scoring job ${jobId} poll returned an invalid status.`
        );
      }

      if (body.status === "done") {
        try {
          return parseResult(body.result);
        } catch {
          throw new Error(
            `Scoring job ${jobId} returned an invalid result.`
          );
        }
      }
      if (body.status === "failed") {
        throw new Error(`Scoring job ${jobId} failed.`);
      }
      if (body.status === "cancelled") {
        throw new Error(
          `Scoring job ${jobId} was cancelled (a newer scoring of the same Task Type replaces a running one).`
        );
      }
      if (
        body.status !== "queued" &&
        body.status !== "running"
      ) {
        throw new Error(
          `Scoring job ${jobId} returned an unknown status.`
        );
      }
    } catch (error) {
      if (
        controller.signal.aborted ||
        now() >= deadlineAt
      ) {
        throw timeoutError(jobId, timeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
    }

    const remaining = deadlineAt - now();
    if (remaining <= 0) {
      throw timeoutError(jobId, timeoutMs);
    }
    await sleep(Math.min(intervalMs, remaining));
  }
}
