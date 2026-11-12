import { useState, type ReactNode } from "react";
import { Button } from "../../ui/Button";
import { StatusChip } from "../../ui/Chip";
import { Disclosure, InternalName } from "../../ui/Disclosure";
import { formatWhen } from "../../ui/format";
import { SectionHeader } from "../../ui/Heading";
import { SETUP_CHECK_STATE } from "../../ui/labels";
import { List } from "../../ui/ListRow";
import { Notice } from "../../ui/Notice";
import { Skeleton } from "../../ui/Skeleton";
import { setupRows, setupSummary, type Instruction } from "./setupChecklist";
import type { SetupStatusState } from "./useSetupStatus";

type SetupSectionProps = {
  setup: SetupStatusState;
  /**
   * `expanded` on a first run, where the checklist leads. Otherwise it stays reachable but collapsed
   * behind its one-line summary, opened by the User or by `open`.
   */
  mode: "expanded" | "collapsed";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

/**
 * The Setup checklist: one row per piece of this installation, with a plain status, what it is for
 * and exactly what to do when it is missing, plus "Check again". Reading and Listening lead, ready,
 * because they need nothing.
 */
export function SetupSection({ setup, mode, open, onOpenChange }: SetupSectionProps) {
  const { status, checkedAt, error, settled, rechecking, recheck } = setup;
  // Only an answer to "Check again" is announced; the first load is just part of the page.
  const [askedAgain, setAskedAgain] = useState(false);
  const checkAgain = (
    <Button
      variant="quiet"
      size="sm"
      loading={rechecking}
      onClick={() => {
        setAskedAgain(true);
        recheck();
      }}
    >
      Check again
    </Button>
  );

  const description = status
    ? mode === "expanded"
      ? `What this machine can do${checkedAt ? `, checked ${formatWhen(checkedAt).replace(/^Today, /, "at ")}` : ""}.`
      : setupSummary(status)
    : null;

  return (
    <section
      id="setup"
      tabIndex={-1}
      aria-labelledby="setup-heading"
      aria-busy={!settled || undefined}
      className="scroll-mt-6 space-y-4 rounded-sheet"
    >
      <SectionHeader id="setup-heading" title="Setup" description={description} action={checkAgain} />
      {/* Says the outcome of "Check again" once, without reading the whole list out. */}
      <p aria-live="polite" className="sr-only">
        {askedAgain && !rechecking ? (error ? "Setup could not be checked." : checkedAt ? `Setup checked ${formatWhen(checkedAt)}.` : "") : ""}
      </p>
      {error && (
        <Notice tone="caution">
          Couldn't check this machine's setup. {error} Reading and Listening work either way.
        </Notice>
      )}
      {!settled && <Skeleton shape="block" className="h-40 w-full" />}
      {status &&
        (mode === "expanded" ? (
          <Checklist status={status} />
        ) : (
          <Disclosure summary={open ? "Hide the checklist" : "Show the checklist"} open={open} onOpenChange={onOpenChange}>
            <div className="mt-2 -ml-5">
              <Checklist status={status} />
            </div>
          </Disclosure>
        ))}
    </section>
  );
}

function Checklist({ status }: { status: NonNullable<SetupStatusState["status"]> }) {
  return (
    <List label="Setup checks">
      {setupRows(status).map((row) => (
        <li key={row.key} className="flex flex-col gap-1.5 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
          <div className="w-24 shrink-0 sm:pt-0.5">
            <StatusChip status={SETUP_CHECK_STATE[row.state]} />
          </div>
          <div className="min-w-0 space-y-0.5">
            <p className="text-body font-medium text-ink">{row.name}</p>
            <p className="text-meta text-ink-soft text-pretty">{row.purpose}</p>
            <p className="text-meta text-graphite text-pretty">{instruction(row.detail)}</p>
          </div>
        </li>
      ))}
    </List>
  );
}

function instruction(parts: Instruction): ReactNode {
  return parts.map((part, i) => (typeof part === "string" ? part : <InternalName key={i}>{part.code}</InternalName>));
}
