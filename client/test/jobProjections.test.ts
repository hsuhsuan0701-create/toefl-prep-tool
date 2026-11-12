import { describe, expect, it } from "vitest";
import type { GenerationBatchDetailVM, GenerationJobDetailVM, ScoringJobDetailVM } from "@toefl-prep/shared";
import { projectScoringJob, type ScoringJobProjection } from "../src/hooks/useScoringJob";
import { projectGenerationJob, type GenerationJobProjection } from "../src/hooks/useGenerationJob";
import { projectGenerationBatch, type GenerationBatchProjection } from "../src/hooks/useGenerationBatch";
import type { PolledJobProjectionInput } from "../src/hooks/usePolledJob";

// The three sticky-merge projections are the only part of each polling hook that decides what the
// UI shows, and they are plain functions of (previous state, one lifecycle update), so they are
// exercised here directly: no renderHook, no act, no timers, no React at all.
//
// Every case below either pins a sticky-merge rule (a poll carrying null progress must not blank
// accumulated state) or proves purity, which is what makes running them inside a React state
// updater safe.

// Deep-freezes an input so any in-place write inside a projection throws (ES modules are strict
// mode). Combined with "the same input twice gives deep-equal output", this is the purity proof.
function frozen<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value as Record<string, unknown>)) frozen(inner);
  }
  return value;
}

function scoringInput(over: Partial<PolledJobProjectionInput<ScoringJobDetailVM>> = {}): PolledJobProjectionInput<ScoringJobDetailVM> {
  return frozen({ phase: "polling", snapshot: null, startError: null, ...over });
}

function scoreJob(over: Partial<ScoringJobDetailVM> = {}): ScoringJobDetailVM {
  return { jobId: "job-1", taskType: "write_email", itemIds: [], stage: null, status: "running", progress: null, ...over };
}

const SCORING_IDLE: ScoringJobProjection = frozen({
  itemIds: null,
  status: "starting",
  stage: null,
  judgesDone: [],
  judgesFailed: [],
  openaiJudgeProvider: null,
  arbiterProvider: null,
  fallbackFrom: null,
  queuePosition: null,
  result: null,
  error: null,
  cancellationRequestedAt: null,
  terminalAt: null,
  cancellationReason: null,
});

describe("projectScoringJob", () => {
  it("maps the engine's lifecycle phases onto the hook's own status union", () => {
    expect(projectScoringJob(SCORING_IDLE, scoringInput({ phase: "starting" })).status).toBe("starting");
    // Reaching "polling" with nothing back yet means a jobId is known, which is 'queued'.
    expect(projectScoringJob(SCORING_IDLE, scoringInput({ phase: "polling" })).status).toBe("queued");
    expect(projectScoringJob(SCORING_IDLE, scoringInput({ phase: "idle" }))).toBe(SCORING_IDLE);
  });

  it("keeps judge badges through the whole arbiter phase, when polls carry no progress at all", () => {
    const judging = projectScoringJob(SCORING_IDLE, scoringInput({
      snapshot: scoreJob({ stage: "judging", progress: { judgesDone: ["gemini"], judgesFailed: ["openai"] } }),
    }));
    expect(judging).toMatchObject({ judgesDone: ["gemini"], judgesFailed: ["openai"], stage: "judging" });

    // The checkpoints after judging carry no Judge detail; the badges must survive them.
    const aggregating = projectScoringJob(frozen(judging), scoringInput({
      snapshot: scoreJob({ stage: "aggregating", progress: null }),
    }));
    expect(aggregating).toMatchObject({ judgesDone: ["gemini"], judgesFailed: ["openai"], stage: "aggregating" });

    const done = projectScoringJob(frozen(aggregating), scoringInput({
      phase: "terminal",
      snapshot: scoreJob({ stage: "persisting", status: "done", progress: null, result: { bands: [] } }),
    }));
    expect(done).toMatchObject({
      status: "done",
      judgesDone: ["gemini"],
      judgesFailed: ["openai"],
      result: { bands: [] },
    });
  });

  it("drops non-string judge names and a fallbackFrom that says nothing", () => {
    const next = projectScoringJob(SCORING_IDLE, scoringInput({
      snapshot: scoreJob({
        stage: "judging",
        progress: {
          judgesDone: ["gemini", 7, null] as unknown as string[],
          judgesFailed: "nope" as unknown as string[],
          arbiterProvider: "claude",
          fallbackFrom: "claude",
          openaiJudgeProvider: "codex",
          queuePosition: 3,
        },
      }),
    }));
    expect(next).toMatchObject({
      judgesDone: ["gemini"],
      judgesFailed: [],
      arbiterProvider: "claude",
      fallbackFrom: null, // "fell back from claude to claude" is not a fallback
      openaiJudgeProvider: "codex",
      queuePosition: 3,
    });
  });

  it("surfaces a terminal failure's message, and a starter failure's message", () => {
    expect(projectScoringJob(SCORING_IDLE, scoringInput({
      phase: "terminal",
      snapshot: scoreJob({ status: "failed" }),
    })).error).toBe("Scoring failed."); // no server message — never a blank error

    expect(projectScoringJob(SCORING_IDLE, scoringInput({
      phase: "terminal",
      snapshot: scoreJob({ status: "failed", error: "arbiter timed out" }),
    })).error).toBe("arbiter timed out");

    expect(projectScoringJob(SCORING_IDLE, scoringInput({
      phase: "terminal",
      startError: "Can't restart this job — no restart handler was provided.",
    }))).toMatchObject({
      status: "failed",
      error: "Can't restart this job — no restart handler was provided.",
    });
  });

  it("is pure: never mutates its input, and repeats itself exactly", () => {
    const input = scoringInput({ snapshot: frozen(scoreJob({ stage: "judging", progress: { judgesDone: ["gemini"] } })) });
    const once = projectScoringJob(SCORING_IDLE, input);
    const twice = projectScoringJob(SCORING_IDLE, input);
    expect(once).toEqual(twice);
    expect(once).not.toBe(SCORING_IDLE);
    expect(SCORING_IDLE.judgesDone).toEqual([]);
  });
});

