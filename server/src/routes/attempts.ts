import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  CaptureFinishedRequestSchema,
  ScoreRequestSchema,
  isDeterministicTaskType,
  type AnySet,
  type AttemptDetailVM,
  type AttemptListVM,
  type DeterministicReviewItemVM,
  type ItemVM,
  type JudgeReportVM,
  type PersistedJudgeReport,
  type ScoreRequest,
  type ScoringJobDetailVM,
  type ScoringProgressDetail,
  type SpeakingSet,
  type TranscriptionJobVM,
} from "@toefl-prep/shared";
import {
  pageParam,
  readSetForDisplay,
  setTitleOrNull,
  setTitlesById,
  toAttemptListItemVM,
  toAttemptVM,
  toScoringJobVM,
} from "./attemptViewModels.js";
import { orderBySet } from "../services/setItemOrder.js";
import { config } from "../lib/config.js";
import { sqliteTimestamp, sqliteTimestampToIso } from "../db/timestamps.js";
import type { AttemptStore } from "../services/attemptStore.js";
import { cancellationMetadata } from "../db/cancellationMetadata.js";
import { setStore } from "../services/setStore.js";
import { checkFullTestLink, type FullTestLinkCheckStore, type FullTestRunStore } from "./fullTests.js";
import {
  scoreBuildSentence,
  NotFound,
  PartlyScoredRequest,
  TranscriptionPending,
  type BuildSentenceScoreStore,
  type ScoreDeps,
} from "../services/scoreItems.js";
import { admit, type ScoreStore } from "../services/judgeEnsemble.js";
import {
  scoreDeterministicItems,
  censusRouterItems,
  indexDeterministicItems,
  AlreadyScoredError,
  DuplicateItemIdError,
  KindMismatchError,
  ModuleLockedError,
  UnknownItemError,
  type DeterministicScoreStore,
} from "../services/deterministicScoring.js";
import { decidePath } from "../services/moduleRouter.js";
import { abortScoringJob, enqueueScoringJob, type ScoringStore } from "../services/scoringJobs.js";
import { jobAdmissionsAreOpen } from "../services/jobCancellation.js";
import { intakeRecording, type RecordingIntakeDeps, type RecordingIntakeOutcome, type RecordingStore } from "../services/recordingIntake.js";
import { computeSectionEstimate, readPersistedEstimate, type EstimateStore } from "../services/sectionEstimates.js";
import { attemptBandStatus } from "./attemptBandStatus.js";
import {
  safeErrorDescriptor,
  TranscriptionExecutionUnavailable,
  TranscriptionJobNotRetryable,
  type TranscriptionJobStore,
  type TranscriptionRecovery,
} from "../services/transcriptionRecovery.js";
import {
  AttemptNotFound,
  NotSpeakingSimulation,
  scheduleGraceReconcile,
  SetUnavailable,
  type CaptureFinishedHints,
  type SpeakingFinalization,
} from "../services/speakingFinalization.js";

const CreateAttemptSchema = z.object({
  kind: z.enum(["writing", "speaking", "reading", "listening"]),
  mode: z.enum(["drill", "simulation"]),
  setId: z.string().min(1),
  // Present exactly when this Attempt is a section of a Full-Test Run. The Attempt is created,
  // timed, routed, scored and completed by the same code path as a standalone Simulation; the Run
  // adds only the link check, the link, and the Repeat tag a restarted section inherits. A field
  // rather than a second route, so a Run has no attempt-creation path of its own to drift from this
  // one. `mode` must be "simulation" (checkFullTestLink refuses anything else with 400): a Run
  // section is a Simulation, and the band estimator's Simulation gate applies to it unchanged.
  fullTestRunId: z.string().min(1).optional(),
});

// GET /'s page size when the caller names none, and the most one request may ask for.
const ATTEMPT_PAGE_DEFAULT = 25;
const ATTEMPT_PAGE_MAX = 100;

// A multipart part this small is not a take (a MediaRecorder blob that never got any audio), so it
// is refused here, before intake stages, transcodes or locks anything.
const MIN_RECORDING_BYTES = 512;

type SpeakingItemLookup = { taskType: "listen_repeat" | "interview"; context: string };

// Locates itemId among the Set's Listen and Repeat Items or Interview questions, and builds the
// task-framing context Ears needs to transcribe well. It never includes a Listen and Repeat target
// sentence, only the scenario framing the User already had: Ears must transcribe what was said, and
// a target in its prompt would pull the transcript toward the sentence the User was meant to say.
function findSpeakingItem(set: SpeakingSet, itemId: string): SpeakingItemLookup | undefined {
  const lr = set.listenAndRepeat.items.find((i) => i.id === itemId);
  if (lr) {
    return {
      taskType: "listen_repeat",
      context: `Listen and Repeat task. Scenario: ${set.listenAndRepeat.scenarioTitle} — ${set.listenAndRepeat.scenarioDescription}. The test taker just heard a sentence spoken once and is repeating it from memory.`,
    };
  }
  const question = set.interview.questions.find((i) => i.id === itemId);
  if (question) {
    return {
      taskType: "interview",
      context: `Interview task. Scenario: ${set.interview.scenarioTitle}. The interviewer asked: "${question.question}"`,
    };
  }
  return undefined;
}

