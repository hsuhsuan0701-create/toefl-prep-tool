import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  LISTEN_AND_REPEAT_ITEM_TARGET_WPM,
  LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC,
} from "@toefl-prep/shared";
import {
  LISTEN_AND_REPEAT_WORD_CEILINGS,
  listenAndRepeatPublishedClipBreach,
  listenAndRepeatViolations,
  listenAndRepeatWordBudgetAtPace,
  type ListenAndRepeatItemLike,
} from "../src/services/speakingConformance.js";
import { config } from "../src/lib/config.js";

// Each budget's half of the gate, read off the one function the generator calls.
function listenAndRepeatWordCountViolations(items: readonly ListenAndRepeatItemLike[]) {
  return listenAndRepeatViolations(items).filter((violation) => violation.kind === "lr-word-count-over");
}

function listenAndRepeatClipDurationViolations(items: readonly ListenAndRepeatItemLike[]) {
  return listenAndRepeatViolations(items).filter((violation) => violation.kind === "lr-clip-duration-over");
}

function itemsOf(sentences: readonly string[]) {
  return sentences.map((sentence, index) => ({ id: `lr-${index + 1}`, sentence }));
}

function words(count: number): string {
  return Array.from({ length: count }, (_, i) => `w${i + 1}`).join(" ");
}

describe("listenAndRepeatWordCountViolations", () => {
  it("accepts a ramp shaped like ETS's own Figure 11 (5, 6, 6, 11, 8, 10, 15), dips and ties included", () => {
    // ETS's own ramp is non-monotonic and jagged, and legal here. The word counts are those of the
    // Technical Manual's Figure 11 campus gym scenario.
    const sentences = [5, 6, 6, 11, 8, 10, 15].map(words);
    expect(listenAndRepeatWordCountViolations(itemsOf(sentences))).toEqual([]);
  });

  it("accepts every item sitting exactly on its ceiling", () => {
    const sentences = LISTEN_AND_REPEAT_WORD_CEILINGS.map(words);
    expect(listenAndRepeatWordCountViolations(itemsOf(sentences))).toEqual([]);
  });

  it("fires on an item one word over its ceiling, with a position and counts but no content", () => {
    const sentences = [5, 6, 6, 11, 8, 10, 17].map(words);
    const violations = listenAndRepeatWordCountViolations(itemsOf(sentences));
    expect(violations).toEqual([
      {
        kind: "lr-word-count-over",
        label: "listenAndRepeat/items[6]",
        id: "lr-7",
        detail: "17 words against a ceiling of 16 for item 7",
      },
    ]);
    // No sentence content in the strings that travel into prompts, logs and advisory notes.
    for (const violation of violations) {
      expect(violation.label).not.toContain("w1");
      expect(violation.detail).not.toContain("w1");
    }
  });

  it("reports every over-long item at once, so one regeneration can fix the whole Set", () => {
    const sentences = [12, 6, 6, 11, 8, 20, 22].map(words);
    const violations = listenAndRepeatWordCountViolations(itemsOf(sentences));
    expect(violations.map((violation) => violation.label)).toEqual([
      "listenAndRepeat/items[0]",
      "listenAndRepeat/items[5]",
      "listenAndRepeat/items[6]",
    ]);
    expect(violations.every((violation) => violation.kind === "lr-word-count-over")).toBe(true);
  });

  it("counts words with the pace pipeline's regex — a contraction is one word, not two", () => {
    // 16 tokens where "doesn't" and "we've" each count once; a naive split on the apostrophe
    // would see 18 and mis-fire. countEnglishWords is the single definition of
    // "word" this codebase measures speech by (audioPace.ts), and the gate must agree with it.
    const sentence =
      "The librarian doesn't lock the annex until we've cleared the reading room on the top floor.";
    const violations = listenAndRepeatWordCountViolations([
      ...itemsOf([5, 6, 6, 11, 8, 10].map(words)),
      { id: "lr-7", sentence },
    ]);
    expect(violations).toEqual([]);
  });
});

