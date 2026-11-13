import {
  type AnySet,
  type BuildSentenceScoreVM,
  type DeliveryReport,
  essayHasNoWords,
  type ScoreRequest,
  type ScoreReport,
} from "@toefl-prep/shared";
import { scoreSentence } from "./sentenceScorer.js";
import { judgeEssay as realJudgeEssay } from "./judges/index.js";
import {
  judgeSpeaking as realJudgeSpeaking,
  type SpeakingJudgeItem,
} from "./judges/speaking.js";
import { ArbiterError, aggregate as realAggregate, aggregateSpeaking as realAggregateSpeaking } from "./arbiter.js";
import {
  admit,
  arbitrate,
  createScoringSession,
  failRescorable,
  noSpeechReportItem,
  noSpeechScoreWrite,
  noWordsReportItem,
  runJudges,
  spokenItemMeta,
  type AdmittedEssay,
  type AdmittedSpeaking,
  type GuardedWrites,
  type OnScoringProgress,
  type ScoreStore,
  type ScoringSession,
  type SpokenItemPrompt,
} from "./judgeEnsemble.js";
import { wordDiff } from "./wordDiff.js";
import { probeDurationSec as realProbeDurationSec } from "./transcode.js";
import { resolveAudioPath } from "../lib/paths.js";
import { NotFound, Rescorable } from "./scoringErrors.js";
// Scoring's injectable dependencies. Ears is not one: transcription happens before scoring, in
// transcriptionRecovery, which has its own `hearRecording` seam.
export type ScoreDeps = {
  // `admit` reads the Attempt's Response rows through it and `createScoringSession` owns the writes.
  repo: ScoreStore;
  judgeEssay?: typeof realJudgeEssay;
  aggregate?: typeof realAggregate;
  judgeSpeaking?: typeof realJudgeSpeaking;
  aggregateSpeaking?: typeof realAggregateSpeaking;
  // ffprobe, for an interview recording's duration. Tests pass an in-process fake.
  probeDurationSec?: typeof realProbeDurationSec;
};

// What the two ensemble adapters below get: the Judges and Arbiters, without the repo. Every write
// an adapter makes must go through its ScoringSession's `persist` guard, and an adapter holding the
// repo could write around it.
type EnsembleDeps = Omit<ScoreDeps, "repo">;

export { NotFound, Rescorable, TranscriptionPending } from "./scoringErrors.js";

// What a failed arbitration persists into score_json and reports as the job's error. Both are
// shown to the User, so neither names a reasoning provider: score-bearing state carries no provider
// provenance. Which provider failed, and how, is in the model diagnostic tables (ADR 0004) and the
// server log (logArbitrationFailure).
const ARBITRATION_FAILED = "arbitration failed";

function logArbitrationFailure(err: unknown): void {
  // An ArbiterError's message is the reasoning route's failure summary or an output-contract
  // violation, never model output. Any other error is logged by class only: a caught error's
  // message is the field most likely to quote its input.
  const cause = err instanceof ArbiterError ? err.message : err instanceof Error ? err.name : "unknown error";
  console.error(`[scoring] ${ARBITRATION_FAILED}: ${cause}`);
}

// The Judge ensemble's `arbitrate`, with its failure made neutral: every Item it marks failed reads
// ARBITRATION_FAILED, and so does the Rescorable it throws.
async function arbitrateNeutrally(
  requestArbitration: Parameters<typeof arbitrate>[0],
  ctx: { onProgress?: OnScoringProgress; signal?: AbortSignal; markFailed: (message: string) => void },
): Promise<ScoreReport> {
  try {
    return await arbitrate(
      async (opts) => {
        try {
          return await requestArbitration(opts);
        } catch (err) {
          if (!ctx.signal?.aborted) logArbitrationFailure(err);
          throw err;
        }
      },
      { onProgress: ctx.onProgress, signal: ctx.signal, markFailed: () => ctx.markFailed(ARBITRATION_FAILED) },
    );
  } catch (err) {
    if (err instanceof Rescorable) throw new Rescorable(ARBITRATION_FAILED);
    throw err;
  }
}
export type { ScoringProgress, OnScoringProgress } from "./judgeEnsemble.js";

