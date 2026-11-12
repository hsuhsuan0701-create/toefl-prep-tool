/**
 * Writes the demo practice history into a data directory that already holds the question bank.
 *
 * Every row goes through the same store calls and scoring services the app uses: Reading and
 * Listening Responses are scored by scoreDeterministicItems and routed by decidePath, Build a
 * Sentence by scoreBuildSentence, a recording goes through the transcription job's own write
 * sequence, a Speaking Simulation is finished by the real capture-finished and reconcile path, and
 * every Band Estimate comes from recomputeSectionEstimate. The only things written by hand are what
 * a model would have returned (content/*.ts, assembled by reports.ts) and the timestamps: the stores
 * stamp rows with the wall clock, so each row's `*_at` columns are moved to the moment in the
 * history it belongs to, right after the store writes it.
 *
 * Deterministic: the history is a fixed script, every random choice (which Items are missed, which
 * wrong option is picked, the ids) comes from a stream named after its sitting (rng.ts), and every
 * date is a fixed offset from `today`. The same `today`, time zone and ffmpeg give the same database.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ScoreRequestSchema,
  type AnySet,
  type DeliveryReport,
  type FullTestSection,
  type ListeningSet,
  type ReadingSet,
  type ScoreRequest,
  type Section,
  type SpeakingSet,
  type WritingSet,
} from "@toefl-prep/shared";
import type Database from "better-sqlite3";
import { openDb } from "../../server/src/db/db.js";
import { createSqliteStores, speakingCoordinatorStore, type SqliteStores } from "../../server/src/db/stores/index.js";
import { sqliteTimestamp } from "../../server/src/db/timestamps.js";
import {
  censusRouterItems,
  indexDeterministicItems,
  scoreDeterministicItems,
  type DeterministicItemRef,
} from "../../server/src/services/deterministicScoring.js";
import { noSpeechScoreWrite, spokenItemMeta } from "../../server/src/services/judgeEnsemble.js";
import { decidePath } from "../../server/src/services/moduleRouter.js";
import { scoreBuildSentence } from "../../server/src/services/scoreItems.js";
import { recomputeSectionEstimate, type EstimateStore } from "../../server/src/services/sectionEstimates.js";
import { scoreSentence } from "../../server/src/services/sentenceScorer.js";
import { createSetStore, type SetStore } from "../../server/src/services/setStore.js";
import { createSpeakingFinalization, type SpeakingFinalization } from "../../server/src/services/speakingFinalization.js";
import { NO_SPEECH, SKIPPED, SPEAKING, TRANSCRIPTION_FAILED, type SpeakingContent } from "./content/speaking.js";
import { WRITING, type EssayOutcome } from "./content/writing.js";
import type { DemoRecordings } from "./recordings.js";
import {
  SILENT_DELIVERY_REPORT,
  buildDeliveryReport,
  buildJudgedScoring,
  buildRepeatScoring,
  type JudgeReportRow,
} from "./reports.js";
import { rngFor, type Rng } from "./rng.js";

export type SeedOptions = {
  /** A data directory that already holds the question bank and no database yet. */
  dataDir: string;
  /** The moment the history leads up to. Every timestamp written is earlier. */
  today: Date;
  /** The audio files behind the spoken Responses, or null to write the rows without files. */
  recordings: DemoRecordings | null;
};

export type SeedSummary = {
  attempts: Record<Section, { drill: number; simulation: number }>;
  fullTestRuns: { completed: number; inProgress: number };
  recordingFiles: number;
  /** Each section's headline Band Estimate after seeding, as the Dashboard reads it. */
  headline: Partial<Record<Section, number>>;
};

/** The Targets the demo User set on the Dashboard. */
const TARGETS: Record<Section, string> = { reading: "5.5", listening: "5.5", writing: "5", speaking: "5" };

/** How often each Task Type is the one missed, relative to the others. */
const DIFFICULTY: Record<string, number> = {
  complete_words: 1,
  daily_life: 0.7,
  academic_passage: 1.5,
  listen_choose: 0.8,
  conversation: 1,
  announcement: 1,
  academic_talk: 1.5,
};

