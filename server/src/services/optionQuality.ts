// ---------------------------------------------------------------------------
// Option-quality checks shared by readingGenerator.ts and listeningGenerator.ts: the
// position-reference rule for Explanations (PART 1) and the option-length cue (PART 2). Each is an
// algorithm with a vocabulary, so it has one definition here rather than a copy per generator.
//
// The file holds model-visible TARGETS (PART 1's prompt fragments) and gate-only TOLERANCES (PART 2's
// numbers). A spawned CLI cannot read this file (claudeRunner.ts denies `Read` on `server/**`), but
// the two are kept apart anyway: a model-visible target and a gate-only tolerance must never leak
// into each other in either direction, so no number crosses between the two halves of this file.
// ---------------------------------------------------------------------------

// ===========================================================================
// PART 1 — the position-reference rule: detector and prompt text, ONE artifact
// ===========================================================================
//
// Both generators shuffle every MCQ's options as the last change to a Set
// (`rebalanceReadingOptionOrder` / `rebalanceListeningOptionOrder`), so an `explanationZh` that names
// an option by its position or label describes a slot the shuffle may reassign. A flagged
// Explanation is sent for a rewrite; one still flagged when the repair budget runs out keeps its
// Item's option order (`finishVerifiedSet`), so it stays true.
//
// The detector and the prompt are designed together. An instruction that only says "never name an
// option by its slot" pushes the model to paraphrase the ban — 「選項一」 becomes 「第一個」 or
// 「最後一個選項」 — and each paraphrase lands outside a narrow regex. So:
//   * The prompt states the REQUIRED FORM positively (POSITION_REFERENCE_REQUIRED_FORM): point at an
//     option only by what it says. Explanations usually already describe each option's content
//     behind the label, so complying is a deletion, not a rewrite.
//   * The prompt names the forbidden class by example (POSITION_REFERENCE_FORBIDDEN_EXAMPLES),
//     covering every family the detector knows, so there is no unnamed neighbour to drift into.
//   * The detector implements that class (POSITION_REFERENCE_PATTERNS).
//   * `optionQuality.test.ts` pins the join: every forbidden example is caught by the detector and
//     every required-form example is not.

/** Counting numerals, for "第X" / "前兩" style references. */
const NUMERAL = "[一二兩三四五1234５１２３４]";
/** The nouns a positional marker can be attached to. */
const OPTION_NOUN = "(?:選項|選擇|答案|正解|解答)";
/** Characters that make a numeral after 選項 the first character of an ordinary word rather than a
 * slot label: 其他選項一致…, 其餘選項一律…, 選項一旦…, 這些選項二者皆非, 其餘選項三番兩次…. */
const NUMERAL_WORD_TAIL = "[致律旦起樣定併再直般同體連概來半些點切方如向者次番處周端]";
/** Nouns that make a bare "第X個/第X項" clearly NOT an option ("第二個原因", "第三個步驟"). */
const NON_OPTION_NOUN =
  "(?:原因|步驟|段|部分|例子|問題|重點|字|詞|句|行|頁|空格|階段|特徵|理由|條件|因素|地方|人|禮拜|星期|月|小時|動作|主題|活動|實驗|樣本|假設|講者|學生|建議|提問|環節|地點|時間|研究|案例" +
  // Physical objects and places: a relative position before one of these describes the scene the
  // transcript describes, not an option slot.
  "|路口|抽屜|櫃子|展櫃|櫃|架子|架|房間|桌子|桌|椅子|座位|門|窗|走廊|樓層|樓|箱子|箱|盒子|盒|資料夾|檔案|標示|招牌|建築|入口|出口|轉角|街|路)";
/**
 * A bare 前 or 後 standing for a slot. On its own it is a relative position only when a count
 * follows it (前兩個選項, 後一項); anywhere else it is the tail of an ordinary word — 提前, 延後,
 * 目前, 之前, 之後 — and 「提前的選項」 is the option that SAYS "move it earlier", which is the
 * required content form rather than a slot. The lookbehind is the same guard for the counted form.
 */
const BARE_FRONT_BACK = `(?<![提延目之以事先從往向然隨稍])[前後](?=\\s*${NUMERAL})`;
/**
 * Relative-position words that can stand in for an ordinal, in two vocabularies. POSITION_WORD is
 * used where an option noun follows ("中間的選項", "最右邊的選項"). POSITION_WORD_ANCHORLESS serves
 * the counter arm, which has no option noun to anchor on, and so leaves out 中間/右邊/左邊: there they
 * would match spatial description inside a clause that really is about the answer
 * ("正確答案是女生說要在中間那個路口轉彎"), which the answer-context guard cannot exclude. Campus
 * directions and lab walkthroughs make such clauses common in this app's own content.
 */
