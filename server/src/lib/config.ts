import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, "../../..");

const CODEX_REASONING_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
// The Claude CLI's --effort flag takes five values, without Codex's `ultra`; a separate enum stops an
// "ultra" pin passing boot validation only to fail every Claude spawn.
const CLAUDE_CLI_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const OPENAI_TEXT_PRIMARIES = ["codex", "http"] as const;

function readNonBlank(
  env: Readonly<Record<string, string | undefined>>,
  variable: string,
  fallback: string
): string {
  const value = env[variable] ?? fallback;
  if (value.trim().length === 0) {
    throw new Error(`${variable} must not be blank`);
  }
  return value;
}

function readEnum<const T extends readonly string[]>(
  env: Readonly<Record<string, string | undefined>>,
  variable: string,
  allowed: T,
  fallback: T[number]
): T[number] {
  const value = env[variable] ?? fallback;
  if (!allowed.includes(value as T[number])) {
    throw new Error(`${variable} must be one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}

// For settings with no default: unset is a valid state distinct from invalid, returned as `undefined`.
// CLAUDE_CLI_MODEL/CLAUDE_CLI_EFFORT use it, and an unset one adds no `--model`/`--effort` flag, so the
// spawn falls back to the CLI's own saved default.
function readOptionalNonBlank(
  env: Readonly<Record<string, string | undefined>>,
  variable: string
): string | undefined {
  const value = env[variable];
  if (value === undefined) return undefined;
  if (value.trim().length === 0) {
    throw new Error(`${variable} must not be blank`);
  }
  return value;
}

function readOptionalEnum<const T extends readonly string[]>(
  env: Readonly<Record<string, string | undefined>>,
  variable: string,
  allowed: T
): T[number] | undefined {
  const value = env[variable];
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T[number])) {
    throw new Error(`${variable} must be one of: ${allowed.join(", ")}`);
  }
  return value as T[number];
}

// Route budgets and other durations, in milliseconds. Unset or blank falls back; anything but a
// positive integer throws.
function readPositiveIntMs(
  env: Readonly<Record<string, string | undefined>>,
  variable: string,
  fallback: number
): number {
  const raw = env[variable];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${variable} must be a positive integer`);
  }
  return value;
}

