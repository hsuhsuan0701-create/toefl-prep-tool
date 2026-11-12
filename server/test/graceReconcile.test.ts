import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./helpers/fakeTimers.js";
import { scheduleGraceReconcile, type GraceReconcileTarget } from "../src/services/speakingFinalization.js";

// The grace re-reconcile is speaking finalization's retry policy: a capture-finished Attempt whose
// reconcile was refused the orphan heal inside ORPHAN_HEAL_GRACE_MS gets one delayed pass. These
// tests drive it with fake timers against a one-method object, with no HTTP, database or route.
//
// The margin is module-private in speakingFinalization.ts and restated here on purpose. Asserting
// the timing directly (nothing fires at the margin itself, the reconcile fires one second past it)
// pins what the delay exists for: the pass lands strictly outside the window that refused the heal,
// so it is never declined twice for the same reason.
const ORPHAN_HEAL_GRACE_MS = 30_000;

function fakeFinalization() {
  const reconcileAttempt = vi.fn(async (_attemptId: string) => {});
  return { reconcileAttempt } satisfies GraceReconcileTarget;
}

describe("scheduleGraceReconcile", () => {
  let clock: ReturnType<typeof useFakeTimersInTest>;
  beforeEach(() => { clock = useFakeTimersInTest(); });

  it("does not reconcile immediately, nor anywhere inside the orphan-heal grace window", async () => {
    const finalization = fakeFinalization();

    scheduleGraceReconcile(finalization, "att-1");

    expect(finalization.reconcileAttempt).not.toHaveBeenCalled();
    await clock.advanceBy(ORPHAN_HEAL_GRACE_MS);
    // Firing at the margin would leave the pass open to refusal for the same reason.
    expect(finalization.reconcileAttempt).not.toHaveBeenCalled();
  });

  it("reconciles once the marker is necessarily older than the grace margin", async () => {
    const finalization = fakeFinalization();

    scheduleGraceReconcile(finalization, "att-1");
    await clock.advanceBy(ORPHAN_HEAL_GRACE_MS + 1_000);

    expect(finalization.reconcileAttempt).toHaveBeenCalledTimes(1);
    expect(finalization.reconcileAttempt).toHaveBeenCalledWith("att-1");
  });

  it("is one-shot: it never re-arms itself into a poll loop", async () => {
    const finalization = fakeFinalization();

    scheduleGraceReconcile(finalization, "att-1");
    await clock.advanceBy(10 * 60_000);

    expect(finalization.reconcileAttempt).toHaveBeenCalledTimes(1);
  });

  it("at most ONE pending timer per attempt, however many times a client re-posts", async () => {
    const finalization = fakeFinalization();

    // The shape a polling client produces: repeated capture-finished 202s while it waits.
    for (let i = 0; i < 5; i += 1) {
      scheduleGraceReconcile(finalization, "att-1");
      await clock.advanceBy(1_000);
    }
    await clock.advanceBy(ORPHAN_HEAL_GRACE_MS + 1_000);

    expect(finalization.reconcileAttempt).toHaveBeenCalledTimes(1);
  });

  it("re-arms after the pending timer has fired", async () => {
    const finalization = fakeFinalization();

    scheduleGraceReconcile(finalization, "att-1");
    await clock.advanceBy(ORPHAN_HEAL_GRACE_MS + 1_000);
    scheduleGraceReconcile(finalization, "att-1");
    await clock.advanceBy(ORPHAN_HEAL_GRACE_MS + 1_000);

    expect(finalization.reconcileAttempt).toHaveBeenCalledTimes(2);
  });

  it("keeps one timer PER ATTEMPT — one attempt's pending timer never suppresses another's", async () => {
    const finalization = fakeFinalization();

    scheduleGraceReconcile(finalization, "att-1");
    scheduleGraceReconcile(finalization, "att-2");
    await clock.advanceBy(ORPHAN_HEAL_GRACE_MS + 1_000);

    expect(finalization.reconcileAttempt.mock.calls.map(([id]) => id).sort()).toEqual(["att-1", "att-2"]);
  });

  it("keeps one timer PER FINALIZER — two wirings in one process never share suppression state", async () => {
    // The pending-timer map is module-level, so an Attempt-id key alone would let one finalizer's
    // timer (one test's, or one mount's) silence another's for the same Attempt id.
    const first = fakeFinalization();
    const second = fakeFinalization();

    scheduleGraceReconcile(first, "att-1");
    scheduleGraceReconcile(second, "att-1");
    await clock.advanceBy(ORPHAN_HEAL_GRACE_MS + 1_000);

    expect(first.reconcileAttempt).toHaveBeenCalledTimes(1);
    expect(second.reconcileAttempt).toHaveBeenCalledTimes(1);
  });

  it("swallows a reconcile rejection, logging only a bounded safe descriptor and never the error value", async () => {
    const secret = "postgres://user:hunter2@db.internal/records";
    const finalization: GraceReconcileTarget = {
      reconcileAttempt: vi.fn(async () => { throw new Error(`connect failed ${secret}`); }),
    };
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    scheduleGraceReconcile(finalization, "att-1");
    // An unhandled rejection here would fail the process, not just this test.
    await clock.advanceBy(ORPHAN_HEAL_GRACE_MS + 1_000);

    const rendered = JSON.stringify(errorLog.mock.calls);
    expect(rendered).toContain("delayed capture reconcile failed");
    // safeErrorDescriptor renders the error's name (plus any `code`), never its message, which is
    // the field that tends to quote its input.
    expect(rendered).toContain("Error");
    expect(rendered).not.toContain("hunter2");
    expect(rendered).not.toContain("connect failed");
    errorLog.mockRestore();
  });

  it("does not keep the process alive on its own", async () => {
    const finalization = fakeFinalization();
    const unref = vi.fn();
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((() => ({ unref })) as unknown as typeof setTimeout);

    scheduleGraceReconcile(finalization, "att-unref");

    expect(unref).toHaveBeenCalledTimes(1);
    setTimeoutSpy.mockRestore();
  });
});