// The second budget: a clip may not hold more than LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC of speech at
// the slowest rate its band accepts. It binds on the product of word count and rate, which neither
// a word ceiling nor a rate band sees alone.
describe("listenAndRepeatClipDurationViolations", () => {
  it("fires on an item that satisfies BOTH individual budgets and still runs long", () => {
    // 15 words at item 6: inside its 15-word ceiling, so the word gate reports nothing, yet at the
    // slowest rate item 6's band accepts (156 WPM) that is 5.8 s, past the 5.0 s ceiling.
    const sentences = [5, 6, 6, 11, 8, 15, 10].map(words);
    expect(listenAndRepeatWordCountViolations(itemsOf(sentences))).toEqual([]);
    expect(listenAndRepeatClipDurationViolations(itemsOf(sentences))).toEqual([
      {
        kind: "lr-clip-duration-over",
        label: "listenAndRepeat/items[5]",
        id: "lr-6",
        detail:
          "15 words runs about 5.8s at the slowest pace item 6's band accepts, past the 5.0s clip " +
          "ceiling (at most 13 words for item 6)",
      },
    ]);
  });

  it("accepts every item sitting exactly on its word budget at pace", () => {
    const sentences = LISTEN_AND_REPEAT_ITEM_TARGET_WPM.map((_, index) =>
      words(listenAndRepeatWordBudgetAtPace()),
    );
    expect(listenAndRepeatClipDurationViolations(itemsOf(sentences))).toEqual([]);
    // ...and one word more is over, at every item.
    for (const index of [0, 1, 2, 3, 4, 5, 6]) {
      const over = [...sentences];
      over[index] = words(listenAndRepeatWordBudgetAtPace() + 1);
      expect(
        listenAndRepeatClipDurationViolations(itemsOf(over)).map((violation) => violation.label),
        `item ${index + 1} is not bounded by its clip budget`,
      ).toEqual([`listenAndRepeat/items[${index}]`]);
    }
  });

  // Where the two budgets bind. The clip budget is taken at the band's slow edge, which is one floor
  // for all seven items, so the budget is one too; it binds only at items 6 and 7, whose word
  // ceilings of 15 and 16 are the only ones above it.
  it("binds only at items 6 and 7, at one budget taken off the band floor", () => {
    const budgets = LISTEN_AND_REPEAT_ITEM_TARGET_WPM.map((_, index) =>
      listenAndRepeatWordBudgetAtPace(),
    );
    expect(budgets).toEqual([13, 13, 13, 13, 13, 13, 13]);
    budgets.forEach((budget, index) => {
      const ceiling = LISTEN_AND_REPEAT_WORD_CEILINGS[index];
      expect(budget < ceiling, `item ${index + 1}`).toBe(index >= 5);
    });
    // ETS's own item 7 in the zoo set is 13 words, and it passes.
    expect(listenAndRepeatClipDurationViolations(itemsOf([5, 6, 6, 11, 8, 13, 13].map(words)))).toEqual([]);
  });

  // What the 13-word cap gives up, stated as a test. ETS's Teacher Practice Test 5 item 7 is 14
  // words and its Figure 11 item 7 is 15, both longer than this app writes. ETS reads its 14-word
  // item at 179.6 WPM (4.68 s); this app's band accepts down to 156 WPM, at which 14 words run
  // 5.4 s. Allowing 14 would need a floor of 168 WPM, a rate this renderer's slow takes fall below
  // (14-word clips have run close to 6 s; see LISTEN_AND_REPEAT_MAX_ITEM_WORDS in shared).
  it("gives up ETS's own 14- and 15-word item 7s, and says why in one place", () => {
    const violations = listenAndRepeatClipDurationViolations(
      itemsOf([5, 6, 6, 11, 8, 10, 14].map(words)),
    );
    expect(violations.map((violation) => violation.label)).toEqual(["listenAndRepeat/items[6]"]);
    expect(listenAndRepeatWordBudgetAtPace()).toBe(13);
  });

  it("counts words with the pace pipeline's regex, exactly as the length gate does", () => {
    // 13 words where "doesn't" and "we've" each count once, exactly item 7's 13-word clip budget; a
    // naive apostrophe split would see 15 and fire this gate on an item that is inside its budget.
    const sentence =
      "The librarian doesn't lock the annex until we've cleared the reading room downstairs.";
    expect(listenAndRepeatClipDurationViolations([
      ...itemsOf([5, 6, 6, 11, 8, 10].map(words)),
      { id: "lr-7", sentence },
    ])).toEqual([]);
  });

  it("never leaks sentence content into a label or a detail", () => {
    const violations = listenAndRepeatClipDurationViolations(itemsOf([5, 6, 6, 11, 8, 20, 22].map(words)));
    expect(violations.length).toBeGreaterThan(0);
    for (const violation of violations) {
      expect(violation.label).not.toContain("w1");
      expect(violation.detail).not.toContain("w1");
    }
  });
});

