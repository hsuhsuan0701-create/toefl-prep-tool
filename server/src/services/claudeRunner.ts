import fs from "node:fs";
import type { ReasoningFailureKind } from "@toefl-prep/shared";
import { config, projectRoot } from "../lib/config.js";
import { extractClaudeJson } from "../lib/jsonExtract.js";
import type { ProviderResult } from "./reasoning/contracts.js";
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
} from "./reasoning/cliProcess.js";
import {
  createProviderDeadline,
  isProviderDeadlineExceeded,
  remainingDeadlineMs,
  runBeforeDeadline,
  throwIfDeadlineExpired,
  type ProviderDeadline,
} from "./reasoning/deadline.js";

const DEFAULT_TIMEOUT_MS = 180_000;
const REPAIR_PREFIX =
  "Your previous output was invalid. Output ONLY JSON matching the schema.";

/**
 * Each `claude -p` spawn runs with cwd = projectRoot and is granted `--tools Read,Skill`. Read has
 * no path restriction of its own, so without these rules the model could read any project file:
 * `.env`'s API keys, the gate-only numeric tolerances in the generators and their shared remediation
 * module (EXPLANATION_HARD_LIMIT_CODE_POINTS in generationVerifyRemediation.ts, for one), and the docs
 * that restate those tolerances.
 *
 * `--settings` applies these permissions to that one process. Deny rules win over allow rules, and
 * `--permission-mode dontAsk` never overrides a deny. A path matching neither list is still
 * readable, though, so this is a deny list with a residual default-allow: it must name every
 * top-level entry under the project root except `.claude` (whose `skills/**` is allowed), and every
 * entry under `.claude/` except `skills`. `CLAUDE.md` is denied like the rest: the spawn does not
 * load it (CLAUDE_SPAWN_ISOLATION_ENV), and a worker has no use for the repository's own
 * instructions. The `.claude/` entries are named one by one because a `.claude/*`
 * wildcard would deny `skills/**` too. server/test/claudeRunner.test.ts reads the real project
 * root and `.claude/` and fails when an entry is not covered, so a new file cannot silently reopen
 * the channel. Glob is not granted: no skill needs it, and it would make filenames enumerable.
 *
 * Exported so the argv test can compare against the exact JSON instead of a hand-copied duplicate.
 */
export const CLI_PERMISSIONS_SETTINGS = JSON.stringify({
  permissions: {
    deny: [
      "Read(server/**)",
      "Read(shared/**)",
      "Read(client/**)",
      "Read(scripts/**)",
      "Read(data/**)",
      "Read(docs/**)",
      "Read(.superpowers/**)",
      "Read(.worktrees/**)",
      "Read(.probe/**)",
      "Read(.env*)",
      // A primary checkout exposes .git as a directory; a linked worktree exposes it as a file.
      "Read(.git)",
      "Read(.git/**)",
      "Read(.github/**)",
      "Read(.gitignore)",
      "Read(.nvmrc)",
      "Read(node_modules/**)",
      "Read(package.json)",
      "Read(package-lock.json)",
      "Read(README.md)",
      "Read(AGENTS.md)",
      "Read(LICENSE)",
      "Read(CLAUDE.md)",
      "Read(CONTEXT.md)",
      "Read(tsconfig.base.json)",
      "Read(vitest.config.ts)",
      "Read(tmp/**)",
      // Every entry under .claude/ except skills/**.
      "Read(.claude/settings.local.json)",
      // Worktrees a Claude Code session creates here are full checkouts, possibly with a .env.
      "Read(.claude/worktrees/**)",
    ],
    allow: ["Read(.claude/skills/**)"],
  },
});

