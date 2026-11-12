import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SentenceTiles, { type BuildSentenceItem } from "../src/components/buildSentence/SentenceTiles";
import { emptySlotsForFrame, tileIdOf, type SlotFill } from "../src/components/buildSentence/sentenceSlotFill";
import {
  TILE_DRAG_LAYOUT,
  dragTile,
  dragTilesIntoBlanks,
  installTileDragLayout,
  pickUpTile,
  releaseTile,
} from "./buildSentenceDrag";

// The project's own reference Item (server/test/fixtures/build-a-sentence-reference-item.json): six
// blanks, seven tiles, "was" the distractor. The drop arithmetic is covered in
// sentenceSlotFill.test.ts; this file asserts the rendering, the drag wiring that reaches that
// arithmetic, that a tap reaches nothing at all, and the controlled contract its owner relies on:
// the arrangement is supplied, and every change to it is reported rather than kept.
const REFERENCE_ITEM: BuildSentenceItem = {
  id: "bas-ref-1",
  prompt: "How did the museum visit go?",
  frame: "The ___ ___ ___ ___ ___ ___ wonderful.",
  tiles: ["were", "the", "was", "new wing", "led us through", "who", "volunteers"],
};

// Only the four this file names in assertions; the holes are the tiles it only ever drags by text.
const [WERE, , , , LED, WHO, VOLUNTEERS] = REFERENCE_ITEM.tiles.map(tileIdOf);

/** The reference answer, in blank order. */
const REFERENCE_ANSWER = ["volunteers", "who", "led us through", "the", "new wing", "were"];

/**
 * The smallest possible owner of the arrangement. The component holds none of its own; in the app
 * `BuildSentenceTask` keeps it in its run state for both the Writing Drill and the Writing
 * Simulation. Interactions are driven through this so a test exercises the same loop the real owner
 * does: report the new arrangement, store it, hand it back.
 */
function ControlledTiles({
  item,
  onSkip = vi.fn(),
  onSlotsChange,
}: {
  item: BuildSentenceItem;
  onSkip?: () => void;
  onSlotsChange?: (slots: SlotFill) => void;
}) {
  const [slots, setSlots] = useState<SlotFill>(() => emptySlotsForFrame(item.frame));
  return (
    <SentenceTiles
      item={item}
      slots={slots}
      onSlotsChange={(next) => {
        onSlotsChange?.(next);
        setSlots(next);
      }}
      onSkip={onSkip}
    />
  );
}

