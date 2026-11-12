import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { deferred } from "./helpers/deferred.js";
import { useFakeTimersInTest } from "./helpers/fakeTimers.js";
import {
  JudgeReportSchema,
  ScoreReportSchema,
  SpeakingGenerationInputSchema,
  WritingSetSchema,
  type ReasoningFailureKind,
} from "@toefl-prep/shared";
import { z } from "zod";
import { config } from "../src/lib/config.js";
import { runClaude as productionRunClaude } from "../src/services/claudeRunner.js";
import { runCodex as productionRunCodex } from "../src/services/reasoning/codexRunner.js";
import type {
  ProviderResult,
  ReasoningEvent,
} from "../src/services/reasoning/contracts.js";
import { createProviderState } from "../src/services/reasoning/providerState.js";
import {
  runOpenAiText,
  runSkillTask,
  type OpenAiTextRequest,
  type ReasoningRouteLog,
  type SkillRouteDeps,
  type SkillTaskRequest,
} from "../src/services/reasoning/router.js";
import { composeCodexSkillPrompt } from "../src/services/reasoning/skillContext.js";
import type { ModelCallInsert } from "../src/db/rows.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { openDb } from "../src/db/db.js";
import {
  createRepoModelCallSink,
  recordHttpModelCall,
  resetModelCallSink,
  setModelCallSink,
} from "../src/services/modelCallLog.js";

const SECRET =
  "PROMPT_CANARY stderr-canary sk-live-credential auth-token-canary";
const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaudeBin = path.resolve(
  here,
  "fixtures/fake-claude.sh",
);
const fakeCodexBin = path.resolve(
  here,
  "fixtures/fake-codex.mjs",
);
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const schema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
};
const parse = (value: unknown) =>
  value as {
    answer: string;
  };

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Object.keys(value)) {
    expectDeepFrozen((value as Record<string, unknown>)[key]);
  }
}

const reasoningConfigKeys = [
  "claudeBin",
  "codexBin",
  "codexModel",
  "codexReasoningEffort",
  "openaiJudgeModel",
  "openaiTextPrimary",
] as const;

function saveReasoningConfig(): Record<
  (typeof reasoningConfigKeys)[number],
  string
> {
  return Object.fromEntries(
    reasoningConfigKeys.map((key) => [key, config[key]])
  ) as Record<(typeof reasoningConfigKeys)[number], string>;
}

function restoreReasoningConfig(
  saved: ReturnType<typeof saveReasoningConfig>
): void {
  Object.assign(config, saved);
}

function poisonReasoningConfig(): void {
  Object.assign(config, {
    claudeBin: `${SECRET}-claude-bin`,
    codexBin: `${SECRET}-codex-bin`,
    codexModel: `${SECRET}-codex-model`,
    codexReasoningEffort: `${SECRET}-effort`,
    openaiJudgeModel: `${SECRET}-http-model`,
    openaiTextPrimary: "http",
  });
}

function fakeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function withinRealTimeout<T>(
  promise: Promise<T>,
  message: string,
  timeoutMs = 3_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = realSetTimeout(
      () => reject(new Error(message)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        realClearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        realClearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function advanceFakeTimersUntil(
  advanceBy: (ms: number) => Promise<void>,
  predicate: () => boolean,
  message: string,
  timeoutMs = 3_000,
): Promise<void> {
  for (
    let elapsedMs = 0;
    elapsedMs < timeoutMs && !predicate();
    elapsedMs += 10
  ) {
    await advanceBy(10);
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 5);
    });
  }
  if (!predicate()) throw new Error(message);
}

