import type {
  AnySet,
  AttemptKind,
  AttemptListItemVM,
  AttemptMode,
  AttemptStatus,
  AttemptVM,
  ScoringJobStatus,
  ScoringJobVM,
} from "@toefl-prep/shared";
import type { AttemptRow, ScoringJobRow } from "../db/rows.js";
import { sqliteTimestampToIso } from "../db/timestamps.js";
import { readPersistedEstimate, type EstimateReadStore } from "../services/sectionEstimates.js";
import { setStore, type SetStore } from "../services/setStore.js";
import { setTitleFor } from "../services/setTitle.js";

// The read side of the Attempts route: how an `attempts` row and a `scoring_jobs` row become the
// view models the client renders. Every Attempt timestamp leaves through `sqliteTimestampToIso` here.

export function toAttemptVM(row: AttemptRow, setTitle: string | null): AttemptVM {
  return {
    id: row.id,
    kind: row.kind as AttemptKind,
    mode: row.mode as AttemptMode,
    setId: row.set_id,
    setTitle,
    isRepeat: row.is_repeat === 1,
    status: row.status as AttemptStatus,
    startedAt: sqliteTimestampToIso(row.started_at),
    completedAt: sqliteTimestampToIso(row.completed_at),
    captureFinishedAt: sqliteTimestampToIso(row.capture_finished_at),
    flagged: row.flagged === 1,
    modulePath: row.module_path,
    routerRaw: row.router_raw,
  };
}

/**
 * One row of the Attempt log. The band goes through readPersistedEstimate, the reader the Attempt
 * review and the Full-Test Run use, so a stored row that is not a band (short coverage, unreadable
 * detail) is null here exactly as it is there. One indexed lookup per row; a page is at most
 * ATTEMPT_PAGE_MAX (100) rows.
 */
export function toAttemptListItemVM(row: AttemptRow, setTitle: string | null, estimates: EstimateReadStore): AttemptListItemVM {
  const estimate = readPersistedEstimate(estimates, row.id);
  return {
    ...toAttemptVM(row, setTitle),
    estimate: estimate ? { band: estimate.band, method: estimate.method } : null,
  };
}

export function toScoringJobVM(job: ScoringJobRow): ScoringJobVM {
  return {
    jobId: job.id,
    taskType: job.task_type,
    itemIds: parseItemIds(job.item_ids),
    stage: job.stage,
    status: job.status as ScoringJobStatus,
  };
}

/** `scoring_jobs.item_ids` is a JSON array this server wrote; anything else reads as no Items. */
function parseItemIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The Set an Attempt was taken against, for display only. A Set that is gone or fails to parse
 * yields undefined, and every caller has a fallback for that: the review and the log must render
 * from the Attempt alone.
 */
export function readSetForDisplay(setId: string): AnySet | undefined {
  try {
    return setStore.readSet(setId);
  } catch {
    return undefined;
  }
}

export function setTitleOrNull(set: AnySet | undefined): string | null {
  if (!set) return null;
  try {
    return setTitleFor(set).title;
  } catch {
    return null;
  }
}

/**
 * One title lookup per distinct Set on a page of the log, through the store's title cache: the log
 * needs nothing else of a Set, and parsing a whole Reading or Listening Set file for its title on
 * every load of the Practice and Progress pages is the cost the cache removes. A Set that is gone or
 * fails to parse is titled null.
 */
export function setTitlesById(setIds: string[], store: Pick<SetStore, "readSetTitle"> = setStore): Map<string, string | null> {
  return new Map([...new Set(setIds)].map((id) => [id, store.readSetTitle(id)?.title ?? null]));
}

/**
 * A `limit`/`offset` query value: an integer of at least `min`, capped at `max`; anything else
 * (absent, non-integer, below `min`) is the default. Malformed input falls back rather than 400ing,
 * and is never bound into SQL as NaN. A fallback of `undefined` leaves the default to the store.
 */
export function pageParam<F extends number | undefined>(raw: string | undefined, fallback: F, min: number, max: number): number | F {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) return fallback;
  return Math.min(value, max);
}
