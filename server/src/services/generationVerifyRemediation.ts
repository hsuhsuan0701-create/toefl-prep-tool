import type { SetAdvisoryNote } from "@toefl-prep/shared";
import type { CheckPolicy } from "./generationCheckPolicy.js";
import { recordAdvisoryNotes } from "./setAdvisoryLedger.js";

// The remediation pieces Reading's and Listening's verify policies share. What differs in substance
// stays in each generator: the content gate's own checks (Reading's details quote the offending text
// for the operator; Listening's are SafeDiagnostic and never do), the prompts and fences, the
// option-key check, and the explanation rewrites (Reading rewrites CtW gaps and MCQs separately;
// Listening sends every flagged Item in one batch).
//
// Not model-visible: claudeRunner.ts's CLI_PERMISSIONS_SETTINGS denies the spawned CLI `Read` on
// `server/**`, which is what lets the gate-only tolerance below live beside the target the prompts
// state.

// ---------------------------------------------------------------------------
// Explanation length
// ---------------------------------------------------------------------------

/**
 * Two different numbers, on purpose.
 *
 * The TARGET (120 字) is what the generation guides, both SKILL.md files and every remediation
 * prompt ask for. A model cannot count its own CJK characters and lands a little above whatever it
 * is told, so the target is never enforced.
 *
 * The HARD LIMIT (200 字) is the only number the gate enforces: a guard against a runaway
 * explanation, not a style rule. It is GATE-ONLY and must never appear in a prompt, a SKILL.md or a
 * guide, because a threshold the model can read is one it aims at.
 */
export const EXPLANATION_TARGET_CODE_POINTS = 120;
export const EXPLANATION_HARD_LIMIT_CODE_POINTS = 200;

/**
 * Kana (U+3040–U+30FF) plus CJK ideographs from extension A through the compatibility block
 * (U+3400–U+FAFF). An explanation must match it and an English stem, option or transcript must not.
 * CJK punctuation (U+3000–U+303F) is excluded, so an explanation of nothing but 「」、。 still counts
 * as having no 繁體中文.
 */
export const CJK_RE = /[぀-ヿ㐀-﫿]/u;

/** Code points, not UTF-16 units: one astral character (emoji, rare han) is one 字, not two. */
export function explanationLength(text: string): number {
  return [...text].length;
}

// ---------------------------------------------------------------------------
// Content-gate tiers and the notes a finished Set carries
// ---------------------------------------------------------------------------

/** One section's content-gate kinds read through generationCheckPolicy, and nothing else. */
export type ContentGateTiers<K extends string> = {
  /** Fails the job on sight: no repair route exists. */
  readonly isFatal: (kind: K) => boolean;
  /** Recorded and published on sight: the verify loop must not spend a round waiting for a fix. */
  readonly isAdvisory: (kind: K) => boolean;
  /**
   * Must not end the job once the repair budget is spent: `advisory`, or `repair-then-accept` ending
   * in `advisory`. The difference from `isAdvisory` is WHEN, not whether — a degrading kind still
   * drives its full complement of repair rounds first.
   */
  readonly degrades: (kind: K) => boolean;
};

export function contentGateTiers<K extends string>(
  policyOf: (kind: K) => CheckPolicy,
): ContentGateTiers<K> {
  return {
    isFatal: (kind) => policyOf(kind).tier === "fatal",
    isAdvisory: (kind) => policyOf(kind).tier === "advisory",
    degrades: (kind) => {
      const policy = policyOf(kind);
      return policy.tier === "advisory"
        || (policy.tier === "repair-then-accept" && policy.unrepaired === "advisory");
    },
  };
}

/**
 * The `content-gate` notes a published Set carries for the violations it is published with.
 *
 * Kinds, Task Types and positions only — all server-authored. A violation's own `detail` is never
 * copied: it embeds measured values and, in Reading, the offending text, and a note must carry
 * nothing a producer could smuggle content through. `taskTypeOf` reads the Task Type back off the
 * violation's `${module}/${component}/${id}` label; an unrecognised shape yields no `taskType` rather
 * than a guess.
 */
export function contentGateNotes<K extends string>(
  violations: readonly { readonly kind: K; readonly label: string; readonly itemPosition?: number }[],
  degrades: (kind: K) => boolean,
  taskTypeOf: (label: string) => string | undefined,
): SetAdvisoryNote[] {
  return violations
    .filter((violation) => degrades(violation.kind))
    .map((violation) => {
      const taskType = taskTypeOf(violation.label);
      return {
        check: "content-gate" as const,
        detail: violation.kind,
        ...(taskType ? { taskType } : {}),
        ...(violation.itemPosition !== undefined ? { itemPosition: violation.itemPosition } : {}),
      };
    });
}

/**
 * The fixed label a Verifier "quality" note carries. The Verifier's own reason may quote the
 * Stimulus, so it never travels this channel; the note names the Task Type and nothing else.
 */
export const ITEM_QUALITY_ADVISORY_DETAIL = "item-quality";

