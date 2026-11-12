import { performance } from "node:perf_hooks";
import { config } from "../../lib/config.js";
import type {
  ReasoningFailureKind,
  ReasoningProvider,
} from "@toefl-prep/shared";
import {
  runClaude as productionRunClaude,
  type CliTranscript,
  type RunClaudeOptions,
} from "../claudeRunner.js";
import {
  currentModelCallCorrelation,
  recordModelCall,
  recordProviderExecutionLifecycle,
  withModelCallRoute,
} from "../modelCallLog.js";
import {
  runCodex as productionRunCodex,
  type RunCodexOptions,
} from "./codexRunner.js";
import {
  ReasoningRouteError,
  fallbackEligible,
  inferCancellationReason,
  type CancellationReason,
  type ProviderResult,
  type ReasoningAttempt,
  type ReasoningEvent,
  type ReasoningFailure,
  type RouteResult,
} from "./contracts.js";
import {
  providerState as productionProviderState,
  type ProviderState,
} from "./providerState.js";
import {
  createProviderExecutor,
  providerResultFromExecution,
} from "./providerExecutor.js";
import type { ReasoningFamily } from "./contracts.js";
import {
  captureSkillTaskDescriptor,
  composeCapturedCodexSkillPromptAsync,
  type SkillTaskDescriptor,
} from "./skillContext.js";
import {
  runBeforeDeadline,
  type ProviderDeadline,
} from "./deadline.js";

export type ReasoningEventObserver = (
  event: ReasoningEvent
) => unknown;

interface StructuredReasoningRequest<T> {
  readonly prompt: string;
  readonly jsonSchema: object;
  readonly parse: (value: unknown) => T;
  readonly onEvent?: ReasoningEventObserver;
  readonly signal?: AbortSignal;
  readonly cancellationReason?: CancellationReason;
  readonly jobId?: string;
  readonly context?: string;
}

export interface SkillTaskRequest<T> extends StructuredReasoningRequest<T> {
  readonly task: SkillTaskDescriptor;
}

export interface OpenAiTextRequest<T> extends StructuredReasoningRequest<T> {}

interface ReasoningRouteLogBase {
  readonly provider: ReasoningProvider;
  readonly model?: string;
}

export type ReasoningRouteLog =
  | (ReasoningRouteLogBase & {
      readonly state: "queued";
      readonly queuePosition: number;
    })
  | (ReasoningRouteLogBase & {
      readonly state: "running";
      readonly queueDurationMs: number;
    })
  | (ReasoningRouteLogBase & {
      readonly state: "fallback";
      readonly fallbackFrom: ReasoningProvider;
      readonly failureKind: ReasoningFailureKind;
    })
  | (ReasoningRouteLogBase & {
      readonly state: "succeeded";
      readonly source: "call";
      readonly queueDurationMs: number;
      readonly providerDurationMs: number;
    })
  | (ReasoningRouteLogBase & {
      readonly state: "failed";
      readonly source: ReasoningFailure["source"];
      readonly queueDurationMs: number;
      readonly providerDurationMs: number;
      readonly failureKind: ReasoningFailureKind;
    });

export type ReasoningRouteLogger = (
  entry: ReasoningRouteLog
) => unknown;

export interface SkillRouteDeps {
  readonly providerState?: ProviderState;
  readonly runClaude?: typeof productionRunClaude;
  readonly runCodex?: typeof productionRunCodex;
  readonly onLog?: ReasoningRouteLogger;
  readonly now?: () => number;
}

export type OpenAiHttpRunner<T> = (
  request: Pick<
    OpenAiTextRequest<T>,
    "prompt" | "jsonSchema" | "parse"
  > & {
    readonly model: string;
  }
) =>
  | ProviderResult<T, "openai-http">
  | Promise<ProviderResult<T, "openai-http">>;

export interface OpenAiTextRouteDeps<T> {
  readonly runHttp: OpenAiHttpRunner<T>;
  readonly openaiTextPrimary?: "codex" | "http";
  readonly providerState?: ProviderState;
  readonly runCodex?: typeof productionRunCodex;
  readonly onLog?: ReasoningRouteLogger;
  readonly now?: () => number;
}

