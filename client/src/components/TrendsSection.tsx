import { useEffect, useId, useRef, useState } from "react";
import type { Section, TrendPointVM } from "@toefl-prep/shared";
import { getTrends } from "../lib/api";
import { requestErrorMessage } from "../lib/requestError";
import { TREND_TASKS } from "../lib/taskTypes";
import {
  DEFAULT_TREND_RANGE,
  TREND_RANGE_OPTIONS,
  filterTrendPoints,
  type CustomTrendRange,
  type TrendRangeKey,
} from "../lib/trendRange";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { SectionHeader } from "../ui/Heading";
import { SECTION_LABEL } from "../ui/labels";
import { Notice } from "../ui/Notice";
import { SegmentedControl } from "../ui/Segmented";
import { Skeleton } from "../ui/Skeleton";
import TrendCard from "./TrendCard";
import { TrendChartView, TrendLegend } from "./TrendChart";

// Test order, as everywhere a page lists the four sections.
const SECTION_ORDER: Section[] = ["reading", "listening", "writing", "speaking"];

const DATE_INPUT = "min-h-8 rounded-control border border-rule-strong bg-field px-2 text-meta text-ink pointer-coarse:min-h-10";

// One range for every tile, not one per tile: the question ("how has my recent practice gone?") is
// asked of the whole grid at once, and per-tile windows would make two tiles silently
// incomparable. The window re-slices histories already fetched; see lib/trendRange.ts.
function RangeControl({
  range,
  custom,
  onRange,
  onCustom,
}: {
  range: TrendRangeKey;
  custom: CustomTrendRange;
  onRange: (range: TrendRangeKey) => void;
  onCustom: (custom: CustomTrendRange) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
      <SegmentedControl
        label="Trend range"
        size="sm"
        value={range}
        onChange={onRange}
        options={TREND_RANGE_OPTIONS.map((option) => ({
          value: option.key,
          label: option.spoken ? (
            <>
              <span aria-hidden="true">{option.label}</span>
              <span className="sr-only">{option.spoken}</span>
            </>
          ) : (
            option.label
          ),
        }))}
      />
      {range === "custom" && (
        <div className="flex flex-wrap items-center gap-3 text-meta text-ink-soft">
          <label className="flex items-center gap-1.5">
            From
            <input type="date" value={custom.from} onChange={(e) => onCustom({ ...custom, from: e.target.value })} className={DATE_INPUT} />
          </label>
          <label className="flex items-center gap-1.5">
            To
            <input type="date" value={custom.to} onChange={(e) => onCustom({ ...custom, to: e.target.value })} className={DATE_INPUT} />
          </label>
        </div>
      )}
    </div>
  );
}

function LoadingTiles() {
  return (
    <div aria-busy="true" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="rounded-sheet border border-rule bg-sheet p-4">
          <Skeleton className="w-1/2" />
          <Skeleton shape="block" className="mt-3 h-7 w-20" />
        </div>
      ))}
    </div>
  );
}

// Every Task Type's recent form as StatTiles, grouped by section. The full chart opens for the one
// Task Type being looked at, below its section's tiles, so axes and the legend appear once on the
// page instead of twelve times.
export default function TrendsSection() {
  const [points, setPoints] = useState<Map<string, TrendPointVM[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [range, setRange] = useState<TrendRangeKey>(DEFAULT_TREND_RANGE);
  const [custom, setCustom] = useState<CustomTrendRange>({ from: "", to: "" });
  const idBase = useId();
  // Each tile's toggle, by Task Type: closing a chart hands focus back to the tile that opened it,
  // since the Close button goes with the chart.
  const tileRefs = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => {
    let cancelled = false;
    getTrends(TREND_TASKS.map((t) => t.taskType))
      .then((grouped) => {
        if (cancelled) return;
        setPoints(grouped);
        setError(null);
      })
      .catch((e) => {
        if (!cancelled) setError(requestErrorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  if (error) {
    return (
      <Notice
        tone="critical"
        title="Couldn't load your trends"
        action={
          <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        }
      >
        {error}
      </Notice>
    );
  }
  if (points === null) return <LoadingTiles />;

  if (![...points.values()].some((history) => history.length > 0)) {
    return (
      <EmptyState title="No scored Attempts yet">
        Each Task Type's score appears here after its first scored Attempt, Drill or Simulation.
      </EmptyState>
    );
  }

  const nowMs = Date.now();
  const visibleFor = (taskType: string) => filterTrendPoints(points.get(taskType) ?? [], range, nowMs, custom);

  return (
    <div className="space-y-8">
      <RangeControl range={range} custom={custom} onRange={setRange} onCustom={setCustom} />
      {SECTION_ORDER.map((section) => {
        const tasks = TREND_TASKS.filter((t) => t.section === section);
        const openTask = tasks.find((t) => t.taskType === expanded);
        // The window can empty the open Task Type's history; the chart then closes rather than draw
        // nothing (its tile is already saying "No Attempts in this range").
        const openPoints = openTask ? visibleFor(openTask.taskType) : [];
        const headingId = `${idBase}-${section}`;
        return (
          <section key={section} aria-labelledby={headingId} className="space-y-3">
            <SectionHeader as="h3" id={headingId} title={SECTION_LABEL[section]} />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {tasks.map((task) => (
                <TrendCard
                  key={task.taskType}
                  taskType={task.taskType}
                  label={task.label}
                  points={visibleFor(task.taskType)}
                  emptyNote={(points.get(task.taskType) ?? []).length > 0 ? "No Attempts in this range" : undefined}
                  expanded={expanded === task.taskType}
                  onToggle={() => setExpanded((prev) => (prev === task.taskType ? null : task.taskType))}
                  ref={(el) => {
                    if (el) tileRefs.current.set(task.taskType, el);
                    else tileRefs.current.delete(task.taskType);
                  }}
                />
              ))}
            </div>
            {openTask && openPoints.length > 0 && (
              <Card className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  <h4 className="text-body font-semibold text-ink">{openTask.label}</h4>
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => {
                      setExpanded(null);
                      tileRefs.current.get(openTask.taskType)?.focus({ preventScroll: true });
                    }}
                  >
                    Close chart
                  </Button>
                </div>
                <TrendLegend />
                <TrendChartView taskType={openTask.taskType} points={openPoints} />
              </Card>
            )}
          </section>
        );
      })}
    </div>
  );
}
