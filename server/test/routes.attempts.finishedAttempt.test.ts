import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "../src/lib/config.js";
import { openDb } from "../src/db/db.js";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { resetJobAdmissionsForTests } from "../src/services/jobCancellation.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// An Attempt that is over — completed or aborted — takes no new Responses and no new scores. Every
// refusal is a 409 without the `alreadyScored` marker, which the client reads as "the server already
// has this" and treats as success. Three requests the app relies on stay open: a re-score of a
// completed Attempt's Item from Attempt review, a transcription retry (not guarded here at all), and
// a repeated completion.

const WRITING_SET_ID = "wri-77af733e";
const SPEAKING_SET_ID = "spk-e5b2b735";
const READING_SET_ID = "rd-04b2ae46";

function harness() {
  resetJobAdmissionsForTests();
  const db = openDb(":memory:");
  const repo = sqliteStores(db);
  const judgeEssay = vi.fn(() => new Promise<never>(() => {}));
  const judgeSpeaking = vi.fn(() => new Promise<never>(() => {}));
  const scoreDeps = { repo, judgeEssay, aggregate: vi.fn(), judgeSpeaking, aggregateSpeaking: vi.fn() };
  const coordinators = createSpeakingCoordinators({ ...scoreDeps, hearRecording: vi.fn() });
  const app = buildAttemptsRoutes({ ...scoreDeps, ...coordinators } as never);
  return { db, repo, app };
}
type Harness = ReturnType<typeof harness>;

async function createAttempt(h: Harness, kind: "writing" | "speaking" | "reading", setId: string, mode: "drill" | "simulation") {
  const res = await h.app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, mode, setId }),
  });
  return ((await res.json()) as { attemptId: string }).attemptId;
}

const postJson = (h: Harness, url: string, body: unknown) =>
  h.app.request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

function uploadAudio(h: Harness, attemptId: string, itemId: string) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(4096)], "take.webm", { type: "audio/webm" }));
  return h.app.request(`/${attemptId}/items/${itemId}/audio`, { method: "POST", body: form });
}

async function expectPlainConflict(res: Response, status: string) {
  expect(res.status).toBe(409);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body).toEqual({ error: `attempt is ${status}` });
}

const itemCount = (h: Harness, attemptId: string) =>
  (h.db.prepare("SELECT COUNT(*) AS n FROM item_results WHERE attempt_id=?").get(attemptId) as { n: number }).n;
const jobCount = (h: Harness, attemptId: string) =>
  (h.db.prepare("SELECT COUNT(*) AS n FROM scoring_jobs WHERE attempt_id=?").get(attemptId) as { n: number }).n;

function seedEssay(h: Harness, attemptId: string, text: string, status: "scored" | "failed") {
  h.repo.insertItemResult({ attemptId, itemId: "email-1", taskType: "email", responseText: text });
  h.repo.updateItemScore({ attemptId, itemId: "email-1", score: status === "scored" ? 4 : null, scoreJson: "{}", scoringStatus: status });
}

function seedTranscript(h: Harness, attemptId: string, itemId: string) {
  h.repo.insertItemResult({ attemptId, itemId, taskType: "listen_repeat", responseAudioPath: `responses/${attemptId}/${itemId}.webm`, transcript: "words were heard" });
  h.repo.updateItemScore({ attemptId, itemId, score: null, scoreJson: JSON.stringify({ error: "arbitration failed" }), scoringStatus: "failed" });
}

describe("a recording uploaded to an Attempt that is over", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it.each(["aborted", "completed"] as const)("is refused when the Attempt is %s, and nothing is stored", async (status) => {
    const attemptId = await createAttempt(h, "speaking", SPEAKING_SET_ID, "drill");
    if (status === "aborted") h.repo.abortAttempt(attemptId);
    else h.repo.completeAttempt(attemptId);

    await expectPlainConflict(await uploadAudio(h, attemptId, "lr-1"), status);
    expect(itemCount(h, attemptId)).toBe(0);
    expect(fs.existsSync(path.join(config.dataDir, "audio/responses", attemptId))).toBe(false);
  });
});

