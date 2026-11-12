import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptDetailVM } from "@toefl-prep/shared";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { openDb } from "../src/db/db.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { attemptBandStatus } from "../src/routes/attemptBandStatus.js";

// GET /:id says where the Attempt's Band Estimate stands and, when there is none, why — through the
// real route over an in-memory database, against Sets from the committed bank.

const WRITING_SET_ID = "wri-77af733e";
const READING_SET_ID = "rd-04b2ae46";
const SPEAKING_SET_ID = "spk-e5b2b735";

function harness() {
  const db = openDb(":memory:");
  const repo = sqliteStores(db);
  const scoreDeps = { repo, judgeEssay: vi.fn(), aggregate: vi.fn(), judgeSpeaking: vi.fn(), aggregateSpeaking: vi.fn() };
  const coordinators = createSpeakingCoordinators({ ...scoreDeps, hearRecording: vi.fn() });
  const app = buildAttemptsRoutes({ ...scoreDeps, ...coordinators });
  return { db, repo, app };
}
type Harness = ReturnType<typeof harness>;

async function createAttempt(h: Harness, kind: string, setId: string, mode: "drill" | "simulation") {
  const res = await h.app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, mode, setId }),
  });
  return ((await res.json()) as { attemptId: string }).attemptId;
}

