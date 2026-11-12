import type { ReactNode } from "react";
import { cx } from "./cx";
import { Kicker } from "./Heading";
import { Prose } from "./Prose";

type ExamSplitProps = {
  /** The text the question is answered against: a PassagePane. */
  passage: ReactNode;
  /** The question(s), their options and anything that acts on them. */
  children: ReactNode;
  className?: string;
};

/**
 * The two panes of a reading exam screen (docs/design-system.md, "Exam screens"): the text on the
 * left and the question on the right from `lg` up, a hairline between them; on a phone the text comes
 * first and the question follows it. Neither pane scrolls on its own — the page scrolls, so nothing
 * is trapped in a box a thumb cannot reach.
 */
export function ExamSplit({ passage, children, className }: ExamSplitProps) {
  return (
    <div className={cx("grid gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-12", className)}>
      <div className="min-w-0">{passage}</div>
      <div className="min-w-0 border-t border-rule pt-6 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-12">{children}</div>
    </div>
  );
}

type PassagePaneProps = {
  /** What kind of text this is, in small capitals: "Notice", "Email", "Biology". English only. */
  label?: ReactNode;
  /** The text's own title, when it has one (an academic passage). */
  title?: ReactNode;
  /** The text itself, exactly as served. */
  text: string;
  /**
   * Keep the text's own line breaks — a notice, an email, a receipt. Lines still wrap, and a long
   * unbroken run (a receipt's dot leaders) breaks anywhere rather than pushing the page sideways.
   */
  preserveLines?: boolean;
  className?: string;
};

/**
 * A Stimulus's text as the exam prints it: a small label, an optional title, then the text in the
 * Stimulus type size at a readable measure. Paragraph breaks in the text (a blank line) become
 * paragraphs.
 */
export function PassagePane({ label, title, text, preserveLines, className }: PassagePaneProps) {
  const paragraphs = preserveLines ? [text] : text.split(/\n\s*\n/).filter((p) => p.trim() !== "");
  return (
    <article className={cx("min-w-0", className)}>
      {label && <Kicker as="p">{label}</Kicker>}
      {title && <h2 className={cx("text-heading font-semibold text-ink text-balance", label ? "mt-1" : null)}>{title}</h2>}
      <Prose
        size="stimulus"
        preserveLines={preserveLines}
        className={cx("space-y-4 wrap-anywhere", label || title ? "mt-3" : null)}
      >
        {paragraphs.map((p, i) => (
          <p key={i}>{p}</p>
        ))}
      </Prose>
    </article>
  );
}
