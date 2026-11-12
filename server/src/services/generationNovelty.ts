import {
  advisoryNotesFromIssues,
  safeIssue,
  uniqueIssues,
  type DiversityIssue,
  type NoveltyTaskType,
} from "./diversityIssues.js";
import {
  compareCatalogEntries,
  domainCounts,
  entriesFromPlan,
  entriesFromSet,
  type NoveltyCatalogEntry,
  type NoveltyPlan,
} from "./generationCatalog.js";
import { blocksGeneration, classifyGenerationCheck } from "./generationCheckPolicy.js";
import {
  classifierTerm,
  classifierTokens,
  domainCompatible,
  emptyDomainCount,
  preferredDomains,
} from "./generationDomains.js";
import { assertNever } from "../lib/assertNever.js";
import type {
  ListeningGenerationInput,
  ReadingGeneratedSet,
  SetAdvisoryNote,
  SpeakingGenerationInput,
  WritingGenerationPlan,
  WritingSet,
} from "@toefl-prep/shared";

// =================================================================================================
// The novelty checks: the two questions novelty is asked.
//
//   * `validateGenerationPlan`     — what admission finds about a Plan, given the Catalog: the fatal
//                                    structural checks, Build a Sentence's domain spread, and the one
//                                    similarity measure (containment against every prior component).
//   * `candidateDomainDriftNotes`  — which generated components contradict their planned domain. A
//                                    pure function of the Plan and the candidate; it never rejects.
//
// Similarity is measured at plan stage only. A generated Set's Catalog entries are derived from its
// stored Plan, so Plan against Catalog compares like with like, and nothing is re-measured at
// candidate stage.
//
// The metric (noveltySimilarity.ts), the taxonomy (generationDomains.ts), the Catalog
// (generationCatalog.ts) and the DiversityIssue (diversityIssues.ts) decide nothing on their own;
// this module applies them, and is what the planner and the candidate loop call. The tier of every
// issue is generationCheckPolicy.ts's to assign.
// =================================================================================================

/**
 * Physical-setting vocabulary for Listen and Repeat plans. Handed to the planner prompt verbatim
 * (generationPlanner.ts), exactly as DOMAIN_KEYWORDS is, because plan validation classifies the
 * plan's own `setting` against this table and a rule the model cannot see is a rule it cannot
 * satisfy.
 *
 * Coarse on purpose: it verifies that the setting names SOME concrete place noun rather than an
 * abstract concept. The setting is illustrated as one map-view scene image and the seven items move
 * through a space, which an abstract setting cannot support — so this is a fatal plan check under
 * docs/adr/0006 ("the Set would be unusable"). English place vocabulary is open-class, so no closed
 * list is complete; a plan that pads an already-concrete setting with a listed noun ("a campus
 * greenhouse facility") passes, and that hole is harmless in the one direction this check cares
 * about — padding can never make an abstract setting concrete.
 *
 * "train" is deliberately excluded: the setting is stemmed before matching, so "training" — the verb
 * nearly every Listen and Repeat scenario is built on — would match it and pass on incidental
 * vocabulary.
 */
export const PHYSICAL_SETTING_TERMS = [
  "studio",
  "laboratory",
  "lab",
  "library",
  "office",
  "center",
  "centre",
  "room",
  "facility",
  "shop",
  "gallery",
  "clinic",
  "station",
  "museum",
  "theater",
  "theatre",
  "booth",
  "kitchen",
  "classroom",
  "workshop",
  "greenhouse",
  "archive",
  "zoo",
  "bakery",
  "apartment",
  "pantry",
  "hotel",
  "garage",
  "home",
  "store",
  "desk",
  "hall",
  "warehouse",
  "bus",
];

const PHYSICAL_SETTING_CLASSIFIER_TERMS = PHYSICAL_SETTING_TERMS.map((term) =>
  classifierTerm(term)
);

/** The valid subset of one component's `distinguishesFrom`: only citations naming a setId already
 * present in `catalog` for the SAME Task Type as the citing component. */
function validDistinguishesFrom<T extends { readonly setId: string }>(
  taskType: NoveltyTaskType,
  distinguishesFrom: readonly T[],
  catalog: readonly NoveltyCatalogEntry[],
): T[] {
  if (distinguishesFrom.length === 0) return [];
  const sameTaskSetIds = new Set(
    catalog
      .filter((entry) => entry.taskType === taskType)
      .map(({ setId }) => setId),
  );
  return distinguishesFrom.filter(({ setId }) => sameTaskSetIds.has(setId));
}

/**
 * `distinguishesFrom` names up to three prior Sets one plan component is deliberately unlike. The
 * only thing that can be required of it is that each cited Set is in the bank for that Task Type —
 * and a section's first Sets have no same-Task-Type entry at all, so any citation is then invalid by
 * construction. An invalid citation is stripped at ingest, immediately after the plan is parsed and
 * before anything else sees it, rather than spent as a planner retry. Novelty never reads this field,
 * so stripping it costs nothing.
 *
 * Generic over `T extends NoveltyPlan` so a caller passing a concrete plan kind gets that same kind
 * back; each branch's `as T` is proven by its own `plan.kind` discriminant.
 */
