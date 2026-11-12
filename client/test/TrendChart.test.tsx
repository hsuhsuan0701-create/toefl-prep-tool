import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { cloneElement, isValidElement } from "react";
import type { TrendPointVM } from "@toefl-prep/shared";

// recharts measures its parent to size itself, and jsdom reports every element as 0x0 — a real
// ResponsiveContainer therefore renders an empty div and no SVG at all. Only the sizing wrapper is
// replaced; every axis, line and scale under test is the real component.
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      isValidElement(children) ? cloneElement(children, { width: 640, height: 240 } as never) : children,
  };
});

const { TrendChartView } = await import("../src/components/TrendChart");
const { formatTrendDate } = await import("../src/lib/trendAxis");

function point(overrides: Partial<TrendPointVM> & Pick<TrendPointVM, "date" | "mode" | "avgScore">): TrendPointVM {
  return {
    attemptId: `att-${overrides.date}`,
    isRepeat: false,
    taskType: "complete_words",
    ...overrides,
  } as TrendPointVM;
}

describe("TrendChartView scales the axis to the Task Type, not to a hardcoded 0-5", () => {
  it("draws a deterministic Task Type against a percentage axis", () => {
    render(
      <TrendChartView
        taskType="complete_words"
        points={[
          point({ date: "2026-08-16T01:00:00.000Z", mode: "drill", avgScore: 0.5 }),
          point({ date: "2026-08-17T01:00:00.000Z", mode: "drill", avgScore: 0.75 }),
        ]}
      />,
    );
    expect(screen.getByText("100%")).toBeTruthy();
    expect(screen.getByText("50%")).toBeTruthy();
    // On a 0..5 axis a 0.75 would look like a flat line.
    expect(screen.queryByText("5")).toBeNull();
  });

  it("draws a judge-scored Task Type against the 0-5 rubric axis", () => {
    render(
      <TrendChartView
        taskType="email"
        points={[
          point({ date: "2026-08-16T01:00:00.000Z", mode: "drill", avgScore: 3, taskType: "email" }),
          point({ date: "2026-08-17T01:00:00.000Z", mode: "drill", avgScore: 4, taskType: "email" }),
        ]}
      />,
    );
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.queryByText("100%")).toBeNull();
  });
});

describe("TrendChartView spaces Attempts by order, not calendar time", () => {
  // Practice is bursty: on a time axis, same-day Attempts smear into a near-vertical cluster and a
  // multi-week gap takes most of the width. So every step is equal (an hour apart and 25 days apart
  // render the same distance), and the calendar survives as one label per day plus the tooltip's
  // full date-time.
  it("gives a same-day burst distinct positions, a multi-week gap no extra width", () => {
    const { container } = render(
      <TrendChartView
        taskType="email"
        points={[
          point({ date: "2026-08-16T01:00:00.000Z", mode: "drill", avgScore: 3, taskType: "email" }),
          point({ date: "2026-08-16T02:00:00.000Z", mode: "drill", avgScore: 3.5, taskType: "email" }),
          point({ date: "2026-09-10T01:00:00.000Z", mode: "drill", avgScore: 4, taskType: "email" }),
        ]}
      />,
    );
    const cxs = [...container.querySelectorAll("circle")]
      .map((c) => Number(c.getAttribute("cx")))
      .sort((a, b) => a - b);
    expect(new Set(cxs).size).toBe(3);
    expect(cxs[1] - cxs[0]).toBeCloseTo(cxs[2] - cxs[1], 3);
  });

  it("labels each calendar day once, however many attempts it holds", () => {
    const { container } = render(
      <TrendChartView
        taskType="email"
        points={[
          point({ date: "2026-08-16T01:00:00.000Z", mode: "drill", avgScore: 3, taskType: "email" }),
          point({ date: "2026-08-16T02:00:00.000Z", mode: "drill", avgScore: 3.5, taskType: "email" }),
          point({ date: "2026-08-16T03:00:00.000Z", mode: "drill", avgScore: 4, taskType: "email" }),
          point({ date: "2026-09-10T01:00:00.000Z", mode: "drill", avgScore: 4.5, taskType: "email" }),
        ]}
      />,
    );
    // Locale-independent: compare against the formatter the axis itself uses, and scope to the
    // chart's own SVG text — recharts also keeps a hidden HTML measurement span holding the last
    // label it sized, which a document-wide text query would count as a duplicate.
    const labels = [...container.querySelectorAll("svg text")].map((t) => t.textContent);
    expect(labels.filter((l) => l === formatTrendDate(new Date("2026-08-16T01:00:00.000Z").getTime()))).toHaveLength(1);
    expect(labels.filter((l) => l === formatTrendDate(new Date("2026-09-10T01:00:00.000Z").getTime()))).toHaveLength(1);
  });
});

describe("TrendChartView keeps each mode's own series continuous", () => {
  // Every row carries exactly one of drillScore/simScore, so the Drill series sees each Simulation
  // as a null. Without connectNulls the line breaks at every interleaved Simulation and renders as
  // isolated dots, so three Drills separated by Simulations look like three unrelated Attempts.
  it("connects Drill attempts that have a Simulation between them", () => {
    const { container } = render(
      <TrendChartView
        taskType="email"
        points={[
          point({ date: "2026-08-10T01:00:00.000Z", mode: "drill", avgScore: 3, taskType: "email" }),
          point({ date: "2026-08-11T01:00:00.000Z", mode: "simulation", avgScore: 4, taskType: "email" }),
          point({ date: "2026-08-12T01:00:00.000Z", mode: "drill", avgScore: 3.5, taskType: "email" }),
          point({ date: "2026-08-13T01:00:00.000Z", mode: "drill", avgScore: 4, taskType: "email" }),
        ]}
      />,
    );
    const curves = [...container.querySelectorAll("path.recharts-curve.recharts-line-curve")];
    const drawn = curves.map((c) => c.getAttribute("d") ?? "").filter((d) => d.length > 0);
    // One continuous 3-point path for the three Drills, not a set of degenerate segments.
    expect(drawn.some((d) => (d.match(/L/gu) ?? []).length >= 2)).toBe(true);
  });
});
