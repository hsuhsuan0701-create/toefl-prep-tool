import type { ReasoningFamily } from "./contracts.js";
export type { ReasoningFamily } from "./contracts.js";

export interface AdmissionRequest {
  readonly family: ReasoningFamily;
  readonly jobId: string;
  readonly signal?: AbortSignal;
  readonly onQueued?: (familyLocalPosition: number) => void;
}

export interface AdmissionSnapshot {
  readonly capacity: number;
  readonly reservedScoring: number;
  readonly active: Readonly<Record<ReasoningFamily, number>>;
  readonly queued: Readonly<Record<ReasoningFamily, number>>;
  readonly queueLatencyMs: Readonly<{ count: number; total: number; max: number }>;
}

interface QueueEntry<T> {
  readonly request: AdmissionRequest;
  readonly operation: () => T | Promise<T>;
  readonly queuedAt: number;
  readonly resolve: (value: Awaited<T>) => void;
  readonly reject: (reason: unknown) => void;
  abortListener?: () => void;
  settled: boolean;
}

interface FamilyQueue {
  readonly jobs: Map<string, QueueEntry<unknown>[]>;
  readonly jobOrder: string[];
  size: number;
}

function newFamilyQueue(): FamilyQueue {
  return { jobs: new Map(), jobOrder: [], size: 0 };
}

function abortError(signal: AbortSignal): DOMException {
  return new DOMException(
    typeof signal.reason === "string" ? signal.reason : "The operation was aborted",
    "AbortError"
  );
}

/**
 * Provider-local admission policy. It knows capacity and fairness, but nothing about
 * route deadlines, providers, adapters, or fallback.
 */
export class AdmissionScheduler {
  private capacity: number;
  private readonly reservedScoring: number;
  private readonly now: () => number;
  private readonly active: Record<ReasoningFamily, number> = { scoring: 0, generation: 0 };
  private readonly queues: Record<ReasoningFamily, FamilyQueue> = {
    scoring: newFamilyQueue(),
    generation: newFamilyQueue(),
  };
  private queueLatencyCount = 0;
  private queueLatencyTotalMs = 0;
  private queueLatencyMaxMs = 0;

