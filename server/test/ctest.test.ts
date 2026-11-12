import { describe, expect, it } from "vitest";
import { deriveCtwGaps, CtwDerivationError } from "../src/services/ctest.js";

// A Complete-the-Words paragraph written for these tests, in the shape the C-test needs: an intact
// first sentence, then enough prose for ten gaps. The tokens after sentence 1, numbered as the
// deriver counts them (the gapped, even-numbered ones in brackets):
//
//   Historians(1) [long](2) assumed(3) [that](4) this(5) [trade](6) was(7) [both](8) cheap(9)
//   [and](10) simple(11). [However](12), it(13) [was](14) controlled(15) [by](16) many(17)
//   [local](18) authorities(19), [and](20) …
//
// Sentence 1 is never counted. An odd-length word gives its extra letter to the completion
// (trade → tr + ade, However → How + ever, local → lo + cal), a two-letter word keeps one letter
// (by → b + y), the count runs on across the full stop after "simple", and everything after token
// 20 stays whole because the tenth gap ends the derivation.
const SAMPLE_CTW_PARAGRAPH =
  "Centuries before railways existed, merchants in medieval Europe moved most heavy goods on rivers " +
  "rather than over land. Historians long assumed that this trade was both cheap and simple. However, " +
  "it was controlled by many local authorities, and nearly every town along the banks collected tolls " +
  "from passing boats. Traders on longer journeys paid these charges repeatedly. Over time, the expense " +
  "encouraged them to form associations that bargained collectively with regional rulers for lower fees.";

describe("deriveCtwGaps", () => {
  it("gaps every second token after sentence 1, deleting the second half of each word", () => {
    const { gaps } = deriveCtwGaps("p1", SAMPLE_CTW_PARAGRAPH);
    expect(gaps.map((g) => [g.prefix, g.completion])).toEqual([
      ["lo", "ng"], ["th", "at"], ["tr", "ade"], ["bo", "th"], ["a", "nd"],
      ["How", "ever"], ["w", "as"], ["b", "y"], ["lo", "cal"], ["a", "nd"],
    ]);
    expect(gaps.every((g) => g.blankLength === g.completion.length)).toBe(true);
  });

  it("keeps sentence 1 intact and reconstructs the paragraph from segments+completions", () => {
    const { segments, gaps } = deriveCtwGaps("p1", SAMPLE_CTW_PARAGRAPH);
    expect(segments[0]).toEqual({
      type: "text",
      text: "Centuries before railways existed, merchants in medieval Europe moved most heavy goods on " +
        "rivers rather than over land. Historians ",
    });
    const byId = new Map(gaps.map((g) => [g.id, g]));
    const rebuilt = segments
      .map((s) => (s.type === "text" ? s.text : byId.get(s.gapId)!.prefix + byId.get(s.gapId)!.completion))
      .join("");
    expect(rebuilt).toBe(SAMPLE_CTW_PARAGRAPH);
    // gap ids follow the documented `${passageId}-g1`… scheme
    expect(gaps.map((g) => g.id)).toEqual(Array.from({ length: 10 }, (_, i) => `p1-g${i + 1}`));
  });

  it("throws CtwDerivationError when the text yields fewer than 10 gaps", () => {
    expect(() => deriveCtwGaps("p1", "One sentence only. Two more words.")).toThrow(CtwDerivationError);
    try {
      deriveCtwGaps("p1", "One sentence only. Two more words.");
      throw new Error("expected deriveCtwGaps to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CtwDerivationError);
      expect((err as InstanceType<typeof CtwDerivationError>).gapCount).toBe(1);
    }
  });

  it("skips length-1 tokens but advances the counter", () => {
    // Sentence 1 ("Start now.") is intact. In the remainder, token 6 ("a") lands on an even
    // count — normally a gap candidate — but its length is 1, so it is left intact and does NOT
    // consume a gap slot. The schedule is not shifted to compensate: token 7 ("seven", odd) stays
    // intact too, and the NEXT even-numbered token, 8 ("eight"), is gapped instead.
    const paragraph =
      "Start now. One two three four five a seven eight nine ten eleven twelve thirteen fourteen " +
      "fifteen sixteen seventeen eighteen nineteen twenty square circle.";
    const { segments, gaps } = deriveCtwGaps("p1", paragraph);
    expect(gaps).toHaveLength(10);
    // "a" (token 6) is never turned into a gap.
    expect(gaps.some((g) => g.prefix + g.completion === "a")).toBe(false);
    // "seven" (token 7, odd) stays intact — the skip did not shift the parity.
    const text = segments.filter((s) => s.type === "text").map((s) => s.text).join("");
    expect(text).toContain("seven");
    // "eight" (token 8, the next even count) is gapped instead.
    expect(gaps.some((g) => g.prefix === "ei" && g.completion === "ght")).toBe(true);
    // Reconstruction still round-trips.
    const byId = new Map(gaps.map((g) => [g.id, g]));
    const rebuilt = segments
      .map((s) => (s.type === "text" ? s.text : byId.get(s.gapId)!.prefix + byId.get(s.gapId)!.completion))
      .join("");
    expect(rebuilt).toBe(paragraph);
  });

  it("splits hyphenated words into two tokens", () => {
    // Sentence 1 ("Start now.") is intact. In the remainder, "well-known" is token 2 ("well") and
    // token 3 ("known") — NOT one 10-character token — so "well" (even) is gapped on its own
    // 4-letter split and "known" (odd) stays fully intact.
    const paragraph =
      "Start now. One well-known two three four five six seven eight nine ten eleven twelve " +
      "thirteen fourteen fifteen sixteen seventeen eighteen nineteen.";
    const { segments, gaps } = deriveCtwGaps("p1", paragraph);
    expect(gaps).toHaveLength(10);
    expect([gaps[0]!.prefix, gaps[0]!.completion]).toEqual(["we", "ll"]);
    const text = segments.filter((s) => s.type === "text").map((s) => s.text).join("");
    expect(text).toContain("known");
    const byId = new Map(gaps.map((g) => [g.id, g]));
    const rebuilt = segments
      .map((s) => (s.type === "text" ? s.text : byId.get(s.gapId)!.prefix + byId.get(s.gapId)!.completion))
      .join("");
    expect(rebuilt).toBe(paragraph);
  });
});
