import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  config,
  projectRoot,
  readClaudeCliConfig,
  readAdmissionConfig,
  readAttemptSupervisorConfig,
  readReasoningConfig,
  readRouteTimeoutConfig,
  readDataDir,
  readShutdownConfig,
  readTtsConcurrency,
} from "../src/lib/config.js";

// The one bound on text-to-speech calls in flight (services/ttsQueue.ts).
describe("readTtsConcurrency", () => {
  it("defaults to 1, one call at a time", () => {
    // Unset and blank are the same state, and both mean one call at a time: running TTS calls
    // concurrently is opt-in by configuration.
    expect(readTtsConcurrency({})).toBe(1);
    expect(readTtsConcurrency({ TTS_CONCURRENCY: "  " })).toBe(1);
  });

  it("takes any positive integer", () => {
    expect(readTtsConcurrency({ TTS_CONCURRENCY: "6" })).toBe(6);
    expect(readTtsConcurrency({ TTS_CONCURRENCY: "1" })).toBe(1);
  });

  it.each(["0", "-1", "2.5", "many"])("refuses %s at boot rather than clamping it", (value) => {
    // This number bounds concurrent paid calls, so a mistake in it costs money faster. A clamp
    // would hide the mistake behind a working render.
    expect(() => readTtsConcurrency({ TTS_CONCURRENCY: value })).toThrow("TTS_CONCURRENCY");
  });
});

describe("readAttemptSupervisorConfig", () => {
  it("uses a two-second default and accepts a bounded positive override", () => {
    expect(readAttemptSupervisorConfig({})).toEqual({ attemptTerminationGraceMs: 2_000 });
    expect(readAttemptSupervisorConfig({ REASONING_ATTEMPT_TERMINATION_GRACE_MS: "750" }))
      .toEqual({ attemptTerminationGraceMs: 750 });
  });

  it.each(["0", "-1", "1.5", "30001"])("rejects unsafe grace %s", (value) => {
    expect(() => readAttemptSupervisorConfig({ REASONING_ATTEMPT_TERMINATION_GRACE_MS: value }))
      .toThrow("REASONING_ATTEMPT_TERMINATION_GRACE_MS");
  });
});

describe("readShutdownConfig", () => {
  it("uses the confirmed drain, recorder flush, and process-grace defaults", () => {
    expect(readShutdownConfig({})).toEqual({
      shutdownDrainMs: 30_000,
      shutdownRecorderFlushMs: 5_000,
      shutdownProcessGraceMs: 2_000,
    });
  });

  it("accepts positive millisecond overrides and rejects unsafe values", () => {
    expect(readShutdownConfig({
      SHUTDOWN_DRAIN_MS: "10",
      SHUTDOWN_RECORDER_FLUSH_MS: "20",
      SHUTDOWN_PROCESS_GRACE_MS: "30",
    })).toEqual({ shutdownDrainMs: 10, shutdownRecorderFlushMs: 20, shutdownProcessGraceMs: 30 });
    expect(() => readShutdownConfig({ SHUTDOWN_DRAIN_MS: "0" })).toThrow("SHUTDOWN_DRAIN_MS");
  });
});

describe("readAdmissionConfig", () => {
  it("returns independent protected-scoring defaults for both CLI providers", () => {
    expect(readAdmissionConfig({})).toEqual({
      claude: { initial: 4, floor: 2, ceiling: 8, scoringReserve: 1, cooldownsMs: [60_000, 120_000, 300_000, 600_000] },
      codex: { initial: 4, floor: 2, ceiling: 8, scoringReserve: 1, cooldownsMs: [60_000, 120_000, 300_000, 600_000] },
    });
  });

  it("accepts independent provider overrides and emergency concurrency one", () => {
    expect(readAdmissionConfig({
      CLAUDE_REASONING_CAPACITY_INITIAL: "3",
      CLAUDE_REASONING_CAPACITY_FLOOR: "2",
      CLAUDE_REASONING_CAPACITY_CEILING: "6",
      CLAUDE_REASONING_SCORING_RESERVE: "1",
      CLAUDE_REASONING_CIRCUIT_COOLDOWNS_MS: "1000,2000",
      CODEX_REASONING_CAPACITY_INITIAL: "1",
      CODEX_REASONING_CAPACITY_FLOOR: "1",
      CODEX_REASONING_CAPACITY_CEILING: "1",
      CODEX_REASONING_SCORING_RESERVE: "0",
      CODEX_REASONING_CIRCUIT_COOLDOWNS_MS: "5000",
    })).toEqual({
      claude: { initial: 3, floor: 2, ceiling: 6, scoringReserve: 1, cooldownsMs: [1_000, 2_000] },
      codex: { initial: 1, floor: 1, ceiling: 1, scoringReserve: 0, cooldownsMs: [5_000] },
    });
  });

  it("supports rollback by setting only a provider ceiling to one", () => {
    expect(readAdmissionConfig({ CODEX_REASONING_CAPACITY_CEILING: "1" }).codex).toEqual({
      initial: 1, floor: 1, ceiling: 1, scoringReserve: 0,
      cooldownsMs: [60_000, 120_000, 300_000, 600_000],
    });
  });

  it.each([
    [{ CLAUDE_REASONING_CAPACITY_INITIAL: "1" }, "CLAUDE"],
    [{ CLAUDE_REASONING_CAPACITY_FLOOR: "5" }, "CLAUDE"],
    [{ CLAUDE_REASONING_CAPACITY_CEILING: "9" }, "CLAUDE"],
    [{ CLAUDE_REASONING_SCORING_RESERVE: "0" }, "CLAUDE"],
    [{ CODEX_REASONING_CAPACITY_CEILING: "1", CODEX_REASONING_SCORING_RESERVE: "1" }, "CODEX"],
    [{ CODEX_REASONING_CIRCUIT_COOLDOWNS_MS: "1000,nope" }, "CODEX_REASONING_CIRCUIT_COOLDOWNS_MS"],
    [{ CODEX_REASONING_CIRCUIT_COOLDOWNS_MS: "600001" }, "CODEX_REASONING_CIRCUIT_COOLDOWNS_MS"],
  ])("rejects inconsistent provider settings: %j", (env, message) => {
    expect(() => readAdmissionConfig(env)).toThrow(message);
  });
});

