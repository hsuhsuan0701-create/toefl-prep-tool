import { useEffect, useState } from "react";
import type { Section, SetupCapability, SetupPiece } from "@toefl-prep/shared";
import { listSets, type BatchGenerateItem, type SetMeta, type SetupStatus } from "../../lib/api";
import { Button } from "../../ui/Button";
import { ConfirmDialog } from "../../ui/ConfirmDialog";
import { Dialog } from "../../ui/Dialog";
import { SECTION_LABEL, advisoryNoteLines } from "../../ui/labels";
import { Notice } from "../../ui/Notice";
import { piecesPhrase } from "../setup/setupChecklist";
import {
  BATCH_WINDOW,
  batchCost,
  costLine,
  GENERATION_SECTIONS,
  MAX_BATCH_TOTAL,
  SECTION_COST,
  setCount,
  type PerSection,
} from "./generationCost";

export type GenerationRequest =
  | { mode: "single"; section: Section; supersedesSetId?: string }
  | { mode: "batch"; items: BatchGenerateItem[] };

type GenerateSetsDialogProps = {
  open: boolean;
  onClose: () => void;
  /** Starts the run; the dialog has closed by the time this is called. */
  onStart: (request: GenerationRequest) => void;
  /** True while this page is already watching a run it started; another cannot start until it ends. */
  busy: boolean;
  /** What this machine can do; null when unknown, which leaves every section available. */
  setup: SetupStatus | null;
};

// Writing a Set needs a reasoning CLI; recording Speaking and Listening audio also needs Gemini's
// voices and ffmpeg.
const GENERATION_NEEDS: Record<Section, SetupCapability> = {
  reading: "reading-writing-generation",
  writing: "reading-writing-generation",
  listening: "speaking-listening-generation",
  speaking: "speaking-listening-generation",
};

/** The pieces known to be missing that stop this section's Sets being generated, or null when nothing does. */
function generationBlockers(section: Section, setup: SetupStatus | null): SetupPiece[] | null {
  if (!setup || setup.capabilities[GENERATION_NEEDS[section]]) return null;
  const pieces = setup.missing.filter((entry) => entry.disables.includes(GENERATION_NEEDS[section])).map((entry) => entry.piece);
  return pieces.length > 0 ? pieces : null;
}

const NONE: PerSection = { reading: 0, listening: 0, writing: 0, speaking: 0 };

/**
 * Choosing which Sets to generate: a count per section (at most MAX_BATCH_TOTAL in all), what the mix
 * costs, and — for one Reading, Listening or Speaking Set — which existing Set it replaces. One Set
 * starts at once. More than one first asks, with the concrete number of AI and text-to-speech calls,
 * because a batch is real, overlapping, possibly hour-long spend.
 */
