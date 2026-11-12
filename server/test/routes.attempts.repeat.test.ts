import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { ReadingSet } from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import { config } from "../src/lib/config.js";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { buildFullTestRoutes } from "../src/routes/fullTests.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// The Repeat tag an Attempt gets at creation, through the real Attempts and Full-Test routes over an
// in-memory database. A Set counts as previously attempted only through an Attempt that has a scored
// Item, or is completed and holds at least one Item. A Full-Test section restarted after a reload is
// the same sitting, so it carries its predecessor's tag.

const WRITING_SET_ID = "wri-77af733e";
// A Reading Set this file writes into its copy of the bank under its own id. Only Reading is ever sat
// here, so the Run's other three Sets never have to exist on disk.
const READING_SET_ID = "rd-a5repeat";
const BANK = [
  { id: READING_SET_ID, kind: "reading" },
  { id: "lsn-a5repeat", kind: "listening" },
  { id: "wri-a5repeat", kind: "writing" },
  { id: "spk-a5repeat", kind: "speaking" },
];
const readingSetFile = path.join(config.dataDir, "question-sets", "reading", `${READING_SET_ID}.json`);

beforeAll(() => {
  const emptyModule = { ctwPassages: [], dailyLife: [], academic: [] };
  const set: ReadingSet = {
    id: READING_SET_ID,
    kind: "reading",
    source: "generated",
    createdAt: "2026-11-11T00:00:00.000Z",
    router: { timeLimitSec: 1200, ...emptyModule },
    lowerModule: { timeLimitSec: 540, ...emptyModule },
    upperModule: { timeLimitSec: 540, ...emptyModule },
  };
  fs.mkdirSync(path.dirname(readingSetFile), { recursive: true });
  fs.writeFileSync(readingSetFile, JSON.stringify(set));
});
afterAll(() => {
  fs.rmSync(readingSetFile, { force: true });
});

function harness() {
  const repo = sqliteStores(openDb(":memory:"));
  const app = new Hono()
    .route("/full-tests", buildFullTestRoutes({ repo, listSetBank: () => BANK }))
    .route("/attempts", buildAttemptsRoutes({
      repo,
      transcriptionRecovery: { readAttemptSnapshot: () => new Map() },
      speakingFinalization: {},
      onScoringTerminal: async () => undefined,
    } as never));
  return { repo, app };
}
type Harness = ReturnType<typeof harness>;

async function startAttempt(h: Harness, body: Record<string, unknown>) {
  const res = await h.app.request("/attempts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { attemptId: string; isRepeat: boolean };
}

const writingDrill = (h: Harness) => startAttempt(h, { kind: "writing", mode: "drill", setId: WRITING_SET_ID });

function scoreOneItem(h: Harness, attemptId: string, status: "scored" | "failed" = "scored") {
  h.repo.insertItemResult({ attemptId, itemId: "item-1", taskType: "build_sentence", responseText: "[]" });
  h.repo.updateItemScore({ attemptId, itemId: "item-1", score: status === "scored" ? 1 : null, scoreJson: "{}", scoringStatus: status });
}

async function startRun(h: Harness): Promise<string> {
  const res = await h.app.request("/full-tests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const sitReadingSection = (h: Harness, runId: string) =>
  startAttempt(h, { kind: "reading", mode: "simulation", setId: READING_SET_ID, fullTestRunId: runId });

describe("Repeat tagging", () => {
  it("does not count an in-progress Attempt with nothing scored", async () => {
    const h = harness();
    await writingDrill(h);
    expect((await writingDrill(h)).isRepeat).toBe(false);
  });

  it("does not count an in-progress Attempt whose only Item failed to score", async () => {
    const h = harness();
    scoreOneItem(h, (await writingDrill(h)).attemptId, "failed");
    expect((await writingDrill(h)).isRepeat).toBe(false);
  });

  it("does not count an aborted Attempt with nothing scored", async () => {
    const h = harness();
    const { attemptId } = await writingDrill(h);
    expect((await h.app.request(`/attempts/${attemptId}/abort`, { method: "POST" })).status).toBe(200);
    expect((await writingDrill(h)).isRepeat).toBe(false);
  });

  it("counts a completed Attempt holding an Item, even one with nothing scored", async () => {
    const h = harness();
    const { attemptId } = await writingDrill(h);
    scoreOneItem(h, attemptId, "failed");
    expect((await h.app.request(`/attempts/${attemptId}/complete`, { method: "POST" })).status).toBe(200);
    expect((await writingDrill(h)).isRepeat).toBe(true);
  });

  it("does not count a completed Attempt with no Item: nothing of the Set was answered", async () => {
    const h = harness();
    const { attemptId } = await writingDrill(h);
    expect((await h.app.request(`/attempts/${attemptId}/complete`, { method: "POST" })).status).toBe(200);
    expect((await writingDrill(h)).isRepeat).toBe(false);
  });

  it("counts an Attempt with a scored Item, whether in progress or aborted", async () => {
    const inProgress = harness();
    scoreOneItem(inProgress, (await writingDrill(inProgress)).attemptId);
    expect((await writingDrill(inProgress)).isRepeat).toBe(true);

    const aborted = harness();
    const { attemptId } = await writingDrill(aborted);
    scoreOneItem(aborted, attemptId);
    expect((await aborted.app.request(`/attempts/${attemptId}/abort`, { method: "POST" })).status).toBe(200);
    expect((await writingDrill(aborted)).isRepeat).toBe(true);
  });
});

describe("Repeat tagging of a restarted Full-Test section", () => {
  it("never makes the restarted section a Repeat of the sitting it replaces, across repeated reloads", async () => {
    const h = harness();
    const runId = await startRun(h);

    const first = await sitReadingSection(h, runId);
    expect(first.isRepeat).toBe(false);
    scoreOneItem(h, first.attemptId);

    const second = await sitReadingSection(h, runId);
    expect(second.isRepeat).toBe(false);
    scoreOneItem(h, second.attemptId);

    // The first sitting is no longer linked to the Run but still holds a scored Item.
    const third = await sitReadingSection(h, runId);
    expect(third.isRepeat).toBe(false);
  });

  it("keeps the sitting a Repeat when its Set had been attempted before the Run", async () => {
    const h = harness();
    const earlier = await startAttempt(h, { kind: "reading", mode: "drill", setId: READING_SET_ID });
    h.repo.insertItemResult({ attemptId: earlier.attemptId, itemId: "r-1", taskType: "complete_words" });
    expect((await h.app.request(`/attempts/${earlier.attemptId}/complete`, { method: "POST" })).status).toBe(200);
    const runId = await startRun(h);

    const first = await sitReadingSection(h, runId);
    expect(first.isRepeat).toBe(true);
    const restarted = await sitReadingSection(h, runId);
    expect(restarted.isRepeat).toBe(true);
  });
});
