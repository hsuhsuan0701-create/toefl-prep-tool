import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { BuildupBankSetVM, FullTestRunVM, SpeakingSet } from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import { buildDrillLabRoutes, type DrillLabSetSource } from "../src/routes/drillLab.js";
import { buildFullTestRoutes } from "../src/routes/fullTests.js";
import { sqliteStores } from "./helpers/sqliteStores.js";

// A Set counts as attempted only through an Attempt that has a scored Item, or is completed and
// holds at least one Item (ATTEMPT_COUNTS_AS_SITTING_SQL in db/stores/attempts.ts). Every reader
// that decides something from "attempted" is held to that one rule here: whether a new Attempt is a
// Repeat, which Set a Full-Test Run draws, and which Listen and Repeat sentences the Drill Lab's
// bank shows.

function storesWithDb() {
  const db = openDb(":memory:");
  return Object.assign(sqliteStores(db), { db });
}

type Stores = ReturnType<typeof storesWithDb>;


function openAttempt(r: Stores, id: string, kind: "speaking" | "reading", setId: string, startedAt: string): void {
  r.createAttempt({ id, kind, mode: "simulation", setId, isRepeat: false });
  r.db.prepare("UPDATE attempts SET started_at=? WHERE id=?").run(startedAt, id);
}

function scoreItem(r: Stores, attemptId: string, itemId: string, taskType: string, scoringStatus: "scored" | "failed" = "scored"): void {
  const recorded = taskType === "listen_repeat" || taskType === "interview";
  r.insertItemResult({ attemptId, itemId, taskType, ...(recorded ? { responseAudioPath: `responses/${attemptId}/${itemId}.webm` } : {}) });
  r.updateItemScore({ attemptId, itemId, score: scoringStatus === "scored" ? 3 : null, scoreJson: "{}", scoringStatus });
}


