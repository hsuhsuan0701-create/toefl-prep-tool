import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TrendPointVM } from "@toefl-prep/shared";
import TrendsSection from "../src/components/TrendsSection";

// The range picker over the real section component, with only the transport mocked: the window
// narrows every card at once, defaults to the last 20 Attempts, and an off-screen history reads as
// "in this range", never as "never attempted".

const DAY_MS = 24 * 60 * 60 * 1000;

function point(taskType: string, msAgo: number, avgScore: number): TrendPointVM {
  return {
    date: new Date(Date.now() - msAgo).toISOString(),
    attemptId: `att-${taskType}-${msAgo}`,
    mode: "drill",
    isRepeat: false,
    taskType,
    avgScore,
  };
}

function dateInputValue(msAgo: number): string {
  const d = new Date(Date.now() - msAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function stubTrends(points: TrendPointVM[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith("/api/stats/trends")) throw new Error(`unexpected fetch: ${url}`);
      return new Response(JSON.stringify(points), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("TrendsSection range picker", () => {
  it("defaults to the last 20 attempts and narrows to the last week on 1W", async () => {
    // Write an Email: 4.00 two days ago, 3.00 forty days ago — a count window keeps both.
    stubTrends([point("email", 40 * DAY_MS, 3), point("email", 2 * DAY_MS, 4)]);
    render(<TrendsSection />);

    expect(await screen.findByText("4.00 / 5")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Last 20 Attempts" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(/from 3\.00 \/ 5/u)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "Past week" }));
    // One point in the week window: no delta line naming the 40-day-old score.
    expect(screen.getByText(/1 Attempt/u)).toBeInTheDocument();
    expect(screen.queryByText(/from 3\.00 \/ 5/u)).not.toBeInTheDocument();
  });

  it("keeps a short history whole under a count window smaller than the bank", async () => {
    stubTrends([point("email", 40 * DAY_MS, 3), point("email", 2 * DAY_MS, 4)]);
    render(<TrendsSection />);
    await screen.findByText("4.00 / 5");

    await userEvent.click(screen.getByRole("radio", { name: "Last 10 Attempts" }));
    expect(screen.getByText(/from 3\.00 \/ 5/u)).toBeInTheDocument();
  });

  it("says a history is outside the range, not that it never happened", async () => {
    stubTrends([point("interview", 40 * DAY_MS, 3.5)]);
    render(<TrendsSection />);

    // A count window can never hide an existing history — the attempt shows on load.
    expect(await screen.findByText("3.50 / 5")).toBeInTheDocument();
    expect(screen.queryByText("No Attempts in this range")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("radio", { name: "Past week" }));
    expect(screen.getByText("No Attempts in this range")).toBeInTheDocument();
    // The eleven genuinely unattempted Task Types keep the never-attempted wording.
    expect(screen.getAllByText("No Attempts scored yet")).toHaveLength(11);
  });

  it("applies a custom from/to window over the picked local days", async () => {
    stubTrends([point("email", 40 * DAY_MS, 3), point("email", 2 * DAY_MS, 4)]);
    render(<TrendsSection />);
    await screen.findByText("4.00 / 5");

    await userEvent.click(screen.getByRole("radio", { name: "Custom" }));
    const oldDay = dateInputValue(40 * DAY_MS);
    fireEvent.change(screen.getByLabelText(/From/u), { target: { value: oldDay } });
    fireEvent.change(screen.getByLabelText(/To/u), { target: { value: oldDay } });

    // Only the 40-day-old attempt falls on that day.
    expect(screen.getByText("3.00 / 5")).toBeInTheDocument();
    expect(screen.queryByText("4.00 / 5")).not.toBeInTheDocument();
  });

  it("closes an open full chart when the window empties its Task Type", async () => {
    stubTrends([point("email", 2 * DAY_MS, 4)]);
    render(<TrendsSection />);
    await screen.findByText("4.00 / 5");

    await userEvent.click(screen.getByRole("button", { name: /Write an Email/u }));
    expect(screen.getByText("Repeat Attempt")).toBeInTheDocument(); // the once-per-page legend

    await userEvent.click(screen.getByRole("radio", { name: "Custom" }));
    const emptyDay = dateInputValue(300 * DAY_MS);
    fireEvent.change(screen.getByLabelText(/From/u), { target: { value: emptyDay } });
    fireEvent.change(screen.getByLabelText(/To/u), { target: { value: emptyDay } });
    expect(screen.queryByText("Repeat Attempt")).not.toBeInTheDocument();
  });

  // "Close chart" goes with the chart, so focus goes back to the tile that opened it rather than to
  // the page body (issue #24).
  it("returns focus to the tile when its chart is closed", async () => {
    stubTrends([point("email", 2 * DAY_MS, 4)]);
    render(<TrendsSection />);
    await screen.findByText("4.00 / 5");

    const tile = screen.getByRole("button", { name: /Write an Email/u });
    await userEvent.click(tile);
    await userEvent.click(screen.getByRole("button", { name: "Close chart" }));
    expect(screen.queryByRole("button", { name: "Close chart" })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(tile);
    expect(tile).toHaveAttribute("aria-expanded", "false");
  });
});
