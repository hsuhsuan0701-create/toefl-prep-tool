import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PublicCtwSegment } from "@toefl-prep/shared";
import CtwGapInput, { type CtwGapResult } from "../src/components/CtwGapInput";

const segments: PublicCtwSegment[] = [
  { type: "text", text: "The " },
  { type: "gap", gapId: "g1" },
  { type: "text", text: " sat on the " },
  { type: "gap", gapId: "g2" },
  { type: "text", text: "." },
];

const gaps = [
  { id: "g1", prefix: "ca", blankLength: 1 },
  { id: "g2", prefix: "m", blankLength: 3 },
];

describe("CtwGapInput", () => {
  it("renders one input per gap with maxLength === blankLength and the prefix visible", () => {
    render(<CtwGapInput segments={segments} gaps={gaps} onChange={vi.fn()} />);

    expect(screen.getByText("ca")).toBeInTheDocument();
    expect(screen.getByText("m")).toBeInTheDocument();

    const g1Input = screen.getByLabelText(/starting with "ca"/i) as HTMLInputElement;
    const g2Input = screen.getByLabelText(/starting with "m"/i) as HTMLInputElement;
    expect(g1Input.maxLength).toBe(1);
    expect(g2Input.maxLength).toBe(3);
  });

  it("typing emits the whole typed map on every change", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CtwGapInput segments={segments} gaps={gaps} onChange={onChange} />);

    await user.type(screen.getByLabelText(/starting with "ca"/i), "t");
    expect(onChange).toHaveBeenLastCalledWith(new Map([["g1", "t"]]));

    await user.type(screen.getByLabelText(/starting with "m"/i), "at");
    expect(onChange).toHaveBeenLastCalledWith(new Map([["g1", "t"], ["g2", "at"]]));
  });

  it("result mode disables the inputs and marks each gap right or wrong, with the completed word (key)", () => {
    const results = new Map<string, CtwGapResult>([
      ["g1", { correct: true, key: "t" }],
      ["g2", { correct: false, key: "at" }],
    ]);
    render(
      <CtwGapInput
        segments={segments}
        gaps={gaps}
        disabled
        results={results}
        values={new Map([["g1", "t"], ["g2", "en"]])}
        onChange={vi.fn()}
      />,
    );

    const g1Input = screen.getByLabelText(/starting with "ca"/i) as HTMLInputElement;
    const g2Input = screen.getByLabelText(/starting with "m"/i) as HTMLInputElement;
    expect(g1Input).toBeDisabled();
    expect(g2Input).toBeDisabled();

    // A glyph plus the verdict in words (for a screen reader), and for a wrong gap the completed
    // word = prefix + key, so the correction is legible without the raw suffix alone.
    expect(screen.getByTestId("ctw-gap-result-g1")).toHaveTextContent("Correct");
    expect(screen.getByTestId("ctw-gap-result-g1").querySelector("svg")).not.toBeNull();
    expect(screen.getByTestId("ctw-gap-result-g2")).toHaveTextContent("Incorrect. The word is mat");
    expect(screen.getByTestId("ctw-gap-result-g2").querySelector("svg")).not.toBeNull();
  });

  // A gap shows its length before anything is typed, so every letter has to take the same width:
  // in a proportional face "ows" is wider than three average slots and its last letter is clipped.
  // jsdom lays nothing out; the measured check (scrollWidth <= clientWidth over every banked gap)
  // is a browser run. This pins what makes it hold: one monospace face over the whole passage, and
  // each box sized in ch to exactly its letter count, with no letter-spacing to pay for.
  it("sets the passage in one monospace face and sizes each box in ch to its letter count", () => {
    render(<CtwGapInput segments={segments} gaps={gaps} onChange={vi.fn()} />);

    const g2Input = screen.getByLabelText(/starting with "m"/i) as HTMLInputElement;
    const paragraph = g2Input.closest("p");
    expect(paragraph).toHaveClass("font-mono");
    expect(g2Input.style.width).toMatch(/^calc\(3ch \+/);
    expect(g2Input.style.backgroundSize).toMatch(/^3ch /);
    expect(g2Input.className).not.toMatch(/tracking-/);
  });

  it("keeps the punctuation after a gap on the gap's line", () => {
    render(<CtwGapInput segments={segments} gaps={gaps} onChange={vi.fn()} />);

    const g2Input = screen.getByLabelText(/starting with "m"/i) as HTMLInputElement;
    expect(g2Input.parentElement).toHaveClass("whitespace-nowrap");
    expect(g2Input.parentElement).toHaveTextContent(/^m.*\.$/);
  });
});
