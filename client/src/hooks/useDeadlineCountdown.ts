import { useEffect, useRef, useState } from "react";

const TICK_MS = 200;

function secondsUntil(deadlineMs: number): number {
  return Math.max(0, (deadlineMs - Date.now()) / 1000);
}

/**
 * The seconds left until `deadlineMs` (epoch ms), re-read from the wall clock every 200 ms, and
 * `onExpire` called exactly once when they reach zero. The app's one exam countdown: every clock
 * drawn with `ExamClock` runs on it (a Reading Module through DeadlineClock, the Build a Sentence
 * budget, the essay Tasks). A Speaking response window is not a deadline and is not timed here: it
 * runs from the moment recording starts (ResponseCountdown).
 *
 * Wall-clock on purpose. A deadline measured as "elapsed since mount" stops while a laptop sleeps
 * and hands that time back; read against `Date.now()`, the time is gone as it would be on the test.
 * Nothing pauses it. The caller fixes `deadlineMs` once per Task and keeps it stable; a new deadline
 * re-arms the countdown and its one expiry.
 *
 * Returns whole seconds, rounded up, so the display reads 0:01 until the instant it expires.
 */
export function useDeadlineCountdown(deadlineMs: number, onExpire: () => void): number {
  const [remaining, setRemaining] = useState(() => secondsUntil(deadlineMs));
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;
  // Which deadline has already expired. A ref rather than a variable in the effect, so StrictMode's
  // second run of the effect does not expire the same deadline twice.
  const expiredRef = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const next = secondsUntil(deadlineMs);
      setRemaining(next);
      if (next <= 0 && expiredRef.current !== deadlineMs) {
        expiredRef.current = deadlineMs;
        onExpireRef.current();
      }
    };
    tick();
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [deadlineMs]);

  return Math.ceil(remaining);
}
