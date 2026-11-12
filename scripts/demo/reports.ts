/**
 * Turns the demo's authored Responses into the exact rows scoring would have written: a Score Report
 * item for `item_results.score_json`, one Judge Report per Judge for `judge_reports.report_json`,
 * and a Delivery Report for a spoken Item.
 *
 * What a person wrote lives in content/*.ts: the Response itself, the final score, the Deductions,
 * the 繁體中文 summary and the Model Rewrite. What follows mechanically from those is built here:
 * the Judges' dimension scores and evidence, the reconciliation note, the Disagreement Flag and
 * single-Judge markers, and, for Listen and Repeat, everything, derived from the word diff between
 * the sentence and what the User said.
 *
 * Every object is parsed with the shared zod schema before it is returned, and every Deduction quote
 * is checked against the Response it marks, because the review page underlines quotes in place and a
 * quote that is not in the text silently underlines nothing.
 */
import {
  DeliveryReportSchema,
  JudgeReportSchema,
  ScoreReportSchema,
  type DeliveryReport,
  type ScoreReport,
} from "@toefl-prep/shared";
import { RUBRIC_DIMENSIONS } from "../../server/src/services/skillReferences.js";
import { wordDiff, type DiffOp } from "../../server/src/services/wordDiff.js";
import type { Rng } from "./rng.js";

export type Category = ScoreReport["items"][number]["deductions"][number]["category"];
export type Deduction = { quote: string; issue: string; fix: string; category: Category };
/** A Deduction as authored: quote (verbatim from the Response), issue, fix, category. */
export type AuthoredDeduction = readonly [quote: string, issue: string, fix: string, category: Category];

export type JudgeName = "gemini" | "openai";
export type JudgedTaskType = "email" | "discussion" | "interview";

/** The dimension names each Judge reports under, the ones the scoring code itself uses. */
export const DIMENSIONS = RUBRIC_DIMENSIONS;

/**
 * One judged Response (an email, a discussion post or an interview answer) as a person wrote it.
 * `dims` is the Arbiter's reading per dimension, in DIMENSIONS order; each Judge's dimension scores
 * are that profile moved by the gap between its own score and the final one.
 */
export type JudgedResponse = {
  text: string;
  final: number;
  /** The Arbiter's own score, committed before it read the Judges. Defaults to `final`. */
  own?: number;
  dims: readonly number[];
  /** Score Report dimension notes, in DIMENSIONS order. Built from `dims` when absent. */
  notes?: readonly string[];
  deductions: readonly AuthoredDeduction[];
  zh: string;
  rewrite: string;
  /** Each Judge's score; `null` means that Judge returned no report. Both default to `final`. */
  judges?: { gemini?: number | null; openai?: number | null };
  /** The OpenAI speaking Judge scored the transcript instead of the recording (Text Fallback). */
  openaiTextFallback?: true;
  reconciliation?: string;
  selfArbitrated?: true;
  delivery?: Partial<DeliveryReport>;
};

export type ScoreReportItem = ScoreReport["items"][number];
export type JudgeReportRow = { judge: JudgeName; reportJson: string };

const ScoreReportItemSchema = ScoreReportSchema.shape.items.element;

function halfStep(n: number): number {
  return Math.min(5, Math.max(0, Math.round(n * 2) / 2));
}

function level(score: number): "high" | "mid" | "low" {
  return score >= 4 ? "high" : score >= 3 ? "mid" : "low";
}

