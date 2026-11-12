import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/db.js";
import { runClaude, type ClaudePressureEvent, type CliTranscript } from "../src/services/claudeRunner.js";
import {
  createRepoModelCallSink,
  flushModelCallRecorder,
  resetModelCallSink,
  setModelCallSink,
  withModelCallContext,
} from "../src/services/modelCallLog.js";
import { runCodex } from "../src/services/reasoning/codexRunner.js";
import { createProviderState } from "../src/services/reasoning/providerState.js";
import { runSkillTask } from "../src/services/reasoning/router.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.resolve(here, "fixtures/fake-claude.sh");
const fakeCodex = path.resolve(here, "fixtures/fake-codex.mjs");

/**
 * A stand-in for the stream's first line. The real `init` event lists every tool, skill and
 * connector the CLI loaded, and alone runs past the first 2,000 characters of output; this one is
 * synthetic (no account details), just as long, and names a skill containing "login". A failure
 * classified from the head of the stream would read it as an authentication failure.
 */
const INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  model: "claude-sonnet-5",
  permissionMode: "dontAsk",
  skills: ["toefl-writing", "login-helper"],
  tools: ["Read", "Skill", "StructuredOutput", ...Array.from({ length: 200 }, (_, index) => `mcp__connector__tool_${index}`)],
});

/** A real recorded `rate_limit_event`, with its status changed to the refusal the CLI's schema defines. */
const REFUSED = (() => {
  const line = fs.readFileSync(path.resolve(here, "fixtures/claude-rate-limit-events.jsonl"), "utf8").split("\n")[0]!;
  const event = JSON.parse(line) as { rate_limit_info: Record<string, unknown> };
  return JSON.stringify({ ...event, rate_limit_info: { ...event.rate_limit_info, status: "rejected" } });
})();

/** The final `result` event of a failed turn, in the shape the CLI's stream-json schema defines. */
function failedResult(apiErrorStatus: number, text: string): string {
  return JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    api_error_status: apiErrorStatus,
    duration_ms: 1_200,
    num_turns: 1,
    result: text,
    session_id: "00000000-0000-4000-8000-000000000000",
  });
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  resetModelCallSink();
});