/**
 * Runs the Judge ensemble and the Arbiter for one judged Task Type request (an essay, or a Speaking
 * Task Type's Items) and persists the result. `onProgress` fires at the checkpoints ScoringProgress
 * names. With a `jobId`, every score and Judge Report write first checks that the job is still
 * running, so a superseded job writes none of them (createScoringSession). Both Judges failing, or
 * the Arbiter failing, marks the Items failed and throws Rescorable; an Item with a committed score
 * keeps it.
 */
export async function scoreItems(deps: ScoreDeps, attemptId: string, set: AnySet, request: ScoreRequest, onProgress?: OnScoringProgress, jobId?: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  // The one scoreability check; the route runs it too before creating the job row. It also resolves
  // the materials the adapters below use.
  const admission = admit(deps.repo, attemptId, set, request);
  if (admission.verdict !== "ok") {
    // The eight deterministic Task Types are scored synchronously by the /score route
    // (scoreBuildSentence below, scoreDeterministicItems for Reading/Listening) and never reach the
    // Judge ensemble. Arriving here means that dispatch was bypassed.
    throw new NotFound(`${request.taskType} is scored synchronously by the /score route, not by the Judge ensemble`);
  }
  const session = createScoringSession(deps.repo, jobId);
  if (admission.admitted.kind === "essay") {
    const { taskType, itemId, responseText } = admission.admitted;
    // The /score route records the essay before it enqueues the job, and that write is the one
    // that makes the Response durable. Recording it again is idempotent (same text, so a committed
    // score is kept) and covers a caller that scores without going through the route. Not routed
    // through `persist`: the Response must land even for a job that has been superseded.
    session.recordResponse({ attemptId, itemId, taskType, responseText });
    const committed = committedItemIds(deps.repo, attemptId, [itemId]);
    return scoreEssay(deps, session, attemptId, admission.admitted, committed, onProgress, signal);
  }
  const committed = committedItemIds(deps.repo, attemptId, admission.admitted.items.map((i) => i.itemId));
  return scoreSpeaking(deps, session, attemptId, admission.admitted, committed, onProgress, signal);
}

// The requested Items that already hold a committed score when a run starts. A rescore replaces
// such an Item's score, its score_json, its scored_at and the Judge Reports it was arbitrated from
// together, and only when the new result is committed: a run that fails, or whose Arbiter leaves
// the Item out, leaves all four as they were.
function committedItemIds(repo: Pick<ScoreStore, "getAttempt">, attemptId: string, itemIds: readonly string[]): ReadonlySet<string> {
  const scored = new Set(
    (repo.getAttempt(attemptId)?.items ?? []).filter((row) => row.scoring_status === "scored").map((row) => row.item_id),
  );
  return new Set(itemIds.filter((id) => scored.has(id)));
}

/** The one write Build a Sentence scoring makes: every Item of a request, in one transaction. */
export type BuildSentenceScoreStore = {
  scoreBuildSentenceItems(
    items: Array<{ attemptId: string; itemId: string; responseText: string; score: number; scoreJson: string }>,
  ): void;
};

/** What Build a Sentence scoring reads of the Attempt: its mode, and the Item rows already on it. */
export type BuildSentenceAttempt = {
  id: string;
  mode: string;
  items: readonly { item_id: string; task_type: string; scoring_status: string; score: number | null }[];
};

/**
 * A Simulation's Build a Sentence request names some Items that are already scored and some that
 * are not. Not a retry of a request that landed (that names only scored Items), so it is refused
 * whole: an answer cannot change once it is scored. The route answers 409, never marked
 * `alreadyScored`.
 */
export class PartlyScoredRequest extends Error {}

