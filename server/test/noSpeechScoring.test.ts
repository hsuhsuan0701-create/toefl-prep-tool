import { describe, expect, it, vi } from "vitest";
import { readBankSet } from "./helpers/setFixtures.js";
import type { DeliveryReport, JudgeReport, ScoreReport } from "@toefl-prep/shared";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { openDb } from "../src/db/db.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import { resetTranscriptionCoordinatorsForNewProcess } from "../src/services/transcriptionRecovery.js";
import type { judgeSpeaking as realJudgeSpeaking } from "../src/services/judges/speaking.js";
import type { aggregateSpeaking as realAggregateSpeaking } from "../src/services/arbiter.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { at } from "./helpers/timestamps.js";

// A recording Ears answered with an empty or whitespace-only transcript is a deterministic 0
// marked "no speech detected". It is scored without a Judge, it counts in the Band Estimate like any
// other 0, and it never blocks, fails or is failed by the sibling Items scored beside it.

const SPEAKING_SET_ID = "spk-e5b2b735";
const speakingSet = readBankSet("speaking", SPEAKING_SET_ID);
const [lr1, lr2, lr3] = speakingSet.listenAndRepeat.items;
const int1 = speakingSet.interview.questions[0];

const deliveryReport: DeliveryReport = {
  paceWpm: 120, pauses: "none", intelligibility: "clear", suspectedMispronunciations: [], intonation: "natural",
};

function judgeReport(judge: "gemini" | "openai", itemIds: string[], taskType: "listen_repeat" | "interview"): JudgeReport {
  return {
    judge, taskType,
    items: itemIds.map((itemId) => ({ itemId, score: 4, dimensions: [{ name: "accuracy", score: 4, evidence: "ok" }], deductions: [] })),
  };
}

function scoreReport(itemIds: string[], taskType: "listen_repeat" | "interview"): ScoreReport {
  return {
    taskType,
    items: itemIds.map((itemId) => ({
      itemId, ownScore: 4, finalScore: 4, maxScore: 5 as const,
      dimensions: [{ name: "accuracy", note: "ok" }], deductions: [], reconciliationNote: "agreed", feedbackZh: "很好。",
    })),
  };
}

function setup() {
  resetTranscriptionCoordinatorsForNewProcess();
  const r = sqliteStores(openDb(":memory:"));
  const judgeSpeaking = vi.fn<typeof realJudgeSpeaking>(async (judge, input) => ({
    report: judgeReport(judge, input.items.map((i) => i.itemId), input.taskType),
    mode: "audio" as const,
    provider: judge === "gemini" ? ("gemini-http" as const) : ("openai-http" as const),
  }));
  const aggregateSpeaking = vi.fn<typeof realAggregateSpeaking>(async (input) => ({
    report: scoreReport(input.items.map((i) => i.itemId), input.taskType),
    provider: "claude" as const,
  }));
  const coordinators = createSpeakingCoordinators({ repo: r, judgeSpeaking, aggregateSpeaking });
  const app = buildAttemptsRoutes({ repo: r, judgeSpeaking, aggregateSpeaking, ...coordinators });
  return { r, app, judgeSpeaking, aggregateSpeaking, coordinators };
}

function seedSpokenItem(
  r: ReturnType<typeof sqliteStores>,
  attemptId: string,
  itemId: string,
  taskType: "listen_repeat" | "interview",
  transcript: string,
): void {
  r.insertItemResult({
    attemptId, itemId, taskType,
    responseAudioPath: `audio/responses/${attemptId}/${itemId}.webm`,
    transcript, deliveryReport: JSON.stringify(deliveryReport),
  });
}