// Skill tasks that plan, generate, verify or import content run far larger prompts than a scoring
// `aggregate` call, so they get the generation-family budgets (*_GENERATION_ROUTE_TIMEOUT_MS).
// Anything else is scoring family: the shorter budget, and so the faster fallback, is the safe
// default for a task this set does not name.
const GENERATION_SKILL_TASKS = new Set<SkillTaskDescriptor["task"]>([
  "plan",
  "generate",
  "verify",
  "import",
]);

export function isGenerationFamily(task: SkillTaskDescriptor["task"]): boolean {
  return GENERATION_SKILL_TASKS.has(task);
}

/**
 * The admission bucket this call belongs to (ADR 0007: within a family the scheduler round-robins
 * jobs and keeps FIFO order within each job).
 *
 * Fairness is per durable job, not per task. A batch runs up to seven children at once
 * (generationBatchWindow.ts), each its own `generation_jobs` row, and one Listening child can fan
 * several remediation calls out together (regenerateRejectedListeningQuestions). Keyed on the task
 * name, all of them would share one `generate:listening` bucket: a flat FIFO in which the child that
 * reached remediation first drains its whole fan-out before any sibling is admitted.
 *
 * The job id is read from the ambient model-call correlation its runner installed
 * (runGenerationJob/runScoringJob) rather than threaded through every signature between here and the
 * runners, which makes that store (modelCallLog.ts) behavioural as well as observational. `explicit`
 * wins where a caller knows better. The task name is the last resort, for calls made outside any job,
 * where there is no other job to be fair to; an empty or non-string ambient id falls through to it
 * rather than becoming a key that every such job would share.
 */
function admissionJobId(explicit: string | undefined, task: string): string {
  const owner: unknown = currentModelCallCorrelation()?.id;
  return explicit ?? (typeof owner === "string" && owner.length > 0 ? owner : task);
}

/** The provider-state operations a route uses. */
type RouteProviderState = Pick<
  ProviderState,
  "admit" | "checkCircuit" | "circuitOpen" | "recordExecution" | "recordPressure"
>;

function productionLog(entry: ReasoningRouteLog): void {
  console.info(`[reasoning-route] ${JSON.stringify(entry)}`);
}

function observe<T>(
  observer: ((value: T) => unknown) | undefined,
  value: T
): void {
  try {
    const observed = observer?.(value);
    if (
      observed !== undefined &&
      observed !== null &&
      typeof (observed as PromiseLike<void>).then === "function"
    ) {
      void Promise.resolve(observed).catch(() => undefined);
    }
  } catch {
    // Routing observers are informational and must never affect execution.
  }
}

function emit(
  observer: ReasoningEventObserver | undefined,
  event: ReasoningEvent
): void {
  observe(observer, Object.freeze({ ...event }));
}

function emitProviderEvent(
  observer: ReasoningEventObserver | undefined,
  event: ReasoningEvent,
  fallbackFrom?: ReasoningProvider
): void {
  if (event.state === "running" && fallbackFrom) {
    emit(observer, { ...event, fallbackFrom });
    return;
  }
  emit(observer, event);
}

function elapsedMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, finishedAt - startedAt);
}

function logRoute(
  logger: ReasoningRouteLogger,
  entry: ReasoningRouteLog
): void {
  observe(logger, Object.freeze({ ...entry }));
}

function modelFields(model: string | undefined): { readonly model?: string } {
  return model ? { model } : {};
}

function logResult<T, P extends ReasoningProvider>(
  logger: ReasoningRouteLogger,
  result: ProviderResult<T, P>,
  queueDurationMs: number,
  providerDurationMs: number,
  model?: string
): void {
  const common = {
    provider: result.ok ? result.provider : result.failure.provider,
    ...modelFields(model),
    queueDurationMs,
    providerDurationMs,
  };
  logRoute(
    logger,
    result.ok
      ? { ...common, state: "succeeded", source: "call" }
      : {
          ...common,
          state: "failed",
          source: result.failure.source,
          failureKind: result.failure.kind,
        }
  );
}

