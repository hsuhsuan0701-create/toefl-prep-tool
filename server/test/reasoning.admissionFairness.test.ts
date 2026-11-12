import { describe, expect, it, vi } from "vitest";
import { withModelCallContext } from "../src/services/modelCallLog.js";
import {
  createProviderState,
  type ProviderState,
} from "../src/services/reasoning/providerState.js";
import {
  runOpenAiText,
  runSkillTask,
  type SkillRouteDeps,
  type SkillTaskRequest,
} from "../src/services/reasoning/router.js";

// ADR 0007: "within a family it round-robins jobs and preserves FIFO order within each job". No
// production caller passes a `jobId`, so the router takes the scheduler's bucket key from the
// model-call correlation in scope, the durable job the call is made for, and falls back to the task
// name only outside a job.

const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};
const parse = (value: unknown) => value as { answer: string };
const claudeSuccess = { ok: true, provider: "claude", value: { answer: "ok" } } as const;

/**
 * A Listening remediation call, rather than `aggregate`: one Listening generation job fires these
 * through `Promise.all` (regenerateRejectedListeningQuestions), the production shape in which one
 * job holds several queued entries at once, and so the only one in which per-job round-robin
 * differs from a flat FIFO.
 */
function remediationRequest(label: string): SkillTaskRequest<{ answer: string }> {
  return {
    task: { task: "generate", context: "listening" },
    prompt: `/toefl-listening\nGENERATE listening\n${label}`,
    jsonSchema: schema,
    parse,
  };
}

/** `as never` on the CLI runners follows reasoning.router.test.ts. */
function skillDeps(
  state: ProviderState,
  onClaudeCall: (prompt: string) => void = () => undefined,
): SkillRouteDeps {
  return {
    providerState: state,
    runClaude: vi.fn(async (options: { prompt: string }) => {
      onClaudeCall(options.prompt);
      return claudeSuccess;
    }) as never,
    runCodex: vi.fn(),
    onLog: () => undefined,
  };
}

/** Records every job id that reaches admission, then delegates to the real state unchanged. */
function admissionSpy(inner: ProviderState, seen: string[]): ProviderState {
  return {
    ...inner,
    admit(provider, request, operation, onEvent) {
      seen.push(request.jobId);
      return inner.admit(provider, request, operation, onEvent);
    },
  };
}

function claudeQueueDepth(state: ProviderState): number {
  const claude = state
    .operationalSnapshot()
    .find((entry) => entry.provider === "claude");
  return claude?.queued.generation ?? -1;
}

/** Occupies the single default capacity slot so every later call is observably queued. */
function blockClaude(state: ProviderState): { readonly settled: Promise<unknown>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const settled = state.admit("claude", { family: "scoring", jobId: "blocker" }, async () => {
    await gate;
  });
  return { settled, release };
}

/** Last prompt line, which remediationRequest makes the call's label. */
function labelOf(prompt: string): string {
  return prompt.split("\n").at(-1)!;
}

describe("admission fairness across durable jobs", () => {
  it("buckets each batch child under its own job id rather than the shared task name", async () => {
    const seen: string[] = [];
    const state = admissionSpy(createProviderState(), seen);
    const deps = skillDeps(state);

    for (const childId of ["child-a", "child-b", "child-c"]) {
      await withModelCallContext({ kind: "generation-job", id: childId }, () =>
        runSkillTask(remediationRequest(childId), deps));
    }

    expect(seen).toEqual(["child-a", "child-b", "child-c"]);
  });

  it("buckets scoring work under its own scoring job id", async () => {
    const seen: string[] = [];
    const state = admissionSpy(createProviderState(), seen);
    const deps = {
      providerState: state,
      runCodex: vi.fn(async () => ({ ok: true, provider: "codex", value: { answer: "ok" } })) as never,
      runHttp: vi.fn(),
      openaiTextPrimary: "codex" as const,
      onLog: () => undefined,
    };

    for (const jobId of ["score-a", "score-b"]) {
      await withModelCallContext(
        { kind: "scoring-job", id: jobId, detail: { attemptId: "attempt-1" } },
        () => runOpenAiText({ prompt: "JUDGE", jsonSchema: schema, parse }, deps),
      );
    }

    expect(seen).toEqual(["score-a", "score-b"]);
  });

  it("alternates admission across concurrent batch children instead of draining one first", async () => {
    // Default capacity is 1, which makes admission order observable: every call after the blocker
    // queues, and the order they run in is the order the scheduler admitted them in.
    const state = createProviderState();
    const blocker = blockClaude(state);
    const admitted: string[] = [];
    const deps = skillDeps(state, (prompt) => admitted.push(labelOf(prompt)));
    const submit = (childId: string, label: string) =>
      withModelCallContext({ kind: "generation-job", id: childId }, () =>
        runSkillTask(remediationRequest(label), deps));

    // Submitted as child A's whole fan-out, then child B's: a flat FIFO's worst case, and what a
    // batch produces when child A reaches its remediation stage a moment before child B.
    const routed = [
      submit("child-a", "a1"),
      submit("child-a", "a2"),
      submit("child-b", "b1"),
      submit("child-b", "b2"),
    ];
    expect(claudeQueueDepth(state)).toBe(4);

    blocker.release();
    await blocker.settled;
    await Promise.all(routed);

    // Round-robin across jobs, FIFO within each: not ["a1", "a2", "b1", "b2"], which a flat
    // per-task queue produces, starving child B behind child A.
    expect(admitted).toEqual(["a1", "b1", "a2", "b2"]);
  });

  it("keeps admission FIFO within a single job", async () => {
    const state = createProviderState();
    const blocker = blockClaude(state);
    const admitted: string[] = [];
    const deps = skillDeps(state, (prompt) => admitted.push(labelOf(prompt)));
    const routed = ["s1", "s2", "s3"].map((label) =>
      withModelCallContext({ kind: "generation-job", id: "solo-child" }, () =>
        runSkillTask(remediationRequest(label), deps)));
    expect(claudeQueueDepth(state)).toBe(3);

    blocker.release();
    await blocker.settled;
    await Promise.all(routed);

    expect(admitted).toEqual(["s1", "s2", "s3"]);
  });

  it("falls back to the task name only when no owning job is in scope", async () => {
    // The seam every injected-runner test and every non-job-backed caller relies on: outside a job
    // there is no durable id to be fair between, so the task name remains the bucket key.
    const seen: string[] = [];
    const state = admissionSpy(createProviderState(), seen);
    await runSkillTask(remediationRequest("orphan"), skillDeps(state));

    expect(seen).toEqual(["generate:listening"]);
  });

  it("treats an empty ambient id as no owning job rather than a shared bucket", async () => {
    const seen: string[] = [];
    const state = admissionSpy(createProviderState(), seen);
    await withModelCallContext({ kind: "generation-job", id: "" }, () =>
      runSkillTask(remediationRequest("blank"), skillDeps(state)));

    expect(seen).toEqual(["generate:listening"]);
  });

  it("lets an explicit request jobId override the ambient correlation", async () => {
    const seen: string[] = [];
    const state = admissionSpy(createProviderState(), seen);
    await withModelCallContext({ kind: "generation-job", id: "ambient" }, () =>
      runSkillTask(
        { ...remediationRequest("explicit"), jobId: "explicit-job" },
        skillDeps(state),
      ));

    expect(seen).toEqual(["explicit-job"]);
  });
});
