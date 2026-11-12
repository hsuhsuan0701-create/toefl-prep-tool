import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SetupStatusVM } from "@toefl-prep/shared";
import {
  buildSetupStatusRoutes,
  isOnPath,
  type SetupStatusDeps,
} from "../src/routes/setupStatus.js";
import { app as composedApp } from "../src/index.js";
import type { ProviderAvailabilitySnapshot } from "../src/services/reasoning/providerState.js";

// The first-run screen is built on this route, and it is the one place a stranger learns why a
// button is off. It has to be right about which missing piece turns off what, it must never echo a
// key back, and a machine with nothing configured still has to answer.

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function binDir(executables: string[], plainFiles: string[] = []): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toefl-setup-bin-"));
  tempDirs.push(dir);
  for (const name of executables) fs.writeFileSync(path.join(dir, name), "#!/bin/sh\n", { mode: 0o755 });
  for (const name of plainFiles) fs.writeFileSync(path.join(dir, name), "", { mode: 0o644 });
  return dir;
}

const available = (provider: "claude" | "codex"): ProviderAvailabilitySnapshot => ({ provider, availability: "available" });
const checking = (provider: "claude" | "codex"): ProviderAvailabilitySnapshot => ({ provider, availability: "checking" });

const NOTHING: SetupStatusDeps = {
  providers: () => [checking("claude"), checking("codex")],
  preflight: () => ({ claude: { ok: false, kind: "missing-cli" }, codex: { ok: false, kind: "missing-cli" } }),
  settings: () => ({ geminiApiKey: undefined, openaiApiKey: undefined, geminiJudgeModel: "", openaiJudgeModel: "", openaiTextPrimary: "codex" }),
  onPath: () => false,
  rubricsSource: () => "rewritten",
  recheckClis: async () => undefined,
};

const EVERYTHING: SetupStatusDeps = {
  providers: () => [available("claude"), available("codex")],
  preflight: () => ({ claude: { ok: true }, codex: { ok: true } }),
  settings: () => ({
    geminiApiKey: "AIza-real-looking-secret",
    openaiApiKey: "sk-real-looking-secret",
    geminiJudgeModel: "gemini-judge",
    openaiJudgeModel: "openai-judge",
    openaiTextPrimary: "codex",
  }),
  onPath: () => true,
  rubricsSource: () => "rewritten",
  recheckClis: async () => undefined,
};

async function status(deps: SetupStatusDeps): Promise<SetupStatusVM> {
  const res = await buildSetupStatusRoutes(deps).request("/");
  expect(res.status).toBe(200);
  return (await res.json()) as SetupStatusVM;
}

const disables = (vm: SetupStatusVM, piece: string) => vm.missing.find((m) => m.piece === piece)?.disables;

