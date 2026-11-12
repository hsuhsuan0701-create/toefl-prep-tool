import { describe, expect, it, vi } from "vitest";
import {
  NOT_CAPTURED_ITEM_ERROR,
  SKIPPED_ITEM_REASON,
  type AttemptDetailVM,
  type AttemptListVM,
  type JudgeReport,
  type ScoreReport,
  type StatsSummaryVM,
} from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { buildStatsRoutes } from "../src/routes/stats.js";
import type { aggregate as realAggregate } from "../src/services/arbiter.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { at } from "./helpers/timestamps.js";

// A Band Estimate needs the whole sitting scored: every Item of the Attempt scored (a deliberate
// skip is a scored 0 and counts) and every Task Type the section requires present. Through the real
// Attempts and Stats routes over one in-memory database, against Sets from the committed bank.

const WRITING_SET_ID = "wri-77af733e";
const SPEAKING_SET_ID = "spk-e5b2b735";

type AggregateInput = Parameters<typeof realAggregate>[0];

function judgeReport(judge: "gemini" | "openai", taskType: "email" | "discussion", itemId: string): JudgeReport {
  return { judge, taskType, items: [{ itemId, score: 4, dimensions: [{ name: "mechanics", score: 4, evidence: "clean" }], deductions: [] }] };
}

function scoreReport(taskType: "email" | "discussion", itemId: string): ScoreReport {
  return {
    taskType,
    items: [{
      itemId, ownScore: 4, finalScore: 4, maxScore: 5, dimensions: [{ name: "mechanics", note: "solid" }],
      deductions: [], reconciliationNote: "judges agreed", feedbackZh: "寫得不錯。",
    }],
  };
}

function harness() {
  const db = openDb(":memory:");
  const repo = sqliteStores(db);
  const judgeEssay = vi.fn(async (judge: "gemini" | "openai", input: { taskType: string }) => {
    const taskType = input.taskType as "email" | "discussion";
    return { report: judgeReport(judge, taskType, taskType === "email" ? "email-1" : "disc-1"), provider: judge === "gemini" ? "gemini-http" as const : "codex" as const };
  });
  const aggregate = vi.fn(async (input: AggregateInput) => ({
    report: scoreReport(input.taskType as "email" | "discussion", input.itemId),
    provider: "claude" as const,
  }));
  const scoreDeps = { repo, judgeEssay, aggregate, judgeSpeaking: vi.fn(), aggregateSpeaking: vi.fn() };
  const coordinators = createSpeakingCoordinators({ ...scoreDeps, hearRecording: vi.fn() });
  const app = buildAttemptsRoutes({ ...scoreDeps, ...coordinators });
  const stats = buildStatsRoutes({ repo });

  async function createAttempt(kind: string, setId: string, mode: "drill" | "simulation") {
    const res = await app.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, mode, setId }) });
    return ((await res.json()) as { attemptId: string }).attemptId;
  }
  function row(attemptId: string, itemId: string, taskType: string, outcome: { score: number | null; status: string; json?: object; text?: string }) {
    repo.insertItemResult({ attemptId, itemId, taskType, responseText: outcome.text ?? "[]" });
    if (outcome.status !== "pending") {
      repo.updateItemScore({ attemptId, itemId, score: outcome.score, scoreJson: JSON.stringify(outcome.json ?? {}), scoringStatus: outcome.status });
    }
  }
  async function detail(attemptId: string) {
    const res = await app.request(`/${attemptId}`);
    expect(res.status).toBe(200);
    return (await res.json()) as AttemptDetailVM;
  }
  async function listBand(attemptId: string) {
    const page = (await (await app.request("/")).json()) as AttemptListVM;
    return page.items.find((item) => item.id === attemptId)!.estimate;
  }
  async function headline(section: string) {
    return ((await (await stats.request("/summary")).json()) as StatsSummaryVM).sections.find((s) => s.section === section);
  }
  return { db, repo, app, createAttempt, row, detail, listBand, headline };
}

const scored = (score: number, json: object = {}) => ({ score, status: "scored", json });
const failed = (error: string) => ({ score: null, status: "failed", json: { error } });
const skipped = scored(0, { skipped: true, reason: SKIPPED_ITEM_REASON });

