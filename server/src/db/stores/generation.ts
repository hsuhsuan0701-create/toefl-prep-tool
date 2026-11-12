import type Database from "better-sqlite3";
import type { CancellationReason, GenerationBatchStatus } from "@toefl-prep/shared";
import type { CancellationRequestResult, GenerationBatchRow, GenerationJobClaimResult, GenerationJobRow } from "../rows.js";
import type { DurableJobClaim } from "../../services/durableJobRunner.js";
import { sqliteTimestamp } from "../timestamps.js";
import { LIVE_INTENT } from "./publication.js";
import type { GenerationJobStore } from "../../services/generationJobs.js";
import type { GenerateRouteStore } from "../../routes/generate.js";

// ---------------------------------------------------------------------------------------------
// The generation-job aggregate, over SQLite
// ---------------------------------------------------------------------------------------------
//
// Tables: `generation_jobs` and `generation_batches` — a batch parent and its children are one
// durable unit (a cancel of the parent has to reach every still-cancellable child in one
// transaction), so they are one aggregate rather than two.
//
// Four writers here READ `generation_publication_intents` through LIVE_INTENT, imported from the
// aggregate that owns it. That is a predicate spliced into a single statement, not a second store
// call: "refuse to move a job whose publication intent is still binding" has to be true AT THE
// MOMENT of the write, and any shape that asked a publication store first would have a window
// between the answer and the UPDATE.
//
// The route half (`createGenerationJob`, `createGenerationBatch`, the batch cancel, and the two "what
// is live right now" listings) is satisfied here too; routes/generate.ts's port doc says why it is
// declared apart from the runner's. The split lives in the ports: the runner is handed
// GenerationJobStore and cannot create a row.

