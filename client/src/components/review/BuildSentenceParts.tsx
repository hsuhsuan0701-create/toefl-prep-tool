import { Chip } from "../../ui/Chip";
import { sentenceAnswerParts, sentenceBlankCount } from "../sentenceAnswerText";

// What a Build a Sentence Item looks like once it is answered, drawn the same way on Attempt review
// and on the Writing Drill's results: the sentence with the placed tiles boxed apart from the words
// the Frame prints, and the tiles the Item offered. The run's own tile components are internal to
// components/buildSentence/, so review draws its own.

/** Said once above a group's Items, so the boxes need no legend of their own. */
export const PLACED_WORDS_NOTE = "Boxed words are tiles placed in the blanks; the other words are printed in the sentence.";

/**
 * A Response or a key arrangement as the sentence it is. Each placed tile is boxed (a border, not a
 * colour, so it still reads in greyscale and in forced colours); the Frame's words and an empty
 * blank's marker are plain text. Its text content is exactly sentenceAnswerText's.
 */
export function ComposedSentence({ frame, tiles }: { frame: string | undefined; tiles: readonly string[] }) {
  return (
    <>
      {sentenceAnswerParts(frame, tiles).map((part, i) =>
        part.kind === "placed" ? (
          <span key={i} data-placed="" className="rounded-chip border border-rule-strong px-1 box-decoration-clone">
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  );
}

/**
 * The User's Response to one Item, as review can truthfully show it.
 *
 * A Response is stored as tile texts in blank order with the empty blanks dropped
 * (`blankOrderTexts`), so a Response shorter than the Item's blank count no longer says which blanks
 * its tiles were in. Composing it would put them in the first blanks, an arrangement the User may
 * never have made. So a partial Response is shown as what is known: how many blanks were left
 * empty, the Frame with every blank drawn as a blank, and the tiles placed, left to right. A full
 * Response reads as the sentence it is, and one with no tile at all as no Response.
 *
 * `keyArrangements` is used only to count a frameless Item's blanks; without the key (a Simulation
 * not yet completed) a frameless Response cannot be told partial and is joined as before.
 */
export function SentenceResponse({
  frame,
  tiles,
  keyArrangements,
}: {
  frame: string | undefined;
  tiles: readonly string[];
  keyArrangements: readonly (readonly string[])[] | null;
}) {
  if (tiles.length === 0) return <>(no Response submitted)</>;
  const blanks = sentenceBlankCount(frame, keyArrangements);
  if (blanks === undefined || tiles.length >= blanks) return <ComposedSentence frame={frame} tiles={tiles} />;

  const empty = blanks - tiles.length;
  const framed = sentenceBlankCount(frame, null) !== undefined;
  return (
    <>
      <span data-unfinished="">
        <span className="figures">{empty}</span> of <span className="figures">{blanks}</span> blanks left empty.
      </span>
      {framed && (
        <span className="block text-ink-soft">
          <ComposedSentence frame={frame} tiles={[]} />
        </span>
      )}
      <span className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-meta text-graphite">{tiles.length === 1 ? "Tile placed:" : "Tiles placed, left to right:"}</span>
        <span data-placed-tiles="" className="flex flex-wrap gap-1.5">
          {tiles.map((tile, i) => (
            <span key={i} data-placed="" className="rounded-chip border border-rule-strong px-1">
              {tile}
            </span>
          ))}
        </span>
      </span>
      <span className="block text-meta text-graphite">Which blank each tile was in is not recorded, so they are not shown in the sentence.</span>
    </>
  );
}

/**
 * The tiles an Item offered, A to Z: the tray is re-drawn per request, so no order shown here could
 * be the one the User saw, and a sorted one does not pretend to be. With the key (`keyArrangements`),
 * the tile no accepted arrangement uses is marked as the extra one; without it (a Simulation not yet
 * completed) nothing is marked, since which tile is extra is the key's to tell.
 */
export function OfferedTiles({
  testId,
  tiles,
  keyArrangements,
}: {
  testId: string;
  tiles: readonly string[];
  keyArrangements: readonly (readonly string[])[] | null;
}) {
  const extra = keyArrangements && keyArrangements.length > 0 ? extraTileCounts(tiles, keyArrangements) : new Map<string, number>();
  const sorted = [...tiles].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }) || a.localeCompare(b));
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="text-meta text-graphite">Tiles offered, A to Z:</span>
      <ul data-testid={testId} className="flex flex-wrap gap-1.5">
        {sorted.map((tile, i) => {
          const left = extra.get(tile) ?? 0;
          if (left > 0) extra.set(tile, left - 1);
          return (
            <li key={i} data-extra={left > 0 ? "" : undefined}>
              <Chip glyph={left > 0 ? "dash" : "none"}>{left > 0 ? `${tile} · not in the sentence` : tile}</Chip>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * How many of each tile no key arrangement uses: the tile's count on the tray less the most any one
 * arrangement takes. Alternative keys reorder the same tiles, so this is the one extra tile.
 */
function extraTileCounts(tiles: readonly string[], keyArrangements: readonly (readonly string[])[]): Map<string, number> {
  const used = new Map<string, number>();
  for (const arrangement of keyArrangements) {
    const counts = new Map<string, number>();
    for (const tile of arrangement) counts.set(tile, (counts.get(tile) ?? 0) + 1);
    for (const [tile, n] of counts) used.set(tile, Math.max(used.get(tile) ?? 0, n));
  }
  const extra = new Map<string, number>();
  for (const tile of tiles) extra.set(tile, (extra.get(tile) ?? 0) + 1);
  for (const [tile, n] of used) extra.set(tile, Math.max(0, (extra.get(tile) ?? 0) - n));
  return extra;
}
