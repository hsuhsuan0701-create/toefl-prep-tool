import type Database from "better-sqlite3";
import type { CancellationRequestResult, ScoringJobRow, TranscriptionJobRow } from "../rows.js";
import type { DurableJobClaim } from "../../services/durableJobRunner.js";
import type { CancellationReason } from "@toefl-prep/shared";
import type { ScoringBootStore, ScoringJobStore } from "../../services/scoringJobs.js";
import type { ScoringPersistenceOperation } from "../../services/scoringPersistence.js";
import { createCompletedAttemptEstimateRefresh } from "./attempts.js";

// ---------------------------------------------------------------------------------------------
// The scoring-job aggregate, over SQLite
// ---------------------------------------------------------------------------------------------
//
// Table: `scoring_jobs`, plus the multi-table transactions scoringJobs.ts's port doc explains cannot
// be split: `createRecoveryScoringJobAndLink` (creates the job and closes the transcription job that
// hands off to it), `replaceScoringJobAndSupersede` (creates the new row while terminalizing the old
// ones), and `completeScoringJobAtomically` and `failScoringJobConditional` (commit a run's buffered
// writes, and the Band Estimate of an Attempt that is already completed, only inside the transaction
// that wins its terminal 'done' or 'failed'). Each stays one call: the transaction wins over the
// aggregate boundary.
//
// `listPendingItemsWithTranscript` anti-joins `item_results` against `transcription_jobs` and stays
// one query for the same reason: the join is the correctness argument.
//
// Every conditional writer reports whether it won, and nothing here is async: better-sqlite3 is
// synchronous, and several of these arguments depend on there being no `await` between two
// statements.

// Which provider is serving a job (`openaiJudgeProvider`, `arbiterProvider`, `fallbackFrom`) is live
// progress, shown only while the job runs: provider names stay out of score-bearing state and out of
// what a finished job serves. Every write that ends a job drops them from its progress in the same
// statement, and a progress checkpoint is written only while the job is still queued or running.
const PROGRESS_WITHOUT_PROVIDERS =
  "progress=CASE WHEN json_valid(progress) THEN json_remove(progress,'$.openaiJudgeProvider','$.arbiterProvider','$.fallbackFrom') ELSE progress END";

