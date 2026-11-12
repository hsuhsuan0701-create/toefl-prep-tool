import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TrendPointVM } from "@toefl-prep/shared";
import TrendCard from "../src/components/TrendCard";

function point(date: string, avgScore: number, taskType = "complete_words"): TrendPointVM {
  return { date, attemptId: `att-${date}`, mode: "drill", isRepeat: false, taskType, avgScore };
}

describe("TrendCard", () => {
  it("reads the latest score in the Task Type's own units", () => {
    render(
      <TrendCard
        taskType="complete_words"
        label="Complete the Words"
        points={[point("2026-08-16T01:00:00.000Z", 0.5), point("2026-08-17T01:00:00.000Z", 0.75)]}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText("75%")).toBeTruthy();
    // Named outright rather than compressed into a delta, which on a proportion scale is ambiguous.
    expect(screen.getByText(/from 50%/u)).toBeTruthy();
    expect(screen.getByText("▲")).toBeTruthy();
  });

  it("keeps a rubric Task Type on its own denominator", () => {
    render(
      <TrendCard
        taskType="email"
        label="Write an Email"
        points={[point("2026-08-16T01:00:00.000Z", 4, "email"), point("2026-08-17T01:00:00.000Z", 3, "email")]}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText("3.00 / 5")).toBeTruthy();
    expect(screen.getByText("▼")).toBeTruthy();
  });

  it("spaces a same-day burst evenly instead of bunching it against a later attempt", () => {
    // The sparkline is positioned by Attempt order, not time. Positioned by time, the two Aug 16
    // Attempts would sit about 0.2px apart while the three-week gap took the rest of the width.
    const { container } = render(
      <TrendCard
        taskType="email"
        label="Write an Email"
        points={[
          point("2026-08-16T01:00:00.000Z", 3, "email"),
          point("2026-08-16T02:00:00.000Z", 4, "email"),
          point("2026-09-06T01:00:00.000Z", 4.5, "email"),
        ]}
        expanded={false}
        onToggle={vi.fn()}
      />,
    );
    const d = container.querySelector("svg path")?.getAttribute("d") ?? "";
    const xs = [...d.matchAll(/[ML](\d+(?:\.\d+)?)/gu)].map((m) => Number(m[1]));
    expect(xs).toHaveLength(3);
    expect(xs[1] - xs[0]).toBeCloseTo(xs[2] - xs[1], 1);
  });

  it("says so, and offers nothing to open, when a Task Type has never been scored", () => {
    render(
      <TrendCard taskType="interview" label="Interview" points={[]} expanded={false} onToggle={vi.fn()} />,
    );
    expect(screen.getByText("No Attempts scored yet")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("names the range, not a missing history, when a filter emptied the card", () => {
    render(
      <TrendCard
        taskType="interview"
        label="Interview"
        points={[]}
        emptyNote="No Attempts in this range"
        expanded={false}
        onToggle={vi.fn()}
      />,
    );
    expect(screen.getByText("No Attempts in this range")).toBeTruthy();
    expect(screen.queryByText("No Attempts scored yet")).toBeNull();
  });

  it("toggles the full chart open and closed", async () => {
    const onToggle = vi.fn();
    render(
      <TrendCard
        taskType="email"
        label="Write an Email"
        points={[point("2026-08-16T01:00:00.000Z", 4, "email")]}
        expanded={false}
        onToggle={onToggle}
      />,
    );
    const card = screen.getByRole("button");
    expect(card.getAttribute("aria-expanded")).toBe("false");
    await userEvent.click(card);
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
