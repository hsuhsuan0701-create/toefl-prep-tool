const BEEP_HZ = 880;
const PEAK_GAIN = 0.15;
/** Attack and release. Long enough to kill the click, short enough to still read as a blip. */
const RAMP_SEC = 0.005;
/** Grace beyond the tone itself, for browsers that don't reliably fire `ended`. */
const SAFETY_NET_MS = 200;
/** How long a resume() gets to answer before the Item goes on without a cue. */
const RESUME_TIMEOUT_MS = 200;

/**
 * One AudioContext for the life of the page, built on first use.
 *
 * Not one per Item: constructing and closing a context asks the OS for a new output stream and
 * tears it down again, eleven times per Speaking Set (seven Listen and Repeat Items, four Interview
 * questions). On macOS that cycles the amp, audibly on external DACs and Bluetooth, and wakes an
 * output device that had idled. The response windows between beeps (8–12 s for Listen and Repeat,
 * 45 s for the Interview) are close to the interval a device idles down over, so a per-Item
 * context pops on some beeps and not others.
 *
 * Not at module import either: under autoplay policy a context constructed outside a
 * gesture-derived call chain starts `suspended`, and Safari may reject a `resume()` that is not tied
 * to a user gesture, which would leave the beep, the only cue that recording is about to start,
 * silent for good. `armBeepCue()` below builds and wakes the context inside the click that starts
 * the Speaking run, because Safari does not count the later chain (stimulus autoplays, `ended`,
 * beep) as a gesture at all.
 */
let sharedContext: AudioContext | null = null;

function sharedAudioContext(): AudioContext | null {
  // A UA may reclaim a context under resource pressure; every later call on a closed one throws,
  // so a beep that kept using it would be silent for the rest of the page's life.
  if (sharedContext && sharedContext.state !== "closed") return sharedContext;
  const AudioContextCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return null;
  try {
    sharedContext = new AudioContextCtor();
  } catch {
    // Resource exhaustion, a locked-down embed: silence beats a wedged Item.
    return null;
  }
  return sharedContext;
}

/**
 * Resolves true once the context can actually make sound, false if it can't be woken.
 *
 * The gate is "anything but `running`", not "`suspended`": Safari has a non-standard fourth
 * AudioContextState, `"interrupted"`, entered around audio-session churn, which this Task Type
 * produces by starting and stopping getUserMedia capture on every Item. An interrupted context
 * renders nothing, so a gate on `suspended` alone would schedule an inaudible tone on it and the
 * beep would vanish. TypeScript's AudioContextState union does not include `"interrupted"`, which is
 * why this compares against the one state that means "rendering" instead of enumerating the ones
 * that don't.
 *
 * The wait is bounded because both failure modes here are silent for good: Safari rejects a
 * resume() that isn't gesture-derived, and Chrome can leave one pending indefinitely while the page
 * is backgrounded. A suspended context produces no sound either way, so there is nothing worth
 * waiting on, and the caller is holding an Item on "Get ready…" until this settles.
 */
function resumeIfNotRunning(ctx: AudioContext): Promise<boolean> {
  if (ctx.state === "running") return Promise.resolve(true);
  return new Promise((resolve) => {
    const bail = window.setTimeout(() => resolve(false), RESUME_TIMEOUT_MS);
    const settle = (ok: boolean) => {
      window.clearTimeout(bail);
      resolve(ok);
    };
    try {
      ctx.resume().then(
        () => settle(true),
        () => settle(false),
      );
    } catch {
      // A UA that throws synchronously from resume() (e.g. on a context it just reclaimed) is a
      // context that cannot make sound — same answer as a rejection.
      settle(false);
    }
  });
}

/**
 * Builds the shared context if needed and attempts the same bounded resume the beep itself uses.
 * Call it from a real user gesture, so the context is created and woken inside the gesture chain:
 * the Speaking Drill and Simulation call it from the click that starts the run.
 *
 * The beep fires from a stimulus `ended` event, which Safari does not treat as gesture-derived: it
 * rejects or slow-walks a resume() there, so a context that is suspended (or interrupted, see
 * resumeIfNotRunning) by then stays silent and the bounded resume skips the cue. Safe to call
 * without awaiting: every path resolves, and nothing here may throw into, or block, the gesture
 * handler that calls it.
 */
export async function armBeepCue(): Promise<void> {
  const ctx = sharedAudioContext();
  if (!ctx) return;
  await resumeIfNotRunning(ctx);
}

/**
 * A ~300 ms Web Audio beep (sine, 880 Hz) marking "recording is about to start". Resolves once the
 * tone finishes, so the caller can start the recorder right after. Resolves at once if there is no
 * AudioContext, and carries its own timeout in case a browser does not fire the oscillator's
 * `ended` event: this gates the recording on every Speaking Item, in the Drill and the Simulation
 * alike, so it must never hang either one.
 *
 * It lives in its own module, not inside ItemRecorder.tsx, so client/test/beepCue.test.ts can pin
 * this contract against a fake Web Audio without rendering a component that needs a microphone.
 *
 * Every failure path resolves rather than rejecting: a caller that awaits this to decide when to
 * start recording has nothing useful to do with a rejection, and an unhandled one would leave the
 * Item stuck on "Get ready…" forever.
 */
export async function playBeep(durationMs = 300): Promise<void> {
  const ctx = sharedAudioContext();
  if (!ctx) return;
  // Nothing is scheduled on a context that couldn't be woken: it would be inaudible now and could
  // fire late, over the recording, if the browser resumed it after we gave up.
  if (!(await resumeIfNotRunning(ctx))) return;
  return new Promise((resolve) => {
    let settled = false;
    let osc: OscillatorNode | undefined;
    let gain: GainNode | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        // The context stays open (see above); this beep's nodes do not, or a page's worth of Items
        // would pile up on the destination.
        osc?.disconnect();
        gain?.disconnect();
      } catch {
        // Already torn down by the browser — nothing to do.
      }
      resolve();
    };
    try {
      const startAt = ctx.currentTime;
      const endAt = startAt + durationMs / 1000;
      // Clamped so the four envelope points stay in order — Web Audio throws if an automation
      // event is scheduled before an earlier one.
      const attackEnd = Math.min(startAt + RAMP_SEC, endAt);
      const releaseStart = Math.max(endAt - RAMP_SEC, attackEnd);
      osc = ctx.createOscillator();
      gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = BEEP_HZ;
      // A sine switched on at full gain and stopped at an arbitrary phase is a step
      // discontinuity at each edge — a broadband transient, i.e. a click, twice per Item. Fading in
      // and out over a few milliseconds removes it without shortening the audible tone.
      gain.gain.setValueAtTime(0, startAt);
      gain.gain.linearRampToValueAtTime(PEAK_GAIN, attackEnd);
      gain.gain.setValueAtTime(PEAK_GAIN, releaseStart);
      gain.gain.linearRampToValueAtTime(0, endAt);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.onended = finish;
      osc.start(startAt);
      // Stopping at the end of the release ramp is what makes the promise settle no earlier than
      // the tone is actually over.
      osc.stop(endAt);
      window.setTimeout(finish, durationMs + SAFETY_NET_MS);
    } catch {
      finish();
    }
  });
}
