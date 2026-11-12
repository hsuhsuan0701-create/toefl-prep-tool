import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pins the environment every worker sees (data dir, providers, CLI binaries, fetch) before any
    // test module imports config.ts; see test/setup-env.ts.
    setupFiles: ["./test/setup-env.ts"],
    // Creates and seeds this run's own data directory before any worker starts, and removes it
    // afterwards; see test/global-setup.ts.
    globalSetup: ["./test/global-setup.ts"],
  },
});