function readInteger(
  env: Readonly<Record<string, string | undefined>>,
  variable: string,
  fallback: number
): number {
  const raw = env[variable];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${variable} must be an integer`);
  return value;
}

function readPositiveIntegerList(
  env: Readonly<Record<string, string | undefined>>,
  variable: string,
  fallback: readonly number[]
): readonly number[] {
  const raw = env[variable];
  if (raw === undefined || raw.trim().length === 0) return [...fallback];
  const values = raw.split(",").map((part) => Number(part.trim()));
  if (
    values.length === 0 ||
    values.some((value) => !Number.isInteger(value) || value <= 0 || value > 600_000)
  ) {
    throw new Error(`${variable} must be a comma-separated list of positive integers up to 600000`);
  }
  return values;
}

export interface ProviderAdmissionConfig {
  readonly initial: number;
  readonly floor: number;
  readonly ceiling: number;
  readonly scoringReserve: number;
  readonly cooldownsMs: readonly number[];
}

function readProviderAdmissionConfig(
  env: Readonly<Record<string, string | undefined>>,
  provider: "CLAUDE" | "CODEX"
): ProviderAdmissionConfig {
  const ceilingVariable = `${provider}_REASONING_CAPACITY_CEILING`;
  const ceiling = readInteger(env, ceilingVariable, 8);
  const emergency = ceiling === 1;
  const initial = readInteger(env, `${provider}_REASONING_CAPACITY_INITIAL`, emergency ? 1 : 4);
  const floor = readInteger(env, `${provider}_REASONING_CAPACITY_FLOOR`, emergency ? 1 : 2);
  const scoringReserve = readInteger(
    env,
    `${provider}_REASONING_SCORING_RESERVE`,
    emergency ? 0 : 1
  );
  const cooldownsMs = readPositiveIntegerList(
    env,
    `${provider}_REASONING_CIRCUIT_COOLDOWNS_MS`,
    [60_000, 120_000, 300_000, 600_000]
  );
  const valid = emergency
    ? scoringReserve === 0 && floor === 1 && initial === 1
    : 1 <= scoringReserve && scoringReserve < floor && floor <= initial &&
      initial <= ceiling && ceiling <= 8;
  if (!valid) {
    throw new Error(
      `${provider} reasoning admission config must satisfy ` +
      "1 <= reserve < floor <= initial <= ceiling <= 8, or ceiling=initial=floor=1 and reserve=0"
    );
  }
  return { initial, floor, ceiling, scoringReserve, cooldownsMs };
}

export function readAdmissionConfig(env: Readonly<Record<string, string | undefined>>) {
  return {
    claude: readProviderAdmissionConfig(env, "CLAUDE"),
    codex: readProviderAdmissionConfig(env, "CODEX"),
  };
}

// Retention for the model-call diagnostic tables (services/modelCallLog.ts), in days. 0 disables
// pruning; a negative, fractional or non-numeric value throws at boot rather than keeping or deleting
// the wrong amount of evidence.
export function readModelCallRetentionDays(
  env: Readonly<Record<string, string | undefined>>
): number {
  const raw = env.MODEL_CALL_RETENTION_DAYS;
  if (raw === undefined || raw.trim().length === 0) return 30;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("MODEL_CALL_RETENTION_DAYS must be a non-negative integer");
  }
  return value;
}

// How many audio clips this process synthesises at once: the one bound on text-to-speech in flight,
// shared by the Speaking and Listening renderers (services/ttsQueue.ts). The default of 1 renders clip
// by clip, in order; raise it for a bank re-render (sixteen Speaking Sets are 208 paid calls). It bounds
// concurrent paid calls, so a bad value costs money: a non-positive or fractional one is a boot failure
// rather than a clamp.
export function readTtsConcurrency(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.TTS_CONCURRENCY;
  if (raw === undefined || raw.trim().length === 0) return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("TTS_CONCURRENCY must be a positive integer");
  }
  return value;
}

export function readReasoningConfig(env: Readonly<Record<string, string | undefined>>) {
  return {
    codexBin: readNonBlank(env, "CODEX_BIN", "codex"),
    claudeBin: readNonBlank(env, "CLAUDE_BIN", "claude"),
    codexModel: readNonBlank(env, "CODEX_MODEL", "gpt-5.6-sol"),
    codexReasoningEffort: readEnum(
      env,
      "CODEX_REASONING_EFFORT",
      CODEX_REASONING_EFFORTS,
      "high"
    ),
    openaiTextPrimary: readEnum(
      env,
      "OPENAI_TEXT_PRIMARY",
      OPENAI_TEXT_PRIMARIES,
      "codex"
    ),
  };
}

// CLAUDE_CLI_MODEL/CLAUDE_CLI_EFFORT pin the spawn's --model/--effort. Not CLAUDE_MODEL/CLAUDE_EFFORT:
// Claude Code exports CLAUDE_EFFORT into every shell it launches, and `tsx --env-file` never overrides
// a variable the shell already set, so a bare name would let that ambient value silently outrank the
// operator's .env.
export function readClaudeCliConfig(env: Readonly<Record<string, string | undefined>>) {
  return {
    claudeCliModel: readOptionalNonBlank(env, "CLAUDE_CLI_MODEL"),
    claudeCliEffort: readOptionalEnum(env, "CLAUDE_CLI_EFFORT", CLAUDE_CLI_EFFORTS),
  };
}

// Post-admission route budgets (ADR 0007), per provider and per family. Claude's 750 s generation
// budget sits above its observed successful generate calls while giving up on a stalled one sooner, so
// Codex (which finishes the same call well inside its 900 s) gets to run. The retired shared
// GENERATION_ROUTE_TIMEOUT_MS is never read: applied to both providers it would re-couple their
// different defaults. Because a leftover value in someone's .env would otherwise change nothing
// silently, setting it logs a warning rather than failing boot.
function warnIfLegacyGenerationRouteTimeoutSet(
  env: Readonly<Record<string, string | undefined>>,
  effective: { claudeGenerationRouteTimeoutMs: number; codexGenerationRouteTimeoutMs: number }
): void {
  const raw = env.GENERATION_ROUTE_TIMEOUT_MS;
  if (raw === undefined || raw.trim().length === 0) return;
  console.warn(
    "[config] GENERATION_ROUTE_TIMEOUT_MS is retired and has no effect: each provider has its own " +
      "generation budget, CLAUDE_GENERATION_ROUTE_TIMEOUT_MS and CODEX_GENERATION_ROUTE_TIMEOUT_MS. " +
      "Effective values: " +
      `CLAUDE_GENERATION_ROUTE_TIMEOUT_MS=${effective.claudeGenerationRouteTimeoutMs}ms, ` +
      `CODEX_GENERATION_ROUTE_TIMEOUT_MS=${effective.codexGenerationRouteTimeoutMs}ms.`
  );
}

export function readRouteTimeoutConfig(env: Readonly<Record<string, string | undefined>>) {
  const claudeGenerationRouteTimeoutMs = readPositiveIntMs(
    env,
    "CLAUDE_GENERATION_ROUTE_TIMEOUT_MS",
    750_000
  );
  const codexGenerationRouteTimeoutMs = readPositiveIntMs(
    env,
    "CODEX_GENERATION_ROUTE_TIMEOUT_MS",
    900_000
  );
  warnIfLegacyGenerationRouteTimeoutSet(env, {
    claudeGenerationRouteTimeoutMs,
    codexGenerationRouteTimeoutMs,
  });
  return {
    claudeRouteTimeoutMs: readPositiveIntMs(env, "CLAUDE_ROUTE_TIMEOUT_MS", 750_000),
    codexRouteTimeoutMs: readPositiveIntMs(env, "CODEX_ROUTE_TIMEOUT_MS", 300_000),
    claudeGenerationRouteTimeoutMs,
    codexGenerationRouteTimeoutMs,
  };
}

export function readShutdownConfig(env: Readonly<Record<string, string | undefined>>) {
  return {
    shutdownDrainMs: readPositiveIntMs(env, "SHUTDOWN_DRAIN_MS", 30_000),
    shutdownRecorderFlushMs: readPositiveIntMs(env, "SHUTDOWN_RECORDER_FLUSH_MS", 5_000),
    shutdownProcessGraceMs: readPositiveIntMs(env, "SHUTDOWN_PROCESS_GRACE_MS", 2_000),
  };
}

export function readAttemptSupervisorConfig(env: Readonly<Record<string, string | undefined>>) {
  const attemptTerminationGraceMs = readPositiveIntMs(env, "REASONING_ATTEMPT_TERMINATION_GRACE_MS", 2_000);
  if (attemptTerminationGraceMs > 30_000) {
    throw new Error("REASONING_ATTEMPT_TERMINATION_GRACE_MS must be at most 30000");
  }
  return { attemptTerminationGraceMs };
}

// The one resolver for the data directory. It takes `env` so it can refuse to hand a test run the real
// question bank: the server suite's setup points TOEFL_DATA_DIR at a scratch copy, but a test file run
// from the repo root finds no vitest config, skips that setup, and would publish fixtures into live
// practice material. vitest sets VITEST (and NODE_ENV=test) in every worker whatever root it resolved,
// so this check fires at module evaluation, before any test body runs.
export function readDataDir(
  env: Readonly<Record<string, string | undefined>>,
  root: string = projectRoot
): string {
  const bank = path.join(root, "data");
  const dataDir = env.TOEFL_DATA_DIR ?? bank;
  const underTest = Boolean(env.VITEST) || env.NODE_ENV === "test";
  // Separator-aware containment, as in paths.ts: a bare startsWith would also catch a sibling such as
  // data-scratch/.
  const resolved = path.resolve(dataDir);
  const insideBank = resolved === bank || resolved.startsWith(bank + path.sep);
  if (underTest && insideBank) {
    throw new Error(
      `TOEFL_DATA_DIR resolves to the repo's real question bank (${resolved}) while running under ` +
        `vitest, which would publish generated test fixtures into live practice material. Run the ` +
        `server suite from the server workspace so server/vitest.config.ts applies: ` +
        `\`npm test -w server\`, or \`npm test\` at the repo root. To run one file, use ` +
        `\`npx vitest run test/<file>.test.ts\` from server/, or pass TOEFL_DATA_DIR explicitly.`
    );
  }
  return dataDir;
}

