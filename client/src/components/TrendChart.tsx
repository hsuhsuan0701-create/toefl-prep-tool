import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { TrendPointVM } from "@toefl-prep/shared";
import { axisTicks, formatAxisTick, formatScore, scaleFor } from "../lib/taskTypeScale";
import { dayTickIndices, formatTrendDate } from "../lib/trendAxis";
import { formatWhen } from "../ui/format";

// Colours are the design tokens, passed as CSS variables because recharts writes them into SVG
// attributes rather than classes. Mode is carried by marker shape as well as tone, as in
// ui/StatTile's Sparkline: a Drill is a hollow circle, a Simulation a filled square. Here a Repeat
// also gets a dashed outline, and the latest Attempt is the one point in the accent.
const INK = "var(--color-ink)";
const INK_SOFT = "var(--color-ink-soft)";
const GRAPHITE = "var(--color-graphite)";
const RULE = "var(--color-rule)";
const RULE_STRONG = "var(--color-rule-strong)";
const ACCENT = "var(--color-accent)";
const SHEET = "var(--color-sheet)";

// Below this, a series draws its points but no connecting line. Two points joined by a segment
// render as a trend the data cannot support, and most Task Types have only a few Attempts.
const MIN_POINTS_FOR_A_LINE = 3;

type Row = {
  /** Position on the x-axis: this Attempt's rank in chronological order, not its instant. */
  idx: number;
  ts: number;
  date: string;
  attemptId: string;
  mode: "drill" | "simulation";
  isRepeat: boolean;
  avgScore: number;
  drillScore?: number;
  simScore?: number;
  latest: boolean;
};

// The x-axis plots Attempt order, so every step is equal: practice is bursty, and on a time axis an
// evening's Attempts would bunch into a near-vertical smear while the idle weeks beside them took
// the width. The calendar survives as day-labelled ticks and the tooltip's date.
function toRows(points: TrendPointVM[]): Row[] {
  const sorted = points
    .map((p) => ({
      ts: new Date(p.date).getTime(),
      date: p.date,
      attemptId: p.attemptId,
      mode: p.mode,
      isRepeat: p.isRepeat,
      avgScore: p.avgScore,
      drillScore: p.mode === "drill" ? p.avgScore : undefined,
      simScore: p.mode === "simulation" ? p.avgScore : undefined,
    }))
    .sort((a, b) => a.ts - b.ts);
  return sorted.map((row, idx) => ({ ...row, idx, latest: idx === sorted.length - 1 }));
}

// r=4.5 keeps every marker over 8px; the sheet fill is its own gap where it crosses a line.
function DrillDot({ cx, cy, payload }: { cx?: number; cy?: number; payload?: Row }) {
  if (cx === undefined || cy === undefined || !payload) return <g />;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={4.5}
      fill={SHEET}
      stroke={payload.latest ? ACCENT : INK_SOFT}
      strokeWidth={1.75}
      strokeDasharray={payload.isRepeat ? "2.5 2" : undefined}
    />
  );
}

function SimulationDot({ cx, cy, payload }: { cx?: number; cy?: number; payload?: Row }) {
  if (cx === undefined || cy === undefined || !payload) return <g />;
  const colour = payload.latest ? ACCENT : INK;
  return (
    <rect
      x={cx - 4.5}
      y={cy - 4.5}
      width={9}
      height={9}
      fill={payload.isRepeat ? SHEET : colour}
      stroke={colour}
      strokeWidth={1.5}
      strokeDasharray={payload.isRepeat ? "2.5 2" : undefined}
    />
  );
}

function ChartTooltip({ active, payload, taskType }: { active?: boolean; payload?: { payload: Row }[]; taskType: string }) {
  if (!active || !payload || payload.length === 0) return null;
  const row = payload[0].payload;
  return (
    <div className="rounded-control border border-rule bg-sheet px-3 py-2 text-meta shadow-overlay">
      <p className="text-graphite">{formatWhen(row.date)}</p>
      <p className="figures mt-0.5 font-semibold text-ink">{formatScore(taskType, row.avgScore)}</p>
      <p className="text-ink-soft">
        {row.mode === "drill" ? "Drill" : "Simulation"}
        {row.isRepeat ? " · Repeat" : ""}
      </p>
    </div>
  );
}

