import crypto from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import type { GenerationProgressDetail } from "@toefl-prep/shared";
import {
  abortGenerationJob,
  runGenerationJob,
  runGenerationBatch,
  type GenerationJobDeps,
  type GenerationJobStore,
} from "../services/generationJobs.js";
import type { CancellationReason, GenerationBatchRow, GenerationJobRow } from "../db/rows.js";
import { sqliteTimestamp, sqliteTimestampToIso, type SqliteTimestamp } from "../db/timestamps.js";
import { cancellationMetadata } from "../db/cancellationMetadata.js";
import { config } from "../lib/config.js";
import { setStore } from "../services/setStore.js";
import { jobAdmissionsAreOpen } from "../services/jobCancellation.js";

// The generation routes, mounted at /api/generate. A factory over its store so tests can build it
// against their own database (test/routes.generate.test.ts).

// The most Sets one POST /api/generate may ask for. Generation is real spend (model calls and TTS,
// tens of minutes for a Speaking Set) on the User's own machine, so this is a guard against an
// obviously wrong request, refused with a 400 before anything is spent; it is not about capacity.
// The client's generationCost.ts mirrors it.
const MAX_BATCH_TOTAL = 10;

// A batch is `{items: [{kind, count}, ...]}` rather than `{writing: N, speaking: M}` because array
// order is admission order, the order children start (they finish in any order):
// `{items:[{kind:"writing",count:2},{kind:"speaking",count:1}]}` means two Writing Sets, then one
// Speaking Set. A keyed shape would need a separate ordering rule and could not express an
// interleaved order at all.
const BatchItemSchema = z.object({
  kind: z.enum(["speaking", "writing", "reading", "listening"]),
  count: z.number().int().min(1),
});
const BatchGenerateSchema = z.object({ items: z.array(BatchItemSchema).min(1) });

// The two POST bodies are told apart by shape alone: an object with an `items` key is a batch, and
// the single-Set form never has one. This checks only that the body is a plain object.
function isRequestObject(body: unknown): body is Record<string, unknown> {
  return typeof body === "object" && body !== null && !Array.isArray(body);
}

function parseProgress(raw: string | null): GenerationProgressDetail | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GenerationProgressDetail;
  } catch {
    // Only this server writes progress, but unreadable JSON reads as no progress rather than a 500.
    return null;
  }
}

function buildBatchResponse(batch: GenerationBatchRow, children: GenerationJobRow[]) {
  const queued = children.filter((c) => c.status === "queued").length;
  const completed = children.filter((c) => c.status === "done").length;
  const failed = children.filter((c) => c.status === "failed").length;
  const cancelled = children.filter((c) => c.status === "cancelled").length;
  const activeChildren = children
    .filter((c) => c.status === "running")
    .sort((a, b) => (a.batch_index ?? 0) - (b.batch_index ?? 0));
  const active = activeChildren.map((child) => ({
    jobId: child.id,
    setIndex: child.batch_index,
    kind: child.kind,
    stage: child.stage,
    progress: parseProgress(child.progress),
  }));

  return {
    jobId: batch.id,
    kind: "batch" as const,
    status: batch.status,
    total: batch.total,
    queued,
    activeCount: active.length,
    completed,
    failed,
    cancelled,
    cancelRequested: batch.cancel_requested === 1,
    ...cancellationMetadata(batch),
    active,
    activeChildIds: activeChildren.map((child) => child.id),
    current: active[0] ?? null,
    children: children.map((c) => ({
      jobId: c.id,
      setIndex: c.batch_index,
      kind: c.kind,
      status: c.status,
      stage: c.stage,
      progress: parseProgress(c.progress),
      ...cancellationMetadata(c),
      ...(c.set_id !== null ? { setId: c.set_id } : {}),
      ...(c.error !== null ? { error: c.error } : {}),
    })),
  };
}

function buildGenerationJobResponse(job: GenerationJobRow) {
  return {
    jobId: job.id,
    kind: job.kind,
    status: job.status,
    stage: job.stage,
    progress: parseProgress(job.progress),
    ...cancellationMetadata(job),
    ...(job.set_id !== null ? { setId: job.set_id } : {}),
    ...(job.error !== null ? { error: job.error } : {}),
  };
}

