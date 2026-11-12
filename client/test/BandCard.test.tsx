import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { Section, StatsSectionVM } from "@toefl-prep/shared";
import BandCard from "../src/components/BandCard";

// One section on the Dashboard: its Band Estimate pencilled with its CEFR level, where it came from,
// the distance to its Target in words, the Module Path where it was routed, and a Target the User can
// edit. With no band it says what gets one — nothing stands in.

function estimate(over: Partial<StatsSectionVM> = {}): StatsSectionVM {
  return {
    section: "reading",
    band: 5,
    method: "table3-v1",
    attemptId: "att-1",
    mode: "simulation",
    attemptedAt: "2026-08-20T03:04:05.000Z",
    target: 5.5,
    modulePath: "upper",
    recentSimulationRange: { min: 5, max: 6, count: 3 },
    ...over,
  };
}

function renderCard(props: { section?: Section; estimate?: StatsSectionVM; target?: number; onTargetChange?: (v: number) => Promise<void>; loading?: boolean }) {
  const onTargetChange = props.onTargetChange ?? vi.fn().mockResolvedValue(undefined);
  render(
    <MemoryRouter>
      <BandCard
        section={props.section ?? "reading"}
        estimate={props.estimate}
        loading={props.loading}
        target={"target" in props ? props.target : 5.5}
        onTargetChange={onTargetChange}
        missing="Take a Reading Simulation."
      />
    </MemoryRouter>,
  );
  return { onTargetChange, card: screen.getByRole("region", { name: /band/ }) };
}

const cefrLevels = (scope: HTMLElement) => within(scope).getAllByTestId("cefr-level").map((el) => el.textContent?.replace("·", "").trim());

describe("BandCard with a Band Estimate", () => {
  it("shows the band as an estimate with its CEFR level, and the Target's level after it", () => {
    const { card } = renderCard({ estimate: estimate({ band: 4.5 }) });
    expect(within(card).getByText("estimate")).toBeInTheDocument();
    expect(cefrLevels(card)).toEqual(["B2", "C1"]);
  });

  it("links to the Attempt it came from by what it was, never by its id", () => {
    const { card } = renderCard({ estimate: estimate() });
    const link = within(card).getByRole("link", { name: "your Reading Simulation" });
    expect(link).toHaveAttribute("href", "/attempts/att-1");
    expect(card).not.toHaveTextContent("att-1");
  });

  it("states the distance to the Target in words", () => {
    const { card } = renderCard({ estimate: estimate({ band: 4.5 }), target: 5.5 });
    expect(within(card).getByText("1 band below your Target")).toBeInTheDocument();
  });

  it("says how far the last few Simulations spread", () => {
    const { card } = renderCard({ estimate: estimate() });
    expect(within(card).getByText("Your last 3 Simulations: 5–6")).toBeInTheDocument();
  });

  it("discloses the Module Path, and the cap on the Lower Module", () => {
    const { card } = renderCard({ estimate: estimate({ band: 4.5, modulePath: "lower" }) });
    const disclosure = within(card).getByTestId("module-path-disclosure").textContent ?? "";
    expect(disclosure).toMatch(/Lower Module/);
    expect(disclosure).toMatch(/capped at 4\.5/);
  });
});

describe("BandCard with no Band Estimate", () => {
  it("says there is no band and what gets one, with no number standing in", () => {
    const { card } = renderCard({ estimate: undefined });
    expect(within(card).getByText("No band yet")).toBeInTheDocument();
    expect(within(card).getByText("Take a Reading Simulation.")).toBeInTheDocument();
    expect(within(card).queryByText("estimate")).toBeNull();
    // Only the Target's level: there is no band to map.
    expect(cefrLevels(card)).toEqual(["C1"]);
  });

  it("does not claim there is no band while the summary is still loading", () => {
    const { card } = renderCard({ estimate: undefined, loading: true });
    expect(within(card).queryByText("No band yet")).toBeNull();
    expect(card).toHaveAttribute("aria-busy", "true");
  });
});

describe("BandCard Target", () => {
  it("every section has one, editable, saved only on Save", async () => {
    const { onTargetChange } = renderCard({ section: "listening", estimate: estimate({ section: "listening" }), target: 5.5 });
    await userEvent.click(screen.getByRole("button", { name: "Edit Listening Target" }));
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Listening Target" }), "6");
    expect(onTargetChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onTargetChange).toHaveBeenCalledWith(6);
  });

  it("carries the estimate caveat on the CEFR level, so it can't be read as a certification", () => {
    const { card } = renderCard({ estimate: estimate() });
    const title = within(card).getAllByTestId("cefr-level")[0].getAttribute("title") ?? "";
    expect(title).toMatch(/not an official certification/);
    expect(title).toMatch(/estimate/);
  });
});
