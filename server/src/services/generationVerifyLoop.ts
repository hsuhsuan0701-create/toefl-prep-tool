import {
  callVerifySkillTask,
  type OnGenerationProgress,
  type SkillTaskRunner,
} from "./generationReasoning.js";
import type { SkillTaskRequest } from "./reasoning/router.js";

// The verify-and-remediate loop Reading and Listening share, each through its own section policy.
//
// The loop owns what the two sections agree on: the round budget, the deterministic gate's blocking
// check, the verify call, the clean-exit and degrade-or-fail endings, the failure ledger, the guard
// every remediation runs inside, the explanations-first dispatch order, and the wholesale-this-round
// exclusion (a remediation never spends a paid call on content another remediation of the same
// round is about to replace). Everything a section does differently — its violations, how they
// bucket into remediations, its Verifier prompt and schema, its diagnostic wording, its finish step
// — is supplied by the policy defined in that section's generator module. The generators import
// this module; this module imports no generator.
//
// How a section's remediations are held to the exclusion and the guard: see `VerifyRemediation`.

// An extra round costs one verify call; running out discards a candidate that has already paid for
// the whole generation.
export const MAX_VERIFY_ATTEMPTS = 5;

/**
 * Merges a `reason` string into a `Map<id, reason>`, concatenating rather than overwriting when an
 * id already has one: an id flagged by more than one source in the same round gets ONE regeneration
 * call with every reason stated, not two calls racing each other.
 */
export function addReason(target: Map<string, string>, id: string, reason: string): void {
  const existing = target.get(id);
  target.set(id, existing ? `${existing} Separately: ${reason}` : reason);
}

/**
 * Throws unless `verdictIds` names every id in `sentIds` exactly once and nothing else.
 *
 * Every Verifier `parse` calls this for each population it sends. An id the Verifier skipped was
 * never judged, so reading its absence as "ok" would publish an Item nobody checked; an id it
 * invented is a verdict about something not in the Set. Throwing from `parse` makes either one an
 * invalid-output failure of the call — the router repairs or falls back as it does for any
 * unparseable reply — rather than an implicit pass. The message carries ids only: they are
 * server-assigned or validated against `[A-Za-z0-9_-]`, never content.
 */
export function assertVerdictCoverage(
  population: string,
  sentIds: readonly string[],
  verdictIds: readonly string[],
): void {
  const sent = new Set(sentIds);
  const seen = new Set<string>();
  const repeated = new Set<string>();
  const unexpected = new Set<string>();
  for (const id of verdictIds) {
    if (!sent.has(id)) unexpected.add(id);
    else if (seen.has(id)) repeated.add(id);
    seen.add(id);
  }
  const missing = sentIds.filter((id) => !seen.has(id));
  if (missing.length === 0 && unexpected.size === 0 && repeated.size === 0) return;
  const parts = [
    ...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []),
    ...(unexpected.size > 0 ? [`not sent ${[...unexpected].join(", ")}`] : []),
    ...(repeated.size > 0 ? [`judged more than once ${[...repeated].join(", ")}`] : []),
  ];
  throw new Error(`verifier ${population} verdicts do not cover exactly the ids sent: ${parts.join("; ")}`);
}

// ---------------------------------------------------------------------------
// Remediations: declared by a policy, ISSUED only by the loop
// ---------------------------------------------------------------------------

/**
 * When a remediation is dispatched, and therefore the loop's answer to the explanations-first rule.
 *
 *  - `"explanation"` — rewrites explanation prose (錯題解析) and nothing else.
 *  - `"wholesale"`   — replaces the content that prose explains: a whole CtW paragraph, a whole MCQ
 *                      question, a whole Listen-and-Choose item, a whole Stimulus.
 *
 * The loop dispatches every `explanation` remediation before every `wholesale` one: a wholesale
 * rewrite produces its own fresh explanation, so an explanation rewrite issued after it would be
 * working from character counts measured on text that no longer exists.
 */
