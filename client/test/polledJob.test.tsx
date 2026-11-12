import { StrictMode } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./deferred";
import { useFakeTimersInTest } from "./fakeTimers";
import type { GenerationBatchDetailVM, GenerationJobDetailVM, ScoringJobDetailVM } from "@toefl-prep/shared";

// The fake-timer suite for the polled-job engine: backoff, cleanup and the stale-retry guard,
// covering all three consumers (scoring, single generation, batch generation) plus the React-free
// core they share.

const api = vi.hoisted(() => ({
  getScoreJob: vi.fn(),
  startGenerate: vi.fn(),
  getGenerateJob: vi.fn(),
  startGenerateBatch: vi.fn(),
  getGenerateBatchJob: vi.fn(),
  cancelGenerateBatch: vi.fn(),
}));

vi.mock("../src/lib/api", () => api);

import { pollUntilTerminal } from "../src/lib/pollJob";
import { usePolledJob, type PolledJobPhase } from "../src/hooks/usePolledJob";
import { useScoringJob } from "../src/hooks/useScoringJob";
import { useGenerationJob } from "../src/hooks/useGenerationJob";
import { useGenerationBatch } from "../src/hooks/useGenerationBatch";

/** Advance fake time inside act(), flushing both timers and the promise continuations they unblock. */
async function tick(ms = 0): Promise<void> {
  await act(async () => {
    await clock.advanceBy(ms);
  });
}

function scoreJob(over: Partial<ScoringJobDetailVM> = {}): ScoringJobDetailVM {
  return { jobId: "job-1", taskType: "write_email", itemIds: [], stage: null, status: "running", progress: null, ...over };
}

function genJob(over: Partial<GenerationJobDetailVM> = {}): GenerationJobDetailVM {
  return { jobId: "gen-1", kind: "writing", status: "running", stage: null, progress: null, ...over };
}

function batchJob(over: Partial<GenerationBatchDetailVM> = {}): GenerationBatchDetailVM {
  return {
    jobId: "batch-1", kind: "batch", status: "running", total: 2, queued: 0, activeCount: 1,
    completed: 0, failed: 0, cancelled: 0, cancelRequested: false,
    active: [], activeChildIds: [], current: null, children: [], ...over,
  };
}

let clock: ReturnType<typeof useFakeTimersInTest>;
beforeEach(() => {
  vi.clearAllMocks();
  clock = useFakeTimersInTest();
});

