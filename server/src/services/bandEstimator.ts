// Pure section band estimator. No I/O, no DB access — callers gather scored item_results and pass
// them in; this module only does the math, versioned via `method` so a scoring revision never
// silently reinterprets a persisted estimate. Two methods live here: `estimateBand` (linear-v2,
// Speaking/Writing — weighted average mapped linearly onto the 1-6 band scale) and
// `estimateBandTable3` (table3-v1, Reading/Listening — percent-correct looked up in the official,
// non-linear Table 3 concordance). Rows persisted under an older method (linear-v1) keep their
// method string and stay readable; this module only ever produces the current methods.
//
// Two rules hold for both methods:
//
//   Coverage. Neither estimator returns a band unless every Task Type the section needs has at
//   least one scored Item; short of that, the result names the missing Task Types and carries no
//   number at all. A missing Task Type's weight is never spread over the ones that are present. The
//   stricter rule an Attempt's band is held to — every Item scored — is sectionEstimates.ts's
//   bandShortfall, applied before these are called; this one is what a stored coverage list is
//   checked against on the read side.
//
//   Exact rounding. Item scores sit on a half-point grid (a Score Report's finalScore is a multiple
//   of 0.5; deterministic Items are 0 or 1), so every band is computed as a fraction of integers and
//   rounded half up with integer division. Floating point turns an exact tie such as 3.75 into
//   3.7499… and rounds it the wrong way.
import {
  isDeterministicTaskType,
  LISTENING_MODULE_COMPOSITION,
  ListeningTaskType,
  READING_MODULE_COMPOSITION,
  ReadingTaskType,
} from "@toefl-prep/shared";

export type Section = "speaking" | "writing" | "reading" | "listening";
type ModulePath = "lower" | "upper";

export interface BandEstimatorItem {
  taskType: string;
  score: number;
  maxScore: number;
  // A deliberate skip scored 0 (nothing was recorded). It counts toward the mean exactly like any
  // other 0, and covers its Task Type, because an unanswered Item scores 0 on the exam too. It is
  // tallied separately only so coverage can say out loud that a 0 was a skip. Set from score_json's
  // skip marker, which only the Speaking Simulation finalizer writes.
  skipped?: boolean;
}

export interface CoverageEntry {
  taskType: string;
  itemCount: number;
  // How many of `itemCount` are deliberate skips scored 0. Always present on a freshly computed
  // estimate; rows persisted before it existed lack it, so the view model types it as optional.
  skippedCount: number;
}

export interface BandEstimate {
  band: number;
  raw: number;
  method: "linear-v2" | "table3-v1";
  coverage: CoverageEntry[];
}

/**
 * What an estimator returns: a band, or the Task Types that stand between the section and one.
 * `coverage` on the incomplete branch is what WAS scored, so a surface can say both halves.
 */
export type BandEstimateResult =
  | { status: "estimated"; estimate: BandEstimate }
  | { status: "incomplete"; method: BandEstimate["method"]; missingTaskTypes: string[]; coverage: CoverageEntry[] };

/**
 * Speaking/Writing Task Type weights: each Task Type's share of the section's raw points (Technical
 * Manual RR-25-12, Table 2), as integer numerators over one denominator so the band can be computed
 * exactly.
 *   Speaking raw 0-55 = 7 Listen and Repeat x 5 + 4 Interview x 5 -> 35/55 = 7/11, 20/55 = 4/11.
 *   Writing raw 0-20 = 10 Build a Sentence x 1 + Email 5 + Discussion 5 -> 2/4, 1/4, 1/4.
 * Key order is the canonical Task Type order coverage is reported in.
 */
export const SECTION_WEIGHTS = {
  speaking: { denominator: 11, shares: { listen_repeat: 7, interview: 4 } },
  writing: { denominator: 4, shares: { build_sentence: 2, email: 1, discussion: 1 } },
} as const satisfies Record<"speaking" | "writing", { denominator: number; shares: Record<string, number> }>;

/**
 * The 0-N scale an item's raw score sits on, by Task Type. Deterministic Task Types — Build a
 * Sentence plus the seven Reading/Listening slugs — are right-or-wrong, so 0-1; every judged Task
 * Type is 0-5. item_results stores only the raw score, never its scale, so it has to be derived, and
 * it is derived here once so two surfaces cannot report different bands from identical data.
 */
