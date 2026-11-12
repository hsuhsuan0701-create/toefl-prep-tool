import { describe, expect, it, vi } from "vitest";
import type { SetupStatusVM } from "@toefl-prep/shared";
import { app as composedApp } from "../src/index.js";
import { buildSetupStatusRoutes, createCliPreflightRecord, type SetupStatusDeps } from "../src/routes/setupStatus.js";
import { preflightProviders } from "../src/services/reasoning/preflight.js";
import { createProviderState, type PreflightOutcome } from "../src/services/reasoning/providerState.js";
import { rubricsSource } from "../src/services/skillReferences.js";

// Two parts of the setup screen: which copy of the rubrics scoring reads, and a recheck the User
// presses after fixing something (installing a CLI, logging in, putting ffmpeg on PATH, installing
// the official rubric text), so they need not restart the server to see it.

const SETTINGS = {
  geminiApiKey: "key",
  openaiApiKey: "key",
  geminiJudgeModel: "gemini-judge",
  openaiJudgeModel: "openai-judge",
  openaiTextPrimary: "codex",
} as const;

/** A setup screen wired to a real provider state, with probes the test answers. */
function harness() {
  const state = createProviderState();
  const answers: Record<"claude" | "codex", PreflightOutcome> = {
    claude: { ok: true },
    codex: { ok: true },
  };
  let runs = 0;
  const record = createCliPreflightRecord({
    activityVersion: (provider) => state.captureActivityToken(provider).version,
    runChecks: (onChecked) => {
      runs += 1;
      return preflightProviders({
        state,
        probeClaude: async () => answers.claude,
        probeCodex: async () => answers.codex,
        onChecked,
      });
    },
  });
  const deps: SetupStatusDeps = {
    providers: () => state.snapshot(),
    preflight: record.outcomes,
    settings: () => SETTINGS,
    onPath: () => true,
    rubricsSource: () => "rewritten",
    recheckClis: record.run,
  };
  const routes = buildSetupStatusRoutes(deps);
  return {
    state,
    answers,
    runs: () => runs,
    record,
    get: async () => (await (await routes.request("/")).json()) as SetupStatusVM,
    recheck: async () => {
      const res = await routes.request("/recheck", { method: "POST" });
      expect(res.status).toBe(200);
      return (await res.json()) as SetupStatusVM;
    },
  };
}

const authFailure = { ok: false, failure: { provider: "claude", kind: "authentication", source: "call" } } as const;

describe("POST /api/setup-status/recheck", () => {
  it("re-runs the CLI checks and answers with the status they produce", async () => {
    const setup = harness();
    setup.answers.claude = { ok: false, kind: "missing-cli" };
    await setup.record.run();
    expect((await setup.get()).claudeCli).toBe("not-installed");

    setup.answers.claude = { ok: true };
    const vm = await setup.recheck();
    expect(vm.claudeCli).toBe("ready");
    expect(vm.capabilities["reading-writing-generation"]).toBe(true);
    expect(setup.runs()).toBe(2);
  });

  it("reports a CLI the user just logged in to as ready, though its circuit stays open until a real request", async () => {
    const setup = harness();
    setup.answers.claude = { ok: false, kind: "authentication" };
    await setup.record.run();
    expect(setup.state.circuitOpen("claude")).toBe(true);
    expect((await setup.get()).claudeCli).toBe("not-logged-in");

    setup.answers.claude = { ok: true };
    expect((await setup.recheck()).claudeCli).toBe("ready");
    // A successful check never closes a circuit (a real request's probe does), so the status above
    // has to come from the check itself — and it keeps doing so on every later read.
    expect(setup.state.circuitOpen("claude")).toBe(true);
    expect((await setup.get()).claudeCli).toBe("ready");
  });

  it("lets a live call that fails after the check overrule it", async () => {
    const setup = harness();
    await setup.recheck();
    expect((await setup.get()).claudeCli).toBe("ready");

    setup.state.recordExecution("claude", authFailure);
    expect((await setup.get()).claudeCli).toBe("not-logged-in");
  });

  it("does not let a check that only proves a login clear a quota the provider reported", async () => {
    const setup = harness();
    await setup.recheck();
    setup.state.recordPressure("claude", "quota");
    expect((await setup.get()).claudeCli).toBe("unavailable");
  });

  it("re-reads PATH and the rubric source on the same request", async () => {
    let ffmpeg = false;
    let source: "rewritten" | "official" = "rewritten";
    const routes = buildSetupStatusRoutes({
      providers: () => [],
      preflight: () => ({ claude: { ok: true, current: true }, codex: { ok: true, current: true } }),
      settings: () => SETTINGS,
      onPath: (bin) => bin !== "ffmpeg" || ffmpeg,
      rubricsSource: () => source,
      recheckClis: async () => undefined,
    });
    const read = async () => (await (await routes.request("/recheck", { method: "POST" })).json()) as SetupStatusVM;
    expect(await read()).toMatchObject({ ffmpeg: false, rubrics: { source: "rewritten" } });
    ffmpeg = true;
    source = "official";
    expect(await read()).toMatchObject({ ffmpeg: true, rubrics: { source: "official" } });
  });
});

