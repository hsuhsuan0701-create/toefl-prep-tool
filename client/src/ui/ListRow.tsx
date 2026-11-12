import { useId, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import type { AttemptMode, AttemptStatus, ModulePath, Section } from "@toefl-prep/shared";
import { BandFigure } from "./BandFigure";
import { Chip, StatusChip } from "./Chip";
import { cx } from "./cx";
import { IconCaution, IconChevronRight, IconFlag, IconRepeat } from "./icons";
import {
  ATTEMPT_FLAG,
  ATTEMPT_MODE_LABEL,
  ATTEMPT_STATUS,
  MODULE_PATH_LABEL,
  NO_BAND,
  SECTION_LABEL,
  SET_PRACTICE_STATE,
  setSourceLabel,
  type SetPracticeState,
} from "./labels";

/**
 * A ruled list of rows on one sheet: Sets, Attempts, setup checks. Rows are separated by hairlines,
 * not by gaps between cards. `label` names the list for screen readers when no heading precedes it.
 */
export function List({ children, label, className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <ul aria-label={label} className={cx("divide-y divide-rule overflow-hidden rounded-sheet border border-rule bg-sheet", className)}>
      {children}
    </ul>
  );
}

// The whole row is the link's hit area (an ::after overlay), while buttons inside the row sit above
// it (relative z-10) — so a row is one big touch target without nesting interactive elements.
const ROW = "relative gap-3 px-4 py-3 transition-colors duration-(--duration-quick) hover:bg-paper";
const ROW_LINK = "rounded-chip after:absolute after:inset-0 after:content-[''] focus-visible:outline-offset-4";

type SetRowProps = {
  /**
   * The Set's human title, derived from its content (docs/design-system.md, "Naming a Set"):
   * "At the Campus Library", never "spk-b1d474fe".
   */
  title: string;
  /** The id, shown small and secondary — useful for bug reports, never the name. */
  setId: string;
  to: string;
  /** Omit where every row has the same state (a "Next up" list is all new by definition). */
  state?: SetPracticeState;
  source: string;
  /** Formatted with ui/format's formatDay. */
  created: string;
  /** What is inside, briefly: "Email · Academic Discussion · 10 Build a Sentence Items". */
  summary?: string;
  /**
   * The Set's advisory notes from generation as sentences (labels.ts's advisoryNoteLines), behind a
   * toggle under the row's meta line. The Set is still usable. An empty list shows nothing.
   */
  noteLines?: string[];
  /** A trailing action, e.g. a quiet ButtonLink "Drill". The row itself already links to `to`. */
  action?: ReactNode;
};

/** One Set in a list: its title first, what it contains, where it came from, and where you stand. */
export function SetRow({ title, setId, to, state, source, created, summary, noteLines, action }: SetRowProps) {
  const lines = noteLines ?? [];
  return (
    <li className={cx(ROW, "flex")}>
      <div className="min-w-0 flex-1">
        <Link to={to} className={cx(ROW_LINK, "text-body font-medium text-ink")}>
          {title}
        </Link>
        {summary && <p className="mt-0.5 text-meta text-ink-soft">{summary}</p>}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-graphite">
          <span>
            {setSourceLabel(source)} · {created}
          </span>
          <span className="font-mono text-caption text-faint">{setId}</span>
        </p>
        {lines.length > 0 && <SetNotes lines={lines} />}
      </div>
      <div className="relative z-10 flex shrink-0 flex-col items-end gap-1.5 sm:flex-row sm:items-center sm:gap-2">
        {state && <StatusChip status={SET_PRACTICE_STATE[state]} />}
        {action}
      </div>
    </li>
  );
}

/**
 * A Set's advisory notes, closed until asked for. Closed means absent from the DOM — not hidden
 * with CSS — so a screen reader or an in-page find never meets them on a closed row. Sits above the
 * row's link overlay, so opening it or selecting its text does not follow the row.
 */
function SetNotes({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <div className="relative z-10 mt-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((was) => !was)}
        className="-ml-0.5 inline-flex min-h-8 items-center gap-1.5 rounded-chip px-0.5 text-meta font-medium text-ink-soft hover:text-ink pointer-coarse:min-h-10"
      >
        <span className={cx("text-graphite transition-transform duration-(--duration-quick)", open && "rotate-90")} aria-hidden="true">
          <IconChevronRight size={14} />
        </span>
        <span className="text-caution">
          <IconCaution size={14} />
        </span>
        {lines.length} {lines.length === 1 ? "note" : "notes"} on this Set
      </button>
      {open && (
        <div id={panelId} className="mt-1 max-w-measure pl-5">
          <ul className="space-y-1 text-meta text-ink-soft">
            {/* Keyed by position: two lines can read the same, and the list is derived fresh from
                an immutable Set, so its order never changes under it. */}
            {lines.map((line, index) => (
              <li key={index} className="text-pretty">
                {line}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-caption text-graphite">Found when this Set was generated. Every Item can still be answered and scored as usual.</p>
        </div>
      )}
    </div>
  );
}

type AttemptRowProps = {
  section: Section;
  mode: AttemptMode;
  /** The Set's human title (see SetRow). */
  setTitle: string;
  /** Formatted with ui/format's formatWhen. */
  when: string;
  to: string;
  status: AttemptStatus;
  /** The Attempt's own Band Estimate, if one was computed. Drills of Reading/Listening never have one. */
  band?: number | null;
  modulePath?: ModulePath | null;
  repeat?: boolean;
  /** The Simulation was interrupted: the tab was left, or a prompt would not play. */
  flagged?: boolean;
  /**
   * A completed Attempt that should have a band and has none (a failed or missing Item), marked
   * beside its status so it does not read like one that went fine.
   */
  noBand?: boolean;
  /** A result for an Attempt with no band: "8 of 9 correct", "Email 4 / 5". */
  summary?: ReactNode;
  /** Row actions for an unfinished Attempt ("Finish and score", "Discard…"). */
  actions?: ReactNode;
};

/**
 * One Attempt in a list. Its name is what it was — "Writing Simulation" — then which Set and when;
 * the outcome on the right is its band if it has one, otherwise its status. Never the UUID.
 */
export function AttemptRow({ section, mode, setTitle, when, to, status, band, modulePath, repeat, flagged, noBand, summary, actions }: AttemptRowProps) {
  const showBand = status === "completed" && band !== undefined && band !== null;
  return (
    <li className={cx(ROW, "grid gap-y-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center")}>
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link to={to} className={cx(ROW_LINK, "text-body font-medium text-ink")}>
            {SECTION_LABEL[section]} {ATTEMPT_MODE_LABEL[mode]}
          </Link>
          {repeat && (
            <Chip tone="neutral" className="relative z-10" title="A Repeat of a Set you had already attempted. Left out of Band Estimates.">
              <IconRepeat size={12} />
              Repeat
            </Chip>
          )}
          {flagged && (
            <Chip tone="caution" className="relative z-10" title={ATTEMPT_FLAG.hint}>
              <IconFlag size={12} />
              {ATTEMPT_FLAG.label}
            </Chip>
          )}
        </p>
        <p className="mt-0.5 text-meta text-graphite">
          <span className="text-ink-soft">{setTitle}</span> · {when}
        </p>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 sm:row-span-2 sm:justify-end">
        <div className="text-left sm:text-right">
          {showBand ? (
            <BandFigure band={band} size="sm" />
          ) : (
            <span className="inline-flex flex-wrap items-center gap-1.5 sm:justify-end">
              <StatusChip status={ATTEMPT_STATUS[status]} />
              {noBand && <StatusChip status={NO_BAND} />}
            </span>
          )}
          {(summary || (showBand && modulePath)) && (
            <p className="mt-0.5 text-meta text-graphite">{summary ?? (modulePath ? MODULE_PATH_LABEL[modulePath] : null)}</p>
          )}
        </div>
        <span className="hidden text-faint sm:block" aria-hidden="true">
          <IconChevronRight />
        </span>
      </div>
      {actions && <div className="relative z-10 flex flex-wrap gap-2">{actions}</div>}
    </li>
  );
}
