import { describe, expect, it } from "vitest";
import type { FullTestRunVM, FullTestSection } from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import { buildFullTestRoutes } from "../src/routes/fullTests.js";
import { requiredTaskTypes } from "../src/services/bandEstimator.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { wholeSittingItems } from "./helpers/wholeSitting.js";

// A Full-Test section's band status. A finished section whose Attempt still has scoring outstanding
// is pending: no band, even one persisted earlier, and a plain account of what is outstanding. A
// section whose scoring has settled with an Item unscored, or a Task Type with no Item, says so
// instead of showing a band built from part of the section. The Overall band exists only when all
// four sections are final with a band.
//
// The Run and its Attempts are built through the stores rather than through the section
// Simulations, so no Set has to exist on disk; only GET /full-tests/:id is under test.

const SETS: Record<FullTestSection, string> = {
  reading: "rd-bs",
  listening: "lsn-bs",
  writing: "wri-bs",
  speaking: "spk-bs",
};

function harness() {
  const db = openDb(":memory:");
  const r = sqliteStores(db);
  const app = buildFullTestRoutes({
    repo: r,
    listSetBank: () => Object.entries(SETS).map(([kind, id]) => ({ id, kind })),
  });
  const runId = "run-1";
  r.createFullTestRun({ id: runId, currentSection: "reading", setIds: SETS });

  /** Creates and links the section's Attempt, and returns its id. */
  function section(name: FullTestSection) {
    const attemptId = `att-${name}`;
    r.createAttempt({ id: attemptId, kind: name, mode: "simulation", setId: SETS[name], isRepeat: false });
    r.linkFullTestAttempt(runId, name, attemptId);
    if (name === "reading" || name === "listening") r.setAttemptRouting(attemptId, "upper", 0.8);
    return attemptId;
  }
  function item(attemptId: string, itemId: string, taskType: string, outcome: "scored" | "pending" | "failed" | "transcription_pending", score = 1, scoreJson = "{}") {
    r.insertItemResult({ attemptId, itemId, taskType, scoringStatus: outcome === "transcription_pending" ? "transcription_pending" : "pending" });
    if (outcome === "scored") r.updateItemScore({ attemptId, itemId, score, scoreJson, scoringStatus: "scored" });
    if (outcome === "failed") r.updateItemScore({ attemptId, itemId, score: null, scoreJson: JSON.stringify({ error: "judges failed" }), scoringStatus: "failed" });
  }
  function band(attemptId: string, name: FullTestSection, value: number) {
    r.saveSectionEstimate({
      attemptId,
      section: name,
      rawDetail: JSON.stringify({ raw: 0.6, coverage: requiredTaskTypes(name, null).map((taskType) => ({ taskType, itemCount: 1, skippedCount: 0 })) }),
      estimatedBand: value,
      method: name === "reading" || name === "listening" ? "table3-v1" : "linear-v2",
    });
  }
  /** A section finished with a band: every Task Type scored and the band persisted. */
  function finishedWithBand(name: FullTestSection, value: number) {
    const attemptId = section(name);
    for (const sat of wholeSittingItems(name, "upper")) item(attemptId, sat.itemId, sat.taskType, "scored", 1, sat.scoreJson);
    r.completeAttempt(attemptId);
    band(attemptId, name, value);
    return attemptId;
  }
  async function read() {
    return (await (await app.request(`/${runId}`)).json()) as FullTestRunVM;
  }
  const sectionOf = (run: FullTestRunVM, name: FullTestSection) => run.sections.find((s) => s.section === name)!;
  return { db, r, runId, section, item, band, finishedWithBand, read, sectionOf };
}

describe("a Writing section completed before its essays are scored", () => {
  function sitWritingEarly(h: ReturnType<typeof harness>) {
    h.finishedWithBand("reading", 6);
    h.finishedWithBand("listening", 6);
    const writing = h.section("writing");
    for (let i = 1; i <= 10; i++) h.item(writing, `bs-${i}`, "build_sentence", "scored");
    h.item(writing, "email-1", "email", "pending");
    h.item(writing, "disc-1", "discussion", "pending");
    h.r.completeAttempt(writing);
    return writing;
  }

  it("is pending, says which Items are outstanding, and shows no band", async () => {
    const h = harness();
    sitWritingEarly(h);
    const run = await h.read();
    const writing = h.sectionOf(run, "writing");
    expect(writing.state).toBe("completed");
    expect(writing.bandStatus).toEqual({
      status: "scoring",
      outstanding: [
        { taskType: "email", itemCount: 1 },
        { taskType: "discussion", itemCount: 1 },
      ],
    });
    expect(writing.estimate).toBeNull();
  });

  it("says it has no band, counting the failed Items per Task Type, once essay scoring has failed for good", async () => {
    const h = harness();
    const writing = sitWritingEarly(h);
    h.item(writing, "email-1", "email", "failed");
    h.item(writing, "disc-1", "discussion", "failed");
    const run = await h.read();
    expect(h.sectionOf(run, "writing").bandStatus).toEqual({
      status: "no-band",
      unscored: [
        { taskType: "email", failed: 1, pending: 0, notCaptured: 0 },
        { taskType: "discussion", failed: 1, pending: 0, notCaptured: 0 },
      ],
      absent: [],
    });
    expect(h.sectionOf(run, "writing").estimate).toBeNull();
  });

  it("names a Task Type with no Item at all as absent", async () => {
    const h = harness();
    h.finishedWithBand("reading", 6);
    h.finishedWithBand("listening", 6);
    const writing = h.section("writing");
    h.item(writing, "bs-1", "build_sentence", "scored");
    h.item(writing, "disc-1", "discussion", "scored", 4);
    h.r.completeAttempt(writing);
    const run = await h.read();
    expect(h.sectionOf(run, "writing").bandStatus).toEqual({ status: "no-band", unscored: [], absent: ["email"] });
  });
});

