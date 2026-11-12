import { describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./helpers/fakeTimers.js";
import { runShutdownProtocol } from "../src/services/shutdownCoordinator.js";

describe("shutdown protocol", () => {
  it("stops admissions, drains, durably cancels remaining work, aborts, and bounds recorder flush", async () => {
    const clock = useFakeTimersInTest();
    const events: string[] = [];
    let active = 1;
    const protocol = runShutdownProtocol({
      stopAdmissions: () => { events.push("stop"); },
      activeCount: () => active,
      persistCancellation: async () => { events.push("persist"); active = 0; },
      abortRemaining: () => { events.push("abort"); },
      flushRecorder: async () => new Promise<void>(() => undefined),
      drainMs: 20,
      recorderFlushMs: 10,
      pollMs: 5,
    });

    await clock.advanceBy(35);
    await protocol;
    expect(events).toEqual(["stop", "persist", "abort"]);
  });
});
