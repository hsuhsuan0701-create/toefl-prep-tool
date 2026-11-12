import { describe, expect, it } from "vitest";
import type { SetAdvisoryNote } from "@toefl-prep/shared";
import { ADVISORY_NOTE_TEXT, advisoryNoteLines } from "../src/ui/labels";

// A Set's advisory notes are internal check codes. What the User reads is one plain sentence per
// kind saying what to expect when they practise the Set, and nothing at all for the kinds that say
// nothing about its practice value.

function rate(detail: string, measuredWpm: number, clipId?: string): SetAdvisoryNote {
  return { check: "speech-rate", detail, measuredWpm, minWpm: 140, maxWpm: 180, targetWpm: 160, take: "retake", ...(clipId ? { clipId } : {}) };
}

describe("advisoryNoteLines", () => {
  it("says nothing for a Set with no notes", () => {
    expect(advisoryNoteLines([])).toEqual([]);
  });

  it("never shows a Plan drift note, which says nothing about practice value", () => {
    expect(advisoryNoteLines([{ check: "plan-conformance", detail: "plan-drift", taskType: "interview" }])).toEqual([]);
    expect(advisoryNoteLines([{ check: "plan-conformance", detail: "domain-drift", taskType: "academic_passage", itemPosition: 0 }])).toEqual([]);
  });

  it("hides a Speaking Set whose only notes are a Plan drift and a slow scenario introduction", () => {
    expect(advisoryNoteLines([{ check: "plan-conformance", detail: "plan-drift", taskType: "interview" }, rate("lr-briefing", 120)])).toEqual([]);
  });

  it("says which way a clip's pace misses the exam's, per kind of clip, and counts the clips", () => {
    const lines = advisoryNoteLines([rate("lr-item", 120, "lr1"), rate("lr-item", 125, "lr2"), rate("conversation", 200, "conv1")]);
    expect(lines).toEqual([
      "2 Listen and Repeat sentences play a little slower than on the real exam.",
      "One Conversation plays a little faster than on the real exam.",
    ]);
  });

  it("counts a part of the Set once however many similarity measures flagged it", () => {
    const lines = advisoryNoteLines([
      { check: "catalog-novelty", detail: "jaccard", taskType: "listen_choose", itemPosition: 4, conflictingSetIds: ["lsn-a"] },
      { check: "catalog-novelty", detail: "containment", taskType: "listen_choose", itemPosition: 4, conflictingSetIds: ["lsn-a"] },
      { check: "catalog-novelty", detail: "trigram-dice", taskType: "listen_choose", itemPosition: 9, conflictingSetIds: ["lsn-b"] },
    ]);
    expect(lines).toEqual(["2 parts of this Set repeat content from another Set in your bank."]);
  });

  it("puts two codes that mean the same thing for a learner in one sentence", () => {
    const lines = advisoryNoteLines([
      { check: "content-gate", detail: "frame-final-punctuation", taskType: "build_sentence", itemPosition: 1 },
      { check: "content-gate", detail: "tile-final-punctuation", taskType: "build_sentence", itemPosition: 6 },
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^In 2 Build a Sentence Items/u);
  });

  it("states what to expect from a content check, in words", () => {
    expect(advisoryNoteLines([{ check: "content-gate", detail: "ctw-gap-leak", taskType: "complete_words", itemPosition: 2 }])).toEqual([
      "In one Complete the Words paragraph, a blanked word also appears in full, so it can be copied rather than recalled.",
    ]);
    expect(advisoryNoteLines([{ check: "talk-register", detail: "below-task-register", taskType: "academic_talk", itemPosition: 2 }])).toEqual([
      "One Academic Talk uses plainer language than the real exam's, so it is easier to follow.",
    ]);
  });

  it("names every kind of clip the audio renderers measure, and a clip of an unknown kind generically", () => {
    for (const role of ["lr-item", "interview-question", "lcr-utterance", "conversation", "announcement", "academic-talk"]) {
      const [line] = advisoryNoteLines([rate(role, 120)]);
      expect(line, role).toMatch(/^One [A-Z].* plays a little slower than on the real exam\.$/u);
    }
    expect(advisoryNoteLines([rate("interview-intro", 120)])).toEqual([]);
    expect(advisoryNoteLines([rate("some-new-role", 200)])).toEqual(["One recording plays a little faster than on the real exam."]);
  });

  it("falls back to a plain sentence for a kind this build does not know", () => {
    const [line] = advisoryNoteLines([{ check: "content-gate", detail: "some-future-kind" }]);
    expect(line).toBe("One part of this Set did not pass a check run when it was generated. You can still practise it.");
    expect(line).not.toContain("some-future-kind");
  });

  it("has a sentence for every kind the generators write, shown or hidden", () => {
    const written = [
      "content-gate/word-count", "content-gate/ctw-word-count-over", "content-gate/academic-coverage", "content-gate/option-count",
      "content-gate/module-difficulty-band", "content-gate/passage-difficulty-band", "content-gate/ctw-paragraph-difficulty-band",
      "content-gate/item-language", "content-gate/explanation-language", "content-gate/explanation-length",
      "content-gate/explanation-length-ctw", "content-gate/explanation-length-mcq", "content-gate/ctw-gap-leak",
      "content-gate/option-length-bias", "content-gate/explanation-position-reference", "content-gate/syllable-estimate",
      "content-gate/item-quality", "content-gate/frame-final-punctuation", "content-gate/tile-count", "content-gate/distractor-count",
      "content-gate/tile-final-punctuation", "content-gate/tile-initial-capital", "content-gate/lr-word-count-over",
      "content-gate/lr-clip-duration-over", "content-gate/lr-clip-over-ceiling", "talk-register/below-task-register",
      "intra-set-similarity/intra-candidate", "catalog-novelty/novelty-key", "catalog-novelty/canonical-title",
      "catalog-novelty/descriptor", "catalog-novelty/jaccard", "catalog-novelty/containment", "catalog-novelty/trigram-dice",
      "catalog-novelty/semantic-signature", "catalog-novelty/domain-balance", "plan-conformance/plan-drift",
      "plan-conformance/domain-drift", "plan-conformance/required-concept",
    ];
    for (const kind of written) {
      expect(ADVISORY_NOTE_TEXT[kind], kind).toBeDefined();
      for (const n of [1, 3]) {
        const text = ADVISORY_NOTE_TEXT[kind].text(n);
        expect(text, kind).toMatch(/^[A-Z0-9].*\.$/u);
        expect(text, kind).not.toMatch(/undefined|NaN|_|\bnote\b/u);
      }
    }
  });
});
