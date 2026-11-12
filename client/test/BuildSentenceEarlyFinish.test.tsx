import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./fakeTimers";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  BUILD_A_SENTENCE_BUDGET_SEC,
  BuildSentenceTask,
  type BuildSentenceItem,
  type BuildSentenceResponse,
  type BuildSentenceRunEnd,
  type BuildSentenceTaskMode,
} from "../src/components/buildSentence";
import { dragTile, installTileDragLayout } from "./buildSentenceDrag";

// Finishing Build a Sentence early ends the pooled clock for good, and an Item with an empty blank
// scores 0. So the Finish button asks first, but only when some Item still has an empty blank, and
// identically in the Drill and the Simulation. A complete arrangement finishes straight away. The
// budget running out never asks: it hands in what is there, exactly once, even with the question
// on screen.

installTileDragLayout();

const items: BuildSentenceItem[] = [
  { id: "bs-1", prompt: "Describe the museum visit.", frame: "The ___ ___ wonderful.", tiles: ["volunteers", "were", "was"] },
  { id: "bs-2", prompt: "Describe the museum.", frame: "The museum ___ ___ crowded.", tiles: ["was", "not", "were"] },
];

function renderTask(mode: BuildSentenceTaskMode, taskItems: BuildSentenceItem[] = items) {
  const completions: { responses: readonly BuildSentenceResponse[]; reason: BuildSentenceRunEnd }[] = [];
  const onComplete = vi.fn((responses: readonly BuildSentenceResponse[], reason: BuildSentenceRunEnd) => {
    completions.push({ responses, reason });
  });
  render(
    <BuildSentenceTask
      items={taskItems}
      mode={mode}
      onComplete={onComplete}
      chrome={{ section: "Writing", exit: <span>exit</span> }}
    />,
  );
  return { completions, onComplete };
}

/** The confirmation, if it is open. jsdom has no showModal, so the dialog is queried as hidden. */
const dialog = () => {
  const element = screen.queryByRole("dialog", { hidden: true });
  return element?.hasAttribute("open") ? element : null;
};

async function finish(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Finish Build a Sentence" }));
}

describe.each<BuildSentenceTaskMode>(["drill", "simulation"])("finishing Build a Sentence early (%s mode)", (mode) => {
  beforeEach(() => {
    useFakeTimersInTest({ shouldAdvanceTime: true });
  });

  it("finishes straight away when every Item's blanks are filled", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { completions, onComplete } = renderTask(mode);
    await screen.findByText("Describe the museum visit.");

    await dragTile(user, "volunteers", { blank: 0 });
    await dragTile(user, "were", { blank: 1 });
    await user.click(screen.getByRole("button", { name: /^Next/ }));
    await screen.findByText("Describe the museum.");
    await dragTile(user, "was", { blank: 0 });
    await dragTile(user, "not", { blank: 1 });

    await finish(user);

    expect(dialog()).toBeNull();
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(completions[0].reason).toBe("finished-early");
  });

  it("asks first when Items still have empty blanks, naming how many and that they score 0", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { completions, onComplete } = renderTask(mode);
    await screen.findByText("Describe the museum visit.");

    await dragTile(user, "volunteers", { blank: 0 });
    await dragTile(user, "were", { blank: 1 });
    await finish(user);

    // Nothing is handed in yet: the question comes first.
    expect(onComplete).not.toHaveBeenCalled();
    const asked = dialog();
    expect(asked).not.toBeNull();
    expect(asked).toHaveTextContent("1 of 2 Items still has an empty blank");
    expect(asked).toHaveTextContent(/score 0/);

    await user.click(within(asked!).getByRole("button", { name: "Finish and hand in", hidden: true }));

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(completions[0].reason).toBe("finished-early");
    expect(completions[0].responses).toEqual([
      { itemId: "bs-1", tileOrder: ["volunteers", "were"] },
      { itemId: "bs-2", tileOrder: [] },
    ]);
  });

  it("counts an Item with some blanks filled and one empty as incomplete", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTask(mode);
    await screen.findByText("Describe the museum visit.");

    await dragTile(user, "volunteers", { blank: 0 });
    await finish(user);

    expect(dialog()).toHaveTextContent("2 of 2 Items still have an empty blank");
  });

  it("goes back to the Task, clock still running, when the User keeps working", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onComplete } = renderTask(mode);
    await screen.findByText("Describe the museum visit.");

    await finish(user);
    await user.click(within(dialog()!).getByRole("button", { name: "Keep working", hidden: true }));

    expect(dialog()).toBeNull();
    expect(onComplete).not.toHaveBeenCalled();
    // Still answerable: the Task is running exactly as before the question.
    await user.click(screen.getByRole("button", { name: /^Next/ }));
    expect(await screen.findByText("Describe the museum.")).toBeInTheDocument();
  });

  it("hands in once, without asking, when the budget runs out with the question on screen", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { completions, onComplete } = renderTask(mode);
    await screen.findByText("Describe the museum visit.");

    await dragTile(user, "volunteers", { blank: 0 });
    await finish(user);
    expect(dialog()).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime((BUILD_A_SENTENCE_BUDGET_SEC + 2) * 1000);
    });

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(completions[0].reason).toBe("budget-expired");
    expect(dialog()).toBeNull();
  });

  it("never asks on account of a frameless Item, which has no blanks to fill", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onComplete } = renderTask(mode, [
      { id: "bs-old", prompt: "An Item from a Set made before sentence frames existed.", tiles: ["The volunteers", "were", "wonderful."] },
    ]);
    await screen.findByText(/This Item has no sentence frame/);

    await finish(user);

    expect(dialog()).toBeNull();
    expect(onComplete).toHaveBeenCalledTimes(1);
  });
});
