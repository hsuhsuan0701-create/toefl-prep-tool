import type {
  ActiveGenerationListVM,
  BuildupBankSetVM,
  BuildupItemVM,
  BuildupPhase,
  BuildupQueueEntryVM,
  BuildupRepVM,
  AttemptDetailVM,
  AttemptListVM,
  BuildSentenceScoreVM,
  DeliveryReport,
  DeterministicScoreRequest,
  FullTestRunStatus,
  FullTestRunVM,
  GenerationBatchDetailVM,
  GenerationJobDetailVM,
  ReasoningStatusVM,
  ScoreRequest,
  ScoringJobDetailVM,
  ServedSet,
  SetListEntryVM,
  SetupStatusVM,
  StatsSettingsVM,
  StatsSummaryVM,
  TranscriptionJobVM,
  TrendPointVM,
  UnloadableSetsVM,
} from "@toefl-prep/shared";

export type { DeliveryReport };

// A failed response as an Error that keeps its HTTP status, so a caller can branch on it without
// parsing `message`: TranscriptionJobPanel words a 404 and a 409 its own way, and the Writing and
// Speaking Simulations stop retrying on a 4xx that resending cannot fix. `message` is
// "<status>: <body>", which requestError.ts reads back.
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

const json = async <T>(res: Response): Promise<T> => {
  if (!res.ok) throw new HttpError(res.status, `${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
};

// One entry of GET /api/sets; SetListEntryVM documents `title`, `summary` and `attempted`.
// `advisoryNotes` is absent, not empty, on a Set that carries none: treat the two the same.
export type SetMeta = SetListEntryVM;

export const listSets = (kind?: string): Promise<SetMeta[]> =>
  fetch(`/api/sets${kind ? `?kind=${kind}` : ""}`).then((r) => json(r));

// The Set files on disk that fail schema validation. The listing above skips them, so one bad file
// cannot blank the bank, which leaves them indistinguishable from Sets that never existed; this is
// how the practice UI learns that some are on disk and cannot be shown. `error` names the failing
// field, never the file's own text (SetLoadFailureVM).
export const listUnloadableSets = (): Promise<UnloadableSetsVM> =>
  fetch("/api/sets/unloadable").then((r) => json(r));

// GET /api/sets/:id, the one route a Set's content reaches the client through. `ServedSet`
// (shared/src/servedSet.ts) is the declared return type of `stripAnswers` on the server, so a field
// renamed on a Set schema stops compiling here and at every reader instead of arriving as a runtime
// `undefined`.
//
// Unvalidated, like every other typed response in this file: the type is a contract with the
// server, not a parse. Readers that need to know which kind arrived narrow with `expectServedSet`
// (Drills and Simulations, which throw on a mismatch) or `asUntrustedServedSet` (Attempt review,
// which renders a retired Set best-effort and never throws).
//
// The Build a Sentence tray's `tiles` arrive in a freshly drawn order per request
// (server/src/services/tileScramble.ts), so their order means nothing and is never compared with a
// stored one.
//
// The type is the success body only: a non-2xx rejects with an HttpError. A Set file that fails
// AnySetSchema never reaches `stripAnswers` (the route answers 404); listUnloadableSets reports it,
// never a degraded Set.
export const getSet = (id: string): Promise<ServedSet> => fetch(`/api/sets/${id}`).then((r) => json(r));

// GET /api/attempts: one page of the Attempt log, newest first, with `total` counting every Attempt
// that matches the filters. Whether a Set has been attempted is not answered here: read `attempted`
// off the Set listing (listSets), which applies the rule (an Attempt that has a scored Item, or is
// completed and holds at least one Item) over the whole history.
export const listAttempts = (
  opts: { kind?: string; setId?: string; limit?: number; offset?: number } = {},
): Promise<AttemptListVM> => {
  const params = new URLSearchParams();
  if (opts.kind) params.set("kind", opts.kind);
  if (opts.setId) params.set("setId", opts.setId);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return fetch(`/api/attempts${qs ? `?${qs}` : ""}`).then((r) => json(r));
};

// `fullTestRunId` is present exactly when this Attempt is a section of a Full-Test Run. The server
// then checks the link and ties the Attempt to that section; a section restarted after a reload
// keeps the Repeat tag of the Attempt it replaces.
export const createAttempt = (body: {
  kind: string;
  mode: string;
  setId: string;
  fullTestRunId?: string;
}): Promise<{ attemptId: string; isRepeat: boolean }> =>
  fetch("/api/attempts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => json(r));

// POST /api/attempts/:id/score answers in one of two ways. The deterministic Task Types are scored
// inline with a 200 (Build a Sentence in this shape; Reading and Listening through
// scoreDeterministicTask below). The four judged Task Types (Email, Academic Discussion, Listen and
// Repeat, Interview) answer 202 with a job id at once, and the result arrives on the job
// (getScoreJob). Build a Sentence's answer carries the keys in a Drill and bare correctness in a
// Simulation (shared's BuildSentenceScoreVM).
export type BuildSentenceScoreResponse = BuildSentenceScoreVM;
export type ScoreJobStarted = { jobId: string };
export type ScoreTaskResult = BuildSentenceScoreResponse | ScoreJobStarted;

// Callers narrow on the key: the inline body has `items` and no `jobId`, the 202 body the reverse
// (WritingDrill's runBuildSentenceScore checks `"items" in res`).
export const scoreTask = (attemptId: string, body: ScoreRequest): Promise<ScoreTaskResult> =>
  fetch(`/api/attempts/${attemptId}/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => json(r));

// Reading and Listening's score request (shared's DeterministicScoreRequest): the same POST
// /:id/score as scoreTask, typed for the inline 200 that server/src/services/deterministicScoring.ts
// always returns. A Drill gets each Item's `key` and `explanationZh`, and a Listening Conversation,
// Announcement or Academic Talk its Stimulus's `transcript`; a Simulation gets bare correctness.
export type DeterministicScoreResponse = {
  taskType: string;
  items: Array<{ itemId: string; correct: boolean; key?: string; explanationZh?: string; transcript?: string }>;
};

// The server has this Task Type's Responses, scored, but the client does not hold the scored answer.
// One reply says so: a 409 marked `alreadyScored: true`. An earlier request landed and only its 200
// was lost, typically to a server restart mid-request. The server marks that case in the JSON body,
// so it is never inferred from the free-text `error`, nor from a 2xx whose body cannot be read: that
// stays an ordinary failure, and the retry it prompts is what earns the 409. A retrying Module
// submit (pages/simulation/submitModule.ts) counts the 409 as accepted, and a Drill reads what was
// recorded back from the Attempt.
//
// POST /:id/score answers a deterministic Task Type with a 409 for two other conflicts as well (wrong
// Attempt kind, locked Module; server/src/routes/attempts.ts). Counting either would mark a Task
// Type done that was never scored, then route or complete on it, so they stay plain HttpErrors.
export class DeterministicAlreadyScoredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeterministicAlreadyScoredError";
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isDeterministicScoreResponse(body: unknown): body is DeterministicScoreResponse {
  return typeof body === "object" && body !== null && Array.isArray((body as { items?: unknown }).items);
}

// Reads the body itself instead of using json(), because the `alreadyScored` marker is a field of
// the error body. A refusal still becomes the HttpError json() would build, "<status>: <body>", so
// requestErrorMessage can quote the server's reason.
export async function scoreDeterministicTask(
  attemptId: string,
  req: DeterministicScoreRequest,
): Promise<DeterministicScoreResponse> {
  const res = await fetch(`/api/attempts/${attemptId}/score`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  const text = await res.text().catch(() => "");
  const body = parseJson(text);
  if (res.ok) {
    if (isDeterministicScoreResponse(body)) return body;
    throw new Error("The server's answer could not be read. Try again: Responses it has already scored are not scored twice.");
  }
  const errorField =
    typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : "request failed";
  const alreadyScored = typeof body === "object" && body !== null && (body as { alreadyScored?: unknown }).alreadyScored === true;
  if (alreadyScored) throw new DeterministicAlreadyScoredError(errorField);
  throw new HttpError(res.status, `${res.status}: ${text}`);
}

// POST /:id/route: the Router Module to Lower/Upper Module decision for a Reading or Listening
// Simulation, called once every Router Module Item is scored. Idempotent: a repeat call returns the
// stored decision rather than recomputing it.
export const routeAttempt = (attemptId: string): Promise<{ path: "lower" | "upper" }> =>
  fetch(`/api/attempts/${attemptId}/route`, { method: "POST" }).then((r) => json(r));

// GET /:id/score-jobs/:jobId, polled by useScoringJob. ScoringJobDetailVM documents when `progress`,
// `result` and `error` are present.
export const getScoreJob = (attemptId: string, jobId: string): Promise<ScoringJobDetailVM> =>
  fetch(`/api/attempts/${attemptId}/score-jobs/${jobId}`).then((r) => json(r));

export const completeAttempt = (attemptId: string): Promise<unknown> =>
  fetch(`/api/attempts/${attemptId}/complete`, { method: "POST" }).then((r) => json(r));

/** Discards an abandoned Attempt so it stops sitting in the list as in progress. Its recorded work
 *  stays as history, but it gets no band (POST /:id/abort). */
export const abortAttempt = (attemptId: string): Promise<unknown> =>
  fetch(`/api/attempts/${attemptId}/abort`, { method: "POST" }).then((r) => json(r));

// Manual recovery for a transcription job that ended `failed`: the review's "Retry transcription"
// (components/review/TranscriptionJobPanel.tsx). The route answers `{job}`, unwrapped here to the
// TranscriptionJobVM. The body is empty: the server takes the recording's path and hash from the
// job row, so the browser never re-uploads.
export const retryTranscription = (attemptId: string, jobId: string): Promise<TranscriptionJobVM> =>
  fetch(`/api/attempts/${attemptId}/transcription-jobs/${jobId}/retry`, { method: "POST" })
    .then((r) => json<{ job: TranscriptionJobVM }>(r))
    .then((body) => body.job);

// Marks a Speaking Simulation's capture finished; the server then finalizes it durably.
// `finalizing` (a 202) means transcription or scoring work is still active, and the server, not the
// caller, keeps reconciling until the Attempt completes (scheduleGraceReconcile in
// server/src/services/speakingFinalization.ts).
//
// `uploadFailedItemIds` are the Items this browser recorded but could not land on the server, the
// one fact the server cannot observe: a lost upload and an Item never recorded both leave it with
// nothing. Named here, a lost upload counts as a recording that never arrived, so the Attempt has no
// band until it is dealt with; unnamed, it would be a deliberate skip scored 0. The body is an
// optional hint (the server derives the expected Items from the Set), so an empty list is both the
// common case and a safe one.
export const finishSpeakingCapture = (
  attemptId: string,
  uploadFailedItemIds: string[] = [],
): Promise<{ status: "finalizing" | "completed" }> =>
  fetch(`/api/attempts/${attemptId}/capture-finished`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uploadFailedItemIds }),
  }).then((r) => json(r));

