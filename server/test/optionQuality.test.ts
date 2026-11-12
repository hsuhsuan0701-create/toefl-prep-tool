import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  isStrictlyLongestBy,
  matchingPositionReferencePatterns,
  neutralProbability,
  optionLengthBiasFlags,
  OPTION_LENGTH_MEASURES,
  POSITION_REFERENCE_FORBIDDEN_EXAMPLES,
  POSITION_REFERENCE_PATTERNS,
  POSITION_REFERENCE_REQUIRED_EXAMPLES,
  positionReferenceInstruction,
  referencesOptionByPosition,
  tailAtLeast,
  wordCount,
  type OptionBiasSample,
} from "../src/services/optionQuality.js";

// The position-reference detector and the model-visible instruction are one artifact
// (optionQuality.ts, part 1), pinned against each other here: a phrasing added to the prompt but not
// the detector, or one the detector catches but the prompt never warns about, fails this file.

/** Seven basic slot references: 選項 with a numeral or letter, or an ordinal before 選項. */
const BASIC_SLOT_REFERENCES = [
  "得體回應是表示得加快進度，即選項二。",
  "答案為選項一。",
  "選項1是正確答案。",
  "選項A正確。",
  "選項a正確。",
  "第一個選項才是正解。",
  "第二選項與原文矛盾。",
];

/** Slot references in shapes other than the basic `選項X`, one or more per family. */
const OTHER_SLOT_REFERENCE_SHAPES = [
  // 第X個 / 第X項 with no 選項
  "正確答案是第一個。",
  "第一項才是正確的。",
  "第二個答案才對。",
  "第一個才是正確答案。",
  "第三項才對。",
  // 最後 / 最前 / 前N / 上面 + 選項
  "最後一個選項才是正確的。",
  "最後一項與原文不符。",
  "最前面的選項是正確的。",
  "前兩個選項都與原文無關。",
  "上面那個選項才對。",
  // a marker before 選項, the most common alternative in 繁中 test-prep prose
  "B選項正確，A選項與C選項均為干擾。",
  "Ａ選項才是正解。",
  "甲選項才是正確答案。",
  "一號選項才是正解。",
  // a particle between the ordinal and 選項
  "排在第一的選項是正確的。",
  "第一句選項與原文無關。",
  // bracketed ordinals
  "選項（一）是正確答案。",
  "選項【二】未提及。",
  // full-width digits and letters
  "選項１是正確答案。",
  "選項Ｂ是正確答案。",
  // 甲乙丙丁 / 壹貳參
  "選項甲才是正確答案。",
  "選項壹為正解。",
  // bare label, no 選項
  "答案為(B)。",
  "正解為 A。",
  // English, which the guides forbid outright
  "The first option is correct.",
  "The last option contradicts the passage.",
  "答案是 option B。",
  "Choice C is not supported.",
  "option 3 is wrong.",
  // 首 / 末
  "首選為描述深夜甜點者。",
  "末項與原文矛盾。",
];

/** Further slot references: more markers and brackets, the phrasings a model reaches for when told
 * not to name a slot, spatial words, English label forms and other counters. */
const FURTHER_SLOT_REFERENCES = [
  "選項乙與原文矛盾。",
  "選項２、３皆錯。",
  "選項(3)錯誤。",
  "選項［B］正確。",
  "二號答案與原文矛盾。",
  "後兩個選項均為干擾。",
  "下面那個選項錯誤。",
  "最後那個選項提到停車場。",
  "最前一個選項與原文無關。",
  "首項才是正解。",
  "第四個選項未提及。",
  "答案應為選項四。",
  "正解為選項d。",
  "選項D正確。",
  "正確答案是 C。",
  "答案是2。",
  "第 一 個 選項才是正解。",
  "選項 一 是正確答案。",
  // The remediation instruction's own pull: told "never a slot or letter", a model reaches for these
  // two first, which is why the detector and the prompt are designed together.
  "答案是第一個，其餘皆不符。",
  "最後一個選項才對。",
  // Spatial words, 項 after a letter, English label forms, and 則/條 counters.
  "中間的選項才是正確的。",
  "最上面那個才是正解。",
  "答案是最上面那個。",
  "最右邊的選項與原文無關。",
  "最左邊那個選項才對。",
  "B項正確。",
  "A項與C項均為干擾。",
  "Answer: B",
  "The 2nd option is correct.",
  "the topmost option is right.",
  "正確的是第一則。",
  "正確的是第一條。",
  // The marker and numeral vocabularies agree on 五, so both forms are caught, though no Item has
  // more than four options.
  "選項五未提及。",
  "第五個選項才是正解。",
];

/** Ordinary 繁中 prose describing a transcript, which a Listening Explanation must cite, and
 * transcripts enumerate things. This is the expensive false positive: the phrase is legitimately not
 * about an option, so a rewrite cannot remove it, and the Item would re-flag every round until the
 * verify budget is gone. */
const TRANSCRIPT_DESCRIBING_PROSE = [
  "第三個學生沒有發言。",
  "第二個建議被接受。",
  "第一個講者提到費用。",
  "第二個實驗結果相反。",
  "第三個樣本被汙染。",
  "第一個假設被推翻。",
  "第二個地點更方便。",
  "第一個時間不合適。",
  "第一個步驟需要準備器材。",
  "第二個問題出現在下半場。",
  "第三個原因並未提及。",
  "第一個例子是關於遷徙。",
  "第二個實驗需要重做。",
  "第一個活動在週六舉行。",
  "教授先講第一個主題,再回到第二個。",
  "最後一個提問來自研究生。",
  "最後一個環節是問答。",
];

/** A Latin word ending in a-e before 選項, and set-wide quantifier phrasings, which are the required
 * form. `marker-then-noun`'s left guards keep it off all ten. */
