// Window filtering for the trend cards (TrendsSection.tsx), by time or by count. Split out of the
// component for the same reason as trendAxis.ts: the component file exports only components, and
// the windowing rules (rolling presets, local-day custom bounds) are testable without mounting.
//
// All filtering happens in the client: the twelve histories arrive in one `/api/stats/trends`
// request, so narrowing the window re-slices in memory instead of re-fetching, and the server keeps
// a single, parameter-free notion of a trend.

/** Windows over when Attempts happened: rolling presets, everything, or picked calendar days. */
export type TimeTrendRangeKey = "1w" | "2w" | "1m" | "2m" | "all" | "custom";
/** Windows over how many: each Task Type's own most recent N Attempts, whenever they happened. */
export type CountTrendRangeKey = "last10" | "last20";
export type TrendRangeKey = TimeTrendRangeKey | CountTrendRangeKey;

/** Date-input values ("YYYY-MM-DD"); an empty or malformed side means unbounded on that side. */
export type CustomTrendRange = { from: string; to: string };

/** `label` is what the control shows; `spoken` is the accessible name where the label abbreviates. */
export const TREND_RANGE_OPTIONS: { key: TrendRangeKey; label: string; spoken?: string }[] = [
  { key: "last10", label: "Last 10", spoken: "Last 10 Attempts" },
  { key: "last20", label: "Last 20", spoken: "Last 20 Attempts" },
  { key: "1w", label: "1W", spoken: "Past week" },
  { key: "2w", label: "2W", spoken: "Past 2 weeks" },
  { key: "1m", label: "1M", spoken: "Past 30 days" },
  { key: "2m", label: "2M", spoken: "Past 60 days" },
  { key: "all", label: "All time" },
  { key: "custom", label: "Custom" },
];

/**
 * A count window, not a time window. With the charts spacing Attempts by order (trendAxis.ts),
 * recent form is most honestly a number of Attempts: a count window reads the same whether those
 * Attempts span one evening or a month, where a week window shows a quiet week as one lonely point
 * and a busy week as a wall.
 */
export const DEFAULT_TREND_RANGE: TrendRangeKey = "last20";

const COUNT_WINDOW: Record<CountTrendRangeKey, number> = { last10: 10, last20: 20 };

function isCountRange(range: TrendRangeKey): range is CountTrendRangeKey {
  return range in COUNT_WINDOW;
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Rolling windows back from "now", in days. Months are 30-day windows, not calendar arithmetic:
// the presets exist to answer "how has the last stretch of practice gone", where a fixed-width
// window is the honest comparison ("1M" spanning 28 days in February but 31 in March would make
// the same practice cadence look denser or sparser by month).
const PRESET_DAYS: Record<Exclude<TimeTrendRangeKey, "all" | "custom">, number> = {
  "1w": 7,
  "2w": 14,
  "1m": 30,
  "2m": 60,
};

// A custom bound is a calendar day as the User sees it, so it is parsed into local midnight, not
// through `new Date("YYYY-MM-DD")`, which the spec reads as UTC midnight and which would move every
// picked day by the machine's UTC offset. The point instants being compared are ISO from the route
// boundary; only the day boundaries are local.
function parseDateInput(value: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const parts = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  return Number.isNaN(new Date(parts.y, parts.m - 1, parts.d).getTime()) ? null : parts;
}

/**
 * The selected window as instants: `startMs` inclusive, `endMs` exclusive, either side null for
 * unbounded. A custom "to" day is included whole by ending at local midnight of the next day
 * (day+1 through the Date constructor's overflow, so a DST-shifted midnight still lands on the real
 * one).
 */
export function trendRangeBounds(
  range: TimeTrendRangeKey,
  nowMs: number,
  custom: CustomTrendRange,
): { startMs: number | null; endMs: number | null } {
  if (range === "all") return { startMs: null, endMs: null };
  if (range === "custom") {
    const from = parseDateInput(custom.from);
    const to = parseDateInput(custom.to);
    return {
      startMs: from ? new Date(from.y, from.m - 1, from.d).getTime() : null,
      endMs: to ? new Date(to.y, to.m - 1, to.d + 1).getTime() : null,
    };
  }
  return { startMs: nowMs - PRESET_DAYS[range] * DAY_MS, endMs: null };
}

/**
 * Points inside the window, order preserved. Generic so callers pass TrendPointVM[] through.
 * Count windows take the array's own tail — the input is already chronological (the trends route
 * returns Attempts in completion order, the same assumption the cards' latest/previous read makes).
 */
export function filterTrendPoints<T extends { date: string }>(
  points: T[],
  range: TrendRangeKey,
  nowMs: number,
  custom: CustomTrendRange,
): T[] {
  if (isCountRange(range)) {
    const count = COUNT_WINDOW[range];
    return points.length > count ? points.slice(-count) : points;
  }
  const { startMs, endMs } = trendRangeBounds(range, nowMs, custom);
  if (startMs === null && endMs === null) return points;
  return points.filter((point) => {
    const ts = new Date(point.date).getTime();
    return (startMs === null || ts >= startMs) && (endMs === null || ts < endMs);
  });
}