function reportFallback(
  observer: ReasoningEventObserver | undefined,
  logger: ReasoningRouteLogger,
  event: Extract<ReasoningEvent, { state: "fallback" }>,
  model?: string
): void {
  routeMetrics.fallbacks += 1;
  emit(observer, event);
  logRoute(logger, {
    ...event,
    ...modelFields(model),
  });
}

const routeMetrics = { fallbacks: 0 };
export function reasoningRouteMetrics(): Readonly<typeof routeMetrics> {
  return Object.freeze({ ...routeMetrics });
}

function frozenAttempts(
  attempts: readonly ReasoningAttempt[]
): readonly ReasoningAttempt[] {
  return Object.freeze(
    attempts.map(({ provider, kind }) => Object.freeze({ provider, kind }))
  );
}

function routeSuccess<T, P extends ReasoningProvider>(
  value: T,
  provider: P,
  attempts: readonly ReasoningAttempt[]
): RouteResult<T, P> {
  return {
    ok: true,
    value,
    provider,
    attempts: frozenAttempts(attempts),
  };
}

function routeFailure<T, P extends ReasoningProvider>(
  attempts: readonly ReasoningAttempt[]
): RouteResult<T, P> {
  const error = new ReasoningRouteError(attempts);
  return {
    ok: false,
    error: error.message,
    attempts: error.attempts,
  };
}

function routeCancelled<T, P extends ReasoningProvider>(
  reason: CancellationReason,
  attempts: readonly ReasoningAttempt[],
): RouteResult<T, P> {
  return {
    ok: false,
    cancelled: true,
    reason,
    error: `Structured reasoning cancelled (${reason}).`,
    attempts: frozenAttempts(attempts),
  };
}

function cancellationReasonOf<T>(
  request: StructuredReasoningRequest<T>,
): CancellationReason {
  return inferCancellationReason(request.signal, request.cancellationReason);
}

function recordFailure(
  attempts: ReasoningAttempt[],
  result: Extract<ProviderResult<unknown>, { ok: false }>
): ReasoningFailureKind {
  const { provider, kind } = result.failure;
  attempts.push({ provider, kind });
  return kind;
}

function structuredOptions<T>(
  request: StructuredReasoningRequest<T>,
  prompt: string
): Pick<RunCodexOptions<T>, "prompt" | "jsonSchema" | "parse"> {
  return {
    prompt,
    jsonSchema: request.jsonSchema,
    parse: request.parse,
  };
}

/**
 * Collects the raw traffic of one provider call so it can be written to the transcript log once the
 * call's outcome is known. A CLI call is up to two attempts (initial plus one repair), and the
 * router is the only layer that knows the outcome, the model, and the queue/provider timings —
 * hence collect here, record here.
 */
function transcriptCollector(): {
  readonly collected: CliTranscript[];
  readonly onTranscript: (transcript: CliTranscript) => void;
} {
  const collected: CliTranscript[] = [];
  return { collected, onTranscript: (t) => collected.push(t) };
}

function claudeOptions<T>(
  request: StructuredReasoningRequest<T>,
  prompt: string,
  bin: string,
  deadline: ProviderDeadline,
  onTranscript?: (transcript: CliTranscript) => void,
  onPressure?: RunClaudeOptions<T>["onPressure"],
): RunClaudeOptions<T> {
  return {
    ...structuredOptions(request, prompt),
    bin,
    deadline,
    ...(request.signal ? { signal: request.signal } : {}),
    ...(onTranscript ? { onTranscript } : {}),
    ...(onPressure ? { onPressure } : {}),
  };
}

/** The Codex CLI settings a route runs with, read once at route entry (config.ts validated them). */
interface CodexSettings {
  readonly bin: string;
  readonly model: string;
  readonly reasoningEffort: string;
}

function codexSettings(): CodexSettings {
  return {
    bin: config.codexBin,
    model: config.codexModel,
    reasoningEffort: config.codexReasoningEffort,
  };
}