const QUANTIFIER_AND_LATIN_PROSE = [
  "提到 pizza 選項的敘述不符。",
  "與 data 答案無關。",
  "任一選項皆可。",
  "其中一選項提到停車場。",
  "這四選項都與原文無關。",
  "每一選項都提到時間。",
  "另一選項描述的是天氣。",
  "唯一答案來自第二段。",
  "哪一選項最貼近原文?",
  "某一選項提到經費。",
];

/** Must not match. The first six are known false-positive families (five 繁中, one English); the
 * rest are phrasings the published Sets use, or the required form itself. */
const MUST_NOT_MATCH = [
  "其他選項一致指向錯誤的時間。",
  "其餘選項一律與原文無關。",
  "選項一旦提及具體數字就會失準。",
  "這些選項二者皆非。",
  "其餘選項三番兩次偏離主題。",
  "選項 describes a different event.",
  "其餘選項均無根據。",
  "四個選項都與原文無關。",
  "選項之一提到停車場。",
  "提到約在畫廊的選項答非所問。",
  "其餘選項分別回應弄壞器材、約中午見面、火車誤點。",
  "通知明確寫出「Saturday morning volunteer sign-up now open」及集合時間地點。",
  "選項一同出現時容易混淆。",
  "選項一起被排除。",
  "答案一致指向同一段。",
  "文中第一段提到沙漠植物的葉片構造。",
  "第一次提到的原因並非重點。",
  "第二個原因與本題無關。",
  "第三個步驟不影響答案。",
  // The trap the tightened Latin arm exists for: an explanation quoting an English line right after
  // an answer word, where the quote's own first word would otherwise read as an option label.
  "答案是「A new station stop was added midweek at Fernbrook Junction」。",
  "答案是 an important detail about the schedule。",
];

function falsePositivesIn(phrases: readonly string[]): { phrase: string; firedOn: string[] }[] {
  return phrases
    .filter((phrase) => referencesOptionByPosition(phrase))
    .map((phrase) => ({ phrase, firedOn: matchingPositionReferencePatterns(phrase) }));
}

describe("referencesOptionByPosition — slot references and the prose around them", () => {
  it("catches 選項 with a numeral or letter, and an ordinal before 選項", () => {
    const missed = BASIC_SLOT_REFERENCES.filter((phrase) => !referencesOptionByPosition(phrase));
    expect(missed).toEqual([]);
  });

  it("catches slot references without 選項, with a marker or particle beside it, bracketed, full-width, in 甲乙丙丁 or in English", () => {
    const missed = OTHER_SLOT_REFERENCE_SHAPES.filter((phrase) => !referencesOptionByPosition(phrase));
    expect(missed).toEqual([]);
  });

  it("catches further markers, spatial words, 項 after a letter, English labels and 則/條 counters", () => {
    const missed = FURTHER_SLOT_REFERENCES.filter((phrase) => !referencesOptionByPosition(phrase));
    expect(missed).toEqual([]);
  });

  it("does not fire on ordinary 繁中 that merely starts a word with a numeral, nor on a quoted English line", () => {
    expect(falsePositivesIn(MUST_NOT_MATCH)).toEqual([]);
  });

  it("does not fire on prose describing a transcript — the false positive a rewrite cannot remove", () => {
    expect(falsePositivesIn(TRANSCRIPT_DESCRIBING_PROSE)).toEqual([]);
  });

  it("does not fire on set-wide quantifier phrasings or on a Latin word ending in a-e before 選項", () => {
    expect(falsePositivesIn(QUANTIFIER_AND_LATIN_PROSE)).toEqual([]);
  });
});

/** Genuine label references after a determiner or quantifier. Only a numeral can end a Chinese
 * quantifier, so the quantifier guard applies to numeral markers and never to a Latin one. No other
 * arm catches these: `marker-then-item` needs 項 right after the letter, and 選 sits in between. */
const LABEL_AFTER_DETERMINER = [
  "其中B選項正確", "這A選項才對", "那A選項才是正解", "哪B選項正確?", "第B選項正確",
  "某B選項提到經費", "唯D選項提到停車場", "每B選項都提到時間", "任C選項皆可", "全B答案都錯",
  "同A選項一樣", "各A選項的長度不同", "兩A選項相同", "幾B選項重複", "單A選項不足",
];

/** `marker-then-item` is guarded on the right as well as the left: 項目, 項鍊, 項研究 are words. */
const LATIN_ITEM_COMPOUNDS = [
  "教授提到 A 項目的預算", "B項目的成本更高", "研究員說 C 項研究仍在進行",
  "他買了 a 項鍊當禮物", "pizza項目與本題無關",
];

/** Spatial description inside a clause that legitimately is about the answer, so the
 * answer-context guard cannot help. Common in this app's own content: campus directions and
 * lab-equipment walkthroughs. */
const SPATIAL_IN_ANSWER_CLAUSE = [
  "正確答案是女生說要在中間那個路口轉彎",
  "正確的描述是最右邊那個展櫃裡的化石",
  "答案指的是他放在左邊那個櫃子的資料",
  "不符的是最上面那個抽屜",
  "正解是他坐在最前面那個座位",
];