/**
 * What the route adds to the generation job store. Three writers the runner never makes, because
 * creation belongs to the request that asked for the work:
 *
 *   createGenerationJob            a standalone job, or one child of a batch;
 *   createGenerationBatch          the batch parent, created BEFORE any of its children so
 *                                  GET /:jobId can show the whole planned sequence from the very
 *                                  first poll;
 *   requestGenerationBatchCancellation
 *                                  the batch-wide cancel, which returns the child ids it affected
 *                                  so the route can abort each one in-process.
 *
 * …plus the two LIVE listings behind GET / (Dashboard re-attach-on-mount):
 *
 *   listActiveGenerationBatches
 *   listActiveStandaloneGenerationJobs
 *
 * Those two share `status IN ('queued','running')` with the runner's
 * `listInterruptedGenerationBatches`/`listInterruptedGenerationJobs`, and are separate members on
 * purpose: one pair is a boot-recovery sweep over rows a dead process left behind, the other a live
 * read for a client re-attaching to work still running, so tightening one can never change the
 * other. `listGenerationJobsByBatch`, which GET / also calls, is inherited from GenerationJobStore.
 *
 * The split is what the types enforce: the runner's port cannot create or list a generation row for
 * display.
 */
export type GenerateRouteStore = GenerationJobStore & {
  createGenerationJob(j: { id: string; kind: string; batchId?: string; batchIndex?: number }): void;
  createGenerationBatch(b: { id: string; total: number }): void;
  requestGenerationBatchCancellation(i: {
    id: string; reason: CancellationReason; now: SqliteTimestamp;
  }): { state: "accepted" | "idempotent" | "terminal"; affectedChildIds: string[] } | undefined;
  /** Newest first (`ORDER BY created_at DESC, rowid DESC`), so the client's re-attach target is [0]. */
  listActiveGenerationBatches(): GenerationBatchRow[];
  /** Standalone jobs only — a batch child is reached through its parent's entry. Same ordering. */
  listActiveStandaloneGenerationJobs(): GenerationJobRow[];
};

export type GenerateRouteDeps = Omit<GenerationJobDeps, "repo"> & { repo: GenerateRouteStore };