export type RemediationPass = "explanation" | "wholesale";

/** One remediation the loop has admitted and is about to issue. Loop-internal. */
type AdmittedRemediation<S> = {
  readonly category: string;
  readonly pass: RemediationPass;
  /** Every id this remediation invalidates once it runs. */
  readonly claims: readonly string[];
  readonly issue: (set: S) => Promise<S>;
};

/**
 * What a section declares for one remediation of one round.
 *
 * `targets` is what the remediation WANTS to fix. `apply` never receives it: it receives only what
 * the loop admitted after the exclusion, and there is no other way to reach it.
 */
export type RemediationSpec<S, T> = {
  /**
   * The failure-ledger label — "MCQ wholesale", "stimulus", "CtW explanation-length". Appears in the
   * guard's console line and, as `"<category> (<ErrorClass>)"`, in the exhaustion diagnostic. A
   * server-authored label, never content.
   */
  readonly category: string;
  readonly pass: RemediationPass;
  /** Everything this remediation would fix, keyed by id. The value shape is the section's own. */
  readonly targets: ReadonlyMap<string, T>;
  /**
   * The id whose being claimed makes a target moot, defaulting to the target's OWN id.
   *
   * Reading's CtW explanation-length rewrite is why this exists: it is driven by flagged GAP ids but
   * re-runs the whole passage's explanation call, so a passage being rewritten wholesale this round
   * moots every one of its gaps at once. Its scope is therefore the gap's passage, not the gap.
   */
  readonly scope?: (targetId: string, set: S) => string;
  /**
   * Everything this remediation invalidates once it runs, defaulting to its own admitted ids.
   *
   * Listening's whole-Stimulus regeneration is why this exists: it discards the Stimulus's
   * questions too, so a question-grain or explanation-grain remediation of any of those question
   * ids in the same round is either wasted or silently dropped.
   */
  readonly claims?: (targetId: string, set: S) => readonly string[];
  readonly apply: (set: S, targets: ReadonlyMap<string, T>) => Promise<S>;
};

/**
 * A remediation as DECLARED, never as issued.
 *
 * A section cannot construct one except through `declare` (the constructor is private), and cannot
 * hand `apply` anything but the ids the loop admitted: `apply` is reachable only through `admit`,
 * which filters the targets against what earlier waves claimed. Sections never call `admit`
 * themselves; `runVerifyLoop` is its only caller and issues every admitted remediation inside the
 * guard that owns the failure ledger. So a remediation is never spent on an already-claimed id, and
 * never outside the guard.
 */
export class VerifyRemediation<S> {
  readonly #admit: (set: S, claimed: ReadonlySet<string>) => AdmittedRemediation<S> | undefined;

  private constructor(
    readonly category: string,
    readonly pass: RemediationPass,
    admit: (set: S, claimed: ReadonlySet<string>) => AdmittedRemediation<S> | undefined,
  ) {
    this.#admit = admit;
  }

  /** The only way to make one. `T` is existential from here on: the loop never sees the value shape. */
  static declare<S, T>(spec: RemediationSpec<S, T>): VerifyRemediation<S> {
    return new VerifyRemediation<S>(spec.category, spec.pass, (set, claimed) => {
      const admitted = new Map<string, T>();
      for (const [id, value] of spec.targets) {
        if (claimed.has(spec.scope ? spec.scope(id, set) : id)) continue;
        admitted.set(id, value);
      }
      if (admitted.size === 0) return undefined;
      return {
        category: spec.category,
        pass: spec.pass,
        claims: [...admitted.keys()].flatMap((id) => (spec.claims ? spec.claims(id, set) : [id])),
        issue: (current) => spec.apply(current, admitted),
      };
    });
  }