describe("listenAndRepeatViolations", () => {
  it("reports both budgets at once, in item order, word budget before clip budget", () => {
    // Item 7 at 22 words breaks both: past its 16-word ceiling, and about 8.5 s of speech at the
    // band floor. Item 6 at 15 words breaks only the clip budget.
    const violations = listenAndRepeatViolations(itemsOf([5, 6, 6, 11, 8, 15, 22].map(words)));
    expect(violations.map((violation) => [violation.label, violation.kind])).toEqual([
      ["listenAndRepeat/items[5]", "lr-clip-duration-over"],
      ["listenAndRepeat/items[6]", "lr-word-count-over"],
      ["listenAndRepeat/items[6]", "lr-clip-duration-over"],
    ]);
  });

  it("is exactly the two halves, and each half is exactly its own kind", () => {
    const items = itemsOf([12, 6, 6, 11, 8, 20, 22].map(words));
    const all = listenAndRepeatViolations(items);
    expect(listenAndRepeatWordCountViolations(items)).toEqual(
      all.filter((violation) => violation.kind === "lr-word-count-over"),
    );
    expect(listenAndRepeatClipDurationViolations(items)).toEqual(
      all.filter((violation) => violation.kind === "lr-clip-duration-over"),
    );
    expect(all).toHaveLength(
      listenAndRepeatWordCountViolations(items).length + listenAndRepeatClipDurationViolations(items).length,
    );
  });

  it("reports nothing at all for a Set shaped like ETS's own published ramp", () => {
    // Figure 11's shape, with item 7 at the 13-word clip budget rather than its 15.
    expect(listenAndRepeatViolations(itemsOf([5, 6, 6, 11, 8, 10, 13].map(words)))).toEqual([]);
  });
});

// The advisory fires at exactly the ceiling the model is told in the generation guide's ramp table,
// with no gate-only tolerance (the rule generationCheckPolicy's READING_ADVISORY_KINDS states for
// Reading). This parses the published table and holds both budgets equal to the code, so retuning
// either side alone fails here rather than opening a gap between what the model is asked for and
// what is checked.
describe("the gate ceilings equal the generation guide's published ramp table", () => {
  const guidePath = path.join(
    config.projectRoot,
    ".claude/skills/toefl-speaking/references/generation-guide.md",
  );
  const guideMd = fs.readFileSync(guidePath, "utf8");

  it("each Length cell's top number is the gate's ceiling for that item", () => {
    const ceilings: number[] = [];
    for (const line of guideMd.split("\n")) {
      const row = /^\|\s*([1-7])\s*\|\s*([^|]*?)\|/u.exec(line);
      if (!row) continue;
      const numbers = row[2].match(/\d+/gu);
      expect(numbers, `ramp row ${row[1]} carries no word count`).not.toBeNull();
      ceilings[Number(row[1]) - 1] = Math.max(...(numbers ?? []).map(Number));
    }
    expect(ceilings).toEqual([...LISTEN_AND_REPEAT_WORD_CEILINGS]);
  });

  // The clip ceiling is not a gate-only tolerance either: the model is shown the per-item word
  // budget the 5.0 s ceiling works out to, in the same table, and this holds that column equal to
  // what the gate computes.
  it("the last column is the clip budget the gate enforces, item by item", () => {
    const published: number[] = [];
    for (const line of guideMd.split("\n")) {
      const row = /^\|\s*([1-7])\s*\|.*\|\s*\*{0,2}(\d+)\*{0,2}\s*\|\s*$/u.exec(line);
      if (!row) continue;
      published[Number(row[1]) - 1] = Number(row[2]);
    }
    expect(published).toEqual(
      LISTEN_AND_REPEAT_ITEM_TARGET_WPM.map((_, index) => listenAndRepeatWordBudgetAtPace()),
    );
  });

  it("states the clip ceiling itself, and that items 6 and 7 are where it binds", () => {
    expect(guideMd).toContain(`${LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC.toFixed(1)} seconds of speech`);
    expect(guideMd).toMatch(/items 6 and 7/u);
    expect(guideMd).toContain("13 words each");
  });

  it("targets ~15-16 words at item 7 and names no 22-word sentence", () => {
    expect(guideMd).toContain("| 7 | ~15–16 words |");
    expect(guideMd).not.toMatch(/22 words/u);
  });

  it("permits ties and local dips, citing Figure 11's counts, and never demands a monotonic ramp", () => {
    // The precedent the trend rule stands on: ETS's own published ramp is jagged.
    expect(guideMd).toContain("5, 6, 6, 11, 8, 10, 15");
    expect(guideMd).toMatch(/ties and local dips/u);
    expect(guideMd).not.toMatch(/monotonic/iu);
  });

  it("keeps the response-window ramp at 8/8/10/10/10/12/12 seconds, which this gate does not set", () => {
    expect(guideMd).toContain("8/8/10/10/10/12/12");
  });
});

