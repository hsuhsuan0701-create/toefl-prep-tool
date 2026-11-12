import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "./helpers/deferred.js";
import { useFakeTimersInTest } from "./helpers/fakeTimers.js";
import type { ReasoningFailureKind } from "@toefl-prep/shared";
import {
  PRIVATE_TEMP_CLEANUP_TIMEOUT_MS,
  sanitizedCliEnv,
  spawnBounded,
  withPrivateTempDir,
} from "../src/services/reasoning/cliProcess.js";
import { runCodex } from "../src/services/reasoning/codexRunner.js";
import {
  ProviderDeadlineExceeded,
  runBeforeDeadline,
} from "../src/services/reasoning/deadline.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.resolve(here, "fixtures/fake-codex.mjs");
const schema = {
  type: "object",
  required: ["echo"],
  properties: { echo: { type: "string" } },
};
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

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function parseEcho(value: unknown): { echo: string } {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { echo?: unknown }).echo !== "string"
  ) {
    throw new Error("echo must be a string; diagnostic must remain private");
  }
  return value as { echo: string };
}

async function runWithTrackedCodexTempDir<T>(
  run: () => Promise<T>,
): Promise<{ result: T; tempDir: string }> {
  const realMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
  let tempDir: string | undefined;
  const mkdtemp = vi
    .spyOn(fs.promises, "mkdtemp")
    .mockImplementation(async (prefix: string) => {
      const created = await realMkdtemp(prefix);
      if (path.basename(prefix) === "toefl-codex-") {
        if (tempDir !== undefined) {
          throw new Error("one Codex invocation created multiple temp directories");
        }
        tempDir = created;
      }
      return created;
    });
  try {
    const result = await run();
    expect(tempDir).toBeDefined();
    if (tempDir === undefined) throw new Error("missing Codex temp directory");
    return { result, tempDir };
  } finally {
    mkdtemp.mockRestore();
  }
}

