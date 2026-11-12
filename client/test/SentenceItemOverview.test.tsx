import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SentenceItemOverview, { type SentenceOverviewItem } from "../src/components/buildSentence/SentenceItemOverview";

// A Build a Sentence run is ten Items; four is enough to assert every rendering rule and keeps the
// expectations readable. The component is driven entirely by props, so no Drill is rendered here —
// which is the point: the run state that produces these flags is tested elsewhere.
const items = (flags: boolean[]): SentenceOverviewItem[] =>
  flags.map((hasResponse, i) => ({ id: `bas-${i + 1}`, hasResponse }));

const buttons = () => screen.getAllByRole("button");

describe("SentenceItemOverview", () => {
  it("renders one control per Item, numbered in run order", () => {
    render(<SentenceItemOverview items={items([true, false, false, true])} currentIndex={0} onJump={vi.fn()} />);

    expect(buttons()).toHaveLength(4);
    expect(buttons().map((b) => b.textContent)).toEqual(["1", "2", "3", "4"]);
  });

  it("names each control by its Item and whether that Item carries a Response", () => {
    render(<SentenceItemOverview items={items([true, false, false, true])} currentIndex={0} onJump={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Item 1 of 4, carries a Response" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Item 2 of 4, no Response yet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Item 3 of 4, no Response yet" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Item 4 of 4, carries a Response" })).toBeInTheDocument();
  });

  it("renders an Item that carries a Response differently from one that does not", () => {
    render(<SentenceItemOverview items={items([true, false])} currentIndex={0} onJump={vi.fn()} />);

    const withResponse = screen.getByTestId("bas-overview-item-0");
    const without = screen.getByTestId("bas-overview-item-1");
    expect(withResponse.className).not.toEqual(without.className);
    // Filled vs dashed outline, so the distinction survives being read without colour.
    expect(without.className).toContain("border-dashed");
    expect(withResponse.className).not.toContain("border-dashed");
  });

  it("summarises how many Items carry a Response", () => {
    render(<SentenceItemOverview items={items([true, false, false, true])} currentIndex={0} onJump={vi.fn()} />);
    expect(screen.getByText(/2 of 4 carry a Response/)).toBeInTheDocument();
  });

  it("marks the current Item, and only that Item", () => {
    render(<SentenceItemOverview items={items([true, false, false, true])} currentIndex={2} onJump={vi.fn()} />);

    expect(screen.getByTestId("bas-overview-item-2")).toHaveAttribute("aria-current", "true");
    for (const index of [0, 1, 3]) {
      expect(screen.getByTestId(`bas-overview-item-${index}`)).not.toHaveAttribute("aria-current");
    }
    // The current marker is carried independently of carries-a-Response: Item 3 is current and
    // carries no Response, and still reads as carrying no Response.
    expect(screen.getByTestId("bas-overview-item-2").className).toContain("border-dashed");
  });

  it("keeps the current-Item marker distinct from every other control", () => {
    render(<SentenceItemOverview items={items([false, false])} currentIndex={1} onJump={vi.fn()} />);

    const current = screen.getByTestId("bas-overview-item-1");
    const other = screen.getByTestId("bas-overview-item-0");
    expect(current.className).not.toEqual(other.className);
    expect(current.className).toContain("ring-2");
    expect(other.className).not.toContain("ring-2");
  });

  it("renders an Item visited but left empty identically to one never visited", () => {
    // The prop surface admits no third state — an Item is either carrying a Response or not — so
    // this is structural, not a styling coincidence. Item 1 has been visited and left empty (the
    // User has moved on to Item 2); Item 4 has never been reached. They must be indistinguishable,
    // because both commit as empty.
    render(<SentenceItemOverview items={items([false, false, false, false])} currentIndex={1} onJump={vi.fn()} />);

    const visitedButEmpty = screen.getByTestId("bas-overview-item-0");
    const neverVisited = screen.getByTestId("bas-overview-item-3");
    expect(visitedButEmpty.className).toEqual(neverVisited.className);
    expect(visitedButEmpty.getAttribute("aria-label")).toEqual("Item 1 of 4, no Response yet");
    expect(neverVisited.getAttribute("aria-label")).toEqual("Item 4 of 4, no Response yet");
  });

  it("reports the selected Item through onJump and navigates nowhere itself", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(<SentenceItemOverview items={items([true, false, false, true])} currentIndex={0} onJump={onJump} />);

    await user.click(screen.getByRole("button", { name: "Item 3 of 4, no Response yet" }));
    expect(onJump).toHaveBeenCalledExactlyOnceWith(2);

    await user.click(screen.getByRole("button", { name: "Item 4 of 4, carries a Response" }));
    expect(onJump).toHaveBeenLastCalledWith(3);
  });

  it("reports a jump to the Item the User is already on rather than disabling it", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(<SentenceItemOverview items={items([false, false])} currentIndex={1} onJump={onJump} />);

    const current = screen.getByTestId("bas-overview-item-1");
    expect(current).toBeEnabled();
    await user.click(current);
    expect(onJump).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("is reachable and operable by keyboard alone", async () => {
    const user = userEvent.setup();
    const onJump = vi.fn();
    render(<SentenceItemOverview items={items([true, false, false, true])} currentIndex={0} onJump={onJump} />);

    await user.tab();
    expect(screen.getByTestId("bas-overview-item-0")).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(screen.getByTestId("bas-overview-item-2")).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(onJump).toHaveBeenLastCalledWith(2);

    await user.keyboard(" ");
    expect(onJump).toHaveBeenLastCalledWith(2);
    expect(onJump).toHaveBeenCalledTimes(2);
  });
});