/** The automatic transcription retry delays, as transcriptionRecovery.ts runs them. */
const TRANSCRIPTION_RETRY_DELAYS_SEC = [15, 60, 300];

type Run = { id: string };
type DeterministicSitting = {
  label: string;
  mode: "drill" | "simulation";
  setId: string;
  start: Date;
  /** Fraction of the Router Module answered correctly. */
  router: number;
  /** Fraction of the second Module answered correctly (Simulations only). */
  second?: number;
  flagged?: true;
  run?: Run;
  /** Leave the Attempt in progress once the Router Module is routed. */
  stopAfterRouting?: true;
};
type WritingSitting = {
  label: string;
  mode: "drill" | "simulation";
  setId: string;
  start: Date;
  /** How many of the ten Build a Sentence Items are right. */
  buildSentence: number;
  essays: "both" | "email" | "none";
  leaveUnfinished?: true;
  run?: Run;
};
type SpeakingSitting = { label: string; mode: "drill" | "simulation"; content: SpeakingContent; start: Date; run?: Run };

function plus(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000);
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

class Seeder {
  readonly stores: SqliteStores;
  readonly summary: SeedSummary = {
    attempts: {
      reading: { drill: 0, simulation: 0 },
      listening: { drill: 0, simulation: 0 },
      writing: { drill: 0, simulation: 0 },
      speaking: { drill: 0, simulation: 0 },
    },
    fullTestRuns: { completed: 0, inProgress: 0 },
    recordingFiles: 0,
    headline: {},
  };
  private readonly sets: SetStore;
  private readonly estimateStore: EstimateStore;
  private readonly finalization: SpeakingFinalization;
  /** The instant the finalization service reads as "now". */
  private finalizationClock = new Date(0);
  private readonly backdate: {
    attemptStarted: Database.Statement;
    item: Database.Statement;
    judgeReports: Database.Statement;
  };

  constructor(
    db: Database.Database,
    private readonly opts: SeedOptions,
  ) {
    this.stores = createSqliteStores(db, { dataDir: opts.dataDir });
    this.sets = createSetStore(opts.dataDir);
    this.estimateStore = { getAttempt: this.stores.attempts.getAttempt, ...this.stores.estimates };
    this.finalization = createSpeakingFinalization({
      repo: speakingCoordinatorStore(this.stores),
      dataDir: opts.dataDir,
      setStore: this.sets,
      now: () => this.finalizationClock,
    });
    this.backdate = {
      attemptStarted: db.prepare("UPDATE attempts SET started_at=? WHERE id=?"),
      item: db.prepare(
        "UPDATE item_results SET created_at=?, scored_at=CASE WHEN scored_at IS NULL THEN NULL ELSE ? END WHERE attempt_id=? AND item_id=?",
      ),
      judgeReports: db.prepare("UPDATE judge_reports SET created_at=? WHERE attempt_id=? AND item_id=?"),
    };
  }

  /** `hh:mm` local time, `daysAgo` calendar days before `today`. */
  at(daysAgo: number, hhmm: string): Date {
    const [hours, minutes] = hhmm.split(":").map(Number);
    const date = new Date(this.opts.today);
    date.setDate(date.getDate() - daysAgo);
    date.setHours(hours, minutes, 0, 0);
    if (date >= this.opts.today) throw new Error(`the demo history reaches past today (${date.toISOString()})`);
    return date;
  }

  setTargets(): void {
    for (const [section, band] of Object.entries(TARGETS)) this.stores.settings.setSetting(`target.${section}`, band);
  }

  private readSet<K extends AnySet["kind"]>(setId: string, kind: K): Extract<AnySet, { kind: K }> {
    const set = this.sets.readSet(setId);
    if (!set || set.kind !== kind) {
      throw new Error(`the demo history needs ${kind} Set ${setId}, which this data directory's bank does not have`);
    }
    return set as Extract<AnySet, { kind: K }>;
  }

  private stampItem(attemptId: string, itemId: string, createdAt: Date, scoredAt: Date = createdAt): void {
    this.backdate.item.run(sqliteTimestamp(createdAt), sqliteTimestamp(scoredAt), attemptId, itemId);
  }