/** One `item-quality` note per Item accepted on a "quality" verdict, given that Item's Task Type. */
export function itemQualityNotes(taskTypes: readonly string[]): SetAdvisoryNote[] {
  return taskTypes.map((taskType) => ({
    check: "content-gate" as const,
    detail: ITEM_QUALITY_ADVISORY_DETAIL,
    taskType,
  }));
}

/**
 * The one exit every successful verify path goes through: rebalance the option order, then attach
 * each producer's notes through the ledger, which owns the cap and the truncation warning. One
 * function, so the note-writing cannot be forgotten on one of the returns.
 *
 * An Item whose explanation still names an option by position keeps its order, so that explanation
 * stays true. Each producer is recorded separately because the ledger's warning names the one that
 * overflowed.
 */
export function finishVerifiedSet<S extends object>(input: {
  readonly set: S;
  readonly violations: readonly { readonly kind: string; readonly id: string }[];
  readonly rebalance: (set: S, keepOrderOf: ReadonlySet<string>) => S;
  readonly notes: readonly { readonly producer: string; readonly notes: readonly SetAdvisoryNote[] }[];
}): S {
  const positional = new Set(
    input.violations
      .filter((violation) => violation.kind === "explanation-position-reference")
      .map((violation) => violation.id),
  );
  let finished = input.rebalance(input.set, positional);
  for (const { producer, notes } of input.notes) {
    finished = recordAdvisoryNotes(finished, notes, producer);
  }
  return finished;
}

// ---------------------------------------------------------------------------
// The answer key
// ---------------------------------------------------------------------------

/**
 * What is wrong with one MCQ's key, or `undefined` when nothing is: two options share an id, so
 * neither the key nor a Response can say which of them it means, or the key names none of the
 * options, so no Response can be marked right. Both sections' content gates report it as
 * `invalid-answer-key`, and both refuse a regeneration reply that carries it.
 *
 * Ids only, never option text: option ids and the key are SafeIdSchema tokens, and this detail can
 * reach a job's `error`.
 */
export function answerKeyDefect(
  options: readonly { readonly id: string }[],
  correctOptionId: string,
): string | undefined {
  const ids = options.map((option) => option.id);
  const shared = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (shared.length > 0) {
    return `option id(s) ${shared.map((id) => `"${id}"`).join(", ")} name more than one option`;
  }
  if (!ids.includes(correctOptionId)) {
    return `correctOptionId "${correctOptionId}" is not among its own option ids (${ids.join(", ")})`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Answer-key position, fixed by construction
// ---------------------------------------------------------------------------

/**
 * One MCQ's options in a uniformly random order, each option RELABELLED to the position it now
 * occupies, with `correctOptionId` following its content.
 *
 * The client renders `options` in array order and sends `option.id` as the radio value, so both the
 * slot and the id label of the key are cues the User can read, and generation models skew both.
 * Permuting the array closes the slot channel; relabelling closes the id channel, reusing the
 * question's own labels so no id format is invented. The draw is random rather than a fixed
 * rotation, because a formula in this source would be a permanent exploit for the one person who can
 * read it.
 *
 * Callers run it once, after the last remediation (inside `finishVerifiedSet`'s rebalance), because a
 * regeneration returns a whole question in the model's own order. A `correctOptionId` that names no
 * option is left untouched: the option-key check owns that defect.
 */
export function shuffleMcqOptions<
  Q extends { options: readonly { id: string; text: string }[]; correctOptionId: string },
>(question: Q, rng: () => number): Q {
  if (!question.options.some((option) => option.id === question.correctOptionId)) return question;
  const originalLabels = question.options.map((option) => option.id);
  const shuffled = [...question.options];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.min(Math.max(Math.floor(rng() * (i + 1)), 0), i);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  // The key's content, found by its pre-shuffle id, takes the label of the position it landed in.
  const newPosition = shuffled.findIndex((option) => option.id === question.correctOptionId);
  const newCorrectOptionId = originalLabels[newPosition]!;
  const relabeled = shuffled.map((option, index) => ({ ...option, id: originalLabels[index]! }));
  return { ...question, options: relabeled, correctOptionId: newCorrectOptionId };
}

// ---------------------------------------------------------------------------
// Accepting a targeted regeneration's reply
// ---------------------------------------------------------------------------

/**
 * The replacements a targeted regeneration returned, keyed by id, for exactly the ids it was asked
 * about. An entry for an id nobody asked about is dropped unread, so an over-inclusive reply can never
 * overwrite a sibling; a requested id with no entry is a failed regeneration, reported through the
 * caller's own failure channel.
 */
export function requestedReplacements<T extends { readonly id: string }>(
  requestedIds: readonly string[],
  reply: readonly T[],
  missing: (id: string) => never,
): Map<string, T> {
  const requested = new Set(requestedIds);
  const byId = new Map(reply.filter((entry) => requested.has(entry.id)).map((entry) => [entry.id, entry]));
  for (const id of requestedIds) {
    if (!byId.has(id)) missing(id);
  }
  return byId;
}
