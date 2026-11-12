import { beforeEach, describe, expect, it, vi } from "vitest";
import { SKIPPED_ITEM_REASON, type BuildupBankSetVM, type BuildupItemVM, type BuildupQueueEntryVM, type BuildupRepVM, type SpeakingSet } from "@toefl-prep/shared";
import { buildDrillLabRoutes, type DrillLabSetSource } from "../src/routes/drillLab.js";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// The Drill Lab is the one route that serves Listen and Repeat target sentences in cleartext, and
// the one that writes practice state. Both of those are deliberate exceptions to rules the rest of
// the codebase depends on, so this suite pins the boundaries of each: what the bank browser will and
// will not reveal, and that a rep never lands anywhere scoring can read.

function speakingSet(id: string, sentences: string[]): SpeakingSet {
  return {
    id,
    kind: "speaking",
    source: "generated",
    createdAt: "2026-08-01T00:00:00.000Z",
    listenAndRepeat: {
      scenarioTitle: `Scenario ${id}`,
      scenarioDescription: "A description.",
      introAudio: `stimuli/${id}/briefing.mp3`,
      items: sentences.map((sentence, i) => ({
        id: `lr-${i + 1}`,
        sentence,
        audio: `stimuli/${id}/lr-${i + 1}.mp3`,
        responseWindowSec: 10,
      })),
    },
    interview: { scenarioTitle: "Interview", scenarioDescription: "", introAudio: "", questions: [] },
  } as unknown as SpeakingSet;
}

const SENTENCES = [
  "The visitor whose badge you print today will remember how you treat them.",
  "The badge, the sign-in sheet, and the posted directory all matter daily.",
];

type FakeTranscribe = (input: { context?: string }) => Promise<{ transcript: string; deliveryReport: unknown }>;

function buildTestApp(opts: { transcribe?: FakeTranscribe } = {}) {
  const db = openDb(":memory:");
  const repo = sqliteStores(db);
  const sets: Record<string, SpeakingSet> = {
    "spk-seen": speakingSet("spk-seen", SENTENCES),
    "spk-unseen": speakingSet("spk-unseen", SENTENCES),
  };
  const setSource: DrillLabSetSource = {
    readSet: (id: string) => sets[id],
    scanBank: () => ({
      files: [],
      sets: Object.values(sets).map((set) => ({ kind: "speaking" as const, file: `${set.id}.json`, set })),
      failures: [],
    }),
  };
  const app = buildDrillLabRoutes({
    repo,
    sets: setSource,
    transcribe: (opts.transcribe ?? (async () => ({ transcript: "", deliveryReport: {} }))) as never,
  });
  return { app, repo, db };
}

function scoreLrItem(
  ctx: ReturnType<typeof buildTestApp>,
  attemptId: string,
  setId: string,
  itemId: string,
  score: number,
) {
  ctx.repo.createAttempt({ id: attemptId, kind: "speaking", mode: "drill", setId, isRepeat: false });
  ctx.repo.insertItemResult({ attemptId, itemId, taskType: "listen_repeat", responseAudioPath: `responses/${attemptId}/${itemId}.webm` });
  ctx.repo.updateItemScore({ attemptId, itemId, score, scoreJson: "{}", scoringStatus: "scored" });
}

async function postRep(ctx: ReturnType<typeof buildTestApp>, setId: string, itemId: string, phase: string) {
  const body = new FormData();
  body.append("file", new File([new Uint8Array(2048)], "rep.webm", { type: "audio/webm" }));
  return ctx.app.request(`/items/${setId}/${itemId}/reps?phase=${phase}`, { method: "POST", body });
}

