/**
 * A stand-in for lib/abortableDelay.ts that returns at once and records every wait it was asked
 * for: virtual time for the HTTP retry loops in ears.ts and judges/index.ts.
 *
 * Those loops back off 1 s then 4 s, and a test that exercises them against the real delay spends
 * up to five seconds of wall-clock time per call doing nothing. With this the whole schedule runs
 * in microseconds, and the test asserts the schedule itself (`waits`) instead of sleeping through it.
 */
export function virtualDelay(): {
  delay: (ms: number, signal?: AbortSignal) => Promise<void>;
  waits: number[];
} {
  const waits: number[] = [];
  return {
    waits,
    // Same abort contract as abortableDelay: an already-aborted signal rejects with its reason.
    delay: async (ms, signal) => {
      signal?.throwIfAborted();
      waits.push(ms);
    },
  };
}
