import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./helpers/deferred.js";
import { z } from "zod";
import type { ReasoningFailureKind } from "@toefl-prep/shared";
import { config, projectRoot } from "../src/lib/config.js";
import {
  CLI_PERMISSIONS_SETTINGS,
  runClaude,
  stripSchemaDialect,
} from "../src/services/claudeRunner.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(here, "fixtures/fake-claude.sh");
const schema = { type: "object" };
const auditPath = `/tmp/fake-claude-attempts-${process.pid}`;
const savedEnv = { ...process.env };

function manualDeadline(timeoutMs: number) {
  let nowMs = 0;
  let nextId = 0;
  const timers = new Map<
    number,
    { readonly dueAtMs: number; readonly callback: () => void }
  >();
  const deadline = Object.freeze({
    expiresAtMs: timeoutMs,
    now: () => nowMs,
    setTimer(callback: () => void, delayMs: number) {
      nextId += 1;
      timers.set(nextId, {
        dueAtMs: nowMs + Math.max(0, delayMs),
        callback,
      });
      return nextId;
    },
    clearTimer(handle: unknown) {
      if (typeof handle === "number") timers.delete(handle);
    },
  });
  return {
    deadline,
    advance(ms: number) {
      nowMs += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.dueAtMs <= nowMs) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

function heartbeatPid(heartbeatPath: string): number | undefined {
  try {
    const pid = Number(fs.readFileSync(heartbeatPath, "utf8").split("\n", 1)[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function expectHeartbeatProcessStopped(
  heartbeatPath: string,
  timeoutMs = 1_000
): Promise<void> {
  const pid = heartbeatPid(heartbeatPath);
  expect(pid, `missing heartbeat PID in ${heartbeatPath}`).toBeDefined();
  if (pid === undefined) return;
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(
    processIsAlive(pid),
    `background descendant ${pid} remained alive after ${timeoutMs}ms`
  ).toBe(false);
}

function cleanupHeartbeat(heartbeatPath: string): void {
  const pid = heartbeatPid(heartbeatPath);
  if (pid !== undefined && processIsAlive(pid)) {
    process.kill(pid, "SIGKILL");
  }
  fs.rmSync(heartbeatPath, { force: true });
}

async function runWithTrackedClaudeTempDir<T>(
  run: () => Promise<T>
): Promise<{ result: T; tempDir: string }> {
  const realMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
  let tempDir: string | undefined;
  const mkdtempSpy = vi
    .spyOn(fs.promises, "mkdtemp")
    .mockImplementation(async (prefix: string) => {
      const created = await realMkdtemp(prefix);
      if (path.basename(prefix) === "toefl-claude-") {
        if (tempDir !== undefined) {
          throw new Error("one Claude invocation created multiple temp directories");
        }
        tempDir = created;
      }
      return created;
    });
  try {
    const result = await run();
    expect(tempDir, "Claude invocation did not create a private temp directory").toBeDefined();
    if (tempDir === undefined) throw new Error("missing tracked Claude temp directory");
    return { result, tempDir };
  } finally {
    mkdtempSpy.mockRestore();
  }
}

function failureKind(result: Awaited<ReturnType<typeof runClaude>>): ReasoningFailureKind {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.failure).toEqual({
    provider: "claude",
    kind: result.failure.kind,
    source: "call",
  });
  return result.failure.kind;
}

afterEach(() => {
  fs.rmSync(auditPath, { force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe.sequential("runClaude", () => {
  it("grants exactly the Read and Skill tools, with no project-tree enumeration capability", async () => {
    const result = await runClaude({
      prompt: "[FAKE_CLAUDE:INSPECT]",
      jsonSchema: schema,
      bin,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const argv = (result.value as { argv: string[] }).argv;
    const toolsFlag = argv.indexOf("--tools");
    expect(toolsFlag).toBeGreaterThan(-1);
    expect(argv[toolsFlag + 1]?.split(",").sort()).toEqual(["Read", "Skill"]);
  });

  it("loads no MCP servers, so no connector tool can join the two it grants", async () => {
    const result = await runClaude({
      prompt: "[FAKE_CLAUDE:INSPECT]",
      jsonSchema: schema,
      bin,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // `--tools` limits only the built-in tools. MCP servers, claude.ai connectors included, add
    // their own; `--strict-mcp-config` with no `--mcp-config` loads none of them.
    const argv = (result.value as { argv: string[] }).argv;
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).not.toContain("--mcp-config");
  });

  it("uses the safe invocation, project cwd, and sanitized environment", async () => {
    process.env.OPENAI_API_KEY = "openai-parent-secret";
    process.env.ANTHROPIC_API_KEY = "anthropic-parent-secret";
    process.env.TOEFL_ARBITRARY_APP_SECRET = "arbitrary-parent-secret";
    process.env.FAKE_CLAUDE_MODE = "provider";

    const result = await runClaude({
      prompt: "[FAKE_CLAUDE:INSPECT]",
      jsonSchema: schema,
      bin,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provider).toBe("claude");
    expect(result.value).toEqual({
      argv: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--json-schema",
        JSON.stringify(schema),
        "--setting-sources",
        "project",
        "--tools",
        "Read,Skill",
        "--strict-mcp-config",
        "--settings",
        CLI_PERMISSIONS_SETTINGS,
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
      ],
      cwd: config.projectRoot,
      inheritedSecrets: [],
      // Removes the CLI's bundled skills from the spawn; the project's .claude/skills/ stay.
      disableBundledSkills: "1",
      // The spawn loads no CLAUDE.md (the person's own or the project's) and no auto memory, so
      // nothing personal to the machine reaches the model that scores or generates.
      disableClaudeMds: "1",
      disableAutoMemory: "1",
    });
  });

  it("adds no --model or --effort args when CLAUDE_CLI_MODEL/CLAUDE_CLI_EFFORT are unset", async () => {
    expect(config.claudeCliModel).toBeUndefined();
    expect(config.claudeCliEffort).toBeUndefined();

    const result = await runClaude({
      prompt: "[FAKE_CLAUDE:INSPECT]",
      jsonSchema: schema,
      bin,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as { argv?: unknown }).argv).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      JSON.stringify(schema),
      "--setting-sources",
      "project",
      "--tools",
      "Read,Skill",
      "--strict-mcp-config",
      "--settings",
      CLI_PERMISSIONS_SETTINGS,
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
    ]);
  });

  it("appends --model and --effort right after -p, before -p's other companions, when both are configured", async () => {
    const savedModel = config.claudeCliModel;
    const savedEffort = config.claudeCliEffort;
    config.claudeCliModel = "claude-fable-5";
    config.claudeCliEffort = "high";
    try {
      const result = await runClaude({
        prompt: "[FAKE_CLAUDE:INSPECT]",
        jsonSchema: schema,
        bin,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value as { argv?: unknown }).argv).toEqual([
        "-p",
        "--model",
        "claude-fable-5",
        "--effort",
        "high",
        "--output-format",
        "stream-json",
        "--verbose",
        "--json-schema",
        JSON.stringify(schema),
        "--setting-sources",
        "project",
        "--tools",
        "Read,Skill",
        "--strict-mcp-config",
        "--settings",
        CLI_PERMISSIONS_SETTINGS,
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
      ]);
    } finally {
      config.claudeCliModel = savedModel;
      config.claudeCliEffort = savedEffort;
    }
  });

  it("appends only --model when CLAUDE_CLI_EFFORT is unset", async () => {
    const savedModel = config.claudeCliModel;
    const savedEffort = config.claudeCliEffort;
    config.claudeCliModel = "claude-fable-5";
    config.claudeCliEffort = undefined;
    try {
      const result = await runClaude({
        prompt: "[FAKE_CLAUDE:INSPECT]",
        jsonSchema: schema,
        bin,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value as { argv?: unknown }).argv).toEqual([
        "-p",
        "--model",
        "claude-fable-5",
        "--output-format",
        "stream-json",
        "--verbose",
        "--json-schema",
        JSON.stringify(schema),
        "--setting-sources",
        "project",
        "--tools",
        "Read,Skill",
        "--strict-mcp-config",
        "--settings",
        CLI_PERMISSIONS_SETTINGS,
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
      ]);
    } finally {
      config.claudeCliModel = savedModel;
      config.claudeCliEffort = savedEffort;
    }
  });

  it("appends only --effort when CLAUDE_CLI_MODEL is unset", async () => {
    const savedModel = config.claudeCliModel;
    const savedEffort = config.claudeCliEffort;
    config.claudeCliModel = undefined;
    config.claudeCliEffort = "xhigh";
    try {
      const result = await runClaude({
        prompt: "[FAKE_CLAUDE:INSPECT]",
        jsonSchema: schema,
        bin,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect((result.value as { argv?: unknown }).argv).toEqual([
        "-p",
        "--effort",
        "xhigh",
        "--output-format",
        "stream-json",
        "--verbose",
        "--json-schema",
        JSON.stringify(schema),
        "--setting-sources",
        "project",
        "--tools",
        "Read,Skill",
        "--strict-mcp-config",
        "--settings",
        CLI_PERMISSIONS_SETTINGS,
        "--permission-mode",
        "dontAsk",
        "--no-session-persistence",
      ]);
    } finally {
      config.claudeCliModel = savedModel;
      config.claudeCliEffort = savedEffort;
    }
  });

  it("uses the immutable project root when mutable aggregate config is retargeted", async () => {
    const originalProjectRoot = config.projectRoot;
    config.projectRoot = os.tmpdir();
    try {
      const result = await runClaude({
        prompt: "[FAKE_CLAUDE:INSPECT]",
        jsonSchema: schema,
        bin,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        (result.value as { cwd?: unknown }).cwd
      ).toBe(projectRoot);
    } finally {
      config.projectRoot = originalProjectRoot;
    }
  });

  it("returns structured output on success", async () => {
    const result = await runClaude({
      prompt: "[FAKE_CLAUDE:OK]",
      jsonSchema: schema,
      bin,
    });
    expect(result).toEqual({
      ok: true,
      value: { echo: "ok" },
      provider: "claude",
    });
  });

  // Under stream-json a single response runs many pipe buffers long, and the result envelope
  // is the last line: losing the tail turns a successful paid call into invalid output and
  // burns the one repair the deadline allows.
  it("parses a successful response many pipe buffers long without burning a repair", async () => {
    const realAppendFileSync = fs.appendFileSync;
    const stall = new Int32Array(new SharedArrayBuffer(4));
    // The truncation only surfaces when the reader is slower than the CLI's writer, so
    // the retention sink is slowed to stand in for the real thing: a synchronous
    // per-chunk append competing with a server that is also serving requests and
    // running up to eight other attempts on the same event loop.
    const appendSpy = vi
      .spyOn(fs, "appendFileSync")
      .mockImplementation(((...args: Parameters<typeof fs.appendFileSync>) => {
        realAppendFileSync(...args);
        Atomics.wait(stall, 0, 0, 4);
      }) as typeof fs.appendFileSync);
    let result: Awaited<ReturnType<typeof runClaude>>;
    try {
      result = await runClaude({
        prompt: "[FAKE_CLAUDE:LARGE_STREAM]",
        jsonSchema: schema,
        bin,
        timeoutMs: 30_000,
      });
    } finally {
      appendSpy.mockRestore();
    }

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Byte-exact on the far side of the payload: the tail is what a truncating
    // teardown drops, and "repaired-after-truncation" is what a burnt repair returns.
    expect(result.value).toEqual({
      echo: "large-stream",
      body: "z".repeat(64 * 1024),
    });
    expect(fs.readFileSync(auditPath, "utf8").trim().split("\n")).toHaveLength(1);
  }, 60_000);

  it("does not accept a success after output validation consumes the absolute deadline", async () => {
    // The budget is virtual for the deadline arithmetic but real for the child process: runClaude
    // passes the remaining budget to the spawn as its timeout. A budget of tens of milliseconds lets
    // the fixture spawn overrun it under full-suite load, and runClaude then returns "timeout"
    // without ever calling `parse`, which satisfies the timeout assertion without running the path
    // under test; `parseCalls` makes that visible. The clock moves only when the parse callback
    // advances it, so 30s costs no real waiting.
    const VIRTUAL_BUDGET_MS = 30_000;
    const clock = manualDeadline(VIRTUAL_BUDGET_MS);
    let parseCalls = 0;
    const result = await runClaude({
      prompt: "[FAKE_CLAUDE:OK]",
      jsonSchema: schema,
      parse(value) {
        parseCalls += 1;
        clock.advance(VIRTUAL_BUDGET_MS);
        return value;
      },
      bin,
      deadline: clock.deadline,
    });

    expect(failureKind(result)).toBe("timeout");
    expect(parseCalls).toBe(1); // the path under test actually ran
  });

  it("returns timeout while Claude output reading is delayed and cleans its private directory", async () => {
    const gate = deferred();
    const clock = manualDeadline(5_000);
    const realReadFile = fs.promises.readFile.bind(fs.promises);
    let outputReadStarted = false;
    const readFile = vi
      .spyOn(fs.promises, "readFile")
      .mockImplementation(async (...args: Parameters<typeof fs.promises.readFile>) => {
        if (path.basename(String(args[0])) === "stdout.json") {
          outputReadStarted = true;
          await gate.promise;
        }
        return Reflect.apply(realReadFile, fs.promises, args);
      });
    let settled = false;
    const running = runWithTrackedClaudeTempDir(() =>
      runClaude({
        prompt: "[FAKE_CLAUDE:OK]",
        jsonSchema: schema,
        bin,
        deadline: clock.deadline,
      }),
    ).then((result) => {
      settled = true;
      return result;
    });
    try {
      await vi.waitFor(() => expect(outputReadStarted).toBe(true));
      clock.advance(5_000);
      await vi.waitFor(() => expect(settled).toBe(true));
      const { result, tempDir } = await running;
      expect(failureKind(result)).toBe("timeout");
      expect(fs.existsSync(tempDir)).toBe(false);
    } finally {
      gate.resolve();
      await running;
      readFile.mockRestore();
    }
  });

  it("repairs invalid output exactly once", async () => {
    const result = await runClaude({
      prompt: "[FAKE_CLAUDE:INVALID_THEN_GOOD]",
      jsonSchema: schema,
      bin,
    });
    expect(result).toEqual({
      ok: true,
      value: { echo: "retried" },
      provider: "claude",
    });
    expect(fs.readFileSync(auditPath, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("reports one transcript per CLI attempt, carrying the exact prompt sent and the raw output", async () => {
    const transcripts: Array<{ prompt: string; response?: string; startedAtMs?: number; finishedAtMs?: number }> = [];
    const result = await runClaude({
      prompt: "[FAKE_CLAUDE:INVALID_THEN_GOOD]",
      jsonSchema: schema,
      bin,
      onTranscript: (t) => transcripts.push(t),
    });
    expect(result.ok).toBe(true);

    // Two attempts, two transcripts. The first output is rejected, and the repair prompt that
    // replaces it is not the prompt the caller passed, so recording only the caller's prompt would
    // misreport what the model saw on the attempt that produced the stored output.
    expect(transcripts).toHaveLength(2);
    expect(transcripts[0].prompt).toBe("[FAKE_CLAUDE:INVALID_THEN_GOOD]");
    expect(transcripts[0].response).toContain("garbage not json");
    expect(transcripts[1].prompt).toMatch(/^Your previous output was invalid/);
    expect(transcripts[1].prompt).toContain("[FAKE_CLAUDE:INVALID_THEN_GOOD]");
    expect(transcripts[1].response).toContain('"echo":"retried"');
  });

  it("reports the transcript of a rejected output even when every attempt fails", async () => {
    const transcripts: Array<{ prompt: string; response?: string }> = [];
    const result = await runClaude({
      prompt: "[FAKE_CLAUDE:ALWAYS_INVALID]",
      jsonSchema: schema,
      bin,
      onTranscript: (t) => transcripts.push(t),
    });
    expect(failureKind(result)).toBe("invalid-output");
    // On invalid-output the raw text never reaches the caller through the result (the failure
    // contract is normalized fields only), so without this channel the one artifact that explains
    // the failure is destroyed with the temp directory.
    expect(transcripts).toHaveLength(2);
    expect(transcripts.every((t) => t.response?.includes("garbage not json"))).toBe(true);
  });

  it("reports no output as undefined rather than empty when the process fails before writing any", async () => {
    const transcripts: Array<{ prompt: string; response?: string; startedAtMs?: number; finishedAtMs?: number }> = [];
    const result = await runClaude({
      prompt: "[FAKE_CLAUDE:EXIT_FAST]",
      jsonSchema: schema,
      bin,
      onTranscript: (t) => transcripts.push(t),
    });
    expect(failureKind(result)).toBe("provider");
    expect(transcripts).toHaveLength(1);
    expect(transcripts[0]).toMatchObject({ prompt: "[FAKE_CLAUDE:EXIT_FAST]" });
    expect(transcripts[0].response).toBeUndefined();
    expect(transcripts[0].startedAtMs).toBeTypeOf("number");
    expect(transcripts[0].finishedAtMs).toBeGreaterThanOrEqual(transcripts[0].startedAtMs!);
  });

  it("cannot be broken by an onTranscript that throws", async () => {
    const result = await runClaude({
      prompt: "[FAKE_CLAUDE:INVALID_THEN_GOOD]",
      jsonSchema: schema,
      bin,
      onTranscript: () => {
        throw new Error("sink exploded");
      },
    });
    expect(result).toEqual({ ok: true, value: { echo: "retried" }, provider: "claude" });
  });

  it("repairs a null envelope exactly once", async () => {
    const result = await runClaude({
      prompt: "[FAKE_CLAUDE:NULL_THEN_GOOD]",
      jsonSchema: schema,
      bin,
    });
    expect(result).toEqual({
      ok: true,
      value: { echo: "retried after null" },
      provider: "claude",
    });
    expect(fs.readFileSync(auditPath, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("normalizes null after repair as invalid-output", async () => {
    const result = await runClaude({
      prompt: "[FAKE_CLAUDE:NULL_ALWAYS]",
      jsonSchema: schema,
      bin,
    });
    expect(failureKind(result)).toBe("invalid-output");
  });

  it("kills an oversized output tree, repairs once, and cleans private output", async () => {
    const heartbeatPath = path.join(
      os.tmpdir(),
      `toefl-claude-overflow-${process.pid}-${Date.now()}`
    );
    try {
      const { result, tempDir } = await runWithTrackedClaudeTempDir(() =>
        runClaude({
          prompt: `[FAKE_CLAUDE:OVERSIZE_THEN_GOOD:${heartbeatPath}]`,
          jsonSchema: schema,
          bin,
          timeoutMs: 5_000,
        })
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        (result.value as { echo?: unknown }).echo === "retried after oversize"
      ).toBe(true);
      expect(JSON.stringify(result)).not.toContain("secret-claude-oversize");
      await expectHeartbeatProcessStopped(heartbeatPath);
      expect(fs.existsSync(tempDir)).toBe(false);
    } finally {
      cleanupHeartbeat(heartbeatPath);
    }
  });

  it("normalizes oversized output after repair as invalid-output", async () => {
    const { result, tempDir } = await runWithTrackedClaudeTempDir(() =>
      runClaude({
        prompt: "[FAKE_CLAUDE:OVERSIZE_ALWAYS]",
        jsonSchema: schema,
        bin,
        timeoutMs: 5_000,
      })
    );
    expect(failureKind(result)).toBe("invalid-output");
    expect(JSON.stringify(result)).not.toContain("secret-claude-oversize");
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it("shares one deadline between the initial and repair attempts", async () => {
    const startedAt = Date.now();
    const result = await runClaude({
      prompt: "[FAKE_CLAUDE:SLOW_INVALID_THEN_GOOD]",
      jsonSchema: schema,
      bin,
      timeoutMs: 240,
    });
    expect(failureKind(result)).toBe("timeout");
    // Timeout teardown owns the process group through the confirmed 2s grace.
    expect(Date.now() - startedAt).toBeLessThan(2_750);
  });

  it.each([
    ["[FAKE_CLAUDE:QUOTA]", "quota"],
    ["[FAKE_CLAUDE:RATE_LIMIT]", "rate-limit"],
    ["[FAKE_CLAUDE:AUTHENTICATION]", "authentication"],
    ["[FAKE_CLAUDE:PROVIDER_FAILURE]", "provider"],
    ["[FAKE_CLAUDE:ALWAYS_INVALID]", "invalid-output"],
    ["[FAKE_CLAUDE:HANG]", "timeout"],
  ] as const)("normalizes %s as %s without raw diagnostics", async (prompt, kind) => {
    const result = await runClaude({
      prompt,
      jsonSchema: schema,
      bin,
      timeoutMs: prompt.includes("HANG") ? 180 : 2_000,
    });
    expect(failureKind(result)).toBe(kind);
    expect(JSON.stringify(result)).not.toContain("secret-claude-diagnostic");
    expect(result).not.toHaveProperty("raw");
  });

  it("normalizes a missing executable", async () => {
    const result = await runClaude({
      prompt: "hello",
      jsonSchema: schema,
      bin: "/tmp/definitely-missing-toefl-claude",
      timeoutMs: 1_000,
    });
    expect(failureKind(result)).toBe("missing-cli");
  });

  it("kills the whole process tree at timeout", async () => {
    const heartbeatPath = path.join(
      os.tmpdir(),
      `toefl-claude-timeout-${process.pid}-${Date.now()}`
    );
    try {
      const result = await runClaude({
        prompt: `[FAKE_CLAUDE:TREE_HANG:${heartbeatPath}]`,
        jsonSchema: schema,
        bin,
        timeoutMs: 250,
      });
      expect(failureKind(result)).toBe("timeout");
      await expectHeartbeatProcessStopped(heartbeatPath);
    } finally {
      cleanupHeartbeat(heartbeatPath);
    }
  });

  it("does not crash on a stdin error when the child exits immediately", async () => {
    const result = await runClaude({
      prompt: `[FAKE_CLAUDE:EXIT_FAST]\n${"x".repeat(1024 * 1024)}`,
      jsonSchema: schema,
      bin,
    });
    expect(failureKind(result)).toBe("provider");
  });

  it("ignores legacy queue callbacks because providerState owns events", async () => {
    const onQueued = vi.fn();
    const onRunning = vi.fn();
    const options = {
      prompt: "[FAKE_CLAUDE:OK]",
      jsonSchema: schema,
      bin,
      onQueued,
      onRunning,
    };
    await runClaude(options);
    expect(onQueued).not.toHaveBeenCalled();
    expect(onRunning).not.toHaveBeenCalled();
  });
});

// The argv-equality tests above compare against the same CLI_PERMISSIONS_SETTINGS constant they
// import, so a wrong value in the constant would still pass them. This block decodes the JSON and
// asserts its meaning: the source tree (where the gate-only tolerances and every server secret live)
// is denied, and only the skills' own reference docs are allowed back.
describe("CLI_PERMISSIONS_SETTINGS denies Read everywhere but the skills' references", () => {
  function decoded(): { permissions: { deny: string[]; allow: string[] } } {
    return JSON.parse(CLI_PERMISSIONS_SETTINGS) as { permissions: { deny: string[]; allow: string[] } };
  }

  it("denies Read on every directory that can hold gate-only tolerances, other server logic, or secrets", () => {
    const { deny } = decoded().permissions;
    for (const pattern of [
      "Read(server/**)", // the generators' gate-only tolerances
      "Read(shared/**)",
      "Read(client/**)",
      "Read(scripts/**)",
      "Read(data/**)", // published Sets' answer keys
      "Read(.env*)", // API keys: sanitizedCliEnv scrubs inherited environment variables, not this file
      "Read(.git)", // linked worktrees represent .git as a file
      "Read(.git/**)",
      "Read(.nvmrc)",
      "Read(node_modules/**)",
      "Read(.claude/settings.local.json)",
    ]) {
      expect(deny).toContain(pattern);
    }
  });

  it("allows Read only on the invoked skill's own reference docs, nothing broader", () => {
    const { allow } = decoded().permissions;
    expect(allow).toEqual(["Read(.claude/skills/**)"]);
  });

  it("never allows the denied source tree back in (no allow entry escapes server/shared/client/scripts/data)", () => {
    const { allow } = decoded().permissions;
    for (const escapeHatch of ["server", "shared", "client", "scripts", "data", ".env", ".git", "node_modules"]) {
      expect(allow.some((pattern) => pattern.includes(escapeHatch))).toBe(false);
    }
  });

  // Finder can drop a `.DS_Store` at the project root or in `.claude/`, and `fs.readdirSync` returns
  // dotfiles. One stray OS file should not turn a correct deny list into a red suite asking for a
  // deny pattern, so both enumeration tests below share this named exemption.
  const OS_EPHEMERA_NAMES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);

  // Under `--permission-mode dontAsk` a path that matches no rule is auto-approved: the list is a
  // deny list over a default-allow, not an allow list (see the constant's doc comment). This test
  // reads the real project root (`fs.readdirSync`), not a hand-maintained mirror of it, so a new
  // top-level file or directory that nobody adds to the deny list fails here instead of silently
  // becoming readable to the spawn.
  it("covers every real top-level entry under the project root except .claude (allowed via skills/**)", () => {
    const { deny } = decoded().permissions;
    const entries = fs.readdirSync(projectRoot)
      .filter((name) => name !== ".claude")
      .filter((name) => !OS_EPHEMERA_NAMES.has(name));
    expect(entries.length).toBeGreaterThan(10); // sanity: the real repo root, not an empty/wrong directory
    for (const entry of entries) {
      const isDirectory = fs.statSync(path.join(projectRoot, entry)).isDirectory();
      const exactPattern = isDirectory ? `Read(${entry}/**)` : `Read(${entry})`;
      // .env / .env.example both fall under the broader "Read(.env*)" glob rather than their own
      // exact entries.
      const covered = deny.includes(exactPattern)
        || (entry.startsWith(".env") && deny.includes("Read(.env*)"));
      expect(covered, `expected the deny list to cover top-level entry "${entry}" (looked for "${exactPattern}")`).toBe(true);
    }
  });

  // The test above exempts `.claude` as one entry because `skills/**` is allowed separately, but
  // everything else under `.claude/` (`settings.local.json`, say) falls to the default-allow unless
  // it is denied by name. This test reads `.claude`'s real children the same way, so a file added
  // under `.claude/` cannot silently become readable either.
  it("covers every real entry under .claude/ except skills/** (separately allowed)", () => {
    const { deny } = decoded().permissions;
    const claudeDir = path.join(projectRoot, ".claude");
    const allEntries = fs.readdirSync(claudeDir)
      .filter((name) => !OS_EPHEMERA_NAMES.has(name));
    // Linked worktrees retain tracked skills but do not copy ignored local settings files.
    expect(allEntries).toContain("skills");
    const entries = allEntries
      .filter((name) => name !== "skills");
    for (const entry of entries) {
      const isDirectory = fs.statSync(path.join(claudeDir, entry)).isDirectory();
      const exactPattern = isDirectory ? `Read(.claude/${entry}/**)` : `Read(.claude/${entry})`;
      expect(deny, `expected the deny list to cover .claude entry "${entry}" (looked for "${exactPattern}")`).toContain(exactPattern);
    }
  });
});

describe("stripSchemaDialect", () => {
  it("removes the $schema dialect marker z.toJSONSchema stamps on its output", () => {
    const jsonSchema = z.toJSONSchema(z.object({ id: z.string() }));
    expect(jsonSchema).toHaveProperty("$schema");
    const stripped = stripSchemaDialect(jsonSchema);
    expect(stripped).not.toHaveProperty("$schema");
    expect(JSON.stringify(stripped)).not.toContain("$schema");
  });

  it("is a no-op when there is no dialect marker", () => {
    const plain = { type: "object", properties: {} };
    expect(stripSchemaDialect(plain)).toEqual(plain);
  });
});
