import type {
  AnySet,
  ListeningGenerationInput,
  ListeningGenerationPlan,
  ReadingGeneratedSet,
  ReadingGenerationPlan,
  SetAdvisoryNote,
  SpeakingGenerationInput,
  SpeakingGenerationPlan,
  WritingGenerationPlan,
  WritingSet,
} from "@toefl-prep/shared";
import { candidateDomainDriftNotes } from "./generationNovelty.js";
import type { ReservedGenerationPlan } from "./generationPlanner.js";
import {
  callGenerationSkillTask,
  type DiversityAttempt,
  type OnGenerationProgress,
  type SkillTaskRunner,
} from "./generationReasoning.js";
import type { SkillTaskRequest } from "./reasoning/router.js";

// The candidate loop: one loop, four section adapters.
//
// The loop owns what every section shares: the attempt budget, the generate call, the retry-hint
// table and its one rule, the rejection accumulator, the exhaustion throw, and attaching the Plan's
// and the candidate's novelty notes to an accepted candidate. Each section's adapter, exported from
// its own generator module, supplies the rest: its prompt, schema, assembly, the accept/reject
// decision (where it applies the ADR 0006 tiers) and its exhaustion wording. generator.ts imports
// the adapters and picks one by kind; no adapter imports generator.ts, and this module imports no
// adapter.

export const CANDIDATE_ATTEMPT_BUDGET = 3;

/** Which of the three attempts this is. Same 1|2|3 the transcript log records per generate call. */
export type CandidateAttempt = DiversityAttempt;

// ---------------------------------------------------------------------------
// The retry-hint table
// ---------------------------------------------------------------------------

/**
 * The ways a candidate attempt can be rejected, and therefore the rows the retry-hint table can have.
 * Novelty is not one of them: the candidate stage's novelty finding (domain drift) is recorded on
 * the Set, never rejected (generationNovelty's candidateDomainDriftNotes).
 *
 *  - `conformance`  — a deterministic content gate (Writing's Build a Sentence, Speaking's Listen
 *                     and Repeat) flagged the candidate while attempts remained.
 *  - `difficulty`   — the Upper Module read no harder than the Lower (Reading/Listening).
 *  - `item-ids`     — Listening's or Speaking's id validation failed (an Item id, or an id that
 *                     names a clip file another id already names): drift from one probabilistic
 *                     generate call, so it costs an attempt rather than the run.
 */
export type RejectionClass = "conformance" | "difficulty" | "item-ids";

/**
 * The shape every section's rejection type must have: which class it is, and the hint it hands the
 * next attempt (absent when that class carries no prompt hint, as Listening's `item-ids`).
 * Everything else on a section's rejection is for that section's exhaustion message.
 */
export type CandidateRejectionLike = {
  readonly rejection: RejectionClass;
  readonly hint?: unknown;
};

/**
 * The retry-hint table: one optional row per rejection class the section can produce, holding that
 * class's hint payload. One table rather than a variable per class, so the rule in
 * `retryHintsAfter` cannot be skipped by a forgotten reset.
 */
export type RetryHints<R extends CandidateRejectionLike> = {
  readonly [C in R["rejection"]]?: Extract<R, { rejection: C }>["hint"];
};

/**
 * The rule, written as the only way a table can be built: the newest rejection's hint is the only
 * live hint, and every other class's hint is cleared.
 *
 * The table is constructed from one rejection rather than mutated, so no hint can survive a
 * rejection of a different class. Otherwise an attempt rejected over difficulty would be handed the
 * previous attempt's complaint about Items that no longer exist.
 */
export function retryHintsAfter<R extends CandidateRejectionLike>(rejection: R): RetryHints<R> {
  return { [rejection.rejection]: rejection.hint } as RetryHints<R>;
}

// ---------------------------------------------------------------------------
// Candidate shape checks (shared by the loop and by generator.ts's import path)
// ---------------------------------------------------------------------------

/**
 * A candidate Set before it is minted. The Writing arm is the persisted `WritingSet`: a parsed
 * Writing candidate is converted (`frame: null` -> no key) as it comes out of the schema, where a
 * Speaking candidate is sanitized, so nothing downstream has to know the null shape exists.
 */
export type GenerationCandidate =
  | SpeakingGenerationInput
  | WritingSet
  | ReadingGeneratedSet
  | ListeningGenerationInput;

// Model-written Item ids become audio file names (renderSpeakingAudio) and path.join inputs, so they
// are constrained before anything downstream trusts them.
const ITEM_ID_RE = /^[A-Za-z0-9_-]+$/;

