import { beforeEach, describe, expect, it } from "vitest";
import type { StatsSettingsVM, StatsSummaryVM, TrendPointVM } from "@toefl-prep/shared";
import { buildStatsRoutes } from "../src/routes/stats.js";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { wholeSittingItems } from "./helpers/wholeSitting.js";
import { requiredTaskTypes } from "../src/services/bandEstimator.js";
import { sqliteTimestamp } from "../src/db/timestamps.js";

// A persisted estimate is read back as a band only when its stored coverage has a scored Item of
// every Task Type its section needs, so every row seeded here carries exactly that (and persistBand
// below gives its Attempt the Items to match).
function fullDetail(section: "speaking" | "writing" | "reading" | "listening"): string {
  return JSON.stringify({ raw: 0.6, coverage: requiredTaskTypes(section, null).map((taskType) => ({ taskType, itemCount: 1 })) });
}

function buildTestApp() {
  const db = openDb(":memory:");
  const testRepo = sqliteStores(db);
  const app = buildStatsRoutes({ repo: testRepo });
  return { app, repo: testRepo, db };
}

/** Trend points and headline estimates come only from completed Attempts, so fixtures complete theirs. */
function completedAttempt(ctx: ReturnType<typeof buildTestApp>, a: { id: string; kind: string; mode: string; setId: string; isRepeat: boolean }) {
  ctx.repo.createAttempt(a);
  ctx.repo.completeAttempt(a.id);
}

function scoreItem(
  ctx: ReturnType<typeof buildTestApp>,
  attemptId: string,
  itemId: string,
  taskType: string,
  score: number,
  scoreJson: unknown = {}
) {
  ctx.repo.insertItemResult({ attemptId, itemId, taskType });
  ctx.repo.updateItemScore({ attemptId, itemId, score, scoreJson: JSON.stringify(scoreJson), scoringStatus: "scored" });
}

// A persisted row is a band only while its Attempt's Items pass the band rule — every Item scored,
// every Task Type present (for Reading and Listening, in each Module the Attempt took) — so each row
// seeded here comes with one scored Item of every Task Type, on the Attempt's own Module Path.
function persistBand(
  ctx: ReturnType<typeof buildTestApp>,
  e: { attemptId: string; section: "speaking" | "writing" | "reading" | "listening"; rawDetail: string; estimatedBand: number; method: string },
) {
  const modulePath = ctx.repo.getAttempt(e.attemptId)?.module_path ?? "upper";
  for (const i of wholeSittingItems(e.section, modulePath)) scoreItem(ctx, e.attemptId, `${i.itemId}-band`, i.taskType, 1, JSON.parse(i.scoreJson));
  ctx.repo.saveSectionEstimate(e);
}

