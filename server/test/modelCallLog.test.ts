import { afterEach, describe, expect, it } from "vitest";
import type { ModelCallInsert } from "../src/db/rows.js";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { readModelCallRetentionDays } from "../src/lib/config.js";
import {
  createRepoModelCallSink,
  getModelCallRecorderLossSnapshot,
  flushModelCallRecorder,
  recordHttpModelCall,
  recordModelCall,
  resetModelCallSink,
  resetModelCallRecorderLossSnapshot,
  setModelCallSink,
  withModelCallContext,
  withModelCallDetail,
  withModelCallRoute,
} from "../src/services/modelCallLog.js";

function captureSink(): { calls: ModelCallInsert[]; install: () => void } {
  const calls: ModelCallInsert[] = [];
  return { calls, install: () => setModelCallSink((c) => calls.push(c)) };
}

afterEach(() => { resetModelCallSink(); resetModelCallRecorderLossSnapshot(); });

describe("modelCallLog", () => {
  it("attaches the ambient correlation, and the nested detail, to a call made deep inside it", async () => {
    const sink = captureSink();
    sink.install();

    await withModelCallContext({ kind: "generation-job", id: "job-7" }, async () =>
      withModelCallDetail({ stage: "generating", generationAttempt: 3 }, async () => {
        // An await between the context and the record proves the correlation survives the
        // asynchronous hop — the whole reason this is AsyncLocalStorage rather than a module global,
        // which a second concurrent job would corrupt.
        await Promise.resolve();
        recordModelCall({
          provider: "claude",
          route: "skill-task",
          task: "generate:speaking",
          prompt: "GENERATE speaking",
          outcome: "failed",
          failureKind: "invalid-output",
        });
      }));

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0]).toMatchObject({
      provider: "claude",
      route: "skill-task",
      contextKind: "generation-job",
      contextId: "job-7",
      outcome: "failed",
      attemptIndex: 0,
    });
    expect(JSON.parse(sink.calls[0].contextDetail!)).toEqual({ stage: "generating", generationAttempt: 3 });
  });

  it("records a call made outside any job, with no correlation rather than no row", () => {
    const sink = captureSink();
    sink.install();
    withModelCallDetail({ ignored: true }, () =>
      recordModelCall({ provider: "codex", route: "skill-task", prompt: "p", outcome: "succeeded" }));

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].contextKind).toBeUndefined();
    // Detail without an id has nothing to hang off, so it is dropped rather than written orphaned.
    expect(sink.calls[0].contextDetail).toBeUndefined();
  });

  it("swallows a sink that throws — an observability write must never fail the call it observes", () => {
    setModelCallSink(() => {
      throw new Error("disk full");
    });
    expect(() =>
      recordModelCall({ provider: "claude", route: "skill-task", prompt: "p", outcome: "succeeded" })
    ).not.toThrow();
  });

  it("keeps an unserializable detail bag from costing the row", () => {
    const sink = captureSink();
    sink.install();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    withModelCallContext({ kind: "scoring-job", id: "score-1" }, () =>
      withModelCallDetail(cyclic, () =>
        recordModelCall({ provider: "gemini-http", route: "gemini-essay-judge", prompt: "p", outcome: "succeeded" })));

    expect(sink.calls).toHaveLength(1);
    expect(sink.calls[0].contextId).toBe("score-1");
    expect(sink.calls[0].contextDetail).toBeUndefined();
  });

  it("recordHttpModelCall stores the request and response bodies verbatim", () => {
    const sink = captureSink();
    sink.install();
    recordHttpModelCall({
      provider: "gemini-http",
      route: "gemini-essay-judge",
      model: "gemini-3-pro",
      requestBody: '{"contents":[{"parts":[{"text":"judge"}]}]}',
      responseBody: '{"candidates":[]}',
      ok: true,
      durationMs: 900,
    });

    expect(sink.calls[0]).toMatchObject({
      provider: "gemini-http",
      route: "gemini-essay-judge",
      model: "gemini-3-pro",
      prompt: '{"contents":[{"parts":[{"text":"judge"}]}]}',
      response: '{"candidates":[]}',
      outcome: "succeeded",
      durationMs: 900,
    });
  });

  it("rounds timings to whole milliseconds, which is what the columns are declared as", () => {
    const sink = captureSink();
    sink.install();
    // What performance.now() actually hands the router. SQLite would store this verbatim, because
    // INTEGER affinity declines a lossy REAL conversion — leaving a float in an INTEGER column.
    recordModelCall({
      provider: "claude",
      route: "skill-task",
      prompt: "p",
      outcome: "succeeded",
      queueMs: 0.4,
      durationMs: 140_281.65075,
    });

    expect(sink.calls[0]).toMatchObject({ queueMs: 0, durationMs: 140_282 });
  });

  it("the production sink writes the normalized diagnostic tables", async () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    setModelCallSink(createRepoModelCallSink(r));
    await withModelCallContext({ kind: "generation-job", id: "g1" }, async () => {
      recordModelCall({ provider: "claude", route: "skill-task", task: "generate:writing", prompt: "p", response: "r", outcome: "succeeded" });
      await Promise.resolve(); // production recorder drains asynchronously
    });
    expect(db.prepare("SELECT count(*) AS n FROM route_invocations").get()).toEqual({ n: 1 });
    expect(r.listModelCallsByContext({ kind: "generation-job", id: "g1" })[0]).toMatchObject({ provider: "claude", prompt: "p", response: "r" });
  });

  it("exposes a process-level flush seam for graceful shutdown", async () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    setModelCallSink(createRepoModelCallSink(r));
    recordModelCall({ provider: "claude", route: "skill-task", prompt: "pending", outcome: "succeeded" });
    expect(await flushModelCallRecorder(100)).toBe(true);
    expect(db.prepare("SELECT count(*) AS n FROM route_invocations").get()).toEqual({ n: 1 });
  });

  it("correlates fallback legs to one logical route and each leg's attempt to that execution", async () => {
    const db=openDb(":memory:"); const r=sqliteStores(db); setModelCallSink(createRepoModelCallSink(r));
    let clock=10;
    await withModelCallContext({kind:"scoring-job",id:"job-1"},()=>withModelCallRoute({operation:"aggregate",family:"scoring",queuedAtMs:clock,now:()=>++clock},async()=>{
      recordModelCall({provider:"claude",route:"skill-task",prompt:"first",outcome:"failed",failureKind:"rate-limit"});
      recordModelCall({provider:"codex",route:"skill-task",prompt:"fallback",response:"ok",outcome:"succeeded"});
      return {ok:true};
    }));
    await Promise.resolve();
    const route=db.prepare("SELECT id,outcome FROM route_invocations").get() as {id:string;outcome:string};
    expect(route.outcome).toBe("success");
    const legs=r.listProviderExecutions(route.id);
    expect(legs.map(x=>[x.provider,x.sequence])).toEqual([["claude",1],["codex",2]]);
    expect(r.listModelAttempts(legs[0].id).map(x=>x.prompt)).toEqual(["first"]);
    expect(r.listModelAttempts(legs[1].id).map(x=>x.prompt)).toEqual(["fallback"]);
  });

  it.each([
    [{ok:false,attempts:[{kind:"rate-limit"}]},"failure","rate-limit",null],
    [{ok:false,cancelled:true,reason:"shutdown",attempts:[]},"cancelled",null,"shutdown"],
  ] as const)("finishes a logical route for failure/cancellation",async(result,outcome,failureKind,cancellationReason)=>{
    const db=openDb(":memory:");const r=sqliteStores(db);setModelCallSink(createRepoModelCallSink(r));let clock=1;
    await withModelCallRoute({operation:"aggregate",family:"scoring",queuedAtMs:clock,now:()=>++clock},async()=>result);
    await Promise.resolve();
    expect(db.prepare("SELECT outcome,failure_kind,cancellation_reason FROM route_invocations").get()).toEqual({outcome,failure_kind:failureKind,cancellation_reason:cancellationReason});
  });

  it("exports cumulative recorder loss counters for provider status telemetry", async () => {
    resetModelCallRecorderLossSnapshot();
    const fakeRepo={insertRouteInvocation:()=>{throw new Error("disk full")},finishRouteInvocation:()=>false,insertProviderExecution:()=>{},insertModelAttempt:()=>{}} as any;
    setModelCallSink(createRepoModelCallSink(fakeRepo));
    recordModelCall({provider:"claude",route:"skill-task",prompt:"p",outcome:"succeeded"});
    await Promise.resolve();
    expect(getModelCallRecorderLossSnapshot()).toEqual({overflow:0,database:1,total:1});
  });

  it("reads MODEL_CALL_RETENTION_DAYS, defaulting to 30 and rejecting nonsense outright", () => {
    expect(readModelCallRetentionDays({})).toBe(30);
    expect(readModelCallRetentionDays({ MODEL_CALL_RETENTION_DAYS: "" })).toBe(30);
    expect(readModelCallRetentionDays({ MODEL_CALL_RETENTION_DAYS: "7" })).toBe(7);
    expect(readModelCallRetentionDays({ MODEL_CALL_RETENTION_DAYS: "0" })).toBe(0);
    for (const bad of ["-1", "1.5", "forever"]) {
      expect(() => readModelCallRetentionDays({ MODEL_CALL_RETENTION_DAYS: bad })).toThrow(/non-negative integer/);
    }
  });
});
