import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/lib/config.js";
import { takeBlockedFetches } from "./helpers/fetchTripwire.js";
import { INHERITED, isScrubbed, PINNED } from "./helpers/hermeticEnv.js";

// The suite's isolation from the launching shell (helpers/hermeticEnv.ts) is only as good as its
// coverage of the names the server actually reads, so that coverage is checked against the source
// rather than against a list someone has to remember to update.

const SOURCE_ROOT = path.join(config.projectRoot, "server/src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

// Every way server/src names an environment variable: a direct `process.env` read, a property read
// off an `env` record, and a name passed to one of config.ts's `readX(env, "NAME", ...)` helpers.
const LITERAL_READS = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  /process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g,
  /\benv\.([A-Z][A-Z0-9_]*)/g,
  /\(\s*env\s*,\s*["']([A-Z][A-Z0-9_]*)["']/g,
];
// config.ts builds the per-provider admission names from a template (`${provider}_REASONING_...`)
// inside readProviderAdmissionConfig, so those names are expanded over the provider tokens that
// function is actually called with.
const PROVIDER_TEMPLATE = /`\$\{provider\}(_[A-Z0-9_]+)`/g;
const PROVIDER_ARGUMENT = /readProviderAdmissionConfig\(\s*env\s*,\s*["']([A-Z][A-Z0-9_]*)["']\s*\)/g;

function namesReadBy(text: string, providers: ReadonlySet<string>): string[] {
  const literal = LITERAL_READS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1]!));
  const templated = [...text.matchAll(PROVIDER_TEMPLATE)].flatMap((match) =>
    [...providers].map((provider) => `${provider}${match[1]}`),
  );
  // A provider token passed to readProviderAdmissionConfig is not itself a variable name.
  return [...literal.filter((name) => !providers.has(name)), ...templated];
}

describe("the server suite's environment", () => {
  const files = sourceFiles(SOURCE_ROOT).map((file) => ({
    file: path.relative(config.projectRoot, file),
    text: fs.readFileSync(file, "utf8"),
  }));
  const providers = new Set(
    files.flatMap(({ text }) => [...text.matchAll(PROVIDER_ARGUMENT)].map((match) => match[1]!)),
  );
  const read = new Map<string, string>();
  for (const { file, text } of files) {
    for (const name of namesReadBy(text, providers)) read.set(name, file);
  }

  it("finds the settings it is meant to cover", () => {
    // A scanner that silently matched nothing would pass the check below vacuously.
    for (const name of ["OPENAI_API_KEY", "GEMINI_API_KEY", "CLAUDE_BIN", "CODEX_BIN", "OPENAI_TTS_MODEL",
      "CLAUDE_REASONING_CAPACITY_CEILING", "CODEX_GENERATION_ROUTE_TIMEOUT_MS", "TTS_CONCURRENCY"]) {
      expect(read.has(name), name).toBe(true);
    }
  });

  it("scrubs or pins every environment variable server/src reads", () => {
    const uncovered = [...read]
      .filter(([name]) => !isScrubbed(name) && !(name in PINNED) && !(INHERITED as readonly string[]).includes(name))
      .map(([name, file]) => `${name} (read in ${file})`);
    expect(uncovered, "add a prefix or name to helpers/hermeticEnv.ts").toEqual([]);
  });

  it("holds no provider credential and no ambient setting inside a test", () => {
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.GEMINI_API_KEY).toBeUndefined();
    expect(config.openaiKey).toBeUndefined();
    expect(config.geminiKey).toBeUndefined();
    for (const name of Object.keys(process.env)) {
      if (isScrubbed(name)) expect([...Object.keys(PINNED), "TOEFL_DATA_DIR"], name).toContain(name);
    }
  });

  it("points the CLI routes at binaries that do not exist", () => {
    expect(config.claudeBin).toBe(PINNED.CLAUDE_BIN);
    expect(config.codexBin).toBe(PINNED.CODEX_BIN);
    expect(fs.existsSync(config.claudeBin)).toBe(false);
    expect(fs.existsSync(config.codexBin)).toBe(false);
  });

  it("refuses an unmocked fetch, naming the test that made it and never the query string", async () => {
    await expect(fetch("https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=secret"))
      .rejects.toThrow(/^Unmocked fetch\(https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/x:generateContent\) in ".*refuses an unmocked fetch/);
    // The refusal is also queued to fail this test from afterEach, even had the rejection been
    // caught; draining it here is what lets this one test pass.
    const refused = takeBlockedFetches();
    expect(refused).toHaveLength(1);
    expect(refused[0]).not.toContain("secret");
  });
});
