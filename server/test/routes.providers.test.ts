import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "./helpers/deferred.js";
import { buildProviderRoutes } from "../src/routes/providers.js";
import type { SpawnBoundedOptions, SpawnBoundedResult } from "../src/services/reasoning/cliProcess.js";
import {
  buildReasoningStatus,
  preflightProviders,
  probeClaude,
  probeCodex,
  startProviderPreflight,
} from "../src/services/reasoning/preflight.js";
import { CIRCUIT_MS, createProviderState } from "../src/services/reasoning/providerState.js";

const successfulProcess = (
  stdout: string,
  overrides: Partial<SpawnBoundedResult> = {},
): SpawnBoundedResult => ({
  ok: true,
  stdout,
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
  structuredOutputOverflow: false,
  ...overrides,
});

const failedProcess = (
  overrides: Partial<SpawnBoundedResult> = {},
): SpawnBoundedResult => ({
  ok: false,
  stdout: "",
  stderr: "provider unavailable",
  code: 1,
  signal: null,
  timedOut: false,
  structuredOutputOverflow: false,
  ...overrides,
});

describe("provider preflight probes", () => {
  it("runs the exact auth-status commands with a sanitized environment and a five-second bound", async () => {
    const calls: SpawnBoundedOptions[] = [];
    const spawn = vi.fn(async (options: SpawnBoundedOptions) => {
      calls.push(options);
      return options.bin === "claude-test"
        ? successfulProcess('{"loggedIn":true}')
        : successfulProcess("Logged in using ChatGPT");
    });

    await expect(probeClaude({
      spawn,
      bin: "claude-test",
      cwd: "/safe/project",
      env: {
        PATH: "/safe/bin",
        USER: "safe-user",
        SECRET_TOKEN: "must-not-reach-cli",
      },
    })).resolves.toEqual({ ok: true });
    await expect(probeCodex({
      spawn,
      bin: "codex-test",
      cwd: "/safe/project",
      env: {
        PATH: "/safe/bin",
        USER: "safe-user",
        SECRET_TOKEN: "must-not-reach-cli",
      },
    })).resolves.toEqual({ ok: true });

    expect(calls).toEqual([
      expect.objectContaining({
        bin: "claude-test",
        args: ["auth", "status"],
        prompt: "",
        cwd: "/safe/project",
        env: {
          PATH: "/safe/bin",
          USER: "safe-user",
        },
        timeoutMs: 5_000,
      }),
      expect.objectContaining({
        bin: "codex-test",
        args: ["login", "status"],
        prompt: "",
        cwd: "/safe/project",
        env: {
          PATH: "/safe/bin",
          USER: "safe-user",
        },
        timeoutMs: 5_000,
      }),
    ]);
  });

  it("accepts Claude only when exit succeeds and JSON loggedIn is exactly true", async () => {
    const cases: [SpawnBoundedResult, { ok: boolean; kind?: string }][] = [
      [successfulProcess('{"loggedIn":true}'), { ok: true }],
      [successfulProcess('{"loggedIn":false}'), { ok: false, kind: "authentication" }],
      [successfulProcess('{"loggedIn":"true"}'), { ok: false, kind: "authentication" }],
      [successfulProcess("not json"), { ok: false, kind: "provider" }],
      [failedProcess({ stderr: "login required" }), { ok: false, kind: "authentication" }],
    ];

    for (const [result, expected] of cases) {
      await expect(probeClaude({ spawn: async () => result })).resolves.toEqual(expected);
    }
  });

  it("accepts Codex only when exit succeeds and output contains the exact Logged in marker", async () => {
    const cases: [SpawnBoundedResult, { ok: boolean; kind?: string }][] = [
      [successfulProcess("Logged in using ChatGPT"), { ok: true }],
      [
        successfulProcess("", {
          stderr: "Logged in using ChatGPT\n",
        }),
        { ok: true },
      ],
      [successfulProcess("logged in using ChatGPT"), { ok: false, kind: "authentication" }],
      [successfulProcess("Not logged in"), { ok: false, kind: "authentication" }],
      [
        successfulProcess("", {
          stderr: "Not Logged in",
        }),
        { ok: false, kind: "authentication" },
      ],
      [
        successfulProcess("", {
          stderr: "Logged inside another account",
        }),
        { ok: false, kind: "authentication" },
      ],
      [failedProcess({ stdout: "Logged in", stderr: "provider error" }), { ok: false, kind: "provider" }],
    ];

    for (const [result, expected] of cases) {
      await expect(probeCodex({ spawn: async () => result })).resolves.toEqual(expected);
    }
  });

  it("normalizes missing executables, timeouts, authentication failures, and other failures", async () => {
    const cases: [SpawnBoundedResult, string][] = [
      [failedProcess({ spawnErrorCode: "ENOENT" }), "missing-cli"],
      [failedProcess({ timedOut: true, code: null }), "timeout"],
      [failedProcess({ stderr: "401 unauthorized" }), "authentication"],
      [failedProcess({ stderr: "unexpected provider fault" }), "provider"],
    ];

    for (const [result, kind] of cases) {
      await expect(probeCodex({ spawn: async () => result })).resolves.toEqual({ ok: false, kind });
    }
  });
});