/**
 * What a spawn must not bring with it from the machine it runs on. A `claude -p` loads, as an
 * interactive session would, the person's own `~/.claude/CLAUDE.md`, the project's `CLAUDE.md` and
 * the project's auto memory (`MEMORY.md`), and a Judge-reconciling Arbiter or a generator must see
 * none of them: personal instructions and notes about the person's real exam results would reach
 * the model that scores them.
 *
 * - CLAUDE_CODE_DISABLE_CLAUDE_MDS keeps every CLAUDE.md and the auto memory out of context.
 * - CLAUDE_CODE_DISABLE_AUTO_MEMORY states the auto-memory half on its own, so it holds even if
 *   the first is ever narrowed.
 * - CLAUDE_CODE_DISABLE_BUNDLED_SKILLS removes the skills that ship with the CLI and leaves the
 *   project's `.claude/skills/` alone.
 *
 * These are environment switches rather than keys in CLI_PERMISSIONS_SETTINGS so that none of them
 * can invalidate the settings object that carries the Read deny list. Skills synced from a
 * claude.ai account do not reach the spawn either: `--setting-sources project` leaves the user
 * source out, and the CLI syncs none without it.
 *
 * Exported so the test can pin the exact variables.
 */
export const CLAUDE_SPAWN_ISOLATION_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
};

/** The spawn's environment: the shared allow-list plus the isolation switches. */
function claudeSpawnEnv(): NodeJS.ProcessEnv {
  return { ...sanitizedCliEnv(), ...CLAUDE_SPAWN_ISOLATION_ENV };
}

/**
 * One CLI attempt's raw traffic. `prompt` is what was actually sent on THIS attempt — the repair
 * retry sends a different prompt than the caller supplied — and `response` is the unparsed stdout,
 * absent when the process produced none at all. The two stamps are epoch milliseconds: they are
 * stored as the attempt's `started_at_ms` and `finished_at_ms`.
 */
export interface CliTranscript {
  readonly prompt: string;
  readonly response?: string;
  readonly startedAtMs?: number;
  readonly finishedAtMs?: number;
}

export interface RunClaudeOptions<T = unknown> {
  readonly prompt: string;
  readonly jsonSchema: object;
  readonly parse?: (value: unknown) => T;
  readonly timeoutMs?: number;
  readonly bin?: string;
  readonly deadline?: ProviderDeadline;
  readonly signal?: AbortSignal;
  /**
   * Observability channel for the transcript log (services/modelCallLog.ts). It exists as a
   * callback rather than a field on the result because neither half of the result can carry it:
   * the provider executor rebuilds every result from its value or its failure kind alone, so an
   * extra field would be silently dropped, and on `invalid-output` the raw text is precisely what
   * never becomes a value. Fired once per attempt, before the attempt's outcome is known.
   * A throwing observer is swallowed — this must never affect the call.
   */
  readonly onTranscript?: (transcript: CliTranscript) => void;
  readonly onPressure?: (event: ClaudePressureEvent) => void;
}

/**
 * What one stream says about subscription limits. `window` names the rate-limit window an
 * observation is about (`<rateLimitType>@<resetsAt>`, or `api_retry@<session>` for a retried call),
 * so provider state can strike once per window however many calls report it. Utilization is a
 * percent. `quota` means the server is refusing requests until `resetAtMs`.
 */
export type ClaudePressureEvent =
  | { readonly kind: "telemetry"; readonly window: string; readonly utilization: number }
  | { readonly kind: "pressure"; readonly window: string; readonly utilization?: number }
  | { readonly kind: "quota"; readonly window: string; readonly resetAtMs?: number };