  /** Loop-internal: `runVerifyLoop`'s admission step is the only caller. */
  admit(set: S, claimed: ReadonlySet<string>): AdmittedRemediation<S> | undefined {
    return this.#admit(set, claimed);
  }
}

// ---------------------------------------------------------------------------
// The policy interface
// ---------------------------------------------------------------------------

/**
 * The section's Verifier call for one round. The prompt and schema stay per section: they go to a
 * paid model, and merging or rewording them would change what the Verifier does.
 */
export type VerifyRequest<Verdict> = {
  readonly task: SkillTaskRequest<unknown>["task"];
  readonly prompt: string;
  readonly jsonSchema: object;
  readonly parse: (value: unknown) => Verdict;
};

/** Everything the loop knows about one round when it asks the policy to route it. */
export type VerifyRound<S, V, Verdict> = {
  readonly attempt: number;
  /**
   * Whether this is the last round the budget allows, computed where the loop terminates so a policy
   * never reconstructs it from `MAX_VERIFY_ATTEMPTS`.
   *
   * A policy needs it when a finding's tier changes on the final round: Listening's Academic Talk
   * `register` verdict is `repair-then-accept -> advisory`, so it counts as outstanding while repair
   * rounds remain and stops counting on the last one, as the loop's own degradable content-gate
   * violations do.
   */
  readonly isFinalRound: boolean;
  readonly set: S;
  /** This round's deterministic content-gate reading, already known not to contain a blocking kind. */
  readonly violations: readonly V[];
  /**
   * The Verifier's reply about the units sent this round — only the pending ones (see
   * `VerifyPolicy.units`). A round with nothing pending makes no call and gets `emptyVerdict`.
   */
  readonly verdict: Verdict;
  /** `units(set)` for this round's `set`: what each unit's content was when it was judged. */
  readonly units: ReadonlyMap<string, string>;
};

/** A section's routing decision for one round. */
export type VerifyRoundPlan<S, P extends string> = {
  /**
   * How many Verifier-sourced findings are still outstanding. Zero of these AND zero non-advisory
   * content-gate violations is what "clean" means; the loop asks no further questions about the
   * verdict's shape.
   */
  readonly verdictFindings: number;
  /**
   * The unit keys this round's verdict passed. Each one is carried forward at the content it was
   * judged on and is not sent to the Verifier again until that content changes.
   */
  readonly passed: readonly string[];
  /**
   * The round's remediations, in CLAIM order: an outer array of waves, each wave a set of
   * remediations that do not exclude one another. Every remediation is filtered against everything
   * claimed by STRICTLY EARLIER waves, and against nothing claimed by its own wave or a later one.
   *
   * Putting two remediations in one wave is how a section says "these two may both touch the same
   * id" — Reading's ambiguous-passage rewrite and its unfaithful-explanation rewrite share wave 1 for
   * that reason.
   *
   * Dispatch order is NOT this order: see `RemediationPass`.
   */
  readonly remediations: readonly (readonly VerifyRemediation<S>[])[];
  /**
   * This section's own Verifier-sourced exhaustion fragments, read only on the final round. The
   * loop supplies the content-gate, advisory-remainder and remediation-failure fragments around
   * them; these are the ones only the section can write.
   */
  readonly exhaustionParts: readonly P[];
};

/** What the loop knows once the budget is spent, handed to the policy so it can word its own throw. */
export type VerifyExhaustion<V, P extends string> = {
  readonly attempts: number;
  /** Everything the final round's gate found. */
  readonly violations: readonly V[];
  /** The subset that is actually ending the job. */
  readonly blockingRemainder: readonly V[];
  /** The subset that would have degraded to advisory, had anything else let the Set publish. */
  readonly degradedRemainder: readonly V[];
  /** `"<category> (<ErrorClass>)"` -> how many rounds that remediation failed. Labels only. */
  readonly remediationFailures: ReadonlyMap<string, number>;
  /** Every fragment, loop-owned and section-owned, already in order. Join them; do not reorder. */
  readonly parts: readonly P[];
};

