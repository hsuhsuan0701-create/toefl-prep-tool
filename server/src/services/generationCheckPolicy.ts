// Answers "does this check stop a generation job?" with one tier per check. The rule, the table of
// where each check landed and the reasons are in docs/adr/0006-generation-check-policy.md: a check
// may block a Set only when the Set would otherwise be UNUSABLE or would TEACH A WRONG ANSWER.
// Similarity and taste are recorded, never fatal.
//
// A leaf module: it imports types only, and never from a generator, so a stage can depend on the
// policy without the policy depending back.

import type { PaceVerdict } from "./audioPace.js";
import type { DiversityIssueKind, NoveltyTaskType } from "./diversityIssues.js";

/**
 * The content-gate kind unions, restated here rather than imported from the generators and gates
 * that produce them: a policy that imports the stages which consult it depends back on them.
 *
 * generationCheckPolicy.test.ts asserts each restated union is MUTUALLY assignable with its
 * producer's own, so adding or removing a kind on either side fails to COMPILE the test until it is
 * classified here too.
 */
export type ReadingViolationKind =
  | "composition"
  | "word-count"
  // A Complete the Words paragraph over its range; one under it is `word-count`.
  | "ctw-word-count-over"
  | "item-language"
  | "explanation-language"
  | "academic-coverage"
  | "explanation-length-ctw"
  | "explanation-length-mcq"
  | "ctw-gap-leak"
  | "option-length-bias"
  | "explanation-position-reference"
  // An MCQ whose key names none of its options, or two of whose options share an id.
  | "invalid-answer-key"
  // An MCQ with fewer than 4 options.
  | "option-count"
  // A module reading outside its absolute Flesch-Kincaid band.
  | "module-difficulty-band"
  // One Academic Passage reading outside its module's band.
  | "passage-difficulty-band"
  // One Complete the Words source paragraph reading outside its module's band.
  | "ctw-paragraph-difficulty-band";

/**
 * Writing's content gate: the nine ways a Build a Sentence Item can depart from the task format,
 * restated from buildASentenceConformance's union. An all-blank frame is not one of them: it is the
 * reorder task the exam sets (docs/adr/0009).
 */
export type BuildASentenceViolationKind =
  | "frame-missing"
  | "frame-unparseable"
  | "frame-final-punctuation"
  | "tile-count"
  | "distractor-count"
  | "answer-length"
  | "answer-not-from-tiles"
  | "tile-final-punctuation"
  | "tile-initial-capital";

export type ListeningViolationKind =
  | "composition"
  | "word-count"
  | "syllable-estimate"
  | "item-language"
  | "transcript-language"
  | "explanation-language"
  | "explanation-length"
  | "invalid-answer-key"
  | "option-length-bias"
  | "explanation-position-reference";

/**
 * Speaking's content gate, restated from speakingConformance's union: a Listen and Repeat Item over
 * its per-item word ceiling, or one projected to run past the clip ceiling at the slowest pace its
 * speech-rate band accepts.
 */
export type SpeakingViolationKind = "lr-word-count-over" | "lr-clip-duration-over";

export const GENERATION_SECTIONS = ["speaking", "writing", "reading", "listening"] as const;
export type GenerationSection = (typeof GENERATION_SECTIONS)[number];

/**
 * The three tiers, and nothing else.
 *
 *  - `fatal`               — the Set would be unusable or would teach a wrong answer. The job fails.
 *  - `advisory`            — the Set is publishable. The issue is recorded on it and shown, and
 *                            never blocks.
 *  - `repair-then-accept`  — one bounded corrective attempt, then degrade.
 *
 * `repair-then-accept` carries its own degrade target rather than assuming one. The usual target is
 * `advisory`; `unrepaired: "fatal"` is for a check whose unrepaired finding leaves the Set unusable
 * (a Listening key naming no option, a Build a Sentence key no tile arrangement can equal), so that
 * "repair, then fail anyway" is a decision written down here, never something that happens by
 * omission.
 */
export type CheckTier = "fatal" | "advisory" | "repair-then-accept";

export type CheckPolicy =
  | { readonly tier: "fatal" }
  | { readonly tier: "advisory" }
  | { readonly tier: "repair-then-accept"; readonly unrepaired: "fatal" | "advisory" };