// Marks the Attempt as interrupted: the tab went hidden, a Stimulus would not play, or a Writing
// Simulation was resumed. Callers fire it and forget it with their own `.catch`; it still rejects
// on failure, like every call in this file.
export const flagAttempt = (attemptId: string): Promise<unknown> =>
  fetch(`/api/attempts/${attemptId}/flag`, { method: "POST" }).then((r) => json(r));

export const getAttempt = (attemptId: string): Promise<AttemptDetailVM> =>
  fetch(`/api/attempts/${attemptId}`).then((r) => json(r));

export const getStatsSummary = (): Promise<StatsSummaryVM> => fetch("/api/stats/summary").then((r) => json(r));

// One request for however many Task Types the caller needs, not one per chart. The route returns a
// flat TrendPointVM[] in which every point names its `taskType`, so the grouping happens here, once.
// A Task Type with no scored Attempts is still in the map, as an empty array: "no data yet" is a
// state the UI renders, not a missing key.
export const getTrends = async (taskTypes: string[]): Promise<Map<string, TrendPointVM[]>> => {
  const grouped = new Map<string, TrendPointVM[]>(taskTypes.map((taskType) => [taskType, []]));
  if (taskTypes.length === 0) return grouped;
  const query = taskTypes.map((taskType) => encodeURIComponent(taskType)).join(",");
  const points = await fetch(`/api/stats/trends?taskType=${query}`).then((r) => json<TrendPointVM[]>(r));
  for (const point of points) {
    const bucket = grouped.get(point.taskType);
    if (bucket) bucket.push(point);
  }
  return grouped;
};