export function maxScoreFor(taskType: string): number {
  return isDeterministicTaskType(taskType) ? 1 : 5;
}

// Which Task Type each Module-composition shape is. Typed against the composition tables, so a shape
// added there without a Task Type here fails the build.
const READING_SHAPE_TASK_TYPE = {
  ctw: "complete_words",
  dailyLife: "daily_life",
  academic: "academic_passage",
} as const satisfies Record<keyof (typeof READING_MODULE_COMPOSITION)["router"], string>;

const LISTENING_SHAPE_TASK_TYPE = {
  listenChoose: "listen_choose",
  conversations: "conversation",
  announcements: "announcement",
  academicTalks: "academic_talk",
} as const satisfies Record<keyof (typeof LISTENING_MODULE_COMPOSITION)["router"], string>;

// Canonical per-section Task Type order for Reading/Listening coverage and missing lists.
const TASK_TYPE_ORDER: Record<"reading" | "listening", readonly string[]> = {
  reading: ReadingTaskType.options,
  listening: ListeningTaskType.options,
};

/**
 * The Task Types one Module of a Reading or Listening Set carries, in canonical order, read off the
 * Module composition (READING_MODULE_COMPOSITION / LISTENING_MODULE_COMPOSITION). The band rule
 * (sectionEstimates.ts's bandShortfall) asks each Module an Attempt took for an Item of every one.
 * Banked Sets may carry more than the composition asks (an older Upper Module still holds a Daily
 * Life text); an extra Task Type is scored like any other and never required.
 */
export function moduleTaskTypes(section: "reading" | "listening", module: "router" | ModulePath): string[] {
  const composition = section === "reading" ? READING_MODULE_COMPOSITION : LISTENING_MODULE_COMPOSITION;
  const shapeTaskType: Record<string, string> = section === "reading" ? READING_SHAPE_TASK_TYPE : LISTENING_SHAPE_TASK_TYPE;
  const counts: Record<string, number> =
    module === "router" ? composition.router : module === "lower" ? composition.lowerModule : composition.upperModule;
  const carried = new Set(Object.entries(counts).filter(([, count]) => count > 0).map(([shape]) => shapeTaskType[shape]));
  return TASK_TYPE_ORDER[section].filter((taskType) => carried.has(taskType));
}

/**
 * The Task Types a section's band needs at least one scored Item of, in canonical order: what a
 * stored coverage list is checked against (missingTaskTypes).
 *
 * Speaking/Writing: every weighted Task Type. Reading/Listening: every Task Type the Modules taken
 * carry — the Router Module, which every routed Attempt sits, plus the second Module its
 * `modulePath` names. With no path only the Router counts; the Router already carries every Task
 * Type of both sections, which bandEstimator.test.ts pins, so the two ask for the same thing. The
 * band rule over an Attempt's Item rows is stricter, per Module (bandShortfall).
 */
export function requiredTaskTypes(section: Section, modulePath: ModulePath | null): string[] {
  if (section === "speaking" || section === "writing") return Object.keys(SECTION_WEIGHTS[section].shares);

  const present = new Set<string>(moduleTaskTypes(section, "router"));
  if (modulePath) for (const taskType of moduleTaskTypes(section, modulePath)) present.add(taskType);
  return TASK_TYPE_ORDER[section].filter((taskType) => present.has(taskType));
}

/**
 * Which required Task Types a coverage list has no scored Item of. Empty means the coverage spans the
 * section. The estimators check what they were given against it, and the read side checks a
 * persisted row's stored coverage against it (sectionEstimates.ts's persistedRowToEstimate).
 */
export function missingTaskTypes(
  section: Section,
  coverage: readonly { taskType: string; itemCount: number }[],
  modulePath: ModulePath | null,
): string[] {
  const covered = new Set(coverage.filter((entry) => entry.itemCount > 0).map((entry) => entry.taskType));
  return requiredTaskTypes(section, modulePath).filter((taskType) => !covered.has(taskType));
}

// ---------------------------------------------------------------------------------------------
// Exact arithmetic
// ---------------------------------------------------------------------------------------------

// A non-negative-denominator fraction of integers. Magnitudes stay far below 2^53: denominators are
// products of item counts and small scale factors, reduced by gcd at every step.
type Fraction = { n: number; d: number };

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b !== 0) [a, b] = [b, a % b];
  return a || 1;
}