/**
 * Every check a generation stage performs, as data.
 *
 * `plan-diversity` has no `section`: plan-stage tiers vary by kind, with one `taskType` special case,
 * and never by section.
 *
 * Candidate-stage novelty has no family here because it never rejects: its one finding, a component
 * contradicting its planned domain, is always recorded on the Set (generationNovelty's
 * candidateDomainDriftNotes).
 */
export type GenerationCheck =
  | {
      readonly family: "plan-diversity";
      readonly kind: DiversityIssueKind;
      readonly taskType: NoveltyTaskType;
    }
  | {
      readonly family: "content-gate";
      readonly section: "reading";
      readonly kind: ReadingViolationKind;
    }
  | {
      readonly family: "content-gate";
      readonly section: "listening";
      readonly kind: ListeningViolationKind;
    }
  /**
   * Writing's content gate, run over a generated candidate's Build a Sentence Items
   * (buildASentenceConformance.ts). Every kind is remediable: the repair is a whole-candidate
   * regeneration inside the candidate loop's 3-attempt budget, handed the full violation list. What
   * differs per kind is only where an UNREPAIRED one lands — see BUILD_A_SENTENCE_UNUSABLE_KINDS.
   */
  | {
      readonly family: "content-gate";
      readonly section: "writing";
      readonly kind: BuildASentenceViolationKind;
    }
  /**
   * Speaking's content gate, run over a generated candidate's Listen and Repeat Items
   * (speakingConformance.ts) before any TTS or image render, so only the generate call is at stake.
   * Like Writing's, the repair is a whole-candidate regeneration inside the candidate loop's
   * 3-attempt budget, handed the full violation list.
   */
  | {
      readonly family: "content-gate";
      readonly section: "speaking";
      readonly kind: SpeakingViolationKind;
    }
  | {
      readonly family: "audio-pace";
      readonly section: "speaking" | "listening";
      readonly verdict: PaceVerdict;
    }
  /**
   * A RENDERED Listen and Repeat clip that holds more speech than the clip ceiling of its Set's audio
   * profile, asked after the one corrective re-render has been spent.
   *
   * Not an arm of `audio-pace`, though both are asked about the same finished clip. `audio-pace`
   * classifies how far a clip's RATE sits from a band; this asks how much speech the User has to
   * hold before the recorder opens, which in a verbatim-repeat task is the difficulty itself, and it
   * leaves its own note on the Set. Speaking-only: Listening has no clip ceiling.
   */
  | {
      readonly family: "audio-clip-ceiling";
      readonly section: "speaking";
    }
  /**
   * The one plan-conformance property that stays fatal: a Reading or Listening Set whose Upper
   * Module is not harder than its Lower Module. See moduleDifficulty.ts for how it is measured and
   * ADR-0006 for why it stays fatal.
   *
   * This family is the RELATIVE ordering only. The absolute per-module bands read the same index but
   * carry a different tier, so they ride the Reading content gate as `module-difficulty-band`.
   */
  | {
      readonly family: "module-difficulty";
      readonly section: "reading" | "listening";
    };

const FATAL: CheckPolicy = { tier: "fatal" };
const ADVISORY: CheckPolicy = { tier: "advisory" };
const REPAIR_THEN_FAIL: CheckPolicy = { tier: "repair-then-accept", unrepaired: "fatal" };
// One bounded corrective attempt, then recorded and published.
const REPAIR_THEN_ACCEPT: CheckPolicy = { tier: "repair-then-accept", unrepaired: "advisory" };

/**
 * Plan admission's tiers. `assertNever` on the kind rather than a `default:` so a new
 * DiversityIssueKind fails to COMPILE here instead of silently defaulting.
 */
