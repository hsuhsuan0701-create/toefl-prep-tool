import type { CancellationReason } from "@toefl-prep/shared";

export type JobCancellationReason = CancellationReason;

export class JobCancelledError extends Error {
  constructor(readonly reason: JobCancellationReason) {
    super(`job cancelled: ${reason}`);
    this.name = "JobCancelledError";
  }
}

type Registration = { token: symbol; controller: AbortController };

/**
 * Process-local delivery of a job cancellation: it wakes runs owned by this process and nothing
 * more. The job row stays the authority. Callers record the cancellation on the row before
 * delivering it, except after a lost execution lease, when this process must not write and the
 * next lease holder's boot recovery settles the row.
 */
export class JobCancellationRegistry {
  private readonly active = new Map<string, Map<symbol, AbortController>>();

  /**
   * Registers one in-process run of `jobId`. Its signal aborts when `cancel` is called for the job or
   * when `parent` aborts. `dispose` unregisters the run and may be called more than once.
   */
  start(jobId: string, parent?: AbortSignal): {
    signal: AbortSignal;
    dispose: () => void;
  } {
    const registration: Registration = {
      token: Symbol(jobId),
      controller: new AbortController(),
    };
    let registrations = this.active.get(jobId);
    if (!registrations) {
      registrations = new Map();
      this.active.set(jobId, registrations);
    }
    registrations.set(registration.token, registration.controller);

    const abortFromParent = () => {
      registration.controller.abort(parent?.reason);
    };
    if (parent?.aborted) abortFromParent();
    else parent?.addEventListener("abort", abortFromParent, { once: true });

    let disposed = false;
    return {
      signal: registration.controller.signal,
      dispose: () => {
        if (disposed) return;
        disposed = true;
        parent?.removeEventListener("abort", abortFromParent);
        const current = this.active.get(jobId);
        current?.delete(registration.token);
        if (current?.size === 0) this.active.delete(jobId);
      },
    };
  }

  /**
   * Aborts every registered run of `jobId` with a JobCancelledError and reports whether there was
   * one. Writes nothing to the job row.
   */
  cancel(jobId: string, reason: JobCancellationReason): boolean {
    const registrations = this.active.get(jobId);
    if (!registrations || registrations.size === 0) return false;
    const error = new JobCancelledError(reason);
    for (const controller of registrations.values()) controller.abort(error);
    return true;
  }

  cancelAll(reason: JobCancellationReason): number {
    const ids = [...this.active.keys()];
    for (const id of ids) this.cancel(id, reason);
    return ids.length;
  }

  get activeCount(): number {
    let count = 0;
    for (const registrations of this.active.values()) count += registrations.size;
    return count;
  }
}

export const generationJobCancellations = new JobCancellationRegistry();
export const scoringJobCancellations = new JobCancellationRegistry();

// The process-wide gate on admitting new work (the durable job runner, the score and generate routes,
// recording intake). Open while admissions have not been stopped (shutdown or a lost execution lease;
// nothing reopens it) and the readiness check passes (index.ts wires it to the execution owner's
// readiness).
let admissionsOpen = true;
let admissionReadiness = () => true;
export function stopJobAdmissions(): void { admissionsOpen = false; }
export function setJobAdmissionReadiness(readiness: () => boolean): void { admissionReadiness = readiness; }
export function jobAdmissionsAreOpen(): boolean { return admissionsOpen && admissionReadiness(); }
export function resetJobAdmissionsForTests(): void { admissionsOpen = true; admissionReadiness = () => true; }

/** Throws the signal's abort reason when it is an Error, else a user cancellation; returns if not aborted. */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new JobCancelledError("user");
}