  private openAttempt(kind: Section, mode: "drill" | "simulation", setId: string, start: Date, label: string, run?: Run): string {
    const id = rngFor(`attempt-id:${label}`).uuid();
    // The Repeat tag from the same rule the route applies: the Set already has an Attempt with a
    // scored Item, or a completed Attempt holding at least one Item.
    const isRepeat = this.stores.attempts.isSetAttempted(setId);
    this.stores.attempts.createAttempt({ id, kind, mode, setId, isRepeat });
    if (run) this.stores.fullTests.linkFullTestAttempt(run.id, kind, id);
    this.backdate.attemptStarted.run(sqliteTimestamp(start), id);
    this.summary.attempts[kind][mode] += 1;
    return id;
  }

  private complete(attemptId: string, at: Date): void {
    if (!this.stores.attempts.completeAttempt(attemptId, sqliteTimestamp(at))) {
      throw new Error(`attempt ${attemptId} was not in progress`);
    }
    recomputeSectionEstimate(this.estimateStore, attemptId);
  }

  fullTestRun(label: string, start: Date, setIds: Record<FullTestSection, string>): Run {
    const run = { id: rngFor(`run-id:${label}`).uuid() };
    this.stores.fullTests.createFullTestRun({ id: run.id, currentSection: "reading", setIds, createdAt: sqliteTimestamp(start) });
    return run;
  }

  private advanceRun(run: Run, next: FullTestSection | "end", at: Date): void {
    if (next === "end") {
      this.stores.fullTests.completeFullTestRun(run.id, sqliteTimestamp(at));
      this.summary.fullTestRuns.completed += 1;
    } else {
      this.stores.fullTests.setFullTestCurrentSection(run.id, next);
    }
  }

  /** The Responses for one Module's Items, with `accuracy` of them right, grouped by Task Type. */
  private moduleRequests(
    items: readonly [string, DeterministicItemRef][],
    accuracy: number,
    rng: Rng,
  ): ScoreRequest[] {
    // Which Items are missed: a weighted sample (key u^(1/w), the largest keys win), so harder Task
    // Types are missed more often without every miss landing on them.
    const wrongCount = Math.round((1 - accuracy) * items.length);
    const keyed = items.map(([itemId, ref]) => ({ itemId, key: rng.next() ** (1 / DIFFICULTY[ref.taskType]) }));
    const wrong = new Set(keyed.sort((a, b) => b.key - a.key).slice(0, wrongCount).map((k) => k.itemId));

    const byTaskType = new Map<string, Record<string, string>[]>();
    for (const [itemId, ref] of items) {
      const missed = wrong.has(itemId);
      let response: Record<string, string>;
      if (ref.taskType === "complete_words") {
        response = { itemId, typed: missed ? wrongCompletion(ref.completion, rng) : ref.completion };
      } else {
        const others = ref.question.options.filter((o) => o.id !== ref.question.correctOptionId).map((o) => o.id);
        response = { itemId, selectedOptionId: missed ? rng.pick(others) : ref.question.correctOptionId };
      }
      byTaskType.set(ref.taskType, [...(byTaskType.get(ref.taskType) ?? []), response]);
    }
    return [...byTaskType].map(([taskType, responses]) => ScoreRequestSchema.parse({ taskType, items: responses }));
  }

  /** Scores one Module the way a Simulation submits it: one request per Task Type, in order. */
  private scoreModule(attemptId: string, set: ReadingSet | ListeningSet, requests: ScoreRequest[], start: Date, minutes: number): Date {
    const step = (minutes * 60) / requests.length;
    let at = start;
    for (const request of requests) {
      at = plus(at, step);
      const attempt = this.stores.attempts.getAttempt(attemptId)!;
      scoreDeterministicItems({ repo: this.stores.attempts, attempt, set, request });
      for (const item of request.items) this.stampItem(attemptId, item.itemId, at);
    }
    return at;
  }