async function scoreAndWait(app: ReturnType<typeof setup>["app"], attemptId: string, body: unknown) {
  const res = await app.request(`/${attemptId}/score`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  expect(res.status).toBe(202);
  const { jobId } = (await res.json()) as { jobId: string };
  let job!: { status: string; result?: { report: ScoreReport; items: Array<{ itemId: string }> } };
  await vi.waitFor(async () => {
    job = (await (await app.request(`/${attemptId}/score-jobs/${jobId}`)).json()) as typeof job;
    expect(["done", "failed"]).toContain(job.status);
  });
  return job;
}

function itemRow(r: ReturnType<typeof sqliteStores>, attemptId: string, itemId: string) {
  return r.getAttempt(attemptId)!.items.find((i) => i.item_id === itemId)!;
}

describe("a recording with no speech", () => {
  it("scores a deterministic no-speech 0 beside its judged siblings, and only the siblings reach the Judges", async () => {
    const { r, app, judgeSpeaking, aggregateSpeaking } = setup();
    r.createAttempt({ id: "att-silent", kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    seedSpokenItem(r, "att-silent", lr1.id, "listen_repeat", "the words the user said");
    seedSpokenItem(r, "att-silent", lr2.id, "listen_repeat", "");
    seedSpokenItem(r, "att-silent", lr3.id, "listen_repeat", "  \n ");
    // A Judge Report left over from an earlier take of this Item must not sit beside its 0.
    r.insertJudgeReport({ attemptId: "att-silent", itemId: lr2.id, judge: "gemini", reportJson: "{}" });

    const job = await scoreAndWait(app, "att-silent", {
      taskType: "listen_repeat", items: [{ itemId: lr1.id }, { itemId: lr2.id }, { itemId: lr3.id }],
    });

    expect(job.status).toBe("done");
    for (const call of judgeSpeaking.mock.calls) expect(call[1].items.map((i) => i.itemId)).toEqual([lr1.id]);
    expect(aggregateSpeaking.mock.calls[0][0].items.map((i) => i.itemId)).toEqual([lr1.id]);

    expect(itemRow(r, "att-silent", lr1.id)).toMatchObject({ scoring_status: "scored", score: 4 });
    for (const item of [lr2, lr3]) {
      const row = itemRow(r, "att-silent", item.id);
      expect(row.scoring_status).toBe("scored");
      expect(row.score).toBe(0);
      const scoreJson = JSON.parse(row.score_json!);
      expect(scoreJson).toMatchObject({
        itemId: item.id, noSpeechDetected: true, ownScore: 0, finalScore: 0, maxScore: 5,
        dimensions: [], deductions: [], meta: { target: item.sentence },
      });
      expect(scoreJson.feedbackZh).toMatch(/語音/);
    }
    expect(r.getJudgeReports("att-silent").filter((j) => j.item_id === lr2.id)).toEqual([]);

    // The job's own result carries the 0s too, so a Drill renders them like any other scored Item.
    expect(job.result!.report.items.map((i) => [i.itemId, i.finalScore])).toEqual([
      [lr1.id, 4], [lr2.id, 0], [lr3.id, 0],
    ]);
    expect(job.result!.items.map((i) => i.itemId)).toEqual([lr1.id, lr2.id, lr3.id]);

    // And the Attempt detail the review page renders from carries it as an ordinary scored Item.
    const detail = (await (await app.request("/att-silent")).json()) as {
      items: Array<{ itemId: string; scoringStatus: string; score: number | null; scoreJson: Record<string, unknown> }>;
    };
    const reviewed = detail.items.find((i) => i.itemId === lr2.id)!;
    expect(reviewed).toMatchObject({ scoringStatus: "scored", score: 0 });
    expect(reviewed.scoreJson).toMatchObject({
      finalScore: 0, maxScore: 5, dimensions: [], deductions: [], noSpeechDetected: true, meta: { target: lr2.sentence },
    });
    expect(typeof reviewed.scoreJson.feedbackZh).toBe("string");
  });

  it("scores a request made only of silent Items without calling a Judge or the Arbiter", async () => {
    const { r, app, judgeSpeaking, aggregateSpeaking } = setup();
    r.createAttempt({ id: "att-all-silent", kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    seedSpokenItem(r, "att-all-silent", int1.id, "interview", "");

    const job = await scoreAndWait(app, "att-all-silent", { taskType: "interview", items: [{ itemId: int1.id }] });

    expect(job.status).toBe("done");
    expect(judgeSpeaking).not.toHaveBeenCalled();
    expect(aggregateSpeaking).not.toHaveBeenCalled();
    const row = itemRow(r, "att-all-silent", int1.id);
    expect(row).toMatchObject({ scoring_status: "scored", score: 0 });
    expect(JSON.parse(row.score_json!)).toMatchObject({ noSpeechDetected: true, meta: { question: int1.question } });
  });

  it("keeps the silent 0 when both Judges fail for its siblings", async () => {
    const { r, app, judgeSpeaking } = setup();
    judgeSpeaking.mockRejectedValue(new Error("provider down"));
    r.createAttempt({ id: "att-judges-down", kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID, isRepeat: false });
    seedSpokenItem(r, "att-judges-down", lr1.id, "listen_repeat", "the words the user said");
    seedSpokenItem(r, "att-judges-down", lr2.id, "listen_repeat", "");

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const job = await scoreAndWait(app, "att-judges-down", {
      taskType: "listen_repeat", items: [{ itemId: lr1.id }, { itemId: lr2.id }],
    });
    errorSpy.mockRestore();

    expect(job.status).toBe("failed");
    expect(itemRow(r, "att-judges-down", lr1.id).scoring_status).toBe("failed");
    expect(itemRow(r, "att-judges-down", lr2.id)).toMatchObject({ scoring_status: "scored", score: 0 });
  });

  it("re-scores an Item a silent sibling once failed, through the ordinary scoring request", async () => {
    const { r, app } = setup();
    r.createAttempt({ id: "att-silent-failed", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedSpokenItem(r, "att-silent-failed", lr2.id, "listen_repeat", "");
    r.updateItemScore({
      attemptId: "att-silent-failed", itemId: lr2.id, score: null,
      scoreJson: JSON.stringify({ error: "scoring request did not arrive" }), scoringStatus: "failed",
    });

    const job = await scoreAndWait(app, "att-silent-failed", { taskType: "listen_repeat", items: [{ itemId: lr2.id }] });

    expect(job.status).toBe("done");
    expect(itemRow(r, "att-silent-failed", lr2.id)).toMatchObject({ scoring_status: "scored", score: 0 });
  });

  it("is what a Simulation's orphan heal scores a silent Item, while a judgeable orphan still becomes rescorable", async () => {
    const { r, coordinators } = setup();
    r.createAttempt({ id: "att-orphans", kind: "speaking", mode: "simulation", setId: SPEAKING_SET_ID, isRepeat: false });
    seedSpokenItem(r, "att-orphans", lr1.id, "listen_repeat", "the words the user said");
    seedSpokenItem(r, "att-orphans", lr2.id, "listen_repeat", " ");
    // An Interview Item already scored, so the section's other Task Type is covered and a band could
    // exist.
    seedSpokenItem(r, "att-orphans", int1.id, "interview", "an answer the user gave");
    r.updateItemScore({
      attemptId: "att-orphans", itemId: int1.id, score: 4,
      scoreJson: JSON.stringify(scoreReport([int1.id], "interview").items[0]), scoringStatus: "scored",
    });
    // Capture finished long ago, and no scoring request ever covered either Listen and Repeat Item.
    r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId: "att-orphans", now: at("2026-07-30 09:00:00"), placeholders: [] });

    await coordinators.speakingFinalization.reconcileAttempt("att-orphans");

    expect(r.getAttempt("att-orphans")!.status).toBe("completed");
    expect(itemRow(r, "att-orphans", lr1.id).scoring_status).toBe("failed");
    const silent = itemRow(r, "att-orphans", lr2.id);
    expect(silent).toMatchObject({ scoring_status: "scored", score: 0 });
    expect(JSON.parse(silent.score_json!)).toMatchObject({ noSpeechDetected: true, meta: { target: lr2.sentence } });
    // The judgeable orphan is now a failed Item waiting on a Re-score, so the Attempt has no band
    // until it is scored (a band needs every Item scored).
    expect(r.getSectionEstimate("att-orphans")).toBeUndefined();
  });
});