const GENERATION_IDLE: GenerationJobProjection = frozen({
  status: "idle",
  kind: null,
  stage: null,
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
  setId: null,
  error: null,
  cancellationRequestedAt: null,
  terminalAt: null,
  cancellationReason: null,
});

function genJob(over: Partial<GenerationJobDetailVM> = {}): GenerationJobDetailVM {
  return { jobId: "gen-1", kind: "speaking", status: "running", stage: null, progress: null, ...over };
}

function genInput(over: Partial<PolledJobProjectionInput<GenerationJobDetailVM>> = {}): PolledJobProjectionInput<GenerationJobDetailVM> {
  return frozen({ phase: "polling", snapshot: null, startError: null, ...over });
}

describe("projectGenerationJob", () => {
  it("reports an admission wait without disturbing the stage already reached", () => {
    const generating = projectGenerationJob(GENERATION_IDLE, genInput({ snapshot: genJob({ stage: "generating" }) }));
    expect(generating).toMatchObject({ stage: "generating", waiting: false });

    const queued = projectGenerationJob(frozen(generating), genInput({
      snapshot: genJob({ stage: "queued", progress: { queuePosition: 2, provider: "claude" } }),
    }));
    // The stepper must not un-complete "generating" because one later call is waiting for a slot.
    expect(queued).toMatchObject({ stage: "generating", waiting: true, queuePosition: 2, provider: "claude" });
  });

  it("retains the audio tally, scene outcome, novelty residual and attempt counters across later polls", () => {
    const audio = projectGenerationJob(GENERATION_IDLE, genInput({
      snapshot: genJob({
        stage: "rendering-audio",
        progress: { done: 7, total: 13, planningAttempt: 2, generationAttempt: 3, maxDiversityAttempts: 3 },
      }),
    }));
    expect(audio).toMatchObject({
      audioProgress: { done: 7, total: 13 },
      planningAttempt: 2,
      generationAttempt: 3,
      maxDiversityAttempts: 3,
    });

    const scene = projectGenerationJob(frozen(audio), genInput({
      snapshot: genJob({
        stage: "saving",
        progress: {
          scene: { image: "succeeded", regions: "failed" },
          noveltyResidual: [{ taskType: "listen_to_a_conversation", kind: "conversation" }],
        },
      }),
    }));
    expect(scene).toMatchObject({
      stage: "saving",
      audioProgress: { done: 7, total: 13 },
      planningAttempt: 2,
      generationAttempt: 3,
      sceneOutcome: { image: "succeeded", regions: "failed" },
      noveltyResidual: [{ taskType: "listen_to_a_conversation", kind: "conversation" }],
    });

    // A bare terminal poll carrying no detail at all must still not blank any of it.
    const done = projectGenerationJob(frozen(scene), genInput({
      phase: "terminal",
      snapshot: genJob({ stage: "saving", status: "done", setId: "spk-abc", progress: null }),
    }));
    expect(done).toMatchObject({
      status: "done",
      setId: "spk-abc",
      audioProgress: { done: 7, total: 13 },
      sceneOutcome: { image: "succeeded", regions: "failed" },
      noveltyResidual: [{ taskType: "listen_to_a_conversation", kind: "conversation" }],
    });
  });

  it("maps lifecycle phases and both failure sources onto its own status union", () => {
    expect(projectGenerationJob(GENERATION_IDLE, genInput({ phase: "starting" })).status).toBe("starting");
    expect(projectGenerationJob(GENERATION_IDLE, genInput({ phase: "polling" })).status).toBe("queued");
    expect(projectGenerationJob(GENERATION_IDLE, genInput({
      phase: "terminal",
      snapshot: genJob({ status: "failed" }),
    })).error).toBe("Generation failed.");
    expect(projectGenerationJob(GENERATION_IDLE, genInput({ phase: "terminal", startError: "network down" })))
      .toMatchObject({ status: "failed", error: "network down" });
  });

  it("is pure: never mutates its input, and repeats itself exactly", () => {
    const input = genInput({ snapshot: frozen(genJob({ stage: "rendering-audio", progress: { done: 1, total: 13 } })) });
    expect(projectGenerationJob(GENERATION_IDLE, input)).toEqual(projectGenerationJob(GENERATION_IDLE, input));
    expect(GENERATION_IDLE.audioProgress).toBeNull();
  });
});