// `claude auth status` on a cold start (boot, or a Setup recheck) can take longer than its 5-second
// bound. An answer that never came is no evidence of an outage: opening the circuit for it would
// send all new work to the other provider for a cooldown.
describe("a preflight that does not answer in time", () => {
  it("opens no circuit and leaves the provider for the next real call to decide", async () => {
    const state = createProviderState({ now: () => 1_000 });
    const checked: Array<[string, unknown]> = [];
    await preflightProviders({
      state,
      probeClaude: () => probeClaude({ spawn: async () => failedProcess({ timedOut: true, code: null }) }),
      probeCodex: () => probeCodex({ spawn: async () => failedProcess({ timedOut: true, code: null }) }),
      onChecked: (provider, outcome) => checked.push([provider, outcome]),
    });

    // The outcome is still reported as it was, for the Setup page.
    expect(checked).toEqual(expect.arrayContaining([
      ["claude", { ok: false, kind: "timeout" }],
      ["codex", { ok: false, kind: "timeout" }],
    ]));
    expect(state.circuitOpen("claude")).toBe(false);
    expect(state.circuitOpen("codex")).toBe(false);
    expect(state.snapshot()).toEqual([
      { provider: "claude", availability: "checking" },
      { provider: "codex", availability: "checking" },
    ]);
  });

  it("does not make a check that overlapped it stale", async () => {
    const state = createProviderState({ now: () => 1_000 });
    const slowToken = state.captureActivityToken("claude");
    const answeringToken = state.captureActivityToken("claude");
    state.recordPreflight("claude", { ok: false, kind: "timeout" }, slowToken);
    state.recordPreflight("claude", { ok: false, kind: "authentication" }, answeringToken);
    expect(state.snapshot()[0]).toMatchObject({ availability: "circuit-open", failureKind: "authentication" });
  });
});

