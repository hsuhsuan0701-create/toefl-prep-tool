import crypto from "node:crypto";
import { assertNever } from "../lib/assertNever.js";
import { toProviderJsonSchema } from "./reasoning/jsonSchema.js";
import {
  GenerationDomainFamilySchema,
  REQUIRED_CONCEPT_MAX_CHARS,
  ListeningGenerationPlanSchema,
  ReadingGenerationPlanSchema,
  SpeakingGenerationPlanSchema,
  WritingGenerationPlanSchema,
  type GenerationDomainFamily,
  type GenerationPlan,
  type SetAdvisoryNote,
} from "@toefl-prep/shared";
import { config } from "../lib/config.js";
import { supersededSetIds } from "./supersession.js";
import {
  callGenerationSkillTask,
  type OnGenerationProgress,
  type SkillTaskRunner,
} from "./generationReasoning.js";
import {
  advisoryNotesFromIssues,
  diversityRetryDetail,
  diversityRetrySummary,
  scrubDiversityIssues,
  TASK_ORDER,
  type DiversityIssue,
  type NoveltyTaskType,
} from "./diversityIssues.js";
import {
  buildNoveltyCatalog,
  domainCounts,
  PENDING_ENTRY_CREATED_AT,
  type NoveltyCatalogEntry,
} from "./generationCatalog.js";
import { DOMAIN_KEYWORDS, preferredDomains } from "./generationDomains.js";
import {
  admissibleNow,
  admissibleOnExhaustion,
  PHYSICAL_SETTING_TERMS,
  requiredPreferredSituations,
  stripInvalidDistinctions,
  validateGenerationPlan,
} from "./generationNovelty.js";
import { createSetStore } from "./setStore.js";

export type GenerationKind = "speaking" | "writing" | "reading" | "listening";
// The Plan shapes this planner can reserve. Today that is all of GenerationPlan; deriving it from
// GenerationKind keeps the two tied if either widens.
type PlanForKind = Extract<GenerationPlan, { kind: GenerationKind }>;

export interface ReservedGenerationPlan {
  readonly reservationId: string;
  readonly ownerId: string;
  readonly plan: PlanForKind;
  /**
   * What admission recorded rather than rejected — Catalog overlap, and Build a Sentence's domain
   * spread once its replans are spent — already in the form the Set carries. Absent when the Plan
   * was admitted clean.
   */
  readonly advisoryNotes?: readonly SetAdvisoryNote[];
}

/**
 * Plans Sets against the Catalog. An admitted Plan stays reserved, and part of every later Catalog
 * build, until `release`, so concurrent jobs are planned against each other's Plans as well as the
 * saved bank.
 */
export interface GenerationPlanner {
  reserve(input: {
    kind: GenerationKind;
    ownerId: string;
    runSkillTask: SkillTaskRunner;
    onProgress?: OnGenerationProgress;
    /** The Set this run replaces, left out of the Catalog it is planned against. */
    supersedesSetId?: string;
  }): Promise<ReservedGenerationPlan>;
  release(reservationId: string): void;
}

class FifoMutex {
  private tail: Promise<void> = Promise.resolve();

  async acquire(): Promise<() => void> {
    let releaseTicket!: () => void;
    const ticket = new Promise<void>((resolve) => {
      releaseTicket = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => ticket);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseTicket();
    };
  }
}

const MAX_DIVERSITY_ATTEMPTS = 3;

// The planner prompt carries at most this many Catalog entries per Task Type, each descriptor cut
// to PROMPT_DESCRIPTOR_CHARS, so its size does not grow with the bank. Admission still validates
// against the complete Catalog, and the payload says how many entries it left out, so the model is
// never told a partial bank is the whole bank.
const PROMPT_ENTRIES_PER_TASK = 40;
// The part of that slice saved Sets keep however many reservations are in flight (boundedCatalog).
const PROMPT_SAVED_ENTRIES_PER_TASK = PROMPT_ENTRIES_PER_TASK / 2;
const PROMPT_DESCRIPTOR_CHARS = 240;

