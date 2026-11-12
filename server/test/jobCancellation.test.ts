import { describe, expect, it } from "vitest";
import { JobCancellationRegistry } from "../src/services/jobCancellation.js";

describe("JobCancellationRegistry", () => {
  it("propagates a durable cancellation reason to every active child signal", () => {
    const cancellations = new JobCancellationRegistry();
    const first = cancellations.start("job-1");
    const second = cancellations.start("job-1");

    expect(cancellations.cancel("job-1", "user")).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
    expect(first.signal.reason).toMatchObject({ reason: "user" });
    expect(second.signal.reason).toMatchObject({ reason: "user" });
  });

  it("does not let an old child release a newer registration", () => {
    const cancellations = new JobCancellationRegistry();
    const old = cancellations.start("job-1");
    const current = cancellations.start("job-1");
    old.dispose();

    expect(cancellations.cancel("job-1", "shutdown")).toBe(true);
    expect(current.signal.aborted).toBe(true);
  });

  it("returns false when no active work exists and makes disposal idempotent", () => {
    const cancellations = new JobCancellationRegistry();
    const registration = cancellations.start("job-1");
    registration.dispose();
    registration.dispose();
    expect(cancellations.cancel("job-1", "superseded")).toBe(false);
  });
});