  async deterministic(kind: "reading" | "listening", s: DeterministicSitting): Promise<void> {
    const set: ReadingSet | ListeningSet = kind === "reading" ? this.readSet(s.setId, "reading") : this.readSet(s.setId, "listening");
    const rng = rngFor(`answers:${s.label}`);
    const id = this.openAttempt(kind, s.mode, s.setId, s.start, s.label, s.run);
    const items = [...indexDeterministicItems(set)];
    const moduleItems = (module: DeterministicItemRef["module"]) => items.filter(([, ref]) => ref.module === module);
    const [routerMinutes, secondMinutes] = kind === "reading" ? [19, 8] : [16, 9];

    let at = this.scoreModule(id, set, this.moduleRequests(moduleItems("router"), s.router, rng), s.start, routerMinutes);
    if (s.mode === "simulation") {
      const census = censusRouterItems(set, this.stores.attempts.getAttempt(id)!);
      const { path: modulePath, routerRaw } = decidePath(census.correctCount, census.total);
      this.stores.attempts.setAttemptRouting(id, modulePath, routerRaw);
      if (s.stopAfterRouting) {
        this.summary.fullTestRuns.inProgress += s.run ? 1 : 0;
        return;
      }
      const second = s.second ?? s.router;
      at = this.scoreModule(id, set, this.moduleRequests(moduleItems(modulePath), second, rng), plus(at, 30), secondMinutes);
    }
    if (s.flagged) this.stores.attempts.flagAttempt(id);
    this.complete(id, plus(at, 20));
    if (s.run) this.advanceRun(s.run, kind === "reading" ? "listening" : "writing", plus(at, 60));
  }

  private essay(attemptId: string, taskType: "email" | "discussion", itemId: string, outcome: EssayOutcome, submittedAt: Date): void {
    this.stores.attempts.insertItemResult({ attemptId, itemId, taskType, responseText: outcome.text });
    // The Judges and the Arbiter take a few minutes after the Response is submitted.
    const judgedAt = plus(submittedAt, 95);
    const scoredAt = plus(submittedAt, 260);
    if ("failed" in outcome) {
      this.stores.attempts.updateItemScore({
        attemptId, itemId, score: null, scoreJson: JSON.stringify({ error: outcome.failed }), scoringStatus: "failed",
      });
      this.stampItem(attemptId, itemId, submittedAt);
      return;
    }
    const { scoreItem, judgeReports } = buildJudgedScoring(taskType, itemId, outcome);
    this.writeJudgeReports(attemptId, itemId, judgeReports, judgedAt);
    this.stores.attempts.updateItemScore({
      attemptId, itemId, score: scoreItem.finalScore, scoreJson: JSON.stringify(scoreItem), scoringStatus: "scored",
    });
    this.stampItem(attemptId, itemId, submittedAt, scoredAt);
  }

  private writeJudgeReports(attemptId: string, itemId: string, reports: readonly JudgeReportRow[], at: Date): void {
    this.stores.attempts.deleteJudgeReports(attemptId, itemId);
    for (const report of reports) this.stores.attempts.insertJudgeReport({ attemptId, itemId, ...report });
    this.backdate.judgeReports.run(sqliteTimestamp(at), attemptId, itemId);
  }

  async writing(s: WritingSitting): Promise<void> {
    const set: WritingSet = this.readSet(s.setId, "writing");
    const rng = rngFor(`answers:${s.label}`);
    const id = this.openAttempt("writing", s.mode, s.setId, s.start, s.label, s.run);

    const items = set.buildASentence.items;
    const missed = new Set(rng.sample(items.map((item) => item.id), items.length - s.buildSentence));
    scoreBuildSentence(this.stores.attempts, this.stores.attempts.getAttempt(id)!, set, {
      taskType: "build_sentence",
      items: items.map((item) => ({ itemId: item.id, tileOrder: missed.has(item.id) ? wrongTileOrder(item, rng) : [...item.answers[0]] })),
    });
    let at = plus(s.start, 6 * 60);
    for (const item of items) this.stampItem(id, item.id, at);

    const content = WRITING[s.setId];
    if (s.essays !== "none") {
      if (!content) throw new Error(`no demo essays are written for ${s.setId}`);
      at = plus(at, 7 * 60);
      this.essay(id, "email", set.email.id, content.email, at);
      if (s.essays === "both") {
        if (!content.discussion) throw new Error(`no demo discussion post is written for ${s.setId}`);
        at = plus(at, 10 * 60);
        this.essay(id, "discussion", set.academicDiscussion.id, content.discussion, at);
      }
    }
    if (s.leaveUnfinished) return;
    this.complete(id, plus(at, 15));
    if (s.run) this.advanceRun(s.run, "speaking", plus(at, 60));
  }

