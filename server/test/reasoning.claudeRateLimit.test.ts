import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseClaudeStream, runClaude, type ClaudePressureEvent } from "../src/services/claudeRunner.js";
import { createProviderState } from "../src/services/reasoning/providerState.js";
import { runSkillTask } from "../src/services/reasoning/router.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.resolve(here, "fixtures/fake-claude.sh");

/**
 * Lines recorded by the real Claude CLI (2.1.252) in this app's own diagnostics: an `allowed`
 * five-hour event whose `overageStatus` reads "rejected", the same with per-window utilization, an
 * `allowed_warning` seven-day event at 76%, and a connection-error retry. Real usage never passed
 * 76%, so the over-90% and refused cases below are these lines with field values changed, within
 * the CLI's own `rate_limit_info` schema (status allowed|allowed_warning|rejected, utilization a
 * fraction, resetsAt epoch seconds).
 */
const [allowedWithOverageRejected, allowedWithWindows, allowedWarning76, connectionRetry] = fs
  .readFileSync(path.resolve(here, "fixtures/claude-rate-limit-events.jsonl"), "utf8")
  .trim()
  .split("\n") as [string, string, string, string];

function derived(line: string, info: Record<string, unknown>): string {
  const event = JSON.parse(line) as { rate_limit_info: Record<string, unknown> };
  return JSON.stringify({ ...event, rate_limit_info: { ...event.rate_limit_info, ...info } });
}

const warning92 = derived(allowedWarning76, { utilization: 0.92, surpassedThreshold: 0.9 });
const refused = derived(allowedWithOverageRejected, { status: "rejected" });
const refusedButOverage = derived(allowedWithOverageRejected, {
  status: "rejected",
  overageStatus: "allowed",
  isUsingOverage: true,
});
const rateLimitedRetry = JSON.stringify({ ...JSON.parse(connectionRetry), error_status: 429, error: "rate_limit" });

const RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: { ok: true } });

function pressureOf(...lines: string[]): readonly ClaudePressureEvent[] {
  return parseClaudeStream([...lines, RESULT].join("\n")).pressure;
}

describe("Claude rate_limit_event parsing", () => {
  it("reads nothing but telemetry from the recorded events, even where overage reads rejected", () => {
    const pressure = pressureOf(allowedWithOverageRejected, allowedWithWindows, allowedWarning76, connectionRetry);
    expect(pressure.every((event) => event.kind === "telemetry")).toBe(true);
    expect(pressure).toEqual([
      { kind: "telemetry", window: "five_hour@1788271200", utilization: 7 },
      { kind: "telemetry", window: "seven_day@1788426000", utilization: 46 },
      { kind: "telemetry", window: "seven_day@1787821200", utilization: 76 },
    ]);
  });

  it("turns 90% utilization of a window into pressure on that window", () => {
    expect(pressureOf(warning92)).toEqual([
      { kind: "pressure", window: "seven_day@1787821200", utilization: 92 },
    ]);
  });

  it("reports a refused window as quota with its reset in epoch milliseconds", () => {
    expect(pressureOf(refused)).toEqual([
      { kind: "quota", window: "five_hour@1786870800", resetAtMs: 1_786_870_800_000 },
    ]);
  });

  it("treats a refusal that paid overage is covering as pressure, not quota", () => {
    expect(pressureOf(refusedButOverage)).toEqual([
      { kind: "pressure", window: "five_hour@1786870800" },
    ]);
  });

  it("reports one pressure per call for a rate-limited retry and none for a connection retry", () => {
    expect(pressureOf(connectionRetry)).toEqual([]);
    expect(pressureOf(rateLimitedRetry, rateLimitedRetry)).toEqual([
      { kind: "pressure", window: "api_retry@ef3f1e85-777d-416b-a4c6-dd12042010d0" },
    ]);
  });

  it("reports a window once however often the stream repeats it", () => {
    expect(pressureOf(warning92, warning92, refused, refused)).toEqual([
      { kind: "pressure", window: "seven_day@1787821200", utilization: 92 },
      { kind: "quota", window: "five_hour@1786870800", resetAtMs: 1_786_870_800_000 },
    ]);
  });
});

