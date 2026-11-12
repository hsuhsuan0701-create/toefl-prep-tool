import type { ReactNode } from "react";
import { cx } from "./cx";

type PageHeaderProps = {
  title: ReactNode;
  /** A short line under the title: what this page is for, or the one fact that frames it. */
  lede?: ReactNode;
  /** A small line above the title, e.g. a back link ("← Progress") or the section ("Writing"). */
  kicker?: ReactNode;
  /** Secondary facts under the lede: dates, the Set, a status chip. */
  meta?: ReactNode;
  /** At most one primary Button here; everything else secondary or quiet. */
  actions?: ReactNode;
};

/**
 * The top of every planning and reading page. The title is serif, which the app keeps for titles
 * and figures alone: that is what gives a screen its "printed report" voice, so do not set other
 * text in serif.
 */
export function PageHeader({ title, lede, kicker, meta, actions }: PageHeaderProps) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 pb-6">
      <div className="min-w-0 max-w-measure">
        {kicker && <div className="mb-2 text-meta text-graphite">{kicker}</div>}
        <h1 className="font-serif text-title font-semibold text-ink text-balance">{title}</h1>
        {lede && <p className="mt-2 text-body text-ink-soft text-pretty">{lede}</p>}
        {meta && <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-meta text-graphite">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

type SectionHeaderProps = {
  title: ReactNode;
  /** One line saying what is in the section or why it matters now. */
  description?: ReactNode;
  /** A trailing action: a ButtonLink ("Start Simulation") or a TextLink ("See all 33"). */
  action?: ReactNode;
  /** Heading level. h2 for page sections, h3 inside a card. */
  as?: "h2" | "h3";
  id?: string;
  className?: string;
};

/** Opens a section of a page (h2) or a part of a card (h3). Sans, semibold — never serif. */
export function SectionHeader({ title, description, action, as: Tag = "h2", id, className }: SectionHeaderProps) {
  return (
    <div className={cx("flex flex-wrap items-end justify-between gap-x-4 gap-y-2", className)}>
      <div className="min-w-0">
        <Tag id={id} className={cx("font-semibold text-ink", Tag === "h2" ? "text-heading" : "text-body")}>
          {title}
        </Tag>
        {description && <p className="mt-0.5 text-meta text-graphite text-pretty">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

/**
 * A small label naming what follows: a card's section name ("Speaking"), a field name ("Target"),
 * a column of a Score Report ("Your Response"). Set in small capitals, not shouted uppercase.
 * English only — never wrap Chinese in it.
 */
export function Kicker({ children, className, as: Tag = "span" }: { children: ReactNode; className?: string; as?: "span" | "p" | "h2" | "h3" | "h4" | "dt" }) {
  return <Tag className={cx("text-ui font-semibold tracking-[0.05em] text-graphite [font-variant-caps:all-small-caps]", className)}>{children}</Tag>;
}
