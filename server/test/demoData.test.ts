import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DeliveryReportSchema,
  JudgeReportSchema,
  ScoreReportSchema,
  isSkippedItemScoreJson,
  type AttemptDetailVM,
  type AttemptListVM,
  type FullTestRunVM,
  type ItemVM,
  type JudgeReportVM,
  type SetListEntryVM,
  type StatsSummaryVM,
} from "@toefl-prep/shared";
import { openDb } from "../src/db/db.js";
import {
  attemptsRouteStore,
  bootRecoveryStore,
  createSqliteStores,
  fullTestsRouteStore,
  speakingCoordinatorStore,
  statsRouteStore,
} from "../src/db/stores/index.js";
import { parseSqliteTimestamp } from "../src/db/timestamps.js";
import { config } from "../src/lib/config.js";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { buildFullTestRoutes } from "../src/routes/fullTests.js";
import { buildSetsRoutes } from "../src/routes/sets.js";
import { buildStatsRoutes } from "../src/routes/stats.js";
import { wireBootRecoveryPasses } from "../src/services/bootRecoveryRegistry.js";
import { readSupersessionManifest, supersessionManifestPath } from "../src/services/supersessionManifest.js";
import { createSpeakingCoordinators } from "../src/services/speakingFinalization.js";
import { seedDemoData, type SeedSummary } from "../../scripts/demo/seed.js";
import { parseToday } from "../../scripts/demo/seedDirectory.js";
import { DEMO_MARKER, SeedTargetRefused, checkSeedTarget } from "../../scripts/demo/target.js";

// The demo data set (scripts/seed-demo-data.ts, docs/demo-data.md) seeded into this file's own data
// directory and read back through the real route handlers. A schema, view model, store or estimate
// change the demo does not satisfy fails here rather than as an empty or broken screen in
// `npm run demo`.
//
// No ffmpeg (only transcode.test.ts runs it): the recordings are a few placeholder bytes, which is all
// the rows and the review page's file lookup need.

// In the past on purpose: a row the seeder forgot to backdate carries the wall clock, which is
// after `today` and fails "dates every row before today".
const TODAY = parseToday("2026-03-20");
const RECORDINGS = {
  sentence: Buffer.from("demo sentence recording"),
  answer: Buffer.from("demo answer recording"),
  silence: Buffer.from("demo silent recording"),
};
const SCORE_REPORT_ITEM = ScoreReportSchema.shape.items.element;
const JUDGED = new Set(["email", "discussion", "interview", "listen_repeat"]);

/** A judged Item that holds a Score Report: scored, and not the scored-0 skip marker. */
function hasScoreReport(item: ItemVM): boolean {
  return JUDGED.has(item.taskType) && item.scoringStatus === "scored" && !isSkippedItemScoreJson(item.scoreJson);
}

let db: Database.Database;
let summary: SeedSummary;
let attemptsApp: ReturnType<typeof buildAttemptsRoutes>;
let statsApp: ReturnType<typeof buildStatsRoutes>;
let fullTestsApp: ReturnType<typeof buildFullTestRoutes>;
let details: AttemptDetailVM[];

async function getJson<T>(app: { request: (url: string) => Response | Promise<Response> }, url: string): Promise<T> {
  const res = await app.request(url);
  expect(res.status, url).toBe(200);
  return (await res.json()) as T;
}