/**
 * The persistence this route needs: each aggregate's port, borrowed from the module that owns it.
 * `attemptsRouteStore` (db/stores/index.ts) builds it.
 *
 * Some members are absent on purpose, so the mistakes they would allow cannot be written here:
 *
 *   create-and-supersede  ScoringStore offers `replaceScoringJobAndSupersede` and nothing else that
 *                         creates or supersedes a scoring job, so a new job row is always created in
 *                         the same transaction that ends the older ones for its (Attempt, Task
 *                         Type); there is no two-call version that a crash could split.
 *   write-once capture    CaptureStore's combined seam is the only writer of the capture marker and
 *                         the missing-Item placeholders; the SetUnavailable branches below use it
 *                         with an empty placeholder list.
 *   Full-Test Runs        Only `linkFullTestAttempt`, the reads `checkFullTestLink` needs, and
 *                         `getFullTestRunForAttempt` (the log names a section's Run, and abort
 *                         refuses the section a Run in progress is sitting); the rest of a Run's
 *                         lifecycle belongs to routes/fullTests.ts.
 *   Set supersession      `supersedeSet` is not in scope: retiring a Set belongs to the generation
 *                         runner that published its replacement.
 *
 * Order and the `Omit`s matter. Several ports declare `getAttempt`, and two declare
 * `getScoringJob`, at different widths, and a call through an intersection resolves to the first
 * declaration, not the widest. AttemptStore leads because this route reads `.items`,
 * `.module_path` and `.capture_finished_at` off its `getAttempt`; the narrower ones are omitted.
 * ScoreStore's `getScoringJob` (`{ status }` only) is omitted so ScoringStore's whole row answers,
 * which the score-job endpoints need. Every port is still satisfied, because a wider member is
 * assignable to a narrower one, which is what lets `deps` be passed straight to admit and
 * enqueueScoringJob.
 */
export type AttemptsRouteStore =
  AttemptStore
  & Omit<ScoreStore, "getAttempt" | "getScoringJob">
  & Omit<ScoringStore, "getAttempt">
  & Omit<EstimateStore, "getAttempt">
  & Pick<FullTestRunStore, "linkFullTestAttempt" | "getFullTestRunForAttempt">
  & FullTestLinkCheckStore
  & RecordingStore
  & DeterministicScoreStore
  & BuildSentenceScoreStore
  & Pick<TranscriptionJobStore, "getTranscriptionJob">;

export type AttemptsRouteDeps = Omit<ScoreDeps, "repo"> & {
  repo: AttemptsRouteStore;
  // Both coordinators are passed in, never built here: the transcription coordinator is one per
  // database (createTranscriptionRecovery says why).
  transcriptionRecovery: TranscriptionRecovery;
  speakingFinalization: SpeakingFinalization;
  // The scoring-terminal callback (recovery re-drive, then finalization reconcile), composed once
  // by createSpeakingCoordinators so no call site can drop either half.
  onScoringTerminal: (attemptId: string) => Promise<void>;
  // Recording intake's ffmpeg seam, handed straight through with ScoreDeps' `probeDurationSec`.
  // Production omits both and gets the real binaries; route tests pass in-process fakes.
  transcode?: RecordingIntakeDeps["transcode"];
};

// An unclassified error is logged as a safe descriptor and answered with a bare 500, never rethrown
// into Hono's default handler, which logs the raw error value. Errors reaching here come from fs,
// better-sqlite3 or an injected dependency, and a caught error's message is the field that tends to
// quote its input.
function internalError(c: Context, err: unknown, site: string) {
  console.error(`[attempts] ${site} failed:`, safeErrorDescriptor(err));
  return c.json({ error: "internal error" }, 500);
}

// The recording-upload status map. Intake names what happened; this decides the status. The three
// conflicts:
//
//   publication-in-progress  another upload of this (Attempt, Item) holds its publication lock
//   superseded-recording     these exact bytes belong to a transcription job a later take replaced
//   superseded-admission     publication succeeded but admission lost a race to a newer recording
//
// The last two share a wire message, because to the User they are the same fact (a newer take won),
// while staying distinct names here so changing one cannot move the other.
function respondToRecordingIntake(c: Context, outcome: RecordingIntakeOutcome) {
  switch (outcome.outcome) {
    case "transcribed":
      return c.json(
        { transcript: outcome.transcript, deliveryReport: outcome.deliveryReport, durationSec: outcome.durationSec },
        200,
      );
    case "transcription-pending":
      // Not an error: the upload was accepted and a durable transcription job owns it.
      return c.json({ transcriptionPending: true, job: outcome.job }, 202);
    case "unusable-recording":
      return c.json({ error: "unusable audio recording" }, 400);
    case "unavailable":
      return c.json({ error: "server is not ready" }, 503);
    case "conflict":
      return outcome.conflict === "publication-in-progress"
        ? c.json({ error: "recording upload in progress" }, 409)
        : c.json({ error: "recording superseded" }, 409);
  }
}

// Reads POST /:id/capture-finished's optional hint body. Never throws and never rejects the request:
// an absent body, a non-JSON body and a body that fails the schema all resolve to "no hints", under
// which every missing Item is treated as a deliberate skip rather than a lost upload
// (CaptureFinishedHints).
async function readCaptureFinishedHints(c: Context): Promise<CaptureFinishedHints> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return {};
  }
  const parsed = CaptureFinishedRequestSchema.safeParse(body);
  return parsed.success ? { uploadFailedItemIds: parsed.data.uploadFailedItemIds } : {};
}

// Re-derives the key and Explanation (錯題解析) for every scored Reading or Listening Item of a
// completed Attempt, walking the Set the same way scoreDeterministicItems does
// (indexDeterministicItems). Neither field is persisted to item_results, so the review has nowhere
// else to read them from. The caller gates this on the Attempt being completed: a Simulation's keys
// and Explanations reach the client only after the whole Attempt is done.
function buildDeterministicReview(set: AnySet, items: ItemVM[]): DeterministicReviewItemVM[] | undefined {
  if (set.kind !== "reading" && set.kind !== "listening") return undefined;
  const index = indexDeterministicItems(set);
  const out: DeterministicReviewItemVM[] = [];
  for (const item of items) {
    const ref = index.get(item.itemId);
    if (!ref) continue;
    const correct = item.score === 1;
    if (ref.taskType === "complete_words") {
      out.push({ itemId: item.itemId, taskType: ref.taskType, correct, key: ref.completion, explanationZh: ref.explanationZh });
    } else {
      // `ref.transcript` is passed through as is: absent for Reading and for Listen and Choose a
      // Response (whose utterance is never shown as text, even after answering), present for
      // Listening's conversation, announcement and academic talk. An absent transcript stays an
      // absent key, not `transcript: undefined`.
      out.push({
        itemId: item.itemId,
        taskType: ref.taskType,
        correct,
        key: ref.question.correctOptionId,
        explanationZh: ref.question.explanationZh,
        ...(ref.transcript !== undefined ? { transcript: ref.transcript } : {}),
      });
    }
  }
  return out;
}