/** A Speaking Attempt with one silent Listen and Repeat 0, six failed, one Interview answered and three skipped. */
function sitMostlyFailedSpeaking(h: ReturnType<typeof harness>, attemptId: string) {
  h.row(attemptId, "lr-1", "listen_repeat", scored(0, { noSpeechDetected: true }));
  for (let i = 2; i <= 7; i++) h.row(attemptId, `lr-${i}`, "listen_repeat", failed("scoring interrupted"));
  h.row(attemptId, "int-1", "interview", scored(3));
  for (let i = 2; i <= 4; i++) h.row(attemptId, `int-${i}`, "interview", skipped);
}

/** Every Item of a Speaking Set scored. */
function sitWholeSpeaking(h: ReturnType<typeof harness>, attemptId: string, score: number) {
  for (let i = 1; i <= 7; i++) h.row(attemptId, `lr-${i}`, "listen_repeat", scored(score));
  for (let i = 1; i <= 4; i++) h.row(attemptId, `int-${i}`, "interview", scored(score));
}

describe("an Attempt with an Item that is not scored has no band", () => {
  it("a mostly failed Speaking Attempt completes with no band, and says six Listen and Repeat Items failed", async () => {
    const h = harness();
    const attemptId = await h.createAttempt("speaking", SPEAKING_SET_ID, "drill");
    sitMostlyFailedSpeaking(h, attemptId);

    const completed = await h.app.request(`/${attemptId}/complete`, { method: "POST" });
    expect(await completed.json()).toEqual({ status: "completed" });

    const body = await h.detail(attemptId);
    expect(body.estimate).toBeNull();
    expect(body.bandStatus).toEqual({
      status: "incomplete",
      unscored: [{ taskType: "listen_repeat", failed: 6, pending: 0, notCaptured: 0 }],
      absent: [],
    });
    expect(h.repo.getSectionEstimate(attemptId)).toBeUndefined();
  });

  it("counts Items still unscored and recordings that never arrived apart from scoring failures", async () => {
    const h = harness();
    const attemptId = await h.createAttempt("speaking", SPEAKING_SET_ID, "drill");
    for (let i = 1; i <= 6; i++) h.row(attemptId, `lr-${i}`, "listen_repeat", scored(4));
    h.repo.insertItemResult({ attemptId, itemId: "lr-7", taskType: "listen_repeat", scoringStatus: "transcription_pending" });
    for (let i = 1; i <= 2; i++) h.row(attemptId, `int-${i}`, "interview", scored(4));
    h.row(attemptId, "int-3", "interview", failed("arbitration failed"));
    h.row(attemptId, "int-4", "interview", failed(NOT_CAPTURED_ITEM_ERROR));
    expect((await h.app.request(`/${attemptId}/complete`, { method: "POST" })).status).toBe(200);

    expect((await h.detail(attemptId)).bandStatus).toEqual({
      status: "incomplete",
      unscored: [
        { taskType: "listen_repeat", failed: 0, pending: 1, notCaptured: 0 },
        { taskType: "interview", failed: 1, pending: 0, notCaptured: 1 },
      ],
      absent: [],
    });
  });

  it("names a required Task Type with no Item at all", async () => {
    const h = harness();
    const attemptId = await h.createAttempt("writing", WRITING_SET_ID, "drill");
    for (let i = 1; i <= 10; i++) h.row(attemptId, `bas-${i}`, "build_sentence", scored(1));
    expect((await h.app.request(`/${attemptId}/complete`, { method: "POST" })).status).toBe(200);

    expect((await h.detail(attemptId)).bandStatus).toEqual({ status: "incomplete", unscored: [], absent: ["email", "discussion"] });
  });

  it("counts a deliberate skip as a scored 0: every Item scored is a band", async () => {
    const h = harness();
    const attemptId = await h.createAttempt("speaking", SPEAKING_SET_ID, "drill");
    for (let i = 1; i <= 7; i++) h.row(attemptId, `lr-${i}`, "listen_repeat", scored(4));
    h.row(attemptId, "int-1", "interview", scored(4));
    for (let i = 2; i <= 4; i++) h.row(attemptId, `int-${i}`, "interview", skipped);
    expect((await h.app.request(`/${attemptId}/complete`, { method: "POST" })).status).toBe(200);

    const body = await h.detail(attemptId);
    expect(body.bandStatus).toEqual({ status: "estimated" });
    expect(body.estimate?.coverage).toEqual([
      { taskType: "listen_repeat", itemCount: 7, skippedCount: 0 },
      { taskType: "interview", itemCount: 4, skippedCount: 3 },
    ]);
  });
});

