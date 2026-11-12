import { afterAll, afterEach, expect } from "vitest";

/**
 * Replaces the global fetch with one that refuses every request.
 *
 * No server test reaches the network. Every provider call goes through fetch, and the code under
 * test takes an injected fetch wherever it makes one; the global is the fallback a forgotten
 * injection lands on. The refusal rejects the call, and because the code under test may catch that
 * rejection and classify it as a retryable network failure, it is also recorded and fails the test
 * from afterEach, so it cannot be swallowed into a passing assertion.
 *
 * A test that stubs fetch itself (`vi.stubGlobal("fetch", ...)`) is unaffected, and
 * `vi.unstubAllGlobals()` puts this tripwire back rather than the real fetch.
 */
const blocked: string[] = [];

function describeRequest(input: Parameters<typeof fetch>[0]): string {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  // Origin and path only: a provider URL can carry its key in the query string.
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<unparseable URL>";
  }
}

function failOnBlockedFetches(): void {
  if (blocked.length > 0) throw new Error(blocked.splice(0).join("\n"));
}

export function installFetchTripwire(): void {
  globalThis.fetch = async (input) => {
    const testName = expect.getState().currentTestName ?? "<outside any test>";
    const message =
      `Unmocked fetch(${describeRequest(input)}) in "${testName}". The server suite never reaches ` +
      `the network: inject a fake fetch into the code under test, or vi.stubGlobal("fetch", ...).`;
    blocked.push(message);
    throw new Error(message);
  };
  afterEach(failOnBlockedFetches);
  afterAll(failOnBlockedFetches);
}

/** Returns and clears the refusals recorded so far: for a test of the tripwire itself. */
export function takeBlockedFetches(): string[] {
  return blocked.splice(0);
}