function collectItemIds(set: GenerationCandidate | AnySet): string[] {
  if (set.kind === "speaking") {
    return [
      ...set.listenAndRepeat.items.map((i) => i.id),
      ...set.interview.questions.map((q) => q.id),
    ];
  }
  if (set.kind === "reading") {
    // A Reading Set's Items are its CtW gaps and its MCQs; Stimulus ids (passages, texts) are
    // containers, never scored. Every module counts, both second modules included: they are published
    // in the same file.
    return [set.router, set.lowerModule, set.upperModule].flatMap((module) => [
      ...module.ctwPassages.flatMap((passage) => passage.gaps.map((gap) => gap.id)),
      ...module.dailyLife.flatMap((text) => text.questions.map((question) => question.id)),
      ...module.academic.flatMap((passage) => passage.questions.map((question) => question.id)),
    ]);
  }
  if (set.kind === "listening") {
    // A Listen and Choose a Response entry is itself one Item (its key sits on the entry); a
    // Conversation, Announcement or Academic Talk is a Stimulus whose questions are the Items.
    return [set.router, set.lowerModule, set.upperModule].flatMap((module) => [
      ...module.listenChoose.map((item) => item.id),
      ...module.conversations.flatMap((conversation) => conversation.questions.map((question) => question.id)),
      ...module.announcements.flatMap((announcement) => announcement.questions.map((question) => question.id)),
      ...module.academicTalks.flatMap((talk) => talk.questions.map((question) => question.id)),
    ]);
  }
  return [
    ...set.buildASentence.items.map((i) => i.id),
    set.email.id,
    set.academicDiscussion.id,
  ];
}

/** Throws a `set validation failed:` error on an Item id that is malformed or used twice. */
export function validateItemIds(set: GenerationCandidate | AnySet): void {
  const seen = new Set<string>();
  for (const id of collectItemIds(set)) {
    if (!ITEM_ID_RE.test(id)) {
      throw new Error(`set validation failed: item id "${id}" contains characters outside [A-Za-z0-9_-]`);
    }
    if (seen.has(id)) {
      throw new Error(`set validation failed: duplicate item id "${id}"`);
    }
    seen.add(id);
  }
}

// ---------------------------------------------------------------------------
// The accepted candidate
// ---------------------------------------------------------------------------

/**
 * An accepted candidate with the Plan it was generated from. `advisoryNotes` is what the ADR 0006
 * `advisory` tier produced for it: the findings Plan admission recorded, plus whatever the candidate
 * stage recorded rather than rejected. They ride here because finalizeAndPublishGeneratedSet, where
 * the Set is minted, is the first place they can be written; optional, and absent means none.
 */
export type PlannedCandidate = ({
      kind: "speaking";
      candidate: SpeakingGenerationInput;
      plan: SpeakingGenerationPlan;
    }
  | {
      kind: "writing";
      // The persisted shape, not WritingGenerationInput: `toPersistedWritingSet` has already dropped
      // the `frame: null` the strict generation schema makes the model emit for a frameless Item.
      // Everything downstream reads a frame that is a string or absent.
      candidate: WritingSet;
      plan: WritingGenerationPlan;
    }
  | {
      kind: "reading";
      candidate: ReadingGeneratedSet;
      plan: ReadingGenerationPlan;
    }
  | {
      kind: "listening";
      candidate: ListeningGenerationInput;
      plan: ListeningGenerationPlan;
    }) & {
      /** What the Set will carry. Absent means none. */
      advisoryNotes?: readonly SetAdvisoryNote[];
    };

// ---------------------------------------------------------------------------
// The adapter interface
// ---------------------------------------------------------------------------

/** Everything the loop hands an adapter for one attempt. */
export type CandidateAttemptContext = {
  readonly attempt: CandidateAttempt;
  readonly attemptBudget: number;
  readonly run: SkillTaskRunner;
  readonly onProgress?: OnGenerationProgress;
};

/** parse → assemble → whatever the section checks before deciding. */
export type PreparedCandidate<C extends GenerationCandidate, R extends CandidateRejectionLike> =
  | { readonly candidate: C }
  | { readonly rejected: R };

export type CandidateDecision<R extends CandidateRejectionLike> =
  | { readonly accepted: PlannedCandidate }
  | { readonly rejected: R };

/**
 * What the loop knows once the budget is spent, handed to the adapter so it can format its own
 * exhaustion message. The wording is section policy, not loop policy: it reaches `job.error` and the
 * Dashboard.
 *
 * `newest` is the rejection that spent the last attempt; `lastByClass` keeps the last rejection of
 * each class, so an earlier class stays nameable after a later one.
 */
export type CandidateExhaustion<R extends CandidateRejectionLike> = {
  readonly attempts: number;
  /** Every rejection, oldest first. */
  readonly rejections: readonly R[];
  /** The rejection that spent the last attempt. */
  readonly newest: R;
  /** The last rejection of each class, whether or not it was the newest one. */
  readonly lastByClass: { readonly [C in R["rejection"]]?: Extract<R, { rejection: C }> };
};

/**
 * One section's contribution to the loop.
 *
 * `Raw` is what the generate call parses to, `C` the prepared candidate `decide` reads, and `R` the
 * section's own rejection union: discriminated on `rejection`, carrying the hint for the next attempt
 * and whatever the exhaustion message needs.
 */
