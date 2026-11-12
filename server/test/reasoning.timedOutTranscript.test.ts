import { afterEach, describe, expect, it, vi } from "vitest";
import { useFakeTimersInTest } from "./helpers/fakeTimers.js";
import { openDb } from "../src/db/db.js";
import { config } from "../src/lib/config.js";
import type { RunClaudeOptions } from "../src/services/claudeRunner.js";
import {
  createRepoModelCallSink,
  flushModelCallRecorder,
  resetModelCallSink,
  setModelCallSink,
  withModelCallContext,
} from "../src/services/modelCallLog.js";
import { PROVIDER_TEARDOWN_GRACE_MS } from "../src/services/reasoning/deadline.js";
import { createProviderState } from "../src/services/reasoning/providerState.js";
import { runSkillTask } from "../src/services/reasoning/router.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

afterEach(() => {
  resetModelCallSink();
});

describe("a timed-out attempt's transcript", () => {
  it("is recorded even when the runner reports it after the route has moved on", async () => {
    const clock = useFakeTimersInTest({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(0);
    const db = openDb(":memory:");
    setModelCallSink(createRepoModelCallSink(sqliteStores(db)));

    // A runner still tearing down a killed CLI when the route's teardown grace runs out: its
    // transcript, the only record of what the CLI said before the deadline, arrives late.
    let finishTeardown!: () => void;
    const runClaude = vi.fn((options: RunClaudeOptions<unknown>) => new Promise((resolve) => {
      finishTeardown = () => {
        options.onTranscript?.({ prompt: options.prompt, response: "stream written before the kill" });
        resolve({ ok: false, failure: { provider: "claude", kind: "timeout", source: "call" } });
      };
    }));

    const routed = withModelCallContext({ kind: "scoring-job", id: "slow-job" }, () =>
      runSkillTask(
        {
          task: { task: "aggregate", context: "email" },
          prompt: "aggregate",
          jsonSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
          parse: (value: unknown) => value as { answer: string },
        },
        {
          providerState: createProviderState(),
          runClaude: runClaude as never,
          runCodex: vi.fn().mockResolvedValue({ ok: true, provider: "codex", value: { answer: "fallback" } }),
          onLog: () => undefined,
          now: () => Date.now(),
        },
      ));

    await clock.advanceBy(config.claudeRouteTimeoutMs + PROVIDER_TEARDOWN_GRACE_MS + 1);
    await expect(routed).resolves.toMatchObject({
      ok: true,
      provider: "codex",
      attempts: [{ provider: "claude", kind: "timeout" }],
    });

    finishTeardown();
    await clock.advanceBy(0);
    await flushModelCallRecorder();

    const rows = db.prepare(`
      SELECT pe.failure_kind AS failureKind, ma.response AS response
      FROM provider_executions pe JOIN model_attempts ma ON ma.provider_execution_id = pe.id
      WHERE pe.provider = 'claude'`).all();
    expect(rows).toEqual([{ failureKind: "timeout", response: "stream written before the kill" }]);
  });
});
