import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GenerationBatchDetailVM } from "@toefl-prep/shared";

const api = vi.hoisted(() => ({
  startGenerateBatch: vi.fn(),
  getGenerateBatchJob: vi.fn(),
  cancelGenerateBatch: vi.fn(),
}));

vi.mock("../src/lib/api", () => api);

import { useGenerationBatch } from "../src/hooks/useGenerationBatch";

describe("useGenerationBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.startGenerateBatch.mockResolvedValue({ jobId: "batch-1" });
  });

  it("exposes ordered active children, lifecycle counts, IDs, and cancellation metadata", async () => {
    const response: GenerationBatchDetailVM = {
      jobId: "batch-1",
      kind: "batch",
      status: "running",
      total: 4,
      queued: 1,
      activeCount: 2,
      completed: 1,
      failed: 0,
      cancelled: 0,
      cancelRequested: true,
      cancellationRequestedAt: "2026-08-13T10:00:00.000Z",
      terminalAt: null,
      cancellationReason: "user",
      active: [
        { jobId: "child-4", setIndex: 3, kind: "reading", stage: "planning", progress: null },
        { jobId: "child-2", setIndex: 1, kind: "speaking", stage: "rendering-audio", progress: { done: 2, total: 13 } },
      ],
      activeChildIds: ["child-2", "child-4"],
      current: { jobId: "child-2", setIndex: 1, kind: "speaking", stage: "rendering-audio", progress: { done: 2, total: 13 } },
      children: [],
    };
    api.getGenerateBatchJob.mockResolvedValue(response);

    const { result, unmount } = renderHook(() => useGenerationBatch());
    act(() => result.current.run([{ kind: "writing", count: 4 }]));

    await waitFor(() => expect(result.current.active).toHaveLength(2));
    expect(result.current.active.map(({ jobId }) => jobId)).toEqual(["child-2", "child-4"]);
    expect(result.current).toMatchObject({
      queued: 1,
      activeCount: 2,
      completed: 1,
      failed: 0,
      cancelledCount: 0,
      cancellationRequestedAt: "2026-08-13T10:00:00.000Z",
      terminalAt: null,
      cancellationReason: "user",
    });
    // The response above carries `activeChildIds` (the batch view returns it), and the hook does not
    // re-expose it: `active` already carries the same children with everything a caller renders, so
    // a bare id list would be state nobody reads, re-set on every poll tick.
    expect(result.current).not.toHaveProperty("activeChildIds");
    unmount();
  });
});