export function GenerateSetsDialog({ open, onClose, onStart, busy, setup }: GenerateSetsDialogProps) {
  const blockers = Object.fromEntries(GENERATION_SECTIONS.map((section) => [section, generationBlockers(section, setup)])) as Record<
    Section,
    SetupPiece[] | null
  >;
  const [counts, setCounts] = useState<PerSection>({ ...NONE, writing: 1 });
  const [confirming, setConfirming] = useState(false);
  // Which existing Set a single new one replaces: pre-selected to the newest Set of that section,
  // cleared in one click. Never for Writing, which the server refuses it for.
  const [replaceTarget, setReplaceTarget] = useState<SetMeta | null>(null);
  const [keepExisting, setKeepExisting] = useState(false);

  // A section this machine cannot generate never carries a count, whatever was picked before.
  const effective: PerSection = Object.fromEntries(GENERATION_SECTIONS.map((s) => [s, blockers[s] ? 0 : counts[s]])) as PerSection;
  const cost = batchCost(effective);
  const single = cost.total === 1 ? GENERATION_SECTIONS.find((s) => effective[s] === 1) ?? null : null;
  const replaceable = open && single !== null && single !== "writing" ? single : null;

  useEffect(() => {
    if (!replaceable) {
      setReplaceTarget(null);
      return;
    }
    let cancelled = false;
    // A new choice of section re-arms the pre-selection.
    setKeepExisting(false);
    // listSets returns newest first and already hides superseded Sets, so [0] is never one that an
    // earlier generation retired.
    listSets(replaceable)
      .then((sets) => {
        if (!cancelled) setReplaceTarget(sets[0] ?? null);
      })
      .catch(() => {
        if (!cancelled) setReplaceTarget(null);
      });
    return () => {
      cancelled = true;
    };
  }, [replaceable]);

  const allBlocked = GENERATION_SECTIONS.every((s) => blockers[s]);
  const supersedesSetId = replaceable && replaceTarget && !keepExisting ? replaceTarget.id : undefined;
  // Worded and filtered exactly as the Sets page shows them (labels.ts), so a note the User cannot
  // act on is left out here too.
  const replaceNotes = advisoryNoteLines(replaceTarget?.advisoryNotes ?? []);

  function adjust(section: Section, delta: number) {
    setCounts((previous) => {
      const others = GENERATION_SECTIONS.reduce((sum, s) => sum + (s === section ? 0 : previous[s]), 0);
      return { ...previous, [section]: Math.max(0, Math.min(previous[section] + delta, MAX_BATCH_TOTAL - others)) };
    });
  }

  function generate() {
    if (busy || cost.total < 1) return;
    if (single) {
      onClose();
      onStart({ mode: "single", section: single, ...(supersedesSetId ? { supersedesSetId } : {}) });
      return;
    }
    setConfirming(true);
  }

  function confirmBatch() {
    setConfirming(false);
    onClose();
    onStart({ mode: "batch", items: GENERATION_SECTIONS.flatMap((section) => (effective[section] > 0 ? [{ kind: section, count: effective[section] }] : [])) });
  }

  return (
    <>
      <Dialog
        open={open && !confirming}
        title="Generate Sets"
        onClose={onClose}
        actions={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" onClick={generate} disabled={busy || cost.total < 1}>
              {cost.total > 1 ? `Generate ${setCount(cost.total)}…` : cost.total === 1 ? "Generate 1 Set" : "Generate Sets"}
            </Button>
          </>
        }
      >
        <p>New Sets are written by Claude (or Codex) and checked before they join your bank; Speaking and Listening Sets also get recorded audio.</p>

        {allBlocked && (
          <Notice tone="caution">
            This machine can't generate Sets yet. Not set up: {piecesPhrase(GENERATION_SECTIONS.flatMap((s) => blockers[s] ?? []))}. The
            Setup list on the Dashboard says how to add each.
          </Notice>
        )}

        <fieldset className="space-y-1 pt-1">
          <legend className="sr-only">How many Sets of each section</legend>
          {GENERATION_SECTIONS.map((section) => (
            <CountStepper
              key={section}
              section={section}
              value={effective[section]}
              blockedBy={blockers[section]}
              atMax={cost.total >= MAX_BATCH_TOTAL}
              onChange={(delta) => adjust(section, delta)}
            />
          ))}
        </fieldset>

        {replaceable && replaceTarget && (
          <div className="space-y-2 border-t border-rule pt-3">
            {keepExisting ? (
              <p className="text-meta text-ink-soft">
                Not replacing an existing Set.{" "}
                <Button variant="quiet" size="sm" onClick={() => setKeepExisting(false)}>
                  Replace “{replaceTarget.title}”
                </Button>
              </p>
            ) : (
              <p className="text-meta text-ink-soft">
                Replaces “{replaceTarget.title}”, which leaves your Set lists once the new one lands.{" "}
                <Button variant="quiet" size="sm" onClick={() => setKeepExisting(true)} aria-label={`Keep “${replaceTarget.title}”`}>
                  Keep it
                </Button>
              </p>
            )}
            {/* What the Set about to be replaced was known to be weak at is what makes "replace it"
                or "keep it" a real choice. */}
            {!keepExisting && replaceNotes.length > 0 && (
              <Notice tone="caution" title={`“${replaceTarget.title}” carries ${replaceNotes.length} ${replaceNotes.length === 1 ? "note" : "notes"}`}>
                <ul className="list-disc space-y-0.5 pl-4">
                  {/* Keyed by position: two notes can compose to identical text. */}
                  {replaceNotes.map((note, index) => (
                    <li key={index}>{note}</li>
                  ))}
                </ul>
              </Notice>
            )}
          </div>
        )}

        <div className="space-y-0.5 border-t border-rule pt-3 text-meta">
          <p className="text-ink-soft">{cost.total < 1 ? "Pick at least one Set." : costLine(cost)}</p>
          {single && <p className="text-graphite">Usually takes {SECTION_COST[single].duration}.</p>}
          {busy && <p className="text-graphite">A generation you started is still running; start another when it finishes.</p>}
        </div>
      </Dialog>

      <ConfirmDialog
        open={open && confirming}
        title={`Generate ${setCount(cost.total)}?`}
        confirmLabel={`Generate ${setCount(cost.total)}`}
        cancelLabel="Back"
        onConfirm={confirmBatch}
        onCancel={() => setConfirming(false)}
      >
        <p>
          Normally about {cost.calls} AI calls; retries for variety can take that to {cost.maxCalls}. They run on your Claude or Codex
          subscription{cost.total > BATCH_WINDOW ? `, at most ${BATCH_WINDOW} Sets at a time` : ""}.
        </p>
        {cost.clips > 0 && (
          <p>
            Speaking: {cost.clips} text-to-speech clips, which are paid Gemini calls — at most {cost.maxClipCalls} if every clip has to be
            recorded again.
          </p>
        )}
        {cost.audioSections.map((section) => (
          <p key={section}>{SECTION_COST[section].audio}</p>
        ))}
        <p>Sets that finish are kept even if you cancel the rest.</p>
      </ConfirmDialog>
    </>
  );
}

function CountStepper({
  section,
  value,
  blockedBy,
  atMax,
  onChange,
}: {
  section: Section;
  value: number;
  blockedBy: SetupPiece[] | null;
  atMax: boolean;
  onChange: (delta: number) => void;
}) {
  const name = SECTION_LABEL[section];
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <div className="min-w-0">
        <p className={value > 0 ? "text-ui font-medium text-ink" : "text-ui text-ink-soft"}>{name}</p>
        {blockedBy && <p className="text-meta text-graphite">Not set up: {piecesPhrase(blockedBy)}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-1" role="group" aria-label={`${name} Sets`}>
        <Button variant="secondary" size="sm" className="w-10 px-0" aria-label={`Fewer ${name} Sets`} disabled={value <= 0} onClick={() => onChange(-1)}>
          −
        </Button>
        <output aria-live="polite" className="figures min-w-[2ch] text-center text-ui font-medium text-ink">
          {value}
        </output>
        <Button
          variant="secondary"
          size="sm"
          className="w-10 px-0"
          aria-label={`More ${name} Sets`}
          disabled={atMax || blockedBy !== null}
          onClick={() => onChange(1)}
        >
          +
        </Button>
      </div>
    </div>
  );
}
