import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { validSpeakingSet, validWritingSet } from "./helpers/setFixtures.js";
import { skillSuccess } from "./helpers/skillResults.js";
import { buildGenerateRoutes } from "../src/routes/generate.js";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { config } from "../src/lib/config.js";
import { failInterruptedGenerationJobs } from "../src/services/generationJobs.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import {
  speakingPlanFixture,
  writingPlanFixture,
} from "./helpers/generationDiversityFixtures.js";

const SANITIZED_ROUTE_FAILURE = {
  ok: false as const,
  error: "Structured reasoning unavailable: Claude (quota) → Codex (timeout).",
  attempts: [
    { provider: "claude" as const, kind: "quota" as const },
    { provider: "codex" as const, kind: "timeout" as const },
  ],
};

function emitRunning(request: SkillTaskRequest<unknown>): void {
  request.onEvent?.({ state: "running", provider: "claude" });
}

// One generate and one verify answer for one Writing Set. Each batch test below queues one pair
// per Writing child onto the shared runSkillTask mock.
function writingSkillCalls() {
  return [
    async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      return skillSuccess(validWritingSet());
    },
    async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      return skillSuccess({
        items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok" })),
      });
    },
  ];
}

function routePlanner() {
  return {
    reserve: vi.fn(async (input: {
      kind: "speaking" | "writing" | "reading" | "listening";
      ownerId: string;
      onProgress?: (progress: {
        stage: "planning";
        detail: {
          provider: "claude";
          planningAttempt: 1;
          maxDiversityAttempts: 3;
        };
      }) => void;
    }) => {
      input.onProgress?.({
        stage: "planning",
        detail: {
          provider: "claude",
          planningAttempt: 1,
          maxDiversityAttempts: 3,
        },
      });
      return {
        reservationId: `reservation-${input.ownerId}`,
        ownerId: input.ownerId,
        plan: input.kind === "speaking"
          ? speakingPlanFixture()
          : writingPlanFixture(),
      };
    }),
    validateCandidate: vi.fn().mockReturnValue([]),
    release: vi.fn(),
  };
}

function buildTestApp() {
  const testRepo = sqliteStores(openDb(":memory:"));
  const runSkillTask = vi.fn();
  const tts = vi.fn(async (_request: unknown, outPath: string) => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, "stub-audio");
  });
  // A Speaking child runs the full pipeline, which ends in two paid scene calls, stubbed like tts so
  // the suite never reaches the image and vision APIs.
  const sceneImage = vi.fn().mockResolvedValue({ file: "images/scenarios/stub.webp", prompt: "p", model: "gpt-image-2" });
  const focusRegions = vi.fn().mockResolvedValue(Array.from({ length: 7 }, () => null));
  const probeDuration = vi.fn(async (filePath: string) => filePath.includes("iq") || filePath.includes("int-intro") ? 0.4 : 0.35);
  const planner = routePlanner();
  const app = buildGenerateRoutes({
    repo: testRepo,
    batchConcurrency: 1,
    runSkillTask,
    tts,
    probeDuration,
    sceneImage,
    focusRegions,
    planner,
  });
  return {
    app,
    repo: testRepo,
    runSkillTask,
    tts,
    sceneImage,
    focusRegions,
    planner,
  };
}

