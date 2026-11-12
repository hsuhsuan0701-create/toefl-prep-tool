import type { SetAdvisoryNote } from "@toefl-prep/shared";

// =================================================================================================
// The DiversityIssue: what plan admission found about a Plan, and every projection of it that leaves
// the novelty subsystem — the advisory notes a Set carries, the scrubbed residual a job row shows,
// and the retry payload a replan is handed.
//
// The vocabulary is its own leaf module because the Catalog, the novelty checks, the planner and
// generationCheckPolicy.ts all name it; housed in generationNovelty.ts, it would close a cycle
// through the policy that module consults. This module imports one type from `shared` and nothing
// else.
//
// The privacy rule every projection below observes: `planLabel` is the Plan's own scenario/topic/
// title text, so it may reach a retry prompt (the model already has the Plan verbatim) and nothing
// else — not a log, not a job error, not a Set.
// =================================================================================================

export type NoveltyTaskType =
  | "listen_repeat"
  | "interview"
  | "build_sentence"
  | "email"
  | "discussion"
  | "complete_words"
  | "daily_life"
  | "academic_passage"
  | "listen_choose"
  | "conversation"
  | "announcement"
  | "academic_talk";

/**
 *  - `containment`    — two components of the same Task Type overlap: most of the smaller one's
 *                       concept tokens appear in the other (the one similarity measure).
 *  - `domain-balance` — Build a Sentence's ten situations bunch into too few domains, or too few
 *                       of them use the Catalog's least-used domains.
 *  - `domain-drift`   — a component's own wording classifies as a different domain than it declares.
 *  - `plan-drift`     — a structural requirement of the Plan is unmet: Listen and Repeat's setting
 *                       names no physical place.
 */
export type DiversityIssueKind =
  | "containment"
  | "domain-balance"
  | "domain-drift"
  | "plan-drift";

export interface DiversityIssue {
  taskType: NoveltyTaskType;
  kind: DiversityIssueKind;
  conflictingSetIds: string[];
  score?: number;
  /**
   * Reading and Listening only: which plan slot (its index in the Plan's own array for that Task
   * Type). Speaking and Writing issues never carry it.
   */
  itemPosition?: number;
  /** The slot's own plan text, for the retry prompt only — see this module's header. */
  planLabel?: string;
}

/** The twelve Task Types by section (Speaking, Writing, Reading, Listening); listings sort by it. */
export const TASK_ORDER: readonly NoveltyTaskType[] = [
  "listen_repeat",
  "interview",
  "build_sentence",
  "email",
  "discussion",
  "complete_words",
  "daily_life",
  "academic_passage",
  "listen_choose",
  "conversation",
  "announcement",
  "academic_talk",
];

function roundedScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** An overlap between two Sets: ids sorted, score rounded to three decimals. */
export function issue(
  taskType: NoveltyTaskType,
  kind: DiversityIssueKind,
  leftId: string,
  rightId: string,
  score?: number,
): DiversityIssue {
  return {
    taskType,
    kind,
    conflictingSetIds: [leftId, rightId].sort(),
    ...(score === undefined ? {} : { score: roundedScore(score) }),
  };
}

// Plain lexicographic comparison, not localeCompare: ordering feeds test expectations and prompt
// rendering, and must not vary with the host locale.
export function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function issueOrder(left: DiversityIssue, right: DiversityIssue): number {
  return (
    TASK_ORDER.indexOf(left.taskType) - TASK_ORDER.indexOf(right.taskType) ||
    compareStrings(left.kind, right.kind) ||
    compareStrings(
      left.conflictingSetIds.join("\0"),
      right.conflictingSetIds.join("\0"),
    ) ||
    (left.itemPosition ?? -1) - (right.itemPosition ?? -1)
  );
}

/** An issue with no score and no plan text: ids deduplicated and sorted, possibly none. */
export function safeIssue(
  taskType: NoveltyTaskType,
  kind: DiversityIssueKind,
  conflictingSetIds: readonly string[] = [],
): DiversityIssue {
  return {
    taskType,
    kind,
    conflictingSetIds: [...new Set(conflictingSetIds)].sort(),
  };
}

/** Issues deduplicated on every field and sorted by `issueOrder`. */
export function uniqueIssues(issues: readonly DiversityIssue[]): DiversityIssue[] {
  const result = new Map<string, DiversityIssue>();
  for (const value of issues) {
    const normalized: DiversityIssue = {
      ...value,
      conflictingSetIds: [...new Set(value.conflictingSetIds)].sort(),
    };
    // Distinct plan slots of the same Task Type and kind stay distinct issues, or a retry prompt
    // could only ever address "a" daily_life entry, never which one.
    const key = JSON.stringify([
      normalized.taskType,
      normalized.kind,
      normalized.conflictingSetIds,
      normalized.score ?? null,
      normalized.itemPosition ?? null,
      normalized.planLabel ?? null,
    ]);
    result.set(key, normalized);
  }
  return [...result.values()].sort(issueOrder);
}

