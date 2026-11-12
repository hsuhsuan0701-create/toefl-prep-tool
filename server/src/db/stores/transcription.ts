import type Database from "better-sqlite3";
import type { TranscriptionFailureKind, TranscriptionJobStatus } from "@toefl-prep/shared";
import type { TranscriptionJobRow } from "../rows.js";
import { resolveAudioPath } from "../../lib/paths.js";
import { ITEM_RESULT_UPSERT_SQL } from "./attempts.js";
import type { TranscriptionBootStore, TranscriptionJobStore } from "../../services/transcriptionRecovery.js";
import type { RecordingStore } from "../../services/recordingIntake.js";

// ---------------------------------------------------------------------------------------------
// The transcription aggregate, over SQLite
// ---------------------------------------------------------------------------------------------
//
// Tables: `transcription_jobs`, plus the two-statement transactions that reconcile a job with the
// `item_results` row it transcribes. `getAttempt`/`insertItemResult` are the Attempt aggregate's,
// composed in at the root, while `persistRecoveredTranscriptAndAwaitScore` and
// `persistFreshTranscriptAndFinishJob` are here: each writes both tables in one `db.transaction`, and
// splitting it into two store calls would lose the atomicity the recovery argument rests on.

export function createSqliteTranscriptionJobStore(db: Database.Database) {
  return {
    // A reused row may already be terminal (`failed`/`done`) or `superseded`; it is returned as is and
    // never revived (ON CONFLICT DO NOTHING returns whatever row holds this attempt/item/hash). A
    // terminal job is retried only through TranscriptionRecovery.retry(jobId), which accepts just the
    // current non-superseded `failed` job and revalidates path and hash first. A caller that takes a
    // reused row for a fresh admission is wrong.
    createOrGetTranscriptionJob(i: { id: string; attemptId: string; itemId: string; taskType: "listen_repeat" | "interview"; audioPath: string; audioSha256: string; now: string }): TranscriptionJobRow {
      return db.transaction(() => {
        const inserted = db.prepare("INSERT INTO transcription_jobs (id,attempt_id,item_id,task_type,audio_path,audio_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id,item_id,audio_sha256) DO NOTHING").run(i.id,i.attemptId,i.itemId,i.taskType,i.audioPath,i.audioSha256,i.now,i.now);
        const job = db.prepare("SELECT * FROM transcription_jobs WHERE attempt_id=? AND item_id=? AND audio_sha256=?").get(i.attemptId,i.itemId,i.audioSha256) as TranscriptionJobRow;
        if (inserted.changes) {
          db.prepare("UPDATE transcription_jobs SET status='superseded',updated_at=? WHERE attempt_id=? AND item_id=? AND id!=? AND status IN ('queued','running','retry_wait','awaiting_score')").run(i.now,i.attemptId,i.itemId,job.id);
        }
        return job;
      })();
    },
    claimTranscriptionJob(i: { id: string; now: string }): TranscriptionJobRow | undefined { return db.transaction(() => { const x=db.prepare("UPDATE transcription_jobs SET status='running',updated_at=? WHERE id=? AND (status='queued' OR (status='retry_wait' AND next_retry_at<=?))").run(i.now,i.id,i.now); return x.changes ? db.prepare("SELECT * FROM transcription_jobs WHERE id=?").get(i.id) as TranscriptionJobRow : undefined; })(); },
    // Every write is gated on `status NOT IN ('superseded','done')`, so a worker whose job was
    // superseded while it waited on Ears cannot write the row back to life. `automatic_attempts` is
    // incremented in SQL rather than set from a caller's "current + 1", so two writers racing (a manual
    // requeue and an in-flight worker) each count. Passing `automaticAttempts` at all means "record one
    // more attempt"; its value is not read.
    updateTranscriptionJob(i: { id: string; status?: TranscriptionJobStatus; automaticAttempts?: number; nextRetryAt?: string | null; failureKind?: TranscriptionFailureKind | null; error?: string | null; scoreJobId?: string | null; now: string }): void {
      const pairs: [unknown, string][] = [[i.status,"status"],[i.nextRetryAt,"next_retry_at"],[i.failureKind,"failure_kind"],[i.error,"error"],[i.scoreJobId,"score_job_id"]]; const sets:string[]=[]; const p:unknown[]=[];
      for (const [v,c] of pairs) if (v !== undefined) { sets.push(`${c}=?`); p.push(v); }
      if (i.automaticAttempts !== undefined) sets.push("automatic_attempts=automatic_attempts+1");
      sets.push("updated_at=?"); p.push(i.now,i.id); db.prepare(`UPDATE transcription_jobs SET ${sets.join(",")} WHERE id=? AND status NOT IN ('superseded','done')`).run(...p);
    },
    getTranscriptionJob(id: string): TranscriptionJobRow | undefined { return db.prepare("SELECT * FROM transcription_jobs WHERE id=?").get(id) as TranscriptionJobRow | undefined; },
    getCurrentTranscriptionJobs(attemptId: string): TranscriptionJobRow[] { return db.prepare("SELECT * FROM transcription_jobs WHERE attempt_id=? AND status!='superseded' ORDER BY created_at,rowid").all(attemptId) as TranscriptionJobRow[]; },
    listRecoverableTranscriptionJobs(now: string): TranscriptionJobRow[] { return db.prepare("SELECT * FROM transcription_jobs WHERE status='queued' OR (status='retry_wait' AND next_retry_at<=?) ORDER BY created_at,rowid").all(now) as TranscriptionJobRow[]; },
    listInterruptedTranscriptionJobs(): TranscriptionJobRow[] { return db.prepare("SELECT * FROM transcription_jobs WHERE status='running'").all() as TranscriptionJobRow[]; },
    // Every transcription job at 'awaiting_score', across all Attempts; nothing else enumerates them
    // globally. listPendingItemsWithTranscript excludes them from boot's orphan sweep so a recovered
    // Item is never mislabelled failed. Two readers: the coordinator's runDueAndReconcile pass resumes
    // each one's scoring handoff, and boot (failInterruptedTranscriptionJobs) closes those a restart
    // left, without that paid handoff.
    listAwaitingScoreTranscriptionJobs(): TranscriptionJobRow[] { return db.prepare("SELECT * FROM transcription_jobs WHERE status='awaiting_score' ORDER BY created_at,rowid").all() as TranscriptionJobRow[]; },
    // Lands a durable retry's transcript: the Item 'transcription_pending' -> 'pending' and the job
    // 'awaiting_score', in one transaction, or neither. 'transcription_pending' is the one state in
    // which a retry's result is still wanted (transcription recovery writes it when it claims a fresh
    // job); any other status means another path already resolved the Item, and a stale retry must not
    // flip a scored Item back to 'pending', dropping its score and spending the Judges again. The path
    // and hash checks cannot catch that alone, because every take of an Item is renamed onto the same
    // canonical path. A job already superseded or done is not moved back to 'awaiting_score' either.
    // Paths compare through resolveAudioPath, so a legacy absolute-form row matches its relative form.
    persistRecoveredTranscriptAndAwaitScore(i: { jobId: string; attemptId: string; itemId: string; audioPath: string; audioSha256: string; transcript: string; deliveryReport: string; now: string }): boolean {
      return db.transaction(() => {
        const j = db.prepare("SELECT * FROM transcription_jobs WHERE id=?").get(i.jobId) as TranscriptionJobRow | undefined;
        const item = db.prepare("SELECT response_audio_path, scoring_status FROM item_results WHERE attempt_id=? AND item_id=?").get(i.attemptId, i.itemId) as { response_audio_path: string | null; scoring_status: string } | undefined;
        if (
          !j || j.status === "superseded" || j.status === "done" ||
          j.attempt_id !== i.attemptId || j.item_id !== i.itemId ||
          resolveAudioPath(j.audio_path) !== resolveAudioPath(i.audioPath) || j.audio_sha256 !== i.audioSha256 ||
          !item || item.scoring_status !== "transcription_pending" ||
          resolveAudioPath(item.response_audio_path ?? "") !== resolveAudioPath(i.audioPath)
        ) return false;
        // The job write carries updateTranscriptionJob's guard, so it can never move a superseded or
        // done job; the Item write after it carries its own.
        const awaiting = db.prepare("UPDATE transcription_jobs SET status='awaiting_score',next_retry_at=NULL,failure_kind=NULL,error=NULL,updated_at=? WHERE id=? AND status NOT IN ('superseded','done')").run(i.now, i.jobId);
        if (awaiting.changes !== 1) return false;
        db.prepare("UPDATE item_results SET transcript=?,delivery_report=?,scoring_status='pending' WHERE attempt_id=? AND item_id=? AND scoring_status='transcription_pending'").run(i.transcript, i.deliveryReport, i.attemptId, i.itemId);
        return true;
      })();
    },
    // The success path of a fresh admission whose first Ears call answered: the transcript and the
    // job's 'done' land in one transaction, so a crash never leaves the Item holding a transcript
    // beside a job still 'running'. Unlike persistRecoveredTranscriptAndAwaitScore (the durable-retry
    // path, which lands on 'awaiting_score' so a scoring job is created and linked), the Item lands at
    // plain 'pending', for the caller's ordinary scoring flow.
    //
    // A fresh Ears call can finish after another take has superseded it, so the job must still be the
    // newest non-superseded one and 'running' inside the same transaction. A false return is part of
    // the contract: the caller must not report a stale transcript as a successful admission.
    persistFreshTranscriptAndFinishJob(i: { jobId: string; attemptId: string; itemId: string; taskType: string; responseAudioPath: string; audioSha256: string; transcript: string; deliveryReport: string; now: string }): boolean {
      return db.transaction(() => {
        const current = db.prepare("SELECT * FROM transcription_jobs WHERE attempt_id=? AND item_id=? AND status!='superseded' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(i.attemptId, i.itemId) as TranscriptionJobRow | undefined;
        if (
          !current ||
          current.id !== i.jobId ||
          current.status !== "running" ||
          current.task_type !== i.taskType ||
          current.audio_sha256 !== i.audioSha256 ||
          resolveAudioPath(current.audio_path) !== resolveAudioPath(i.responseAudioPath)
        ) return false;

        const finished = db.prepare("UPDATE transcription_jobs SET status='done',updated_at=? WHERE id=? AND status='running'").run(i.now, i.jobId);
        if (finished.changes !== 1) return false;
        db.prepare(ITEM_RESULT_UPSERT_SQL).run(i.attemptId, i.itemId, i.taskType, null, i.responseAudioPath, i.transcript, i.deliveryReport, "pending");
        return true;
      })();
    },
    // Items waiting on a transcription that no current job will ever produce: 'transcription_pending'
    // with no non-superseded transcription_jobs row. Recordings saved before transcription_jobs
    // existed are the population this finds.
    listTranscriptionPendingItemsWithoutJob(): { attemptId: string; itemId: string; taskType: string; responseAudioPath: string | null }[] {
      return db.prepare(
        `SELECT ir.attempt_id AS attemptId, ir.item_id AS itemId, ir.task_type AS taskType, ir.response_audio_path AS responseAudioPath
         FROM item_results ir
         WHERE ir.scoring_status='transcription_pending'
           AND NOT EXISTS (
             SELECT 1 FROM transcription_jobs tj
             WHERE tj.attempt_id=ir.attempt_id AND tj.item_id=ir.item_id AND tj.status!='superseded'
           )
         ORDER BY ir.attempt_id, ir.rowid`
      ).all() as { attemptId: string; itemId: string; taskType: string; responseAudioPath: string | null }[];
    },
    // Gives such an Item a job to retry: born 'failed' with a retryable failure kind, so the User's
    // Retry is what spends the Ears call. Refuses (false) when a row for these exact bytes exists.
    insertFailedTranscriptionJob(i: { id: string; attemptId: string; itemId: string; taskType: "listen_repeat" | "interview"; audioPath: string; audioSha256: string; failureKind: TranscriptionFailureKind; error: string; now: string }): boolean {
      return db.prepare(
        `INSERT INTO transcription_jobs (id,attempt_id,item_id,task_type,audio_path,audio_sha256,status,failure_kind,error,created_at,updated_at)
         VALUES (?,?,?,?,?,?,'failed',?,?,?,?) ON CONFLICT(attempt_id,item_id,audio_sha256) DO NOTHING`
      ).run(i.id, i.attemptId, i.itemId, i.taskType, i.audioPath, i.audioSha256, i.failureKind, i.error, i.now, i.now).changes === 1;
    },
  } satisfies Omit<TranscriptionJobStore, "getAttempt" | "insertItemResult"> & TranscriptionBootStore;
}

// ---------------------------------------------------------------------------------------------
// The recording-publication read, over SQLite
// ---------------------------------------------------------------------------------------------
//
// The one `transcription_jobs` read recording intake makes: "are these bytes a take a later
// re-record already replaced?". A separate adapter from the one above, because intake must not reach
// a transcription job's writers. The per-Item publication lock is intake's own and in memory
// (recordingIntake.ts says why).

export function createSqliteRecordingStore(db: Database.Database) {
  return {
    // Asked by recording intake before it replaces the canonical media pair, while it holds that
    // Item's publication lock. A known historical hash is safe only while its own row is still the
    // newest non-superseded job for the Item; otherwise replaying those bytes would briefly make the
    // files disagree with the current transcript and job.
    isSupersededTranscriptionHash(i: { attemptId: string; itemId: string; audioSha256: string }): boolean {
      const matching = db.prepare("SELECT id FROM transcription_jobs WHERE attempt_id=? AND item_id=? AND audio_sha256=?").get(i.attemptId, i.itemId, i.audioSha256) as { id: string } | undefined;
      if (!matching) return false;
      const current = db.prepare("SELECT id FROM transcription_jobs WHERE attempt_id=? AND item_id=? AND status!='superseded' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(i.attemptId, i.itemId) as { id: string } | undefined;
      return current?.id !== matching.id;
    },
  } satisfies RecordingStore;
}
