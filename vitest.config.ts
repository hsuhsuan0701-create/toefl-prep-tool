import { defineConfig } from "vitest/config";

// Exists only so that running vitest FROM THE REPO ROOT resolves each workspace's own config
// instead of no config at all. Without this file, `npx vitest run server/test/generator.test.ts`
// — the natural way to run one file while working at the root — started vitest with default
// settings: no setupFiles, no globalSetup, and, fatally, no TOEFL_DATA_DIR, so config.dataDir fell
// back to the repo's real data/ and the generator tests published fixtures into the User's live
// question bank (issue #104).
//
// config.ts's readDataDir now REFUSES that resolution outright, so the leak is closed whether or
// not this file exists; this makes the root invocation work rather than merely fail loudly.
// `npm test` still runs `npm test -w server && npm test -w client` — each workspace's config is
// the single source of truth for how its own suite runs, and this file only points at them.
export default defineConfig({
  test: {
    projects: ["server", "client"],
  },
});