export function buildGenerateRoutes(deps: GenerateRouteDeps) {
  return new Hono()
    .post("/", async (c) => {
      if (!jobAdmissionsAreOpen()) return c.json({ error: "server is shutting down" }, 503);
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON" }, 400);
      }
      if (!isRequestObject(body)) return c.json({ error: "request body must be a JSON object" }, 400);

      if ("items" in body) {
        const parsed = BatchGenerateSchema.safeParse(body);
        if (!parsed.success) return c.json({ error: parsed.error.message }, 400);

        const total = parsed.data.items.reduce((sum, item) => sum + item.count, 0);
        if (total > MAX_BATCH_TOTAL) {
          return c.json({ error: `batch total (${total}) exceeds max of ${MAX_BATCH_TOTAL}` }, 400);
        }

        const batchId = crypto.randomUUID();
        deps.repo.createGenerationBatch({ id: batchId, total });
        // Every child is created up front, so GET /:jobId shows the whole planned sequence, unstarted
        // Sets included, from the first poll.
        let batchIndex = 0;
        for (const item of parsed.data.items) {
          for (let n = 0; n < item.count; n++) {
            const childId = crypto.randomUUID();
            deps.repo.createGenerationJob({ id: childId, kind: item.kind, batchId, batchIndex });
            batchIndex++;
          }
        }

        // Not awaited. Each child's failure is recorded on its own row; runGenerationBatch rejects
        // only when an invariant breaks (a store call throwing), and the .catch logs that instead
        // of leaving an unhandled rejection.
        void runGenerationBatch(deps, batchId).catch((err) => {
          console.error(`[generationJobs] batch ${batchId} runner threw unexpectedly:`, err);
        });

        return c.json({ jobId: batchId }, 202);
      }

      // The single-Set form: `{kind, supersedesSetId?}`.
      const { kind } = body;
      if (kind !== "speaking" && kind !== "writing" && kind !== "reading" && kind !== "listening") return c.json({ error: "bad kind" }, 400);

      // Superseding is explicit and per-generation, and refused for Writing. Validated before the job
      // row exists, so a bad target is a 400 rather than a failure tens of minutes into a paid run.
      // A retirement the run records lands in `superseded_sets` and
      // data/question-sets/supersessions.json together (ADR 0011).
      const { supersedesSetId } = body;
      if (supersedesSetId !== undefined) {
        if (typeof supersedesSetId !== "string" || supersedesSetId.length === 0) {
          return c.json({ error: "supersedesSetId must be a set id" }, 400);
        }
        if (kind === "writing") {
          return c.json({ error: "supersedesSetId is not supported for writing" }, 400);
        }
        const target = setStore.readSet(supersedesSetId);
        // Same kind, not mere existence: a Listening Set cannot stand in for a retired Reading Set.
        if (!target || target.kind !== kind) {
          return c.json({ error: `supersedesSetId is not an existing ${kind} set` }, 400);
        }
      }

      const jobId = crypto.randomUUID();
      deps.repo.createGenerationJob({ id: jobId, kind });

      // Not awaited. runGenerationJob records a generation failure on the job row and rejects only
      // when a store call throws; the .catch logs that instead of leaving an unhandled rejection.
      void runGenerationJob(deps, jobId, {
        kind,
        ...(typeof supersedesSetId === "string" ? { supersedesSetId } : {}),
      }).catch((err) => {
        console.error(`[generationJobs] job ${jobId} runner threw unexpectedly:`, err);
      });

      return c.json({ jobId }, 202);
    })
    // Cancels whatever the id names, batch or job, tried in that order (the id spaces never collide;
    // see GET /:jobId). The job branch takes a standalone job or a batch child's own id. Cancelling
    // one child leaves its siblings running and the parent's `cancel_requested` untouched, which is
    // why a batch's status comes from what its children became (computeBatchStatus).
    .post("/:batchId/cancel", (c) => {
      const batchId = c.req.param("batchId");
      const result = deps.repo.requestGenerationBatchCancellation({
        id: batchId,
        reason: "user",
        now: sqliteTimestamp(),
      });
      if (!result) {
        const jobResult = deps.repo.requestGenerationJobCancellation({
          id: batchId,
          reason: "user",
          now: sqliteTimestamp(),
        });
        if (!jobResult) return c.json({ error: "not found" }, 404);
        if (!jobResult.accepted) return c.json({ error: "generation job already finished" }, 409);
        abortGenerationJob(batchId, "user");
        const job = deps.repo.getGenerationJob(batchId);
        if (!job) return c.json({ error: "not found" }, 404);
        return c.json(buildGenerationJobResponse(job), 200);
      }
      if (result.state === "terminal") {
        return c.json({ error: "batch already finished" }, 409);
      }
      for (const childId of result.affectedChildIds) abortGenerationJob(childId, "parent_cancelled");
      const batch = deps.repo.getGenerationBatch(batchId);
      if (!batch) return c.json({ error: "not found" }, 404);
      return c.json(buildBatchResponse(batch, deps.repo.listGenerationJobsByBatch(batchId)), 200);
    })
    // The active listing (ActiveGenerationListVM): every batch and standalone job still
    // queued|running, newest first, each in the shape GET /:jobId serves plus `createdAt` (converted
    // to ISO here, as every timestamp is at the route boundary), so a re-attaching client can seed
    // its elapsed clock from the job's real start. Active only: a job that finished unwatched needs no
    // progress UI, and its Set already appears in the practice lists.
    .get("/", (c) => {
      const batches = deps.repo.listActiveGenerationBatches().map((batch) => ({
        ...buildBatchResponse(batch, deps.repo.listGenerationJobsByBatch(batch.id)),
        createdAt: sqliteTimestampToIso(batch.created_at),
      }));
      const jobs = deps.repo.listActiveStandaloneGenerationJobs().map((job) => ({
        ...buildGenerationJobResponse(job),
        createdAt: sqliteTimestampToIso(job.created_at),
      }));
      // Newest first across both tables. created_at has second precision and rowids do not compare
      // across tables, so a same-second tie goes to the batch (spread first; the sort is stable): a
      // batch is the bigger thing to re-attach a progress UI to.
      const active = [...batches, ...jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return c.json({ active }, 200);
    })
    .get("/:jobId", (c) => {
      const id = c.req.param("jobId");

      // Batch and job ids live in separate tables and are both random UUIDs, so trying the batch
      // first and falling back is unambiguous. A child's own id falls through to the job lookup and
      // gets the single-job shape.
      const batch = deps.repo.getGenerationBatch(id);
      if (batch) {
        const children = deps.repo.listGenerationJobsByBatch(id);
        return c.json(buildBatchResponse(batch, children), 200);
      }

      const job = deps.repo.getGenerationJob(id);
      if (!job) return c.json({ error: "not found" }, 404);

      return c.json(buildGenerationJobResponse(job), 200);
    });
}