/**
 * Scores a Build a Sentence request synchronously: every Item is resolved and scored before
 * anything is written, then the whole request is written at once, so an unknown Item refuses the
 * request with nothing persisted.
 *
 * A Drill's answer carries each Item's key, and a Drill may send an Item again (the Writing Drill's
 * Retry after a lost response re-sends the whole Task). A Simulation's answer carries bare
 * correctness (keys reach the client only once the Attempt completes), and an Item is scored once:
 * a request whose Items are all scored already is answered from the stored rows and writes
 * nothing, so a retry after a lost response is safe, and a request mixing scored and unscored Items
 * throws PartlyScoredRequest. Decided from the Attempt's mode, never from client input.
 *
 * score_json carries the Item's key and its `frame` as the Set had it at scoring time (absent when
 * the Item has none). Attempt review composes the persisted tile order with the persisted frame in
 * preference to the Set's current one, so the order is never paired with a frame it was not
 * answered against.
 */
export function scoreBuildSentence(
  repo: BuildSentenceScoreStore,
  attempt: BuildSentenceAttempt,
  set: AnySet,
  request: Extract<ScoreRequest, { taskType: "build_sentence" }>,
): BuildSentenceScoreVM {
  if (set.kind !== "writing") throw new NotFound("build_sentence requires a writing set");
  const requested = request.items.map(({ itemId, tileOrder }) => {
    const item = set.buildASentence.items.find((i) => i.id === itemId);
    if (!item) throw new NotFound(`unknown item ${itemId}`);
    return { item, tileOrder };
  });
  const drill = attempt.mode === "drill";

  if (!drill) {
    const scoredRows = new Map(
      attempt.items
        .filter((row) => row.task_type === "build_sentence" && row.scoring_status === "scored")
        .map((row) => [row.item_id, row]),
    );
    const already = requested.filter(({ item }) => scoredRows.has(item.id));
    if (already.length > 0 && already.length === requested.length) {
      return {
        taskType: "build_sentence",
        items: requested.map(({ item }) => ({ itemId: item.id, correct: scoredRows.get(item.id)!.score === 1 })),
      };
    }
    if (already.length > 0) throw new PartlyScoredRequest(`already scored: ${already.map(({ item }) => item.id).join(", ")}`);
  }

  const scored = requested.map(({ item, tileOrder }) => ({ item, tileOrder, ...scoreSentence(tileOrder, item.answers) }));
  repo.scoreBuildSentenceItems(scored.map(({ item, tileOrder, correct }) => ({
    attemptId: attempt.id,
    itemId: item.id,
    responseText: JSON.stringify(tileOrder),
    score: correct ? 1 : 0,
    scoreJson: JSON.stringify({
      correct,
      correctAnswers: item.answers,
      ...(item.frame !== undefined ? { frame: item.frame } : {}),
    }),
  })));
  return drill
    ? {
        taskType: "build_sentence",
        items: scored.map(({ item, correct, matchedAnswer }) => ({ itemId: item.id, correct, matchedAnswer, correctAnswers: item.answers })),
      }
    : { taskType: "build_sentence", items: scored.map(({ item, correct }) => ({ itemId: item.id, correct })) };
}

