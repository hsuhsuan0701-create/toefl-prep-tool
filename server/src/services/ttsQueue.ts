// The one bound on how much text-to-speech this process has in flight (TTS_CONCURRENCY).
//
// PROCESS-WIDE, NOT PER-SET. What it protects is a provider rate limit, and a rate limit does not
// care how many Sets are rendering: two Speaking renders of 13 clips each put 26 calls through the
// same account as one would. A per-render limiter would bound each renderer and nothing about their
// sum.
//
// WHAT A SLOT COVERS: one CLIP's whole take cycle — every synthesis it buys (the first take and any
// pace-corrective retakes), the probe after each, and tts.ts's retry waits between failed requests.
// So `limit` clips in flight means at most `limit` syntheses in flight, a clip's correction state
// never interleaves with another clip's, and a clip backing off from a 429 keeps its slot, which is
// what throttles the clips queued behind it. It also bounds the ffprobe/ffmpeg processes that ride
// along with each clip. The cost is that a slot is held across local probes that are not paid calls.
//
// FIFO. Waiters are admitted in submission order, so at `limit = 1` this is exactly a serial loop over
// the clips: same order, same one-at-a-time spend, same failure point.
//
// The calibration and smoke scripts take a slot too (withTtsSlot), so TTS_CONCURRENCY bounds them in
// their own process as it bounds the server.

import { config } from "../lib/config.js";

/**
 * A counting semaphore with a FIFO waiter queue.
 *
 * `release` hands its slot DIRECTLY to the next waiter rather than decrementing and letting the
 * waiter re-check: decrementing first would let a task submitted later, whose `acquire` happens to
 * run in the intervening microtask, jump the queue. FIFO is what makes limit=1 a serial loop.
 */
class TtsSemaphore {
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(readonly limit: number) {}

  private async acquire(): Promise<void> {
    if (this.inFlight < this.limit) {
      this.inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    // The slot is transferred, not returned: `inFlight` is deliberately unchanged when a waiter
    // takes it over.
    if (next) next();
    else this.inFlight -= 1;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }
}

let queue: TtsSemaphore | undefined;

/**
 * The process-wide queue. Created on first use rather than at module load so a test can set the
 * limit before anything renders, and so importing this module never reads configuration.
 */
function ttsQueue(): TtsSemaphore {
  queue ??= new TtsSemaphore(config.ttsConcurrency);
  return queue;
}

/** How many clips this process will render at once. For a log line and for the tests. */
export function ttsConcurrencyLimit(): number {
  return ttsQueue().limit;
}

/**
 * Test-only. Replaces the process-wide queue with one of a given limit, or (with no argument) drops
 * it so the next use rebuilds it from configuration.
 */
export function setTtsConcurrencyForTests(limit?: number): void {
  queue = limit === undefined ? undefined : new TtsSemaphore(limit);
}

/**
 * Runs one clip render under the process-wide bound: renderClipsBounded's clips, and each synthesis
 * the calibration and smoke scripts make.
 */
export function withTtsSlot<T>(render: () => Promise<T>): Promise<T> {
  return ttsQueue().run(render);
}

/**
 * Renders `clips` through the process-wide queue and returns their outputs IN CLIP ORDER. Three
 * properties a bare `Promise.all` would not give:
 *
 *  1. ORDER. Results are written to `results[index]`, never pushed as they complete: the Speaking
 *     manifest's clip order is read downstream (`lr-1`…`lr-7` are a difficulty ramp). Submission is
 *     in clip order too, so with FIFO admission the calls are also made in clip order.
 *
 *  2. NOTHING NEW IS BOUGHT AFTER A FAILURE. Once any clip has failed, a clip that has not started
 *     is skipped rather than synthesized, so a failure costs a partial Set's worth of calls.
 *
 *  3. EVERY IN-FLIGHT CLIP SETTLES BEFORE THE FAILURE PROPAGATES. Both renderers handle a failure by
 *     deleting their output directory, and a later re-render refuses to start while that directory
 *     exists. A straggler finishing after the delete would recreate it (`synthesizeToFile` creates
 *     its output's parent), leaving an orphan temp file and a collision error on every retry.
 *
 * The failure that propagates is the LOWEST-INDEXED one, not the first to happen, so the error a
 * caller sees does not depend on scheduling and matches what a serial loop would report.
 */
export async function renderClipsBounded<Clip, Out>(
  clips: readonly Clip[],
  render: (clip: Clip, index: number) => Promise<Out>,
): Promise<Out[]> {
  const results = new Array<Out>(clips.length);
  const failures: { index: number; error: unknown }[] = [];
  // These tasks never reject — a failure is recorded and swallowed here — so `Promise.all` settles
  // them all. Rejecting from inside would let the first rejection escape while siblings still hold
  // slots, which is exactly what property 3 above forbids.
  await Promise.all(
    clips.map((clip, index) =>
      withTtsSlot(async () => {
        if (failures.length > 0) return;
        try {
          results[index] = await render(clip, index);
        } catch (error) {
          failures.push({ index, error });
        }
      }),
    ),
  );
  if (failures.length > 0) {
    throw failures.reduce((earliest, candidate) =>
      candidate.index < earliest.index ? candidate : earliest
    ).error;
  }
  return results;
}
