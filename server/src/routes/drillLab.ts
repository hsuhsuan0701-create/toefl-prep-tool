import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  breakdownWordIndex,
  buildupSteps,
  chunkSentence,
  heldWordCount,
  type BuildupBankSetVM,
  type BuildupDiffOp,
  type BuildupItemVM,
  type BuildupPhase,
  type BuildupQueueEntryVM,
  type BuildupRepVM,
  type SpeakingSet,
} from "@toefl-prep/shared";
import { config } from "../lib/config.js";
import { setStore, type SetStore } from "../services/setStore.js";
import { wordDiff } from "../services/wordDiff.js";
import { hearRecording, EarsError } from "../services/ears.js";
import { sqliteTimestamp, sqliteTimestampToIso } from "../db/timestamps.js";

// =================================================================================================
// Drill Lab — backward buildup (倒序堆疊)
// =================================================================================================
//
// THIS ROUTE DELIBERATELY REVEALS LISTEN AND REPEAT TARGET SENTENCES IN CLEARTEXT.
//
// Everywhere else that is a bug: `GET /api/sets/:id` strips `sentence` from every Listen and Repeat
// Item, and routes/audio.ts refuses to serve `audio-manifest.json` because its word counts give the
// sentences' lengths away. A Listen and Repeat Item measures whether a sentence heard once can be
// held and reproduced, and a User who has read the sentence is no longer measuring that.
//
// Backward buildup cannot work without the text: the method is reading a growing suffix aloud. So
// this route breaks the rule on purpose, and keeps the break contained:
//
//   1. It is a separate route with its own path prefix. `stripAnswers` and `/api/sets/:id` are
//      untouched, so no change to Set serving can inherit this.
//   2. Nothing it writes reaches scoring state. Reps go to their own table, `backward_buildup_reps`,
//      which no estimator, Score Report, Attempt view or stats route joins: a rep is practice on a
//      sentence the User has read, not evidence of recall.
//   3. The bank browser shows a sentence only once the User has answered it as an Item, and reports
//      `attempted` per Set, so opening an unheard sentence is a deliberate choice: once read, it can
//      never be heard blind again.
//
// When adding an endpoint here, the question is not "does this leak a sentence" (they all do) but
// "can anything outside this file come to depend on the leak".

// ---------------------------------------------------------------------------------------------
// Persistence port
// ---------------------------------------------------------------------------------------------

export type DrillLabScoreRow = { setId: string; itemId: string; score: number; createdAt: string };

/** One row per drilled item: how many reps it has, and the newest MEASURED one's held-words inputs. */
export type DrillLabRepSummaryRow = {
  setId: string;
  itemId: string;
  repCount: number;
  breakdownIndex: number | null;
  targetWordCount: number;
  matchedWordCount: number | null;
};

export type BackwardBuildupRepRow = {
  id: string;
  setId: string;
  itemId: string;
  phase: BuildupPhase;
  transcript: string | null;
  transcriptionError: string | null;
  breakdownIndex: number | null;
  targetWordCount: number;
  matchedWordCount: number | null;
  diffJson: string | null;
  audioPath: string | null;
  createdAt: string;
};

export type DrillLabStore = {
  listenRepeatScores(): DrillLabScoreRow[];
  scoresForItem(setId: string, itemId: string): DrillLabScoreRow[];
  repSummaries(): DrillLabRepSummaryRow[];
  answeredListenRepeatItems(): { setId: string; itemId: string }[];
  listReps(setId: string, itemId: string): BackwardBuildupRepRow[];
  insertRep(row: BackwardBuildupRepRow): void;
};

export type DrillLabDeps = {
  repo: DrillLabStore;
  sets?: DrillLabSetSource;
  /** Injected for tests; production uses the real Ears call. */
  transcribe?: typeof hearRecording;
};

/**
 * A Listen and Repeat Item enters the practice queue at or below this score.
 *
 * 2.5 sits on the rubric's 3/2 boundary, rounded up to catch half steps: at 3 the response is still
 * a whole sentence carrying most of the content, at 2 a large part is gone. Below it the sentence
 * fell apart in memory, which is what backward buildup trains; a 3 or a 4 lost its marks to changed
 * words, a different problem.
 */
const WEAK_SCORE_CEILING = 2.5;

// Same floor as the Speaking upload path (routes/attempts.ts): a multipart part this small is a
// MediaRecorder blob that never captured any audio, not a take.
const MIN_RECORDING_BYTES = 512;

// ---------------------------------------------------------------------------------------------

/**
 * The two bank reads this route needs: one Set by id (the drill target) and a whole-bank scan (the
 * picker). Its own pair rather than a wider `SetReader`, which every other read-only consumer uses.
 */
export type DrillLabSetSource = Pick<SetStore, "readSet" | "scanBank">;

type LocatedItem = { set: SpeakingSet; scenarioTitle: string; sentence: string; audio: string };

function locateItem(sets: DrillLabSetSource, setId: string, itemId: string): LocatedItem | undefined {
  const set = sets.readSet(setId);
  if (!set || set.kind !== "speaking") return undefined;
  const item = set.listenAndRepeat.items.find((i) => i.id === itemId);
  if (!item) return undefined;
  return {
    set,
    scenarioTitle: set.listenAndRepeat.scenarioTitle,
    sentence: item.sentence,
    audio: item.audio,
  };
}