interface PromptCatalogEntry {
  setId: string;
  taskType: NoveltyTaskType;
  domain: GenerationDomainFamily;
  noveltyKey?: string;
  canonicalTitle?: string;
  descriptor: string;
}

/** Truncates on a token boundary: a mid-word cut injects tokens the source never contained. */
function boundedForPrompt(descriptor: string): string {
  if (descriptor.length <= PROMPT_DESCRIPTOR_CHARS) return descriptor;
  const head = descriptor.slice(0, PROMPT_DESCRIPTOR_CHARS);
  const lastBoundary = head.lastIndexOf(" ");
  return (lastBoundary > 0 ? head.slice(0, lastBoundary) : head).trim();
}

function promptEntry(entry: NoveltyCatalogEntry): PromptCatalogEntry {
  return {
    setId: entry.setId,
    taskType: entry.taskType,
    domain: entry.domain,
    ...(entry.noveltyKey ? { noveltyKey: entry.noveltyKey } : {}),
    ...(entry.canonicalTitle ? { canonicalTitle: entry.canonicalTitle } : {}),
    descriptor: boundedForPrompt(entry.descriptor),
  };
}

function boundedCatalog(catalog: readonly NoveltyCatalogEntry[]): {
  entries: PromptCatalogEntry[];
  omittedByTaskType: Partial<Record<NoveltyTaskType, number>>;
} {
  const entries: PromptCatalogEntry[] = [];
  const omittedByTaskType: Partial<Record<NoveltyTaskType, number>> = {};
  for (const taskType of TASK_ORDER) {
    const forTask = catalog.filter((entry) => entry.taskType === taskType);
    // Newest first, so the most recent Sets are the ones the planner is sure to see. Reservations
    // carry PENDING_ENTRY_CREATED_AT and sort ahead of every saved Set.
    const ordered = [...forTask].sort((left, right) =>
      (left.createdAt < right.createdAt
        ? 1
        : left.createdAt > right.createdAt
        ? -1
        : 0) ||
      (left.setId < right.setId ? -1 : left.setId > right.setId ? 1 : 0) ||
      left.itemPosition - right.itemPosition
    );
    // In-flight reservations and saved Sets split the slice, each guaranteed half and each free to
    // use what the other leaves. A Listening Plan carries twenty Listen and Choose a Response
    // entries, so without the split two concurrent reservations fill the whole slice and the planner
    // sees no saved Set at all.
    const pending = ordered.filter((entry) => entry.createdAt === PENDING_ENTRY_CREATED_AT);
    const saved = ordered.filter((entry) => entry.createdAt !== PENDING_ENTRY_CREATED_AT);
    const savedShare = Math.min(
      saved.length,
      Math.max(PROMPT_ENTRIES_PER_TASK - pending.length, PROMPT_SAVED_ENTRIES_PER_TASK),
    );
    const kept = [
      ...pending.slice(0, PROMPT_ENTRIES_PER_TASK - savedShare),
      ...saved.slice(0, savedShare),
    ];
    if (ordered.length > kept.length) {
      omittedByTaskType[taskType] = ordered.length - kept.length;
    }
    entries.push(...kept.map(promptEntry));
  }
  return { entries, omittedByTaskType };
}

function planSchema(kind: GenerationKind) {
  return kind === "speaking"
    ? SpeakingGenerationPlanSchema
    : kind === "writing"
    ? WritingGenerationPlanSchema
    : kind === "reading"
    ? ReadingGenerationPlanSchema
    : kind === "listening"
    ? ListeningGenerationPlanSchema
    // A new GenerationKind is a compile error here, never a Plan parsed against the wrong schema.
    : assertNever(kind);
}

