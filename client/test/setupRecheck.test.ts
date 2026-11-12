import { afterEach, describe, expect, it, vi } from "vitest";
import { recheckSetupStatus } from "../src/lib/api";

// "Check again" asks the server to re-run its setup checks and reports what they found.

const STATUS = { claudeCli: "ready", codexCli: "ready", capabilities: {}, missing: [] };

function stub(responses: Record<string, Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const key = `${init?.method ?? "GET"} ${String(input)}`;
      calls.push(key);
      const res = responses[key];
      if (!res) throw new Error(`unexpected ${key}`);
      return res;
    }),
  );
  return calls;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("recheckSetupStatus", () => {
  it("POSTs the recheck and answers what it found", async () => {
    const calls = stub({ "POST /api/setup-status/recheck": json({ ...STATUS, rubrics: { source: "official" } }) });
    expect(await recheckSetupStatus()).toMatchObject({ rubrics: { source: "official" } });
    expect(calls).toEqual(["POST /api/setup-status/recheck"]);
  });

  it("surfaces a failed recheck", async () => {
    stub({ "POST /api/setup-status/recheck": new Response("boom", { status: 500 }) });
    await expect(recheckSetupStatus()).rejects.toMatchObject({ status: 500 });
  });
});