describe("capture-finished on a Speaking Simulation that is over", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("is refused on an aborted Simulation, writing no capture marker and no placeholder", async () => {
    const attemptId = await createAttempt(h, "speaking", SPEAKING_SET_ID, "simulation");
    h.repo.abortAttempt(attemptId);

    await expectPlainConflict(await postJson(h, `/${attemptId}/capture-finished`, {}), "aborted");
    expect(h.repo.getAttempt(attemptId)).toMatchObject({ status: "aborted", capture_finished_at: null });
    expect(itemCount(h, attemptId)).toBe(0);
  });

  it("answers a repeat on a completed Simulation with its completion, and writes nothing", async () => {
    const attemptId = await createAttempt(h, "speaking", SPEAKING_SET_ID, "simulation");
    h.repo.completeAttempt(attemptId);

    const res = await postJson(h, `/${attemptId}/capture-finished`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "completed" });
    expect(h.repo.getAttempt(attemptId)?.capture_finished_at).toBeNull();
    expect(itemCount(h, attemptId)).toBe(0);
  });
});

describe("a score request on an Attempt that is over", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it("is refused on an aborted Attempt, even as a re-score of a failed Item", async () => {
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID, "drill");
    seedEssay(h, attemptId, "My essay.", "failed");
    h.repo.abortAttempt(attemptId);

    await expectPlainConflict(
      await postJson(h, `/${attemptId}/score`, { taskType: "email", items: [{ itemId: "email-1", text: "My essay.", secondsUsed: 0 }] }),
      "aborted",
    );
    expect(jobCount(h, attemptId)).toBe(0);
  });

  it.each(["aborted", "completed"] as const)("refuses Build a Sentence on a %s Attempt and writes no score", async (status) => {
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID, "drill");
    if (status === "aborted") h.repo.abortAttempt(attemptId);
    else h.repo.completeAttempt(attemptId);

    await expectPlainConflict(
      await postJson(h, `/${attemptId}/score`, { taskType: "build_sentence", items: [{ itemId: "bas-1", tileOrder: ["can", "leave them", "by", "the"] }] }),
      status,
    );
    expect(itemCount(h, attemptId)).toBe(0);
  });

  it("refuses new Reading answers on a completed Attempt", async () => {
    const attemptId = await createAttempt(h, "reading", READING_SET_ID, "drill");
    h.repo.completeAttempt(attemptId);

    await expectPlainConflict(
      await postJson(h, `/${attemptId}/score`, { taskType: "daily_life", items: [{ itemId: "dl-r1-q1", selectedOptionId: "a" }] }),
      "completed",
    );
    expect(itemCount(h, attemptId)).toBe(0);
  });

  it("accepts a re-score of a completed Attempt's essay as it was written", async () => {
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID, "drill");
    seedEssay(h, attemptId, "My essay.", "failed");
    h.repo.completeAttempt(attemptId);

    const res = await postJson(h, `/${attemptId}/score`, { taskType: "email", items: [{ itemId: "email-1", text: "My essay.", secondsUsed: 0 }] });
    expect(res.status).toBe(202);
    expect(jobCount(h, attemptId)).toBe(1);
  });

  it("refuses a completed Attempt's essay with different text, or one that was never written", async () => {
    const attemptId = await createAttempt(h, "writing", WRITING_SET_ID, "drill");
    seedEssay(h, attemptId, "My essay.", "scored");
    h.repo.completeAttempt(attemptId);

    await expectPlainConflict(
      await postJson(h, `/${attemptId}/score`, { taskType: "email", items: [{ itemId: "email-1", text: "A new essay.", secondsUsed: 0 }] }),
      "completed",
    );
    await expectPlainConflict(
      await postJson(h, `/${attemptId}/score`, { taskType: "discussion", items: [{ itemId: "disc-1", text: "Never sent.", secondsUsed: 0 }] }),
      "completed",
    );
    expect(h.repo.getAttempt(attemptId)?.items.map((i) => [i.item_id, i.response_text])).toEqual([["email-1", "My essay."]]);
    expect(jobCount(h, attemptId)).toBe(0);
  });

  it("accepts a re-score of a completed Attempt's recorded Items", async () => {
    const attemptId = await createAttempt(h, "speaking", SPEAKING_SET_ID, "drill");
    seedTranscript(h, attemptId, "lr-1");
    seedTranscript(h, attemptId, "lr-2");
    h.repo.completeAttempt(attemptId);

    const res = await postJson(h, `/${attemptId}/score`, { taskType: "listen_repeat", items: [{ itemId: "lr-1" }, { itemId: "lr-2" }] });
    expect(res.status).toBe(202);
    expect(jobCount(h, attemptId)).toBe(1);
  });
});