  /**
   * One recording, written as the upload and its transcription job write it: the file, a job that
   * is claimed, the Item row at 'transcription_pending', then either the transcript landing on the
   * Item or every automatic retry failing.
   */
  private record(
    attemptId: string,
    itemId: string,
    taskType: "listen_repeat" | "interview",
    audio: Buffer | null,
    at: Date,
    rng: Rng,
    result: { transcript: string; delivery: DeliveryReport } | "transcription-failed",
  ): void {
    const audioPath = `audio/responses/${attemptId}/${itemId}.webm`;
    if (audio) {
      const file = path.join(this.opts.dataDir, audioPath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, audio);
      this.summary.recordingFiles += 1;
    }
    const audioSha256 = sha256(audio ?? Buffer.alloc(0));
    const jobId = rng.uuid();
    const transcription = this.stores.transcription;
    const ts = sqliteTimestamp;
    transcription.createOrGetTranscriptionJob({ id: jobId, attemptId, itemId, taskType, audioPath, audioSha256, now: ts(at) });
    transcription.claimTranscriptionJob({ id: jobId, now: ts(at) });
    this.stores.attempts.insertItemResult({ attemptId, itemId, taskType, responseAudioPath: audioPath, scoringStatus: "transcription_pending" });
    this.stampItem(attemptId, itemId, at);

    if (result !== "transcription-failed") {
      const landed = transcription.persistFreshTranscriptAndFinishJob({
        jobId, attemptId, itemId, taskType, responseAudioPath: audioPath, audioSha256,
        transcript: result.transcript, deliveryReport: JSON.stringify(result.delivery), now: ts(plus(at, 9)),
      });
      if (!landed) throw new Error(`the transcript for ${attemptId}/${itemId} did not land`);
      return;
    }
    // Ears answered 503 on the first try and on each automatic retry, so the job ends 'failed' with
    // a retryable kind: the review offers the User a Retry that re-uses this recording.
    let tryAt = at;
    for (let attempt = 0; attempt <= TRANSCRIPTION_RETRY_DELAYS_SEC.length; attempt++) {
      if (attempt > 0) transcription.claimTranscriptionJob({ id: jobId, now: ts(tryAt) });
      const last = attempt === TRANSCRIPTION_RETRY_DELAYS_SEC.length;
      const nextTry = last ? null : plus(tryAt, TRANSCRIPTION_RETRY_DELAYS_SEC[attempt]);
      transcription.updateTranscriptionJob({
        id: jobId,
        status: last ? "failed" : "retry_wait",
        automaticAttempts: 1,
        nextRetryAt: nextTry ? ts(nextTry) : null,
        failureKind: "provider",
        error: "provider unavailable (HTTP 503)",
        now: ts(plus(tryAt, 6)),
      });
      if (nextTry) tryAt = nextTry;
    }
  }