describe("referencesOptionByPosition — labels after a determiner, and words that only look like references", () => {
  it("catches a label reference after a determiner or quantifier — 其中B選項, 這A選項, 第B選項", () => {
    const missed = LABEL_AFTER_DETERMINER.filter((phrase) => !referencesOptionByPosition(phrase));
    expect(missed).toEqual([]);
  });

  it("does not fire on 項目 / 項鍊 / 項研究 after a Latin letter", () => {
    expect(falsePositivesIn(LATIN_ITEM_COMPOUNDS)).toEqual([]);
  });

  it("does not fire on spatial description inside an answer clause", () => {
    expect(falsePositivesIn(SPATIAL_IN_ANSWER_CLAUSE)).toEqual([]);
  });

  it("still catches those words when they anchor on an option noun", () => {
    const anchored = [
      "中間的選項才是正確的。", "最右邊的選項與原文無關。", "最左邊那個選項才對。",
      "最上面那個才是正解。", "答案是最上面那個。", "B項正確。", "A項與C項均為干擾。",
    ];
    expect(anchored.filter((phrase) => !referencesOptionByPosition(phrase))).toEqual([]);
  });
});

/** A bare option letter as the subject of a verdict, with no option noun: the shuffle relabels the
 * options, so each of these names a different option than the key once the Set publishes. */
const BARE_LETTER_LABELS = [
  "(B) 正確，文中提到停車場。",
  "C 才是正確答案，因為…",
  "B 錯誤，…",
  "C 才是正確答案，因為講者明確說要延期。",
  "A：文中未提及。",
  "B 錯誤，講者並沒有這樣說。",
  "A 為正解。",
  "（D）與原文矛盾。",
  // The same forms after clause punctuation, mid-Explanation.
  "文中提到停車場，(B) 正確。",
  "其餘說法都不對；C 才是正確答案。",
  "講者只提到時間。B：與原文不符。",
  // Full-width, lower case, other brackets.
  "Ｂ：與原文不符。",
  "b 錯誤，文中沒提到。",
  "【C】才是正解。",
  "「D」與原文矛盾。",
  // After a Chinese word rather than punctuation, and bracketed anywhere.
  "因此 B 正確。",
  "其中（C）未提及。",
  "所以 (b)：文中沒有提到。",
  // Two letters in one verdict.
  "A 與 C 均為干擾。",
  "A、C 皆錯。",
  "B 和 D 都不對。",
  // Forms the banked Sets use (rd-1d6486b7, lsn-03948a55, lsn-6de33148, lsn-7c5cf3f6,
  // lsn-fc96bdab): a lower-case letter after 故, a list of letters, a letter in parentheses with no
  // verdict beside it, and the letter as what to choose.
  "文章明確指出協會沒有法定否決權,故b錯;文中未提及強制註冊規定,故c錯。",
  "b、c、d 皆與對話內容矛盾或未提及。",
  "(b)(c)(d)在原文中皆無根據，屬於干擾選項。",
  "(b)僅為支持性解釋而非主旨、(c)原文未評價APP可靠性。",
  "文章未提法定回覆期限(b)、電話自動併入請願(c)或市府不留紀錄(d),均缺乏文本依據。",
  "修復師說明動物膠可逆，故選(a)。",
  "應選 B，其餘皆不符。",
  "得體回應應追問新班別的上課時間;b誤把情境當作退選,c答非所問要求改約。",
];

/** Single capitals that are not option labels: English the Explanation quotes, a CEFR level, a
 * Latin name with a letter in it, an id, and the four banked Explanations that would catch a looser
 * rule (rd-6d02b750 dl-r2-q1 and dl-r3-q2, rd-efd07fb4 dl-r1-q1, lsn-0488674a ann-lo2-q1). */
const LETTER_LOOKALIKES = [
  "A student asked about the deadline.",
  "講者說「A student asked about the deadline」。",
  "屬於 B2 程度的字彙。",
  "達到 C1 程度即可。",
  "CEFR B1 等級的用語。",
  "他們決定改用 Plan B，因為場地太小。",
  "補充 vitamin C 才是重點。",
  "題目 q-A 的敘述與原文矛盾。",
  "Room 2B 正確的開放時間是九點。",
  "FAQ 寫著「Q: Can I return it? A: Yes, within a week」。",
  "清單寫著「A, B and C are due Friday」。",
  "教授把受試者分成 A、B 兩組，結果相反。",
  "拿到 A 的學生不多。",
  "B 非常重要的一點是時間。",
  "請從標示「B」的入口進場。",
  "展品「Exhibit (A) shows the oldest map」是講者舉的例子。",
  "乘客說「switch to a window」，告知六B可用正好同意。",
  "時刻表註記寫明「A new station stop was added midweek at Fernbrook Junction」,並在該站旁標示「(new stop)」,可知新增停靠站為Fernbrook Junction,其餘車站原本皆已存在。",
  "「Fixed」段落指出「A login bug ... has been fixed in this latest update」,可知修正的是登入問題;交易紀錄載入速度屬於「Improved」項目,共享預算是尚未推出的「Coming Soon」功能。",
  "公告明確指出改到Baxter Hall 220室，Hall B 104室是原本的舊教室，服務台只是詢問處，並非新教室位置。",
  "公告說明原教室容納不下這麼多人，因此更換到 Hall B。提到設備問題、講者要求更大舞台、教室被重複預約的選項原文均未提到。",
];

describe("referencesOptionByPosition — a bare option letter", () => {
  it("catches a letter that leads a clause or is the subject of a verdict, in every bracket, width and case", () => {
    const missed = BARE_LETTER_LABELS.filter((phrase) => !referencesOptionByPosition(phrase));
    expect(missed).toEqual([]);
  });

  it("does not fire on quoted English, a CEFR level, a Latin name, an id, or the banked Explanations a looser rule would catch", () => {
    expect(falsePositivesIn(LETTER_LOOKALIKES)).toEqual([]);
  });
});