function failureKind(result: Awaited<ReturnType<typeof runCodex>>): ReasoningFailureKind {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected failure");
  expect(result.failure).toEqual({
    provider: "codex",
    kind: result.failure.kind,
    source: "call",
  });
  expect(result).not.toHaveProperty("raw");
  return result.failure.kind;
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

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

describe.sequential("CLI process isolation", () => {
  it("allowlists only the documented environment variables and omits undefined", () => {
    expect(
      sanitizedCliEnv({
        PATH: "/bin",
        HOME: "/home/test",
        CODEX_HOME: "/codex",
        TMPDIR: "/tmpdir",
        TMP: "/tmp",
        TEMP: "/temp",
        LANG: "en_US.UTF-8",
        LC_ALL: "C",
        SSL_CERT_FILE: "/cert.pem",
        SSL_CERT_DIR: "/certs",
        HTTP_PROXY: "http://proxy",
        HTTPS_PROXY: "https://proxy",
        NO_PROXY: "localhost",
        OPENAI_API_KEY: "openai-secret",
        ANTHROPIC_API_KEY: "anthropic-secret",
        APP_SECRET: "app-secret",
        OMITTED: undefined,
      })
    ).toEqual({
      PATH: "/bin",
      HOME: "/home/test",
      CODEX_HOME: "/codex",
      TMPDIR: "/tmpdir",
      TMP: "/tmp",
      TEMP: "/temp",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      SSL_CERT_FILE: "/cert.pem",
      SSL_CERT_DIR: "/certs",
      HTTP_PROXY: "http://proxy",
      HTTPS_PROXY: "https://proxy",
      NO_PROXY: "localhost",
    });
  });

  it("retains at most 2,000 characters from each diagnostic stream", async () => {
    const result = await spawnBounded({
      bin: process.execPath,
      args: [
        "-e",
        'process.stdout.write("o".repeat(3000)); process.stderr.write("e".repeat(3000))',
      ],
      prompt: "",
      cwd: process.cwd(),
      env: sanitizedCliEnv(),
      timeoutMs: 2_000,
    });
    expect(result.stdout).toHaveLength(2_000);
    expect(result.stderr).toHaveLength(2_000);
  });
});

describe.sequential("runCodex", () => {
  it("rejects an optional object property as configuration before creating a temp directory", async () => {
    const mkdtemp = vi.spyOn(fs.promises, "mkdtemp");
    try {
      const result = await runCodex({
        prompt: "must not reach Codex",
        jsonSchema: {
          type: "object",
          properties: {
            echo: { type: "string" },
            optionalNote: { type: "string" },
          },
          required: ["echo"],
        },
        parse: parseEcho,
        bin,
      });

      expect(failureKind(result)).toBe("configuration");
      expect(mkdtemp).not.toHaveBeenCalled();
    } finally {
      mkdtemp.mockRestore();
    }
  });

  it.each([
    ["oneOf", [{ type: "string" }, { type: "null" }]],
    ["allOf", [{ type: "string" }]],
    ["not", { type: "null" }],
    ["dependentRequired", { echo: ["detail"] }],
    ["dependentSchemas", { echo: { type: "string" } }],
    ["if", { type: "string" }],
    ["then", { type: "string" }],
    ["else", { type: "string" }],
  ] as const)(
    "rejects unsupported composition keyword %s as configuration before creating a temp directory",
    async (keyword, keywordValue) => {
      const mkdtemp = vi.spyOn(fs.promises, "mkdtemp");
      try {
        const result = await runCodex({
          prompt: "must not reach Codex",
          jsonSchema: {
            type: "object",
            properties: {
              echo: { type: "string" },
            },
            required: ["echo"],
            [keyword]: keywordValue,
          },
          parse: parseEcho,
          bin,
        });

        expect(failureKind(result)).toBe("configuration");
        expect(mkdtemp).not.toHaveBeenCalled();
      } finally {
        mkdtemp.mockRestore();
      }
    },
  );

  it.each([
    "additionalItems",
    "unevaluatedItems",
    "contentSchema",
  ] as const)(
    "rejects an incompatible nested schema under %s before creating a temp directory",
    async (keyword) => {
      const mkdtemp = vi.spyOn(fs.promises, "mkdtemp");
      try {
        const result = await runCodex({
          prompt: "must not reach Codex",
          jsonSchema: {
            type: "object",
            properties: {
              echo: { type: "string" },
            },
            required: ["echo"],
            [keyword]: {
              type: "object",
              properties: {
                optionalNote: { type: "string" },
              },
            },
          },
          parse: parseEcho,
          bin,
        });

        expect(failureKind(result)).toBe("configuration");
        expect(mkdtemp).not.toHaveBeenCalled();
      } finally {
        mkdtemp.mockRestore();
      }
    },
  );

  it("rejects an incompatible schema dependency before creating a temp directory", async () => {
    const mkdtemp = vi.spyOn(fs.promises, "mkdtemp");
    try {
      const result = await runCodex({
        prompt: "must not reach Codex",
        jsonSchema: {
          type: "object",
          properties: {
            echo: { type: "string" },
          },
          required: ["echo"],
          dependencies: {
            echo: ["detail"],
            detail: {
              type: "object",
              properties: {
                optionalNote: { type: "string" },
              },
            },
          },
        },
        parse: parseEcho,
        bin,
      });

      expect(failureKind(result)).toBe("configuration");
      expect(mkdtemp).not.toHaveBeenCalled();
    } finally {
      mkdtemp.mockRestore();
    }
  });

  it("accepts a string-array property dependency and executes Codex", async () => {
    const mkdtemp = vi.spyOn(fs.promises, "mkdtemp");
    try {
      const result = await runCodex({
        prompt: "strict schema with a property dependency",
        jsonSchema: {
          type: "object",
          properties: {
            echo: { type: "string" },
          },
          required: ["echo"],
          dependencies: {
            echo: ["detail"],
          },
        },
        parse: parseEcho,
        bin,
      });

      expect(result).toEqual({
        ok: true,
        provider: "codex",
        value: { echo: "ok" },
      });
      expect(mkdtemp).toHaveBeenCalled();
    } finally {
      mkdtemp.mockRestore();
    }
  });

  it("accepts a required field named properties and executes Codex", async () => {
    const mkdtemp = vi.spyOn(fs.promises, "mkdtemp");
    try {
      const result = await runCodex({
        prompt: "strict schema with a field named properties",
        jsonSchema: {
          type: "object",
          properties: {
            properties: { type: "string" },
          },
          required: ["properties"],
        },
        parse: parseEcho,
        bin,
      });

      expect(result).toEqual({
        ok: true,
        provider: "codex",
        value: { echo: "ok" },
      });
      expect(mkdtemp).toHaveBeenCalled();
    } finally {
      mkdtemp.mockRestore();
    }
  });

  it("accepts nested required nullable properties", async () => {
    const result = await runCodex({
      prompt: "strict nullable schema",
      jsonSchema: {
        type: "object",
        properties: {
          echo: { type: "string" },
          detail: {
            anyOf: [
              {
                type: "object",
                properties: {
                  answer: {
                    anyOf: [
                      { type: "array", items: { type: "string" } },
                      { type: "null" },
                    ],
                  },
                },
                required: ["answer"],
              },
              { type: "null" },
            ],
          },
        },
        required: ["echo", "detail"],
      },
      parse: parseEcho,
      bin,
    });

    expect(result).toEqual({
      ok: true,
      provider: "codex",
      value: { echo: "ok" },
    });
  });

  it("bounds cleanup of a known temp directory so a stuck filesystem cannot hold the operation forever", async () => {
    const fakeTimers = useFakeTimersInTest();
    const clock = manualDeadline(50);
    const entered = deferred();
    const realRm = fs.promises.rm.bind(fs.promises);
    let tempDir: string | undefined;
    const rm = vi
      .spyOn(fs.promises, "rm")
      .mockImplementation(async (...args: Parameters<typeof fs.promises.rm>) => {
        if (String(args[0]) === tempDir) {
          return new Promise<never>(() => undefined);
        }
        return Reflect.apply(realRm, fs.promises, args);
      });
    const running = withPrivateTempDir(
      "toefl-codex-cleanup-test-",
      async (created) => {
        tempDir = created;
        entered.resolve();
        return runBeforeDeadline(
          clock.deadline,
          () => new Promise<never>(() => undefined),
        );
      },
      clock.deadline,
    );
    const observed = running.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await entered.promise;
      clock.advance(50);
      await flushPromises();
      await fakeTimers.advanceBy(
        PRIVATE_TEMP_CLEANUP_TIMEOUT_MS + 1,
      );
      expect(await observed).toBeInstanceOf(ProviderDeadlineExceeded);
    } finally {
      rm.mockRestore();
      if (tempDir) {
        await realRm(tempDir, { recursive: true, force: true });
        expect(fs.existsSync(tempDir)).toBe(false);
      }
    }
  });

  it("returns timeout while private temp creation is still pending and cleans a late directory", async () => {
    const gate = deferred();
    const clock = manualDeadline(50);
    const realMkdtemp = fs.promises.mkdtemp.bind(fs.promises);
    let lateTempDir: string | undefined;
    const mkdtemp = vi
      .spyOn(fs.promises, "mkdtemp")
      .mockImplementation(async (prefix: string) => {
        await gate.promise;
        lateTempDir = await realMkdtemp(prefix);
        return lateTempDir;
      });
    let settled = false;
    const running = runCodex({
      prompt: "never reaches Codex",
      jsonSchema: schema,
      parse: parseEcho,
      bin: path.join(os.tmpdir(), "deadline-missing-codex"),
      deadline: clock.deadline,
    }).then((result) => {
      settled = true;
      return result;
    });
    try {
      await flushPromises();
      clock.advance(50);
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(failureKind(await running)).toBe("timeout");
    } finally {
      gate.resolve();
      await running;
      mkdtemp.mockRestore();
    }
    await vi.waitFor(async () => {
      expect(lateTempDir).toBeDefined();
      expect(fs.existsSync(lateTempDir!)).toBe(false);
    });
  });

  it("bounds a delayed private write with the same deadline and leaves no artifact", async () => {
    const gate = deferred();
    const clock = manualDeadline(50);
    const realWriteFile = fs.promises.writeFile.bind(fs.promises);
    let writeStarted = false;
    let tempDir: string | undefined;
    const writeFile = vi
      .spyOn(fs.promises, "writeFile")
      .mockImplementation(async (...args: Parameters<typeof fs.promises.writeFile>) => {
        if (!writeStarted) {
          writeStarted = true;
          tempDir = path.dirname(String(args[0]));
          await gate.promise;
        }
        return Reflect.apply(realWriteFile, fs.promises, args);
      });
    let settled = false;
    const running = runCodex({
      prompt: "never reaches Codex",
      jsonSchema: schema,
      parse: parseEcho,
      bin: path.join(os.tmpdir(), "deadline-missing-codex"),
      deadline: clock.deadline,
    }).then((result) => {
      settled = true;
      return result;
    });
    try {
      await vi.waitFor(() => expect(writeStarted).toBe(true));
      clock.advance(50);
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(failureKind(await running)).toBe("timeout");
      expect(tempDir).toBeDefined();
      expect(fs.existsSync(tempDir!)).toBe(false);
    } finally {
      gate.resolve();
      await running;
      writeFile.mockRestore();
    }
  });

  it("uses the exact secure invocation, private files, and sanitized child environment", async () => {
    process.env.OPENAI_API_KEY = "openai-parent-secret";
    process.env.ANTHROPIC_API_KEY = "anthropic-parent-secret";
    process.env.TOEFL_ARBITRARY_APP_SECRET = "arbitrary-parent-secret";

    const result = await runCodex({
      prompt: "[FAKE_CODEX:INSPECT]",
      jsonSchema: schema,
      parse: (value) => value as {
        argv: string[];
        cwd: string;
        requestedCwd: string;
        cwdMode: number;
        schemaMode: number;
        outputMode: number;
        schema: unknown;
        inheritedSecrets: string[];
      },
      bin,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const value = result.value;
    expect(path.basename(value.cwd)).toMatch(/^toefl-codex-/);
    expect(path.basename(value.requestedCwd)).toMatch(/^toefl-codex-/);
    expect(fs.realpathSync(path.dirname(value.requestedCwd))).toBe(
      fs.realpathSync(os.tmpdir())
    );
    const schemaPath = path.join(value.requestedCwd, "schema.json");
    const outputPath = path.join(value.requestedCwd, "last-message.json");
    expect(value.argv).toEqual([
      "exec",
      "--model",
      "gpt-5.6-sol",
      "-c",
      'model_reasoning_effort="high"',
      "--strict-config",
      "--sandbox",
      "read-only",
      "--ephemeral",
      "--ignore-user-config",
      "--skip-git-repo-check",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "--color",
      "never",
      "--cd",
      value.requestedCwd,
      "-",
    ]);
    expect(value).toMatchObject({
      cwdMode: 0o700,
      schemaMode: 0o600,
      outputMode: 0o600,
      schema,
      inheritedSecrets: [],
    });
    expect(result.provider).toBe("codex");
    expect(fs.existsSync(value.requestedCwd)).toBe(false);
  });

  it("repairs parser-invalid output exactly once and succeeds", async () => {
    const result = await runCodex({
      prompt: "[FAKE_CODEX:INVALID_THEN_GOOD]",
      jsonSchema: schema,
      parse: parseEcho,
      bin,
    });
    expect(result).toEqual({
      ok: true,
      provider: "codex",
      value: { echo: "retried" },
    });
  });

  it("reports one transcript per CLI attempt, carrying the exact prompt sent and the raw output", async () => {
    const transcripts: Array<{ prompt: string; response?: string }> = [];
    const result = await runCodex({
      prompt: "[FAKE_CODEX:INVALID_THEN_GOOD]",
      jsonSchema: schema,
      parse: parseEcho,
      bin,
      onTranscript: (t) => transcripts.push(t),
    });
    expect(result.ok).toBe(true);
    expect(transcripts).toHaveLength(2);
    expect(transcripts[0].prompt).toBe("[FAKE_CODEX:INVALID_THEN_GOOD]");
    expect(transcripts[1].prompt).toMatch(/^Your previous output was invalid/);
    expect(transcripts[1].response).toContain('"echo":"retried"');
  });

  it("reports the rejected output of every attempt when they all fail, and cannot be broken by a throwing observer", async () => {
    const transcripts: Array<{ prompt: string; response?: string }> = [];
    const result = await runCodex({
      prompt: "[FAKE_CODEX:ALWAYS_INVALID]",
      jsonSchema: schema,
      parse: parseEcho,
      bin,
      onTranscript: (t) => {
        transcripts.push(t);
        throw new Error("sink exploded");
      },
    });
    expect(failureKind(result)).toBe("invalid-output");
    expect(transcripts).toHaveLength(2);
    expect(transcripts[0].response).toBeDefined();
  });

  it("rejects an oversized valid object, repairs once, and cleans its temp directory", async () => {
    const { result, tempDir } = await runWithTrackedCodexTempDir(() =>
      runCodex({
        prompt: "[FAKE_CODEX:OVERSIZE_THEN_GOOD]",
        jsonSchema: schema,
        parse: parseEcho,
        bin,
      }),
    );
    expect(result).toEqual({
      ok: true,
      provider: "codex",
      value: { echo: "retried after oversize" },
    });
    expect(JSON.stringify(result)).not.toContain("secret-codex-oversize");
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it("normalizes oversized output after repair as invalid-output", async () => {
    const { result, tempDir } = await runWithTrackedCodexTempDir(() =>
      runCodex({
        prompt: "[FAKE_CODEX:OVERSIZE_ALWAYS]",
        jsonSchema: schema,
        parse: parseEcho,
        bin,
      }),
    );
    expect(failureKind(result)).toBe("invalid-output");
    expect(JSON.stringify(result)).not.toContain("secret-codex-oversize");
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it("kills normal-exit descendants before returning terminal oversized output", async () => {
    const heartbeatBase = path.join(
      os.tmpdir(),
      `toefl-codex-overflow-tree-${process.pid}-${Date.now()}`
    );
    const heartbeatPaths = [`${heartbeatBase}.1`, `${heartbeatBase}.2`];
    const tempDirTracePath = `${heartbeatBase}.temp-dir`;
    try {
      const result = await runCodex({
        prompt: `[FAKE_CODEX:OVERSIZE_TREE_ALWAYS:${heartbeatBase}]`,
        jsonSchema: schema,
        parse: parseEcho,
        bin,
      });
      expect(failureKind(result)).toBe("invalid-output");
      expect(JSON.stringify(result)).not.toContain("secret-codex-oversize");
      for (const heartbeatPath of heartbeatPaths) {
        await expectHeartbeatProcessStopped(heartbeatPath);
      }
      const tempDir = fs.readFileSync(tempDirTracePath, "utf8");
      expect(path.basename(tempDir)).toMatch(/^toefl-codex-/);
      expect(fs.existsSync(tempDir)).toBe(false);
    } finally {
      for (const heartbeatPath of heartbeatPaths) {
        cleanupHeartbeat(heartbeatPath);
      }
      fs.rmSync(tempDirTracePath, { force: true });
    }
  });

  it("shares one deadline between the initial and repair attempts", async () => {
    const startedAt = Date.now();
    const result = await runCodex({
      prompt: "[FAKE_CODEX:SLOW_INVALID_THEN_GOOD]",
      jsonSchema: schema,
      parse: parseEcho,
      bin,
      timeoutMs: 240,
    });
    expect(failureKind(result)).toBe("timeout");
    // Timeout teardown owns the process group through the confirmed 2s grace.
    expect(Date.now() - startedAt).toBeLessThan(2_750);
  });

  it("uses one injected absolute deadline across initial parsing and repair", async () => {
    // This budget is virtual for the deadline arithmetic but real for the child
    // process: runCodex passes remainingDeadlineMs() straight into spawnBounded
    // as timeoutMs, and cliProcess applies it with a system setTimeout. So the
    // number has to cover a real `node` cold start on a fully loaded machine.
    // At tens of milliseconds the fixture spawn overruns it, and runCodex
    // returns "timeout" without ever calling parse: the first assertion passes
    // while parseCalls is 0, and the deadline-expires-during-parse path never
    // runs. Keep this in seconds. The clock only moves when the parse callback
    // below advances it, so a large value costs no real waiting.
    const VIRTUAL_BUDGET_MS = 30_000;
    const clock = manualDeadline(VIRTUAL_BUDGET_MS);
    let parseCalls = 0;
    const result = await runCodex({
      prompt: "[FAKE_CODEX:INVALID_THEN_GOOD]",
      jsonSchema: schema,
      parse(value) {
        parseCalls += 1;
        if (parseCalls === 1) {
          clock.advance(VIRTUAL_BUDGET_MS);
          throw new Error("force repair after budget expiry");
        }
        return parseEcho(value);
      },
      bin,
      deadline: clock.deadline,
    });

    expect(failureKind(result)).toBe("timeout");
    expect(parseCalls).toBe(1);
  });

  it("does not accept output whose bounded read finishes after the absolute deadline", async () => {
    const gate = deferred();
    const clock = manualDeadline(5_000);
    const realOpen = fs.promises.open.bind(fs.promises);
    let outputReadStarted = false;
    let tempDir: string | undefined;
    const open = vi
      .spyOn(fs.promises, "open")
      .mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
        if (
          path.basename(String(args[0])) === "last-message.json" &&
          args[1] === "r"
        ) {
          outputReadStarted = true;
          tempDir = path.dirname(String(args[0]));
          await gate.promise;
        }
        return Reflect.apply(realOpen, fs.promises, args);
      });
    let settled = false;
    const running = runCodex({
      prompt: "valid but read too late",
      jsonSchema: schema,
      parse: parseEcho,
      bin,
      deadline: clock.deadline,
    }).then((result) => {
      settled = true;
      return result;
    });
    try {
      await vi.waitFor(() => expect(outputReadStarted).toBe(true));
      clock.advance(5_000);
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(failureKind(await running)).toBe("timeout");
      expect(tempDir).toBeDefined();
      expect(fs.existsSync(tempDir!)).toBe(false);
    } finally {
      gate.resolve();
      await running;
      open.mockRestore();
    }
  });

  it.each([
    ["[FAKE_CODEX:QUOTA]", "quota"],
    ["[FAKE_CODEX:RATE_LIMIT]", "rate-limit"],
    ["[FAKE_CODEX:AUTHENTICATION]", "authentication"],
    ["[FAKE_CODEX:PROVIDER_FAILURE]", "provider"],
    ["[FAKE_CODEX:ALWAYS_INVALID]", "invalid-output"],
    ["[FAKE_CODEX:HANG]", "timeout"],
  ] as const)("normalizes %s as %s without returning diagnostics", async (prompt, kind) => {
    const { result, tempDir } = await runWithTrackedCodexTempDir(() =>
      runCodex({
        prompt,
        jsonSchema: schema,
        parse: parseEcho,
        bin,
        timeoutMs: prompt.includes("HANG") ? 180 : 2_000,
      }),
    );
    expect(failureKind(result)).toBe(kind);
    expect(JSON.stringify(result)).not.toContain("secret-codex-diagnostic");
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it("normalizes a missing executable and cleans its private directory", async () => {
    const { result, tempDir } = await runWithTrackedCodexTempDir(() =>
      runCodex({
        prompt: "hello",
        jsonSchema: schema,
        parse: parseEcho,
        bin: path.join(os.tmpdir(), "definitely-missing-toefl-codex"),
        timeoutMs: 1_000,
      }),
    );
    expect(failureKind(result)).toBe("missing-cli");
    expect(fs.existsSync(tempDir)).toBe(false);
  });

  it("kills the whole detached process tree at timeout", async () => {
    const heartbeatPath = path.join(
      os.tmpdir(),
      `toefl-codex-timeout-${process.pid}-${Date.now()}`
    );
    try {
      const result = await runCodex({
        prompt: `[FAKE_CODEX:TREE_HANG:${heartbeatPath}]`,
        jsonSchema: schema,
        parse: parseEcho,
        bin,
        timeoutMs: 250,
      });
      expect(failureKind(result)).toBe("timeout");
      await expectHeartbeatProcessStopped(heartbeatPath);
    } finally {
      cleanupHeartbeat(heartbeatPath);
    }
  });
});
