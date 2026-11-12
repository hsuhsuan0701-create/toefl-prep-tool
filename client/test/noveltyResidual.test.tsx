import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import GenerationProgress, { type GenerationProgressJob } from "../src/components/GenerationProgress";
import { deriveJobDisplay, noveltyResidualSummary } from "../src/lib/progressUtils";

// Overlap with the existing bank never stops a generation run: the run finishes and says so (ADR
// 0006). These pin the saying-so, the only place a User learns that a Set repeats content they
// already have.

const RESIDUAL = [
  { taskType: "listen_choose", kind: "containment", conflictingSetIds: ["lsn-14659f38"], score: 0.83 },
  { taskType: "conversation", kind: "jaccard", conflictingSetIds: ["lsn-14659f38"], score: 0.71 },
];

// `overrides` is untyped and the whole job is cast, so a case can put any shape on the job the panel
// renders.
function progressProps(overrides: Record<string, unknown> = {}) {
  const job = {
    kind: "listening" as const,
    status: "running" as const,
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
    elapsedMs: 0,
    error: null,
    ...overrides,
  } as GenerationProgressJob;
  return { job, onRetry: () => undefined };
}

describe("novelty residual disclosure", () => {
  it("names the count, the conflicting sets and the kinds — and nothing else", () => {
    const line = noveltyResidualSummary(RESIDUAL);
    expect(line).toContain("2 tolerated overlaps");
    expect(line).toContain("lsn-14659f38");
    expect(line).toContain("containment");
    expect(line).toContain("jaccard");
    // It also has to say the Set is still usable — a warning with no verdict just reads as breakage.
    expect(line).toMatch(/usable/i);
  });

  it("singularises a lone overlap and tolerates one carrying no conflicting set", () => {
    expect(noveltyResidualSummary([{ taskType: "daily_life", kind: "descriptor" }]))
      .toContain("1 tolerated overlap ");
  });

  it("is disclosed while the job runs", () => {
    render(<GenerationProgress {...progressProps({ noveltyResidual: RESIDUAL })} />);
    expect(screen.getByText(/2 tolerated overlaps/)).toBeInTheDocument();
  });

  it("shows nothing at all when Novelty tolerated nothing", () => {
    render(<GenerationProgress {...progressProps()} />);
    expect(screen.queryByText(/tolerated overlap/)).toBeNull();
  });

  it("survives a malformed residual rather than rendering garbage", () => {
    // HTTP JSON is untrusted at runtime and this array is rendered.
    expect(deriveJobDisplay("generating", { noveltyResidual: "not an array" } as never).noveltyResidual)
      .toBeNull();
    expect(deriveJobDisplay("generating", { noveltyResidual: [null, 3, { kind: "jaccard" }] } as never).noveltyResidual)
      .toBeNull();
    expect(deriveJobDisplay("generating", { noveltyResidual: RESIDUAL }).noveltyResidual)
      .toEqual(RESIDUAL);
  });

  it("never carries plan text: only the scrubbed fields survive the wire", () => {
    // planLabel is the Plan's own scenario, topic or title text, which no channel to the UI may
    // carry (scrubDiversityIssues in server/src/services/diversityIssues.ts). Even a payload that
    // carried it must render none of it here.
    const withLabel = [{ ...RESIDUAL[0], planLabel: "notice: a paperless billing notice" }];
    expect(noveltyResidualSummary(withLabel)).not.toContain("paperless");
    render(<GenerationProgress {...progressProps({ noveltyResidual: withLabel })} />);
    expect(screen.queryByText(/paperless/)).toBeNull();
  });
});