describe("the detector and the remediation prompt are one artifact", () => {
  it("every forbidden example the prompt names is caught by the detector, in the context it appears in", () => {
    // Two of the 24, 第一個 and 第一項, are caught only inside a clause about the answer, because
    // standing alone they ordinarily describe a transcript. So the prompt forbids a strict superset
    // of what the detector catches, the right way round (target inside tolerance), and the coupling
    // is asserted at the level where it holds.
    const uncaught = POSITION_REFERENCE_FORBIDDEN_EXAMPLES.filter(
      (example) => !referencesOptionByPosition(`正確答案是${example}，其餘皆不符。`),
    );
    expect(uncaught).toEqual([]);
    const contextDependent = POSITION_REFERENCE_FORBIDDEN_EXAMPLES.filter((e) => !referencesOptionByPosition(e));
    expect(contextDependent).toEqual(["第一個", "第一項"]);
  });

  // The list is pinned exactly, so dropping an example from the prompt fails here rather than
  // leaving the suite green.
  it("the forbidden list is exactly this, so an entry cannot be quietly dropped from the prompt", () => {
    expect([...POSITION_REFERENCE_FORBIDDEN_EXAMPLES]).toEqual([
      "選項一", "選項A", "選項１", "選項（二）", "選項甲", "B選項",
      "第一個選項", "第二選項", "第一個", "第一項",
      "最後一個選項", "最前面的選項", "前兩個選項", "上面那個選項", "一號選項",
      "首選", "末項", "答案為(B)", "正解為 A", "the first option", "option B",
      "(B) 正確", "C 才是正解", "A：未提及",
    ]);
  });

  it("every required-form example the prompt offers is accepted by the detector", () => {
    const wronglyCaught = POSITION_REFERENCE_REQUIRED_EXAMPLES.filter((example) => referencesOptionByPosition(example));
    expect(wronglyCaught).toEqual([]);
  });

  it("the instruction ships both lists, and states the required form before the ban", () => {
    const instruction = positionReferenceInstruction();
    for (const example of POSITION_REFERENCE_FORBIDDEN_EXAMPLES) expect(instruction).toContain(example);
    for (const example of POSITION_REFERENCE_REQUIRED_EXAMPLES) expect(instruction).toContain(example);
    // A bare prohibition pushes the model into unnamed paraphrases, so the permitted form comes
    // first, stated as a form rather than as an absence.
    expect(instruction.indexOf("唯一允許的寫法")).toBeLessThan(instruction.indexOf("禁止使用下列"));
  });

  it("the two generation guides warn about the same near-miss paraphrases the detector catches", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const root = path.resolve(here, "../..");
    for (const guide of [
      ".claude/skills/toefl-reading/references/generation-guide.md",
      ".claude/skills/toefl-listening/references/generation-guide.md",
    ]) {
      const text = fs.readFileSync(path.join(root, guide), "utf8");
      // Every entry: the guides' lists are hand-written copies of the exported array, and this keeps
      // them from drifting apart.
      for (const example of POSITION_REFERENCE_FORBIDDEN_EXAMPLES) expect(text).toContain(example);
      // ...and no gate-only number appears in a model-visible file: a model that learns a tolerance
      // drifts toward it.
      expect(text).not.toContain("0.01");
      expect(text).not.toContain("1.4");
    }
  });
});

describe("referencesOptionByPosition — the real published Sets", () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const readingSet = JSON.parse(
    fs.readFileSync(path.join(root, "data/question-sets/reading/rd-6d02b750.json"), "utf8"),
  ) as Record<string, { dailyLife: { questions: { explanationZh: string }[] }[]; academic: { questions: { explanationZh: string }[] }[] }>;
  const listeningSet = JSON.parse(
    fs.readFileSync(path.join(root, "data/question-sets/listening/lsn-14659f38.json"), "utf8"),
  ) as Record<string, {
    listenChoose: { explanationZh: string }[];
    conversations: { questions: { explanationZh: string }[] }[];
    announcements: { questions: { explanationZh: string }[] }[];
    academicTalks: { questions: { explanationZh: string }[] }[];
  }>;
  const MODULES = ["router", "lowerModule", "upperModule"] as const;

  it("matches all 60 Explanations of lsn-14659f38, a published Set whose Explanations name options by position", () => {
    const explanations = MODULES.flatMap((m) => [
      ...listeningSet[m]!.listenChoose.map((i) => i.explanationZh),
      ...listeningSet[m]!.conversations.flatMap((s) => s.questions.map((q) => q.explanationZh)),
      ...listeningSet[m]!.announcements.flatMap((s) => s.questions.map((q) => q.explanationZh)),
      ...listeningSet[m]!.academicTalks.flatMap((s) => s.questions.map((q) => q.explanationZh)),
    ]);
    expect(explanations).toHaveLength(60);
    expect(explanations.filter((e) => !referencesOptionByPosition(e))).toEqual([]);
  });

  it("matches none of the 28 MCQ Explanations of rd-6d02b750 — no false positive on published 繁中 prose", () => {
    const explanations = MODULES.flatMap((m) => [
      ...readingSet[m]!.dailyLife.flatMap((t) => t.questions.map((q) => q.explanationZh)),
      ...readingSet[m]!.academic.flatMap((p) => p.questions.map((q) => q.explanationZh)),
    ]);
    expect(explanations).toHaveLength(28);
    expect(explanations.filter((e) => referencesOptionByPosition(e))).toEqual([]);
  });
});

// The option-length cue (optionQuality.ts, part 2): whether a group's keys are the longest option
// more often than that group's own chance rate allows, and which Items to send for a fix.

function sample(id: string, label: string, lengths: number[], correctIndex: number): OptionBiasSample {
  return {
    label,
    id,
    options: lengths.map((len, i) => ({ id: `${id}-o${i}`, text: "x".repeat(len) })),
    correctOptionId: `${id}-o${correctIndex}`,
  };
}

const CAP = 1000; // "no cap" for the tests that are not about the cap

