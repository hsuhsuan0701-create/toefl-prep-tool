import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { useDeadlineCountdown } from "../../hooks/useDeadlineCountdown";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { ExamClock, ExamShell } from "../../ui/ExamShell";
import { IconArrowLeft, IconArrowRight } from "../../ui/icons";
import SentenceTiles, { type BuildSentenceItem } from "./SentenceTiles";
import SentenceItemOverview from "./SentenceItemOverview";
import { emptySlotsForFrame, slotsFromTexts, slotTextsOf, type SlotFill } from "./sentenceSlotFill";
import {
  arrangementOf,
  initialBuildSentenceRunState,
  reduceBuildSentenceRun,
  respondedItemIds,
  type BuildSentenceResponse,
  type BuildSentenceRunEnd,
  type BuildSentenceRunEvent,
  type BuildSentenceRunState,
} from "./buildSentenceRun";

/**
 * Which call site's chrome to draw: the one axis on which the Writing Drill and the Writing
 * Simulation differ.
 *
 * Everything a Build a Sentence run does is identical in the two modes, by construction: same pooled
 * budget, same Frame slot filling, same navigation, same overview, same commit, and the same
 * confirmation before finishing with empty blanks. Only arrangement and emphasis differ. The Drill
 * puts the Item overview under the tiles and ends the Task with the primary button; the Simulation
 * puts the overview above the prompt (it is the section's own review affordance, not an extra) and
 * keeps Finish secondary, with a line saying what finishing hands in.
 *
 * If a second axis ever seems necessary, the boundary is probably in the wrong place.
 */
export type BuildSentenceTaskMode = "drill" | "simulation";

export type BuildSentenceChrome = {
  /** The section: "Writing". */
  section: string;
  /** Where in it: "Drill · Build a Sentence", "Simulation · Build a Sentence". */
  part?: ReactNode;
  /** The screen's one way out: the caller's `ExamExit`, held by the caller's leave guard. */
  exit: ReactNode;
  /** Anything the caller shows above the Task: earlier stages' results, a notice. */
  before?: ReactNode;
};

export type BuildSentenceTaskProps = {
  /**
   * The Task's Items, in Set order. The module reads nothing else off the Set, and never reads an
   * Item's optional `timeLimitSec`: the budget is a Task-level constant.
   */
  items: readonly BuildSentenceItem[];
  mode: BuildSentenceTaskMode;
  /**
   * The exam screen this Task is drawn on. The module draws the `ExamShell` itself because the
   * pooled clock and the Back / Next / Finish controls are its own and belong in the shell's header
   * and footer; the caller supplies the rest. Per-render data, not a second mode axis.
   */
  chrome: BuildSentenceChrome;
  /**
   * The Responses, one per Item in Set order (never visit order), whether the User finished early or
   * the pooled budget expired. Called exactly once per mounted run, from the interaction that ends
   * it, so a caller may move its own stage on synchronously.
   */
  onComplete: (responses: readonly BuildSentenceResponse[], reason: BuildSentenceRunEnd) => void;
  /**
   * A deadline and arrangements the caller owns: the Writing Simulation passes the deadline it keeps
   * in its saved session and each Item's draft as tile texts per blank, so a reload picks the Task
   * up where it was. Absent (the Drill), the Task starts a fresh budget at mount.
   */
  resume?: { deadlineMs: number; slotTexts: Readonly<Record<string, readonly (string | null)[]>> };
  /** Every arrangement change, as tile texts per blank, for a caller that keeps a draft. */
  onArrangementChange?: (itemId: string, slotTexts: (string | null)[]) => void;
};

/**
 * The Build a Sentence task module: hand it the Items, get the Responses back.
 *
 * It owns the whole Task: the one pooled budget across every Item, the wall-clock countdown, Frame
 * slot filling, tile state, free navigation, the Item overview, and the commit both endings share.
 * Leaving and reloading are asked about by the page's leave guard (useLeaveGuard), which is up
 * whenever this module is mounted. `buildSentenceRun.ts` (the pure run reducer), `SentenceTiles.tsx`,
 * `sentenceSlotFill.ts` and `SentenceItemOverview.tsx` are its private internals: nothing outside
 * this directory imports them, and the public surface is `index.ts`. The Writing Drill and the
 * Writing Simulation both mount this one implementation, which is why they time the Task
 * identically.
 *
 * The budget is pooled across Items, never per Item: `deadlineMs` is fixed once, at mount (from
 * `resume` when the caller supplies one), and nothing (navigation, a tile placement, a re-render)
 * recomputes it. Expiry commits whatever is arranged and ends the Task rather than force-marching
 * the User through the Items they never reached; those Items commit as empty Responses through the
 * same path.
 */
