import type Database from "better-sqlite3";
import type { PublicationRepo } from "../../services/generationPublication.js";
import type { GenerationJobStore } from "../../services/generationJobs.js";

// ---------------------------------------------------------------------------------------------
// The generation-publication aggregate, over SQLite
// ---------------------------------------------------------------------------------------------
//
// Tables: `generation_publication_intents` and `cleanup_debt` — the two-phase record of "this job
// has committed to publishing a Set" and the durable list of staging paths a crash left behind.
//
// `markGenerationPublicationComplete` and `abandonGenerationPublicationIntent` each also write
// `generation_jobs`, inside the SAME transaction that settles the intent: honoring or abandoning an
// intent and terminalizing the job it belongs to is one fact, and a crash between two store calls
// would leave a published Set whose job still reads 'running'. The transaction wins, so both stay
// here rather than being split across this aggregate and stores/generation.ts.

// What it means for a generation_publication_intents row to still be BINDING: neither published nor
// abandoned. Every guard that asks "has this job committed to publishing?" must use exactly this
// predicate — a published intent is already honored and an abandoned one can never be, so neither
// may keep protecting its job from the cancel/fail writers or keep re-entering boot reconciliation.
// Interpolated (not bound) because it names only columns; it takes no parameters of its own, so it
// never shifts the positional parameters of the statement it is spliced into.
//
// Exported because the three conditional `generation_jobs` writers that must not move a row an intent
// protects live in stores/generation.ts; importing the one predicate from the aggregate that owns the
// table keeps a second copy from drifting.
export const LIVE_INTENT = "published_at IS NULL AND abandoned_at IS NULL";

export function createSqlitePublicationStore(db: Database.Database) {
  return {
    commitGenerationPublicationIntent(i:{childId:string;setId:string;expectedKind:string;stagingPath:string;canonicalPath:string;contentHash:string;now:string}):boolean {
      return db.transaction(() => {
        const child=db.prepare("SELECT status,cancel_requested_at FROM generation_jobs WHERE id=?").get(i.childId) as {status:string;cancel_requested_at:string|null}|undefined;
        if(!child||child.cancel_requested_at||!["queued","running"].includes(child.status))return false;
        return db.prepare(`INSERT INTO generation_publication_intents(child_id,set_id,expected_kind,staging_path,canonical_path,content_hash,committed_at)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(child_id) DO NOTHING`).run(i.childId,i.setId,i.expectedKind,i.stagingPath,i.canonicalPath,i.contentHash,i.now).changes===1;
      })();
    },
    markGenerationPublicationComplete(i:{childId:string;now:string}):boolean {
      return db.transaction(() => {
        // `abandoned_at IS NULL`, not the full LIVE_INTENT: completing an ALREADY-published intent
        // stays idempotently true (COALESCE keeps the original timestamp), but an abandoned one can
        // never be completed — its job has already been failed, and resurrecting it to 'done' would
        // claim a publication whose bytes were verified missing.
        const intent=db.prepare("UPDATE generation_publication_intents SET published_at=COALESCE(published_at,?) WHERE child_id=? AND abandoned_at IS NULL").run(i.now,i.childId);
        if(intent.changes===0)return false;
        db.prepare("UPDATE generation_jobs SET status='done',terminal_at=COALESCE(terminal_at,?),updated_at=? WHERE id=? AND status IN ('queued','running')").run(i.now,i.now,i.childId);
        return true;
      })();
    },
    listUnreconciledGenerationPublicationIntents(): unknown[] { return db.prepare(`SELECT * FROM generation_publication_intents WHERE ${LIVE_INTENT} ORDER BY committed_at`).all(); },
    getUnreconciledGenerationPublicationIntent(childId: string): unknown | undefined { return db.prepare(`SELECT * FROM generation_publication_intents WHERE child_id=? AND ${LIVE_INTENT}`).get(childId); },
    // The intent's OTHER terminal outcome, for bytes that can no longer be published (see
    // schema.sql). Retires the intent and fails its job in ONE transaction, because the two are the
    // same fact: while the intent is live it is precisely what forbids failGenerationJobConditional
    // from touching the row, so retiring it first and failing separately would leave a window where
    // the job is unprotected but still 'running'. Returns false if there was no live intent to
    // abandon, leaving the job untouched.
    abandonGenerationPublicationIntent(i:{childId:string;error:string;now:string}):boolean {
      return db.transaction(() => {
        if(db.prepare(`UPDATE generation_publication_intents SET abandoned_at=? WHERE child_id=? AND ${LIVE_INTENT}`).run(i.now,i.childId).changes===0)return false;
        db.prepare("UPDATE generation_jobs SET status='failed',error=?,terminal_at=COALESCE(terminal_at,?),updated_at=? WHERE id=? AND status IN ('queued','running')").run(i.error,i.now,i.now,i.childId);
        return true;
      })();
    },
    createCleanupDebt(i:{id:string;childId?:string;path:string;now:string}):void { db.prepare("INSERT INTO cleanup_debt(id,child_id,path,created_at) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING").run(i.id,i.childId??null,i.path,i.now); },
    listPendingCleanupDebt():unknown[]{return db.prepare("SELECT * FROM cleanup_debt WHERE completed_at IS NULL ORDER BY created_at,id").all();},
    completeCleanupDebt(i:{id:string;now:string}):boolean{return db.prepare("UPDATE cleanup_debt SET completed_at=?,last_error=NULL WHERE id=? AND completed_at IS NULL").run(i.now,i.id).changes===1;},
    failCleanupDebt(i:{id:string;error:string}):boolean{return db.prepare("UPDATE cleanup_debt SET last_error=? WHERE id=? AND completed_at IS NULL").run(i.error,i.id).changes===1;},
  } satisfies PublicationRepo & Pick<GenerationJobStore, "commitGenerationPublicationIntent" | "getUnreconciledGenerationPublicationIntent">;
}