function planDiversityPolicy(kind: DiversityIssueKind, taskType: NoveltyTaskType): CheckPolicy {
  switch (kind) {
    // Overlap with the Catalog measures distance from a bank the section cannot control: a
    // preference that biases a Plan, never a reason it cannot be admitted.
    case "containment":
      return ADVISORY;
    // Build a Sentence's ten situations bunched into too few domains are repetitive practice, not
    // unusable Items: replanning is the repair, and a plan is admitted with a note when it runs out.
    case "domain-balance":
      return taskType === "build_sentence" ? REPAIR_THEN_ACCEPT : ADVISORY;
    // A Plan that contradicts its own declared domain, or whose Listen and Repeat setting names no
    // place, is cheap to re-ask for, and the planner is shown both tables it is checked against.
    case "plan-drift":
    case "domain-drift":
      return FATAL;
    default:
      return assertNeverCheck(kind);
  }
}

/**
 * The Reading content gate's remediable kinds: each has a regeneration route in readingGenerator's
 * readingRemediationRoute, and readingGenerator reads this set rather than keeping a copy.
 */
export const READING_REMEDIABLE_KINDS: ReadonlySet<ReadingViolationKind> = new Set([
  "explanation-length-ctw",
  "explanation-length-mcq",
  "explanation-language",
  "item-language",
  "ctw-gap-leak",
  "option-length-bias",
  "explanation-position-reference",
  "invalid-answer-key",
]);

/**
 * Reading's remediable kinds whose unrepaired ending is `fatal`, as Listening's are below.
 *
 *  - `invalid-answer-key` — `correctOptionId` names no option, so no Response can be marked right; or
 *    two options share an id, so the key and a Response cannot say which of the two they mean. The
 *    question is regenerated whole, and the job fails only if it is still wrong when repairs run out.
 */
export const READING_UNUSABLE_IF_UNREPAIRED: ReadonlySet<ReadingViolationKind> = new Set([
  "invalid-answer-key",
]);

export const LISTENING_REMEDIABLE_KINDS: ReadonlySet<ListeningViolationKind> = new Set([
  "word-count",
  "syllable-estimate",
  "item-language",
  "transcript-language",
  "explanation-language",
  "explanation-length",
  "invalid-answer-key",
  "option-length-bias",
  "explanation-position-reference",
]);

/**
 * The kinds Reading records and publishes rather than repairing or failing on. Each leaves every
 * Item answerable and correctly keyed, and none has a regeneration route that targets it.
 *
 * `word-count` and `ctw-word-count-over`: a Stimulus outside its length range. A Complete the Words
 * paragraph that reaches the verify stage has already derived its 10 gaps, so its length changes
 * nothing else. A Daily Life text or Academic Passage outside its range is off-target practice
 * against the module's fixed clock, but its questions are still answerable from it; one that cannot
 * support its questions is the Verifier's "issue" verdict, which stays blocking.
 *
 * `academic-coverage`: an Academic Passage whose five questions leave one of ETS's five skill slots
 * uncovered (readingGenerator's ACADEMIC_SKILL_SLOTS). Practice on a different mix of skills than
 * the exam's, and nothing worse.
 *
 * `option-count`: an MCQ with fewer than 4 options, which raises guessing odds to 33% against the
 * exam's 25%. Easier practice, still answerable and correctly keyed. The generation guide's "exactly
 * 4 options per question" is the mechanism; this gate is the backstop.
 *
 * `module-difficulty-band`: a module whose prose reads outside the absolute Flesch-Kincaid band ETS
 * publishes for it (moduleDifficulty's READING_MODULE_GRADE_BANDS). Off-target practice. The
 * RELATIVE Upper-vs-Lower ordering, which is what makes a routed Band Estimate honest, is the
 * separate `module-difficulty` family and stays fatal.
 *
 * `passage-difficulty-band` and `ctw-paragraph-difficulty-band`: the same bands read over one
 * Academic Passage or one CtW paragraph, because a module's pooled grade can sit in band while the
 * Stimulus carrying its hardest Items does not. Same tier for the same reason; a 70–100 word
 * paragraph is also a small enough sample that the index is noisy on it (see textBandVerdict).
 *
 * No kind here has a second, looser numeric threshold: each fires at exactly the bound the skill
 * reference already states, so nothing gate-only has to be kept out of a prompt.
 */
export const READING_ADVISORY_KINDS: ReadonlySet<ReadingViolationKind> = new Set([
  "word-count",
  "ctw-word-count-over",
  "academic-coverage",
  "option-count",
  "module-difficulty-band",
  "passage-difficulty-band",
  "ctw-paragraph-difficulty-band",
]);