/**
 * One section's contribution to the loop.
 *
 * `S` is the Set shape, `V` the section's content-violation type, `Verdict` its Verifier response,
 * and `P` the string type its diagnostics are made of. `P` exists for Listening: its diagnostics are
 * `SafeDiagnostic`, a branded string that a Verifier-authored `.reason` cannot be assigned to, so the
 * compiler keeps Verifier prose out of the error message. Reading passes plain `string`.
 */
export type VerifyPolicy<S, V extends { readonly kind: string }, Verdict, P extends string> = {
  /** Console label, e.g. `"[readingGenerator]"`. */
  readonly logPrefix: string;
  /** Mints one of this section's diagnostic fragments from a loop-built, content-free string. */
  readonly diagnostic: (text: string) => P;
  /** Runs once, before the first round. */
  readonly preflight: (set: S) => void;
  /** The deterministic content gate. Re-read at the TOP of every round, never cached. */
  readonly violations: (set: S) => readonly V[];
  /** ADR-0006 `fatal`: hard-fails the run on sight, costing no provider time. */
  readonly isBlocking: (violation: V) => boolean;
  /** ADR-0006 `advisory`: has no remediation route, so the loop must not wait a round on it. */
  readonly isAdvisory: (violation: V) => boolean;
  /** `advisory`, plus the `repair-then-accept` kinds whose unrepaired outcome is advisory. */
  readonly isDegradable: (violation: V) => boolean;
  readonly formatViolations: (violations: readonly V[]) => string;
  /** The whole message thrown when the gate finds a blocking kind. */
  readonly describeGateFailure: (violations: readonly V[]) => string;
  /**
   * Every unit the Verifier judges, keyed by a section-chosen unit key and valued by a fingerprint of
   * everything its verdict depends on — an MCQ's fingerprint includes the text it is about, a
   * Stimulus's includes its questions. The loop sends a unit only while it has no passing verdict at
   * its current fingerprint, so a passed unit is judged again only when its content has changed.
   */
  readonly units: (set: S) => ReadonlyMap<string, string>;
  /** The verify call for the `pending` units only. Never called with an empty `pending`. */
  readonly verify: (set: S, pending: ReadonlySet<string>) => VerifyRequest<Verdict>;
  /** The verdict of a round with nothing pending: nothing judged, nothing found. */
  readonly emptyVerdict: Verdict;
  readonly planRound: (round: VerifyRound<S, V, Verdict>) => VerifyRoundPlan<S, P>;
  readonly describeExhaustion: (state: VerifyExhaustion<V, P>) => string;
  /** The one exit both success paths go through: rebalance, then record advisory notes. */
  readonly finish: (set: S, violations: readonly V[]) => S;
};

/**
 * Thrown when the round budget is spent and something that blocks is still outstanding. `message` is
 * whatever the policy worded, and reaches `job.error` and the Dashboard; the loop's own parts in it
 * include the remediation-failure ledger.
 */
export class GenerationVerifyExhaustedError extends Error {}