// A Build a Sentence score_json without its key (`correctAnswers`): correctness and the frame stay,
// the frame being on screen in the Set as served.
function withoutBuildSentenceKey(scoreJson: unknown): unknown {
  if (typeof scoreJson !== "object" || scoreJson === null || !("correctAnswers" in scoreJson)) return scoreJson;
  const { correctAnswers: _key, ...rest } = scoreJson as Record<string, unknown>;
  return rest;
}

// An Attempt that is over (completed or aborted) takes no new Responses and no new scores: a write
// after completion changes an Attempt whose Band Estimate is already persisted, and a scored Item
// on a discarded one would make its Set count as attempted. The refusal is a plain 409, never
// marked `alreadyScored`, which the client reads as "the server already has this".
function refuseFinishedAttempt(c: Context, attempt: { status: string }) {
  return c.json({ error: `attempt is ${attempt.status}` }, 409);
}

// The one score request an Attempt that is over still takes: the Attempt review's Re-score of a
// completed Attempt's judge-scored Items. Every Item must already have a row of that Task Type, and
// an essay must be re-sent exactly as stored; anything else would add or replace a Response.
function isRescoreOfCompletedAttempt(
  attempt: { status: string; items: { item_id: string; task_type: string; response_text: string | null }[] },
  request: ScoreRequest,
): boolean {
  if (attempt.status !== "completed" || isDeterministicTaskType(request.taskType)) return false;
  const stored = new Map(attempt.items.map((item) => [item.item_id, item]));
  return request.items.every((item) => {
    const row = stored.get(item.itemId);
    if (!row || row.task_type !== request.taskType) return false;
    return "text" in item ? row.response_text === item.text : true;
  });
}

// The job, if any, that is already scoring exactly this essay: queued or running with no cancel
// requested, covering the Item, while the stored Response is the text just sent. Different text is
// a new Response, and a job being cancelled will not produce a score, so neither is joined.
function activeJobScoringSameEssay(
  repo: Pick<AttemptsRouteStore, "listActiveScoringJobsForTask">,
  attempt: { id: string; items: { item_id: string; response_text: string | null }[] },
  essay: { taskType: string; itemId: string; responseText: string },
): string | undefined {
  const stored = attempt.items.find((item) => item.item_id === essay.itemId);
  if (!stored || stored.response_text !== essay.responseText) return undefined;
  const active = repo
    .listActiveScoringJobsForTask(attempt.id, essay.taskType)
    .filter((job) => job.cancel_requested_at == null && (JSON.parse(job.item_ids) as string[]).includes(essay.itemId));
  return active.at(-1)?.id;
}

/**
 * `/api/attempts`: the Attempt lifecycle. Create, upload a recording, score (deterministic Task
 * Types inline, judged ones as a durable job answered with 202 and a job id), route, capture-finish,
 * complete, abort, flag, and the list and review reads.
 */
