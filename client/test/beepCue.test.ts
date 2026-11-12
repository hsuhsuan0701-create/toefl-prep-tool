import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./fakeTimers";

/**
 * The pre-recording cue gates auto-start on every Speaking Item, in the Drill and the Simulation
 * alike, so the Item sticks on "Get ready…" if the cue's promise ever fails to settle.
 *
 * jsdom has no Web Audio at all, so everything below runs against the hand-rolled fake in this
 * file. It models the one thing the cue's contract depends on: `stop(when)` fires the oscillator's
 * `ended` event at the scheduled time, driven off vitest's fake clock, so a test advances audio
 * time exactly the way it advances the safety-net timeout.
 */

type ParamCall = { method: "setValueAtTime" | "linearRampToValueAtTime"; value: number; time: number };

class FakeParam {
  value = 0;
  readonly calls: ParamCall[] = [];
  setValueAtTime(value: number, time: number) {
    this.calls.push({ method: "setValueAtTime", value, time });
    return this;
  }
  linearRampToValueAtTime(value: number, time: number) {
    this.calls.push({ method: "linearRampToValueAtTime", value, time });
    return this;
  }
}

class FakeOscillator {
  type = "";
  readonly frequency = new FakeParam();
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  connectCount = 0;
  disconnectCount = 0;
  private readonly ctx: FakeAudioContext;
  constructor(ctx: FakeAudioContext) {
    this.ctx = ctx;
  }
  connect() {
    this.connectCount += 1;
  }
  disconnect() {
    this.disconnectCount += 1;
  }
  start(when = 0) {
    this.startedAt = when;
    this.ctx.events.push("start");
  }
  stop(when: number) {
    this.stoppedAt = when;
    // A suspended context's clock does not advance, so a real oscillator scheduled on one never
    // reaches its stop time and never fires `ended` — only the cue's own safety net gets it out.
    if (this.ctx.options.endedNeverFires || this.ctx.state !== "running") return;
    window.setTimeout(() => this.onended?.(), Math.max(0, (when - this.ctx.currentTime) * 1000));
  }
}

class FakeGain {
  readonly gain = new FakeParam();
  connectCount = 0;
  disconnectCount = 0;
  connect() {
    this.connectCount += 1;
  }
  disconnect() {
    this.disconnectCount += 1;
  }
}

type FakeAudioOptions = {
  endedNeverFires?: boolean;
  /** "interrupted" is Safari's non-standard fourth state; see the state field below. */
  initialState?: "running" | "suspended" | "interrupted";
  resumeRejects?: boolean;
  resumeNeverSettles?: boolean;
  constructorThrows?: boolean;
  createOscillatorThrows?: boolean;
};

class FakeAudioContext {
  /**
   * Wider than the DOM's AudioContextState on purpose: Safari reports "interrupted" around
   * audio-session churn, and an interrupted context renders nothing. The oscillator fake's
   * `state !== "running"` gate models that the same way it models "suspended".
   */
  state: "running" | "suspended" | "interrupted" | "closed";
  private readonly openedAtMs = Date.now();
  /**
   * Advances with vitest's fake clock rather than sitting at 0. Sharing one context across Items
   * is what makes `ctx.currentTime` load-bearing: the second beep must schedule where the clock is
   * at that moment, not where it was when the context opened, so a frozen fake would let a stale
   * start time through unseen.
   */
  get currentTime() {
    return (Date.now() - this.openedAtMs) / 1000;
  }
  readonly destination = {};
  readonly oscillators: FakeOscillator[] = [];
  readonly gains: FakeGain[] = [];
  closeCount = 0;
  resumeCount = 0;
  /** Ordering log: a resume that lands after the oscillator starts is a silent first beep. */
  readonly events: string[] = [];
  readonly options: FakeAudioOptions;
  constructor(options: FakeAudioOptions) {
    this.options = options;
    this.state = options.initialState ?? "running";
  }
  createOscillator() {
    if (this.options.createOscillatorThrows) throw new Error("no nodes available");
    const osc = new FakeOscillator(this);
    this.oscillators.push(osc);
    return osc;
  }
  createGain() {
    const gain = new FakeGain();
    this.gains.push(gain);
    return gain;
  }
  resume() {
    this.resumeCount += 1;
    this.events.push("resume");
    if (this.options.resumeNeverSettles) return new Promise<void>(() => {});
    if (this.options.resumeRejects) return Promise.reject(new Error("autoplay policy"));
    this.state = "running";
    return Promise.resolve();
  }
  close() {
    this.closeCount += 1;
    this.state = "closed";
    return Promise.resolve();
  }
}