// Rendered once by whatever lays the charts out, not once per chart.
export function TrendLegend() {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-graphite" aria-label="Chart key">
      <li className="flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="4.25" className="fill-sheet stroke-ink-soft" strokeWidth={1.5} />
        </svg>
        Drill
      </li>
      <li className="flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="1.5" y="1.5" width="9" height="9" className="fill-ink" />
        </svg>
        Simulation
      </li>
      <li className="flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="4.25" className="fill-sheet stroke-ink-soft" strokeWidth={1.5} strokeDasharray="2.5 2" />
        </svg>
        Repeat Attempt
      </li>
      <li className="flex items-center gap-1.5">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="4.25" className="fill-sheet stroke-accent" strokeWidth={1.75} />
        </svg>
        Latest
      </li>
    </ul>
  );
}

// The chart itself, with no data fetching of its own, so a container that has already fetched
// several Task Types in one request can render many of these, and the axis and scale behaviour is
// testable without a fetch mock.
export function TrendChartView({ taskType, points, height = 220 }: { taskType: string; points: TrendPointVM[]; height?: number }) {
  const rows = toRows(points);
  const drillCount = rows.filter((r) => r.drillScore !== undefined).length;
  const simCount = rows.filter((r) => r.simScore !== undefined).length;
  const ticks = axisTicks(taskType);
  // The Y axis is as wide as its widest label needs: recharts ends each label 8px left of the axis
  // line and never measures it, so "100%" (up to 35px at this size, by font) needs 48px where a
  // single rubric digit needs 36. The chart's left margin stays 0 so the axis box starts at the
  // SVG's edge, never past it.
  const yAxisWidth = scaleFor(taskType).kind === "accuracy" ? 48 : 36;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={rows} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
        <CartesianGrid stroke={RULE} vertical={false} />
        {/* tickFormatter has no rows[idx] guard on purpose: dayTickIndices only ever emits indices of
            this same rows array, and recharts passes a supplied `ticks` prop through verbatim, so a
            miss here should fail loudly rather than render a blank label. */}
        <XAxis
          dataKey="idx"
          type="number"
          domain={["dataMin", "dataMax"]}
          ticks={dayTickIndices(rows)}
          tickFormatter={(idx: number) => formatTrendDate(rows[idx].ts)}
          tick={{ fontSize: 12, fill: GRAPHITE }}
          stroke={RULE_STRONG}
        />
        {/* The scale comes from the Task Type (lib/taskTypeScale): accuracy Task Types run 0–1,
            shown as 0–100%, and judged ones 0–5, so an accuracy series uses the full height. */}
        <YAxis
          domain={[0, ticks[ticks.length - 1]]}
          ticks={ticks}
          tickFormatter={(v: number) => formatAxisTick(taskType, v)}
          tick={{ fontSize: 12, fill: GRAPHITE }}
          stroke={RULE_STRONG}
          width={yAxisWidth}
        />
        <Tooltip content={<ChartTooltip taskType={taskType} />} cursor={{ stroke: RULE_STRONG }} />
        {/* Both series need connectNulls: every row carries exactly one of drillScore and simScore,
            so each series sees the other mode's rows as nulls, and without it a Drill line would
            break wherever a Simulation lands between two Drills. `linear`, not a spline, because a
            curve between sparse points draws values that were never measured. */}
        <Line
          type="linear"
          dataKey="drillScore"
          name="Drill"
          stroke={drillCount >= MIN_POINTS_FOR_A_LINE ? INK_SOFT : "none"}
          strokeWidth={1.5}
          connectNulls
          dot={DrillDot}
          activeDot={{ r: 6, fill: SHEET, stroke: ACCENT, strokeWidth: 2 }}
          isAnimationActive={false}
        />
        <Line
          type="linear"
          dataKey="simScore"
          name="Simulation"
          stroke={simCount >= MIN_POINTS_FOR_A_LINE ? INK : "none"}
          strokeWidth={1.5}
          connectNulls
          dot={SimulationDot}
          activeDot={{ r: 6, fill: SHEET, stroke: ACCENT, strokeWidth: 2 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