describe("GET /api/setup-status rubrics", () => {
  it.each(["rewritten", "official"] as const)("reports %s when that is the copy scoring reads", async (source) => {
    const routes = buildSetupStatusRoutes({
      providers: () => [],
      preflight: () => ({}),
      settings: () => SETTINGS,
      onPath: () => true,
      rubricsSource: () => source,
      recheckClis: async () => undefined,
    });
    const vm = (await (await routes.request("/")).json()) as SetupStatusVM;
    expect(vm.rubrics).toEqual({ source });
  });

  it("is wired to the real rubric resolution in the composed app", async () => {
    const res = await composedApp.request("/api/setup-status");
    const vm = (await res.json()) as SetupStatusVM;
    expect(vm.rubrics).toEqual({ source: rubricsSource() });
  });
});

describe("createCliPreflightRecord", () => {
  it("joins a check already in flight instead of starting another", async () => {
    let release: () => void = () => undefined;
    const runChecks = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const record = createCliPreflightRecord({ activityVersion: () => 0, runChecks });
    const first = record.run();
    const second = record.run();
    expect(runChecks).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    // Once it settles, the next press runs the checks again.
    void record.run();
    expect(runChecks).toHaveBeenCalledTimes(2);
    release();
  });

  it("marks an outcome current until the provider records newer activity", async () => {
    let version = 3;
    const record = createCliPreflightRecord({
      activityVersion: () => version,
      runChecks: async (onChecked) => {
        onChecked("claude", { ok: true });
        onChecked("codex", { ok: false, kind: "authentication" });
      },
    });
    expect(record.outcomes()).toEqual({});
    await record.run();
    expect(record.outcomes()).toEqual({
      claude: { ok: true, current: true },
      codex: { ok: false, kind: "authentication", current: true },
    });
    version = 4;
    expect(record.outcomes()).toEqual({
      claude: { ok: true, current: false },
      codex: { ok: false, kind: "authentication", current: false },
    });
  });
});

describe("preflightProviders onChecked", () => {
  it("reports each outcome after it is applied, a thrown probe as a normalized failure", async () => {
    const state = createProviderState();
    const seen: [string, PreflightOutcome, number][] = [];
    await preflightProviders({
      state,
      probeClaude: async () => ({ ok: true }),
      probeCodex: async () => { throw Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }); },
      onChecked: (provider, outcome) => seen.push([provider, outcome, state.captureActivityToken(provider).version]),
    });
    expect(seen).toEqual([
      ["claude", { ok: true }, 1],
      ["codex", { ok: false, kind: "missing-cli" }, 1],
    ]);
  });
});