describe("GET /queue", () => {
  let ctx: ReturnType<typeof buildTestApp>;
  beforeEach(() => {
    ctx = buildTestApp();
  });

  it("holds items at or below the 2.5 ceiling and excludes the ones above it", async () => {
    // 2.5 is the rubric's own 3/2 boundary: below it the response stopped being a full sentence,
    // which is what backward buildup trains. A 3 lost its marks to paraphrase — a different problem.
    scoreLrItem(ctx, "a1", "spk-seen", "lr-1", 2);
    scoreLrItem(ctx, "a2", "spk-seen", "lr-2", 3);
    const queue = (await (await ctx.app.request("/queue")).json()) as BuildupQueueEntryVM[];
    expect(queue.map((e) => e.itemId)).toEqual(["lr-1"]);
    expect(queue[0]!.worstScore).toBe(2);
  });

  it("keeps an item that EVER collapsed, even after a later good score", async () => {
    // Recovering once on a sentence is not evidence the buffer grew; the drill keeps offering it
    // until the User takes it out of the queue.
    scoreLrItem(ctx, "a1", "spk-seen", "lr-1", 1);
    scoreLrItem(ctx, "a2", "spk-seen", "lr-1", 4);
    const queue = (await (await ctx.app.request("/queue")).json()) as BuildupQueueEntryVM[];
    expect(queue).toHaveLength(1);
    expect(queue[0]!.worstScore).toBe(1);
    expect(queue[0]!.latestScore).toBe(4);
  });

  it("orders worst score first, then longer sentence first", async () => {
    scoreLrItem(ctx, "a1", "spk-seen", "lr-2", 2); // 12 words
    scoreLrItem(ctx, "a2", "spk-seen", "lr-1", 2); // 13 words
    scoreLrItem(ctx, "a3", "spk-unseen", "lr-1", 1);
    const queue = (await (await ctx.app.request("/queue")).json()) as BuildupQueueEntryVM[];
    expect(queue.map((e) => `${e.setId}/${e.itemId}`)).toEqual([
      "spk-unseen/lr-1",
      "spk-seen/lr-1",
      "spk-seen/lr-2",
    ]);
  });

  it("distinguishes a clean rep from an item that has never been practised", async () => {
    // Both carry a null breakdown index, so read raw the drill's best outcome would look like an
    // untouched sentence. `latestHeldWords` tells them apart.
    scoreLrItem(ctx, "a1", "spk-seen", "lr-1", 2);
    scoreLrItem(ctx, "a2", "spk-seen", "lr-2", 2);
    ctx.repo.insertRep({
      id: "rep-clean", setId: "spk-seen", itemId: "lr-1", phase: "post", transcript: SENTENCES[0]!,
      transcriptionError: null, breakdownIndex: null, targetWordCount: 13, matchedWordCount: 13,
      diffJson: "[]", audioPath: null, createdAt: "2026-08-23 12:00:00",
    });
    const queue = (await (await ctx.app.request("/queue")).json()) as BuildupQueueEntryVM[];
    const drilled = queue.find((e) => e.itemId === "lr-1")!;
    const untouched = queue.find((e) => e.itemId === "lr-2")!;
    expect(drilled.latestHeldWords).toBe(13); // held the whole sentence
    expect(drilled.repCount).toBe(1);
    expect(untouched.latestHeldWords).toBeNull();
    expect(untouched.repCount).toBe(0);
  });

  it("reports no held words when the item's only rep was never measured", async () => {
    // A failed transcription must not read as a perfect rep, or a provider outage would show as the
    // best result the drill can give.
    scoreLrItem(ctx, "a1", "spk-seen", "lr-1", 2);
    ctx.repo.insertRep({
      id: "rep-failed", setId: "spk-seen", itemId: "lr-1", phase: "baseline", transcript: null,
      transcriptionError: "provider down", breakdownIndex: null, targetWordCount: 13,
      matchedWordCount: null, diffJson: null, audioPath: "responses/x.webm",
      createdAt: "2026-08-23 12:00:00",
    });
    const queue = (await (await ctx.app.request("/queue")).json()) as BuildupQueueEntryVM[];
    expect(queue[0]!.repCount).toBe(1);
    expect(queue[0]!.latestHeldWords).toBeNull();
  });

  it("prefers the newest MEASURED rep over a newer failed one", async () => {
    scoreLrItem(ctx, "a1", "spk-seen", "lr-1", 2);
    ctx.repo.insertRep({
      id: "rep-ok", setId: "spk-seen", itemId: "lr-1", phase: "baseline", transcript: "some words",
      transcriptionError: null, breakdownIndex: 7, targetWordCount: 13, matchedWordCount: 7,
      diffJson: "[]", audioPath: null, createdAt: "2026-08-23 12:00:00",
    });
    ctx.repo.insertRep({
      id: "rep-later-failed", setId: "spk-seen", itemId: "lr-1", phase: "post", transcript: null,
      transcriptionError: "provider down", breakdownIndex: null, targetWordCount: 13,
      matchedWordCount: null, diffJson: null, audioPath: null, createdAt: "2026-08-23 13:00:00",
    });
    const queue = (await (await ctx.app.request("/queue")).json()) as BuildupQueueEntryVM[];
    expect(queue[0]!.latestHeldWords).toBe(7);
    expect(queue[0]!.repCount).toBe(2);
  });

  it("reads each Set at most once however many of its items are queued", async () => {
    // readSet re-parses the file on every call by design, and a queue routinely holds several weak
    // items from one Set.
    scoreLrItem(ctx, "a1", "spk-seen", "lr-1", 1);
    scoreLrItem(ctx, "a2", "spk-seen", "lr-2", 1);
    const reads: string[] = [];
    const counting = buildTestApp();
    counting.repo.createAttempt({ id: "b1", kind: "speaking", mode: "drill", setId: "spk-seen", isRepeat: false });
    counting.repo.insertItemResult({ attemptId: "b1", itemId: "lr-1", taskType: "listen_repeat", responseAudioPath: "responses/b1/lr-1.webm" });
    counting.repo.updateItemScore({ attemptId: "b1", itemId: "lr-1", score: 1, scoreJson: "{}", scoringStatus: "scored" });
    counting.repo.insertItemResult({ attemptId: "b1", itemId: "lr-2", taskType: "listen_repeat", responseAudioPath: "responses/b1/lr-2.webm" });
    counting.repo.updateItemScore({ attemptId: "b1", itemId: "lr-2", score: 1, scoreJson: "{}", scoringStatus: "scored" });
    const app = buildDrillLabRoutes({
      repo: counting.repo,
      sets: {
        readSet: (id: string) => {
          reads.push(id);
          return speakingSet("spk-seen", SENTENCES);
        },
        scanBank: () => ({ files: [], sets: [], failures: [] }),
      },
      transcribe: (async () => ({ transcript: "", deliveryReport: {} })) as never,
    });
    const queue = (await (await app.request("/queue")).json()) as BuildupQueueEntryVM[];
    expect(queue).toHaveLength(2);
    expect(reads).toEqual(["spk-seen"]);
  });

  it("leaves out an Item scored 0 for never being reached: it has no take, so its sentence was never heard", async () => {
    // A Speaking Simulation finished early writes these placeholders (a skip scored 0, no
    // recording) through the capture-finished seam. Worst first, one would head the queue, and one
    // click would show a sentence the User has never heard.
    ctx.repo.createAttempt({ id: "sim", kind: "speaking", mode: "simulation", setId: "spk-unseen", isRepeat: false });
    ctx.repo.markCaptureFinishedWithMissingItemPlaceholders({
      attemptId: "sim",
      placeholders: [{ itemId: "lr-1", taskType: "listen_repeat", scoreJson: JSON.stringify({ skipped: true, reason: SKIPPED_ITEM_REASON }), score: 0, scoringStatus: "scored" }],
    });
    scoreLrItem(ctx, "a1", "spk-seen", "lr-2", 2);

    const queue = (await (await ctx.app.request("/queue")).json()) as BuildupQueueEntryVM[];
    expect(queue.map((e) => `${e.setId}/${e.itemId}`)).toEqual(["spk-seen/lr-2"]);
    // The Item's own page agrees: the placeholder is no past score of a sentence the User answered.
    const item = (await (await ctx.app.request("/items/spk-unseen/lr-1")).json()) as BuildupItemVM;
    expect(item.pastScores).toEqual([]);
    // And so does the bank browser, which already required a take.
    const bank = (await (await ctx.app.request("/bank")).json()) as BuildupBankSetVM[];
    expect(bank.find((s) => s.setId === "spk-unseen")!.items[0]!.preview).toBeNull();
  });

  it("skips a score whose Set no longer reads, rather than 500ing the page", async () => {
    scoreLrItem(ctx, "a1", "spk-deleted", "lr-1", 1);
    const res = await ctx.app.request("/queue");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});

describe("GET /bank", () => {
  it("reveals sentences only for Sets already sat, and flags the rest as unattempted", async () => {
    // Browsing must not be able to spoil a Set by accident: opening an item is the deliberate act
    // that reveals one, and the client needs `attempted` to be able to warn before that happens.
    const ctx = buildTestApp();
    scoreLrItem(ctx, "a1", "spk-seen", "lr-1", 4);
    scoreLrItem(ctx, "a2", "spk-seen", "lr-2", 4);
    const bank = (await (await ctx.app.request("/bank")).json()) as BuildupBankSetVM[];
    const seen = bank.find((s) => s.setId === "spk-seen")!;
    const unseen = bank.find((s) => s.setId === "spk-unseen")!;
    expect(seen.attempted).toBe(true);
    expect(seen.items[0]!.preview).toBe(SENTENCES[0]);
    expect(unseen.attempted).toBe(false);
    expect(unseen.items[0]!.preview).toBeNull();
    // A word count is itself a hint about an unheard sentence, so it is gated with the preview.
    expect(seen.items[0]!.wordCount).toBe(13);
    expect(unseen.items[0]!.wordCount).toBeNull();
  });
});

describe("GET /items/:setId/:itemId", () => {
  it("reveals the sentence with its chunking and steps", async () => {
    const ctx = buildTestApp();
    scoreLrItem(ctx, "a1", "spk-seen", "lr-1", 2);
    const item = (await (await ctx.app.request("/items/spk-seen/lr-1")).json()) as BuildupItemVM;
    expect(item.sentence).toBe(SENTENCES[0]);
    expect(item.pastScores).toEqual([2]);
    expect(item.steps.at(-1)!.text).toBe(SENTENCES[0]);
    expect(item.steps[0]!.text).toBe(item.chunks.at(-1));
  });

  it("404s for an unknown item", async () => {
    const ctx = buildTestApp();
    expect((await ctx.app.request("/items/spk-seen/lr-99")).status).toBe(404);
    expect((await ctx.app.request("/items/nope/lr-1")).status).toBe(404);
  });
});

describe("POST /items/:setId/:itemId/reps", () => {
  it("transcribes, aligns and reports where recall first broke", async () => {
    const ctx = buildTestApp({
      transcribe: async () => ({
        transcript: "The badge, the signing sheet, and the uh are all signed daily.",
        deliveryReport: {},
      }),
    });
    const res = await postRep(ctx, "spk-seen", "lr-2", "baseline");
    expect(res.status).toBe(201);
    const rep = (await res.json()) as BuildupRepVM;
    expect(rep.phase).toBe("baseline");
    expect(rep.breakdownIndex).toBe(3);
    expect(rep.targetWordCount).toBe(12);
    expect(rep.diff).not.toBeNull();
    expect(rep.transcriptionError).toBeNull();
    expect(rep.audioPath).toMatch(/^responses\/drill-lab\/spk-seen\/lr-2\/.*\.webm$/);
  });

  it("never sends the target sentence to the transcriber", async () => {
    // A prompt carrying the answer biases the model toward transcribing what should have been said,
    // which would erase the very deviations this drill measures. Same rule as the Attempt path.
    const transcribe = vi.fn(async (_input: { context?: string }) => ({
      transcript: "anything",
      deliveryReport: {},
    }));
    const ctx = buildTestApp({ transcribe });
    await postRep(ctx, "spk-seen", "lr-1", "baseline");
    const context = transcribe.mock.calls[0]![0].context!;
    expect(context).not.toContain("badge");
    expect(context).not.toContain(SENTENCES[0]);
  });

  it("still stores the rep when transcription fails", async () => {
    // The recording is the User's own primary feedback; losing it because a provider blipped
    // would be worse than losing the diff.
    const ctx = buildTestApp({
      transcribe: async () => {
        throw new Error("provider down");
      },
    });
    const res = await postRep(ctx, "spk-seen", "lr-1", "post");
    expect(res.status).toBe(201);
    const rep = (await res.json()) as BuildupRepVM;
    expect(rep.transcript).toBeNull();
    expect(rep.transcriptionError).toBe("transcription failed");
    expect(rep.audioPath).not.toBeNull();
  });

  it("rejects an unusable take and an unknown phase without writing anything", async () => {
    const ctx = buildTestApp();
    const tiny = new FormData();
    tiny.append("file", new File([new Uint8Array(8)], "rep.webm", { type: "audio/webm" }));
    expect((await ctx.app.request("/items/spk-seen/lr-1/reps?phase=baseline", { method: "POST", body: tiny })).status)
      .toBe(400);
    expect((await postRep(ctx, "spk-seen", "lr-1", "midway")).status).toBe(400);
    expect(ctx.repo.listReps("spk-seen", "lr-1")).toEqual([]);
  });

  it("writes NOTHING that scoring can read", async () => {
    // The load-bearing separation: a rep is practice on a sentence the User has already read, so
    // letting it reach item_results would feed a read-the-answer-first exercise into the Band
    // Estimates this drill exists to improve.
    const ctx = buildTestApp({ transcribe: async () => ({ transcript: "whatever", deliveryReport: {} }) });
    await postRep(ctx, "spk-seen", "lr-1", "baseline");
    const itemResults = ctx.db.prepare("SELECT COUNT(*) AS n FROM item_results").get() as { n: number };
    const attempts = ctx.db.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number };
    const reps = ctx.db.prepare("SELECT COUNT(*) AS n FROM backward_buildup_reps").get() as { n: number };
    expect(itemResults.n).toBe(0);
    expect(attempts.n).toBe(0);
    expect(reps.n).toBe(1);
  });
});
