import { cx } from "./cx";

// The recording controls' visual parts, for the mic check and every Speaking Item (ItemRecorder,
// MicCheck, the Drill Lab's blind reps). Presentation only: what records, and when, is the caller's.
//
// Recording is shown in the accent, with the word "Recording" and a slow pulsing ring — never with a
// red dot. In this system red means a fault (`critical`), and a User mid-answer must not read their
// own recording as an error. With reduced motion the ring holds still; the word stays.

/**
 * "Recording", with a pulsing accent ring. `label` replaces the word where the context says more
 * ("Recording — say something"); keep "Recording" in it.
 */
export function RecordingIndicator({ label = "Recording", className }: { label?: string; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2 text-ui font-semibold text-accent", className)}>
      <span aria-hidden="true" className="relative inline-flex h-3 w-3 shrink-0">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-50 [animation-duration:1.6s]" />
        <span className="relative inline-flex h-3 w-3 rounded-full bg-accent" />
      </span>
      {label}
    </span>
  );
}

/** At or above this level the meter reads as hearing speech. Below it, as quiet. */
export const LEVEL_SPEECH_THRESHOLD = 0.08;

/**
 * The live microphone level, 0–1: a bar on a `well` track, and the reading in words beside it
 * ("Hearing you" / "Quiet") so it never rests on the bar alone. role="meter" with its value; it is
 * not a live region, because a level that changes sixty times a second must not be read out.
 */
export function LevelMeter({ level, label = "Microphone level" }: { level: number; label?: string }) {
  const value = Math.round(Math.max(0, Math.min(1, level)) * 100);
  const hearing = level >= LEVEL_SPEECH_THRESHOLD;
  return (
    <div className="flex items-center gap-3">
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        aria-valuetext={hearing ? `${value}%, hearing you` : `${value}%, quiet`}
        className="h-2.5 flex-1 overflow-hidden rounded-full bg-well"
      >
        <div
          className={cx("h-full rounded-full transition-[width] duration-75 ease-out", hearing ? "bg-accent" : "bg-rule-strong")}
          style={{ width: `${value}%` }}
        />
      </div>
      <span className="w-24 shrink-0 text-meta text-graphite">{hearing ? "Hearing you" : "Quiet"}</span>
    </div>
  );
}

/**
 * The response window, counting down: a bar draining on a `well` track in `ink-soft`, and the
 * seconds left in tabular figures. role="timer", named with the seconds left, and not a live region:
 * a screen reader that announced every second would talk over the User's answer.
 */
export function ResponseClock({ secondsLeft, totalSeconds, className }: { secondsLeft: number; totalSeconds: number; className?: string }) {
  const secs = Math.max(0, Math.ceil(secondsLeft));
  const fraction = totalSeconds > 0 ? Math.min(1, Math.max(0, secondsLeft / totalSeconds)) : 0;
  return (
    <div className={cx("flex w-full items-center gap-4", className)}>
      <div aria-hidden="true" className="h-1.5 flex-1 overflow-hidden rounded-full bg-well">
        <div className="h-full rounded-full bg-ink-soft transition-[width] duration-150 ease-linear" style={{ width: `${fraction * 100}%` }} />
      </div>
      <span role="timer" aria-label={`${secs} seconds remaining`} className="figures w-14 shrink-0 text-right text-clock font-semibold text-ink">
        {secs} s
      </span>
    </div>
  );
}