// Polls GET /:jobId until the job is done or failed, at a short fixed interval: everything here is
// in memory, so no backoff is needed.
async function pollUntilTerminal(app: ReturnType<typeof buildGenerateRoutes>, jobId: string, maxTicks = 50): Promise<Record<string, unknown>> {
  for (let i = 0; i < maxTicks; i++) {
    const res = await app.request(`/${jobId}`);
    const body = (await res.json()) as Record<string, unknown>;
    if (body.status === "done" || body.status === "failed") return body;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job never reached a terminal status");
}

// The same, for a batch's terminal statuses.
async function pollBatchUntilTerminal(app: ReturnType<typeof buildGenerateRoutes>, batchId: string, maxTicks = 200): Promise<Record<string, unknown>> {
  const TERMINAL = new Set(["done", "partial", "failed", "cancelled"]);
  for (let i = 0; i < maxTicks; i++) {
    const res = await app.request(`/${batchId}`);
    const body = (await res.json()) as Record<string, unknown>;
    if (TERMINAL.has(body.status as string)) return body;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("batch never reached a terminal status");
}

describe("generate routes", () => {
  it("rejects malformed JSON in POST /", async () => {
    const { app } = buildTestApp();
    const res = await app.request("/", {
      method: "POST",
      body: "not json at all",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid JSON" });
  });

  it("rejects a kind outside speaking|writing|reading|listening", async () => {
    const { app } = buildTestApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "french" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad kind" });
  });

  // The route checks the kind against its enum and nothing more, so queuing the row is all it owns;
  // the Reading pipeline itself is generator.reading.test.ts's.
  it("accepts kind:\"reading\" and queues a generation job", async () => {
    const { app, repo: testRepo } = buildTestApp();
    const res = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "reading" }),
    });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    const job = testRepo.getGenerationJob(jobId);
    expect(job?.kind).toBe("reading");
  });

  it("returns 404 for an unknown job id", async () => {
    const { app } = buildTestApp();
    const res = await app.request("/unknown-job-id-12345");
    expect(res.status).toBe(404);
  });

  // The listing the Dashboard re-attaches to on mount: only active work, each batch whole (children
  // reached through their parent, never listed alone), createdAt as an ISO instant though the column
  // holds the space form.
  it("GET / lists active batches and standalone jobs with ISO createdAt, excluding terminal jobs and batch children", async () => {
    const { app, repo: testRepo } = buildTestApp();
    testRepo.createGenerationJob({ id: "job-active", kind: "writing" });
    testRepo.createGenerationJob({ id: "job-done", kind: "reading" });
    testRepo.updateGenerationJob({ id: "job-done", status: "done" });
    testRepo.createGenerationBatch({ id: "batch-1", total: 2 });
    testRepo.createGenerationJob({ id: "child-1", kind: "writing", batchId: "batch-1", batchIndex: 0 });
    testRepo.createGenerationJob({ id: "child-2", kind: "speaking", batchId: "batch-1", batchIndex: 1 });

    const res = await app.request("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: Array<Record<string, unknown>> };
    const ids = body.active.map((entry) => entry.jobId);
    expect(ids).toContain("batch-1");
    expect(ids).toContain("job-active");
    expect(ids).not.toContain("job-done");
    expect(ids).not.toContain("child-1");
    expect(ids).not.toContain("child-2");

    const batchEntry = body.active.find((entry) => entry.jobId === "batch-1") as Record<string, unknown>;
    expect(batchEntry.kind).toBe("batch");
    expect(batchEntry.total).toBe(2);
    expect((batchEntry.children as unknown[]).length).toBe(2);
    const jobEntry = body.active.find((entry) => entry.jobId === "job-active") as Record<string, unknown>;
    expect(jobEntry.kind).toBe("writing");
    for (const entry of body.active) {
      expect(entry.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    }
  });

  it("POST / returns 202 {jobId} immediately and creates a durable (DB-backed) job row; polling GET /:jobId reaches status='done' with the published setId once generateSet finishes", async () => {
    const { app, repo: r, runSkillTask, planner } = buildTestApp();
    runSkillTask
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        emitRunning(request);
        return skillSuccess(validWritingSet());
      })
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        emitRunning(request);
        return skillSuccess({
          items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok" })),
        });
      });

    const postRes = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "writing" }),
    });
    expect(postRes.status).toBe(202);
    const { jobId } = (await postRes.json()) as { jobId: string };
    expect(jobId).toBeTruthy();

    // The job row is in the database the moment POST returns, before the background runner has
    // necessarily finished.
    expect(r.getGenerationJob(jobId)).toBeTruthy();
    expect(planner.reserve).toHaveBeenCalledTimes(1);
    expect(planner.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      runSkillTask.mock.invocationCallOrder[0],
    );

    const final = await pollUntilTerminal(app, jobId);
    expect(final.status).toBe("done");
    expect(final.stage).toBe("saving");
    expect(typeof final.setId).toBe("string");
    expect(final.kind).toBe("writing");

    const setId = final.setId as string;
    const publishedPath = path.join(config.dataDir, "question-sets/writing", `${setId}.json`);
    expect(fs.existsSync(publishedPath)).toBe(true);
    fs.rmSync(publishedPath);
  });

  it.each([
    {
      label: "full scene success",
      configure: (_sceneImage: ReturnType<typeof vi.fn>, _focusRegions: ReturnType<typeof vi.fn>) => {},
      expected: { image: "succeeded", regions: "succeeded" },
    },
    {
      label: "image failure",
      configure: (sceneImage: ReturnType<typeof vi.fn>, _focusRegions: ReturnType<typeof vi.fn>) => {
        sceneImage.mockRejectedValue(new Error("image unavailable"));
      },
      expected: { image: "failed", regions: "skipped" },
    },
    {
      label: "vision failure",
      configure: (_sceneImage: ReturnType<typeof vi.fn>, focusRegions: ReturnType<typeof vi.fn>) => {
        focusRegions.mockRejectedValue(new Error("vision unavailable"));
      },
      expected: { image: "succeeded", regions: "failed" },
    },
  ])("terminal speaking GET preserves the API-visible optional outcome for $label", async ({ configure, expected }) => {
    const { app, repo: r, runSkillTask, sceneImage, focusRegions } = buildTestApp();
    runSkillTask.mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
      emitRunning(request);
      return skillSuccess(validSpeakingSet());
    });
    configure(sceneImage, focusRegions);

    const postRes = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "speaking" }),
    });
    const { jobId } = (await postRes.json()) as { jobId: string };
    const final = await pollUntilTerminal(app, jobId);

    expect(final.status).toBe("done");
    expect(final.progress).toEqual({
      provider: "claude",
      planningAttempt: 1,
      generationAttempt: 1,
      maxDiversityAttempts: 3,
      done: 13,
      total: 13,
      setId: final.setId,
      scene: expected,
    });
    expect(JSON.parse(r.getGenerationJob(jobId)!.progress!)).toEqual(final.progress);

    fs.rmSync(path.join(config.dataDir, "question-sets/speaking", `${final.setId}.json`));
  });

  it("a failed provider chain reaches status='failed' with only the sanitized chain surfaced on GET /:jobId", async () => {
    const { app, runSkillTask } = buildTestApp();
    runSkillTask.mockResolvedValue(SANITIZED_ROUTE_FAILURE);

    const postRes = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "writing" }),
    });
    const { jobId } = (await postRes.json()) as { jobId: string };

    const final = await pollUntilTerminal(app, jobId);
    expect(final.status).toBe("failed");
    expect(final.error).toBe(SANITIZED_ROUTE_FAILURE.error);
    expect(final.error).not.toMatch(/http|raw/i);
    expect(final.setId).toBeUndefined();
  });

  it("boot recovery: a generation job left 'running' by a killed process is marked failed rather than looking 'running' forever, and is visible as such through GET /:jobId", async () => {
    const { app, repo: r } = buildTestApp();
    r.createGenerationJob({ id: "gen-interrupted", kind: "speaking" });
    r.updateGenerationJob({ id: "gen-interrupted", status: "running", stage: "rendering-audio" });

    // What wireGenerationBootRecovery runs once the server holds its port, called directly because
    // there is no server here.
    failInterruptedGenerationJobs({ repo: r });

    const res = await app.request("/gen-interrupted");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("failed");
    expect(body.error).toBe("interrupted by server restart");
  });

  it("accepts the single-kind form {kind}: 202 {jobId}, and a plain (non-batch) job shape on GET", async () => {
    const { app, runSkillTask } = buildTestApp();
    const [gen, verify] = writingSkillCalls();
    runSkillTask.mockImplementationOnce(gen).mockImplementationOnce(verify);

    const postRes = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "writing" }),
    });
    expect(postRes.status).toBe(202);
    const { jobId } = (await postRes.json()) as { jobId: string };

    const final = await pollUntilTerminal(app, jobId);
    expect(final.status).toBe("done");
    expect(final.kind).toBe("writing"); // not 'batch': the single-job shape
    expect(final.total).toBeUndefined();
    expect(final.children).toBeUndefined();
    expect(typeof final.setId).toBe("string");

    fs.rmSync(path.join(config.dataDir, "question-sets/writing", `${final.setId}.json`));
  });
});

