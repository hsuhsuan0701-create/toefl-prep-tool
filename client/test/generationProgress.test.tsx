import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import GenerationProgress, { type GenerationProgressJob } from "../src/components/GenerationProgress";

// What a generation job waiting in its provider's queue says about the queue: how many requests are
// ahead when there are any, and "Waiting for a slot" when nothing is — never "0 requests ahead".

function job(over: Partial<GenerationProgressJob>): GenerationProgressJob {
  return {
    kind: "writing",
    status: "running",
    stage: "generating",
    waiting: true,
    provider: "claude",
    fallbackFrom: null,
    queuePosition: null,
    planningAttempt: null,
    generationAttempt: null,
    maxDiversityAttempts: null,
    audioProgress: null,
    sceneOutcome: null,
    noveltyResidual: null,
    elapsedMs: 0,
    error: null,
    ...over,
  };
}

describe("GenerationProgress queue line", () => {
  it.each([0, null])("reads 'Waiting for a slot' when the queue position is %s", (queuePosition) => {
    render(<GenerationProgress job={job({ queuePosition })} onRetry={vi.fn()} />);
    expect(screen.getByText(/Waiting for a slot/)).toBeInTheDocument();
    expect(screen.queryByText(/requests? ahead/)).toBeNull();
  });

  it("counts the requests ahead when there are some", () => {
    render(<GenerationProgress job={job({ queuePosition: 2 })} onRetry={vi.fn()} />);
    expect(screen.getByText(/2 requests ahead/)).toBeInTheDocument();
    expect(screen.queryByText(/Waiting for a slot/)).toBeNull();
  });

  it("says nothing about a queue when the job is not waiting", () => {
    render(<GenerationProgress job={job({ waiting: false, queuePosition: 0 })} onRetry={vi.fn()} />);
    expect(screen.queryByText(/Waiting for a slot|requests? ahead/)).toBeNull();
  });

  it("counts Speaking clips out of the total the job reports", () => {
    render(<GenerationProgress job={job({ kind: "speaking", waiting: false, stage: "rendering-audio", audioProgress: { done: 9, total: 13 } })} onRetry={vi.fn()} />);
    expect(screen.getByRole("progressbar", { name: "Recording audio" })).toHaveAttribute("aria-valuetext", "9 of 13 clips");
    expect(screen.queryByText(/pace correction/)).toBeNull();
  });
});
