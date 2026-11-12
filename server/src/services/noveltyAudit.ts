import {
  compareStrings,
  TASK_ORDER,
  type DiversityIssue,
} from "./diversityIssues.js";
import {
  buildNoveltyCatalog,
  findCatalogCollisions,
  type NoveltyCatalogEntry,
} from "./generationCatalog.js";
import { createSetStore } from "./setStore.js";

export interface NoveltyAuditResult {
  collisions: DiversityIssue[];
  lines: string[];
  exitCode: 0 | 1;
}

interface FormattedCollision {
  issue: DiversityIssue;
  domains: readonly [string, string];
}

function collisionOrder(
  left: FormattedCollision,
  right: FormattedCollision,
): number {
  return (
    TASK_ORDER.indexOf(left.issue.taskType) -
      TASK_ORDER.indexOf(right.issue.taskType) ||
    compareStrings(left.issue.kind, right.issue.kind) ||
    compareStrings(
      left.issue.conflictingSetIds.join(" "),
      right.issue.conflictingSetIds.join(" "),
    ) ||
    compareStrings(left.domains.join(" "), right.domains.join(" ")) ||
    (left.issue.score ?? -1) - (right.issue.score ?? -1)
  );
}

function formatCollision(collision: FormattedCollision): string {
  const { issue, domains } = collision;
  return [
    issue.taskType,
    issue.conflictingSetIds.join(" ↔ "),
    issue.kind,
    ...(issue.score === undefined
      ? []
      : [`score=${issue.score.toFixed(3)}`]),
    `domains=${domains.join(",")}`,
  ].join(" | ");
}

/**
 * Every overlap in the bank, by the comparator Plan admission uses (`compareCatalogEntries`, through
 * findCatalogCollisions), so the audit and generation cannot disagree about what counts as one.
 * Pairs within one Set are included.
 */
function compareBank(
  entries: readonly NoveltyCatalogEntry[],
): FormattedCollision[] {
  const domainsBySetItem = new Map<string, string>();
  for (const entry of entries) {
    domainsBySetItem.set(`${entry.taskType}:${entry.setId}`, entry.domain);
  }
  return findCatalogCollisions(entries, { withinSet: true })
    .map((issue) => ({
      issue,
      domains: [
        domainsBySetItem.get(
          `${issue.taskType}:${issue.conflictingSetIds[0]}`,
        ) ?? "unknown",
        domainsBySetItem.get(
          `${issue.taskType}:${issue.conflictingSetIds.at(-1)}`,
        ) ?? "unknown",
      ] as const,
    }))
    .sort(collisionOrder);
}

/**
 * Audits the saved bank with the production Catalog and comparator: one line per overlap, then a
 * count per kind and a total. Makes no model call and writes nothing; the output names only ids,
 * kinds, domains and scores. Exits 1 on any overlap unless `allowExisting`.
 */
export function runNoveltyAudit(input: {
  dataDir: string;
  allowExisting: boolean;
  warn?: (message: string) => void;
}): NoveltyAuditResult {
  const catalog = buildNoveltyCatalog({
    // The audit's only route to a Set: `SetStore` has no member that can reach a paid provider.
    store: createSetStore(input.dataDir),
    ...(input.warn ? { warn: input.warn } : {}),
  });
  const formatted = compareBank(catalog);
  const counts = new Map<string, number>();
  for (const { issue } of formatted) {
    counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
  }
  const lines = [
    ...formatted.map(formatCollision),
    ...[...counts.entries()]
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([kind, count]) => `${kind} collisions: ${count}`),
    `total collisions: ${formatted.length}`,
  ];
  return {
    collisions: formatted.map(({ issue }) => issue),
    lines,
    exitCode:
      formatted.length > 0 && !input.allowExisting ? 1 : 0,
  };
}
