import { formatDay } from "../ui/format";

// X-axis helpers for the trend charts. Split out of TrendChart.tsx so the component file exports
// only components (oxlint's react/only-export-components rule, which exists because a mixed file
// breaks Fast Refresh) and so the tick logic is testable without rendering recharts.

/** A tick's day, in the app's one date format ("Aug 16"). */
export function formatTrendDate(ts: number): string {
  return formatDay(new Date(ts).toISOString());
}

// The axis positions Attempts by order, not by instant, so ticks are row indices and the calendar
// survives only as each tick's label. Recharts places ticks by value, which would print a day's
// label once per Attempt on a day with several. Ticks are therefore chosen here: the index of the
// first Attempt of each calendar day, thinned evenly to at most MAX_X_TICKS while keeping the first
// and last day, so a label never repeats and the axis never crowds. Rows must already be sorted
// ascending by `ts`.
const MAX_X_TICKS = 5;
export function dayTickIndices(rows: { ts: number }[]): number[] {
  const firstOfDay: number[] = [];
  let previousDay = "";
  rows.forEach((row, index) => {
    const day = new Date(row.ts).toDateString();
    if (day !== previousDay) {
      firstOfDay.push(index);
      previousDay = day;
    }
  });
  if (firstOfDay.length <= MAX_X_TICKS) return firstOfDay;
  const step = (firstOfDay.length - 1) / (MAX_X_TICKS - 1);
  const thinned = new Set<number>();
  for (let i = 0; i < MAX_X_TICKS; i += 1) thinned.add(firstOfDay[Math.round(i * step)]);
  return [...thinned];
}