/**
 * `locateItem` with each Set parsed once per request: the queue often holds several Items of one
 * Set, and `readSet` re-parses the file on every call. Built per request, so nothing outlives it.
 */
function locatedItemMemo(sets: DrillLabSetSource): (setId: string, itemId: string) => LocatedItem | undefined {
  const cache = new Map<string, SpeakingSet | undefined>();
  return (setId, itemId) => {
    if (!cache.has(setId)) {
      const set = sets.readSet(setId);
      cache.set(setId, set && set.kind === "speaking" ? set : undefined);
    }
    const set = cache.get(setId);
    if (!set) return undefined;
    const item = set.listenAndRepeat.items.find((i) => i.id === itemId);
    if (!item) return undefined;
    return { set, scenarioTitle: set.listenAndRepeat.scenarioTitle, sentence: item.sentence, audio: item.audio };
  };
}

function wordCount(sentence: string): number {
  return sentence.trim().split(/\s+/u).filter((w) => w.length > 0).length;
}

function toRepVM(row: BackwardBuildupRepRow): BuildupRepVM {
  let diff: BuildupDiffOp[] | null = null;
  if (row.diffJson) {
    // An unparseable stored diff renders as "no diff available" beside its transcript rather than
    // failing the page.
    try {
      diff = JSON.parse(row.diffJson) as BuildupDiffOp[];
    } catch {
      diff = null;
    }
  }
  return {
    id: row.id,
    phase: row.phase,
    createdAt: sqliteTimestampToIso(row.createdAt),
    transcript: row.transcript,
    transcriptionError: row.transcriptionError,
    breakdownIndex: row.breakdownIndex,
    targetWordCount: row.targetWordCount,
    matchedWordCount: row.matchedWordCount,
    diff,
    audioPath: row.audioPath,
  };
}

