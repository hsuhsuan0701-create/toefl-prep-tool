import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import {
  inferCancellationReason,
  type CancellationReason,
  type CliProvider,
  type ProviderResult,
  type ReasoningFamily,
} from "./contracts.js";
import {
  createProviderDeadline,
  isProviderDeadlineExceeded,
  superviseBeforeDeadline,
  type ProviderDeadline,
} from "./deadline.js";

export interface AdmissionRequest {
  readonly family: ReasoningFamily;
  readonly jobId: string;
  readonly signal?: AbortSignal;
}

export interface AdmissionController {
  admit<T>(
    request: AdmissionRequest,
    operation: () => T | Promise<T>,
  ): Promise<T>;
}

export type ProviderLifecycleEvent = Readonly<{
  executionId: string;
  provider: CliProvider;
  family: ReasoningFamily;
  operation: string;
  jobId: string;
  context: string;
  state: "queued" | "dequeued" | "started" | "finished";
  atMs: number;
}>;

export interface ProviderAdapterContext {
  readonly deadline: ProviderDeadline;
  readonly signal?: AbortSignal;
  /** The id this execution was admitted under, so an observation the call reports names it. */
  readonly executionId: string;
}

interface ProviderExecutionBase<P extends CliProvider> {
  readonly executionId: string;
  readonly provider: P;
  readonly family: ReasoningFamily;
  readonly operation: string;
  readonly jobId: string;
  readonly context: string;
  readonly queuedAtMs: number;
  readonly dequeuedAtMs: number;
  readonly startedAtMs: number;
  readonly finishedAtMs: number;
}

export type ProviderExecution<T, P extends CliProvider = CliProvider> =
  | (ProviderExecutionBase<P> & {
      readonly status: "success";
      readonly value: T;
    })
  | (ProviderExecutionBase<P> & {
      readonly status: "failure";
      readonly failure: Extract<ProviderResult<T, P>, { ok: false }>["failure"];
    })
  | (ProviderExecutionBase<P> & {
      readonly status: "cancelled";
      readonly reason: CancellationReason;
    });

export interface ProviderExecutionRequest<T, P extends CliProvider> {
  readonly provider: P;
  readonly family: ReasoningFamily;
  readonly operation: string;
  readonly budgetMs: number;
  readonly jobId: string;
  readonly context: string;
  readonly signal?: AbortSignal;
  readonly cancellationReason?: () => CancellationReason;
  readonly observer?: (event: ProviderLifecycleEvent) => unknown;
  /** A cheap policy gate evaluated before scarce scheduler admission. */
  readonly beforeAdmission?: (
    executionId: string,
    queuedAtMs: number,
  ) => ProviderResult<void, P> | Promise<ProviderResult<void, P>>;
  readonly beforeStart?: (
    executionId: string,
    queuedAtMs: number,
  ) => ProviderResult<void, P> | Promise<ProviderResult<void, P>>;
  readonly onTerminal?: (
    result: ProviderResult<T, P> | { readonly cancelled: true },
    executionId: string,
  ) => void;
  readonly adapter: (
    context: ProviderAdapterContext,
  ) => ProviderResult<T, P> | Promise<ProviderResult<T, P>>;
}

export interface ProviderExecutor {
  execute<T, P extends CliProvider>(
    request: ProviderExecutionRequest<T, P>,
  ): Promise<ProviderExecution<T, P>>;
}

function observe(
  observer: ((event: ProviderLifecycleEvent) => unknown) | undefined,
  event: ProviderLifecycleEvent,
): void {
  try {
    const pending = observer?.(Object.freeze(event));
    if (
      pending !== undefined &&
      pending !== null &&
      typeof (pending as PromiseLike<void>).then === "function"
    ) {
      void Promise.resolve(pending).catch(() => undefined);
    }
  } catch {
    // Lifecycle observation cannot change admission or provider outcomes.
  }
}

function cancellationReason<T, P extends CliProvider>(
  request: ProviderExecutionRequest<T, P>,
): CancellationReason {
  try {
    return inferCancellationReason(request.signal, request.cancellationReason?.());
  } catch {
    return inferCancellationReason(request.signal);
  }
}