describe("pollUntilTerminal (the React-free core)", () => {
  it("doubles its wait after each failed poll and drops straight back to the base after a success", async () => {
    const fetchJob = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "done" });

    const finished = pollUntilTerminal<{ status: string }>({
      fetch: fetchJob,
      isTerminal: (snapshot) => snapshot.status === "done",
    });

    await clock.advanceBy(0);
    expect(fetchJob).toHaveBeenCalledTimes(1); // the first poll is immediate

    for (const [wait, expected] of [[3000, 2], [6000, 3]] as const) {
      await clock.advanceBy(wait - 1);
      expect(fetchJob).toHaveBeenCalledTimes(expected - 1);
      await clock.advanceBy(1);
      expect(fetchJob).toHaveBeenCalledTimes(expected);
    }

    // The third poll succeeded (status running), so the next wait is the base 1.5s again, not 12s.
    await clock.advanceBy(1499);
    expect(fetchJob).toHaveBeenCalledTimes(3);
    await clock.advanceBy(1);
    expect(fetchJob).toHaveBeenCalledTimes(4);

    await expect(finished).resolves.toEqual({ status: "done" });
  });

  it("caps the backoff at maxBackoffMs however long the server stays down", async () => {
    const fetchJob = vi.fn().mockRejectedValue(new Error("down"));
    const live = vi.fn(() => true);
    void pollUntilTerminal({ fetch: fetchJob, isTerminal: () => false, shouldContinue: live });

    await clock.advanceBy(0);
    let calls = 1;
    for (const wait of [3000, 6000, 12000, 15000, 15000]) {
      await clock.advanceBy(wait - 1);
      expect(fetchJob).toHaveBeenCalledTimes(calls);
      await clock.advanceBy(1);
      calls += 1;
      expect(fetchJob).toHaveBeenCalledTimes(calls);
    }
    live.mockReturnValue(false);
    await clock.advanceBy(60_000);
    expect(fetchJob).toHaveBeenCalledTimes(calls);
  });

  it("takes its policy as a parameter, so a caller can opt out of backing off entirely", async () => {
    // A flat policy: every wait is the base interval, however many polls fail.
    const fetchJob = vi.fn().mockRejectedValue(new Error("down"));
    void pollUntilTerminal({
      fetch: fetchJob,
      isTerminal: () => false,
      shouldContinue: () => fetchJob.mock.calls.length < 4,
      policy: { intervalMs: 1500, maxBackoffMs: 1500 },
    });

    await clock.advanceBy(0);
    for (const expected of [2, 3, 4]) {
      await clock.advanceBy(1499);
      expect(fetchJob).toHaveBeenCalledTimes(expected - 1);
      await clock.advanceBy(1);
      expect(fetchJob).toHaveBeenCalledTimes(expected);
    }
  });

  it("abandons polling — and only polling — the moment shouldContinue says so", async () => {
    const fetchJob = vi.fn().mockResolvedValue({ status: "running" });
    let live = true;
    const finished = pollUntilTerminal<{ status: string }>({
      fetch: fetchJob,
      isTerminal: (snapshot) => snapshot.status === "done",
      shouldContinue: () => live,
    });

    await clock.advanceBy(0);
    expect(fetchJob).toHaveBeenCalledTimes(1);
    live = false;
    await clock.advanceBy(60_000);
    expect(fetchJob).toHaveBeenCalledTimes(1);
    await expect(finished).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("usePolledJob (the engine's own contract)", () => {
  type Snap = { done: boolean };
  type Projection = { phase: PolledJobPhase; startError: string | null };

  function renderEngine() {
    return renderHook(() => usePolledJob<Snap, Projection>({
      initial: () => ({ phase: "idle", startError: null }),
      // A projection that records what it was told. The engine's `phase` is an input to every
      // consumer's projection, which is how each keeps its own status vocabulary.
      project: (prev, input) => ({ phase: input.phase, startError: input.startError ?? prev.startError }),
      isTerminal: (snapshot) => snapshot.done,
    }));
  }

  it("walks idle → starting → polling → terminal, and hands each phase to the projection", async () => {
    const fetchJob = vi.fn()
      .mockResolvedValueOnce({ done: false })
      .mockResolvedValueOnce({ done: true });
    const { result, unmount } = renderEngine();
    expect(result.current.phase).toBe("idle");
    expect(result.current.projection.phase).toBe("idle");

    act(() => result.current.begin(() => Promise.resolve({ fetch: fetchJob })));
    expect(result.current.projection.phase).toBe("starting");

    await tick();
    expect(result.current.projection.phase).toBe("polling");
    await tick(1500);
    expect(result.current.phase).toBe("terminal");
    expect(result.current.projection.phase).toBe("terminal");
    unmount();
  });

  it("skips 'starting' entirely when a starter hands back its handle synchronously", async () => {
    const fetchJob = vi.fn().mockResolvedValue({ done: true });
    const { result, unmount } = renderEngine();
    act(() => result.current.begin(() => ({ fetch: fetchJob })));
    expect(result.current.projection.phase).toBe("polling"); // never "starting" — no POST happened
    await tick();
    expect(result.current.projection.phase).toBe("terminal");
    unmount();
  });

  it("reports a starter that throws synchronously, in the same tick", () => {
    const { result, unmount } = renderEngine();
    act(() => result.current.begin(() => {
      throw new Error("nothing to restart");
    }));
    expect(result.current.projection).toEqual({ phase: "terminal", startError: "nothing to restart" });
    unmount();
  });

  it("lets a consumer patch the projection for things that are not poll outcomes", async () => {
    const { result, unmount } = renderEngine();
    act(() => result.current.patch((prev) => ({ ...prev, startError: "optimistic" })));
    expect(result.current.projection.startError).toBe("optimistic");
    unmount();
    // A patch after unmount is a no-op rather than a React state-update-on-unmounted warning.
    act(() => result.current.patch((prev) => ({ ...prev, startError: "too late" })));
    expect(result.current.projection.startError).toBe("optimistic");
  });
});

describe("useScoringJob on the engine", () => {
  it("fires its starter exactly once across StrictMode's synthetic double mount", async () => {
    const start = vi.fn().mockResolvedValue({ jobId: "job-1" });
    api.getScoreJob.mockResolvedValue(scoreJob({ status: "done", result: { bands: [] } }));

    const { result, unmount } = renderHook(() => useScoringJob("attempt-1", { start }), { wrapper: StrictMode });
    await tick();

    expect(start).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("done");
    expect(result.current.result).toEqual({ bands: [] });
    unmount();
  });

  it("never turns a failed poll into a user-visible error — it backs off and keeps polling the same job", async () => {
    const start = vi.fn().mockResolvedValue({ jobId: "job-1" });
    api.getScoreJob
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValue(scoreJob({ status: "failed", error: "server restarted mid-job" }));

    const { result, unmount } = renderHook(() => useScoringJob("attempt-1", { start }));
    await tick();
    expect(result.current).toMatchObject({ status: "queued", error: null });

    await tick(3000);
    expect(result.current).toMatchObject({ status: "queued", error: null });

    // Once the server is back, its real status lands, including boot recovery's 'failed'.
    await tick(6000);
    expect(result.current).toMatchObject({ status: "failed", error: "server restarted mid-job" });
    expect(api.getScoreJob).toHaveBeenCalledTimes(3);
    expect(api.getScoreJob.mock.calls).toEqual([
      ["attempt-1", "job-1"], ["attempt-1", "job-1"], ["attempt-1", "job-1"],
    ]);
    unmount();
  });

  it("leaves no timer behind when a page is left mid-job", async () => {
    api.getScoreJob.mockResolvedValue(scoreJob({ status: "running" }));
    const { unmount } = renderHook(() => useScoringJob("attempt-1", { start: vi.fn().mockResolvedValue({ jobId: "job-1" }) }));
    await tick();
    expect(vi.getTimerCount()).toBeGreaterThan(0); // the elapsed ticker plus the next poll's wait

    unmount();
    await tick(60_000);
    // No zombie 1s ticker, and the loop stopped rather than polling a job nobody is watching.
    expect(vi.getTimerCount()).toBe(0);
    expect(api.getScoreJob).toHaveBeenCalledTimes(1);
  });

  it("stops all polling once the job reaches a terminal status", async () => {
    api.getScoreJob.mockResolvedValue(scoreJob({ status: "cancelled", cancellationReason: "superseded" }));
    const { result, unmount } = renderHook(() => useScoringJob("attempt-1", { jobId: "job-9" }));
    await tick();
    expect(result.current.status).toBe("cancelled");

    await tick(60_000);
    expect(api.getScoreJob).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it("re-attaches to a known jobId without a POST, reporting 'queued' from the first frame", async () => {
    const start = vi.fn();
    api.getScoreJob.mockResolvedValue(scoreJob({ status: "running", stage: "judging" }));
    const { result, unmount } = renderHook(() => useScoringJob("attempt-1", { jobId: "job-9", start }));

    expect(result.current.status).toBe("queued");
    await tick();
    expect(start).not.toHaveBeenCalled();
    expect(api.getScoreJob).toHaveBeenCalledWith("attempt-1", "job-9");
    expect(result.current.status).toBe("running");
    unmount();
  });

  it("says so plainly when retry() has no restart handler to call, instead of hanging", async () => {
    api.getScoreJob.mockResolvedValue(scoreJob({ status: "failed", error: "judge unavailable" }));
    const { result, unmount } = renderHook(() => useScoringJob("attempt-1", { jobId: "job-9" }));
    await tick();
    expect(result.current.status).toBe("failed");

    act(() => result.current.retry());
    expect(result.current).toMatchObject({
      status: "failed",
      error: "Can't restart this job — no restart handler was provided.",
    });
    unmount();
  });

  it("never lets a superseded retry's late response clobber the newer job's state", async () => {
    const first = deferred<{ jobId: string }>();
    const second = deferred<{ jobId: string }>();
    const start = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    api.getScoreJob.mockImplementation((_attemptId: string, jobId: string) =>
      Promise.resolve(jobId === "job-2"
        ? scoreJob({ jobId, status: "running", stage: "judging" })
        : scoreJob({ jobId, status: "failed", error: "the abandoned job's failure" })));

    const { result, unmount } = renderHook(() => useScoringJob("attempt-1", { start }));
    await tick();
    expect(result.current.status).toBe("starting");

    act(() => result.current.retry());
    second.resolve({ jobId: "job-2" });
    await tick();
    expect(result.current).toMatchObject({ status: "running", stage: "judging" });

    // The abandoned first POST only now comes back. It must be a silent no-op.
    first.resolve({ jobId: "job-1" });
    await tick();
    expect(result.current).toMatchObject({ status: "running", stage: "judging", error: null });
    expect(api.getScoreJob.mock.calls.map(([, jobId]) => jobId)).not.toContain("job-1");
    unmount();
  });

  it("restarts the elapsed clock on every retry and stops it at the terminal status", async () => {
    const start = vi.fn().mockResolvedValue({ jobId: "job-1" });
    api.getScoreJob.mockResolvedValue(scoreJob({ status: "running" }));
    const { result, unmount } = renderHook(() => useScoringJob("attempt-1", { start }));

    await tick(4000);
    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(3000);

    act(() => result.current.retry());
    expect(result.current.elapsedMs).toBe(0);

    api.getScoreJob.mockResolvedValue(scoreJob({ status: "done" }));
    await tick(2000);
    const frozenAt = result.current.elapsedMs;
    await tick(30_000);
    expect(result.current.elapsedMs).toBe(frozenAt); // terminal — the ticker is gone
    unmount();
  });
});

describe("useGenerationJob on the engine", () => {
  it("keeps polling the same job through transient failures, then reports the real outcome", async () => {
    api.startGenerate.mockResolvedValue({ jobId: "gen-1" });
    api.getGenerateJob
      .mockRejectedValueOnce(new Error("Failed to fetch"))
      .mockResolvedValue(genJob({ status: "done", setId: "wri-abc", stage: "saving" }));

    const { result, unmount } = renderHook(() => useGenerationJob());
    expect(result.current.status).toBe("idle");

    act(() => result.current.run("writing"));
    expect(result.current).toMatchObject({ status: "starting", kind: "writing" });

    await tick();
    expect(result.current).toMatchObject({ status: "queued", error: null });
    await tick(3000);
    expect(result.current).toMatchObject({ status: "done", setId: "wri-abc", error: null });
    expect(api.getGenerateJob.mock.calls).toEqual([["gen-1"], ["gen-1"]]);
    unmount();
  });

  it("re-runs the same kind AND the same supersedesSetId on retry()", async () => {
    api.startGenerate.mockResolvedValue({ jobId: "gen-1" });
    api.getGenerateJob.mockResolvedValue(genJob({ kind: "reading", status: "failed", error: "verification failed" }));

    const { result, unmount } = renderHook(() => useGenerationJob());
    act(() => result.current.run("reading", { supersedesSetId: "rea-old" }));
    await tick();
    expect(result.current.status).toBe("failed");

    act(() => result.current.retry());
    await tick();
    expect(api.startGenerate).toHaveBeenCalledTimes(2);
    expect(api.startGenerate.mock.calls[1]).toEqual(["reading", { supersedesSetId: "rea-old" }]);
    unmount();
  });

  it("surfaces a failed POST as a failed job, and retry() before any run() does nothing", async () => {
    api.startGenerate.mockRejectedValue(new Error("503 Service Unavailable"));
    const { result, unmount } = renderHook(() => useGenerationJob());

    act(() => result.current.retry());
    expect(result.current.status).toBe("idle");
    expect(api.startGenerate).not.toHaveBeenCalled();

    act(() => result.current.run("speaking"));
    await tick();
    expect(result.current).toMatchObject({ status: "failed", error: "503 Service Unavailable" });
    expect(api.getGenerateJob).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });

  it("leaves no timer behind when the dashboard is left mid-generation", async () => {
    api.startGenerate.mockResolvedValue({ jobId: "gen-1" });
    api.getGenerateJob.mockResolvedValue(genJob({ status: "running", stage: "generating" }));
    const { result, unmount } = renderHook(() => useGenerationJob());
    act(() => result.current.run("writing"));
    await tick();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    await tick(60_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(api.getGenerateJob).toHaveBeenCalledTimes(1);
  });
});

describe("useGenerationBatch on the engine", () => {
  it("shows the requested total immediately, then whatever the batch reports", async () => {
    api.startGenerateBatch.mockResolvedValue({ jobId: "batch-1" });
    api.getGenerateBatchJob.mockResolvedValue(batchJob({ total: 3, queued: 3, activeCount: 0 }));

    const { result, unmount } = renderHook(() => useGenerationBatch());
    act(() => result.current.run([{ kind: "writing", count: 2 }, { kind: "reading", count: 1 }]));
    expect(result.current).toMatchObject({ status: "starting", total: 3 });

    await tick();
    expect(result.current).toMatchObject({ status: "running", total: 3, queued: 3 });
    unmount();
  });

  it("flips cancelRequested optimistically and lets the next poll confirm it", async () => {
    api.startGenerateBatch.mockResolvedValue({ jobId: "batch-1" });
    api.cancelGenerateBatch.mockResolvedValue(batchJob());
    api.getGenerateBatchJob.mockResolvedValue(batchJob({ cancelRequested: false }));

    const { result, unmount } = renderHook(() => useGenerationBatch());
    act(() => result.current.run([{ kind: "writing", count: 2 }]));
    await tick();
    expect(result.current.cancelRequested).toBe(false);

    act(() => result.current.cancel());
    expect(result.current.cancelRequested).toBe(true); // no round trip waited on
    expect(api.cancelGenerateBatch).toHaveBeenCalledWith("batch-1");

    // ...and the next poll is the source of truth, correcting an optimistic flip if need be.
    api.getGenerateBatchJob.mockResolvedValue(batchJob({ cancelRequested: true, status: "cancelled" }));
    await tick(1500);
    expect(result.current).toMatchObject({ cancelRequested: true, status: "cancelled" });
    unmount();
  });

  it("advances each running child's own elapsed time from the engine's single ticker", async () => {
    api.startGenerateBatch.mockResolvedValue({ jobId: "batch-1" });
    api.getGenerateBatchJob.mockResolvedValue(batchJob({
      active: [{ jobId: "child-1", setIndex: 0, kind: "writing", stage: "generating", progress: null }],
    }));

    const { result, unmount } = renderHook(() => useGenerationBatch());
    act(() => result.current.run([{ kind: "writing", count: 2 }]));
    await tick();
    expect(result.current.active[0]?.elapsedMs ?? -1).toBeLessThan(1000);

    await tick(5000);
    expect(result.current.elapsedMs).toBeGreaterThanOrEqual(5000);
    expect(result.current.active[0]?.elapsedMs ?? 0).toBeGreaterThanOrEqual(4000);

    // A child that appears later starts its own clock from zero, not the batch's.
    api.getGenerateBatchJob.mockResolvedValue(batchJob({
      active: [{ jobId: "child-2", setIndex: 1, kind: "reading", stage: "planning", progress: null }],
    }));
    await tick(1500);
    expect(result.current.active.map(({ jobId }) => jobId)).toEqual(["child-2"]);
    expect(result.current.active[0]?.elapsedMs).toBe(0);
    unmount();
  });

  it("never lets a superseded run's late poll clobber the newer batch, and leaves no timer behind", async () => {
    const first = deferred<{ jobId: string }>();
    api.startGenerateBatch
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ jobId: "batch-2" });
    api.getGenerateBatchJob.mockImplementation((batchId: string) =>
      Promise.resolve(batchId === "batch-2"
        ? batchJob({ jobId: batchId, total: 1, status: "running" })
        : batchJob({ jobId: batchId, total: 9, status: "failed" })));

    const { result, unmount } = renderHook(() => useGenerationBatch());
    act(() => result.current.run([{ kind: "writing", count: 9 }]));
    await tick();
    expect(result.current.status).toBe("starting");

    act(() => result.current.run([{ kind: "reading", count: 1 }]));
    await tick();
    expect(result.current).toMatchObject({ status: "running", total: 1 });

    first.resolve({ jobId: "batch-1" }); // the abandoned batch's POST finally lands
    await tick();
    expect(result.current).toMatchObject({ status: "running", total: 1 });
    expect(api.getGenerateBatchJob.mock.calls.flat()).not.toContain("batch-1");
    // cancel() must target the live batch, never the abandoned one.
    act(() => result.current.cancel());
    expect(api.cancelGenerateBatch).toHaveBeenCalledWith("batch-2");

    unmount();
    await tick(60_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
