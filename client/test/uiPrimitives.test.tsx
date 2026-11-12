import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { BandFigure } from "../src/ui/BandFigure";
import { Button } from "../src/ui/Button";
import { ConfirmDialog } from "../src/ui/ConfirmDialog";
import { ExamClock } from "../src/ui/ExamShell";
import { AttemptRow, List } from "../src/ui/ListRow";
import { SegmentedControl } from "../src/ui/Segmented";

describe("BandFigure", () => {
  it("renders the CEFR level through CefrLevelNote and marks an estimate as one", () => {
    render(<BandFigure band={4.5} />);
    expect(screen.getByTestId("cefr-level")).toHaveTextContent("B2");
    expect(screen.getByText("estimate")).toBeInTheDocument();
    expect(screen.getByText("out of 6", { exact: false })).toBeInTheDocument();
  });

  it("keeps the estimate word even when asked to hide the tag", () => {
    render(<BandFigure band={5} tag={false} />);
    expect(screen.getByText("estimate")).toBeInTheDocument();
  });

  it("says what is missing instead of inventing a band", () => {
    render(<BandFigure band={null} missing="Score an Email and an Academic Discussion." />);
    expect(screen.getByText("No band yet")).toBeInTheDocument();
    expect(screen.getByText("Score an Email and an Academic Discussion.")).toBeInTheDocument();
    expect(screen.queryByTestId("cefr-level")).toBeNull();
  });
});

describe("ExamClock", () => {
  it("is a timer, and states a low-time threshold in words, not colour alone", () => {
    const { rerender } = render(<ExamClock secondsLeft={724} />);
    expect(screen.getByRole("timer")).toHaveTextContent("12:04");
    expect(screen.queryByText("Under 5 min")).toBeNull();
    rerender(<ExamClock secondsLeft={281} />);
    expect(screen.getByText("Under 5 min")).toBeInTheDocument();
    rerender(<ExamClock secondsLeft={42} />);
    expect(screen.getByText("Under 1 min")).toBeInTheDocument();
    expect(screen.getByText("Under 1 min left.")).toBeInTheDocument();
  });
});

describe("Button", () => {
  it("stays focusable while loading and ignores clicks", () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Submitting
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Submitting" });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("ConfirmDialog", () => {
  it("opens and cancels without showModal (jsdom), naming the act on its button", () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open title="Discard this Attempt?" confirmLabel="Discard" tone="destructive" onConfirm={onConfirm} onCancel={onCancel}>
        <p>This cannot be undone.</p>
      </ConfirmDialog>,
    );
    const dialog = screen.getByRole("dialog", { hidden: true });
    expect(dialog).toHaveAttribute("open");
    // A destructive confirmation starts on the safe choice.
    expect(within(dialog).getByRole("button", { name: "Cancel", hidden: true })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel", hidden: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard", hidden: true }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("SegmentedControl", () => {
  function Harness() {
    const [value, setValue] = useState<"10" | "20" | "all">("10");
    return (
      <SegmentedControl
        label="Trend range"
        value={value}
        onChange={setValue}
        options={[
          { value: "10", label: "Last 10" },
          { value: "20", label: "Last 20" },
          { value: "all", label: "All time" },
        ]}
      />
    );
  }

  it("is one radio group with arrow-key selection", () => {
    render(<Harness />);
    const first = screen.getByRole("radio", { name: "Last 10" });
    expect(first).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Last 20" })).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Last 20" })).toHaveAttribute("aria-checked", "true");
    fireEvent.keyDown(screen.getByRole("radio", { name: "Last 20" }), { key: "End" });
    expect(screen.getByRole("radio", { name: "All time" })).toHaveAttribute("aria-checked", "true");
  });
});

describe("AttemptRow", () => {
  it("names an Attempt by what it was, never by its id, and shows a human status", () => {
    render(
      <MemoryRouter>
        <List>
          <AttemptRow section="writing" mode="drill" setTitle="Request to move a lab session" when="Yesterday, 9:03 PM" to="/attempts/296a8412-e665-496c-a18e-57b7d6dc63d2" status="in_progress" />
        </List>
      </MemoryRouter>,
    );
    expect(screen.getByRole("link", { name: "Writing Drill" })).toBeInTheDocument();
    expect(screen.getByText("Unfinished")).toBeInTheDocument();
    expect(screen.queryByText(/296a8412/)).toBeNull();
    expect(screen.queryByText("in_progress")).toBeNull();
  });
});
