import {
  isNotCapturedItemScoreJson,
  isSkippedItemScoreJson,
  type BandShortfallVM,
  type ModuleShortfallVM,
  type SectionEstimateVM,
} from "@toefl-prep/shared";
import {
  estimateBand,
  estimateBandTable3,
  maxScoreFor,
  missingTaskTypes,
  moduleTaskTypes,
  requiredTaskTypes,
  type BandEstimatorItem,
  type Section,
} from "./bandEstimator.js";

// Band Estimate recompute-and-read: the one home for the rules that decide whether an Attempt has a
// Band Estimate at all and, if so, which versioned method computed it (ADR 0010).
//
//   the whole-sitting rule        a band needs every Item row of the Attempt scored (a deliberate
//                                 skip is a scored 0 and counts) and every Task Type the section
//                                 requires present (for Reading and Listening, in each Module the
//                                 Attempt took): bandShortfall, over the Attempt's CURRENT Item
//                                 rows, on the write side AND on the read side, so a row persisted
//                                 under an older, looser rule never surfaces as a band;
//   the scored-Item filter        each scored Item on its own 0-N scale (Writing mixes 0-1 Build a
//                                 Sentence with 0-5 judged Task Types), disclosing whether it is a
//                                 deliberate skip;
//   the estimator dispatch        Speaking/Writing -> estimateBand (linear-v2);
//                                 Reading/Listening -> estimateBandTable3 (table3-v1);
//   the Simulation + Module Path  a Reading/Listening Attempt yields a Band Estimate ONLY as a
//   gate                          routed Simulation.
//
// Every writer calls in here, so none of them can compute a different band from the same state: the
// Attempt store's settleAttempt (POST /:id/complete, and speakingFinalization's reconcile of a
// Speaking Attempt, inside the transaction that also settles and completes it) and the writing
// branch of that reconcile. A persisted row keeps whatever method it was computed under, which is
// why the read half returns `method` as a plain string rather than the current union.

// ---------------------------------------------------------------------------------------------
// Persistence port
// ---------------------------------------------------------------------------------------------

// One persisted Item row (item_results), narrowed to the four fields the estimate actually reads.
export type EstimateItemRow = {
  task_type: string;
  score: number | null;
  scoring_status: string;
  score_json: string | null;
};

// One persisted Attempt row, narrowed the same way. `module_path` and `mode` are here for the gate
// and for the Modules whose Task Types a Reading/Listening band needs; `kind` is the Section.
export type EstimateAttempt = {
  kind: string;
  mode: string;
  module_path: "lower" | "upper" | null;
  items: EstimateItemRow[];
};

export type SectionEstimateWrite = {
  attemptId: string;
  section: string;
  rawDetail: string;
  estimatedBand: number;
  method: string;
};

/**
 * One persisted row read back, with the owning Attempt's Module Path and its CURRENT Item rows: the
 * read side decides whether the row is still a band from those, not from what was true when the row
 * was written. Without a Module Path the check asks for the Router Module's Task Types, which are
 * every Task Type of the section (see bandEstimator's requiredTaskTypes).
 */
export type PersistedSectionEstimate = {
  section: string;
  rawDetail: string;
  estimatedBand: number;
  method: string;
  modulePath?: "lower" | "upper" | null;
  items: readonly EstimateItemRow[];
};

// The persistence this module depends on, declared as exactly the members it uses. db/stores/
// estimates.ts (the `section_estimates` members) and db/stores/attempts.ts (`getAttempt`) satisfy
// it in production; tests use a plain object literal. Nothing here assumes SQLite.
//
// `saveSectionEstimate` is the one-current-row upsert (ON CONFLICT(attempt_id, section) DO UPDATE,
// backed by the section_estimates_attempt_section unique index), so two concurrent completions of
// one Attempt replace one row rather than appending a second. `clearSectionEstimate` removes that
// row: an Attempt that fails the band rule has no band, even if an earlier state of it had one.
// `getSectionEstimate` returns the row with the Attempt's current Item rows, which the read side
// checks the rule against.
export type EstimateStore = {
  getAttempt(id: string): EstimateAttempt | undefined;
  saveSectionEstimate(e: SectionEstimateWrite): void;
  clearSectionEstimate(attemptId: string): void;
  getSectionEstimate(attemptId: string): PersistedSectionEstimate | undefined;
};

/**
 * The READ half alone. The Attempt detail response and the Full-Test Run view model read an
 * estimate and have no business writing one, so they are handed this and not the whole store.
 */
export type EstimateReadStore = Pick<EstimateStore, "getSectionEstimate">;

// ---------------------------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------------------------

/**
 * Where one Attempt's Band Estimate stands:
 *   estimated       the band, in the shape every surface reads;
 *   incomplete      some Item is not scored, or a Task Type the section requires has no Item — no
 *                   band, and the shortfall in counts, so a surface can say why instead of showing a
 *                   number;
 *   not-applicable  a Reading/Listening Attempt that is not a routed Simulation. Drills never
 *                   produce a Reading/Listening band (CONTEXT.md, Simulation).
 */