export function createSqliteGenerationStore(db: Database.Database) {
  return {
    // `id` is caller-supplied (crypto.randomUUID()). A standalone job omits batchId/batchIndex and gets
    // NULL for both.
    createGenerationJob(j: { id: string; kind: string; batchId?: string; batchIndex?: number }) {
      db.prepare(
        `INSERT INTO generation_jobs (id, kind, status, batch_id, batch_index) VALUES (?,?, 'queued', ?, ?)`
      ).run(j.id, j.kind, j.batchId ?? null, j.batchIndex ?? null);
    },
    // Partial update: an omitted field leaves its column untouched, an explicit value (null included)
    // sets it, and updated_at advances whenever the write lands. A write that sets `status` is
    // status-agnostic (the CHECK constraint enforces the allowed set). A write without one is a
    // progress write (stage, progress, set id) and lands only while the job is queued or running, as
    // the scoring store's stage write does: a call still running after its job ended, such as a
    // sibling regeneration the verify loop is waiting out, cannot put a stage back on a terminal row.
    updateGenerationJob(u: {
      id: string;
      status?: string;
      stage?: string | null;
      progress?: string | null;
      setId?: string | null;
      error?: string | null;
    }) {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (u.status !== undefined) { sets.push("status=?"); params.push(u.status); }
      if (u.stage !== undefined) { sets.push("stage=?"); params.push(u.stage); }
      if (u.progress !== undefined) { sets.push("progress=?"); params.push(u.progress); }
      if (u.setId !== undefined) { sets.push("set_id=?"); params.push(u.setId); }
      if (u.error !== undefined) { sets.push("error=?"); params.push(u.error); }
      sets.push("updated_at=datetime('now')");
      params.push(u.id);
      const whileLive = u.status === undefined ? " AND status IN ('queued','running')" : "";
      db.prepare(`UPDATE generation_jobs SET ${sets.join(", ")} WHERE id=?${whileLive}`).run(...params);
    },
    getGenerationJob(id: string): GenerationJobRow | undefined {
      return db.prepare("SELECT * FROM generation_jobs WHERE id=?").get(id) as GenerationJobRow | undefined;
    },
    // Every generation job still queued or running, batch children included. Read only at boot
    // (failInterruptedGenerationJobs in generationJobs.ts): a row in this state then was orphaned by
    // the previous process, and a batch child needs the same failed-and-cleaned-up treatment as a
    // standalone job. The affected batches' own statuses are recomputed afterwards.
    listInterruptedGenerationJobs(): GenerationJobRow[] {
      return db.prepare("SELECT * FROM generation_jobs WHERE status IN ('queued','running')").all() as GenerationJobRow[];
    },
    // `id` is caller-supplied, as for createGenerationJob.
    createGenerationBatch(b: { id: string; total: number }) {
      db.prepare(
        `INSERT INTO generation_batches (id, total, status) VALUES (?,?, 'queued')`
      ).run(b.id, b.total);
    },
    // Partial update, with updateGenerationJob's semantics.
    updateGenerationBatch(u: { id: string; status?: string; cancelRequested?: boolean; error?: string | null }) {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (u.status !== undefined) { sets.push("status=?"); params.push(u.status); }
      if (u.status !== undefined && ["done", "partial", "failed", "cancelled"].includes(u.status)) {
        sets.push("terminal_at=COALESCE(terminal_at,datetime('now'))");
        if (u.status === "cancelled") sets.push("cancelled_at=COALESCE(cancelled_at,datetime('now'))");
      }
      if (u.cancelRequested !== undefined) { sets.push("cancel_requested=?"); params.push(u.cancelRequested ? 1 : 0); }
      if (u.error !== undefined) { sets.push("error=?"); params.push(u.error); }
      sets.push("updated_at=datetime('now')");
      params.push(u.id);
      db.prepare(`UPDATE generation_batches SET ${sets.join(", ")} WHERE id=?`).run(...params);
    },
    getGenerationBatch(id: string): GenerationBatchRow | undefined {
      return db.prepare("SELECT * FROM generation_batches WHERE id=?").get(id) as GenerationBatchRow | undefined;
    },
    // The batch parent's 'queued' -> 'running' compare-and-set. Two-valued, never 'cancel_requested': a
    // batch's cancel flag gates the admission of its children, not the parent's own start, so a batch
    // cancelled before it started still runs. Its window admits nothing, cancelUnpublishedChildren
    // settles every child, and computeBatchStatus reports 'cancelled' from what the children became.
    // Terminalizing the parent here instead would leave those children non-terminal for good.
    claimGenerationBatchRunning(id:string,now=sqliteTimestamp()):DurableJobClaim {
      return db.prepare("UPDATE generation_batches SET status='running',updated_at=? WHERE id=? AND status='queued'").run(now,id).changes===1?"claimed":"unclaimable";
    },
    // The batch parent's terminal write, conditional, reporting whether it won.
    settleGenerationBatch(i:{id:string;status:GenerationBatchStatus;error?:string|null;now:string}):boolean {
      const sets:string[]=["status=?"];const params:unknown[]=[i.status];
      if(i.error!==undefined){sets.push("error=?");params.push(i.error);}
      sets.push("terminal_at=COALESCE(terminal_at,?)");params.push(i.now);
      if(i.status==="cancelled"){sets.push("cancelled_at=COALESCE(cancelled_at,?)");params.push(i.now);}
      sets.push("updated_at=?");params.push(i.now,i.id);
      return db.prepare(`UPDATE generation_batches SET ${sets.join(",")} WHERE id=? AND status IN ('queued','running')`).run(...params).changes===1;
    },
    // A batch's children in `batch_index` (admission) order: the order the runner starts them in, and
    // the order of the batch response's `children`.
    listGenerationJobsByBatch(batchId: string): GenerationJobRow[] {
      return db.prepare("SELECT * FROM generation_jobs WHERE batch_id=? ORDER BY batch_index ASC").all(batchId) as GenerationJobRow[];
    },
    // Every batch still queued or running. Read only at boot, as listInterruptedGenerationJobs is: its
    // children are recovered through that method, and this lets failInterruptedGenerationJobs then
    // settle the parent too.
    listInterruptedGenerationBatches(): GenerationBatchRow[] {
      return db.prepare("SELECT * FROM generation_batches WHERE status IN ('queued','running')").all() as GenerationBatchRow[];
    },
    // GET /api/generate's active listing: the same queued-or-running predicate as the two boot reads
    // above, kept as separate methods so tightening one (boot recovery learning a lease column, say)
    // cannot change the other. Newest first, so the client's "most recent thing running" is [0]. The
    // job variant lists standalone jobs only; a batch child is reached through its batch. Ties break
    // on rowid, not id: created_at has one-second resolution and ids are random UUIDs.
    listActiveGenerationBatches(): GenerationBatchRow[] {
      return db.prepare("SELECT * FROM generation_batches WHERE status IN ('queued','running') ORDER BY created_at DESC, rowid DESC").all() as GenerationBatchRow[];
    },
    listActiveStandaloneGenerationJobs(): GenerationJobRow[] {
      return db.prepare("SELECT * FROM generation_jobs WHERE batch_id IS NULL AND status IN ('queued','running') ORDER BY created_at DESC, rowid DESC").all() as GenerationJobRow[];
    },

    requestGenerationJobCancellation(i:{id:string;reason:CancellationReason;now:string}):CancellationRequestResult|undefined {
      return db.transaction((): CancellationRequestResult|undefined => {
        const row=db.prepare("SELECT status,cancel_requested_at FROM generation_jobs WHERE id=?").get(i.id) as {status:string;cancel_requested_at:string|null}|undefined;
        if(!row)return undefined;
        if(db.prepare(`SELECT 1 FROM generation_publication_intents WHERE child_id=? AND ${LIVE_INTENT}`).get(i.id))return {accepted:false,state:"publication_committed"};
        if(row.status==="cancelled"||row.cancel_requested_at)return {accepted:true,state:row.status==="cancelled"?"cancelled":"cancel_requested"};
        if(!["queued","running"].includes(row.status))return {accepted:false,state:"terminal"};
        db.prepare("UPDATE generation_jobs SET cancel_requested_at=?,cancellation_reason=?,updated_at=? WHERE id=? AND status IN ('queued','running') AND cancel_requested_at IS NULL").run(i.now,i.reason,i.now,i.id);
        return {accepted:true,state:"cancel_requested"};
      })();
    },
    requestGenerationBatchCancellation(i:{id:string;reason:CancellationReason;now:string}):{state:"accepted"|"idempotent"|"terminal";affectedChildIds:string[]}|undefined {
      return db.transaction(() => {
        const batch=db.prepare("SELECT status,cancel_requested FROM generation_batches WHERE id=?").get(i.id) as {status:string;cancel_requested:0|1}|undefined;
        if(!batch)return undefined;
        if(batch.cancel_requested)return {state:"idempotent" as const,affectedChildIds:[]};
        if(!["queued","running"].includes(batch.status))return {state:"terminal" as const,affectedChildIds:[]};
        const children=db.prepare(`SELECT id FROM generation_jobs gj WHERE batch_id=? AND status IN ('queued','running')
          AND cancel_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM generation_publication_intents pi WHERE pi.child_id=gj.id AND ${LIVE_INTENT})
          ORDER BY batch_index`).all(i.id) as {id:string}[];
        db.prepare("UPDATE generation_batches SET cancel_requested=1,cancel_requested_at=?,cancellation_reason=?,updated_at=? WHERE id=?").run(i.now,i.reason,i.now,i.id);
        db.prepare(`UPDATE generation_jobs SET cancel_requested_at=?,cancellation_reason=?,updated_at=? WHERE batch_id=? AND status IN ('queued','running')
          AND cancel_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM generation_publication_intents pi WHERE pi.child_id=generation_jobs.id AND ${LIVE_INTENT})`).run(i.now,"parent_cancelled",i.now,i.id);
        return {state:"accepted" as const,affectedChildIds:children.map(c=>c.id)};
      })();
    },
    // Takes the 'queued' -> 'running' transition and, when it cannot, says which refusal it was
    // (GenerationJobClaimResult). The distinction matters: this writer requires
    // `cancel_requested_at IS NULL`, so a cancellation recorded on a job that has not started is
    // refused here and nowhere else, and the runner that called this is the last code to look at that
    // row in this run. A bare false would strand such a job at 'queued' until the next boot. The
    // 'cancel_requested' arm is limited to a still-'queued' row: a 'running' row with a cancel stamp
    // belongs to whoever claimed it, and their abort path will terminalize it.
    claimGenerationJobRunning(id:string,now=sqliteTimestamp()):GenerationJobClaimResult {
      return db.transaction((): GenerationJobClaimResult => {
        if(db.prepare("UPDATE generation_jobs SET status='running',updated_at=? WHERE id=? AND status='queued' AND cancel_requested_at IS NULL").run(now,id).changes===1)return "claimed";
        const row=db.prepare("SELECT status,cancel_requested_at FROM generation_jobs WHERE id=?").get(id) as {status:string;cancel_requested_at:string|null}|undefined;
        return row?.status==="queued"&&row.cancel_requested_at?"cancel_requested":"unclaimable";
      })();
    },
    failGenerationJobConditional(i:{id:string;error:string;now:string}):boolean {
      return db.prepare(`UPDATE generation_jobs SET status='failed',error=?,terminal_at=?,updated_at=? WHERE id=? AND status IN ('queued','running')
        AND cancel_requested_at IS NULL AND NOT EXISTS(SELECT 1 FROM generation_publication_intents WHERE child_id=? AND ${LIVE_INTENT})`).run(i.error,i.now,i.now,i.id,i.id).changes===1;
    },
    finishGenerationJobCancellation(i:{id:string;now:string}):boolean {
      return db.prepare(`UPDATE generation_jobs SET status='cancelled',cancelled_at=?,terminal_at=?,updated_at=? WHERE id=? AND status IN ('queued','running')
        AND cancel_requested_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM generation_publication_intents WHERE child_id=? AND ${LIVE_INTENT})`).run(i.now,i.now,i.now,i.id,i.id).changes===1;
    },
  } satisfies Pick<
    GenerateRouteStore,
    | "getGenerationJob" | "listInterruptedGenerationJobs" | "listGenerationJobsByBatch"
    | "claimGenerationJobRunning" | "updateGenerationJob" | "requestGenerationJobCancellation"
    | "finishGenerationJobCancellation" | "failGenerationJobConditional"
    | "getGenerationBatch" | "listInterruptedGenerationBatches" | "claimGenerationBatchRunning"
    | "updateGenerationBatch" | "settleGenerationBatch" | "createGenerationJob"
    | "createGenerationBatch" | "requestGenerationBatchCancellation"
    | "listActiveGenerationBatches" | "listActiveStandaloneGenerationJobs"
  > & Pick<GenerationJobStore, "getGenerationJob" | "claimGenerationJobRunning">;
}
