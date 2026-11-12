import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { ModelCallRecorder } from "../src/services/modelCallRecorder.js";

describe("ModelCallRecorder", () => {
  afterEach(() => vi.restoreAllMocks());

  it("persists correlated lifecycle records in executor sequence order", async () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    const recorder = new ModelCallRecorder(r, { capacity: 8 });

    recorder.route({ id: "r1", operation: "arbitrate", family: "scoring", contextKind: "scoring-job", contextId: "j1", queuedAtMs: 10, finishedAtMs: 90, outcome: "success" });
    recorder.execution({ id: "e2", routeInvocationId: "r1", sequence: 2, provider: "codex", family: "scoring", operation: "arbitrate", queuedAtMs: 20, dequeuedAtMs: 30, startedAtMs: 31, finishedAtMs: 80, outcome: "success" });
    recorder.attempt({ id: "a2", providerExecutionId: "e2", sequence: 2, kind: "repair", prompt: "repair", response: "ok", startedAtMs: 50, finishedAtMs: 75, outcome: "success" });
    recorder.attempt({ id: "a1", providerExecutionId: "e2", sequence: 1, kind: "initial", prompt: "first", response: "bad", startedAtMs: 31, finishedAtMs: 49, outcome: "failure", failureKind: "invalid-output" });

    expect(await recorder.flush(100)).toBe(true);
    expect(r.listModelAttempts("e2").map((x) => [x.id, x.sequence])).toEqual([["a1", 1], ["a2", 2]]);
    expect(r.getRouteInvocation("r1")?.outcome).toBe("success");
  });

  it("redacts secrets and truncates UTF-8 bodies to one MiB while reporting omitted bytes", async () => {
    const r = sqliteStores(openDb(":memory:"));
    const recorder = new ModelCallRecorder(r, { capacity: 3 });
    const huge = `begin sk-test-secret ${"界".repeat(400_000)} end`;
    recorder.route({ id: "r", operation: "generate", family: "generation", queuedAtMs: 1, finishedAtMs: 3, outcome: "success" });
    recorder.execution({ id: "e", routeInvocationId: "r", sequence: 1, provider: "claude", family: "generation", operation: "generate", queuedAtMs: 1, startedAtMs: 1, finishedAtMs: 3, outcome: "success" });
    recorder.attempt({ id: "a", providerExecutionId: "e", sequence: 1, kind: "initial", prompt: huge, response: "Authorization: Bearer token-value", startedAtMs: 1, finishedAtMs: 3, outcome: "success" });
    await recorder.flush(100);

    const row = r.listModelAttempts("e")[0];
    expect(row.prompt).not.toContain("sk-test-secret");
    expect(Buffer.byteLength(row.prompt!, "utf8")).toBeLessThanOrEqual(1_048_576);
    expect(row.prompt_omitted_bytes).toBeGreaterThan(0);
    expect(row.response).toBe("Authorization: Bearer [REDACTED]");
  });

  it("redacts quoted JSON credentials while preserving valid JSON syntax", async () => {
    const r=sqliteStores(openDb(":memory:"));const recorder=new ModelCallRecorder(r,{capacity:3});
    recorder.route({id:"rj",operation:"judge",family:"scoring",queuedAtMs:1,finishedAtMs:9,outcome:"success"});
    recorder.execution({id:"ej",routeInvocationId:"rj",sequence:1,provider:"openai-http",family:"scoring",operation:"judge",queuedAtMs:1,startedAtMs:2,finishedAtMs:9,outcome:"success"});
    recorder.attempt({id:"aj",providerExecutionId:"ej",sequence:1,kind:"initial",prompt:'{"apiKey":"secret-value","authorization":"Bearer live-token","safe":"keep"}',startedAtMs:2,finishedAtMs:9,outcome:"success"});
    await recorder.flush(100);
    expect(JSON.parse(r.listModelAttempts("ej")[0].prompt!)).toEqual({apiKey:"[REDACTED]",authorization:"Bearer [REDACTED]",safe:"keep"});
  });

  it("reports queue overflow and database failures without throwing into the model path", async () => {
    const losses: Array<{ kind: string; correlationId: string }> = [];
    const deferred: Array<() => void> = [];
    const badRepo = { insertRouteInvocation: () => { throw new Error("disk full"); } } as any;
    const recorder = new ModelCallRecorder(badRepo, {
      capacity: 1,
      schedule: (fn) => deferred.push(fn),
      onLoss: (loss) => losses.push(loss),
    });
    const event = { operation: "x", family: "scoring", queuedAtMs: 1, finishedAtMs: 2, outcome: "success" } as const;
    expect(() => recorder.route({ id: "one", ...event })).not.toThrow();
    expect(() => recorder.route({ id: "two", ...event })).not.toThrow();
    deferred.splice(0).forEach((fn) => fn());
    await recorder.flush(100);
    expect(losses).toEqual([
      expect.objectContaining({ kind: "overflow", correlationId: "two" }),
      expect.objectContaining({ kind: "database", correlationId: "one" }),
    ]);
  });
});
