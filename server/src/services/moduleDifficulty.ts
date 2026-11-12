// Is a Set's Upper Module actually harder than its Lower Module?
//
// The one plan-conformance property ADR-0006 keeps fatal. Reading and Listening are scored
// deterministically from the answer key, with no Judge to catch a defect, and ADR-0005's Module
// Path, ROUTER_PROMOTION_THRESHOLD and LOWER_PATH_BAND_CAP are only honest if the two modules
// genuinely differ in difficulty: a User routed UP is told they met a higher bar, and a User routed
// DOWN has their estimate capped for taking an easier one.
//
// A text measure, not a composition one: which shapes each module holds is already fixed by the
// schema (LISTENING_MODULE_COMPOSITION, READING_MODULE_COMPOSITION), so a composition check could
// never fire. What the model is free to get wrong is the PROSE: it can write an Upper Module in
// simpler language than its Lower Module.
//
// The measure is a grade-level index of the module's own Stimulus text, in the Flesch-Kincaid form:
//
//     0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59
//
// Longer sentences and longer words both raise it. It is deterministic, needs no model call, and is
// a published formula rather than weights invented here — which matters for a check that can fail a
// job. The comparison allows MODULE_DIFFICULTY_TOLERANCE_GRADES of noise, so only a genuine
// inversion fails.
//
// Reading also reads the same index absolutely, against the Flesch-Kincaid ranges ETS publishes for
// Reading text (READING_MODULE_GRADE_BANDS). Those checks are advisory, so an index error costs a
// note on a Set rather than the Set; the relative gate stays fatal and stays relative. Listening gets
// no absolute band: ETS publishes CEFR levels for its Listening tasks but no readability range for
// spoken text.

import type { ListeningModule, ReadingModule } from "@toefl-prep/shared";

export type ModuleDifficulty = {
  readonly grade: number;
  readonly words: number;
  readonly sentences: number;
  readonly syllables: number;
};

export type ModuleDifficultyComparison = {
  readonly lower: ModuleDifficulty;
  readonly upper: ModuleDifficulty;
  /** True when the Upper Module reads as harder than the Lower Module. */
  readonly upperIsHarder: boolean;
};

