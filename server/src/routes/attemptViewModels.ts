import type {
  AnySet,
  AttemptKind,
  AttemptListItemVM,
  AttemptMode,
  AttemptStatus,
  AttemptVM,
  FullTestRunStatus,
  MarksWithheldReason,
  ScoringJobStatus,
  ScoringJobVM,
} from "@toefl-prep/shared";
import type { AttemptRow, ScoringJobRow } from "../db/rows.js";
import type { FullTestRunStore } from "./fullTests.js";
import type { AttemptReadStore } from "../services/attemptStore.js";
import { sqliteTimestampToIso } from "../db/timestamps.js";
import { readPersistedEstimate, type EstimateReadStore } from "../services/sectionEstimates.js";
import { requiredTaskTypes } from "../services/bandEstimator.js";
import { currentTranscriptionStatuses, liveScoringOutstanding } from "../services/liveScoring.js";
import { setStore, type SetStore } from "../services/setStore.js";
import { setTitleFor } from "../services/setTitle.js";

// The read side of the Attempts route: how an `attempts` row and a `scoring_jobs` row become the
// view models the client renders. Every Attempt timestamp leaves through `sqliteTimestampToIso` here.

/**
 * Why an Attempt's marks are withheld, given the ids `listMarksWithheldAttemptIds` returned for it
 * (MARKS_WITHHELD_SQL decides), or undefined when they are sent. In progress, the Attempt is waiting
 * on itself; otherwise it is a restarted section's replaced Attempt, waiting on its Run.
 */
export function marksWithheldReason(row: AttemptRow, withheldIds: ReadonlySet<string>): MarksWithheldReason | undefined {
  if (!withheldIds.has(row.id)) return undefined;
  return row.status === "in_progress" ? "attempt-in-progress" : "full-test-run-in-progress";
}

/**
 * `marksWithheld`: the Router raw score is the share of the Router Module answered right, so it
 * waits with the Attempt's marks. The Module Path does not: the run sits the Module it names.
 */
export function toAttemptVM(row: AttemptRow, setTitle: string | null, marksWithheld = false): AttemptVM {
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
    routerRaw: marksWithheld ? null : row.router_raw,
  };
}

/**
 * One row of the Attempt log. The band goes through readPersistedEstimate, the reader the Attempt
 * review and the Full-Test Run use, so a stored row that is not a band (short coverage, unreadable
 * detail) is null here exactly as it is there. The page is at most ATTEMPT_PAGE_MAX (100) rows, and
 * reads only what it shows: one indexed estimate lookup per row, one read for the whole page of the
 * Full-Test Runs its Attempts are sections of, and the band state's few small reads only for a
 * completed, non-Repeat row with no band.
 */
export function toAttemptListItemVMs(
  rows: readonly AttemptRow[],
  setTitles: ReadonlyMap<string, string | null>,
  repo: EstimateReadStore & MissingBandStore & Pick<FullTestRunStore, "listFullTestRunsForAttempts"> & Pick<AttemptReadStore, "listMarksWithheldAttemptIds">,
): AttemptListItemVM[] {
  const ids = rows.map((row) => row.id);
  const runs = rows.length > 0 ? repo.listFullTestRunsForAttempts(ids) : new Map<string, { id: string; status: string }>();
  const marksWithheld = rows.length > 0 ? repo.listMarksWithheldAttemptIds(ids) : new Set<string>();
  return rows.map((row) => {
    const estimate = readPersistedEstimate(repo, row.id);
    const run = runs.get(row.id);
    return {
      ...toAttemptVM(row, setTitles.get(row.set_id) ?? null, marksWithheld.has(row.id)),
      estimate: estimate ? { band: estimate.band, method: estimate.method } : null,
      // Worked out only where the log shows it: a completed, non-Repeat Attempt with no band.
      missingBand: row.status === "completed" && !estimate && row.is_repeat !== 1 ? missingBand(row, repo) : null,
      fullTestRun: run ? { id: run.id, status: run.status as FullTestRunStatus } : null,
    };
  });
}

type MissingBandStore = {
  listItemScoringStates(attemptId: string): readonly { item_id: string; task_type: string; scoring_status: string }[];
  listActiveJobs(attemptId: string): readonly ScoringJobRow[];
  getCurrentTranscriptionJobs(attemptId: string): readonly { item_id: string; status: string }[];
};

/**
 * AttemptListItemVM.missingBand for a completed Attempt with no band. A Simulation is always meant to
 * give one, whatever became of it. A Drill is when it is Speaking or Writing and took every Task
 * Type its section needs; a Drill of one Task Type gives no band by the User's own choice. Whether
 * the band is still on its way is liveScoringOutstanding's call, the one the Attempt review
 * (attemptBandStatus) and a Full-Test Run's section make, so the log never says "No band" over a
 * sitting the review says is still scoring.
 */
function missingBand(row: AttemptRow, repo: MissingBandStore): "scoring" | "incomplete" | null {
  if (row.mode !== "simulation" && row.kind !== "speaking" && row.kind !== "writing") return null;
  const items = repo.listItemScoringStates(row.id);
  if (row.mode !== "simulation") {
    const present = new Set(items.map((item) => item.task_type));
    if (!requiredTaskTypes(row.kind as "speaking" | "writing", null).every((taskType) => present.has(taskType))) return null;
  }
  const outstanding = liveScoringOutstanding({
    attempt: { status: row.status, capture_finished_at: row.capture_finished_at, items },
    activeJobs: repo.listActiveJobs(row.id).map((job) => ({ itemIds: parseItemIds(job.item_ids) })),
    transcriptionStatuses: currentTranscriptionStatuses(repo, row.id),
  });
  return outstanding ? "scoring" : "incomplete";
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
