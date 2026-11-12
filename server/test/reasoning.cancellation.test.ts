import { describe, expect, it, vi } from "vitest";
import { createProviderState } from "../src/services/reasoning/providerState.js";
import { runSkillTask } from "../src/services/reasoning/router.js";

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};

function request(signal: AbortSignal) {
  return {
    task: { task: "aggregate" as const, context: "email" as const },
    prompt: "aggregate",
    jsonSchema: schema,
    parse: (value: unknown) => value as { answer: string },
    signal,
    cancellationReason: "superseded" as const,
    jobId: "score-job-1",
    context: "email:item-1",
  };
}

describe("reasoning route cancellation", () => {
  it("normalizes cancellation while queued for provider admission", async () => {
    const state = createProviderState();
    let release!: () => void;
    const blocker = state.admit("claude", { family: "scoring", jobId: "blocker" }, () => new Promise<void>((resolve) => {
      release = resolve;
    }));
    const controller = new AbortController();
    const runClaude = vi.fn();
    const routed = runSkillTask(request(controller.signal), {
      providerState: state,
      runClaude,
      runCodex: vi.fn(),
      onLog: vi.fn(),
    });
    controller.abort();

    await expect(routed).resolves.toMatchObject({
      ok: false,
      cancelled: true,
      reason: "superseded",
      attempts: [],
    });
    expect(runClaude).not.toHaveBeenCalled();
    release();
    await blocker;
  });

  it("returns a separate cancelled outcome without starting a provider", async () => {
    const controller = new AbortController();
    controller.abort();
    const runClaude = vi.fn();
    const runCodex = vi.fn();

    const result = await runSkillTask(request(controller.signal), {
      providerState: createProviderState(),
      runClaude,
      runCodex,
      onLog: vi.fn(),
    });

    expect(result).toEqual({
      ok: false,
      cancelled: true,
      reason: "superseded",
      error: "Structured reasoning cancelled (superseded).",
      attempts: [],
    });
    expect(runClaude).not.toHaveBeenCalled();
    expect(runCodex).not.toHaveBeenCalled();
  });

  it("does not fallback or record a provider failure when an active leg is cancelled", async () => {
    const controller = new AbortController();
    const runCodex = vi.fn();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const runClaude = vi.fn(async () => {
      markStarted();
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      });
      return {
        ok: false as const,
        failure: {
          provider: "claude" as const,
          kind: "application" as const,
          source: "call" as const,
        },
      };
    });

    const routed = runSkillTask(request(controller.signal), {
      providerState: createProviderState(),
      runClaude: runClaude as never,
      runCodex,
      onLog: vi.fn(),
    });
    await started;
    controller.abort();

    await expect(routed).resolves.toMatchObject({
      ok: false,
      cancelled: true,
      reason: "superseded",
      attempts: [],
    });
    expect(runCodex).not.toHaveBeenCalled();
  });
});
