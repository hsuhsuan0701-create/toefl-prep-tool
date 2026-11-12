import { describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import { sqliteStores, sqliteStoreHalves } from "./helpers/sqliteStores.js";
import { sqliteTimestamp } from "../src/db/timestamps.js";
import { at } from "./helpers/timestamps.js";

// The SQL-level suite for the per-aggregate SQLite stores. It goes through helpers/sqliteStores.ts,
// a composition of the real adapters, because a single case here routinely spans several
// aggregates: create an Attempt, upload an Item, run a scoring job, read a Band Estimate back. Every
// statement it exercises is the statement production runs, except the few that helper marks
// test-only.
describe("the SQLite stores", () => {
  it("durably coordinates transcription recovery jobs without stale writes", () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    r.createAttempt({ id: "recovery-attempt", kind: "speaking", mode: "simulation", setId: "spk-1", isRepeat: false });
    r.insertItemResult({ attemptId: "recovery-attempt", itemId: "lr-1", taskType: "listen_repeat", responseAudioPath: "recordings/old.webm", scoringStatus: "transcription_pending" });

    const old = r.createOrGetTranscriptionJob({ id: "old", attemptId: "recovery-attempt", itemId: "lr-1", taskType: "listen_repeat", audioPath: "recordings/old.webm", audioSha256: "a".repeat(64), now: "2026-07-30T00:00:00.000Z" });
    expect(r.createOrGetTranscriptionJob({ id: "duplicate", attemptId: "recovery-attempt", itemId: "lr-1", taskType: "listen_repeat", audioPath: "recordings/old.webm", audioSha256: "a".repeat(64), now: "2026-07-30T00:00:01.000Z" }).id).toBe(old.id);
    // The same-hash resubmission returned the existing job untouched: its own reuse did not flip it
    // to 'superseded' or any other status.
    expect(r.getTranscriptionJob(old.id)?.status).toBe("queued");
    expect(r.claimTranscriptionJob({ id: old.id, now: "2026-07-30T00:00:02.000Z" })?.status).toBe("running");
    expect(r.claimTranscriptionJob({ id: old.id, now: "2026-07-30T00:00:03.000Z" })).toBeUndefined();
    expect(r.listInterruptedTranscriptionJobs().map((j) => j.id)).toEqual([old.id]);
    r.updateTranscriptionJob({ id: old.id, status: "retry_wait", automaticAttempts: 1, nextRetryAt: "2026-07-30T00:01:00.000Z", now: "2026-07-30T00:00:04.000Z" });
    expect(r.listRecoverableTranscriptionJobs("2026-07-30T00:00:59.000Z")).toEqual([]);
    expect(r.listRecoverableTranscriptionJobs("2026-07-30T00:01:00.000Z").map((j) => j.id)).toEqual([old.id]);

    r.insertItemResult({ attemptId: "recovery-attempt", itemId: "lr-1", taskType: "listen_repeat", responseAudioPath: "recordings/new.webm", scoringStatus: "transcription_pending" });
    const current = r.createOrGetTranscriptionJob({ id: "new", attemptId: "recovery-attempt", itemId: "lr-1", taskType: "listen_repeat", audioPath: "recordings/new.webm", audioSha256: "b".repeat(64), now: "2026-07-30T00:02:00.000Z" });
    expect(r.getTranscriptionJob(old.id)?.status).toBe("superseded");
    expect(r.persistRecoveredTranscriptAndAwaitScore({ jobId: old.id, attemptId: "recovery-attempt", itemId: "lr-1", audioPath: "recordings/old.webm", audioSha256: "a".repeat(64), transcript: "stale", deliveryReport: "{}", now: "2026-07-30T00:02:02.000Z" })).toBe(false);
    expect(r.persistRecoveredTranscriptAndAwaitScore({ jobId: current.id, attemptId: "recovery-attempt", itemId: "lr-1", audioPath: "recordings/new.webm", audioSha256: "b".repeat(64), transcript: "current", deliveryReport: "{}", now: "2026-07-30T00:02:03.000Z" })).toBe(true);
    expect(r.getAttempt("recovery-attempt")?.items[0].transcript).toBe("current");
    expect(r.getTranscriptionJob(current.id)?.status).toBe("awaiting_score");
    expect(r.createRecoveryScoringJobAndLink({ transcriptionJobId: current.id, scoringJobId: "score-1", attemptId: "recovery-attempt", taskType: "listen_repeat", itemId: "lr-1", now: "2026-07-30T00:02:04.000Z" })).toEqual({ created: true, scoreJobId: "score-1" });
    expect(r.createRecoveryScoringJobAndLink({ transcriptionJobId: current.id, scoringJobId: "score-2", attemptId: "recovery-attempt", taskType: "listen_repeat", itemId: "lr-1", now: "2026-07-30T00:02:05.000Z" })).toEqual({ created: false, scoreJobId: "score-1" });
    expect(r.listActiveScoringJobsForTask("recovery-attempt", "listen_repeat").map((j) => j.id)).toEqual(["score-1"]);
  });

  it("atomically admits a new recording and supersedes its older active recovery", () => {
    const db = openDb(":memory:"); const r = sqliteStores(db);
    r.createAttempt({ id: "atomic", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    r.createOrGetTranscriptionJob({ id: "old", attemptId: "atomic", itemId: "item", taskType: "interview", audioPath: "old.webm", audioSha256: "a".repeat(64), now: "now" });
    db.exec("CREATE TRIGGER reject_supersede BEFORE UPDATE OF status ON transcription_jobs WHEN OLD.id='old' BEGIN SELECT RAISE(ABORT, 'stop'); END");
    expect(() => r.createOrGetTranscriptionJob({ id: "new", attemptId: "atomic", itemId: "item", taskType: "interview", audioPath: "new.webm", audioSha256: "b".repeat(64), now: "later" })).toThrow("stop");
    expect(r.getTranscriptionJob("new")).toBeUndefined();
    expect(r.getTranscriptionJob("old")?.status).toBe("queued");
  });

  it("does not let a resubmission of an older, superseded recording take the active status from the current job", () => {
    const db = openDb(":memory:"); const r = sqliteStores(db);
    r.createAttempt({ id: "stale-reuse", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    const a = r.createOrGetTranscriptionJob({ id: "a", attemptId: "stale-reuse", itemId: "item", taskType: "interview", audioPath: "a.webm", audioSha256: "a".repeat(64), now: "t0" });
    const b = r.createOrGetTranscriptionJob({ id: "b", attemptId: "stale-reuse", itemId: "item", taskType: "interview", audioPath: "b.webm", audioSha256: "b".repeat(64), now: "t1" });
    expect(r.getTranscriptionJob(a.id)?.status).toBe("superseded");
    expect(r.getTranscriptionJob(b.id)?.status).toBe("queued");

    // Resubmitting the older, superseded hash reuses A's own row (the insert hits `ON CONFLICT DO
    // NOTHING`) and leaves B alone. The supersede sweep runs only when the insert added a row
    // (`inserted.changes`); run on a reuse, it would keep A and mark B, the current job, superseded.
    const reused = r.createOrGetTranscriptionJob({ id: "a-again", attemptId: "stale-reuse", itemId: "item", taskType: "interview", audioPath: "a.webm", audioSha256: "a".repeat(64), now: "t2" });
    expect(reused.id).toBe(a.id);
    expect(r.getTranscriptionJob(b.id)?.status).toBe("queued");
    expect(r.getTranscriptionJob(a.id)?.status).toBe("superseded");
  });

  it("persistRecoveredTranscriptAndAwaitScore refuses to flip an already-scored item back to pending on a stale retry, even when the caller's audioPath and hash match the job's own (immutable) columns", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "stale-recover", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    // The shape transcription recovery writes when it claims a fresh job, before its first Ears
    // call: 'transcription_pending', audio path set, no transcript yet. It is the one scoring_status
    // a durable job's Item has while the job runs (judgeEnsemble.ts's `admit` refuses to score it,
    // with TranscriptionPending).
    r.insertItemResult({ attemptId: "stale-recover", itemId: "lr-3", taskType: "listen_repeat", responseAudioPath: "audio/responses/stale-recover/lr-3.webm", scoringStatus: "transcription_pending" });
    const job = r.createOrGetTranscriptionJob({ id: "j1", attemptId: "stale-recover", itemId: "lr-3", taskType: "listen_repeat", audioPath: "audio/responses/stale-recover/lr-3.webm", audioSha256: "a".repeat(64), now: "t0" });
    r.updateTranscriptionJob({ id: job.id, status: "retry_wait", automaticAttempts: 1, nextRetryAt: "t1", now: "t1" });

    // The Item is scored by another path (a re-recording that transcribed at once, or an ordinary
    // scoring pass). response_audio_path does not change, because the upload route writes every
    // take of an Item to the same audio/responses/<attemptId>/<itemId>.webm, so the job's own
    // path and hash comparisons cannot detect it.
    r.updateItemScore({ attemptId: "stale-recover", itemId: "lr-3", score: 4, scoreJson: '{"finalScore":4}', scoringStatus: "scored" });

    // j1's stale retry now completes. Its own audio_path and audio_sha256 columns are immutable, so
    // it passes every path and hash guard.
    const result = r.persistRecoveredTranscriptAndAwaitScore({ jobId: job.id, attemptId: "stale-recover", itemId: "lr-3", audioPath: "audio/responses/stale-recover/lr-3.webm", audioSha256: "a".repeat(64), transcript: "stale transcript", deliveryReport: "{}", now: "t2" });

    expect(result).toBe(false);
    const item = r.getAttempt("stale-recover")?.items.find((it) => it.item_id === "lr-3");
    expect(item?.scoring_status).toBe("scored");
    expect(item?.score).toBe(4);
    expect(item?.transcript).toBeNull(); // the stale UPDATE never ran
    expect(r.getTranscriptionJob(job.id)?.status).toBe("retry_wait"); // never flipped to awaiting_score
  });

  it("persistRecoveredTranscriptAndAwaitScore never moves a job another path already ended 'done', and then writes nothing to its Item either", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "ended", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    r.insertItemResult({ attemptId: "ended", itemId: "lr-1", taskType: "listen_repeat", responseAudioPath: "audio/responses/ended/lr-1.webm", scoringStatus: "transcription_pending" });
    const job = r.createOrGetTranscriptionJob({ id: "j-ended", attemptId: "ended", itemId: "lr-1", taskType: "listen_repeat", audioPath: "audio/responses/ended/lr-1.webm", audioSha256: "a".repeat(64), now: "t0" });
    r.claimTranscriptionJob({ id: job.id, now: "t1" });
    // Ended while this run was still waiting on Ears.
    r.updateTranscriptionJob({ id: job.id, status: "done", now: "t2" });

    expect(r.persistRecoveredTranscriptAndAwaitScore({ jobId: job.id, attemptId: "ended", itemId: "lr-1", audioPath: "audio/responses/ended/lr-1.webm", audioSha256: "a".repeat(64), transcript: "late transcript", deliveryReport: "{}", now: "t3" })).toBe(false);
    expect(r.getTranscriptionJob(job.id)?.status).toBe("done");
    expect(r.getAttempt("ended")?.items[0]).toMatchObject({ scoring_status: "transcription_pending", transcript: null });
  });

  it("updateTranscriptionJob refuses to write over a superseded or done job — an ordinary failure/retry-scheduling write cannot resurrect a job the supersede sweep already moved on from", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "resurrect", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    const old = r.createOrGetTranscriptionJob({ id: "old", attemptId: "resurrect", itemId: "item", taskType: "interview", audioPath: "old.webm", audioSha256: "a".repeat(64), now: "t0" });
    r.claimTranscriptionJob({ id: old.id, now: "t1" }); // 'running': a worker waits on Ears
    // A new recording preempts it while the worker is still in flight.
    r.createOrGetTranscriptionJob({ id: "new", attemptId: "resurrect", itemId: "item", taskType: "interview", audioPath: "new.webm", audioSha256: "b".repeat(64), now: "t2" });
    expect(r.getTranscriptionJob(old.id)?.status).toBe("superseded");

    // The worker's Ears call for `old` returns and takes its ordinary failure-scheduling path. An
    // unguarded UPDATE would move `old` back to 'retry_wait', undoing the supersede and putting it
    // back into every recoverable-job lookup.
    r.updateTranscriptionJob({ id: old.id, status: "retry_wait", automaticAttempts: 1, nextRetryAt: "t3", now: "t3" });
    expect(r.getTranscriptionJob(old.id)?.status).toBe("superseded");
  });

  // A test-only statement (helpers/sqliteStores.ts). The guard production runs is pinned by
  // `updateTranscriptionJob` in the case above and by `createRecoveryScoringJobAndLink`, which is
  // where production links a score job; this case re-checks the same `WHERE status NOT IN (...)`
  // clause on the helper's statement, and does not by itself cover any shipped path.
  it("linkTranscriptionScoreJob refuses to write over a superseded or done job", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "link-resurrect", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    const old = r.createOrGetTranscriptionJob({ id: "old", attemptId: "link-resurrect", itemId: "item", taskType: "interview", audioPath: "old.webm", audioSha256: "a".repeat(64), now: "t0" });
    r.createOrGetTranscriptionJob({ id: "new", attemptId: "link-resurrect", itemId: "item", taskType: "interview", audioPath: "new.webm", audioSha256: "b".repeat(64), now: "t1" });
    expect(r.getTranscriptionJob(old.id)?.status).toBe("superseded");
    expect(r.getTranscriptionJob(old.id)?.score_job_id).toBeNull();

    r.createScoringJob({ id: "score-stale", attemptId: "link-resurrect", taskType: "interview", itemIds: ["item"] });
    r.linkTranscriptionScoreJob({ jobId: old.id, scoreJobId: "score-stale", now: "t2" });
    expect(r.getTranscriptionJob(old.id)?.score_job_id).toBeNull(); // write refused; superseded row untouched
  });

  it("updateTranscriptionJob's automatic_attempts increment is a race-free SQL-level +1, immune to a lost-update race between two concurrent writers reading the same stale count", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "attempt-counter", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    const job = r.createOrGetTranscriptionJob({ id: "j", attemptId: "attempt-counter", itemId: "item", taskType: "interview", audioPath: "a.webm", audioSha256: "a".repeat(64), now: "t0" });
    expect(r.getTranscriptionJob(job.id)?.automatic_attempts).toBe(0);

    // Two writers each record one attempt. better-sqlite3 is synchronous, so they run one after the
    // other here; the point is that neither passes a count. A writer that computed "current + 1"
    // from its own snapshot would let two racing writers both write 1, while the SQL-level
    // increment counts both.
    r.updateTranscriptionJob({ id: job.id, automaticAttempts: 1, now: "t1" });
    r.updateTranscriptionJob({ id: job.id, automaticAttempts: 1, now: "t2" });
    expect(r.getTranscriptionJob(job.id)?.automatic_attempts).toBe(2);
  });

  it("the transcription_jobs CHECK constraint rejects status='retry_wait' with a NULL next_retry_at — that combination is invisible to every recoverable-job lookup query, stranding an accepted recording across every restart", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "limbo-attempt", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    const job = r.createOrGetTranscriptionJob({ id: "j", attemptId: "limbo-attempt", itemId: "item", taskType: "interview", audioPath: "a.webm", audioSha256: "a".repeat(64), now: "t0" });

    // The likely accident: a caller sets status='retry_wait' and omits nextRetryAt.
    // updateTranscriptionJob's partial update leaves next_retry_at NULL from creation, which is
    // exactly the stranded shape.
    expect(() => r.updateTranscriptionJob({ id: job.id, status: "retry_wait", now: "t1" })).toThrow();
    expect(r.getTranscriptionJob(job.id)?.status).toBe("queued"); // the bad write did not partially apply

    // retry_wait with a next_retry_at is accepted.
    expect(() => r.updateTranscriptionJob({ id: job.id, status: "retry_wait", nextRetryAt: "t2", now: "t1" })).not.toThrow();
    expect(r.getTranscriptionJob(job.id)?.status).toBe("retry_wait");
    expect(r.getTranscriptionJob(job.id)?.next_retry_at).toBe("t2");
  });

  it("transcription_jobs.failure_kind CHECK constraint rejects a value outside the 11-value TranscriptionFailureKind union", () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    r.createAttempt({ id: "failure-kind-attempt", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    const job = r.createOrGetTranscriptionJob({ id: "j", attemptId: "failure-kind-attempt", itemId: "item", taskType: "interview", audioPath: "a.webm", audioSha256: "a".repeat(64), now: "t0" });
    expect(() =>
      db.prepare("UPDATE transcription_jobs SET failure_kind=? WHERE id=?").run("bogus-kind", job.id)
    ).toThrow();
    // Every one of the 11 real union values is accepted.
    for (const kind of ["network", "timeout", "rate-limit", "provider", "invalid-output", "authentication", "configuration", "unsupported-audio", "unsafe-path", "missing-recording", "corrupt-recording"]) {
      expect(() => db.prepare("UPDATE transcription_jobs SET failure_kind=? WHERE id=?").run(kind, job.id)).not.toThrow();
    }
    // NULL (no failure recorded) is also valid.
    expect(() => db.prepare("UPDATE transcription_jobs SET failure_kind=NULL WHERE id=?").run(job.id)).not.toThrow();
  });

  it("listPendingItemsWithTranscript excludes items whose current transcription job is awaiting_score — the boot orphan sweep must not mislabel a durably-recovered item as failed", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "orphan-guard", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    r.insertItemResult({ attemptId: "orphan-guard", itemId: "lr-1", taskType: "listen_repeat", responseAudioPath: "a.webm", scoringStatus: "transcription_pending" });
    const job = r.createOrGetTranscriptionJob({ id: "j", attemptId: "orphan-guard", itemId: "lr-1", taskType: "listen_repeat", audioPath: "a.webm", audioSha256: "a".repeat(64), now: "t0" });
    expect(r.persistRecoveredTranscriptAndAwaitScore({ jobId: job.id, attemptId: "orphan-guard", itemId: "lr-1", audioPath: "a.webm", audioSha256: "a".repeat(64), transcript: "hi", deliveryReport: "{}", now: "t1" })).toBe(true);
    expect(r.getTranscriptionJob(job.id)?.status).toBe("awaiting_score");

    // Now item_results is 'pending' with a transcript and no scoring_jobs row covers it yet
    // (createRecoveryScoringJobAndLink has not run): the shape failInterruptedJobs' orphan sweep
    // would otherwise flip to 'failed'.
    expect(r.listPendingItemsWithTranscript()).toEqual([]);

    // A pending Item with a transcript and no transcription job at all, the shape the sweep exists
    // for, is still listed.
    r.insertItemResult({ attemptId: "orphan-guard", itemId: "lr-2", taskType: "listen_repeat", transcript: "hi2" });
    expect(r.listPendingItemsWithTranscript()).toEqual([{ attemptId: "orphan-guard", itemId: "lr-2" }]);
  });

  it("listAwaitingScoreTranscriptionJobs enumerates every awaiting_score job across all attempts — unlike getCurrentTranscriptionJobs, no attemptId is required, and non-awaiting_score jobs are excluded", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "aw-1", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    r.createAttempt({ id: "aw-2", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    r.insertItemResult({ attemptId: "aw-1", itemId: "lr-1", taskType: "listen_repeat", responseAudioPath: "a.webm", scoringStatus: "transcription_pending" });
    r.insertItemResult({ attemptId: "aw-2", itemId: "int-1", taskType: "interview", responseAudioPath: "b.webm", scoringStatus: "transcription_pending" });

    const jobA = r.createOrGetTranscriptionJob({ id: "aw-job-1", attemptId: "aw-1", itemId: "lr-1", taskType: "listen_repeat", audioPath: "a.webm", audioSha256: "a".repeat(64), now: "t0" });
    const jobB = r.createOrGetTranscriptionJob({ id: "aw-job-2", attemptId: "aw-2", itemId: "int-1", taskType: "interview", audioPath: "b.webm", audioSha256: "b".repeat(64), now: "t0" });
    // A third job left 'queued', which the awaiting_score listing must leave out.
    r.createAttempt({ id: "aw-3", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    r.insertItemResult({ attemptId: "aw-3", itemId: "int-2", taskType: "interview", responseAudioPath: "c.webm", scoringStatus: "transcription_pending" });
    r.createOrGetTranscriptionJob({ id: "aw-job-3", attemptId: "aw-3", itemId: "int-2", taskType: "interview", audioPath: "c.webm", audioSha256: "c".repeat(64), now: "t0" });

    expect(r.listAwaitingScoreTranscriptionJobs()).toEqual([]);

    expect(r.persistRecoveredTranscriptAndAwaitScore({ jobId: jobA.id, attemptId: "aw-1", itemId: "lr-1", audioPath: "a.webm", audioSha256: "a".repeat(64), transcript: "hi", deliveryReport: "{}", now: "t1" })).toBe(true);
    expect(r.persistRecoveredTranscriptAndAwaitScore({ jobId: jobB.id, attemptId: "aw-2", itemId: "int-1", audioPath: "b.webm", audioSha256: "b".repeat(64), transcript: "hi2", deliveryReport: "{}", now: "t1" })).toBe(true);

    // Across Attempts, without the still-'queued' third job.
    expect(r.listAwaitingScoreTranscriptionJobs().map((j) => j.id).sort()).toEqual(["aw-job-1", "aw-job-2"]);

    // Once createRecoveryScoringJobAndLink links it and marks it done, it leaves the listing.
    expect(r.createRecoveryScoringJobAndLink({ transcriptionJobId: jobA.id, scoringJobId: "aw-score-1", attemptId: "aw-1", taskType: "listen_repeat", itemId: "lr-1", now: "t2" })).toEqual({ created: true, scoreJobId: "aw-score-1" });
    expect(r.listAwaitingScoreTranscriptionJobs().map((j) => j.id)).toEqual(["aw-job-2"]);
  });

  it("persistFreshTranscriptAndFinishJob atomically accepts only the current running take", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "fresh-1", kind: "speaking", mode: "drill", setId: "set", isRepeat: false });
    // The Item sits at 'transcription_pending', as the claim-time write leaves it before the first
    // Ears call.
    r.insertItemResult({ attemptId: "fresh-1", itemId: "lr-1", taskType: "listen_repeat", responseAudioPath: "a.webm", scoringStatus: "transcription_pending" });
    const job = r.createOrGetTranscriptionJob({ id: "fresh-job", attemptId: "fresh-1", itemId: "lr-1", taskType: "listen_repeat", audioPath: "a.webm", audioSha256: "a".repeat(64), now: "t0" });
    r.claimTranscriptionJob({ id: job.id, now: "t0" });

    expect(r.persistFreshTranscriptAndFinishJob({ jobId: job.id, attemptId: "fresh-1", itemId: "lr-1", taskType: "listen_repeat", responseAudioPath: "a.webm", audioSha256: "a".repeat(64), transcript: "hello world", deliveryReport: '{"paceWpm":140}', now: "t1" })).toBe(true);

    const item = r.getAttempt("fresh-1")!.items.find((i) => i.item_id === "lr-1")!;
    expect(item.transcript).toBe("hello world");
    expect(item.delivery_report).toBe('{"paceWpm":140}');
    // Plain 'pending', not 'awaiting_score' or 'transcription_pending': a transcript that succeeds
    // at admission is scored by the caller's ordinary upload flow, not by the recovery handoff.
    expect(item.scoring_status).toBe("pending");
    expect(r.getTranscriptionJob(job.id)?.status).toBe("done");

    // A job superseded mid-flight is neither resurrected to 'done' nor allowed to overwrite the
    // current item's transcript. The boolean tells the caller not to report stale success.
    r.createAttempt({ id: "fresh-2", kind: "speaking", mode: "drill", setId: "set", isRepeat: false });
    r.insertItemResult({ attemptId: "fresh-2", itemId: "lr-1", taskType: "listen_repeat", responseAudioPath: "b.webm", scoringStatus: "transcription_pending" });
    const superseded = r.createOrGetTranscriptionJob({ id: "fresh-job-2", attemptId: "fresh-2", itemId: "lr-1", taskType: "listen_repeat", audioPath: "b.webm", audioSha256: "b".repeat(64), now: "t0" });
    r.claimTranscriptionJob({ id: superseded.id, now: "t0" });
    r.supersedeOtherTranscriptionJobs({ attemptId: "fresh-2", itemId: "lr-1", keepJobId: "some-newer-job", now: "t1" });
    expect(r.getTranscriptionJob(superseded.id)?.status).toBe("superseded");

    expect(r.persistFreshTranscriptAndFinishJob({ jobId: superseded.id, attemptId: "fresh-2", itemId: "lr-1", taskType: "listen_repeat", responseAudioPath: "b.webm", audioSha256: "b".repeat(64), transcript: "late", deliveryReport: "{}", now: "t2" })).toBe(false);
    expect(r.getTranscriptionJob(superseded.id)?.status).toBe("superseded"); // never resurrected
    const currentItem = r.getAttempt("fresh-2")!.items.find((i) => i.item_id === "lr-1")!;
    expect(currentItem.transcript).toBeNull();
    expect(currentItem.scoring_status).toBe("transcription_pending");
  });

  it("only creates a recovery scoring job from its matching awaiting-score job", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "handoff", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    r.createAttempt({ id: "other-attempt", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    const job = r.createOrGetTranscriptionJob({ id: "t", attemptId: "handoff", itemId: "item", taskType: "interview", audioPath: "audio", audioSha256: "c".repeat(64), now: "now" });

    // A rejected call leaves no scoring_jobs row behind, although each one supplies a scoringJobId.
    expect(r.createRecoveryScoringJobAndLink({ transcriptionJobId: job.id, scoringJobId: "wrong-status", attemptId: "handoff", taskType: "interview", itemId: "item", now: "now" })).toBeUndefined();
    expect(r.getScoringJob("wrong-status")).toBeUndefined();

    r.updateTranscriptionJob({ id: job.id, status: "awaiting_score", now: "later" });

    expect(r.createRecoveryScoringJobAndLink({ transcriptionJobId: job.id, scoringJobId: "wrong-task", attemptId: "handoff", taskType: "listen_repeat", itemId: "item", now: "later" })).toBeUndefined();
    expect(r.getScoringJob("wrong-task")).toBeUndefined();

    // The right transcription job id with the wrong attemptId.
    expect(r.createRecoveryScoringJobAndLink({ transcriptionJobId: job.id, scoringJobId: "wrong-attempt", attemptId: "other-attempt", taskType: "interview", itemId: "item", now: "later" })).toBeUndefined();
    expect(r.getScoringJob("wrong-attempt")).toBeUndefined();

    // The right transcription job id with the wrong itemId.
    expect(r.createRecoveryScoringJobAndLink({ transcriptionJobId: job.id, scoringJobId: "wrong-item", attemptId: "handoff", taskType: "interview", itemId: "other-item", now: "later" })).toBeUndefined();
    expect(r.getScoringJob("wrong-item")).toBeUndefined();

    expect(r.createRecoveryScoringJobAndLink({ transcriptionJobId: job.id, scoringJobId: "score", attemptId: "handoff", taskType: "interview", itemId: "item", now: "later" })).toEqual({ created: true, scoreJobId: "score" });
    // The row itself, not only the return value: one job covering exactly this Item.
    expect(JSON.parse(r.getScoringJob("score")!.item_ids)).toEqual(["item"]);

    // Once linked, the transcription job is 'done', not 'awaiting_score'; a second call still finds
    // the link and creates nothing new.
    expect(r.createRecoveryScoringJobAndLink({ transcriptionJobId: job.id, scoringJobId: "again", attemptId: "handoff", taskType: "interview", itemId: "item", now: "later" })).toEqual({ created: false, scoreJobId: "score" });
    expect(r.getScoringJob("again")).toBeUndefined();
  });

  // A test-only statement (helpers/sqliteStores.ts). Production supersedes an Item's other in-flight
  // transcription jobs inside `createOrGetTranscriptionJob`'s own transaction, which this file's
  // createOrGetTranscriptionJob cases cover; this case runs the same UPDATE on its own.
  it("supersedeOtherTranscriptionJobs supersedes every other active job for the same attempt/item, leaving keepJobId, other items, and other attempts untouched", () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    r.createAttempt({ id: "supersede-direct", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    // A second Attempt with an active job for the same item id "item". The supersede is scoped by
    // attempt_id as well as item_id, and this job is what shows the other Attempt is left alone.
    r.createAttempt({ id: "other-attempt-direct", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    const now = "2026-07-30T00:00:00.000Z";
    // Inserted directly, so createOrGetTranscriptionJob's own sweep never runs and only
    // supersedeOtherTranscriptionJobs can change a status.
    const insert = db.prepare(
      "INSERT INTO transcription_jobs (id,attempt_id,item_id,task_type,audio_path,audio_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"
    );
    insert.run("keep", "supersede-direct", "item", "interview", "keep.webm", "a".repeat(64), now, now);
    insert.run("stale", "supersede-direct", "item", "interview", "stale.webm", "b".repeat(64), now, now);
    // Another Item's job in the same Attempt.
    insert.run("other-item", "supersede-direct", "other", "interview", "other.webm", "c".repeat(64), now, now);
    // The same item id in another Attempt.
    insert.run("other-attempt-job", "other-attempt-direct", "item", "interview", "other-attempt.webm", "d".repeat(64), now, now);

    r.supersedeOtherTranscriptionJobs({ attemptId: "supersede-direct", itemId: "item", keepJobId: "keep", now: "2026-07-30T00:00:01.000Z" });

    expect(r.getTranscriptionJob("keep")?.status).toBe("queued");
    expect(r.getTranscriptionJob("stale")?.status).toBe("superseded");
    expect(r.getTranscriptionJob("other-item")?.status).toBe("queued");
    expect(r.getTranscriptionJob("other-attempt-job")?.status).toBe("queued");
  });

  // `getCurrentTranscriptionJobs` ships; `linkTranscriptionScoreJob` is test-only
  // (helpers/sqliteStores.ts), since production links through `createRecoveryScoringJobAndLink`.
  it("linkTranscriptionScoreJob sets and clears score_job_id directly, and getCurrentTranscriptionJobs excludes superseded jobs across an attempt's items", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "link-direct", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    const a = r.createOrGetTranscriptionJob({ id: "la", attemptId: "link-direct", itemId: "item-a", taskType: "interview", audioPath: "a.webm", audioSha256: "a".repeat(64), now: "t0" });
    r.createOrGetTranscriptionJob({ id: "lb1", attemptId: "link-direct", itemId: "item-b", taskType: "interview", audioPath: "b1.webm", audioSha256: "b".repeat(64), now: "t0" });
    const b2 = r.createOrGetTranscriptionJob({ id: "lb2", attemptId: "link-direct", itemId: "item-b", taskType: "interview", audioPath: "b2.webm", audioSha256: "c".repeat(64), now: "t1" }); // supersedes lb1

    // Only the two non-superseded jobs of this Attempt, across both Items; lb2 superseded lb1.
    expect(r.getCurrentTranscriptionJobs("link-direct").map((j) => j.id).sort()).toEqual([a.id, b2.id].sort());

    // score_job_id is a foreign key into scoring_jobs(id), so the link needs a real row.
    r.createScoringJob({ id: "score-x", attemptId: "link-direct", taskType: "interview", itemIds: ["item-a"] });
    r.linkTranscriptionScoreJob({ jobId: a.id, scoreJobId: "score-x", now: "t2" });
    expect(r.getTranscriptionJob(a.id)?.score_job_id).toBe("score-x");
    r.linkTranscriptionScoreJob({ jobId: a.id, scoreJobId: null, now: "t3" });
    expect(r.getTranscriptionJob(a.id)?.score_job_id).toBeNull();
  });

  it("createRecoveryScoringJobAndLink defers when an active scoring job already covers the same attempt/task type, creating nothing new and leaving the transcription job retryable", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "active-guard", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    const job = r.createOrGetTranscriptionJob({ id: "ag", attemptId: "active-guard", itemId: "item", taskType: "interview", audioPath: "audio", audioSha256: "a".repeat(64), now: "now" });
    r.updateTranscriptionJob({ id: job.id, status: "awaiting_score", now: "later" });
    // An active scoring job for the same Attempt and Task Type, covering another Item scored the
    // ordinary way. Recovery waits for it rather than superseding it or writing through it.
    r.createScoringJob({ id: "already-active", attemptId: "active-guard", taskType: "interview", itemIds: ["other-item"] });

    expect(r.createRecoveryScoringJobAndLink({ transcriptionJobId: job.id, scoringJobId: "would-be-new", attemptId: "active-guard", taskType: "interview", itemId: "item", now: "later" })).toBeUndefined();
    expect(r.getScoringJob("would-be-new")).toBeUndefined();
    // The transcription job is untouched, still awaiting_score and unlinked, so a retry after the
    // active job finishes can still link it.
    expect(r.getTranscriptionJob(job.id)?.status).toBe("awaiting_score");
    expect(r.getTranscriptionJob(job.id)?.score_job_id).toBeNull();
  });

  it("records capture completion idempotently, preserves original completion, and replaces estimates", () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    r.createAttempt({ id: "capture", kind: "speaking", mode: "simulation", setId: "spk-1", isRepeat: false });
    // The first call marks capture and writes the placeholder; the second changes neither. The
    // do-nothing and write-once halves are asserted in full by "atomically marks capture and
    // creates only missing-item placeholders".
    r.markCaptureFinishedWithMissingItemPlaceholders({
      attemptId: "capture", now: at("2026-07-30 00:03:00"),
      placeholders: [{ itemId: "int-1", taskType: "interview", scoreJson: '{"error":"recording upload did not arrive"}' }],
    });
    r.markCaptureFinishedWithMissingItemPlaceholders({
      attemptId: "capture", now: at("2026-07-30 00:04:00"),
      placeholders: [{ itemId: "int-1", taskType: "interview", scoreJson: "{}" }],
    });
    expect(r.getAttempt("capture")?.capture_finished_at).toBe("2026-07-30 00:03:00");
    expect(r.getAttempt("capture")?.items).toMatchObject([
      { item_id: "int-1", scoring_status: "failed", score_json: '{"error":"recording upload did not arrive"}' },
    ]);
    expect(r.listCaptureFinishedInProgressAttempts().map((a) => a.id)).toEqual(["capture"]);
    // The second write does not move the first. Space form, because trendPoints string-compares
    // `completed_at` against `started_at` in its COALESCE and ORDER BY.
    r.completeAttempt("capture", at("2026-07-30 00:05:00"));
    r.completeAttempt("capture", at("2026-07-30 00:06:00"));
    expect(r.getAttempt("capture")?.completed_at).toBe("2026-07-30 00:05:00");
    r.saveSectionEstimate({ attemptId: "capture", section: "speaking", rawDetail: "one", estimatedBand: 3, method: "v1" });
    r.saveSectionEstimate({ attemptId: "capture", section: "speaking", rawDetail: "two", estimatedBand: 4, method: "v2" });
    expect(r.getSectionEstimate("capture")).toMatchObject({ rawDetail: "two", estimatedBand: 4, method: "v2" });
    // getSectionEstimate's `ORDER BY rowid DESC LIMIT 1` cannot tell an upsert from an append that
    // reads back the newest row first, so the row count is asserted directly.
    expect((db.prepare("SELECT COUNT(*) AS n FROM section_estimates WHERE attempt_id='capture' AND section='speaking'").get() as { n: number }).n).toBe(1);
  });

  it("atomically marks capture and creates only missing-item placeholders", () => {
    const db = openDb(":memory:"); const r = sqliteStores(db);
    r.createAttempt({ id: "capture-atomic", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    db.exec("CREATE TRIGGER reject_placeholder BEFORE INSERT ON item_results WHEN NEW.item_id='missing' BEGIN SELECT RAISE(ABORT, 'stop'); END");
    expect(() => r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId: "capture-atomic", now: "now", placeholders: [{ itemId: "missing", taskType: "interview", scoreJson: "{}" }] })).toThrow("stop");
    expect(r.getAttempt("capture-atomic")?.capture_finished_at).toBeNull();
    db.exec("DROP TRIGGER reject_placeholder");
    // "arrived" is a scored Item, so the placeholder insert's ON CONFLICT DO NOTHING has a real row
    // to leave alone. An `ON CONFLICT DO UPDATE SET score_json=...` would keep scoring_status and
    // overwrite the score, so the full row is asserted below.
    r.insertItemResult({ attemptId: "capture-atomic", itemId: "arrived", taskType: "interview" });
    r.updateItemScore({ attemptId: "capture-atomic", itemId: "arrived", score: 4.5, scoreJson: '{"finalScore":4.5}', scoringStatus: "scored" });

    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId: "capture-atomic", now: "now", placeholders: [{ itemId: "arrived", taskType: "interview", scoreJson: "{}" }, { itemId: "missing", taskType: "interview", scoreJson: "{}" }] });
    expect(r.getAttempt("capture-atomic")?.capture_finished_at).toBe("now");
    const itemsAfterFirstCall = r.getAttempt("capture-atomic")?.items ?? [];
    // The row count, because an extra placeholder row would pass every .find() assertion below.
    expect(itemsAfterFirstCall).toHaveLength(2);
    const arrivedAfterFirstCall = itemsAfterFirstCall.find((item) => item.item_id === "arrived");
    expect(arrivedAfterFirstCall).toMatchObject({ item_id: "arrived", scoring_status: "scored", score: 4.5, score_json: '{"finalScore":4.5}' });
    const missingAfterFirstCall = itemsAfterFirstCall.find((item) => item.item_id === "missing");
    expect(missingAfterFirstCall).toMatchObject({ item_id: "missing", scoring_status: "failed", score_json: "{}" });

    // A retried finalization with a different `now` and the same placeholders changes nothing,
    // "arrived"'s score included.
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId: "capture-atomic", now: "later", placeholders: [{ itemId: "arrived", taskType: "interview", scoreJson: "{}" }, { itemId: "missing", taskType: "interview", scoreJson: "{}" }] });
    expect(r.getAttempt("capture-atomic")?.capture_finished_at).toBe("now");
    const itemsAfterSecondCall = r.getAttempt("capture-atomic")?.items ?? [];
    expect(itemsAfterSecondCall).toHaveLength(2);
    expect(itemsAfterSecondCall.find((item) => item.item_id === "arrived")).toMatchObject({ item_id: "arrived", scoring_status: "scored", score: 4.5, score_json: '{"finalScore":4.5}' });
    expect(itemsAfterSecondCall.find((item) => item.item_id === "missing")).toMatchObject({ item_id: "missing", scoring_status: "failed", score_json: "{}" });
  });
  // A placeholder row is a failure by default, or a scored skip when the caller says so. The
  // score/scored_at pair is easy to get half-right: a scored 0 without scored_at counts toward the
  // Band Estimate while staying invisible to every "currently scored" stats query
  // (recentScoredItemResults and the others filter on `scored_at IS NOT NULL`).
  it("markCaptureFinishedWithMissingItemPlaceholders writes a scored skip placeholder with its score and scored_at, and still defaults to the failed/null shape", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "capture-classified", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    r.markCaptureFinishedWithMissingItemPlaceholders({
      attemptId: "capture-classified",
      now: "2026-08-23 09:00:00",
      placeholders: [
        { itemId: "skipped", taskType: "interview", scoreJson: '{"skipped":true}', score: 0, scoringStatus: "scored" },
        { itemId: "lost", taskType: "interview", scoreJson: '{"error":"recording upload did not arrive"}', score: null, scoringStatus: "failed" },
        // Neither field supplied: the failed/null default.
        { itemId: "legacy", taskType: "listen_repeat", scoreJson: "{}" },
      ],
    });

    const items = r.getAttempt("capture-classified")!.items;
    expect(items.find((i) => i.item_id === "skipped")).toMatchObject({
      scoring_status: "scored", score: 0, score_json: '{"skipped":true}', scored_at: "2026-08-23 09:00:00",
    });
    // A failure is not scored, so it carries no scored_at; otherwise it would look currently scored
    // to every query that uses that column as the signal.
    expect(items.find((i) => i.item_id === "lost")).toMatchObject({ scoring_status: "failed", score: null, scored_at: null });
    expect(items.find((i) => i.item_id === "legacy")).toMatchObject({ scoring_status: "failed", score: null, scored_at: null });
  });

  it("completeAttempt's default `now` writes the same datetime('now')-compatible on-disk format as started_at's own default, so the two columns remain directly comparable", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "ts-format", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    r.completeAttempt("ts-format"); // no explicit `now`: the production default
    const att = r.getAttempt("ts-format")!;
    const sqliteTimestampPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
    expect(att.started_at).toMatch(sqliteTimestampPattern);
    expect(att.completed_at).toMatch(sqliteTimestampPattern);
    // In one format, a string comparison is a chronological one, so completed_at sorts at or after
    // started_at. A space-form column compared with an ISO one ('T' and 'Z') breaks this
    // comparison, and `new Date(x)` on a non-UTC machine reads the space form as local time and the
    // ISO form as UTC.
    expect(att.completed_at! >= att.started_at).toBe(true);
    // The exported helper produces exactly this format.
    expect(sqliteTimestamp(new Date("2026-07-30T13:05:00.000Z"))).toBe("2026-07-30 13:05:00");
  });

  // markCaptureFinishedWithMissingItemPlaceholders is the only writer of capture_finished_at, so its
  // default is the only place the column's format is decided.
  it("markCaptureFinishedWithMissingItemPlaceholders' default `now` writes capture_finished_at in the same on-disk format completeAttempt writes completed_at in", () => {
    const r = sqliteStores(openDb(":memory:"));
    const sqliteTimestampPattern = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

    r.createAttempt({ id: "capture-ts-format-b", kind: "speaking", mode: "simulation", setId: "set", isRepeat: false });
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId: "capture-ts-format-b", placeholders: [] }); // `now` omitted
    expect(r.getAttempt("capture-ts-format-b")?.capture_finished_at).toMatch(sqliteTimestampPattern);
  });

  it("creates and fetches an attempt with item results", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-1", kind: "writing", mode: "drill", setId: "wri-001", isRepeat: false });
    r.insertItemResult({ attemptId: "att-1", itemId: "em1", taskType: "email", responseText: "Dear Sir..." });
    r.updateItemScore({ attemptId: "att-1", itemId: "em1", score: 3.5, scoreJson: '{"finalScore":3.5}', scoringStatus: "scored" });
    r.insertJudgeReport({ attemptId: "att-1", itemId: "em1", judge: "gemini", reportJson: "{}" });
    r.completeAttempt("att-1");

    const att = r.getAttempt("att-1");
    expect(att?.status).toBe("completed");
    expect(att?.items).toHaveLength(1);
    expect(att?.items[0].score).toBe(3.5);
    expect(att?.items[0].scoring_status).toBe("scored");
  });

  // scoreDeterministicItems writes two statements per Item (insert, then score), and the batch is
  // all-or-nothing. A failure partway that left some Items scored would break the client's retry
  // rule (pages/simulation/submitModule.ts), which reads a 409 marked alreadyScored as "this whole
  // Task Type already landed". So a failure partway leaves no rows at all.
  it("scoreDeterministicItemsBatch is atomic: a mid-batch failure leaves ZERO item_results rows, and a retry then scores every item", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-1", kind: "reading", mode: "drill", setId: "rd-1", isRepeat: false });

    // A real SQL failure (a foreign key violation; openDb turns `foreign_keys` on in db.ts) on the
    // third Item, after the first two are already written inside the same transaction. Any
    // exception partway through db.transaction()'s callback rolls back everything in it.
    const batchWithABadItem = [
      { attemptId: "att-1", itemId: "item-1", taskType: "complete_words", score: 1, scoreJson: '{"correct":true}' },
      { attemptId: "att-1", itemId: "item-2", taskType: "complete_words", score: 0, scoreJson: '{"correct":false}' },
      { attemptId: "no-such-attempt", itemId: "item-3", taskType: "complete_words", score: 1, scoreJson: '{"correct":true}' },
    ];
    expect(() => r.scoreDeterministicItemsBatch(batchWithABadItem)).toThrow();

    // Nothing from the failed batch persisted, not even item-1 and item-2, which on their own would
    // have succeeded.
    expect(r.getAttempt("att-1")!.items).toHaveLength(0);

    // A retry of the same batch, once the bad Item's attemptId is fixed, scores every Item.
    const fixedBatch = batchWithABadItem.map((item) => (item.itemId === "item-3" ? { ...item, attemptId: "att-1" } : item));
    r.scoreDeterministicItemsBatch(fixedBatch);
    const items = r.getAttempt("att-1")!.items;
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.scoring_status === "scored")).toBe(true);
    expect(items.find((i) => i.item_id === "item-1")?.score).toBe(1);
    expect(items.find((i) => i.item_id === "item-2")?.score).toBe(0);
  });

  it("scoreDeterministicItemsBatch scores a normal (no-failure) batch in one pass, matching insertItemResult+updateItemScore's own field semantics", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-2", kind: "reading", mode: "simulation", setId: "rd-1", isRepeat: false });
    r.scoreDeterministicItemsBatch([
      { attemptId: "att-2", itemId: "dl-1-q1", taskType: "daily_life", score: 1, scoreJson: '{"correct":true,"answer":"a"}' },
    ]);
    const item = r.getAttempt("att-2")!.items[0];
    expect(item.scoring_status).toBe("scored");
    expect(item.score).toBe(1);
    expect(item.score_json).toBe('{"correct":true,"answer":"a"}');
    expect(item.scored_at).not.toBeNull();
  });

  it("tracks attempted sets (holding a scored Item, or completed holding an Item) and the repeat flag", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "a1", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    r.createAttempt({ id: "a2", kind: "speaking", mode: "simulation", setId: "spk-001", isRepeat: true });
    r.insertItemResult({ attemptId: "a1", itemId: "lr-1", taskType: "listen_repeat", responseAudioPath: "audio/responses/a1/lr-1.webm" });
    expect(r.isSetAttempted("spk-001")).toBe(false);
    r.completeAttempt("a1");
    expect(r.isSetAttempted("spk-001")).toBe(true);
    expect(r.isSetAttempted("spk-002")).toBe(false);
    expect(r.listAttempts({ kind: "speaking" }).map((a) => a.is_repeat)).toEqual([1, 0]);
  });

  // listAttempts({setId}) lists every Attempt on one Set, without the general listing's default
  // 50-row cap: a Set last attempted more than 50 Attempts ago still shows up.
  it("listAttempts({setId}) is scoped to one Set and unbounded by the general 50-row default", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "rd-old", kind: "reading", mode: "drill", setId: "rd-target", isRepeat: false });
    // 55 later Attempts on other Sets push rd-old outside the general listing's 50-row window.
    for (let i = 0; i < 55; i++) {
      r.createAttempt({ id: `filler-${i}`, kind: "writing", mode: "drill", setId: `wri-filler-${i}`, isRepeat: false });
    }

    // The general listing (no setId) does not see rd-old.
    expect(r.listAttempts({}).map((a) => a.id)).not.toContain("rd-old");

    // The setId-scoped listing still does, unbounded.
    const scoped = r.listAttempts({ setId: "rd-target" });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].id).toBe("rd-old");
  });

  it("listAttempts({setId, limit}) still honors an explicit limit when the caller wants one", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "a1", kind: "reading", mode: "drill", setId: "rd-1", isRepeat: false });
    r.createAttempt({ id: "a2", kind: "reading", mode: "simulation", setId: "rd-1", isRepeat: true });
    expect(r.listAttempts({ setId: "rd-1", limit: 1 })).toHaveLength(1);
  });

  it("returns item results in insertion order even when created within the same second", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-2", kind: "writing", mode: "drill", setId: "wri-002", isRepeat: false });
    // Three Items inside the same second, so created_at alone cannot order them.
    r.insertItemResult({ attemptId: "att-2", itemId: "item1", taskType: "email", responseText: "First" });
    r.insertItemResult({ attemptId: "att-2", itemId: "item2", taskType: "email", responseText: "Second" });
    r.insertItemResult({ attemptId: "att-2", itemId: "item3", taskType: "email", responseText: "Third" });

    const att = r.getAttempt("att-2");
    expect(att?.items).toHaveLength(3);
    expect(att?.items[0].item_id).toBe("item1");
    expect(att?.items[1].item_id).toBe("item2");
    expect(att?.items[2].item_id).toBe("item3");
  });

  it("returns judge reports for an attempt in insertion order (created_at, rowid), null score before scoring", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "a9", kind: "writing", mode: "drill", setId: "wri-x", isRepeat: false });
    r.insertItemResult({ attemptId: "a9", itemId: "em1", taskType: "email", responseText: "hi" });
    expect(r.getAttempt("a9")?.items[0].score).toBeNull();
    r.insertJudgeReport({ attemptId: "a9", itemId: "em1", judge: "gemini", reportJson: '{"g":1}' });
    r.insertJudgeReport({ attemptId: "a9", itemId: "em1", judge: "openai", reportJson: '{"o":1}' });
    r.insertJudgeReport({ attemptId: "a9", itemId: "em1", judge: "gemini", reportJson: '{"g":2}' });
    const reports = r.getJudgeReports("a9");
    expect(reports.map((x) => x.judge)).toEqual(["gemini", "openai", "gemini"]);
  });

  it("persists delivery_report on insert and resets it on re-upsert", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-dr", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    r.insertItemResult({
      attemptId: "att-dr", itemId: "lr1", taskType: "listen_repeat",
      transcript: "the ferry left before noon",
      deliveryReport: '{"paceWpm":140,"pauses":"none","intelligibility":"clear","suspectedMispronunciations":[],"intonation":"natural"}',
    });
    let att = r.getAttempt("att-dr");
    expect(att?.items[0].delivery_report).toBe(
      '{"paceWpm":140,"pauses":"none","intelligibility":"clear","suspectedMispronunciations":[],"intonation":"natural"}'
    );

    // A new Response for the same Item without a deliveryReport (Ears has not reported on it yet)
    // resets the previous delivery_report rather than leaving it stale.
    r.insertItemResult({ attemptId: "att-dr", itemId: "lr1", taskType: "listen_repeat", transcript: "the ferry left after noon" });
    att = r.getAttempt("att-dr");
    expect(att?.items[0].delivery_report).toBeNull();
    expect(att?.items[0].transcript).toBe("the ferry left after noon");
  });

  it("updateItemScore stamps scored_at on a 'scored' write and resets it to NULL on any other status (e.g. a rescore that fails)", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-sa", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    r.insertItemResult({ attemptId: "att-sa", itemId: "em1", taskType: "email" });

    r.updateItemScore({ attemptId: "att-sa", itemId: "em1", score: 3, scoreJson: "{}", scoringStatus: "scored" });
    expect(r.getAttempt("att-sa")?.items[0].scored_at).toEqual(expect.any(String));
    expect(r.recentScoredItemResults(10)).toHaveLength(1);

    r.updateItemScore({ attemptId: "att-sa", itemId: "em1", score: null, scoreJson: '{"error":"arbiter down"}', scoringStatus: "failed" });
    expect(r.getAttempt("att-sa")?.items[0].scored_at).toBeNull();
    expect(r.recentScoredItemResults(10)).toHaveLength(0);
  });

  it("recentScoredItemResults orders by scored_at (scoring time), not created_at (upload/submission time): a rescored item ranks ahead of an item scored earlier but uploaded later", () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    r.createAttempt({ id: "att-ord", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    r.insertItemResult({ attemptId: "att-ord", itemId: "item-a", taskType: "email" });
    r.updateItemScore({ attemptId: "att-ord", itemId: "item-a", score: 3, scoreJson: '{"tag":"a-first-score"}', scoringStatus: "scored" });
    r.insertItemResult({ attemptId: "att-ord", itemId: "item-b", taskType: "email" });
    r.updateItemScore({ attemptId: "att-ord", itemId: "item-b", score: 4, scoreJson: '{"tag":"b"}', scoringStatus: "scored" });

    // item-a was submitted (created_at) and scored before item-b.
    db.prepare("UPDATE item_results SET created_at='2026-01-01 00:00:00', scored_at='2026-01-01 00:00:01' WHERE attempt_id='att-ord' AND item_id='item-a'").run();
    db.prepare("UPDATE item_results SET created_at='2026-01-02 00:00:00', scored_at='2026-01-02 00:00:01' WHERE attempt_id='att-ord' AND item_id='item-b'").run();

    // A re-score of item-a moves its scored_at after item-b's, while its created_at stays the older.
    r.updateItemScore({ attemptId: "att-ord", itemId: "item-a", score: 3.5, scoreJson: '{"tag":"a-rescored"}', scoringStatus: "scored" });
    db.prepare("UPDATE item_results SET scored_at='2026-01-03 00:00:00' WHERE attempt_id='att-ord' AND item_id='item-a'").run();

    const recent = r.recentScoredItemResults(10);
    expect(recent.map((x) => (JSON.parse(x.scoreJson) as { tag: string }).tag)).toEqual(["a-rescored", "b"]);
  });

  it("getSetting returns null for an unset key; setSetting upserts (insert then update)", () => {
    const r = sqliteStores(openDb(":memory:"));
    expect(r.getSetting("target.speaking")).toBeNull();
    r.setSetting("target.speaking", "5.5");
    expect(r.getSetting("target.speaking")).toBe("5.5");
    r.setSetting("target.speaking", "6");
    expect(r.getSetting("target.speaking")).toBe("6");
    // Untouched keys stay independent.
    expect(r.getSetting("target.writing")).toBeNull();
  });

  // A band needs every Item of the Attempt scored and a scored Item of every Task Type its section
  // weighs; rows that say otherwise are not read back as a band (sectionEstimates.ts's
  // persistedRowToEstimate), so every estimate seeded below carries full coverage over an Attempt
  // whose Items are all scored. The headline reads only completed Attempts, so each one is completed.
  function scoreEvery(r: ReturnType<typeof sqliteStores>, attemptId: string, kind: string) {
    const taskTypes = kind === "speaking" ? ["listen_repeat", "interview"] : ["build_sentence", "email", "discussion"];
    for (const taskType of taskTypes) {
      r.insertItemResult({ attemptId, itemId: `${taskType}-1`, taskType });
      r.updateItemScore({ attemptId, itemId: `${taskType}-1`, score: 1, scoreJson: "{}", scoringStatus: "scored" });
    }
  }
  const SPEAKING_COVERAGE = [{ taskType: "listen_repeat", itemCount: 7 }, { taskType: "interview", itemCount: 4 }];
  const SPEAKING_DETAIL = JSON.stringify({ raw: 0.6, coverage: SPEAKING_COVERAGE });
  const WRITING_DETAIL = JSON.stringify({
    raw: 0.6,
    coverage: [{ taskType: "build_sentence", itemCount: 10 }, { taskType: "email", itemCount: 1 }, { taskType: "discussion", itemCount: 1 }],
  });

  it("saveSectionEstimate persists a row readable back via latestEstimate", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-est", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    scoreEvery(r, "att-est", "speaking");
    r.completeAttempt("att-est");
    r.saveSectionEstimate({
      attemptId: "att-est",
      section: "speaking",
      rawDetail: SPEAKING_DETAIL,
      estimatedBand: 4.5,
      method: "linear-v2",
    });
    const latest = r.latestEstimate("speaking");
    expect(latest?.attemptId).toBe("att-est");
    expect(latest?.estimatedBand).toBe(4.5);
    expect(latest?.method).toBe("linear-v2");
    expect(latest?.mode).toBe("drill");
  });

  it("latestEstimate returns undefined when there are no estimates for the section", () => {
    const r = sqliteStores(openDb(":memory:"));
    expect(r.latestEstimate("writing")).toBeUndefined();
  });

  it("getSectionEstimate returns THIS attempt's own estimate row (not the section-wide latest), and undefined when this attempt never got one", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-old", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    scoreEvery(r, "att-old", "speaking");
    r.completeAttempt("att-old");
    r.createAttempt({ id: "att-new", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    scoreEvery(r, "att-new", "speaking");
    r.completeAttempt("att-new");
    r.createAttempt({ id: "att-none", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    scoreEvery(r, "att-none", "speaking");
    r.saveSectionEstimate({
      attemptId: "att-old", section: "speaking",
      rawDetail: JSON.stringify({ raw: 0.5, coverage: SPEAKING_COVERAGE }),
      estimatedBand: 3.5, method: "linear-v2",
    });
    r.saveSectionEstimate({
      attemptId: "att-new", section: "speaking",
      rawDetail: JSON.stringify({ raw: 0.9, coverage: SPEAKING_COVERAGE }),
      estimatedBand: 5.5, method: "linear-v2",
    });

    // The section-wide "current best" is att-new's estimate...
    expect(r.latestEstimate("speaking")?.attemptId).toBe("att-new");
    // ...but att-old's own review still reads its own estimate, not null and not att-new's.
    const old = r.getSectionEstimate("att-old");
    expect(old?.section).toBe("speaking");
    expect(old?.estimatedBand).toBe(3.5);
    expect(old?.method).toBe("linear-v2");
    expect(JSON.parse(old!.rawDetail)).toEqual({ raw: 0.5, coverage: SPEAKING_COVERAGE });

    expect(r.getSectionEstimate("att-none")).toBeUndefined();
  });

  it("latestEstimate excludes is_repeat=1 attempts", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "a-orig", kind: "writing", mode: "drill", setId: "wri-001", isRepeat: false });
    scoreEvery(r, "a-orig", "writing");
    r.completeAttempt("a-orig");
    r.saveSectionEstimate({ attemptId: "a-orig", section: "writing", rawDetail: WRITING_DETAIL, estimatedBand: 3.0, method: "linear-v2" });
    r.createAttempt({ id: "a-repeat", kind: "writing", mode: "drill", setId: "wri-001", isRepeat: true });
    scoreEvery(r, "a-repeat", "writing");
    r.completeAttempt("a-repeat");
    r.saveSectionEstimate({ attemptId: "a-repeat", section: "writing", rawDetail: WRITING_DETAIL, estimatedBand: 5.5, method: "linear-v2" });

    // The Repeat's estimate (5.5) never surfaces, although it is the more recent row.
    const latest = r.latestEstimate("writing");
    expect(latest?.attemptId).toBe("a-orig");
    expect(latest?.estimatedBand).toBe(3.0);
  });

  it("latestEstimate prefers the latest simulation attempt over a more recent drill attempt", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "a-sim", kind: "speaking", mode: "simulation", setId: "spk-001", isRepeat: false });
    scoreEvery(r, "a-sim", "speaking");
    r.completeAttempt("a-sim");
    r.saveSectionEstimate({ attemptId: "a-sim", section: "speaking", rawDetail: SPEAKING_DETAIL, estimatedBand: 4.0, method: "linear-v2" });
    // The Drill is created, and its estimate saved, after the Simulation.
    r.createAttempt({ id: "a-drill", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    scoreEvery(r, "a-drill", "speaking");
    r.completeAttempt("a-drill");
    r.saveSectionEstimate({ attemptId: "a-drill", section: "speaking", rawDetail: SPEAKING_DETAIL, estimatedBand: 5.0, method: "linear-v2" });

    const latest = r.latestEstimate("speaking");
    expect(latest?.attemptId).toBe("a-sim");
    expect(latest?.mode).toBe("simulation");
    expect(latest?.estimatedBand).toBe(4.0);
  });

  it("latestEstimate falls back to the latest drill attempt when no simulation attempt exists", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "a-drill-1", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    scoreEvery(r, "a-drill-1", "speaking");
    r.completeAttempt("a-drill-1");
    r.saveSectionEstimate({ attemptId: "a-drill-1", section: "speaking", rawDetail: SPEAKING_DETAIL, estimatedBand: 3.0, method: "linear-v2" });
    r.createAttempt({ id: "a-drill-2", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    scoreEvery(r, "a-drill-2", "speaking");
    r.completeAttempt("a-drill-2");
    r.saveSectionEstimate({ attemptId: "a-drill-2", section: "speaking", rawDetail: SPEAKING_DETAIL, estimatedBand: 4.5, method: "linear-v2" });

    const latest = r.latestEstimate("speaking");
    expect(latest?.attemptId).toBe("a-drill-2");
    expect(latest?.estimatedBand).toBe(4.5);
  });

  it("latestEstimate ranks by completion time, not start time: an attempt started earlier but finished later ranks as latest", () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    r.createAttempt({ id: "a-early-start", kind: "writing", mode: "drill", setId: "wri-001", isRepeat: false });
    scoreEvery(r, "a-early-start", "writing");
    r.completeAttempt("a-early-start");
    r.saveSectionEstimate({ attemptId: "a-early-start", section: "writing", rawDetail: WRITING_DETAIL, estimatedBand: 3.0, method: "linear-v2" });
    r.createAttempt({ id: "a-late-start", kind: "writing", mode: "drill", setId: "wri-001", isRepeat: false });
    scoreEvery(r, "a-late-start", "writing");
    r.completeAttempt("a-late-start");
    r.saveSectionEstimate({ attemptId: "a-late-start", section: "writing", rawDetail: WRITING_DETAIL, estimatedBand: 5.0, method: "linear-v2" });

    // a-early-start started first and finished last; a-late-start started second and finished
    // first. Ordering by started_at would pick a-late-start.
    db.prepare("UPDATE attempts SET started_at = '2026-01-01 00:00:00', completed_at = '2026-01-03 00:00:00' WHERE id = 'a-early-start'").run();
    db.prepare("UPDATE attempts SET started_at = '2026-01-02 00:00:00', completed_at = '2026-01-02 12:00:00' WHERE id = 'a-late-start'").run();

    const latest = r.latestEstimate("writing");
    expect(latest?.attemptId).toBe("a-early-start");
    expect(latest?.estimatedBand).toBe(3.0);
  });

  it("getLatestEstimates returns both sections' latest estimates in one call", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "a-spk", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    scoreEvery(r, "a-spk", "speaking");
    r.completeAttempt("a-spk");
    r.saveSectionEstimate({ attemptId: "a-spk", section: "speaking", rawDetail: SPEAKING_DETAIL, estimatedBand: 4.0, method: "linear-v2" });
    r.createAttempt({ id: "a-wri", kind: "writing", mode: "drill", setId: "wri-001", isRepeat: false });
    scoreEvery(r, "a-wri", "writing");
    r.completeAttempt("a-wri");
    r.saveSectionEstimate({ attemptId: "a-wri", section: "writing", rawDetail: WRITING_DETAIL, estimatedBand: 3.5, method: "linear-v2" });

    const { speaking, writing } = r.getLatestEstimates();
    expect(speaking?.attemptId).toBe("a-spk");
    expect(writing?.attemptId).toBe("a-wri");
  });

  // `getScoringJob` and `setScoringJobStage` ship. `createScoringJob` is a test-only seed
  // (helpers/sqliteStores.ts): production creates a job only through `replaceScoringJobAndSupersede`
  // or `createRecoveryScoringJobAndLink`, both of which have their own cases in this file.
  it("createScoringJob/getScoringJob/setScoringJobStage round-trip: a created row starts 'queued' with null stage/progress/result/error, and the stage moves only on a live job", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-jobs", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });

    r.createScoringJob({ id: "job-email", attemptId: "att-jobs", taskType: "email", itemIds: ["email-1"] });
    const created = r.getScoringJob("job-email");
    expect(created?.status).toBe("queued");
    expect(created?.stage).toBeNull();
    expect(created?.progress).toBeNull();
    expect(created?.result).toBeNull();
    expect(created?.error).toBeNull();
    expect(JSON.parse(created!.item_ids)).toEqual(["email-1"]);

    // The stage alone: status, progress, result and error stay as they were.
    expect(r.setScoringJobStage({ id: "job-email", stage: "persisting" })).toBe(true);
    const staged = r.getScoringJob("job-email")!;
    expect(staged).toMatchObject({ status: "queued", stage: "persisting", progress: null, result: null, error: null });
    expect(staged.updated_at >= created!.updated_at).toBe(true);

    // A finished job keeps the stage it ended with.
    expect(r.failScoringJobConditional({ id: "job-email", error: "both judges failed", now: "2026-08-01 00:00:00" as never })).toBe(true);
    expect(r.setScoringJobStage({ id: "job-email", stage: "judging" })).toBe(false);
    expect(r.getScoringJob("job-email")).toMatchObject({ status: "failed", stage: "persisting", error: "both judges failed" });
  });

  it("getScoringJob returns undefined for an unknown id", () => {
    const r = sqliteStores(openDb(":memory:"));
    expect(r.getScoringJob("nope")).toBeUndefined();
  });

  it("scoring_jobs.status CHECK constraint rejects a status outside queued|running|done|failed|superseded|cancelled", () => {
    const db = openDb(":memory:");
    expect(() =>
      db.prepare(
        "INSERT INTO scoring_jobs (id, attempt_id, task_type, item_ids, status) VALUES (?,?,?,?,?)"
      ).run("job-bad", "att-x", "email", "[]", "bogus")
    ).toThrow();

    // Also enforced on UPDATE, through the store rather than raw SQL.
    const r = sqliteStores(db);
    r.createAttempt({ id: "att-x", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    r.createScoringJob({ id: "job-ok", attemptId: "att-x", taskType: "email", itemIds: ["email-1"] });
    expect(() => r.seedScoringJobState({ id: "job-ok", status: "bogus" })).toThrow();
    // The bad update did not partially apply.
    expect(r.getScoringJob("job-ok")?.status).toBe("queued");
  });

  it("listActiveJobs returns only queued|running jobs for ONE attempt; replaceScoringJobAndSupersede cancels the matching in-flight ones with reason 'superseded', leaving other task types, other attempts and terminal jobs untouched", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-super", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });

    r.createScoringJob({ id: "job-email-old", attemptId: "att-super", taskType: "email", itemIds: ["email-1"] });
    r.seedScoringJobState({ id: "job-email-old", status: "running" });

    // A done job of another Task Type, which an email-scoped supersede leaves alone.
    r.createScoringJob({ id: "job-discussion", attemptId: "att-super", taskType: "discussion", itemIds: ["disc-1"] });
    r.seedScoringJobState({ id: "job-discussion", status: "done", result: '{"ok":true}' });

    // An email job of another Attempt, also left alone.
    r.createAttempt({ id: "att-other", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    r.createScoringJob({ id: "job-email-other-attempt", attemptId: "att-other", taskType: "email", itemIds: ["email-1"] });

    expect(r.listActiveJobs("att-super").map((j) => j.id)).toEqual(["job-email-old"]);

    expect(r.replaceScoringJobAndSupersede({ id: "job-email-new", attemptId: "att-super", taskType: "email", itemIds: ["email-1"], now: "2026-08-01 00:00:00" as never })).toEqual(["job-email-old"]);

    expect(r.getScoringJob("job-email-old")).toMatchObject({ status: "cancelled", cancellation_reason: "superseded" });
    expect(r.getScoringJob("job-discussion")?.status).toBe("done");
    expect(r.getScoringJob("job-email-other-attempt")?.status).toBe("queued");
    expect(r.listActiveJobs("att-super").map((j) => j.id)).toEqual(["job-email-new"]);
  });

  it("listInterruptedJobs/listAllScoringJobs/listPendingItemsWithTranscript are the primitives failInterruptedJobs is built on", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-lp", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });
    r.insertItemResult({ attemptId: "att-lp", itemId: "lr-1", taskType: "listen_repeat", transcript: "hi", deliveryReport: "{}" });
    r.insertItemResult({ attemptId: "att-lp", itemId: "lr-2", taskType: "listen_repeat" }); // pending, no transcript

    r.createScoringJob({ id: "job-running", attemptId: "att-lp", taskType: "listen_repeat", itemIds: ["lr-1"] });
    r.seedScoringJobState({ id: "job-running", status: "running" });
    r.createScoringJob({ id: "job-queued", attemptId: "att-lp", taskType: "listen_repeat", itemIds: ["lr-2"] });
    r.createScoringJob({ id: "job-done", attemptId: "att-lp", taskType: "listen_repeat", itemIds: ["lr-3"] });
    r.seedScoringJobState({ id: "job-done", status: "done" });

    expect(r.listInterruptedJobs().map((j) => j.id).sort()).toEqual(["job-queued", "job-running"]);
    expect(r.listAllScoringJobs().map((j) => j.id).sort()).toEqual(["job-done", "job-queued", "job-running"]);
    // Only lr-1 has a transcript; lr-2 is pending without one.
    expect(r.listPendingItemsWithTranscript()).toEqual([{ attemptId: "att-lp", itemId: "lr-1" }]);
  });

  it("listScoringJobsForAttempt is listAllScoringJobs scoped to one attempt: same rows, same order, nobody else's", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createAttempt({ id: "att-scoped", kind: "speaking", mode: "simulation", setId: "spk-001", isRepeat: false });
    r.createAttempt({ id: "att-other", kind: "speaking", mode: "drill", setId: "spk-001", isRepeat: false });

    r.createScoringJob({ id: "scoped-1", attemptId: "att-scoped", taskType: "listen_repeat", itemIds: ["lr-1"] });
    r.createScoringJob({ id: "other-1", attemptId: "att-other", taskType: "listen_repeat", itemIds: ["lr-1"] });
    r.createScoringJob({ id: "scoped-2", attemptId: "att-scoped", taskType: "interview", itemIds: ["int-1"] });
    r.seedScoringJobState({ id: "scoped-2", status: "cancelled" });

    // Every status is listed, a cancelled row included: the reader decides what each one covers
    // (scoringJobCoversItsItems).
    expect(r.listScoringJobsForAttempt("att-scoped").map((j) => j.id)).toEqual(["scoped-1", "scoped-2"]);
    expect(r.listScoringJobsForAttempt("att-other").map((j) => j.id)).toEqual(["other-1"]);
    expect(r.listScoringJobsForAttempt("no-such-attempt")).toEqual([]);
    // Identical to filtering the global list.
    expect(r.listScoringJobsForAttempt("att-scoped")).toEqual(
      r.listAllScoringJobs().filter((j) => j.attempt_id === "att-scoped"),
    );
  });

  it("createGenerationJob/getGenerationJob/updateGenerationJob round-trip: created row starts 'queued' with null stage/progress/set_id/error, a partial update only changes the fields provided and always advances updated_at — no attempt/item required (unlike scoring_jobs)", () => {
    const r = sqliteStores(openDb(":memory:"));

    r.createGenerationJob({ id: "gen-1", kind: "writing" });
    const created = r.getGenerationJob("gen-1");
    expect(created?.kind).toBe("writing");
    expect(created?.status).toBe("queued");
    expect(created?.stage).toBeNull();
    expect(created?.progress).toBeNull();
    expect(created?.set_id).toBeNull();
    expect(created?.error).toBeNull();

    // A partial update of status and stage leaves set_id and error alone.
    r.updateGenerationJob({ id: "gen-1", status: "running", stage: "generating" });
    const running = r.getGenerationJob("gen-1")!;
    expect(running.status).toBe("running");
    expect(running.stage).toBe("generating");
    expect(running.set_id).toBeNull();
    expect(running.error).toBeNull();
    expect(running.updated_at >= created!.updated_at).toBe(true);

    // setId is set on its own, well before the job is done: generationJobs.ts's runGenerationJob
    // persists it the moment generateSet() mints it.
    r.updateGenerationJob({ id: "gen-1", stage: "verifying", setId: "wri-abc12345" });
    const midFlight = r.getGenerationJob("gen-1")!;
    expect(midFlight.status).toBe("running"); // untouched by this update
    expect(midFlight.stage).toBe("verifying");
    expect(midFlight.set_id).toBe("wri-abc12345");

    r.updateGenerationJob({ id: "gen-1", status: "done", stage: "saving", progress: null });
    const done = r.getGenerationJob("gen-1")!;
    expect(done.status).toBe("done");
    expect(done.stage).toBe("saving");
    expect(done.set_id).toBe("wri-abc12345"); // untouched by this update (setId omitted)
  });

  // A paid call can still be running when its job ends (a regeneration the verify loop is waiting
  // out, a sibling of the call that failed the job). Its progress must not land on the ended row.
  it("updateGenerationJob writes stage, progress and set id only while the job is queued or running", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createGenerationJob({ id: "gen-late", kind: "listening" });
    r.updateGenerationJob({ id: "gen-late", stage: "queued", progress: "{\"queuePosition\":1}" });
    expect(r.getGenerationJob("gen-late")).toMatchObject({ status: "queued", stage: "queued" });
    expect(r.claimGenerationJobRunning("gen-late")).toBe("claimed");
    r.updateGenerationJob({ id: "gen-late", stage: "verifying", progress: "{\"provider\":\"claude\"}", setId: "lsn-late0001" });
    expect(r.failGenerationJobConditional({ id: "gen-late", error: "verify exhausted", now: sqliteTimestamp() })).toBe(true);
    const ended = r.getGenerationJob("gen-late")!;

    r.updateGenerationJob({ id: "gen-late", stage: "generating", progress: "{\"provider\":\"codex\"}", setId: "lsn-other001" });

    expect(r.getGenerationJob("gen-late")).toEqual(ended);
    expect(ended).toMatchObject({ status: "failed", stage: "verifying", progress: "{\"provider\":\"claude\"}", set_id: "lsn-late0001" });
  });

  it("getGenerationJob returns undefined for an unknown id", () => {
    const r = sqliteStores(openDb(":memory:"));
    expect(r.getGenerationJob("nope")).toBeUndefined();
  });

  it("generation_jobs.kind CHECK constraint rejects a kind outside speaking|writing|reading|listening, and .status CHECK constraint rejects a status outside queued|running|done|failed|cancelled (no 'superseded': generation jobs never supersede each other; 'cancelled' is reachable through a batch's cancel path)", () => {
    const db = openDb(":memory:");
    expect(() =>
      db.prepare("INSERT INTO generation_jobs (id, kind) VALUES (?,?)").run("gen-bad-kind", "bogus")
    ).toThrow();
    expect(() =>
      db.prepare("INSERT INTO generation_jobs (id, kind, status) VALUES (?,?,?)").run("gen-bad-status", "writing", "superseded")
    ).toThrow();
    // 'cancelled' passes the CHECK on a raw INSERT, not only through updateGenerationJob.
    expect(() =>
      db.prepare("INSERT INTO generation_jobs (id, kind, status) VALUES (?,?,?)").run("gen-cancelled-ok", "writing", "cancelled")
    ).not.toThrow();
    // 'reading' and 'listening' are valid kinds too, not only speaking and writing.
    expect(() =>
      db.prepare("INSERT INTO generation_jobs (id, kind) VALUES (?,?)").run("gen-reading-ok", "reading")
    ).not.toThrow();
    expect(() =>
      db.prepare("INSERT INTO generation_jobs (id, kind) VALUES (?,?)").run("gen-listening-ok", "listening")
    ).not.toThrow();

    // Also enforced on UPDATE, through the store rather than raw SQL.
    const r = sqliteStores(db);
    r.createGenerationJob({ id: "gen-ok", kind: "writing" });
    expect(() => r.updateGenerationJob({ id: "gen-ok", status: "superseded" })).toThrow();
    // The bad update did not partially apply.
    expect(r.getGenerationJob("gen-ok")?.status).toBe("queued");
    // A legitimate 'cancelled' transition, in contrast, is accepted.
    expect(() => r.updateGenerationJob({ id: "gen-ok", status: "cancelled" })).not.toThrow();
    expect(r.getGenerationJob("gen-ok")?.status).toBe("cancelled");
  });

  it("createGenerationJob accepts an optional batchId/batchIndex and defaults both to null for a standalone job", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createGenerationJob({ id: "gen-standalone", kind: "writing" });
    const standalone = r.getGenerationJob("gen-standalone");
    expect(standalone?.batch_id).toBeNull();
    expect(standalone?.batch_index).toBeNull();

    r.createGenerationBatch({ id: "batch-1", total: 2 });
    r.createGenerationJob({ id: "gen-child-0", kind: "writing", batchId: "batch-1", batchIndex: 0 });
    r.createGenerationJob({ id: "gen-child-1", kind: "speaking", batchId: "batch-1", batchIndex: 1 });
    const child0 = r.getGenerationJob("gen-child-0")!;
    expect(child0.batch_id).toBe("batch-1");
    expect(child0.batch_index).toBe(0);
  });

  it("createGenerationBatch/getGenerationBatch/updateGenerationBatch round-trip: created row starts 'queued' with cancel_requested=0 and null error, a partial update only changes the fields provided", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createGenerationBatch({ id: "batch-rt", total: 3 });
    const created = r.getGenerationBatch("batch-rt");
    expect(created?.total).toBe(3);
    expect(created?.status).toBe("queued");
    expect(created?.cancel_requested).toBe(0);
    expect(created?.error).toBeNull();

    r.updateGenerationBatch({ id: "batch-rt", status: "running" });
    expect(r.getGenerationBatch("batch-rt")?.status).toBe("running");
    expect(r.getGenerationBatch("batch-rt")?.cancel_requested).toBe(0); // untouched by this update

    r.updateGenerationBatch({ id: "batch-rt", cancelRequested: true });
    const cancelling = r.getGenerationBatch("batch-rt")!;
    expect(cancelling.cancel_requested).toBe(1);
    expect(cancelling.status).toBe("running"); // untouched by this update

    r.updateGenerationBatch({ id: "batch-rt", status: "cancelled" });
    const cancelled = r.getGenerationBatch("batch-rt")!;
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.terminal_at).not.toBeNull();
    expect(cancelled.cancelled_at).toBe(cancelled.terminal_at);
    const terminalAt = cancelled.terminal_at;
    r.updateGenerationBatch({ id: "batch-rt", status: "cancelled" });
    expect(r.getGenerationBatch("batch-rt")?.terminal_at).toBe(terminalAt);
  });

  it("getGenerationBatch returns undefined for an unknown id", () => {
    const r = sqliteStores(openDb(":memory:"));
    expect(r.getGenerationBatch("nope")).toBeUndefined();
  });

  it("generation_batches.status CHECK constraint rejects a status outside queued|running|done|partial|failed|cancelled", () => {
    const db = openDb(":memory:");
    expect(() =>
      db.prepare("INSERT INTO generation_batches (id, total, status) VALUES (?,?,?)").run("batch-bad", 1, "superseded")
    ).toThrow();
    const r = sqliteStores(db);
    r.createGenerationBatch({ id: "batch-ok", total: 1 });
    expect(() => r.updateGenerationBatch({ id: "batch-ok", status: "bogus" })).toThrow();
    expect(r.getGenerationBatch("batch-ok")?.status).toBe("queued"); // bad update did not partially apply
  });

  it("listGenerationJobsByBatch returns a batch's children in batch_index order and never includes another batch's children or a standalone job", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createGenerationBatch({ id: "batch-order", total: 3 });
    // Inserted out of index order, so the query has to sort by batch_index.
    r.createGenerationJob({ id: "gen-idx-2", kind: "speaking", batchId: "batch-order", batchIndex: 2 });
    r.createGenerationJob({ id: "gen-idx-0", kind: "writing", batchId: "batch-order", batchIndex: 0 });
    r.createGenerationJob({ id: "gen-idx-1", kind: "writing", batchId: "batch-order", batchIndex: 1 });
    r.createGenerationJob({ id: "gen-standalone-2", kind: "writing" }); // no batch, so never listed
    r.createGenerationBatch({ id: "batch-other", total: 1 });
    r.createGenerationJob({ id: "gen-other-batch", kind: "writing", batchId: "batch-other", batchIndex: 0 });

    expect(r.listGenerationJobsByBatch("batch-order").map((j) => j.id)).toEqual(["gen-idx-0", "gen-idx-1", "gen-idx-2"]);
    expect(r.listGenerationJobsByBatch("batch-other").map((j) => j.id)).toEqual(["gen-other-batch"]);
  });

  it("listInterruptedGenerationBatches returns only queued|running batches, same semantics as listInterruptedGenerationJobs", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createGenerationBatch({ id: "batch-queued", total: 1 });
    r.createGenerationBatch({ id: "batch-running", total: 1 });
    r.updateGenerationBatch({ id: "batch-running", status: "running" });
    r.createGenerationBatch({ id: "batch-done", total: 1 });
    r.updateGenerationBatch({ id: "batch-done", status: "done" });

    expect(r.listInterruptedGenerationBatches().map((b) => b.id).sort()).toEqual(["batch-queued", "batch-running"]);
  });

  it("listInterruptedGenerationJobs returns only queued|running rows, across every kind, leaving done/failed ones out", () => {
    const r = sqliteStores(openDb(":memory:"));
    r.createGenerationJob({ id: "gen-queued", kind: "writing" });
    r.createGenerationJob({ id: "gen-running", kind: "speaking" });
    r.updateGenerationJob({ id: "gen-running", status: "running" });
    r.createGenerationJob({ id: "gen-done", kind: "writing" });
    r.updateGenerationJob({ id: "gen-done", status: "done", setId: "wri-11111111" });
    r.createGenerationJob({ id: "gen-failed", kind: "speaking" });
    r.updateGenerationJob({ id: "gen-failed", status: "failed", error: "boom" });

    expect(r.listInterruptedGenerationJobs().map((j) => j.id).sort()).toEqual(["gen-queued", "gen-running"]);
  });
});

