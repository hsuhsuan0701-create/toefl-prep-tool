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
import { dragTile, dragTilesIntoBlanks, installTileDragLayout } from "./buildSentenceDrag";

// The owning Build a Sentence task module. Callers hand in the Items and receive the Responses; the
// pooled budget, the Frame slot filling, the tile state, navigation, the Item overview and the
// expiry commit all live in here. Asking before a reload is the page's leave guard, asserted with
// the pages (drillLeaveGuard.test.tsx, WritingSimulation.test.tsx).
//
// This file is where the pooled-budget behaviours are asserted, once. The Writing Drill and the
// Writing Simulation tests cover each page's side of the hand-off: how it introduces the Task, and
// what it does with the Responses out.
//
// The reducer underneath has its own tests (buildSentenceRun.test.ts) covering every transition
// without rendering anything, including the standing guard that the budget is derived from nothing
// on the Item. What is worth asserting here is what only a mounted run can get wrong: one clock for
// the whole Task, an Item returned to still showing what it was left with, both endings committing
// through the same path, and the guard that stops a reload destroying an arranged run.

// Tiles are placed by dragging and by nothing else, so every arrangement below is built by a real
// drag over the synthetic layout this installs. See test/buildSentenceDrag.ts.
installTileDragLayout();

/** The two Items every behaviour test below runs on, in Set order. */
const items: BuildSentenceItem[] = [
  { id: "bs-1", prompt: "Describe the museum visit.", frame: "The ___ ___ wonderful.", tiles: ["volunteers", "were", "was"] },
  { id: "bs-2", prompt: "Describe the museum.", frame: "The museum ___ ___ crowded.", tiles: ["was", "not", "were"] },
];

type Completion = { responses: readonly BuildSentenceResponse[]; reason: BuildSentenceRunEnd };

function renderTask(mode: BuildSentenceTaskMode, taskItems: BuildSentenceItem[] = items) {
  const completions: Completion[] = [];
  const onComplete = vi.fn((responses: readonly BuildSentenceResponse[], reason: BuildSentenceRunEnd) => {
    completions.push({ responses, reason });
  });
  render(<BuildSentenceTask items={taskItems} mode={mode} onComplete={onComplete} chrome={CHROME} />);
  return { completions, onComplete };
}

/** The exam-screen chrome the callers supply: the section, where in it, and a way out. */
const CHROME = { section: "Writing", part: "Drill · Build a Sentence", exit: <span>exit</span> };

/**
 * Finishing with an empty blank left asks first (BuildSentenceEarlyFinish.test.tsx pins that
 * question); these tests are about what is committed, so they answer it.
 */
async function finishAndHandIn(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Finish Build a Sentence" }));
  const dialog = screen.getByRole("dialog", { hidden: true });
  await user.click(within(dialog).getByRole("button", { name: "Finish and hand in", hidden: true }));
}

/** The displayed clock as whole seconds, so assertions tolerate sub-second scheduler drift. */
function remainingSeconds(): number {
  const [mm, ss] = (screen.getByRole("timer").textContent ?? "").split(":");
  return Number(mm) * 60 + Number(ss);
}