async function putSettings(ctx: ReturnType<typeof buildTestApp>, body: unknown) {
  return ctx.app.request("/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /trends", () => {
  let ctx: ReturnType<typeof buildTestApp>;
  beforeEach(() => {
    ctx = buildTestApp();
  });

  it("400s when taskType is missing or not a recognized TaskType value", async () => {
    const missing = await ctx.app.request("/trends");
    expect(missing.status).toBe(400);
    const invalid = await ctx.app.request("/trends?taskType=not-a-real-type");
    expect(invalid.status).toBe(400);
  });

  // The gate is AnyTaskType (shared/src/schemas/primitives.ts): Reading and Listening Task Types
  // are accepted, and anything else is refused.
  it("accepts a Reading Task Type (complete_words), and rejects a value that is not a Task Type", async () => {
    const ok = await ctx.app.request("/trends?taskType=complete_words");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as TrendPointVM[];
    expect(body).toEqual([]); // no data yet — the point is the gate accepted the query, not that points exist

    const garbage = await ctx.app.request("/trends?taskType=not-a-real-type");
    expect(garbage.status).toBe(400);
  });

  // The Dashboard draws one small multiple per Task Type, and a list asks for all twelve in one
  // request. The gate stays per value, so one bad entry fails the whole request rather than being
  // dropped from the results.
  it("accepts a comma-separated list of task types and returns every one's points in one flat array", async () => {
    completedAttempt(ctx, { id: "att-email", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    scoreItem(ctx, "att-email", "email-a", "email", 4);
    completedAttempt(ctx, { id: "att-bas", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    scoreItem(ctx, "att-bas", "bas-1", "build_sentence", 1);
    completedAttempt(ctx, { id: "att-ctw", kind: "reading", mode: "drill", setId: "rea-1", isRepeat: false });
    scoreItem(ctx, "att-ctw", "ctw-1", "complete_words", 0.5);

    const res = await ctx.app.request("/trends?taskType=email,build_sentence,complete_words");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TrendPointVM[];
    expect(body).toHaveLength(3);
    // Every point still names its own Task Type, which is what the caller groups by.
    expect(body.map((p) => `${p.taskType}:${p.attemptId}`).sort()).toEqual([
      "build_sentence:att-bas",
      "complete_words:att-ctw",
      "email:att-email",
    ]);
  });

  it("400s the whole list when any one entry is not a recognized Task Type", async () => {
    const res = await ctx.app.request("/trends?taskType=email,not-a-real-type");
    expect(res.status).toBe(400);
  });

  it("collapses a repeated task type instead of returning its points twice", async () => {
    completedAttempt(ctx, { id: "att-email", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    scoreItem(ctx, "att-email", "email-a", "email", 4);

    const res = await ctx.app.request("/trends?taskType=email,email");
    const body = (await res.json()) as TrendPointVM[];
    expect(body).toHaveLength(1);
  });

  it("returns one point per attempt (avg of its scored items of that task type), ordered by completion time, with repeats included and flagged (not excluded)", async () => {
    completedAttempt(ctx, { id: "att-1", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    scoreItem(ctx, "att-1", "email-a", "email", 3);
    completedAttempt(ctx, { id: "att-2", kind: "writing", mode: "simulation", setId: "wri-1", isRepeat: true });
    scoreItem(ctx, "att-2", "email-a", "email", 4.5);
    // Different task type — must never appear in the email trend.
    completedAttempt(ctx, { id: "att-3", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    scoreItem(ctx, "att-3", "bas-1", "build_sentence", 1);

    // Out-of-order timestamps: att-2 starts after att-1 but finishes first.
    ctx.db.prepare("UPDATE attempts SET started_at='2026-01-01 00:00:00', completed_at='2026-01-03 00:00:00' WHERE id='att-1'").run();
    ctx.db.prepare("UPDATE attempts SET started_at='2026-01-02 00:00:00', completed_at='2026-01-02 12:00:00' WHERE id='att-2'").run();

    const res = await ctx.app.request("/trends?taskType=email");
    expect(res.status).toBe(200);
    const body = (await res.json()) as TrendPointVM[];
    expect(body.map((p) => p.attemptId)).toEqual(["att-2", "att-1"]);
    // `date` leaves as the ISO instant the stored space form names, so TrendChart's `new Date(...)`
    // is right; the ordering above is the SQL's.
    expect(body[0]).toMatchObject({ attemptId: "att-2", mode: "simulation", isRepeat: true, taskType: "email", avgScore: 4.5, date: "2026-01-02T12:00:00.000Z" });
    expect(body[1]).toMatchObject({ attemptId: "att-1", mode: "drill", isRepeat: false, taskType: "email", avgScore: 3, date: "2026-01-03T00:00:00.000Z" });
  });

  it("averages multiple scored items of the same task type within a single attempt", async () => {
    completedAttempt(ctx, { id: "att-1", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    scoreItem(ctx, "att-1", "bas-1", "build_sentence", 1);
    scoreItem(ctx, "att-1", "bas-2", "build_sentence", 0);

    const res = await ctx.app.request("/trends?taskType=build_sentence");
    const body = (await res.json()) as TrendPointVM[];
    expect(body).toHaveLength(1);
    expect(body[0].avgScore).toBeCloseTo(0.5);
  });

  // The band rule per Task Type (ADR 0010): a point only when every Item of the Task Type is scored,
  // a deliberate skip being a scored 0.
  it("counts a skip as 0 in an Attempt whose Items of the Task Type are all scored", async () => {
    completedAttempt(ctx, { id: "att-1", kind: "speaking", mode: "simulation", setId: "spk-1", isRepeat: false });
    for (let i = 1; i <= 6; i++) scoreItem(ctx, "att-1", `lr-${i}`, "listen_repeat", 3.5, { deductions: [] });
    scoreItem(ctx, "att-1", "lr-7", "listen_repeat", 0, { skipped: true, reason: "No recording was made for this item." });

    const body = (await (await ctx.app.request("/trends?taskType=listen_repeat")).json()) as TrendPointVM[];
    expect(body.map((p) => p.attemptId)).toEqual(["att-1"]);
    expect(body[0].avgScore).toBeCloseTo(3);
  });

  it("gives no point for an Attempt with an Item of the Task Type that is not scored, and ignores other Task Types' Items", async () => {
    completedAttempt(ctx, { id: "att-1", kind: "speaking", mode: "drill", setId: "spk-1", isRepeat: false });
    scoreItem(ctx, "att-1", "lr-1", "listen_repeat", 4, { deductions: [] });
    scoreItem(ctx, "att-1", "int-1", "interview", 4, { deductions: [] });
    ctx.repo.insertItemResult({ attemptId: "att-1", itemId: "int-2", taskType: "interview", scoringStatus: "transcription_pending" });
    ctx.repo.insertItemResult({ attemptId: "att-1", itemId: "int-3", taskType: "interview" });
    ctx.repo.updateItemScore({ attemptId: "att-1", itemId: "int-3", score: null, scoreJson: JSON.stringify({ error: "judges failed" }), scoringStatus: "failed" });

    const body = (await (await ctx.app.request("/trends?taskType=listen_repeat,interview")).json()) as TrendPointVM[];
    expect(body.map((p) => [p.taskType, p.avgScore])).toEqual([["listen_repeat", 4]]);
  });

  it("orders deterministically by attempt insertion order (not attempt id) when two attempts share an identical completed_at", async () => {
    // Ids chosen so alphabetical order is the reverse of creation order: a tiebreak on attempt_id
    // (a random UUID in production) would put "aaa-created-second" first. Only an insertion-order
    // tiebreak (attempts.rowid) gets this right.
    completedAttempt(ctx, { id: "zzz-created-first", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    scoreItem(ctx, "zzz-created-first", "email-a", "email", 3);
    completedAttempt(ctx, { id: "aaa-created-second", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    scoreItem(ctx, "aaa-created-second", "email-a", "email", 4);

    ctx.db.prepare(
      "UPDATE attempts SET completed_at='2026-01-01 00:00:00' WHERE id IN ('zzz-created-first','aaa-created-second')"
    ).run();

    const res = await ctx.app.request("/trends?taskType=email");
    const body = (await res.json()) as TrendPointVM[];
    expect(body.map((p) => p.attemptId)).toEqual(["zzz-created-first", "aaa-created-second"]);
  });
});

describe("GET /summary", () => {
  let ctx: ReturnType<typeof buildTestApp>;
  beforeEach(() => {
    ctx = buildTestApp();
  });

  it("returns nothing to show when there is no data: no section, NO overall band, empty weaknesses, zero judge agreement", async () => {
    const res = await ctx.app.request("/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatsSummaryVM;
    // Nothing stands in for a band that does not exist: every section is absent until it has one.
    expect(body.sections).toEqual([]);
    expect(body.overall).toEqual({ band: null, missingSections: ["reading", "listening", "writing", "speaking"] });
    expect(body.weaknesses).toEqual([]);
    expect(body.judgeAgreement).toEqual({ avgDelta: null, sampleSize: 0 });
  });

  it("surfaces the latest section estimate (band/method/attempt/when) plus its default Target; with three sections missing there is no overall band", async () => {
    ctx.repo.createAttempt({ id: "att-spk", kind: "speaking", mode: "simulation", setId: "spk-1", isRepeat: false });
    ctx.repo.completeAttempt("att-spk", sqliteTimestamp(new Date(Date.UTC(2026, 7, 20, 3, 4, 5))));
    persistBand(ctx, { attemptId: "att-spk", section: "speaking", rawDetail: fullDetail("speaking"), estimatedBand: 4.5, method: "linear-v2" });
    // Stored by an older version; read as nothing.
    ctx.repo.setSetting("pin.reading", "5");
    ctx.repo.setSetting("pin.listening", "6");

    const res = await ctx.app.request("/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatsSummaryVM;
    expect(body.sections).toEqual([
      {
        section: "speaking", band: 4.5, method: "linear-v2", attemptId: "att-spk", mode: "simulation", target: 5.5,
        // Space-form UTC in the column, an ISO instant on the wire.
        attemptedAt: "2026-08-20T03:04:05.000Z",
        recentSimulationRange: { min: 4.5, max: 4.5, count: 1 },
      },
    ]);
    // Never a mean of the sections that exist, and never a Pin standing in for one that does not.
    expect(body.overall).toEqual({ band: null, missingSections: ["reading", "listening", "writing"] });
  });

  it("carries each section's own Target, Reading and Listening included", async () => {
    await putSettings(ctx, { targets: { reading: 6, listening: 4.5 } });
    for (const section of ["reading", "listening"] as const) {
      completedAttempt(ctx, { id: `att-${section}`, kind: section, mode: "simulation", setId: `${section}-1`, isRepeat: false });
      persistBand(ctx, { attemptId: `att-${section}`, section, rawDetail: fullDetail(section), estimatedBand: 5, method: "table3-v1" });
    }
    const body = (await (await ctx.app.request("/summary")).json()) as StatsSummaryVM;
    expect(body.sections.map((s) => [s.section, s.target])).toEqual([["reading", 6], ["listening", 4.5]]);
  });

  // Estimates keep their method as an opaque string and are never recomputed on read, so a row
  // written under linear-v1 still surfaces "linear-v1": the label is what keeps the band
  // interpretable against the weights that produced it.
  it("surfaces a persisted linear-v1 estimate's method verbatim", async () => {
    completedAttempt(ctx, { id: "att-hist", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    persistBand(ctx, { attemptId: "att-hist", section: "writing", rawDetail: fullDetail("writing"), estimatedBand: 4.0, method: "linear-v1" });

    const body = (await (await ctx.app.request("/summary")).json()) as StatsSummaryVM;
    const writing = body.sections.find((s) => s.section === "writing");
    expect(writing?.method).toBe("linear-v1");
    expect(writing?.band).toBe(4.0);
  });

  it("a section is absent until its own estimate exists; the Overall appears with the fourth, as a plain mean", async () => {
    for (const section of ["speaking", "writing", "listening"] as const) {
      completedAttempt(ctx, { id: `att-${section}`, kind: section, mode: "simulation", setId: `${section}-1`, isRepeat: false });
      persistBand(ctx, { attemptId: `att-${section}`, section, rawDetail: fullDetail(section), estimatedBand: 5, method: section === "listening" ? "table3-v1" : "linear-v2" });
    }
    const before = await (await ctx.app.request("/summary")).json() as StatsSummaryVM;
    expect(before.sections.find((s) => s.section === "reading")).toBeUndefined();
    expect(before.overall).toEqual({ band: null, missingSections: ["reading"] });

    completedAttempt(ctx, { id: "att-rd", kind: "reading", mode: "simulation", setId: "rd-1", isRepeat: false });
    persistBand(ctx, { attemptId: "att-rd", section: "reading", rawDetail: fullDetail("reading"), estimatedBand: 4, method: "table3-v1" });

    const after = await (await ctx.app.request("/summary")).json() as StatsSummaryVM;
    expect(after.sections.find((s) => s.section === "reading")).toEqual({
      section: "reading", band: 4, method: "table3-v1", attemptId: "att-rd", mode: "simulation", target: 5.5,
      attemptedAt: expect.any(String),
      recentSimulationRange: { min: 4, max: 4, count: 1 },
    });
    // mean(5, 5, 5, reading 4) = 4.75 -> 5.
    expect(after.overall).toEqual({ band: 5, missingSections: [] });
  });

  it("a routed reading simulation's estimate carries its modulePath, so the Dashboard can disclose it too", async () => {
    completedAttempt(ctx, { id: "att-rd-lower", kind: "reading", mode: "simulation", setId: "rd-1", isRepeat: false });
    ctx.repo.setAttemptRouting("att-rd-lower", "lower", 0.4);
    persistBand(ctx, { attemptId: "att-rd-lower", section: "reading", rawDetail: fullDetail("reading"), estimatedBand: 4.5, method: "table3-v1" });

    const body = (await (await ctx.app.request("/summary")).json()) as StatsSummaryVM;
    expect(body.sections.find((s) => s.section === "reading")).toEqual({
      section: "reading", band: 4.5, method: "table3-v1", attemptId: "att-rd-lower", mode: "simulation", modulePath: "lower", target: 5.5,
      attemptedAt: expect.any(String),
      recentSimulationRange: { min: 4.5, max: 4.5, count: 1 },
    });
  });

  it("an unrouted reading estimate (should not occur in practice) omits modulePath rather than sending null", async () => {
    completedAttempt(ctx, { id: "att-rd-unrouted", kind: "reading", mode: "simulation", setId: "rd-1", isRepeat: false });
    persistBand(ctx, { attemptId: "att-rd-unrouted", section: "reading", rawDetail: fullDetail("reading"), estimatedBand: 3, method: "table3-v1" });

    const body = (await (await ctx.app.request("/summary")).json()) as StatsSummaryVM;
    const reading = body.sections.find((s) => s.section === "reading");
    expect(reading).toEqual({
      section: "reading", band: 3, method: "table3-v1", attemptId: "att-rd-unrouted", mode: "simulation", target: 5.5,
      attemptedAt: expect.any(String),
      recentSimulationRange: { min: 3, max: 3, count: 1 },
    });
    expect(reading).not.toHaveProperty("modulePath");
  });

  it("a Repeat reading simulation's estimate never surfaces — the section stays absent (latestEstimate's is_repeat exclusion, same as every section)", async () => {
    completedAttempt(ctx, { id: "att-rd-repeat", kind: "reading", mode: "simulation", setId: "rd-1", isRepeat: true });
    persistBand(ctx, { attemptId: "att-rd-repeat", section: "reading", rawDetail: fullDetail("reading"), estimatedBand: 2, method: "table3-v1" });

    const body = await (await ctx.app.request("/summary")).json() as StatsSummaryVM;
    expect(body.sections.find((s) => s.section === "reading")).toBeUndefined();
  });

  it("reflects a custom target set via PUT /settings", async () => {
    await putSettings(ctx, { targets: { writing: 6 } });
    completedAttempt(ctx, { id: "att-wri", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    persistBand(ctx, { attemptId: "att-wri", section: "writing", rawDetail: fullDetail("writing"), estimatedBand: 4.0, method: "linear-v2" });

    const res = await ctx.app.request("/summary");
    const body = (await res.json()) as StatsSummaryVM;
    expect(body.sections.find((s) => s.section === "writing")?.target).toBe(6);
  });

  it("weaknesses count deduction categories across only the last 20 scored items (older items excluded), sorted by count desc", async () => {
    ctx.repo.createAttempt({ id: "att-w", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    for (let i = 1; i <= 5; i++) {
      scoreItem(ctx, "att-w", `stale-${i}`, "email", 3, { deductions: [{ category: "stale-only", quote: "x", issue: "y", fix: "z" }] });
    }
    for (let i = 1; i <= 15; i++) {
      scoreItem(ctx, "att-w", `g-${i}`, "email", 3, { deductions: [{ category: "grammar", quote: "x", issue: "y", fix: "z" }] });
    }
    for (let i = 1; i <= 5; i++) {
      scoreItem(ctx, "att-w", `v-${i}`, "email", 3, { deductions: [{ category: "vocab", quote: "x", issue: "y", fix: "z" }] });
    }

    const res = await ctx.app.request("/summary");
    const body = (await res.json()) as StatsSummaryVM;
    expect(body.weaknesses).toEqual([
      { category: "grammar", count: 15 },
      { category: "vocab", count: 5 },
    ]);
  });

  it("weaknesses tolerates corrupt score_json and items with no deductions array (e.g. build_sentence) without erroring", async () => {
    ctx.repo.createAttempt({ id: "att-d", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    ctx.repo.insertItemResult({ attemptId: "att-d", itemId: "corrupt-1", taskType: "email" });
    ctx.repo.updateItemScore({ attemptId: "att-d", itemId: "corrupt-1", score: 3, scoringStatus: "scored", scoreJson: "{not valid json" });
    scoreItem(ctx, "att-d", "bas-1", "build_sentence", 1, { correct: true, correctAnswers: [["a"]] });
    scoreItem(ctx, "att-d", "email-1", "email", 3, { deductions: [{ category: "coherence", quote: "x", issue: "y", fix: "z" }] });

    const res = await ctx.app.request("/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatsSummaryVM;
    expect(body.weaknesses).toEqual([{ category: "coherence", count: 1 }]);
  });

  // skillItems is a thin pass-through (section, skill and correctness of each recently scored
  // Reading or Listening question). Bucketing, minimum counts and sorting belong to
  // client/src/pages/weaknessCategories.ts's computeSkillAccuracy, tested there. These tests pin what
  // the server must get right: which rows are included, and which section a Task Type maps to.
  describe("skillItems", () => {
    it("passes through section+skill+correct for Reading and Listening MCQ items, keeping same-named skills from each section DISTINCT by section", async () => {
      ctx.repo.createAttempt({ id: "att-rl", kind: "reading", mode: "drill", setId: "rd-1", isRepeat: false });
      // "detail" and "inference" are category names in both ReadingSkillCategory and
      // ListeningSkillCategory, so the section is what keeps them apart.
      scoreItem(ctx, "att-rl", "dl-1", "daily_life", 1, { correct: true, skill: "detail", module: "router", answer: "a" });
      scoreItem(ctx, "att-rl", "dl-2", "daily_life", 0, { correct: false, skill: "detail", module: "router", answer: "b" });
      scoreItem(ctx, "att-rl", "lc-1", "listen_choose", 1, { correct: true, skill: "detail", module: "router", answer: "a" });
      scoreItem(ctx, "att-rl", "tk-1", "academic_talk", 0, { correct: false, skill: "inference", module: "router", answer: "b" });

      const res = await ctx.app.request("/summary");
      const body = (await res.json()) as StatsSummaryVM;
      expect(body.skillItems).toEqual(
        expect.arrayContaining([
          { section: "reading", skill: "detail", correct: true },
          { section: "reading", skill: "detail", correct: false },
          { section: "listening", skill: "detail", correct: true },
          { section: "listening", skill: "inference", correct: false },
        ]),
      );
      expect(body.skillItems).toHaveLength(4);
    });

    // Nothing in the route enumerates ReadingSkillCategory, so a new category reaches the weakness
    // breakdown with no route change. A route that grew a hardcoded category list would drop these
    // three rows silently, and the Progress page would never show those skills.
    it("passes through the academic-passage skill categories with no per-category allowlist", async () => {
      ctx.repo.createAttempt({ id: "att-ap", kind: "reading", mode: "drill", setId: "rd-1", isRepeat: false });
      scoreItem(ctx, "att-ap", "ap-1", "academic_passage", 1, { correct: true, skill: "figurative_language", module: "upper", answer: "a" });
      scoreItem(ctx, "att-ap", "ap-2", "academic_passage", 0, { correct: false, skill: "grammatical_complexity", module: "upper", answer: "b" });
      scoreItem(ctx, "att-ap", "ap-3", "academic_passage", 1, { correct: true, skill: "rhetorical_structure", module: "upper", answer: "c" });

      const res = await ctx.app.request("/summary");
      const body = (await res.json()) as StatsSummaryVM;
      // Recency order, as in the case above; what matters is that all three survive.
      expect(body.skillItems).toEqual(
        expect.arrayContaining([
          { section: "reading", skill: "figurative_language", correct: true },
          { section: "reading", skill: "grammatical_complexity", correct: false },
          { section: "reading", skill: "rhetorical_structure", correct: true },
        ]),
      );
      expect(body.skillItems).toHaveLength(3);
    });

    it("excludes complete_words (no skill category at all) even if its score_json somehow carried a skill key", async () => {
      ctx.repo.createAttempt({ id: "att-ctw", kind: "reading", mode: "drill", setId: "rd-1", isRepeat: false });
      scoreItem(ctx, "att-ctw", "ctw-1-g1", "complete_words", 1, { correct: true, module: "router", answer: "x", skill: "should-never-appear" });

      const res = await ctx.app.request("/summary");
      const body = (await res.json()) as StatsSummaryVM;
      expect(body.skillItems).toEqual([]);
    });

    it("tolerates corrupt score_json and a missing/wrong-typed skill or correct without erroring", async () => {
      ctx.repo.createAttempt({ id: "att-bad", kind: "listening", mode: "drill", setId: "lsn-1", isRepeat: false });
      ctx.repo.insertItemResult({ attemptId: "att-bad", itemId: "corrupt-1", taskType: "listen_choose" });
      ctx.repo.updateItemScore({ attemptId: "att-bad", itemId: "corrupt-1", score: 1, scoringStatus: "scored", scoreJson: "{not valid json" });
      scoreItem(ctx, "att-bad", "no-skill-1", "conversation", 1, { correct: true, module: "router", answer: "a" }); // skill missing
      scoreItem(ctx, "att-bad", "bad-correct-1", "announcement", 1, { correct: "yes", skill: "detail", module: "router", answer: "a" }); // correct not boolean
      scoreItem(ctx, "att-bad", "good-1", "academic_talk", 1, { correct: true, skill: "gist", module: "router", answer: "a" });

      const res = await ctx.app.request("/summary");
      expect(res.status).toBe(200);
      const body = (await res.json()) as StatsSummaryVM;
      expect(body.skillItems).toEqual([{ section: "listening", skill: "gist", correct: true }]);
    });

    it("never includes Speaking/Writing items", async () => {
      ctx.repo.createAttempt({ id: "att-sw", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
      scoreItem(ctx, "att-sw", "email-1", "email", 3, { deductions: [] });

      const res = await ctx.app.request("/summary");
      const body = (await res.json()) as StatsSummaryVM;
      expect(body.skillItems).toEqual([]);
    });
  });

  it("judgeAgreement averages |gemini-openai| across matched (attempt,item) pairs only; unmatched single-judge rows are excluded, corrupt rows are skipped", async () => {
    ctx.repo.createAttempt({ id: "att-j", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    const rpt = (judge: "gemini" | "openai", itemId: string, score: number) =>
      JSON.stringify({ judge, taskType: "email", items: [{ itemId, score, dimensions: [], deductions: [] }] });
    ctx.repo.insertJudgeReport({ attemptId: "att-j", itemId: "item-a", judge: "gemini", reportJson: rpt("gemini", "item-a", 4) });
    ctx.repo.insertJudgeReport({ attemptId: "att-j", itemId: "item-a", judge: "openai", reportJson: rpt("openai", "item-a", 3) });
    ctx.repo.insertJudgeReport({ attemptId: "att-j", itemId: "item-b", judge: "gemini", reportJson: rpt("gemini", "item-b", 4.5) });
    ctx.repo.insertJudgeReport({ attemptId: "att-j", itemId: "item-b", judge: "openai", reportJson: rpt("openai", "item-b", 4) });
    // Unmatched: only gemini scored item-c.
    ctx.repo.insertJudgeReport({ attemptId: "att-j", itemId: "item-c", judge: "gemini", reportJson: rpt("gemini", "item-c", 2) });
    // Corrupt row must not crash the route.
    ctx.repo.insertJudgeReport({ attemptId: "att-j", itemId: "item-d", judge: "openai", reportJson: "{not valid json" });

    const res = await ctx.app.request("/summary");
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatsSummaryVM;
    expect(body.judgeAgreement.sampleSize).toBe(2);
    expect(body.judgeAgreement.avgDelta).toBeCloseTo((1 + 0.5) / 2);
  });
});

describe("GET /settings", () => {
  let ctx: ReturnType<typeof buildTestApp>;
  beforeEach(() => {
    ctx = buildTestApp();
  });

  it("returns a 5.5 Target for every section when nothing has been set, without persisting anything", async () => {
    const res = await ctx.app.request("/settings");
    expect(res.status).toBe(200);
    expect((await res.json()) as StatsSettingsVM).toEqual({
      targets: { reading: 5.5, listening: 5.5, writing: 5.5, speaking: 5.5 },
    });
    // A read must not be a write: no setting rows should exist after a bare GET.
    expect(ctx.repo.getSetting("target.speaking")).toBeNull();
  });

  it("reflects values previously persisted via PUT (a pure read, not the empty-patch PUT trick)", async () => {
    await putSettings(ctx, { targets: { writing: 6, reading: 4.5 } });

    const res = await ctx.app.request("/settings");
    expect(res.status).toBe(200);
    expect((await res.json()) as StatsSettingsVM).toEqual({
      targets: { reading: 4.5, listening: 5.5, writing: 6, speaking: 5.5 },
    });
  });

  // A Pin was a stand-in band, not a goal: a value an older version stored is neither reported nor
  // read as the section's Target.
  it("reads a stored Pin as nothing", async () => {
    ctx.repo.setSetting("pin.reading", "4");
    ctx.repo.setSetting("pin.listening", "6");

    const body = (await (await ctx.app.request("/settings")).json()) as StatsSettingsVM & { pins?: unknown };
    expect(body).toEqual({ targets: { reading: 5.5, listening: 5.5, writing: 5.5, speaking: 5.5 } });
    expect(body.pins).toBeUndefined();
  });
});

describe("PUT /settings", () => {
  let ctx: ReturnType<typeof buildTestApp>;
  beforeEach(() => {
    ctx = buildTestApp();
  });

  it("persists a partial patch merged with previously-set values (untouched keys survive)", async () => {
    const res1 = await putSettings(ctx, { targets: { reading: 5 } });
    expect(res1.status).toBe(200);
    expect((await res1.json()) as StatsSettingsVM).toEqual({
      targets: { reading: 5, listening: 5.5, writing: 5.5, speaking: 5.5 },
    });

    const res2 = await putSettings(ctx, { targets: { listening: 4.5, speaking: 6 } });
    const body2 = (await res2.json()) as StatsSettingsVM;
    expect(body2).toEqual({ targets: { reading: 5, listening: 4.5, writing: 5.5, speaking: 6 } });
  });

  // A tab still running an older client can send the Pins it knew about. That is not an error, and
  // it changes nothing: the request succeeds, writes no Pin and no Target, and answers the current
  // shape.
  it("accepts and ignores Pins from an older client", async () => {
    const res = await putSettings(ctx, { pins: { reading: 4, listening: 6 }, targets: { writing: 6 } });
    expect(res.status).toBe(200);
    expect((await res.json()) as StatsSettingsVM).toEqual({
      targets: { reading: 5.5, listening: 5.5, writing: 6, speaking: 5.5 },
    });
    expect(ctx.repo.getSetting("pin.reading")).toBeNull();
    expect(ctx.repo.getSetting("target.reading")).toBeNull();
  });

  it("400s on an out-of-range value, an off-half-step value, or invalid JSON", async () => {
    expect((await putSettings(ctx, { targets: { speaking: 7 } })).status).toBe(400);
    expect((await putSettings(ctx, { targets: { reading: 5.25 } })).status).toBe(400);
    const invalidJson = await ctx.app.request("/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(invalidJson.status).toBe(400);
  });
});
