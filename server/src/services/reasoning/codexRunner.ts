import fs from "node:fs";
import type { ReasoningFailureKind } from "@toefl-prep/shared";
import { config } from "../../lib/config.js";
import { extractJsonObject } from "../../lib/jsonExtract.js";
import type { ProviderResult } from "./contracts.js";
import {
  reportTranscript,
  type CliTranscript,
} from "../claudeRunner.js";
import {
  classifyFailureText,
  classifyProcessFailure,
  failureTranscriptResponse,
  privateTempFile,
  readBoundedOutput,
  sanitizedCliEnv,
  spawnBounded,
  withPrivateTempDir,
  writePrivateFile,
  type SpawnBoundedResult,
} from "./cliProcess.js";
import {
  createProviderDeadline,
  isProviderDeadlineExceeded,
  remainingDeadlineMs,
  runBeforeDeadline,
  throwIfDeadlineExpired,
  type ProviderDeadline,
} from "./deadline.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const REPAIR_PREFIX =
  "Your previous output was invalid. Output ONLY JSON matching the schema.";

export interface RunCodexOptions<T> {
  readonly prompt: string;
  readonly jsonSchema: object;
  readonly parse: (value: unknown) => T;
  readonly timeoutMs?: number;
  readonly bin?: string;
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly deadline?: ProviderDeadline;
  readonly signal?: AbortSignal;
  /** See RunClaudeOptions.onTranscript — same channel, same contract, same reasons. */
  readonly onTranscript?: (transcript: CliTranscript) => void;
}

function failure<T>(
  kind: ReasoningFailureKind
): ProviderResult<T, "codex"> {
  return {
    ok: false,
    failure: {
      provider: "codex",
      kind,
      source: "call",
    },
  };
}

function parseValue<T>(
  text: string,
  parse: (value: unknown) => T
): { ok: true; value: T } | { ok: false } {
  const extracted = extractJsonObject(text);
  if (!extracted.ok) return { ok: false };
  try {
    return { ok: true, value: parse(extracted.value) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SCHEMA_MAP_KEYWORDS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependencies",
] as const;
const SCHEMA_VALUE_KEYWORDS = [
  "items",
  "additionalItems",
  "contains",
  "unevaluatedItems",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contentSchema",
] as const;
const SCHEMA_ARRAY_KEYWORDS = [
  "anyOf",
  "prefixItems",
] as const;
const UNSUPPORTED_COMPOSITION_KEYWORDS = [
  "oneOf",
  "allOf",
  "not",
  "dependentRequired",
  "dependentSchemas",
  "if",
  "then",
  "else",
] as const;

export function isCodexStrictOutputSchema(schema: object): boolean {
  const pending: unknown[] = [schema];
  const visited = new Set<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null) continue;
    if (visited.has(current)) continue;
    visited.add(current);

    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }

    const record = current as Record<string, unknown>;
    if (
      UNSUPPORTED_COMPOSITION_KEYWORDS.some((keyword) => keyword in record)
    ) {
      return false;
    }
    const properties = record.properties;
    if (isRecord(properties)) {
      const propertyNames = Object.keys(properties);
      const required = record.required;
      if (
        !Array.isArray(required) ||
        !propertyNames.every((name) => required.includes(name))
      ) {
        return false;
      }
    }

    for (const keyword of SCHEMA_MAP_KEYWORDS) {
      const schemaMap = record[keyword];
      if (isRecord(schemaMap)) {
        pending.push(...Object.values(schemaMap));
      }
    }
    for (const keyword of SCHEMA_VALUE_KEYWORDS) {
      pending.push(record[keyword]);
    }
    for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
      const schemas = record[keyword];
      if (Array.isArray(schemas)) {
        pending.push(schemas);
      }
    }
  }

  return true;
}

/** A line the CLI wrote to report the error that ended the run, possibly after a timestamp. */
const ERROR_LINE = /^\W*(?:\[[^\]]*\]\s*)?(?:error|fatal)\b/i;

/**
 * Why a failed `codex exec` stopped. Its stderr is a human-readable session log that echoes the
 * whole prompt and the model's own messages before the error that ended the run, so only that
 * final error line is read (or, failing one, the very last line): a prompt or a draft that mentions
 * a login or a quota must not decide the failure kind.
 */
export function classifyCodexFailure(
  process: Pick<SpawnBoundedResult, "timedOut" | "spawnErrorCode" | "spawnErrorMessage" | "stderr" | "stderrTail">,
): ReasoningFailureKind {
  const processKind = classifyProcessFailure(process);
  if (processKind) return processKind;
  const lines = (process.stderrTail ?? process.stderr)
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const finalError = lines.filter((line) => ERROR_LINE.test(line)).at(-1) ?? lines.at(-1) ?? "";
  return classifyFailureText(finalError) ?? "provider";
}