describe("SentenceTiles", () => {
  installTileDragLayout();

  it("renders the frame's fixed text with a blank at each gap, in order", () => {
    render(<ControlledTiles item={REFERENCE_ITEM} />);

    expect(screen.getByTestId("bas-frame")).toHaveTextContent(/^The\s+wonderful\.$/);
    expect(screen.getAllByRole("group")).toHaveLength(6);
    expect(screen.getByLabelText("Blank 1, empty")).toBeInTheDocument();
    expect(screen.getByLabelText("Blank 6, empty")).toBeInTheDocument();
    expect(screen.queryByLabelText("Blank 7, empty")).not.toBeInTheDocument();
    // All seven tiles start in the tray, distractor included.
    expect(screen.getByRole("button", { name: "was" })).toBeInTheDocument();
  });

  it("draws a supplied arrangement into the blanks it names and leaves the rest in the tray", () => {
    render(
      <SentenceTiles
        item={REFERENCE_ITEM}
        slots={[VOLUNTEERS, null, LED, null, null, WERE]}
        onSlotsChange={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(screen.getByTestId("bas-blank-0")).toHaveTextContent("volunteers");
    expect(screen.getByTestId("bas-blank-2")).toHaveTextContent("led us through");
    expect(screen.getByTestId("bas-blank-5")).toHaveTextContent("were");
    // The empty blanks stay where the arrangement put them: three tiles do not arrive packed into
    // blanks 0-2. This is the whole reason the arrangement travels in its lossless form.
    expect(screen.getByLabelText("Blank 2, empty")).toBeInTheDocument();
    expect(screen.getByLabelText("Blank 4, empty")).toBeInTheDocument();
    expect(screen.getByLabelText("Blank 5, empty")).toBeInTheDocument();

    const tray = within(screen.getByTestId("bas-tray"));
    expect(tray.getAllByRole("button").map((tile) => tile.textContent)).toEqual([
      "the",
      "was",
      "new wing",
      "who",
    ]);
  });

  it("puts a dragged tray tile in the blank it was dropped on, not in the next empty one", async () => {
    const user = userEvent.setup();
    render(<ControlledTiles item={REFERENCE_ITEM} />);

    await dragTile(user, "were", { blank: 5 });

    expect(screen.getByTestId("bas-blank-5")).toHaveTextContent("were");
    expect(screen.getByLabelText("Blank 1, empty")).toBeInTheDocument();
    expect(within(screen.getByTestId("bas-tray")).queryByRole("button", { name: "were" })).not.toBeInTheDocument();
  });

  it("swaps when a tile is dropped on a filled blank, and returns one dragged back to the tray", async () => {
    const user = userEvent.setup();
    render(<ControlledTiles item={REFERENCE_ITEM} />);

    await dragTile(user, "who", { blank: 0 });
    await dragTile(user, "volunteers", { blank: 1 });

    // Blank to blank, onto an occupied blank: the two tiles exchange blanks in one gesture.
    await dragTile(user, "who", { blank: 1 });
    expect(screen.getByTestId("bas-blank-0")).toHaveTextContent("volunteers");
    expect(screen.getByTestId("bas-blank-1")).toHaveTextContent("who");

    // …and back to the tray, which is the only way a placed tile comes out.
    await dragTile(user, "who", "tray");
    expect(screen.getByLabelText("Blank 2, empty")).toBeInTheDocument();
    expect(within(screen.getByTestId("bas-tray")).getByRole("button", { name: "who" })).toBeInTheDocument();
  });

  // The zone under the pointer decides, not the zone whose centre is nearest the tile: the tray is
  // wide, so its centre is often farther from a point inside it than a blank's centre is.
  it("returns a tile released anywhere inside the tray, even nearer a blank's centre than the tray's", async () => {
    const user = userEvent.setup();
    render(<ControlledTiles item={REFERENCE_ITEM} />);
    const { tray } = TILE_DRAG_LAYOUT;

    await dragTile(user, "who", { blank: 5 });
    await dragTile(user, "who", { clientX: tray.right - 10, clientY: tray.bottom - 5 });
    expect(screen.getByLabelText("Blank 6, empty")).toBeInTheDocument();
    expect(within(screen.getByTestId("bas-tray")).getByRole("button", { name: "who" })).toBeInTheDocument();

    await dragTile(user, "who", { blank: 3 });
    await dragTile(user, "who", { clientX: tray.left + 5, clientY: tray.bottom - 5 });
    expect(screen.getByLabelText("Blank 4, empty")).toBeInTheDocument();
    expect(screen.getByLabelText("Blank 1, empty")).toBeInTheDocument();
    expect(within(screen.getByTestId("bas-tray")).getByRole("button", { name: "who" })).toBeInTheDocument();
  });

  it("places nothing when a drag starts and ends inside the tray", async () => {
    const user = userEvent.setup();
    const onSlotsChange = vi.fn();
    render(<ControlledTiles item={REFERENCE_ITEM} onSlotsChange={onSlotsChange} />);
    const { tileCentre } = TILE_DRAG_LAYOUT;

    // A 12 px nudge: past the 8 px activation distance, so it is a drag, but it never leaves the tray.
    await dragTile(user, "were", { clientX: tileCentre.clientX + 12, clientY: tileCentre.clientY });

    expect(onSlotsChange).not.toHaveBeenCalledWith(expect.arrayContaining([WERE]));
    expect(screen.getByLabelText("Blank 1, empty")).toBeInTheDocument();
    expect(within(screen.getByTestId("bas-tray")).getByRole("button", { name: "were" })).toBeInTheDocument();
  });

  it("leaves the arrangement as it was when a tile is released outside the sentence and the tray", async () => {
    const user = userEvent.setup();
    render(<ControlledTiles item={REFERENCE_ITEM} />);
    await dragTile(user, "who", { blank: 2 });

    await dragTile(user, "who", { clientX: 900, clientY: 600 }); // a placed tile
    await dragTile(user, "were", { clientX: 900, clientY: 600 }); // a tray tile

    expect(screen.getByTestId("bas-blank-2")).toHaveTextContent("who");
    for (const blank of [1, 2, 4, 5, 6]) expect(screen.getByLabelText(`Blank ${blank}, empty`)).toBeInTheDocument();
    expect(within(screen.getByTestId("bas-tray")).getByRole("button", { name: "were" })).toBeInTheDocument();
  });

  // The real exam places tiles by dragging and offers no tap, and tapping is a speed habit that
  // mis-calibrates pacing practice. A press that never travels far enough to start a drag leaves the
  // arrangement exactly where it was.
  it("ignores a tap on a tray tile, on a placed tile and on a filled blank", async () => {
    const user = userEvent.setup();
    const onSlotsChange = vi.fn();
    render(
      <SentenceTiles
        item={REFERENCE_ITEM}
        slots={[VOLUNTEERS, null, null, null, null, null]}
        onSlotsChange={onSlotsChange}
        onSkip={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId(`bas-tile-${WHO}`)); // a tray tile: fills nothing
    await user.click(screen.getByTestId(`bas-tile-${VOLUNTEERS}`)); // a placed tile: returns nothing
    await user.click(screen.getByTestId("bas-blank-0")); // the blank around it: returns nothing

    expect(onSlotsChange).not.toHaveBeenCalled();
    expect(screen.getByTestId("bas-blank-0")).toHaveTextContent("volunteers");
    expect(screen.getByLabelText("Blank 2, empty")).toBeInTheDocument();
    expect(within(screen.getByTestId("bas-tray")).getByTestId(`bas-tile-${WHO}`)).toBeInTheDocument();
  });

  it("tells the User to drag, and never to tap — with the tray full or empty", () => {
    const { unmount } = render(<ControlledTiles item={REFERENCE_ITEM} />);

    expect(screen.getByText(/^Drag a tile onto the blank you want/)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/tap/i);
    unmount();

    // The emptied tray says its own thing, and it must not offer a tap either. It only ever empties
    // on an Item with no distractor, so this is one of those rather than the reference Item.
    const noDistractor: BuildSentenceItem = { ...REFERENCE_ITEM, frame: "___ ___ good.", tiles: ["the", "food"] };
    render(
      <SentenceTiles
        item={noDistractor}
        slots={noDistractor.tiles.map(tileIdOf)}
        onSlotsChange={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    expect(within(screen.getByTestId("bas-tray")).getByText(/Drag one back here/)).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toMatch(/tap/i);
  });

  // Every draggable tile carries `touch-none`, in the tray and in a blank alike. The check is
  // structural because jsdom cannot exercise a finger being claimed by the browser's pan gesture.
  // `useDraggable` sets no `touch-action`, so without this class a touch drag is cancelled by
  // `pointercancel` before it activates, and a Build a Sentence Item cannot be answered on a touch
  // device at all.
  it("marks every draggable tile touch-action:none, so a touch drag is not claimed as a pan", () => {
    render(
      <SentenceTiles
        item={REFERENCE_ITEM}
        slots={[VOLUNTEERS, null, null, null, null, null]}
        onSlotsChange={vi.fn()}
        onSkip={vi.fn()}
      />,
    );

    const tiles = REFERENCE_ITEM.tiles.map(tileIdOf).map((id) => screen.getByTestId(`bas-tile-${id}`));
    expect(tiles).toHaveLength(7);
    for (const tile of tiles) {
      expect(tile.className.split(/\s+/u)).toContain("touch-none");
    }
    // Including the one sitting in a blank, which is the same component in the other place.
    expect(within(screen.getByTestId("bas-blank-0")).getByTestId(`bas-tile-${VOLUNTEERS}`).className)
      .toContain("touch-none");
  });

  // A tile moved by a transform on itself counts towards the page's scrollable size, so one held at
  // the window's right or bottom edge let auto-scroll grow the page without limit. jsdom has no
  // layout to scroll, so this checks the structure that prevents it: the tile under the pointer is a
  // fixed copy outside the component's own tree, and the tile itself does not move.
  it("draws the tile under the pointer as a fixed copy outside the page flow, not by moving the tile", async () => {
    const user = userEvent.setup();
    const { container } = render(<ControlledTiles item={REFERENCE_ITEM} />);

    await pickUpTile(user, "who", { blank: 1 });

    const copy = screen.getByTestId("bas-drag-overlay");
    expect(copy).toHaveTextContent("who");
    expect(copy).toHaveAttribute("aria-hidden", "true");
    expect(container).not.toContainElement(copy);
    expect(copy.parentElement).toHaveStyle({ position: "fixed" });
    expect(screen.getByTestId(`bas-tile-${WHO}`).style.transform).toBe("");

    await releaseTile(user);
    expect(screen.queryByTestId("bas-drag-overlay")).not.toBeInTheDocument();
    expect(screen.getByTestId("bas-blank-1")).toHaveTextContent("who");
  });

  // The Response itself is produced when the Task commits (buildSentenceRun.ts, via blankOrderTexts);
  // what this component owes it is the arrangement, blank by blank, in the order the blanks run.
  it("arranges the tiles into the blanks in blank order", async () => {
    const user = userEvent.setup();
    const onSlotsChange = vi.fn();
    render(<ControlledTiles item={REFERENCE_ITEM} onSlotsChange={onSlotsChange} />);

    await dragTilesIntoBlanks(user, REFERENCE_ANSWER);

    expect(onSlotsChange).toHaveBeenLastCalledWith(
      REFERENCE_ANSWER.map((text) => tileIdOf(text, REFERENCE_ITEM.tiles.indexOf(text))),
    );
    REFERENCE_ANSWER.forEach((text, blank) => expect(screen.getByTestId(`bas-blank-${blank}`)).toHaveTextContent(text));
  });

  it("reports every arrangement change in its lossless form, so which blanks are empty survives", async () => {
    const user = userEvent.setup();
    const onSlotsChange = vi.fn();
    render(<ControlledTiles item={REFERENCE_ITEM} onSlotsChange={onSlotsChange} />);

    // Nothing is reported before the User touches anything: the caller seeded the empty arrangement
    // itself, so the component has nothing to announce on mount.
    expect(onSlotsChange).not.toHaveBeenCalled();

    await dragTile(user, "volunteers", { blank: 0 });
    expect(onSlotsChange).toHaveBeenLastCalledWith([VOLUNTEERS, null, null, null, null, null]);

    await dragTile(user, "were", { blank: 1 });
    expect(onSlotsChange).toHaveBeenLastCalledWith([VOLUNTEERS, WERE, null, null, null, null]);

    // Returning a tile is a change too — and the blank it empties keeps its position. The submission
    // form would report ["were"] here, losing the fact that blank 0 rather than blank 1 is the empty
    // one, which is why the caller is handed this form instead.
    await dragTile(user, "volunteers", "tray");
    expect(onSlotsChange).toHaveBeenLastCalledWith([null, WERE, null, null, null, null]);
  });

  it("reports an interaction rather than acting on it, so nothing moves until the caller says so", async () => {
    const user = userEvent.setup();
    const onSlotsChange = vi.fn();
    const supplied: SlotFill = [VOLUNTEERS, null, null, null, null, null];
    render(
      <SentenceTiles item={REFERENCE_ITEM} slots={supplied} onSlotsChange={onSlotsChange} onSkip={vi.fn()} />,
    );

    await dragTile(user, screen.getByTestId(`bas-tile-${WHO}`), { blank: 1 });

    expect(onSlotsChange).toHaveBeenCalledWith([VOLUNTEERS, WHO, null, null, null, null]);
    // The supplied arrangement is neither mutated nor shadowed by one of the component's own: this
    // owner never hands the reported arrangement back, so the tile is still sitting in the tray.
    expect(supplied).toEqual([VOLUNTEERS, null, null, null, null, null]);
    expect(screen.getByTestId("bas-blank-1")).toHaveTextContent("");
    expect(within(screen.getByTestId("bas-tray")).getByTestId(`bas-tile-${WHO}`)).toBeInTheDocument();
  });

  // The keyboard path: Space picks the focused tile up, each arrow press carries it 25 px over the
  // synthetic layout, Space drops it. Whatever the move, the next key press must act on the tile the
  // User just moved, so focus has to land on it wherever it went.
  it("keeps focus on the tile moved by keyboard: into an empty blank, onto a filled one, and back", async () => {
    const user = userEvent.setup();
    render(<ControlledTiles item={REFERENCE_ITEM} />);
    await dragTile(user, "who", { blank: 0 });
    await dragTile(user, "volunteers", { blank: 1 });
    const tileWith = (id: string) => screen.getByTestId(`bas-tile-${id}`);

    // Blank 2 onto the filled blank 1: the two tiles swap, and focus goes with "volunteers".
    tileWith(VOLUNTEERS).focus();
    await user.keyboard(`[Space]${"[ArrowUp]".repeat(9)}[Space]`);
    expect(screen.getByTestId("bas-blank-0")).toHaveTextContent("volunteers");
    expect(screen.getByTestId("bas-blank-1")).toHaveTextContent("who");
    await waitFor(() => expect(document.activeElement).toBe(tileWith(VOLUNTEERS)));

    // From the tray into the empty blank 3.
    tileWith(LED).focus();
    await user.keyboard(`[Space]${"[ArrowUp]".repeat(9)}${"[ArrowRight]".repeat(8)}[Space]`);
    expect(screen.getByTestId("bas-blank-2")).toHaveTextContent("led us through");
    await waitFor(() => expect(document.activeElement).toBe(tileWith(LED)));

    // And from blank 1 back to the tray.
    tileWith(VOLUNTEERS).focus();
    await user.keyboard(`[Space]${"[ArrowRight]".repeat(12)}[Space]`);
    expect(within(screen.getByTestId("bas-tray")).getByTestId(`bas-tile-${VOLUNTEERS}`)).toBeInTheDocument();
    await waitFor(() => expect(document.activeElement).toBe(tileWith(VOLUNTEERS)));
  });

  it("keeps duplicate tile texts distinguishable", async () => {
    const user = userEvent.setup();
    const item: BuildSentenceItem = {
      ...REFERENCE_ITEM,
      frame: "___ ___ ___ good.",
      tiles: ["the", "food", "the"],
    };
    const onSlotsChange = vi.fn();
    render(<ControlledTiles item={item} onSlotsChange={onSlotsChange} />);

    // Two tiles read "the"; only their index-stable ids tell them apart, so they are dragged as
    // elements rather than by name.
    await dragTile(user, screen.getByTestId("bas-tile-the#0"), { blank: 0 });
    await dragTile(user, screen.getByTestId("bas-tile-food#1"), { blank: 1 });
    await dragTile(user, screen.getByTestId("bas-tile-the#2"), { blank: 2 });

    expect(within(screen.getByTestId("bas-blank-0")).getByTestId("bas-tile-the#0")).toBeInTheDocument();
    expect(within(screen.getByTestId("bas-blank-2")).getByTestId("bas-tile-the#2")).toBeInTheDocument();

    // Returning one leaves the other in place, rather than both collapsing into one tile.
    await dragTile(user, screen.getByTestId("bas-tile-the#0"), "tray");
    expect(screen.getByTestId("bas-blank-0")).toHaveTextContent("");
    expect(screen.getByTestId("bas-blank-2")).toHaveTextContent("the");

    await dragTile(user, screen.getByTestId("bas-tile-the#0"), { blank: 0 });
    expect(onSlotsChange).toHaveBeenLastCalledWith(["the#0", "food#1", "the#2"]);
  });

  it("shows a notice instead of an interactive Item when the Item has no frame", async () => {
    const user = userEvent.setup();
    const onSkip = vi.fn();
    const { frame: _frame, ...frameless } = REFERENCE_ITEM;
    render(<ControlledTiles item={frameless} onSkip={onSkip} />);

    expect(screen.getByText(/no sentence frame/i)).toHaveTextContent("It comes from a Set made before sentence frames existed");
    expect(screen.queryByTestId("bas-frame")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "was" })).not.toBeInTheDocument();

    // The way out of a Set made before sentence frames existed, not a second way to answer one.
    await user.click(screen.getByRole("button", { name: "Skip this Item" }));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });
});
