import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ScoringJobDetailVM } from "@toefl-prep/shared";
import ScoringProgress from "../src/components/ScoringProgress";
import { projectScoringJob, type ScoringJobProjection } from "../src/hooks/useScoringJob";

// A finished scoring job's progress names no provider (the server drops the fields when the job
// ends). Opening a finished job fresh must still draw its checkpoints in words, with no provider
// label and nothing reading "undefined".

const FRESH: ScoringJobProjection = {
  itemIds: null,
  status: "starting",
  stage: null,
  judgesDone: [],
  judgesFailed: [],
  openaiJudgeProvider: null,
  arbiterProvider: null,
  fallbackFrom: null,
  queuePosition: null,
  error: null,
  result: null,
  cancellationRequestedAt: null,
  terminalAt: null,
  cancellationReason: null,
};

function finished(over: Partial<ScoringJobDetailVM>) {
  const snapshot: ScoringJobDetailVM = {
    jobId: "job-1",
    taskType: "email",
    itemIds: ["email-1"],
    stage: "persisting",
    status: "done",
    progress: { judgesDone: ["openai", "gemini"], judgesFailed: [] },
    result: {},
    ...over,
  };
  return { ...projectScoringJob(FRESH, { phase: "polling", snapshot, startError: null }), elapsedMs: 0, retry: () => {} };
}

describe("a finished scoring job opened fresh", () => {
  it("shows each Judge as done, with no provider and nothing undefined", () => {
    const { container } = render(<ScoringProgress job={finished({})} onRetry={() => {}} />);
    expect(screen.getByText("Scored")).toBeTruthy();
    expect(screen.getByText("Gemini done")).toBeTruthy();
    expect(screen.getByText("OpenAI done")).toBeTruthy();
    expect(container.textContent).not.toMatch(/undefined|null|Claude|Codex|HTTP/);
  });

  it("drops the provider a live job showed once the job is done", () => {
    const running: ScoringJobDetailVM = {
      jobId: "job-1",
      taskType: "email",
      itemIds: ["email-1"],
      stage: "aggregating",
      status: "running",
      progress: { judgesDone: ["openai", "gemini"], judgesFailed: [], openaiJudgeProvider: "codex", arbiterProvider: "claude" },
    };
    const live = projectScoringJob(FRESH, { phase: "polling", snapshot: running, startError: null });
    const done = projectScoringJob(live, {
      phase: "polling",
      snapshot: { ...running, stage: "persisting", status: "done", progress: { judgesDone: ["openai", "gemini"], judgesFailed: [] }, result: {} },
      startError: null,
    });
    const { container } = render(<ScoringProgress job={{ ...done, elapsedMs: 0 }} onRetry={() => {}} />);
    expect(screen.getByText("OpenAI done")).toBeTruthy();
    expect(container.textContent).not.toMatch(/Claude|Codex|HTTP/);
  });

  it("shows a failed Judge on a job that ended with one", () => {
    const { container } = render(
      <ScoringProgress job={finished({ progress: { judgesDone: ["gemini"], judgesFailed: ["openai"] } })} onRetry={() => {}} />,
    );
    expect(screen.getByText("OpenAI failed")).toBeTruthy();
    expect(container.textContent).not.toMatch(/undefined|null|Claude|Codex|HTTP/);
  });
});
