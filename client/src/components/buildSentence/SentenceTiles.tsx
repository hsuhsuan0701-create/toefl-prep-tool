import { useMemo, type ReactNode } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "../../ui/Button";
import { cx } from "../../ui/cx";
import { Kicker } from "../../ui/Heading";
import { IconGrip } from "../../ui/icons";
import { Notice } from "../../ui/Notice";
import {
  TRAY_ZONE_ID,
  applyTileDrop,
  blankIndexOfZone,
  blankZoneId,
  parseFrameOrNull,
  tileIdOf,
  tileTextOf,
  trayTileIds,
  type SlotFill,
} from "./sentenceSlotFill";

export type BuildSentenceItem = {
  id: string;
  prompt: string;
  /** The partial sentence the tiles complete, blanks written as `___` — see shared/src/sentenceFrame.ts. */
  frame?: string;
  tiles: string[];
};

type SentenceTilesProps = {
  item: BuildSentenceItem;
  /**
   * The arrangement to draw: one slot per blank the Item's frame has, each holding a tile id or
   * `null`. Owned by the caller — seed it with `emptySlotsForFrame(item.frame)`.
   */
  slots: SlotFill;
  /**
   * Fires on every arrangement change — every drag that moves a tile — with the arrangement that
   * change produces. The caller stores it and hands it straight back as `slots`; nothing moves
   * until it does.
   */
  onSlotsChange: (slots: SlotFill) => void;
  /** The way past a frameless Item, which has no blanks to fill. Not a way to answer. */
  onSkip: () => void;
};

/** Where a drop target is, in words, for the screen-reader announcements. */
function zoneName(zoneId: string | null): string {
  if (zoneId === null) return "nowhere";
  const blank = blankIndexOfZone(zoneId);
  return blank === null ? "the tiles" : `blank ${blank + 1}`;
}

/** What dnd-kit says aloud during a drag: the tile's own text and the blank's number, never an id. */
const ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) => `Picked up ${tileTextOf(String(active.id))}.`,
  onDragOver: ({ active, over }) =>
    over ? `${tileTextOf(String(active.id))} is over ${zoneName(String(over.id))}.` : `${tileTextOf(String(active.id))} is not over a blank.`,
  onDragEnd: ({ active, over }) =>
    over ? `Dropped ${tileTextOf(String(active.id))} on ${zoneName(String(over.id))}.` : `${tileTextOf(String(active.id))} went back.`,
  onDragCancel: ({ active }) => `Put ${tileTextOf(String(active.id))} back where it was.`,
};

/**
 * Which zone a drag is over: the blank or tray under the pointer, and none when the pointer is over
 * neither, so a release outside the sentence and the tray changes nothing and a press that never
 * leaves the tray puts nothing anywhere. Nearest-centre would let a blank win over most of the
 * tray, whose centre sits far from its ends. The keyboard sensor has no pointer, so a keyboard drag
 * keeps the nearest-centre rule, carrying the tile 25 px per arrow press until a zone is closest.
 */
const zoneUnderPointer: CollisionDetection = (args) =>
  args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);

const KEYBOARD_INSTRUCTIONS =
  "Press Space to pick up a tile. Use the arrow keys to move it onto a blank, then press Space to drop it, or Escape to put it back.";

