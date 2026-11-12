import type { ReactNode } from "react";
import { cx } from "./cx";
import { markQuotes, type QuoteMark } from "./markQuotes";

type ProseLang = "en" | "zh-Hant";
type ProseSize = "body" | "prose" | "stimulus";

const SIZE: Record<ProseSize, string> = {
  body: "text-body",
  prose: "text-prose",
  stimulus: "text-stimulus",
};

type ProseProps = {
  /**
   * The language of the text. `zh-Hant` for every piece of Traditional Chinese feedback — Score
   * Report summaries, Explanations (錯題解析), coaching. It sets the lang attribute, which picks
   * Traditional glyph forms, the CJK line-breaking and spacing rules in index.css, and the screen
   * reader's voice. Mixed text (Chinese prose quoting English) is `zh-Hant`.
   */
  lang?: ProseLang;
  /** `prose` for long reading on review screens; `stimulus` for exam text; `body` inside dense cards. */
  size?: ProseSize;
  /** Keep the User's own line breaks (a Response, an email). */
  preserveLines?: boolean;
  as?: "div" | "p" | "blockquote";
  className?: string;
  children: ReactNode;
};

/**
 * Running text longer than a sentence or two. Keeps the line length readable (max-w-measure) and
 * the leading generous; Chinese gets taller leading than English. Never italic for Chinese, never
 * uppercase, never tracked.
 */
export function Prose({ lang = "en", size = "prose", preserveLines, as: Tag = "div", className, children }: ProseProps) {
  return (
    <Tag
      lang={lang}
      className={cx(
        "max-w-measure text-ink text-pretty",
        SIZE[size],
        lang === "zh-Hant" && "leading-[1.85]",
        preserveLines && "whitespace-pre-wrap",
        className,
      )}
    >
      {children}
    </Tag>
  );
}

type MarkedTextProps = {
  /** The User's Response, exactly as written. */
  text: string;
  /** Each Deduction's quote with the number it is listed under. */
  marks: QuoteMark[];
  className?: string;
};

/**
 * A Response marked up like a teacher's correction: each Deduction's quote underlined in the
 * correction colour and tagged with its Deduction's number. A quote that cannot be found in the
 * text is simply not marked (the Deduction list still shows it). The number, not the colour,
 * carries the link between mark and Deduction.
 */
export function MarkedText({ text, marks, className }: MarkedTextProps) {
  const { segments } = markQuotes(text, marks);
  return (
    <Prose size="prose" preserveLines className={className}>
      {segments.map((seg, i) =>
        seg.markId === undefined ? (
          <span key={i}>{seg.text}</span>
        ) : (
          <mark
            key={i}
            className="bg-correction-wash/60 text-ink underline decoration-correction decoration-[1.5px] underline-offset-[0.22em] [box-decoration-break:clone]"
          >
            {seg.text}
            <sup className="figures ml-0.5 text-caption font-semibold text-correction no-underline" aria-label={`Deduction ${seg.markId}`}>
              {seg.markId}
            </sup>
          </mark>
        ),
      )}
    </Prose>
  );
}