function parsePlan(kind: GenerationKind, value: unknown): PlanForKind {
  return kind === "speaking"
    ? SpeakingGenerationPlanSchema.parse(value)
    : kind === "writing"
    ? WritingGenerationPlanSchema.parse(value)
    : kind === "reading"
    ? ReadingGenerationPlanSchema.parse(value)
    : kind === "listening"
    ? ListeningGenerationPlanSchema.parse(value)
    : assertNever(kind);
}

function preferredDomainsByTaskType(
  catalog: readonly NoveltyCatalogEntry[],
): Record<NoveltyTaskType, GenerationDomainFamily[]> {
  const counts = domainCounts(catalog);
  return {
    listen_repeat: preferredDomains(counts.listen_repeat),
    interview: preferredDomains(counts.interview),
    build_sentence: preferredDomains(counts.build_sentence),
    email: preferredDomains(counts.email),
    discussion: preferredDomains(counts.discussion),
    complete_words: preferredDomains(counts.complete_words),
    daily_life: preferredDomains(counts.daily_life),
    academic_passage: preferredDomains(counts.academic_passage),
    listen_choose: preferredDomains(counts.listen_choose),
    conversation: preferredDomains(counts.conversation),
    announcement: preferredDomains(counts.announcement),
    academic_talk: preferredDomains(counts.academic_talk),
  };
}

/** What a log line or the thrown error may say about a plan's issues: scrubbed of plan text. */
function planIssueDetail(issues: readonly DiversityIssue[]): string {
  return JSON.stringify(scrubDiversityIssues(issues));
}

function plannerPrompt(input: {
  kind: GenerationKind;
  attempt: 1 | 2 | 3;
  catalog: readonly NoveltyCatalogEntry[];
  previousIssues: readonly DiversityIssue[];
}): string {
  const preferredByTaskType = preferredDomainsByTaskType(input.catalog);
  const bounded = boundedCatalog(input.catalog);
  const payload = {
    kind: input.kind,
    attempt: input.attempt,
    maxAttempts: MAX_DIVERSITY_ATTEMPTS,
    domainFamilies: GenerationDomainFamilySchema.options,
    // Admission rejects a Plan whose own wording contradicts the domain family it declares, judged
    // by this table; without it the rule would be unsatisfiable.
    domainKeywords: DOMAIN_KEYWORDS,
    // The same rule and reason for Listen and Repeat's `setting`, which must name one of these. See
    // PHYSICAL_SETTING_TERMS in generationNovelty.ts for what the check verifies and why the list is
    // not exhaustive.
    physicalSettingTerms: PHYSICAL_SETTING_TERMS,
    // Required concepts are guidance: nothing checks the generated Set for them. Their form still
    // matters for prose quality — a concept worded as an instruction about the answer reads as an
    // instruction rather than content. The schema's max length carries the length rule.
    requiredConceptRules: {
      maxCharacters: REQUIRED_CONCEPT_MAX_CHARS,
      form:
        "A concrete noun phrase naming something the final content should cover, worded as the content itself would say it.",
      good: ["cheaper fares versus frequent service", "hydration counter refilled before opening"],
      bad: [
        "A stated preference between cheaper fares and more frequent service, with a reason",
        "A usual weekday trip described concretely, including the bus the speaker relies on",
      ],
      whyBad:
        "Words like 'stated', 'preference', 'described', 'concretely' and 'a recommendation about' describe the response instead of naming content, so they read as meta-commentary rather than something natural content would ever actually say.",
    },
    preferredDomainsByTaskType: preferredByTaskType,
    buildSentenceRules: {
      situations: 10,
      minimumDistinctDomains: 5,
      maximumPerDomain: 3,
      minimumInPreferredDomains: requiredPreferredSituations(
        preferredByTaskType.build_sentence.length,
      ),
    },
    domainCountsByTaskType: domainCounts(input.catalog),
    catalog: bounded.entries,
    catalogOmittedByTaskType: bounded.omittedByTaskType,
    // Reading's and Listening's plan entries carry itemPosition/planLabel, so their retry names the
    // exact slot that failed; Speaking and Writing get the summary shape.
    retry: input.attempt === 1
      ? null
      : input.kind === "reading" || input.kind === "listening"
      ? diversityRetryDetail(input.previousIssues)
      : diversityRetrySummary(input.previousIssues),
  };
  return [
    `PLAN ${input.kind}`,
    "",
    "Select semantic content for one complete TOEFL set; do not write final learner-facing wording.",
    "Preserve every TOEFL structural requirement defined by the canonical skill.",
    "Use the preferred domains and avoid semantic reuse of every catalog entry.",
    "Each component's own planning wording must contain at least one keyword of the domain family it declares, and no more keywords of any other family.",
    "For Speaking's Listen and Repeat component, `setting` must contain at least one word from `physicalSettingTerms` (a form of it — plurals and the usual verb/noun endings are matched), naming a real, concrete, illustratable place. Reach for the term that actually names the place rather than appending an unrelated one from the list.",
    "Return planning JSON only. Do not repeat planning metadata in final generated content.",
    "",
    "```json",
    JSON.stringify(payload),
    "```",
  ].join("\n");
}

