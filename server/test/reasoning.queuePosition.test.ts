import { describe, expect, it, vi } from "vitest";
import { AdmissionScheduler } from "../src/services/reasoning/admissionScheduler.js";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

/** Queue position means "requests queued ahead of this one in its family", never "running beside it". */
describe("queue position at a capacity above one", () => {
  it("does not report a request that starts immediately as queued, however many are running", async () => {
    const scheduler = new AdmissionScheduler({ capacity: 4, reservedScoring: 1 });
    const blocker = gate();
    const running = [0, 1, 2].map((index) =>
      scheduler.run({ family: "scoring", jobId: `running-${index}` }, () => blocker.promise));

    const onQueued = vi.fn();
    const started = vi.fn();
    const fourth = scheduler.run({ family: "scoring", jobId: "fourth", onQueued }, started);

    await vi.waitFor(() => expect(started).toHaveBeenCalled());
    expect(onQueued).not.toHaveBeenCalled();
    blocker.open();
    await Promise.all([...running, fourth]);
  });

  it("counts only requests queued ahead once the request has to wait", async () => {
    const scheduler = new AdmissionScheduler({ capacity: 2, reservedScoring: 1 });
    const blocker = gate();
    const running = [0, 1].map((index) =>
      scheduler.run({ family: "scoring", jobId: `running-${index}` }, () => blocker.promise));

    const positions: number[] = [];
    const waiting = ["first", "second", "third"].map((jobId) =>
      scheduler.run({ family: "scoring", jobId, onQueued: (position) => positions.push(position) }, () => undefined));

    expect(positions).toEqual([0, 1, 2]);
    blocker.open();
    await Promise.all([...running, ...waiting]);
  });

  it("reports a generation request held back by the scoring reservation with nothing ahead of it", async () => {
    const scheduler = new AdmissionScheduler({ capacity: 4, reservedScoring: 1 });
    const blocker = gate();
    const running = [0, 1, 2].map((index) =>
      scheduler.run({ family: "generation", jobId: `running-${index}` }, () => blocker.promise));

    const positions: number[] = [];
    const held = scheduler.run(
      { family: "generation", jobId: "held", onQueued: (position) => positions.push(position) },
      () => undefined,
    );

    expect(positions).toEqual([0]);
    blocker.open();
    await Promise.all([...running, held]);
  });
});