/** Every row of the score-bearing tables, in insertion order: what the demo IS. */
function snapshot(handle: Database.Database): Record<string, unknown[]> {
  const tables = ["attempts", "item_results", "judge_reports", "section_estimates", "transcription_jobs", "full_test_runs", "settings"];
  return Object.fromEntries(tables.map((table) => [table, handle.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

function judgesFor(detail: AttemptDetailVM, itemId: string): JudgeReportVM[] {
  return detail.judgeReports.filter((report) => report.itemId === itemId);
}

function allItems(): { detail: AttemptDetailVM; item: ItemVM }[] {
  return details.flatMap((detail) => detail.items.map((item) => ({ detail, item })));
}

beforeAll(async () => {
  // config.dataDir is this test file's private copy of the bank; the route handlers read Sets from it.
  expect(fs.existsSync(path.join(config.dataDir, "db.sqlite"))).toBe(false);
  summary = await seedDemoData({ dataDir: config.dataDir, today: TODAY, recordings: RECORDINGS });

  db = openDb(path.join(config.dataDir, "db.sqlite"));
  const stores = createSqliteStores(db, { dataDir: config.dataDir });
  attemptsApp = buildAttemptsRoutes({
    repo: attemptsRouteStore(stores),
    ...createSpeakingCoordinators({ repo: speakingCoordinatorStore(stores) }),
  });
  statsApp = buildStatsRoutes({ repo: statsRouteStore(stores) });
  fullTestsApp = buildFullTestRoutes({ repo: fullTestsRouteStore(stores) });

  const list = await getJson<AttemptListVM>(attemptsApp, "/?limit=100");
  details = await Promise.all(list.items.map((row) => getJson<AttemptDetailVM>(attemptsApp, `/${row.id}`)));
});

afterAll(() => db?.close());

describe("the demo practice history", () => {
  it("gives the Dashboard four section bands, each against its Target, and an Overall", async () => {
    const dashboard = await getJson<StatsSummaryVM>(statsApp, "/summary");
    expect(dashboard.sections.map((s) => s.section)).toEqual(["reading", "listening", "writing", "speaking"]);
    expect(dashboard.overall.missingSections).toEqual([]);
    expect(dashboard.overall.band).toEqual(expect.any(Number));
    const band = Object.fromEntries(dashboard.sections.map((s) => [s.section, s.band]));
    // The bands docs/demo-data.md and the README screenshots show.
    expect(band).toEqual({ reading: 5, listening: 5.5, writing: 4, speaking: 4 });
    expect(dashboard.overall.band).toBe(4.5);
    // The learner the demo describes: stronger at Reading and Listening than at Writing and Speaking.
    expect(Math.min(band.reading, band.listening)).toBeGreaterThan(Math.max(band.writing, band.speaking));
    for (const section of dashboard.sections) {
      expect(section.target).toBeGreaterThanOrEqual(section.band);
      expect(section.recentSimulationRange?.count).toBeGreaterThanOrEqual(2);
    }
    expect(dashboard.weaknesses.length).toBeGreaterThan(0);
    expect(dashboard.judgeAgreement.sampleSize).toBeGreaterThan(0);
    expect(dashboard.skillItems.length).toBeGreaterThan(0);
  });

  it("lists every seeded Attempt, Drills and Simulations in all four sections", async () => {
    const list = await getJson<AttemptListVM>(attemptsApp, "/?limit=100");
    const seeded = Object.values(summary.attempts).reduce((n, s) => n + s.drill + s.simulation, 0);
    expect(list.total).toBe(seeded);
    expect(list.items).toHaveLength(seeded);
    for (const section of ["reading", "listening", "writing", "speaking"] as const) {
      for (const mode of ["drill", "simulation"] as const) {
        const count = list.items.filter((a) => a.kind === section && a.mode === mode).length;
        expect(count, `${section} ${mode}`).toBe(summary.attempts[section][mode]);
        expect(count, `${section} ${mode}`).toBeGreaterThan(0);
      }
    }
    // Two Repeats, both Drills: no seeded Simulation loses its band to the Repeat rule.
    const repeats = list.items.filter((a) => a.isRepeat);
    expect(repeats.map((a) => `${a.kind} ${a.mode}`).sort()).toEqual(["reading drill", "speaking drill"]);
    expect(list.items.filter((a) => a.flagged)).toHaveLength(1);
    expect(list.items.some((a) => a.status === "in_progress" && a.mode === "drill")).toBe(true);
    const paths = new Set(list.items.flatMap((a) => (a.modulePath ? [`${a.kind}:${a.modulePath}`] : [])));
    expect(paths).toEqual(new Set(["reading:lower", "reading:upper", "listening:lower", "listening:upper"]));
  });

  it("has a completed Full-Test Run with an Overall and one left in progress without one", async () => {
    const runs = await getJson<FullTestRunVM[]>(fullTestsApp, "/");
    const completed = runs.filter((r) => r.status === "completed");
    const inProgress = runs.filter((r) => r.status === "in-progress");
    expect(completed).toHaveLength(1);
    expect(inProgress).toHaveLength(1);
    expect(completed[0].overall.band).toEqual(expect.any(Number));
    expect(completed[0].sections.every((s) => s.bandStatus.status === "estimated")).toBe(true);
    expect(inProgress[0].overall.band).toBeNull();
    expect(inProgress[0].currentSection).toBe("listening");
    expect(inProgress[0].sections.find((s) => s.section === "reading")?.bandStatus.status).toBe("estimated");
  });

  it("serves every Attempt's review with well-formed Score, Judge and Delivery Reports", () => {
    for (const { detail, item } of allItems()) {
      const where = `${detail.attempt.kind} ${detail.attempt.id} ${item.itemId}`;
      if (item.deliveryReport !== null) DeliveryReportSchema.parse(JSON.parse(item.deliveryReport));
      if (!hasScoreReport(item)) continue;
      const report = SCORE_REPORT_ITEM.parse(item.scoreJson);
      const responseText = item.taskType === "email" || item.taskType === "discussion" ? item.responseText : item.transcript;
      for (const d of report.deductions) expect(responseText, where).toContain(d.quote);

      const judges = judgesFor(detail, item.itemId);
      for (const judge of judges) {
        const parsed = JudgeReportSchema.parse(judge.report);
        for (const d of parsed.items[0].deductions) expect(responseText, where).toContain(d.quote);
        if (judge.mode === "text-fallback") expect(judge.judge, where).toBe("openai");
        if (item.taskType === "interview" || item.taskType === "listen_repeat") expect(judge.mode, where).toBeDefined();
      }
      const noSpeech = (item.scoreJson as { noSpeechDetected?: boolean }).noSpeechDetected === true;
      if (noSpeech) {
        expect(judges, where).toHaveLength(0);
        continue;
      }
      expect(report.singleJudge === true, where).toBe(judges.length === 1);
      const scores = judges.map((j) => j.report!.items[0].score);
      expect(report.lowConfidence === true, where).toBe(scores.length === 2 && Math.abs(scores[0] - scores[1]) >= 1.5);
      expect(report.feedbackZh, where).not.toMatch(/[这们说语还时]/);
      // Score-bearing state names no provider (CLAUDE.md); Judges are named only by family.
      expect(JSON.stringify(item.scoreJson), where).not.toMatch(/claude|codex|gpt|openai-http/i);
    }
  });

  it("shows the review states the UI has to render", () => {
    const items = allItems();
    const speaking = items.filter(({ item }) => item.taskType === "listen_repeat" || item.taskType === "interview");

    // A recording with no speech: a scored 0, marked, no Judges.
    const silent = speaking.filter(({ item }) => (item.scoreJson as { noSpeechDetected?: boolean } | null)?.noSpeechDetected);
    expect(silent).toHaveLength(1);
    expect(silent[0].item).toMatchObject({ score: 0, scoringStatus: "scored", transcript: "" });

    // A skipped Item: a scored 0 with the skip marker, disclosed in the band's coverage.
    const skipped = items.filter(({ item }) => isSkippedItemScoreJson(item.scoreJson));
    expect(skipped).toHaveLength(1);
    expect(skipped[0].item.score).toBe(0);
    expect(skipped[0].detail.estimate?.coverage.some((c) => (c.skippedCount ?? 0) > 0)).toBe(true);

    // An Item whose scoring failed: the Attempt has no band and says which Item stands in the way.
    const failed = items.filter(({ item }) => item.scoringStatus === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].item.scoreJson).toEqual({ error: "both judges failed" });
    expect(failed[0].detail.estimate).toBeNull();
    expect(failed[0].detail.bandStatus).toMatchObject({ status: "incomplete", unscored: [{ taskType: failed[0].item.taskType, failed: 1 }] });

    // A transcription that failed every automatic retry, offered for a retry.
    const untranscribed = items.filter(({ item }) => item.transcriptionJob !== undefined);
    expect(untranscribed).toHaveLength(1);
    expect(untranscribed[0].item.scoringStatus).toBe("transcription_pending");
    expect(untranscribed[0].item.transcriptionJob).toMatchObject({ status: "failed", automaticAttempts: 4, failureKind: "provider" });
    expect(untranscribed[0].detail.bandStatus).toMatchObject({ status: "incomplete" });
    expect(fs.existsSync(path.join(config.dataDir, untranscribed[0].item.responseAudioPath!))).toBe(true);

    // Every recorded spoken Item has its recording on disk for the review's player.
    for (const { item } of speaking) {
      if (item.responseAudioPath === null) continue;
      expect(fs.existsSync(path.join(config.dataDir, item.responseAudioPath)), item.responseAudioPath).toBe(true);
    }

    // Listen and Repeat transcripts that differ from the target, so the word diff has something to show.
    const diffs = speaking
      .filter(({ item }) => item.taskType === "listen_repeat" && hasScoreReport(item))
      .map(({ item }) => (item.scoreJson as { meta: { diff: { op: string }[] } }).meta.diff);
    expect(diffs.filter((diff) => diff.some((op) => op.op !== "match")).length).toBeGreaterThan(diffs.length / 2);

    // Each Score Report marker the review discloses.
    const reports = items
      .filter(({ item }) => hasScoreReport(item))
      .map(({ detail, item }) => ({ detail, item, report: SCORE_REPORT_ITEM.parse(item.scoreJson) }));
    expect(reports.filter((r) => r.report.lowConfidence)).toHaveLength(1);
    expect(reports.filter((r) => r.report.singleJudge)).toHaveLength(1);
    expect(reports.filter((r) => r.report.selfArbitrated)).toHaveLength(1);
    expect(details.flatMap((d) => d.judgeReports).filter((j) => j.mode === "text-fallback")).toHaveLength(1);
    const rewritable = reports.filter((r) => r.item.taskType !== "listen_repeat" && !(r.item.scoreJson as { noSpeechDetected?: boolean }).noSpeechDetected);
    for (const r of rewritable) expect(r.report.modelRewrite, r.item.itemId).toEqual(expect.stringMatching(/\S/));

    // A completed Reading or Listening Attempt carries its keys and Explanations.
    for (const detail of details) {
      if ((detail.attempt.kind === "reading" || detail.attempt.kind === "listening") && detail.attempt.status === "completed") {
        expect(detail.deterministicReview?.length, detail.attempt.id).toBe(detail.items.length);
      }
    }
    // An Attempt left unfinished says so.
    expect(details.some((d) => d.bandStatus.status === "unfinished" && d.attempt.mode === "drill")).toBe(true);
  });

  it("leaves a live Reading Set unattempted, so a Reading Simulation in the demo is a first sitting", async () => {
    const retired = new Set(readSupersessionManifest(supersessionManifestPath(config.dataDir)).map((s) => s.setId));
    const stores = createSqliteStores(db, { dataDir: config.dataDir });
    const setsApp = buildSetsRoutes({
      attemptedSetIds: () => new Set(stores.attempts.listSetIdsCountedAsAttempted()),
      supersededSetIds: () => retired,
      dataDir: config.dataDir,
    });
    const reading = await getJson<SetListEntryVM[]>(setsApp, "/?kind=reading");
    const fresh = reading.filter((set) => !set.attempted);
    expect(fresh.length).toBeGreaterThan(0);

    // Started on a copy of the seeded database, so the rows the other tests compare stay as seeded.
    const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-first-sitting-"));
    const copyFile = path.join(copyDir, "db.sqlite");
    db.prepare("VACUUM INTO ?").run(copyFile);
    const copy = openDb(copyFile);
    try {
      const copyStores = createSqliteStores(copy, { dataDir: config.dataDir });
      const app = buildAttemptsRoutes({
        repo: attemptsRouteStore(copyStores),
        ...createSpeakingCoordinators({ repo: speakingCoordinatorStore(copyStores) }),
      });
      const res = await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "reading", mode: "simulation", setId: fresh[0].id }),
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ isRepeat: false });
    } finally {
      copy.close();
    }
  });

  it("dates every row before `today`", () => {
    const columns: Record<string, string[]> = {
      attempts: ["started_at", "completed_at", "capture_finished_at"],
      item_results: ["created_at", "scored_at"],
      judge_reports: ["created_at"],
      transcription_jobs: ["created_at", "updated_at", "next_retry_at"],
      full_test_runs: ["created_at", "completed_at"],
    };
    for (const [table, names] of Object.entries(columns)) {
      for (const row of db.prepare(`SELECT ${names.join(",")} FROM ${table}`).all() as Record<string, string | null>[]) {
        for (const name of names) {
          if (row[name] === null) continue;
          expect(parseSqliteTimestamp(row[name]!).getTime(), `${table}.${name}`).toBeLessThan(TODAY.getTime());
        }
      }
    }
    const first = db.prepare("SELECT MIN(started_at) AS t FROM attempts").get() as { t: string };
    expect(TODAY.getTime() - parseSqliteTimestamp(first.t).getTime()).toBeGreaterThan(14 * 24 * 3600 * 1000);
  });

  it("is a state the server's boot recovery leaves as it is", async () => {
    // `npm run demo` boots the server over the seeded database before anyone looks at it.
    const before = snapshot(db);
    const stores = createSqliteStores(db, { dataDir: config.dataDir });
    const listeners: (() => unknown)[] = [];
    wireBootRecoveryPasses(
      { on: (_event, listener) => { listeners.push(listener); } },
      { repo: bootRecoveryStore(stores), speakingFinalization: createSpeakingCoordinators({ repo: speakingCoordinatorStore(stores) }).speakingFinalization },
    );
    for (const listener of listeners) await listener();
    expect(snapshot(db)).toEqual(before);
  });

  it("writes the same database for the same `today`", async () => {
    const again = fs.mkdtempSync(path.join(os.tmpdir(), "demo-again-"));
    fs.cpSync(path.join(config.dataDir, "question-sets"), path.join(again, "question-sets"), { recursive: true });
    await seedDemoData({ dataDir: again, today: TODAY, recordings: RECORDINGS });
    const second = openDb(path.join(again, "db.sqlite"));
    try {
      expect(snapshot(second)).toEqual(snapshot(db));
    } finally {
      second.close();
    }
  });
});

