import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { buildGenerateRoutes } from "../src/routes/generate.js";
import { resetJobAdmissionsForTests, setJobAdmissionReadiness } from "../src/services/jobCancellation.js";

afterEach(() => resetJobAdmissionsForTests());

describe("generation cancellation API", () => {
  it("returns 503 for new paid work while the execution lease is not ready", async () => {
    const r = sqliteStores(openDb(":memory:"));
    setJobAdmissionReadiness(() => false);
    const app = new Hono().route("/", buildGenerateRoutes({ repo: r, runSkillTask: vi.fn() }));
    const response = await app.request("/", { method: "POST", body: JSON.stringify({ kind: "writing" }), headers: { "content-type": "application/json" } });
    expect(response.status).toBe(503);
    expect(r.listInterruptedGenerationJobs()).toEqual([]);
  });

  it("supports standalone job cancellation with idempotent 200 and terminal 409 semantics", async () => {
    const r = sqliteStores(openDb(":memory:"));
    const app = new Hono().route("/", buildGenerateRoutes({ repo: r, runSkillTask: vi.fn() }));
    r.createGenerationJob({ id: "standalone", kind: "writing" });

    const accepted = await app.request("/standalone/cancel", { method: "POST" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      jobId: "standalone", status: "queued", cancellationReason: "user",
      cancellationRequestedAt: expect.any(String),
    });
    expect((await app.request("/standalone/cancel", { method: "POST" })).status).toBe(200);

    r.finishGenerationJobCancellation({ id: "standalone", now: "2026-08-13 00:00:00" });
    expect((await app.request("/standalone/cancel", { method: "POST" })).status).toBe(200);

    r.createGenerationJob({ id: "done", kind: "writing" });
    r.updateGenerationJob({ id: "done", status: "done" });
    expect((await app.request("/done/cancel", { method: "POST" })).status).toBe(409);
  });

  it("returns the current batch state and treats a repeated active cancellation as idempotent", async () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createGenerationBatch({ id: "batch", total: 2 });
    r.updateGenerationBatch({ id: "batch", status: "running" });
    r.createGenerationJob({ id: "active", kind: "writing", batchId: "batch", batchIndex: 0 });
    r.updateGenerationJob({ id: "active", status: "running" });
    r.createGenerationJob({ id: "queued", kind: "writing", batchId: "batch", batchIndex: 1 });
    const app = new Hono().route("/", buildGenerateRoutes({ repo: r, runSkillTask: vi.fn() }));

    const first = await app.request("/batch/cancel", { method: "POST" });
    expect(first.status).toBe(200);
    const body = await first.json() as Record<string, unknown>;
    expect(body).toMatchObject({
      jobId: "batch",
      cancelRequested: true,
      cancellationReason: "user",
      activeCount: 1,
      queued: 1,
      activeChildIds: ["active"],
    });
    expect(body.cancellationRequestedAt).toEqual(expect.any(String));

    const repeated = await app.request("/batch/cancel", { method: "POST" });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ jobId: "batch", cancelRequested: true });
  });
});
