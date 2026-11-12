import type { ReactNode } from "react";
import { cx } from "./cx";
import { IconCaution, IconCheck, IconCritical, IconInfo } from "./icons";

type NoticeTone = "info" | "caution" | "critical" | "positive";

const TONE: Record<NoticeTone, { box: string; icon: string; Icon: typeof IconInfo; word: string }> = {
  info: { box: "bg-accent-wash border-accent-rule", icon: "text-accent", Icon: IconInfo, word: "Note" },
  caution: { box: "bg-caution-wash border-caution-rule", icon: "text-caution", Icon: IconCaution, word: "Caution" },
  critical: { box: "bg-critical-wash border-critical-rule", icon: "text-critical", Icon: IconCritical, word: "Problem" },
  positive: { box: "bg-positive-wash border-positive-rule", icon: "text-positive", Icon: IconCheck, word: "Done" },
};

type NoticeProps = {
  /**
   * - `info` — context the User should read before acting ("Feedback appears after the whole Simulation").
   * - `caution` — something that changes how to read a result, not a fault ("This Simulation was routed
   *   to the Lower Module, which caps the band", "Reduced model independence", a skipped Item).
   * - `critical` — something failed or will be lost ("Scoring failed", "This will discard the Attempt").
   * - `positive` — a completed step worth confirming, sparingly.
   */
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  /** A Button or TextLink that resolves the notice ("Re-score", "Open setup guide"). */
  action?: ReactNode;
  /**
   * Announce when it appears: `polite` for a notice that arrives after something the User did,
   * `assertive` only for a critical failure that interrupts. Default: not announced (static notices
   * that are part of the page are read in order like any text).
   */
  live?: "polite" | "assertive";
  className?: string;
};

/** An inline callout inside the page flow. Icon + a hidden tone word so meaning never rests on colour. */
export function Notice({ tone = "info", title, children, action, live, className }: NoticeProps) {
  const t = TONE[tone];
  return (
    <div
      role={live === "assertive" ? "alert" : live === "polite" ? "status" : undefined}
      className={cx("flex gap-3 rounded-sheet border px-4 py-3", t.box, className)}
    >
      <span className={cx("mt-[0.1875rem]", t.icon)}>
        <t.Icon size={16} />
      </span>
      <div className="min-w-0 flex-1 text-ui text-ink">
        <span className="sr-only">{t.word}: </span>
        {title && <p className="font-semibold text-ink">{title}</p>}
        {children && <div className={cx("text-ink-soft text-pretty", Boolean(title) && "mt-0.5")}>{children}</div>}
        {action && <div className="mt-2.5 flex flex-wrap gap-2">{action}</div>}
      </div>
    </div>
  );
}