describe("GET /api/providers", () => {
  it("reports fresh providers as checking instead of claiming availability", async () => {
    const state = createProviderState({ now: () => 1_000 });
    const app = buildProviderRoutes({
      snapshot: () => buildReasoningStatus(state),
    });

    const body = await (await app.request("/")).json();
    expect(body.providers).toEqual([
      { provider: "claude", availability: "checking" },
      { provider: "codex", availability: "checking" },
    ]);
    expect(body.operationalProviders).toEqual([
      expect.objectContaining({
        provider: "claude",
        active: { scoring: 0, generation: 0 },
        queued: { scoring: 0, generation: 0 },
        effectiveCapacity: 1,
        pressureStrikes: 0,
        circuitState: "closed",
        queueLatencyMs: { count: 0, total: 0, max: 0 },
      }),
      expect.objectContaining({ provider: "codex", circuitState: "closed" }),
    ]);
    expect(body.processMetrics).toEqual(expect.objectContaining({
      cancellations: expect.any(Number),
      timeouts: expect.any(Number),
      forcedKills: expect.any(Number),
      fallbacks: expect.any(Number),
      recorderLoss: {
        overflow: expect.any(Number),
        database: expect.any(Number),
        total: expect.any(Number),
      },
    }));
  });

  it("publishes one completed provider preflight while the other remains checking", async () => {
    const codexProbe = deferred<{ ok: true }>();
    const state = createProviderState({ now: () => 1_000 });
    const preflight = preflightProviders({
      state,
      probeClaude: async () => ({ ok: true }),
      probeCodex: () => codexProbe.promise,
    });

    await vi.waitFor(() => {
      expect(buildReasoningStatus(state).providers).toEqual([
        { provider: "claude", availability: "available" },
        { provider: "codex", availability: "checking" },
      ]);
    });

    codexProbe.resolve({ ok: true });
    await preflight;
  });

  it("reports Claude unavailable and Codex available without changing health", async () => {
    const state = createProviderState({ now: () => 1_000 });
    await preflightProviders({
      state,
      probeClaude: async () => ({ ok: false, kind: "authentication" }),
      probeCodex: async () => ({ ok: true }),
    });

    const app = new Hono();
    app.get("/api/health", (c) => c.json({ ok: true }));
    app.route("/api/providers", buildProviderRoutes({
      snapshot: () => buildReasoningStatus(state),
    }));

    const response = await app.request("/api/providers");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: "claude",
        availability: "circuit-open",
        failureKind: "authentication",
        retryAt: new Date(1_000 + CIRCUIT_MS).toISOString(),
      }),
      expect.objectContaining({
        provider: "codex",
        availability: "available",
      }),
    ]));
    expect(await (await app.request("/api/health")).json()).toEqual({ ok: true });
  });

  it("opens the same application state circuit that live work consults", async () => {
    const state = createProviderState({ now: () => 1_000 });

    await preflightProviders({
      state,
      probeClaude: async () => ({ ok: false, kind: "quota" }),
      probeCodex: async () => ({ ok: true }),
    });

    await expect(state.checkCircuit("claude", {
      requestId: "live",
      queuedAtMs: 1_000,
      submittedWhileOpen: true,
    })).resolves.toEqual({
      ok: false,
      failure: {
        provider: "claude",
        kind: "quota",
        source: "circuit",
      },
    });
  });

  it("never exposes raw auth output, tokens, usernames, or filesystem paths", async () => {
    const raw = "401 unauthorized: /Users/name/.codex/auth.json token=secret username=jane@example.com";
    const state = createProviderState({ now: () => 1_000 });
    await preflightProviders({
      state,
      probeClaude: () => probeClaude({
        spawn: async () => failedProcess({ stderr: raw }),
      }),
      probeCodex: () => probeCodex({
        spawn: async () => failedProcess({ stderr: raw }),
      }),
    });

    const app = buildProviderRoutes({
      snapshot: () => buildReasoningStatus(state),
    });
    const serialized = JSON.stringify(await (await app.request("/")).json());
    expect(serialized).not.toMatch(/Users|auth\.json|secret|jane|example\.com/);
    expect(serialized).toMatch(/authentication/);
  });
});

