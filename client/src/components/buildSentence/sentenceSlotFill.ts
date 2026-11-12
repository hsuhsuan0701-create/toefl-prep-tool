import { parseSentenceFrame, type SentenceFrameSegment } from "@toefl-prep/shared";

/**
 * Where each of a frame Item's tiles currently sits.
 *
 * A Build a Sentence Item with a Frame is a fixed sentence with holes in it, and the User's answer
 * is which tile is in which hole. So the whole arrangement is one array indexed by blank: `slots[i]`
 * is the id of the tile filling blank `i`, or `null` while that blank is empty. The tray is not
 * stored at all; it is derived (see {@link trayTileIds}), which is what makes "put this tile back"
 * unambiguous: a returned tile can only land in its original tray position, so the tray never
 * reshuffles under a User who is experimenting, and no code path can leave a tile in a blank and in
 * the tray at once.
 *
 * A private internal of the Build a Sentence task module; nothing outside this directory imports it.
 *
 * This lives beside the component rather than inside it because a dnd-kit pointer drag needs real
 * layout measurements, which jsdom does not have. As pure functions, every drop outcome is tested
 * directly, without layout.
 */
export type SlotFill = readonly (string | null)[];

/**
 * The tray's drop zone, and one drop zone per blank.
 *
 * `applyTileDrop` tells a drop target from a dragged tile by comparing ids, so the two namespaces
 * must not meet: a tile id always ends in `#<tile index>` (see {@link tileIdOf}) and a zone id never
 * contains `#`.
 */
export const TRAY_ZONE_ID = "zone:tray";

const BLANK_ZONE_PREFIX = "blank:";

/** The drop-zone id for blank `index`. */
export function blankZoneId(index: number): string {
  return `${BLANK_ZONE_PREFIX}${index}`;
}

/** The blank a drop-zone id names, or `null` for the tray zone or anything unrecognised. */
export function blankIndexOfZone(zoneId: string): number | null {
  if (!zoneId.startsWith(BLANK_ZONE_PREFIX)) return null;
  const index = Number(zoneId.slice(BLANK_ZONE_PREFIX.length));
  return Number.isInteger(index) && index >= 0 ? index : null;
}

/**
 * Tile ids are index-stable (`${text}#${index}`) because a Set may legitimately offer the same tile
 * text twice — "the" appears twice in plenty of sentences — and two tiles that share an id would
 * become the same tile the moment one of them moved.
 */
export function tileIdOf(text: string, index: number): string {
  return `${text}#${index}`;
}

/** The tile text behind an id. Everything the server is told is text; ids are render-local. */
export function tileTextOf(tileId: string): string {
  return tileId.slice(0, tileId.lastIndexOf("#"));
}

/** How many blanks a parsed frame draws. */
export function blankCountOf(segments: SentenceFrameSegment[]): number {
  return segments.reduce((count, segment) => (segment.type === "blank" ? count + 1 : count), 0);
}

/**
 * An Item's frame as drawable segments, or `null` when it has none or it does not parse.
 *
 * A frame that reaches an Attempt always parses: `BuildASentenceItemSchema` rejects one that does
 * not, and the server's `readSet` does not serve a Set that fails to parse. Caught anyway because a
 * throw would blank the page mid-Attempt, and the frameless notice `SentenceTiles` draws instead is
 * a better failure. Lives here rather than in the component because `BuildSentenceTask` owns the
 * arrangement (see {@link emptySlotsForFrame}) and must count an Item's blanks the same way the
 * component draws them.
 */
export function parseFrameOrNull(frame: string | undefined): SentenceFrameSegment[] | null {
  if (frame === undefined) return null;
  try {
    return parseSentenceFrame(frame);
  } catch {
    return null;
  }
}

/** The opening arrangement: every blank empty, every tile in the tray. */
export function emptyBlanks(blankCount: number): SlotFill {
  return Array.from({ length: blankCount }, () => null);
}

/**
 * The opening arrangement for one Item: an empty slot per blank its frame draws, and no slots at
 * all for a frameless Item, which has nothing to arrange.
 *
 * The length is load-bearing, not cosmetic: `applyTileDrop` resolves against the slots that exist,
 * so an arrangement seeded too short would silently swallow every drop past its end.
 */
