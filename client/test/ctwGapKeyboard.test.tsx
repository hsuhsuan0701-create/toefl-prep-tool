import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PublicCtwSegment } from "@toefl-prep/shared";
import CtwGapInput from "../src/components/CtwGapInput";

// Complete the Words is ten gaps in one paragraph, typed against a clock. Working through them with
// the keyboard alone has to be comfortable: a gap that is full hands focus to the next one, Backspace
// in an empty gap goes back to the previous one, and Enter moves on. Each gap says how many letters
// it is missing before anything is typed.

const segments: PublicCtwSegment[] = [
  { type: "text", text: "The " },
  { type: "gap", gapId: "g1" },
  { type: "text", text: " sat on the " },
  { type: "gap", gapId: "g2" },
  { type: "text", text: " by the " },
  { type: "gap", gapId: "g3" },
  { type: "text", text: "." },
];

const gaps = [
  { id: "g1", prefix: "ca", blankLength: 1 },
  { id: "g2", prefix: "m", blankLength: 2 },
  { id: "g3", prefix: "do", blankLength: 2 },
];

const gap = (prefix: string) => screen.getByLabelText(`Gap starting with "${prefix}"`) as HTMLInputElement;

describe("Complete the Words, by keyboard", () => {
  it("says how many letters each gap is missing", () => {
    render(<CtwGapInput segments={segments} gaps={gaps} onChange={vi.fn()} />);
    expect(gap("ca")).toHaveAccessibleDescription("1 missing letter");
    expect(gap("m")).toHaveAccessibleDescription("2 missing letters");
  });

  it("moves to the next gap once a gap is full, so a whole passage types straight through", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CtwGapInput segments={segments} gaps={gaps} onChange={onChange} />);

    await user.click(gap("ca"));
    await user.keyboard("tat");
    expect(gap("ca").value).toBe("t");
    expect(gap("m").value).toBe("at");
    expect(gap("do")).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith(new Map([["g1", "t"], ["g2", "at"]]));
  });

  it("goes back to the previous gap on Backspace in an empty one", async () => {
    const user = userEvent.setup();
    render(<CtwGapInput segments={segments} gaps={gaps} onChange={vi.fn()} />);

    await user.click(gap("m"));
    await user.keyboard("{Backspace}");
    expect(gap("ca")).toHaveFocus();
  });

  it("moves on with Enter, and stays on the last gap at the end of the passage", async () => {
    const user = userEvent.setup();
    render(<CtwGapInput segments={segments} gaps={gaps} onChange={vi.fn()} />);

    await user.click(gap("ca"));
    await user.keyboard("{Enter}");
    expect(gap("m")).toHaveFocus();
    await user.click(gap("do"));
    await user.keyboard("gs");
    expect(gap("do")).toHaveFocus();
  });

  it("does not jump while an input method is still composing", () => {
    render(<CtwGapInput segments={segments} gaps={gaps} onChange={vi.fn()} />);
    const first = gap("ca");
    first.focus();
    fireEvent.compositionStart(first);
    fireEvent.change(first, { target: { value: "t" } });
    expect(first).toHaveFocus();
    fireEvent.compositionEnd(first);
    expect(first).toHaveFocus();
  });

  it("shows the letters it is given, so a gap typed earlier is still filled when the passage returns", () => {
    render(<CtwGapInput segments={segments} gaps={gaps} values={new Map([["g2", "at"]])} onChange={vi.fn()} />);
    expect(gap("m").value).toBe("at");
    expect(gap("ca").value).toBe("");
  });
});