describe("optionLengthBiasFlags — each length measure is gated against its own exact chance rate", () => {
  it("neutralProbability is the item's own chance rate, not 1/n: ties suppress it", () => {
    const chars = OPTION_LENGTH_MEASURES.find((m) => m.name === "character length")!;
    const distinct = sample("q", "router/daily_life/x", [50, 40, 30, 20], 0);
    expect(neutralProbability(chars, distinct.options)).toBeCloseTo(0.25, 10);
    // Two options tied at the top: no option is strictly longest, so the predicate can never fire.
    const tied = sample("q", "router/daily_life/x", [50, 50, 30, 20], 0);
    expect(neutralProbability(chars, tied.options)).toBe(0);
    // A three-option Item's chance rate is 1/3, so 3- and 4-option Items cannot share one `1/n`.
    const three = sample("q", "router/conversation/x", [50, 40, 30], 0);
    expect(neutralProbability(chars, three.options)).toBeCloseTo(1 / 3, 10);
  });

  it("the word measure has its own, different chance rate on the same item", () => {
    const words = OPTION_LENGTH_MEASURES.find((m) => m.name === "word count")!;
    const options = [
      { id: "a", text: "one two three" },
      { id: "b", text: "aaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      { id: "c", text: "bb" },
      { id: "d", text: "cc" },
    ];
    // Only "a" is strictly longest by words; "b" is strictly longest by characters. One null shared
    // by the two measures would gate each against the wrong chance rate.
    expect(neutralProbability(words, options)).toBeCloseTo(0.25, 10);
    expect(isStrictlyLongestBy(words, options, "a")).toBe(true);
    expect(isStrictlyLongestBy(words, options, "b")).toBe(false);
    const chars = OPTION_LENGTH_MEASURES.find((m) => m.name === "character length")!;
    expect(isStrictlyLongestBy(chars, options, "b")).toBe(true);
  });

  it("flags a group biased on word count alone, with every option the same character length", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      label: "router/daily_life/x",
      id: `q${i}`,
      options: [
        { id: "o0", text: "one two three".padEnd(30, ".") },
        { id: "o1", text: "aaa".padEnd(30, ".") },
        { id: "o2", text: "bbb".padEnd(30, ".") },
        { id: "o3", text: "ccc".padEnd(30, ".") },
      ],
      correctOptionId: "o0",
    }));
    for (const item of items) expect(new Set(item.options.map((o) => o.text.length)).size).toBe(1);
    const flags = optionLengthBiasFlags(items, CAP);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((f) => f.detail.includes("word count"))).toBe(true);
  });

  it("tailAtLeast is the exact Poisson-binomial tail, so mixed option counts are handled natively", () => {
    expect(tailAtLeast([0.25, 0.25, 0.25, 0.25], 4)).toBeCloseTo(0.25 ** 4, 10);
    expect(tailAtLeast([0.25, 0.25, 0.25, 0.25], 0)).toBeCloseTo(1, 10);
    // 3-option and 4-option items in one group: mean is 1/3 + 1/4, not 2 * 1/n for any single n.
    expect(tailAtLeast([1 / 3, 0.25], 2)).toBeCloseTo((1 / 3) * 0.25, 10);
  });
});

describe("optionLengthBiasFlags — the ceiling fires on real cues and not on chance", () => {
  it("does not flag a chance-neutral group: 4 of 16 four-option keys longest is exactly the chance rate", () => {
    const items = [
      ...Array.from({ length: 4 }, (_, i) => sample(`hit${i}`, "router/daily_life/x", [50, 20, 20, 20], 0)),
      ...Array.from({ length: 12 }, (_, i) => sample(`miss${i}`, "router/daily_life/x", [20, 50, 20, 20], 0)),
    ];
    expect(optionLengthBiasFlags(items, CAP)).toEqual([]);
  });

  it("does not flag a single-item group, or three of four — small samples are not evidence", () => {
    expect(optionLengthBiasFlags([sample("q", "router/daily_life/x", [50, 20, 20, 20], 0)], CAP)).toEqual([]);
    const threeOfFour = [
      ...Array.from({ length: 3 }, (_, i) => sample(`hit${i}`, "router/daily_life/x", [50, 20, 20, 20], 0)),
      sample("miss", "router/daily_life/x", [20, 50, 20, 20], 0),
    ];
    expect(optionLengthBiasFlags(threeOfFour, CAP)).toEqual([]);
  });

  it("flags a group whose share is meaningfully above its own chance rate", () => {
    const items = [
      ...Array.from({ length: 12 }, (_, i) => sample(`hit${i}`, "router/daily_life/x", [50, 20, 20, 20], 0)),
      ...Array.from({ length: 8 }, (_, i) => sample(`miss${i}`, "router/daily_life/x", [20, 50, 20, 20], 0)),
    ];
    const flags = optionLengthBiasFlags(items, CAP);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((f) => f.id.startsWith("hit"))).toBe(true);
  });

  // With the key drawn uniformly among each Item's options, the Set carries no length information,
  // so every flag is a false positive. The bound is loose so the test is fast and cannot flake.
  it("fires on under a fifth of chance-neutral Sets", () => {
    const shapes: number[][] = [[52, 31, 24, 19], [40, 38, 22, 21], [33, 30, 28], [61, 25, 24, 12], [45, 44, 20]];
    let rngState = 20260811;
    const nextRandom = (): number => {
      rngState = (rngState * 1103515245 + 12345) % 2147483648;
      return rngState / 2147483648;
    };
    const TRIALS = 400;
    let fired = 0;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const items: OptionBiasSample[] = [];
      for (const [taskType, count] of [["daily_life", 13], ["academic", 15]] as const) {
        for (let i = 0; i < count; i += 1) {
          const moduleName = ["router", "lowerModule", "upperModule"][i % 3]!;
          const lengths = shapes[i % shapes.length]!;
          const item = sample(`${taskType}-${i}`, `${moduleName}/${taskType}/x`, lengths, 0);
          const drawn = Math.floor(nextRandom() * item.options.length);
          items.push({ ...item, correctOptionId: item.options[drawn]!.id });
        }
      }
      if (optionLengthBiasFlags(items, 12).length > 0) fired += 1;
    }
    expect(fired / TRIALS).toBeLessThan(0.2);
  });
});

