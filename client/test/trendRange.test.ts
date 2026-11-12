import { describe, expect, it } from "vitest";
import { filterTrendPoints, trendRangeBounds, TREND_RANGE_OPTIONS, DEFAULT_TREND_RANGE } from "../src/lib/trendRange";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-08-25T12:00:00.000Z").getTime();
const NO_CUSTOM = { from: "", to: "" };

function pointAt(ms: number): { date: string } {
  return { date: new Date(ms).toISOString() };
}

/** The "YYYY-MM-DD" a date input would hold for this instant on this machine (local calendar day). */
function dateInputValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

describe("filterTrendPoints", () => {
  it("keeps only the rolling window for each preset", () => {
    const points = [pointAt(NOW - 45 * DAY_MS), pointAt(NOW - 20 * DAY_MS), pointAt(NOW - 10 * DAY_MS), pointAt(NOW - 2 * DAY_MS)];
    expect(filterTrendPoints(points, "1w", NOW, NO_CUSTOM)).toEqual([points[3]]);
    expect(filterTrendPoints(points, "2w", NOW, NO_CUSTOM)).toEqual([points[2], points[3]]);
    expect(filterTrendPoints(points, "1m", NOW, NO_CUSTOM)).toEqual([points[1], points[2], points[3]]);
    expect(filterTrendPoints(points, "2m", NOW, NO_CUSTOM)).toEqual(points);
  });

  it("a window boundary is inclusive of a point exactly on it", () => {
    const onBoundary = pointAt(NOW - 7 * DAY_MS);
    expect(filterTrendPoints([onBoundary], "1w", NOW, NO_CUSTOM)).toEqual([onBoundary]);
  });

  it("all time passes every point through untouched", () => {
    const points = [pointAt(NOW - 400 * DAY_MS), pointAt(NOW)];
    expect(filterTrendPoints(points, "all", NOW, NO_CUSTOM)).toBe(points);
  });

  it("a custom range includes both named days whole, in local time", () => {
    const early = pointAt(NOW - 30 * DAY_MS);
    const inside = pointAt(NOW - 10 * DAY_MS);
    const late = pointAt(NOW - 1 * DAY_MS);
    // Bounds named as the inside point's own local day on both ends: the day must contain it whole.
    const day = dateInputValue(NOW - 10 * DAY_MS);
    expect(filterTrendPoints([early, inside, late], "custom", NOW, { from: day, to: day })).toEqual([inside]);
  });

  it("a custom range picked the wrong way round is the range between the two days", () => {
    const early = pointAt(NOW - 30 * DAY_MS);
    const inside = pointAt(NOW - 10 * DAY_MS);
    const late = pointAt(NOW - 1 * DAY_MS);
    const first = dateInputValue(NOW - 12 * DAY_MS);
    const last = dateInputValue(NOW - 8 * DAY_MS);
    const forward = filterTrendPoints([early, inside, late], "custom", NOW, { from: first, to: last });
    expect(forward).toEqual([inside]);
    expect(filterTrendPoints([early, inside, late], "custom", NOW, { from: last, to: first })).toEqual(forward);
    expect(trendRangeBounds("custom", NOW, { from: last, to: first })).toEqual(trendRangeBounds("custom", NOW, { from: first, to: last }));
  });

  it("an empty or malformed custom side is unbounded on that side", () => {
    const early = pointAt(NOW - 30 * DAY_MS);
    const late = pointAt(NOW - 1 * DAY_MS);
    const mid = dateInputValue(NOW - 10 * DAY_MS);
    expect(filterTrendPoints([early, late], "custom", NOW, { from: mid, to: "" })).toEqual([late]);
    expect(filterTrendPoints([early, late], "custom", NOW, { from: "", to: mid })).toEqual([early]);
    expect(filterTrendPoints([early, late], "custom", NOW, { from: "not-a-date", to: "" })).toEqual([early, late]);
  });

  it("custom day boundaries are local midnight, not the UTC midnight Date.parse would give", () => {
    const day = dateInputValue(NOW);
    const { startMs } = trendRangeBounds("custom", NOW, { from: day, to: "" });
    const [y, m, d] = day.split("-").map(Number);
    expect(startMs).toBe(new Date(y, m - 1, d).getTime());
  });
});

describe("count windows", () => {
  it("keeps only the most recent N points, preserving order", () => {
    const points = Array.from({ length: 25 }, (_, i) => pointAt(NOW - (25 - i) * DAY_MS));
    expect(filterTrendPoints(points, "last20", NOW, NO_CUSTOM)).toEqual(points.slice(5));
    expect(filterTrendPoints(points, "last10", NOW, NO_CUSTOM)).toEqual(points.slice(15));
  });

  it("shows the full history when it holds fewer than N points", () => {
    const points = [pointAt(NOW - 400 * DAY_MS), pointAt(NOW - 2 * DAY_MS)];
    expect(filterTrendPoints(points, "last10", NOW, NO_CUSTOM)).toEqual(points);
  });

  it("ignores time entirely — a years-old attempt still counts toward the window", () => {
    const points = [pointAt(NOW - 800 * DAY_MS), pointAt(NOW - 1 * DAY_MS)];
    expect(filterTrendPoints(points, "last20", NOW, NO_CUSTOM)).toEqual(points);
  });
});

describe("range options", () => {
  it("offers exactly the eight advertised windows, defaulting to the last 20 attempts", () => {
    expect(TREND_RANGE_OPTIONS.map((o) => o.key)).toEqual(["last10", "last20", "1w", "2w", "1m", "2m", "all", "custom"]);
    expect(DEFAULT_TREND_RANGE).toBe("last20");
  });
});