export const getStatsSettings = (): Promise<StatsSettingsVM> => fetch("/api/stats/settings").then((r) => json(r));

export const getReasoningStatus = (): Promise<ReasoningStatusVM> =>
  fetch("/api/providers").then((r) => json(r));

// A partial patch: only the sections it names are written, and the answer is the full Settings.
export type StatsSettingsPatch = { targets?: Partial<StatsSettingsVM["targets"]> };
export const putStatsSettings = (patch: StatsSettingsPatch): Promise<StatsSettingsVM> =>
  fetch("/api/stats/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then((r) => json(r));

// POST /api/generate answers 202 with a job id at once; progress and the result are read from
// GET /api/generate/:jobId (GenerationJobDetailVM). `supersedesSetId` names an existing Set of the
// same kind that the new one retires (ADR 0011); the server refuses it for Writing. It is left out
// of the body when absent.
export const startGenerate = (
  kind: "speaking" | "writing" | "reading" | "listening",
  opts: { supersedesSetId?: string } = {},
): Promise<{ jobId: string }> =>
  fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, ...(opts.supersedesSetId ? { supersedesSetId: opts.supersedesSetId } : {}) }),
  }).then((r) => json(r));

export const getGenerateJob = (jobId: string): Promise<GenerationJobDetailVM> =>
  fetch(`/api/generate/${jobId}`).then((r) => json(r));

