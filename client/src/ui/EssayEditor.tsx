import { useEffect, useRef, useState, type TextareaHTMLAttributes } from "react";
import { cx } from "./cx";
import { IconCheck, IconDash } from "./icons";
import { wordGuideStatus, wordGuideText, type WordGuide, type WordGuideStatus } from "./wordCount";

// The essay editor's two parts: the field the User writes a Response in, and the live word count
// against the Task's guidance. The Task clock is the shell's ExamClock (ExamShell.tsx), not part of
// this file. Used by TimedEditor for Write an Email and Academic Discussion.

type EssayFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "className"> & {
  value: string;
  onChange: (next: string) => void;
  className?: string;
};

/**
 * The writing field for an essay Response. A `field` surface with a strong rule, prose-sized type,
 * and the global focus ring. Spelling and grammar help are switched off, as on the test: the editor
 * there has no spell check, and practising with one hides exactly the errors a Judge deducts for.
 *
 * Give it an accessible name (`aria-label` or `aria-labelledby`); it renders no label of its own.
 */
export function EssayField({ value, onChange, className, ...rest }: EssayFieldProps) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="sentences"
      className={cx(
        "block min-h-72 w-full resize-y rounded-control border border-rule-strong bg-field px-4 py-3 text-prose text-ink placeholder:text-faint",
        "transition-colors duration-(--duration-quick) ease-quiet hover:border-graphite",
        className,
      )}
      {...rest}
    />
  );
}

const STATUS_WORDS: Record<WordGuideStatus, string> = {
  below: "below the guide",
  within: "within the guide",
  over: "over the guide",
};

/**
 * The live word count against the Task's guidance: "86 words · within 80–120". Ink only — an exam
 * screen gets no colour but the clock — so the state is carried by the words and a glyph (a check
 * inside the guide, a dash outside it).
 *
 * The count changes on every keystroke and is not announced each time. A polite live region says
 * only when the count crosses into or out of the guide, once per crossing.
 */
export function WordCount({ count, guide, className }: { count: number; guide: WordGuide; className?: string }) {
  const status = wordGuideStatus(count, guide);
  // The range without its unit, which the count beside it already says: "53 short of 80–120".
  const range = wordGuideText(guide).replace(/ words$/, "");
  const detail =
    status === "below"
      ? `${guide.min - count} short of ${range}`
      : status === "over"
        ? `${count - (guide.max ?? count)} over ${range}`
        : `within ${range}`;

  // Announce a crossing, not a count: the first render (and a count that stays on the same side of
  // the guide) says nothing.
  const [announcement, setAnnouncement] = useState("");
  const lastStatusRef = useRef(status);
  useEffect(() => {
    if (lastStatusRef.current === status) return;
    lastStatusRef.current = status;
    setAnnouncement(`${count} words, ${STATUS_WORDS[status]}.`);
  }, [status, count]);

  return (
    <div className={cx("flex min-w-0 items-center gap-2 text-ui text-ink-soft", className)}>
      <span className="shrink-0 text-graphite">{status === "within" ? <IconCheck size={14} /> : <IconDash size={14} />}</span>
      {/* Wraps rather than truncates: beside Submit on a phone the line runs out of room, and the
          part it would lose is the range. The detail stays whole, so a wrap falls before its "·"
          and never inside "80–120". */}
      <p className="figures min-w-0">
        <span className="font-semibold text-ink">{count}</span> {count === 1 ? "word" : "words"}{" "}
        <span className="whitespace-nowrap text-graphite">· {detail}</span>
      </p>
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}