function codexOptions<T>(
  request: StructuredReasoningRequest<T>,
  prompt: string,
  codex: CodexSettings,
  deadline: ProviderDeadline,
  onTranscript?: (transcript: CliTranscript) => void,
): RunCodexOptions<T> {
  return {
    ...structuredOptions(request, prompt),
    bin: codex.bin,
    model: codex.model,
    reasoningEffort: codex.reasoningEffort,
    deadline,
    ...(request.signal ? { signal: request.signal } : {}),
    ...(onTranscript ? { onTranscript } : {}),
  };
}

/**
 * One row per CLI attempt. Every attempt but the last exists only because its output was rejected,
 * so it is recorded as an `invalid-output` failure regardless of how the call ultimately went —
 * that is what actually happened to it, and it is the row a reader needs when asking why a repair
 * was necessary. Only the final attempt carries the call's real outcome and its timings; the
 * earlier ones are sub-attempts of the same clock, and splitting the durations across them would
 * invent numbers nobody measured.
 */
function recordCliTranscripts(input: {
  readonly transcripts: readonly CliTranscript[];
  readonly provider: "claude" | "codex";
  readonly model?: string;
  readonly route: string;
  readonly task?: string;
  readonly ok: boolean;
  readonly failureKind?: ReasoningFailureKind;
  readonly queueMs: number;
  readonly durationMs: number;
}): void {
  input.transcripts.forEach((transcript, index) => {
    const isFinal = index === input.transcripts.length - 1;
    recordModelCall({
      provider: input.provider,
      route: input.route,
      prompt: transcript.prompt,
      attemptIndex: index,
      outcome: isFinal && input.ok ? "succeeded" : "failed",
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.task === undefined ? {} : { task: input.task }),
      ...(transcript.response === undefined
        ? {}
        : { response: transcript.response }),
      ...(isFinal
        ? {
            ...(input.failureKind === undefined
              ? {}
              : { failureKind: input.failureKind }),
            queueMs: input.queueMs,
            durationMs: input.durationMs,
          }
        : { failureKind: "invalid-output" }),
    });
  });
}

