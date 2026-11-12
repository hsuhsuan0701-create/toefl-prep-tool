import crypto from "node:crypto";
import type {
  CancellationReason,
  DiagnosticOutcome,
  ModelCallInsert,
  ModelAttemptInsert,
  ProviderExecutionInsert,
  RouteInvocationInsert,
} from "../db/rows.js";

/**
 * The normalized model-diagnostic port, `route_invocations` -> `provider_executions` ->
 * `model_attempts` (ADR 0004), declared as exactly the four writers this recorder makes.
 * db/stores/diagnostics.ts is the SQLite adapter; the suite also hands the recorder throwing object
 * literals to prove the containment below without a database.
 *
 * `finishRouteInvocation` is a conditional writer and reports whether it won: its statement carries
 * `WHERE id=? AND outcome IS NULL`, so the first terminal outcome recorded for a route invocation
 * stands and a late or duplicate finish cannot overwrite it. A future member that finishes a row
 * without such a guard would be removing one.
 *
 * Nothing here throws into the caller: a diagnostic write that could fail the paid call it observes
 * would be worse than no diagnostics. That containment lives in `drain` below, which is why these
 * members are declared as returning normally.
 */
export type ModelDiagnosticStore = {
  insertRouteInvocation(r: RouteInvocationInsert): void;
  finishRouteInvocation(r: {
    id: string; finishedAtMs: number; durationMs: number; outcome: DiagnosticOutcome;
    failureKind?: string; cancellationReason?: CancellationReason;
  }): boolean;
  insertProviderExecution(e: ProviderExecutionInsert): void;
  insertModelAttempt(a: ModelAttemptInsert): void;
};

type Repo = ModelDiagnosticStore;
type RecordLoss = { kind: "overflow" | "database"; correlationId: string; recordType: "route" | "execution" | "attempt"; error?: string };
type Pending = { correlationId: string; recordType: RecordLoss["recordType"]; write: () => void };

