import type { ReadingSet } from "@toefl-prep/shared";

// A minimal schema-valid Reading Set. Only the counts zod actually pins are honoured (10 gaps per
// CtW passage, 2-3 questions per daily-life text, exactly 5 per academic passage); module
// COMPOSITION counts (how many passages and Items each Module holds) are enforced by the Verifier, not zod, so the
// modules here stay as small as the schema allows.
//
// Gap completions are deliberately chosen so that none of them occurs as a substring of anything
// stripAnswers keeps (segment text, prefixes, topics, stems, options, passage text). That is what
// makes the leak scan in schemas.reading.test.ts a real test rather than a coincidence: if a
// completion ever survives the strip, the scan sees it.

// Appears ONLY inside generationPlan, which stripAnswers drops wholesale — so the leak scan can
// assert on plan content instead of just on the field name.
export const READING_PLAN_MARKER = "plan-only-provenance-marker";

const mcq = (id: string, correct: string) => ({
  id,
  stem: `Stem for ${id}?`,
  options: [
    { id: "a", text: "Option A" },
    { id: "b", text: "Option B" },
    { id: "c", text: "Option C" },
  ],
  correctOptionId: correct,
  skill: "detail" as const,
  explanationZh: `題目 ${id}:正確答案是 ${correct},因為文中明確提到;其他選項與原文不符。`,
});

// prefix + completion is the whole word; segments carry the text BETWEEN gaps only (the prefix is
// rendered from the gap, in front of `blankLength` letter boxes) — the same split ctest.ts derives.
const gapWords: readonly [string, string][] = [
  ["mi", "ght"], ["sur", "vival"], ["dra", "wings"], ["gr", "oup"], ["act", "ivity"],
  ["pur", "pose"], ["ba", "sic"], ["di", "vine"], ["coh", "esion"], ["dan", "cing"],
];
const gaps = gapWords.map(([prefix, completion], i) => ({
  id: `ctw-1-g${i + 1}`,
  prefix,
  completion,
  blankLength: completion.length,
  explanationZh: `語意上只有 ${prefix}${completion} 符合上下文。`,
}));
const gapTexts = [
  "Early people painted caves. We ",
  " picture a life of ",
  " alone, but the ",
  " show a ",
  " at play. Each ",
  " had a ",
  ": a ",
  " story, a ",
  " sign, or the ",
  " of a clan. The ",
  " was real.",
];
const segments = gapTexts.flatMap((text, i) =>
  i < gaps.length
    ? [{ type: "text" as const, text }, { type: "gap" as const, gapId: gaps[i]!.id }]
    : [{ type: "text" as const, text }]
);

const planEntry = (slug: string) => ({
  domain: "history-social-change" as const,
  noveltyKey: `plan-key-${slug}`,
  requiredConcepts: [`plan concept ${slug} alpha`, `plan concept ${slug} beta`],
  distinguishesFrom: [],
});

export const READING_FIXTURE: ReadingSet = {
  id: "rd-fixture1", kind: "reading", source: "generated", createdAt: "2026-08-09T00:00:00.000Z",
  router: {
    timeLimitSec: 1200,
    ctwPassages: [{
      id: "ctw-1", taskType: "complete_words", topic: "prehistoric dance",
      // An opaque marker, not a passage: it points at nothing and spells nothing the segments hold.
      // stripAnswers must drop sourceParagraph, and schemas.reading.test.ts's leak scan looks for
      // this exact string in the served Set, so it has to be text found nowhere else in the fixture.
      sourceParagraph: "SEE deriveCtwGaps GOLDEN TEXT",
      segments,
      gaps,
    }],
    dailyLife: [{
      id: "dl-1", taskType: "daily_life", genre: "notice",
      text: "Paperless billing starts Monday. Enroll in the app.",
      questions: [mcq("dl-1-q1", "a"), mcq("dl-1-q2", "b")],
    }],
    academic: [{
      id: "ap-1", taskType: "academic_passage", title: "The Mirror Test", discipline: "life science",
      text: "Two hundred words of expository prose about self-recognition in animals.",
      questions: [
        mcq("ap-1-q1", "b"), mcq("ap-1-q2", "a"), mcq("ap-1-q3", "c"),
        mcq("ap-1-q4", "a"), mcq("ap-1-q5", "b"),
      ],
    }],
  },
  lowerModule: {
    timeLimitSec: 540, ctwPassages: [], academic: [],
    dailyLife: [{
      id: "dl-lo-1", taskType: "daily_life", genre: "menu", text: "Salad $6. Tea $2.",
      questions: [mcq("dl-lo-1-q1", "c"), mcq("dl-lo-1-q2", "a")],
    }],
  },
  upperModule: {
    timeLimitSec: 540, ctwPassages: [], academic: [],
    dailyLife: [{
      id: "dl-up-1", taskType: "daily_life", genre: "invoice",
      text: "Amount due on receipt of this invoice: $120, net 30.",
      questions: [mcq("dl-up-1-q1", "b"), mcq("dl-up-1-q2", "c")],
    }],
  },
  // This fixture keeps the archive composition on purpose: six `dailyLifeTexts` entries, and an
  // upperModule holding a Daily Life text (`dl-up-1` above), which newly generated Sets no longer
  // have. Banked Reading Sets carry this shape, and a published Set is never edited and is re-parsed
  // on every read, so the shape must keep parsing. Holding the fixture at it makes the suites that
  // go through ReadingSetSchema/AnySetSchema (and the upper-module daily_life scoring cases in
  // routes.attempts.reading.test.ts) cover the archive half of the schema split.
  // schemas.reading.test.ts asserts both halves by name.
  generationPlan: {
    version: "cross-set-diversity-v1",
    kind: "reading",
    ctwPassages: Array.from({ length: 4 }, (_, i) => ({
      ...planEntry(`ctw-${i + 1}`),
      topic: `Plan topic ctw-${i + 1}`,
      angle: `Plan angle ctw-${i + 1} (${READING_PLAN_MARKER})`,
    })),
    dailyLifeTexts: Array.from({ length: 6 }, (_, i) => ({
      ...planEntry(`dl-${i + 1}`),
      genre: "notice",
      scenario: `Plan scenario dl-${i + 1}`,
    })),
    academicPassages: Array.from({ length: 3 }, (_, i) => ({
      ...planEntry(`ap-${i + 1}`),
      title: `Plan title ap-${i + 1}`,
      discipline: "life science",
      angle: `Plan angle ap-${i + 1}`,
    })),
  },
};