// The helper's own coverage guard. helpers/sqliteStores.ts spreads the fifteen real adapters and
// then `testOnlyStatements` last, so a name present in both resolves to the test-only copy.
// Everything above goes through that merge, so a collision fails nothing: it takes the production
// statement out of this suite's reach and leaves every case green. A `latestEstimate` method on the
// estimate store, for instance, would be shadowed by the helper's own.
//
// The guard reads the objects the merge consumes (`sqliteStoreHalves`), not a hand-maintained list
// of names, so a member added to either half is covered the moment it exists. A failure here is
// never fixed by reordering the two spreads, which would break the test-only statement instead.
// One of the two names has to go.
describe("helpers/sqliteStores", () => {
  it("keeps the test-only statements disjoint from every shipped store member, so neither half can silently shadow the other", () => {
    const { production, testOnly } = sqliteStoreHalves(openDb(":memory:"));
    const shipped = new Set(Object.keys(production));

    // The real halves, not an empty or wrong object.
    expect(shipped.size).toBeGreaterThan(80);
    expect(Object.keys(testOnly).length).toBeGreaterThan(5);

    const shadowed = Object.keys(testOnly).filter((name) => shipped.has(name));
    expect(
      shadowed,
      `these test-only statements shadow a shipped store member of the same name, and the merge in `
        + `helpers/sqliteStores.ts resolves them in the test-only copy's favour: ${shadowed.join(", ")}. `
        + `Rename or delete one of the two — do NOT reorder the spreads.`,
    ).toEqual([]);
  });
});