export function stripInvalidDistinctions<T extends NoveltyPlan>(
  plan: T,
  catalog: readonly NoveltyCatalogEntry[],
): T {
  if (plan.kind === "speaking") {
    return {
      ...plan,
      listenAndRepeat: {
        ...plan.listenAndRepeat,
        distinguishesFrom: validDistinguishesFrom(
          "listen_repeat",
          plan.listenAndRepeat.distinguishesFrom,
          catalog,
        ),
      },
      interview: {
        ...plan.interview,
        distinguishesFrom: validDistinguishesFrom(
          "interview",
          plan.interview.distinguishesFrom,
          catalog,
        ),
      },
    } as T;
  }
  if (plan.kind === "reading") {
    return {
      ...plan,
      ctwPassages: plan.ctwPassages.map((entry) => ({
        ...entry,
        distinguishesFrom: validDistinguishesFrom("complete_words", entry.distinguishesFrom, catalog),
      })),
      dailyLifeTexts: plan.dailyLifeTexts.map((entry) => ({
        ...entry,
        distinguishesFrom: validDistinguishesFrom("daily_life", entry.distinguishesFrom, catalog),
      })),
      academicPassages: plan.academicPassages.map((entry) => ({
        ...entry,
        distinguishesFrom: validDistinguishesFrom("academic_passage", entry.distinguishesFrom, catalog),
      })),
    } as T;
  }
  if (plan.kind === "writing") {
    return {
      ...plan,
      buildASentence: {
        ...plan.buildASentence,
        situations: plan.buildASentence.situations.map((situation) => ({
          ...situation,
          distinguishesFrom: validDistinguishesFrom("build_sentence", situation.distinguishesFrom, catalog),
        })) as typeof plan.buildASentence.situations,
      },
      email: {
        ...plan.email,
        distinguishesFrom: validDistinguishesFrom("email", plan.email.distinguishesFrom, catalog),
      },
      academicDiscussion: {
        ...plan.academicDiscussion,
        distinguishesFrom: validDistinguishesFrom(
          "discussion",
          plan.academicDiscussion.distinguishesFrom,
          catalog,
        ),
      },
    } as T;
  }
  if (plan.kind === "listening") {
    return {
      ...plan,
      listenChoose: plan.listenChoose.map((entry) => ({
        ...entry,
        distinguishesFrom: validDistinguishesFrom("listen_choose", entry.distinguishesFrom, catalog),
      })),
      conversations: plan.conversations.map((entry) => ({
        ...entry,
        distinguishesFrom: validDistinguishesFrom("conversation", entry.distinguishesFrom, catalog),
      })),
      announcements: plan.announcements.map((entry) => ({
        ...entry,
        distinguishesFrom: validDistinguishesFrom("announcement", entry.distinguishesFrom, catalog),
      })),
      academicTalks: plan.academicTalks.map((entry) => ({
        ...entry,
        distinguishesFrom: validDistinguishesFrom("academic_talk", entry.distinguishesFrom, catalog),
      })),
    } as T;
  }
  return assertNever(plan);
}

/**
 * At least five distinct domain families, at most three uses of any one, and coverage of the Task
 * Type's currently preferred domains.
 *
 * The preferred-coverage floor is clamped to what the preferred set can hold. `preferredDomains`
 * returns the domains at or one above the current minimum, which can be a single domain; with at
 * most three situations per domain, a fixed floor of five would then be unsatisfiable, and every
 * replan would be spent on it.
 */
function validateBuildSentenceDomainBalance(
  plan: WritingGenerationPlan,
  catalog: readonly NoveltyCatalogEntry[],
): DiversityIssue[] {
  const situations = plan.buildASentence.situations;
  const countsByDomain = emptyDomainCount();
  for (const situation of situations) {
    countsByDomain[situation.domain] += 1;
  }
  const preferred = new Set(
    preferredDomains(domainCounts(catalog).build_sentence),
  );
  const preferredCount = situations
    .filter(({ domain }) => preferred.has(domain))
    .length;
  const valid =
    new Set(situations.map(({ domain }) => domain)).size >= 5 &&
    Math.max(...Object.values(countsByDomain)) <=
      BUILD_SENTENCE_MAX_PER_DOMAIN &&
    preferredCount >= requiredPreferredSituations(preferred.size);
  return valid
    ? []
    : [safeIssue("build_sentence", "domain-balance")];
}

const BUILD_SENTENCE_MAX_PER_DOMAIN = 3;

const BUILD_SENTENCE_PREFERRED_TARGET = 5;

/**
 * How many Build a Sentence situations must use a preferred domain: five, or as many as
 * `preferredCount` domains can hold at three each.
 */
export function requiredPreferredSituations(preferredCount: number): number {
  return Math.min(
    BUILD_SENTENCE_PREFERRED_TARGET,
    preferredCount * BUILD_SENTENCE_MAX_PER_DOMAIN,
  );
}