function installFakeAudio(options: FakeAudioOptions = {}): FakeAudioContext[] {
  const contexts: FakeAudioContext[] = [];
  vi.stubGlobal(
    "AudioContext",
    class {
      constructor() {
        if (options.constructorThrows) throw new Error("too many AudioContexts");
        const ctx = new FakeAudioContext(options);
        contexts.push(ctx);
        return ctx as unknown as FakeAudioContext;
      }
    },
  );
  return contexts;
}

// Imported fresh per test: the module holds process-wide state (one AudioContext for the life of
// the page), and a leaked one would make these tests order-dependent.
async function loadBeepCue() {
  vi.resetModules();
  return await import("../src/components/beepCue");
}

async function loadPlayBeep() {
  return (await loadBeepCue()).playBeep;
}

/** Track settlement without awaiting: every assertion here is about when the promise settles. */
function watch(promise: Promise<void>) {
  const result = { resolved: false, rejected: false };
  promise.then(
    () => {
      result.resolved = true;
    },
    () => {
      result.rejected = true;
    },
  );
  return result;
}

let clock: ReturnType<typeof useFakeTimersInTest>;
beforeEach(() => {
  clock = useFakeTimersInTest();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("playBeep", () => {
  it("resolves only after the tone has finished", async () => {
    installFakeAudio();
    const playBeep = await loadPlayBeep();

    const settled = watch(playBeep(300));
    await clock.advanceBy(299);
    expect(settled.resolved).toBe(false);

    await clock.advanceBy(1);
    expect(settled.resolved).toBe(true);
  });

  it("resolves immediately when Web Audio is unavailable, rather than hanging", async () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    const playBeep = await loadPlayBeep();

    const settled = watch(playBeep(300));
    // No clock advance at all: nothing may be waited on when there is nothing to play.
    await clock.advanceBy(0);
    expect(settled.resolved).toBe(true);
  });

  it("resolves via its own timeout safety net when the oscillator's `ended` event never fires", async () => {
    installFakeAudio({ endedNeverFires: true });
    const playBeep = await loadPlayBeep();

    const settled = watch(playBeep(300));
    await clock.advanceBy(300);
    expect(settled.resolved).toBe(false);

    await clock.advanceBy(200);
    expect(settled.resolved).toBe(true);
  });

  it("never rejects when constructing the AudioContext throws", async () => {
    installFakeAudio({ constructorThrows: true });
    const playBeep = await loadPlayBeep();

    const settled = watch(playBeep(300));
    await clock.advanceBy(500);
    expect(settled).toEqual({ resolved: true, rejected: false });
  });

  it("never rejects when building the audio graph throws mid-setup", async () => {
    installFakeAudio({ createOscillatorThrows: true });
    const playBeep = await loadPlayBeep();

    const settled = watch(playBeep(300));
    await clock.advanceBy(500);
    expect(settled).toEqual({ resolved: true, rejected: false });
  });
});

/**
 * The cue must not click. Two independent causes of a click are guarded here and in the lifecycle
 * tests below: a rectangular gain envelope (a step at each edge, so a click twice per Item), and a
 * fresh AudioContext per Item, which cycles the OS output stream on every Item of a Set.
 *
 * These tests assert the scheduling on purpose: proving the rendered waveform is continuous would
 * need a real Web Audio implementation in tests, which this suite does not pull in.
 */
describe("playBeep envelope", () => {
  it("ramps the gain in and out instead of assigning it", async () => {
    const contexts = installFakeAudio();
    const playBeep = await loadPlayBeep();

    void playBeep(300);
    await clock.advanceBy(0);
    const gain = contexts[0].gains[0];

    expect(gain.gain.calls).toEqual([
      { method: "setValueAtTime", value: 0, time: 0 },
      { method: "linearRampToValueAtTime", value: expect.any(Number), time: 0.005 },
      { method: "setValueAtTime", value: expect.any(Number), time: 0.295 },
      { method: "linearRampToValueAtTime", value: 0, time: 0.3 },
    ]);
    // The peak is reached by the ramp, never by a bare assignment.
    const peak = gain.gain.calls[1].value;
    expect(peak).toBeGreaterThan(0);
    expect(gain.gain.value).not.toBe(peak);
  });

  it("keeps the total audible length at the requested duration", async () => {
    const contexts = installFakeAudio();
    const playBeep = await loadPlayBeep();

    void playBeep(300);
    await clock.advanceBy(0);
    const osc = contexts[0].oscillators[0];

    expect(osc.startedAt).toBe(0);
    expect(osc.stoppedAt).toBeCloseTo(0.3, 4);
  });

  it("resolves no earlier than the end of the release ramp", async () => {
    const contexts = installFakeAudio();
    const playBeep = await loadPlayBeep();

    const settled = watch(playBeep(300));
    await clock.advanceBy(299);
    expect(settled.resolved).toBe(false);

    await clock.advanceBy(1);
    expect(settled.resolved).toBe(true);
    const releaseEnd = contexts[0].gains[0].gain.calls.at(-1)!.time;
    expect(contexts[0].oscillators[0].stoppedAt).toBeGreaterThanOrEqual(releaseEnd);
  });

  it("disconnects this beep's nodes so repeated items do not accumulate them", async () => {
    const contexts = installFakeAudio();
    const playBeep = await loadPlayBeep();

    for (let i = 0; i < 3; i += 1) {
      const settled = watch(playBeep(300));
      await clock.advanceBy(300);
      expect(settled.resolved).toBe(true);
    }

    expect(contexts[0].oscillators).toHaveLength(3);
    expect(contexts[0].oscillators.map((o) => o.disconnectCount)).toEqual([1, 1, 1]);
    expect(contexts[0].gains.map((g) => g.disconnectCount)).toEqual([1, 1, 1]);
  });

  it("schedules each beep at the shared context's CURRENT time, not the time it opened", async () => {
    const contexts = installFakeAudio();
    const playBeep = await loadPlayBeep();

    for (let i = 0; i < 3; i += 1) {
      watch(playBeep(300));
      await clock.advanceBy(300);
    }

    // One context spans the whole page, so a start time captured once would put every beep after
    // the first entirely in the past: full gain at once and stop() already due, which clicks.
    const starts = contexts[0].oscillators.map((o) => o.startedAt!);
    expect(starts[0]).toBeCloseTo(0, 4);
    expect(starts[1]).toBeCloseTo(0.3, 4);
    expect(starts[2]).toBeCloseTo(0.6, 4);
    contexts[0].oscillators.forEach((osc, i) => {
      expect(osc.stoppedAt!).toBeCloseTo(starts[i] + 0.3, 4);
      expect(contexts[0].gains[i].gain.calls[0].time).toBeCloseTo(starts[i], 4);
    });
  });

  it("keeps the envelope points in order even for a duration shorter than the ramps", async () => {
    const contexts = installFakeAudio();
    const playBeep = await loadPlayBeep();

    watch(playBeep(4));
    await clock.advanceBy(0);

    // Web Audio throws if an automation event is scheduled before an earlier one.
    const times = contexts[0].gains[0].gain.calls.map((c) => c.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("playBeep audio context lifecycle", () => {
  it("constructs exactly one AudioContext across consecutive beeps and never closes it", async () => {
    const contexts = installFakeAudio();
    const playBeep = await loadPlayBeep();

    for (let i = 0; i < 7; i += 1) {
      const settled = watch(playBeep(300));
      await clock.advanceBy(300);
      expect(settled.resolved).toBe(true);
    }

    expect(contexts).toHaveLength(1);
    expect(contexts[0].closeCount).toBe(0);
    expect(contexts[0].state).not.toBe("closed");
  });

  it("constructs the context lazily on first use, never at module import", async () => {
    const contexts = installFakeAudio();
    const playBeep = await loadPlayBeep();

    expect(contexts).toHaveLength(0);

    void playBeep(300);
    await clock.advanceBy(0);
    expect(contexts).toHaveLength(1);
  });

  it("resumes a suspended context BEFORE starting the tone, so the first item is audible", async () => {
    const contexts = installFakeAudio({ initialState: "suspended" });
    const playBeep = await loadPlayBeep();

    const settled = watch(playBeep(300));
    await clock.advanceBy(300);

    expect(contexts[0].resumeCount).toBe(1);
    expect(contexts[0].events).toEqual(["resume", "start"]);
    expect(contexts[0].oscillators[0].startedAt).not.toBeNull();
    expect(settled.resolved).toBe(true);
  });

  it("still resolves when resume() rejects — a silent beep must not hang the Item", async () => {
    const contexts = installFakeAudio({ initialState: "suspended", resumeRejects: true });
    const playBeep = await loadPlayBeep();

    const settled = watch(playBeep(300));
    await clock.advanceBy(0);

    expect(contexts[0].resumeCount).toBe(1);
    // Resolved on the rejection itself, not by waiting out the safety net: a rejected resume means
    // a context that cannot make sound, so there is nothing to wait for.
    expect(settled).toEqual({ resolved: true, rejected: false });
    expect(contexts[0].oscillators).toHaveLength(0);
  });

  it("still resolves when resume() never settles at all", async () => {
    // Chrome can leave resume() pending indefinitely on a backgrounded page. An unbounded wait
    // would hold every Item on "Get ready…" for good, with no recorder ever started.
    const contexts = installFakeAudio({ initialState: "suspended", resumeNeverSettles: true });
    const playBeep = await loadPlayBeep();

    const settled = watch(playBeep(300));
    await clock.advanceBy(1000);

    expect(settled).toEqual({ resolved: true, rejected: false });
    expect(contexts[0].oscillators).toHaveLength(0);
  });

  it("recovers on later Items after a rejected resume, without stalling each one", async () => {
    const contexts = installFakeAudio({ initialState: "suspended", resumeRejects: true });
    const playBeep = await loadPlayBeep();

    for (let i = 0; i < 3; i += 1) {
      const settled = watch(playBeep(300));
      await clock.advanceBy(0);
      expect(settled.resolved).toBe(true);
    }

    // Still one context, and each Item retries the resume rather than giving up on the cue for good.
    expect(contexts).toHaveLength(1);
    expect(contexts[0].resumeCount).toBe(3);
  });

  it("rebuilds the context if the browser closed it out from under us", async () => {
    const contexts = installFakeAudio();
    const playBeep = await loadPlayBeep();

    const first = watch(playBeep(300));
    await clock.advanceBy(300);
    expect(first.resolved).toBe(true);

    // Nothing here closes a context, but a UA may reclaim one under resource pressure — every
    // later call on it throws, so a beep that kept using it would be silent for the rest of the
    // page's life.
    contexts[0].state = "closed";

    const second = watch(playBeep(300));
    await clock.advanceBy(300);
    expect(second.resolved).toBe(true);
    expect(contexts).toHaveLength(2);
  });
});

/**
 * Safari has a non-standard "interrupted" AudioContextState, entered around audio-session churn
 * (this Task Type starts and stops getUserMedia capture on every Item). An interrupted context
 * renders nothing, so it is resumed like a suspended one; a tone scheduled on it unwoken would
 * vanish silently and the promise would settle only through the safety net.
 */
describe("playBeep on Safari's interrupted context", () => {
  it("resumes an 'interrupted' context BEFORE scheduling, exactly like a suspended one", async () => {
    const contexts = installFakeAudio({ initialState: "interrupted" });
    const playBeep = await loadPlayBeep();

    const settled = watch(playBeep(300));
    await clock.advanceBy(300);

    expect(contexts[0].resumeCount).toBe(1);
    expect(contexts[0].events).toEqual(["resume", "start"]);
    expect(settled.resolved).toBe(true);
  });

  it("skips the beep within the bounded window when the interrupted context's resume never settles", async () => {
    // Safari queues a non-gesture resume() until the interruption ends, which may be never.
    // Nothing is scheduled (it would fire late, over the recording, if the browser resumed the
    // context after the cue gave up), and the Item moves on at the resume bound.
    const contexts = installFakeAudio({ initialState: "interrupted", resumeNeverSettles: true });
    const playBeep = await loadPlayBeep();

    const settled = watch(playBeep(300));
    await clock.advanceBy(199);
    expect(settled.resolved).toBe(false);

    await clock.advanceBy(1);
    expect(settled).toEqual({ resolved: true, rejected: false });
    expect(contexts[0].oscillators).toHaveLength(0);
  });

  it("still resolves, scheduling nothing, when the interrupted context's resume rejects", async () => {
    const contexts = installFakeAudio({ initialState: "interrupted", resumeRejects: true });
    const playBeep = await loadPlayBeep();

    const settled = watch(playBeep(300));
    await clock.advanceBy(0);

    expect(settled).toEqual({ resolved: true, rejected: false });
    expect(contexts[0].oscillators).toHaveLength(0);
  });
});

/**
 * The beep fires from a Stimulus's `ended` event, which Safari does not treat as gesture-derived:
 * it rejects or slow-walks a resume() there, so once the shared context is suspended the bounded
 * resume gives up and skips the cue. armBeepCue() is called from the click that starts each
 * Speaking Drill and Simulation, creating and waking the context inside a gesture chain Safari
 * honors. It is fire-and-forget from a gesture handler, so every path must resolve: never reject,
 * never block past the resume bound.
 */
describe("armBeepCue", () => {
  it("creates the shared context and resumes it inside the calling gesture", async () => {
    const contexts = installFakeAudio({ initialState: "suspended" });
    const { armBeepCue } = await loadBeepCue();

    const settled = watch(armBeepCue());
    await clock.advanceBy(0);

    expect(contexts).toHaveLength(1);
    expect(contexts[0].resumeCount).toBe(1);
    expect(contexts[0].state).toBe("running");
    expect(settled).toEqual({ resolved: true, rejected: false });
  });

  it("wakes an interrupted context too", async () => {
    const contexts = installFakeAudio({ initialState: "interrupted" });
    const { armBeepCue } = await loadBeepCue();

    const settled = watch(armBeepCue());
    await clock.advanceBy(0);

    expect(contexts[0].resumeCount).toBe(1);
    expect(contexts[0].state).toBe("running");
    expect(settled.resolved).toBe(true);
  });

  it("arms the SAME context the beeps then play on — one context per page, still", async () => {
    const contexts = installFakeAudio({ initialState: "suspended" });
    const { armBeepCue, playBeep } = await loadBeepCue();

    watch(armBeepCue());
    await clock.advanceBy(0);
    const settled = watch(playBeep(300));
    await clock.advanceBy(300);

    expect(contexts).toHaveLength(1);
    // The arm already woke it, so the beep needed no resume of its own.
    expect(contexts[0].resumeCount).toBe(1);
    expect(settled.resolved).toBe(true);
  });

  it("does not call resume() on a context that is already running", async () => {
    const contexts = installFakeAudio();
    const { armBeepCue } = await loadBeepCue();

    const settled = watch(armBeepCue());
    await clock.advanceBy(0);

    expect(contexts[0].resumeCount).toBe(0);
    expect(settled.resolved).toBe(true);
  });

  it("resolves immediately when Web Audio is unavailable", async () => {
    vi.stubGlobal("AudioContext", undefined);
    vi.stubGlobal("webkitAudioContext", undefined);
    const { armBeepCue } = await loadBeepCue();

    const settled = watch(armBeepCue());
    await clock.advanceBy(0);
    expect(settled).toEqual({ resolved: true, rejected: false });
  });

  it("never rejects when constructing the AudioContext throws", async () => {
    installFakeAudio({ constructorThrows: true });
    const { armBeepCue } = await loadBeepCue();

    const settled = watch(armBeepCue());
    await clock.advanceBy(0);
    expect(settled).toEqual({ resolved: true, rejected: false });
  });

  it("settles within the resume bound when resume() never settles — it must not block the flow", async () => {
    installFakeAudio({ initialState: "suspended", resumeNeverSettles: true });
    const { armBeepCue } = await loadBeepCue();

    const settled = watch(armBeepCue());
    await clock.advanceBy(199);
    expect(settled.resolved).toBe(false);

    await clock.advanceBy(1);
    expect(settled).toEqual({ resolved: true, rejected: false });
  });

  it("never rejects when resume() rejects", async () => {
    installFakeAudio({ initialState: "suspended", resumeRejects: true });
    const { armBeepCue } = await loadBeepCue();

    const settled = watch(armBeepCue());
    await clock.advanceBy(0);
    expect(settled).toEqual({ resolved: true, rejected: false });
  });
});