describe("optionLengthBiasFlags — option-count and module subpopulations", () => {
  // 12 three-option Items at 0% and 4 four-option Items at 100% in one legal `academic_talk`
  // bucket. Pooled that is 4/16 = 25.0% against a 43.8% pooled ceiling and passes, while a User
  // reaching those four wins every time by picking the longest. The Listening guide allows the
  // 3-/4-option mixture.
  it("catches a four-option concentration hiding inside a pooled bucket lifted by three-option items", () => {
    const items = [
      ...Array.from({ length: 12 }, (_, i) => sample(`three${i}`, "router/academic_talk/x", [20, 50, 20], 0)),
      ...Array.from({ length: 4 }, (_, i) => sample(`four${i}`, "router/academic_talk/x", [50, 20, 20, 20], 0)),
    ];
    const flags = optionLengthBiasFlags(items, CAP);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((f) => f.id.startsWith("four"))).toBe(true);
    expect(flags.every((f) => f.detail.includes("4-option"))).toBe(true);
    // ...and the pooled Task Type group passes on its own, or this test would prove nothing.
    expect(flags.some((f) => f.detail.includes(`within "academic_talk"`))).toBe(false);
  });

  it("catches a concentration confined to one module while the pooled task type passes", () => {
    const items = [
      ...Array.from({ length: 10 }, (_, i) => sample(`r${i}`, "router/academic/x", [20, 50, 20, 20], 0)),
      ...Array.from({ length: 15 }, (_, i) => sample(`lo${i}`, "lowerModule/academic/x", [20, 50, 20, 20], 0)),
      ...Array.from({ length: 5 }, (_, i) => sample(`up${i}`, "upperModule/academic/x", [50, 20, 20, 20], 0)),
    ];
    const flags = optionLengthBiasFlags(items, CAP);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.every((f) => f.id.startsWith("up"))).toBe(true);
    // The `module`, `module+task-type` and fine groups have identical membership on this fixture,
    // so de-duplication names the coarsest. What matters is that a module-grain group caught it,
    // not which of the three is named.
    expect(flags.every((f) => /within "upperModule(?:\/academic(?:\/4-option)?)?"/.test(f.detail))).toBe(true);
    expect(flags.some((f) => f.detail.includes(`within "academic"`))).toBe(false);
  });

  it("de-duplicates groups with identical membership, so an option-count-uniform Set is not tested twice", () => {
    const items = Array.from({ length: 20 }, (_, i) => sample(`q${i}`, "router/daily_life/x", [50, 20, 20, 20], 0));
    const flags = optionLengthBiasFlags(items, CAP);
    // One group, one measure: the excess is counted once, not once per level.
    expect(new Set(flags.map((f) => f.id)).size).toBe(flags.length);
    expect(flags.every((f) => f.detail.includes(`within "daily_life"`))).toBe(true);
  });
});

describe("optionLengthBiasFlags — taker paths and the whole Set", () => {
  function biasedItem(id: string, label: string, hit: boolean): OptionBiasSample {
    return {
      label,
      id,
      options: [50, 20, 20, 20].map((len, i) => ({ id: `${id}-o${i}`, text: "x".repeat(len) })),
      correctOptionId: hit ? `${id}-o0` : `${id}-o1`,
    };
  }
  /** `[module, taskType, count, howManyOfThemAreStrictlyLongest]` */
  function build(spec: [string, string, number, number][]): OptionBiasSample[] {
    const out: OptionBiasSample[] = [];
    for (const [moduleName, taskType, count, hits] of spec) {
      for (let i = 0; i < count; i += 1) out.push(biasedItem(`${moduleName}-${taskType}-${i}`, `${moduleName}/${taskType}/x`, i < hits));
    }
    return out;
  }
  const groupsOf = (flags: { detail: string }[]) => new Set(flags.map((f) => /within "([^"]+)"/.exec(f.detail)![1]!));

  // `moduleRouter.ts`'s `decidePath` sends every Attempt to the Router Module plus exactly one of
  // Lower and Upper, so `router+lowerModule` and `router+upperModule` are the only populations a
  // Simulation sits. Here the bias is spread across two Task Types inside one such path, thinly
  // enough that no Task Type group, no fine group and not the whole Set can reject it (5 of 10 in a
  // 4-option group is a 1-in-13 event, not evidence), while the path sits at 20 of 40 = 50% against
  // a 25% chance rate. This level keeps bias from being parked in one arm of the routing tree.
  it("catches a concentration spread across one taker path while every other group passes", () => {
    const flags = optionLengthBiasFlags(
      build([
        ["router", "daily_life", 10, 5], ["router", "academic", 10, 5],
        ["lowerModule", "daily_life", 10, 5], ["lowerModule", "academic", 10, 5],
        ["upperModule", "daily_life", 20, 0], ["upperModule", "academic", 20, 0],
      ]),
      CAP,
    );
    expect(flags.length).toBeGreaterThan(0);
    expect(groupsOf(flags)).toEqual(new Set(["router+lowerModule"]));
    // The clean path is untouched: no upperModule Item is remediated for someone else's bias.
    expect(flags.filter((f) => f.id.startsWith("upperModule"))).toEqual([]);
  });

  it("catches a Set-wide concentration that every path, task type and fine group individually tolerates", () => {
    const flags = optionLengthBiasFlags(
      build([
        ["lowerModule", "daily_life", 10, 5], ["lowerModule", "academic", 10, 5],
        ["upperModule", "daily_life", 10, 5], ["upperModule", "academic", 10, 5],
      ]),
      CAP,
    );
    expect(flags.length).toBeGreaterThan(0);
    expect(groupsOf(flags)).toEqual(new Set(["the whole Set"]));
  });

  it("still flags only the excess at a coarse level, so a Set-wide finding is not a Set-wide regeneration", () => {
    const flags = optionLengthBiasFlags(
      build([
        ["lowerModule", "daily_life", 10, 5], ["lowerModule", "academic", 10, 5],
        ["upperModule", "daily_life", 10, 5], ["upperModule", "academic", 10, 5],
      ]),
      CAP,
    );
    // 40 items, chance count 10, ceiling 14 -> 20 - 14 = 6 fixes, not all 20 flagged items.
    expect(flags).toHaveLength(6);
  });
});