const WORD_RE = /[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/gu;
/**
 * A sentence ends at `.`, `!` or `?`. Newlines are NOT boundaries: Daily Life genres such as "menu"
 * and "text-message chain" are naturally line-broken, and counting their line breaks would collapse
 * the module's words-per-sentence and move its grade over formatting rather than language level. For
 * the same reason `textDifficulty` joins texts on a space.
 */
const SENTENCE_RE = /[.!?]+/gu;

/**
 * Vowel-group syllable estimate. listeningGenerator has its own estimateSyllables for a different
 * check on a different unit (one Listen and Choose a Response utterance); sharing one would change
 * what one of the two gates measures.
 */
export function estimateSyllables(word: string): number {
  const cleaned = word.toLowerCase().replace(/[^a-z]/gu, "");
  // A token with no letters but some digits ("1950", "24") is still a WORD to the word counter;
  // giving it zero syllables would rate a module easier for mentioning more numbers. One syllable is
  // the floor every other word gets; a token with nothing in it at all gets nothing.
  if (!cleaned) return /[0-9]/u.test(word) ? 1 : 0;
  const groups = cleaned.match(/[aeiouy]+/gu)?.length ?? 0;
  // A trailing silent "e" is not a syllable ("make" is one, not two) unless it is all the word has.
  const adjusted = cleaned.endsWith("e") && groups > 1 ? groups - 1 : groups;
  return Math.max(1, adjusted);
}

/** The Flesch-Kincaid grade of `texts` read as one body of prose, with the counts behind it. */
export function textDifficulty(texts: readonly string[]): ModuleDifficulty {
  const joined = texts.join(" ");
  const words = joined.match(WORD_RE) ?? [];
  const sentenceBreaks = joined.match(SENTENCE_RE)?.length ?? 0;
  const syllables = words.reduce((total, word) => total + estimateSyllables(word), 0);
  // Never divide by zero: an empty module is grade 0 rather than NaN. A NaN here would compare false
  // against everything and silently fail every Set.
  const sentences = Math.max(1, sentenceBreaks);
  if (words.length === 0) return { grade: 0, words: 0, sentences, syllables: 0 };
  const grade = 0.39 * (words.length / sentences) + 11.8 * (syllables / words.length) - 15.59;
  return { grade, words: words.length, sentences, syllables };
}

/**
 * A Listening module's spoken text: every Listen and Choose a Response utterance and every Stimulus
 * transcript. Questions, options and Explanations are excluded — the module's difficulty is the
 * LISTENING load, and an Explanation is 繁體中文 prose the User reads only after answering.
 */
export function listeningModuleText(module: ListeningModule): string[] {
  return [
    ...module.listenChoose.map((item) => item.utterance),
    ...module.conversations.flatMap((conversation) =>
      conversation.transcript.map((turn) => turn.text)
    ),
    ...module.announcements.map((announcement) => announcement.transcript),
    ...module.academicTalks.map((talk) => talk.transcript),
  ];
}

/**
 * A Reading module's read text: the CtW source paragraphs, the daily-life texts and the academic
 * passages. `sourceParagraph` is the CtW passage BEFORE letters are deleted, which is the prose whose
 * difficulty is being compared; the gapped form would measure the deletion pattern instead.
 */
export function readingModuleText(module: {
  // Structurally the minimum this needs, NOT ReadingModule, so it can measure a raw
  // ReadingGenerationInput module, whose CtW passages have no segments or gaps yet. That lets the
  // difficulty gate run before assembleReadingContent spends calls on a candidate it would reject.
  readonly ctwPassages: readonly { readonly sourceParagraph?: string | undefined }[];
  readonly dailyLife: readonly { readonly text: string }[];
  readonly academic: readonly { readonly text: string }[];
}): string[] {
  return [
    ...module.ctwPassages.map((passage) => passage.sourceParagraph ?? ""),
    ...module.dailyLife.map((text) => text.text),
    ...module.academic.map((passage) => passage.text),
  ];
}

export function compareListeningModuleDifficulty(set: {
  lowerModule: ListeningModule;
  upperModule: ListeningModule;
}): ModuleDifficultyComparison {
  return compare(
    textDifficulty(listeningModuleText(set.lowerModule)),
    textDifficulty(listeningModuleText(set.upperModule)),
  );
}

export function compareReadingModuleDifficulty(set: {
  lowerModule: Parameters<typeof readingModuleText>[0];
  upperModule: Parameters<typeof readingModuleText>[0];
}): ModuleDifficultyComparison {
  return compare(
    textDifficulty(readingModuleText(set.lowerModule)),
    textDifficulty(readingModuleText(set.upperModule)),
  );
}

/**
 * How much of a grade the Upper Module may fall short by and still pass.
 *
 * A strict `upper > lower` would fail a fatal gate on a difference inside the noise of a
 * syllable-ESTIMATING index. A quarter of a grade is above that jitter and well below any difference
 * that means something pedagogically (every banked Set's Upper Module leads by more than a full
 * grade), so it separates "the same level" from "the Upper Module is genuinely the easier one".
 */
export const MODULE_DIFFICULTY_TOLERANCE_GRADES = 0.25;

function compare(lower: ModuleDifficulty, upper: ModuleDifficulty): ModuleDifficultyComparison {
  return {
    lower,
    upper,
    upperIsHarder: upper.grade > lower.grade - MODULE_DIFFICULTY_TOLERANCE_GRADES,
  };
}

// ---------------------------------------------------------------------------
// The ABSOLUTE per-module bands (Reading only).
// ---------------------------------------------------------------------------

export type ReadingModuleBand = {
  /** Inclusive. Both ends are inclusive, so a module sitting exactly on 10.5 satisfies medium AND high. */
  readonly min: number;
  readonly max: number;
  /** The band's name, as ETS names it (or, for `lowerModule`, as this file defines it). */
  readonly label: string;
  /** ETS's TextEvaluator range, carried into the operator line so the FK numbers are traceable. */
  readonly textEvaluator: string;
};

/**
 * What each Reading module's own prose must read as, absolutely, in Flesch-Kincaid grades.
 *
 * ETS's Router Module carries moderate tasks only (CEFR B1–B2, the band ETS labels medium) and the
 * second module opens the range (docs/adr/0005). ETS publishes two text bands with their
 * Flesch-Kincaid equivalents:
 *
 *     medium  TextEvaluator  800–1100   FK  7.4–10.5
 *     high    TextEvaluator 1100–1360+  FK 10.5–20.0
 *
 * The `lowerModule` floor, 4.0, is ours: ETS publishes no band below medium. The medium band spans
 * two CEFR sublevels across 3.1 grades, ~1.55 grades per sublevel; extending that rate down puts A1
 * at ~4.3, and A1 is the right anchor because the Lower Module carries Daily Life texts (menus,
 * receipts, forms, schedules) that are telegraphic by design. Rounded down to sit under the
 * extrapolation rather than on it; every banked Lower Module clears it (moduleDifficulty.test.ts).
 *
 * These numbers are NOT gate-only: every bound is stated verbatim in the Reading generation guide's
 * difficulty table, which the generating model reads, so the gate fires at exactly the bound the
 * model was told. Keep the two equal.
 */
export const READING_MODULE_GRADE_BANDS: Readonly<
  Record<"router" | "lowerModule" | "upperModule", ReadingModuleBand>
> = {
  router: { min: 7.4, max: 10.5, label: "medium", textEvaluator: "800-1100" },
  lowerModule: { min: 4.0, max: 10.5, label: "at or below medium", textEvaluator: "<=1100" },
  upperModule: { min: 10.5, max: 20.0, label: "high", textEvaluator: "1100-1360+" },
};

export type ModuleBandVerdict = {
  readonly module: "router" | "lowerModule" | "upperModule";
  readonly difficulty: ModuleDifficulty;
  readonly band: ReadingModuleBand;
  readonly placement: "in-band" | "below-band" | "above-band";
};

/**
 * One module's placement against its band, or `undefined` when the module carries no text at all
 * (see placeAgainstBand).
 */
export function readingModuleBandVerdict(
  module: "router" | "lowerModule" | "upperModule",
  content: Parameters<typeof readingModuleText>[0],
): ModuleBandVerdict | undefined {
  return placeAgainstBand(module, textDifficulty(readingModuleText(content)));
}

/**
 * The same bands, asked of ONE Stimulus text: an Academic Passage or a Complete the Words source
 * paragraph. The granularity lives entirely in what the caller passes, never in the measurement.
 *
 * A module's grade pools texts written to deliberately different registers, so an Upper Module's
 * Academic Passage can sit in the medium band and still be carried over the high floor by the CtW
 * paragraph beside it, or the reverse. Read an Academic Passage is where the section's difficulty
 * ceiling lives, and a CtW paragraph is the Stimulus for ten Items, so each is checked on its own.
 *
 * No new numbers: a text is held to its own module's row in READING_MODULE_GRADE_BANDS, by identity
 * (pinned per granularity in moduleDifficulty.test.ts). A separate per-passage table would be the
 * second, looser threshold READING_ADVISORY_KINDS rules out.
 *
 * One Stimulus is a far smaller sample than a module — a 70–100 word CtW paragraph especially, where
 * one long sentence moves the index. That is affordable only because both per-Stimulus kinds are
 * advisory; do not promote either to fatal. The paragraph is measured before any letter is deleted
 * from it, so the gaps (ctest.ts) play no part.
 *
 * `undefined` for a wordless text (see placeAgainstBand).
 */
export function textBandVerdict(
  module: "router" | "lowerModule" | "upperModule",
  text: string,
): ModuleBandVerdict | undefined {
  return placeAgainstBand(module, textDifficulty([text]));
}

/**
 * The one placement rule both verdicts share — whole module, or one Stimulus — so the numbers, the
 * comparison and the wordless-input rule cannot drift between granularities.
 *
 * `undefined` for zero words. A grade of 0 over zero words is textDifficulty's divide-by-zero floor,
 * not a measurement, and the defect is already reported elsewhere: a module with no Stimuli is a
 * fatal `composition` violation, an empty Academic Passage or Daily Life text a `word-count` one,
 * and the schema refuses an empty CtW paragraph.
 */
function placeAgainstBand(
  module: "router" | "lowerModule" | "upperModule",
  difficulty: ModuleDifficulty,
): ModuleBandVerdict | undefined {
  if (difficulty.words === 0) return undefined;
  const band = READING_MODULE_GRADE_BANDS[module];
  const placement = difficulty.grade < band.min
    ? "below-band"
    : difficulty.grade > band.max
    ? "above-band"
    : "in-band";
  return { module, difficulty, band, placement };
}

/**
 * The operator-readable line an out-of-band module carries. Numbers and enum-shaped words only,
 * nothing a module's own prose could be reconstructed from, because it can reach `job.error` and the
 * Dashboard through formatReadingViolations.
 */
export function moduleBandDetail(verdict: ModuleBandVerdict): string {
  const { difficulty: d, band } = verdict;
  const direction = verdict.placement === "above-band" ? "above" : "below";
  return `reads grade ${d.grade.toFixed(2)} (${d.words} words, ${d.sentences} sentences, ${d.syllables} syllables), `
    + `${direction} the ${verdict.module} band ${band.min.toFixed(1)}-${band.max.toFixed(1)} `
    + `(${band.label}, TextEvaluator ${band.textEvaluator})`;
}

/**
 * moduleBandDetail's line for one Academic Passage. Which passage is named by the violation's own
 * `label`, never by quoting it.
 */
export function academicPassageBandDetail(verdict: ModuleBandVerdict): string {
  return `academic passage ${moduleBandDetail(verdict)}`;
}

/**
 * The retry direction both sections' generation prompts carry after a difficulty inversion.
 *
 * Qualitative only — no grade, no tolerance, no word or syllable count. The measured comparison is
 * gate-only: a model shown the number optimises the number instead of writing genuinely harder prose.
 * One wording for both sections, because the property is identical in both.
 */
export const UPPER_MODULE_HARDER_RETRY = [
  "",
  "A previous attempt produced an UPPER MODULE that was no harder to understand than its LOWER",
  "MODULE. The upper module is what a stronger test taker is routed to, so it must be genuinely more",
  "demanding: longer and more complex sentences, denser information, less common vocabulary, and more",
  "abstract or technical content. The lower module must stay correspondingly plainer and more",
  "concrete. Keep both modules faithful to their plan entries — change the LEVEL of the language, not",
  "the topics.",
].join("\n");

/**
 * The operator-readable line a failed comparison carries. Numbers only — no transcript, no scenario,
 * nothing a module's own prose could be reconstructed from.
 */
export function moduleDifficultyDetail(comparison: ModuleDifficultyComparison): string {
  const fmt = (value: ModuleDifficulty): string =>
    `grade ${value.grade.toFixed(2)} (${value.words} words, ${value.sentences} sentences, ${value.syllables} syllables)`;
  return `upper module reads no harder than lower: upper ${fmt(comparison.upper)} vs lower ${fmt(comparison.lower)}`;
}
