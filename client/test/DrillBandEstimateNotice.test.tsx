import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import DrillBandEstimateNotice from "../src/components/DrillBandEstimateNotice";

describe("DrillBandEstimateNotice", () => {
  it("renders the exact mandated notice that Drills never produce a Band Estimate", () => {
    render(<DrillBandEstimateNotice />);
    expect(
      screen.getByText("A Drill doesn't change your Band Estimate. For a band, take a Simulation."),
    ).toBeInTheDocument();
  });
});