/**
 * Build a Sentence, as ETS presents it: the Item's Frame is drawn as fixed text with an inline blank
 * at each gap, and the tiles sit in a tray below it. Tiles move by dragging and by nothing else: a
 * drag puts a tile in one specific blank, a drag onto a filled blank swaps, and a drag back to the
 * tray takes a tile out.
 *
 * Drag-only because the real exam is drag-only, and pacing fidelity is the point of practising here:
 * tapping a tile to fill the next blank is a speed habit the exam does not offer, so practising with
 * it mis-calibrates how long a sentence really takes. dnd-kit's KeyboardSensor is deliberately kept:
 * picking a tile up with the space bar and moving it with the arrow keys is the accessibility path,
 * not a faster way to answer, so it costs nothing in fidelity. Do not add a click affordance.
 *
 * The drag has to be obvious without reading anything: every tile carries a grip and a grab cursor
 * and sits on its own field like something to pick up, each empty blank is a dashed slot the size of
 * a tile, and a target lights up while a tile is over it. The keyboard path appears as a line of
 * instructions the moment a tile takes keyboard focus.
 *
 * A private internal of the Build a Sentence task module: its one call site is `BuildSentenceTask`.
 * A frameless Item (from a Set banked before Frames existed) is not expected here and gets a notice
 * and a way past it, not a second interaction model to maintain.
 *
 * Fully controlled: the arrangement is a prop, not state. Every interaction resolves the next
 * arrangement and reports it; the caller stores it and hands it back. `BuildSentenceTask` owns it
 * because it has to survive this component being remounted per Item. What moves is the lossless
 * arrangement, one slot per blank; the form a Response is sent in is produced when the Task
 * commits, nowhere here.
 */
export default function SentenceTiles({ item, slots, onSlotsChange, onSkip }: SentenceTilesProps) {
  const segments = useMemo(() => parseFrameOrNull(item.frame), [item.frame]);
  const tileIds = useMemo(() => item.tiles.map(tileIdOf), [item.tiles]);

  // The 8 px activation distance is what makes "drag-only" mean something: a press that never
  // travels that far is not a drag, and it is not anything else either.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor),
  );

  // Every drag (tray to blank, blank to blank, blank back to the tray) is resolved by one pure
  // function, applyTileDrop in sentenceSlotFill.ts, and tiles move no other way. jsdom measures
  // every element as 0×0, so tests drive real drags over a synthetic layout
  // (client/test/buildSentenceDrag.ts) rather than through layout here.
  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    const overId = over ? String(over.id) : null;
    onSlotsChange(applyTileDrop({ activeId: String(active.id), overId, slots }));
  };

  if (!segments) {
    return (
      <Notice
        tone="caution"
        action={
          // Not an alternative way to answer: a way out, so a Set banked before Frames existed does not
          // strand the User in front of Items with nothing to do but sit out the whole pooled budget.
          <Button size="sm" onClick={onSkip}>
            Skip this Item
          </Button>
        }
      >
        This Item has no sentence frame, so there are no blanks to fill. It comes from a Set made before
        sentence frames existed; generate a new Set to practise Build a Sentence.
      </Notice>
    );
  }

  const trayIds = trayTileIds(tileIds, slots);

  return (
    <div className="group space-y-5">
      <DndContext
        sensors={sensors}
        collisionDetection={zoneUnderPointer}
        onDragEnd={handleDragEnd}
        accessibility={{ announcements: ANNOUNCEMENTS, screenReaderInstructions: { draggable: KEYBOARD_INSTRUCTIONS } }}
      >
        {/* Inline flow, not a flex row: this is a sentence, so the blanks wrap with the words around
            them. `whitespace-pre-wrap` keeps the frame's own spacing verbatim; the tall leading
            leaves room for a tile-sized blank inside a line. */}
        <p data-testid="bas-frame" className="whitespace-pre-wrap text-stimulus leading-[2.9] text-ink">
          {segments.map((segment, i) =>
            segment.type === "text" ? (
              <span key={`text-${i}`}>{segment.text}</span>
            ) : (
              <Blank key={`blank-${segment.index}`} index={segment.index} tileId={slots[segment.index] ?? null} />
            ),
          )}
        </p>

        <div className="space-y-2">
          <Kicker as="p">Tiles</Kicker>
          <DropZone id={TRAY_ZONE_ID} testId="bas-tray">
            {trayIds.length === 0 ? (
              <span className="text-meta text-graphite">Every tile is placed. Drag one back here to take it out.</span>
            ) : (
              trayIds.map((id) => <Tile key={id} id={id} placed={false} />)
            )}
          </DropZone>
        </div>
      </DndContext>

      <div className="space-y-1 text-meta text-graphite">
        <p>
          Drag a tile onto the blank you want, and drag it back to the tray to take it out again — the
          same way the exam does it. Not every tile belongs in the sentence.
        </p>
        {/* Shown only while a tile has keyboard focus, so the keyboard path is there when it is
            being used and out of the way when it is not. */}
        <p className="hidden font-medium text-ink-soft group-has-[:focus-visible]:block">{KEYBOARD_INSTRUCTIONS}</p>
      </div>
    </div>
  );
}

