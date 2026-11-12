import type { AnySet, ScoreReport, ScoreRequest, ScoringProgressDetail } from "@toefl-prep/shared";
import { JudgeError } from "./judges/index.js";
import type { ArbitrationOptions, ArbitrationResult } from "./arbiter.js";
import type { ReasoningEvent } from "./reasoning/contracts.js";
import { NotFound, Rescorable, TranscriptionPending } from "./scoringErrors.js";
import { wordDiff, type DiffOp } from "./wordDiff.js";

// The Judge ensemble (ADR 0001): two independent Judges from different model families, then an
// Arbiter, as three responsibilities:
//
//   admit      the side-effect-free scoreability check for a Response, and the resolution of the
//              materials a scoreable one is judged against. The /score route calls it before any
//              scoring job exists, and scoreItems calls it again when the job runs. Throws
//              NotFound/TranscriptionPending; returns a verdict otherwise.
//   runJudges  the fixed Gemini-and-OpenAI fan-out: per-settlement progress, per-Judge materials,
//              and the one piece of provider provenance arbitration may see.
//   arbitrate  Score Report assembly: the Arbiter call, its progress forwarding, and the single
//              failure path that marks the Items rescorable.
//
// Essay and Speaking are adapters over these three (scoreEssay/scoreSpeaking in scoreItems.ts).
// They differ only in materials, arbitration batching (one Item per call vs the whole Task Type in
// one call), and Speaking's audio-vs-Text-Fallback modes.
//
// The ensemble takes the narrow ScoreStore port below, and every write a superseded job must not
// make goes through the one `persist` seam (ScoringSession).

// ---------------------------------------------------------------------------------------------
// Persistence port
// ---------------------------------------------------------------------------------------------

// One persisted Response row (item_results), narrowed to the fields the ensemble actually reads.
export type ResponseRow = {
  item_id: string;
  scoring_status: string;
  transcript: string | null;
  delivery_report: string | null;
  response_audio_path: string | null;
};

export type RecordResponseInput = { attemptId: string; itemId: string; taskType: string; responseText: string };
export type ItemScoreWrite = { attemptId: string; itemId: string; score: number | null; scoreJson: string; scoringStatus: string };
export type JudgeReportWrite = { attemptId: string; itemId: string; judge: string; reportJson: string };

// The persistence the ensemble depends on, declared as the members it uses rather than as the whole
// repo. Its SQLite implementation is the `attempts` store (db/stores/attempts.ts) plus
// `getScoringJob` from the scoring store, composed in db/stores/index.ts. Inside a scoring job,
// scoreItems is handed createBufferedScoringPersistence's wrapper over that store instead: the three
// GuardedWrites are queued and committed in the transaction that ends the job 'done' or 'failed',
// so a re-score's writes land together with its result, and a run that has lost its job writes
// none. scoringJobs.ts's ScoringStore extends this port with the scoring_jobs members rather than
// restating it.
export type ScoreStore = {
  getScoringJob(id: string): { status: string } | undefined;
  getAttempt(id: string): { items: ResponseRow[] } | undefined;
  insertItemResult(input: RecordResponseInput): void;
  updateItemScore(input: ItemScoreWrite): void;
  deleteJudgeReports(attemptId: string, itemId: string): void;
  insertJudgeReport(input: JudgeReportWrite): void;
  /**
   * The read half of `judge_reports`, ordered by `created_at, rowid`. The ensemble never calls it
   * (the Attempt review route does); it is declared beside the two writers so the table has one port.
   */
  getJudgeReports(attemptId: string): { item_id: string; judge: string; report_json: string }[];
};

// The three writes a superseded job must never make. Reachable only as the argument `persist` hands
// its step. Under a scoring job they reach the job's buffer, not the database (see ScoreStore).
export type GuardedWrites = Pick<ScoreStore, "updateItemScore" | "deleteJudgeReports" | "insertJudgeReport">;

export type ScoringSession = {
  // The one unguarded write: the essay adapter records the User's Response before the Judges run,
  // so the Response survives a scoring failure or a supersede. Speaking has no analogue: its
  // Response was written by the recording upload before scoring started.
  recordResponse(input: RecordResponseInput): void;
  // Runs `step` only while this session's job is still 'running', handing it the only reference to
  // the guarded writes, so a new write site cannot skip the check. A step may hold several writes
  // (Speaking marks every requested Item failed as one step) or a non-write that a superseded job
  // must not make either (the `persisting` progress event).
  //
  // The job status is re-read on every call, never cached: a newer score request for the same
  // Attempt and Task Type can supersede this job (`replaceScoringJobAndSupersede`) at any point
  // during the Judges' or the Arbiter's work. persist reports nothing; a caller that must still throw after
  // a skipped step throws itself.
  persist(step: (writes: GuardedWrites) => void): void;
};