// Every behaviour below runs in both modes. Build a Sentence behaves identically in the Writing
// Drill and the Writing Simulation because it is one implementation, whose only mode-dependent part
// is the chrome asserted at the bottom of this file.
describe.each<BuildSentenceTaskMode>(["drill", "simulation"])("BuildSentenceTask (%s mode)", (mode) => {
  beforeEach(() => {
    useFakeTimersInTest({ shouldAdvanceTime: true });
  });

  it("opens on ONE budget for the whole Task — not a clock per Item", async () => {
    renderTask(mode);

    expect(await screen.findByText("Describe the museum visit.")).toBeInTheDocument();
    // Exactly one clock exists. No per-Item countdown is drawn anywhere.
    expect(screen.getAllByRole("timer")).toHaveLength(1);
    expect(remainingSeconds()).toBeGreaterThan(BUILD_A_SENTENCE_BUDGET_SEC - 5);
    expect(remainingSeconds()).toBeLessThanOrEqual(BUILD_A_SENTENCE_BUDGET_SEC);
  });

  // `timeLimitSec` is an optional key on the persisted Item schema that the older banked Writing
  // Sets carry on every Build a Sentence Item, so an Item really can arrive with a clock on it. The
  // reducer's own test feeds the same hostile 5; this is the same guard one level up, where an Item
  // is a whole rendered prop rather than an argument.
  it("ignores an Item's own timeLimitSec entirely — a Set of 5 s Items still gets the pooled budget", async () => {
    const hostile = items.map((item) => ({ ...item, timeLimitSec: 5 }));
    renderTask(mode, hostile as BuildSentenceItem[]);

    await screen.findByText("Describe the museum visit.");
    expect(remainingSeconds()).toBeGreaterThan(BUILD_A_SENTENCE_BUDGET_SEC - 5);

    // Well past the Item's own 5 seconds, and the Task has neither expired nor advanced.
    await act(async () => {
      vi.advanceTimersByTime(41_000);
    });
    expect(screen.getByText("Describe the museum visit.")).toBeInTheDocument();
    expect(remainingSeconds()).toBeLessThanOrEqual(BUILD_A_SENTENCE_BUDGET_SEC - 41);
  });

  it("pools the budget across Items: navigating neither restarts the clock nor loses an arrangement", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTask(mode);
    await screen.findByText("Describe the museum visit.");

    await dragTile(user, "volunteers", { blank: 0 });
    await dragTile(user, "were", { blank: 1 });
    expect(screen.getByTestId("bas-overview-item-0")).toHaveAttribute("aria-label", "Item 1 of 2, carries a Response");
    expect(screen.getByTestId("bas-overview-item-1")).toHaveAttribute("aria-label", "Item 2 of 2, no Response yet");
    expect(screen.getByRole("button", { name: "Back" })).toBeDisabled();

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    const afterItemOne = remainingSeconds();
    expect(afterItemOne).toBeLessThanOrEqual(BUILD_A_SENTENCE_BUDGET_SEC - 59);

    // Item 2 inherits the remaining budget, not a fresh clock.
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Describe the museum.");
    expect(remainingSeconds()).toBeLessThanOrEqual(afterItemOne);
    expect(screen.getByLabelText("Blank 1, empty")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();

    // Straight back to Item 1 from the overview: the arrangement is exactly as it was left, and the
    // clock has still never restarted.
    await user.click(screen.getByTestId("bas-overview-item-0"));
    await screen.findByText("Describe the museum visit.");
    expect(screen.getByLabelText('Blank 1, filled with "volunteers"')).toBeInTheDocument();
    expect(screen.getByLabelText('Blank 2, filled with "were"')).toBeInTheDocument();
    expect(remainingSeconds()).toBeLessThanOrEqual(afterItemOne);
  });

  // An Item left with a gap in the middle is the case a Response's lossy wire form cannot
  // represent, and the reason the run holds the per-blank arrangement rather than the tile order.
  it("brings an Item back with the blanks it was left with, not with its tiles shifted left", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderTask(mode);
    await screen.findByText("Describe the museum visit.");

    // Fill both blanks, then empty the first one, leaving a gap before a filled blank 2.
    await dragTile(user, "volunteers", { blank: 0 });
    await dragTile(user, "were", { blank: 1 });
    await dragTile(user, "volunteers", "tray");
    expect(screen.getByLabelText("Blank 1, empty")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Describe the museum.");
    await user.click(screen.getByTestId("bas-overview-item-0"));
    await screen.findByText("Describe the museum visit.");

    expect(screen.getByLabelText("Blank 1, empty")).toBeInTheDocument();
    expect(screen.getByLabelText('Blank 2, filled with "were"')).toBeInTheDocument();
  });

  // A clock counting down while its parent re-renders for unrelated reasons, here every tile
  // placement. The failure ruled out is a Task that force-expires part-way through its own budget.
  it("does not expire early while the clock advances between tile placements", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onComplete } = renderTask(mode);
    await screen.findByText("Describe the museum visit.");

    // 210 seconds of real elapsed time, past the 205 at which a halved budget would expire, with a
    // placement (and so a re-render of the whole screen) between every advance.
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        vi.advanceTimersByTime(35_000);
      });
      // Alternately drags the tile into blank 1 and drags it back to the tray.
      await dragTile(user, "volunteers", i % 2 === 0 ? { blank: 0 } : "tray");
    }

    expect(screen.getByText("Describe the museum visit.")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
    expect(remainingSeconds()).toBeGreaterThan(BUILD_A_SENTENCE_BUDGET_SEC - 215);
    expect(remainingSeconds()).toBeLessThan(BUILD_A_SENTENCE_BUDGET_SEC - 205);

    // …and it does still expire, at its real deadline (210 + 201 = 411 > 410).
    await act(async () => {
      vi.advanceTimersByTime(201_000);
    });
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it("commits what is arranged when the budget expires, once, without force-advancing", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { completions, onComplete } = renderTask(mode);
    await screen.findByText("Describe the museum visit.");

    // Only Item 1 is touched; Item 2 is never reached.
    await dragTile(user, "volunteers", { blank: 0 });

    await act(async () => {
      vi.advanceTimersByTime((BUILD_A_SENTENCE_BUDGET_SEC + 2) * 1000);
    });

    // One commit for the whole Task, carrying every Item in Set order: the arranged one as
    // arranged, the one never reached as empty. Not one commit per Item.
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(completions[0].reason).toBe("budget-expired");
    expect(completions[0].responses).toEqual([
      { itemId: "bs-1", tileOrder: ["volunteers"] },
      { itemId: "bs-2", tileOrder: [] },
    ]);
    // Expiry ends the Task where it stands rather than marching through the remainder.
    expect(screen.queryByText("Describe the museum.")).not.toBeInTheDocument();
  });

  it("finishes early through the same commit path, with budget still on the clock", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { completions, onComplete } = renderTask(mode);
    await screen.findByText("Describe the museum visit.");

    await dragTile(user, "volunteers", { blank: 0 });
    expect(remainingSeconds()).toBeGreaterThan(BUILD_A_SENTENCE_BUDGET_SEC - 10);

    await finishAndHandIn(user);

    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(completions[0].reason).toBe("finished-early");
    // Byte-for-byte what expiry commits, differing only in the recorded reason.
    expect(completions[0].responses).toEqual([
      { itemId: "bs-1", tileOrder: ["volunteers"] },
      { itemId: "bs-2", tileOrder: [] },
    ]);
  });

  it("commits exactly once however hard Finish is pressed", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onComplete } = renderTask(mode);
    await screen.findByText("Describe the museum visit.");

    await finishAndHandIn(user);
    // The run has ended, so there is no Finish left to press a second time.
    expect(screen.queryByRole("button", { name: "Finish Build a Sentence" })).not.toBeInTheDocument();
    await act(async () => {
      vi.advanceTimersByTime((BUILD_A_SENTENCE_BUDGET_SEC + 2) * 1000);
    });

    // A duplicate expiry racing a manual finish is expected, not exceptional: the caller is handed
    // one set of Responses, so it can never score the same Task twice.
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  // "next" clamps on the last Item rather than ending the Task, so a stray Next cannot burn the
  // User's remaining budget: Finish is the one manual way to end it.
  it("clamps at the last Item instead of ending the Task", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onComplete } = renderTask(mode);
    await screen.findByText("Describe the museum visit.");

    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Describe the museum.");
    const next = screen.getByRole("button", { name: "Next" });
    expect(next).toBeDisabled();
    await user.click(next);

    expect(screen.getByText("Describe the museum.")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  // Frames are optional: the Sets banked before frames existed carry none, and those Items must
  // still render rather than stranding the User in front of a blank screen for the whole budget.
  it("still renders a frameless Item, and its way out advances rather than ending the Task", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onComplete } = renderTask(mode, [
      { id: "bs-1", prompt: "Describe the museum visit.", tiles: ["The volunteers", "were", "wonderful."] },
      items[1],
    ]);

    expect(await screen.findByText(/This Item has no sentence frame/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Skip this Item" }));

    expect(await screen.findByText("Describe the museum.")).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });
});