async function runCli<T, P extends "claude" | "codex">(
  providerState: RouteProviderState,
  provider: P,
  operation: (deadline: ProviderDeadline, executionId: string) =>
    | ProviderResult<T, P>
    | Promise<ProviderResult<T, P>>,
  observer: ReasoningEventObserver | undefined,
  logger: ReasoningRouteLogger,
  now: () => number,
  model: string | undefined,
  fallbackFrom: ReasoningProvider | undefined,
  transcripts: { readonly collected: readonly CliTranscript[]; readonly route: string; readonly task?: string },
  execution: {
    readonly family: ReasoningFamily;
    readonly operation: string;
    readonly budgetMs: number;
    readonly jobId: string;
    readonly context: string;
    readonly signal?: AbortSignal;
  },
): Promise<ProviderResult<T, P>> {
  const queuedAt = now();
  let queueDurationMs: number | undefined;
  let providerStartedAt: number | undefined;
  const onProviderEvent = (event: ReasoningEvent) => {
    if (event.state === "running") {
      const runningAt = now();
      queueDurationMs = elapsedMs(queuedAt, runningAt);
      providerStartedAt = runningAt;
      emitProviderEvent(observer, event, fallbackFrom);
      logRoute(logger, {
        state: "running",
        provider,
        ...modelFields(model),
        queueDurationMs,
      });
      return;
    }

    emitProviderEvent(observer, event, fallbackFrom);
    if (event.state === "queued") {
      logRoute(logger, {
        state: "queued",
        provider,
        ...modelFields(model),
        queuePosition: event.queuePosition,
      });
    }
  };
  const executor = createProviderExecutor({
    now,
    admission: {
      admit: (request, admittedOperation) =>
        providerState.admit(
          provider,
          request,
          admittedOperation,
          onProviderEvent,
        ),
    },
  });
  const submittedWhileOpen = providerState.circuitOpen(provider);
  let adapterSettled: Promise<unknown> | undefined;
  const envelope = await executor.execute<T, P>({
    provider,
    family: execution.family,
    operation: execution.operation,
    budgetMs: execution.budgetMs,
    jobId: execution.jobId,
    context: execution.context,
    ...(execution.signal ? { signal: execution.signal } : {}),
    // `running` is reported when the provider call starts, never at dequeue: the circuit check
    // between the two can hold the request for up to the hold ceiling.
    observer: (event) => {
      if (event.state === "started") onProviderEvent({ state: "running", provider });
    },
    beforeAdmission: submittedWhileOpen ? (executionId, queuedAtMs) =>
      providerState.checkCircuit(provider, {
        requestId: executionId,
        queuedAtMs,
        submittedWhileOpen: true,
        family: execution.family,
        ...(execution.signal ? { signal: execution.signal } : {}),
      }) : undefined,
    beforeStart: submittedWhileOpen ? undefined : (executionId, queuedAtMs) =>
      providerState.checkCircuit(provider, {
        requestId: executionId,
        queuedAtMs,
        submittedWhileOpen: false,
        family: execution.family,
        ...(execution.signal ? { signal: execution.signal } : {}),
        // Held by an open circuit, the request is waiting for a slot like one still in the
        // scheduler's queue. Its position is 0: it has left that queue, and what it waits for is the
        // circuit, not a count of requests ahead of it.
        onHeld: () => onProviderEvent({ state: "queued", provider, queuePosition: 0 }),
      }),
    onTerminal: (terminal, executionId) =>
      providerState.recordExecution(provider, terminal, executionId),
    adapter: ({ deadline, executionId }) => {
      const pending = Promise.resolve().then(() => operation(deadline, executionId));
      adapterSettled = pending.catch(() => undefined);
      return pending;
    },
  });
  // Only a timeout can return before the runner settles; its transcript is still on the way.
  const timedOut = envelope.status === "failure" && envelope.failure.kind === "timeout";
  const normalizedLifecycleRecorded = recordProviderExecutionLifecycle(envelope, {
    values: transcripts.collected,
    ...(model ? { model } : {}),
    ...(timedOut && adapterSettled ? { settled: adapterSettled } : {}),
  });
  const result: ProviderResult<T, P> = providerResultFromExecution(envelope) ?? {
    ok: false,
    failure: { provider, kind: "application", source: "call" },
  };
  const finishedAt = now();
  const circuitShortCircuit =
    !result.ok && result.failure.source === "circuit";
  const finalQueueDurationMs =
    queueDurationMs ?? elapsedMs(queuedAt, finishedAt);
  const providerDurationMs =
    circuitShortCircuit || providerStartedAt === undefined
      ? 0
      : elapsedMs(providerStartedAt, finishedAt);
  logResult(
    logger,
    result,
    finalQueueDurationMs,
    providerDurationMs,
    model
  );
  if (!normalizedLifecycleRecorded) {
    recordCliTranscripts({
      transcripts: transcripts.collected,
      provider,
      route: transcripts.route,
      ok: result.ok,
      queueMs: finalQueueDurationMs,
      durationMs: providerDurationMs,
      ...(model === undefined ? {} : { model }),
      ...(transcripts.task === undefined ? {} : { task: transcripts.task }),
      ...(result.ok ? {} : { failureKind: result.failure.kind }),
    });
  }
  return result;
}

function normalizeHttpFailure<T>(
  kind: ReasoningFailureKind
): ProviderResult<T, "openai-http"> {
  return {
    ok: false,
    failure: {
      provider: "openai-http",
      kind,
      source: "call",
    },
  };
}