function streamFile(...lines: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-failed-stream-"));
  dirs.push(dir);
  const file = path.join(dir, "stream.jsonl");
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

async function failedClaude(...lines: string[]) {
  const transcripts: CliTranscript[] = [];
  const pressure: ClaudePressureEvent[] = [];
  const result = await runClaude({
    prompt: `[FAKE_CLAUDE:STREAM:${streamFile(...lines)}:1]`,
    jsonSchema: { type: "object" },
    bin: fakeClaude,
    onTranscript: (transcript) => transcripts.push(transcript),
    onPressure: (event) => pressure.push(event),
  });
  return { result, transcripts, pressure };
}

describe("a failed Claude call", () => {
  it("is classified from its final result event, not from the head of the stream", async () => {
    expect(INIT.length).toBeGreaterThan(2_000);
    const { result } = await failedClaude(INIT, failedResult(529, "API Error: Repeated 529 Overloaded errors"));
    expect(result).toMatchObject({ ok: false, failure: { kind: "provider" } });
  });

  it.each([
    [401, "Failed to authenticate. API Error: 401 authentication_error", "authentication"],
    [429, "API Error: 429 Too Many Requests", "rate-limit"],
  ] as const)("reads API status %i (%s) as %s", async (status, text, kind) => {
    const { result } = await failedClaude(INIT, failedResult(status, text));
    expect(result).toMatchObject({ ok: false, failure: { kind } });
  });

  it("never reads a result that is not an error as error text", async () => {
    // The turn finished and its `result` is the model's own answer, which can be about anything.
    const answered = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      api_error_status: null,
      result: "Dear IT team, I cannot log in to the portal since Monday.",
    });
    const { result } = await failedClaude(INIT.replace("login-helper", "email-helper"), answered);
    expect(result).toMatchObject({ ok: false, failure: { kind: "provider" } });
  });

  it("reports a refused window as quota with its reset, so the circuit honours it", async () => {
    const { result, pressure } = await failedClaude(INIT, REFUSED, failedResult(429, "You've hit your limit"));
    expect(result).toMatchObject({ ok: false, failure: { kind: "quota" } });
    expect(pressure).toEqual([{ kind: "quota", window: "five_hour@1786870800", resetAtMs: 1_786_870_800_000 }]);
  });

  it("reports the whole stream as the failed attempt's response", async () => {
    const last = failedResult(401, "Failed to authenticate.");
    const { transcripts } = await failedClaude(INIT, last);
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]!.response).toContain(INIT);
    expect(transcripts[0]!.response).toContain(last);
  });

  it("reports stderr as the response when the CLI wrote nothing else", async () => {
    const transcripts: CliTranscript[] = [];
    const result = await runClaude({
      prompt: "[FAKE_CLAUDE:QUOTA]",
      jsonSchema: { type: "object" },
      bin: fakeClaude,
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    expect(result).toMatchObject({ ok: false, failure: { kind: "quota" } });
    expect(transcripts[0]!.response).toBe("[stderr]\nquota exceeded; secret-claude-diagnostic\n");
  });

  it("records that response, redacted, in the attempt row", async () => {
    const db = openDb(":memory:");
    setModelCallSink(createRepoModelCallSink(sqliteStores(db)));
    const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";
    const stream = streamFile(INIT, failedResult(401, `Invalid API key ${secret}`));

    const routed = await withModelCallContext({ kind: "scoring-job", id: "failed-claude" }, () =>
      runSkillTask(
        {
          task: { task: "aggregate", context: "email" },
          prompt: `[FAKE_CLAUDE:STREAM:${stream}:1]`,
          jsonSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
          parse: (value: unknown) => value as { answer: string },
        },
        {
          providerState: createProviderState(),
          runClaude: (options) => runClaude({ ...options, bin: fakeClaude }),
          runCodex: vi.fn().mockResolvedValue({ ok: true, provider: "codex", value: { answer: "fallback" } }),
          onLog: () => undefined,
        },
      ));
    expect(routed).toMatchObject({ ok: true, provider: "codex", attempts: [{ provider: "claude", kind: "authentication" }] });
    await flushModelCallRecorder();

    const row = db.prepare(`
      SELECT pe.failure_kind AS failureKind, ma.response AS response
      FROM provider_executions pe JOIN model_attempts ma ON ma.provider_execution_id = pe.id
      WHERE pe.provider = 'claude'`).get() as { failureKind: string; response: string | null };
    expect(row.failureKind).toBe("authentication");
    expect(row.response).toContain('"api_error_status":401');
    expect(row.response).toContain("[REDACTED]");
    expect(row.response).not.toContain(secret);
  });
});

describe("a failed Codex call", () => {
  const schema = { type: "object", required: ["echo"], properties: { echo: { type: "string" } } };
  const prompt = `[FAKE_CODEX:SESSION_THEN_USAGE_LIMIT] Write to IT about a login problem.\n${"Context. ".repeat(300)}`;

  it("is classified from the end of its session log, past the echoed prompt", async () => {
    const result = await runCodex({ prompt, jsonSchema: schema, parse: (value) => value, bin: fakeCodex });
    expect(result).toMatchObject({ ok: false, failure: { kind: "quota" } });
  });

  it("reports the session log as the failed attempt's response", async () => {
    const transcripts: CliTranscript[] = [];
    await runCodex({
      prompt,
      jsonSchema: schema,
      parse: (value) => value,
      bin: fakeCodex,
      onTranscript: (transcript) => transcripts.push(transcript),
    });
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]!.response).toContain("ERROR: You've hit your usage limit");
  });
});