export function emptySlotsForFrame(frame: string | undefined): SlotFill {
  const segments = parseFrameOrNull(frame);
  return emptyBlanks(segments ? blankCountOf(segments) : 0);
}

/**
 * An arrangement as tile texts per blank: the form that survives the tray being re-served, since
 * the server re-draws the tray's order on every request and tile ids carry a tray index.
 */
export function slotTextsOf(slots: SlotFill): (string | null)[] {
  return slots.map((tileId) => (tileId === null ? null : tileTextOf(tileId)));
}

/**
 * The inverse of {@link slotTextsOf} against a tray served afresh: each text is matched to the first
 * tile carrying that text that no earlier blank already took, so a word offered twice fills two
 * blanks with two different tiles. A text the tray no longer offers leaves its blank empty.
 */
export function slotsFromTexts(tiles: readonly string[], texts: readonly (string | null)[], blankCount: number): SlotFill {
  const taken = new Set<number>();
  return Array.from({ length: blankCount }, (_, blank) => {
    const text = texts[blank] ?? null;
    if (text === null) return null;
    const index = tiles.findIndex((tile, i) => tile === text && !taken.has(i));
    if (index === -1) return null;
    taken.add(index);
    return tileIdOf(text, index);
  });
}

/**
 * The tiles still in the tray: every tile not currently in a blank, in the Item's own tile order.
 *
 * Derived rather than stored, so a tile returned from a blank goes back where it came from.
 */
export function trayTileIds(allTileIds: string[], slots: SlotFill): string[] {
  return allTileIds.filter((id) => !slots.includes(id));
}

/**
 * Resolves one drag into the next arrangement: the one way an arrangement changes.
 *
 * There is deliberately no tap-to-fill or tap-to-clear: the real exam places tiles by dragging and
 * nothing else, and tapping the next blank is a speed habit it does not offer. A caller that wants a
 * tile in a blank is describing a drop.
 *
 * `activeId` is always a tile id; `overId` is a drop zone — a blank or the tray — or `null` when the
 * drop missed everything. A tile is in exactly one place at a time, so where it came from is read
 * off `slots`: found means it was in that blank, not found means it was in the tray.
 *
 * Dropping onto a filled blank swaps: from another blank the two tiles exchange blanks (a
 * one-gesture fix for two tiles in the wrong order), and from the tray the occupant is displaced
 * back to the tray. Returns the same array whenever nothing moves.
 */
export function applyTileDrop(input: { activeId: string; overId: string | null; slots: SlotFill }): SlotFill {
  const { activeId, overId, slots } = input;
  if (overId === null) return slots;

  const from = slots.indexOf(activeId);

  if (overId === TRAY_ZONE_ID) {
    return from === -1 ? slots : withTile(slots, from, null);
  }

  const to = blankIndexOfZone(overId);
  if (to === null || to >= slots.length || to === from) return slots;

  const next = [...slots];
  next[to] = activeId;
  if (from !== -1) next[from] = slots[to]; // swap; `slots[to]` may be null, which empties it
  return next;
}

/**
 * The Response as it is sent: tile texts in blank order.
 *
 * Empty blanks are skipped rather than reported as gaps, because this is also what the caller hands
 * to the server when the Task's pooled budget expires on a half-finished arrangement — a partial
 * answer is scored as the wrong order, which it is, and the answer key is a plain array of tile
 * texts.
 *
 * Lossy, therefore, and deliberately called only at commit time: which blanks were empty is gone
 * from the result, so an arrangement kept in this form and put back on screen would come back with
 * its tiles shifted left. Everything upstream of a commit (the run state, and the Simulation's draft
 * as tile texts per blank) keeps one entry per blank.
 */
export function blankOrderTexts(slots: SlotFill): string[] {
  return slots.filter((id): id is string => id !== null).map(tileTextOf);
}

function withTile(slots: SlotFill, index: number, tileId: string | null): SlotFill {
  const next = [...slots];
  next[index] = tileId;
  return next;
}