export type SectionBandResult =
  | { status: "estimated"; estimate: SectionEstimateVM }
  | { status: "incomplete"; section: Section; shortfall: BandShortfallVM }
  | { status: "not-applicable" };

// A row's parsed score_json, or undefined when there is none or it is corrupt. Never throws.
function parsedScoreJson(row: { score_json: string | null }): unknown {
  if (row.score_json === null) return undefined;
  try {
    return JSON.parse(row.score_json);
  } catch {
    return undefined;
  }
}

// Does this item_results row hold the deliberate-skip marker? Reads score_json rather than
// "score === 0", because a judged 0 is a different fact and must not be disclosed as a skip.
function isSkippedItem(row: { score_json: string | null }): boolean {
  return isSkippedItemScoreJson(parsedScoreJson(row));
}

function isScoredItem(item: EstimateItemRow): boolean {
  return item.scoring_status === "scored" && item.score !== null;
}

type DeterministicModule = ModuleShortfallVM["module"];

// The Module a Reading or Listening Item row was scored in. Deterministic scoring tags every row's
// score_json with it (deterministicScoring.ts); a row without a readable tag belongs to no Module and
// so counts toward neither.
function itemModule(row: EstimateItemRow): DeterministicModule | undefined {
  const module = (parsedScoreJson(row) as { module?: unknown } | undefined)?.module;
  return module === "router" || module === "lower" || module === "upper" ? module : undefined;
}

/**
 * The Modules of a Reading or Listening Attempt that are short of Items: of the Router Module, and
 * of the second Module `modulePath` names, each must have an Item tagged with it for every Task Type
 * it carries (moduleTaskTypes). A Router Module alone carries every Task Type of the section, so
 * without this a routed Attempt finished before its second Module would read as a whole sitting.
 */
function moduleShortfalls(
  section: "reading" | "listening",
  modulePath: "lower" | "upper" | null,
  items: readonly EstimateItemRow[],
): ModuleShortfallVM[] {
  const taken = new Map<DeterministicModule, Set<string>>();
  for (const item of items) {
    const module = itemModule(item);
    if (!module) continue;
    const taskTypes = taken.get(module) ?? new Set<string>();
    taskTypes.add(item.task_type);
    taken.set(module, taskTypes);
  }
  const shortfalls: ModuleShortfallVM[] = [];
  for (const module of modulePath ? (["router", modulePath] as const) : (["router"] as const)) {
    const taskTypes = taken.get(module);
    const absent = moduleTaskTypes(section, module).filter((taskType) => !taskTypes?.has(taskType));
    if (absent.length > 0) shortfalls.push({ module, sat: taskTypes !== undefined, absent });
  }
  return shortfalls;
}

/**
 * THE band rule, stated once (docs/adr/0010): an Attempt can have a Band Estimate only when every one
 * of its Item rows is scored and every Task Type its section requires has at least one. For Reading
 * and Listening that holds per Module: the Router Module and the Module the Module Path names each
 * need an Item of every Task Type they carry. Returns what stands in the way, or null when nothing
 * does.
 *
 * Every Item that is not scored is counted against its Task Type as exactly one of:
 *   notCaptured  failed with the never-captured marker: the recording never reached the server;
 *   pending      'pending' or 'transcription_pending': nothing has scored it yet;
 *   failed       any other state, a scoring failure above all (and, defensively, a 'scored' row with
 *                no score, or a status this code does not know).
 * Task Types are listed in the section's own order; one outside it (never from real rows) follows,
 * alphabetically, so nothing unscored goes unreported.
 */
export function bandShortfall(section: Section, modulePath: "lower" | "upper" | null, items: readonly EstimateItemRow[]): BandShortfallVM | null {
  const required = requiredTaskTypes(section, modulePath);
  const routed = section === "reading" || section === "listening";
  const modules = routed ? moduleShortfalls(section, modulePath, items) : [];
  const present = new Set(items.map((item) => item.task_type));
  const absent = routed ? [] : required.filter((taskType) => !present.has(taskType));

  const counts = new Map<string, { failed: number; pending: number; notCaptured: number }>();
  for (const item of items) {
    if (isScoredItem(item)) continue;
    const entry = counts.get(item.task_type) ?? { failed: 0, pending: 0, notCaptured: 0 };
    if (item.scoring_status === "pending" || item.scoring_status === "transcription_pending") entry.pending += 1;
    else if (item.scoring_status === "failed" && isNotCapturedItemScoreJson(parsedScoreJson(item))) entry.notCaptured += 1;
    else entry.failed += 1;
    counts.set(item.task_type, entry);
  }
  const others = [...counts.keys()].filter((taskType) => !required.includes(taskType)).sort();
  const unscored = [...required, ...others]
    .filter((taskType) => counts.has(taskType))
    .map((taskType) => ({ taskType, ...counts.get(taskType)! }));

  if (absent.length === 0 && unscored.length === 0 && modules.length === 0) return null;
  return { unscored, absent, ...(modules.length > 0 ? { moduleShortfalls: modules } : {}) };
}