function fraction(n: number, d: number): Fraction {
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

function add(a: Fraction, b: Fraction): Fraction {
  return fraction(a.n * b.d + b.n * a.d, a.d * b.d);
}

function scale(a: Fraction, n: number, d: number): Fraction {
  return fraction(a.n * n, a.d * d);
}

// One item's normalized score, score / maxScore, as an exact fraction: the score is read in
// half-points so a 3.5 is 7/2 rather than a float.
function normalized(item: BandEstimatorItem): Fraction {
  return fraction(Math.round(item.score * 2), Math.round(item.maxScore * 2));
}

// floor(a / b) for integers with b > 0.
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Round-half-up of n/d to the nearest half: floor(2x + 1/2) / 2, in integers. */
function roundToHalfExact(x: Fraction): number {
  return floorDiv(4 * x.n + x.d, 2 * x.d) / 2;
}

/**
 * ETS's mean-then-round for an overall band (Technical Manual RR-25-12, §III-3: the average of the
 * section bands, rounded to the nearest half band). An exact quarter rounds up, so a mean of 5.125
 * reports as 5 and 5.25 as 5.5. Exact for any count of bands, because the bands themselves are read
 * in half-points.
 */
export function meanBand(bands: readonly number[]): number {
  const halfPoints = bands.reduce((sum, band) => sum + Math.round(band * 2), 0);
  return roundToHalfExact(fraction(halfPoints, 2 * bands.length));
}

function bucketByTaskType(items: readonly BandEstimatorItem[], keep: (item: BandEstimatorItem) => boolean) {
  const byTaskType = new Map<string, { scores: BandEstimatorItem[]; skipped: number }>();
  for (const item of items) {
    if (!keep(item)) continue;
    const bucket = byTaskType.get(item.taskType) ?? { scores: [], skipped: 0 };
    bucket.scores.push(item);
    if (item.skipped) bucket.skipped += 1;
    byTaskType.set(item.taskType, bucket);
  }
  return byTaskType;
}

function coverageIn(order: readonly string[], byTaskType: ReturnType<typeof bucketByTaskType>): CoverageEntry[] {
  return order
    .filter((taskType) => byTaskType.has(taskType))
    .map((taskType) => ({ taskType, itemCount: byTaskType.get(taskType)!.scores.length, skippedCount: byTaskType.get(taskType)!.skipped }));
}

// ---------------------------------------------------------------------------------------------
// linear-v2
// ---------------------------------------------------------------------------------------------

/**
 * `linear-v2` for Speaking and Writing: `raw` is the SECTION_WEIGHTS-weighted sum of each Task
 * Type's mean normalized score (0-1), and the band is 1 + 5 x raw rounded half up to the half band.
 * Incomplete, with no number, when any weighted Task Type has no scored Item.
 */
export function estimateBand(section: "speaking" | "writing", items: readonly BandEstimatorItem[]): BandEstimateResult {
  const { denominator, shares } = SECTION_WEIGHTS[section];
  const weighted: Record<string, number> = shares;
  const order = Object.keys(weighted);

  // Items of a Task Type outside this section's weight table are ignored, as are items with a
  // non-positive scale (they would divide by zero).
  const byTaskType = bucketByTaskType(items, (item) => item.taskType in weighted && item.maxScore > 0);
  const coverage = coverageIn(order, byTaskType);

  const missing = missingTaskTypes(section, coverage, null);
  if (missing.length > 0) return { status: "incomplete", method: "linear-v2", missingTaskTypes: missing, coverage };

  // raw = sum over Task Types of (share / denominator) * mean normalized score.
  let raw: Fraction = { n: 0, d: 1 };
  for (const taskType of order) {
    const { scores } = byTaskType.get(taskType)!;
    const sum = scores.map(normalized).reduce(add, { n: 0, d: 1 });
    raw = add(raw, scale(sum, weighted[taskType], denominator * scores.length));
  }

  // band = 1 + 5 * raw, rounded half up to the half-band grid, then clamped.
  const band = clamp(roundToHalfExact(add({ n: 1, d: 1 }, scale(raw, 5, 1))), 1, 6);
  return { status: "estimated", estimate: { band, raw: raw.n / raw.d, method: "linear-v2", coverage } };
}

// ---------------------------------------------------------------------------------------------
// table3-v1
// ---------------------------------------------------------------------------------------------

/**
 * [ours] Not ETS policy: the Lower Module's task mix tops out around B2 evidence, so a Lower-path
 * Attempt's Table 3 lookup is capped here however well it scored. ETS states no such cap
 * (docs/adr/0005-two-stage-adaptive-sets.md, "Band estimation: table3-v1").
 */
export const LOWER_PATH_BAND_CAP = 4.5;

// ETS's band <-> legacy 0-30 scaled-score concordance (Table 3 of the score-report overview,
// reproduced in ADR 0005). Rows are { minScaled, band }, descending: the lookup takes the first row
// whose minScaled a scaled score clears, so the bottom row's minScaled: 0 is the floor. Each
// minScaled is Table 3's published lower bound (Reading 4.0 = "18-21" -> 18).
const TABLE3: Record<"reading" | "listening", ReadonlyArray<{ minScaled: number; band: number }>> = {
  reading: [
    { minScaled: 29, band: 6 },
    { minScaled: 27, band: 5.5 },
    { minScaled: 24, band: 5 },
    { minScaled: 22, band: 4.5 },
    { minScaled: 18, band: 4 },
    { minScaled: 12, band: 3.5 },
    { minScaled: 6, band: 3 },
    { minScaled: 4, band: 2.5 },
    { minScaled: 3, band: 2 },
    { minScaled: 2, band: 1.5 },
    { minScaled: 0, band: 1 },
  ],
  listening: [
    { minScaled: 28, band: 6 },
    { minScaled: 26, band: 5.5 },
    { minScaled: 22, band: 5 },
    { minScaled: 20, band: 4.5 },
    { minScaled: 17, band: 4 },
    { minScaled: 13, band: 3.5 },
    { minScaled: 9, band: 3 },
    { minScaled: 6, band: 2.5 },
    { minScaled: 4, band: 2 },
    { minScaled: 2, band: 1.5 },
    { minScaled: 0, band: 1 },
  ],
};

/**
 * Reading/Listening percent-correct -> band via Table 3. Table 3 itself is [ETS]; projecting an
 * Attempt's percent-correct onto its 0-30 scale (round half up of 30 x fraction) to use as the
 * lookup key is [ours]: ETS publishes no raw-to-band formula for the new test (ADR 0005). `raw`
 * reports the 0-1 percent-correct, not the intermediate 0-30 value, so `raw` means the same thing
 * under both methods.
 *
 * Percent-correct is unweighted across every scoreable item passed in; Task Types matter only for
 * coverage, which needs every Task Type of the Modules taken (see requiredTaskTypes).
 *
 * Known limitation (ADR 0005): percent-correct cannot see the difficulty difference between
 * the Lower and Upper Module. LOWER_PATH_BAND_CAP compensates; it does not correct the assumption.
 */
export function estimateBandTable3(
  section: "reading" | "listening",
  items: readonly BandEstimatorItem[],
  opts: { modulePath: ModulePath },
): BandEstimateResult {
  const byTaskType = bucketByTaskType(items, (item) => item.maxScore > 0);
  // Canonical order first, then any Task Type outside the section's list (never from real
  // item_results), alphabetically, so nothing scored is silently dropped from the disclosure.
  const canonical = TASK_TYPE_ORDER[section];
  const stragglers = [...byTaskType.keys()].filter((taskType) => !canonical.includes(taskType)).sort();
  const coverage = coverageIn([...canonical, ...stragglers], byTaskType);

  const missing = missingTaskTypes(section, coverage, opts.modulePath);
  if (missing.length > 0) return { status: "incomplete", method: "table3-v1", missingTaskTypes: missing, coverage };

  const scoreable = [...byTaskType.values()].flatMap((bucket) => bucket.scores);
  const correct = scoreable.map(normalized).reduce(add, { n: 0, d: 1 });
  const raw = scale(correct, 1, scoreable.length);
  // scaled = round-half-up(30 * raw), in integers.
  const thirty = scale(raw, 30, 1);
  const scaled = floorDiv(2 * thirty.n + thirty.d, 2 * thirty.d);
  // Non-null: the last row (minScaled: 0) always matches, since scaled is never negative.
  const row = TABLE3[section].find((r) => scaled >= r.minScaled)!;
  const band = opts.modulePath === "lower" ? Math.min(row.band, LOWER_PATH_BAND_CAP) : row.band;

  return { status: "estimated", estimate: { band, raw: raw.n / raw.d, method: "table3-v1", coverage } };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