  constructor(options: { readonly capacity: number; readonly reservedScoring: number; readonly now?: () => number }) {
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new RangeError("capacity must be a positive integer");
    }
    if (
      !Number.isInteger(options.reservedScoring) ||
      options.reservedScoring < 0 ||
      options.reservedScoring >= options.capacity
    ) {
      throw new RangeError("reservedScoring must be a non-negative integer below capacity");
    }
    this.capacity = options.capacity;
    this.reservedScoring = options.reservedScoring;
    this.now = options.now ?? Date.now;
  }

  setCapacity(capacity: number): void {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity <= this.reservedScoring) {
      throw new RangeError("capacity must be an integer above reservedScoring");
    }
    this.capacity = capacity;
    this.dispatch();
  }

  /**
   * `onQueued` fires only when the request cannot start at once, with the number of requests of its
   * family queued ahead of it. Requests already running are never counted: at a capacity above one
   * they run beside this request rather than in front of it. The count is family-local and
   * best-effort (round-robin across jobs can reorder the line), never an ETA.
   */
  run<T>(request: AdmissionRequest, operation: () => T | Promise<T>): Promise<Awaited<T>> {
    if (request.signal?.aborted) return Promise.reject(abortError(request.signal));
    const queue = this.queues[request.family];
    const position = queue.size;
    const promise = new Promise<Awaited<T>>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        request,
        operation,
        queuedAt: this.now(),
        resolve,
        reject,
        settled: false,
      };
      const jobQueue = queue.jobs.get(request.jobId);
      if (jobQueue) {
        jobQueue.push(entry as QueueEntry<unknown>);
      } else {
        queue.jobs.set(request.jobId, [entry as QueueEntry<unknown>]);
        queue.jobOrder.push(request.jobId);
      }
      queue.size += 1;
      if (request.signal) {
        entry.abortListener = () => this.abortQueued(entry as QueueEntry<unknown>);
        request.signal.addEventListener("abort", entry.abortListener, { once: true });
      }
    });
    if (position > 0 || !this.canStart(request.family)) {
      try { request.onQueued?.(position); } catch { /* telemetry is isolated */ }
    }
    this.dispatch();
    return promise;
  }

  /** ProviderExecutor's admission-facade spelling. */
  admit<T>(request: AdmissionRequest, operation: () => T | Promise<T>): Promise<Awaited<T>> {
    return this.run(request, operation);
  }

  snapshot(): AdmissionSnapshot {
    return Object.freeze({
      capacity: this.capacity,
      reservedScoring: this.reservedScoring,
      active: Object.freeze({ ...this.active }),
      queued: Object.freeze({ scoring: this.queues.scoring.size, generation: this.queues.generation.size }),
      queueLatencyMs: Object.freeze({ count: this.queueLatencyCount, total: this.queueLatencyTotalMs, max: this.queueLatencyMaxMs }),
    });
  }

  private canStart(family: ReasoningFamily): boolean {
    const total = this.active.scoring + this.active.generation;
    if (total >= this.capacity) return false;
    return family === "scoring" || this.active.generation < this.capacity - this.reservedScoring;
  }

  private candidate(family: ReasoningFamily): QueueEntry<unknown> | undefined {
    if (!this.canStart(family)) return undefined;
    const queue = this.queues[family];
    const jobId = queue.jobOrder[0];
    return jobId === undefined ? undefined : queue.jobs.get(jobId)?.[0];
  }

  private take(family: ReasoningFamily): QueueEntry<unknown> | undefined {
    const queue = this.queues[family];
    const jobId = queue.jobOrder.shift();
    if (jobId === undefined) return undefined;
    const jobQueue = queue.jobs.get(jobId)!;
    const entry = jobQueue.shift()!;
    queue.size -= 1;
    if (jobQueue.length === 0) queue.jobs.delete(jobId);
    else queue.jobOrder.push(jobId);
    return entry;
  }

  private dispatch(): void {
    for (;;) {
      const scoring = this.candidate("scoring");
      const generation = this.candidate("generation");
      if (!scoring && !generation) return;
      const family: ReasoningFamily = !generation || (scoring && scoring.queuedAt <= generation.queuedAt)
        ? "scoring"
        : "generation";
      const entry = this.take(family);
      if (!entry) return;
      entry.settled = true;
      if (entry.abortListener && entry.request.signal) {
        entry.request.signal.removeEventListener("abort", entry.abortListener);
      }
      this.active[family] += 1;
      const latencyMs = Math.max(0, this.now() - entry.queuedAt);
      this.queueLatencyCount += 1;
      this.queueLatencyTotalMs += latencyMs;
      this.queueLatencyMaxMs = Math.max(this.queueLatencyMaxMs, latencyMs);
      void Promise.resolve()
        .then(entry.operation)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this.active[family] -= 1;
          this.dispatch();
        });
    }
  }

  private abortQueued(entry: QueueEntry<unknown>): void {
    if (entry.settled) return;
    const { family, jobId, signal } = entry.request;
    const queue = this.queues[family];
    const jobQueue = queue.jobs.get(jobId);
    if (!jobQueue) return;
    const index = jobQueue.indexOf(entry);
    if (index < 0) return;
    jobQueue.splice(index, 1);
    queue.size -= 1;
    if (jobQueue.length === 0) {
      queue.jobs.delete(jobId);
      const orderIndex = queue.jobOrder.indexOf(jobId);
      if (orderIndex >= 0) queue.jobOrder.splice(orderIndex, 1);
    }
    entry.settled = true;
    entry.reject(abortError(signal!));
    this.dispatch();
  }
}