/** One issue reduced to what may safely leave this process: ids, kinds, counts and positions. */
export interface ScrubbedDiversityIssue {
  taskType: NoveltyTaskType;
  kind: DiversityIssueKind;
  conflictingSetIds?: string[];
  itemPosition?: number;
  score?: number;
}

/**
 * The one privacy filter: what a log line, a thrown error, or the job row's `noveltyResidual` may
 * carry. Drops `planLabel`.
 */
export function scrubDiversityIssues(
  issues: readonly DiversityIssue[],
): ScrubbedDiversityIssue[] {
  return issues.map(({ taskType, kind, conflictingSetIds, itemPosition, score }) => ({
    taskType,
    kind,
    // Empty on a pure conformance issue, and an empty array on every row would read as a collision
    // that never happened.
    ...(conflictingSetIds.length > 0 ? { conflictingSetIds } : {}),
    ...(itemPosition !== undefined ? { itemPosition } : {}),
    ...(score !== undefined ? { score } : {}),
  }));
}

/**
 * The ids of a note's conflicting Sets, minus any that name a reservation rather than a published
 * Set. A collision with a concurrently reserved Plan carries the id `pending:<ownerId>`, whose colon
 * SafeIdSchema rejects: copied onto the note, it would make the Set fail to parse when it is
 * published. It names nothing a User could look at, so it is dropped.
 */
function publishableSetIds(ids: readonly string[] | undefined): string[] {
  return (ids ?? []).filter((id) => /^[A-Za-z0-9_-]{1,64}$/u.test(id));
}

/**
 * The advisory issues a Set is published with, in the durable form that rides on the Set itself.
 * Built on top of scrubDiversityIssues, so there is one privacy filter, not two.
 *
 * `containment` and `domain-balance` depend on the Catalog (`domain-balance` through
 * `preferredDomains`), so both are `catalog-novelty`; `domain-drift` and `plan-drift` are content
 * disagreeing with its Plan, so `plan-conformance`. The kind itself survives in `detail`.
 */
export function advisoryNotesFromIssues(
  issues: readonly DiversityIssue[],
): SetAdvisoryNote[] {
  return scrubDiversityIssues(issues).map((issue) => ({
    check: issue.kind === "containment" || issue.kind === "domain-balance"
      ? "catalog-novelty" as const
      : "plan-conformance" as const,
    detail: issue.kind,
    taskType: issue.taskType,
    ...(issue.itemPosition !== undefined ? { itemPosition: issue.itemPosition } : {}),
    ...(publishableSetIds(issue.conflictingSetIds).length > 0
      ? { conflictingSetIds: publishableSetIds(issue.conflictingSetIds) }
      : {}),
    ...(issue.score !== undefined ? { score: issue.score } : {}),
  }));
}

/** The planner's retry payload for Speaking and Writing: which Task Types and kinds, and which Sets. */
export function diversityRetrySummary(
  issues: readonly DiversityIssue[],
): {
  taskTypes: NoveltyTaskType[];
  collisionKinds: DiversityIssueKind[];
  conflictingSetIds: string[];
} {
  return {
    taskTypes: [...new Set(issues.map(({ taskType }) => taskType))].sort(),
    collisionKinds: [...new Set(issues.map(({ kind }) => kind))].sort(),
    conflictingSetIds: [
      ...new Set(issues.flatMap(({ conflictingSetIds }) => conflictingSetIds)),
    ].sort(),
  };
}

/** One addressable retry-prompt entry: which plan slot failed which check. */
export interface DiversityRetryEntry {
  taskType: NoveltyTaskType;
  kind: DiversityIssueKind;
  itemPosition?: number;
  planLabel?: string;
}

/**
 * The planner's retry payload for Reading and Listening: diversityRetrySummary plus `entries`, naming
 * exactly which plan slot failed which check, so a replan can fix that slot rather than re-audit every
 * entry of its Task Type. `planLabel` is safe here and nowhere else: the same prompt already embeds
 * the plan verbatim.
 */
export function diversityRetryDetail(
  issues: readonly DiversityIssue[],
): {
  taskTypes: NoveltyTaskType[];
  collisionKinds: DiversityIssueKind[];
  conflictingSetIds: string[];
  entries: DiversityRetryEntry[];
} {
  return {
    ...diversityRetrySummary(issues),
    entries: issues
      .filter(({ itemPosition }) => itemPosition !== undefined)
      .map(({ taskType, kind, itemPosition, planLabel }) => ({
        taskType,
        kind,
        ...(itemPosition !== undefined ? { itemPosition } : {}),
        ...(planLabel !== undefined ? { planLabel } : {}),
      })),
  };
}