describe("optionLengthBiasFlags — the Router Module and the single-Task-Type Drill population", () => {
  function biasedItem(id: string, label: string, hit: boolean): OptionBiasSample {
    return {
      label,
      id,
      options: [50, 20, 20, 20].map((len, i) => ({ id: `${id}-o${i}`, text: "x".repeat(len) })),
      correctOptionId: hit ? `${id}-o0` : `${id}-o1`,
    };
  }
  function build(spec: [string, string, number, number][]): OptionBiasSample[] {
    const out: OptionBiasSample[] = [];
    for (const [moduleName, taskType, count, hits] of spec) {
      for (let i = 0; i < count; i += 1) out.push(biasedItem(`${moduleName}-${taskType}-${i}`, `${moduleName}/${taskType}/x`, i < hits));
    }
    return out;
  }
  const groupsOf = (flags: { detail: string }[]) => new Set(flags.map((f) => /within "([^"]+)"/.exec(f.detail)![1]!));

  // Drills never route: both Drill pages call `stimuliForKinds(set.router, kinds)`, so the Router
  // Module is the whole scored population of every Drill, and a full Drill sits all of it. Without a
  // Router-only group, a bias of 9/12 = 75.0% (Reading) or 18/26 = 69.2% (Listening) confined to
  // the Router passes with no flag. Here the bias is spread across two router Task Types thinly
  // enough that no Task Type, fine, path or Set-wide group can reject it.
  it("catches a concentration confined to the Router Module, which every Drill sits end to end", () => {
    const flags = optionLengthBiasFlags(
      build([
        ["router", "daily_life", 8, 5], ["router", "academic", 8, 5],
        ["lowerModule", "daily_life", 12, 0], ["lowerModule", "academic", 12, 0],
        ["upperModule", "daily_life", 12, 0], ["upperModule", "academic", 12, 0],
      ]),
      CAP,
    );
    expect(flags.length).toBeGreaterThan(0);
    expect(groupsOf(flags)).toEqual(new Set(["router"]));
    expect(flags.every((f) => f.id.startsWith("router"))).toBe(true);
  });

  // The single-Task-Type Drill population, `router ∩ taskType` as a whole. The schema allows 3 or 4
  // options per Listening question and the guide asks for "3-4 options per question", so a Set that
  // mixes counts inside one router Task Type splits that Drill into two fine cells, and only this
  // group gates it whole. This fixture is that Set.
  it("catches a drill population that a mixed-option-count Set splits across two fine cells", () => {
    const threeOption = (id: string, hit: boolean): OptionBiasSample => ({
      label: "router/conversation/x",
      id,
      options: [50, 20, 20].map((len, i) => ({ id: `${id}-o${i}`, text: "x".repeat(len) })),
      correctOptionId: hit ? `${id}-o0` : `${id}-o1`,
    });
    const items: OptionBiasSample[] = [
      ...Array.from({ length: 8 }, (_, i) => threeOption(`c3-${i}`, i < 6)),
      ...Array.from({ length: 8 }, (_, i) => biasedItem(`c4-${i}`, "router/conversation/x", i < 5)),
      // Clean padding, so `router`, `conversation` and the taker paths are all populations other
      // than `router/conversation`, and all pass: otherwise de-duplication would hand the finding
      // to a coarser group and this test would prove nothing.
      ...Array.from({ length: 20 }, (_, i) => biasedItem(`rt-${i}`, "router/academic_talk/x", false)),
      ...Array.from({ length: 24 }, (_, i) => biasedItem(`lo-${i}`, "lowerModule/conversation/x", false)),
      ...Array.from({ length: 20 }, (_, i) => biasedItem(`up-${i}`, "upperModule/academic_talk/x", false)),
    ];
    const flags = optionLengthBiasFlags(items, CAP);
    expect(flags.length).toBeGreaterThan(0);
    // Neither fine cell can reject its own half (6/8 three-option and 5/8 four-option both sit inside
    // their own tolerances); the drill population as a whole is what fails.
    expect(groupsOf(flags)).toEqual(new Set(["router/conversation"]));
  });
});