const MAX_FIELD_BYTES = 1024 * 1024;
const REDACTION_RULES: Array<[RegExp, string]> = [
  [/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [/(authorization["']?\s*:\s*["']Bearer\s+)[^"']+/gi, "$1[REDACTED]"],
  [/(["']?(?:api[_-]?key|apiKey|access[_-]?token|secret)["']?\s*:\s*)(["'])[^"']*\2/gi, "$1$2[REDACTED]$2"],
  [/(\b(?:api[_-]?key|access[_-]?token|secret)\b\s*[=:]\s*)[^\s,;"']+/gi, "$1[REDACTED]"],
  [/\b(?:sk|sk-ant)-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]"],
];

export function redactModelText(value: string): string {
  return REDACTION_RULES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

export function truncateModelText(value: string, limit = MAX_FIELD_BYTES): { value: string; omittedBytes: number } {
  const redacted = redactModelText(value);
  const bytes = Buffer.from(redacted, "utf8");
  if (bytes.length <= limit) return { value: redacted, omittedBytes: 0 };
  const markerReserve = 96;
  const payloadBytes = Math.max(0, limit - markerReserve);
  const headBytes = Math.ceil(payloadBytes / 2);
  const tailBytes = Math.floor(payloadBytes / 2);
  let head = bytes.subarray(0, headBytes).toString("utf8").replace(/\uFFFD$/u, "");
  let tail = bytes.subarray(bytes.length - tailBytes).toString("utf8").replace(/^\uFFFD+/u, "");
  let omittedBytes = bytes.length - Buffer.byteLength(head) - Buffer.byteLength(tail);
  let marker = `\n… [${omittedBytes} bytes omitted] …\n`;
  while (Buffer.byteLength(head + marker + tail) > limit) {
    if (head.length >= tail.length) head = head.slice(0, -1); else tail = tail.slice(1);
    omittedBytes = bytes.length - Buffer.byteLength(head) - Buffer.byteLength(tail);
    marker = `\n… [${omittedBytes} bytes omitted] …\n`;
  }
  return { value: head + marker + tail, omittedBytes };
}

/**
 * Bounded, asynchronous diagnostic writer. Lifecycle callers only enqueue; database latency and
 * failures never enter provider execution or fallback control flow.
 */
export class ModelCallRecorder {
  private readonly queue: Pending[] = [];
  private scheduled = false;
  private processing = false;
  private readonly waiters = new Set<() => void>();
  private readonly capacity: number;
  private readonly schedule: (fn: () => void) => void;
  private readonly onLoss: (loss: RecordLoss) => void;

  constructor(private readonly repo: Repo, options: {
    capacity?: number;
    schedule?: (fn: () => void) => void;
    onLoss?: (loss: RecordLoss) => void;
  } = {}) {
    this.capacity = Math.max(1, Math.floor(options.capacity ?? 1024));
    this.schedule = options.schedule ?? queueMicrotask;
    this.onLoss = options.onLoss ?? ((loss) => console.error(JSON.stringify({ event: "model_call_recorder_loss", ...loss })));
  }

  route(record: RouteInvocationInsert): void {
    this.enqueue({ correlationId: record.id, recordType: "route", write: () => this.repo.insertRouteInvocation(record) });
  }

  finishRoute(record: Parameters<Repo["finishRouteInvocation"]>[0]): void {
    this.enqueue({ correlationId: record.id, recordType: "route", write: () => { this.repo.finishRouteInvocation(record); } });
  }

  execution(record: ProviderExecutionInsert): void {
    this.enqueue({ correlationId: record.id, recordType: "execution", write: () => this.repo.insertProviderExecution(record) });
  }

  attempt(record: ModelAttemptInsert): void {
    const prompt = record.prompt === undefined ? undefined : truncateModelText(record.prompt);
    const response = record.response === undefined ? undefined : truncateModelText(record.response);
    const safe: ModelAttemptInsert = {
      ...record,
      ...(prompt ? { prompt: prompt.value, promptOmittedBytes: prompt.omittedBytes } : {}),
      ...(response ? { response: response.value, responseOmittedBytes: response.omittedBytes } : {}),
    };
    this.enqueue({ correlationId: record.id, recordType: "attempt", write: () => this.repo.insertModelAttempt(safe) });
  }

  /** Compatibility entry point for call sites that only report after a complete call. */
  completedCall(call: ModelCallInsert, parent?: { routeId: string; executionSequence: number; family: "scoring" | "generation" }): void {
    const routeId = parent?.routeId ?? crypto.randomUUID();
    const executionId = crypto.randomUUID();
    const finishedAtMs = Date.now();
    const durationMs = call.durationMs ?? 0;
    const startedAtMs = Math.max(0, finishedAtMs - durationMs);
    const queuedAtMs = Math.max(0, startedAtMs - (call.queueMs ?? 0));
    const family = parent?.family ?? (call.contextKind === "generation-job" ? "generation" : "scoring");
    const outcome = call.outcome === "succeeded" ? "success" : "failure";
    const prompt = truncateModelText(call.prompt);
    const response = call.response === undefined ? undefined : truncateModelText(call.response);
    this.enqueue({ correlationId: call.id, recordType: "attempt", write: () => {
      if (!parent) this.repo.insertRouteInvocation({ id: routeId, operation: call.task ?? call.route, family, contextKind: call.contextKind, contextId: call.contextId, contextDetail: call.contextDetail, queuedAtMs, finishedAtMs, durationMs: finishedAtMs - queuedAtMs, outcome, failureKind: call.failureKind });
      this.repo.insertProviderExecution({ id: executionId, routeInvocationId: routeId, sequence: parent?.executionSequence ?? 1, provider: call.provider, family, operation: call.task ?? call.route, queuedAtMs, dequeuedAtMs: startedAtMs, startedAtMs, finishedAtMs, queueMs: call.queueMs, durationMs, outcome, failureKind: call.failureKind });
      this.repo.insertModelAttempt({ id: call.id, providerExecutionId: executionId, sequence: (call.attemptIndex ?? 0) + 1, kind: (call.attemptIndex ?? 0) > 0 ? "repair" : "initial", model: call.model, prompt: prompt.value, promptOmittedBytes: prompt.omittedBytes, response: response?.value, responseOmittedBytes: response?.omittedBytes, startedAtMs, finishedAtMs, durationMs, outcome, failureKind: call.failureKind });
    }});
  }

  executionWithAttempts(execution: ProviderExecutionInsert, attempts: ModelAttemptInsert[]): void {
    const safeAttempts = attempts.map((attempt) => {
      const prompt = attempt.prompt === undefined ? undefined : truncateModelText(attempt.prompt);
      const response = attempt.response === undefined ? undefined : truncateModelText(attempt.response);
      return { ...attempt, ...(prompt ? {prompt:prompt.value,promptOmittedBytes:prompt.omittedBytes}:{}), ...(response ? {response:response.value,responseOmittedBytes:response.omittedBytes}:{}) };
    });
    this.enqueue({ correlationId: execution.id, recordType: "execution", write: () => {
      this.repo.insertProviderExecution(execution);
      for (const attempt of safeAttempts) this.repo.insertModelAttempt(attempt);
    }});
  }

  private enqueue(pending: Pending): void {
    if (this.queue.length >= this.capacity) {
      this.report({ kind: "overflow", correlationId: pending.correlationId, recordType: pending.recordType });
      return;
    }
    this.queue.push(pending);
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.drain());
    }
  }

  private drain(): void {
    this.scheduled = false;
    this.processing = true;
    while (this.queue.length) {
      const pending = this.queue.shift()!;
      try { pending.write(); }
      catch (error) {
        this.report({ kind: "database", correlationId: pending.correlationId, recordType: pending.recordType, error: error instanceof Error ? error.message : String(error) });
      }
    }
    this.processing = false;
    for (const resolve of this.waiters) resolve();
    this.waiters.clear();
  }

  private report(loss: RecordLoss): void {
    try { this.onLoss(loss); }
    catch { /* metrics/logging observers are isolated too */ }
  }

  async flush(timeoutMs = 5000): Promise<boolean> {
    if (!this.scheduled && !this.processing && this.queue.length === 0) return true;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
      this.waiters.add(() => finish(true));
    });
  }
}