describe("GET /api/setup-status", () => {
  it("on a machine with nothing set up, reports every piece missing and every capability off", async () => {
    const vm = await status(NOTHING);
    expect(vm).toMatchObject({
      claudeCli: "not-installed",
      codexCli: "not-installed",
      geminiApiKey: false,
      openaiApiKey: false,
      geminiJudgeModel: false,
      openaiJudgeModel: false,
      ffmpeg: false,
      ffprobe: false,
      capabilities: {
        "reading-writing-generation": false,
        "speaking-listening-generation": false,
        "writing-scoring": false,
        "speaking-scoring": false,
        "speaking-uploads": false,
      },
    });
    expect(disables(vm, "claude-cli")).toEqual([
      "reading-writing-generation", "speaking-listening-generation", "writing-scoring", "speaking-scoring",
    ]);
    expect(disables(vm, "ffmpeg")).toEqual(["speaking-listening-generation", "speaking-scoring", "speaking-uploads"]);
    expect(disables(vm, "ffprobe")).toEqual(["speaking-listening-generation"]);
    expect(disables(vm, "gemini-api-key")).toEqual(["speaking-listening-generation", "writing-scoring", "speaking-scoring"]);
    expect(disables(vm, "openai-api-key")).toEqual(["writing-scoring"]);
  });

  it("with everything present, turns every capability on and lists nothing, without echoing a key", async () => {
    const res = await buildSetupStatusRoutes(EVERYTHING).request("/");
    const text = await res.text();
    expect(text).not.toContain("secret");
    expect(text).not.toContain("gemini-judge");
    expect(text).not.toContain("openai-judge");
    const vm = JSON.parse(text) as SetupStatusVM;
    expect(Object.values(vm.capabilities).every(Boolean)).toBe(true);
    expect(vm.missing).toEqual([]);
    expect(vm).toMatchObject({ claudeCli: "ready", codexCli: "ready", geminiApiKey: true, openaiApiKey: true });
  });

  it("lists a CLI the other one covers as missing but turning nothing off", async () => {
    const vm = await status({
      ...EVERYTHING,
      providers: () => [available("claude"), { provider: "codex", availability: "circuit-open", failureKind: "missing-cli" }],
    });
    expect(vm.codexCli).toBe("not-installed");
    expect(Object.values(vm.capabilities).every(Boolean)).toBe(true);
    expect(vm.missing).toEqual([{ piece: "codex-cli", disables: [] }]);
  });

  it("counts one Judge as enough for Writing, and the OpenAI one may run through Codex", async () => {
    const vm = await status({
      ...EVERYTHING,
      settings: () => ({ ...EVERYTHING.settings(), geminiApiKey: "", openaiApiKey: undefined }),
    });
    expect(vm.capabilities["writing-scoring"]).toBe(true);
    // Ears needs the Gemini key, so Speaking cannot be scored without it.
    expect(vm.capabilities["speaking-scoring"]).toBe(false);
    expect(disables(vm, "gemini-api-key")).toEqual(["speaking-listening-generation", "speaking-scoring"]);
    expect(disables(vm, "openai-api-key")).toEqual([]);
  });

  it("does not count Codex as the OpenAI Judge when OPENAI_TEXT_PRIMARY=http", async () => {
    const vm = await status({
      ...EVERYTHING,
      settings: () => ({ ...EVERYTHING.settings(), geminiApiKey: undefined, openaiApiKey: undefined, openaiTextPrimary: "http" }),
    });
    expect(vm.capabilities["writing-scoring"]).toBe(false);
    expect(disables(vm, "openai-api-key")).toEqual(["writing-scoring"]);
  });

  it("treats a blank value as unset", async () => {
    const vm = await status({
      ...EVERYTHING,
      settings: () => ({ ...EVERYTHING.settings(), geminiApiKey: "  ", openaiJudgeModel: " " }),
    });
    expect(vm.geminiApiKey).toBe(false);
    expect(vm.openaiJudgeModel).toBe(false);
  });

  it("reports a CLI as checking until its boot check answers, without listing it as missing", async () => {
    const vm = await status({ ...EVERYTHING, providers: () => [checking("claude"), checking("codex")], preflight: () => ({}) });
    expect(vm.claudeCli).toBe("checking");
    expect(vm.codexCli).toBe("checking");
    expect(vm.capabilities["reading-writing-generation"]).toBe(false);
    expect(vm.capabilities["speaking-uploads"]).toBe(true);
    expect(vm.missing).toEqual([]);
  });

  it("maps each check outcome to a state, including the ones that never open a circuit", async () => {
    const vm = await status({
      ...EVERYTHING,
      providers: () => [{ provider: "claude", availability: "circuit-open", failureKind: "authentication" }, checking("codex")],
      preflight: () => ({ claude: { ok: false, kind: "authentication" }, codex: { ok: false, kind: "configuration" } }),
    });
    expect(vm.claudeCli).toBe("not-logged-in");
    // A configuration failure leaves the provider's availability at "checking" forever, so the
    // recorded check outcome has to decide it.
    expect(vm.codexCli).toBe("unavailable");
    expect(vm.capabilities["reading-writing-generation"]).toBe(false);
  });

  it("reads the live provider state over the boot check once calls have happened", async () => {
    const vm = await status({
      ...EVERYTHING,
      providers: () => [{ provider: "claude", availability: "circuit-open", failureKind: "quota" }, available("codex")],
    });
    expect(vm.claudeCli).toBe("unavailable");
    expect(vm.codexCli).toBe("ready");
  });
});

describe("isOnPath", () => {
  it("finds an executable on PATH and ignores a non-executable file of the same name", () => {
    const dir = binDir(["ffmpeg"], ["ffprobe"]);
    const env = { PATH: [binDir([]), dir].join(path.delimiter) };
    expect(isOnPath("ffmpeg", env)).toBe(true);
    expect(isOnPath("ffprobe", env)).toBe(process.platform === "win32");
    expect(isOnPath("ffmpeg", { PATH: "" })).toBe(false);
    expect(isOnPath("ffmpeg", {})).toBe(false);
  });
});

describe("the composed server app", () => {
  it("serves setup status without a database or any key", async () => {
    const res = await composedApp.request("/api/setup-status");
    expect(res.status).toBe(200);
    const vm = (await res.json()) as SetupStatusVM;
    expect(Object.keys(vm.capabilities).sort()).toEqual([
      "reading-writing-generation", "speaking-listening-generation", "speaking-scoring", "speaking-uploads", "writing-scoring",
    ]);
  });
});