export function createProviderExecutor(options: {
  readonly admission: AdmissionController;
  /** The monotonic clock the provider deadline runs on. */
  readonly now?: () => number;
  /**
   * The clock of the execution's `*AtMs` stamps and lifecycle events: epoch milliseconds, because
   * the stamps are stored beside the HTTP calls' (`provider_executions`), and the monotonic clock
   * counts from process start.
   */
  readonly epochNow?: () => number;
  readonly id?: () => string;
}): ProviderExecutor {
  const now = options.now ?? (() => performance.now());
  const stamp = options.epochNow ?? (() => Date.now());
  const id = options.id ?? randomUUID;

  return {
    async execute<T, P extends CliProvider>(
      request: ProviderExecutionRequest<T, P>,
    ): Promise<ProviderExecution<T, P>> {
      const executionId = id();
      // The admission hooks order requests by the monotonic clock; the stamps below are epoch.
      const queuedAtMonotonicMs = now();
      const queuedAtMs = stamp();
      const eventBase = {
        executionId,
        provider: request.provider,
        family: request.family,
        operation: request.operation,
        jobId: request.jobId,
        context: request.context,
      } as const;
      observe(request.observer, {
        ...eventBase,
        state: "queued",
        atMs: queuedAtMs,
      });

      // Preserve the synchronous admission prefix when no preflight hook is installed. Awaiting
      // `undefined` would insert a microtask boundary before queue telemetry/admission.
      const preAdmission = request.beforeAdmission
        ? await request.beforeAdmission(executionId, queuedAtMonotonicMs)
        : undefined;
      if (preAdmission && !preAdmission.ok) {
        const finishedAtMs = stamp();
        observe(request.observer, {
          ...eventBase,
          state: "finished",
          atMs: finishedAtMs,
        });
        try {
          request.onTerminal?.(preAdmission, executionId);
        } catch {
          // Policy observation cannot replace the provider outcome.
        }
        return Object.freeze({
          ...eventBase,
          status: "failure",
          failure: preAdmission.failure,
          queuedAtMs,
          dequeuedAtMs: finishedAtMs,
          startedAtMs: finishedAtMs,
          finishedAtMs,
        });
      }

      try {
        return await options.admission.admit(
        {
          family: request.family,
          jobId: request.jobId,
          ...(request.signal ? { signal: request.signal } : {}),
        },
        async () => {
          const dequeuedAtMs = stamp();
          observe(request.observer, {
            ...eventBase,
            state: "dequeued",
            atMs: dequeuedAtMs,
          });
          // Set, and `started` observed, only when the adapter is about to run: `beforeStart` can
          // hold a dequeued request (an open circuit), and that wait is not provider time. An
          // execution that never reaches the adapter starts and finishes at the same instant.
          let startedAtMs: number | undefined;

          let execution:
            | { readonly status: "success"; readonly value: T }
            | {
                readonly status: "failure";
                readonly failure: Extract<ProviderResult<T, P>, { ok: false }>["failure"];
              }
            | { readonly status: "cancelled"; readonly reason: CancellationReason };

          const availability = await request.beforeStart?.(
            executionId,
            queuedAtMonotonicMs,
          );
          if (request.signal?.aborted) {
            execution = {
              status: "cancelled",
              reason: cancellationReason(request),
            };
          } else if (availability && !availability.ok) {
            execution = {
              status: "failure",
              failure: availability.failure,
            };
          } else {
            startedAtMs = stamp();
            observe(request.observer, {
              ...eventBase,
              state: "started",
              atMs: startedAtMs,
            });
            const deadline = createProviderDeadline(request.budgetMs, { now });
            try {
              const result = await superviseBeforeDeadline(
                deadline,
                () => request.adapter({
                  deadline,
                  executionId,
                  ...(request.signal ? { signal: request.signal } : {}),
                }),
              );
              if (request.signal?.aborted) {
                execution = {
                  status: "cancelled",
                  reason: cancellationReason(request),
                };
              } else {
                // Rebuilt from named fields so the execution (and the diagnostic row recorded
                // from it) carries the called provider and the failure kind, and nothing else a
                // runner's result may hold.
                execution = result.ok
                  ? { status: "success", value: result.value }
                  : {
                      status: "failure",
                      failure: {
                        provider: request.provider,
                        kind: result.failure.kind,
                        source: "call",
                      },
                    };
              }
            } catch (error) {
              if (request.signal?.aborted) {
                execution = {
                  status: "cancelled",
                  reason: cancellationReason(request),
                };
              } else {
                execution = {
                  status: "failure",
                  failure: {
                    provider: request.provider,
                    kind: isProviderDeadlineExceeded(error)
                      ? "timeout"
                      : "application",
                    source: "call",
                  },
                };
              }
            }
          }

          const finishedAtMs = stamp();
          observe(request.observer, {
            ...eventBase,
            state: "finished",
            atMs: finishedAtMs,
          });
          try {
            request.onTerminal?.(
              execution.status === "cancelled"
                ? { cancelled: true }
                : execution.status === "success"
                  ? {
                      ok: true,
                      provider: request.provider,
                      value: execution.value,
                    }
                  : { ok: false, failure: execution.failure },
              executionId,
            );
          } catch {
            // Policy observation cannot replace the provider outcome.
          }
          return Object.freeze({
            ...eventBase,
            ...execution,
            queuedAtMs,
            dequeuedAtMs,
            startedAtMs: startedAtMs ?? finishedAtMs,
            finishedAtMs,
          }) as ProviderExecution<T, P>;
        },
        );
      } catch (error) {
        if (!(request.signal?.aborted || (error instanceof DOMException && error.name === "AbortError"))) {
          throw error;
        }
        const finishedAtMs = stamp();
        const execution = Object.freeze({
          ...eventBase,
          status: "cancelled" as const,
          reason: cancellationReason(request),
          queuedAtMs,
          dequeuedAtMs: finishedAtMs,
          startedAtMs: finishedAtMs,
          finishedAtMs,
        });
        observe(request.observer, { ...eventBase, state: "finished", atMs: finishedAtMs });
        try { request.onTerminal?.({ cancelled: true }, executionId); } catch { /* isolated */ }
        return execution;
      }
    },
  };
}

export function providerResultFromExecution<
  T,
  P extends CliProvider,
>(execution: ProviderExecution<T, P>): ProviderResult<T, P> | undefined {
  if (execution.status === "cancelled") return undefined;
  return execution.status === "success"
    ? { ok: true, provider: execution.provider, value: execution.value }
    : { ok: false, failure: execution.failure };
}