// Each scored Item on its own Task Type's scale.
function scoredEstimatorItems(items: readonly EstimateItemRow[]): BandEstimatorItem[] {
  return items
    .filter(isScoredItem)
    .map((item) => ({
      taskType: item.task_type,
      score: item.score as number,
      maxScore: maxScoreFor(item.task_type),
      skipped: isSkippedItem(item),
    }));
}

/**
 * The whole estimate decision for one Attempt, as a pure function of its row: gate, the band rule,
 * dispatch.
 *
 * The gate: a Reading/Listening band exists only for `mode === "simulation"` with `module_path`
 * already decided by POST /:id/route. A Drill never gets one (module_path is never set for a Drill —
 * Drills only expose the Router Module), and neither does a Simulation that ended before routing.
 */
export function computeSectionEstimate(attempt: EstimateAttempt): SectionBandResult {
  const section = attempt.kind as Section;
  const routed = section === "reading" || section === "listening";
  if (routed && (attempt.mode !== "simulation" || attempt.module_path == null)) return { status: "not-applicable" };

  const shortfall = bandShortfall(section, attempt.module_path, attempt.items);
  if (shortfall) return { status: "incomplete", section, shortfall };

  // A routed band counts the Items of the Modules the Attempt took and no others: a row tagged
  // with the Module it was not routed to, or with no Module, says nothing about this sitting.
  const counted = routed
    ? attempt.items.filter((item) => {
        const module = itemModule(item);
        return module === "router" || module === attempt.module_path;
      })
    : attempt.items;
  const items = scoredEstimatorItems(counted);
  const result = routed
    ? estimateBandTable3(section, items, { modulePath: attempt.module_path! })
    : estimateBand(section as "speaking" | "writing", items);
  // The estimators keep their own coverage rule; with no shortfall it has nothing left to refuse.
  if (result.status === "incomplete") return { status: "incomplete", section, shortfall: { unscored: [], absent: result.missingTaskTypes } };
  return { status: "estimated", estimate: { section, ...result.estimate } };
}

/**
 * Recomputes the one current Band Estimate for an Attempt from whatever is scored RIGHT NOW and
 * upserts it, returning what it wrote — or, when the Attempt has no band, removes any row an earlier
 * state of it left and returns null.
 *
 * Reads the Attempt fresh rather than taking a caller's snapshot, so a caller that has just healed
 * or completed an Item cannot persist a band computed from the pre-write state.
 *
 * Clearing is what keeps the band rule true over time, not just at the first write: once any Item
 * stops being scored (a new Response or re-recording resets its row), the band computed before no
 * longer describes this Attempt. Scoring that Item later writes a band back through the upsert.
 */
export function recomputeSectionEstimate(store: EstimateStore, attemptId: string): SectionEstimateVM | null {
  const attempt = store.getAttempt(attemptId);
  if (!attempt) return null;
  const result = computeSectionEstimate(attempt);
  if (result.status !== "estimated") {
    store.clearSectionEstimate(attemptId);
    return null;
  }
  const { estimate } = result;
  store.saveSectionEstimate({
    attemptId,
    section: estimate.section,
    rawDetail: JSON.stringify({ raw: estimate.raw, coverage: estimate.coverage }),
    estimatedBand: estimate.band,
    method: estimate.method,
  });
  return estimate;
}

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

const SECTIONS: ReadonlySet<string> = new Set<Section>(["speaking", "writing", "reading", "listening"]);

/**
 * A persisted row as a band, or null when it is not one: an unknown section, unreadable raw_detail,
 * stored coverage short of a Task Type the section needs, or an Attempt whose CURRENT Items fail the
 * band rule (bandShortfall). The last two are how rows written under an earlier, looser rule stop
 * surfacing without being rewritten (ADR 0010). The Attempt review, the Attempt list, the Full-Test
 * Run, the Dashboard headline and its recent-Simulations range all read rows through here.
 */
export function persistedRowToEstimate(row: PersistedSectionEstimate): SectionEstimateVM | null {
  if (!SECTIONS.has(row.section)) return null;
  const section = row.section as Section;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.rawDetail);
  } catch {
    return null;
  }
  const { raw, coverage } = (parsed ?? {}) as { raw?: unknown; coverage?: unknown };
  if (typeof raw !== "number" || !Array.isArray(coverage)) return null;
  const entries = coverage as SectionEstimateVM["coverage"];
  const modulePath = row.modulePath ?? null;
  if (missingTaskTypes(section, entries, modulePath).length > 0) return null;
  if (bandShortfall(section, modulePath, row.items)) return null;
  return { section, band: row.estimatedBand, raw, method: row.method, coverage: entries };
}

/**
 * The one current Band Estimate persisted for an Attempt, in AttemptDetailVM's shape — or null when
 * there is none, or when the row there is not a band (see persistedRowToEstimate). Shared by GET
 * /:id, the finalization responses and the Full-Test Run, which must report the estimate actually
 * persisted and never recompute a second one. `method` passes through verbatim, so a row persisted
 * under an older method still reads as the method it was computed under.
 */
export function readPersistedEstimate(store: EstimateReadStore, attemptId: string): SectionEstimateVM | null {
  const row = store.getSectionEstimate(attemptId);
  return row ? persistedRowToEstimate(row) : null;
}