// The batch form of POST /api/generate, `{items: [{kind, count}, ...]}`. Array order fixes each
// child's index and the order the children are listed in, even though several may run at once. The
// answer has startGenerate's `{jobId}` shape, holding the batch's own id.
export type BatchGenerateItem = { kind: "speaking" | "writing" | "reading" | "listening"; count: number };
export const startGenerateBatch = (items: BatchGenerateItem[]): Promise<{ jobId: string }> =>
  fetch("/api/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ items }),
  }).then((r) => json(r));

// The same URL as getGenerateJob, typed for a batch's id, which the server answers with the batch
// shape. Two fetchers rather than one returning GenerationJobOrBatchDetailVM, because each caller
// already knows which kind of id it holds.
export const getGenerateBatchJob = (batchId: string): Promise<GenerationBatchDetailVM> =>
  fetch(`/api/generate/${batchId}`).then((r) => json(r));

export const cancelGenerateBatch = (batchId: string): Promise<GenerationBatchDetailVM> =>
  fetch(`/api/generate/${batchId}/cancel`, { method: "POST" }).then((r) => json(r));

// The same route as cancelGenerateBatch, which tries the id as a batch and then as a job (standalone
// or a batch child); its own fetcher so the return type is GenerationJobDetailVM.
export const cancelGenerateJob = (jobId: string): Promise<GenerationJobDetailVM> =>
  fetch(`/api/generate/${jobId}/cancel`, { method: "POST" }).then((r) => json(r));

// GET /api/generate: every batch and standalone job still queued or running, newest first, each with
// `createdAt` (ISO). Fetched once when the Dashboard's generation control mounts, so a reload or a
// navigation mid-generation re-attaches the progress UI to work the server kept running.
export const listActiveGeneration = (): Promise<ActiveGenerationListVM> =>
  fetch("/api/generate").then((r) => json(r));

export type UploadRecordingResult = {
  transcript: string;
  deliveryReport: DeliveryReport;
  durationSec: number | null;
};

// What an upload came to, for a caller that must decide between waiting, resending and asking for a
// new take:
//
//   recovery-pending  a 202: the server stored the recording and a transcription job owns it.
//                     Nothing needs resending, and the Item is not scoreable yet. `job` is that
//                     job's view model.
//   retryable         the recording held in memory is still good: the request never arrived, or the
//                     server answered for a reason other than the audio. Resending can work.
//   needs-rerecord    a 400: the server read these bytes and refused them. Only a new take helps.
//
// `job` is optional because the 202 alone says the recording is stored, whatever its body holds. A
// 202 with an unreadable body is still `recovery-pending`: as `retryable` it would offer a resend of
// a recording the server already has, and the Speaking Drill's `uploads-settling` stage, which waits
// for every Item to settle, would not move on by itself.
export type UploadOutcome =
  // `data` is null when a 200's body could not be read: the server has the recording and its
  // transcript all the same, and the Attempt report shows them.
  | { ok: true; data: UploadRecordingResult | null }
  | {
      ok: false;
      kind: "recovery-pending";
      message: string;
      job?: TranscriptionJobVM;
    }
  | {
      ok: false;
      kind: "retryable" | "needs-rerecord";
      message: string;
    };

