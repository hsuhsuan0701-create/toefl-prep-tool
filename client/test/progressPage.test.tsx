import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { cloneElement, isValidElement, type ReactElement } from "react";
import type { StatsSummaryVM, TrendPointVM } from "@toefl-prep/shared";
import Progress from "../src/pages/Progress";
import TrendsSection from "../src/components/TrendsSection";
import WeaknessPanel from "../src/components/WeaknessPanel";
import { TrendChartView } from "../src/components/TrendChart";

// jsdom sizes every element 0x0, so recharts' ResponsiveContainer would draw nothing. Only that
// sizing wrapper is replaced; the chart under it is the real one.
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: ReactElement }) =>
      isValidElement(children) ? cloneElement(children, { width: 640, height: 240 } as never) : children,
  };
});

// Progress reads as words first: a trend's mode is a marker shape as well as a tone, a weak skill is
// named rather than only coloured, Judge agreement is a sentence, and a failed load is never drawn
// as an empty page.

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function stub(routes: Record<string, () => Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const handler = Object.entries(routes).find(([pattern]) => url.includes(pattern))?.[1];
      if (!handler) throw new Error(`unhandled fetch in test: ${url}`);
      return handler();
    }),
  );
}

function point(over: Partial<TrendPointVM>): TrendPointVM {
  return { date: "2026-08-16T01:00:00.000Z", attemptId: "att", mode: "drill", isRepeat: false, taskType: "email", avgScore: 3, ...over };
}

const SUMMARY: StatsSummaryVM = {
  sections: [],
  overall: { band: null } as unknown as StatsSummaryVM["overall"],
  weaknesses: [],
  judgeAgreement: { avgDelta: null, sampleSize: 0 },
  skillItems: [],
  skillItemsLimit: 300,
};

afterEach(() => vi.unstubAllGlobals());

describe("the full trend chart", () => {
  it("draws Drills as circles and Simulations as squares, in token colours", () => {
    const { container } = render(
      <TrendChartView
        taskType="email"
        points={[
          point({ attemptId: "d1", date: "2026-08-16T01:00:00.000Z", mode: "drill", avgScore: 3 }),
          point({ attemptId: "s1", date: "2026-08-17T01:00:00.000Z", mode: "simulation", avgScore: 3.5 }),
          point({ attemptId: "d2", date: "2026-08-18T01:00:00.000Z", mode: "drill", avgScore: 4 }),
        ]}
      />,
    );
    const svg = container.querySelector("svg.recharts-surface")!;
    expect(svg.querySelectorAll("circle")).toHaveLength(2);
    expect(svg.querySelectorAll("rect[width='9']")).toHaveLength(1);
    expect(svg.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
  });
});

describe("trend tiles", () => {
  it("say the load failed, with a retry, instead of an empty grid", async () => {
    let fail = true;
    stub({ "/api/stats/trends": () => (fail ? json({ error: "boom" }, 500) : json([point({ avgScore: 4 })])) });
    render(<TrendsSection />);

    expect(await screen.findByText("Couldn't load your trends")).toBeInTheDocument();
    expect(screen.queryByText(/No scored Attempts yet|No Attempts scored yet/u)).toBeNull();

    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("4.00 / 5")).toBeInTheDocument();
  });

  it("say once that nothing is scored yet rather than twelve times", async () => {
    stub({ "/api/stats/trends": () => json([]) });
    render(<TrendsSection />);
    expect(await screen.findByText("No scored Attempts yet")).toBeInTheDocument();
    expect(screen.queryByText("No Attempts scored yet")).toBeNull();
  });
});

describe("the weakness breakdown", () => {
  it("names a weak skill in words and states each figure in full", () => {
    render(
      <WeaknessPanel
        skillItemsLimit={300}
        weaknesses={[{ category: "grammar", count: 7 }, { category: "pronunciation-proxy", count: 1 }]}
        judgeAgreement={{ avgDelta: null, sampleSize: 0 }}
        skillAccuracy={[
          { section: "listening", skill: "inference", correct: 2, total: 5, accuracy: 0.4 },
          { section: "reading", skill: "main_idea", correct: 9, total: 10, accuracy: 0.9 },
        ]}
      />,
    );
    expect(screen.getByText("7 Deductions")).toBeInTheDocument();
    expect(screen.getByText("1 Deduction")).toBeInTheDocument();
    // The same word the Deduction's own chip uses (ui/labels.ts).
    expect(screen.getByText("Pronunciation")).toBeInTheDocument();
    expect(screen.getByText("40% · 2 of 5")).toBeInTheDocument();
    expect(screen.getAllByText("Under 60%")).toHaveLength(1);
  });

  it("states judge agreement as a sentence", () => {
    const { rerender } = render(<WeaknessPanel skillItemsLimit={300} weaknesses={[]} skillAccuracy={[]} judgeAgreement={{ avgDelta: 0.4166, sampleSize: 120 }} />);
    expect(
      screen.getByText("On the same Response, your two Judges' scores are 0.4 points apart on average, out of 5, over 120 Responses. They mostly agree."),
    ).toBeInTheDocument();

    rerender(<WeaknessPanel skillItemsLimit={300} weaknesses={[]} skillAccuracy={[]} judgeAgreement={{ avgDelta: null, sampleSize: 0 }} />);
    expect(screen.getByText(/Not enough Responses have been scored by both Judges/u)).toBeInTheDocument();
  });
});

describe("/progress", () => {
  it("says the Attempt log failed rather than that there are no Attempts", async () => {
    stub({
      "/api/attempts": () => json({ error: "boom" }, 500),
      "/api/stats/summary": () => json(SUMMARY),
      "/api/stats/trends": () => json([]),
    });
    render(
      <MemoryRouter>
        <Progress />
      </MemoryRouter>,
    );
    expect(await screen.findByText("Couldn't load your Attempts")).toBeInTheDocument();
    expect(screen.queryByText("No Attempts yet")).toBeNull();
  });

  it("names the skill pane's window with the number the summary sends", async () => {
    stub({
      "/api/attempts": () => json({ items: [], total: 0 }),
      "/api/stats/summary": () => json({ ...SUMMARY, skillItemsLimit: 120 }),
      "/api/stats/trends": () => json([]),
    });
    render(
      <MemoryRouter>
        <Progress />
      </MemoryRouter>,
    );
    expect(
      await screen.findByText(
        "Percent correct on each skill in your 120 most recently scored Reading and Listening Items, weakest first. Drills and Simulations both count.",
      ),
    ).toBeInTheDocument();
  });

  it("offers a way to start when there are no Attempts", async () => {
    stub({
      "/api/attempts": () => json({ items: [], total: 0 }),
      "/api/stats/summary": () => json(SUMMARY),
      "/api/stats/trends": () => json([]),
    });
    render(
      <MemoryRouter>
        <Progress />
      </MemoryRouter>,
    );
    expect(await screen.findByText("No Attempts yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Choose a Set" })).toHaveAttribute("href", "/sets");
  });
});