describe("generate routes — batch generation", () => {
  it("zod validation: rejects an empty items array, a count below 1, and a kind outside speaking|writing|reading|listening within an item — all 400", async () => {
    const { app } = buildTestApp();

    const empty = await app.request("/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [] }),
    });
    expect(empty.status).toBe(400);

    const zeroCount = await app.request("/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ kind: "writing", count: 0 }] }),
    });
    expect(zeroCount.status).toBe(400);

    const badKind = await app.request("/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ kind: "french", count: 1 }] }),
    });
    expect(badKind.status).toBe(400);
  });

  it("zod validation: caps the batch total (sum of counts) at 10 — a request over the cap is rejected 400 and creates NOTHING (no batch/child rows, no reasoning calls)", async () => {
    const { app, repo: r, runSkillTask } = buildTestApp();

    const res = await app.request("/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ kind: "writing", count: 6 }, { kind: "speaking", count: 5 }] }), // total 11
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/11/);
    expect(body.error).toMatch(/10/);
    expect(runSkillTask).not.toHaveBeenCalled();

    // Nothing was persisted: a rejected request leaves no orphaned rows.
    expect(r.listInterruptedGenerationJobs()).toEqual([]);
    expect(r.listInterruptedGenerationBatches()).toEqual([]);
  });

  it("a batch exactly AT the cap (10) is accepted", async () => {
    const { app, repo: r } = buildTestApp();
    const res = await app.request("/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ kind: "writing", count: 10 }] }),
    });
    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(r.getGenerationBatch(jobId)?.total).toBe(10);
    // Not run to completion: the assertion is acceptance and the ten planned children existing at
    // once.
    expect(r.listGenerationJobsByBatch(jobId)).toHaveLength(10);
  });

  // A mixed batch shows each child keeps its own kind through the batch bookkeeping. The Reading
  // child's pipeline is generator.reading.test.ts's, so it is left unresolved here (runSkillTask is
  // unconfigured): this asserts acceptance and bookkeeping only.
  it("accepts a mixed writing+reading batch: both children are created with their own kind", async () => {
    const { app, repo: r } = buildTestApp();
    const res = await app.request("/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ kind: "writing", count: 1 }, { kind: "reading", count: 1 }] }),
    });
    expect(res.status).toBe(202);
    const { jobId: batchId } = (await res.json()) as { jobId: string };
    const children = r.listGenerationJobsByBatch(batchId);
    expect(children.map((c) => c.kind)).toEqual(["writing", "reading"]);
  });

  it("POST / with {items} creates a parent batch row plus one child generation job per set, in order, and returns 202 {jobId} for the PARENT; GET /:jobId returns the batch shape ({kind:'batch', total, completed, failed, current, children}) and reaches a terminal 'done' once every child succeeds", async () => {
    const { app, repo: r, runSkillTask } = buildTestApp();
    const [gen0, verify0] = writingSkillCalls();
    const [gen1, verify1] = writingSkillCalls();
    runSkillTask
      .mockImplementationOnce(gen0).mockImplementationOnce(verify0)
      .mockImplementationOnce(gen1).mockImplementationOnce(verify1);

    const postRes = await app.request("/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ kind: "writing", count: 2 }] }),
    });
    expect(postRes.status).toBe(202);
    const { jobId: batchId } = (await postRes.json()) as { jobId: string };

    // The parent and both children are database rows at once, before the background runner has
    // necessarily finished either.
    expect(r.getGenerationBatch(batchId)).toBeTruthy();
    expect(r.listGenerationJobsByBatch(batchId)).toHaveLength(2);

    const final = await pollBatchUntilTerminal(app, batchId);
    expect(final.kind).toBe("batch");
    expect(final.status).toBe("done");
    expect(final.total).toBe(2);
    expect(final.completed).toBe(2);
    expect(final.failed).toBe(0);
    expect(final.cancelled).toBe(0);
    expect(final.current).toBeNull(); // nothing running: the batch is terminal
    const children = final.children as { jobId: string; setIndex: number; kind: string; status: string; setId?: string }[];
    expect(children).toHaveLength(2);
    expect(children.map((c) => c.setIndex)).toEqual([0, 1]);
    expect(children.every((c) => c.status === "done" && typeof c.setId === "string")).toBe(true);

    for (const child of children) fs.rmSync(path.join(config.dataDir, "question-sets/writing", `${child.setId}.json`));
  });

  it("partial success over HTTP: one set failing does not kill the batch — GET /:jobId reports the parent as 'partial' with per-child status/error, and the successfully-generated set is still on disk", async () => {
    const { app, runSkillTask } = buildTestApp();
    const [, verifyOk] = writingSkillCalls();
    runSkillTask
      .mockResolvedValueOnce(SANITIZED_ROUTE_FAILURE) // child 0 GENERATE fails
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        emitRunning(request);
        return skillSuccess(validWritingSet());
      }) // child 1 GENERATE
      .mockImplementationOnce(verifyOk); // child 1 VERIFY

    const postRes = await app.request("/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ kind: "writing", count: 2 }] }),
    });
    const { jobId: batchId } = (await postRes.json()) as { jobId: string };

    const final = await pollBatchUntilTerminal(app, batchId);
    expect(final.status).toBe("partial");
    expect(final.completed).toBe(1);
    expect(final.failed).toBe(1);
    const children = final.children as { setIndex: number; status: string; error?: string; setId?: string }[];
    expect(children[0].status).toBe("failed");
    expect(children[0].error).toBe(SANITIZED_ROUTE_FAILURE.error);
    expect(children[1].status).toBe("done");
    expect(typeof children[1].setId).toBe("string");

    const publishedPath = path.join(config.dataDir, "question-sets/writing", `${children[1].setId}.json`);
    expect(fs.existsSync(publishedPath)).toBe(true);
    fs.rmSync(publishedPath);
  });

  it("POST /:batchId/cancel stops the batch after the current set finishes: already-completed sets stay banked, remaining children become 'cancelled', and the parent resolves to 'cancelled'", async () => {
    const { app, runSkillTask } = buildTestApp();

    let releaseChild0Verify!: () => void;
    const gate = new Promise<void>((resolve) => { releaseChild0Verify = resolve; });
    let child0VerifyStartedResolve!: () => void;
    const child0VerifyStarted = new Promise<void>((resolve) => { child0VerifyStartedResolve = resolve; });

    runSkillTask
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        emitRunning(request);
        return skillSuccess(validWritingSet());
      }) // child0 GENERATE
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => { // child0 VERIFY — gated
        emitRunning(request);
        child0VerifyStartedResolve();
        await gate;
        return skillSuccess({
          items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok" })),
        });
      });
      // No mocks queued for child1/child2 — if the cancel isn't honored correctly and they run
      // anyway, their reasoning call falls through to the unmocked default and the test fails.

    const postRes = await app.request("/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ kind: "writing", count: 3 }] }),
    });
    const { jobId: batchId } = (await postRes.json()) as { jobId: string };

    await child0VerifyStarted;

    // Cancelling a still-in-flight batch is accepted (200) — the flag is recorded, not acted on yet.
    const cancelRes = await app.request(`/${batchId}/cancel`, { method: "POST" });
    expect(cancelRes.status).toBe(200);

    releaseChild0Verify(); // let child0 finish naturally — never interrupted mid-render

    const final = await pollBatchUntilTerminal(app, batchId);
    expect(final.status).toBe("cancelled");
    expect(final.cancelled).toBe(3);
    expect(final.completed).toBe(0);
    const children = final.children as { setIndex: number; status: string; setId?: string }[];
    expect(children[0].status).toBe("cancelled");
    expect(children[1].status).toBe("cancelled");
    expect(children[2].status).toBe("cancelled");

  });

  it("POST /:batchId/cancel on an unknown batch id is 404; on an already-terminal batch is 409", async () => {
    const { app, repo: r } = buildTestApp();

    const notFound = await app.request("/nope-not-a-batch/cancel", { method: "POST" });
    expect(notFound.status).toBe(404);

    r.createGenerationBatch({ id: "batch-finished", total: 1 });
    r.updateGenerationBatch({ id: "batch-finished", status: "done" });
    const alreadyDone = await app.request("/batch-finished/cancel", { method: "POST" });
    expect(alreadyDone.status).toBe(409);
  });

  it("a mixed-kind batch (writing + speaking) runs each kind's set through its real pipeline — speaking children get 13 base TTS renders, writing children get GENERATE+VERIFY — in the given item order", async () => {
    const { app, runSkillTask, tts, planner } = buildTestApp();
    const [wGen, wVerify] = writingSkillCalls();
    runSkillTask
      .mockImplementationOnce(wGen).mockImplementationOnce(wVerify) // writing child (index 0)
      .mockImplementationOnce(async (request: SkillTaskRequest<unknown>) => {
        emitRunning(request);
        return skillSuccess(validSpeakingSet());
      }); // speaking child (index 1) — GENERATE only, no VERIFY

    const postRes = await app.request("/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ kind: "writing", count: 1 }, { kind: "speaking", count: 1 }] }),
    });
    const { jobId: batchId } = (await postRes.json()) as { jobId: string };

    const final = await pollBatchUntilTerminal(app, batchId);
    expect(final.status).toBe("done");
    const children = final.children as { setIndex: number; kind: string; status: string; setId?: string }[];
    expect(children.map((c) => c.kind)).toEqual(["writing", "speaking"]);
    expect(children.every((c) => c.status === "done")).toBe(true);
    expect(planner.reserve.mock.calls.map(([input]) => input.kind)).toEqual([
      "writing",
      "speaking",
    ]);
    const [firstPlanOrder, secondPlanOrder] =
      planner.reserve.mock.invocationCallOrder;
    const [writingGenerateOrder, writingVerifyOrder, speakingGenerateOrder] =
      runSkillTask.mock.invocationCallOrder;
    expect(firstPlanOrder).toBeLessThan(writingGenerateOrder);
    expect(writingVerifyOrder).toBeLessThan(secondPlanOrder);
    expect(secondPlanOrder).toBeLessThan(speakingGenerateOrder);
    expect(tts).toHaveBeenCalledTimes(13);
    expect(children[1]).toMatchObject({
      progress: {
        setId: children[1].setId,
        scene: { image: "succeeded", regions: "succeeded" },
      },
    });

    for (const child of children) fs.rmSync(path.join(config.dataDir, "question-sets", child.kind, `${child.setId}.json`));
  });
});
