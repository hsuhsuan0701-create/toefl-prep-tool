import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DeliveryReport, ReadingModule } from "@toefl-prep/shared";
import * as api from "../../client/src/lib/api.js";
import { buildScoreRequests } from "../../client/src/pages/readingSimulation.js";
import { config } from "../src/lib/config.js";
import { openDb } from "../src/db/db.js";
import { createSqliteStores, speakingCoordinatorStore } from "../src/db/stores/index.js";
import { app, mountDatabaseRoutes } from "../src/index.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import { fakeMedia } from "./helpers/fakeMedia.js";
import { readBankSet } from "./helpers/setFixtures.js";

// The client's own API module, driven against the composed app: index.ts's `app` with its request
// guard and every route, the database routes mounted by the same mountDatabaseRoutes the server
// boots with, over the real SQLite stores. Global fetch is the app's own request handler for this
// file, so each call crosses the wire format both sides actually use (paths, methods, JSON and
// multipart bodies, the upload's field name), which no route-level test can see. Ears and ffmpeg
// are the suite's in-process stand-ins; nothing reaches the network.

const SPEAKING_SET_ID = "spk-e5b2b735";
const READING_SET_ID = "rd-04b2ae46";
const TINY_WEBM = fs.readFileSync(path.join(import.meta.dirname, "fixtures/tiny.webm"));

const deliveryReport: DeliveryReport = {
  paceWpm: 120,
  pauses: "no notable pauses",
  intelligibility: "clear throughout",
  suspectedMispronunciations: [],
  intonation: "natural",
};
const hearRecording = vi.fn(async () => ({ transcript: "the library opens at nine", deliveryReport }));

const createdAttempts: string[] = [];

beforeAll(() => {
  const stores = createSqliteStores(openDb(":memory:"));
  const coordinators = createSpeakingCoordinators({
    repo: speakingCoordinatorStore(stores),
    hearRecording,
    probeDurationSec: fakeMedia.probeDurationSec,
  });
  mountDatabaseRoutes(app, stores, coordinators, fakeMedia);
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => app.request(input, init));
});

afterAll(() => {
  vi.unstubAllGlobals();
  for (const attemptId of createdAttempts) {
    fs.rmSync(path.join(config.dataDir, "audio/responses", attemptId), { recursive: true, force: true });
  }
});

// The key the Set on disk holds for every Item of one Module: what a User who answered everything
// right would have typed or chosen.
function correctAnswers(module: ReadingModule): Map<string, string> {
  const answers = new Map<string, string>();
  for (const passage of module.ctwPassages) for (const gap of passage.gaps) answers.set(gap.id, gap.completion);
  for (const text of module.dailyLife) for (const q of text.questions) answers.set(q.id, q.correctOptionId);
  for (const passage of module.academic) for (const q of passage.questions) answers.set(q.id, q.correctOptionId);
  return answers;
}

describe("the client API against the composed app", () => {
  it("uploads a Speaking recording under the field name the route reads, and reads its transcript back", async () => {
    const set = readBankSet("speaking", SPEAKING_SET_ID);
    const itemId = set.listenAndRepeat.items[0]!.id;

    const { attemptId, isRepeat } = await api.createAttempt({ kind: "speaking", mode: "drill", setId: SPEAKING_SET_ID });
    createdAttempts.push(attemptId);
    expect(isRepeat).toBe(false);

    const upload = await api.uploadItemAudio(attemptId, itemId, new Blob([TINY_WEBM], { type: "audio/webm" }));

    expect(upload).toEqual({ ok: true, data: { transcript: "the library opens at nine", deliveryReport, durationSec: 0.208 } });
    expect(hearRecording).toHaveBeenCalledTimes(1);
    const detail = await api.getAttempt(attemptId);
    expect(detail.items).toEqual([
      expect.objectContaining({ itemId, taskType: "listen_repeat", transcript: "the library opens at nine", scoringStatus: "pending" }),
    ]);
  });

  it("sits a Reading Simulation end to end: the Router Module, the route, the second Module, completion and the review", async () => {
    const onDisk = readBankSet("reading", READING_SET_ID);
    const served = await api.getSet(READING_SET_ID);
    if (served.kind !== "reading") throw new Error(`expected a Reading Set, got ${served.kind}`);

    const { attemptId } = await api.createAttempt({ kind: "reading", mode: "simulation", setId: READING_SET_ID });
    createdAttempts.push(attemptId);

    // The requests the Reading Simulation itself builds from the served Set.
    for (const request of buildScoreRequests(served, "router", correctAnswers(onDisk.router))) {
      const scored = await api.scoreDeterministicTask(attemptId, request);
      // A Simulation's answer carries bare correctness, never a key.
      expect(scored.items.every((item) => item.correct && item.key === undefined)).toBe(true);
    }
    const { path: modulePath } = await api.routeAttempt(attemptId);
    expect(modulePath).toBe("upper");

    const secondModule = modulePath === "upper" ? onDisk.upperModule : onDisk.lowerModule;
    for (const request of buildScoreRequests(served, modulePath, correctAnswers(secondModule))) {
      await api.scoreDeterministicTask(attemptId, request);
    }

    expect(await api.completeAttempt(attemptId)).toMatchObject({ status: "completed", estimate: { section: "reading", method: "table3-v1" } });

    const review = await api.getAttempt(attemptId);
    expect(review.attempt.status).toBe("completed");
    expect(review.estimate).toMatchObject({ section: "reading", method: "table3-v1" });
    expect(review.bandStatus.status).toBe("estimated");
    const itemCount = correctAnswers(onDisk.router).size + correctAnswers(secondModule).size;
    expect(review.items).toHaveLength(itemCount);
    // Keys reach the client only now, with the Attempt complete.
    expect(review.deterministicReview).toHaveLength(itemCount);
    expect(review.deterministicReview!.every((item) => item.correct)).toBe(true);
  });

  it("answers the client's own error shapes: an unknown Attempt is an HttpError carrying its status", async () => {
    const error = await api.getAttempt("no-such-attempt").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(api.HttpError);
    expect((error as api.HttpError).status).toBe(404);
  });
});