  async speaking(s: SpeakingSitting): Promise<void> {
    const set: SpeakingSet = this.readSet(s.content.setId, "speaking");
    const rng = rngFor(`answers:${s.label}`);
    const recordings = this.opts.recordings;
    const id = this.openAttempt("speaking", s.mode, set.id, s.start, s.label, s.run);
    let at = plus(s.start, 75);

    // Listen and Repeat: seven sentences, recorded one after another, then scored as one request.
    const repeated: { itemId: string; target: string; said: string; at: Date }[] = [];
    for (const item of set.listenAndRepeat.items) {
      at = plus(at, 22);
      const response = s.content.repeat[item.id];
      if (response === undefined) throw new Error(`${s.label}: no Response written for ${item.id}`);
      if (response === SKIPPED) continue;
      const delivery = buildDeliveryReport("repeat", response.score, rng, { suspectedMispronunciations: [...(response.mispronounced ?? [])] });
      this.record(id, item.id, "listen_repeat", recordings?.sentence ?? null, at, rng, { transcript: response.said, delivery });
      repeated.push({ itemId: item.id, target: item.sentence, said: response.said, at });
    }
    const repeatScoredAt = plus(at, 150);
    for (const r of repeated) {
      const response = s.content.repeat[r.itemId];
      if (response === SKIPPED || response === undefined) continue;
      const { scoreItem, judgeReports } = buildRepeatScoring(r.itemId, r.target, response);
      this.writeJudgeReports(id, r.itemId, judgeReports, plus(repeatScoredAt, -40));
      this.stores.attempts.updateItemScore({
        attemptId: id, itemId: r.itemId, score: scoreItem.finalScore,
        scoreJson: JSON.stringify({ ...scoreItem, meta: spokenItemMeta({ target: r.target }, r.said) }),
        scoringStatus: "scored",
      });
      this.stampItem(id, r.itemId, r.at, repeatScoredAt);
    }

    // Interview: four answers, then scored as one request.
    const answered: { itemId: string; question: string; at: Date }[] = [];
    at = plus(at, 40);
    for (const question of set.interview.questions) {
      at = plus(at, 70);
      const response = s.content.interview[question.id];
      if (response === undefined) throw new Error(`${s.label}: no Response written for ${question.id}`);
      if (response === TRANSCRIPTION_FAILED) {
        this.record(id, question.id, "interview", recordings?.answer ?? null, at, rng, "transcription-failed");
        continue;
      }
      if (response === NO_SPEECH) {
        this.record(id, question.id, "interview", recordings?.silence ?? null, at, rng, { transcript: "", delivery: SILENT_DELIVERY_REPORT });
      } else {
        const delivery = buildDeliveryReport("interview", response.final, rng, response.delivery);
        this.record(id, question.id, "interview", recordings?.answer ?? null, at, rng, { transcript: response.text, delivery });
      }
      answered.push({ itemId: question.id, question: question.question, at });
    }
    const captureEnd = plus(at, 50);
    const interviewScoredAt = plus(captureEnd, 240);
    for (const a of answered) {
      const response = s.content.interview[a.itemId];
      if (response === NO_SPEECH) {
        this.stores.attempts.updateItemScore(noSpeechScoreWrite(id, a.itemId, { question: a.question }));
      } else if (response !== TRANSCRIPTION_FAILED && response !== undefined) {
        const { scoreItem, judgeReports } = buildJudgedScoring("interview", a.itemId, response);
        this.writeJudgeReports(id, a.itemId, judgeReports, plus(interviewScoredAt, -60));
        this.stores.attempts.updateItemScore({
          attemptId: id, itemId: a.itemId, score: scoreItem.finalScore,
          scoreJson: JSON.stringify({ ...scoreItem, meta: spokenItemMeta({ question: a.question }, response.text) }),
          scoringStatus: "scored",
        });
      }
      this.stampItem(id, a.itemId, a.at, response === NO_SPEECH ? plus(captureEnd, 5) : interviewScoredAt);
    }

    if (s.mode === "simulation") {
      // The Simulation's own ending: capture finishes (an Item never recorded becomes a scored-0
      // skip), and reconciliation completes the Attempt once its scoring has ended.
      this.finalizationClock = captureEnd;
      await this.finalization.markCaptureFinished(id);
      // The placeholder rows capture-finished inserts for Items never recorded take the wall clock.
      for (const item of set.listenAndRepeat.items) {
        if (s.content.repeat[item.id] === SKIPPED) this.stampItem(id, item.id, captureEnd);
      }
      if (s.run) this.advanceRun(s.run, "end", captureEnd);
      this.finalizationClock = plus(interviewScoredAt, 5);
      await this.finalization.reconcileAttempt(id);
      if (this.stores.attempts.getAttempt(id)?.status !== "completed") throw new Error(`${s.label} did not complete`);
    } else {
      this.complete(id, captureEnd);
    }
  }
}

