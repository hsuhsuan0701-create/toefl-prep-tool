import { describe, expect, it } from "vitest";
import { parseSentenceFrame } from "@toefl-prep/shared";
import {
  TRAY_ZONE_ID,
  applyTileDrop,
  blankCountOf,
  blankOrderTexts,
  blankZoneId,
  emptyBlanks,
  emptySlotsForFrame,
  slotTextsOf,
  slotsFromTexts,
  tileIdOf,
  tileTextOf,
  trayTileIds,
} from "../src/components/buildSentence/sentenceSlotFill";

// The project's own reference Item, in frame form
// (server/test/fixtures/build-a-sentence-reference-item.json): six blanks, seven tiles, "was" the
// distractor that never gets placed.
const FRAME = "The ___ ___ ___ ___ ___ ___ wonderful.";
const TILE_TEXTS = ["were", "the", "was", "new wing", "led us through", "who", "volunteers"];
const TILE_IDS = TILE_TEXTS.map(tileIdOf);
const [WERE, THE, WAS, NEW_WING, LED, WHO, VOLUNTEERS] = TILE_IDS;

const blanks = () => emptyBlanks(blankCountOf(parseSentenceFrame(FRAME)));

describe("tile ids", () => {
  it("keeps duplicate tile texts distinguishable and never collides with a drop-zone id", () => {
    const duplicated = ["the", "new wing", "the"].map(tileIdOf);

    expect(new Set(duplicated).size).toBe(3);
    expect(duplicated.map(tileTextOf)).toEqual(["the", "new wing", "the"]);
    // Zone ids are matched against tile ids in applyTileDrop, so the two namespaces must not meet.
    expect(duplicated).not.toContain(TRAY_ZONE_ID);
    expect(duplicated).not.toContain(blankZoneId(0));
  });
});

describe("blankCountOf", () => {
  it("counts the frame's blanks, ignoring its literal runs", () => {
    expect(blankCountOf(parseSentenceFrame(FRAME))).toBe(6);
    expect(blankCountOf(parseSentenceFrame("___ wonderful."))).toBe(1);
  });
});

describe("emptySlotsForFrame", () => {
  it("opens one empty slot per blank — the arrangement the Drill and the Simulation seed an Item with", () => {
    expect(emptySlotsForFrame(FRAME)).toEqual([null, null, null, null, null, null]);
  });

  it("opens nothing for a frameless Item, or one whose frame does not parse", () => {
    // The retired frameless Sets, which get a notice rather than blanks. Length matters: a caller
    // seeding an arrangement shorter than the Item's blanks would silently swallow every drop.
    expect(emptySlotsForFrame(undefined)).toEqual([]);
    expect(emptySlotsForFrame("no blanks at all.")).toEqual([]);
  });
});

describe("trayTileIds", () => {
  it("holds every tile not currently in a blank, in the Item's own tile order", () => {
    const slots = [VOLUNTEERS, WHO, null, null, null, null];

    // Not placement order: returning a tile puts it back where it came from, so the tray never
    // reshuffles under a User who is experimenting.
    expect(trayTileIds(TILE_IDS, slots)).toEqual([WERE, THE, WAS, NEW_WING, LED]);
  });

  it("returns a tile to its original tray position rather than the end", () => {
    let slots = blanks();
    slots = applyTileDrop({ activeId: THE, overId: blankZoneId(0), slots });
    slots = applyTileDrop({ activeId: WERE, overId: blankZoneId(1), slots });
    slots = applyTileDrop({ activeId: WERE, overId: TRAY_ZONE_ID, slots }); // "were" is dragged back

    expect(trayTileIds(TILE_IDS, slots)).toEqual([WERE, WAS, NEW_WING, LED, WHO, VOLUNTEERS]);
  });

  it("keeps duplicate texts apart — placing one leaves the other in the tray", () => {
    const ids = ["the", "new wing", "the"].map(tileIdOf);
    const tray = trayTileIds(ids, [ids[0], null]);

    expect(tray).toEqual([ids[1], ids[2]]);
    expect(tray.map(tileTextOf)).toEqual(["new wing", "the"]);
  });
});

