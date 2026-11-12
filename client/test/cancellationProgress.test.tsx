import { render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { GenerationBatchChildVM } from "@toefl-prep/shared";
import BatchGenerationProgress, { type BatchGenerationProgressBatch } from "../src/components/BatchGenerationProgress";
import GenerationProgress, { type GenerationProgressJob } from "../src/components/GenerationProgress";
import ScoringProgress, { type ScoringProgressJob } from "../src/components/ScoringProgress";
import type { CurrentSetDisplay } from "../src/hooks/useGenerationBatch";

// A finished batch links each new Set to its Drill.
const renderInRouter = (ui: ReactElement) => render(ui, { wrapper: MemoryRouter });

const child = (overrides: Partial<GenerationBatchChildVM>): GenerationBatchChildVM => ({
  jobId: "child-1",
  setIndex: 0,
  kind: "writing",
  status: "running",
  stage: "generating",
  progress: null,
  ...overrides,
});

const batch = (
  overrides: Partial<BatchGenerationProgressBatch>,
): BatchGenerationProgressBatch => ({
  status: "running",
  total: 0,
  queued: 0,
  activeCount: 0,
  completed: 0,
  failed: 0,
  cancelledCount: 0,
  cancelRequested: false,
  cancellationRequestedAt: null,
  active: [],
  children: [],
  elapsedMs: 2_000,
  error: null,
  ...overrides,
});

const generationJob = (
  overrides: Partial<GenerationProgressJob>,
): GenerationProgressJob => ({
  kind: "writing",
  status: "running",
  stage: "generating",
  waiting: false,
  provider: null,
  fallbackFrom: null,
  queuePosition: null,
  planningAttempt: null,
  generationAttempt: null,
  maxDiversityAttempts: null,
  audioProgress: null,
  sceneOutcome: null,
  noveltyResidual: null,
  elapsedMs: 1_000,
  error: null,
  ...overrides,
});

const scoringJob = (overrides: Partial<ScoringProgressJob>): ScoringProgressJob => ({
  status: "starting",
  stage: "judging",
  judgesDone: [],
  judgesFailed: [],
  openaiJudgeProvider: null,
  arbiterProvider: null,
  fallbackFrom: null,
  queuePosition: null,
  elapsedMs: 1_000,
  error: null,
  ...overrides,
});

const activeChild = (overrides: Partial<CurrentSetDisplay>): CurrentSetDisplay => ({
  jobId: "child-1",
  setIndex: 0,
  kind: "writing",
  stage: "generating",
  waiting: false,
  provider: null,
  fallbackFrom: null,
  queuePosition: null,
  planningAttempt: null,
  generationAttempt: null,
  maxDiversityAttempts: null,
  audioProgress: null,
  sceneOutcome: null,
  noveltyResidual: null,
  elapsedMs: 1_000,
  ...overrides,
});

describe("cancellable progress", () => {
  it("shows every active batch child in batch-index order with its counts in words", () => {
    renderInRouter(
      <BatchGenerationProgress
        batch={batch({
          total: 5,
          queued: 1,
          activeCount: 2,
          completed: 1,
          failed: 1,
          active: [
            activeChild({ jobId: "child-2", setIndex: 1, kind: "speaking" }),
            activeChild({ jobId: "child-4", setIndex: 3, kind: "reading", stage: "planning" }),
          ],
        })}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("1 ready · 2 in progress · 1 waiting · 1 failed")).toBeInTheDocument();
    const active = screen.getAllByRole("region", { name: /Set (2|4) of 5/ }).map((node) => node.getAttribute("aria-label"));
    expect(active).toEqual(["Set 2 of 5", "Set 4 of 5"]);
  });

  it("distinguishes an accepted cancellation request from terminal cancellation", () => {
    const { rerender } = render(
      <GenerationProgress
        job={generationJob({
          cancellationRequestedAt: "2026-08-13T10:00:00.000Z",
          cancellationReason: "user",
        })}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("Cancellation requested…")).toBeInTheDocument();
    expect(screen.queryByText(/^Cancelled/)).not.toBeInTheDocument();

    rerender(
      <GenerationProgress
        job={generationJob({
          status: "cancelled",
          elapsedMs: 2_000,
          cancellationRequestedAt: "2026-08-13T10:00:00.000Z",
          terminalAt: "2026-08-13T10:00:01.000Z",
          cancellationReason: "user",
        })}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Cancelled by you")).toBeInTheDocument();
  });

  // A batch that published something and then had children cancelled reports 'partial', not
  // 'cancelled', and this is the case where the User needs telling that what already landed is
  // theirs to keep.
  it("explains that a partly-cancelled batch retains already-published Sets", () => {
    renderInRouter(
      <BatchGenerationProgress
        batch={batch({
          status: "partial",
          total: 3,
          completed: 1,
          cancelledCount: 2,
          cancelRequested: true,
          cancellationRequestedAt: "2026-08-13T10:00:00.000Z",
          children: [
            child({ status: "done", setId: "set-published" }),
            child({ jobId: "child-2", setIndex: 1, status: "cancelled" }),
            child({ jobId: "child-3", setIndex: 2, status: "cancelled" }),
          ],
        })}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("The Sets that finished are kept.")).toBeInTheDocument();
    expect(screen.getByText("1 of 3 Sets generated, 2 cancelled.")).toBeInTheDocument();
    expect(screen.getByText("set-published")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Practise it" })).toHaveAttribute("href", "/writing/set-published");
  });

  // The other half of the same distinction: a batch cancelled before anything published still says
  // 'cancelled', and must not claim there are published Sets to retain.
  it("reports a wholly-cancelled batch as cancelled with nothing to retain", () => {
    renderInRouter(
      <BatchGenerationProgress
        batch={batch({
          status: "cancelled",
          total: 2,
          cancelledCount: 2,
          cancelRequested: true,
          cancellationRequestedAt: "2026-08-13T10:00:00.000Z",
          children: [
            child({ status: "cancelled" }),
            child({ jobId: "child-2", setIndex: 1, status: "cancelled" }),
          ],
        })}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("Cancelled — 0 of 2 Sets generated before stopping.")).toBeInTheDocument();
    expect(screen.queryByText("The Sets that finished are kept.")).not.toBeInTheDocument();
  });

  it("counts cancelled children alongside failed ones in a partial batch's summary", () => {
    renderInRouter(
      <BatchGenerationProgress
        batch={batch({
          status: "partial",
          total: 3,
          completed: 1,
          failed: 1,
          cancelledCount: 1,
          children: [
            child({ status: "done", setId: "set-published" }),
            child({ jobId: "child-2", setIndex: 1, status: "failed", error: "route exhausted" }),
            child({ jobId: "child-3", setIndex: 2, status: "cancelled" }),
          ],
        })}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText("1 of 3 Sets generated, 1 failed, 1 cancelled.")).toBeInTheDocument();
    expect(screen.getByText("The Sets that finished are kept.")).toBeInTheDocument();
  });

  it("renders scoring cancellation separately from supersession", () => {
    render(
      <ScoringProgress
        job={scoringJob({
          status: "cancelled",
          cancellationRequestedAt: "2026-08-13T10:00:00.000Z",
          terminalAt: "2026-08-13T10:00:01.000Z",
          cancellationReason: "shutdown",
        })}
        onRetry={vi.fn()}
      />,
    );
    // Nothing replaces a job the shutdown stopped, so it reads as an interruption with a Retry.
    expect(screen.getByText("Scoring was interrupted")).toBeInTheDocument();
    expect(screen.getByText("Cancelled during server shutdown.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry scoring" })).toBeInTheDocument();
  });

  it("describes superseded work in terms of the User's Response", () => {
    const { rerender } = render(
      <ScoringProgress
        job={scoringJob({ status: "cancelled", terminalAt: "2026-08-13T10:00:01.000Z", cancellationReason: "superseded" })}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Cancelled by a newer Response")).toBeInTheDocument();

    rerender(
      <GenerationProgress
        job={generationJob({ status: "cancelled", cancellationReason: "superseded" })}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText("Cancelled by a newer Response")).toBeInTheDocument();
  });
});
