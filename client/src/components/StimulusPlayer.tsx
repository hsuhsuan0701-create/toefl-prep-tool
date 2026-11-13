import { useEffect, useRef, useState } from "react";
import { AudioStatus } from "../ui/AudioStage";

type StimulusPlayerProps = {
  src: string;
  onEnded: () => void;
  // Called instead of onEnded when playback fails to load or play (browsers report a failed load and
  // a playback error through the same `error` event or `play()` rejection). Omitted, a failure calls
  // onEnded: right for an intro clip whose text is also on screen, never for a Stimulus or an Item
  // prompt, whose callers always pass it.
  onError?: () => void;
};

type Phase = "playing" | "done" | "error";

/**
 * How long a clip may take to start before its load counts as failed. A request that is neither
 * answered nor failed (a hung or suspended server) fires no `error` and never settles `play()`, so
 * without a bound "Listen…" would stay up for as long as it lasts, with nothing to retry. The clips
 * are local files served over loopback and start in well under a second, so this is generous on a
 * slow first load; it stops counting once playback begins, so a playing clip is never cut short.
 */
export const START_TIMEOUT_MS = 15_000;

/**
 * Plays `src` exactly once on mount: autoplays, no `<audio controls>` (so there's nothing to click
 * to replay), calls `onEnded` when playback finishes, or `onError` (falling back to `onEnded`) when
 * it fails. A parent advances to a new clip, or retries a failed one, by giving this a new `key`;
 * a changed `src` on the same instance never replays.
 *
 * React StrictMode runs effects mount -> cleanup -> mount in dev. The `played` ref makes the second
 * mount a no-op, and the cleanup does not tear the Audio element down, which would cut the clip off
 * before `ended` fires for the mount that follows. A real unmount (the User left the page) is told
 * apart by deferring the pause one task: by then StrictMode has mounted again, a real unmount has
 * not, and only the clip of a page that is gone is stopped.
 *
 * `finish()` is one-shot: browsers commonly reject `play()` and also fire `error` for the same
 * failed load, and four paths can reach it (the start bound, START_TIMEOUT_MS, is the fourth). It
 * also does nothing once unmounted, so a late `ended` from an orphaned element cannot advance a
 * stage the User already left.
 */
export default function StimulusPlayer({ src, onEnded, onError }: StimulusPlayerProps) {
  const playedRef = useRef(false);
  const finishedRef = useRef(false);
  const mountedRef = useRef(true);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const onEndedRef = useRef(onEnded);
  const onErrorRef = useRef(onError);
  const [phase, setPhase] = useState<Phase>("playing");

  onEndedRef.current = onEnded;
  onErrorRef.current = onError;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      setTimeout(() => {
        if (!mountedRef.current) audioRef.current?.pause();
      }, 0);
    };
  }, []);

  useEffect(() => {
    if (playedRef.current) return;
    playedRef.current = true;

    const audio = new Audio(src);
    audioRef.current = audio;
    const finish = (nextPhase: Exclude<Phase, "playing">) => {
      if (finishedRef.current) return;
      finishedRef.current = true;
      if (!mountedRef.current) return;
      setPhase(nextPhase);
      if (nextPhase === "error" && onErrorRef.current) {
        onErrorRef.current();
      } else {
        onEndedRef.current();
      }
    };
    // Not cleared by the effect's cleanup, for the same StrictMode reason the element is kept: the
    // second mount is a no-op and arms nothing. A real unmount is covered by `finish` doing nothing
    // once unmounted, and by the check below.
    let startTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
      startTimer = undefined;
      if (finishedRef.current || !mountedRef.current) return;
      // Give the held request up, so this element can never start playing over the retry or the gate.
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      finish("error");
    }, START_TIMEOUT_MS);
    // Playback has begun: `play()` resolves exactly when it does, and `playing` says so too.
    const started = () => {
      if (startTimer !== undefined) clearTimeout(startTimer);
      startTimer = undefined;
    };
    audio.addEventListener("playing", started);
    audio.addEventListener("ended", () => finish("done"));
    audio.addEventListener("error", () => finish("error"));
    void audio.play().then(started, () => finish("error"));
  }, [src]);

  return <AudioStatus state={phase === "error" ? "failed" : phase} />;
}
