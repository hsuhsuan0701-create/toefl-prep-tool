import { afterEach, beforeEach, vi, type MockInstance } from "vitest";
import { act, screen, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";

/**
 * Driving a Build a Sentence tile the only way the exam offers: by dragging it.
 *
 * A tile has no click handler, so jsdom cannot place one with a click. dnd-kit resolves a drop by
 * measuring the drop targets and picking the one under the pointer (or, for the keyboard, the one
 * nearest the carried tile), and jsdom reports every element as 0×0 at the origin, so with real
 * rects no drop would ever land on anything.
 *
 * So this hands the tiles a synthetic layout (the blanks in a row, the tray below them) and then
 * drives a real pointer drag through it: dnd-kit's own PointerSensor, its 8 px activation
 * constraint, its collision detection and `applyTileDrop`, exactly as the browser runs them.
 * Mocking DndContext and calling its `onDragEnd` by hand would assert the pure function twice over
 * and prove nothing about the wiring in between.
 *
 * Only elements the Build a Sentence screen owns (`data-testid` starting `bas-`) get a synthetic
 * rect; everything else keeps jsdom's own answer, so a page test that also renders an essay editor
 * or a countdown is unaffected.
 */

const BLANK_WIDTH = 80;
const BLANK_PITCH = 100;
const TRAY_TOP = 200;

/** Where the pointer starts: the centre of the stubbed tile rect, wherever the tile currently sits. */
const TILE_CENTRE = { clientX: 40, clientY: TRAY_TOP + 10 };

/**
 * The tray, or the blank at `index` — the two things a tile can be dropped on — or a point in the
 * synthetic layout, for a release that is not at a target's centre (see {@link TILE_DRAG_LAYOUT}).
 */
export type TileDropTarget = "tray" | { blank: number } | { clientX: number; clientY: number };

/** The synthetic layout's boxes, for tests that release a tile at a chosen point. */
export const TILE_DRAG_LAYOUT = {
  tray: { left: 0, top: TRAY_TOP, right: 700, bottom: TRAY_TOP + 60 },
  /** Where every drag starts: the centre of the tile being dragged. */
  tileCentre: TILE_CENTRE,
} as const;

const realGetBoundingClientRect = Element.prototype.getBoundingClientRect;

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    left: x,
    top: y,
    width,
    height,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}

function syntheticRect(element: Element): DOMRect {
  const testId = element.getAttribute("data-testid") ?? "";
  const blank = /^bas-blank-(\d+)$/.exec(testId);
  if (blank) return rect(BLANK_PITCH * Number(blank[1]), 0, BLANK_WIDTH, 20);
  if (testId === "bas-tray") return rect(0, TRAY_TOP, 700, 60);
  // Every tile reports the same rect wherever it is, so a drag always starts at TILE_CENTRE and the
  // pointer's delta carries the tile's collision box exactly onto the target's centre.
  // The copy drawn under the pointer during a drag starts where its tile was, so it reports the tile's
  // rect too; a keyboard drag measures it to find the nearest zone.
  if (testId.startsWith("bas-tile-") || testId === "bas-drag-overlay") return rect(10, TRAY_TOP + 10, 60, 20);
  return realGetBoundingClientRect.call(element);
}

/**
 * Installs the synthetic layout for every test in the block that calls it. Call it once at the top
 * of a file (or a describe) that drags tiles; `dragTile` needs it.
 */
export function installTileDragLayout(): void {
  let layout: MockInstance<() => DOMRect> | null = null;
  beforeEach(() => {
    layout = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        return syntheticRect(this);
      });
  });
  afterEach(() => {
    // Restored one spy at a time rather than through `restoreAllMocks`, which would also strip the
    // implementations the surrounding suite's module mocks were set up with.
    layout?.mockRestore();
    layout = null;
  });
}

function centreOf(target: TileDropTarget): { clientX: number; clientY: number } {
  if (target === "tray") return { clientX: 350, clientY: TRAY_TOP + 30 };
  if ("clientX" in target) return target;
  return { clientX: BLANK_PITCH * target.blank + BLANK_WIDTH / 2, clientY: 10 };
}

/**
 * Drags one tile onto one drop target: the tile named by its accessible text (or handed in as the
 * element itself, for the Sets whose tiles share a text), the target a blank or the tray.
 *
 * The middle move exists to clear the sensor's 8 px activation distance: under it dnd-kit treats
 * the gesture as a click and no drag ever starts, so a press alone places nothing.
 */
export async function dragTile(
  user: ReturnType<typeof userEvent.setup>,
  tile: string | HTMLElement,
  target: TileDropTarget,
): Promise<void> {
  await pickUpTile(user, tile, target);
  await releaseTile(user);
}

/**
 * The first half of {@link dragTile}: presses the tile and carries it to `target` without letting
 * go, for a test about what a drag in progress draws. End it with {@link releaseTile}.
 */
export async function pickUpTile(
  user: ReturnType<typeof userEvent.setup>,
  tile: string | HTMLElement,
  target: TileDropTarget,
): Promise<void> {
  const element = typeof tile === "string" ? screen.getByRole("button", { name: tile }) : tile;
  const to = centreOf(target);
  await user.pointer([
    { keys: "[MouseLeft>]", target: element, coords: TILE_CENTRE },
    { target: element, coords: { clientX: TILE_CENTRE.clientX + 20, clientY: TILE_CENTRE.clientY } },
    { target: element, coords: to },
  ]);
}

/** Lets go of the tile {@link pickUpTile} is carrying, where the pointer is. */
export async function releaseTile(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.pointer({ keys: "[/MouseLeft]" });
  await settleDrag();
}

/**
 * Lets dnd-kit finish tidying up after a drop.
 *
 * A drag arms a capture-phase `click` listener on the document so the click a real pointer emits at
 * the end of a drag is swallowed rather than treated as a second interaction, and dnd-kit takes it
 * off again 50 ms later. Left pending, that listener eats the test's very next click (Submit, Next,
 * Finish) and, if the test ends before the timer fires, every click the rest of the file makes.
 */
async function settleDrag(): Promise<void> {
  const DND_KIT_LISTENER_CLEANUP_MS = 50;
  await act(async () => {
    if (vi.isFakeTimers()) {
      vi.advanceTimersByTime(DND_KIT_LISTENER_CLEANUP_MS + 10);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, DND_KIT_LISTENER_CLEANUP_MS + 10));
  });
}

/** Fills blanks 0, 1, 2… with the tiles named, which is how an answer gets arranged in order. */
export async function dragTilesIntoBlanks(
  user: ReturnType<typeof userEvent.setup>,
  tileTexts: readonly string[],
): Promise<void> {
  for (const [index, text] of tileTexts.entries()) {
    await dragTile(user, text, { blank: index });
  }
}

/**
 * Ends a Build a Sentence Task through its Finish button, answering the confirmation the Task asks
 * when an Item still has an empty blank (BuildSentenceEarlyFinish.test.tsx pins that question). For
 * page tests that are about what happens after the Task ends.
 */
export async function finishBuildSentence(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Finish Build a Sentence" }));
  const dialog = screen.queryAllByRole("dialog", { hidden: true }).find((d) => d.hasAttribute("open"));
  if (dialog) {
    await user.click(within(dialog).getByRole("button", { name: "Finish and hand in", hidden: true }));
  }
}
