import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { AttemptListItemVM, AttemptListVM } from "@toefl-prep/shared";
import AttemptsFeed from "../src/components/AttemptsFeed";

// An Attempt in the log is named by what it was ("Writing Simulation"), then its Set and when, and
// its outcome is its own Band Estimate — pencilled — or its status in words. Its id is only ever in
// the link.

const UUID = "3f1c2a9e-8b7d-4c1e-9f0a-1b2c3d4e5f60";

function attempt(over: Partial<AttemptListItemVM> = {}): AttemptListItemVM {
  return {
    id: UUID,
    kind: "writing",
    mode: "simulation",
    setId: "wri-787b9d66",
    setTitle: "Order #4127 - damaged panel",
    isRepeat: false,
    status: "completed",
    startedAt: "2026-08-01T10:00:00.000Z",
    completedAt: "2026-08-01T10:20:00.000Z",
    captureFinishedAt: null,
    flagged: false,
    modulePath: null,
    routerRaw: null,
    estimate: null,
    fullTestRun: null,
    ...over,
  };
}

function renderLog(page: AttemptListVM | null, props: Partial<Parameters<typeof AttemptsFeed>[0]> = {}) {
  return render(
    <MemoryRouter>
      <AttemptsFeed attempts={page} onChanged={() => {}} {...props} />
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("an Attempt row", () => {
  it("is named by section and mode, links by id, and never shows the id", () => {
    renderLog({ items: [attempt()], total: 1 });
    const link = screen.getByRole("link", { name: "Writing Simulation" });
    expect(link).toHaveAttribute("href", `/attempts/${UUID}`);
    expect(screen.getByText("Order #4127 - damaged panel")).toBeInTheDocument();
    expect(screen.queryByText(new RegExp(UUID))).toBeNull();
  });

  it("shows its own Band Estimate, pencilled as an estimate with its CEFR level", () => {
    renderLog({ items: [attempt({ estimate: { band: 5, method: "linear-v2" } })], total: 1 });
    const row = screen.getByRole("link", { name: "Writing Simulation" }).closest("li")!;
    expect(within(row).getByText("5")).toBeInTheDocument();
    expect(within(row).getByText("estimate")).toBeInTheDocument();
    expect(within(row).getByText(/C1/)).toBeInTheDocument();
    expect(within(row).queryByText("Completed")).toBeNull();
  });

  it("says its status in words when it has no band", () => {
    renderLog({
      items: [
        attempt({ id: "a1", status: "in_progress", completedAt: null }),
        attempt({ id: "a2", status: "aborted", completedAt: null, kind: "speaking", mode: "drill" }),
        attempt({ id: "a3", kind: "reading", mode: "drill" }),
      ],
      total: 3,
    });
    expect(screen.getByText("Unfinished")).toBeInTheDocument();
    expect(screen.getByText("Discarded")).toBeInTheDocument();
    const drill = screen.getByRole("link", { name: "Reading Drill" }).closest("li")!;
    expect(within(drill).getByText("Completed")).toBeInTheDocument();
    expect(within(drill).getByText("Drills give no band")).toBeInTheDocument();
    expect(screen.queryByText(/in_progress|aborted/)).toBeNull();
  });

  // The flag is raised by a tab switch and by a prompt that would not play alike, so the chip says
  // the Simulation was interrupted and never that the User left.
  it("marks a Repeat and a flagged Simulation as interrupted", () => {
    renderLog({ items: [attempt({ isRepeat: true, flagged: true })], total: 1 });
    expect(screen.getByText("Repeat")).toBeInTheDocument();
    const chip = screen.getByText("Interrupted");
    expect(chip).toHaveAttribute("title", "This Simulation was interrupted: the tab was left, or a prompt would not play.");
    expect(screen.queryByText(/left the tab/i)).toBeNull();
  });

  it("names the Module a routed Reading Simulation took beside its band", () => {
    renderLog({ items: [attempt({ kind: "reading", estimate: { band: 4.5, method: "table3-v1" }, modulePath: "lower" })], total: 1 });
    expect(screen.getByText("Lower Module")).toBeInTheDocument();
  });
});

describe("the log's own states", () => {
  it("shows loading as a busy region, not as an empty log", () => {
    const { container } = renderLog(null);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.queryByText("No Attempts yet")).toBeNull();
  });

  it("says it failed, with a way to try again, and never reads as empty", async () => {
    const onChanged = vi.fn();
    renderLog(null, { error: "Can't reach the server. Is it running?", onChanged });
    expect(screen.getByText("Couldn't load your Attempts")).toBeInTheDocument();
    expect(screen.queryByText("No Attempts yet")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onChanged).toHaveBeenCalled();
  });

  it("says what will fill an empty log", () => {
    renderLog({ items: [], total: 0 });
    expect(screen.getByText("No Attempts yet")).toBeInTheDocument();
  });
});

// The log on the Dashboard and on Progress. A Run never re-sits a section that was finished or
// discarded, so the row of the section a Run in progress is sitting leads back into the Run instead.
describe("an unfinished Attempt that is a Full-Test Run's section", () => {
  it("names the Run and offers to resume it, in place of finishing or discarding", () => {
    renderLog({
      items: [attempt({ kind: "listening", status: "in_progress", completedAt: null, fullTestRun: { id: "run-open", status: "in-progress" } })],
      total: 1,
    });
    const row = screen.getByRole("link", { name: "Listening Simulation" }).closest("li")!;
    expect(within(row).getByText("A section of a Full-Test Run in progress")).toBeInTheDocument();
    expect(within(row).getByRole("link", { name: "Resume the Full-Test Run" })).toHaveAttribute("href", "/full-test/run-open");
    expect(within(row).queryByRole("button", { name: "Finish and score…" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Discard…" })).toBeNull();
  });

  it.each([
    ["belongs to no Run (or a restart replaced it)", null],
    ["belongs to a Run no longer in progress", { id: "run-done", status: "completed" as const }],
  ])("keeps both actions when it %s", (_label, fullTestRun) => {
    renderLog({ items: [attempt({ status: "in_progress", completedAt: null, fullTestRun })], total: 1 });
    expect(screen.getByRole("button", { name: "Finish and score…" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard…" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Resume the Full-Test Run" })).toBeNull();
    expect(screen.queryByText("A section of a Full-Test Run in progress")).toBeNull();
  });
});

describe("acting on an unfinished Attempt", () => {
  it("reports a failed discard on the row and leaves the Attempt listed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "attempt is already completed" }), { status: 409, headers: { "Content-Type": "application/json" } })),
    );
    const onChanged = vi.fn();
    renderLog({ items: [attempt({ status: "in_progress", completedAt: null })], total: 1 }, { onChanged });

    await userEvent.click(screen.getByRole("button", { name: "Discard…" }));
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("attempt is already completed");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Writing Simulation" })).toBeInTheDocument();
  });
});