export default function BuildSentenceTask({
  items,
  mode,
  chrome,
  onComplete,
  resume,
  onArrangementChange,
}: BuildSentenceTaskProps) {
  // "begin" at mount, from the initial state: this fixes the pooled deadline once for the whole Task,
  // either the caller's (`resume`) or a fresh budget from now. A second mount without `resume` gets
  // a second, fresh budget.
  const [run, setRun] = useState<BuildSentenceRunState>(() =>
    reduceBuildSentenceRun(
      initialBuildSentenceRunState,
      {
        type: "begin",
        resume: resume && {
          deadlineMs: resume.deadlineMs,
          arrangements: new Map(
            items
              .filter((item) => resume.slotTexts[item.id] !== undefined)
              .map((item) => [
                item.id,
                slotsFromTexts(item.tiles, resume.slotTexts[item.id], emptySlotsForFrame(item.frame).length),
              ]),
          ),
        },
      },
      items,
    ),
  );
  // The Task commits exactly once. "finished" is terminal in the reducer, so this only matters for
  // the one race the reducer cannot see: a manual Finish and an expiry resolving against the same
  // rendered state, which would otherwise hand the caller two sets of Responses.
  const committedRef = useRef(false);

  const dispatch = useCallback(
    (ev: BuildSentenceRunEvent) => {
      setRun((prev) => reduceBuildSentenceRun(prev, ev, items));
    },
    [items],
  );

  // Both ways the Task ends, through the reducer's one commit path, so early finishing and expiry
  // cannot drift apart. The ended state is computed here rather than inside the state updater
  // because handing the Responses to the caller is a side effect, and a state updater must not have
  // one.
  const endTask = useCallback(
    (ev: { type: "finish-early" } | { type: "budget-expired" }) => {
      if (committedRef.current || run.stage !== "running") return;
      const ended = reduceBuildSentenceRun(run, ev, items);
      if (ended.stage !== "finished") return;
      committedRef.current = true;
      setRun(ended);
      onComplete(ended.responses, ended.reason);
    },
    [run, items, onComplete],
  );

  // Everything on screen is derived from the run state at render and never reset by an effect, so a
  // newly-keyed Item cannot paint once holding the previous Item's tiles before an effect catches up.
  const index = run.stage === "running" ? run.index : 0;
  const item: BuildSentenceItem | undefined = items[index];
  const slots = useMemo<SlotFill>(
    // The slot count is load-bearing, not cosmetic: applyTileDrop resolves against the slots that
    // exist, so an arrangement seeded shorter than the Item's Frame silently swallows every drop
    // past its end. emptySlotsForFrame parses the Frame exactly the way SentenceTiles draws it, so
    // the seeded count cannot disagree with the blanks on screen, and a frameless Item (a Set banked
    // before Frames existed) gets no slots at all.
    () => (item ? arrangementOf(run, item.id, emptySlotsForFrame(item.frame).length) : emptySlotsForFrame(undefined)),
    [run, item],
  );
  const responded = useMemo(() => respondedItemIds(run), [run]);
  const overviewItems = useMemo(
    () => items.map((i) => ({ id: i.id, hasResponse: responded.has(i.id) })),
    [items, responded],
  );
  // Items with at least one empty blank: the ones that would score 0 if the Task ended now. A
  // frameless Item has no blanks, so it never counts — there is nothing the User could still fill.
  const incompleteCount = useMemo(
    () =>
      items.filter((i) => arrangementOf(run, i.id, emptySlotsForFrame(i.frame).length).some((tileId) => tileId === null))
        .length,
    [items, run],
  );

  // Finishing early ends the pooled clock for good, and an Item with an empty blank scores 0, so
  // Finish asks first whenever some Item still has one — identically in both modes. A complete
  // arrangement needs no question. The budget running out never asks (see handleExpire).
  const [confirmingFinish, setConfirmingFinish] = useState(false);

  // One countdown for the whole pooled budget, read against the wall clock so a laptop lid closed
  // mid-Task cannot hand back free time, and keyed to the Task's deadline (fixed by "begin" at mount)
  // and never to the Item, so moving between Items neither restarts it nor hands back time.
  const deadlineMs = useRef(run.stage === "running" ? run.deadlineMs : Date.now()).current;
  const handleExpire = useCallback(() => {
    setConfirmingFinish(false);
    endTask({ type: "budget-expired" });
  }, [endTask]);
  const secondsLeft = useDeadlineCountdown(deadlineMs, handleExpire);

  const handleSlotsChange = useCallback(
    (next: SlotFill) => {
      if (!item) return;
      dispatch({ type: "arrangement-changed", itemId: item.id, slots: next });
      onArrangementChange?.(item.id, slotTextsOf(next));
    },
    [item, dispatch, onArrangementChange],
  );

  // Navigation clamps on the last Item rather than ending the Task; ending it is the explicit Finish
  // affordance's job, so a stray Next cannot spend the User's remaining budget.
  const handleNext = useCallback(() => dispatch({ type: "next" }), [dispatch]);
  const handleBack = useCallback(() => dispatch({ type: "back" }), [dispatch]);
  const handleJump = useCallback((itemIndex: number) => dispatch({ type: "navigate-to-item", index: itemIndex }), [dispatch]);

  const handleFinishClick = useCallback(() => {
    if (incompleteCount > 0) setConfirmingFinish(true);
    else endTask({ type: "finish-early" });
  }, [incompleteCount, endTask]);
  const handleFinishConfirmed = useCallback(() => {
    setConfirmingFinish(false);
    endTask({ type: "finish-early" });
  }, [endTask]);

  // The run has ended (or the Task has no Items at all): there is no current Item, so there is
  // nothing to draw. In practice the caller has already moved its own stage on in the same batch as
  // the onComplete that ended the run, so this is the safety net rather than a screen anyone sees.
  if (run.stage !== "running" || !item) {
    return (
      <ExamShell section={chrome.section} part={chrome.part} exit={chrome.exit}>
        <p className="text-ui text-graphite">Finishing Build a Sentence…</p>
      </ExamShell>
    );
  }

  const onLastItem = index + 1 >= items.length;
  const simulation = mode === "simulation";

  // Back-navigation without this is not navigation: ten Items reachable only by stepping backwards
  // leaves the User no way to find the one they skipped.
  const overview = <SentenceItemOverview items={overviewItems} currentIndex={index} onJump={handleJump} />;

  const footer = (
    <>
      <div className="flex gap-2">
        {/* Words on a laptop, arrows with the same words for a screen reader on a phone, so the
            footer fits 390 px beside the Finish button. */}
        <Button onClick={handleBack} disabled={index === 0} icon={<IconArrowLeft size={16} />}>
          <span className="max-sm:sr-only">Back</span>
        </Button>
        <Button onClick={handleNext} disabled={onLastItem} iconEnd={<IconArrowRight size={16} />}>
          <span className="max-sm:sr-only">Next</span>
        </Button>
      </div>
      {/* The only manual way to end the Task. Primary in the Drill, where finishing is the next step;
          secondary in the Simulation, where the section moves on to the Email and the Item tiles
          are what the User should be looking at. */}
      <Button variant={simulation ? "secondary" : "primary"} onClick={handleFinishClick}>
        Finish Build a Sentence
      </Button>
    </>
  );

  return (
    <ExamShell
      section={chrome.section}
      part={chrome.part}
      clock={<ExamClock secondsLeft={secondsLeft} lowAt={60} criticalAt={30} label="Time left for Build a Sentence" />}
      exit={chrome.exit}
      progress={{ current: index + 1, total: items.length, label: `Item ${index + 1} of ${items.length}` }}
      footer={footer}
    >
      <div className="mx-auto max-w-measure space-y-8">
        {chrome.before}
        {simulation && overview}
        <section aria-label={`Item ${index + 1}`} className="space-y-6">
          <p className="border-l-2 border-rule-strong pl-4 text-stimulus text-ink-soft">{item.prompt}</p>
          <SentenceTiles key={item.id} item={item} slots={slots} onSlotsChange={handleSlotsChange} onSkip={handleNext} />
        </section>
        {!simulation && overview}
        {simulation && (
          <p className="text-meta text-graphite">
            Finishing hands in every item exactly as it stands and starts the email. Whatever is left of
            the budget is not carried over.
          </p>
        )}
      </div>
      <ConfirmDialog
        open={confirmingFinish}
        title="Finish Build a Sentence?"
        confirmLabel="Finish and hand in"
        cancelLabel="Keep working"
        onConfirm={handleFinishConfirmed}
        onCancel={() => setConfirmingFinish(false)}
      >
        <p>
          {incompleteCount} of {items.length} {items.length === 1 ? "Item" : "Items"}{" "}
          {incompleteCount === 1 ? "still has" : "still have"} an empty blank. As on the test, Items with an
          empty blank score 0, and you can't come back to them once the Task ends.
        </p>
      </ConfirmDialog>
    </ExamShell>
  );
}
