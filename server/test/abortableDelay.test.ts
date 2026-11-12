import { describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./helpers/fakeTimers.js";
import { abortableDelay } from "../src/lib/abortableDelay.js";

describe("abortableDelay", () => {
  // The reason this helper exists. Its retry loops (the Judges', Ears') wait against one abort
  // signal per job, so a listener that outlives its timer leaks one closure per retry for the whole
  // scoring run, and Node warns past ten listeners on a single signal.
  it("leaves no abort listener behind once the timer wins", async () => {
    const clock = useFakeTimersInTest();
    const controller = new AbortController();
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    vi.spyOn(controller.signal, "addEventListener").mockImplementation((type, listener, options) => {
      if (type === "abort") added.push(listener);
      add(type, listener as EventListener, options);
    });
    vi.spyOn(controller.signal, "removeEventListener").mockImplementation((type, listener, options) => {
      if (type === "abort") removed.push(listener);
      remove(type, listener as EventListener, options);
    });

    for (let i = 0; i < 5; i += 1) {
      const waited = abortableDelay(1_000, controller.signal);
      await clock.advanceBy(1_000);
      await waited;
    }

    expect(added).toHaveLength(5);
    expect(removed).toEqual(added);
  });

  it("rejects with the signal's reason when the abort wins, and clears the pending timer", async () => {
    const clock = useFakeTimersInTest();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    const waited = abortableDelay(1_000, controller.signal);
    controller.abort(reason);

    await expect(waited).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects immediately when the signal is already aborted, without arming a timer", async () => {
    const clock = useFakeTimersInTest();
    const reason = new Error("already gone");
    await expect(abortableDelay(1_000, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still resolves when no signal is supplied at all", async () => {
    const clock = useFakeTimersInTest();
    const waited = abortableDelay(1_000);
    await clock.advanceBy(1_000);
    await expect(waited).resolves.toBeUndefined();
  });
});