// A recording the server accepted but has not transcribed yet; a transcription job owns it. HTTP
// calls this a success, which is why uploadItemAudio checks for it before `res.ok`.
const ACCEPTED_PENDING_TRANSCRIPTION = 202;

// Checks only the two identifying fields of the 202 body's `job` and trusts the rest of
// TranscriptionJobVM's shape. Returns null for an absent or malformed body rather than throwing, so
// the upload still reads as `recovery-pending`, with the generic message.
function extractTranscriptionJob(body: unknown): TranscriptionJobVM | null {
  if (typeof body !== "object" || body === null) return null;
  const job = (body as { job?: unknown }).job;
  if (typeof job !== "object" || job === null) return null;
  const candidate = job as Partial<TranscriptionJobVM>;
  if (typeof candidate.jobId !== "string" || typeof candidate.status !== "string") return null;
  return job as TranscriptionJobVM;
}

function isUploadRecordingResult(body: unknown): body is UploadRecordingResult {
  return typeof body === "object" && body !== null && typeof (body as { transcript?: unknown }).transcript === "string";
}

// POST /:id/items/:itemId/audio. The FormData field "file" is the one the route reads. A failed
// request resolves to an UploadOutcome rather than rejecting, so the Speaking Drill and Simulation
// choose between waiting, resending and asking for a new take without reading HTTP statuses.
export async function uploadItemAudio(attemptId: string, itemId: string, blob: Blob): Promise<UploadOutcome> {
  const form = new FormData();
  form.append("file", blob, "recording.webm");
  let res: Response;
  try {
    res = await fetch(`/api/attempts/${attemptId}/items/${itemId}/audio`, { method: "POST", body: form });
  } catch (err) {
    return { ok: false, kind: "retryable", message: err instanceof Error ? err.message : "network error" };
  }
  // Checked before `res.ok`, because a 202 is an HTTP success. As `ok: true` (with no transcript)
  // the callers would treat the Item as transcribed and put it in POST /score, and the server
  // refuses the whole request with a 409 while any Item in it is still transcribing, so none of
  // that Task Type's Items would be scored. A non-ok outcome keeps this Item, and only this one, out
  // of the request.
  if (res.status === ACCEPTED_PENDING_TRANSCRIPTION) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const job = extractTranscriptionJob(body);
    if (job) {
      // The job can already be `failed`: a terminal failure kind ends it on its first run, and no
      // automatic retry follows. The message says which, and the review's Retry transcription is
      // the way on from there.
      const message =
        job.status === "failed"
          ? "Recording saved, but transcription failed — retry it from your results after finishing."
          : "Recording saved — transcription is still in progress.";
      return { ok: false, kind: "recovery-pending", message, job };
    }
    // An absent or malformed body: still `recovery-pending`, since the 202 alone says the recording
    // is stored (UploadOutcome says why), with no `job` rather than an invented one.
    return { ok: false, kind: "recovery-pending", message: "Recording saved — transcription is still pending." };
  }
  // A 200 is a recording stored and transcribed, whatever its body holds. Read as a failure it would
  // be sent again, which transcribes it a second time.
  if (res.ok) {
    const body: unknown = await res.json().catch(() => undefined);
    return { ok: true, data: isUploadRecordingResult(body) ? body : null };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const message =
    typeof body === "object" && body !== null && typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error
      : `upload failed (${res.status})`;
  // Only a 400 means the server read these bytes and refused them: "no usable recording" (no file,
  // or one too short) or "unusable audio recording" (the transcoder rejected it). Anything else is
  // about the request or the server, and the recording held in memory is still good: a 409 is a
  // conflict (a concurrent upload or a newer take for the same Item, an Attempt already over), a 404
  // an unknown Attempt or Item, a 5xx the server not ready or failing (the dev proxy answers 500
  // while the server restarts). Calling those `needs-rerecord` would tell the User a good answer was
  // unusable and make them speak it again, in a Simulation with the clock running.
  return res.status === 400
    ? { ok: false, kind: "needs-rerecord", message }
    : { ok: false, kind: "retryable", message };
}

