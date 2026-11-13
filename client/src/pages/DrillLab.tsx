import { useCallback, useEffect, useMemo, useState } from "react";
import type { BuildupBankSetVM, BuildupItemVM, BuildupQueueEntryVM } from "@toefl-prep/shared";
import BuildupRun from "../components/buildup/BuildupRun";
import { getBuildupBank, getBuildupItem, getBuildupQueue } from "../lib/api";
import { ScoreFigure } from "../ui/BandFigure";
import { Button } from "../ui/Button";
import { StatusChip } from "../ui/Chip";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { cx } from "../ui/cx";
import { EmptyState } from "../ui/EmptyState";
import { PageHeader, SectionHeader } from "../ui/Heading";
import { IconArrowRight, IconChevronDown } from "../ui/icons";
import { drillLabSetState } from "../ui/labels";
import { Notice } from "../ui/Notice";
import { PageShell } from "../ui/PageShell";
import { Skeleton } from "../ui/Skeleton";

/**
 * The Drill Lab: backward buildup (倒序堆疊) over Listen and Repeat sentences.
 *
 * A practice surface, not an Attempt: nothing here creates an Attempt, and nothing it records
 * reaches a Band Estimate (server/src/routes/drillLab.ts says why that separation matters). So it
 * keeps the app navigation, unlike the Drill and Simulation screens: leaving mid-rep costs nothing.
 *
 * The queue and the bank load independently, the rule usePracticeData follows: a bank scan that
 * fails must not blank the queue the User came for.
 */
export default function DrillLab() {
  const [queue, setQueue] = useState<BuildupQueueEntryVM[] | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [bank, setBank] = useState<BuildupBankSetVM[] | null>(null);
  const [bankError, setBankError] = useState<string | null>(null);
  const [item, setItem] = useState<BuildupItemVM | null>(null);
  const [itemError, setItemError] = useState<string | null>(null);
  const [loadingItem, setLoadingItem] = useState(false);

  useEffect(() => {
    getBuildupQueue().then(setQueue, () => setQueueError("The practice queue didn't load."));
    getBuildupBank().then(setBank, () => setBankError("The bank didn't load."));
  }, []);

  const open = useCallback((setId: string, itemId: string) => {
    setLoadingItem(true);
    setItemError(null);
    getBuildupItem(setId, itemId).then(
      (loaded) => {
        setItem(loaded);
        setLoadingItem(false);
        window.scrollTo({ top: 0 });
      },
      () => {
        setItemError("That sentence didn't load.");
        setLoadingItem(false);
      },
    );
  }, []);

  const exit = useCallback(() => {
    setItem(null);
    // The queue's rep counts and breakdown positions are stale the moment a run records anything.
    getBuildupQueue().then(setQueue, () => setQueueError("The practice queue didn't reload."));
  }, []);

  return (
    <PageShell>
      {item ? (
        <BuildupRun item={item} onExit={exit} />
      ) : (
        <div className="space-y-12">
          <Intro />
          {loadingItem && (
            <p role="status" className="text-ui text-graphite">
              Opening the sentence…
            </p>
          )}
          {itemError && (
            <Notice tone="critical" live="polite">
              {itemError}
            </Notice>
          )}
          <QueueSection queue={queue} bank={bank} error={queueError} onOpen={open} />
          <BankSection bank={bank} error={bankError} onOpen={open} />
        </div>
      )}
    </PageShell>
  );
}

function Intro() {
  return (
    <div className="space-y-4">
      <PageHeader
        kicker="Drill Lab"
        title={
          <>
            Backward buildup{" "}
            <span lang="zh-Hant" className="font-sans text-heading font-medium text-graphite">
              倒序堆疊
            </span>
          </>
        }
        lede="Build a long Listen and Repeat sentence from its tail forward, so the end that falls apart becomes the part you know best. Each sentence runs three steps: a blind baseline, the buildup with the text in view, then a blind re-test. What it measures is not a score but where you first slip, and whether that point moves later."
      />
      <Notice tone="caution" title="This page shows sentences in full">
        Opening a sentence shows its Listen and Repeat text, so you can no longer hear and repeat it blind. The bank
        below keeps every sentence you haven't answered yet hidden, and asks before opening one.
      </Notice>
    </div>
  );
}

// How many queued sentences show before "Show all": the queue is ordered worst first, and a User
// with many scored Attempts can have dozens in it.
const QUEUE_PREVIEW = 10;

/** "Sentence 6": a sentence's place in its Set, read off the bank, which lists each Set's in order. */
function sentenceNumbers(bank: BuildupBankSetVM[] | null): Map<string, number> {
  const numbers = new Map<string, number>();
  for (const set of bank ?? []) set.items.forEach((entry, i) => numbers.set(`${set.setId}/${entry.itemId}`, i + 1));
  return numbers;
}

