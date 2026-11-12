import type {
  ReasoningFailureKind,
  ReasoningStatusVM,
} from "@toefl-prep/shared";
import { attemptSupervisorMetrics } from "./attemptSupervisor.js";
import { reasoningRouteMetrics } from "./router.js";
import { getModelCallRecorderLossSnapshot } from "../modelCallLog.js";
import { config } from "../../lib/config.js";
import {
  classifyCliFailure,
  sanitizedCliEnv,
  spawnBounded,
  type SpawnBoundedOptions,
  type SpawnBoundedResult,
} from "./cliProcess.js";
import {
  providerState,
  type PreflightOutcome,
  type ProviderState,
} from "./providerState.js";

const PROBE_TIMEOUT_MS = 5_000;
const NORMALIZED_PREFLIGHT_WARNING =
  "[reasoning] provider preflight failed with a normalized internal error";

type ProbeSpawn = (
  options: SpawnBoundedOptions,
) => Promise<SpawnBoundedResult>;

type ProbeOptions = {
  spawn?: ProbeSpawn;
  bin?: string;
  cwd?: string;
  env?: Readonly<Record<string, string | undefined>>;
};

function thrownFailureKind(error: unknown): ReasoningFailureKind {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  ) {
    return "missing-cli";
  }
  return "provider";
}

async function runProbe(
  options: ProbeOptions,
  defaults: { bin: string; args: readonly string[] },
): Promise<SpawnBoundedResult | PreflightOutcome> {
  const spawn = options.spawn ?? spawnBounded;
  try {
    return await spawn({
      bin: options.bin ?? defaults.bin,
      args: defaults.args,
      prompt: "",
      cwd: options.cwd ?? config.projectRoot,
      env: sanitizedCliEnv(options.env ?? process.env),
      timeoutMs: PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    return { ok: false, kind: thrownFailureKind(error) };
  }
}

function isOutcome(
  result: SpawnBoundedResult | PreflightOutcome,
): result is PreflightOutcome {
  return "kind" in result;
}

export async function probeClaude(
  options: ProbeOptions = {},
): Promise<PreflightOutcome> {
  const result = await runProbe(options, {
    bin: config.claudeBin,
    args: ["auth", "status"],
  });
  if (isOutcome(result)) return result;
  if (!result.ok) {
    return { ok: false, kind: classifyCliFailure(result) };
  }

  let body: unknown;
  try {
    body = JSON.parse(result.stdout);
  } catch {
    return { ok: false, kind: "provider" };
  }
  if (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.hasOwn(body, "loggedIn")
  ) {
    return (body as { loggedIn?: unknown }).loggedIn === true
      ? { ok: true }
      : { ok: false, kind: "authentication" };
  }
  return { ok: false, kind: "provider" };
}

function hasCodexLoggedInMarker(output: string): boolean {
  return output
    .split(/\r?\n/)
    .some((line) => {
      const normalized = line.trimEnd();
      return (
        normalized === "Logged in" ||
        normalized.startsWith("Logged in ")
      );
    });
}

export async function probeCodex(
  options: ProbeOptions = {},
): Promise<PreflightOutcome> {
  const result = await runProbe(options, {
    bin: config.codexBin,
    args: ["login", "status"],
  });
  if (isOutcome(result)) return result;
  if (!result.ok) {
    return { ok: false, kind: classifyCliFailure(result) };
  }
  return (
    hasCodexLoggedInMarker(result.stdout) ||
    hasCodexLoggedInMarker(result.stderr)
  )
    ? { ok: true }
    : { ok: false, kind: "authentication" };
}

type PreflightDeps = {
  state?: ProviderState;
  probeClaude?: () => Promise<PreflightOutcome>;
  probeCodex?: () => Promise<PreflightOutcome>;
  /**
   * Told each provider's outcome in the same synchronous step that applies it to `state`, so a
   * reader that notes the provider's activity version here can later tell whether any live call
   * outcome has arrived since (GET /api/setup-status does).
   */
  onChecked?: (provider: "claude" | "codex", outcome: PreflightOutcome) => void;
};

async function safelyProbe(
  probe: () => Promise<PreflightOutcome>,
): Promise<PreflightOutcome> {
  try {
    return await probe();
  } catch (error) {
    return { ok: false, kind: thrownFailureKind(error) };
  }
}

async function preflightProvider(
  state: ProviderState,
  provider: "claude" | "codex",
  probe: () => Promise<PreflightOutcome>,
  onChecked: PreflightDeps["onChecked"],
): Promise<void> {
  const token = state.captureActivityToken(provider);
  const outcome = await safelyProbe(probe);
  state.recordPreflight(provider, outcome, token);
  onChecked?.(provider, outcome);
}

export async function preflightProviders(
  deps: PreflightDeps = {},
): Promise<void> {
  const state = deps.state ?? providerState;
  await Promise.all([
    preflightProvider(
      state,
      "claude",
      deps.probeClaude ?? probeClaude,
      deps.onChecked,
    ),
    preflightProvider(
      state,
      "codex",
      deps.probeCodex ?? probeCodex,
      deps.onChecked,
    ),
  ]);
}

export function buildReasoningStatus(
  state: ProviderState = providerState,
): ReasoningStatusVM {
  return {
    providers: state.snapshot().map((entry) => ({
      provider: entry.provider,
      availability: entry.availability,
      ...(entry.failureKind
        ? { failureKind: entry.failureKind }
        : {}),
      ...(entry.retryAtMs !== undefined
        ? { retryAt: new Date(entry.retryAtMs).toISOString() }
        : {}),
    })),
    operationalProviders: state.operationalSnapshot().map((entry) => ({
      provider: entry.provider,
      active: { ...entry.active },
      queued: { ...entry.queued },
      effectiveCapacity: entry.effectiveCapacity,
      reservedScoring: entry.reservedScoring,
      pressureStrikes: entry.pressureStrikes,
      queueLatencyMs: entry.queueLatencyMs,
      circuitState: entry.circuitState,
      ...(entry.probeOwner === undefined ? {} : { probeOwner: entry.probeOwner }),
      ...(entry.oldestHeldAgeMs === undefined ? {} : { oldestHeldAgeMs: entry.oldestHeldAgeMs }),
    })),
    processMetrics: {
      ...attemptSupervisorMetrics(),
      ...reasoningRouteMetrics(),
      recorderLoss: getModelCallRecorderLossSnapshot(),
    },
    openaiTextPrimary: config.openaiTextPrimary,
    codexModel: config.codexModel,
    codexReasoningEffort: config.codexReasoningEffort,
  };
}

export function startProviderPreflight(
  run: () => Promise<void> = preflightProviders,
  warn: (message: string) => void = console.warn,
): void {
  const reportFailure = () => {
    try {
      warn(NORMALIZED_PREFLIGHT_WARNING);
    } catch {
      // Observability must never turn an optional capability check into a startup gate.
    }
  };
  try {
    void run().catch(reportFailure);
  } catch {
    reportFailure();
  }
}
