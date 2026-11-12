import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AttemptDetailVM, AttemptListVM, FullTestRunVM, TrendPointVM } from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { buildGenerateRoutes } from "../src/routes/generate.js";
import { buildStatsRoutes } from "../src/routes/stats.js";
import { buildFullTestRoutes } from "../src/routes/fullTests.js";
import { pinTimezone } from "./helpers/pinTimezone.js";

// Every timestamp a route hands the client is read out of a SQLite column written in
// sqliteTimestamp()'s space form ("2026-08-22 12:50:10", no 'T', no 'Z'), which `new Date(...)`
// parses as local time. No such raw value crosses the boundary: each leaves as an unambiguous ISO
// instant, so the client's single `new Date(value).toLocaleString()` is right and nothing
// downstream converts a second time.
//
// Pinned to a non-UTC zone for the same reason db.timestamps.test.ts is: on a UTC machine the space
// form and the instant name the same moment, so a route that forgot to normalise would still look
// correct here.
const EXPECTED_OFFSET = pinTimezone();

// 12:50:10 UTC is 20:50 in the pinned zone (Asia/Taipei).
const STORED = "2026-08-22 12:50:10";
const INSTANT = "2026-08-22T12:50:10.000Z";

function attemptsApp() {
  const db = openDb(":memory:");
  const r = sqliteStores(db);
  const app = buildAttemptsRoutes({
    repo: r,
    // A real (empty) snapshot, not a bare `{}`: GET /:id calls readAttemptSnapshot inside its own
    // try/catch, so an absent method would degrade to "no transcription jobs" through the failure
    // path, and these cases would pass while proving less. nextRetryAt's normalisation is covered
    // where it is built, in transcriptionRecovery.test.ts.
    transcriptionRecovery: { readAttemptSnapshot: () => new Map() },
    speakingFinalization: {},
    onScoringTerminal: async () => undefined,
  } as never);
  return { r, db, app };
}