function formatScore(score: number): string {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

function assertQuotesIn(text: string, deductions: readonly Deduction[], where: string): void {
  for (const d of deductions) {
    if (!text.includes(d.quote)) throw new Error(`${where}: Deduction quote not found in the Response: ${JSON.stringify(d.quote)}`);
  }
}

type Bank = Record<"high" | "mid" | "low", readonly [string, string]>;

const LANGUAGE: Bank = {
  high: ["Accurate, with some variety in sentence structure.", "Few errors; word choice is mostly precise."],
  mid: ["Noticeable errors in agreement and tense, but the meaning is always clear.", "Mostly simple sentences with recurring small errors."],
  low: ["Frequent errors that sometimes slow the reader down.", "Limited range, with errors in most sentences."],
};
const MECHANICS: Bank = {
  high: ["No spelling or punctuation problems.", "Clean spelling and punctuation."],
  mid: ["One or two punctuation slips, such as a comma splice.", "Minor punctuation issues only."],
  low: ["Several run-on sentences.", "Repeated punctuation errors."],
};

const EVIDENCE: Record<string, Bank> = {
  "communicative goal & social conventions": {
    high: ["Every bullet is handled and the tone suits the reader.", "The purpose is clear from the first lines; requests are polite and direct."],
    mid: ["All bullets are present, though one gets a single sentence.", "Task completed; a few phrases are more casual than this reader calls for."],
    low: ["One bullet is only touched on, so the reader cannot act on it.", "The purpose is recoverable, but the requests are vague."],
  },
  "elaboration & cohesion": {
    high: ["Each point is backed by a concrete detail and the paragraphs follow naturally.", "Specific details throughout; the ideas connect without effort."],
    mid: ["Points are made, but only some are developed with specifics.", "Clear paragraphing; development is uneven across the bullets."],
    low: ["Ideas are listed rather than developed.", "Little detail beyond restating the bullets."],
  },
  "argument & engagement": {
    high: ["A clear position that answers the classmates directly.", "Takes a side and adds a point the thread did not already contain."],
    mid: ["A clear position, but the post mostly echoes one classmate.", "Position stated; engagement with the other view is brief."],
    low: ["The position is stated but not argued.", "Restates a classmate's view without adding to it."],
  },
  "support & cohesion": {
    high: ["The example is specific and tied back to the claim.", "Well-chosen support; the post builds to its conclusion."],
    mid: ["One relevant example, only partly developed.", "Support is relevant but thin in places."],
    low: ["Support is mostly general statements.", "The example is mentioned but not explained."],
  },
  "grammar & vocabulary": LANGUAGE,
  mechanics: MECHANICS,
  "topical elaboration": {
    high: ["Addresses the whole question with relevant detail.", "Well developed, with a specific example."],
    mid: ["Relevant, with limited development.", "Answers the question; the reasons are brief."],
    low: ["A short answer with little development.", "Mostly restates the options in the question."],
  },
  "pace & pausing": {
    high: ["Smooth, conversational pace.", "Few hesitations; the flow is natural."],
    mid: ["Frequent fillers, but the answer keeps moving.", "Some hesitation while planning sentences."],
    low: ["Long pauses interrupt the flow.", "Halting delivery with several restarts."],
  },
  "intelligibility & prosody": {
    high: ["Clear and easy to follow.", "Natural stress and intonation."],
    mid: ["Generally clear; intonation is fairly flat.", "Understandable, with occasional unclear word endings."],
    low: ["Needs listener effort in places.", "Several words are hard to make out."],
  },
};

const INTERVIEW_NOTES: Record<string, Bank> = {
  "topical elaboration": {
    high: ["Answers every part of the question and backs the point with a specific example.", "Fully on topic, with a concrete example that carries the answer."],
    mid: ["Answers the question with one relevant example; the reasoning could go one step further.", "On topic and clear, but each point gets only a sentence or two."],
    low: ["On topic, but the answer ends before any point is developed.", "Responds to the question in general terms, without an example."],
  },
  "pace & pausing": {
    high: ["Steady pace; pauses fall between ideas rather than inside them.", "Conversational pace with natural pauses."],
    mid: ["Fillers and a couple of mid-sentence pauses slow the answer without stopping it.", "A few hesitations while planning, but the answer keeps moving."],
    low: ["Long pauses and restarts break the answer into pieces.", "Halting; the listener waits for most sentences to finish."],
  },
  "intelligibility & prosody": {
    high: ["Easy to follow throughout, with natural stress on the key words.", "Clear, with intonation that marks where each idea ends."],
    mid: ["Clear overall; some word endings are swallowed and stress is fairly flat.", "Understandable, though stress falls on almost every word."],
    low: ["Mostly understandable, but several words run together.", "Needs effort to follow in the faster stretches."],
  },
  "grammar & vocabulary": {
    high: ["Mostly accurate, with a few complex sentences that work.", "Good control of tense and word choice."],
    mid: ["Simple structures, with recurring slips in articles, tense or agreement.", "Errors in verb forms and articles, though the meaning stays clear."],
    low: ["Frequent errors in basic grammar; vocabulary stays with everyday words.", "Limited range, with errors in most sentences."],
  },
};

function evidence(dimension: string, score: number, judgeIndex: 0 | 1): string {
  return EVIDENCE[dimension][level(score)][judgeIndex];
}

/** The Score Report item and Judge Reports one judged Response was scored to. */
export type JudgedScoring = {
  scoreItem: ScoreReportItem;
  /** `taskType`-level Judge Report JSON per Judge, in the order the ensemble writes them. */
  judgeReports: JudgeReportRow[];
};

function defaultReconciliation(scores: { gemini: number | null; openai: number | null }, own: number, final: number): string {
  const present = [scores.gemini, scores.openai].filter((s): s is number => s !== null);
  if (present.length === 1) {
    return `Only one Judge returned a report for this Response, so the score rests on that Judge's ${formatScore(present[0])} and the Arbiter's own reading of ${formatScore(own)}.`;
  }
  const [a, b] = present;
  if (a === b && own === final && a === final) {
    return `Both Judges gave ${formatScore(a)}, and the Arbiter's own reading, committed before it saw theirs, landed in the same place.`;
  }
  if (a === b) {
    return `Both Judges gave ${formatScore(a)}. The Arbiter's own reading was ${formatScore(own)}; it settled on ${formatScore(final)}, where the band description fits the whole response best.`;
  }
  return `The Judges gave ${formatScore(a)} and ${formatScore(b)}, half a point apart. The Arbiter's own reading was ${formatScore(own)}, and ${formatScore(final)} is the band whose description matches the response as a whole.`;
}

/**
 * Builds the persisted scoring of one judged Response. `taskType` picks the dimension names; for an
 * interview the Judge Reports carry a `mode`, as the speaking ensemble writes them.
 */
export function buildJudgedScoring(taskType: JudgedTaskType, itemId: string, r: JudgedResponse): JudgedScoring {
  const names = DIMENSIONS[taskType];
  if (r.dims.length !== names.length) throw new Error(`${itemId}: expected ${names.length} dimension scores`);
  const deductions: Deduction[] = r.deductions.map(([quote, issue, fix, category]) => ({ quote, issue, fix, category }));
  assertQuotesIn(r.text, deductions, `${taskType} ${itemId}`);

  const own = r.own ?? r.final;
  const scores = {
    gemini: r.judges?.gemini === undefined ? r.final : r.judges.gemini,
    openai: r.judges?.openai === undefined ? r.final : r.judges.openai,
  };
  const judgeReports: JudgeReportRow[] = [];
  (["gemini", "openai"] as const).forEach((judge, judgeIndex) => {
    const score = scores[judge];
    if (score === null) return;
    const shift = score - r.final;
    // Each Judge finds most of the Deductions, not the identical list: the first leaves out the
    // second-to-last, the other the last, whenever there are three or more to choose from.
    const skip = deductions.length >= 3 ? (judgeIndex === 0 ? deductions.length - 2 : deductions.length - 1) : -1;
    const item = {
      itemId,
      score,
      dimensions: names.map((name, i) => {
        const dimScore = halfStep(r.dims[i] + shift);
        return { name, score: dimScore, evidence: evidence(name, dimScore, judgeIndex as 0 | 1) };
      }),
      deductions: deductions.filter((_, i) => i !== skip),
    };
    const report = { judge, taskType, items: [item] };
    JudgeReportSchema.parse(report);
    const persisted =
      taskType === "interview"
        ? { ...report, mode: judge === "openai" && r.openaiTextFallback ? "text-fallback" : "audio" }
        : report;
    judgeReports.push({ judge, reportJson: JSON.stringify(persisted) });
  });
  if (judgeReports.length === 0) throw new Error(`${itemId}: a scored Response needs at least one Judge Report`);

  const notes = r.notes ?? names.map((name, i) => INTERVIEW_NOTES[name][level(r.dims[i])][0]);
  const singleJudge = judgeReports.length === 1;
  const lowConfidence = scores.gemini !== null && scores.openai !== null && Math.abs(scores.gemini - scores.openai) >= 1.5;
  const scoreItem: ScoreReportItem = {
    itemId,
    ownScore: own,
    finalScore: r.final,
    maxScore: 5,
    dimensions: names.map((name, i) => ({ name, note: notes[i] })),
    deductions,
    reconciliationNote: r.reconciliation ?? defaultReconciliation(scores, own, r.final),
    feedbackZh: r.zh,
    modelRewrite: r.rewrite,
    ...(singleJudge ? { singleJudge: true } : {}),
    ...(lowConfidence ? { lowConfidence: true } : {}),
    ...(r.selfArbitrated ? { selfArbitrated: true } : {}),
  };
  ScoreReportItemSchema.parse(scoreItem);
  return { scoreItem, judgeReports };
}

/** One Listen and Repeat Response as authored: what the User said, and the score it earned. */
export type RepeatResponse = {
  said: string;
  score: number;
  /** Words Ears flagged as possibly mispronounced. */
  mispronounced?: readonly string[];
  /** The OpenAI Judge's score where it differs from `score`. */
  openai?: number;
};

const FUNCTION_WORDS = new Set([
  "a", "an", "the", "to", "at", "in", "on", "of", "for", "by", "with", "and", "or", "but",
  "is", "are", "was", "were", "be", "it", "them", "her", "his", "their", "your", "my", "me",
  "you", "we", "who", "which", "that", "this", "each", "every", "before", "after", "then",
]);
const FILLERS = new Set(["um", "uh", "erm", "hmm"]);

function bare(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
}

function sameStem(a: string, b: string): boolean {
  const x = bare(a).replace(/'s$/, "");
  const y = bare(b).replace(/'s$/, "");
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 3 && long.startsWith(short.slice(0, Math.max(3, short.length - 1))) && long.length - short.length <= 3;
}

type Edit = {
  ops: DiffOp[];
  /** Index range in the said words this edit touches or sits between. */
  saidStart: number;
  saidEnd: number;
  targetStart: number;
  targetEnd: number;
};

/** Groups the diff into maximal runs of non-matching operations, with their word positions. */
function edits(diff: readonly DiffOp[]): Edit[] {
  const out: Edit[] = [];
  let said = 0;
  let target = 0;
  let current: Edit | null = null;
  for (const op of diff) {
    if (op.op === "match") {
      if (current) out.push(current);
      current = null;
      said += 1;
      target += 1;
      continue;
    }
    current ??= { ops: [], saidStart: said, saidEnd: said, targetStart: target, targetEnd: target };
    current.ops.push(op);
    if (op.op !== "omission") said += 1;
    if (op.op !== "insertion") target += 1;
    current.saidEnd = said;
    current.targetEnd = target;
  }
  if (current) out.push(current);
  return out;
}

type EditSummary = { deduction: Deduction; english: string; zh: string };

function describeEdit(edit: Edit, saidWords: readonly string[], targetWords: readonly string[]): EditSummary {
  // The quote is the edit plus one word of context on each side, taken from what the User said, so
  // it always occurs in the transcript. The fix is the same span of the sentence as it should be.
  const quoteStart = Math.max(0, edit.saidStart - 1);
  const quoteEnd = Math.min(saidWords.length, edit.saidEnd + 1);
  const fixStart = Math.max(0, edit.targetStart - 1);
  const fixEnd = Math.min(targetWords.length, edit.targetEnd + 1);
  let quote = saidWords.slice(quoteStart, Math.max(quoteEnd, quoteStart + 2)).join(" ");
  if (quote === "") quote = saidWords.slice(-2).join(" ");
  const fix = targetWords.slice(fixStart, Math.max(fixEnd, fixStart + 2)).join(" ");

  const omitted = edit.ops.filter((op) => op.op === "omission").map((op) => (op as { targetWord: string }).targetWord);
  const inserted = edit.ops.filter((op) => op.op === "insertion").map((op) => (op as { saidWord: string }).saidWord);
  const substituted = edit.ops.filter((op): op is Extract<DiffOp, { op: "substitution" }> => op.op === "substitution");
  const atEnd = edit.targetEnd === targetWords.length && omitted.length >= 2;
  const words = (list: readonly string[]) => list.map((w) => bare(w)).join(" ");

  if (atEnd && substituted.length === 0) {
    return {
      deduction: { quote, issue: `The end of the sentence ("${words(omitted)}") was not repeated.`, fix, category: "completeness" },
      english: `left off the ending ("${words(omitted)}")`,
      zh: `句尾的「${words(omitted)}」沒有說出來`,
    };
  }
  if (substituted.length > 0 && omitted.length === 0 && inserted.length === 0) {
    const pairs = substituted.map((s) => `"${bare(s.saidWord)}" for "${bare(s.targetWord)}"`).join(", ");
    const small = substituted.every((s) => FUNCTION_WORDS.has(bare(s.targetWord)) && FUNCTION_WORDS.has(bare(s.saidWord)));
    const ending = !small && substituted.every((s) => sameStem(s.saidWord, s.targetWord));
    return {
      deduction: {
        quote,
        issue: small
          ? `Said ${pairs}, a small word swapped for another.`
          : ending
            ? `Said ${pairs}: the word ending changed.`
            : `Said ${pairs}, which changes what the sentence says.`,
        fix,
        category: ending || small ? "grammar" : "content",
      },
      english: `said ${pairs}`,
      zh: substituted.map((s) => `把「${bare(s.targetWord)}」說成「${bare(s.saidWord)}」`).join("、"),
    };
  }
  if (omitted.length > 0 && inserted.length === 0 && substituted.length === 0) {
    const small = omitted.every((w) => FUNCTION_WORDS.has(bare(w)));
    return {
      deduction: {
        quote,
        issue: small ? `Dropped "${words(omitted)}".` : `Left out "${words(omitted)}", which carries part of the meaning.`,
        fix,
        category: small ? "grammar" : "content",
      },
      english: `dropped "${words(omitted)}"`,
      zh: small ? `少了「${words(omitted)}」` : `漏掉「${words(omitted)}」`,
    };
  }
  if (inserted.length > 0 && omitted.length === 0 && substituted.length === 0) {
    const filler = inserted.every((w) => FILLERS.has(bare(w)));
    return {
      deduction: {
        quote,
        issue: filler ? `A filler ("${words(inserted)}") broke up the sentence.` : `Added "${words(inserted)}", which is not in the sentence.`,
        fix,
        category: filler ? "pronunciation-proxy" : "grammar",
      },
      english: filler ? `paused on "${words(inserted)}"` : `added "${words(inserted)}"`,
      zh: filler ? `中間停下來說了「${words(inserted)}」` : `多加了「${words(inserted)}」`,
    };
  }
  // A mixed run: name both sides in the order they were said and heard.
  const heard = edit.ops.flatMap((op) => (op.op === "omission" || op.op === "substitution" ? [bare(op.targetWord)] : [])).join(" ");
  const spoken = edit.ops.flatMap((op) => (op.op === "insertion" || op.op === "substitution" ? [bare(op.saidWord)] : [])).join(" ");
  const contentLost = heard.split(" ").some((w) => !FUNCTION_WORDS.has(w) && !spoken.split(" ").some((s) => sameStem(s, w)));
  return {
    deduction: {
      quote,
      issue: `Said "${spoken}" where the sentence has "${heard}".`,
      fix,
      category: contentLost ? "content" : "grammar",
    },
    english: `said "${spoken}" for "${heard}"`,
    zh: `把「${heard}」說成「${spoken}」`,
  };
}

const PHRASE_STARTS = new Set([
  "beside", "near", "before", "after", "during", "against", "at", "in", "on", "to", "by", "for", "with",
  "should", "who", "which", "and", "then", "get", "gets", "go", "forms", "tracks", "make",
]);

/** The sentence cut into two halves at the phrase boundary nearest its middle, for the 繁中 tip. */
function splitSentence(target: string): [string, string] {
  const comma = target.indexOf(",");
  if (comma > 0 && comma < target.length - 2) return [target.slice(0, comma + 1), target.slice(comma + 1).trim()];
  const words = target.split(" ");
  const middle = words.length / 2;
  const boundaries = words.map((_, i) => i).filter((i) => i >= 2 && i <= words.length - 2 && PHRASE_STARTS.has(bare(words[i])));
  // Nearest the middle; of two equally near, the later one, so the subject stays with its verb.
  const cut = boundaries.reduce<number | null>(
    (best, i) => (best === null || Math.abs(i - middle) <= Math.abs(best - middle) ? i : best),
    null,
  ) ?? Math.ceil(middle);
  return [words.slice(0, cut).join(" "), words.slice(cut).join(" ")];
}

const ACCURACY_CLOSE: Record<number, string> = {
  4: "The meaning survives intact, which is what keeps it at 4.",
  3: "Enough changed that the sentence no longer says quite what it said.",
  2: "A large part of the sentence is missing, so the meaning comes through in fragments.",
  1: "Only a few words of the sentence came back.",
};

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function listEnglish(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function zhFeedback(score: number, issues: readonly string[], target: string): string {
  if (score >= 5) return "整句完整、正確地重複出來，字尾和小字都沒有漏掉，維持這個節奏。";
  const list = issues.join("、");
  if (score >= 4) return `意思完整保留，只是${list}，所以差一點拿到 5 分。重複時連小字和字尾都要照原句說。`;
  if (score >= 3) return `大部分內容都有說到，但${list}，句子的意思已經和原句有落差。長句可以先抓住主詞和動詞，再補上細節。`;
  const [first, second] = splitSentence(target);
  return `${list}，只重複出句子的一部分。聽到長句時，先在心裡把句子切成兩段來記：「${first} / ${second}」`;
}

/** The Score Report item, the meta's diff, and both Judge Reports for one Listen and Repeat Item. */
export function buildRepeatScoring(itemId: string, target: string, r: RepeatResponse) {
  const diff = wordDiff(target, r.said);
  const saidWords = r.said.trim().split(/\s+/);
  const targetWords = target.trim().split(/\s+/);
  const summaries = edits(diff).map((e) => describeEdit(e, saidWords, targetWords));
  const deductions = summaries.map((s) => s.deduction);
  assertQuotesIn(r.said, deductions, `listen_repeat ${itemId}`);
  if (r.score >= 5 && deductions.length > 0) throw new Error(`listen_repeat ${itemId}: a 5 must be word for word`);
  if (r.score < 5 && deductions.length === 0) throw new Error(`listen_repeat ${itemId}: an exact repetition scores 5`);

  const mis = r.mispronounced ?? [];
  const intelligibility = halfStep(Math.min(5, r.score + (mis.length > 0 ? 0.5 : 1)));
  const accuracyNote =
    r.score >= 5
      ? "Every word came back, in order."
      : `${capitalize(listEnglish(summaries.map((s) => s.english)))}. ${ACCURACY_CLOSE[Math.max(1, Math.floor(r.score))]}`;
  const intelligibilityNote =
    mis.length > 0
      ? `Clear apart from "${mis.join('", "')}", which was hard to catch.`
      : r.score >= 3
        ? "Every word that was said is easy to make out."
        : "What was said is clear, though the speaker trails off near the end.";

  const scores = { gemini: r.score, openai: r.openai ?? r.score };
  const judgeReports: JudgeReportRow[] = (["gemini", "openai"] as const).map((judge, judgeIndex) => {
    const score = scores[judge];
    const accuracyEvidence =
      r.score >= 5 ? ["Repeated word for word.", "Exact repetition."][judgeIndex] : `${capitalize(listEnglish(summaries.map((s) => s.english)))}.`;
    const item = {
      itemId,
      score,
      dimensions: [
        { name: DIMENSIONS.listen_repeat[0], score, evidence: accuracyEvidence },
        {
          name: DIMENSIONS.listen_repeat[1],
          score: halfStep(intelligibility + (score - r.score)),
          evidence: mis.length > 0 ? `"${mis[0]}" was unclear.` : ["Clear throughout.", "Easy to understand."][judgeIndex],
        },
      ],
      // The Judges agree on what changed; one of them lists only the first change it heard.
      deductions: judgeIndex === 1 && deductions.length > 1 ? deductions.slice(0, 1) : deductions,
    };
    const report = { judge, taskType: "listen_repeat" as const, items: [item] };
    JudgeReportSchema.parse(report);
    return { judge, reportJson: JSON.stringify({ ...report, mode: "audio" }) };
  });

  const reconciliationNote =
    scores.gemini === scores.openai
      ? `Both Judges heard the same ${deductions.length === 0 ? "exact repetition" : "changes"} and gave ${formatScore(r.score)}; the Arbiter's own reading agreed.`
      : `The Judges gave ${formatScore(scores.gemini)} and ${formatScore(scores.openai)}. The Arbiter's own reading was ${formatScore(r.score)}: ${(ACCURACY_CLOSE[Math.max(1, Math.floor(r.score))] ?? "").toLowerCase()}`;

  const scoreItem: ScoreReportItem = {
    itemId,
    ownScore: r.score,
    finalScore: r.score,
    maxScore: 5,
    dimensions: [
      { name: DIMENSIONS.listen_repeat[0], note: accuracyNote },
      { name: DIMENSIONS.listen_repeat[1], note: intelligibilityNote },
    ],
    deductions,
    reconciliationNote,
    feedbackZh: zhFeedback(r.score, summaries.map((s) => s.zh), target),
  };
  ScoreReportItemSchema.parse(scoreItem);
  return { scoreItem, judgeReports };
}

const PAUSES = {
  repeat: {
    high: "Smooth delivery with no noticeable hesitation.",
    mid: "A short hesitation partway through while recalling the second half.",
    low: "A long pause mid-sentence; the speaker restarted once and trailed off at the end.",
  },
  interview: {
    high: "Pauses fall at clause boundaries; a few fillers while planning the next point.",
    mid: "Frequent short fillers (um, uh) and two longer pauses while searching for words; the answer still moves forward.",
    low: "Long pauses between sentences and several restarts break up the flow.",
  },
} as const;

const INTELLIGIBILITY = {
  high: "Clear throughout; every word is easy to make out.",
  mid: "Mostly clear; a few word endings are swallowed.",
  low: "Generally understandable, but several words blur together and need effort to follow.",
} as const;

const INTONATION = [
  "Natural sentence stress with a falling tone at the end of statements.",
  "Fairly flat, with stress on almost every word.",
  "Pitch rises at some clause ends, so a few statements sound like questions.",
] as const;

/** A Delivery Report in Ears' shape for one spoken Response. */
export function buildDeliveryReport(
  kind: "repeat" | "interview",
  score: number,
  rng: Rng,
  overrides: Partial<DeliveryReport> = {},
): DeliveryReport {
  const band = score >= 4 ? "high" : score >= 3 ? "mid" : "low";
  const pace = kind === "repeat" ? rng.int(138, 176) : rng.int(score >= 3.5 ? 118 : 96, score >= 3.5 ? 138 : 122);
  const report: DeliveryReport = {
    paceWpm: pace,
    pauses: PAUSES[kind][band],
    intelligibility: INTELLIGIBILITY[band],
    suspectedMispronunciations: [],
    intonation: INTONATION[band === "high" ? 0 : rng.int(1, 2)],
    ...overrides,
  };
  return DeliveryReportSchema.parse(report);
}

/** What Ears reports for a recording with no speech in it. */
export const SILENT_DELIVERY_REPORT: DeliveryReport = DeliveryReportSchema.parse({
  paceWpm: null,
  pauses: "No speech was detected in the recording.",
  intelligibility: "No speech was detected in the recording.",
  suspectedMispronunciations: [],
  intonation: "No speech was detected in the recording.",
});