/** A tile order that is not one of the Item's answers: two neighbours swapped, or a distractor in. */
function wrongTileOrder(item: WritingSet["buildASentence"]["items"][number], rng: Rng): string[] {
  const answer = item.answers[0];
  const leftover = [...item.tiles];
  for (const tile of answer) leftover.splice(leftover.indexOf(tile), 1);
  const candidates: string[][] = [];
  if (leftover.length > 0) {
    const position = rng.int(0, answer.length - 1);
    candidates.push(answer.map((tile, i) => (i === position ? leftover[0] : tile)));
  }
  const swapAt = rng.int(0, answer.length - 2);
  const swapped = [...answer];
  [swapped[swapAt], swapped[swapAt + 1]] = [swapped[swapAt + 1], swapped[swapAt]];
  candidates.push(swapped);
  if (rng.next() < 0.5) candidates.reverse();
  candidates.push([...answer].reverse());
  const wrong = candidates.find((order) => !scoreSentence(order, item.answers).correct);
  if (!wrong) throw new Error(`could not build a wrong tile order for ${item.id}`);
  return wrong;
}

/** A Complete the Words gap typed wrong: left blank, or with its last letter mistyped. */
function wrongCompletion(completion: string, rng: Rng): string {
  if (completion.length <= 1 || rng.next() < 0.3) return "";
  const last = completion[completion.length - 1].toLowerCase();
  const swap = [..."aeiostdn"].filter((c) => c !== last);
  return completion.slice(0, -1) + rng.pick(swap);
}

/**
 * The demo User's three weeks, oldest first. Stronger at Reading and Listening than at Writing and
 * Speaking, improving unevenly: a lower Module Path in the first Simulations, an upper one later,
 * and productive scores that move half a band.
 */