async function runHttp<T>(
  request: StructuredReasoningRequest<T>,
  runner: OpenAiHttpRunner<T>,
  observer: ReasoningEventObserver | undefined,
  logger: ReasoningRouteLogger,
  now: () => number,
  model: string,
  fallbackFrom?: "codex"
): Promise<ProviderResult<T, "openai-http">> {
  emit(observer, {
    state: "running",
    provider: "openai-http",
    ...(fallbackFrom ? { fallbackFrom } : {}),
  });
  logRoute(logger, {
    state: "running",
    provider: "openai-http",
    ...modelFields(model),
    queueDurationMs: 0,
  });
  const providerStartedAt = now();
  let result: ProviderResult<T, "openai-http">;
  try {
    const raw = await runner({
      ...structuredOptions(request, request.prompt),
      model,
    });
    result = raw.ok
      ? { ok: true, value: raw.value, provider: "openai-http" }
      : normalizeHttpFailure(raw.failure.kind);
  } catch {
    result = normalizeHttpFailure("application");
  }
  // Deliberately NOT recorded here. The runner is supplied by the caller (the OpenAI text judge),
  // which owns both the wire request body and the response and records them itself — a row from
  // this layer would duplicate that one while carrying strictly less (a prompt, no response).
  logResult(logger, result, 0, elapsedMs(providerStartedAt, now()), model);
  return result;
}

export async function runSkillTask<T>(
  request: SkillTaskRequest<T>,
  deps: SkillRouteDeps = {}
): Promise<RouteResult<T, "claude" | "codex">> {
  // The canonical descriptor names the skill sources the Codex leg packages; an unsupported
  // task/context throws here, before any route row or provider is touched.
  const skill = captureSkillTaskDescriptor(request.task);
  const {
    providerState = productionProviderState,
    runClaude = productionRunClaude,
    runCodex = productionRunCodex,
    onLog: logger = productionLog,
    now = () => performance.now(),
  } = deps;
  const task = `${skill.task}:${skill.context}`;
  const family: ReasoningFamily = isGenerationFamily(skill.task) ? "generation" : "scoring";
  const claudeBin = config.claudeBin;
  const codexCli = codexSettings();
  const claudeBudgetMs = family === "generation"
    ? config.claudeGenerationRouteTimeoutMs
    : config.claudeRouteTimeoutMs;
  const codexBudgetMs = family === "generation"
    ? config.codexGenerationRouteTimeoutMs
    : config.codexRouteTimeoutMs;
  const execution = (budgetMs: number) => ({
    family,
    operation: skill.task,
    budgetMs,
    jobId: admissionJobId(request.jobId, task),
    context: request.context ?? skill.context,
    ...(request.signal ? { signal: request.signal } : {}),
  });
  const attempts: ReasoningAttempt[] = [];

  // The stored stamps are epoch milliseconds, like every HTTP call's; `now` stays the clock of the
  // route log's durations and of the provider deadlines.
  return withModelCallRoute({ operation: skill.task, family, queuedAtMs: Date.now(), now: () => Date.now() }, async () => {
    if (request.signal?.aborted) {
      return routeCancelled(cancellationReasonOf(request), attempts);
    }

    const claudeTranscripts = transcriptCollector();
    const claude = await runCli<T, "claude">(
      providerState,
      "claude",
      (deadline, executionId) => runClaude(claudeOptions(
        request,
        request.prompt,
        claudeBin,
        deadline,
        claudeTranscripts.onTranscript,
        (event) => {
          if (event.kind === "telemetry") return;
          // Named by its execution, so a refusal this call saw is weighed against when it was
          // admitted, not against when it was reported.
          providerState.recordPressure(
            "claude",
            event.kind,
            event.kind === "quota" ? event.resetAtMs : undefined,
            event.window,
            executionId,
          );
        },
      )),
      request.onEvent,
      logger,
      now,
      undefined,
      undefined,
      { collected: claudeTranscripts.collected, route: "skill-task", task },
      execution(claudeBudgetMs),
    );
    if (claude.ok) {
      return routeSuccess(claude.value, "claude", attempts);
    }
    if (request.signal?.aborted) {
      return routeCancelled(cancellationReasonOf(request), attempts);
    }
    const claudeKind = recordFailure(attempts, claude);
    if (!fallbackEligible(claudeKind)) {
      return routeFailure(attempts);
    }

    reportFallback(
      request.onEvent,
      logger,
      { state: "fallback", provider: "codex", fallbackFrom: "claude", failureKind: claudeKind },
      codexCli.model,
    );
    const codexTranscripts = transcriptCollector();
    const codex = await runCli<T, "codex">(
      providerState,
      "codex",
      async (deadline) => {
        const skillPrompt = await runBeforeDeadline(
          deadline,
          () => composeCapturedCodexSkillPromptAsync(skill, request.prompt),
        );
        return runCodex(codexOptions(
          request,
          skillPrompt,
          codexCli,
          deadline,
          codexTranscripts.onTranscript,
        ));
      },
      request.onEvent,
      logger,
      now,
      codexCli.model,
      "claude",
      { collected: codexTranscripts.collected, route: "skill-task", task },
      execution(codexBudgetMs),
    );
    if (codex.ok) {
      return routeSuccess(codex.value, "codex", attempts);
    }
    if (request.signal?.aborted) {
      return routeCancelled(cancellationReasonOf(request), attempts);
    }
    recordFailure(attempts, codex);
    return routeFailure(attempts);
  });
}