describe("Full-Test Set selection", () => {
  const BANK = [
    { id: "rd-left", kind: "reading" },
    { id: "rd-sat", kind: "reading" },
    { id: "lsn-1", kind: "listening" },
    { id: "wri-1", kind: "writing" },
    { id: "spk-1", kind: "speaking" },
  ];

  async function drawReading(r: Stores): Promise<string | null> {
    const app = new Hono().route("/full-tests", buildFullTestRoutes({ repo: r, listSetBank: () => BANK }));
    const res = await app.request("/full-tests", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    expect(res.status).toBe(201);
    const run = (await res.json()) as FullTestRunVM;
    return run.sections.find((s) => s.section === "reading")!.setId;
  }

  it("draws a Set whose only Attempt was opened and left with nothing scored as unattempted", async () => {
    const r = storesWithDb();
    openAttempt(r, "sat", "reading", "rd-sat", "2026-08-01 00:00:00");
    scoreItem(r, "sat", "r-1", "complete_words");
    r.completeAttempt("sat");
    // Opened later, and abandoned before anything was scored: not a sitting of rd-left.
    openAttempt(r, "left", "reading", "rd-left", "2026-08-10 00:00:00");
    r.abortAttempt("left");

    expect(await drawReading(r)).toBe("rd-left");
  });

  it("orders sat Sets by their latest counted sitting, not by an Attempt that does not count", async () => {
    const r = storesWithDb();
    openAttempt(r, "left-sitting", "reading", "rd-left", "2026-07-01 00:00:00");
    scoreItem(r, "left-sitting", "r-1", "complete_words");
    openAttempt(r, "sat", "reading", "rd-sat", "2026-08-01 00:00:00");
    scoreItem(r, "sat", "r-1", "complete_words");
    r.completeAttempt("sat");
    // A later, empty Attempt on rd-left must not make it look recently sat.
    openAttempt(r, "left-empty", "reading", "rd-left", "2026-09-01 00:00:00");

    expect(await drawReading(r)).toBe("rd-left");
  });

  it("draws a Set whose only Attempt was completed with no Item as unattempted", async () => {
    const r = storesWithDb();
    openAttempt(r, "sat", "reading", "rd-sat", "2026-08-01 00:00:00");
    scoreItem(r, "sat", "r-1", "complete_words");
    r.completeAttempt("sat");
    // Completed later, holding nothing: were it a sitting, rd-left would be the more recently sat.
    openAttempt(r, "empty", "reading", "rd-left", "2026-09-01 00:00:00");
    r.completeAttempt("empty");

    expect(await drawReading(r)).toBe("rd-left");
  });
});

describe("a completed Attempt with no Item", () => {
  it("is not a sitting for the Repeat tag, the Set listing or Full-Test Set selection", () => {
    const r = storesWithDb();
    openAttempt(r, "empty", "reading", "rd-empty", "2026-09-01 00:00:00");
    r.completeAttempt("empty");
    openAttempt(r, "answered", "reading", "rd-answered", "2026-09-02 00:00:00");
    // Completed with its one Item still unscored still counts: the User answered it.
    r.insertItemResult({ attemptId: "answered", itemId: "r-1", taskType: "complete_words" });
    r.completeAttempt("answered");

    expect(r.isSetAttempted("rd-empty")).toBe(false);
    expect(r.isSetAttempted("rd-answered")).toBe(true);
    expect(r.listSetIdsCountedAsAttempted()).toEqual(["rd-answered"]);
    expect([...r.lastAttemptStartedAtBySetId().keys()]).toEqual(["rd-answered"]);
  });
});

describe("the Drill Lab bank", () => {
  const SENTENCES = ["The first sentence is about the library hours today.", "The second one names the room."];

  function speakingSet(id: string): SpeakingSet {
    return {
      id,
      kind: "speaking",
      source: "generated",
      createdAt: "2026-08-01T00:00:00.000Z",
      listenAndRepeat: {
        scenarioTitle: `Scenario ${id}`,
        scenarioDescription: "A description.",
        items: SENTENCES.map((sentence, i) => ({ id: `lr-${i + 1}`, sentence, audio: `stimuli/${id}/lr-${i + 1}.mp3`, responseWindowSec: 10 })),
      },
      interview: { scenarioTitle: "Interview", scenarioDescription: "", questions: [] },
    } as unknown as SpeakingSet;
  }

  async function bank(r: Stores): Promise<BuildupBankSetVM> {
    const set = speakingSet("spk-1");
    const sets: DrillLabSetSource = {
      readSet: (id) => (id === set.id ? set : undefined),
      scanBank: () => ({ files: [], sets: [{ kind: "speaking" as const, file: "spk-1.json", set }], failures: [] }),
    };
    const app = buildDrillLabRoutes({ repo: r, sets, transcribe: (async () => ({ transcript: "", deliveryReport: {} })) as never });
    const [entry] = (await (await app.request("/bank")).json()) as BuildupBankSetVM[];
    return entry!;
  }

  it("shows no sentence of a Set whose Attempt was opened and left with nothing scored", async () => {
    const r = storesWithDb();
    openAttempt(r, "left", "speaking", "spk-1", "2026-08-01 00:00:00");

    const entry = await bank(r);
    expect(entry.attempted).toBe(false);
    expect(entry.items.map((i) => i.preview)).toEqual([null, null]);
    expect(entry.items.map((i) => i.wordCount)).toEqual([null, null]);
  });

  it("shows a sentence once its own Item has a scored recording, and calls the Set sat only when every one has", async () => {
    const r = storesWithDb();
    openAttempt(r, "a1", "speaking", "spk-1", "2026-08-01 00:00:00");
    scoreItem(r, "a1", "lr-1", "listen_repeat");
    scoreItem(r, "a1", "lr-2", "listen_repeat", "failed");

    let entry = await bank(r);
    // The Set counts as attempted under the sitting rule (it has a scored Item), but lr-2's
    // sentence was never scored, so it stays hidden. The bank's own `attempted` needs every
    // sentence scored, so opening lr-2 still asks first.
    expect(entry.items.map((i) => i.preview)).toEqual([SENTENCES[0], null]);
    expect(entry.items.map((i) => i.wordCount)).toEqual([9, null]);
    expect(entry.attempted).toBe(false);

    scoreItem(r, "a1", "lr-2", "listen_repeat");
    entry = await bank(r);
    expect(entry.items.map((i) => i.preview)).toEqual(SENTENCES);
    expect(entry.attempted).toBe(true);
  });

  it("shows nothing for a Set whose only scored Items are Interview answers", async () => {
    const r = storesWithDb();
    openAttempt(r, "a1", "speaking", "spk-1", "2026-08-01 00:00:00");
    scoreItem(r, "a1", "iv-1", "interview");
    r.completeAttempt("a1");

    const entry = await bank(r);
    expect(entry.items.map((i) => i.preview)).toEqual([null, null]);
    expect(entry.attempted).toBe(false);
  });

  it("shows no sentence whose Item was only scored 0 as a skip, with no recording", async () => {
    // "Finish & score it" on a half-sat Speaking Simulation scores every Item without a row as a
    // skip — including Items the run never reached, whose sentences the User has not heard.
    const r = storesWithDb();
    openAttempt(r, "a1", "speaking", "spk-1", "2026-08-01 00:00:00");
    scoreItem(r, "a1", "lr-1", "listen_repeat");
    r.markCaptureFinishedWithMissingItemPlaceholders({
      attemptId: "a1",
      placeholders: [{ itemId: "lr-2", taskType: "listen_repeat", scoreJson: JSON.stringify({ skipped: true }), score: 0, scoringStatus: "scored" }],
    });

    const entry = await bank(r);
    expect(entry.items.map((i) => i.preview)).toEqual([SENTENCES[0], null]);
    expect(entry.attempted).toBe(false);
  });

  it("counts the Set as attempted through a discarded Attempt that holds a scored Response", async () => {
    const r = storesWithDb();
    openAttempt(r, "a1", "speaking", "spk-1", "2026-08-01 00:00:00");
    scoreItem(r, "a1", "lr-1", "listen_repeat");
    scoreItem(r, "a1", "lr-2", "listen_repeat");
    r.abortAttempt("a1");

    expect((await bank(r)).attempted).toBe(true);
  });
});