const BATCH_IDLE: GenerationBatchProjection = frozen({
  status: "idle",
  total: 0,
  queued: 0,
  activeCount: 0,
  completed: 0,
  failed: 0,
  cancelledCount: 0,
  cancelRequested: false,
  cancellationRequestedAt: null,
  terminalAt: null,
  cancellationReason: null,
  active: [],
  children: [],
  error: null,
});

function batchJob(over: Partial<GenerationBatchDetailVM> = {}): GenerationBatchDetailVM {
  return {
    jobId: "batch-1",
    kind: "batch",
    status: "running",
    total: 2,
    queued: 0,
    activeCount: 2,
    completed: 0,
    failed: 0,
    cancelled: 0,
    cancelRequested: false,
    active: [],
    activeChildIds: [],
    current: null,
    children: [],
    ...over,
  };
}

function batchInput(over: Partial<PolledJobProjectionInput<GenerationBatchDetailVM>> = {}): PolledJobProjectionInput<GenerationBatchDetailVM> {
  return frozen({ phase: "polling", snapshot: null, startError: null, ...over });
}

describe("projectGenerationBatch", () => {
  it("orders active children by set index and carries the batch's counts", () => {
    const next = projectGenerationBatch(BATCH_IDLE, batchInput({
      snapshot: batchJob({
        total: 4, queued: 1, activeCount: 2, completed: 1,
        cancelRequested: true, cancellationRequestedAt: "2026-08-13T10:00:00.000Z", cancellationReason: "user",
        active: [
          { jobId: "child-4", setIndex: 3, kind: "reading", stage: "planning", progress: null },
          { jobId: "child-2", setIndex: 1, kind: "speaking", stage: "rendering-audio", progress: { done: 2, total: 13 } },
        ],
      }),
    }));
    expect(next.active.map((child) => child.jobId)).toEqual(["child-2", "child-4"]);
    expect(next).toMatchObject({
      total: 4, queued: 1, activeCount: 2, completed: 1, cancelledCount: 0,
      cancelRequested: true, cancellationRequestedAt: "2026-08-13T10:00:00.000Z", cancellationReason: "user",
    });
    expect(next.active[0]?.audioProgress).toEqual({ done: 2, total: 13 });
    // elapsedMs is not a poll outcome: usePolledJob's one ticker supplies it at render time.
    expect(next.active[0]).not.toHaveProperty("elapsedMs");
  });

  it("keeps each child's own accumulated detail, matched by job id, across its later polls", () => {
    const first = projectGenerationBatch(BATCH_IDLE, batchInput({
      snapshot: batchJob({
        active: [
          { jobId: "child-1", setIndex: 0, kind: "speaking", stage: "rendering-audio", progress: { done: 5, total: 13 } },
          { jobId: "child-2", setIndex: 1, kind: "writing", stage: "generating", progress: { planningAttempt: 2 } },
        ],
      }),
    }));
    const second = projectGenerationBatch(frozen(first), batchInput({
      snapshot: batchJob({
        active: [
          { jobId: "child-1", setIndex: 0, kind: "speaking", stage: "saving", progress: null },
          { jobId: "child-2", setIndex: 1, kind: "writing", stage: "queued", progress: { position: 1 } },
        ],
      }),
    }));
    expect(second.active[0]).toMatchObject({ stage: "saving", audioProgress: { done: 5, total: 13 } });
    // A child waiting for admission keeps the stage it had reached, and its earlier attempt count.
    expect(second.active[1]).toMatchObject({ stage: "generating", waiting: true, queuePosition: 1, planningAttempt: 2 });
  });

  it("maps lifecycle phases and a starter failure onto its own status union", () => {
    expect(projectGenerationBatch(BATCH_IDLE, batchInput({ phase: "starting" })).status).toBe("starting");
    expect(projectGenerationBatch(BATCH_IDLE, batchInput({ phase: "polling" })).status).toBe("queued");
    expect(projectGenerationBatch(BATCH_IDLE, batchInput({ phase: "terminal", startError: "429 rate limited" })))
      .toMatchObject({ status: "failed", error: "429 rate limited" });
  });

  it("is pure: never mutates its input, and repeats itself exactly", () => {
    const input = batchInput({
      snapshot: frozen(batchJob({
        active: [{ jobId: "child-1", setIndex: 0, kind: "writing", stage: "generating", progress: null }],
      })),
    });
    expect(projectGenerationBatch(BATCH_IDLE, input)).toEqual(projectGenerationBatch(BATCH_IDLE, input));
    expect(BATCH_IDLE.active).toEqual([]);
  });
});
