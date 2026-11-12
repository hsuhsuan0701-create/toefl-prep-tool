import { describe, expect, it } from "vitest";
import type { AttemptListVM } from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { at } from "./helpers/timestamps.js";

// The Attempt log names each row by its outcome: its own Band Estimate when it has one. The band is
// read through the same rule as every other band surface (sectionEstimates' persistedRowToEstimate),
// so a row an older build persisted from part of a section never reaches the log as a band.

const SET_ID = "wri-nosuchset";
const FULL_WRITING_COVERAGE = [
  { taskType: "build_sentence", itemCount: 10 },
  { taskType: "email", itemCount: 1 },
  { taskType: "discussion", itemCount: 1 },
];

function harness() {
  const db = openDb(":memory:");
  const r = sqliteStores(db);
  const app = buildAttemptsRoutes({
    repo: r,
    transcriptionRecovery: { readAttemptSnapshot: () => new Map() },
    speakingFinalization: {},
    onScoringTerminal: async () => undefined,
  } as never);
  return { r, db, app };
}

async function log(app: ReturnType<typeof harness>["app"]): Promise<AttemptListVM> {
  const res = await app.request("/");
  expect(res.status).toBe(200);
  return (await res.json()) as AttemptListVM;
}

// A completed Writing Attempt with every Item scored, so whether a persisted row is a band turns on
// the row alone.
function completed(r: ReturnType<typeof harness>["r"], id: string, opts: { isRepeat?: boolean; mode?: "drill" | "simulation" } = {}) {
  r.createAttempt({ id, kind: "writing", mode: opts.mode ?? "simulation", setId: SET_ID, isRepeat: opts.isRepeat ?? false });
  for (const [itemId, taskType] of [["bs-1", "build_sentence"], ["email-1", "email"], ["disc-1", "discussion"]]) {
    r.insertItemResult({ attemptId: id, itemId, taskType });
    r.updateItemScore({ attemptId: id, itemId, score: 1, scoreJson: "{}", scoringStatus: "scored" });
  }
  r.completeAttempt(id, at("2026-08-01 10:30:00"));
}

describe("GET / — each Attempt carries its own Band Estimate", () => {
  it("carries the band and the method it was computed under", async () => {
    const { r, app } = harness();
    completed(r, "att-banded");
    r.saveSectionEstimate({
      attemptId: "att-banded",
      section: "writing",
      rawDetail: JSON.stringify({ raw: 4.1, coverage: FULL_WRITING_COVERAGE }),
      estimatedBand: 5,
      method: "linear-v2",
    });

    const page = await log(app);
    expect(page.items[0].estimate).toEqual({ band: 5, method: "linear-v2" });
  });

  it("keeps an older method's name as it was persisted", async () => {
    const { r, app } = harness();
    completed(r, "att-old-method");
    r.saveSectionEstimate({
      attemptId: "att-old-method",
      section: "writing",
      rawDetail: JSON.stringify({ raw: 3.9, coverage: FULL_WRITING_COVERAGE }),
      estimatedBand: 4.5,
      method: "linear-v1",
    });

    expect((await log(app)).items[0].estimate).toEqual({ band: 4.5, method: "linear-v1" });
  });

  it("is null for an Attempt with no persisted estimate", async () => {
    const { r, app } = harness();
    completed(r, "att-none", { mode: "drill" });
    expect((await log(app)).items[0].estimate).toBeNull();
  });

  it("is null for a row persisted from part of a section, never a band", async () => {
    const { r, app } = harness();
    completed(r, "att-partial");
    // Only the Email was scored: an older build re-spread the weights and stored a band anyway.
    r.saveSectionEstimate({
      attemptId: "att-partial",
      section: "writing",
      rawDetail: JSON.stringify({ raw: 4.5, coverage: [{ taskType: "email", itemCount: 1 }] }),
      estimatedBand: 5.5,
      method: "linear-v1",
    });

    expect((await log(app)).items[0].estimate).toBeNull();
  });

  it("is null for a row whose stored detail cannot be read", async () => {
    const { r, app } = harness();
    completed(r, "att-corrupt");
    r.saveSectionEstimate({ attemptId: "att-corrupt", section: "writing", rawDetail: "{not json", estimatedBand: 5, method: "linear-v2" });

    expect((await log(app)).items[0].estimate).toBeNull();
  });

  it("shows a Repeat its own band, as the Attempt review does", async () => {
    const { r, app } = harness();
    completed(r, "att-repeat", { isRepeat: true });
    r.saveSectionEstimate({
      attemptId: "att-repeat",
      section: "writing",
      rawDetail: JSON.stringify({ raw: 4.1, coverage: FULL_WRITING_COVERAGE }),
      estimatedBand: 5,
      method: "linear-v2",
    });

    const [row] = (await log(app)).items;
    expect(row.isRepeat).toBe(true);
    expect(row.estimate).toEqual({ band: 5, method: "linear-v2" });
  });

  it("gives each row on a page its own estimate", async () => {
    const { r, db, app } = harness();
    completed(r, "att-a");
    completed(r, "att-b");
    db.prepare("UPDATE attempts SET started_at=? WHERE id='att-a'").run("2026-08-01 10:00:00");
    db.prepare("UPDATE attempts SET started_at=? WHERE id='att-b'").run("2026-08-02 10:00:00");
    r.saveSectionEstimate({
      attemptId: "att-a",
      section: "writing",
      rawDetail: JSON.stringify({ raw: 3.2, coverage: FULL_WRITING_COVERAGE }),
      estimatedBand: 4,
      method: "linear-v2",
    });

    const page = await log(app);
    expect(page.items.map((a) => [a.id, a.estimate?.band ?? null])).toEqual([
      ["att-b", null],
      ["att-a", 4],
    ]);
  });
});
