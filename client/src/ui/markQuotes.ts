// The red pen. Finds each Deduction's quote inside the Response it was taken from, so the Response
// can be shown marked up — the phrase underlined and numbered to its Deduction — instead of the
// quotes floating in a separate list with no way to see where they came from.
//
// Quotes come from a model, so they rarely match byte for byte: curly vs straight quotes and
// apostrophes, collapsed whitespace, different case, a leading/trailing quote mark or ellipsis, or
// an ellipsis eliding the middle. Matching normalises all of those, then maps the hit back onto the
// original text, so what renders is always the User's own characters. A quote that still cannot be
// found is returned in `unmatched` — the Deduction list must still show it, just without a mark.

export type QuoteMark = { id: number; quote: string };
export type MarkedSegment = { text: string; markId?: number };
export type MarkResult = { segments: MarkedSegment[]; unmatched: number[] };

const FOLD: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "″": '"',
  "–": "-", "—": "-",
  " ": " ",
};

/**
 * Normalises `text` and keeps, for every UTF-16 unit of the normalised text, the source character it
 * came from: `from[k]` is where that character starts in `text` and `to[k]` where it ends. The two
 * texts' lengths differ, so a match is mapped back through these arrays and never by its offset:
 *
 * - `text` is read a code point at a time, so an emoji's two units stay one character and a match
 *   ending on one ends after both;
 * - one character can lowercase to several units ("İ" becomes "i" and a combining dot), each of
 *   which maps back to that one character;
 * - a run of whitespace becomes one space, and the rest of the run adds no unit at all, so a match
 *   spanning it covers it from its neighbours' bounds.
 */
function normalise(text: string): { norm: string; from: number[]; to: number[] } {
  let norm = "";
  const from: number[] = [];
  const to: number[] = [];
  let lastWasSpace = false;
  for (let i = 0; i < text.length; ) {
    const raw = String.fromCodePoint(text.codePointAt(i)!);
    const end = i + raw.length;
    const folded = (FOLD[raw] ?? raw).toLowerCase();
    const isSpace = /\s/.test(folded);
    const units = isSpace ? (lastWasSpace ? "" : " ") : folded;
    for (let k = 0; k < units.length; k++) {
      from.push(i);
      to.push(end);
    }
    norm += units;
    lastWasSpace = isSpace;
    i = end;
  }
  return { norm, from, to };
}

/** The searchable fragments of a quote: trimmed of wrapping quote marks, split on any ellipsis. */
function fragments(quote: string): string[] {
  const stripped = quote
    .trim()
    .replace(/^["'‘’“”]+|["'‘’“”]+$/g, "")
    .trim();
  return stripped
    .split(/\s*(?:\.\.\.|…)\s*/)
    .map((f) => normalise(f).norm.trim())
    .filter((f) => f.length > 0);
}

export function markQuotes(text: string, quotes: readonly QuoteMark[]): MarkResult {
  const { norm, from: sourceStart, to: sourceEnd } = normalise(text);
  const taken: Array<{ start: number; end: number; id: number }> = [];
  const unmatched: number[] = [];

  const overlaps = (start: number, end: number) => taken.some((t) => start < t.end && end > t.start);

  for (const { id, quote } of quotes) {
    // Whole quote first; failing that, each elided fragment of 8 or more characters, longest first.
    // A shorter one is too ambiguous (a 3-letter fragment would mark the first "the" in the essay).
    const frags = fragments(quote);
    const longFragments = frags.length > 1 ? [...frags].sort((a, b) => b.length - a.length).filter((f) => f.length >= 8) : [];
    const candidates = [frags.join(" "), ...longFragments].filter((c) => c.length > 0);
    let placed = false;
    for (const needle of candidates) {
      let from = 0;
      while (!placed) {
        const at = norm.indexOf(needle, from);
        if (at < 0) break;
        const start = sourceStart[at];
        const end = sourceEnd[at + needle.length - 1];
        if (!overlaps(start, end)) {
          taken.push({ start, end, id });
          placed = true;
        } else {
          from = at + 1;
        }
      }
      if (placed) break;
    }
    if (!placed) unmatched.push(id);
  }

  taken.sort((a, b) => a.start - b.start);
  const segments: MarkedSegment[] = [];
  let cursor = 0;
  for (const t of taken) {
    if (t.start > cursor) segments.push({ text: text.slice(cursor, t.start) });
    segments.push({ text: text.slice(t.start, t.end), markId: t.id });
    cursor = t.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor) });
  return { segments, unmatched };
}