function formatRemediationFailures(failures: ReadonlyMap<string, number>): string {
  return [...failures].map(([descriptor, count]) => `${descriptor} x${count}`).join(", ");
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * Deterministic content gate first, then the section's LLM verify call, then whatever remediations
 * the section routed this round — repeated up to `MAX_VERIFY_ATTEMPTS` times.
 *
 * The verify call covers only the units still pending: a unit that passed keeps its pass until its
 * content changes, so "clean" means every unit has a pass for its current content and no
 * non-advisory content-gate violation remains — not one round in which the Verifier passed the whole
 * Set at once.
 *
 * A round ends in one of four ways: publish (nothing non-advisory outstanding), publish DEGRADED
 * (budget spent, nothing left that blocks), fail (budget spent, something left that blocks), or
 * remediate-and-go-again. Only the last one costs another verify call, so the budget is a budget of
 * verify calls, shared by every remediation category the section has.
 *
 * A regeneration response can itself be broken — a schema-valid reply that omits a requested id, a
 * zod parse failure on the patched Set, a provider error. Every remediation therefore runs inside
 * the guard below: on failure the Set is left unchanged for that category, the SAME violations are
 * found again next round and a fresh regeneration is attempted, and if it never lands the exhaustion
 * throw — a bounded-retry exhaustion, not a first-miss failure — is what reports it, naming the
 * error CLASS and the round count. Only `error.name` is ever read, never `.message`: a remediation's
 * failure surface includes zod parse failures, whose messages quote the offending VALUES (passage
 * prose, stems, option text, transcripts), and Set text is never logged, error paths included (the
 * same rule as setStore.ts's `safeSetErrorDescriptor`).
 */
export async function runVerifyLoop<
  S,
  V extends { readonly kind: string },
  Verdict,
  P extends string,
>(input: {
  set: S;
  policy: VerifyPolicy<S, V, Verdict, P>;
  run: SkillTaskRunner;
  onProgress: OnGenerationProgress | undefined;
  setId: string;
}): Promise<S> {
  const { policy } = input;
  policy.preflight(input.set);

  let current = input.set;
  // "<category> (<ErrorClass>)" -> how many rounds it failed. Server-authored labels only — a
  // category name a policy wrote and an error CLASS name — so this is safe to carry into the
  // exhaustion diagnostic, which can then say a regeneration reply kept failing rather than only
  // "unresolved issues after N attempts".
  const remediationFailures = new Map<string, number>();
  // Unit key -> the fingerprint it last passed at. A Verifier judging the same unchanged content
  // twice can disagree with itself, so a pass stands until the content it was about changes.
  const passedAt = new Map<string, string>();

  for (let attempt = 1; attempt <= MAX_VERIFY_ATTEMPTS; attempt += 1) {
    // The one statement of the termination condition: the ending below and the policy's
    // `VerifyRound.isFinalRound` both read this binding.
    const isFinalRound = attempt === MAX_VERIFY_ATTEMPTS;
    // The gate runs BEFORE the round's verify call, so a hard-failing content defect costs no
    // provider time at all, and reports every violation it found rather than the first.
    const violations = policy.violations(current);
    if (violations.some((violation) => policy.isBlocking(violation))) {
      throw new Error(policy.describeGateFailure(violations));
    }

    const units = policy.units(current);
    const pending = new Set([...units].filter(([key, fingerprint]) => passedAt.get(key) !== fingerprint).map(([key]) => key));
    let verdict = policy.emptyVerdict;
    if (pending.size > 0) {
      const request = policy.verify(current, pending);
      const res = await callVerifySkillTask({
        run: input.run,
        task: request.task,
        prompt: request.prompt,
        jsonSchema: request.jsonSchema,
        parse: request.parse,
        stage: "verifying",
        onProgress: input.onProgress,
        setId: input.setId,
        logPrefix: policy.logPrefix,
      });
      if (!res.ok) throw new Error(res.error);
      verdict = res.value;
    }

    const plan = policy.planRound({ attempt, isFinalRound, set: current, violations, verdict, units });
    for (const key of plan.passed) {
      const fingerprint = units.get(key);
      if (fingerprint !== undefined) passedAt.set(key, fingerprint);
    }

    // An `advisory` kind is not something the loop waits on. It has no remediation route, so another
    // round would re-find it unchanged; counting it here would burn the whole budget and then fail a
    // publishable Set. It rides out on the Set as a note instead.
    const unresolved = violations.filter((violation) => !policy.isAdvisory(violation));
    if (unresolved.length === 0 && plan.verdictFindings === 0) {
      return policy.finish(current, violations);
    }

    if (isFinalRound) {
      // The repair budget is spent, so the degrading kinds have had every round they were going to
      // get. What is LEFT decides the ending: if none of it blocks, the Set publishes with the
      // findings recorded rather than being thrown away.
      const blockingRemainder = violations.filter((violation) => !policy.isDegradable(violation));
      if (blockingRemainder.length === 0 && plan.verdictFindings === 0) {
        // The Set publishes DEGRADED: remediation was attempted for every one of these and never
        // landed. The advisory notes tell the User; this line tells the operator, with the
        // remediation-failure classes that separate a persistently malformed regeneration reply from
        // a model that could not fix the content. Kinds and error CLASS names only, no content.
        console.warn(
          `${policy.logPrefix} publishing with ${violations.length} unrepaired advisory violation(s) after `
            + `${MAX_VERIFY_ATTEMPTS} verify attempts: ${[...new Set(violations.map((v) => v.kind))].join(", ")}`
            + (remediationFailures.size > 0
              ? ` | remediation failures: ${formatRemediationFailures(remediationFailures)}`
              : ""),
        );
        return policy.finish(current, violations);
      }
      // The degradable violations that ALSO survived. They are not why the job fails, but naming them
      // keeps an operator from fixing the named defect, paying for another full run, and only then
      // learning about these.
      const degradedRemainder = violations.filter((violation) => policy.isDegradable(violation));
      const parts: P[] = [
        ...(blockingRemainder.length > 0
          ? [policy.diagnostic(
            `${blockingRemainder.length} content-gate violation(s): ${policy.formatViolations(blockingRemainder)}`,
          )]
          : []),
        ...(degradedRemainder.length > 0
          ? [policy.diagnostic(
            `${degradedRemainder.length} advisory violation(s) also unresolved (not the cause of this failure): ${
              policy.formatViolations(degradedRemainder)
            }`,
          )]
          : []),
        ...plan.exhaustionParts,
        ...(remediationFailures.size > 0
          ? [policy.diagnostic(`remediation failures: ${formatRemediationFailures(remediationFailures)}`)]
          : []),
      ];
      throw new GenerationVerifyExhaustedError(
        policy.describeExhaustion({
          attempts: MAX_VERIFY_ATTEMPTS,
          violations,
          blockingRemainder,
          degradedRemainder,
          remediationFailures,
          parts,
        }),
      );
    }

    // ---- Admission: the wholesale-this-round exclusion.
    //
    // Waves are walked in claim order and every remediation is admitted against what strictly
    // earlier waves claimed — never against its own wave, which is what lets two remediations in one
    // wave both touch an id. A remediation with nothing left after the filter is not issued at all:
    // no call, no guard entry, nothing to record.
    const claimed = new Set<string>();
    const admitted: AdmittedRemediation<S>[] = [];
    for (const wave of plan.remediations) {
      const wavePicks = wave
        .map((remediation) => remediation.admit(current, claimed))
        .filter((pick): pick is AdmittedRemediation<S> => pick !== undefined);
      for (const pick of wavePicks) {
        for (const id of pick.claims) claimed.add(id);
        admitted.push(pick);
      }
    }

    // ---- Dispatch: explanations first, then wholesale, each in the order the section declared.
    for (const pass of ["explanation", "wholesale"] as const) {
      for (const pick of admitted.filter((entry) => entry.pass === pass)) {
        try {
          current = await pick.issue(current);
        } catch (error) {
          const descriptor = `${pick.category} (${error instanceof Error ? error.name : "unknown"})`;
          remediationFailures.set(descriptor, (remediationFailures.get(descriptor) ?? 0) + 1);
          console.error(
            `${policy.logPrefix} verify attempt ${attempt}/${MAX_VERIFY_ATTEMPTS}: ${descriptor} remediation failed, will retry next round`,
          );
        }
      }
    }
  }
  // Unreachable: the loop above always either returns or throws by MAX_VERIFY_ATTEMPTS.
  return current;
}