describe("startup preflight", () => {
  it.each(["claude", "codex"] as const)(
    "does not let delayed %s preflight success clear a newer live failure",
    async (provider) => {
      const probe = deferred<{ ok: true }>();
      const state = createProviderState({ now: () => 1_000 });
      const preflight = preflightProviders({
        state,
        probeClaude:
          provider === "claude"
            ? () => probe.promise
            : async () => ({ ok: true }),
        probeCodex:
          provider === "codex"
            ? () => probe.promise
            : async () => ({ ok: true }),
      });

      state.recordExecution(provider, {
        ok: false,
        failure: { provider, kind: "quota", source: "call" },
      });
      probe.resolve({ ok: true });
      await preflight;

      expect(state.snapshot().find((entry) => entry.provider === provider)).toEqual({
        provider,
        availability: "circuit-open",
        failureKind: "quota",
        retryAtMs: 1_000 + CIRCUIT_MS,
      });
    },
  );

  it.each(["claude", "codex"] as const)(
    "does not let delayed %s preflight failure reopen after a newer live success",
    async (provider) => {
      const probe = deferred<{ ok: false; kind: "authentication" }>();
      const state = createProviderState({ now: () => 1_000 });
      const preflight = preflightProviders({
        state,
        probeClaude:
          provider === "claude"
            ? () => probe.promise
            : async () => ({ ok: true }),
        probeCodex:
          provider === "codex"
            ? () => probe.promise
            : async () => ({ ok: true }),
      });

      state.recordExecution(provider, {
        ok: true,
        value: "live success",
        provider,
      });
      probe.resolve({ ok: false, kind: "authentication" });
      await preflight;

      expect(state.snapshot().find((entry) => entry.provider === provider)).toEqual({
        provider,
        availability: "available",
      });
    },
  );

  it.each(["claude", "codex"] as const)(
    "does not let delayed %s preflight success clear a newer in-flight live failure",
    async (provider) => {
      const liveResult = deferred<void>();
      const probe = deferred<{ ok: true }>();
      const state = createProviderState({ now: () => 1_000 });
      const live = liveResult.promise.then(() => state.recordExecution(provider, {
        ok: false,
        failure: { provider, kind: "quota", source: "call" },
      }));
      const preflight = preflightProviders({
        state,
        probeClaude:
          provider === "claude"
            ? () => probe.promise
            : async () => ({ ok: true }),
        probeCodex:
          provider === "codex"
            ? () => probe.promise
            : async () => ({ ok: true }),
      });

      liveResult.resolve();
      await live;
      probe.resolve({ ok: true });
      await preflight;

      expect(state.snapshot().find((entry) => entry.provider === provider)).toEqual({
        provider,
        availability: "circuit-open",
        failureKind: "quota",
        retryAtMs: 1_000 + CIRCUIT_MS,
      });
    },
  );

  it.each(["claude", "codex"] as const)(
    "does not let delayed %s preflight failure reopen after a newer in-flight live success",
    async (provider) => {
      const liveResult = deferred<void>();
      const probe = deferred<{ ok: false; kind: "authentication" }>();
      const state = createProviderState({ now: () => 1_000 });
      const live = liveResult.promise.then(() => state.recordExecution(provider, {
        ok: true,
        value: "live success",
        provider,
      }));
      const preflight = preflightProviders({
        state,
        probeClaude:
          provider === "claude"
            ? () => probe.promise
            : async () => ({ ok: true }),
        probeCodex:
          provider === "codex"
            ? () => probe.promise
            : async () => ({ ok: true }),
      });

      liveResult.resolve();
      await live;
      probe.resolve({ ok: false, kind: "authentication" });
      await preflight;

      expect(state.snapshot().find((entry) => entry.provider === provider)).toEqual({
        provider,
        availability: "available",
      });
    },
  );

  it("applies one provider's observation without waiting for the other probe", async () => {
    const codexProbe = deferred<{ ok: true }>();
    const state = createProviderState({ now: () => 1_000 });
    const preflight = preflightProviders({
      state,
      probeClaude: async () => ({ ok: false, kind: "authentication" }),
      probeCodex: () => codexProbe.promise,
    });

    await vi.waitFor(() => {
      expect(state.snapshot().find((entry) => entry.provider === "claude")).toEqual({
        provider: "claude",
        availability: "circuit-open",
        failureKind: "authentication",
        retryAtMs: 1_000 + CIRCUIT_MS,
      });
    });

    codexProbe.resolve({ ok: true });
    await preflight;
  });

  it("starts fire-and-forget and does not wait for probes to settle", () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const run = vi.fn(() => pending);

    expect(startProviderPreflight(run, vi.fn())).toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
    resolve();
  });

  it("logs only a normalized static warning when the detached preflight rejects", async () => {
    const warn = vi.fn();
    startProviderPreflight(
      async () => {
        throw new Error("/Users/name/.codex/auth.json token=secret");
      },
      warn,
    );

    await vi.waitFor(() => expect(warn).toHaveBeenCalledOnce());
    expect(warn).toHaveBeenCalledWith(
      "[reasoning] provider preflight failed with a normalized internal error",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Users|auth\.json|secret/);
  });

  it("also contains an unexpected synchronous startup seam failure", () => {
    const warn = vi.fn();
    expect(() => startProviderPreflight(
      (() => {
        throw new Error("/Users/name/.codex/auth.json token=secret");
      }) as () => Promise<void>,
      warn,
    )).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      "[reasoning] provider preflight failed with a normalized internal error",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/Users|auth\.json|secret/);
  });
});