export function createSqliteScoringJobStore(db: Database.Database) {
  const recomputeEstimateIfCompleted = createCompletedAttemptEstimateRefresh(db);

  // What a terminal write that won commits with it: the run's buffered writes, then the Band
  // Estimate of the job's Attempt if that Attempt is already completed (a re-score, or a job that
  // outlived /complete). One transaction, so a band never describes scores other than the stored ones.
  function commitRunWrites(jobId: string, operations: readonly ScoringPersistenceOperation[], now: string): void {
    applyScoringOperations(operations, now);
    const job = db.prepare("SELECT attempt_id FROM scoring_jobs WHERE id=?").get(jobId) as { attempt_id: string };
    recomputeEstimateIfCompleted(job.attempt_id);
  }

  // A run's buffered Judge Report and Item score writes, in order. Called only inside the
  // transaction of the terminal write ('done' or 'failed') that this run won.
  function applyScoringOperations(operations: readonly ScoringPersistenceOperation[], now: string): void {
    const deleteReports=db.prepare("DELETE FROM judge_reports WHERE attempt_id=? AND item_id=?");
    const insertReport=db.prepare("INSERT INTO judge_reports(attempt_id,item_id,judge,report_json) VALUES(?,?,?,?)");
    const updateScore=db.prepare("UPDATE item_results SET score=?,score_json=?,scoring_status=?,scored_at=CASE WHEN ?='scored' THEN ? ELSE NULL END WHERE attempt_id=? AND item_id=?");
    for(const operation of operations){
      if(operation.kind==="delete-judge-reports")deleteReports.run(operation.attemptId,operation.itemId);
      else if(operation.kind==="insert-judge-report")insertReport.run(operation.attemptId,operation.itemId,operation.judge,operation.reportJson);
      else updateScore.run(operation.score,operation.scoreJson,operation.scoringStatus,operation.scoringStatus,now,operation.attemptId,operation.itemId);
    }
  }

  return {
    getScoringJob(id: string): ScoringJobRow | undefined {
      return db.prepare("SELECT * FROM scoring_jobs WHERE id=?").get(id) as ScoringJobRow | undefined;
    },
    listActiveScoringJobsForTask(attemptId: string, taskType: string): ScoringJobRow[] { return db.prepare("SELECT * FROM scoring_jobs WHERE attempt_id=? AND task_type=? AND status IN ('queued','running') ORDER BY created_at,rowid").all(attemptId,taskType) as ScoringJobRow[]; },
    // Queued or running jobs for one Attempt: AttemptDetailVM.activeJobs, which lets a client returning
    // to the page re-attach to live progress.
    listActiveJobs(attemptId: string): ScoringJobRow[] {
      return db.prepare(
        `SELECT * FROM scoring_jobs WHERE attempt_id=? AND status IN ('queued','running')
         ORDER BY created_at, rowid`
      ).all(attemptId) as ScoringJobRow[];
    },
    // Every job still queued or running, across all Attempts. Read only at boot (failInterruptedJobs in
    // scoringJobs.ts): a job in this state then was orphaned by the previous process.
    listInterruptedJobs(): ScoringJobRow[] {
      return db.prepare("SELECT * FROM scoring_jobs WHERE status IN ('queued','running')").all() as ScoringJobRow[];
    },
    // Every job row, whatever its status, for boot's orphan sweep: it needs every (attempt, item) pair
    // any job has ever covered, to tell a stray 'pending' Item no job tracks apart from one whose job
    // simply finished, failed or was superseded.
    listAllScoringJobs(): ScoringJobRow[] {
      return db.prepare("SELECT * FROM scoring_jobs ORDER BY created_at, rowid").all() as ScoringJobRow[];
    },
    // listAllScoringJobs for one Attempt, in the same (created_at, rowid) order. Speaking finalization
    // asks "is this Item covered by any job" on every scoring-terminal callback, so it must not scan
    // the whole table's history; the global form stays for boot's sweep.
    listScoringJobsForAttempt(attemptId: string): ScoringJobRow[] {
      return db.prepare("SELECT * FROM scoring_jobs WHERE attempt_id=? ORDER BY created_at, rowid").all(attemptId) as ScoringJobRow[];
    },
    // item_results rows still 'pending' that hold a transcript: Speaking Items transcribed and waiting
    // for a scoring pass. Boot's orphan sweep checks them against listAllScoringJobs() for Items no job
    // covers.
    //
    // Excludes an Item whose current transcription job is 'awaiting_score':
    // persistRecoveredTranscriptAndAwaitScore leaves such an Item 'pending' with a transcript and,
    // until createRecoveryScoringJobAndLink runs in a later call, no scoring job. It is the
    // transcription family's to settle (the boot sweep closes its handoff), not an orphan.
    listPendingItemsWithTranscript(): { attemptId: string; itemId: string }[] {
      return db.prepare(
        `SELECT ir.attempt_id AS attemptId, ir.item_id AS itemId FROM item_results ir
         WHERE ir.scoring_status='pending' AND ir.transcript IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM transcription_jobs tj
             WHERE tj.attempt_id = ir.attempt_id AND tj.item_id = ir.item_id AND tj.status = 'awaiting_score'
           )`
      ).all() as { attemptId: string; itemId: string }[];
    },
    // Every Item still unscored that holds a transcript, across all Attempts — boot's candidates for
    // a no-speech 0 (scoringJobs.ts's scoreSilentItemsLeftUnscored), which decides in JS with the
    // shared spokenResponseState rule rather than SQLite's narrower notion of whitespace.
    listUnscoredItemsWithTranscript(): { attemptId: string; itemId: string; scoring_status: string; transcript: string }[] {
      return db.prepare(
        `SELECT attempt_id AS attemptId, item_id AS itemId, scoring_status, transcript FROM item_results
         WHERE scoring_status IN ('pending','failed') AND transcript IS NOT NULL
         ORDER BY attempt_id, rowid`
      ).all() as { attemptId: string; itemId: string; scoring_status: string; transcript: string }[];
    },
    // Three outcomes. `undefined`: launch nothing, because this transcription job is not the current
    // awaiting_score job for the Attempt, Item and Task Type, or an active scoring job already covers
    // that Attempt and Task Type. `{created:false, scoreJobId}`: a scoring job is already linked to this
    // transcription job (a replay, or the job has since moved on to 'done'); reuse it. `{created:true,
    // scoreJobId}`: a new scoring job was inserted and linked in this call, and the caller must launch
    // its runner. The already-linked check runs before the awaiting_score check so reuse stays
    // reachable after the transcription job reaches 'done'.
    //
    // `undefined` therefore means either "wait: same-Task-Type work is active" or "never: not
    // eligible". The caller (transcriptionRecovery.ts, through enqueueScoringJob) checks
    // listActiveScoringJobsForTask first, so from this call it means the second; a caller that skipped
    // that check would read a temporary wait as permanent.
    createRecoveryScoringJobAndLink(i: { transcriptionJobId: string; scoringJobId: string; attemptId: string; taskType: "listen_repeat" | "interview"; itemId: string; now: string }): { created: boolean; scoreJobId: string } | undefined { return db.transaction(() => { const j=db.prepare("SELECT * FROM transcription_jobs WHERE id=?").get(i.transcriptionJobId) as TranscriptionJobRow|undefined; if (!j || j.attempt_id!==i.attemptId || j.item_id!==i.itemId || j.task_type!==i.taskType) return undefined; if (j.score_job_id) return {created:false,scoreJobId:j.score_job_id}; if (j.status!=="awaiting_score") return undefined; if (db.prepare("SELECT id FROM scoring_jobs WHERE attempt_id=? AND task_type=? AND status IN ('queued','running') LIMIT 1").get(i.attemptId,i.taskType)) return undefined; db.prepare("INSERT INTO scoring_jobs (id,attempt_id,task_type,item_ids,status,created_at,updated_at) VALUES (?,?,?,?, 'queued',?,?)").run(i.scoringJobId,i.attemptId,i.taskType,JSON.stringify([i.itemId]),i.now,i.now); db.prepare("UPDATE transcription_jobs SET score_job_id=?,status='done',updated_at=? WHERE id=?").run(i.scoringJobId,i.now,i.transcriptionJobId); return {created:true,scoreJobId:i.scoringJobId}; })(); },
    // The stage alone, written only while the job is queued or running. It touches no status,
    // result or error column, so no job ends through it.
    setScoringJobStage(i:{id:string;stage:string}):boolean {
      return db.prepare("UPDATE scoring_jobs SET stage=?,updated_at=datetime('now') WHERE id=? AND status IN ('queued','running')").run(i.stage,i.id).changes===1;
    },
    // A running job's progress checkpoint. Conditional on the job still being live, so a run that was
    // superseded or cancelled while it kept working cannot put its stage or its providers back on a
    // finished row.
    saveScoringJobProgress(i:{id:string;stage:string|null;progress:string|null}):boolean {
      return db.prepare("UPDATE scoring_jobs SET stage=?,progress=?,updated_at=datetime('now') WHERE id=? AND status IN ('queued','running')").run(i.stage,i.progress,i.id).changes===1;
    },
    // The read and the guarded stamp are one transaction, as in requestGenerationJobCancellation, and
    // the answer comes from the stamp's change count: when it changes nothing, the row as it now
    // stands is reported rather than the request the read assumed would land.
    requestScoringJobCancellation(i:{id:string;reason:CancellationReason;now:string}):CancellationRequestResult|undefined {
      return db.transaction((): CancellationRequestResult|undefined => {
        const read=()=>db.prepare("SELECT status,cancel_requested_at FROM scoring_jobs WHERE id=?").get(i.id) as {status:string;cancel_requested_at:string|null}|undefined;
        const answered=(row:{status:string;cancel_requested_at:string|null}):CancellationRequestResult|null => {
          if(row.status==="cancelled"||row.cancel_requested_at)return {accepted:true,state:row.status==="cancelled"?"cancelled":"cancel_requested"};
          if(!["queued","running"].includes(row.status))return {accepted:false,state:"terminal"};
          return null;
        };
        const row=read();
        if(!row)return undefined;
        const settled=answered(row);
        if(settled)return settled;
        const won=db.prepare("UPDATE scoring_jobs SET cancel_requested_at=?,cancellation_reason=?,updated_at=? WHERE id=? AND status IN ('queued','running') AND cancel_requested_at IS NULL").run(i.now,i.reason,i.now,i.id).changes===1;
        if(won)return {accepted:true,state:"cancel_requested"};
        const after=read();
        // A live row the guarded write still could not stamp is not one this request cancelled.
        return after?(answered(after)??{accepted:false,state:"terminal"}):undefined;
      })();
    },
    finishScoringJobCancellation(i:{id:string;now:string}):boolean {
      return db.prepare(`UPDATE scoring_jobs SET status='cancelled',cancelled_at=?,terminal_at=?,updated_at=?,${PROGRESS_WITHOUT_PROVIDERS} WHERE id=? AND status IN ('queued','running') AND cancel_requested_at IS NOT NULL`).run(i.now,i.now,i.now,i.id).changes===1;
    },
    // Scoring's counterpart to claimGenerationJobRunning, with the same three-valued contract: a
    // conditional 'queued' -> 'running' write that refuses a row carrying a cancel stamp, so a job
    // cancelled before it started never runs a paid Judge or Arbiter pass. `stage` rides in the same
    // write, so the claim and the first stage the poller sees are one write.
    claimScoringJobRunning(i:{id:string;stage?:string|null;now:string}):DurableJobClaim {
      return db.transaction((): DurableJobClaim => {
        if(db.prepare("UPDATE scoring_jobs SET status='running',stage=?,updated_at=? WHERE id=? AND status='queued' AND cancel_requested_at IS NULL").run(i.stage??null,i.now,i.id).changes===1)return "claimed";
        const row=db.prepare("SELECT status,cancel_requested_at FROM scoring_jobs WHERE id=?").get(i.id) as {status:string;cancel_requested_at:string|null}|undefined;
        return row?.status==="queued"&&row.cancel_requested_at?"cancel_requested":"unclaimable";
      })();
    },
    // The 'failed' terminal write, conditional and reporting whether it won, as
    // failGenerationJobConditional is: a cancel that lands first is not overwritten with an
    // incidental error. A failing run's buffered writes ride in the same transaction and land only
    // if it wins, so a run that no longer owns its job writes nothing to its Items.
    failScoringJobConditional(i:{id:string;error:string;now:string;operations?:ScoringPersistenceOperation[]}):boolean {
      return db.transaction(() => {
        const won=db.prepare(`UPDATE scoring_jobs SET status='failed',error=?,terminal_at=?,updated_at=?,${PROGRESS_WITHOUT_PROVIDERS} WHERE id=? AND status IN ('queued','running') AND cancel_requested_at IS NULL`).run(i.error,i.now,i.now,i.id).changes===1;
        if(won)commitRunWrites(i.id,i.operations??[],i.now);
        return won;
      })();
    },
    replaceScoringJobAndSupersede(i:{id:string;attemptId:string;taskType:string;itemIds:string[];now:string}):string[] {
      return db.transaction(() => {
        const prior=db.prepare("SELECT id FROM scoring_jobs WHERE attempt_id=? AND task_type=? AND status IN ('queued','running') ORDER BY created_at,rowid").all(i.attemptId,i.taskType) as {id:string}[];
        db.prepare(`UPDATE scoring_jobs SET status='cancelled',cancel_requested_at=COALESCE(cancel_requested_at,?),cancelled_at=COALESCE(cancelled_at,?),cancellation_reason='superseded',terminal_at=?,updated_at=?,${PROGRESS_WITHOUT_PROVIDERS}
          WHERE attempt_id=? AND task_type=? AND status IN ('queued','running')`).run(i.now,i.now,i.now,i.now,i.attemptId,i.taskType);
        db.prepare("INSERT INTO scoring_jobs(id,attempt_id,task_type,item_ids,status,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?)").run(i.id,i.attemptId,i.taskType,JSON.stringify(i.itemIds),i.now,i.now);
        return prior.map(x=>x.id);
      })();
    },
    completeScoringJobAtomically(i:{id:string;result:string;operations:ScoringPersistenceOperation[];now:string}):boolean {
      return db.transaction(() => {
        const won=db.prepare(`UPDATE scoring_jobs SET status='done',result=?,terminal_at=?,updated_at=?,${PROGRESS_WITHOUT_PROVIDERS} WHERE id=? AND status IN ('queued','running') AND cancel_requested_at IS NULL`).run(i.result,i.now,i.now,i.id).changes===1;
        if(won)commitRunWrites(i.id,i.operations,i.now);
        return won;
      })();
    },
  } satisfies ScoringJobStore & ScoringBootStore;
}
