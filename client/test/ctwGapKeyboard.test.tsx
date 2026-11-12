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

// The opening of rd-170e6bf3's first passage: "When t[he] queue gr[ows] past a fixed li[mit], the
// plat[form] automatically shi[fts] extra ...".
const proseSegments: PublicCtwSegment[] = [
  { type: "text", text: "When " },
  { type: "gap", gapId: "p1" },
  { type: "text", text: " queue " },
  { type: "gap", gapId: "p2" },
  { type: "text", text: " past a fixed " },
  { type: "gap", gapId: "p3" },
  { type: "text", text: ", the " },
  { type: "gap", gapId: "p4" },
  { type: "text", text: " automatically " },
  { type: "gap", gapId: "p5" },
  { type: "text", text: " extra traffic." },
];
const proseGaps = [
  { id: "p1", prefix: "t", blankLength: 2 },
  { id: "p2", prefix: "gr", blankLength: 3 },
  { id: "p3", prefix: "li", blankLength: 3 },
  { id: "p4", prefix: "plat", blankLength: 4 },
  { id: "p5", prefix: "shi", blankLength: 3 },
];

describe("Complete the Words, typed like prose", () => {
  it("lets no space into a gap, so words typed with spaces between them land one per gap", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CtwGapInput segments={proseSegments} gaps={proseGaps} onChange={onChange} />);

    await user.click(gap("t"));
    await user.keyboard("he ows mit form");
    expect([gap("t"), gap("gr"), gap("li"), gap("plat")].map((g) => g.value)).toEqual(["he", "ows", "mit", "form"]);
    expect(gap("shi").value).toBe("");
    expect(gap("shi")).toHaveFocus();
    expect(onChange).toHaveBeenLastCalledWith(new Map([["p1", "he"], ["p2", "ows"], ["p3", "mit"], ["p4", "form"]]));
  });

  it("takes a space typed into a gap that is not yet full as nothing: no slot, no move", async () => {
    const user = userEvent.setup();
    render(<CtwGapInput segments={proseSegments} gaps={proseGaps} onChange={vi.fn()} />);

    await user.click(gap("gr"));
    await user.keyboard("ow ");
    expect(gap("gr").value).toBe("ow");
    expect(gap("gr")).toHaveFocus();
    await user.keyboard("s");
    expect(gap("gr").value).toBe("ows");
    expect(gap("li")).toHaveFocus();
  });

  it("drops the whitespace from a paste and keeps every letter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CtwGapInput segments={proseSegments} gaps={proseGaps} onChange={onChange} />);

    await user.click(gap("gr"));
    await user.paste("o w s");
    expect(gap("gr").value).toBe("ows");
    expect(onChange).toHaveBeenLastCalledWith(new Map([["p2", "ows"]]));
  });

  it("keeps any other character as typed: a digit or a wrong letter is the User's own Response", async () => {
    const user = userEvent.setup();
    render(<CtwGapInput segments={proseSegments} gaps={proseGaps} onChange={vi.fn()} />);

    await user.click(gap("gr"));
    await user.keyboard("o3x");
    expect(gap("gr").value).toBe("o3x");
  });
});