export function createGenerationPlanner(input: {
  dataDir: string;
  randomUUID?: () => string;
  warn?: (message: string) => void;
  // Injected so this factory stays database-free and a test can state the retired Sets explicitly;
  // production passes supersession.ts's reader. Called on every Catalog build, never memoized, so a
  // retirement or its reversal takes effect on the next build.
  supersededSetIds?: () => ReadonlySet<string>;
}): GenerationPlanner {
  const reservations = new Map<string, { ownerId: string; plan: PlanForKind }>();
  const admission = new FifoMutex();
  const randomUUID = input.randomUUID ?? crypto.randomUUID;
  // One store for the planner's lifetime. `SetStore` keeps no parsed Set (its one cache holds titles,
  // which the planner never reads), and the Catalog's cache is keyed on `store.bankDir`.
  const store = createSetStore(input.dataDir);

  // `pendingSupersededSetId` is this run's own replacement target, which is retired only once the
  // replacement publishes, so the injected reader does not list it yet.
  function currentCatalog(pendingSupersededSetId?: string): NoveltyCatalogEntry[] {
    const retired = new Set(input.supersededSetIds?.() ?? []);
    if (pendingSupersededSetId) retired.add(pendingSupersededSetId);
    return buildNoveltyCatalog({
      store,
      reservations: [...reservations.values()],
      ...(input.warn ? { warn: input.warn } : {}),
      ...(retired.size > 0 ? { supersededSetIds: retired } : {}),
    });
  }

  return {
    /**
     * Plans until a Plan can be admitted, for up to MAX_DIVERSITY_ATTEMPTS plan calls.
     *
     * A Plan is admitted as soon as every issue it carries is advisory; its issues ride to the Set
     * as notes. A fatal issue — a component contradicting its declared domain, a Listen and Repeat
     * setting that names no place — buys a replan with the issues as the retry hint. So does Build a
     * Sentence's domain spread, whose repair IS the replan: the first plan whose only non-advisory
     * issue is that spread is kept, and admitted with a note if every replan fails too.
     *
     * The admission lock covers only what two concurrent reservations could race on — reading the
     * Catalog (which includes every committed reservation), validating against it, and committing.
     * The plan call runs outside it, so a batch's planning is never serialized; a plan is therefore
     * validated against a Catalog read under the lock AFTER its call returns, and a sibling that
     * committed meanwhile is part of what it is measured against.
     */
    async reserve(reserveInput): Promise<ReservedGenerationPlan> {
      const admitted = async <T>(step: () => T): Promise<T> => {
        const release = await admission.acquire();
        try {
          return step();
        } finally {
          release();
        }
      };
      const catalogNow = (): NoveltyCatalogEntry[] => currentCatalog(reserveInput.supersedesSetId);

      // Runs under the admission lock only.
      const commit = (plan: PlanForKind, issues: readonly DiversityIssue[]): ReservedGenerationPlan => {
        const reservationId = randomUUID();
        reservations.set(reservationId, { ownerId: reserveInput.ownerId, plan });
        if (issues.length > 0) {
          const scrubbed = scrubDiversityIssues(issues);
          console.warn(
            `[generationPlanner] ${reserveInput.kind} plan admitted with ${issues.length} recorded issue(s):`,
            JSON.stringify(scrubbed),
          );
          reserveInput.onProgress?.({ stage: "planning", detail: { noveltyResidual: scrubbed } });
        }
        return Object.freeze({
          reservationId,
          ownerId: reserveInput.ownerId,
          plan,
          ...(issues.length > 0
            ? { advisoryNotes: Object.freeze(advisoryNotesFromIssues(issues)) }
            : {}),
        });
      };

      // Validates `plan` against the Catalog as it stands now and, when `admit` says so, commits it in
      // the same locked step.
      const validateAndMaybeCommit = (
        plan: PlanForKind,
        admit: (issues: readonly DiversityIssue[]) => boolean,
      ): Promise<{ reservation: ReservedGenerationPlan } | { issues: DiversityIssue[] }> =>
        admitted(() => {
          const issues = validateGenerationPlan({ plan, catalog: catalogNow() });
          return admit(issues) ? { reservation: commit(plan, issues) } : { issues };
        });

      let previousIssues: DiversityIssue[] = [];
      let retained: PlanForKind | undefined;
      for (let rawAttempt = 1; rawAttempt <= MAX_DIVERSITY_ATTEMPTS; rawAttempt += 1) {
        const attempt = rawAttempt as 1 | 2 | 3;
        // Rebuilt per attempt, so a Set published by a concurrent job is in this attempt's prompt.
        const catalog = await admitted(catalogNow);
        const result = await callGenerationSkillTask<PlanForKind>({
          run: reserveInput.runSkillTask,
          task: { task: "plan", context: reserveInput.kind },
          prompt: plannerPrompt({
            kind: reserveInput.kind,
            attempt,
            catalog,
            previousIssues,
          }),
          jsonSchema: toProviderJsonSchema(planSchema(reserveInput.kind)),
          parse: (value) => parsePlan(reserveInput.kind, value),
          stage: "planning",
          onProgress: reserveInput.onProgress,
          planningAttempt: attempt,
        });
        if (!result.ok) {
          throw new Error(result.error);
        }
        // Invalid `distinguishesFrom` citations are stripped at ingest, against the Catalog the
        // planner was shown, before anything downstream sees the plan.
        const plan = stripInvalidDistinctions(result.value, catalog);
        const outcome = await validateAndMaybeCommit(plan, admissibleNow);
        if ("reservation" in outcome) return outcome.reservation;
        const { issues } = outcome;
        if (admissibleOnExhaustion(issues)) retained ??= plan;
        console.error(
          `[generationPlanner] ${reserveInput.kind} plan attempt ${attempt}/${MAX_DIVERSITY_ATTEMPTS} replanned:`,
          planIssueDetail(issues),
        );
        previousIssues = issues;
      }
      if (retained) {
        const outcome = await validateAndMaybeCommit(retained, admissibleOnExhaustion);
        if ("reservation" in outcome) return outcome.reservation;
        previousIssues = outcome.issues;
      }
      // Only a fatal plan issue can get here: every attempt contradicted its own declared domains or
      // named no place for Listen and Repeat.
      throw new Error(
        [
          `no plan could be admitted after ${MAX_DIVERSITY_ATTEMPTS} attempts`,
          planIssueDetail(previousIssues),
        ].join("\n"),
      );
    },

    release(reservationId): void {
      reservations.delete(reservationId);
    },
  };
}

export const productionGenerationPlanner = createGenerationPlanner({
  dataDir: config.dataDir,
  // Reads whatever the composition root installed (server/src/index.ts); the empty set until then,
  // which is exactly what the hermetic test suite wants — see services/supersession.ts.
  supersededSetIds,
});
