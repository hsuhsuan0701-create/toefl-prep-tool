import { describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./fakeTimers";
import { act, render, screen } from "@testing-library/react";
import TimedEditor from "../src/components/TimedEditor";

const emailMaterials = {
  id: "em1",
  scenario: "Ask your professor for an extension.",
  to: "prof@uni.edu",
  subject: "Extension request",
  bullets: ["say why", "propose a date", "thank them"],
  timeLimitSec: 420,
  wordGuidance: { min: 80, max: 120 },
};

/** The exam-screen chrome a caller supplies. */
const CHROME = { section: "Writing Drill", part: "Write an Email", exit: <span>exit</span> };

describe("TimedEditor clock", () => {
  // A laptop lid closed mid-essay: the wall clock jumps, but timers and performance.now() do not
  // advance while the machine sleeps. Measured against its own mount the clock would hand that time
  // back; measured against a wall-clock deadline it expires the moment the machine wakes.
  it("counts down against the wall clock, so time spent asleep is not handed back", () => {
    useFakeTimersInTest();
    const onSubmit = vi.fn();
    render(<TimedEditor task="email" materials={emailMaterials} seconds={420} onSubmit={onSubmit} chrome={CHROME} />);

    vi.setSystemTime(Date.now() + 500_000);
    act(() => {
      vi.advanceTimersByTime(250);
    });

    expect(onSubmit).toHaveBeenCalledWith("", 420);
  });

  it("resumes a Task on the deadline it was given, with its draft restored", () => {
    useFakeTimersInTest();
    const deadlineMs = Date.now() + 95_000;
    render(
      <TimedEditor
        task="email"
        materials={emailMaterials}
        seconds={420}
        deadlineMs={deadlineMs}
        initialText="Dear Professor,"
        onSubmit={vi.fn()}
        chrome={CHROME}
      />,
    );

    expect(screen.getByRole("textbox")).toHaveValue("Dear Professor,");
    expect(screen.getByRole("timer")).toHaveTextContent("1:35");
  });
});