export function buildAttemptsRoutes(deps: AttemptsRouteDeps) {
  // What a completed Attempt's completion answers: its status and the estimate persisted for it, if
  // any. The same body whether this request completed it or an earlier one did.
  function completedOutcome(attemptId: string) {
    const estimate = readPersistedEstimate(deps.repo, attemptId);
    return estimate ? { status: "completed" as const, estimate } : { status: "completed" as const };
  }

  // The answer to /complete for an Attempt that has already left 'in_progress'. Completion is
  // one-way: an aborted Attempt is never completed (409, without the `alreadyScored` marker the
  // client treats as success), and a completed one answers a repeat with its persisted outcome and
  // writes nothing. Repeats happen: React StrictMode runs a Simulation's completion effect twice in
  // development, and a Drill's Finish can be clicked twice.
  function respondToSettledAttempt(c: Context, attemptId: string) {
    const attempt = deps.repo.getAttempt(attemptId);
    if (attempt?.status === "completed") return c.json(completedOutcome(attemptId), 200);
    return c.json({ error: `attempt is ${attempt?.status ?? "missing"}` }, 409);
  }

  // Completes an in-progress Attempt, without waiting on outstanding work, and recomputes its
  // estimate from what is scored now. Used by Writing, Speaking Drills, and Reading and Listening;
  // the estimate rules, including the Simulation + Module Path gate, are recomputeSectionEstimate's.
  //
  // A Speaking Drill answers here rather than through reconcileAttempt, which declines while any
  // transcription or scoring work is active and so would answer a Drill finished with one Item still
  // retrying with no estimate. reconcileAttempt still recomputes a completed Drill's estimate on
  // every later terminal transition, so the two cannot disagree about the same state.
  //
  // A Speaking Simulation never comes here, even with an unreadable Set: it completes only through
  // reconcileAttempt, which waits for its work to end. Completing it here would stamp completed_at,
  // which never moves afterwards, and could compute a band while Items are still being scored.
  //
  // The completion and the estimate commit together (settleAttempt), so a fault between them leaves
  // the Attempt in progress rather than completed without its estimate. The caller has already
  // answered an Attempt that left 'in_progress' earlier, which is what keeps a repeated /complete
  // from recomputing anything.
  function completeWithLocalEstimate(c: Context, attemptId: string) {
    const settled = deps.repo.settleAttempt({ attemptId });
    if (!settled?.completedNow) return respondToSettledAttempt(c, attemptId);

    // Null means the Attempt completes without an estimate: the response carries no `estimate`
    // field, and any stored estimate row for it is cleared.
    if (!settled.estimate) return c.json({ status: "completed" });

    // SectionEstimateVM, the same shape the reconciliation branch returns.
    return c.json({ status: "completed", estimate: settled.estimate });
  }

  // Runs the durable finalizer for a capture-finished Speaking Simulation and answers with what it
  // achieved: 200 once the Attempt is complete, otherwise 202 with one delayed re-reconcile armed.
  // Shared by POST /:id/capture-finished and POST /:id/complete so both reach completion through
  // the same reconciliation and the same estimate writer.
  async function respondAfterReconcile(attemptId: string) {
    await deps.speakingFinalization.reconcileAttempt(attemptId);
    const fresh = deps.repo.getAttempt(attemptId);
    if (fresh?.status === "completed") return { body: completedOutcome(attemptId), status: 200 as const };
    scheduleGraceReconcile(deps.speakingFinalization, attemptId);
    return { body: { status: "finalizing" as const }, status: 202 as const };
  }

  return new Hono()
    .post("/", async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON" }, 400);
      }
      const parsed = CreateAttemptSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
      const { kind, mode, setId, fullTestRunId } = parsed.data;
      const set = setStore.readSet(setId);
      if (!set) return c.json({ error: "unknown set" }, 404);
      if (set.kind !== kind) return c.json({ error: "set kind mismatch" }, 400);

      // Everything a Run needs checked is checked before the Attempt row exists, so a refused link
      // never leaves a stray in-progress Attempt behind. The rule is checkFullTestLink's.
      let replacedSectionAttemptId: string | null = null;
      if (fullTestRunId) {
        const check = checkFullTestLink(deps.repo, fullTestRunId, kind, setId, mode);
        if (!check.ok) return c.json({ error: check.error }, check.status);
        // The section's current Attempt, which this one replaces: a section restarted after a
        // reload (checkFullTestLink only lets an in-progress one be replaced).
        replacedSectionAttemptId = check.run[`${kind}_attempt_id`];
      }

      // A restarted Full-Test section is the same sitting as the Attempt it replaces, so it carries
      // that Attempt's tag. Recomputing would count the replaced sitting itself once it held a
      // scored Item, and after a second reload the first sitting would still count even though the
      // Run no longer points at it.
      const replaced = replacedSectionAttemptId ? deps.repo.getAttempt(replacedSectionAttemptId) : undefined;
      const isRepeat = replaced ? replaced.is_repeat === 1 : deps.repo.isSetAttempted(setId);
      const id = crypto.randomUUID();
      deps.repo.createAttempt({ id, kind, mode, setId, isRepeat });
      if (fullTestRunId) deps.repo.linkFullTestAttempt(fullTestRunId, kind, id);
      return c.json({ attemptId: id, isRepeat, ...(fullTestRunId ? { fullTestRunId } : {}) }, 201);
    })
    .post("/:id/items/:itemId/audio", async (c) => {
      const attemptId = c.req.param("id");
      const itemId = c.req.param("itemId");
      const attempt = deps.repo.getAttempt(attemptId);
      if (!attempt || attempt.kind !== "speaking") return c.json({ error: "unknown attempt" }, 404);
      if (attempt.status !== "in_progress") return refuseFinishedAttempt(c, attempt);

      const set = setStore.readSet(attempt.set_id);
      if (!set || set.kind !== "speaking") return c.json({ error: "unknown set" }, 404);

      const lookup = findSpeakingItem(set, itemId);
      if (!lookup) return c.json({ error: "unknown item" }, 404);

      let file: unknown;
      try {
        const parsedBody = await c.req.parseBody();
        file = parsedBody.file;
      } catch {
        return c.json({ error: "no usable recording" }, 400);
      }
      if (!(file instanceof File) || file.size < MIN_RECORDING_BYTES) {
        return c.json({ error: "no usable recording" }, 400);
      }

      // Staging through the transcription hand-off is recordingIntake's; this route only maps its
      // outcome to a status. An unclassified fault is answered by internalError, as on every other
      // route here.
      try {
        const outcome = await intakeRecording(
          {
            store: deps.repo,
            transcriptionRecovery: deps.transcriptionRecovery,
            transcode: deps.transcode,
            probeDurationSec: deps.probeDurationSec,
          },
          {
            attemptId,
            itemId,
            taskType: lookup.taskType,
            context: lookup.context,
            bytes: Buffer.from(await file.arrayBuffer()),
          },
        );
        return respondToRecordingIntake(c, outcome);
      } catch (err) {
        return internalError(c, err, "recording upload");
      }
    })
    // Manual recovery for a transcription job whose automatic retries are spent (the review's
    // "Retry transcription"). The body is empty: the server takes the recording path and hash from
    // the job row and revalidates both before calling Ears, so a client cannot point recovery at an
    // arbitrary path and the User never re-uploads.
    .post("/:id/transcription-jobs/:jobId/retry", async (c) => {
      const attemptId = c.req.param("id");
      const jobId = c.req.param("jobId");
      const attempt = deps.repo.getAttempt(attemptId);
      if (!attempt) return c.json({ error: "unknown attempt" }, 404);

      // A job of another Attempt is a 404, as in GET /:id/score-jobs/:jobId: indistinguishable from
      // a job that does not exist.
      const job = deps.repo.getTranscriptionJob(jobId);
      if (!job || job.attempt_id !== attemptId) return c.json({ error: "not found" }, 404);

      try {
        if (!jobAdmissionsAreOpen()) return c.json({ error: "server is not ready" }, 503);
        const retried = await deps.transcriptionRecovery.retry(jobId);
        return c.json({ job: retried }, 200);
      } catch (err) {
        if (err instanceof TranscriptionExecutionUnavailable) return c.json({ error: "server is not ready" }, 503);
        // Only the module's named conflict is a 409: the job is not at 'failed', or a re-record has
        // replaced it as its Item's current job. Anything else (a row gone mid-operation, a
        // database fault) is a 500, never "not retryable". No error message is echoed back.
        if (err instanceof TranscriptionJobNotRetryable) {
          return c.json({ error: "transcription job is not retryable" }, 409);
        }
        return internalError(c, err, "transcription retry");
      }
    })
    // Marks a Speaking Simulation's capture finished and runs its durable finalization; idempotent.
    // The body names no Items: the server derives the expected ids from the immutable Set, so a
    // client that lost an upload response cannot also lose the Item from the reconciliation.
    //
    // The client is expected to settle every score submission first, because "pending +
    // transcript + no covering scoring job" is also the state a healthy upload occupies for a moment
    // between transcription and POST /score. The server does not rely on that ordering:
    // reconcileAttempt will not heal an Item while the marker is younger than its grace margin, and
    // respondAfterReconcile arms a delayed re-reconcile for after it.
    .post("/:id/capture-finished", async (c) => {
      const attemptId = c.req.param("id");
      // The hint body is optional: absent, unparseable or failing the schema all mean no hints,
      // never a 400. Hints only turn a missing Item from a skip scored 0 into a recording that never
      // arrived (failed, so the Attempt has no band until it is dealt with). Losing them costs that
      // distinction; rejecting the request would leave the Attempt with no capture marker, which
      // nothing ever finalizes.
      //
      // A repeat after the Simulation completed (the client re-posts this when a response was
      // lost) gets the completion's answer and writes nothing: no new placeholder may land on a
      // completed Attempt. An aborted one is refused. Anything else falls through to finalization,
      // which owns the "is this a Speaking Simulation" check.
      const finished = deps.repo.getAttempt(attemptId);
      if (finished?.status === "aborted") return refuseFinishedAttempt(c, finished);
      if (finished?.status === "completed" && finished.kind === "speaking" && finished.mode === "simulation") {
        return c.json(completedOutcome(attemptId), 200);
      }
      const hints = await readCaptureFinishedHints(c);
      try {
        await deps.speakingFinalization.markCaptureFinished(attemptId, hints);
        // Inside the try, so a reconciliation fault is answered by internalError rather than
        // reaching Hono's default handler.
        const { body, status } = await respondAfterReconcile(attemptId);
        return c.json(body, status);
      } catch (err) {
        // speakingFinalization's own error classes, distinct from scoreItems' `NotFound`.
        if (err instanceof AttemptNotFound) return c.json({ error: "unknown attempt" }, 404);
        if (err instanceof NotSpeakingSimulation) return c.json({ error: "not a speaking simulation" }, 400);
        if (err instanceof SetUnavailable) {
          // No readable Set means no expected Item ids and no placeholders, so only the marker is
          // written, through the same seam with an empty placeholder list, and then the same
          // reconciliation every Simulation runs. A 500 instead would leave the marker NULL, and an
          // Attempt without one is skipped by reconcileAttempt and by the boot pass, so it would
          // never complete. Completing it locally instead would bypass reconcileAttempt's wait for
          // active work. If the Set becomes readable later, a repeated capture-finished keeps this
          // marker (COALESCE) and can still add the placeholders (ON CONFLICT DO NOTHING).
          const attempt = deps.repo.getAttempt(attemptId);
          if (!attempt) return c.json({ error: "unknown attempt" }, 404);
          console.warn(
            `[attempts] capture-finished: speaking simulation ${attemptId} has no readable question set; marking capture finished without missing-upload placeholders`,
          );
          // Its own try: this runs inside the handler's catch, so a throw here would otherwise reach
          // Hono's default handler, which logs the raw error value.
          try {
            deps.repo.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, placeholders: [] });
            const { body, status } = await respondAfterReconcile(attemptId);
            return c.json(body, status);
          } catch (reconcileErr) {
            return internalError(c, reconcileErr, "capture-finished");
          }
        }
        return internalError(c, err, "capture-finished");
      }
    })
    .post("/:id/score", async (c) => {
      const attemptId = c.req.param("id");
      const attempt = deps.repo.getAttempt(attemptId);
      if (!attempt) return c.json({ error: "unknown attempt" }, 404);

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON" }, 400);
      }
      const parsed = ScoreRequestSchema.safeParse(body);
      if (!parsed.success) return c.json({ error: parsed.error.message }, 400);
      if (attempt.status !== "in_progress" && !isRescoreOfCompletedAttempt(attempt, parsed.data)) {
        return refuseFinishedAttempt(c, attempt);
      }

      const set = setStore.readSet(attempt.set_id);
      if (!set) return c.json({ error: "unknown set" }, 404);

      // The eight deterministic Task Types (Build a Sentence, Reading's three, Listening's four) are
      // scored synchronously, with no scoring_jobs row and no Judges or Arbiter: tile, typed-letter
      // and option matching has no model in the loop, and the client reads the result inline.
      if (isDeterministicTaskType(parsed.data.taskType)) {
        if (parsed.data.taskType === "build_sentence") {
          try {
            return c.json(scoreBuildSentence(deps.repo, attempt, set, parsed.data), 200);
          } catch (err) {
            if (err instanceof NotFound) return c.json({ error: err.message }, 404);
            // A Simulation's request mixing scored and unscored Items: a plain 409, never marked
            // `alreadyScored`, because part of it never landed.
            if (err instanceof PartlyScoredRequest) return c.json({ error: err.message }, 409);
            throw err;
          }
        }

        // Reading and Listening: scoreDeterministicItems validates the whole request (Attempt and Set
        // kind, unknown Item ids, already-scored Task Types) before it writes anything.
        try {
          const result = scoreDeterministicItems({ repo: deps.repo, attempt, set, request: parsed.data });
          return c.json(result, 200);
        } catch (err) {
          if (err instanceof NotFound) return c.json({ error: err.message }, 404);
          if (err instanceof UnknownItemError) return c.json({ error: err.message }, 404);
          // `alreadyScored: true` tells this 409 apart from the other two: a client retrying a
          // Reading or Listening Module submission treats it as accepted (the server already has
          // this Task Type), and must never swallow a kind mismatch or a locked Module. Never
          // inferred from `err.message`, which is free text.
          if (err instanceof AlreadyScoredError) return c.json({ error: err.message, alreadyScored: true }, 409);
          if (err instanceof KindMismatchError) return c.json({ error: err.message }, 409);
          if (err instanceof ModuleLockedError) return c.json({ error: err.message }, 409);
          // A DuplicateItemIdError (a Set two of whose Items share an id) lands here too: the Set
          // cannot be scored safely, and nothing is written.
          return internalError(c, err, "score");
        }
      }

      // The judged Task Types (Email, Academic Discussion, Listen and Repeat, Interview) are scored
      // by a durable job. Every check that could 404 or 409 runs here, before anything is written:
      // `admit` is the read-only scoreability check scoreItems also runs inside the job. Its
      // "not-scoreable-here" verdict is ignored rather than mapped to a 404, because the Task Types
      // it reports that way are the deterministic ones, already answered above.
      let admission: ReturnType<typeof admit>;
      try {
        admission = admit(deps.repo, attemptId, set, parsed.data);
      } catch (err) {
        if (err instanceof NotFound) return c.json({ error: err.message }, 404);
        if (err instanceof TranscriptionPending) return c.json({ error: err.message, itemIds: err.itemIds }, 409);
        throw err;
      }

      if (!jobAdmissionsAreOpen()) return c.json({ error: "server is shutting down" }, 503);

      // An essay exists only in this request body, so it is stored before the job is created: a job
      // that never runs (admissions closing before the runner claims it, a crash) still leaves the
      // Response on the Attempt to be scored later. The same text written again over a committed
      // score keeps that score until the re-score commits (ITEM_RESULT_UPSERT_SQL). A recording
      // needs no write here: `admit` refuses an Item whose upload has not landed.
      if (admission.verdict === "ok" && admission.admitted.kind === "essay") {
        const { taskType, itemId, responseText } = admission.admitted;
        // The same essay sent again while its job is still queued or running joins that job. A
        // client that gave up waiting for the first answer, or reloaded before it recorded it, sends
        // the Response a second time; superseding there would abort Judge calls already paid for
        // and buy the whole run again for text that has not changed.
        const joined = activeJobScoringSameEssay(deps.repo, attempt, { taskType, itemId, responseText });
        if (joined) return c.json({ jobId: joined }, 202);
        deps.repo.insertItemResult({ attemptId, itemId, taskType, responseText });
      }

      // `supersedeActive: true` creates the new job row in the same transaction that supersedes the
      // older active ones for this (Attempt, Task Type).
      const jobId = enqueueScoringJob(
        deps,
        { attemptId, set, request: parsed.data },
        {
          supersedeActive: true,
          // The same callback a recovery-created scoring job gets: first the transcription re-drive,
          // which hands off any recovered Item that waited because this job was active for its Task
          // Type, then the finalization reconcile that completes a capture-finished Simulation. A
          // fault in either half does not skip the other.
          onTerminal: deps.onScoringTerminal,
        },
      );

      return c.json({ jobId }, 202);
    })
    .post("/:id/score-jobs/:jobId/cancel", (c) => {
      const attemptId = c.req.param("id");
      const jobId = c.req.param("jobId");
      const job = deps.repo.getScoringJob(jobId);
      if (!job || job.attempt_id !== attemptId) return c.json({ error: "not found" }, 404);
      const result = deps.repo.requestScoringJobCancellation({ id: jobId, reason: "user", now: sqliteTimestamp() });
      if (!result?.accepted) return c.json({ error: "scoring job already finished" }, 409);
      abortScoringJob(jobId, "user");
      const current = deps.repo.getScoringJob(jobId);
      return c.json({
        jobId,
        status: current?.status ?? job.status,
        ...cancellationMetadata(current),
      }, 200);
    })
    .get("/:id/score-jobs/:jobId", (c) => {
      const attemptId = c.req.param("id");
      const jobId = c.req.param("jobId");
      const job = deps.repo.getScoringJob(jobId);
      if (!job || job.attempt_id !== attemptId) return c.json({ error: "not found" }, 404);

      // Defensive corrupt-JSON handling, same convention as GET /:id below — progress/result are
      // only ever written by this server, but a null/undefined fallback is cheap insurance against
      // a 500 on read-back.
      let progress: ScoringProgressDetail | null = null;
      if (job.progress) {
        try {
          progress = JSON.parse(job.progress) as ScoringProgressDetail;
        } catch {
          progress = null;
        }
      }

      const body: ScoringJobDetailVM = {
        ...toScoringJobVM(job),
        progress,
        ...cancellationMetadata(job),
      };
      if (job.result !== null) {
        try {
          body.result = JSON.parse(job.result);
        } catch {
          body.result = null;
        }
      }
      if (job.error !== null) body.error = job.error;

      return c.json(body satisfies ScoringJobDetailVM, 200);
    })
    .post("/:id/flag", (c) => {
      const attemptId = c.req.param("id");
      const attempt = deps.repo.getAttempt(attemptId);
      if (!attempt) return c.json({ error: "unknown attempt" }, 404);
      deps.repo.flagAttempt(attemptId);
      return c.json({ status: "flagged" });
    })
    // The Router Module to Lower/Upper Module gate for a Reading or Listening Simulation. The client
    // calls this once every Router Module Item is scored; the server checks the full census itself
    // rather than trusting the client's timing.
    .post("/:id/route", (c) => {
      const attemptId = c.req.param("id");
      const attempt = deps.repo.getAttempt(attemptId);
      if (!attempt) return c.json({ error: "unknown attempt" }, 404);

      // A Drill exposes only the Router Module and is never routed. Checked before the stored
      // decision, so a Drill always gets this answer.
      if (attempt.mode !== "simulation") {
        return c.json({ error: "routing is simulation-only" }, 409);
      }

      // Idempotent replay: the decision is returned as stored, with no Set read, census or write,
      // so a second POST can never compute a different answer or re-stamp router_raw. Ahead of the
      // status check, so a client whose routing response was lost still gets it after the Attempt
      // has ended.
      if (attempt.module_path !== null) {
        return c.json({ path: attempt.module_path, routerRaw: attempt.router_raw }, 200);
      }

      // Only an Attempt still being sat is routed. A completed or discarded one never sat a second
      // Module, and a Module Path written onto it afterwards would claim it had (and its Band
      // Estimate was settled at completion, without one).
      if (attempt.status !== "in_progress") return refuseFinishedAttempt(c, attempt);

      const set = setStore.readSet(attempt.set_id);
      if (!set) return c.json({ error: "unknown set" }, 404);

      try {
        const census = censusRouterItems(set, attempt);
        if (census.missing > 0) {
          return c.json({ error: `router module incomplete: ${census.missing} item(s) not yet scored` }, 409);
        }
        // censusRouterItems throws on an empty census, so decidePath never sees (0, 0), which would
        // yield a NaN routerRaw.
        const { path, routerRaw } = decidePath(census.correctCount, census.total);
        deps.repo.setAttemptRouting(attemptId, path, routerRaw);
        return c.json({ path, routerRaw }, 200);
      } catch (err) {
        if (err instanceof NotFound) return c.json({ error: err.message }, 404);
        if (err instanceof KindMismatchError) return c.json({ error: err.message }, 409);
        return internalError(c, err, "route");
      }
    })
    // Discards an Attempt the User is never going to finish; the counterpart to /complete. Nothing
    // else writes 'aborted', and boot recovery completes only Speaking Simulations with a capture
    // marker, so without this an abandoned Attempt stays in progress forever.
    //
    // It deletes nothing: the row and its Item rows stay (if it holds a scored Item, its Set still
    // counts as attempted). It is not completion either: an aborted Attempt gets no band, so a
    // partial run never becomes a data point.
    //
    // The answer comes from the guarded write, not from the read before it: when a completion lands
    // in between, the write changes nothing and the 409 names the state the Attempt is really in.
    //
    // The unfinished section a Full-Test Run in progress is sitting is refused: a Run never re-sits
    // an abandoned section, so discarding it would cost the Run its Overall for good. It is finished
    // inside the Run. /complete is not refused the same way, because the section's own flow calls it.
    .post("/:id/abort", (c) => {
      const attemptId = c.req.param("id");
      const attempt = deps.repo.getAttempt(attemptId);
      if (!attempt) return c.json({ error: "unknown attempt" }, 404);
      const run = attempt.status === "in_progress" ? deps.repo.getFullTestRunForAttempt(attemptId) : undefined;
      if (run?.status === "in-progress") {
        return c.json({
          error: "This Attempt is a section of a Full-Test Run in progress, and a discarded section can never be sat again. Resume the Run to finish it.",
          fullTestRunId: run.id,
        }, 409);
      }
      if (attempt.status === "in_progress" && deps.repo.abortAttempt(attemptId)) {
        return c.json({ status: "aborted" });
      }
      const current = deps.repo.getAttempt(attemptId);
      return c.json({ error: `attempt is already ${current?.status ?? attempt.status}` }, 409);
    })
    .post("/:id/complete", async (c) => {
      const attemptId = c.req.param("id");
      const attempt = deps.repo.getAttempt(attemptId);
      if (!attempt) return c.json({ error: "unknown attempt" }, 404);
      // Ahead of the Speaking Simulation branch, so an aborted Simulation is refused before any
      // capture marker is written for it.
      if (attempt.status !== "in_progress") return respondToSettledAttempt(c, attemptId);

      // A Speaking Simulation completes through the durable finalizer, exactly as POST
      // /capture-finished does: reconciliation decides when it is done, and the answer is 202 while
      // work is outstanding. Speaking Drills and Writing complete below (completeWithLocalEstimate
      // says why).
      if (attempt.kind === "speaking" && attempt.mode === "simulation") {
        try {
          // No hints: this entry point carries no body, so every missing Item is a deliberate skip
          // scored 0, and a lost upload is not told apart from a skip.
          await deps.speakingFinalization.markCaptureFinished(attemptId);
          const { body, status } = await respondAfterReconcile(attemptId);
          return c.json(body, status);
        } catch (err) {
          // AttemptNotFound and NotSpeakingSimulation cannot happen here: both facts were just read
          // off the row. A reconciliation fault is inside this try, so it reaches internalError.
          if (!(err instanceof SetUnavailable)) return internalError(c, err, "complete");
          console.warn(
            `[attempts] complete: speaking simulation ${attemptId} has no readable question set; marking capture finished without missing-upload placeholders`,
          );
          // The same handling as POST /capture-finished's SetUnavailable branch, and for the same
          // reasons: the marker alone, through the store's seam (markCaptureFinished is what just
          // threw), then the same gated reconciliation.
          try {
            deps.repo.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, placeholders: [] });
            const { body, status } = await respondAfterReconcile(attemptId);
            return c.json(body, status);
          } catch (reconcileErr) {
            return internalError(c, reconcileErr, "complete");
          }
        }
      }

      // A fault in the settling transaction (completeWithLocalEstimate) has changed nothing.
      try {
        const response = completeWithLocalEstimate(c, attemptId);
        // A Speaking Drill needs one reconcile after completion. reconcileAttempt ignores a Drill that
        // is not yet completed, so the reconcile its last scoring job fired ran too early, and an Item
        // left uncovered (say, covered only by a superseded job) would otherwise stay pending until
        // the next boot. It is the delayed reconcile, not an inline one: a healthy recovered Item is
        // briefly uncovered between its transcript landing and its scoring job being created, and a
        // completed Drill gets no grace margin from reconcileAttempt, so the delay is what keeps such
        // an Item from being failed. Work still active when it fires is declined and covered by that
        // work's own terminal callback.
        if (attempt.kind === "speaking") scheduleGraceReconcile(deps.speakingFinalization, attempt.id);
        return response;
      } catch (err) {
        return internalError(c, err, "complete");
      }
    })
    // The Attempt log, one page at a time: `total` counts every Attempt matching the filters, so a
    // caller can say how many there are and fetch the rest.
    .get("/", (c) => {
      const kind = c.req.query("kind") || undefined;
      const setId = c.req.query("setId") || undefined;
      const limit = pageParam(c.req.query("limit"), ATTEMPT_PAGE_DEFAULT, 1, ATTEMPT_PAGE_MAX);
      const offset = pageParam(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER);
      const rows = deps.repo.listAttempts({ kind, setId, limit, offset });
      const titles = setTitlesById(rows.map((row) => row.set_id));
      return c.json({
        items: rows.map((row) => toAttemptListItemVM(row, titles.get(row.set_id) ?? null, deps.repo)),
        total: deps.repo.countAttempts({ kind, setId }),
      } satisfies AttemptListVM);
    })
    .get("/:id", (c) => {
      const attempt = deps.repo.getAttempt(c.req.param("id"));
      if (!attempt) return c.json({ error: "not found" }, 404);

      // Display-only: the Set orders the Items, titles the Attempt and supplies a completed
      // Reading/Listening review. An unreadable Set degrades each of those, never the readback.
      const set = readSetForDisplay(attempt.set_id);
      const attemptVM = toAttemptVM(attempt, setTitleOrNull(set));

      // The current transcription job per Item, as TranscriptionJobVM (status, attempt count, retry
      // timing, failure kind, safe error, linked scoring job; never the recording path, its hash,
      // the transcript or a provider body). A finished job whose result has landed is left out, so
      // an ordinary scored Attempt carries no `transcriptionJob` at all. A failing read degrades to
      // no transcription jobs rather than failing the whole readback.
      let transcriptionJobs: ReadonlyMap<string, TranscriptionJobVM> = new Map();
      try {
        transcriptionJobs = deps.transcriptionRecovery.readAttemptSnapshot(attempt.id);
      } catch (err) {
        console.error("[attempts] transcription snapshot failed:", safeErrorDescriptor(err));
      }

      // A Simulation's keys reach the client only once the Attempt is completed, as
      // deterministicReview's do for Reading and Listening. Build a Sentence keeps its key in
      // score_json (so a completed Attempt's review shows the key it was scored against), so that
      // field is withheld here until then. A Drill's score response has already shown its keys.
      const withholdKeys = attempt.mode !== "drill" && attempt.status !== "completed";

      // A corrupt score_json (persisted state can outlive the code that wrote it) nulls that Item's
      // parsed field rather than failing the readback. Items are listed in the Set's exam order,
      // not the order the rows were stored.
      const items: ItemVM[] = orderBySet(attempt.items.map((item) => {
        let scoreJson: unknown | null = null;
        if (item.score_json) {
          try {
            scoreJson = JSON.parse(item.score_json);
          } catch {
            scoreJson = null;
          }
        }
        if (withholdKeys && item.task_type === "build_sentence") scoreJson = withoutBuildSentenceKey(scoreJson);
        const transcriptionJob = transcriptionJobs.get(item.item_id);
        return {
          attemptId: item.attempt_id,
          itemId: item.item_id,
          taskType: item.task_type,
          responseText: item.response_text,
          responseAudioPath: item.response_audio_path,
          transcript: item.transcript,
          score: item.score,
          scoreJson,
          scoringStatus: item.scoring_status,
          deliveryReport: item.delivery_report,
          createdAt: sqliteTimestampToIso(item.created_at),
          // Spread rather than `transcriptionJob: undefined`, so an Item with no current job has no
          // such key.
          ...(transcriptionJob ? { transcriptionJob } : {}),
        };
      }), set);

      // Judge Reports parsed: judge and mode at the top level, the full report under `report`. A
      // corrupt report becomes null (mode undefined) rather than throwing.
      const judgeReports: JudgeReportVM[] = deps.repo.getJudgeReports(attempt.id).map((row) => {
        let report: PersistedJudgeReport | null = null;
        try {
          report = JSON.parse(row.report_json) as PersistedJudgeReport;
        } catch {
          report = null;
        }
        return {
          itemId: row.item_id,
          judge: row.judge as "gemini" | "openai",
          mode: report?.mode,
          report,
        };
      });

      // The estimate persisted for this Attempt, if it passes the band rule. Read through
      // readPersistedEstimate, so this read and the completion responses above return the same
      // shape from the same row.
      const estimate = readPersistedEstimate(deps.repo, attempt.id);

      // Queued or running scoring jobs, so a returning client re-attaches to live progress instead
      // of showing "not yet scored" for an Item whose score is on its way. Deterministic Task Types
      // never appear: they are scored inline, with no job row. Each job names the Items it covers,
      // so its progress is drawn over those Items only.
      const activeJobs = deps.repo.listActiveJobs(attempt.id).map(toScoringJobVM);

      // Why there is or is not a band, decided from the same estimate rule the writers use.
      const bandStatus = attemptBandStatus({
        attempt,
        estimate,
        computed: computeSectionEstimate(attempt),
        activeJobs,
        transcriptionStatuses: [...transcriptionJobs.values()].map((job) => job.status),
      });

      // The key and Explanation review, for a completed Reading or Listening Attempt only, in either
      // mode. A missing or unreadable Set omits the field rather than failing the readback.
      let deterministicReview: DeterministicReviewItemVM[] | undefined;
      if (set && attempt.status === "completed" && (attempt.kind === "reading" || attempt.kind === "listening")) {
        try {
          deterministicReview = buildDeterministicReview(set, items);
        } catch (err) {
          // Two Items sharing an id: either key could be shown against either Response, so the
          // review is left out rather than risk teaching a wrong answer.
          if (!(err instanceof DuplicateItemIdError)) throw err;
          console.error("[attempts] review omitted:", safeErrorDescriptor(err), err.setId, err.itemId);
        }
      }

      return c.json({
        attempt: attemptVM,
        items,
        judgeReports,
        estimate,
        bandStatus,
        activeJobs,
        ...(deterministicReview ? { deterministicReview } : {}),
      } satisfies AttemptDetailVM);
    });
}