export type CandidateAdapter<
  Raw,
  C extends GenerationCandidate,
  R extends CandidateRejectionLike,
> = {
  readonly task: SkillTaskRequest<unknown>["task"];
  readonly jsonSchema: object;
  /** The router-level parse: what `callGenerationSkillTask` validates the provider response with. */
  readonly parseResponse: (value: unknown) => unknown;
  /**
   * The same schema again, with the placeholder `id`/`source`/`createdAt` every candidate is parsed
   * under. The loop wraps a failure in a `set validation failed:` error, which also keeps that
   * construction out of listeningGenerator.ts (see its `listeningFailure`).
   */
  readonly parseCandidate: (value: unknown) => Raw;
  /** The GENERATE prompt for this attempt, given the live hint table. */
  readonly prompt: (hints: RetryHints<R>) => string;
  readonly prepare: (input: {
    readonly raw: Raw;
    readonly ctx: CandidateAttemptContext;
  }) => Promise<PreparedCandidate<C, R>>;
  /**
   * Accepts or rejects a prepared candidate. An accepted candidate's own `advisoryNotes` are the
   * section's; the loop adds the Plan's and the candidate's domain drift to them.
   */
  readonly decide: (input: {
    readonly candidate: C;
    readonly ctx: CandidateAttemptContext;
  }) => CandidateDecision<R>;
  readonly describeExhaustion: (state: CandidateExhaustion<R>) => string;
};

/**
 * Thrown when all `CANDIDATE_ATTEMPT_BUDGET` attempts were rejected. `message` is what the adapter
 * formatted; it reaches `job.error` and the Dashboard.
 */
export class GenerationCandidateExhaustedError extends Error {}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/**
 * The accepted candidate with every note the Set will carry, in order: what Plan admission recorded,
 * then the components whose content contradicts their planned domain, then the section's own.
 */
function withNoveltyNotes(
  accepted: PlannedCandidate,
  reservation: ReservedGenerationPlan,
): PlannedCandidate {
  const notes = [
    ...(reservation.advisoryNotes ?? []),
    ...candidateDomainDriftNotes(accepted.plan, accepted.candidate),
    ...(accepted.advisoryNotes ?? []),
  ];
  return notes.length > 0 ? { ...accepted, advisoryNotes: notes } : accepted;
}

/**
 * Generates up to `CANDIDATE_ATTEMPT_BUDGET` candidates through `adapter`, returning the first one
 * the adapter accepts, with its advisory notes. Throws GenerationCandidateExhaustedError when every
 * attempt is rejected; a provider failure or an unparseable candidate throws at once.
 */
export async function runCandidateLoop<
  Raw,
  C extends GenerationCandidate,
  R extends CandidateRejectionLike,
>(input: {
  adapter: CandidateAdapter<Raw, C, R>;
  run: SkillTaskRunner;
  reservation: ReservedGenerationPlan;
  onProgress?: OnGenerationProgress;
}): Promise<PlannedCandidate> {
  const { adapter } = input;
  const rejections: R[] = [];
  let hints: RetryHints<R> = {};
  const reject = (rejection: R): void => {
    rejections.push(rejection);
    hints = retryHintsAfter(rejection);
  };

  for (let rawAttempt = 1; rawAttempt <= CANDIDATE_ATTEMPT_BUDGET; rawAttempt += 1) {
    const attempt = rawAttempt as CandidateAttempt;
    const ctx: CandidateAttemptContext = {
      attempt,
      attemptBudget: CANDIDATE_ATTEMPT_BUDGET,
      run: input.run,
      onProgress: input.onProgress,
    };

    const result = await callGenerationSkillTask({
      run: input.run,
      task: adapter.task,
      prompt: adapter.prompt(hints),
      jsonSchema: adapter.jsonSchema,
      parse: adapter.parseResponse,
      stage: "generating",
      onProgress: input.onProgress,
      generationAttempt: attempt,
    });
    if (!result.ok) throw new Error(result.error);

    let raw: Raw;
    try {
      raw = adapter.parseCandidate(result.value);
    } catch (error) {
      throw new Error(
        `set validation failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const prepared = await adapter.prepare({ raw, ctx });
    if ("rejected" in prepared) {
      reject(prepared.rejected);
      continue;
    }

    const decision = adapter.decide({ candidate: prepared.candidate, ctx });
    if ("accepted" in decision) {
      return withNoveltyNotes(decision.accepted, input.reservation);
    }
    reject(decision.rejected);
  }

  const lastByClass: Record<string, R> = {};
  for (const rejection of rejections) lastByClass[rejection.rejection] = rejection;
  throw new GenerationCandidateExhaustedError(
    adapter.describeExhaustion({
      attempts: CANDIDATE_ATTEMPT_BUDGET,
      rejections,
      newest: rejections[rejections.length - 1],
      lastByClass: lastByClass as CandidateExhaustion<R>["lastByClass"],
    }),
  );
}