const POSITION_WORD =
  `(?:最前面|最後面|最上面|最下面|最右邊|最左邊|最前|最後|最上|最下|最末|最初|最先|開頭|結尾|前面|後面|上面|下面|上方|下方|右邊|左邊|中間|${BARE_FRONT_BACK})`;
const POSITION_WORD_ANCHORLESS =
  `(?:最前面|最後面|最上面|最下面|最前|最後|最上|最下|最末|最初|最先|開頭|結尾|前面|後面|上面|下面|上方|下方|${BARE_FRONT_BACK})`;
const BRACKET_OPEN = "[（(【\\[［「『]";
const COPULA = "(?:是|為|係|即|＝|=|:|：)?";
/**
 * Left guards for `marker-then-noun`, one per marker type: a marker is a label only when nothing
 * immediately before it makes it part of another word. A Latin marker must not end a Latin word
 * (「提到 pizza 選項的敘述不符」, 「與 data 答案無關」). A numeral marker must not end a quantifier or
 * determiner (「任一選項皆可」, 「其中一選項提到停車場」, 「每一選項」, 「唯一答案」), which describes
 * the option set, the required form. Only a numeral can end a Chinese quantifier, so the Han guard
 * does not apply to Latin markers: 「其中B選項正確」 and 「第B選項正確」 are label references, and no
 * other arm would catch them.
 */
const NOT_AFTER_LATIN = "(?<![A-Za-z])";
const NOT_AFTER_QUANTIFIER = "(?<![任每唯哪另這那其中某各同單全第兩幾])";
const LATIN_MARKER = "[ABCDEabcdeＡＢＣＤＥａｂｃｄｅ]";
const NON_LATIN_MARKER = "[一二三四五1234５１２３４甲乙丙丁戊壹貳參肆]";

/**
 * Two arms name an option by ordinal alone, with no option noun: `bare-ordinal` (第一個/第一項) and
 * `position-word-counter` (最後一個/最後一項). Those phrases are about an option only when their
 * clause is about the answer; otherwise they are ordinary description, and a Listening Explanation
 * cites the transcript, which enumerates things (第三個學生沒有發言, 第一個講者提到費用). So those two
 * arms match only in a clause that also holds an answer-context word. Clauses split on commas as
 * well as sentence terminators, so 「教授先講第一個主題,再回到第二個」 cannot borrow context from a
 * neighbouring clause.
 *
 * The trade is deliberate. A false positive cannot be removed by a rewrite, so its Item re-flags
 * every round, pays for a rewrite each time and publishes with a note it did not earn; a missed
 * ordinal costs one Explanation that may name the wrong slot. The prompt and both generation guides
 * forbid the whole class regardless of what this regex catches.
 */
const ANSWER_CONTEXT_RE =
  /正確|正解|正答|答案|解答|才是|才對|為對|對的|錯誤|不對|不符|干擾|無關|矛盾|未提及|沒提到|應選|應為|選錯|是解/u;
const CLAUSE_BOUNDARY_RE = /[。！？!?；;，,、\n]/u;

/**
 * A bare option letter, the way the client labels options (A–D by position): half- or full-width,
 * either case. Lower case is included because the banked option ids are lower case and a model may
 * mirror them ("b 錯誤").
 */
const OPTION_LETTER = "[A-DＡ-Ｄa-dａ-ｄ]";
const LETTER_BRACKET_OPEN = "[（(【\\[［「『]";
const LETTER_BRACKET_CLOSE = "[）)】\\]］」』]";
/** The brackets only an option label sits in. Quote marks are left out: 「B」 can be a sign or a
 * gate the Stimulus names, and is a label only with a verdict after it. */
const LETTER_PAREN_OPEN = "[（(【\\[［]";
const LETTER_PAREN_CLOSE = "[）)】\\]］]";
/**
 * One option letter standing alone: bracketed, or bare with no Latin letter, digit, hyphen or
 * underscore after it, so "B2", "C1", "A student" and an id such as "q-A1" are not labels.
 */
const LETTER_LABEL =
  `(?:${LETTER_BRACKET_OPEN}\\s*${OPTION_LETTER}\\s*${LETTER_BRACKET_CLOSE}|${OPTION_LETTER}(?![A-Za-z0-9_\\-]))`;
