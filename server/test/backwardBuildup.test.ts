import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  breakdownWordIndex,
  buildupSteps,
  chunkSentence,
  type BuildupDiffOp,
} from "@toefl-prep/shared";
import { wordDiff } from "../src/services/wordDiff.js";
import { config } from "../src/lib/config.js";

// The backward-buildup drill's pure core (shared/src/backwardBuildup.ts). It lives in `shared`
// because the server persists a rep against word indices the client re-derives when it renders the
// same sentence; the properties below are what stop those two from disagreeing.
//
// Tested here rather than in the client suite for the same reason cefr.test.ts is: this is string
// and index math, not rendering. The client suite covers the display side.

const words = (s: string) => s.trim().split(/\s+/u).filter((w) => w.length > 0);

describe("chunkSentence", () => {
  it("is lossless — chunks rejoin to the original word sequence", () => {
    const sentence = "The visitor whose badge you print today will remember how you treat them.";
    expect(chunkSentence(sentence).join(" ")).toBe(words(sentence).join(" "));
  });

  it("keeps every chunk inside the 2-6 word band", () => {
    const sentence = "The badge, the sign-in sheet, and the posted directory all matter daily.";
    for (const chunk of chunkSentence(sentence)) {
      expect(words(chunk).length).toBeGreaterThanOrEqual(2);
      expect(words(chunk).length).toBeLessThanOrEqual(6);
    }
  });

  it("never ends a chunk on a word that binds to its right", () => {
    // Cutting between "the" and "sign-in sheet" splits the unit chunking exists to keep whole. The
    // determiner list is the guard; this pins the property rather than the list.
    const binders = new Set(["the", "a", "an", "to", "of", "and", "or", "my", "your", "its", "their"]);
    const sentence = "Restock the filament shelf by size, and wipe down the workbench.";
    for (const chunk of chunkSentence(sentence)) {
      const last = words(chunk).at(-1)!.toLowerCase().replace(/[^a-z-]/g, "");
      expect(binders.has(last)).toBe(false);
    }
  });

  it("cuts at the relative pronoun — the structure item 7 is built on", () => {
    // 60% of lr-7 across the bank is "[head noun] [who/whose clause] [main verb]". If chunking does
    // not find that seam, the drill rehearses fragments that cut through the clause.
    const chunks = chunkSentence("The visitor whose badge you print today will remember how you treat them.");
    expect(chunks[0]).toBe("The visitor");
    expect(chunks[1]).toBe("whose badge you print today");
  });

  it("returns one chunk for a sentence too short to split, and none for a blank", () => {
    expect(chunkSentence("Check the print queue.")).toEqual(["Check the print queue."]);
    expect(chunkSentence("   ")).toEqual([]);
  });

  it("holds every property across the whole published Listen and Repeat bank", () => {
    // The drill is only usable if it never produces a degenerate chunking, and the bank is the real
    // input distribution. Hand-picked sentences miss shapes real input has, such as the stranded
    // one-word tail a greedy chunker leaves.
    const dir = path.join(config.dataDir, "question-sets", "speaking");
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")) : [];
    expect(files.length).toBeGreaterThan(0);
    let checked = 0;
    for (const file of files) {
      const set = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as {
        listenAndRepeat?: { items?: { sentence: string }[] };
      };
      for (const item of set.listenAndRepeat?.items ?? []) {
        const chunks = chunkSentence(item.sentence);
        expect(chunks.join(" ")).toBe(words(item.sentence).join(" "));
        // A sentence that already fits one chunk is left as one: at 5-6 words there is no seam
        // worth the size penalty, and nothing to build up to — those are the items that already
        // score well. Anything longer must split, or the drill has nothing to step through.
        if (words(item.sentence).length >= 7) expect(chunks.length).toBeGreaterThan(1);
        for (const chunk of chunks) {
          expect(words(chunk).length).toBeGreaterThanOrEqual(2);
          expect(words(chunk).length).toBeLessThanOrEqual(6);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(300);
  });
});

describe("buildupSteps", () => {
  const sentence = "The backup bulbs sit inside a locked drawer beside the main switchboard.";

  it("builds suffixes — every step ends where the sentence ends", () => {
    // This is the whole method: a step that ended anywhere else would rehearse a falling terminal
    // contour at a position that never carries one, N times over.
    for (const step of buildupSteps(sentence)) {
      expect(sentence.endsWith(step.text)).toBe(true);
    }
  });

  it("grows one chunk at a time, shortest first, ending at the full sentence", () => {
    const steps = buildupSteps(sentence);
    const chunks = chunkSentence(sentence);
    expect(steps).toHaveLength(chunks.length);
    expect(steps[0]!.text).toBe(chunks.at(-1));
    expect(steps.at(-1)!.text).toBe(words(sentence).join(" "));
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]!.text.length).toBeGreaterThan(steps[i - 1]!.text.length);
      expect(steps[i]!.text.endsWith(steps[i - 1]!.text)).toBe(true);
      expect(steps[i]!.ordinal).toBe(i + 1);
    }
  });

  it("reports the word index each step starts at", () => {
    const steps = buildupSteps(sentence);
    for (const step of steps) {
      expect(words(sentence).slice(step.startWordIndex).join(" ")).toBe(step.text);
    }
  });

  it("returns no steps for a blank sentence rather than throwing", () => {
    expect(buildupSteps("")).toEqual([]);
  });
});

describe("breakdownWordIndex", () => {
  const target = "The badge, the sign-in sheet, and the posted directory all matter daily.";

  it("is null when every target word matched", () => {
    expect(breakdownWordIndex(wordDiff(target, target) as BuildupDiffOp[])).toBeNull();
  });

  it("points at the first target word that was substituted or omitted", () => {
    const said = "The badge, the signing sheet, and the uh are all signed daily.";
    const index = breakdownWordIndex(wordDiff(target, said) as BuildupDiffOp[]);
    // "The badge, the" survived; "sign-in" (word 3) is the first one that did not.
    expect(index).toBe(3);
    expect(words(target)[index!]).toBe("sign-in");
  });

  it("does not fire on inserted fillers alone", () => {
    // ETS's own 5-scored samples carry fillers and self-repairs; a drill whose one instrument fired
    // on "um" would report noise as collapse.
    const said = `um ${target}`;
    expect(breakdownWordIndex(wordDiff(target, said) as BuildupDiffOp[])).toBeNull();
  });

  it("counts a leading omission as breakdown at word 0", () => {
    const said = "badge, the sign-in sheet, and the posted directory all matter daily.";
    expect(breakdownWordIndex(wordDiff(target, said) as BuildupDiffOp[])).toBe(0);
  });
});