export async function runOpenAiText<T>(
  request: OpenAiTextRequest<T>,
  deps: OpenAiTextRouteDeps<T>
): Promise<RouteResult<T, "codex" | "openai-http">> {
  const {
    runHttp: httpRunner,
    openaiTextPrimary,
    providerState = productionProviderState,
    runCodex = productionRunCodex,
    onLog: logger = productionLog,
    now = () => performance.now(),
  } = deps;
  // config.ts lets OPENAI_JUDGE_MODEL default to blank, and the HTTP leg cannot run without it.
  // The route refuses to start rather than run Codex-only with no fallback model; the Judge reports
  // that as the OpenAI Judge being unavailable.
  const openaiJudgeModel = config.openaiJudgeModel;
  if (openaiJudgeModel.trim().length === 0) {
    throw new TypeError("OPENAI_JUDGE_MODEL is not set.");
  }
  const codexCli = codexSettings();
  const codexBudgetMs = config.codexRouteTimeoutMs;
  const primary = openaiTextPrimary ?? config.openaiTextPrimary;
  const attempts: ReasoningAttempt[] = [];

  // Epoch stamps for storage, as in runSkillTask.
  return withModelCallRoute({ operation: "openai-text", family: "scoring", queuedAtMs: Date.now(), now: () => Date.now() }, async () => {
    if (request.signal?.aborted) {
      return routeCancelled(cancellationReasonOf(request), attempts);
    }

    if (primary === "codex") {
      const codexTranscripts = transcriptCollector();
      const codex = await runCli<T, "codex">(
        providerState,
        "codex",
        (deadline) => runCodex(codexOptions(
          request,
          request.prompt,
          codexCli,
          deadline,
          codexTranscripts.onTranscript,
        )),
        request.onEvent,
        logger,
        now,
        codexCli.model,
        undefined,
        // No task: this route carries the Judge's own prompt, not a skill.
        { collected: codexTranscripts.collected, route: "openai-text" },
        {
          family: "scoring",
          operation: "openai-text",
          budgetMs: codexBudgetMs,
          jobId: admissionJobId(request.jobId, "openai-text"),
          context: request.context ?? "judge",
          ...(request.signal ? { signal: request.signal } : {}),
        },
      );
      if (codex.ok) {
        return routeSuccess(codex.value, "codex", attempts);
      }
      if (request.signal?.aborted) {
        return routeCancelled(cancellationReasonOf(request), attempts);
      }
      const codexKind = recordFailure(attempts, codex);
      if (!fallbackEligible(codexKind)) {
        return routeFailure(attempts);
      }
      reportFallback(
        request.onEvent,
        logger,
        { state: "fallback", provider: "openai-http", fallbackFrom: "codex", failureKind: codexKind },
        openaiJudgeModel,
      );
    }

    const http = await runHttp(
      request,
      httpRunner,
      request.onEvent,
      logger,
      now,
      openaiJudgeModel,
      primary === "codex" ? "codex" : undefined,
    );
    if (http.ok) {
      return routeSuccess(http.value, "openai-http", attempts);
    }
    if (request.signal?.aborted) {
      return routeCancelled(cancellationReasonOf(request), attempts);
    }
    recordFailure(attempts, http);
    return routeFailure(attempts);
  });
}