// The essay adapter over the Judge ensemble: one Item, its materials already resolved by admit, and
// an arbitration call carrying that single Item.
async function scoreEssay(
  deps: EnsembleDeps,
  session: ScoringSession,
  attemptId: string,
  admitted: AdmittedEssay,
  committed: ReadonlySet<string>,
  onProgress?: OnScoringProgress,
  signal?: AbortSignal,
) {
  const judgeEssay = deps.judgeEssay ?? realJudgeEssay;
  const aggregate = deps.aggregate ?? realAggregate;
  const { taskType, itemId, responseText: text, materials } = admitted;
  const hadScore = committed.has(itemId);

  // An essay with no words (nothing, or only whitespace: essayHasNoWords) scores a deterministic 0
  // and never reaches a Judge or the Arbiter, the written counterpart of a recording with no speech
  // (docs/adr/0018). A Re-score of it lands here too, so the empty text is never sent anywhere. Any
  // Judge Report from an earlier scoring of the Item is deleted with it, so nothing judged sits
  // beside the 0.
  if (essayHasNoWords(text)) {
    const reportItem = noWordsReportItem(itemId);
    session.persist((writes) => {
      onProgress?.({ stage: "persisting" });
      writes.deleteJudgeReports(attemptId, itemId);
      writes.updateItemScore({ attemptId, itemId, score: 0, scoreJson: JSON.stringify(reportItem), scoringStatus: "scored" });
    });
    return { taskType, report: { taskType, items: [reportItem] }, judges: [], judgesFailed: [] };
  }

  const markFailed = (message: string) => {
    if (hadScore) return;
    session.persist((writes) => {
      writes.updateItemScore({ attemptId, itemId, score: null, scoreJson: JSON.stringify({ error: message }), scoringStatus: "failed" });
    });
  };

  const { fulfilled, judgesFailed, openaiJudgeProvider } = await runJudges(
    (judge) => judgeEssay(judge, { taskType, materials, responseText: text, ...(signal ? { signal } : {}) }),
    { onProgress, signal },
  );
  const judgeReports = fulfilled.map((f) => f.value.report);

  if (judgeReports.length === 0) failRescorable(markFailed, "both judges failed");
  // A rescore replaces the prior Judge Reports rather than appending. An Item without a committed
  // score gets them now, so they survive a failed arbitration; one with a committed score gets them
  // only alongside its new score.
  const replaceJudgeReports = (writes: GuardedWrites) => {
    writes.deleteJudgeReports(attemptId, itemId);
    for (const r of judgeReports) writes.insertJudgeReport({ attemptId, itemId, judge: r.judge, reportJson: JSON.stringify(r) });
  };
  if (!hadScore) session.persist(replaceJudgeReports);

  const report: ScoreReport = await arbitrateNeutrally(
    (opts) =>
      aggregate(
        {
          taskType,
          itemId,
          materials,
          responseText: text,
          judgeReports,
          openaiJudgeProvider,
        },
        opts,
      ),
    { onProgress, signal, markFailed },
  );

  const result = {
    taskType, report,
    judges: judgeReports.map((r) => ({ judge: r.judge, score: r.items[0].score, dimensions: r.items[0].dimensions, deductions: r.items[0].deductions })),
    judgesFailed,
  };
  session.persist((writes) => {
    onProgress?.({ stage: "persisting" });
    if (hadScore) replaceJudgeReports(writes);
    writes.updateItemScore({ attemptId, itemId, score: report.items[0].finalScore, scoreJson: JSON.stringify(report.items[0]), scoringStatus: "scored" });
  });
  return result;
}

// Seconds. Below this clip duration a word-count pace is noise rather than a rate: one word in a
// 0.3 s clip extrapolates to about 200 words per minute.
const MIN_PACE_DURATION_SEC = 2;