describe("a persisted band whose Attempt has an Item that is not scored", () => {
  // A row persisted for the mostly failed shape under a rule that needed only one scored Item per Task
  // Type. Such rows stay in a database; the read side decides from the Attempt's current Items.
  const LEGACY_ROW = {
    section: "speaking",
    rawDetail: JSON.stringify({
      raw: 0.05454545454545454,
      coverage: [{ taskType: "listen_repeat", itemCount: 1, skippedCount: 0 }, { taskType: "interview", itemCount: 4, skippedCount: 3 }],
    }),
    estimatedBand: 1.5,
    method: "linear-v2",
  };

  it("stops surfacing on the review, the Attempt list and the Dashboard, and is not rewritten", async () => {
    const h = harness();
    const earlier = await h.createAttempt("speaking", SPEAKING_SET_ID, "simulation");
    sitWholeSpeaking(h, earlier, 4);
    h.repo.completeAttempt(earlier, at("2026-08-20 10:00:00"));
    h.repo.saveSectionEstimate({ attemptId: earlier, section: "speaking", rawDetail: JSON.stringify({ raw: 0.8, coverage: [{ taskType: "listen_repeat", itemCount: 7 }, { taskType: "interview", itemCount: 4 }] }), estimatedBand: 5, method: "linear-v2" });

    const legacy = await h.createAttempt("speaking", SPEAKING_SET_ID, "simulation");
    h.db.prepare("UPDATE attempts SET is_repeat=0 WHERE id=?").run(legacy);
    sitMostlyFailedSpeaking(h, legacy);
    h.repo.completeAttempt(legacy, at("2026-08-23 16:30:04"));
    h.repo.saveSectionEstimate({ attemptId: legacy, ...LEGACY_ROW });

    const body = await h.detail(legacy);
    expect(body.estimate).toBeNull();
    expect(body.bandStatus).toEqual({
      status: "incomplete",
      unscored: [{ taskType: "listen_repeat", failed: 6, pending: 0, notCaptured: 0 }],
      absent: [],
    });
    expect(await h.listBand(legacy)).toBeNull();
    expect(await h.headline("speaking")).toMatchObject({
      attemptId: earlier,
      band: 5,
      recentSimulationRange: { min: 5, max: 5, count: 1 },
    });

    expect(h.db.prepare("SELECT estimated_band FROM section_estimates WHERE attempt_id=?").get(legacy)).toEqual({ estimated_band: 1.5 });
  });
});

describe("a Writing Simulation completed before its essays are scored", () => {
  it("has no band at completion, and gets one when the last essay job lands", async () => {
    const h = harness();
    const attemptId = await h.createAttempt("writing", WRITING_SET_ID, "simulation");
    for (let i = 1; i <= 10; i++) h.row(attemptId, `bas-${i}`, "build_sentence", scored(1));
    h.row(attemptId, "email-1", "email", { score: null, status: "pending", text: "Dear Ms Lee, thank you for the delivery." });
    h.row(attemptId, "disc-1", "discussion", { score: null, status: "pending", text: "I think students should choose." });

    const completed = await h.app.request(`/${attemptId}/complete`, { method: "POST" });
    expect(await completed.json()).toEqual({ status: "completed" });
    expect((await h.detail(attemptId)).estimate).toBeNull();

    for (const [taskType, itemId, text] of [
      ["email", "email-1", "Dear Ms Lee, thank you for the delivery."],
      ["discussion", "disc-1", "I think students should choose."],
    ] as const) {
      const res = await h.app.request(`/${attemptId}/score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskType, items: [{ itemId, text, secondsUsed: 60 }] }),
      });
      expect(res.status).toBe(202);
      if (taskType === "email") {
        const { jobId } = (await res.json()) as { jobId: string };
        await vi.waitFor(() => expect(h.repo.getScoringJob(jobId)?.status).toBe("done"), { timeout: 2000, interval: 5 });
        // One essay scored, the other still pending: still no band.
        expect((await h.detail(attemptId)).estimate).toBeNull();
      }
    }

    await vi.waitFor(async () => expect((await h.detail(attemptId)).bandStatus).toEqual({ status: "estimated" }), { timeout: 2000, interval: 5 });
    expect((await h.detail(attemptId)).estimate).toMatchObject({ section: "writing", method: "linear-v2" });
  });
});