describe("readReasoningConfig", () => {
  it("returns the reasoning defaults", () => {
    expect(readReasoningConfig({})).toEqual({
      codexBin: "codex",
      claudeBin: "claude",
      codexModel: "gpt-5.6-sol",
      codexReasoningEffort: "high",
      openaiTextPrimary: "codex",
    });
  });

  it("accepts explicit reasoning overrides", () => {
    expect(readReasoningConfig({
      CODEX_BIN: "/opt/codex",
      CLAUDE_BIN: "/opt/claude",
      CODEX_MODEL: "gpt-5.6-sol",
      CODEX_REASONING_EFFORT: "xhigh",
      OPENAI_TEXT_PRIMARY: "http",
    })).toEqual({
      codexBin: "/opt/codex",
      claudeBin: "/opt/claude",
      codexModel: "gpt-5.6-sol",
      codexReasoningEffort: "xhigh",
      openaiTextPrimary: "http",
    });
  });

  it.each([
    ["CODEX_REASONING_EFFORT", "extreme"],
    ["OPENAI_TEXT_PRIMARY", "auto"],
  ])("rejects invalid %s values", (variable, value) => {
    expect(() => readReasoningConfig({ [variable]: value })).toThrow(variable);
  });

  it.each([
    ["CODEX_BIN", ""],
    ["CODEX_BIN", "   "],
    ["CLAUDE_BIN", ""],
    ["CLAUDE_BIN", "\t"],
    ["CODEX_MODEL", ""],
    ["CODEX_MODEL", " \t "],
  ])("rejects blank %s values", (variable, value) => {
    expect(() => readReasoningConfig({ [variable]: value })).toThrow(variable);
  });
});

describe("readClaudeCliConfig", () => {
  // Namespaced CLAUDE_CLI_MODEL/CLAUDE_CLI_EFFORT rather than CLAUDE_MODEL/CLAUDE_EFFORT: Claude
  // Code itself exports CLAUDE_EFFORT into every shell it launches, and tsx --env-file (every
  // production entry point) does not override an already-present shell variable, so the bare name
  // would let that ambient value silently outrank an operator's own .env setting.
  it("leaves the CLI model/effort pins unset by default", () => {
    expect(readClaudeCliConfig({})).toEqual({
      claudeCliModel: undefined,
      claudeCliEffort: undefined,
    });
  });

  it("accepts explicit pins", () => {
    expect(
      readClaudeCliConfig({
        CLAUDE_CLI_MODEL: "claude-fable-5",
        CLAUDE_CLI_EFFORT: "xhigh",
      })
    ).toEqual({
      claudeCliModel: "claude-fable-5",
      claudeCliEffort: "xhigh",
    });
  });

  it("rejects an invalid CLAUDE_CLI_EFFORT value like CODEX_REASONING_EFFORT's precedent", () => {
    expect(() =>
      readClaudeCliConfig({ CLAUDE_CLI_EFFORT: "extreme" })
    ).toThrow("CLAUDE_CLI_EFFORT");
  });

  // The Claude CLI's --effort has only five values (`claude --help`: low, medium, high, xhigh,
  // max), with no `ultra`, unlike CODEX_REASONING_EFFORT's six. "ultra" is rejected at boot rather
  // than handed to the Claude CLI, where it would be a spawn-time flag error on every call.
  it("rejects 'ultra' for CLAUDE_CLI_EFFORT even though it is valid for CODEX_REASONING_EFFORT", () => {
    expect(() =>
      readClaudeCliConfig({ CLAUDE_CLI_EFFORT: "ultra" })
    ).toThrow("CLAUDE_CLI_EFFORT");
    expect(() =>
      readReasoningConfig({ CODEX_REASONING_EFFORT: "ultra" })
    ).not.toThrow();
  });

  it("rejects a blank CLAUDE_CLI_MODEL", () => {
    expect(() => readClaudeCliConfig({ CLAUDE_CLI_MODEL: "   " })).toThrow(
      "CLAUDE_CLI_MODEL"
    );
  });
});