/**
 * Each planned component whose own wording contradicts the domain it declares. Validated against the
 * plan's raw prose, before a single generator call, and the planner is shown DOMAIN_KEYWORDS, so this
 * is a rule it can satisfy. A tie cannot drift: domainCompatible reports a contradiction only when
 * the declared domain has no keyword support at all and another domain has two or more.
 */
function plannedDomainDrift(plannedEntries: readonly NoveltyCatalogEntry[]): DiversityIssue[] {
  return plannedEntries
    .filter(({ domain, classifierText }) => !domainCompatible(domain, classifierText))
    .map((planned) => ({
      ...safeIssue(planned.taskType, "domain-drift"),
      ...planConformanceExtras(planned),
    }));
}

/**
 * Everything admission finds about a Plan. The tier of each issue is generationCheckPolicy's
 * (`plan-diversity`): drift and a missing physical setting are fatal, Build a Sentence's domain spread
 * is repaired by replanning, and containment is recorded.
 */
export function validateGenerationPlan(input: {
  plan: NoveltyPlan;
  catalog: readonly NoveltyCatalogEntry[];
}): DiversityIssue[] {
  const plannedEntries = entriesFromPlan(input.plan, {
    setId: "pending:plan-validation",
    source: "generated",
  });
  const issues: DiversityIssue[] = [...plannedDomainDrift(plannedEntries)];

  if (input.plan.kind === "speaking") {
    const settingTokens = classifierTokens(input.plan.listenAndRepeat.setting);
    if (!PHYSICAL_SETTING_CLASSIFIER_TERMS.some((term) => settingTokens.has(term))) {
      issues.push(safeIssue("listen_repeat", "plan-drift"));
    }
  } else if (input.plan.kind === "writing") {
    issues.push(...validateBuildSentenceDomainBalance(input.plan, input.catalog));
  }

  for (const planned of plannedEntries) {
    for (const prior of input.catalog) {
      issues.push(...compareCatalogEntries(planned, prior).map((value) => ({
        ...value,
        conflictingSetIds: value.conflictingSetIds.filter((setId) => setId !== planned.setId),
        ...planConformanceExtras(planned),
      })));
    }
  }
  return uniqueIssues(issues);
}

/** True when the Plan can be admitted as it stands: every issue is recorded, none needs a replan. */
export function admissibleNow(issues: readonly DiversityIssue[]): boolean {
  return issues.every((value) => planIssuePolicy(value).tier === "advisory");
}

/** True when the Plan may be admitted once the replans are spent: no issue is fatal, repaired or not. */
export function admissibleOnExhaustion(issues: readonly DiversityIssue[]): boolean {
  return !issues.some((value) =>
    blocksGeneration({ family: "plan-diversity", kind: value.kind, taskType: value.taskType })
  );
}

function planIssuePolicy(value: DiversityIssue) {
  return classifyGenerationCheck({ family: "plan-diversity", kind: value.kind, taskType: value.taskType });
}

// Reading's and Listening's plan entries are addressable by position, so their issues carry
// itemPosition/planLabel; Speaking's and Writing's never do.
const POSITIONAL_TASK_TYPES: ReadonlySet<NoveltyTaskType> = new Set([
  "complete_words",
  "daily_life",
  "academic_passage",
  "listen_choose",
  "conversation",
  "announcement",
  "academic_talk",
]);

function planConformanceExtras(
  planned: NoveltyCatalogEntry,
): Pick<DiversityIssue, "itemPosition" | "planLabel"> {
  if (!POSITIONAL_TASK_TYPES.has(planned.taskType)) return {};
  return {
    itemPosition: planned.itemPosition,
    ...(planned.planLabel ? { planLabel: planned.planLabel } : {}),
  };
}

/**
 * The generated components whose content contradicts their planned domain, as `plan-conformance`
 * notes for the Set. Matched by (Task Type, position); the classifier reads each component's raw
 * text (`classifierText`), never the normalized descriptor, which has lost "student" and been stemmed.
 *
 * Recorded, never rejected: a component that drifted from its planned domain is still answerable and
 * correctly keyed. Every Task Type's array is schema-pinned on both sides, so a planned slot always
 * has a generated counterpart.
 */
export function candidateDomainDriftNotes(
  plan: NoveltyPlan,
  candidate: SpeakingGenerationInput | WritingSet | ReadingGeneratedSet | ListeningGenerationInput,
): SetAdvisoryNote[] {
  const plannedEntries = entriesFromPlan(plan, { setId: "pending:candidate", source: "generated" });
  const candidateEntries = entriesFromSet(candidate);
  const drifted: DiversityIssue[] = [];
  for (const planned of plannedEntries) {
    const generated = candidateEntries.find((entry) =>
      entry.taskType === planned.taskType && entry.itemPosition === planned.itemPosition
    );
    if (generated && !domainCompatible(planned.domain, generated.classifierText)) {
      drifted.push({ ...safeIssue(planned.taskType, "domain-drift"), ...planConformanceExtras(planned) });
    }
  }
  return advisoryNotesFromIssues(uniqueIssues(drifted));
}
