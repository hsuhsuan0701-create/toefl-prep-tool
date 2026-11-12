import { describe, expect, it } from "vitest";
import { markQuotes } from "../src/ui/markQuotes";

const marked = (text: string, quotes: string[]) => {
  const result = markQuotes(
    text,
    quotes.map((quote, i) => ({ id: i + 1, quote })),
  );
  return {
    marks: result.segments.filter((s) => s.markId !== undefined).map((s) => [s.markId, s.text]),
    unmatched: result.unmatched,
    joined: result.segments.map((s) => s.text).join(""),
  };
};

describe("markQuotes", () => {
  it("marks an exact quote and keeps the text intact", () => {
    const text = "I am writing about my subscription. The advertisement still plays.";
    const r = marked(text, ["The advertisement still plays"]);
    expect(r.marks).toEqual([[1, "The advertisement still plays"]]);
    expect(r.joined).toBe(text);
  });

  it("matches across curly quotes, case and collapsed whitespace, but renders the original characters", () => {
    const text = "It’s   fine,\nexcept that we need it.";
    const r = marked(text, ["it's fine, except"]);
    expect(r.marks).toEqual([[1, "It’s   fine,\nexcept"]]);
  });

  it("strips wrapping quote marks from the quote", () => {
    const r = marked("Could you also let me know when the problem is solved?", ["“when the problem is solved”"]);
    expect(r.marks).toEqual([[1, "when the problem is solved"]]);
  });

  it("falls back to the longest fragment of an elided quote", () => {
    const r = marked("I would like to kindly request to fix this issue, or I should receive a refund.", [
      "I would like to kindly request … receive a refund",
    ]);
    expect(r.marks).toEqual([[1, "I would like to kindly request"]]);
  });

  it("gives a repeated quote the next occurrence instead of overlapping", () => {
    const r = marked("the ad plays and the ad plays", ["the ad plays", "the ad plays"]);
    expect(r.marks).toEqual([
      [1, "the ad plays"],
      [2, "the ad plays"],
    ]);
  });

  // "İ" lowercases to two units ("i" and a combining dot), so the normalised text runs one unit
  // longer than the Response from there on. A quote after it must still map to its own words.
  it("marks exactly the quoted words after a character whose lowercase form is longer", () => {
    const text = "I moved to İstanbul last year. The advertisement still plays.";
    const r = marked(text, ["The advertisement still plays", "last year"]);
    expect(r.marks).toEqual([
      [2, "last year"],
      [1, "The advertisement still plays"],
    ]);
    expect(r.joined).toBe(text);
  });

  it("marks a quote that itself contains that character", () => {
    const r = marked("We flew to İstanbul in May.", ["İstanbul in May"]);
    expect(r.marks).toEqual([[1, "İstanbul in May"]]);
  });

  // An emoji is two UTF-16 units: neither one before the quote nor one closing it may split or shift
  // the mark.
  it("keeps marks whole and in place around an emoji", () => {
    const text = "Great news 😀! The advertisement still plays, so happy 😀 today.";
    const r = marked(text, ["The advertisement still plays", "so happy 😀"]);
    expect(r.marks).toEqual([
      [1, "The advertisement still plays"],
      [2, "so happy 😀"],
    ]);
    expect(r.joined).toBe(text);
  });

  it("reports a quote it cannot find instead of dropping it", () => {
    const r = marked("Dear Customer Support,", ["Best regards", ""]);
    expect(r.marks).toEqual([]);
    expect(r.unmatched).toEqual([1, 2]);
  });

  // A transcript can trail off with an ellipsis of its own; a quote of those words is not elided.
  it("marks a quote whose ellipsis is in the Response itself", () => {
    const r = marked("Once the surface is clean, count the... and lock the register.", ["the... and"]);
    expect(r.marks).toEqual([[1, "the... and"]]);
    expect(r.unmatched).toEqual([]);
  });

  // Listen and Repeat Deductions often quote adjacent words that share one: "point to" and
  // "to shelf." both hold the one "to". The second is in the Response, so it is not unmatched.
  it("reports a quote whose only occurrence overlaps an earlier mark as overlapping that mark, not as missing", () => {
    const result = markQuotes("Then you point to shelf.", [
      { id: 3, quote: "point to" },
      { id: 4, quote: "to shelf." },
      { id: 5, quote: "a phrase that is not there" },
    ]);
    expect(result.segments.filter((s) => s.markId !== undefined).map((s) => [s.markId, s.text])).toEqual([[3, "point to"]]);
    expect(result.overlapping).toEqual([{ id: 4, overlaps: 3 }]);
    expect(result.unmatched).toEqual([5]);
  });
});