describe("attempt timestamps cross the boundary as instants", () => {
  it("machine timezone is non-UTC, so an un-normalised value would actually differ", () => {
    expect(new Date(INSTANT).getTimezoneOffset()).toBe(EXPECTED_OFFSET);
  });

  it("GET /:id emits startedAt, completedAt and captureFinishedAt as instants", async () => {
    const { r, db, app } = attemptsApp();
    r.createAttempt({ id: "att", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    db.prepare("UPDATE attempts SET started_at=?, completed_at=?, capture_finished_at=? WHERE id='att'")
      .run(STORED, "2026-08-22 13:00:00", "2026-08-22 12:55:00");

    const body = (await (await app.request("/att")).json()) as AttemptDetailVM;
    expect(body.attempt.startedAt).toBe(INSTANT);
    expect(body.attempt.completedAt).toBe("2026-08-22T13:00:00.000Z");
    expect(body.attempt.captureFinishedAt).toBe("2026-08-22T12:55:00.000Z");
    // The displayed wall-clock hour is the local one, not the stored UTC one.
    expect(new Date(body.attempt.startedAt).getHours()).toBe(20);
  });

  it("GET /:id leaves a null completedAt null rather than inventing an epoch instant", async () => {
    const { r, app } = attemptsApp();
    r.createAttempt({ id: "att", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    const body = (await (await app.request("/att")).json()) as AttemptDetailVM;
    expect(body.attempt.completedAt).toBeNull();
    expect(body.attempt.captureFinishedAt).toBeNull();
  });

  it("GET /:id emits each item's createdAt as an instant", async () => {
    const { r, db, app } = attemptsApp();
    r.createAttempt({ id: "att", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    r.insertItemResult({ attemptId: "att", itemId: "email-a", taskType: "email" });
    db.prepare("UPDATE item_results SET created_at=? WHERE attempt_id='att'").run(STORED);

    const body = (await (await app.request("/att")).json()) as AttemptDetailVM;
    expect(body.items[0].createdAt).toBe(INSTANT);
  });

  it("GET / emits every listed attempt's startedAt and completedAt as instants", async () => {
    const { r, db, app } = attemptsApp();
    r.createAttempt({ id: "att", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    db.prepare("UPDATE attempts SET started_at=?, completed_at=? WHERE id='att'").run(STORED, "2026-08-22 13:00:00");

    const page = (await (await app.request("/")).json()) as AttemptListVM;
    expect(page.items[0].startedAt).toBe(INSTANT);
    expect(page.items[0].completedAt).toBe("2026-08-22T13:00:00.000Z");
  });

  it("scoring-job cancellation and readback emit cancellationRequestedAt/terminalAt as instants", async () => {
    const { r, app } = attemptsApp();
    r.createAttempt({ id: "att", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    r.createScoringJob({ id: "job", attemptId: "att", taskType: "email", itemIds: ["email-a"] });
    r.requestScoringJobCancellation({ id: "job", reason: "user", now: STORED });
    r.finishScoringJobCancellation({ id: "job", now: "2026-08-22 12:50:20" });

    const cancelled = (await (await app.request("/att/score-jobs/job/cancel", { method: "POST" })).json()) as Record<string, string>;
    expect(cancelled.cancellationRequestedAt).toBe(INSTANT);
    expect(cancelled.terminalAt).toBe("2026-08-22T12:50:20.000Z");

    const read = (await (await app.request("/att/score-jobs/job")).json()) as Record<string, string>;
    expect(read.cancellationRequestedAt).toBe(INSTANT);
    expect(read.terminalAt).toBe("2026-08-22T12:50:20.000Z");
  });
});

describe("generation timestamps cross the boundary as instants", () => {
  function generateApp() {
    const r = sqliteStores(openDb(":memory:"));
    return { r, app: new Hono().route("/", buildGenerateRoutes({ repo: r, runSkillTask: vi.fn() })) };
  }

  it("a standalone job emits cancellationRequestedAt/terminalAt as instants", async () => {
    const { r, app } = generateApp();
    r.createGenerationJob({ id: "job", kind: "writing" });
    r.requestGenerationJobCancellation({ id: "job", reason: "user", now: STORED });
    r.finishGenerationJobCancellation({ id: "job", now: "2026-08-22 12:50:20" });

    const body = (await (await app.request("/job")).json()) as Record<string, string>;
    expect(body.cancellationRequestedAt).toBe(INSTANT);
    expect(body.terminalAt).toBe("2026-08-22T12:50:20.000Z");
  });

  it("a batch emits its own and each child's cancellation timestamps as instants", async () => {
    const { r, app } = generateApp();
    r.createGenerationBatch({ id: "batch", total: 1 });
    r.createGenerationJob({ id: "child", kind: "writing", batchId: "batch", batchIndex: 0 });
    r.requestGenerationBatchCancellation({ id: "batch", reason: "user", now: STORED });
    r.requestGenerationJobCancellation({ id: "child", reason: "user", now: STORED });
    r.finishGenerationJobCancellation({ id: "child", now: "2026-08-22 12:50:20" });

    const body = (await (await app.request("/batch")).json()) as {
      cancellationRequestedAt: string;
      children: { cancellationRequestedAt: string; terminalAt: string }[];
    };
    expect(body.cancellationRequestedAt).toBe(INSTANT);
    expect(body.children[0].cancellationRequestedAt).toBe(INSTANT);
    expect(body.children[0].terminalAt).toBe("2026-08-22T12:50:20.000Z");
  });
});

describe("trend point dates cross the boundary as instants", () => {
  it("GET /trends emits each point's date as an instant", async () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    const app = buildStatsRoutes({ repo: r });
    r.createAttempt({ id: "att", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    r.insertItemResult({ attemptId: "att", itemId: "email-a", taskType: "email" });
    r.updateItemScore({ attemptId: "att", itemId: "email-a", score: 4, scoreJson: "{}", scoringStatus: "scored" });
    db.prepare("UPDATE attempts SET status='completed', started_at=?, completed_at=? WHERE id='att'").run("2026-08-22 09:00:00", STORED);

    const points = (await (await app.request("/trends?taskType=email")).json()) as TrendPointVM[];
    expect(points[0].date).toBe(INSTANT);
  });

  it("GET /trends falls back to startedAt, still as an instant, for a completed attempt with no completed_at", async () => {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    const app = buildStatsRoutes({ repo: r });
    r.createAttempt({ id: "att", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    r.insertItemResult({ attemptId: "att", itemId: "email-a", taskType: "email" });
    r.updateItemScore({ attemptId: "att", itemId: "email-a", score: 4, scoreJson: "{}", scoringStatus: "scored" });
    // Trends plot completed Attempts only; a completed row missing its completed_at is the one shape
    // the fallback still serves.
    db.prepare("UPDATE attempts SET status='completed', started_at=?, completed_at=NULL WHERE id='att'").run(STORED);

    const points = (await (await app.request("/trends?taskType=email")).json()) as TrendPointVM[];
    expect(points[0].date).toBe(INSTANT);
  });
});

describe("full-test run timestamps cross the boundary as instants", () => {
  function fullTestApp() {
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    const app = buildFullTestRoutes({
      repo: r,
      // One Set per section, since a Run missing any is refused at creation. Nothing here sits a
      // section: only the two timestamps are under test.
      listSetBank: () => [
        { id: "rd-ft", kind: "reading" },
        { id: "lsn-ft", kind: "listening" },
        { id: "wri-ft", kind: "writing" },
        { id: "spk-ft", kind: "speaking" },
      ],
    });
    return { db, r, app };
  }

  it("writes created_at in the on-disk space form, and emits it as an instant", async () => {
    const { db, app } = fullTestApp();
    const created = (await (await app.request("/", { method: "POST" })).json()) as FullTestRunVM;

    // The write side: a Run created through the route lands in the same space-form UTC every other
    // `*_at` column holds. An ISO write would sort above every space-form value of the same day
    // ('T' > ' ') and be misread as local time wherever it is read.
    const stored = db.prepare("SELECT created_at FROM full_test_runs WHERE id=?").get(created.id) as {
      created_at: string;
    };
    expect(stored.created_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    // The read side, against a known stored value.
    db.prepare("UPDATE full_test_runs SET created_at=?, completed_at=? WHERE id=?")
      .run(STORED, "2026-08-22 13:00:00", created.id);
    const body = (await (await app.request(`/${created.id}`)).json()) as FullTestRunVM;
    expect(body.createdAt).toBe(INSTANT);
    expect(body.completedAt).toBe("2026-08-22T13:00:00.000Z");
    expect(new Date(body.createdAt).getHours()).toBe(20);
  });

  it("leaves an unfinished run's completedAt null rather than inventing an epoch instant", async () => {
    const { app } = fullTestApp();
    const created = (await (await app.request("/", { method: "POST" })).json()) as FullTestRunVM;
    expect(created.completedAt).toBeNull();
  });

  it("the listing normalises every row the same way", async () => {
    const { db, app } = fullTestApp();
    const created = (await (await app.request("/", { method: "POST" })).json()) as FullTestRunVM;
    db.prepare("UPDATE full_test_runs SET created_at=? WHERE id=?").run(STORED, created.id);

    const list = (await (await app.request("/")).json()) as FullTestRunVM[];
    expect(list[0].createdAt).toBe(INSTANT);
  });
});