/**
 * Listening's remediable kinds whose unrepaired ending is still `fatal`. Every other remediable kind
 * gets the full repair budget and then publishes with a note.
 *
 *  - `invalid-answer-key` — `correctOptionId` names no option, so no Response can be marked right;
 *    or two options share an id, so neither the key nor a Response can say which one is meant.
 *  - `transcript-language` — a transcript not in English is read aloud by an English voice; the
 *    Stimulus is not a listening task at all.
 *
 * The degrading kinds, in both sections, degrade for the same reason: the Item is answerable and
 * correctly keyed, and what the check guards is length, the language of a single field, or a cue that
 * makes practice easier — `explanation-length*` and `explanation-language` (an Explanation too long
 * or not in 繁體中文), `item-language` (a stem or option not in English), `option-length-bias` (the
 * key is too often the longest option), `word-count`/`syllable-estimate` (a Stimulus or utterance off
 * its length target), `ctw-gap-leak` (a blanked word also readable elsewhere in the passage, our rule
 * rather than ETS's), and `explanation-position-reference` (an Explanation naming an option by its
 * slot; the finishing step leaves that Item's options unshuffled, so it stays true).
 */
export const LISTENING_UNUSABLE_IF_UNREPAIRED: ReadonlySet<ListeningViolationKind> = new Set([
  "invalid-answer-key",
  "transcript-language",
]);

export function isRemediableReadingViolation(kind: ReadingViolationKind): boolean {
  return READING_REMEDIABLE_KINDS.has(kind);
}

/** Reading's content-gate tier: advisory, repair-then-accept ending in advisory or in fatal, or fatal. */
function readingContentGatePolicy(kind: ReadingViolationKind): CheckPolicy {
  if (READING_ADVISORY_KINDS.has(kind)) return ADVISORY;
  if (!isRemediableReadingViolation(kind)) return FATAL;
  return READING_UNUSABLE_IF_UNREPAIRED.has(kind) ? REPAIR_THEN_FAIL : REPAIR_THEN_ACCEPT;
}

export function isRemediableListeningViolation(kind: ListeningViolationKind): boolean {
  return LISTENING_REMEDIABLE_KINDS.has(kind);
}

/** Listening's content-gate tier: repair-then-accept ending in advisory or in fatal, or fatal. */
function listeningContentGatePolicy(kind: ListeningViolationKind): CheckPolicy {
  if (!isRemediableListeningViolation(kind)) return FATAL;
  return LISTENING_UNUSABLE_IF_UNREPAIRED.has(kind) ? REPAIR_THEN_FAIL : REPAIR_THEN_ACCEPT;
}

/**
 * The four Build a Sentence violations that survive the regeneration budget as FATAL.
 *
 * Build a Sentence is machine scored by exact match against `answers`, and a Drill renders an Item
 * from its frame, so each of these leaves an Item the User cannot answer:
 *
 *  - `frame-missing`         — the Drill has no frame to lay out and shows a notice instead of an
 *    interaction. The User cannot attempt the Item at all.
 *  - `frame-unparseable`     — a frame with no blanks to render. `BuildASentenceItemSchema` refuses
 *    it, so a Set carrying one cannot be minted; classifying it fatal reports that as the conformance
 *    failure it is rather than as an opaque parse error at publication time.
 *  - `answer-length`         — the key does not fill every blank exactly once, so no arrangement the
 *    User can build equals it. Every Response is marked wrong.
 *  - `answer-not-from-tiles` — the key names a tile the Item does not offer, or reuses one it offers
 *    once. Same consequence, from the other side.
 *
 * The other five degrade to advisory, because each makes an Item off-format or easier and none makes
 * it unanswerable:
 *
 *  - `frame-final-punctuation` — a missing full stop.
 *  - `tile-count`              — outside 4–10. The range is a difficulty target, not a correctness
 *    rule.
 *  - `distractor-count`        — no distractor, or two. The one genuinely unanswerable shape
 *    underneath this kind — more blanks than tiles — always co-fires `answer-length` or
 *    `answer-not-from-tiles`, so nothing unusable escapes through here.
 *  - `tile-final-punctuation`  — the tile can only be last: a position leak, not a wrong answer.
 *  - `tile-initial-capital`    — the exam's lowercase-tile rule: a capital gives away which tile the
 *    sentence starts with. Also a leak, and it over-fires on a proper noun or "I"
 *    (buildASentenceConformance says why), which would be an absurd reason to discard a whole Set.
 *
 * An advisory is not a silent pass: it is recorded on the Set as a `content-gate` note and shown
 * before the User practises.
 */
