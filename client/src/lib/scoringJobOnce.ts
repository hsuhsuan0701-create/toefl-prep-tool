// One scoring job per (Attempt, Task Type) for the Drills' pipelined result slots.
//
// A Drill result slot fires its scoring job when it mounts (useScoringJob's auto-start). A slot that
// is unmounted and mounted again, because the screen around it changed shape between stages or a
// stage renders it in a different place, would therefore POST the same Task Type for scoring a
// second time, and the second job supersedes the first on the server and overwrites its scores.
// Guarding inside the component cannot stop that: a fresh instance has fresh refs.
//
// So the start is keyed outside React. The first caller for a key fires the request; every later
// caller for the same key, mounted or remounted, gets the same promise and so the same job id to
// poll. The promise is stored, not the job id, so a request still in flight dedupes as reliably as
// one that has landed. A request that fails releases its key, so the next mount (or a Retry) can try
// again. An explicit Retry must start a new job: call `forgetScoringJob` first.
//
// Module scope, cleared only by a page reload. Keys always carry the Attempt id, so two Attempts
// never share an entry.

const registry = new Map<string, Promise<{ jobId: string }>>();

/** The registry key for one Task Type of one Attempt. */
export function scoringJobKey(attemptId: string, taskType: string): string {
  return `${attemptId}:${taskType}`;
}

/**
 * Starts the scoring job for `key` with `fire`, or joins the one already started for it. The entry is
 * claimed synchronously, before `fire`'s request settles, so a second caller in the same tick joins
 * rather than racing.
 */
export function startScoringJobOnce(key: string, fire: () => Promise<{ jobId: string }>): Promise<{ jobId: string }> {
  const existing = registry.get(key);
  if (existing) return existing;
  const promise = fire();
  registry.set(key, promise);
  promise.catch(() => {
    if (registry.get(key) === promise) registry.delete(key);
  });
  return promise;
}

/** Drops `key`'s entry, so the next start fires a new job. For an explicit Retry. */
export function forgetScoringJob(key: string): void {
  registry.delete(key);
}