describe("applyTileDrop", () => {
  it("drops a tray tile into the specific blank it was dragged onto, not the next empty one", () => {
    const next = applyTileDrop({ activeId: WERE, overId: blankZoneId(5), slots: blanks() });

    expect(next[5]).toBe(WERE);
    expect(next.slice(0, 5)).toEqual([null, null, null, null, null]);
  });

  it("displaces the occupant of a filled blank back to the tray when the drag came from the tray", () => {
    const slots = [WAS, null, null, null, null, null];
    const next = applyTileDrop({ activeId: WERE, overId: blankZoneId(0), slots });

    expect(next[0]).toBe(WERE);
    expect(trayTileIds(TILE_IDS, next)).toContain(WAS);
  });

  it("swaps the two tiles when a blank's tile is dropped onto another filled blank", () => {
    const slots = [WERE, WHO, null, null, null, null];
    const next = applyTileDrop({ activeId: WERE, overId: blankZoneId(1), slots });

    expect(next.slice(0, 2)).toEqual([WHO, WERE]);
  });

  it("moves a blank's tile into an empty blank, emptying the one it left", () => {
    const slots = [WERE, null, null, null, null, null];
    const next = applyTileDrop({ activeId: WERE, overId: blankZoneId(3), slots });

    expect(next).toEqual([null, null, null, WERE, null, null]);
  });

  it("returns a blank's tile to the tray when dropped on the tray", () => {
    const slots = [WERE, WHO, null, null, null, null];
    const next = applyTileDrop({ activeId: WERE, overId: TRAY_ZONE_ID, slots });

    expect(next).toEqual([null, WHO, null, null, null, null]);
    expect(trayTileIds(TILE_IDS, next)).toContain(WERE);
  });

  it("is a no-op for a missed drop, a drop on the tile's own blank, a tray-to-tray drop, or an unknown target", () => {
    const slots = [WERE, null, null, null, null, null];

    expect(applyTileDrop({ activeId: WERE, overId: null, slots })).toBe(slots);
    expect(applyTileDrop({ activeId: WERE, overId: blankZoneId(0), slots })).toBe(slots);
    expect(applyTileDrop({ activeId: WHO, overId: TRAY_ZONE_ID, slots })).toBe(slots);
    expect(applyTileDrop({ activeId: WHO, overId: "zone:nonsense", slots })).toBe(slots);
    expect(applyTileDrop({ activeId: WHO, overId: blankZoneId(99), slots })).toBe(slots);
  });
});

describe("blankOrderTexts", () => {
  it("submits tile texts in blank order, which is the shape of the answer key", () => {
    const slots = [VOLUNTEERS, WHO, LED, THE, NEW_WING, WERE];

    expect(blankOrderTexts(slots)).toEqual([
      "volunteers",
      "who",
      "led us through",
      "the",
      "new wing",
      "were",
    ]);
  });

  it("skips empty blanks, so a timer-expiry auto-submit reports the partial arrangement", () => {
    expect(blankOrderTexts([VOLUNTEERS, null, LED, null, null, null])).toEqual([
      "volunteers",
      "led us through",
    ]);
    expect(blankOrderTexts(blanks())).toEqual([]);
  });
});

describe("an arrangement across a re-served tray", () => {
  // GET /api/sets/:id serves the tiles in a fresh order on every request, so a draft that survives a
  // reload must be held as tile texts and matched back onto whatever order the tray comes back in.
  it("round-trips through tile texts onto a tray served in a different order", () => {
    const before = ["was", "the", "the", "volunteers"];
    const slots = [tileIdOf("the", 2), null, tileIdOf("volunteers", 3), tileIdOf("the", 1)];
    const texts = slotTextsOf(slots);
    expect(texts).toEqual(["the", null, "volunteers", "the"]);

    const after = ["the", "volunteers", "was", "the"];
    const restored = slotsFromTexts(after, texts, 4);
    // Each "the" lands on its own tile — never the same tile twice — and the empty blank stays empty.
    expect(restored).toEqual([tileIdOf("the", 0), null, tileIdOf("volunteers", 1), tileIdOf("the", 3)]);
    expect(blankOrderTexts(restored)).toEqual(blankOrderTexts(slots));
    expect(before).toHaveLength(after.length);
  });

  it("leaves a blank empty when the tray no longer offers its text, and fits the frame's blank count", () => {
    expect(slotsFromTexts(["a", "b"], ["c", "a", "b"], 2)).toEqual([null, tileIdOf("a", 0)]);
  });
});