/** The tray: a drop target, so a tile dropped on empty space in it goes back. */
function DropZone({ id, testId, children }: { id: string; testId: string; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-testid={testId}
      className={cx(
        "flex min-h-16 flex-wrap items-center gap-2 rounded-sheet border p-3",
        "transition-colors duration-(--duration-quick) ease-quiet",
        isOver ? "border-accent bg-accent-wash" : "border-rule bg-well",
      )}
    >
      {children}
    </div>
  );
}

/** One gap in the frame: a drop target that either holds a tile or shows a dashed, tile-sized slot. */
function Blank({ index, tileId }: { index: number; tileId: string | null }) {
  const { setNodeRef, isOver } = useDroppable({ id: blankZoneId(index) });

  return (
    <span
      ref={setNodeRef}
      role="group"
      aria-label={tileId ? `Blank ${index + 1}, filled with "${tileTextOf(tileId)}"` : `Blank ${index + 1}, empty`}
      data-testid={`bas-blank-${index}`}
      className={cx(
        "mx-0.5 inline-flex min-h-10 min-w-24 items-center justify-center rounded-control align-middle leading-none",
        "transition-colors duration-(--duration-quick) ease-quiet",
        !tileId && "border border-dashed border-rule-strong bg-well",
        isOver && "outline-2 outline-offset-2 outline-accent",
        isOver && !tileId && "border-accent bg-accent-wash",
      )}
    >
      {/* Keyed by the tile, so a swap mounts the arriving tile's own button rather than relabelling
          the one that has focus; dnd-kit then restores keyboard focus to the tile that was moved. */}
      {tileId ? <Tile key={tileId} id={tileId} placed /> : <span aria-hidden="true">{" "}</span>}
    </span>
  );
}

/**
 * One tile, wherever it currently is. The id is the same in the tray and in a blank (a tile is in
 * exactly one place at a time), so a drag that starts in a blank and one that starts in the tray are
 * the same gesture to dnd-kit, and `applyTileDrop` works out which by looking at the arrangement.
 *
 * It is a real `<button>` with no click handler: a press that never travels the sensor's 8 px does
 * nothing. The element is a button so it takes focus and the KeyboardSensor's space bar (dnd-kit's
 * own drag activator) reaches it, not so it can be clicked.
 *
 * `touch-none` (`touch-action: none`) is load-bearing on touch, and it is the app's job rather than
 * dnd-kit's: `useDraggable` returns only role/tabIndex/aria attributes and pointer listeners and sets
 * no `touch-action`. Without it a finger that starts on a tile is claimed by the browser's own
 * pan/scroll gesture, which fires `pointercancel` and aborts the drag before the 8 px activation
 * distance is travelled, leaving a Build a Sentence Item with no way to answer it on a touch device.
 * PointerSensor receives touch pointer events once the browser stops claiming them, so no
 * TouchSensor is needed. The blanks and the tray are `useDroppable` only and need none of this.
 */
function Tile({ id, placed }: { id: string; placed: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id });
  const style = { transform: CSS.Translate.toString(transform) };

  return (
    <button
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      type="button"
      data-testid={`bas-tile-${id}`}
      className={cx(
        "touch-none inline-flex min-h-10 cursor-grab select-none items-center gap-1.5 rounded-control border py-1.5 pr-3 pl-2 text-stimulus leading-none text-ink active:cursor-grabbing pointer-coarse:min-h-11",
        "transition-colors duration-(--duration-quick) ease-quiet",
        placed ? "border-accent-rule bg-accent-wash hover:border-accent" : "border-rule-strong bg-field hover:border-graphite",
        isDragging && "relative z-10 shadow-overlay",
      )}
    >
      <IconGrip size={14} className="shrink-0 text-faint" />
      {tileTextOf(id)}
    </button>
  );
}
