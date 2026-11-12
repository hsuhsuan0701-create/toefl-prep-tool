import type { ReactNode } from "react";
import { cx } from "./cx";

type EmptyStateProps = {
  /** What is not here yet, plainly: "No Attempts yet". */
  title: ReactNode;
  /** What will fill it, or what to do first. One or two sentences. */
  children?: ReactNode;
  /** The one next step, usually a ButtonLink. */
  action?: ReactNode;
  className?: string;
};

/**
 * A space that has nothing in it yet. Drawn as a dashed outline — a blank on an answer sheet —
 * and it always says what will fill it. Not for errors (Notice) and not for loading (Skeleton).
 */
export function EmptyState({ title, children, action, className }: EmptyStateProps) {
  return (
    <div className={cx("rounded-sheet border border-dashed border-rule-strong px-5 py-6", className)}>
      <p className="text-body font-medium text-ink">{title}</p>
      {children && <div className="mt-1 max-w-measure text-ui text-graphite text-pretty">{children}</div>}
      {action && <div className="mt-4 flex flex-wrap gap-2">{action}</div>}
    </div>
  );
}