describe("readRouteTimeoutConfig", () => {
  it("returns the ADR 0007 budget defaults when unset", () => {
    expect(readRouteTimeoutConfig({})).toEqual({
      claudeRouteTimeoutMs: 750_000,
      codexRouteTimeoutMs: 300_000,
      // Per provider, because Claude's generation budget gives up sooner and leaves time for the
      // Codex fallback. Observed Claude Listening `generate` runs succeeded in 494.7s and 708s, and
      // Codex finished the same call in 280-321s. 750s sits above both Claude successes, so it
      // costs nothing on a run that would finish; Codex is the fallback, and 900s leaves it ample
      // headroom.
      claudeGenerationRouteTimeoutMs: 750_000,
      codexGenerationRouteTimeoutMs: 900_000,
    });
  });

  it("accepts explicit positive-integer overrides, independently per provider", () => {
    expect(
      readRouteTimeoutConfig({
        CLAUDE_ROUTE_TIMEOUT_MS: "111000",
        CODEX_ROUTE_TIMEOUT_MS: "222000",
        CLAUDE_GENERATION_ROUTE_TIMEOUT_MS: "333000",
        CODEX_GENERATION_ROUTE_TIMEOUT_MS: "444000",
      })
    ).toEqual({
      claudeRouteTimeoutMs: 111_000,
      codexRouteTimeoutMs: 222_000,
      claudeGenerationRouteTimeoutMs: 333_000,
      codexGenerationRouteTimeoutMs: 444_000,
    });
  });

  it.each([
    ["CLAUDE_ROUTE_TIMEOUT_MS", "0"],
    ["CLAUDE_ROUTE_TIMEOUT_MS", "-1000"],
    ["CLAUDE_ROUTE_TIMEOUT_MS", "1.5"],
    ["CLAUDE_ROUTE_TIMEOUT_MS", "not-a-number"],
    ["CODEX_ROUTE_TIMEOUT_MS", "0"],
    ["CLAUDE_GENERATION_ROUTE_TIMEOUT_MS", "0"],
    ["CODEX_GENERATION_ROUTE_TIMEOUT_MS", "0"],
  ])("rejects a non-positive-integer %s value", (variable, value) => {
    expect(() => readRouteTimeoutConfig({ [variable]: value })).toThrow(
      variable
    );
  });

  // The retired GENERATION_ROUTE_TIMEOUT_MS is not a fallback. Claude and Codex have different
  // generation defaults (750s vs 900s), and one shared value applied to both would silently
  // re-couple them for anyone who still has it set. .env.example documents the two replacements.
  it("ignores a leftover GENERATION_ROUTE_TIMEOUT_MS: neither generation timeout falls back to it", () => {
    expect(
      readRouteTimeoutConfig({ GENERATION_ROUTE_TIMEOUT_MS: "333000" })
    ).toEqual({
      claudeRouteTimeoutMs: 750_000,
      codexRouteTimeoutMs: 300_000,
      claudeGenerationRouteTimeoutMs: 750_000,
      codexGenerationRouteTimeoutMs: 900_000,
    });
  });

  // An operator who still sets GENERATION_ROUTE_TIMEOUT_MS would otherwise see their tuning stop
  // applying with no signal. A stale value gets a non-blocking console.warn at boot: not a fallback
  // (the case above proves the value is ignored) and not a hard error (a stale entry must not stop
  // boot).
  describe("the boot warning for a retired GENERATION_ROUTE_TIMEOUT_MS", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("warns once, naming both replacement vars and their effective values, when the retired var is set", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      readRouteTimeoutConfig({ GENERATION_ROUTE_TIMEOUT_MS: "333000" });

      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0]!;
      expect(message).toContain("GENERATION_ROUTE_TIMEOUT_MS");
      expect(message).toContain("retired");
      expect(message).toContain("no effect");
      expect(message).toContain("CLAUDE_GENERATION_ROUTE_TIMEOUT_MS");
      expect(message).toContain("CODEX_GENERATION_ROUTE_TIMEOUT_MS");
      // Effective values, not just the names, so the operator can see what they are getting.
      expect(message).toContain("750000");
      expect(message).toContain("900000");
    });

    it("reflects the CURRENT effective values in the warning when the replacements are also overridden", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      readRouteTimeoutConfig({
        GENERATION_ROUTE_TIMEOUT_MS: "333000",
        CLAUDE_GENERATION_ROUTE_TIMEOUT_MS: "111000",
        CODEX_GENERATION_ROUTE_TIMEOUT_MS: "222000",
      });

      expect(warn).toHaveBeenCalledTimes(1);
      const [message] = warn.mock.calls[0]!;
      expect(message).toContain("111000");
      expect(message).toContain("222000");
      expect(message).not.toContain("750000");
      expect(message).not.toContain("900000");
    });

    it("does not warn when the retired var is absent", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      readRouteTimeoutConfig({});
      readRouteTimeoutConfig({
        CLAUDE_GENERATION_ROUTE_TIMEOUT_MS: "111000",
        CODEX_GENERATION_ROUTE_TIMEOUT_MS: "222000",
      });

      expect(warn).not.toHaveBeenCalled();
    });

    it("does not warn when the retired var is blank", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      readRouteTimeoutConfig({ GENERATION_ROUTE_TIMEOUT_MS: "   " });

      expect(warn).not.toHaveBeenCalled();
    });

    it("yields the per-provider defaults (750s Claude / 900s Codex), not the retired value, while warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = readRouteTimeoutConfig({ GENERATION_ROUTE_TIMEOUT_MS: "333000" });

      expect(result.claudeGenerationRouteTimeoutMs).toBe(750_000);
      expect(result.codexGenerationRouteTimeoutMs).toBe(900_000);
      expect(warn).toHaveBeenCalledTimes(1);
    });
  });
});