describe("rate-limit pressure in provider state", () => {
  function windowPressure(state: ReturnType<typeof createProviderState>, window: string): void {
    state.recordPressure("claude", "pressure", undefined, window);
  }

  it("never opens the circuit for windows that are still serving, however many calls report them", () => {
    let now = 0;
    const state = createProviderState({
      now: () => now,
      admission: {
        claude: { initial: 8, floor: 2, ceiling: 8, scoringReserve: 1, cooldownsMs: [60_000] },
        codex: { initial: 8, floor: 2, ceiling: 8, scoringReserve: 1, cooldownsMs: [60_000] },
      },
    });
    for (let call = 0; call < 20; call += 1) {
      now += 1_000;
      for (const window of ["five_hour@1786870800", "seven_day@1787821200", "seven_day_opus@1787821200"]) {
        windowPressure(state, window);
      }
    }
    expect(state.operationalSnapshot()[0]).toMatchObject({ circuitState: "closed", pressureStrikes: 3 });
    expect(state.operationalSnapshot()[0]!.effectiveCapacity).toBeLessThan(8);
  });

  it("strikes once per window, not once per call that reports it", () => {
    const state = createProviderState({
      now: () => 0,
      admission: {
        claude: { initial: 8, floor: 2, ceiling: 8, scoringReserve: 1, cooldownsMs: [60_000] },
        codex: { initial: 8, floor: 2, ceiling: 8, scoringReserve: 1, cooldownsMs: [60_000] },
      },
    });
    for (let call = 0; call < 5; call += 1) windowPressure(state, "seven_day@1787821200");
    expect(state.operationalSnapshot()[0]).toMatchObject({ pressureStrikes: 1, effectiveCapacity: 7 });
  });

  it("opens the circuit on a refused window until its reset and persists that reset", () => {
    const saved: Array<{ provider: string; resetAtMs: number }> = [];
    const state = createProviderState({
      now: () => 1_786_860_000_000,
      persistence: {
        load: () => undefined,
        save: (provider, value) => saved.push({ provider, resetAtMs: value.resetAtMs }),
        clear: () => undefined,
      },
    });
    const [quota] = pressureOf(refused);
    expect(quota).toMatchObject({ kind: "quota" });
    if (quota?.kind !== "quota") return;

    state.recordPressure("claude", "quota", quota.resetAtMs, quota.window);

    expect(state.snapshot()[0]).toEqual({
      provider: "claude",
      availability: "circuit-open",
      failureKind: "quota",
      retryAtMs: 1_786_870_805_000,
    });
    expect(saved).toEqual([{ provider: "claude", resetAtMs: 1_786_870_800_000 }]);
  });
});

describe("the Claude runner reports what the stream says", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function streamFile(...lines: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-stream-"));
    dirs.push(dir);
    const file = path.join(dir, "stream.jsonl");
    fs.writeFileSync(file, `${lines.join("\n")}\n`);
    return file;
  }

  it("opens the circuit until a refused window's reset and persists it, through the real route", async () => {
    const saved: Array<{ provider: string; resetAtMs: number }> = [];
    const state = createProviderState({
      now: () => 1_786_860_000_000,
      persistence: {
        load: () => undefined,
        save: (provider, value) => saved.push({ provider, resetAtMs: value.resetAtMs }),
        clear: () => undefined,
      },
    });
    const refusedTurn = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      api_error_status: 429,
      result: "You've hit your limit",
    });

    const routed = await runSkillTask(
      {
        task: { task: "aggregate", context: "email" },
        prompt: `[FAKE_CLAUDE:STREAM:${streamFile(allowedWithOverageRejected, refused, refusedTurn)}:1]`,
        jsonSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
        parse: (value: unknown) => value as { answer: string },
      },
      {
        providerState: state,
        runClaude: (options) => runClaude({ ...options, bin: fakeClaude }),
        runCodex: vi.fn().mockResolvedValue({ ok: true, provider: "codex", value: { answer: "fallback" } }),
        onLog: () => undefined,
      },
    );

    expect(routed).toMatchObject({ ok: true, provider: "codex", attempts: [{ provider: "claude", kind: "quota" }] });
    expect(state.snapshot()[0]).toEqual({
      provider: "claude",
      availability: "circuit-open",
      failureKind: "quota",
      retryAtMs: 1_786_870_805_000,
    });
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.every((entry) => entry.provider === "claude" && entry.resetAtMs === 1_786_870_800_000)).toBe(true);
  });

  // `claude -p` can exit 0 with a result that is an error. That output is not malformed but absent,
  // so the structured-output repair, a second spawn, would be refused the same way.
  it.each([
    ["a usage-limit result", [JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Claude AI usage limit reached|1786870800" })], "quota"],
    ["an API error result", [JSON.stringify({ type: "result", subtype: "success", is_error: true, api_error_status: 529, result: "API Error: overloaded" })], "provider"],
    ["an error-subtype result", [JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["authentication failed"] })], "authentication"],
    ["a refused window beside an unparseable result", [refused, JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "no json here" })], "quota"],
  ] as const)("classifies %s from a CLI that exited 0 without a repair attempt", async (_label, lines, kind) => {
    const transcripts: unknown[] = [];
    const result = await runClaude({
      prompt: `[FAKE_CLAUDE:STREAM:${streamFile(...lines)}:0]`,
      jsonSchema: { type: "object" },
      parse: (value: unknown) => value as { answer: string },
      bin: fakeClaude,
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    expect(result).toEqual({ ok: false, failure: { provider: "claude", kind, source: "call" } });
    expect(transcripts).toHaveLength(1);
  });

  it("still repairs a result that answered with output that does not parse", async () => {
    const transcripts: unknown[] = [];
    const result = await runClaude({
      prompt: `[FAKE_CLAUDE:STREAM:${streamFile(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "no json here" }))}:0]`,
      jsonSchema: { type: "object" },
      bin: fakeClaude,
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    expect(result).toMatchObject({ ok: false, failure: { kind: "invalid-output" } });
    expect(transcripts).toHaveLength(2);
  });

  it("hands a successful call's refused window to the pressure observer", async () => {
    const observed: ClaudePressureEvent[] = [];
    const result = await runClaude({
      prompt: `[FAKE_CLAUDE:STREAM:${streamFile(allowedWithOverageRejected, refused, RESULT)}:0]`,
      jsonSchema: { type: "object" },
      bin: fakeClaude,
      onPressure: (event) => observed.push(event),
    });
    expect(result).toMatchObject({ ok: true, value: { ok: true } });
    expect(observed).toEqual([
      { kind: "quota", window: "five_hour@1786870800", resetAtMs: 1_786_870_800_000 },
    ]);
  });
});