// ---------------------------------------------------------------------------------------------
// Full-Test Runs
// ---------------------------------------------------------------------------------------------

/**
 * Starts a Run: the server draws a Set per section (`sets` overrides a section's draw) and returns
 * the Run with all four listed.
 */
export const createFullTest = (body: { sets?: Partial<Record<string, string>> } = {}): Promise<FullTestRunVM> =>
  fetch("/api/full-tests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => json(r));

export const getFullTest = (runId: string): Promise<FullTestRunVM> =>
  fetch(`/api/full-tests/${runId}`).then((r) => json(r));

// `status: "in-progress"` lists every Run still waiting to be resumed, however many newer Runs exist.
export const listFullTests = (opts: { limit?: number; status?: FullTestRunStatus } = {}): Promise<FullTestRunVM[]> => {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.status) params.set("status", opts.status);
  const qs = params.toString();
  return fetch(`/api/full-tests${qs ? `?${qs}` : ""}`).then((r) => json(r));
};

// The section hand-off, called once the current section's Attempt is over: the server moves the Run
// to the first section still to sit, or completes it, and answers 409 while the current section is
// unfinished. A Simulation's own hand-off swallows a failure (advanceFullTestSection in
// pages/simulation/simulationShell.ts); the Run page shows it.
export const advanceFullTest = (runId: string): Promise<FullTestRunVM> =>
  fetch(`/api/full-tests/${runId}/advance`, { method: "POST" }).then((r) => json(r));

// Gives up on a Run in progress: it ends abandoned with no Overall, its finished sections keep their
// Attempts and bands, and the section being sat is discarded. Idempotent; a completed Run is a 409.
export const abandonFullTest = (runId: string): Promise<FullTestRunVM> =>
  fetch(`/api/full-tests/${runId}/abandon`, { method: "POST" }).then((r) => json(r));

// ---------------------------------------------------------------------------------------------
// Drill Lab — backward buildup (倒序堆疊)
// ---------------------------------------------------------------------------------------------
//
// The one client surface that receives Listen and Repeat sentences in cleartext. Set content
// otherwise arrives only through getSet, after `stripAnswers`; server/src/routes/drillLab.ts says
// why this route is the exception and what keeps it contained.

export const getBuildupQueue = (): Promise<BuildupQueueEntryVM[]> =>
  fetch("/api/drill-lab/queue").then((r) => json(r));

export const getBuildupBank = (): Promise<BuildupBankSetVM[]> =>
  fetch("/api/drill-lab/bank").then((r) => json(r));

export const getBuildupItem = (setId: string, itemId: string): Promise<BuildupItemVM> =>
  fetch(`/api/drill-lab/items/${encodeURIComponent(setId)}/${encodeURIComponent(itemId)}`).then((r) => json(r));

export const postBuildupRep = (
  setId: string,
  itemId: string,
  phase: BuildupPhase,
  recording: Blob,
): Promise<BuildupRepVM> => {
  const body = new FormData();
  body.append("file", recording, "rep.webm");
  return fetch(
    `/api/drill-lab/items/${encodeURIComponent(setId)}/${encodeURIComponent(itemId)}/reps?phase=${phase}`,
    { method: "POST", body },
  ).then((r) => json(r));
};

// ---------------------------------------------------------------------------------------------
// Setup status
// ---------------------------------------------------------------------------------------------

/** GET /api/setup-status. */
export type SetupStatus = SetupStatusVM;

/**
 * Which optional pieces (the Claude/Codex CLIs, API keys, Judge models, ffmpeg/ffprobe) are present,
 * and which capabilities each missing one turns off. Answers with no key or CLI configured.
 */
export const getSetupStatus = (): Promise<SetupStatus> => fetch("/api/setup-status").then((r) => json(r));

/**
 * Asks the server to run its setup checks again (the CLI sign-in checks included) and answers what
 * they found, in GET's shape.
 */
export const recheckSetupStatus = (): Promise<SetupStatus> =>
  fetch("/api/setup-status/recheck", { method: "POST" }).then((r) => json<SetupStatus>(r));
