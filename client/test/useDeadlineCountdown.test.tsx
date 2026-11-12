import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useFakeTimersInTest } from "./fakeTimers";
import { DeadlineClock } from "../src/ui/ExamShell";

// The app's one exam countdown (useDeadlineCountdown, drawn by DeadlineClock for a Reading Module).
// It reads the wall clock on every tick, so a laptop that sleeps through part of a Module loses that
// time as it would on the test, and it fires its expiry once, at the deadline and not before.

describe("an exam clock counting down to a deadline", () => {
  it("expires from wall-clock time even when performance.now() is frozen, as across a system suspend", () => {
    useFakeTimersInTest();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    const frozen = performance.now();
    const perfSpy = vi.spyOn(performance, "now").mockReturnValue(frozen);
    try {
      const onExpire = vi.fn();
      render(<DeadlineClock deadlineMs={Date.now() + 60_000} onExpire={onExpire} label="Time remaining in this Module" />);

      // 90 s pass on the wall clock with no time passing on performance.now(): a 90-second sleep.
      act(() => {
        vi.setSystemTime(new Date(Date.now() + 90_000));
        vi.advanceTimersByTime(200);
      });
      expect(onExpire).toHaveBeenCalledTimes(1);
    } finally {
      perfSpy.mockRestore();
    }
  });

  it("does not fire before the deadline, fires once at it, and reads 0:01 until then", () => {
    useFakeTimersInTest();
    vi.setSystemTime(new Date("2026-08-10T00:00:00.000Z"));
    const onExpire = vi.fn();
    render(<DeadlineClock deadlineMs={Date.now() + 60_000} onExpire={onExpire} label="Time remaining in this Module" />);
    expect(screen.getByRole("timer", { name: "Time remaining in this Module" })).toHaveTextContent("1:00");

    act(() => {
      vi.advanceTimersByTime(59_400);
    });
    expect(onExpire).not.toHaveBeenCalled();
    expect(screen.getByRole("timer")).toHaveTextContent("0:01");

    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
