import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { BuildupBankSetVM, BuildupQueueEntryVM } from "@toefl-prep/shared";
import DrillLab from "../src/pages/DrillLab";
import { getBuildupBank, getBuildupQueue } from "../src/lib/api";

// The Drill Lab's two lists name a sentence the way the User counts it, by its place in its Set
// ("Sentence 6"), never by its id, and the practice queue opens on its first few sentences.

vi.mock("../src/lib/api", () => ({
  getBuildupQueue: vi.fn(),
  getBuildupBank: vi.fn(),
  getBuildupItem: vi.fn(),
}));

const SEVEN = ["lr-a", "lr-b", "lr-c", "lr-d", "lr-e", "lr-f", "lr-g"];

const bank: BuildupBankSetVM[] = [
  {
    setId: "spk-1",
    scenarioTitle: "Front Office Check-In",
    attempted: true,
    items: SEVEN.map((itemId, i) => ({ itemId, wordCount: 8 + i, preview: `Sentence text ${i + 1}.` })),
  },
];

function queued(n: number): BuildupQueueEntryVM[] {
  return Array.from({ length: n }, (_, i) => ({
    setId: "spk-1",
    itemId: SEVEN[i % SEVEN.length],
    scenarioTitle: "Front Office Check-In",
    wordCount: 12,
    worstScore: 1,
    latestScore: 1,
    repCount: 0,
    latestHeldWords: null,
  }));
}

function renderLab() {
  render(
    <MemoryRouter>
      <DrillLab />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(getBuildupBank).mockResolvedValue(bank);
});

describe("the Drill Lab's lists", () => {
  it("names a queued sentence by its place in its Set, never by its id", async () => {
    vi.mocked(getBuildupQueue).mockResolvedValue([{ ...queued(1)[0], itemId: "lr-f" }]);
    renderLab();
    const row = await screen.findByRole("button", { name: "Practise Front Office Check-In, sentence 6" });
    expect(row).toHaveTextContent("Sentence 6");
    expect(screen.queryByText(/lr-f/)).toBeNull();
  });

  it("numbers the bank's sentences in Set order", async () => {
    vi.mocked(getBuildupQueue).mockResolvedValue([]);
    const user = userEvent.setup();
    renderLab();
    await user.click(await screen.findByRole("button", { name: /Front Office Check-In/ }));
    const rows = screen.getAllByText(/^Sentence text \d\.$/).map((el) => el.closest("li")!);
    expect(within(rows[2]).getByText("3")).toBeInTheDocument();
    expect(screen.queryByText(/^lr-/)).toBeNull();
  });

  it("opens the queue on its first ten sentences and shows the rest on request", async () => {
    vi.mocked(getBuildupQueue).mockResolvedValue(queued(14));
    const user = userEvent.setup();
    renderLab();
    const list = await screen.findByRole("list", { name: "Practice queue" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(10);
    await user.click(screen.getByRole("button", { name: "Show all 14 sentences" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(14);
  });
});