// The Speaking adapter over the Judge ensemble. Unlike the essay adapter, its materials come off
// the persisted Response rows (transcript, Delivery Report and recording, written before scoring
// started), which it only reads: insertItemResult would upsert NULLs over them. Each Judge family
// also gets its own audio container, and the whole Task Type is arbitrated in one call.
async function scoreSpeaking(
  deps: EnsembleDeps,
  session: ScoringSession,
  attemptId: string,
  admitted: AdmittedSpeaking,
  committed: ReadonlySet<string>,
  onProgress?: OnScoringProgress,
  signal?: AbortSignal,
) {
  const judgeSpeaking = deps.judgeSpeaking ?? realJudgeSpeaking;
  const aggregateSpeaking = deps.aggregateSpeaking ?? realAggregateSpeaking;
  const probeDurationSec = deps.probeDurationSec ?? realProbeDurationSec;
  const taskType = admitted.taskType;
  const requestedIds = admitted.items.map((i) => i.itemId);

  // A no-speech recording scores a deterministic 0 and never reaches a Judge. Written first, as its
  // own step, so the judged Items' outcome can neither block nor overwrite it; any Judge Report from
  // an earlier take is deleted with it.
  const silent: Array<{ itemId: string } & SpokenItemPrompt> = admitted.silent;
  if (silent.length > 0) {
    session.persist((writes) => {
      for (const s of silent) {
        writes.deleteJudgeReports(attemptId, s.itemId);
        writes.updateItemScore(noSpeechScoreWrite(attemptId, s.itemId, s));
      }
    });
  }
  const silentReportItems = silent.map((s) => noSpeechReportItem(s.itemId));
  const silentResultItems = silent.map((s) => ({ itemId: s.itemId, ...spokenItemMeta(s, "") }));
  if (requestedIds.length === 0) {
    return { taskType, report: { taskType, items: silentReportItems }, judges: [], judgesFailed: [], items: silentResultItems };
  }

  // One SpeakingJudgeItem per admitted Item, pointing at the webm (Gemini's container; the OpenAI
  // Judge gets the mp3 beside it). Listen and Repeat gets its target and a server-computed word
  // diff; Interview gets the question and a server-computed paceWpm in place of the one Ears
  // reported. resolveAudioPath accepts both stored forms of response_audio_path (dataDir-relative,
  // or absolute on older rows).
  const judgeItems: SpeakingJudgeItem[] = [];
  if (admitted.taskType === "listen_repeat") {
    for (const { itemId, row, target } of admitted.items) {
      const deliveryReport = JSON.parse(row.delivery_report!) as DeliveryReport;
      const webmPath = resolveAudioPath(row.response_audio_path!);
      judgeItems.push({
        itemId, audioPath: webmPath, transcript: row.transcript!, deliveryReport,
        target, diff: wordDiff(target, row.transcript!),
      });
    }
  } else {
    for (const { itemId, row, question } of admitted.items) {
      const deliveryReport = JSON.parse(row.delivery_report!) as DeliveryReport;
      const webmPath = resolveAudioPath(row.response_audio_path!);
      let durationSec: number | null = null;
      try {
        durationSec = await probeDurationSec(webmPath);
      } catch {
        durationSec = null; // best-effort: a failed probe falls back to Ears' own pace below
      }
      // Window-time pace: transcript word count over the whole clip, silences and pauses included,
      // not a speech-only rate. A failed probe keeps Ears' paceWpm; a clip shorter than
      // MIN_PACE_DURATION_SEC reports null rather than an extrapolated rate.
      let paceWpm: number | null;
      if (durationSec === null) {
        paceWpm = deliveryReport.paceWpm;
      } else if (durationSec < MIN_PACE_DURATION_SEC) {
        paceWpm = null;
      } else {
        paceWpm = Math.round((countWords(row.transcript!) / durationSec) * 60);
      }
      judgeItems.push({
        itemId, audioPath: webmPath, transcript: row.transcript!,
        deliveryReport: { ...deliveryReport, paceWpm }, question,
      });
    }
  }

  // A supersede obsoletes every Item this job covers at once, so a failure marks all of them in one
  // step. An Item with a committed score is left as it was (see committedItemIds).
  const markFailed = (message: string) =>
    session.persist((writes) => {
      for (const id of requestedIds) {
        if (committed.has(id)) continue;
        writes.updateItemScore({ attemptId, itemId: id, score: null, scoreJson: JSON.stringify({ error: message }), scoringStatus: "failed" });
      }
    });

  const { fulfilled, judgesFailed, openaiJudgeProvider } = await runJudges(
    (judge) => judgeSpeaking(judge, {
      taskType,
      items: judge === "gemini" ? judgeItems : judgeItems.map((it) => ({ ...it, audioPath: toMp3Path(it.audioPath) })),
      ...(signal ? { signal } : {}),
    }),
    { onProgress, signal },
  );
  const judgeReports = fulfilled.map((f) => f.value.report);

  if (judgeReports.length === 0) failRescorable(markFailed, "both judges failed");

  // A rescore replaces each Item's prior Judge Reports rather than appending. Each report is stored
  // per Item, with the Judge's `mode` folded in so a Text Fallback stays visible on read-back. Items
  // without a committed score get theirs now, so they survive a failed arbitration; Items with one
  // get theirs only alongside their new score.
  const replaceJudgeReports = (writes: GuardedWrites, ids: readonly string[]) => {
    for (const id of ids) {
      writes.deleteJudgeReports(attemptId, id);
      for (const f of fulfilled) {
        const judgeItem = f.value.report.items.find((i) => i.itemId === id);
        if (!judgeItem) continue;
        writes.insertJudgeReport({
          attemptId, itemId: id, judge: f.judge,
          reportJson: JSON.stringify({ judge: f.judge, taskType, items: [judgeItem], mode: f.value.mode }),
        });
      }
    }
  };
  session.persist((writes) => replaceJudgeReports(writes, requestedIds.filter((id) => !committed.has(id))));

  // Tells the Arbiter which Judges scored from the transcript (Text Fallback) rather than the audio.
  const modes: Record<string, "audio" | "text-fallback"> = {};
  for (const f of fulfilled) modes[f.judge] = f.value.mode;

  const report: ScoreReport = await arbitrateNeutrally(
    (opts) =>
      aggregateSpeaking(
        {
          taskType,
          items: judgeItems.map(({ itemId, target, question, transcript, deliveryReport, diff }) => ({
            itemId, target, question, transcript, deliveryReport, diff,
          })),
          judgeReports,
          modes,
          openaiJudgeProvider,
        },
        opts,
      ),
    { onProgress, signal, markFailed },
  );

  // Each scored Item's target and diff (Listen and Repeat) or question (Interview), persisted under
  // score_json's `meta` key: Attempt review renders from persisted rows only.
  const metaByItemId = new Map(
    judgeItems.map(({ itemId, target, diff, question }) => [itemId, { target, diff, question }])
  );
  // The Arbiter may leave a requested Item out of its report (aggregateSpeaking refuses ids it was
  // not asked about, but not omissions). An omitted Item without a committed score is marked
  // failed so it is visibly rescorable rather than left 'pending'; one with a committed score keeps
  // it, since nothing replaced it.
  const returnedIds = new Set(report.items.map((i) => i.itemId));

  // One step for the whole persist phase, progress event included, for the same reason as markFailed.
  session.persist((writes) => {
    onProgress?.({ stage: "persisting" });
    replaceJudgeReports(writes, report.items.map((i) => i.itemId).filter((id) => committed.has(id)));
    for (const reportItem of report.items) {
      writes.updateItemScore({
        attemptId, itemId: reportItem.itemId, score: reportItem.finalScore,
        scoreJson: JSON.stringify({ ...reportItem, meta: metaByItemId.get(reportItem.itemId) }),
        scoringStatus: "scored",
      });
    }
    for (const id of requestedIds) {
      if (returnedIds.has(id) || committed.has(id)) continue;
      writes.updateItemScore({
        attemptId, itemId: id, score: null,
        scoreJson: JSON.stringify({ error: "arbiter omitted item" }), scoringStatus: "failed",
      });
    }
  });

  return {
    taskType,
    report: { ...report, items: [...report.items, ...silentReportItems] },
    judges: fulfilled.map((f) => ({
      judge: f.judge, mode: f.value.mode,
      items: f.value.report.items.map((i) => ({ itemId: i.itemId, score: i.score, dimensions: i.dimensions, deductions: i.deductions })),
    })),
    judgesFailed,
    // The target and word diff (Listen and Repeat) or question (Interview) the client shows beside
    // each score; ScoreReport is task-agnostic and carries neither.
    items: [
      ...judgeItems.map(({ itemId, target, diff, question }) =>
        taskType === "listen_repeat" ? { itemId, target, diff } : { itemId, question }),
      ...silentResultItems,
    ],
  };
}

function toMp3Path(webmPath: string): string {
  return webmPath.replace(/\.webm$/, ".mp3");
}

function countWords(text: string): number {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed === "" ? 0 : trimmed.split(" ").length;
}