describe("optionLengthBiasFlags — the excess is drawn across modules rather than concentrated", () => {
  function item(id: string, moduleName: string, hit: boolean): OptionBiasSample {
    return {
      label: `${moduleName}/daily_life/x`,
      id,
      options: [50, 20, 20, 20].map((len, i) => ({ id: `${id}-o${i}`, text: "x".repeat(len) })),
      correctOptionId: hit ? `${id}-o0` : `${id}-o1`,
    };
  }

  it("draws a group's excess across every module rather than in traversal order", () => {
    // Sized so exactly one group flags, the whole Set (15 of 30, chance 7.5, ceiling 10.5), while
    // every module group (5 of 10, ceiling 6) and both taker paths (10 of 20, ceiling 10) pass. That
    // isolates the order within the group: the excess is 5 and traversal starts at the router, so
    // taking the first five hits would draw only router Items and leave the bias concentrated in
    // the modules traversed last.
    const items = [
      ...Array.from({ length: 10 }, (_, i) => item(`router-${i}`, "router", i < 5)),
      ...Array.from({ length: 10 }, (_, i) => item(`lower-${i}`, "lowerModule", i < 5)),
      ...Array.from({ length: 10 }, (_, i) => item(`upper-${i}`, "upperModule", i < 5)),
    ];
    const flags = optionLengthBiasFlags(items, CAP);
    expect(flags).toHaveLength(5);
    // One task type only, so the task-type group and the Set-wide group have identical membership
    // and de-duplicate to the first-listed name.
    expect(new Set(flags.map((f) => /within "([^"]+)"/.exec(f.detail)![1]!))).toEqual(new Set(["daily_life"]));
    const drawnFrom = (prefix: string) => flags.filter((f) => f.id.startsWith(prefix)).length;
    expect(drawnFrom("router")).toBeGreaterThan(0);
    expect(drawnFrom("lower")).toBeGreaterThan(0);
    expect(drawnFrom("upper")).toBeGreaterThan(0);
  });

  it("draws from the module that is furthest above its own chance rate first", () => {
    // upperModule is the worst offender by share (8 of 10) and is not starved by a module that is
    // merely traversed earlier.
    const items = [
      ...Array.from({ length: 10 }, (_, i) => item(`router-${i}`, "router", i < 3)),
      ...Array.from({ length: 10 }, (_, i) => item(`lower-${i}`, "lowerModule", i < 4)),
      ...Array.from({ length: 10 }, (_, i) => item(`upper-${i}`, "upperModule", i < 8)),
    ];
    const flags = optionLengthBiasFlags(items, 3);
    expect(flags).toHaveLength(3);
    expect(flags.filter((f) => f.id.startsWith("upper")).length).toBeGreaterThanOrEqual(1);
    expect(flags[0]!.id.startsWith("upper")).toBe(true);
  });
});

describe("optionLengthBiasFlags — excess-only, capped and deferring", () => {
  it("flags only the excess needed to bring the group back under its own ceiling", () => {
    const items = Array.from({ length: 20 }, (_, i) => sample(`q${i}`, "router/daily_life/x", [50, 20, 20, 20], 0));
    // 20 Items, chance count 20 * 0.25 = 5, ceiling 5 * 1.4 = 7 -> 20 - 7 = 13 fixes, not 20.
    expect(optionLengthBiasFlags(items, CAP)).toHaveLength(13);
  });

  it("caps the per-round draw and defers the rest — the selection is recomputed, never marked", () => {
    const items = Array.from({ length: 40 }, (_, i) => sample(`q${i}`, "router/daily_life/x", [50, 20, 20, 20], 0));
    const round1 = optionLengthBiasFlags(items, 12);
    expect(round1).toHaveLength(12);
    // "Fix" round 1's Items by moving the key off the longest option, then re-run: the same
    // function, with no memory of round 1, picks a different batch rather than re-flagging the fixed
    // ones or returning nothing.
    const fixed = new Set(round1.map((f) => f.id));
    const afterRound1 = items.map((item) =>
      fixed.has(item.id) ? { ...item, correctOptionId: item.options[1]!.id } : item,
    );
    const round2 = optionLengthBiasFlags(afterRound1, 12);
    expect(round2.length).toBeGreaterThan(0);
    expect(round2.filter((f) => fixed.has(f.id))).toEqual([]);
  });

  it("draws round-robin across offending groups so one group cannot starve another", () => {
    const items = [
      ...Array.from({ length: 20 }, (_, i) => sample(`dl${i}`, "router/daily_life/x", [50, 20, 20, 20], 0)),
      ...Array.from({ length: 20 }, (_, i) => sample(`ap${i}`, "router/academic/x", [50, 20, 20, 20], 0)),
    ];
    const flags = optionLengthBiasFlags(items, 12);
    expect(flags).toHaveLength(12);
    expect(flags.filter((f) => f.id.startsWith("dl")).length).toBeGreaterThan(0);
    expect(flags.filter((f) => f.id.startsWith("ap")).length).toBeGreaterThan(0);
  });

  it("returns an empty selection rather than a violation when nothing is over its ceiling", () => {
    expect(optionLengthBiasFlags([], CAP)).toEqual([]);
    const neutral = Array.from({ length: 20 }, (_, i) =>
      sample(`q${i}`, "router/daily_life/x", [20, 50, 20, 20], i % 4),
    );
    expect(optionLengthBiasFlags(neutral, CAP)).toEqual([]);
  });

  it("never puts item text in `detail` — it reaches job.error and the Dashboard", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      label: "router/daily_life/x",
      id: `q${i}`,
      options: [
        { id: "o0", text: "the community centre closes for renovation on Friday afternoon" },
        { id: "o1", text: "short" },
        { id: "o2", text: "brief" },
        { id: "o3", text: "small" },
      ],
      correctOptionId: "o0",
    }));
    const flags = optionLengthBiasFlags(items, CAP);
    expect(flags.length).toBeGreaterThan(0);
    for (const flag of flags) {
      expect(flag.detail).not.toContain("community centre");
      expect(flag.detail).not.toContain("renovation");
    }
  });
});

describe("wordCount", () => {
  it("counts word tokens, not whitespace-separated tokens", () => {
    expect(wordCount("a b — c")).toBe(3);
    expect(wordCount("  well-known don't  ")).toBe(2);
    expect(wordCount("— —")).toBe(0);
    expect(wordCount("")).toBe(0);
  });
});
