import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { OverallCard } from "../src/pages/dashboard/OverallCard";

// The Overall exists only when all four sections have a Band Estimate. Without it the card shows no
// number at all — never a mean of the sections it has — and names the ones still missing.

describe("OverallCard", () => {
  it("a first run shows no band and no CEFR level", () => {
    render(<OverallCard overall={{ band: null, missingSections: ["reading", "listening", "writing", "speaking"] }} />);
    expect(screen.getByText("No band yet")).toBeInTheDocument();
    expect(screen.queryByTestId("cefr-level")).toBeNull();
    expect(screen.queryByText("estimate")).toBeNull();
  });

  it("names the sections still without a band", () => {
    render(<OverallCard overall={{ band: null, missingSections: ["listening", "writing"] }} />);
    expect(screen.getByText(/Listening and Writing have none yet/)).toBeInTheDocument();
  });

  it("names a single missing section on its own", () => {
    render(<OverallCard overall={{ band: null, missingSections: ["speaking"] }} />);
    expect(screen.getByText(/Speaking has none yet/)).toBeInTheDocument();
  });

  it("shows the mean as an estimate with its CEFR level, and how it is computed", () => {
    render(<OverallCard overall={{ band: 5.5, missingSections: [] }} />);
    expect(screen.getByText("5.5")).toBeInTheDocument();
    expect(screen.getByTestId("cefr-level")).toHaveTextContent("C1");
    expect(screen.getByText("estimate")).toBeInTheDocument();
    expect(screen.getByText(/Mean of the four section bands, rounded to the nearest half band/)).toBeInTheDocument();
  });
});
