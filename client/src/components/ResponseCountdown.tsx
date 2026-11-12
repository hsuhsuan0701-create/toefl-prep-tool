import { useEffect, useRef, useState } from "react";
import { ResponseClock } from "../ui/Recording";

type ResponseCountdownProps = {
  seconds: number;
  onExpire: () => void;
};

/**
 * A Speaking Item's response window (8–12 s for Listen and Repeat, 45 s for an Interview answer),
 * drawn as ResponseClock. Fires `onExpire` exactly once; the caller keys it to restart it.
 *
 * Measured from this component's own mount with performance.now(), not against the wall clock: a
 * window this short only runs while the User is speaking at the screen, and it mounts when the
 * recording starts, so mount is the right zero.
 */
export default function ResponseCountdown({ seconds, onExpire }: ResponseCountdownProps) {
  const [remaining, setRemaining] = useState(seconds);
  const firedRef = useRef(false);
  const onExpireRef = useRef(onExpire);
  const startRef = useRef<number | null>(null);

  onExpireRef.current = onExpire;

  useEffect(() => {
    startRef.current ??= performance.now();
    const startMs = startRef.current;
    const tick = () => {
      const elapsedMs = performance.now() - startMs;
      const next = Math.max(0, seconds - elapsedMs / 1000);
      setRemaining(next);
      if (next <= 0 && !firedRef.current) {
        firedRef.current = true;
        onExpireRef.current();
      }
    };
    tick();
    const id = setInterval(tick, 100);
    return () => clearInterval(id);
  }, [seconds]);

  return <ResponseClock secondsLeft={remaining} totalSeconds={seconds} />;
}