describe("pending hides a band persisted before the outstanding work", () => {
  it("an active scoring job (a re-score in flight) hides the section's band and the Overall", async () => {
    const h = harness();
    h.finishedWithBand("reading", 6);
    h.finishedWithBand("listening", 6);
    const writing = h.finishedWithBand("writing", 5);
    h.finishedWithBand("speaking", 4);
    expect((await h.read()).overall.band).toBe(5.5);

    h.r.createScoringJob({ id: "job-rescore", attemptId: writing, taskType: "email", itemIds: ["email-1"] });
    const run = await h.read();
    expect(h.sectionOf(run, "writing").bandStatus).toEqual({ status: "scoring", outstanding: [] });
    expect(h.sectionOf(run, "writing").estimate).toBeNull();
    expect(run.overall.band).toBeNull();
    expect(run.overall.pendingSections).toEqual(["writing"]);
  });
});

describe("Speaking at capture-finished", () => {
  it("is pending while its finalizer has not completed the Attempt, with outstanding Items counted per Task Type", async () => {
    const h = harness();
    const speaking = h.section("speaking");
    for (let i = 1; i <= 7; i++) h.item(speaking, `lr-${i}`, "listen_repeat", i <= 5 ? "scored" : "pending", 4);
    h.item(speaking, "int-1", "interview", "transcription_pending");
    h.r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId: speaking, placeholders: [] });

    const run = await h.read();
    const section = h.sectionOf(run, "speaking");
    expect(section.state).toBe("completed");
    expect(section.bandStatus).toEqual({
      status: "scoring",
      outstanding: [
        { taskType: "listen_repeat", itemCount: 2 },
        { taskType: "interview", itemCount: 1 },
      ],
    });
  });

  it("is estimated once completed with a band, and the Overall appears with all four", async () => {
    const h = harness();
    h.finishedWithBand("reading", 6);
    h.finishedWithBand("listening", 6);
    h.finishedWithBand("writing", 4);
    h.finishedWithBand("speaking", 4.5);
    const run = await h.read();
    expect(run.sections.map((s) => s.bandStatus.status)).toEqual(["estimated", "estimated", "estimated", "estimated"]);
    expect(h.sectionOf(run, "speaking").estimate).toMatchObject({ band: 4.5, method: "linear-v2" });
    // (6 + 6 + 4 + 4.5) / 4 = 5.125 -> 5
    expect(run.overall.band).toBe(5);
  });
});

describe("rows persisted from part of a section", () => {
  it("an estimate row covering part of a settled section reads as no band, with the failed Items counted", async () => {
    const h = harness();
    const speaking = h.section("speaking");
    h.item(speaking, "int-1", "interview", "scored", 3);
    for (let i = 1; i <= 7; i++) h.item(speaking, `lr-${i}`, "listen_repeat", "failed");
    h.r.completeAttempt(speaking);
    h.r.saveSectionEstimate({
      attemptId: speaking,
      section: "speaking",
      rawDetail: JSON.stringify({ raw: 0, coverage: [{ taskType: "interview", itemCount: 1, skippedCount: 0 }] }),
      estimatedBand: 1,
      method: "linear-v2",
    });
    const run = await h.read();
    expect(h.sectionOf(run, "speaking").bandStatus).toEqual({
      status: "no-band",
      unscored: [{ taskType: "listen_repeat", failed: 7, pending: 0, notCaptured: 0 }],
      absent: [],
    });
    expect(h.sectionOf(run, "speaking").estimate).toBeNull();
  });
});

describe("a Reading section routed and finished before its second Module", () => {
  it("reads as no band, naming the Module it never sat, even with a band persisted for it", async () => {
    const h = harness();
    const reading = h.section("reading");
    for (const sat of wholeSittingItems("reading", "upper").filter((i) => i.itemId.startsWith("router-"))) {
      h.item(reading, sat.itemId, sat.taskType, "scored", 1, sat.scoreJson);
    }
    h.r.completeAttempt(reading);
    h.band(reading, "reading", 6);

    const run = await h.read();
    expect(h.sectionOf(run, "reading").bandStatus).toEqual({
      status: "no-band",
      unscored: [],
      absent: [],
      moduleShortfalls: [{ module: "upper", sat: false, absent: ["complete_words", "academic_passage"] }],
    });
    expect(h.sectionOf(run, "reading").estimate).toBeNull();
  });
});

describe("sections that are not finished", () => {
  it("not started, in progress and abandoned all read not-finished", async () => {
    const h = harness();
    const reading = h.section("reading");
    h.item(reading, "q1", "complete_words", "scored");
    const listening = h.section("listening");
    h.r.abortAttempt(listening);
    const run = await h.read();
    expect(run.sections.map((s) => s.bandStatus)).toEqual([
      { status: "not-finished" },
      { status: "not-finished" },
      { status: "not-finished" },
      { status: "not-finished" },
    ]);
    expect(run.sections.every((s) => s.estimate === null)).toBe(true);
  });
});