const PRESSURE_UTILIZATION_PERCENT = 90;
const RATE_LIMIT_STATUSES = new Set(["allowed", "allowed_warning", "rejected"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * `{"type":"rate_limit_event","rate_limit_info":{status, resetsAt, rateLimitType, utilization?,
 * unifiedWindows?, overageStatus?, isUsingOverage?}}`. The top-level `status` says whether requests
 * are refused; `overageStatus` is about paid extra usage and says nothing about this call, so it is
 * never read as a refusal. `utilization` is a fraction of the window (it can exceed 1) and
 * `resetsAt` is epoch seconds. A refusal that paid overage is covering is still being served, so it
 * is pressure rather than quota.
 */
function rateLimitObservations(info: Record<string, unknown>): ClaudePressureEvent[] {
  const status = info.status;
  if (typeof status !== "string" || !RATE_LIMIT_STATUSES.has(status)) return [];
  const resetsAt = finite(info.resetsAt);
  const limiting = `${typeof info.rateLimitType === "string" ? info.rateLimitType : "unknown"}@${resetsAt ?? "unknown"}`;
  if (status === "rejected") {
    return info.isUsingOverage === true
      ? [{ kind: "pressure", window: limiting }]
      : [{ kind: "quota", window: limiting, ...(resetsAt === undefined ? {} : { resetAtMs: resetsAt * 1_000 }) }];
  }
  const windows: Array<{ window: string; utilization: number }> = [];
  const topUtilization = finite(info.utilization);
  if (topUtilization !== undefined) windows.push({ window: limiting, utilization: topUtilization });
  for (const [name, raw] of Object.entries(record(info.unifiedWindows) ?? {})) {
    const entry = record(raw);
    const utilization = finite(entry?.utilization);
    if (utilization !== undefined) {
      windows.push({ window: `${name}@${finite(entry?.resetsAt) ?? "unknown"}`, utilization });
    }
  }
  return windows.map(({ window, utilization }) => {
    const percent = Math.round(utilization * 10_000) / 100;
    return percent >= PRESSURE_UTILIZATION_PERCENT
      ? { kind: "pressure", window, utilization: percent }
      : { kind: "telemetry", window, utilization: percent };
  });
}

/** A retried API call that the server rate-limited or reported overloaded is pressure on this call. */
function retryObservation(event: Record<string, unknown>): ClaudePressureEvent | undefined {
  const status = finite(event.error_status);
  const error = event.error;
  const pressured = status === 429 || status === 529 || error === "rate_limit" || error === "overloaded";
  if (!pressured) return undefined;
  return { kind: "pressure", window: `api_retry@${typeof event.session_id === "string" ? event.session_id : "unknown"}` };
}

export interface ParsedClaudeStream {
  /** The raw line of the last `result` event, when the stream has one. */
  readonly resultEnvelope?: string;
  /** That same event, parsed. */
  readonly result?: Readonly<Record<string, unknown>>;
  /** Limit observations, at most one per kind and window. */
  readonly pressure: readonly ClaudePressureEvent[];
}

export function parseClaudeStream(input: string): ParsedClaudeStream {
  let resultEnvelope: string | undefined;
  let result: Record<string, unknown> | undefined;
  const pressure: ClaudePressureEvent[] = [];
  const seen = new Set<string>();
  const observe = (observation: ClaudePressureEvent | undefined) => {
    if (!observation) return;
    const key = `${observation.kind}|${observation.window}`;
    if (seen.has(key)) return;
    seen.add(key);
    pressure.push(Object.freeze(observation));
  };
  for (const line of input.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    const event = record(value);
    if (!event) continue;
    if (event.type === "result") {
      resultEnvelope = line;
      result = event;
    } else if (event.type === "rate_limit_event") {
      const info = record(event.rate_limit_info);
      if (info) rateLimitObservations(info).forEach(observe);
    } else if (event.type === "system" && event.subtype === "api_retry") {
      observe(retryObservation(event));
    }
  }
  return Object.freeze({
    ...(resultEnvelope === undefined ? {} : { resultEnvelope }),
    ...(result === undefined ? {} : { result: Object.freeze(result) }),
    pressure: Object.freeze(pressure),
  });
}

/**
 * Why a failed `claude -p` stopped. The stream's last `result` event says it best: `api_error_status`
 * is the HTTP status of the API error that ended the turn, and `result`/`errors` carry its text. A
 * refused rate-limit window anywhere in the stream makes it a quota failure whatever the final
 * status was. Without a result event the CLI died before streaming one, so the reason is in stderr
 * or in a plain-text stdout line — never in the JSON events, whose tool and skill lists can contain
 * any word.
 */
export function classifyClaudeFailure(
  process: Pick<SpawnBoundedResult, "timedOut" | "spawnErrorCode" | "spawnErrorMessage" | "stderr" | "stderrTail">,
  stream: ParsedClaudeStream | undefined,
  stdout: string | undefined,
): ReasoningFailureKind {
  const processKind = classifyProcessFailure(process);
  if (processKind) return processKind;
  if (stream?.pressure.some((event) => event.kind === "quota")) return "quota";
  const result = stream?.result;
  if (result) {
    if (result.subtype === "error_max_structured_output_retries") return "invalid-output";
    // A result that is not an error carries the model's own answer, which can mention anything.
    const isError = result.is_error === true ||
      (typeof result.subtype === "string" && result.subtype.startsWith("error_"));
    if (!isError) return "provider";
    const text = [result.result, ...(Array.isArray(result.errors) ? result.errors : [])]
      .filter((part): part is string => typeof part === "string")
      .join("\n");
    const textKind = classifyFailureText(text);
    const status = finite(result.api_error_status);
    if (status === 401 || status === 403) return "authentication";
    if (status === 402) return "quota";
    if (status === 429) return textKind === "quota" ? "quota" : "rate-limit";
    if (status !== undefined && status >= 500) return "provider";
    return textKind ?? "provider";
  }
  const plainStdout = (stdout ?? "")
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("{"))
    .join("\n");
  return classifyFailureText(`${process.stderrTail ?? process.stderr}\n${plainStdout}`) ?? "provider";
}

/**
 * Whether a stream whose output did not parse says the turn failed rather than answered badly: a
 * refused rate-limit window, or a `result` marked as an error. The CLI's own structured-output
 * give-up (`error_max_structured_output_retries`) is the one error a repair attempt is for, so it is
 * not counted here.
 */
function streamReportsFailure(stream: ParsedClaudeStream): boolean {
  if (stream.pressure.some((event) => event.kind === "quota")) return true;
  const result = stream.result;
  if (!result || result.subtype === "error_max_structured_output_retries") return false;
  return result.is_error === true ||
    (typeof result.subtype === "string" && result.subtype.startsWith("error_"));
}

type ClaudeSuccess<T> = Extract<
  ProviderResult<T, "claude">,
  { ok: true }
>;
type ClaudeFailure = Extract<
  ProviderResult<never, "claude">,
  { ok: false }
>;
export type ClaudeResult<T> = ClaudeSuccess<T> | ClaudeFailure;

function failure(kind: ReasoningFailureKind): ClaudeFailure {
  return {
    ok: false,
    failure: {
      provider: "claude",
      kind,
      source: "call",
    },
  };
}

function reportPressure(
  observer: ((event: ClaudePressureEvent) => void) | undefined,
  stream: ParsedClaudeStream,
): void {
  for (const event of stream.pressure) {
    try { observer?.(event); } catch { /* observers never affect the call */ }
  }
}

export function reportTranscript(
  observer: ((transcript: CliTranscript) => void) | undefined,
  transcript: CliTranscript,
): void {
  try {
    observer?.(transcript);
  } catch {
    // Observers are informational and must never affect execution — the same rule the reasoning
    // router applies to its own route observers.
  }
}

function parseValue<T>(
  stdout: string,
  parse: ((value: unknown) => T) | undefined
): { ok: true; value: T } | { ok: false } {
  const extracted = extractClaudeJson(stdout);
  if (!extracted.ok) return { ok: false };
  if (!parse) return { ok: true, value: extracted.value as T };
  try {
    return { ok: true, value: parse(extracted.value) };
  } catch {
    return { ok: false };
  }
}

/**
 * `z.toJSONSchema()` (zod v4) stamps `$schema: "https://json-schema.org/draft/2020-12/schema"`
 * on its output, but the Claude CLI's `--json-schema` validator cannot resolve that ref and
 * rejects the whole schema. Callers are expected to hand us zod output directly, so drop the
 * dialect marker here rather than making every caller remember to.
 */
export function stripSchemaDialect(schema: object): object {
  if (!("$schema" in schema)) return schema;
  const { $schema: _dialect, ...rest } = schema as Record<string, unknown>;
  return rest;
}

/**
 * Runs one `claude -p` call: an initial attempt and at most one structured-output repair, inside the
 * deadline. The option type accepts extra properties, but this adapter never reads or invokes queue
 * callbacks: queueing and progress events belong to providerState.
 */
export async function runClaude<
  T = unknown,
  O extends RunClaudeOptions<T> = RunClaudeOptions<T>,
>(options: O): Promise<ClaudeResult<T>> {
  const deadline =
    options.deadline ??
    createProviderDeadline(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
  try {
    return await withPrivateTempDir("toefl-claude-", async (tempDir) => {
      const stdoutPath = privateTempFile(tempDir, "stdout.json");
      await runBeforeDeadline(deadline, () =>
        writePrivateFile(stdoutPath, ""),
      );

      const serializedSchema = await runBeforeDeadline(
        deadline,
        () =>
          JSON.stringify(
            stripSchemaDialect(options.jsonSchema),
          ),
      );

      const args = [
        "-p",
        // An unpinned `-p` inherits the interactive CLI's saved model and effort, which can be far
        // slower than any route budget. Each is passed when configured and adds no args when unset.
        ...(config.claudeCliModel ? ["--model", config.claudeCliModel] : []),
        ...(config.claudeCliEffort ? ["--effort", config.claudeCliEffort] : []),
        "--output-format",
        "stream-json",
        "--verbose",
        "--json-schema",
        serializedSchema,
        "--setting-sources",
        "project",
        "--tools",
        "Read,Skill",
        // `--tools` limits only the built-in tools; MCP servers, claude.ai connectors included,
        // bring their own. With no `--mcp-config`, this loads none of them.
        "--strict-mcp-config",
        "--settings",
        CLI_PERMISSIONS_SETTINGS,
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
      ];
      let prompt = options.prompt;

      for (let attemptNumber = 0; attemptNumber < 2; attemptNumber += 1) {
        await runBeforeDeadline(deadline, () =>
          writePrivateFile(stdoutPath, ""),
        );
        const remainingMs = remainingDeadlineMs(deadline);
        if (remainingMs <= 0) return failure("timeout");
        const attemptPrompt = prompt;
        const attemptStartedAtMs = Date.now();
        const processResult = await spawnBounded({
          bin: options.bin ?? config.claudeBin,
          args,
          prompt,
          cwd: projectRoot,
          env: claudeSpawnEnv(),
          timeoutMs: remainingMs,
          stdoutFilePath: stdoutPath,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        if (processResult.structuredOutputOverflow) {
          // No transcript: an overflow means the output was too large to retain, so there is no
          // response text to report and reporting the prompt alone would imply the model answered.
          prompt = `${REPAIR_PREFIX}\n\nOriginal request:\n${options.prompt}`;
          continue;
        }
        if (!processResult.ok) {
          // Read without the deadline: on a timeout it has already expired, and this is a local,
          // size-capped file that holds the only record of what the CLI said before it stopped.
          const output = await readBoundedOutput(stdoutPath);
          const stdout = output.ok ? output.text : undefined;
          const stream = stdout === undefined ? undefined : parseClaudeStream(stdout);
          const response = failureTranscriptResponse({ stdout, stderr: processResult.stderrTail });
          reportTranscript(options.onTranscript, {
            prompt: attemptPrompt,
            ...(response === undefined ? {} : { response }),
            startedAtMs: attemptStartedAtMs,
            finishedAtMs: Date.now(),
          });
          if (stream) reportPressure(options.onPressure, stream);
          return failure(classifyClaudeFailure(processResult, stream, stdout));
        }

        const stdout = await runBeforeDeadline(
          deadline,
          () => fs.promises.readFile(stdoutPath, "utf8"),
        ).catch((error) => {
          if (isProviderDeadlineExceeded(error)) throw error;
          return undefined;
        });
        reportTranscript(options.onTranscript, {
          prompt: attemptPrompt,
          ...(stdout === undefined ? {} : { response: stdout }),
          startedAtMs: attemptStartedAtMs,
          finishedAtMs: Date.now(),
        });
        if (stdout === undefined) return failure("provider");
        const stream = parseClaudeStream(stdout);
        reportPressure(options.onPressure, stream);
        const parsed = await runBeforeDeadline(
          deadline,
          () => parseValue(stream.resultEnvelope ?? stdout, options.parse),
        );
        if (parsed.ok) {
          throwIfDeadlineExpired(deadline);
          return {
            ok: true,
            value: parsed.value,
            provider: "claude",
          };
        }
        // A CLI that exits 0 can still have ended the turn in an error (a usage limit, an API
        // error) or been refused a rate-limit window. Its output is then not malformed but absent,
        // and a repair attempt would be a second call refused the same way.
        if (streamReportsFailure(stream)) {
          return failure(classifyClaudeFailure(processResult, stream, stdout));
        }

        prompt = `${REPAIR_PREFIX}\n\nOriginal request:\n${options.prompt}`;
      }

      return failure("invalid-output");
    }, deadline);
  } catch (error) {
    if (isProviderDeadlineExceeded(error)) {
      return failure("timeout");
    }
    return failure("application");
  }
}