/** Where a clause starts: the start of the Explanation, or right after clause punctuation. */
const CLAUSE_START = "(?:^|[。！？!?；;，,、：:\\n])\\s*";
/**
 * The verdicts an Explanation pronounces on an option, which make the letter in front of them its
 * subject: 「B 錯誤」, 「C 才是正確答案」, 「A 為正解」, 「（D）與原文矛盾」, 「B 未提及」, 「b、c、d 皆與原文矛盾」.
 */
const LETTER_JUDGEMENT =
  "(?:(?:也|則|就|並|皆|均|都|即|亦|故)\\s*)?(?:(?:是|為|屬|乃)\\s*)?" +
  "(?:正確|正解|正答|答案|錯誤|錯的|對的|干擾|誤|不正確|不對|有誤|錯(?![過開落])|才是|才對" +
  "|未(?![來必婚滿])|沒提到|沒有提到|並非|非(?!常)|不符|無關|無根據|缺乏|矛盾|相反|答非所問|離題|原文未|文中未" +
  "|與[^。！？!?；;，,\\n]*?(?:矛盾|不符|無關|相反|不同|不一致))";
/**
 * A colon or comma closing a letter label, 「A：文中未提及」, 「B，因為…」. Never followed by Latin text,
 * so an English line the Explanation quotes ("A: The library opens at nine", "A, B and C") is not
 * a label.
 */
const LETTER_SEPARATOR = "\\s*[：:，,](?!\\s*[A-Za-zＡ-Ｚａ-ｚ])";

export type PositionReferencePattern = {
  readonly name: string;
  readonly re: RegExp;
  /** When true the match only counts if its own clause is about the answer — see ANSWER_CONTEXT_RE. */
  readonly needsAnswerContext?: boolean;
};

/** Each pattern is named so a test failure says WHICH family fired, and so the battery in
 * optionQuality.test.ts can report coverage family by family rather than as one boolean. */