function heartbeatPid(heartbeatPath: string): number | undefined {
  try {
    const pid = Number(
      fs.readFileSync(heartbeatPath, "utf8").split("\n", 1)[0],
    );
    return Number.isSafeInteger(pid) && pid > 0
      ? pid
      : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function heartbeatSize(heartbeatPath: string): number {
  return fs.statSync(heartbeatPath).size;
}

async function expectProcessEventuallyGone(
  pid: number,
  timeoutMs = 1_000,
): Promise<void> {
  for (
    let elapsedMs = 0;
    elapsedMs < timeoutMs && processIsAlive(pid);
    elapsedMs += 10
  ) {
    await new Promise<void>((resolve) => {
      realSetTimeout(resolve, 10);
    });
  }
  expect(processIsAlive(pid)).toBe(false);
}

async function waitForHeartbeat(
  heartbeatPath: string,
): Promise<number> {
  const started = new Promise<number>((resolve, reject) => {
    const check = () => {
      const pid = heartbeatPid(heartbeatPath);
      if (pid !== undefined) {
        resolve(pid);
        return;
      }
      fs.promises.stat(import.meta.filename).then(check, reject);
    };
    check();
  });
  return withinRealTimeout(
    started,
    `heartbeat did not start: ${heartbeatPath}`,
  );
}

function cleanupHeartbeat(heartbeatPath: string): void {
  const pid = heartbeatPid(heartbeatPath);
  if (pid !== undefined && processIsAlive(pid)) {
    process.kill(pid, "SIGKILL");
  }
  fs.rmSync(heartbeatPath, { force: true });
}

function success<T, P extends "claude" | "codex" | "openai-http">(
  provider: P,
  value: T
): ProviderResult<T, P> {
  return { ok: true, provider, value };
}

function failure<P extends "claude" | "codex" | "openai-http">(
  provider: P,
  kind: ReasoningFailureKind
): ProviderResult<never, P> {
  return {
    ok: false,
    failure: { provider, kind, source: "call" },
  };
}

function leakyFailure<P extends "claude" | "codex" | "openai-http">(
  provider: P,
  kind: ReasoningFailureKind
): ProviderResult<never, P> {
  return {
    ok: false,
    failure: {
      provider,
      kind,
      source: "call",
      stderr: SECRET,
      prompt: SECRET,
      output: SECRET,
    },
  } as never;
}

function skillRequest(
  onEvent?: (event: ReasoningEvent) => unknown
): SkillTaskRequest<{ answer: string }> {
  return {
    task: { task: "aggregate", context: "email" },
    prompt: `/toefl-writing\nAGGREGATE email\n${SECRET}`,
    jsonSchema: schema,
    parse,
    onEvent,
  };
}

function openAiRequest(
  onEvent?: (event: ReasoningEvent) => unknown
): OpenAiTextRequest<{ answer: string }> {
  return {
    prompt: `EXISTING_JUDGE_PROMPT_UNCHANGED\n${SECRET}`,
    jsonSchema: schema,
    parse,
    onEvent,
  };
}

describe("model call transcript recording", () => {
  afterEach(() => resetModelCallSink());

  it("persists the cancellation reason inferred from the job AbortSignal", async () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    setModelCallSink(createRepoModelCallSink(r));
    const controller = new AbortController();
    controller.abort(Object.assign(new Error("cancelled"), { reason: "shutdown" }));
    const result = await runSkillTask({
      ...skillRequest(), signal: controller.signal, jobId: "score-job", context: "email:item",
    }, { providerState: createProviderState(), runClaude: vi.fn(), runCodex: vi.fn(), onLog: vi.fn() });
    expect(result).toMatchObject({ cancelled: true, reason: "shutdown" });
    await Promise.resolve();
    expect(db.prepare("SELECT outcome,cancellation_reason FROM route_invocations").get()).toEqual({
      outcome: "cancelled", cancellation_reason: "shutdown",
    });
  });

  it("writes one row per CLI attempt across a Claude failure and its Codex fallback", async () => {
    const rows: ModelCallInsert[] = [];
    setModelCallSink((row) => rows.push(row));

    // Claude burns both attempts on unparseable output; Codex then succeeds on its first.
    const runClaude = vi.fn(async (options: { onTranscript?: (t: unknown) => void }) => {
      options.onTranscript?.({ prompt: "first", response: "garbage" });
      options.onTranscript?.({ prompt: "repair", response: "still garbage" });
      return failure("claude", "invalid-output");
    });
    const runCodex = vi.fn(async (options: { onTranscript?: (t: unknown) => void }) => {
      options.onTranscript?.({ prompt: "codex skill prompt", response: '{"answer":"ok"}' });
      return success("codex", { answer: "ok" });
    });

    const result = await runSkillTask(skillRequest(), {
      providerState: createProviderState(),
      runClaude: runClaude as never,
      runCodex: runCodex as never,
      onLog: vi.fn(),
    });
    expect(result.ok).toBe(true);

    expect(rows.map((r) => [r.provider, r.attemptIndex, r.outcome, r.failureKind])).toEqual([
      // The first Claude attempt failed on its own terms — its output was rejected, which is why a
      // repair ran at all — so it is recorded as such rather than inheriting the call's verdict.
      ["claude", 0, "failed", "invalid-output"],
      ["claude", 1, "failed", "invalid-output"],
      ["codex", 0, "succeeded", undefined],
    ]);
    // Every row carries the skill task and the route, so a failed generation is findable without
    // knowing which provider served it.
    expect(rows.every((r) => r.route === "skill-task" && r.task === "aggregate:email")).toBe(true);
    expect(rows[2].model).toBe(config.codexModel);
    // Timings land on the attempt that settled each provider call — Claude's second, Codex's first
    // — and never on a superseded sub-attempt, which would mean splitting one measured duration
    // into numbers nobody took.
    expect(rows[0].durationMs).toBeUndefined();
    expect(rows[1].durationMs).toBeTypeOf("number");
    expect(rows[2].durationMs).toBeTypeOf("number");
    // The prompt recorded for Codex is the skill-composed one it was actually sent, not the
    // caller's — they differ, and only one of them is what the model saw.
    expect(rows[2].prompt).toBe("codex skill prompt");
  });

  it("normalizes one logical route across Claude and Codex legs with attempts attached to their leg", async () => {
    const db=openDb(":memory:"); const r=sqliteStores(db); setModelCallSink(createRepoModelCallSink(r));
    const result=await runSkillTask(skillRequest(),{
      providerState:createProviderState(),onLog:vi.fn(),
      runClaude:vi.fn(async(options:{onTranscript?:(t:unknown)=>void})=>{options.onTranscript?.({prompt:"c1",response:"bad",startedAtMs:10,finishedAtMs:20});options.onTranscript?.({prompt:"c2",response:"bad2",startedAtMs:21,finishedAtMs:30});return failure("claude","invalid-output");}) as never,
      runCodex:vi.fn(async(options:{onTranscript?:(t:unknown)=>void})=>{options.onTranscript?.({prompt:"x1",response:'{"answer":"ok"}'});return success("codex",{answer:"ok"});}) as never,
    });
    expect(result.ok).toBe(true); await Promise.resolve();
    const routes=db.prepare("SELECT id FROM route_invocations").all() as {id:string}[];
    expect(routes).toHaveLength(1);
    const legs=r.listProviderExecutions(routes[0].id);
    expect(legs.map(x=>[x.provider,x.sequence])).toEqual([["claude",1],["codex",2]]);
    expect(r.listModelAttempts(legs[0].id).map(x=>[x.kind,x.sequence])).toEqual([["initial",1],["repair",2]]);
    expect(r.listModelAttempts(legs[1].id).map(x=>[x.kind,x.sequence])).toEqual([["initial",1]]);
    const claudeAttempts=r.listModelAttempts(legs[0].id);
    expect(claudeAttempts[0].finished_at_ms).toBeLessThanOrEqual(claudeAttempts[1].started_at_ms);
    expect(claudeAttempts[0].started_at_ms).not.toBe(claudeAttempts[1].started_at_ms);
  });

  // CLAUDE.md's per-job query orders a job's calls by route_invocations.queued_at_ms. Every stamp is
  // epoch milliseconds, so a CLI route sorts among the HTTP calls (the Judges, Ears) by when it ran;
  // a stamp from the monotonic clock would sort every CLI route first, and differently after each
  // restart.
  it("orders a CLI route between the HTTP calls recorded before and after it", async () => {
    useFakeTimersInTest({ toFake: ["Date"] });
    const db = openDb(":memory:");
    setModelCallSink(createRepoModelCallSink(sqliteStores(db)));
    const T0 = Date.parse("2026-11-12T00:00:00.000Z");

    vi.setSystemTime(T0);
    recordHttpModelCall({ provider: "gemini-http", route: "ears", model: "gemini", requestBody: "before", ok: true });
    vi.setSystemTime(T0 + 1_000);
    const routed = await runSkillTask(skillRequest(), {
      providerState: createProviderState(),
      onLog: vi.fn(),
      runClaude: vi.fn().mockResolvedValue(success("claude", { answer: "ok" })),
      runCodex: vi.fn(),
    });
    expect(routed.ok).toBe(true);
    vi.setSystemTime(T0 + 2_000);
    recordHttpModelCall({ provider: "gemini-http", route: "ears", model: "gemini", requestBody: "after", ok: true });
    await Promise.resolve();

    const ordered = db.prepare(`SELECT ri.queued_at_ms AS queued, pe.provider, pe.started_at_ms AS started FROM route_invocations ri
      JOIN provider_executions pe ON pe.route_invocation_id = ri.id
      ORDER BY ri.queued_at_ms, pe.sequence`).all() as { queued: number; provider: string; started: number }[];
    expect(ordered).toEqual([
      { provider: "gemini-http", queued: T0, started: T0 },
      // The CLI execution's own stamps are on the same clock as its route's.
      { provider: "claude", queued: T0 + 1_000, started: T0 + 1_000 },
      { provider: "gemini-http", queued: T0 + 2_000, started: T0 + 2_000 },
    ]);
  });

  it("keeps a failing transcript sink from failing the model call it observes", async () => {
    const sink = vi.fn(() => {
      throw new Error("db locked");
    });
    setModelCallSink(sink);
    const runClaude = vi.fn(async (options: { onTranscript?: (t: unknown) => void }) => {
      options.onTranscript?.({ prompt: "p", response: "r" });
      return success("claude", { answer: "claude" });
    });

    const result = await runSkillTask(skillRequest(), {
      providerState: createProviderState(),
      runClaude: runClaude as never,
      runCodex: vi.fn(),
      onLog: vi.fn(),
    });

    expect(result).toMatchObject({ ok: true, provider: "claude" });
    expect(sink).toHaveBeenCalled(); // the sink really ran, and threw
  });

  it("records nothing for the OpenAI HTTP leg, which the judge records itself with its wire bodies", async () => {
    const rows: ModelCallInsert[] = [];
    setModelCallSink((row) => rows.push(row));

    const result = await runOpenAiText(openAiRequest(), {
      runHttp: () => success("openai-http", { answer: "http" }) as never,
      openaiTextPrimary: "http",
      providerState: createProviderState(),
      runCodex: vi.fn(),
      onLog: vi.fn(),
    });

    expect(result).toMatchObject({ ok: true, provider: "openai-http" });
    // A row here would duplicate the judge's own, while carrying a prompt and no response.
    expect(rows).toEqual([]);
  });
});

// Skill-backed work (plan, generate, verify, import, the Arbiter) runs Claude CLI, then Codex CLI,
// and never OpenAI HTTP (ADR 0003).
describe("Claude skill route", () => {
  // A type-level assertion: `npm run typecheck` fails if SkillRouteDeps gains a runHttp.
  it("has no HTTP dependency in the skill-route contract", () => {
    expectTypeOf<SkillRouteDeps>().not.toHaveProperty("runHttp");
  });

  it("runs Claude first with the existing slash prompt, schema, and parser unchanged", async () => {
    const events: ReasoningEvent[] = [];
    const runClaude = vi
      .fn()
      .mockResolvedValue(success("claude", { answer: "claude" }));
    const runCodex = vi.fn();
    const request = skillRequest((event) => events.push(event));

    const result = await runSkillTask(request, {
      providerState: createProviderState(),
      runClaude,
      runCodex: runCodex as never,
      onLog: () => undefined,
    });

    expect(result).toEqual({
      ok: true,
      provider: "claude",
      value: { answer: "claude" },
      attempts: [],
    });
    expect(runClaude).toHaveBeenCalledWith({
      prompt: request.prompt,
      jsonSchema: request.jsonSchema,
      parse: request.parse,
      bin: config.claudeBin,
      deadline: expect.objectContaining({
        expiresAtMs: expect.any(Number),
      }),
      onTranscript: expect.any(Function),
      onPressure: expect.any(Function),
    });
    expect(runCodex).not.toHaveBeenCalled();
    expect(events).toEqual([{ state: "running", provider: "claude" }]);
  });

  it.each([
    ["ScoreReport", ScoreReportSchema],
    ["writing generation", WritingSetSchema],
    ["speaking generation", SpeakingGenerationInputSchema],
    ["judge report", JudgeReportSchema],
  ])(
    "accepts a real %s Zod JSON schema through the skill route",
    async (_name, zodSchema) => {
      const jsonSchema = z.toJSONSchema(zodSchema);
      const runClaude = vi
        .fn()
        .mockResolvedValue(success("claude", { answer: "safe" }));

      await expect(
        runSkillTask(
          { ...skillRequest(), jsonSchema },
          {
            providerState: createProviderState(),
            runClaude,
            runCodex: vi.fn(),
            onLog: () => undefined,
          }
        )
      ).resolves.toMatchObject({ ok: true, provider: "claude" });

      const capturedSchema = runClaude.mock.calls[0]?.[0].jsonSchema;
      // The runners serialize the schema, so the JSON is what reaches the CLI.
      expect(JSON.stringify(capturedSchema)).toBe(
        JSON.stringify(jsonSchema)
      );
    }
  );

  it("routes one real ScoreReport schema unchanged through Claude and Codex", async () => {
    const jsonSchema = z.toJSONSchema(ScoreReportSchema);
    const runClaude = vi.fn().mockResolvedValue(failure("claude", "quota"));
    const runCodex = vi
      .fn()
      .mockResolvedValue(success("codex", { answer: "safe" }));

    await expect(
      runSkillTask(
        { ...skillRequest(), jsonSchema },
        {
          providerState: createProviderState(),
          runClaude,
          runCodex,
          onLog: () => undefined,
        }
      )
    ).resolves.toMatchObject({ ok: true, provider: "codex" });

    const claudeSchema = runClaude.mock.calls[0]?.[0].jsonSchema;
    const codexSchema = runCodex.mock.calls[0]?.[0].jsonSchema;
    expect(claudeSchema).toBe(codexSchema);
    expect(JSON.stringify(codexSchema)).toBe(JSON.stringify(jsonSchema));
  });

  it.each([
    null,
    { task: "aggregate", context: "build_sentence" },
    { task: "generate", context: "../secrets" },
    { task: "unknown", context: "email" },
    {
      task: "aggregate",
      context: "email",
      path: "../SECRET-CANARY",
    },
  ])(
    "rejects an invalid runtime skill descriptor before touching routing dependencies",
    async (task) => {
      // Every provider-state operation a route uses (RouteProviderState in router.ts).
      const state = {
        admit: vi.fn(),
        checkCircuit: vi.fn(),
        circuitOpen: vi.fn(),
        recordExecution: vi.fn(),
        recordPressure: vi.fn(),
      };
      const runClaude = vi.fn();
      const runCodex = vi.fn();
      const onEvent = vi.fn();
      const onLog = vi.fn();

      await expect(
        runSkillTask(
          { ...skillRequest(onEvent), task: task as never },
          {
            providerState: state as never,
            runClaude: runClaude as never,
            runCodex: runCodex as never,
            onLog,
          }
        )
      ).rejects.toThrow("Unsupported canonical skill task/context.");

      for (const operation of Object.values(state)) expect(operation).not.toHaveBeenCalled();
      expect(runClaude).not.toHaveBeenCalled();
      expect(runCodex).not.toHaveBeenCalled();
      expect(onEvent).not.toHaveBeenCalled();
      expect(onLog).not.toHaveBeenCalled();
    }
  );

  it("falls back only after an eligible Claude failure and packages Codex context", async () => {
    const events: ReasoningEvent[] = [];
    const runClaude = vi
      .fn()
      .mockResolvedValue(failure("claude", "quota"));
    const runCodex = vi
      .fn()
      .mockResolvedValue(success("codex", { answer: "codex" }));
    const request = skillRequest((event) => events.push(event));

    const result = await runSkillTask(request, {
      providerState: createProviderState(),
      runClaude,
      runCodex,
      onLog: () => undefined,
    });

    expect(result).toEqual({
      ok: true,
      provider: "codex",
      value: { answer: "codex" },
      attempts: [{ provider: "claude", kind: "quota" }],
    });
    expect(runCodex).toHaveBeenCalledWith({
      prompt: composeCodexSkillPrompt(request.task, request.prompt),
      jsonSchema: request.jsonSchema,
      parse: request.parse,
      bin: config.codexBin,
      model: config.codexModel,
      reasoningEffort: config.codexReasoningEffort,
      deadline: expect.objectContaining({
        expiresAtMs: expect.any(Number),
      }),
      onTranscript: expect.any(Function),
    });
    expect(events).toEqual([
      { state: "running", provider: "claude" },
      {
        state: "fallback",
        provider: "codex",
        fallbackFrom: "claude",
        failureKind: "quota",
      },
      {
        state: "running",
        provider: "codex",
        fallbackFrom: "claude",
      },
    ]);
  });

  it("rejects a late Claude success and falls back without extending the post-dequeue budget", async () => {
    const clock = fakeClock();
    const runCodex = vi
      .fn()
      .mockResolvedValue(success("codex", { answer: "fallback" }));
    const result = await runSkillTask(skillRequest(), {
      providerState: createProviderState(),
      runClaude: vi.fn().mockImplementation(async () => {
        clock.advance(750_001);
        return success("claude", { answer: "late" });
      }),
      runCodex,
      onLog: () => undefined,
      now: clock.now,
    });

    expect(result).toEqual({
      ok: true,
      provider: "codex",
      value: { answer: "fallback" },
      attempts: [{ provider: "claude", kind: "timeout" }],
    });
    expect(runCodex).toHaveBeenCalledOnce();
  });

  it("fixes timeout at the deadline but waits for Claude adapter teardown before Codex fallback", async () => {
    const fakeTimers = useFakeTimersInTest();
    vi.setSystemTime(0);
    const teardown = deferred();
    const teardownStarted = deferred();
    const events: ReasoningEvent[] = [];
    const runCodex = vi
      .fn()
      .mockResolvedValue(success("codex", { answer: "fallback" }));
    let settled = false;
    try {
      const routed = runSkillTask(
        skillRequest((event) => events.push(event)),
        {
        providerState: createProviderState(),
        runClaude: vi.fn().mockImplementation(async (options) => {
          try {
            await new Promise((_, reject) => {
              options.deadline.setTimer(
                () => reject(new Error("provider execution stopped")),
                750_000,
              );
            });
          } catch {
            teardownStarted.resolve();
            await teardown.promise;
            throw new Error("adapter teardown rejected after timeout");
          }
        }),
        runCodex,
        onLog: () => undefined,
        now: () => Date.now(),
      },
      ).then((result) => {
        settled = true;
        return result;
      });

      await fakeTimers.advanceBy(750_000);
      await teardownStarted.promise;
      await flushPromises();
      expect(settled).toBe(false);
      expect(runCodex).not.toHaveBeenCalled();
      expect(events).not.toContainEqual(
        expect.objectContaining({ state: "fallback" }),
      );

      teardown.resolve();
      await expect(routed).resolves.toEqual({
        ok: true,
        provider: "codex",
        value: { answer: "fallback" },
        attempts: [{ provider: "claude", kind: "timeout" }],
      });
      expect(runCodex).toHaveBeenCalledOnce();
    } finally {
      teardown.resolve();
    }
  });

  it("releases a non-cooperative Codex adapter only after bounded teardown grace", async () => {
    const fakeTimers = useFakeTimersInTest();
    vi.setSystemTime(0);
    const runHttp = vi
      .fn()
      .mockResolvedValue(
        success("openai-http", { answer: "fallback" }),
      );
    let settled = false;
      const routed = runOpenAiText(openAiRequest(), {
        providerState: createProviderState(),
        openaiTextPrimary: "codex",
        runCodex: vi
          .fn()
          .mockImplementation(() => new Promise(() => undefined)),
        runHttp,
        onLog: () => undefined,
        now: () => Date.now(),
      }).then((result) => {
        settled = true;
        return result;
      });

    await fakeTimers.advanceBy(300_000);
      expect(settled).toBe(false);
      expect(runHttp).not.toHaveBeenCalled();

    await fakeTimers.advanceBy(2_999);
      expect(settled).toBe(false);
      expect(runHttp).not.toHaveBeenCalled();

    await fakeTimers.advanceBy(1);
      await expect(routed).resolves.toEqual({
        ok: true,
        provider: "openai-http",
        value: { answer: "fallback" },
        attempts: [{ provider: "codex", kind: "timeout" }],
      });
      expect(runHttp).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start Claude fallback until the real adapter has killed its process tree and removed its known temp directory", async () => {
    const fakeTimers = useFakeTimersInTest();
    vi.setSystemTime(0);
    const savedConfig = saveReasoningConfig();
    const heartbeatPath = path.join(
      os.tmpdir(),
      `toefl-route-claude-teardown-${process.pid}-${Date.now()}`,
    );
    const cleanupGate = deferred();
    const cleanupStarted = deferred();
    const realMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
    const realRm = fs.promises.rm.bind(fs.promises);
    const realKill = process.kill.bind(process);
    let tempDir: string | undefined;
    let cleanupHasStarted = false;
    let groupKillSignals = 0;
    let fallbackHeartbeatSize: number | undefined;
    const mkdtemp = vi
      .spyOn(fs.promises, "mkdtemp")
      .mockImplementation(async (prefix: string) => {
        const created = await realMkdtemp(prefix);
        if (path.basename(prefix) === "toefl-claude-") {
          tempDir = created;
        }
        return created;
      });
    const rm = vi
      .spyOn(fs.promises, "rm")
      .mockImplementation(
        async (...args: Parameters<typeof fs.promises.rm>) => {
          if (String(args[0]) === tempDir) {
            cleanupHasStarted = true;
            cleanupStarted.resolve();
            await cleanupGate.promise;
          }
          return Reflect.apply(realRm, fs.promises, args);
        },
      );
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation(
        (...args: Parameters<typeof process.kill>) => {
          if (args[0] < 0 && args[1] === "SIGKILL") {
            groupKillSignals += 1;
          }
          return realKill(...args);
        },
      );
    let heartbeatProcessId: number | undefined;
    const runCodex = vi.fn().mockImplementation(async () => {
      expect(tempDir).toBeDefined();
      expect(fs.existsSync(tempDir!)).toBe(false);
      expect(heartbeatProcessId).toBeDefined();
      expect(groupKillSignals).toBeGreaterThan(0);
      fallbackHeartbeatSize = heartbeatSize(heartbeatPath);
      return success("codex", { answer: "fallback" });
    });
    try {
      config.claudeBin = fakeClaudeBin;
      const routed = runSkillTask(
        {
          ...skillRequest(),
          prompt: `[FAKE_CLAUDE:TREE_HANG:${heartbeatPath}]`,
        },
        {
          providerState: createProviderState(),
          runClaude: productionRunClaude,
          runCodex,
          onLog: () => undefined,
          now: () => Date.now(),
        },
      );

      heartbeatProcessId = await waitForHeartbeat(heartbeatPath);
      expect(tempDir).toBeDefined();
      await fakeTimers.advanceBy(750_000);
      await advanceFakeTimersUntil(
        fakeTimers.advanceBy,
        () => cleanupHasStarted,
        "Claude adapter did not finish process teardown",
      );
      await withinRealTimeout(
        cleanupStarted.promise,
        "Claude cleanup did not start",
      );

      expect(fs.existsSync(tempDir!)).toBe(true);
      expect(runCodex).not.toHaveBeenCalled();

      cleanupGate.resolve();
      await expect(routed).resolves.toEqual({
        ok: true,
        provider: "codex",
        value: { answer: "fallback" },
        attempts: [{ provider: "claude", kind: "timeout" }],
      });
      expect(runCodex).toHaveBeenCalledOnce();
      await new Promise<void>((resolve) => {
        realSetTimeout(resolve, 40);
      });
      expect(heartbeatSize(heartbeatPath)).toBe(
        fallbackHeartbeatSize,
      );
      await expectProcessEventuallyGone(heartbeatProcessId!);
    } finally {
      cleanupGate.resolve();
      mkdtemp.mockRestore();
      rm.mockRestore();
      kill.mockRestore();
      restoreReasoningConfig(savedConfig);
      cleanupHeartbeat(heartbeatPath);
      if (tempDir) {
        await realRm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("starts real-clock Claude process-group termination before entering fallback", async () => {
    const savedConfig = saveReasoningConfig();
    const heartbeatPath = path.join(
      os.tmpdir(),
      `toefl-route-claude-real-clock-${process.pid}-${Date.now()}`,
    );
    const killStarted = deferred();
    const realMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
    const realRm = fs.promises.rm.bind(fs.promises);
    const realKill = process.kill.bind(process);
    let tempDir: string | undefined;
    let fallbackTempExists: boolean | undefined;
    let fallbackHeartbeatSize: number | undefined;
    const lifecycle: {
      readonly event: "kill" | "fallback-enter";
      readonly atMs: number;
    }[] = [];
    const mkdtemp = vi
      .spyOn(fs.promises, "mkdtemp")
      .mockImplementation(async (prefix: string) => {
        const created = await realMkdtemp(prefix);
        if (path.basename(prefix) === "toefl-claude-") {
          tempDir = created;
        }
        return created;
      });
    const rm = vi
      .spyOn(fs.promises, "rm")
      .mockImplementation(
        async (...args: Parameters<typeof fs.promises.rm>) => {
          if (String(args[0]) === tempDir) {
            fs.rmSync(tempDir!, { recursive: true, force: true });
            return;
          }
          return Reflect.apply(realRm, fs.promises, args);
        },
      );
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation(
        (...args: Parameters<typeof process.kill>) => {
          if (
            args[0] < 0 &&
            args[1] === "SIGKILL" &&
            !lifecycle.some((entry) => entry.event === "kill")
          ) {
            lifecycle.push({
              event: "kill",
              atMs: performance.now(),
            });
            killStarted.resolve();
          }
          return realKill(...args);
        },
      );
    const runClaude = vi.fn(
      (options: Parameters<typeof productionRunClaude>[0]) =>
        productionRunClaude({
          ...options,
          deadline: undefined,
          timeoutMs: 250,
        }),
    );
    const runCodex = vi.fn().mockImplementation(async () => {
      await killStarted.promise;
      return success("codex", { answer: "fallback" });
    });
    try {
      config.claudeBin = fakeClaudeBin;
      const routed = runSkillTask(
        {
          ...skillRequest((event) => {
            if (event.state !== "fallback") return;
            lifecycle.push({
              event: "fallback-enter",
              atMs: performance.now(),
            });
            fallbackTempExists =
              tempDir === undefined || fs.existsSync(tempDir);
            fallbackHeartbeatSize = heartbeatSize(heartbeatPath);
          }),
          prompt: `[FAKE_CLAUDE:TREE_HANG:${heartbeatPath}]`,
        },
        {
          providerState: createProviderState(),
          runClaude: runClaude as never,
          runCodex,
          onLog: () => undefined,
        },
      );

      const heartbeatProcessId =
        await waitForHeartbeat(heartbeatPath);
      await expect(routed).resolves.toEqual({
        ok: true,
        provider: "codex",
        value: { answer: "fallback" },
        attempts: [{ provider: "claude", kind: "timeout" }],
      });

      expect(lifecycle.map((entry) => entry.event)).toEqual([
        "kill",
        "fallback-enter",
      ]);
      expect(fallbackTempExists).toBe(false);
      expect(fallbackHeartbeatSize).toBeDefined();
      await new Promise<void>((resolve) => {
        realSetTimeout(resolve, 40);
      });
      expect(heartbeatSize(heartbeatPath)).toBe(
        fallbackHeartbeatSize,
      );
      await expectProcessEventuallyGone(heartbeatProcessId);
      expect(runClaude).toHaveBeenCalledOnce();
      expect(runCodex).toHaveBeenCalledOnce();
    } finally {
      mkdtemp.mockRestore();
      rm.mockRestore();
      kill.mockRestore();
      restoreReasoningConfig(savedConfig);
      cleanupHeartbeat(heartbeatPath);
      if (tempDir) {
        await realRm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("times out hanging Codex skill-context composition and releases the provider queue", async () => {
    const fakeTimers = useFakeTimersInTest();
    vi.setSystemTime(0);
    const readStarted = deferred();
    const readFile = vi
      .spyOn(fs.promises, "readFile")
      .mockImplementation(() => {
        readStarted.resolve();
        return new Promise(() => undefined);
      });
    const state = createProviderState();
    try {
      const routed = runSkillTask(skillRequest(), {
        providerState: state,
        runClaude: vi
          .fn()
          .mockResolvedValue(failure("claude", "quota")),
        runCodex: vi
          .fn()
          .mockResolvedValue(success("codex", { answer: "late" })),
        onLog: () => undefined,
        now: () => Date.now(),
      });

      await readStarted.promise;
      await fakeTimers.advanceBy(300_000);
      await expect(routed).resolves.toEqual({
        ok: false,
        error:
          "Structured reasoning unavailable: Claude (quota) → Codex (timeout).",
        attempts: [
          { provider: "claude", kind: "quota" },
          { provider: "codex", kind: "timeout" },
        ],
      });
      await expect(
        state.admit("codex", { family: "scoring", jobId: "after-timeout" }, async () => "queue usable"),
      ).resolves.toBe("queue usable");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      readFile.mockRestore();
    }
  });

  it.each(["configuration", "application"] as const)(
    "stops on a non-fallback-eligible Claude %s failure",
    async (kind) => {
      const runCodex = vi.fn();
      const result = await runSkillTask(skillRequest(), {
        providerState: createProviderState(),
        runClaude: vi.fn().mockResolvedValue(failure("claude", kind)),
        runCodex: runCodex as never,
        onLog: () => undefined,
      });

      expect(result).toEqual({
        ok: false,
        error: `Structured reasoning unavailable: Claude (${kind}).`,
        attempts: [{ provider: "claude", kind }],
      });
      expect(runCodex).not.toHaveBeenCalled();
    }
  );

  it("stops after Codex and returns only a sanitized immutable failure chain", async () => {
    const events: ReasoningEvent[] = [];
    const logs: ReasoningRouteLog[] = [];
    const result = await runSkillTask(
      skillRequest((event) => events.push(event)),
      {
        providerState: createProviderState(),
        runClaude: vi
          .fn()
          .mockResolvedValue(leakyFailure("claude", "authentication")),
        runCodex: vi.fn().mockResolvedValue(leakyFailure("codex", "quota")),
        onLog: (entry) => logs.push(entry),
      }
    );

    expect(result).toEqual({
      ok: false,
      error:
        "Structured reasoning unavailable: Claude (authentication) → Codex (quota).",
      attempts: [
        { provider: "claude", kind: "authentication" },
        { provider: "codex", kind: "quota" },
      ],
    });
    expect(Object.isFrozen(result.attempts)).toBe(true);
    expect(result.attempts.every(Object.isFrozen)).toBe(true);
    expect(JSON.stringify({ result, events, logs })).not.toContain(SECRET);
    expect(JSON.stringify({ result, events, logs })).not.toMatch(
      /stderr|output|credential|auth-token/
    );
  });

  it("rejects work submitted to an open injected provider circuit before queue admission", async () => {
    const clock = fakeClock();
    const state = createProviderState({ now: () => 1_000 });
    state.recordPressure("claude", "quota");
    const events: ReasoningEvent[] = [];
    const logs: ReasoningRouteLog[] = [];
    const runClaude = vi.fn();
    const runCodex = vi
      .fn()
      .mockImplementation(async () => {
        clock.advance(5);
        return success("codex", { answer: "fallback" });
      });
    const routed = await runSkillTask(
      skillRequest((event) => events.push(event)),
      {
        providerState: state,
        runClaude,
        runCodex,
        onLog: (entry) => logs.push(entry),
        now: clock.now,
      }
    );

    expect(routed).toMatchObject({
      ...success("codex", { answer: "fallback" }),
      attempts: [{ provider: "claude", kind: "quota" }],
    });
    expect(runClaude).not.toHaveBeenCalled();
    expect(runCodex).toHaveBeenCalledOnce();
    // Claude's queue is empty here, so admission would have started the request at once and
    // reported it running rather than queued. Claude gets no event at all, and its one log line is
    // the circuit's refusal, with no time spent queued or running.
    expect(events.filter((event) => event.provider === "claude")).toEqual([]);
    expect(logs.filter((entry) => "provider" in entry && entry.provider === "claude")).toEqual([{
      state: "failed", provider: "claude", failureKind: "quota", source: "circuit",
      queueDurationMs: 0, providerDurationMs: 0,
    }]);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("joins the independent Codex queue on fallback without misordering events", async () => {
    const { promise: codexGate, resolve: releaseCodex } = deferred();
    const state = createProviderState();
    const blocker = state.admit("codex", { family: "scoring", jobId: "blocker" }, async () => {
      await codexGate;
    });
    const { promise: fallbackSeen, resolve: fallbackObserved } = deferred();
    const events: ReasoningEvent[] = [];
    const routed = runSkillTask(
      skillRequest((event) => {
        events.push(event);
        if (event.state === "fallback") fallbackObserved();
      }),
      {
        providerState: state,
        runClaude: vi
          .fn()
          .mockResolvedValue(failure("claude", "invalid-output")),
        runCodex: vi
          .fn()
          .mockResolvedValue(success("codex", { answer: "queued fallback" })),
        onLog: () => undefined,
      }
    );

    await fallbackSeen;
    expect(events).toEqual([
      { state: "running", provider: "claude" },
      {
        state: "fallback",
        provider: "codex",
        fallbackFrom: "claude",
        failureKind: "invalid-output",
      },
      { state: "queued", provider: "codex", queuePosition: 0 },
    ]);

    releaseCodex();
    await blocker;
    await expect(routed).resolves.toMatchObject({
      ok: true,
      provider: "codex",
    });
    expect(events.at(-1)).toEqual({
      state: "running",
      provider: "codex",
      fallbackFrom: "claude",
    });
  });

  it("falls back for invalid output without opening the shared circuit", async () => {
    const state = createProviderState({ now: () => 1_000 });
    const runClaude = vi
      .fn()
      .mockResolvedValueOnce(failure("claude", "invalid-output"))
      .mockResolvedValueOnce(success("claude", { answer: "recovered" }));
    const runCodex = vi
      .fn()
      .mockResolvedValue(success("codex", { answer: "fallback" }));
    const deps = {
      providerState: state,
      runClaude,
      runCodex,
      onLog: () => undefined,
    };

    await expect(runSkillTask(skillRequest(), deps)).resolves.toMatchObject({
      ok: true,
      provider: "codex",
    });
    await expect(runSkillTask(skillRequest(), deps)).resolves.toMatchObject({
      ok: true,
      provider: "claude",
    });
    expect(runClaude).toHaveBeenCalledTimes(2);
  });
});

// The OpenAI text Judge runs Codex, then OpenAI HTTP; OPENAI_TEXT_PRIMARY=http makes it HTTP only
// (ADR 0003).
describe("OpenAI text route", () => {
  it("runs Codex first with the existing Judge prompt unchanged", async () => {
    const events: ReasoningEvent[] = [];
    const runCodex = vi
      .fn()
      .mockResolvedValue(success("codex", { answer: "codex" }));
    const runHttp = vi.fn();
    const request = openAiRequest((event) => events.push(event));

    const result = await runOpenAiText(request, {
      providerState: createProviderState(),
      openaiTextPrimary: "codex",
      runCodex,
      runHttp: runHttp as never,
      onLog: () => undefined,
    });

    expect(result).toEqual({
      ok: true,
      provider: "codex",
      value: { answer: "codex" },
      attempts: [],
    });
    expect(runCodex).toHaveBeenCalledWith({
      prompt: request.prompt,
      jsonSchema: request.jsonSchema,
      parse: request.parse,
      bin: config.codexBin,
      model: config.codexModel,
      reasoningEffort: config.codexReasoningEffort,
      deadline: expect.objectContaining({
        expiresAtMs: expect.any(Number),
      }),
      onTranscript: expect.any(Function),
    });
    expect(runHttp).not.toHaveBeenCalled();
    expect(events).toEqual([{ state: "running", provider: "codex" }]);
  });

  it("routes one real ScoreReport schema unchanged through Codex and HTTP", async () => {
    const jsonSchema = z.toJSONSchema(ScoreReportSchema);
    const runCodex = vi.fn().mockResolvedValue(failure("codex", "quota"));
    const runHttp = vi
      .fn()
      .mockResolvedValue(success("openai-http", { answer: "safe" }));

    await expect(
      runOpenAiText(
        { ...openAiRequest(), jsonSchema },
        {
          providerState: createProviderState(),
          openaiTextPrimary: "codex",
          runCodex,
          runHttp,
          onLog: () => undefined,
        }
      )
    ).resolves.toMatchObject({ ok: true, provider: "openai-http" });

    const codexSchema = runCodex.mock.calls[0]?.[0].jsonSchema;
    const httpSchema = runHttp.mock.calls[0]?.[0].jsonSchema;
    expect(codexSchema).toBe(httpSchema);
    expect(JSON.stringify(httpSchema)).toBe(JSON.stringify(jsonSchema));
  });

  it("falls back from eligible Codex failure to HTTP with exact events", async () => {
    const events: ReasoningEvent[] = [];
    const request = openAiRequest((event) => events.push(event));
    const runHttp = vi
      .fn()
      .mockResolvedValue(success("openai-http", { answer: "http" }));

    const result = await runOpenAiText(request, {
      providerState: createProviderState(),
      openaiTextPrimary: "codex",
      runCodex: vi.fn().mockResolvedValue(failure("codex", "rate-limit")),
      runHttp,
      onLog: () => undefined,
    });

    expect(result).toEqual({
      ok: true,
      provider: "openai-http",
      value: { answer: "http" },
      attempts: [{ provider: "codex", kind: "rate-limit" }],
    });
    expect(runHttp).toHaveBeenCalledWith({
      prompt: request.prompt,
      jsonSchema: request.jsonSchema,
      parse: request.parse,
      model: config.openaiJudgeModel,
    });
    expect(events).toEqual([
      { state: "running", provider: "codex" },
      {
        state: "fallback",
        provider: "openai-http",
        fallbackFrom: "codex",
        failureKind: "rate-limit",
      },
      {
        state: "running",
        provider: "openai-http",
        fallbackFrom: "codex",
      },
    ]);
  });

  it("treats a late Codex success as a timeout and falls back to HTTP, without opening Codex's circuit", async () => {
    const clock = fakeClock();
    const state = createProviderState();
    const runCodex = vi.fn().mockImplementation(async () => {
      clock.advance(300_001);
      return success("codex", { answer: "late" });
    });
    const runHttp = vi
      .fn()
      .mockResolvedValue(success("openai-http", { answer: "fallback" }));
    const deps = {
      providerState: state,
      openaiTextPrimary: "codex" as const,
      runCodex,
      runHttp,
      onLog: () => undefined,
      now: clock.now,
    };

    await expect(runOpenAiText(openAiRequest(), deps)).resolves.toEqual({
      ok: true,
      provider: "openai-http",
      value: { answer: "fallback" },
      attempts: [{ provider: "codex", kind: "timeout" }],
    });
    await expect(runOpenAiText(openAiRequest(), deps)).resolves.toEqual({
      ok: true,
      provider: "openai-http",
      value: { answer: "fallback" },
      attempts: [{ provider: "codex", kind: "timeout" }],
    });
    // A timeout records capacity, not a circuit: the second request still reaches Codex.
    expect(runCodex).toHaveBeenCalledTimes(2);
    expect(state.circuitOpen("codex")).toBe(false);
    expect(runHttp).toHaveBeenCalledTimes(2);
  });

  it("holds Codex fallback and its same-provider queue until the real adapter teardown removes its known temp directory", async () => {
    const fakeTimers = useFakeTimersInTest();
    vi.setSystemTime(0);
    const savedConfig = saveReasoningConfig();
    const heartbeatPath = path.join(
      os.tmpdir(),
      `toefl-route-codex-teardown-${process.pid}-${Date.now()}`,
    );
    const cleanupGate = deferred();
    const cleanupStarted = deferred();
    const realMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
    const realRm = fs.promises.rm.bind(fs.promises);
    const realKill = process.kill.bind(process);
    let tempDir: string | undefined;
    let cleanupHasStarted = false;
    let groupKillSignals = 0;
    const mkdtemp = vi
      .spyOn(fs.promises, "mkdtemp")
      .mockImplementation(async (prefix: string) => {
        const created = await realMkdtemp(prefix);
        if (path.basename(prefix) === "toefl-codex-") {
          if (tempDir !== undefined) {
            throw new Error(
              "same-provider queue started a second Codex adapter",
            );
          }
          tempDir = created;
        }
        return created;
      });
    const rm = vi
      .spyOn(fs.promises, "rm")
      .mockImplementation(
        async (...args: Parameters<typeof fs.promises.rm>) => {
          if (String(args[0]) === tempDir) {
            cleanupHasStarted = true;
            cleanupStarted.resolve();
            await cleanupGate.promise;
          }
          return Reflect.apply(realRm, fs.promises, args);
        },
    );
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation(
        (...args: Parameters<typeof process.kill>) => {
          if (args[0] < 0 && args[1] === "SIGKILL") {
            groupKillSignals += 1;
          }
          return realKill(...args);
        },
      );
    let heartbeatProcessId: number | undefined;
    const runCodex = vi.fn(productionRunCodex);
    const fallbackEvidence: {
      readonly tempExists: boolean;
      readonly heartbeatSize: number;
    }[] = [];
    const runHttp = vi.fn().mockImplementation(async () => {
      expect(tempDir).toBeDefined();
      expect(heartbeatProcessId).toBeDefined();
      expect(groupKillSignals).toBeGreaterThan(0);
      fallbackEvidence.push({
        tempExists: fs.existsSync(tempDir!),
        heartbeatSize: heartbeatSize(heartbeatPath),
      });
      return success("openai-http", { answer: "fallback" });
    });
    const state = createProviderState();
    const deps = {
      providerState: state,
      openaiTextPrimary: "codex" as const,
      runCodex: runCodex as never,
      runHttp,
      onLog: () => undefined,
      now: () => Date.now(),
    };
    try {
      config.codexBin = fakeCodexBin;
      const first = runOpenAiText(
        {
          ...openAiRequest(),
          prompt: `[FAKE_CODEX:TREE_HANG:${heartbeatPath}]`,
        },
        deps,
      );
      heartbeatProcessId = await waitForHeartbeat(heartbeatPath);
      expect(tempDir).toBeDefined();

      const queued = runOpenAiText(openAiRequest(), deps);
      await fakeTimers.advanceBy(300_000);
      await advanceFakeTimersUntil(
        fakeTimers.advanceBy,
        () => cleanupHasStarted,
        "Codex adapter did not finish process teardown",
      );
      await withinRealTimeout(
        cleanupStarted.promise,
        "Codex cleanup did not start",
      );

      expect(fs.existsSync(tempDir!)).toBe(true);
      expect(runHttp).not.toHaveBeenCalled();
      expect(runCodex).toHaveBeenCalledOnce();

      cleanupGate.resolve();
      await expect(first).resolves.toEqual({
        ok: true,
        provider: "openai-http",
        value: { answer: "fallback" },
        attempts: [{ provider: "codex", kind: "timeout" }],
      });
      await expect(queued).resolves.toMatchObject({ ok: false });
      expect(runCodex).toHaveBeenCalledTimes(2);
      expect(runHttp).toHaveBeenCalledTimes(1);
      expect(fallbackEvidence).toHaveLength(1);
      expect(
        fallbackEvidence.every(
          (entry) => entry.tempExists === false,
        ),
      ).toBe(true);
      await new Promise<void>((resolve) => {
        realSetTimeout(resolve, 40);
      });
      expect(heartbeatSize(heartbeatPath)).toBe(
        fallbackEvidence[0].heartbeatSize,
      );
      await expectProcessEventuallyGone(heartbeatProcessId!);
    } finally {
      cleanupGate.resolve();
      mkdtemp.mockRestore();
      rm.mockRestore();
      kill.mockRestore();
      restoreReasoningConfig(savedConfig);
      cleanupHeartbeat(heartbeatPath);
      if (tempDir) {
        await realRm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("starts real-clock Codex process-group termination before fallback or queued-route continuation", async () => {
    const savedConfig = saveReasoningConfig();
    const heartbeatPath = path.join(
      os.tmpdir(),
      `toefl-route-codex-real-clock-${process.pid}-${Date.now()}`,
    );
    const killStarted = deferred();
    const realMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
    const realRm = fs.promises.rm.bind(fs.promises);
    const realKill = process.kill.bind(process);
    let tempDir: string | undefined;
    const lifecycle: {
      readonly event:
        | "kill"
        | "fallback-enter"
        | "queued-fallback-enter";
      readonly atMs: number;
    }[] = [];
    const fallbackEvidence: {
      readonly tempExists: boolean;
      readonly heartbeatSize: number;
    }[] = [];
    const mkdtemp = vi
      .spyOn(fs.promises, "mkdtemp")
      .mockImplementation(async (prefix: string) => {
        const created = await realMkdtemp(prefix);
        if (path.basename(prefix) === "toefl-codex-") {
          if (tempDir !== undefined) {
            throw new Error(
              "queued route started a second Codex process",
            );
          }
          tempDir = created;
        }
        return created;
      });
    const rm = vi
      .spyOn(fs.promises, "rm")
      .mockImplementation(
        async (...args: Parameters<typeof fs.promises.rm>) => {
          if (String(args[0]) === tempDir) {
            fs.rmSync(tempDir!, { recursive: true, force: true });
            return;
          }
          return Reflect.apply(realRm, fs.promises, args);
        },
      );
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation(
        (...args: Parameters<typeof process.kill>) => {
          if (
            args[0] < 0 &&
            args[1] === "SIGKILL" &&
            !lifecycle.some((entry) => entry.event === "kill")
          ) {
            lifecycle.push({
              event: "kill",
              atMs: performance.now(),
            });
            killStarted.resolve();
          }
          return realKill(...args);
        },
      );
    const runCodex = vi.fn(
      (options: Parameters<typeof productionRunCodex>[0]) =>
        productionRunCodex({
          ...options,
          deadline: undefined,
          timeoutMs: 250,
        }),
    );
    let fallbackCalls = 0;
    const runHttp = vi.fn().mockImplementation(async () => {
      const event =
        fallbackCalls === 0
          ? "fallback-enter"
          : "queued-fallback-enter";
      fallbackCalls += 1;
      lifecycle.push({ event, atMs: performance.now() });
      fallbackEvidence.push({
        tempExists:
          tempDir === undefined || fs.existsSync(tempDir),
        heartbeatSize: heartbeatSize(heartbeatPath),
      });
      await killStarted.promise;
      return success("openai-http", { answer: "fallback" });
    });
    const state = createProviderState();
    const deps = {
      providerState: state,
      openaiTextPrimary: "codex" as const,
      runCodex: runCodex as never,
      runHttp,
      onLog: () => undefined,
    };
    try {
      config.codexBin = fakeCodexBin;
      const first = runOpenAiText(
        {
          ...openAiRequest(),
          prompt: `[FAKE_CODEX:TREE_HANG:${heartbeatPath}]`,
        },
        deps,
      );
      const heartbeatProcessId =
        await waitForHeartbeat(heartbeatPath);
      const queued = runOpenAiText(openAiRequest(), deps);

      await expect(first).resolves.toEqual({
        ok: true,
        provider: "openai-http",
        value: { answer: "fallback" },
        attempts: [{ provider: "codex", kind: "timeout" }],
      });
      await expect(queued).resolves.toMatchObject({ ok: false });

      expect(lifecycle.map((entry) => entry.event)).toEqual([
        "kill",
        "fallback-enter",
      ]);
      expect(
        fallbackEvidence.every(
          (entry) => entry.tempExists === false,
        ),
      ).toBe(true);
      expect(fallbackEvidence).toHaveLength(1);
      await new Promise<void>((resolve) => {
        realSetTimeout(resolve, 40);
      });
      expect(heartbeatSize(heartbeatPath)).toBe(
        fallbackEvidence[0].heartbeatSize,
      );
      await expectProcessEventuallyGone(heartbeatProcessId);
      expect(runCodex).toHaveBeenCalledTimes(2);
      expect(runHttp).toHaveBeenCalledOnce();
    } finally {
      mkdtemp.mockRestore();
      rm.mockRestore();
      kill.mockRestore();
      restoreReasoningConfig(savedConfig);
      cleanupHeartbeat(heartbeatPath);
      if (tempDir) {
        await realRm(tempDir, { recursive: true, force: true });
      }
    }
  });

  it("uses HTTP only in rollback mode and never invokes Codex", async () => {
    const events: ReasoningEvent[] = [];
    const runCodex = vi.fn();
    const result = await runOpenAiText(
      openAiRequest((event) => events.push(event)),
      {
        providerState: createProviderState(),
        openaiTextPrimary: "http",
        runCodex: runCodex as never,
        runHttp: vi
          .fn()
          .mockResolvedValue(success("openai-http", { answer: "rollback" })),
        onLog: () => undefined,
      }
    );

    expect(result).toEqual({
      ok: true,
      provider: "openai-http",
      value: { answer: "rollback" },
      attempts: [],
    });
    expect(runCodex).not.toHaveBeenCalled();
    expect(events).toEqual([
      { state: "running", provider: "openai-http" },
    ]);
  });

  it.each(["configuration", "application"] as const)(
    "does not hide a Codex %s failure behind HTTP",
    async (kind) => {
      const runHttp = vi.fn();
      const result = await runOpenAiText(openAiRequest(), {
        providerState: createProviderState(),
        openaiTextPrimary: "codex",
        runCodex: vi.fn().mockResolvedValue(failure("codex", kind)),
        runHttp: runHttp as never,
        onLog: () => undefined,
      });

      expect(result).toEqual({
        ok: false,
        error: `Structured reasoning unavailable: Codex (${kind}).`,
        attempts: [{ provider: "codex", kind }],
      });
      expect(runHttp).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      "failed",
      vi.fn().mockResolvedValue(
        leakyFailure("codex", "provider") as unknown as ProviderResult<
          never,
          "openai-http"
        >
      ),
      "provider",
    ],
    [
      "thrown",
      vi.fn().mockRejectedValue(new Error(SECRET)),
      "application",
    ],
  ] as const)(
    "stops after HTTP and sanitizes %s HTTP details",
    async (_case, runHttp, expectedKind) => {
      const logs: ReasoningRouteLog[] = [];
      const events: ReasoningEvent[] = [];
      const result = await runOpenAiText(
        openAiRequest((event) => events.push(event)),
        {
          providerState: createProviderState(),
          openaiTextPrimary: "codex",
          runCodex: vi
            .fn()
            .mockResolvedValue(leakyFailure("codex", "quota")),
          runHttp,
          onLog: (entry) => logs.push(entry),
        }
      );

      expect(result).toEqual({
        ok: false,
        error:
          `Structured reasoning unavailable: Codex (quota) → OpenAI HTTP (${expectedKind}).`,
        attempts: [
          { provider: "codex", kind: "quota" },
          { provider: "openai-http", kind: expectedKind },
        ],
      });
      expect(JSON.stringify({ result, events, logs })).not.toContain(SECRET);
      expect(JSON.stringify(result)).not.toMatch(/source|stderr|output/);
    }
  );
});

describe("route observers and logging", () => {
  it.each([
    () => {
      throw new Error(SECRET);
    },
    () => Promise.reject(new Error(SECRET)),
  ])("does not let a throwing or rejected event observer change routing", async (throwingObserver) => {
    const onEvent = vi.fn(throwingObserver);
    const result = await runSkillTask(skillRequest(onEvent), {
      providerState: createProviderState(),
      runClaude: vi
        .fn()
        .mockResolvedValue(failure("claude", "invalid-output")),
      runCodex: vi
        .fn()
        .mockResolvedValue(success("codex", { answer: "safe" })),
      onLog: () => undefined,
    });

    expect(result).toMatchObject({
      ok: true,
      provider: "codex",
      value: { answer: "safe" },
    });
    expect(onEvent).toHaveBeenCalled(); // the observer really ran, and threw or rejected
  });

  it("partitions an immediate CLI call into zero queue wait and provider time", async () => {
    const clock = fakeClock(100);
    const logs: ReasoningRouteLog[] = [];
    const result = await runOpenAiText(openAiRequest(), {
      providerState: createProviderState(),
      openaiTextPrimary: "codex",
      runCodex: vi.fn().mockImplementation(async () => {
        clock.advance(7);
        return success("codex", { answer: "safe" });
      }),
      runHttp: vi.fn(),
      onLog: (entry) => logs.push(entry),
      now: clock.now,
    });

    expect(result).toMatchObject({ ok: true, provider: "codex" });
    expect(logs).toEqual([
      {
        state: "running",
        provider: "codex",
        model: config.codexModel,
        queueDurationMs: 0,
      },
      {
        state: "succeeded",
        provider: "codex",
        model: config.codexModel,
        source: "call",
        queueDurationMs: 0,
        providerDurationMs: 7,
      },
    ]);
  });

  it("uses one running timestamp so observer time is not omitted", async () => {
    const clock = fakeClock();
    const logs: ReasoningRouteLog[] = [];
    const routeStartedAt = clock.now();
    const result = await runOpenAiText(
      openAiRequest((event) => {
        if (event.state === "running") clock.advance(2);
      }),
      {
        providerState: createProviderState(),
        openaiTextPrimary: "codex",
        runCodex: vi.fn().mockImplementation(async () => {
          clock.advance(5);
          return success("codex", { answer: "safe" });
        }),
        runHttp: vi.fn(),
        onLog: (entry) => {
          logs.push(entry);
          if (entry.state === "running") clock.advance(3);
        },
        now: clock.now,
      }
    );
    const routeFinishedAt = clock.now();

    expect(result).toMatchObject({ ok: true, provider: "codex" });
    expect(logs).toEqual([
      {
        state: "running",
        provider: "codex",
        model: config.codexModel,
        queueDurationMs: 0,
      },
      {
        state: "succeeded",
        provider: "codex",
        model: config.codexModel,
        source: "call",
        queueDurationMs: 0,
        providerDurationMs: 10,
      },
    ]);
    const terminal = logs[1];
    if (
      terminal?.state !== "succeeded" &&
      terminal?.state !== "failed"
    ) {
      throw new Error("expected terminal telemetry");
    }
    expect(
      terminal.queueDurationMs + terminal.providerDurationMs
    ).toBe(routeFinishedAt - routeStartedAt);
  });

  it("partitions queued wait from provider execution at the running transition", async () => {
    const clock = fakeClock();
    const state = createProviderState();
    const { promise: blockerGate, resolve: releaseBlocker } = deferred();
    const blocker = state.admit("codex", { family: "scoring", jobId: "blocker" }, async () => {
      await blockerGate;
    });
    const logs: ReasoningRouteLog[] = [];
    const routed = runOpenAiText(openAiRequest(), {
      providerState: state,
      openaiTextPrimary: "codex",
      runCodex: vi.fn().mockImplementation(async () => {
        clock.advance(4);
        return success("codex", { answer: "safe" });
      }),
      runHttp: vi.fn(),
      onLog: (entry) => logs.push(entry),
      now: clock.now,
    });

    expect(logs).toEqual([
      {
        state: "queued",
        provider: "codex",
        model: config.codexModel,
        queuePosition: 0,
      },
    ]);
    clock.advance(9);
    releaseBlocker();
    await blocker;
    await expect(routed).resolves.toMatchObject({
      ok: true,
      provider: "codex",
    });

    expect(logs).toEqual([
      {
        state: "queued",
        provider: "codex",
        model: config.codexModel,
        queuePosition: 0,
      },
      {
        state: "running",
        provider: "codex",
        model: config.codexModel,
        queueDurationMs: 9,
      },
      {
        state: "succeeded",
        provider: "codex",
        model: config.codexModel,
        source: "call",
        queueDurationMs: 9,
        providerDurationMs: 4,
      },
    ]);
  });

  it("attributes queued observers before running and all running observers after it", async () => {
    const clock = fakeClock();
    const state = createProviderState();
    const { promise: blockerGate, resolve: releaseBlocker } = deferred();
    const blocker = state.admit("codex", { family: "scoring", jobId: "blocker" }, async () => {
      await blockerGate;
    });
    const logs: ReasoningRouteLog[] = [];
    const routeStartedAt = clock.now();
    const routed = runOpenAiText(
      openAiRequest((event) => {
        if (event.state === "queued") clock.advance(2);
        if (event.state === "running") clock.advance(5);
      }),
      {
        providerState: state,
        openaiTextPrimary: "codex",
        runCodex: vi.fn().mockImplementation(async () => {
          clock.advance(7);
          return success("codex", { answer: "safe" });
        }),
        runHttp: vi.fn(),
        onLog: (entry) => {
          logs.push(entry);
          if (entry.state === "queued") clock.advance(3);
          if (entry.state === "running") clock.advance(6);
        },
        now: clock.now,
      }
    );

    expect(logs[0]).toEqual({
      state: "queued",
      provider: "codex",
      model: config.codexModel,
      queuePosition: 0,
    });
    clock.advance(4);
    releaseBlocker();
    await blocker;
    await routed;
    const routeFinishedAt = clock.now();

    expect(logs).toEqual([
      {
        state: "queued",
        provider: "codex",
        model: config.codexModel,
        queuePosition: 0,
      },
      {
        state: "running",
        provider: "codex",
        model: config.codexModel,
        queueDurationMs: 9,
      },
      {
        state: "succeeded",
        provider: "codex",
        model: config.codexModel,
        source: "call",
        queueDurationMs: 9,
        providerDurationMs: 18,
      },
    ]);
    const terminal = logs[2];
    if (
      terminal?.state !== "succeeded" &&
      terminal?.state !== "failed"
    ) {
      throw new Error("expected terminal telemetry");
    }
    expect(
      terminal.queueDurationMs + terminal.providerDurationMs
    ).toBe(routeFinishedAt - routeStartedAt);
  });

  it("logs sanitized fallback and HTTP transitions in causal order", async () => {
    const clock = fakeClock();
    const logs: ReasoningRouteLog[] = [];
    const result = await runOpenAiText(openAiRequest(), {
      providerState: createProviderState(),
      openaiTextPrimary: "codex",
      runCodex: vi.fn().mockImplementation(async () => {
        clock.advance(3);
        return leakyFailure("codex", "provider");
      }),
      runHttp: vi.fn().mockImplementation(async () => {
        clock.advance(8);
        return success("openai-http", { answer: "safe" });
      }),
      onLog: (entry) => logs.push(entry),
      now: clock.now,
    });

    expect(result).toMatchObject({ ok: true, provider: "openai-http" });
    expect(logs).toEqual([
      {
        state: "running",
        provider: "codex",
        model: config.codexModel,
        queueDurationMs: 0,
      },
      {
        state: "failed",
        provider: "codex",
        model: config.codexModel,
        source: "call",
        queueDurationMs: 0,
        providerDurationMs: 3,
        failureKind: "provider",
      },
      {
        state: "fallback",
        provider: "openai-http",
        model: config.openaiJudgeModel,
        fallbackFrom: "codex",
        failureKind: "provider",
      },
      {
        state: "running",
        provider: "openai-http",
        model: config.openaiJudgeModel,
        queueDurationMs: 0,
      },
      {
        state: "succeeded",
        provider: "openai-http",
        model: config.openaiJudgeModel,
        source: "call",
        queueDurationMs: 0,
        providerDurationMs: 8,
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(JSON.stringify(logs)).not.toMatch(
      /prompt|schema|output|stderr|credential|auth-token/
    );
  });

  it("keeps queued telemetry reentrant without changing FIFO order", async () => {
    const state = createProviderState();
    const { promise: blockerGate, resolve: releaseBlocker } = deferred();
    const order: string[] = [];
    const blocker = state.admit("codex", { family: "scoring", jobId: "blocker" }, async () => {
      order.push("blocker");
      await blockerGate;
    });
    const logs: ReasoningRouteLog[] = [];
    let reentered: Promise<void> | undefined;
    const routed = runOpenAiText(openAiRequest(), {
      providerState: state,
      openaiTextPrimary: "codex",
      runCodex: vi.fn().mockImplementation(async () => {
        order.push("routed");
        return success("codex", { answer: "safe" });
      }),
      runHttp: vi.fn(),
      onLog: (entry) => {
        logs.push(entry);
        if (entry.state === "queued" && reentered === undefined) {
          reentered = state.admit("codex", { family: "scoring", jobId: "reentered" }, async () => {
            order.push("reentered");
          });
        }
      },
    });

    expect(reentered).toBeDefined();
    expect(logs[0]).toMatchObject({
      state: "queued",
      provider: "codex",
      queuePosition: 0,
    });
    releaseBlocker();
    await Promise.all([blocker, routed, reentered!]);
    expect(order).toEqual(["blocker", "routed", "reentered"]);
  });

  it.each([
    () => {
      throw new Error(SECRET);
    },
    () => Promise.reject(new Error(SECRET)),
  ])("does not let a throwing or rejected log observer change routing", async (throwingObserver) => {
    const onLog = vi.fn(throwingObserver);
    await expect(
      runOpenAiText(openAiRequest(), {
        providerState: createProviderState(),
        openaiTextPrimary: "http",
        runHttp: vi
          .fn()
          .mockResolvedValue(success("openai-http", { answer: "safe" })),
        onLog,
      })
    ).resolves.toMatchObject({
      ok: true,
      provider: "openai-http",
      value: { answer: "safe" },
    });
    expect(onLog).toHaveBeenCalled(); // the observer really ran, and threw or rejected
  });
});

// The generation family (plan, generate, verify) gets a longer budget than other skill work: real
// Reading runs have measured generate and verify calls near 600s, and others well under half that,
// so a tighter cap would kill healthy runs.
describe("per-family route budgets", () => {
  function readingRequest(
    task: "plan" | "generate" | "verify"
  ): SkillTaskRequest<{ answer: string }> {
    return {
      task: { task, context: "reading" } as never,
      prompt: `${task.toUpperCase()} READING\n${SECRET}`,
      jsonSchema: schema,
      parse,
    };
  }

  // Claude's two budgets share the 750s default, so a Claude deadline alone cannot show which family
  // a task was put in. The tests that classify by Claude's deadline move the scoring budget away
  // from 750s first.
  function withDistinctClaudeScoringBudget<T>(run: () => Promise<T>): Promise<T> {
    const saved = config.claudeRouteTimeoutMs;
    config.claudeRouteTimeoutMs = 123_000;
    return run().finally(() => {
      config.claudeRouteTimeoutMs = saved;
    });
  }

  // Claude's generation-family budget is 750s and Codex's 900s. Claude's successful Listening
  // `generate` calls have run up to about 700s, and a stalled one is given up sooner so Codex, which
  // finishes the same call in roughly 280-320s, gets to run.
  it("gives a generate:reading call Claude's 750s generation-family deadline, lower than Codex's", async () => {
    const clock = fakeClock();
    const runClaude = vi
      .fn()
      .mockResolvedValue(success("claude", { answer: "generated" }));
    const runCodex = vi.fn();

    const result = await withDistinctClaudeScoringBudget(() => runSkillTask(readingRequest("generate"), {
      providerState: createProviderState(),
      runClaude,
      runCodex,
      onLog: () => undefined,
      now: clock.now,
    }));

    expect(result).toMatchObject({ ok: true, provider: "claude" });
    expect(
      runClaude.mock.calls[0]?.[0].deadline.expiresAtMs
    ).toBe(750_000);
    expect(runCodex).not.toHaveBeenCalled();
  });

  it("gives a generate:reading call Claude's 750s deadline and Codex's 900s deadline across fallback", async () => {
    const clock = fakeClock();
    const runClaude = vi.fn().mockResolvedValue(failure("claude", "quota"));
    const runCodex = vi
      .fn()
      .mockResolvedValue(success("codex", { answer: "generated" }));

    const result = await runSkillTask(readingRequest("generate"), {
      providerState: createProviderState(),
      runClaude,
      runCodex,
      onLog: () => undefined,
      now: clock.now,
    });

    expect(result).toMatchObject({ ok: true, provider: "codex" });
    // Claude is attempted first; Codex runs only as its fallback.
    expect(
      runClaude.mock.calls[0]?.[0].deadline.expiresAtMs
    ).toBe(750_000);
    expect(
      runCodex.mock.calls[0]?.[0].deadline.expiresAtMs
    ).toBe(900_000);
  });

  it.each([
    ["plan", "reading"],
    ["generate", "reading"],
    ["verify", "reading"],
    ["import", "writing"],
  ] as const)(
    "classifies %s:%s as the generation family on Claude's 750s budget",
    async (task, context) => {
      const clock = fakeClock();
      const runClaude = vi
        .fn()
        .mockResolvedValue(success("claude", { answer: "ok" }));

      await withDistinctClaudeScoringBudget(() => runSkillTask(
        {
          task: { task, context } as never,
          prompt: `${task}:${context}`,
          jsonSchema: schema,
          parse,
        },
        {
          providerState: createProviderState(),
          runClaude,
          runCodex: vi.fn(),
          onLog: () => undefined,
          now: clock.now,
        }
      ));

      expect(
        runClaude.mock.calls[0]?.[0].deadline.expiresAtMs
      ).toBe(750_000);
    }
  );

  it.each([
    ["plan", "reading"],
    ["generate", "reading"],
    ["verify", "reading"],
    ["import", "writing"],
  ] as const)(
    "classifies %s:%s as the generation family on Codex's 900s budget when it is the fallback",
    async (task, context) => {
      const clock = fakeClock();
      const runClaude = vi.fn().mockResolvedValue(failure("claude", "quota"));
      const runCodex = vi
        .fn()
        .mockResolvedValue(success("codex", { answer: "ok" }));

      await runSkillTask(
        {
          task: { task, context } as never,
          prompt: `${task}:${context}`,
          jsonSchema: schema,
          parse,
        },
        {
          providerState: createProviderState(),
          runClaude,
          runCodex,
          onLog: () => undefined,
          now: clock.now,
        }
      );

      expect(
        runCodex.mock.calls[0]?.[0].deadline.expiresAtMs
      ).toBe(900_000);
    }
  );

  it("uses the confirmed aggregate:email scoring-family deadlines (750s Claude / 300s Codex)", async () => {
    const clock = fakeClock();
    const runClaude = vi.fn().mockResolvedValue(failure("claude", "quota"));
    const runCodex = vi
      .fn()
      .mockResolvedValue(success("codex", { answer: "scored" }));

    const result = await runSkillTask(skillRequest(), {
      providerState: createProviderState(),
      runClaude,
      runCodex,
      onLog: () => undefined,
      now: clock.now,
    });

    expect(result).toMatchObject({ ok: true, provider: "codex" });
    expect(runClaude.mock.calls[0]?.[0].deadline.expiresAtMs).toBe(
      750_000
    );
    expect(runCodex.mock.calls[0]?.[0].deadline.expiresAtMs).toBe(
      300_000
    );
  });

  it("honors an independently configured value for each of the four route budgets", async () => {
    const savedClaudeGeneration = config.claudeGenerationRouteTimeoutMs;
    const savedCodexGeneration = config.codexGenerationRouteTimeoutMs;
    const savedClaude = config.claudeRouteTimeoutMs;
    const savedCodex = config.codexRouteTimeoutMs;
    // Asymmetric, and not the shipped 750s/900s defaults, so this cannot pass by matching the
    // defaults: it passes only if the router reads each provider's own configured value for the
    // generation family, independent of the other three.
    config.claudeGenerationRouteTimeoutMs = 11_111;
    config.codexGenerationRouteTimeoutMs = 22_222;
    config.claudeRouteTimeoutMs = 6_789;
    config.codexRouteTimeoutMs = 9_876;
    try {
      const generationClock = fakeClock();
      const runClaudeGeneration = vi
        .fn()
        .mockResolvedValue(failure("claude", "quota"));
      const runCodexGeneration = vi
        .fn()
        .mockResolvedValue(success("codex", { answer: "ok" }));
      await runSkillTask(readingRequest("verify"), {
        providerState: createProviderState(),
        runClaude: runClaudeGeneration,
        runCodex: runCodexGeneration,
        onLog: () => undefined,
        now: generationClock.now,
      });
      expect(
        runClaudeGeneration.mock.calls[0]?.[0].deadline.expiresAtMs
      ).toBe(11_111);
      expect(
        runCodexGeneration.mock.calls[0]?.[0].deadline.expiresAtMs
      ).toBe(22_222);

      const scoringClock = fakeClock();
      const runClaudeScoring = vi
        .fn()
        .mockResolvedValue(failure("claude", "quota"));
      const runCodexScoring = vi
        .fn()
        .mockResolvedValue(success("codex", { answer: "ok" }));
      await runSkillTask(skillRequest(), {
        providerState: createProviderState(),
        runClaude: runClaudeScoring,
        runCodex: runCodexScoring,
        onLog: () => undefined,
        now: scoringClock.now,
      });
      expect(
        runClaudeScoring.mock.calls[0]?.[0].deadline.expiresAtMs
      ).toBe(6_789);
      expect(
        runCodexScoring.mock.calls[0]?.[0].deadline.expiresAtMs
      ).toBe(9_876);
    } finally {
      config.claudeGenerationRouteTimeoutMs = savedClaudeGeneration;
      config.codexGenerationRouteTimeoutMs = savedCodexGeneration;
      config.claudeRouteTimeoutMs = savedClaude;
      config.codexRouteTimeoutMs = savedCodex;
    }
  });

  it("applies the configured Codex route budget to the OpenAI text route's Codex leg too", async () => {
    const savedCodex = config.codexRouteTimeoutMs;
    config.codexRouteTimeoutMs = 42_000;
    try {
      const clock = fakeClock();
      const runCodex = vi
        .fn()
        .mockResolvedValue(success("codex", { answer: "safe" }));

      await runOpenAiText(openAiRequest(), {
        providerState: createProviderState(),
        openaiTextPrimary: "codex",
        runCodex,
        runHttp: vi.fn(),
        onLog: () => undefined,
        now: clock.now,
      });

      expect(
        runCodex.mock.calls[0]?.[0].deadline.expiresAtMs
      ).toBe(42_000);
    } finally {
      config.codexRouteTimeoutMs = savedCodex;
    }
  });
});
