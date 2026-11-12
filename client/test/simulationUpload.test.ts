import { describe, expect, it, vi } from "vitest";
import { lostUploadItemIds, uploadUntilSectionEnds, uploadWithRetry } from "../src/pages/simulationUpload";

// A Speaking Simulation is continuous — the User cannot stop and press a retry button mid-run, and
// the exam clock does not pause. So the only place a failed upload can be absorbed is here.
const clock = { now: () => 0, sleep: async () => {} };

/** A virtual clock whose `sleep` parks until the test moves time past it. */
function controllableClock() {
  let now = 0;
  let waiters: Array<{ at: number; resolve: () => void }> = [];
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((resolve) => {
        waiters.push({ at: now + ms, resolve });
      }),
    async advance(ms: number) {
      const target = now + ms;
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      // Step through every wake-up in order, letting each woken chain schedule its next sleep.
      for (;;) {
        const next = waiters.filter((w) => w.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = next.at;
        waiters = waiters.filter((w) => w !== next);
        next.resolve();
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      }
      now = target;
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
    },
  };
}

const retryable = { ok: false as const, kind: "retryable" as const, message: "500" };

describe("uploadWithRetry", () => {
  it("keeps the recording when a transient server failure clears on a later attempt", async () => {
    const upload = vi
      .fn()
      .mockResolvedValueOnce(retryable)
      .mockResolvedValueOnce(retryable)
      .mockResolvedValueOnce({ ok: true, data: {} });

    expect(await uploadWithRetry(upload, clock)).toBe("done");
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it("does not retry a recording the server actually rejected", async () => {
    // HTTP 400 — the bytes really are unusable, so retrying just burns the budget.
    const upload = vi.fn().mockResolvedValue({ ok: false, kind: "needs-rerecord", message: "too short" });

    expect(await uploadWithRetry(upload, clock)).toBe("rejected");
    expect(upload).toHaveBeenCalledOnce();
  });

  it("does not retry once the server has durably accepted the recording", async () => {
    // 202: saved, transcription pending. Retrying would upload the same audio twice.
    const upload = vi.fn().mockResolvedValue({ ok: false, kind: "recovery-pending", message: "saved" });

    expect(await uploadWithRetry(upload, clock)).toBe("recovery-pending");
    expect(upload).toHaveBeenCalledOnce();
  });

  it("reports unsent once one budget is spent", async () => {
    let t = 0;
    const spendingClock = { now: () => t, sleep: async () => { t += 10_000; } };
    const upload = vi.fn().mockResolvedValue(retryable);

    expect(await uploadWithRetry(upload, spendingClock)).toBe("unsent");
    expect(upload.mock.calls.length).toBeGreaterThan(1);
    expect(upload.mock.calls.length).toBeLessThan(10);
  });

  it("treats a thrown network error as retryable too", async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({ ok: true, data: {} });

    expect(await uploadWithRetry(upload, clock)).toBe("done");
  });
});

describe("uploadUntilSectionEnds", () => {
  it("keeps a recording past its first budget, for as long as the section runs", async () => {
    const vclock = controllableClock();
    let serverUp = false;
    const upload = vi.fn(async () => (serverUp ? { ok: true as const, data: {} } : retryable));
    let settled: string | null = null;
    void uploadUntilSectionEnds(upload, vclock, new Promise(() => {})).then((o) => {
      settled = o;
    });

    // Five minutes of server outage, well past one 30 s budget: still held, still being tried.
    await vclock.advance(5 * 60_000);
    expect(settled).toBeNull();
    const triesWhileDown = upload.mock.calls.length;
    expect(triesWhileDown).toBeGreaterThan(5);

    serverUp = true;
    await vclock.advance(20_000);
    expect(settled).toBe("done");
  });

  it("gives an unsent recording one more full budget once the section ends, then reports it", async () => {
    const vclock = controllableClock();
    let end!: () => void;
    const sectionEnded = new Promise<void>((resolve) => {
      end = resolve;
    });
    const upload = vi.fn(async () => retryable);
    let settled: string | null = null;
    void uploadUntilSectionEnds(upload, vclock, sectionEnded).then((o) => {
      settled = o;
    });

    await vclock.advance(45_000);
    expect(settled).toBeNull();

    end();
    const triesAtEnd = upload.mock.calls.length;
    await vclock.advance(10_000);
    expect(settled).toBeNull(); // the final budget is still running
    expect(upload.mock.calls.length).toBeGreaterThan(triesAtEnd);

    await vclock.advance(40_000);
    expect(settled).toBe("unsent");
  });

  it("does not hold a rejected recording at all", async () => {
    const upload = vi.fn().mockResolvedValue({ ok: false, kind: "needs-rerecord", message: "too short" });
    expect(await uploadUntilSectionEnds(upload, clock, new Promise(() => {}))).toBe("rejected");
    expect(upload).toHaveBeenCalledOnce();
  });
});

// This list is the whole of what the server has to go on when it decides whether a missing Item was
// a lost recording (labeled failed, so the Attempt has no Band Estimate) or a deliberate skip
// (scored 0). Over-reporting hides a genuine 0 behind an "infrastructure failure"; under-reporting
// invents a 0 for audio the User spoke.
describe("lostUploadItemIds", () => {
  it("reports only the recordings this browser could not land", () => {
    expect(
      lostUploadItemIds({ "lr-1": "done", "lr-2": "unsent", "lr-3": "recovery-pending", "int-1": "rejected" }),
    ).toEqual(["lr-2", "int-1"]);
  });

  it("never reports a durably-accepted recording still awaiting transcription", () => {
    expect(lostUploadItemIds({ "lr-1": "recovery-pending" })).toEqual([]);
  });

  it("is empty for a clean run — the common case, where every missing item is a genuine skip", () => {
    expect(lostUploadItemIds({ "lr-1": "done", "lr-2": "done" })).toEqual([]);
    expect(lostUploadItemIds({})).toEqual([]);
  });
});