export const config = {
  port: Number(process.env.PORT ?? 8787),
  projectRoot,
  // TOEFL_DATA_DIR redirects every read and write of the question bank, stimulus audio, recorded
  // responses and db.sqlite; the test suite points it at a scratch copy (server/test/setup-env.ts).
  dataDir: readDataDir(process.env),
  openaiKey: process.env.OPENAI_API_KEY,
  geminiKey: process.env.GEMINI_API_KEY,
  geminiJudgeModel: process.env.GEMINI_JUDGE_MODEL ?? "",
  openaiJudgeModel: process.env.OPENAI_JUDGE_MODEL ?? "",
  // Audio input is only in the audio model family (docs/research/2026-07-28-audio-judge-apis.md). Unlike
  // the two text Judge models, this one has a working default.
  openaiAudioJudgeModel: process.env.OPENAI_AUDIO_JUDGE_MODEL ?? "gpt-audio-1.5",
  // Blank is a boot failure rather than an empty model id spliced into the request URL.
  geminiTtsModel: readNonBlank(process.env, "GEMINI_TTS_MODEL", "gemini-3.1-flash-tts-preview"),
  modelCallRetentionDays: readModelCallRetentionDays(process.env),
  ttsConcurrency: readTtsConcurrency(process.env),
  ...readReasoningConfig(process.env),
  ...readClaudeCliConfig(process.env),
  ...readRouteTimeoutConfig(process.env),
  admission: readAdmissionConfig(process.env),
  ...readShutdownConfig(process.env),
  ...readAttemptSupervisorConfig(process.env),
};