// The three frame shapes the deterministic layer accepts (blanked start, full reorder, fixed
// opening), rendered through the real module both Writing screens mount, so "it renders and is
// answerable in the Drill and in the Simulation" is one claim about one implementation, asserted in
// both modes.
//
// The Items mirror server/test/fixtures/build-a-sentence-reorder-shapes.json, which is where the
// conformance gate and the scorer check the same three shapes. They are restated here rather than
// read from that file because the client suite reads no files at all: the copy is small, and each
// half tests a different thing about it (the server: does it conform and score; here: does it draw).
const REORDER_SHAPES: BuildSentenceItem[] = [
  {
    id: "bas-start-blanked",
    prompt: "What did you ask the department for?",
    frame: "___ ___ ___ ___ ___ ___ the deadline.",
    tiles: ["extend", "we", "the", "asking", "asked", "department", "to"],
  },
  {
    id: "bas-full-reorder",
    prompt: "How much longer do you have?",
    frame: "___ ___ ___ ___ ___ ___ ___ ___ ___.",
    tiles: ["weeks", "our", "extending", "professor", "the", "by", "extended", "deadline", "another", "two"],
  },
  {
    id: "bas-fixed-opening",
    prompt: "Why were you late?",
    frame: "The ___ ___ ___ ___ this morning.",
    tiles: ["bus", "broke down", "on my", "way here", "arrived"],
  },
];

const ANSWERS: Record<string, string[]> = {
  "bas-start-blanked": ["we", "asked", "the", "department", "to", "extend"],
  "bas-full-reorder": ["our", "professor", "extended", "the", "deadline", "by", "another", "two", "weeks"],
  "bas-fixed-opening": ["bus", "broke down", "on my", "way here"],
};