function QueueSection({
  queue,
  bank,
  error,
  onOpen,
}: {
  queue: BuildupQueueEntryVM[] | null;
  /** The bank, when it has loaded, for each sentence's place in its Set. */
  bank: BuildupBankSetVM[] | null;
  error: string | null;
  onOpen: (setId: string, itemId: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const numbers = useMemo(() => sentenceNumbers(bank), [bank]);
  const shown = queue && !showAll ? queue.slice(0, QUEUE_PREVIEW) : queue;
  return (
    <section aria-labelledby="queue-title" className="space-y-4">
      <SectionHeader
        id="queue-title"
        title="Practice queue"
        description="Sentences that scored 2.5 or below in a scored Attempt, where the sentence really fell apart. Lowest score first; a tie goes to the longer sentence."
      />
      {error && <Notice tone="critical">{error}</Notice>}
      {!queue && !error && (
        <div aria-busy="true" className="space-y-2">
          <Skeleton shape="block" className="h-16" />
          <Skeleton shape="block" className="h-16" />
        </div>
      )}
      {queue?.length === 0 && (
        <EmptyState title="The queue is empty">No sentence you have recorded scored 2.5 or below.</EmptyState>
      )}
      {shown && shown.length > 0 && (
        <ul aria-labelledby="queue-title" className="divide-y divide-rule rounded-sheet border border-rule bg-sheet">
          {shown.map((entry) => {
            const number = numbers.get(`${entry.setId}/${entry.itemId}`);
            const which = number === undefined ? null : `Sentence ${number}`;
            return (
              <li key={`${entry.setId}/${entry.itemId}`}>
                <button
                  type="button"
                  onClick={() => onOpen(entry.setId, entry.itemId)}
                  aria-label={`Practise ${entry.scenarioTitle}${which ? `, ${which.toLowerCase()}` : ""}`}
                  className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors duration-(--duration-quick) ease-quiet hover:bg-paper"
                >
                  <span className="w-28 shrink-0">
                    <ScoreFigure score={entry.worstScore} size="sm" />
                    <span className="block text-caption text-graphite">lowest</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-body font-medium text-ink">{entry.scenarioTitle}</span>
                    <span className="block text-meta text-graphite">
                      {which && <>{which} · </>}
                      {entry.wordCount} words
                      {entry.repCount > 0 && <> · practised {entry.repCount} {entry.repCount === 1 ? "time" : "times"}</>}
                      {entry.latestHeldWords !== null && <> · last held to word {entry.latestHeldWords}</>}
                    </span>
                  </span>
                  <span className="inline-flex shrink-0 items-center gap-1 text-ui font-medium text-accent">
                    <span className="max-sm:sr-only">Practise</span>
                    <IconArrowRight size={14} />
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {queue && shown && queue.length > shown.length && (
        <Button variant="quiet" size="sm" onClick={() => setShowAll(true)}>
          Show all {queue.length} sentences
        </Button>
      )}
    </section>
  );
}

function BankSection({
  bank,
  error,
  onOpen,
}: {
  bank: BuildupBankSetVM[] | null;
  error: string | null;
  onOpen: (setId: string, itemId: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  // A hidden sentence (one with no scored recording) waits for a confirmation: opening it costs the
  // chance to hear it blind, so the first click asks rather than reveals. A sentence already shown
  // in full has nothing left to spoil and opens straight away, whatever the rest of its Set is.
  const [revealing, setRevealing] = useState<{ setId: string; itemId: string; title: string; number: number } | null>(null);

  return (
    <section aria-labelledby="bank-title" className="space-y-4">
      <SectionHeader
        id="bank-title"
        title="Every sentence"
        description="All Listen and Repeat sentences in your Sets. A sentence you have answered opens straight away; one still hidden asks first."
      />
      {error && <Notice tone="critical">{error}</Notice>}
      {!bank && !error && (
        <div aria-busy="true" className="space-y-2">
          <Skeleton shape="block" className="h-12" />
          <Skeleton shape="block" className="h-12" />
        </div>
      )}
      {bank && bank.length > 0 && (
        <ul className="divide-y divide-rule rounded-sheet border border-rule bg-sheet">
          {bank.map((set) => {
            const isOpen = expanded === set.setId;
            const state = drillLabSetState(set.items.filter((entry) => entry.preview !== null).length, set.items.length);
            return (
              <li key={set.setId}>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setExpanded(isOpen ? null : set.setId)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors duration-(--duration-quick) ease-quiet hover:bg-paper pointer-coarse:min-h-11"
                >
                  <span className="min-w-0 flex-1 truncate text-body text-ink">{set.scenarioTitle}</span>
                  {state && <StatusChip status={state} />}
                  <span aria-hidden="true" className={cx("shrink-0 text-graphite transition-transform duration-(--duration-quick)", isOpen && "rotate-180")}>
                    <IconChevronDown size={16} />
                  </span>
                </button>
                {isOpen && (
                  <ul className="border-t border-rule bg-paper px-4 py-1">
                    {set.items.map((entry, i) => (
                      <li key={entry.itemId} className="flex items-center gap-3 py-2">
                        <span className="figures w-6 shrink-0 text-meta text-graphite">
                          <span className="sr-only">Sentence </span>
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-ui text-ink-soft">
                          {entry.preview ?? <span className="text-graphite">Hidden until you open it</span>}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            entry.preview !== null
                              ? onOpen(set.setId, entry.itemId)
                              : setRevealing({ setId: set.setId, itemId: entry.itemId, title: set.scenarioTitle, number: i + 1 })
                          }
                          className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-control px-2 text-ui font-medium text-accent transition-colors duration-(--duration-quick) hover:bg-accent-wash pointer-coarse:min-h-11"
                        >
                          {entry.preview !== null ? "Practise" : "Practise…"}
                          <IconArrowRight size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <ConfirmDialog
        open={revealing !== null}
        title="Reveal this sentence?"
        confirmLabel="Reveal and practise"
        cancelLabel="Keep it hidden"
        onConfirm={() => {
          if (revealing) onOpen(revealing.setId, revealing.itemId);
          setRevealing(null);
        }}
        onCancel={() => setRevealing(null)}
      >
        <p>
          {revealing ? `Sentence ${revealing.number} of ${revealing.title}` : "This sentence"} has no scored recording yet,
          so it is still hidden. Opening it shows it in full, so you can no longer hear and repeat it blind.
        </p>
      </ConfirmDialog>
    </section>
  );
}
