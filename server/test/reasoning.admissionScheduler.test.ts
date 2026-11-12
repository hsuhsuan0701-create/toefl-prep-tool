import { describe, expect, it, vi } from "vitest";
import { deferred } from "./helpers/deferred.js";
import { AdmissionScheduler } from "../src/services/reasoning/admissionScheduler.js";

describe("AdmissionScheduler", () => {
  it("protects the scoring reservation from generation work", async () => {
    const scheduler = new AdmissionScheduler({ capacity: 4, reservedScoring: 1 });
    const blockers = Array.from({ length: 4 }, deferred);
    const started: string[] = [];

    const generation = blockers.map((blocker, index) =>
      scheduler.run({ family: "generation", jobId: `g${index}` }, async () => {
        started.push(`g${index}`);
        await blocker.promise;
      })
    );
    await vi.waitFor(() => expect(started).toHaveLength(3));

    const scoring = scheduler.run({ family: "scoring", jobId: "score" }, async () => {
      started.push("score");
    });
    await scoring;
    expect(started).toEqual(["g0", "g1", "g2", "score"]);

    blockers.forEach(({ resolve }) => resolve());
    await Promise.all(generation);
  });

  it("round-robins jobs within a family while preserving each job's FIFO order", async () => {
    const scheduler = new AdmissionScheduler({ capacity: 1, reservedScoring: 0 });
    const gate = deferred();
    const order: string[] = [];
    const first = scheduler.run({ family: "generation", jobId: "a" }, async () => gate.promise);
    const queued = [
      scheduler.run({ family: "generation", jobId: "a" }, async () => { order.push("a1"); }),
      scheduler.run({ family: "generation", jobId: "a" }, async () => { order.push("a2"); }),
      scheduler.run({ family: "generation", jobId: "b" }, async () => { order.push("b1"); }),
      scheduler.run({ family: "generation", jobId: "b" }, async () => { order.push("b2"); }),
    ];

    gate.resolve();
    await first;
    await Promise.all(queued);
    expect(order).toEqual(["a1", "b1", "a2", "b2"]);
  });

  it("removes aborted queued work without running it", async () => {
    const scheduler = new AdmissionScheduler({ capacity: 1, reservedScoring: 0 });
    const gate = deferred();
    const active = scheduler.run({ family: "scoring", jobId: "active" }, async () => gate.promise);
    const controller = new AbortController();
    const operation = vi.fn();
    const queued = scheduler.run(
      { family: "scoring", jobId: "queued", signal: controller.signal },
      operation
    );
    controller.abort("superseded");

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(operation).not.toHaveBeenCalled();
    expect(scheduler.snapshot().queued.scoring).toBe(0);
    gate.resolve();
    await active;
  });

  it("reports accumulated queue latency when delayed work starts", async () => {
    let now = 100;
    const scheduler = new AdmissionScheduler({ capacity: 1, reservedScoring: 0, now: () => now });
    const gate = deferred();
    const active = scheduler.run({ family: "scoring", jobId: "active" }, () => gate.promise);
    const queued = scheduler.run({ family: "generation", jobId: "queued" }, () => undefined);
    now = 145;
    gate.resolve();
    await Promise.all([active, queued]);
    expect(scheduler.snapshot().queueLatencyMs).toEqual({ count: 2, total: 45, max: 45 });
  });
});