export function buildDrillLabRoutes(deps: DrillLabDeps) {
  const sets = deps.sets ?? setStore;
  const transcribe = deps.transcribe ?? hearRecording;

  return new Hono()
    /**
     * The practice queue: every Listen and Repeat sentence the learner has answered (a recorded take
     * that was scored, as the bank requires) and scored at or below WEAK_SCORE_CEILING, worst first.
     * An Item scored 0 for never being reached has no take and stays out: its sentence was never
     * heard. Ordering is by worst score then by length, because the two together are what the drill
     * targets — a long sentence that collapsed outranks a short one.
     */
    .get("/queue", (c) => {
      const byItem = new Map<string, { setId: string; itemId: string; scores: number[] }>();
      for (const row of deps.repo.listenRepeatScores()) {
        const key = `${row.setId}::${row.itemId}`;
        const entry = byItem.get(key) ?? { setId: row.setId, itemId: row.itemId, scores: [] };
        entry.scores.push(row.score);
        byItem.set(key, entry);
      }

      // One row per drilled Item, in one query rather than a listReps call per entry.
      const summaries = new Map(deps.repo.repSummaries().map((r) => [`${r.setId}::${r.itemId}`, r]));
      const located = locatedItemMemo(sets);

      const entries: BuildupQueueEntryVM[] = [];
      for (const entry of byItem.values()) {
        const worstScore = Math.min(...entry.scores);
        if (worstScore > WEAK_SCORE_CEILING) continue;
        const item = located(entry.setId, entry.itemId);
        if (!item) continue; // Set deleted or unreadable: a stale score is not a drill target.
        const summary = summaries.get(`${entry.setId}::${entry.itemId}`);
        entries.push({
          setId: entry.setId,
          itemId: entry.itemId,
          scenarioTitle: item.scenarioTitle,
          wordCount: wordCount(item.sentence),
          worstScore,
          // listenRepeatScores() is newest first (created_at, then rowid), so scores[0] is the
          // most recent.
          latestScore: entry.scores[0]!,
          repCount: summary?.repCount ?? 0,
          latestHeldWords: summary ? heldWordCount(summary) : null,
        });
      }
      entries.sort((a, b) => a.worstScore - b.worstScore || b.wordCount - a.wordCount);
      return c.json(entries);
    })

    /**
     * The whole Listen and Repeat bank, grouped by Set, for picking a sentence the queue does not
     * hold. `preview` and `wordCount` are filled only for an Item the User has answered (a recorded
     * take that was scored), so browsing cannot spoil an unanswered sentence or its length; the item
     * route reveals it. A Set is `attempted` once every one of its Items is answered, so the client
     * asks before opening a sentence that may still be unheard.
     *
     * Per Item, and so narrower than the Set-level "attempted" of the Set listing, which one scored
     * Item or a completed Attempt satisfies. An answered Item does make its Set count as attempted,
     * so any later sitting of a Set whose sentence is shown here is already a Repeat.
     */
    .get("/bank", (c) => {
      const answered = new Set(deps.repo.answeredListenRepeatItems().map((r) => `${r.setId}::${r.itemId}`));
      const banks: BuildupBankSetVM[] = [];
      // A bank scan, because this needs each Set's Listen and Repeat Items. Parse failures are
      // skipped silently: routes/sets.ts reports them.
      for (const banked of sets.scanBank().sets) {
        const set = banked.set;
        if (set.kind !== "speaking") continue;
        const items = set.listenAndRepeat.items.map((item) => {
          const isAnswered = answered.has(`${set.id}::${item.id}`);
          return {
            itemId: item.id,
            wordCount: isAnswered ? wordCount(item.sentence) : null,
            preview: isAnswered ? item.sentence : null,
          };
        });
        banks.push({
          setId: set.id,
          scenarioTitle: set.listenAndRepeat.scenarioTitle,
          attempted: items.length > 0 && items.every((item) => item.preview !== null),
          items,
        });
      }
      banks.sort((a, b) => Number(b.attempted) - Number(a.attempted) || a.setId.localeCompare(b.setId));
      return c.json(banks);
    })

    /** One sentence, revealed, with its chunking, its steps and every rep against it. */
    .get("/items/:setId/:itemId", (c) => {
      const setId = c.req.param("setId");
      const itemId = c.req.param("itemId");
      const located = locateItem(sets, setId, itemId);
      if (!located) return c.json({ error: "unknown item" }, 404);

      const pastScores = deps.repo.scoresForItem(setId, itemId).map((r) => r.score);

      const vm: BuildupItemVM = {
        setId,
        itemId,
        scenarioTitle: located.scenarioTitle,
        sentence: located.sentence,
        audio: located.audio,
        chunks: chunkSentence(located.sentence),
        steps: buildupSteps(located.sentence),
        pastScores,
        reps: deps.repo.listReps(setId, itemId).map(toRepVM),
      };
      return c.json(vm);
    })

    /**
     * Record one blind rep: store the take, transcribe it, align it against the target.
     *
     * Transcription runs inline, not through the durable transcription jobs a Speaking Attempt uses:
     * those exist so a scored Attempt survives a crash, and a practice rep lost to one costs only
     * another press of record.
     *
     * A transcription failure is not a request failure. The take is already stored and the User's
     * own ear is the drill's main feedback, so the rep persists with `transcriptionError` set and the
     * page offers playback without a diff.
     */
    .post("/items/:setId/:itemId/reps", async (c) => {
      const setId = c.req.param("setId");
      const itemId = c.req.param("itemId");
      const located = locateItem(sets, setId, itemId);
      if (!located) return c.json({ error: "unknown item" }, 404);

      const phaseRaw = c.req.query("phase");
      if (phaseRaw !== "baseline" && phaseRaw !== "post") {
        return c.json({ error: "phase must be baseline or post" }, 400);
      }
      const phase: BuildupPhase = phaseRaw;

      let file: unknown;
      try {
        file = (await c.req.parseBody()).file;
      } catch {
        return c.json({ error: "no usable recording" }, 400);
      }
      if (!(file instanceof File) || file.size < MIN_RECORDING_BYTES) {
        return c.json({ error: "no usable recording" }, 400);
      }

      const repId = randomUUID();
      // Stored under the base routes/audio.ts already serves, so playback inherits its traversal and
      // extension guards. `drill-lab` cannot collide with an Attempt id, which is a UUID.
      const relative = path.join("drill-lab", setId, itemId, `${repId}.webm`);
      const absolute = path.join(config.dataDir, "audio", "responses", relative);
      let audioPath: string | null = null;
      try {
        fs.mkdirSync(path.dirname(absolute), { recursive: true });
        fs.writeFileSync(absolute, Buffer.from(await file.arrayBuffer()));
        audioPath = `responses/${relative.split(path.sep).join("/")}`;
      } catch {
        return c.json({ error: "could not store the recording" }, 500);
      }

      let transcript: string | null = null;
      let transcriptionError: string | null = null;
      let diff: BuildupDiffOp[] | null = null;
      try {
        // The framing the Attempt path gives Ears, without the target sentence: a prompt carrying the
        // answer biases the model toward transcribing what the User should have said, erasing the
        // deviations this drill measures.
        const heard = await transcribe({
          audioPath: absolute,
          mimeType: "audio/webm",
          context: `Listen and Repeat practice. Scenario: ${located.scenarioTitle}. The speaker heard a sentence once and is repeating it from memory.`,
        });
        transcript = heard.transcript;
        diff = wordDiff(located.sentence, heard.transcript);
      } catch (error) {
        transcriptionError =
          error instanceof EarsError ? error.safeMessage : "transcription failed";
      }

      const row: BackwardBuildupRepRow = {
        id: repId,
        setId,
        itemId,
        phase,
        transcript,
        transcriptionError,
        breakdownIndex: diff ? breakdownWordIndex(diff) : null,
        targetWordCount: wordCount(located.sentence),
        matchedWordCount: diff ? diff.filter((op) => op.op === "match").length : null,
        diffJson: diff ? JSON.stringify(diff) : null,
        audioPath,
        createdAt: sqliteTimestamp(),
      };
      deps.repo.insertRep(row);
      return c.json(toRepVM(row), 201);
    });
}