describe("where demo data may be written", () => {
  const repoRoot = config.projectRoot;

  it("never inside the repository's data/", () => {
    expect(() => checkSeedTarget(path.join(repoRoot, "data"), { repoRoot, force: true })).toThrow(SeedTargetRefused);
    expect(() => checkSeedTarget(path.join(repoRoot, "data", "demo"), { repoRoot, force: true })).toThrow(SeedTargetRefused);
  });

  it("into a new or empty directory", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "demo-target-"));
    expect(checkSeedTarget(path.join(parent, "new"), { repoRoot, force: false }).replace).toBe(false);
    expect(checkSeedTarget(parent, { repoRoot, force: false }).replace).toBe(false);
  });

  it("over earlier demo data only with --force, and never over a database it did not write", () => {
    const demo = fs.mkdtempSync(path.join(os.tmpdir(), "demo-target-"));
    fs.writeFileSync(path.join(demo, DEMO_MARKER), "");
    fs.writeFileSync(path.join(demo, "db.sqlite"), "");
    expect(() => checkSeedTarget(demo, { repoRoot, force: false })).toThrow(/--force/);
    expect(checkSeedTarget(demo, { repoRoot, force: true }).replace).toBe(true);

    const real = fs.mkdtempSync(path.join(os.tmpdir(), "demo-target-"));
    fs.writeFileSync(path.join(real, "db.sqlite"), "");
    expect(() => checkSeedTarget(real, { repoRoot, force: true })).toThrow(/did not create/);
  });
});