export async function runCodex<T>(
  options: RunCodexOptions<T>
): Promise<ProviderResult<T, "codex">> {
  const deadline =
    options.deadline ??
    createProviderDeadline(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  try {
    if (!isCodexStrictOutputSchema(options.jsonSchema)) {
      return failure<T>("configuration");
    }

    return await withPrivateTempDir("toefl-codex-", async (tempDir) => {
      const schemaPath = privateTempFile(tempDir, "schema.json");
      const outputPath = privateTempFile(tempDir, "last-message.json");
      const serializedSchema = await runBeforeDeadline(
        deadline,
        () => JSON.stringify(options.jsonSchema),
      );
      await runBeforeDeadline(deadline, () =>
        writePrivateFile(schemaPath, serializedSchema),
      );
      await runBeforeDeadline(deadline, () =>
        writePrivateFile(outputPath, ""),
      );

      const bin = options.bin ?? config.codexBin;
      const model = options.model ?? config.codexModel;
      const reasoningEffort =
        options.reasoningEffort ?? config.codexReasoningEffort;
      const args = [
        "exec",
        "--model",
        model,
        "-c",
        `model_reasoning_effort="${reasoningEffort}"`,
        "--strict-config",
        // Blocks writes and network, not reads: the model's shell can still read any file this
        // process's user can. `codex exec` has no narrower read scope (ADR 0003).
        "--sandbox",
        "read-only",
        "--ephemeral",
        "--ignore-user-config",
        "--skip-git-repo-check",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        outputPath,
        "--color",
        "never",
        "--cd",
        tempDir,
        "-",
      ];

      let prompt = options.prompt;

      for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
        await runBeforeDeadline(deadline, () =>
          writePrivateFile(outputPath, ""),
        );
        const remainingMs = remainingDeadlineMs(deadline);
        if (remainingMs <= 0) return failure<T>("timeout");
        const attemptPrompt = prompt;
        const attemptStartedAtMs = Date.now();
        const processResult = await spawnBounded({
          bin,
          args,
          prompt,
          cwd: tempDir,
          env: sanitizedCliEnv(),
          timeoutMs: remainingMs,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (!processResult.ok) {
          // Read without the deadline: on a timeout it has already expired, and the last message
          // file is local and size-capped.
          const lastMessage = await readBoundedOutput(outputPath);
          const stdout = [lastMessage.ok ? lastMessage.text : "", processResult.stdoutTail ?? ""]
            .filter((part) => part.trim().length > 0)
            .join("\n");
          const response = failureTranscriptResponse({ stdout, stderr: processResult.stderrTail });
          reportTranscript(options.onTranscript, {
            prompt: attemptPrompt,
            ...(response === undefined ? {} : { response }),
            startedAtMs: attemptStartedAtMs,
            finishedAtMs: Date.now(),
          });
          return failure<T>(classifyCodexFailure(processResult));
        }

        const output = await runBeforeDeadline(
          deadline,
          () => readBoundedOutput(outputPath),
        );
        if (!output.ok && output.kind === "read-error") {
          reportTranscript(options.onTranscript, { prompt: attemptPrompt, startedAtMs: attemptStartedAtMs, finishedAtMs: Date.now() });
          return failure<T>("provider");
        }
        if (!output.ok) {
          // Oversize: there is no response text to report — see the matching branch in
          // claudeRunner for why the prompt alone would be a misleading row.
          prompt = `${REPAIR_PREFIX}\n\nOriginal request:\n${options.prompt}`;
          continue;
        }
        reportTranscript(options.onTranscript, {
          prompt: attemptPrompt,
          response: output.text,
          startedAtMs: attemptStartedAtMs,
          finishedAtMs: Date.now(),
        });
        const parsed = await runBeforeDeadline(
          deadline,
          () => parseValue(output.text, options.parse),
        );
        if (parsed.ok) {
          throwIfDeadlineExpired(deadline);
          return {
            ok: true,
            value: parsed.value,
            provider: "codex",
          };
        }

        prompt = `${REPAIR_PREFIX}\n\nOriginal request:\n${options.prompt}`;
      }

      return failure<T>("invalid-output");
    }, deadline);
  } catch (error) {
    if (isProviderDeadlineExceeded(error)) {
      return failure<T>("timeout");
    }
    return failure<T>("application");
  }
}
