import { Hono } from "hono";
import { z } from "zod";
import {
  AnyTaskType,
  ListeningTaskType,
  ReadingTaskType,
  type AttemptMode,
  type Section,
  type StatsOverallVM,
  type StatsSectionVM,
  type StatsSettingsVM,
  type StatsSummaryVM,
  type TrendPointVM,
} from "@toefl-prep/shared";
import { meanBand } from "../services/bandEstimator.js";
import { sqliteTimestampToIso } from "../db/timestamps.js";
import type { JudgeReportListRow, LatestEstimateRow, TrendRow } from "../db/rows.js";

// ETS test order. Every list of sections this route returns follows it.
const SUMMARY_SECTION_ORDER: readonly Section[] = ["reading", "listening", "writing", "speaking"];

/**
 * The Settings store behind the four per-section Targets. This route is its only reader and only
 * writer, so the port is declared here. Values are scalars stored under individual keys
 * ("target.reading"), never one JSON blob, so a corrupt value costs one setting rather than all four.
 */
export type SettingsStore = {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
};

/**
 * The Dashboard's read-only aggregation: whole-history reads that would otherwise be a fetch per
 * Attempt. Nothing here writes; the one writer this route uses is SettingsStore, a separate port.
 */
export type StatsReadStore = {
  trendPoints(taskType: string): TrendRow[];
  getLatestEstimates(): Partial<Record<"speaking" | "writing" | "reading" | "listening", LatestEstimateRow>>;
  /** Bands of the section's latest non-Repeat Simulations that are bands at all, newest first. */
  recentSimulationBands(section: string, limit: number): number[];
  recentScoredItemResults(limit: number): { scoreJson: string }[];
  recentScoredReadingListeningItemResults(limit: number): { scoreJson: string; taskType: string }[];
  listAllJudgeReports(): JudgeReportListRow[];
};

export type StatsStore = SettingsStore & StatsReadStore;
export type StatsDeps = { repo: StatsStore };

// Every section's Target starts at 5.5 until the User sets one.
const DEFAULT_TARGET = 5.5;

// Targets live on the same 1-6, half-step grid as the estimators' output.
const bandNumber = z.number().min(1).max(6).multipleOf(0.5);

// Not strict: unknown keys are dropped, not refused, so a stale tab that still sends `pins` saves
// its Target edit and nothing else. Stored `pin.*` values are never read: a Pin was a stand-in band,
// not a goal, so it is not a Target.
const SettingsPatchSchema = z.object({
  targets: z
    .object({
      reading: bandNumber.optional(),
      listening: bandNumber.optional(),
      writing: bandNumber.optional(),
      speaking: bandNumber.optional(),
    })
    .optional(),
});

// Defensive: a corrupt/non-numeric stored value falls back to the default rather than propagating
// NaN into the response.
function readNumberSetting(repo: SettingsStore, key: string, fallback: number): number {
  const raw = repo.getSetting(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readSettings(repo: SettingsStore): StatsSettingsVM {
  const targets = Object.fromEntries(
    SUMMARY_SECTION_ORDER.map((section) => [section, readNumberSetting(repo, `target.${section}`, DEFAULT_TARGET)]),
  ) as Record<Section, number>;
  return { targets };
}

// Deduction-category counts across the most recently scored judged Items' Score Reports (the store
// scopes the window to judge-scored Task Types, so right-or-wrong Items never take a slot).
// Corrupt JSON or a missing or non-array `deductions` field is skipped, never thrown. Sorted by
// count descending, then category.
function computeWeaknesses(rows: { scoreJson: string }[]): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.scoreJson);
    } catch {
      continue;
    }
    const deductions = (parsed as { deductions?: unknown })?.deductions;
    if (!Array.isArray(deductions)) continue;
    for (const d of deductions) {
      const category = (d as { category?: unknown })?.category;
      if (typeof category !== "string") continue;
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || a.category.localeCompare(b.category));
}

