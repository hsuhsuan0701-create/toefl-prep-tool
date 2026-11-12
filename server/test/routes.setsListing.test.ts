import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { framelessWritingSet } from "./helpers/setFixtures.js";
import type { SetListEntryVM, UnloadableSetsVM } from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import { buildSetsRoutes } from "../src/routes/sets.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// GET /api/sets answers which Sets there are, what they are called and which have been practised.
// "Attempted" is decided on the server because the Attempt log the client sees is paged: worked out
// from one page, an older attempted Set would read as new and the Simulation picker could choose it.
// What counts is an Attempt that has a scored Item, or is completed and holds at least one Item.

function writingSet(id: string, subject: string) {
  return framelessWritingSet(id, { subject, courseTitle: "Urban Studies 210" });
}

let dataDir: string;

function writeSet(kind: string, id: string, body: unknown) {
  const dir = path.join(dataDir, "question-sets", kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.json`), typeof body === "string" ? body : JSON.stringify(body));
}

function harness() {
  const r = sqliteStores(openDb(":memory:"));
  const app = buildSetsRoutes({
    attemptedSetIds: () => new Set(r.listSetIdsCountedAsAttempted()),
    supersededSetIds: () => new Set(),
    dataDir,
  });
  return { r, app };
}

async function listing(app: ReturnType<typeof buildSetsRoutes>, query = ""): Promise<SetListEntryVM[]> {
  const res = await app.request(`/${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as SetListEntryVM[];
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "sets-listing-"));
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("GET /api/sets — attempted", () => {
  it("is true only for a Set with an Attempt that has a scored Item, or is completed holding an Item", async () => {
    for (const id of ["wri-done", "wri-empty", "wri-scored", "wri-opened", "wri-aborted", "wri-fresh"]) writeSet("writing", id, writingSet(id, `Subject ${id}`));
    const { r, app } = harness();

    // Completed with an essay still unscored: the User answered, so this is a sitting.
    r.createAttempt({ id: "a-done", kind: "writing", mode: "drill", setId: "wri-done", isRepeat: false });
    r.insertItemResult({ attemptId: "a-done", itemId: "em1", taskType: "email", responseText: "draft" });
    r.completeAttempt("a-done");

    // Completed with no Item at all: nothing of the Set was answered.
    r.createAttempt({ id: "a-empty", kind: "writing", mode: "simulation", setId: "wri-empty", isRepeat: false });
    r.completeAttempt("a-empty");

    r.createAttempt({ id: "a-scored", kind: "writing", mode: "simulation", setId: "wri-scored", isRepeat: false });
    r.insertItemResult({ attemptId: "a-scored", itemId: "bs1", taskType: "build_sentence", responseText: "[]" });
    r.updateItemScore({ attemptId: "a-scored", itemId: "bs1", score: 1, scoreJson: "{}", scoringStatus: "scored" });

    r.createAttempt({ id: "a-opened", kind: "writing", mode: "drill", setId: "wri-opened", isRepeat: false });
    r.insertItemResult({ attemptId: "a-opened", itemId: "em1", taskType: "email", responseText: "draft" });

    r.createAttempt({ id: "a-aborted", kind: "writing", mode: "drill", setId: "wri-aborted", isRepeat: false });
    r.insertItemResult({ attemptId: "a-aborted", itemId: "em1", taskType: "email", responseText: "draft" });
    r.updateItemScore({ attemptId: "a-aborted", itemId: "em1", score: null, scoreJson: "{}", scoringStatus: "failed" });
    r.abortAttempt("a-aborted");

    const byId = Object.fromEntries((await listing(app, "?kind=writing")).map((s) => [s.id, s.attempted]));
    expect(byId).toEqual({
      "wri-done": true,
      "wri-empty": false,
      "wri-scored": true,
      "wri-opened": false,
      "wri-aborted": false,
      "wri-fresh": false,
    });
  });

  it("still counts a Set whose only Attempt is older than any page of the Attempt log", async () => {
    writeSet("writing", "wri-old", writingSet("wri-old", "Old one"));
    const { r, app } = harness();
    r.createAttempt({ id: "a-old", kind: "writing", mode: "drill", setId: "wri-old", isRepeat: false });
    r.insertItemResult({ attemptId: "a-old", itemId: "em1", taskType: "email", responseText: "draft" });
    r.completeAttempt("a-old");
    for (let i = 0; i < 60; i++) {
      r.createAttempt({ id: `filler-${i}`, kind: "writing", mode: "drill", setId: `wri-filler-${i}`, isRepeat: false });
      r.completeAttempt(`filler-${i}`);
    }
    const [entry] = await listing(app, "?kind=writing");
    expect(entry).toMatchObject({ id: "wri-old", attempted: true });
  });
});

describe("GET /api/sets — title and summary", () => {
  it("carries a title and summary derived from the Set, with the id beside them", async () => {
    writeSet("writing", "wri-titled", writingSet("wri-titled", "Order #4127 - damaged panel and missing brackets"));
    const { app } = harness();
    const [entry] = await listing(app);
    expect(entry).toEqual({
      id: "wri-titled",
      kind: "writing",
      source: "generated",
      createdAt: "2026-07-27T00:00:00Z",
      title: "Order #4127 - damaged panel and missing brackets",
      summary: "Academic Discussion · Urban Studies 210",
      attempted: false,
    });
  });

  it("keeps an unparseable Set out of the listing and in the unloadable notice", async () => {
    writeSet("writing", "wri-good", writingSet("wri-good", "Fine"));
    writeSet("writing", "wri-broken", { ...writingSet("wri-broken", "Broken"), email: undefined });
    const { app } = harness();

    expect((await listing(app)).map((s) => s.id)).toEqual(["wri-good"]);
    const unloadable = (await (await app.request("/unloadable")).json()) as UnloadableSetsVM;
    expect(unloadable.count).toBe(1);
    expect(unloadable.failures[0]).toMatchObject({ kind: "writing", file: "wri-broken.json" });
  });
});
