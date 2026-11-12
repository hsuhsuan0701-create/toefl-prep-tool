import type { ReactNode } from "react";
import { cx } from "./cx";
import { IconChevronRight } from "./icons";

type DisclosureProps = {
  /** What opening it reveals, as a plain phrase: "How this band is estimated", "Judge detail". */
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  /**
   * Controlled form, for a page that opens it from elsewhere ("See what's missing" opening Setup).
   * Pass both, or neither; `defaultOpen` is then ignored.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  id?: string;
  className?: string;
};

/**
 * Secondary detail the User may want but does not need first: the estimate method and its internal
 * name (`linear-v2`), the Arbiter's reconciliation, the Judge Reports, a Set's id. Native
 * <details>, so it works without JavaScript and is keyboard-operable for free.
 */
export function Disclosure({ summary, children, defaultOpen, open, onOpenChange, id, className }: DisclosureProps) {
  return (
    <details
      id={id}
      open={open ?? defaultOpen}
      onToggle={onOpenChange ? (e) => onOpenChange(e.currentTarget.open) : undefined}
      className={cx("group", className)}
    >
      <summary className="inline-flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-chip text-meta font-medium text-ink-soft select-none hover:text-ink pointer-coarse:min-h-10 [&::-webkit-details-marker]:hidden">
        <span className="text-graphite transition-transform duration-(--duration-quick) group-open:rotate-90" aria-hidden="true">
          <IconChevronRight size={14} />
        </span>
        {summary}
      </summary>
      <div className="mt-1 pl-5 text-meta text-ink-soft">{children}</div>
    </details>
  );
}

/** An internal name shown inside a Disclosure: `linear-v2`, a Set id. Mono, small, selectable. */
export function InternalName({ children }: { children: ReactNode }) {
  return <code className="rounded-chip bg-well px-1 py-px font-mono text-caption text-ink-soft">{children}</code>;
}