// Under test, config.dataDir must never resolve to the repo's real bank. The server workspace's
// vitest setup points TOEFL_DATA_DIR at a private copy, but that config is loaded only when vitest's
// root is the server workspace. Run a server test file from the repo root (`npx vitest run
// server/test/generator.test.ts`) and vitest finds no config at all: no setupFiles, no globalSetup,
// no TOEFL_DATA_DIR, so config.dataDir falls back to <projectRoot>/data and every generator test
// would publish stub audio and generated Sets into the User's own practice bank.
//
// The guard therefore lives below the vitest config, in config.ts itself: a check shipped inside
// server/vitest.config.ts is dead code in exactly the invocation that bypasses that file.
// `VITEST`/`NODE_ENV` are set by vitest in every worker no matter which root it resolved.
describe("readDataDir", () => {
  const root = "/repo";
  const bank = path.join(root, "data");

  it("uses the repo's data/ directory outside the test environment, and honors TOEFL_DATA_DIR", () => {
    expect(readDataDir({}, root)).toBe(bank);
    expect(readDataDir({ TOEFL_DATA_DIR: "/scratch/bank" }, root)).toBe("/scratch/bank");
  });

  it("refuses to resolve inside the repo's question bank when running under vitest", () => {
    expect(() => readDataDir({ VITEST: "true" }, root)).toThrow("TOEFL_DATA_DIR");
    expect(() => readDataDir({ NODE_ENV: "test" }, root)).toThrow(bank);
    // An explicit pin at the bank is the same hazard as no pin at all, as is any subdirectory of
    // it: a stray fixture under data/question-sets/ lands in the live bank.
    expect(() => readDataDir({ VITEST: "true", TOEFL_DATA_DIR: bank }, root)).toThrow();
    expect(() => readDataDir({ VITEST: "true", TOEFL_DATA_DIR: path.join(bank, "question-sets") }, root))
      .toThrow();
    // ...and the error has to name the way out, since it fires before any test body runs.
    expect(() => readDataDir({ VITEST: "true" }, root)).toThrow(/npm test -w server/);
  });

  it("accepts a scratch directory under the repo root that is not the bank", () => {
    // A scratch directory inside the checkout is fine; only data/ itself is off limits. The separator
    // check also has to keep a sibling-prefix path like data-scratch/ from reading as the bank.
    expect(readDataDir({ VITEST: "true", TOEFL_DATA_DIR: path.join(root, "server/.test-data") }, root))
      .toBe(path.join(root, "server/.test-data"));
    expect(readDataDir({ VITEST: "true", TOEFL_DATA_DIR: path.join(root, "data-scratch") }, root))
      .toBe(path.join(root, "data-scratch"));
  });

  it("has kept THIS suite run off the real bank", () => {
    // The live assertion behind the unit tests above: whatever invocation is running right now,
    // config.dataDir is not the repo bank. Fails the suite if the redirect is ever lost.
    expect(config.dataDir).not.toBe(path.join(projectRoot, "data"));
    expect(config.dataDir.startsWith(path.join(projectRoot, "data") + path.sep)).toBe(false);
  });
});