// Everything else in this file is a projection: how long a sentence would run at some rate, decided
// from its word count before anything is spent. This is the one check that reads what a paid render
// produced. A projection cannot see a clip delivered below the band floor it assumes, which can run
// past the ceiling while the pace invariant holds.
describe("listenAndRepeatPublishedClipBreach", () => {
  const clip = (speechDurationSec: number, wordCount = 13) => ({
    file: "lr-7.mp3",
    wordCount,
    speechDurationSec,
    maxItemClipSec: LISTEN_AND_REPEAT_MAX_ITEM_CLIP_SEC,
  });

  // A clip a paid pilot render produced: 13 words, 5.284 s of speech, 147.6 WPM. Inside its word
  // ceiling and past the clip ceiling, which only a measurement shows.
  it("catches a 13-word clip that fits its word ceiling but runs past the clip ceiling", () => {
    const breach = listenAndRepeatPublishedClipBreach(clip(5.284));
    expect(breach).toBeDefined();
    expect(breach!.file).toBe("lr-7.mp3");
    expect(breach!.speechDurationSec).toBe(5.284);
    expect(breach!.maxItemClipSec).toBe(5);
    expect(breach!.detail).toContain("5.284");
    expect(breach!.detail).toContain("13 words");
  });

  // Strictly `>`. A grace margin here would reopen the `tolerance-covers-ceiling` hole the pace
  // invariant's second half closes: audioPace's 0.4 s absolute tolerance passing an over-ceiling
  // clip as in band.
  it.each([
    [4.999, false],
    [5, false],
    [5.001, true],
  ])("treats %ss of speech against a 5.0s ceiling as a breach: %s", (seconds, expected) => {
    expect(listenAndRepeatPublishedClipBreach(clip(seconds)) !== undefined).toBe(expected);
  });

  // A non-finite or non-positive duration is `assessPace`'s malfunction to fail: reporting it here
  // would relabel a truncated synthesis as an over-long clip, and reporting it clean would be a
  // claim this function cannot support. It says nothing.
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("stays silent on a %s duration", (seconds) => {
    expect(listenAndRepeatPublishedClipBreach(clip(seconds))).toBeUndefined();
  });

  // The ceiling is a parameter, not a constant read inside, so the renderer can pass the Set's own
  // recorded `itemMaxClipSec` and hold a re-render of an older Set to its own policy.
  it("measures against the ceiling it is given, not the live constant", () => {
    expect(listenAndRepeatPublishedClipBreach({ ...clip(5.9), maxItemClipSec: 6 })).toBeUndefined();
    expect(listenAndRepeatPublishedClipBreach({ ...clip(4.7), maxItemClipSec: 4.676 })).toBeDefined();
  });

  // Same rule every other string in this file follows: positions, counts and filenames, never a
  // syllable of the sentence. These travel into error messages and job logs.
  it("carries no sentence content", () => {
    const breach = listenAndRepeatPublishedClipBreach(clip(5.5));
    expect(JSON.stringify(breach)).not.toMatch(/[A-Za-z]{4,}\s+[A-Za-z]{4,}\s+[A-Za-z]{4,}\s+[A-Za-z]{4,}\./u);
    expect(breach!.detail).toContain("clip ceiling");
  });
});