// Without a jobId (a direct caller outside the scoring-job system) the session counts as always
// active, and persist runs every step.
export function createScoringSession(store: ScoreStore, jobId?: string): ScoringSession {
  const writes: GuardedWrites = {
    updateItemScore: (input) => store.updateItemScore(input),
    deleteJudgeReports: (attemptId, itemId) => store.deleteJudgeReports(attemptId, itemId),
    insertJudgeReport: (input) => store.insertJudgeReport(input),
  };
  return {
    recordResponse: (input) => store.insertItemResult(input),
    persist(step) {
      if (jobId && store.getScoringJob(jobId)?.status !== "running") return;
      step(writes);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------

// Reported at real checkpoints only, never on a timer: each Judge settling, the Arbiter starting,
// and persisting the final result.
export type ScoringProgress = {
  stage: "judging" | "aggregating" | "persisting";
  detail?: ScoringProgressDetail;
};
export type OnScoringProgress = (progress: ScoringProgress) => void;

function forwardArbitrationProgress(
  onProgress: OnScoringProgress | undefined,
  event: ReasoningEvent,
): void {
  if (event.state === "queued") {
    onProgress?.({
      stage: "aggregating",
      detail: {
        arbiterProvider: event.provider,
        queuePosition: event.queuePosition,
      },
    });
    return;
  }
  onProgress?.({
    stage: "aggregating",
    detail: {
      arbiterProvider:
        event.provider === "claude" || event.provider === "codex"
          ? event.provider
          : undefined,
      ...(event.fallbackFrom === "claude" ||
      event.fallbackFrom === "codex"
        ? { fallbackFrom: event.fallbackFrom }
        : {}),
    },
  });
}

// ---------------------------------------------------------------------------------------------
// The stored spoken Response
// ---------------------------------------------------------------------------------------------

/**
 * What a stored spoken Response can be scored as. This is the one rule for "does this Item have a
 * usable transcript": `admit` reads it to decide what a scoring request may send to the Judges, and
 * `settleStrandedItems`, the orphan heal and the boot sweep read it to decide what a stranded Item
 * becomes.
 *
 *   transcription-pending  Ears has not produced a transcript yet; the recording is kept for retry.
 *   absent                 nothing on file to score: no row, or a row without a transcript (a
 *                          lost-upload or skipped-Item placeholder).
 *   no-speech              Ears answered and heard nothing — the transcript is empty or whitespace.
 *                          Scored a deterministic 0 without calling a Judge.
 *   usable                 a transcript the Judges can score.
 */
export type SpokenResponseState = "transcription-pending" | "absent" | "no-speech" | "usable";

export function spokenResponseState(
  row: Pick<ResponseRow, "scoring_status" | "transcript"> | undefined,
): SpokenResponseState {
  if (!row) return "absent";
  if (row.scoring_status === "transcription_pending") return "transcription-pending";
  if (row.transcript === null) return "absent";
  return row.transcript.trim() === "" ? "no-speech" : "usable";
}

/** The Set material a no-speech 0 is shown against: the sentence to repeat, or the question asked. */
export type SpokenItemPrompt = { target: string } | { question: string };

/**
 * The Set material for a spoken Item, looked up by id alone. That relies on a speaking Set's Item
 * ids being distinct across its two Task Types, which item_results (keyed attempt_id, item_id)
 * assumes too.
 */
export function spokenItemPrompt(set: AnySet | undefined, itemId: string): SpokenItemPrompt | undefined {
  if (set?.kind !== "speaking") return undefined;
  const item = set.listenAndRepeat.items.find((i) => i.id === itemId);
  if (item) return { target: item.sentence };
  const question = set.interview.questions.find((q) => q.id === itemId);
  return question ? { question: question.question } : undefined;
}

const NO_SPEECH_NOTE = "No speech was detected in this recording, so it was scored 0 without being sent to the Judges.";
const NO_SPEECH_FEEDBACK_ZH = "這段錄音中沒有偵測到語音，因此本題以 0 分計算，與正式考試中沒有作答的題目相同。";

export type NoSpeechReportItem = ScoreReport["items"][number] & { noSpeechDetected: true };
type SpokenItemMeta = { target: string; diff: DiffOp[] } | { question: string };

/**
 * The Score Report item a no-speech recording is persisted as. It has the Score Report's shape so
 * every reader that renders a scored spoken Item renders this one too; `noSpeechDetected` is what
 * tells it apart from a judged 0, and no Judge Report exists behind it.
 */
export function noSpeechReportItem(itemId: string): NoSpeechReportItem {
  return {
    itemId,
    ownScore: 0,
    finalScore: 0,
    maxScore: 5,
    dimensions: [],
    deductions: [],
    reconciliationNote: NO_SPEECH_NOTE,
    feedbackZh: NO_SPEECH_FEEDBACK_ZH,
    noSpeechDetected: true,
  };
}

/** The `meta` a scored spoken Item carries beside its report: target and diff, or the question. */
export function spokenItemMeta(prompt: SpokenItemPrompt, transcript: string): SpokenItemMeta {
  return "target" in prompt
    ? { target: prompt.target, diff: wordDiff(prompt.target, transcript) }
    : { question: prompt.question };
}

/** The item_results write that scores one Item a no-speech 0. */
export function noSpeechScoreWrite(attemptId: string, itemId: string, prompt: SpokenItemPrompt | undefined): ItemScoreWrite {
  const meta = prompt ? spokenItemMeta(prompt, "") : undefined;
  return {
    attemptId,
    itemId,
    score: 0,
    scoreJson: JSON.stringify({ ...noSpeechReportItem(itemId), ...(meta ? { meta } : {}) }),
    scoringStatus: "scored",
  };
}

// ---------------------------------------------------------------------------------------------
// admit
// ---------------------------------------------------------------------------------------------

type WritingSet = Extract<AnySet, { kind: "writing" }>;
export type EssayMaterials = WritingSet["email"] | WritingSet["academicDiscussion"];

export type AdmittedEssay = {
  kind: "essay";
  taskType: "email" | "discussion";
  itemId: string;
  responseText: string;
  materials: EssayMaterials;
};

// A discriminated union rather than one shape with optional target/question, so the adapter gets
// the field its Task Type has without a non-null assertion.
//
// `items` are the Responses with a usable transcript, the only ones the Judges see. `silent` are the
// no-speech recordings in the same request, which the adapter scores a deterministic 0; keeping them
// out of `items` stops a Judge failure on their siblings from failing them too.
export type AdmittedSpeaking =
  | {
    kind: "speaking";
    taskType: "listen_repeat";
    items: Array<{ itemId: string; row: ResponseRow; target: string }>;
    silent: Array<{ itemId: string; target: string }>;
  }
  | {
    kind: "speaking";
    taskType: "interview";
    items: Array<{ itemId: string; row: ResponseRow; question: string }>;
    silent: Array<{ itemId: string; question: string }>;
  };

export type Admitted = AdmittedEssay | AdmittedSpeaking;

// "not-scoreable-here" is not a rejection: it is how admit reports a Task Type the Judge ensemble
// does not score at all (the eight deterministic Task Types). Each caller maps it to its own
// meaning: the /score route scores those synchronously before it calls admit and ignores the
// verdict, while scoreItems throws NotFound, because reaching it with one is a routing bug. The rejections are
// the NotFound and TranscriptionPending admit throws.
export type Admission =
  | { verdict: "not-scoreable-here" }
  | { verdict: "ok"; admitted: Admitted };

/**
 * The one scoreability check. Side-effect-free: its store parameter is narrowed to the single read
 * it makes, and it performs no model call, no ffprobe and no JSON parsing (a malformed
 * delivery_report must fail inside scoring, where it becomes a rescorable Item, not at the route
 * before any job exists). Every requested id is checked before any material is prepared, so a
 * request with an unknown or unready Item is rejected before any Judge call or database write.
 */
export function admit(
  store: Pick<ScoreStore, "getAttempt">,
  attemptId: string,
  set: AnySet,
  request: ScoreRequest,
): Admission {
  // Named literally rather than via isDeterministicTaskType, which returns a plain boolean and
  // cannot narrow `request`. This list narrows `request` to the judged Task Types below, so a Task
  // Type left off it fails to compile in the speaking branch instead of being mis-routed.
  if (
    request.taskType === "build_sentence" ||
    request.taskType === "complete_words" ||
    request.taskType === "daily_life" ||
    request.taskType === "academic_passage" ||
    request.taskType === "listen_choose" ||
    request.taskType === "conversation" ||
    request.taskType === "announcement" ||
    request.taskType === "academic_talk"
  ) {
    return { verdict: "not-scoreable-here" };
  }

  if (request.taskType === "email" || request.taskType === "discussion") {
    if (set.kind !== "writing") throw new NotFound(`${request.taskType} requires a writing set`);
    const { itemId, text } = request.items[0];
    const materials = request.taskType === "email" ? set.email : set.academicDiscussion;
    if (materials.id !== itemId) throw new NotFound(`unknown item ${itemId}`);
    return {
      verdict: "ok",
      admitted: { kind: "essay", taskType: request.taskType, itemId, responseText: text, materials },
    };
  }

  if (set.kind !== "speaking") throw new NotFound(`${request.taskType} requires a speaking set`);
  const requestedIds = request.items.map((i) => i.itemId);
  const attempt = store.getAttempt(attemptId);
  const stored = new Map((attempt?.items ?? []).map((row) => [row.item_id, row]));
  const stateOf = (id: string) => spokenResponseState(stored.get(id));

  // transcription-pending (the recording is stored, its transcript not yet produced) is reported
  // ahead of the "no transcript on file" case below: it is the more specific, more actionable state.
  const pendingIds = requestedIds.filter((id) => stateOf(id) === "transcription-pending");
  if (pendingIds.length > 0) throw new TranscriptionPending(pendingIds);
  const missingIds = requestedIds.filter((id) => stateOf(id) === "absent");
  if (missingIds.length > 0) throw new NotFound(`missing transcript for item(s): ${missingIds.join(", ")} — upload audio first`);

  // Every id left is either usable or no-speech, so `stored.get(id)!` below always has a row.
  const usableIds = requestedIds.filter((id) => stateOf(id) === "usable");
  const silentIds = requestedIds.filter((id) => stateOf(id) === "no-speech");
  if (request.taskType === "listen_repeat") {
    const targetOf = (id: string) => {
      const item = set.listenAndRepeat.items.find((i) => i.id === id);
      if (!item) throw new NotFound(`unknown item ${id}`);
      return item.sentence;
    };
    // Resolved in request order before either list is built, so an unknown id rejects the request
    // whichever of the two it would have landed in.
    const targets = new Map(requestedIds.map((id) => [id, targetOf(id)]));
    return {
      verdict: "ok",
      admitted: {
        kind: "speaking",
        taskType: "listen_repeat",
        items: usableIds.map((id) => ({ itemId: id, row: stored.get(id)!, target: targets.get(id)! })),
        silent: silentIds.map((id) => ({ itemId: id, target: targets.get(id)! })),
      },
    };
  }
  const questionOf = (id: string) => {
    const question = set.interview.questions.find((i) => i.id === id);
    if (!question) throw new NotFound(`unknown item ${id}`);
    return question.question;
  };
  const questions = new Map(requestedIds.map((id) => [id, questionOf(id)]));
  return {
    verdict: "ok",
    admitted: {
      kind: "speaking",
      taskType: request.taskType,
      items: usableIds.map((id) => ({ itemId: id, row: stored.get(id)!, question: questions.get(id)! })),
      silent: silentIds.map((id) => ({ itemId: id, question: questions.get(id)! })),
    },
  };
}

// ---------------------------------------------------------------------------------------------
// runJudges
// ---------------------------------------------------------------------------------------------

export type JudgeName = "gemini" | "openai";
export type OpenAiJudgeProvider = "codex" | "openai-http";
type JudgeProvider = "gemini-http" | OpenAiJudgeProvider;

export type JudgeFanOut<V> = {
  fulfilled: Array<{ judge: JudgeName; value: V }>;
  judgesFailed: JudgeName[];
  // The provenance arbitration may see: the provider of a fulfilled OpenAI Judge, never of Gemini.
  openaiJudgeProvider: OpenAiJudgeProvider | undefined;
};

function logJudgeFailure(judge: JudgeName, reason: unknown): void {
  const status =
    reason instanceof JudgeError
      ? reason.status
      : "internal-failure";
  console.error(`judge ${judge} failed (${status})`);
}

function openAiProvider(judge: JudgeName, provider: JudgeProvider): OpenAiJudgeProvider | undefined {
  return judge === "openai" && (provider === "codex" || provider === "openai-http") ? provider : undefined;
}

/**
 * Runs both Judges concurrently and waits for both to settle. `callJudge` is the adapter's one point
 * of difference: it supplies that Judge's materials (Speaking gives OpenAI the .mp3 beside the
 * Gemini-ready .webm) and returns that family's raw result.
 *
 * Progress fires once per settlement with the cumulative tally, and a throwing progress sink is
 * swallowed: the production sink is a database write, and a failed progress write must never cost
 * a valid Judge Report. A Judge's failure is logged by status only and reported in `judgesFailed`.
 */
export async function runJudges<V extends { provider: JudgeProvider }>(
  callJudge: (judge: JudgeName) => Promise<V>,
  ctx: { onProgress?: OnScoringProgress; signal?: AbortSignal } = {},
): Promise<JudgeFanOut<V>> {
  const judges = ["gemini", "openai"] as const;
  const done: JudgeName[] = [];
  const failed: JudgeName[] = [];
  let openaiJudgeProvider: OpenAiJudgeProvider | undefined;
  const report = (progress: ScoringProgress): void => {
    try {
      ctx.onProgress?.(progress);
    } catch {
      // Progress is observational; a failed write must not fail the Judge.
    }
  };
  const reportTally = (): void => report({
    stage: "judging",
    detail: {
      judgesDone: [...done],
      judgesFailed: [...failed],
      ...(openaiJudgeProvider ? { openaiJudgeProvider } : {}),
    },
  });

  report({ stage: "judging" });
  const settled = await Promise.allSettled(judges.map(async (judge) => {
    let value: V;
    try {
      value = await callJudge(judge);
    } catch (err) {
      failed.push(judge);
      reportTally();
      throw err;
    }
    done.push(judge);
    openaiJudgeProvider = openAiProvider(judge, value.provider) ?? openaiJudgeProvider;
    reportTally();
    return value;
  }));
  ctx.signal?.throwIfAborted();
  settled.forEach((s, i) => {
    if (s.status === "rejected") {
      logJudgeFailure(judges[i], s.reason);
    }
  });
  const fulfilled = settled.flatMap((s, i) =>
    s.status === "fulfilled" ? [{ judge: judges[i], value: s.value }] : []
  );
  const judgesFailed = judges.filter((_, i) => settled[i].status === "rejected");
  return { fulfilled, judgesFailed, openaiJudgeProvider };
}

// ---------------------------------------------------------------------------------------------
// arbitrate
// ---------------------------------------------------------------------------------------------

/**
 * Calls the adapter's `markFailed(message)`, then throws Rescorable(message), so the persisted
 * `{ error }` and the thrown error always carry the same message. Used for "both judges failed" and
 * for an Arbiter that threw. It throws whether or not the write landed: for a superseded job the
 * adapter's write is skipped by `persist`, and the job still rejects.
 */
export function failRescorable(markFailed: (message: string) => void, message: string): never {
  markFailed(message);
  throw new Rescorable(message);
}

/**
 * The Arbiter call, its progress forwarding, and its one failure path: any error other than an
 * abort marks the Items failed and throws Rescorable. `requestArbitration` is the adapter's point of
 * difference: essay arbitrates one Item per call, Speaking the whole Task Type in one.
 */
export async function arbitrate(
  requestArbitration: (opts: ArbitrationOptions) => Promise<ArbitrationResult>,
  ctx: {
    onProgress?: OnScoringProgress;
    signal?: AbortSignal;
    markFailed: (message: string) => void;
  },
): Promise<ScoreReport> {
  try {
    ctx.onProgress?.({ stage: "aggregating" });
    const arbitration = await requestArbitration({
      onEvent: (event) => forwardArbitrationProgress(ctx.onProgress, event),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    ctx.signal?.throwIfAborted();
    // The Arbiter's provider is dropped here: the only provider provenance allowed into
    // score-bearing state is the item-level `selfArbitrated` flag the arbiter already applied.
    return arbitration.report;
  } catch (err) {
    ctx.signal?.throwIfAborted();
    return failRescorable(ctx.markFailed, String(err));
  }
}
