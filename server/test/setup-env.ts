import path from "node:path";
import { inject } from "vitest";
import { installFetchTripwire } from "./helpers/fetchTripwire.js";
import { applyHermeticEnv } from "./helpers/hermeticEnv.js";
import { privateDataDir } from "./helpers/privateDataDir.js";

// Runs in every worker before each test file is imported, which is what makes it the one place to
// fix the environment: config.ts reads process.env once, at module evaluation, and nothing here may
// import it (or anything that does) first.

// Every server setting is scrubbed back to its default or pinned to a test value, so no ambient
// variable, real API keys included, reaches the code under test. See helpers/hermeticEnv.ts.
applyHermeticEnv(process.env);

// This test file's own data directory: a fresh copy of the bank global-setup.ts seeded, so nothing
// another test file writes into its bank can reach this one (see helpers/privateDataDir.ts). Both
// paths are checked rather than used blind: process.env would store a missing value as the string
// "undefined", a relative path config.ts would resolve against the cwd and happily write into.
const testRunDir: unknown = inject("testRunDir");
const testDataTemplate: unknown = inject("testDataTemplate");
const testTmpDir: unknown = inject("testTmpDir");
if (
  typeof testRunDir !== "string" || !path.isAbsolute(testRunDir)
  || typeof testDataTemplate !== "string" || !path.isAbsolute(testDataTemplate)
  || typeof testTmpDir !== "string" || !path.isAbsolute(testTmpDir)
) {
  throw new Error(
    "server/test/global-setup.ts did not provide this run's data directory. Run the server suite " +
      "through its own vitest config: `npm test -w server`, `npm test`, or `npx vitest run` from server/."
  );
}
process.env.TOEFL_DATA_DIR = privateDataDir(testDataTemplate, testRunDir);

// os.tmpdir() reads these on every call, so every temporary directory a test or the code under test
// makes (and every child process it spawns) lands inside this run's directory, which global-setup.ts
// removes when the run ends.
process.env.TMPDIR = testTmpDir;
process.env.TMP = testTmpDir;
process.env.TEMP = testTmpDir;

// A fetch nobody mocked fails the test that made it. See helpers/fetchTripwire.ts.
installFetchTripwire();