export const BUILD_A_SENTENCE_UNUSABLE_KINDS: ReadonlySet<BuildASentenceViolationKind> = new Set([
  "frame-missing",
  "frame-unparseable",
  "answer-length",
  "answer-not-from-tiles",
]);

export function isUnusableBuildASentenceViolation(kind: BuildASentenceViolationKind): boolean {
  return BUILD_A_SENTENCE_UNUSABLE_KINDS.has(kind);
}

/** The tier of one generation check (docs/adr/0006). */
export function classifyGenerationCheck(check: GenerationCheck): CheckPolicy {
  switch (check.family) {
    case "plan-diversity":
      return planDiversityPolicy(check.kind, check.taskType);
    case "content-gate": {
      if (check.section === "reading") return readingContentGatePolicy(check.kind);
      // Every Writing kind gets the regeneration budget; only the unrepaired ending differs.
      if (check.section === "writing") {
        return isUnusableBuildASentenceViolation(check.kind)
          ? REPAIR_THEN_FAIL
          : REPAIR_THEN_ACCEPT;
      }
      // Both Speaking kinds buy a whole-candidate regeneration while the candidate loop's budget
      // lasts, and degrade to an advisory note after it: a Listen and Repeat sentence a little past
      // its ceiling is harder practice than designed and nothing worse.
      //
      // `lr-clip-duration-over` is a PROJECTION at the slowest rate the Item's band accepts, made
      // before anything is rendered and deliberately pessimistic. The DELIVERED clip running past the
      // ceiling is the separate `audio-clip-ceiling` family below.
      if (check.section === "speaking") return REPAIR_THEN_ACCEPT;
      return listeningContentGatePolicy(check.kind);
    }
    case "audio-pace":
      // The only hard failure is a genuine malfunction — a truncated, empty or stuck synthesis, or a
      // probe that returned a non-finite duration. Pace variance is exam realism, not correctness.
      if (check.verdict === "malfunction") return FATAL;
      // A missed band buys a corrective re-render and is accepted either way. Gemini has no rate
      // parameter, so the correction is prompt-directed (audioPrompt's PaceCorrection).
      //
      // HOW MANY re-renders is not decided here: the tier is the same whether the caller buys one
      // corrective take or three. The budget belongs to the loop that spends the money,
      // audioPaceCorrection.ts, whose default is one and which lets Listening buy more for a clip far
      // below its band.
      return check.verdict === "out-of-band" ? REPAIR_THEN_ACCEPT : ADVISORY;
    case "audio-clip-ceiling":
      // A Listen and Repeat clip still past its ceiling after the corrective re-render is harder than
      // designed — more speech to hold before repeating it — but answerable, and the Response is
      // judged on what the User said. The re-render was the repair; the breach is recorded.
      return REPAIR_THEN_ACCEPT;
    case "module-difficulty":
      // ADR-0005's Module Path, promotion threshold and lower-path band cap are honest only if the
      // two modules genuinely differ in difficulty; Reading and Listening are scored from the answer
      // key with no Judge to catch the defect, so a Set that fails this yields a dishonest Band
      // Estimate.
      return FATAL;
    default:
      return assertNeverCheck(check);
  }
}

/** Whether this check, in the end, stops the job: `fatal`, or a repair whose unrepaired ending is. */
export function blocksGeneration(check: GenerationCheck): boolean {
  const policy = classifyGenerationCheck(check);
  if (policy.tier === "fatal") return true;
  return policy.tier === "repair-then-accept" && policy.unrepaired === "fatal";
}

function assertNeverCheck(value: never): never {
  throw new Error(`unclassified generation check: ${JSON.stringify(value)}`);
}
