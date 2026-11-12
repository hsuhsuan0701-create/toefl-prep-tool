import fs from "node:fs";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttemptDetailVM } from "@toefl-prep/shared";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { openDb } from "../src/db/db.js";
import { config } from "../src/lib/config.js";
import { resetJobAdmissionsForTests } from "../src/services/jobCancellation.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import { placeholderSpeakingSet } from "./helpers/setFixtures.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// GET /:id sends each spoken Item's prompt as text (the Listen and Repeat sentence, the Item's own
// Interview question) with a completed Speaking Attempt only, scored or not, re-read from the Set on
// disk; never while the Attempt can still be answered, nor once it is discarded (docs/adr/0017).

const SET_ID = "spk-prompts55";
const GONE_SET_ID = "spk-prompts55gone";
const SET = placeholderSpeakingSet(SET_ID);
const SENTENCE_1 = SET.listenAndRepeat.items[0]!.sentence;
const QUESTION_2 = SET.interview.questions[1]!.question;

function setPath(id: string) {
  return path.join(config.dataDir, "question-sets/speaking", `${id}.json`);
}

beforeAll(() => {
  fs.mkdirSync(path.dirname(setPath(SET_ID)), { recursive: true });
  fs.writeFileSync(setPath(SET_ID), JSON.stringify(SET));
  fs.writeFileSync(setPath(GONE_SET_ID), JSON.stringify(placeholderSpeakingSet(GONE_SET_ID)));
});

function harness() {
  resetJobAdmissionsForTests();
  const db = openDb(":memory:");
  const repo = sqliteStores(db);
  const scoreDeps = { repo, judgeEssay: vi.fn(), aggregate: vi.fn(), judgeSpeaking: vi.fn(), aggregateSpeaking: vi.fn() };
  const coordinators = createSpeakingCoordinators({ ...scoreDeps, hearRecording: vi.fn() });
  const app = buildAttemptsRoutes({ ...scoreDeps, ...coordinators });
  return { db, repo, app };
}
type Harness = ReturnType<typeof harness>;

async function createAttempt(h: Harness, setId: string, mode: "drill" | "simulation") {
  const res = await h.app.request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "speaking", mode, setId }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { attemptId: string }).attemptId;
}

async function detail(h: Harness, attemptId: string): Promise<AttemptDetailVM> {
  const res = await h.app.request(`/${attemptId}`);
  expect(res.status).toBe(200);
  return (await res.json()) as AttemptDetailVM;
}

// A recording whose transcription failed (no transcript, no Score Report), and one that was scored
// with its target in the Score Report's meta, as the scorer writes it.
function seedItems(h: Harness, attemptId: string) {
  h.repo.insertItemResult({ attemptId, itemId: "q-2", taskType: "interview", responseAudioPath: `responses/${attemptId}/q-2.webm` });
  h.repo.updateItemScore({ attemptId, itemId: "q-2", score: null, scoreJson: JSON.stringify({ error: "transcription failed" }), scoringStatus: "failed" });
  h.repo.insertItemResult({ attemptId, itemId: "lr-1", taskType: "listen_repeat", responseAudioPath: `responses/${attemptId}/lr-1.webm` });
  h.repo.updateItemScore({ attemptId, itemId: "lr-1", score: null, scoreJson: JSON.stringify({ error: "transcription failed" }), scoringStatus: "failed" });
}

async function complete(h: Harness, attemptId: string) {
  const res = await h.app.request(`/${attemptId}/complete`, { method: "POST" });
  expect(res.status).toBe(200);
  expect((await detail(h, attemptId)).attempt.status).toBe("completed");
}

function expectNoPromptText(body: AttemptDetailVM) {
  expect(body).not.toHaveProperty("spokenPrompts");
  const raw = JSON.stringify(body);
  expect(raw).not.toContain(SENTENCE_1);
  expect(raw).not.toContain(QUESTION_2);
}

describe("GET /:id — spokenPrompts", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it.each(["drill", "simulation"] as const)("is absent while a Speaking %s is in progress, and carries every Item's text once it is completed", async (mode) => {
    const attemptId = await createAttempt(h, SET_ID, mode);
    seedItems(h, attemptId);
    expectNoPromptText(await detail(h, attemptId));

    await complete(h, attemptId);
    const body = await detail(h, attemptId);
    const byId = new Map((body.spokenPrompts ?? []).map((p) => [p.itemId, p]));
    expect(byId.get("lr-1")).toEqual({ itemId: "lr-1", taskType: "listen_repeat", text: SENTENCE_1 });
    expect(byId.get("q-2")).toEqual({ itemId: "q-2", taskType: "interview", text: QUESTION_2 });
    // The Interview Item carries its own question, never the Interview's introduction.
    expect(JSON.stringify(body.spokenPrompts)).not.toContain(SET.interview.intro);
    // One entry per Item of the Attempt, and only for Items the Attempt holds.
    for (const prompt of body.spokenPrompts!) expect(body.items.map((i) => i.itemId)).toContain(prompt.itemId);
  });

  it.each(["drill", "simulation"] as const)("is absent for a discarded Speaking %s", async (mode) => {
    const attemptId = await createAttempt(h, SET_ID, mode);
    seedItems(h, attemptId);
    expect((await h.app.request(`/${attemptId}/abort`, { method: "POST" })).status).toBe(200);
    const body = await detail(h, attemptId);
    expect(body.attempt.status).toBe("aborted");
    expectNoPromptText(body);
  });

  it("is absent, and the readback still succeeds, when the Set can no longer be read", async () => {
    const attemptId = await createAttempt(h, GONE_SET_ID, "drill");
    seedItems(h, attemptId);
    await complete(h, attemptId);
    expect((await detail(h, attemptId)).spokenPrompts).toBeDefined();

    fs.writeFileSync(setPath(GONE_SET_ID), "{ not json");
    const body = await detail(h, attemptId);
    expect(body.attempt.status).toBe("completed");
    expect(body.items.map((i) => i.itemId).sort()).toEqual(["lr-1", "q-2"]);
    expect(body).not.toHaveProperty("spokenPrompts");
  });

  it("is absent for a completed Attempt of another section", async () => {
    const res = await h.app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "writing", mode: "drill", setId: "wri-77af733e" }),
    });
    const { attemptId } = (await res.json()) as { attemptId: string };
    expect((await h.app.request(`/${attemptId}/complete`, { method: "POST" })).status).toBe(200);
    expect(await detail(h, attemptId)).not.toHaveProperty("spokenPrompts");
  });
});
