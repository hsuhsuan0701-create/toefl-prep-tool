import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

type CardPadding = "none" | "sm" | "md" | "lg";
type CardTone = "sheet" | "well" | "plain";

const PADDING: Record<CardPadding, string> = {
  none: "",
  sm: "p-3",
  md: "p-4 sm:p-5",
  lg: "p-5 sm:p-7",
};

const TONE: Record<CardTone, string> = {
  sheet: "bg-sheet border border-rule",
  well: "bg-well border border-transparent",
  plain: "border border-rule",
};

type CardProps = HTMLAttributes<HTMLElement> & {
  /** `section`/`article` when the card is a landmark-worthy unit with its own heading. */
  as?: "div" | "section" | "article" | "li";
  /**
   * `sheet` (default) — a unit of content laid on the page: a section's band, an Item's review.
   * `well` — recessed: the User's own Response text, a quote, a read-only figure group inside a sheet.
   * `plain` — a ruled outline with no fill, for grouping inside a sheet without stacking fills.
   */
  tone?: CardTone;
  padding?: CardPadding;
  children: ReactNode;
};

/**
 * A sheet of content. Cards are separated by ruled borders, never by shadows; never nest a `sheet`
 * inside a `sheet` (use `well` or `plain`, or a Divider).
 */
export function Card({ as: Tag = "div", tone = "sheet", padding = "md", className, children, ...rest }: CardProps) {
  return (
    <Tag className={cx("rounded-sheet", TONE[tone], PADDING[padding], className)} {...rest}>
      {children}
    </Tag>
  );
}

/** A hairline between parts of one card or one list. Decorative; screen readers skip it. */
export function Divider({ className }: { className?: string }) {
  return <hr aria-hidden="true" className={cx("border-0 border-t border-rule", className)} />;
}
