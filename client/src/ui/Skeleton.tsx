import { cx } from "./cx";

type SkeletonProps = {
  /** `line` — a line of text; `block` — a figure, chart or card body of the given height class. */
  shape?: "line" | "block";
  /** Several text lines; the last one is shorter, like a paragraph. */
  lines?: number;
  /** Size utilities, e.g. "h-10 w-24" for a band figure. */
  className?: string;
};

/**
 * The shape of content that is on its way, for loads that take long enough to notice (over ~300 ms).
 * Decorative: put aria-busy="true" on the region being loaded so assistive tech knows. Never a
 * skeleton for something that failed — that is a Notice.
 */
export function Skeleton({ shape = "line", lines = 1, className }: SkeletonProps) {
  if (shape === "block") {
    return <div aria-hidden="true" className={cx("animate-skeleton rounded-control bg-well", className)} />;
  }
  return (
    <div aria-hidden="true" className={cx("space-y-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={cx("h-3 animate-skeleton rounded-chip bg-well", lines > 1 && i === lines - 1 ? "w-3/5" : "w-full")} />
      ))}
    </div>
  );
}