export const POSITION_REFERENCE_PATTERNS: readonly PositionReferencePattern[] = [
  // 選項一 · 選項 B · 選項（一） · 選項【二】 · 選項１ · 選項Ｂ · 選項甲 · 選項壹 · 答案為(B) · 正解為 A ·
  // 正確答案是 a.
  // A Latin marker counts only when no Latin letter follows it, so English right after the noun is
  // not read as a label: 「選項 describes a different event」, or an Explanation quoting an option —
  // 「答案是「A new station stop was added」」. A Han marker counts only when NUMERAL_WORD_TAIL does
  // not follow it.
  {
    name: "noun-then-marker",
    re: new RegExp(
      `${OPTION_NOUN}\\s*${COPULA}\\s*${BRACKET_OPEN}?\\s*(?:[一二三四五甲乙丙丁戊壹貳參肆](?!${NUMERAL_WORD_TAIL})|[ABCDEabcdeＡＢＣＤＥａｂｃｄｅ](?!\\s*[A-Za-z])|[1234５１２３４])`,
      "u",
    ),
  },
  // B選項 · A選項 · Ａ選項 · 甲選項 · １選項 — the marker before the noun, the most common
  // alternative in 繁中 test-prep prose. "四個選項" / "兩個選項" do not match: a counter (個) sits
  // between the numeral and the noun.
  {
    name: "marker-then-noun",
    re: new RegExp(
      `(?:${NOT_AFTER_LATIN}${LATIN_MARKER}|${NOT_AFTER_QUANTIFIER}${NON_LATIN_MARKER})\\s*${OPTION_NOUN}`,
      "u",
    ),
  },
  // B項 · A項與C項均為干擾 — 項 alone is not an OPTION_NOUN (第一項 is bare-ordinal's job), so this arm
  // takes Latin labels only, which are never anything but labels here. The right guard keeps out
  // 項目 / 項鍊 / 項研究 ("教授提到 A 項目的預算", "他買了 a 項鍊當禮物").
  { name: "marker-then-item", re: /(?<![A-Za-z])[A-Ea-eＡＢＣＤＥａｂｃｄｅ]\s*項(?![目鍊鏈練圈研工任作])/u },
  // 第一個選項 · 第二選項 · 第一句選項 · 排在第一的選項 · 第二個答案
  { name: "ordinal-then-noun", re: new RegExp(`第\\s*${NUMERAL}\\s*[個項題條句欄則]?\\s*[的那]?\\s*${OPTION_NOUN}`, "u") },
  // 第一個 · 第一項 · 第一則 — an ordinal standing alone FOR an option, with no 選項 noun anywhere.
  {
    name: "bare-ordinal",
    re: new RegExp(`第\\s*${NUMERAL}\\s*[個項則條](?!\\s*${NON_OPTION_NOUN})`, "u"),
    needsAnswerContext: true,
  },
  // 一號選項 · 二號答案
  { name: "numbered-noun", re: new RegExp(`${NUMERAL}\\s*號\\s*${OPTION_NOUN}`, "u") },
  // 最後一個選項 · 最前面的選項 · 前兩個選項 · 上面那個選項 · 中間的選項
  {
    name: "position-word-noun",
    re: new RegExp(`${POSITION_WORD}\\s*${NUMERAL}?\\s*[個項面]?\\s*[的那]?\\s*(?:個\\s*)?${OPTION_NOUN}`, "u"),
  },
  // 最後一項 · 最後一個 · 最上面那個 — the same relative position with no 選項 noun.
  {
    name: "position-word-counter",
    re: new RegExp(`${POSITION_WORD_ANCHORLESS}\\s*${NUMERAL}?\\s*[的那]?\\s*[個項](?!\\s*${NON_OPTION_NOUN})`, "u"),
    needsAnswerContext: true,
  },
  // 首選 · 末項 · 首項
  { name: "head-tail", re: /(?:首|末)\s*(?:選項|選|項|個|答案)/u },
  // An Explanation may quote an option's own English words (the required form allows it), so the
  // English ordinal and label forms are covered too.
  {
    name: "english-ordinal",
    re: /\b(?:the\s+)?(?:first|second|third|fourth|fifth|last|final|top|topmost|bottom|bottommost|former|latter|preceding|above|below|1st|2nd|3rd|4th|5th)\s+(?:one|option|choice|answer|item)\b/iu,
  },
  // Upper-case letters and digits only: 「the answer a new station stop…」 would otherwise read
  // "answer a" as a label, and an article is far more likely than a lower-case option label here.
  // The noun is case-insensitive by hand rather than with the `i` flag, because `i` would also make
  // the marker class match a-e. `Answer: B` needs the colon arm.
  { name: "english-label", re: /\b[OoCcAaIi](?:ption|hoice|nswer|tem)\s*(?:is\s*|[:：]\s*)?[（([]?\s*[A-E1-5](?![A-Za-z0-9])/u },
  // The bare letter, with no option noun anywhere: 「(B) 正確」 · 「C 才是正確答案」 · 「A：文中未提及」 ·
  // 「B 錯誤」 · 「A 為正解」 · 「（D）與原文矛盾」, at the start of the Explanation or of any clause.
  // A letter is a label here only where nothing but clause punctuation stands before it and a
  // colon, a comma or a verdict follows it.
  //
  // The guards keep English the Explanation quotes out: a letter after a Latin word ("Plan B，",
  // "vitamin C 才是重點", "Hall B"), inside a token ("B2", "C1", "q-A"), or opening an English line
  // ("A student asked…", "「A new stop…」") is never a label. The trade runs the other way from the
  // two answer-context arms above. A false positive here costs one Explanation rewrite, or leaves one
  // Item's options unshuffled when the rewrite does not take; a false negative publishes an
  // Explanation that names a different option than the key, because the finishing shuffle moves the
  // option the letter named. So these arms take a letter followed by a verdict wherever a Chinese
  // clause puts it, and accept the rare non-option letter they catch.
  {
    name: "letter-at-clause-start",
    re: new RegExp(`${CLAUSE_START}${LETTER_LABEL}(?:${LETTER_SEPARATOR}|\\s*${LETTER_JUDGEMENT})`, "u"),
  },
  // The same letter-led verdict mid-clause, after a Chinese word: 「因此 B 正確」 · 「其中（C）未提及」.
  {
    name: "letter-after-han",
    re: new RegExp(`(?<=\\p{Script=Han})\\s*${LETTER_LABEL}\\s*${LETTER_JUDGEMENT}`, "u"),
  },
  // A letter in brackets or quote marks before a verdict is a label wherever it stands, unless a
  // Latin word precedes it: 「所以 (b)：」 · 「「D」與原文矛盾」.
  {
    name: "bracketed-letter",
    re: new RegExp(
      `(?<![A-Za-z0-9]\\s*)${LETTER_BRACKET_OPEN}\\s*${OPTION_LETTER}\\s*${LETTER_BRACKET_CLOSE}(?:${LETTER_SEPARATOR}|\\s*${LETTER_JUDGEMENT})`,
      "u",
    ),
  },
  // A letter in parentheses or square brackets needs no verdict: 「(b)僅為支持性解釋」 · 「(b)(c)(d)皆無
  // 根據」 · 「電話自動併入請願(c)」. Only English text after it, or a Latin word before it, makes it
  // something else ("Exhibit (A)", "(A) is the first step").
  {
    name: "parenthesized-letter",
    re: new RegExp(
      `(?<![A-Za-z0-9]\\s*)${LETTER_PAREN_OPEN}\\s*${OPTION_LETTER}\\s*${LETTER_PAREN_CLOSE}(?!\\s*[A-Za-z0-9])`,
      "u",
    ),
  },
  // A letter as what to choose: 「故選(a)」 · 「應選 B」.
  { name: "choose-letter", re: new RegExp(`選\\s*${LETTER_LABEL}`, "u") },
  // Two letters joined in one verdict: 「A 與 C 均為干擾」 · 「A、C 皆錯」 · 「B 和 D 都不對」. The verdict is
  // required in the same clause, so 「A、B 兩組受試者」 describing an experiment's groups is not a label.
  {
    name: "letter-pair",
    re: new RegExp(
      `(?<![A-Za-z0-9_\\-]\\s*)${OPTION_LETTER}\\s*(?:和|與|及|跟|或|、|，|,)\\s*${OPTION_LETTER}(?![A-Za-z0-9_\\-])[^。！？!?；;，,\\n]*?${LETTER_JUDGEMENT}`,
      "u",
    ),
  },
];

/** The pattern families `text` actually trips, answer-context requirement included. Exported so a
 * failing battery assertion can name the family rather than just report a boolean. */
export function matchingPositionReferencePatterns(text: string): string[] {
  const clauses = text.split(CLAUSE_BOUNDARY_RE);
  return POSITION_REFERENCE_PATTERNS.filter((pattern) =>
    pattern.needsAnswerContext
      ? clauses.some((clause) => pattern.re.test(clause) && ANSWER_CONTEXT_RE.test(clause))
      : pattern.re.test(text),
  ).map((pattern) => pattern.name);
}

/**
 * True when `text` points at an option by where it sits or what it is labelled rather than by what
 * it says. A bare 選項 with no marker ("其餘選項", "四個選項都", "提到約在畫廊的選項") does not match:
 * it describes the option set or an option's content, stays true under any order, and is the form
 * the prompt asks for.
 *
 * A phrasing outside the families above is not caught, which is why the prompt specifies the
 * required form positively instead of relying on this detector alone.
 */
export function referencesOptionByPosition(text: string): boolean {
  return matchingPositionReferencePatterns(text).length > 0;
}

// --- The model-visible half of the same artifact -------------------------------------------------
// These strings are interpolated verbatim into both generators' remediation prompts and restated in
// both generation guides. They state a TARGET and name a forbidden class, and must never quote a
// gate number.

/** The positive specification: the ONE permitted way to point at an option. Stated first, and as a
 * minimal edit of what the model already writes, so "comply" is a deletion rather than a redesign. */
export const POSITION_REFERENCE_REQUIRED_FORM =
  "點到某個選項時，只能用「它說了什麼」來指認它 — 例如「提到停車場的選項」「說要改約週五的那個」，或直接引用該選項自己的英文原文。這是唯一允許的寫法。你原本的解析通常已經寫出了每個選項的內容，只是在前面多掛了一個位置標籤；把標籤刪掉、保留內容描述就對了。";

/** The forbidden class, named by example so there is no unnamed neighbour to drift into. Every
 * string here is asserted to be caught by `referencesOptionByPosition` (optionQuality.test.ts). */
export const POSITION_REFERENCE_FORBIDDEN_EXAMPLES: readonly string[] = [
  "選項一",
  "選項A",
  "選項１",
  "選項（二）",
  "選項甲",
  "B選項",
  "第一個選項",
  "第二選項",
  "第一個",
  "第一項",
  "最後一個選項",
  "最前面的選項",
  "前兩個選項",
  "上面那個選項",
  "一號選項",
  "首選",
  "末項",
  "答案為(B)",
  "正解為 A",
  "the first option",
  "option B",
  "(B) 正確",
  "C 才是正解",
  "A：未提及",
];

/** Strings in the REQUIRED form — permutation-invariant, and asserted NOT to be caught. Shipped in
 * the prompts as the "write it like this instead" half. */
export const POSITION_REFERENCE_REQUIRED_EXAMPLES: readonly string[] = [
  "提到停車場的選項",
  "說要改約週五的那個選項",
  "其餘選項均無根據",
  "四個選項都與原文無關",
];

/** The whole instruction block, assembled once so both generators send the identical wording. */
export function positionReferenceInstruction(): string {
  return [
    "選項的排列順序會在發佈前被伺服器重新洗牌，所以任何指涉「位置」或「標籤」的說法都會變成錯的。",
    POSITION_REFERENCE_REQUIRED_FORM,
    `禁止使用下列任何一種寫法（含同類變體）：${POSITION_REFERENCE_FORBIDDEN_EXAMPLES.join("、")}。`,
    `應該寫成這樣：${POSITION_REFERENCE_REQUIRED_EXAMPLES.join("、")}。`,
  ].join(" ");
}

// ===========================================================================
// PART 2 — the option-length cue
// ===========================================================================
//
// A User who always picks the longest option should do no better than chance. optionLengthBiasFlags
// finds groups of Items whose keys are the strictly longest option more often than chance allows,
// and returns the excess for regeneration.

/** Whitespace-separated tokens that contain a letter or digit, so a stray dash is not a word. The
 * option-length word measure and both generators' word-count gates share this one definition. */
export function wordCount(text: string): number {
  return text
    .trim()
    .split(/\s+/u)
    .filter((token) => /\p{L}|\p{N}/u.test(token)).length;
}

export type OptionLengthMeasure = { readonly name: string; readonly of: (text: string) => number };

/**
 * The two length cues a User can read off option text without the Stimulus: characters and words.
 * Bounding one does not bound the other, so both are gated, each separately against its own exact
 * chance rate. A combined "longest by characters OR by words" predicate fires more often than either
 * alone, so measuring it against one cue's chance rate both flags chance-neutral Sets and bounds
 * each cue more loosely than intended.
 */
export const OPTION_LENGTH_MEASURES: readonly OptionLengthMeasure[] = [
  { name: "character length", of: (text) => text.length },
  { name: "word count", of: (text) => wordCount(text) },
];

type OptionLike = { readonly id: string; readonly text: string };

/** True when `optionId`'s option is the unique longest by `measure`; a tie for longest is false. */
export function isStrictlyLongestBy(
  measure: OptionLengthMeasure,
  options: readonly OptionLike[],
  optionId: string,
): boolean {
  const target = options.find((option) => option.id === optionId);
  if (target === undefined) return false; // a dangling correctOptionId is a different violation
  const values = options.map((option) => measure.of(option.text));
  const max = Math.max(...values);
  return measure.of(target.text) === max && values.filter((value) => value === max).length === 1;
}

/**
 * The exact chance rate of "this Item's key is the strictly longest option by `measure`" under the
 * null that the key is independent of option length: the share of the Item's own options that would
 * satisfy the predicate if they were the key. Derived from the option texts, so it needs no
 * calibration constant and holds for any option count (a Listening question has 3 or 4).
 *
 * It is `1/n` or 0, not always `1/n`: ties suppress the predicate, so an Item whose two longest
 * options are equally long has a chance rate of 0 on that measure, and the two measures can give the
 * same Item different rates.
 */
export function neutralProbability(measure: OptionLengthMeasure, options: readonly OptionLike[]): number {
  if (options.length === 0) return 0;
  return options.filter((option) => isStrictlyLongestBy(measure, options, option.id)).length / options.length;
}

/** P(X >= k) for X ~ PoissonBinomial(ps): the exact distribution of "how many of this group's keys
 * are the strictly longest option" under the null, given each Item's own chance rate. Exact rather
 * than a normal approximation because the groups that matter most are small, which is where a
 * normal approximation is worst. O(n²) in the group size. */
export function tailAtLeast(probabilities: readonly number[], k: number): number {
  let distribution = [1];
  for (const p of probabilities) {
    const next = new Array<number>(distribution.length + 1).fill(0);
    for (let i = 0; i < distribution.length; i += 1) {
      next[i]! += distribution[i]! * (1 - p);
      next[i + 1]! += distribution[i]! * p;
    }
    distribution = next;
  }
  return distribution.slice(k).reduce((sum, value) => sum + value, 0);
}

export type OptionBiasSample = {
  /** `"<module>/<taskType>/<stimulusId>"`, as both generators build it; grouping reads the module and
   * Task Type from it. */
  readonly label: string;
  readonly id: string;
  readonly options: readonly OptionLike[];
  readonly correctOptionId: string;
};

export type OptionBiasFlag = {
  readonly id: string;
  readonly label: string;
  /** Counts, group names and measure names only — never Item text. It can reach `job.error`, which
   * the client displays, through a verify-exhaustion error, and Set content never goes into an
   * error or a log. */
  readonly detail: string;
};

// --- gate-only tolerances (never model-visible; see this file's header) ---------------------------

/**
 * The effect-size bound: a group is over its ceiling when its count of strictly-longest keys exceeds
 * this multiple of its expected count under the null, per measure. A flag needs this AND the tail
 * bound (NEUTRAL_TAIL_ALPHA). The tail is the stricter of the two at every group size a Set produces
 * (this bound starts to bind only at about 70–100 Items), so this multiplier rarely decides WHETHER
 * a group is flagged. It decides HOW MUCH is remediated: a flagged group gives up
 * `hits - floor(expected * this)` Items, so a remediated group settles near this multiple of chance.
 */
const NEUTRAL_MARGIN_MULTIPLIER = 1.4;

/**
 * The noise bound: a group is flagged only when its count is also implausible under its own exact
 * null, P(at least this many | chance) < this. Without it small groups would fire constantly: 3 of 4
 * four-option keys being longest happens 5.1% of the time by chance. It is what makes the
 * per-module and per-option-count groups affordable.
 *
 * The floor is detectability: four 4-option Items whose keys are all longest have a null
 * probability of 0.25^4 ≈ 0.0039, so a value at or below that cannot see them. The ceiling is the
 * false-positive budget: every flag on a chance-neutral Set buys rewrite calls, and a larger value
 * flags more of them (optionQuality.test.ts bounds the rate). At 0.005 the gate would miss a real
 * cue on a published Reading Set, `rd-6d02b750`, whose Daily Life keys are longest by characters in
 * 8 of 13 questions (P ≈ 0.0056).
 */
const NEUTRAL_TAIL_ALPHA = 0.01;

/**
 * The groups each measure is tested over; an Item is flagged if any group containing it is flagged.
 *
 * A small group cannot be held near chance, because its tolerated share is set by the tail bound,
 * and that is a property of sample size rather than calibration: four 4-option Items tolerate 3 of 4
 * keys longest, twenty tolerate 10 of 20, and tightening that floods chance-neutral Sets with false
 * positives. So the levels bound every population a User actually answers, each tested whole:
 *
 * - "task-type": a Set's questions of one Task Type.
 * - "taker-path": `router+lowerModule` and `router+upperModule`. A Simulation takes the Router Module
 *   and exactly one second module (moduleRouter.ts), so these are the two populations a Simulation
 *   answers; Router Module Items belong to both.
 * - "module": the Router Module is the whole scored population of every Reading and Listening Drill
 *   (both Drills queue `set.router` only), and a second module is a Simulation's second timed block.
 * - "module+task-type": what a single-Task-Type Drill answers (`router ∩ taskType`).
 * - "the whole Set".
 * - "module+task-type+option-count": a Listening question has 3 or 4 options, so a concentrated
 *   4-option subgroup could otherwise hide under a ceiling raised by 3-option Items' higher chance
 *   rate.
 *
 * Groups with identical membership are tested once, so an option-count-uniform Set pays for the fine
 * split only where it splits something. Level order decides only which name a de-duplicated group
 * reports.
 */
const GROUP_LEVELS = [
  "task-type",
  "taker-path",
  "module",
  "module+task-type",
  "the whole Set",
  "module+task-type+option-count",
] as const;

/** The group name(s) a sample belongs to at one level. Only "taker-path" returns more than one: a
 * Router Module item is answered on BOTH paths, so it belongs to both groups. */
function groupKeysFor(level: (typeof GROUP_LEVELS)[number], sample: OptionBiasSample): string[] {
  const [moduleName = "", taskType = sample.label] = sample.label.split("/");
  switch (level) {
    case "task-type":
      return [taskType];
    case "taker-path":
      return moduleName === "router"
        ? ["router+lowerModule", "router+upperModule"]
        : [`router+${moduleName}`];
    case "module":
      return [moduleName];
    case "module+task-type":
      return [`${moduleName}/${taskType}`];
    case "the whole Set":
      return ["the whole Set"];
    case "module+task-type+option-count":
      return [`${moduleName}/${taskType}/${sample.options.length}-option`];
  }
}

/** The module segment of a sample's label — `"router"`, `"lowerModule"`, `"upperModule"`. */
function moduleOf(sample: OptionBiasSample): string {
  return sample.label.split("/")[0] ?? "";
}

/**
 * Which of a flagged group's hits to remediate this round, when only `excess` of them are needed.
 *
 * Each draw comes from the module with the highest share of hits still undrawn (undrawn hits over
 * that module's members in the group), recomputed after every draw. Taking hits in traversal order
 * would leave the residual in the last-traversed module, because the loop stops as soon as no group
 * flags; a plain rotation equalises the count drawn per module rather than the share left, so a
 * small module keeps a high share. This only reorders: the same `excess` is drawn either way.
 * optionLengthBiasFlags's round-robin does the same job across groups.
 */
function excessAcrossModules(
  hits: readonly OptionBiasSample[],
  excess: number,
  members: readonly OptionBiasSample[],
): OptionBiasSample[] {
  const byModule = new Map<string, OptionBiasSample[]>();
  for (const hit of hits) {
    const list = byModule.get(moduleOf(hit));
    if (list) list.push(hit);
    else byModule.set(moduleOf(hit), [hit]);
  }
  const sizeByModule = new Map<string, number>();
  for (const member of members) sizeByModule.set(moduleOf(member), (sizeByModule.get(moduleOf(member)) ?? 0) + 1);

  const drawn: OptionBiasSample[] = [];
  const cursors = new Map<string, number>();
  while (drawn.length < excess) {
    let pick: string | undefined;
    let pickShare = -1;
    for (const [moduleName, queue] of byModule) {
      const cursor = cursors.get(moduleName) ?? 0;
      if (cursor >= queue.length) continue;
      const share = (queue.length - cursor) / (sizeByModule.get(moduleName) ?? queue.length);
      if (share > pickShare) { pickShare = share; pick = moduleName; }
    }
    if (pick === undefined) break;
    const cursor = cursors.get(pick) ?? 0;
    drawn.push(byModule.get(pick)![cursor]!);
    cursors.set(pick, cursor + 1);
  }
  return drawn;
}

/**
 * Every MCQ-shaped Item in one Set, in traversal order, in; the Items to remediate this round out.
 *
 * 1. Remediable, never blocking: this returns Items to fix, never a reason to discard the run.
 * 2. The cap defers, it never skips: the selection is recomputed from the current Set every verify
 *    round, with no mark-and-skip state, so an Item left out by `cap` is picked up next round. `cap`
 *    takes a round-robin prefix across offending groups so one group cannot starve another.
 * 3. Only the excess is flagged: a group over its ceiling contributes only as many Items as bring it
 *    back under its own effect-size ceiling, so a marginal group does not send every hit for
 *    regeneration.
 */
export function optionLengthBiasFlags(samples: readonly OptionBiasSample[], cap: number): OptionBiasFlag[] {
  if (samples.length === 0 || cap <= 0) return [];

  const offending: { readonly detailByItem: Map<string, OptionBiasFlag>; readonly queue: OptionBiasSample[] }[] = [];
  const seenMembership = new Set<string>();

  for (const level of GROUP_LEVELS) {
    const groups = new Map<string, OptionBiasSample[]>();
    for (const sample of samples) {
      for (const key of groupKeysFor(level, sample)) {
        const list = groups.get(key);
        if (list) list.push(sample);
        else groups.set(key, [sample]);
      }
    }
    for (const [groupName, members] of groups) {
      const membership = members.map((member) => member.id).join(",");
      if (seenMembership.has(membership)) continue;
      seenMembership.add(membership);

      for (const measure of OPTION_LENGTH_MEASURES) {
        const hits = members.filter((member) => isStrictlyLongestBy(measure, member.options, member.correctOptionId));
        const probabilities = members.map((member) => neutralProbability(measure, member.options));
        const expected = probabilities.reduce((sum, p) => sum + p, 0);
        const effectCeiling = expected * NEUTRAL_MARGIN_MULTIPLIER;
        if (hits.length <= effectCeiling) continue;
        if (tailAtLeast(probabilities, hits.length) >= NEUTRAL_TAIL_ALPHA) continue;

        const excess = Math.max(1, hits.length - Math.floor(effectCeiling));
        const queue = excessAcrossModules(hits, excess, members);
        const detailByItem = new Map<string, OptionBiasFlag>(
          queue.map((item) => [
            item.id,
            {
              id: item.id,
              label: item.label,
              detail: `within "${groupName}", ${hits.length} of ${members.length} answer keys are the strictly longest option by ${measure.name} among their own choices (an exploitable cue: a test taker can beat chance by always picking the longest) — rewrite this item's options so length alone no longer signals the key`,
            },
          ]),
        );
        offending.push({ detailByItem, queue });
      }
    }
  }
  if (offending.length === 0) return [];

  const selected: OptionBiasFlag[] = [];
  const chosen = new Set<string>();
  const cursors = offending.map(() => 0);
  let progressed = true;
  while (selected.length < cap && progressed) {
    progressed = false;
    for (let i = 0; i < offending.length && selected.length < cap; i += 1) {
      const group = offending[i]!;
      while (cursors[i]! < group.queue.length) {
        const candidate = group.queue[cursors[i]!]!;
        cursors[i] = cursors[i]! + 1;
        if (chosen.has(candidate.id)) continue; // already drawn from another group's queue
        chosen.add(candidate.id);
        selected.push(group.detailByItem.get(candidate.id)!);
        progressed = true;
        break;
      }
    }
  }
  return selected;
}
