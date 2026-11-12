import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, expect } from "vitest";

afterEach(() => cleanup());

// jsdom lays nothing out, so it cannot scroll, and it reports "Not implemented" on every call. A
// Drill or Simulation scrolls each new stage to the top (hooks/useStageEntry.ts); a test that cares
// spies on this.
window.scrollTo = () => {};

// No client test talks to a server. Every page reaches the API through src/lib/api.ts, which calls
// the global fetch, and a test that has not stubbed it (vi.stubGlobal("fetch", ...) or a vi.mock of
// the api module) lands here. The call is refused, and because the code under test usually catches
// a failed request and renders an error state, the refusal is also recorded and fails the test from
// afterEach: otherwise a test could pass by asserting on an error screen it never meant to reach.
// vi.unstubAllGlobals() restores this tripwire, not the real fetch.
const blockedFetches: string[] = [];

globalThis.fetch = async (input) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const testName = expect.getState().currentTestName ?? "<outside any test>";
  const message =
    `Unmocked fetch(${new URL(raw, "http://localhost").pathname}) in "${testName}". Stub it with ` +
    `vi.stubGlobal("fetch", ...) or mock src/lib/api.`;
  blockedFetches.push(message);
  throw new Error(message);
};

function failOnBlockedFetches(): void {
  if (blockedFetches.length > 0) throw new Error(blockedFetches.splice(0).join("\n"));
}

afterEach(failOnBlockedFetches);
afterAll(failOnBlockedFetches);