// Mean |Gemini score - OpenAI score| over every (Attempt, Item) pair with both Judge Reports
// persisted. An Item scored by one Judge (the other failed) is left out of both the mean and the
// sample size. Corrupt report_json, or a report missing the matching Item, is skipped.
function computeJudgeAgreement(rows: { attemptId: string; itemId: string; judge: string; reportJson: string }[]): {
  avgDelta: number | null;
  sampleSize: number;
} {
  const byKey = new Map<string, { gemini?: number; openai?: number }>();
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.reportJson);
    } catch {
      continue;
    }
    const items = (parsed as { items?: unknown })?.items;
    const item = Array.isArray(items)
      ? (items as { itemId?: unknown; score?: unknown }[]).find((i) => i.itemId === row.itemId)
      : undefined;
    if (!item || typeof item.score !== "number") continue;
    const key = `${row.attemptId}:${row.itemId}`;
    const entry = byKey.get(key) ?? {};
    if (row.judge === "gemini") entry.gemini = item.score;
    else if (row.judge === "openai") entry.openai = item.score;
    byKey.set(key, entry);
  }
  const deltas: number[] = [];
  for (const { gemini, openai } of byKey.values()) {
    if (typeof gemini === "number" && typeof openai === "number") deltas.push(Math.abs(gemini - openai));
  }
  const sampleSize = deltas.length;
  // null, not 0, when there is nothing to average: 0 would read as perfect agreement.
  const avgDelta = sampleSize === 0 ? null : deltas.reduce((a, b) => a + b, 0) / sampleSize;
  return { avgDelta, sampleSize };
}


// How many recent Simulations the range beside a headline spans.
const RECENT_SIMULATIONS = 3;

/**
 * The min and max of the section's last few non-Repeat Simulation bands, or nothing when it has
 * none — a single Simulation is a noisy sample, and the range says how far the headline moves
 * between sittings.
 */
function recentSimulationRange(repo: StatsReadStore, section: Section): { recentSimulationRange?: { min: number; max: number; count: number } } {
  const bands = repo.recentSimulationBands(section, RECENT_SIMULATIONS);
  if (bands.length === 0) return {};
  return { recentSimulationRange: { min: Math.min(...bands), max: Math.max(...bands), count: bands.length } };
}

/**
 * The Dashboard's Overall (StatsOverallVM): ETS's mean-then-round over the four sections' Band
 * Estimates. With any section missing there is no Overall — a mean of three sections is a different
 * number, not an approximation of four.
 */
function deriveOverall(sections: readonly StatsSectionVM[]): StatsOverallVM {
  const bySection = new Map(sections.map((s) => [s.section, s]));
  const missingSections = SUMMARY_SECTION_ORDER.filter((section) => !bySection.has(section));
  return {
    band: missingSections.length === 0 ? meanBand(SUMMARY_SECTION_ORDER.map((section) => bySection.get(section)!.band)) : null,
    missingSections,
  };
}

// Scored Reading/Listening multiple-choice item_results as StatsSummaryVM.skillItems: section, skill
// and correctness per row, with no bucketing, filtering or sorting (the client's
// weaknessCategories.ts does that). Not a leak: `skill` already reaches the client per Attempt in
// ItemVM.scoreJson; this gathers the same field across the history in one call. `taskType` decides
// the section, because the two sections' skill categories share names ("detail", "inference").
// A Task Type in neither set is skipped here rather than trusting the store's query to exclude it.
// Corrupt JSON or a missing or wrong-typed `skill`/`correct` is skipped.
const READING_MCQ_TASK_TYPES: ReadonlySet<string> = new Set(ReadingTaskType.options.filter((t) => t !== "complete_words"));
const LISTENING_MCQ_TASK_TYPES: ReadonlySet<string> = new Set(ListeningTaskType.options);
function computeSkillItems(
  rows: { scoreJson: string; taskType: string }[],
): { section: "reading" | "listening"; skill: string; correct: boolean }[] {
  const items: { section: "reading" | "listening"; skill: string; correct: boolean }[] = [];
  for (const row of rows) {
    const section = READING_MCQ_TASK_TYPES.has(row.taskType) ? "reading" : LISTENING_MCQ_TASK_TYPES.has(row.taskType) ? "listening" : null;
    if (section === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.scoreJson);
    } catch {
      continue;
    }
    const skill = (parsed as { skill?: unknown })?.skill;
    const correct = (parsed as { correct?: unknown })?.correct;
    if (typeof skill !== "string" || typeof correct !== "boolean") continue;
    items.push({ section, skill, correct });
  }
  return items;
}