describe.each<BuildSentenceTaskMode>(["drill", "simulation"])(
  "BuildSentenceTask renders the reorder shapes (%s mode)",
  (mode) => {
    beforeEach(() => {
      useFakeTimersInTest({ shouldAdvanceTime: true });
    });

    it("opens a leading-blank frame on the blank itself — no phantom leading text or space", async () => {
      renderTask(mode, [REORDER_SHAPES[0]]);
      await screen.findByText("What did you ask the department for?");

      const frame = screen.getByTestId("bas-frame");
      // Structural, not textual: an empty blank draws its own placeholder space, so "does the text
      // start with a space" cannot tell a phantom leading literal from the blank itself. What must
      // be true is that the frame's first child is the first blank: parseSentenceFrame emits no
      // empty literal ahead of it, and the renderer adds none.
      expect(frame.firstElementChild).toHaveAttribute("data-testid", "bas-blank-0");
      expect(screen.getAllByRole("group")).toHaveLength(6);
      // The fixed tail survives verbatim, on the other side of the blanks.
      expect(frame).toHaveTextContent(/the deadline\.$/);
    });

    it("draws an all-blank frame as blanks and a full stop, and nothing else", async () => {
      renderTask(mode, [REORDER_SHAPES[1]]);
      await screen.findByText("How much longer do you have?");

      const frame = screen.getByTestId("bas-frame");
      expect(frame.firstElementChild).toHaveAttribute("data-testid", "bas-blank-0");
      // Nine blanks for ten tiles, the top of the tile-count range: one distractor.
      expect(screen.getAllByRole("group")).toHaveLength(9);
      expect(screen.getByLabelText("Blank 9, empty")).toBeInTheDocument();
      expect(frame.lastElementChild).toHaveTextContent(".");
      // The only literal text in the whole frame is the punctuation and the spaces between blanks.
      expect((frame.textContent ?? "").replace(/\s/g, "")).toBe(".");
    });

    it("still opens a conventional frame on its fixed word", async () => {
      renderTask(mode, [REORDER_SHAPES[2]]);
      await screen.findByText("Why were you late?");

      const frame = screen.getByTestId("bas-frame");
      expect(frame.firstElementChild).toHaveTextContent("The");
      expect(frame.firstElementChild).not.toHaveAttribute("data-testid");
      expect(screen.getAllByRole("group")).toHaveLength(4);
    });

    it("is answerable in every shape: dragging the tiles into the blanks in order commits that arrangement", async () => {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      const { completions } = renderTask(mode, REORDER_SHAPES);

      for (const item of REORDER_SHAPES) {
        await screen.findByText(item.prompt);
        // Each answer is dragged blank by blank, so for a start-blanked or all-blank frame the very
        // first drag targets blank 0, the slot the sentence itself starts on.
        await dragTilesIntoBlanks(user, ANSWERS[item.id]);
        // Every blank the shape has is now filled, including the first one, which for the first two
        // shapes is the word the sentence starts with.
        expect(screen.queryByLabelText(/, empty$/)).not.toBeInTheDocument();
        if (item !== REORDER_SHAPES.at(-1)) {
          await user.click(screen.getByRole("button", { name: "Next" }));
        }
      }

      await user.click(screen.getByRole("button", { name: "Finish Build a Sentence" }));

      expect(completions[0].responses).toEqual(
        REORDER_SHAPES.map((item) => ({ itemId: item.id, tileOrder: ANSWERS[item.id] })),
      );
    });
  },
);

// The one axis the two call sites differ on. Everything above is identical in both modes; this is
// the whole of what is not.
describe("BuildSentenceTask chrome", () => {
  const promptBeforeOverview = () =>
    Boolean(
      screen
        .getByText("Describe the museum visit.")
        .compareDocumentPosition(screen.getByRole("navigation", { name: "Build a Sentence Items" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    );

  it("drill mode puts the Item overview under the tiles and ends the Task with the primary button", async () => {
    renderTask("drill");
    await screen.findByText("Describe the museum visit.");

    expect(promptBeforeOverview()).toBe(true);
    expect(screen.queryByText(/Finishing hands in every item exactly as it stands/)).not.toBeInTheDocument();
  });

  it("simulation mode puts the overview above the prompt and says what finishing hands in", async () => {
    renderTask("simulation");
    await screen.findByText("Describe the museum visit.");

    expect(promptBeforeOverview()).toBe(false);
    expect(screen.getByText(/Finishing hands in every item exactly as it stands/)).toBeInTheDocument();
  });

  it("draws the caller's section and part over its own Item count and clock", async () => {
    render(
      <BuildSentenceTask
        items={items}
        mode="drill"
        onComplete={vi.fn()}
        chrome={{ section: "Writing", part: "Drill · Task 1 of 3 · Build a Sentence", exit: <span>exit</span> }}
      />,
    );
    expect(await screen.findByText("Drill · Task 1 of 3 · Build a Sentence")).toBeInTheDocument();
    expect(screen.getByText("Item 1 of 2")).toBeInTheDocument();
    expect(screen.getAllByRole("timer")).toHaveLength(1);
  });
});
