import { FRAME_BLANK_MARKER, parseSentenceFrame } from "@toefl-prep/shared";

/**
 * A Build a Sentence Response (or an accepted answer), written back out as the sentence it is.
 *
 * A submitted Response, and an answer key, is only ever the tile texts in blank order, because that
 * is all the tiles are. A frameless Item's tiles carry the whole sentence, but an Item with a Frame
 * keeps its fixed words out of the tiles, so the bare list reads as a fragment ("volunteers who led
 * us through the new wing were" for "The volunteers who led us through the new wing were
 * wonderful."). Review is where a User reads their Response as English rather than as an
 * arrangement, so it has to be the whole sentence.
 *
 * This is the same layout SentenceTiles draws (the Frame's text verbatim, one filled or empty blank
 * per gap), filled in and static, so the results view is recognisably the Item just answered.
 */
export function sentenceAnswerText(frame: string | undefined, tileTexts: readonly string[]): string {
  return sentenceAnswerParts(frame, tileTexts)
    .map((part) => part.text)
    .join("");
}

/**
 * One run of a composed sentence: words printed in the Frame, a tile the User (or the key) placed in
 * a blank, or a blank left empty. A review sets the placed words apart from the printed ones, so the
 * User can see which words were theirs to choose.
 */
export type SentencePart = Readonly<{ kind: "frame" | "placed" | "blank"; text: string }>;

/**
 * The same composition as {@link sentenceAnswerText}, as runs: their texts joined are exactly that
 * string. Without a usable Frame every word is a placed tile, so the runs are the tiles and the
 * spaces between them.
 */
export function sentenceAnswerParts(frame: string | undefined, tileTexts: readonly string[]): SentencePart[] {
  const segments = parseFrameOrNull(frame);
  // No Frame, or one that does not parse: the tiles are the sentence, so join them.
  // `BuildASentenceItemSchema` rejects an unparseable Frame long before a Set is served, so that
  // half is defensive only, as in SentenceTiles: a bad Frame must not take the results view down.
  if (!segments) return spaced(tileTexts);

  let filled = 0;
  const parts: SentencePart[] = [];
  for (const segment of segments) {
    if (segment.type === "text") {
      parts.push({ kind: "frame", text: segment.text });
      continue;
    }
    // A partial Response is scored as the arrangement it is, the texts it does have from blank 0
    // rightwards, because `blankOrderTexts` drops the empty blanks and never records which ones they
    // were. Reading it back the same way keeps the results view true to what was scored, and the
    // shortfall stays visible as blanks rather than closing the sentence up over the gap: a User
    // reviewing an unfinished Item needs to see that they ran out of tiles, not a tidy sentence
    // that was never submitted.
    const tile = tileTexts[segment.index];
    parts.push(tile === undefined ? { kind: "blank", text: FRAME_BLANK_MARKER } : { kind: "placed", text: tile });
    filled = Math.max(filled, segment.index + 1);
  }

  // More texts than blanks cannot come out of a Drill (the arrangement has exactly one slot per
  // blank), but dropping part of a Response would be a far worse way to be wrong than trailing it.
  const surplus = tileTexts.slice(filled);
  return surplus.length === 0 ? parts : [...parts, { kind: "frame", text: " " }, ...spaced(surplus)];
}

function spaced(tileTexts: readonly string[]): SentencePart[] {
  return tileTexts.flatMap((text, i): SentencePart[] =>
    i === 0 ? [{ kind: "placed", text }] : [{ kind: "frame", text: " " }, { kind: "placed", text }],
  );
}

function parseFrameOrNull(frame: string | undefined) {
  if (frame === undefined) return null;
  try {
    return parseSentenceFrame(frame);
  } catch {
    return null;
  }
}