// Far wider than the 20-Item weakness window: the client drops any skill category with fewer than
// five samples, so the pane needs a sample spanning several Attempts.
const SKILL_ITEMS_LIMIT = 300;

/**
 * `/api/stats`: per-Task-Type trends, the Dashboard summary (headline Band Estimates, the Overall,
 * weaknesses, Judge agreement, skill accuracy) and the Targets. Read-only except PUT /settings.
 */
export function buildStatsRoutes(deps: StatsDeps) {
  return new Hono()
    .get("/trends", (c) => {
      // `taskType` is one Task Type of any section, or a comma-separated list of them: a page shows
      // one small multiple per Task Type and fetches them in one request. Every value is gated
      // against AnyTaskType individually — one unknown entry 400s the whole request rather than
      // being dropped — and duplicates collapse, so the work is bounded at one query per known Task
      // Type. The result is a flat TrendPointVM[]; each point names its `taskType` for the caller
      // to group by.
      const requested = [...new Set((c.req.query("taskType") ?? "").split(",").map((value) => value.trim()))];
      const taskTypes: string[] = [];
      for (const value of requested) {
        const parsed = AnyTaskType.safeParse(value);
        if (!parsed.success) {
          return c.json({ error: "taskType query param required (one or more comma-separated Speaking/Writing/Reading/Listening Task Types)" }, 400);
        }
        taskTypes.push(parsed.data);
      }
      const points: TrendPointVM[] = taskTypes.flatMap((taskType) => {
        return deps.repo.trendPoints(taskType).map((row) => ({
          // The client feeds this straight into `new Date(...)`, so it must be an ISO instant, not
          // the space-form UTC column value, which `new Date` reads as local time.
          date: sqliteTimestampToIso(row.completedAt ?? row.startedAt),
          attemptId: row.attemptId,
          mode: row.mode as "drill" | "simulation",
          isRepeat: row.isRepeat === 1,
          taskType,
          avgScore: row.avgScore,
        }));
      });
      return c.json(points);
    })
    .get("/summary", (c) => {
      const settings = readSettings(deps.repo);
      const estimates = deps.repo.getLatestEstimates();

      // A section is listed only once a completed non-Repeat Attempt has a Band Estimate under the
      // band rule (getLatestEstimates applies it); nothing stands in for one before that.
      const sections: StatsSummaryVM["sections"] = [];
      for (const section of SUMMARY_SECTION_ORDER) {
        const est = estimates[section];
        if (!est) continue;
        sections.push({
          section,
          band: est.estimatedBand,
          method: est.method,
          attemptId: est.attemptId,
          mode: est.mode as AttemptMode,
          attemptedAt: sqliteTimestampToIso(est.completedAt ?? est.startedAt),
          target: settings.targets[section],
          // Present only for a routed Reading/Listening Simulation, the one place table3-v1 persists.
          ...(est.modulePath ? { modulePath: est.modulePath } : {}),
          ...recentSimulationRange(deps.repo, section),
        });
      }

      const summary: StatsSummaryVM = {
        sections,
        overall: deriveOverall(sections),
        weaknesses: computeWeaknesses(deps.repo.recentScoredItemResults(20)),
        judgeAgreement: computeJudgeAgreement(deps.repo.listAllJudgeReports()),
        skillItems: computeSkillItems(deps.repo.recentScoredReadingListeningItemResults(SKILL_ITEMS_LIMIT)),
      };
      return c.json(summary);
    })
    .get("/settings", (c) => c.json(readSettings(deps.repo)))
    .put("/settings", async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON" }, 400);
      }
      const parsed = SettingsPatchSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

      for (const section of SUMMARY_SECTION_ORDER) {
        const value = parsed.data.targets?.[section];
        if (value !== undefined) deps.repo.setSetting(`target.${section}`, String(value));
      }

      return c.json(readSettings(deps.repo));
    });
}
