import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import { IconCaution, IconCheck } from "./icons";

// The Listening stage (who is speaking, and where), and AudioStatus, where any play-once clip in the
// app has got (components/StimulusPlayer draws it, for Speaking prompts too). Ink on paper, like
// every exam screen: the one moving thing is a slow pulse while the audio plays, which reduced
// motion switches off along with every other animation.

type AudioStageProps = HTMLAttributes<HTMLDivElement> & {
  /** Where the Stimulus takes place, or an academic talk's discipline. A string is shown in sentence case. */
  setting?: ReactNode;
  /** The SpeakerFigures. */
  children: ReactNode;
};

/**
 * The card a Listening Stimulus is heard against: its speakers side by side, then the setting. It
 * carries no Item content and has nothing to press, so it can stand on screen through the whole
 * play-once beat without leaking anything or inviting a replay.
 */
export function AudioStage({ setting, children, className, ...rest }: AudioStageProps) {
  return (
    <div className={cx("rounded-sheet border border-rule bg-sheet px-5 py-6 sm:px-8", className)} {...rest}>
      <div className="flex flex-wrap items-start justify-center gap-x-12 gap-y-5">{children}</div>
      {setting && <p className="mt-5 text-center text-meta text-graphite">{typeof setting === "string" ? sentenceCase(setting) : setting}</p>}
    </div>
  );
}

type SpeakerFigureProps = HTMLAttributes<HTMLElement> & {
  /** The speaker's role, as served ("resident advisor"). Shown in sentence case. */
  role: string;
  /** The speaker's accent, as served ("north-american"). Shown in words ("North American"). */
  accent: string;
  /** Picks the silhouette's outline only. Never printed. */
  gender: "male" | "female";
};

/** One speaker on the stage: a silhouette in a ruled circle, their role, and their accent. */
export function SpeakerFigure({ role, accent, gender, className, ...rest }: SpeakerFigureProps) {
  return (
    <figure className={cx("flex w-32 flex-col items-center gap-2 text-center", className)} {...rest}>
      <span className="flex h-16 w-16 items-center justify-center rounded-full border border-rule-strong bg-well text-ink-soft">
        {gender === "female" ? <FemaleSilhouette /> : <MaleSilhouette />}
      </span>
      <figcaption className="leading-tight">
        <span className="block text-ui font-medium text-ink">{sentenceCase(role)}</span>
        <span className="mt-0.5 block text-meta text-graphite">{accentWords(accent)}</span>
      </figcaption>
    </figure>
  );
}

export type AudioState = "playing" | "done" | "failed";

/**
 * Where a play-once clip has got, in words with a glyph: "Listen…" with a slow pulse while it plays,
 * then "Playback finished." or "Couldn't play the audio." Announced politely as it changes.
 */
export function AudioStatus({ state }: { state: AudioState }) {
  return (
    <div className="flex items-center justify-center gap-2.5 py-3">
      <span
        aria-hidden="true"
        className={cx(
          "flex h-8 w-8 items-center justify-center rounded-full border",
          state === "failed" ? "border-caution-rule bg-caution-wash text-caution" : "border-rule-strong bg-sheet text-ink-soft",
          state === "playing" && "animate-pulse",
        )}
      >
        {state === "playing" ? <SpeakerGlyph /> : state === "done" ? <IconCheck size={14} /> : <IconCaution size={14} />}
      </span>
      <p role="status" aria-live="polite" className={cx("text-ui", state === "failed" ? "text-caution" : "text-ink-soft")}>
        {state === "failed" ? "Couldn't play the audio." : state === "playing" ? "Listen…" : "Playback finished."}
      </p>
    </div>
  );
}

function sentenceCase(text: string): string {
  const t = text.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** "north-american" → "North American". */
function accentWords(accent: string): string {
  return accent
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function SpeakerGlyph() {
  return (
    <svg viewBox="0 0 16 16" width={14} height={14} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M7.25 3.5L4.25 6H2v4h2.25l3 2.5z" />
      <path d="M10.25 6a3 3 0 010 4M12.25 4a6 6 0 010 8" />
    </svg>
  );
}

// Short hair, square shoulders.
function MaleSilhouette() {
  return (
    <svg viewBox="0 0 24 24" className="h-10 w-10" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="12" cy="8" r="4.5" />
      <path d="M4 21c0-5.5 3.5-9 8-9s8 3.5 8 9v1H4v-1Z" />
    </svg>
  );
}

// Longer hair (wider above the shoulders), rounded shoulders.
function FemaleSilhouette() {
  return (
    <svg viewBox="0 0 24 24" className="h-10 w-10" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M12 2.5c-3.6 0-6 2.7-6 6.2 0 1.9.7 3.6 1.9 4.9-.4.5-1 .9-1.7 1.1C3.5 15.7 2 18.1 2 21v1h20v-1c0-2.9-1.5-5.3-4.2-6.3-.7-.2-1.3-.6-1.7-1.1 1.2-1.3 1.9-3 1.9-4.9 0-3.5-2.4-6.2-6-6.2Z" />
    </svg>
  );
}