async function writeHistory(s: Seeder): Promise<void> {
  s.setTargets();

  // Week one: trying each section, Drills first.
  await s.deterministic("listening", { label: "d20-listening-drill", mode: "drill", setId: "lsn-23b1b036", start: s.at(20, "19:40"), router: 0.72 });
  await s.writing({ label: "d19-writing-drill", mode: "drill", setId: "wri-77af733e", start: s.at(19, "21:05"), buildSentence: 5, essays: "both" });
  await s.speaking({ label: "d18-speaking-drill", mode: "drill", content: SPEAKING.commuteDrill, start: s.at(18, "20:10") });
  await s.deterministic("reading", { label: "d17-reading-sim", mode: "simulation", setId: "rd-1d6486b7", start: s.at(17, "19:30"), router: 0.55, second: 0.68 });
  await s.deterministic("listening", { label: "d16-listening-sim", mode: "simulation", setId: "lsn-03948a55", start: s.at(16, "20:00"), router: 0.56, second: 0.86 });
  await s.writing({ label: "d15-writing-sim", mode: "simulation", setId: "wri-90026a0d", start: s.at(15, "21:00"), buildSentence: 4, essays: "both" });
  await s.speaking({ label: "d14-speaking-sim", mode: "simulation", content: SPEAKING.artsSimulation, start: s.at(14, "20:20") });

  // Week two: Simulations, with a Writing Drill left unfinished late one night.
  await s.writing({ label: "d13-writing-drill", mode: "drill", setId: "wri-6c0c961a", start: s.at(13, "22:10"), buildSentence: 6, essays: "none", leaveUnfinished: true });
  await s.deterministic("reading", { label: "d12-reading-sim", mode: "simulation", setId: "rd-47ae9ca3", start: s.at(12, "19:45"), router: 0.72, second: 0.72 });
  await s.speaking({ label: "d11-speaking-drill", mode: "drill", content: SPEAKING.groceryDrill, start: s.at(11, "20:30") });
  await s.deterministic("listening", { label: "d10-listening-sim", mode: "simulation", setId: "lsn-ac7788d4", start: s.at(10, "20:05"), router: 0.76, second: 0.72, flagged: true });
  await s.writing({ label: "d9-writing-sim", mode: "simulation", setId: "wri-7024b060", start: s.at(9, "21:00"), buildSentence: 6, essays: "both" });
  await s.speaking({ label: "d8-speaking-sim", mode: "simulation", content: SPEAKING.exerciseSimulation, start: s.at(8, "20:15") });
  // The Reading Drill goes back over the Set of the first Reading Simulation, so it is a Repeat
  // and one live Reading Set (rd-35c68bb3) stays new: a Reading Simulation started in the demo is a
  // first sitting and can become the headline. After that Simulation, never before it, or the
  // Simulation would be the Repeat and lose its band.
  await s.deterministic("reading", { label: "d7-reading-drill", mode: "drill", setId: "rd-1d6486b7", start: s.at(7, "19:50"), router: 0.76 });

  // Week three: a whole Full-Test Run one afternoon, more practice, and a second Run started last
  // night and left after the Listening Router Module.
  const first = s.fullTestRun("d6-full-test", s.at(6, "13:30"), {
    reading: "rd-04b2ae46", listening: "lsn-7c5cf3f6", writing: "wri-f9779355", speaking: "spk-eabf67bc",
  });
  await s.deterministic("reading", { label: "d6-full-test-reading", mode: "simulation", setId: "rd-04b2ae46", start: s.at(6, "13:30"), router: 0.82, second: 0.8, run: first });
  await s.deterministic("listening", { label: "d6-full-test-listening", mode: "simulation", setId: "lsn-7c5cf3f6", start: s.at(6, "13:58"), router: 0.88, second: 0.86, run: first });
  await s.writing({ label: "d6-full-test-writing", mode: "simulation", setId: "wri-f9779355", start: s.at(6, "14:24"), buildSentence: 5, essays: "both", run: first });
  await s.speaking({ label: "d6-full-test-speaking", mode: "simulation", content: SPEAKING.windDownFullTest, start: s.at(6, "14:48"), run: first });

  await s.writing({ label: "d4-writing-sim", mode: "simulation", setId: "wri-736f2103", start: s.at(4, "21:00"), buildSentence: 7, essays: "both" });
  await s.speaking({ label: "d3-speaking-repeat", mode: "drill", content: SPEAKING.commuteRepeat, start: s.at(3, "20:40") });
  await s.writing({ label: "d2-writing-drill", mode: "drill", setId: "wri-be127d2e", start: s.at(2, "20:10"), buildSentence: 8, essays: "email" });
  await s.deterministic("listening", { label: "d2-listening-drill", mode: "drill", setId: "lsn-0488674a", start: s.at(2, "21:00"), router: 0.85 });

  const second = s.fullTestRun("d1-full-test", s.at(1, "19:20"), {
    reading: "rd-170e6bf3", listening: "lsn-93ee51c8", writing: "wri-7a20b90b", speaking: "spk-9dbd086f",
  });
  await s.deterministic("reading", { label: "d1-full-test-reading", mode: "simulation", setId: "rd-170e6bf3", start: s.at(1, "19:20"), router: 0.8, second: 0.8, run: second });
  await s.deterministic("listening", { label: "d1-full-test-listening", mode: "simulation", setId: "lsn-93ee51c8", start: s.at(1, "19:52"), router: 0.81, run: second, stopAfterRouting: true });
}

/**
 * Seeds `dataDir/db.sqlite`. The directory must already hold the question bank; the database must
 * not exist yet. On failure the half-written database is removed.
 */
export async function seedDemoData(opts: SeedOptions): Promise<SeedSummary> {
  const dbFile = path.join(opts.dataDir, "db.sqlite");
  if (fs.existsSync(dbFile)) throw new Error(`${dbFile} already exists`);
  const db = openDb(dbFile);
  // Durability of every single write is irrelevant while the whole file is being built (a failed
  // seed is deleted below), and per-statement fsyncs make seeding many times slower.
  db.pragma("synchronous = OFF");
  try {
    const seeder = new Seeder(db, opts);
    await writeHistory(seeder);
    const latest = seeder.stores.estimates.getLatestEstimates();
    for (const section of ["reading", "listening", "writing", "speaking"] as const) {
      const row = latest[section];
      if (row) seeder.summary.headline[section] = row.estimatedBand;
    }
    db.close();
    return seeder.summary;
  } catch (err) {
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbFile + suffix, { force: true });
    fs.rmSync(path.join(opts.dataDir, "audio", "responses"), { recursive: true, force: true });
    throw err;
  }
}