async function detail(h: Harness, attemptId: string): Promise<AttemptDetailVM> {
  const res = await h.app.request(`/${attemptId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as AttemptDetailVM;
}

function score(h: Harness, attemptId: string, itemId: string, taskType: string, scoring: { score: number | null; status: string; json?: object }) {
  h.repo.insertItemResult({ attemptId, itemId, taskType, responseText: "[]" });
  h.repo.updateItemScore({ attemptId, itemId, score: scoring.score, scoreJson: JSON.stringify(scoring.json ?? {}), scoringStatus: scoring.status });
}

const scored = (score: number) => ({ score, status: "scored" });
const failed = { score: null, status: "failed", json: { error: "Scoring failed." } };

describe("GET /:id bandStatus", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("is estimated exactly when the Attempt has a persisted band", async () => {
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID, "simulation");
    score(h, attemptId, "bas-1", "build_sentence", scored(1));
    score(h, attemptId, "email-1", "email", scored(4));
    score(h, attemptId, "disc-1", "discussion", scored(4));
    expect((await h.app.request(`/${attemptId}/complete`, { method: "POST" })).status).toBe(200);

    const body = await detail(h, attemptId);
    expect(body.bandStatus).toEqual({ status: "estimated" });
    expect(body.estimate).not.toBeNull();
  });

  it("counts each Task Type's unscored Items and names the Task Types with no Item at all", async () => {
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID, "simulation");
    score(h, attemptId, "bas-1", "build_sentence", scored(1));
    score(h, attemptId, "email-1", "email", failed);
    expect((await h.app.request(`/${attemptId}/complete`, { method: "POST" })).status).toBe(200);

    const body = await detail(h, attemptId);
    expect(body.estimate).toBeNull();
    expect(body.bandStatus).toEqual({
      status: "incomplete",
      unscored: [{ taskType: "email", failed: 1, pending: 0, notCaptured: 0 }],
      absent: ["discussion"],
    });
  });

  it("names every Task Type for a completed Attempt that recorded nothing", async () => {
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID, "simulation");
    expect((await h.app.request(`/${attemptId}/complete`, { method: "POST" })).status).toBe(200);

    const body = await detail(h, attemptId);
    expect(body.bandStatus).toEqual({ status: "incomplete", unscored: [], absent: ["build_sentence", "email", "discussion"] });
  });

  it("says scoring is still running while a job is live, counting the Items it is scoring", async () => {
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID, "simulation");
    score(h, attemptId, "bas-1", "build_sentence", scored(1));
    score(h, attemptId, "email-1", "email", failed);
    h.repo.insertItemResult({ attemptId, itemId: "disc-1", taskType: "discussion", responseText: "An answer." });
    expect((await h.app.request(`/${attemptId}/complete`, { method: "POST" })).status).toBe(200);
    h.repo.replaceScoringJobAndSupersede({ id: "job-1", attemptId, taskType: "email", itemIds: ["email-1"], now: "2026-01-01 00:00:00" });

    const body = await detail(h, attemptId);
    expect(body.bandStatus).toEqual({
      status: "scoring",
      outstanding: [
        { taskType: "email", itemCount: 1 },
        { taskType: "discussion", itemCount: 1 },
      ],
    });
  });

  it("does not promise scoring for an Item left pending with nothing live behind it", async () => {
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID, "simulation");
    score(h, attemptId, "bas-1", "build_sentence", scored(1));
    score(h, attemptId, "email-1", "email", scored(4));
    h.repo.insertItemResult({ attemptId, itemId: "disc-1", taskType: "discussion", responseText: "An answer." });
    expect((await h.app.request(`/${attemptId}/complete`, { method: "POST" })).status).toBe(200);

    expect((await detail(h, attemptId)).bandStatus).toEqual({
      status: "incomplete",
      unscored: [{ taskType: "discussion", failed: 0, pending: 1, notCaptured: 0 }],
      absent: [],
    });
  });

  it("is unfinished for an Attempt that was started and never submitted", async () => {
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID, "drill");
    score(h, attemptId, "bas-1", "build_sentence", scored(1));
    expect((await detail(h, attemptId)).bandStatus).toEqual({ status: "unfinished" });
  });

  it("is scoring while a captured Speaking Simulation is still being finalized", async () => {
    const attemptId = await createAttempt(h, "speaking", SPEAKING_SET_ID, "simulation");
    h.db.prepare("UPDATE attempts SET capture_finished_at='2026-01-01 00:00:00' WHERE id=?").run(attemptId);
    expect((await detail(h, attemptId)).bandStatus).toEqual({ status: "scoring", outstanding: [] });
  });

  it("is discarded for an aborted Attempt", async () => {
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID, "simulation");
    expect((await h.app.request(`/${attemptId}/abort`, { method: "POST" })).status).toBe(200);
    expect((await detail(h, attemptId)).bandStatus).toEqual({ status: "discarded" });
  });

  it("is not applicable to a Reading Drill, nor to a Reading Simulation that never routed", async () => {
    const drillId = await createAttempt(h, "reading", READING_SET_ID, "drill");
    score(h, drillId, "ctw-r1-g1", "complete_words", { score: 1, status: "scored", json: { correct: true, module: "router", answer: "x" } });
    expect((await h.app.request(`/${drillId}/complete`, { method: "POST" })).status).toBe(200);
    expect((await detail(h, drillId)).bandStatus).toEqual({ status: "not-applicable", reason: "drill" });

    const simulationId = await createAttempt(h, "reading", READING_SET_ID, "simulation");
    expect((await h.app.request(`/${simulationId}/complete`, { method: "POST" })).status).toBe(200);
    expect((await detail(h, simulationId)).bandStatus).toEqual({ status: "not-applicable", reason: "not-routed" });
  });
});

describe("attemptBandStatus", () => {
  it("counts a live transcription job as scoring still to come", () => {
    const status = attemptBandStatus({
      attempt: {
        status: "completed",
        mode: "simulation",
        capture_finished_at: "2026-01-01 00:00:00",
        items: [{ item_id: "lr-1", task_type: "listen_repeat", scoring_status: "transcription_pending" }],
      },
      estimate: null,
      computed: { status: "incomplete", section: "speaking", shortfall: { unscored: [{ taskType: "listen_repeat", failed: 0, pending: 1, notCaptured: 0 }], absent: ["interview"] } },
      activeJobs: [],
      transcriptionStatuses: ["retry_wait"],
    });
    expect(status).toEqual({ status: "scoring", outstanding: [{ taskType: "listen_repeat", itemCount: 1 }] });
  });
});
