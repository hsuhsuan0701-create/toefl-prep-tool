import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FULL_TEST_SECTION_ORDER, type FullTestRunVM, type FullTestSection, type ReadingSet, type StatsSummaryVM } from "@toefl-prep/shared";
import { Hono } from "hono";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { wholeSittingItems } from "./helpers/wholeSitting.js";
import { config } from "../src/lib/config.js";
import { buildAttemptsRoutes } from "../src/routes/attempts.js";
import { buildFullTestRoutes } from "../src/routes/fullTests.js";
import { buildStatsRoutes } from "../src/routes/stats.js";
import { deriveFullTestOverall, FULL_TEST_OVERALL_METHOD, pickFullTestSets } from "../src/services/fullTestRun.js";
import { maxScoreFor, requiredTaskTypes } from "../src/services/bandEstimator.js";

// The Full-Test Run: its own table and API, four sections sat through their own Simulations in ETS
// order with the order enforced, and the Run completed once it steps past Speaking.
//
// The Set bank is injected (buildFullTestRoutes' listSetBank) rather than read off disk: selection
// rules such as "prefer an unattempted Set" or "never reuse another Run's Set" can only be asserted
// against a known bank, and config.dataDir holds the whole seeded bank plus this file's fixtures.

// The Sets that also have to exist on disk, since POST /api/attempts reads the Set before creating a
// section's Attempt. Reading's two are hand-built and minimal: every test writes its item_results
// through the repo rather than answering real Items, so the Modules can be empty. The other three
// kinds are too large to hand-build honestly (a Speaking Set needs seven Listen and Repeat Items on
// a validated response-window ramp), so one banked Set of each is copied under this file's own id.
// That keeps the fixture valid as the bank changes, and never overwrites a banked Set.
const DISK_SET_ID = "rd-ft78disk";
const OTHER_DISK_SET_ID = "rd-ft78other";
const LISTENING_SET_ID = "lsn-ft79disk";
const WRITING_SET_ID = "wri-ft79disk";
const SPEAKING_SET_ID = "spk-ft79disk";
// A second Writing Set, on disk but not in the bank a Run draws from. The Simulation-preference test
// needs a Drill on a Set the Run did not sit, so the Drill is not a Repeat: latestEstimate excludes
// Repeats, and a Drill excluded for that reason would prove nothing about Simulation preference.
const WRITING_DRILL_SET_ID = "wri-ft80drill";

function diskSet(id: string): ReadingSet {
  return {
    id,
    kind: "reading",
    source: "generated",
    createdAt: "2026-08-23T00:00:00.000Z",
    router: { timeLimitSec: 1200, ctwPassages: [], dailyLife: [], academic: [] },
    lowerModule: { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] },
    upperModule: { timeLimitSec: 540, ctwPassages: [], dailyLife: [], academic: [] },
  };
}

function setFile(kind: string, id: string): string {
  return path.join(config.dataDir, "question-sets", kind, `${id}.json`);
}

// A banked Set's file name: a section prefix and eight hex digits. The fixtures this file writes
// beside them never have that shape, so a copy is always made from a banked Set.
const BANKED_SET_FILE = /^[a-z]+-[0-9a-f]{8}\.json$/;

/**
 * Copies the first banked Set of `kind` out of the seeded bank under `id`.
 */
function copyBankSet(kind: "listening" | "writing" | "speaking", id: string): string {
  const dir = path.join(config.dataDir, "question-sets", kind);
  const source = fs.readdirSync(dir).filter((f) => BANKED_SET_FILE.test(f)).sort()[0];
  if (!source) throw new Error(`no ${kind} Set in the seeded bank to copy a fixture from`);
  const set = JSON.parse(fs.readFileSync(path.join(dir, source), "utf8")) as Record<string, unknown>;
  set.id = id;
  const file = setFile(kind, id);
  fs.writeFileSync(file, JSON.stringify(set));
  return file;
}

const DISK_FILES: string[] = [];

// One Set per section, every section runnable: a Run missing any section's Set is refused at
// creation (see below).
const BANK = [
  { id: DISK_SET_ID, kind: "reading" },
  { id: OTHER_DISK_SET_ID, kind: "reading" },
  { id: LISTENING_SET_ID, kind: "listening" },
  { id: WRITING_SET_ID, kind: "writing" },
  { id: SPEAKING_SET_ID, kind: "speaking" },
] as const;

/** A four-kind bank built around a caller's own Reading Sets — the minimum a Run can be created on. */
function bankWith(...readingIds: string[]): { id: string; kind: string }[] {
  return [
    ...readingIds.map((id) => ({ id, kind: "reading" })),
    { id: LISTENING_SET_ID, kind: "listening" },
    { id: WRITING_SET_ID, kind: "writing" },
    { id: SPEAKING_SET_ID, kind: "speaking" },
  ];
}

beforeAll(() => {
  for (const id of [DISK_SET_ID, OTHER_DISK_SET_ID]) {
    const file = setFile("reading", id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(diskSet(id)));
    DISK_FILES.push(file);
  }
  DISK_FILES.push(copyBankSet("listening", LISTENING_SET_ID));
  DISK_FILES.push(copyBankSet("writing", WRITING_SET_ID));
  DISK_FILES.push(copyBankSet("writing", WRITING_DRILL_SET_ID));
  DISK_FILES.push(copyBankSet("speaking", SPEAKING_SET_ID));
});
afterAll(() => {
  for (const file of DISK_FILES) fs.rmSync(file, { force: true });
});

function harness(bank: readonly { id: string; kind: string }[] = BANK) {
  const db = openDb(":memory:");
  const r = sqliteStores(db);
  const app = new Hono()
    .route("/full-tests", buildFullTestRoutes({ repo: r, listSetBank: () => bank }))
    .route(
      "/attempts",
      buildAttemptsRoutes({
        repo: r,
        transcriptionRecovery: { readAttemptSnapshot: () => new Map() },
        speakingFinalization: {},
        onScoringTerminal: async () => undefined,
      } as never),
    )
    // The Dashboard's source for the latest estimate per section, mounted so a Full-Test section's
    // standing in that choice is asserted end to end over one database rather than inferred from
    // the repo query alone.
    .route("/stats", buildStatsRoutes({ repo: r }));
  return { db, r, app };
}

async function createRun(app: Hono, body?: unknown): Promise<{ status: number; run: FullTestRunVM }> {
  const res = await app.request("/full-tests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, run: (await res.json()) as FullTestRunVM };
}

async function startSection(h: ReturnType<typeof harness>, runId: string, kind: FullTestSection, setId: string) {
  const created = await h.app.request("/attempts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, mode: "simulation", setId, fullTestRunId: runId }),
  });
  return { status: created.status, body: (await created.json()) as { attemptId?: string; error?: string } };
}

/** Drives a Run's Reading section all the way to a completed, band-bearing Attempt. */
async function sitReading(h: ReturnType<typeof harness>, runId: string, setId = DISK_SET_ID) {
  const { body } = await startSection(h, runId, "reading", setId);
  const attemptId = body.attemptId!;

  // Stands in for the Simulation's scoring and routing, which routes.attempts.reading.test.ts
  // covers: all that matters here is that the Attempt reaches the state /complete grants a band for,
  // a routed Simulation with every Task Type scored.
  scoreEveryTaskType(h, attemptId, "reading");
  h.r.setAttemptRouting(attemptId, "upper", 0.8);

  const completed = await h.app.request(`/attempts/${attemptId}/complete`, { method: "POST" });
  return { attemptId, completeStatus: completed.status };
}

/**
 * Drives one section of a Run to the state its own runner leaves the Attempt in.
 *
 * Reading, Listening and Writing end at a completed Attempt, through the POST /:id/complete their
 * Simulations call. Speaking does not: a Speaking Simulation ends at capture-finished, with the
 * Judges still running and the Attempt 'in_progress' until reconciliation completes it, so this
 * writes that marker and nothing else. A Run that waited for the Judges before moving past Speaking
 * would strand the User at the end of an exam that is, for them, over.
 */
async function sitSection(h: ReturnType<typeof harness>, runId: string, section: FullTestSection): Promise<string> {
  const setId = SECTION_SET_IDS[section];
  const { status, body } = await startSection(h, runId, section, setId);
  expect(status).toBe(201);
  const attemptId = body.attemptId!;

  if (section === "speaking") {
    h.r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, placeholders: [] });
    return attemptId;
  }

  scoreEveryTaskType(h, attemptId, section);
  if (section === "reading" || section === "listening") h.r.setAttemptRouting(attemptId, "upper", 0.8);

  const completed = await h.app.request(`/attempts/${attemptId}/complete`, { method: "POST" });
  expect(completed.status).toBe(200);
  return attemptId;
}

/**
 * One scored Item of every Task Type the section's band needs — the least an Attempt can carry and
 * still have a band; for Reading and Listening, in each Module of the Upper path
 * (wholeSittingItems). Deterministic Items are answered right; judged Items score `judgedScore` of 5.
 */
function scoreEveryTaskType(h: ReturnType<typeof harness>, attemptId: string, section: FullTestSection, judgedScore = 1) {
  for (const { itemId, taskType, scoreJson } of wholeSittingItems(section, "upper")) {
    h.r.insertItemResult({ attemptId, itemId, taskType });
    const score = maxScoreFor(taskType) === 1 ? 1 : judgedScore;
    h.r.updateItemScore({ attemptId, itemId, score, scoreJson, scoringStatus: "scored" });
  }
}

const SECTION_SET_IDS: Record<FullTestSection, string> = {
  reading: DISK_SET_ID,
  listening: LISTENING_SET_ID,
  writing: WRITING_SET_ID,
  speaking: SPEAKING_SET_ID,
};


describe("POST /api/full-tests creates a run over the whole test", () => {
  it("lists the four sections in ETS order with a Set each, all runnable and only Reading launchable", async () => {
    const h = harness();
    const { status, run } = await createRun(h.app);

    expect(status).toBe(201);
    expect(run.sections.map((s) => s.section)).toEqual(["reading", "listening", "writing", "speaking"]);
    expect(run.sections.map((s) => s.order)).toEqual([1, 2, 3, 4]);
    expect(run.status).toBe("in-progress");
    expect(run.currentSection).toBe("reading");
    expect(run.completedAt).toBeNull();

    for (const section of run.sections) {
      expect(section.state).toBe("pending");
      expect(section.attemptId).toBeNull();
      expect(section.estimate).toBeNull();
      expect(section.setId).not.toBeNull();
    }
    // Every section has a runner...
    expect(run.sections.filter((s) => s.runnable).map((s) => s.section)).toEqual([
      "reading",
      "listening",
      "writing",
      "speaking",
    ]);
    // ...and exactly one of them may be started, which is the exam's order.
    expect(run.sections.filter((s) => s.launchable).map((s) => s.section)).toEqual(["reading"]);
  });

  it("persists across a server restart — a fresh route instance over the same database sees it", async () => {
    const h = harness();
    const { run } = await createRun(h.app);

    // A new Hono app and a new repo over the same database handle: whatever the first app held in
    // memory is gone, and only what it wrote survives.
    const restarted = new Hono().route("/full-tests", buildFullTestRoutes({ repo: sqliteStores(h.db), listSetBank: () => BANK }));
    const reloaded = (await (await restarted.request(`/full-tests/${run.id}`)).json()) as FullTestRunVM;

    expect(reloaded.id).toBe(run.id);
    expect(reloaded.sections.map((s) => s.section)).toEqual(["reading", "listening", "writing", "speaking"]);
    expect(reloaded.sections.map((s) => s.setId)).toEqual(run.sections.map((s) => s.setId));
    expect(reloaded.currentSection).toBe("reading");
  });

  it("draws a different Reading Set for a second run while an alternative remains", async () => {
    const h = harness(bankWith("rd-a", "rd-b"));
    const first = (await createRun(h.app)).run;
    const second = (await createRun(h.app)).run;

    const readingOf = (run: FullTestRunVM) => run.sections.find((s) => s.section === "reading")!.setId;
    expect(readingOf(first)).not.toBe(readingOf(second));
    expect([readingOf(first), readingOf(second)].sort()).toEqual(["rd-a", "rd-b"]);
  });

  // A Run started by mistake and abandoned at once sat nothing, so it holds no claim on its Sets: the
  // next Run may draw them. A Set a section did sit stays claimed, as the attempted rule
  // (ATTEMPT_COUNTS_AS_SITTING_SQL) already counts it.
  it("lets a later run draw the Sets an abandoned run reserved but never sat", async () => {
    const h = harness(bankWith("rd-a", "rd-b"));
    const first = (await createRun(h.app)).run;
    expect((await h.app.request(`/full-tests/${first.id}/abandon`, { method: "POST" })).status).toBe(200);

    const second = (await createRun(h.app)).run;
    expect(second.sections.map((s) => s.setId)).toEqual(first.sections.map((s) => s.setId));
    // The second Run is in progress, so it claims them again.
    const third = (await createRun(h.app)).run;
    expect(third.sections.find((s) => s.section === "reading")!.setId).toBe("rd-b");
  });

  it("keeps a Set claimed when the abandoned run's section sat it", async () => {
    const h = harness(bankWith(DISK_SET_ID, OTHER_DISK_SET_ID));
    const first = (await createRun(h.app)).run;
    expect(first.sections.find((s) => s.section === "reading")!.setId).toBe(DISK_SET_ID);
    await sitReading(h, first.id);
    expect((await h.app.request(`/full-tests/${first.id}/abandon`, { method: "POST" })).status).toBe(200);
    // The other Reading Set sat more recently, so least-recently-attempted alone would choose the
    // abandoned Run's Set: only its claim keeps the next Run off it.
    h.r.createAttempt({ id: "att-other", kind: "reading", mode: "drill", setId: OTHER_DISK_SET_ID, isRepeat: false });
    h.r.insertItemResult({ attemptId: "att-other", itemId: "r-1", taskType: "complete_words" });
    h.r.updateItemScore({ attemptId: "att-other", itemId: "r-1", score: 1, scoreJson: "{}", scoringStatus: "scored" });
    h.db.prepare("UPDATE attempts SET started_at='2999-01-01 00:00:00' WHERE id='att-other'").run();

    const second = (await createRun(h.app)).run;
    expect(second.sections.find((s) => s.section === "reading")!.setId).toBe(OTHER_DISK_SET_ID);
  });

  it("honours an explicit Set per section, and refuses one that is unknown or of the wrong kind", async () => {
    const h = harness();
    const chosen = await createRun(h.app, { sets: { reading: OTHER_DISK_SET_ID } });
    expect(chosen.run.sections.find((s) => s.section === "reading")!.setId).toBe(OTHER_DISK_SET_ID);

    const wrongKind = await h.app.request("/full-tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sets: { reading: WRITING_SET_ID } }),
    });
    expect(wrongKind.status).toBe(400);

    const unknown = await h.app.request("/full-tests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sets: { reading: "rd-nope" } }),
    });
    expect(unknown.status).toBe(400);
  });

  it("refuses to start a run at all when the bank has no Reading Set", async () => {
    const h = harness([{ id: "wri-a", kind: "writing" }]);
    const res = await h.app.request("/full-tests", { method: "POST" });
    expect(res.status).toBe(400);
  });

  // A Run missing any one Set could never be finished: it would lock at that section with no
  // Attempt to create and no way to advance.
  it("refuses to start when any single section has no Set, naming the section", async () => {
    const h = harness([
      { id: "rd-a", kind: "reading" },
      { id: "lsn-a", kind: "listening" },
      { id: "wri-a", kind: "writing" },
    ]);
    const res = await h.app.request("/full-tests", { method: "POST" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining("speaking") });
  });

  it("GET /api/full-tests lists runs newest first", async () => {
    const h = harness();
    const first = (await createRun(h.app)).run;
    const second = (await createRun(h.app)).run;
    const list = (await (await h.app.request("/full-tests")).json()) as FullTestRunVM[];
    expect(list.map((r) => r.id)).toEqual([second.id, first.id]);
  });

  it("GET /api/full-tests/:id 404s an unknown run", async () => {
    const h = harness();
    expect((await h.app.request("/full-tests/nope")).status).toBe(404);
  });
});

describe("the Reading section runs inside the run and advances it", () => {
  it("links the Attempt the Reading Simulation creates, and reports the section in progress", async () => {
    const h = harness();
    const { run } = await createRun(h.app, { sets: { reading: DISK_SET_ID } });

    const created = await h.app.request("/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "reading", mode: "simulation", setId: DISK_SET_ID, fullTestRunId: run.id }),
    });
    expect(created.status).toBe(201);
    const { attemptId } = (await created.json()) as { attemptId: string };

    const fresh = (await (await h.app.request(`/full-tests/${run.id}`)).json()) as FullTestRunVM;
    const reading = fresh.sections.find((s) => s.section === "reading")!;
    expect(reading.attemptId).toBe(attemptId);
    expect(reading.state).toBe("in-progress");
    // The Attempt is an ordinary Simulation Attempt: the Run changes nothing about how it is
    // created, timed or scored.
    expect(h.r.getAttempt(attemptId)?.mode).toBe("simulation");
  });

  it("records the completed Attempt with its Band Estimate and advances the run to Listening", async () => {
    const h = harness();
    const { run } = await createRun(h.app, { sets: { reading: DISK_SET_ID } });
    const { attemptId, completeStatus } = await sitReading(h, run.id);
    expect(completeStatus).toBe(200);

    const advanced = await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
    expect(advanced.status).toBe(200);
    const after = (await advanced.json()) as FullTestRunVM;

    expect(after.currentSection).toBe("listening");
    const reading = after.sections.find((s) => s.section === "reading")!;
    expect(reading.state).toBe("completed");
    expect(reading.attemptId).toBe(attemptId);
    expect(reading.estimate?.method).toBe("table3-v1");
    expect(typeof reading.estimate?.band).toBe("number");
    // The Run reports its Overall band only once every section has one. One section in, there is
    // nothing to report (deriveFullTestOverall).
    expect(after.overall.band).toBeNull();
    expect(after.overall.pendingSections).toEqual(["listening", "writing", "speaking"]);
    // And nothing was invented for the sections nobody has sat yet.
    expect(after.sections.filter((s) => s.state !== "pending").map((s) => s.section)).toEqual(["reading"]);
    // The handoff moves which section may be started, and only that one.
    expect(after.sections.filter((s) => s.launchable).map((s) => s.section)).toEqual(["listening"]);
  });

  it("refuses to advance while the current section is unfinished", async () => {
    const h = harness();
    const { run } = await createRun(h.app, { sets: { reading: DISK_SET_ID } });

    const tooEarly = await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
    expect(tooEarly.status).toBe(409);

    await h.app.request("/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "reading", mode: "simulation", setId: DISK_SET_ID, fullTestRunId: run.id }),
    });
    const midSection = await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
    expect(midSection.status).toBe(409);
  });

  it("does not skip a second section when advance is called twice", async () => {
    const h = harness();
    const { run } = await createRun(h.app, { sets: { reading: DISK_SET_ID } });
    await sitReading(h, run.id);

    expect((await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" })).status).toBe(200);
    // Listening has no Attempt, so it is not finished, so the run stays where it is.
    expect((await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" })).status).toBe(409);
    const still = (await (await h.app.request(`/full-tests/${run.id}`)).json()) as FullTestRunVM;
    expect(still.currentSection).toBe("listening");
  });

  it("reads no body at the handoff: a request that sends one is advanced like any other", async () => {
    const h = harness();
    const { run } = await createRun(h.app, { sets: { reading: DISK_SET_ID } });
    await sitReading(h, run.id);

    const res = await h.app.request(`/full-tests/${run.id}/advance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paused: true }),
    });
    expect(res.status).toBe(200);
    const after = (await res.json()) as FullTestRunVM;
    expect(after.currentSection).toBe("listening");
  });

  it("refuses to sit a section a second time once it is complete, and refuses the wrong Set", async () => {
    const h = harness();
    const { run } = await createRun(h.app, { sets: { reading: DISK_SET_ID } });

    // A real, loadable Reading Set — just not the one this Run drew for its Reading section.
    const wrongSet = await h.app.request("/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "reading", mode: "simulation", setId: OTHER_DISK_SET_ID, fullTestRunId: run.id }),
    });
    expect(wrongSet.status).toBe(400);

    await sitReading(h, run.id);
    const again = await h.app.request("/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "reading", mode: "simulation", setId: DISK_SET_ID, fullTestRunId: run.id }),
    });
    expect(again.status).toBe(409);
  });

  it("refuses to link an Attempt to an unknown run, and never leaves one behind when it does", async () => {
    const h = harness();
    const before = h.r.listAttempts().length;
    const res = await h.app.request("/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "reading", mode: "simulation", setId: DISK_SET_ID, fullTestRunId: "no-such-run" }),
    });
    expect(res.status).toBe(404);
    expect(h.r.listAttempts().length).toBe(before);
  });

  it("refuses with 400 to link a Drill as a section, and leaves no Attempt and no link behind", async () => {
    const h = harness();
    const { run } = await createRun(h.app, { sets: { reading: DISK_SET_ID } });
    const before = h.r.listAttempts().length;

    const res = await h.app.request("/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "reading", mode: "drill", setId: DISK_SET_ID, fullTestRunId: run.id }),
    });
    expect(res.status).toBe(400);
    expect(h.r.listAttempts().length).toBe(before);
    expect(h.r.getFullTestRun(run.id)!.reading_attempt_id).toBeNull();

    // The same section still takes its Simulation.
    const { status } = await startSection(h, run.id, "reading", DISK_SET_ID);
    expect(status).toBe(201);
  });

  it("leaves a standalone Simulation untouched — no run, no link, same 201", async () => {
    const h = harness();
    const res = await h.app.request("/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "reading", mode: "simulation", setId: DISK_SET_ID }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ isRepeat: expect.any(Boolean) });
    expect(body.fullTestRunId).toBeUndefined();
  });
});

// The whole chain: all four sections, in ETS order, in one sitting.
describe("all four sections run in ETS order inside one run", () => {
  const ETS_ORDER: FullTestSection[] = ["reading", "listening", "writing", "speaking"];

  async function newRun(h: ReturnType<typeof harness>) {
    const { run } = await createRun(h.app, { sets: SECTION_SET_IDS });
    return run;
  }

  it("carries one sitting through Reading, Listening, Writing and Speaking and completes the run", async () => {
    const h = harness();
    const run = await newRun(h);
    const attemptIds: Record<string, string> = {};

    for (const [i, section] of ETS_ORDER.entries()) {
      const before = (await (await h.app.request(`/full-tests/${run.id}`)).json()) as FullTestRunVM;
      // Exactly one section is startable at a time, and it is this one.
      expect(before.currentSection).toBe(section);
      expect(before.sections.filter((s) => s.launchable).map((s) => s.section)).toEqual([section]);

      attemptIds[section] = await sitSection(h, run.id, section);

      const advanced = await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
      expect(advanced.status).toBe(200);
      const after = (await advanced.json()) as FullTestRunVM;
      // Everything sat so far reads finished; nothing further along has been touched.
      expect(after.sections.filter((s) => s.state === "completed").map((s) => s.section)).toEqual(
        ETS_ORDER.slice(0, i + 1),
      );
      expect(after.sections.filter((s) => s.state === "pending").map((s) => s.section)).toEqual(
        ETS_ORDER.slice(i + 1),
      );
    }

    const finished = (await (await h.app.request(`/full-tests/${run.id}`)).json()) as FullTestRunVM;
    expect(finished.status).toBe("completed");
    expect(finished.currentSection).toBeNull();
    expect(finished.completedAt).not.toBeNull();
    // `completed_at` is space-form UTC in SQLite and an ISO instant on the wire, never the raw
    // column, which `new Date(...)` would misread as local time.
    expect(finished.completedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(h.r.getFullTestRun(run.id)?.completed_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    // Nothing may be started any more, and each section still points at the Attempt that sat it.
    expect(finished.sections.some((s) => s.launchable)).toBe(false);
    for (const section of ETS_ORDER) {
      expect(finished.sections.find((s) => s.section === section)!.attemptId).toBe(attemptIds[section]);
    }
    // The sitting is over but Speaking's Judges have not landed, so the Run reports the three
    // sections it has and no Overall band, rather than a mean of three.
    expect(finished.overall.band).toBeNull();
    expect(finished.overall.scoredSections).toBe(3);
    expect(finished.overall.pendingSections).toEqual(["speaking"]);
  });

  it("refuses to skip ahead to a later section, however the Attempt is asked for", async () => {
    const h = harness();
    const run = await newRun(h);

    for (const section of ["listening", "writing", "speaking"] as const) {
      const { status, body } = await startSection(h, run.id, section, SECTION_SET_IDS[section]);
      expect(status).toBe(409);
      expect(body.error).toContain("reading");
    }
    // No half-created Attempt left behind by any of those refusals.
    expect(h.r.listAttempts().length).toBe(0);

    // And the refusal moves with the run: once Reading is done, Listening is in and Writing is out.
    await sitSection(h, run.id, "reading");
    await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
    expect((await startSection(h, run.id, "writing", WRITING_SET_ID)).status).toBe(409);
    expect((await startSection(h, run.id, "listening", LISTENING_SET_ID)).status).toBe(201);
  });

  it("refuses to advance past a section that is not finished, at every position in the order", async () => {
    const h = harness();
    const run = await newRun(h);

    for (const section of ETS_ORDER) {
      // Nothing started: not finished.
      expect((await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" })).status).toBe(409);
      // Started but mid-section: still not finished.
      const { body } = await startSection(h, run.id, section, SECTION_SET_IDS[section]);
      const midSection = await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
      expect(midSection.status).toBe(409);
      expect((await midSection.json()) as { sectionState: string }).toMatchObject({ sectionState: "in-progress" });

      // Finish it the way its own runner would, then the handoff is allowed.
      const attemptId = body.attemptId!;
      if (section === "speaking") {
        h.r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, placeholders: [] });
      } else {
        scoreEveryTaskType(h, attemptId, section);
        if (section === "reading" || section === "listening") h.r.setAttemptRouting(attemptId, "upper", 0.8);
        await h.app.request(`/attempts/${attemptId}/complete`, { method: "POST" });
      }
      expect((await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" })).status).toBe(200);
    }
  });

  // A Speaking Simulation ends at capture-finished with the Judges still running and the Attempt
  // still 'in_progress'. A Run that waited for 'completed' would strand the User at the end of a
  // finished exam.
  it("moves past Speaking on the capture-finished marker, without waiting on scoring", async () => {
    const h = harness();
    const run = await newRun(h);
    for (const section of ["reading", "listening", "writing"] as const) {
      await sitSection(h, run.id, section);
      await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
    }

    const { body } = await startSection(h, run.id, "speaking", SPEAKING_SET_ID);
    const attemptId = body.attemptId!;
    expect((await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" })).status).toBe(409);

    h.r.markCaptureFinishedWithMissingItemPlaceholders({ attemptId, placeholders: [] });
    // The Attempt itself has not completed: scoring still owns that.
    expect(h.r.getAttempt(attemptId)?.status).toBe("in_progress");

    const advanced = await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
    expect(advanced.status).toBe(200);
    const after = (await advanced.json()) as FullTestRunVM;
    expect(after.status).toBe("completed");
    const speaking = after.sections.find((s) => s.section === "speaking")!;
    expect(speaking.state).toBe("completed");
    // No band yet: the estimate lands when the Judges do, through the same section_estimates row
    // every other section reads.
    expect(speaking.estimate).toBeNull();
    // And the section is locked against being sat again from the moment capture finished.
    expect((await startSection(h, run.id, "speaking", SPEAKING_SET_ID)).status).toBe(409);
  });

  it("leaves a completed run alone — no further advance, no second completed_at", async () => {
    const h = harness();
    const run = await newRun(h);
    for (const section of ETS_ORDER) {
      await sitSection(h, run.id, section);
      await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
    }
    const stamped = h.r.getFullTestRun(run.id)?.completed_at;

    expect((await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" })).status).toBe(409);
    expect(h.r.getFullTestRun(run.id)?.completed_at).toBe(stamped);
    expect(h.r.getFullTestRun(run.id)?.status).toBe("completed");
  });

  // The cursor is best-effort and can lag the sitting by more than one section: any handoff POST can
  // be lost (navigating away mid-wrap-up is enough), and the Attempt link does not key on the
  // cursor, so later sections are sat regardless. An advance that stepped one section from a stalled
  // cursor would spend the last handoff catching up and leave a fully sat Run 'in-progress' forever,
  // with nothing left to complete it. So one advance repairs the whole lag.
  it("completes a fully-sat run in one advance after earlier handoffs were lost", async () => {
    const h = harness();
    const run = await newRun(h);
    await sitSection(h, run.id, "reading");
    await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
    await sitSection(h, run.id, "listening");
    await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
    // Writing's handoff goes missing (no advance), and Speaking is sat anyway.
    await sitSection(h, run.id, "writing");
    await sitSection(h, run.id, "speaking");

    const stuck = (await (await h.app.request(`/full-tests/${run.id}`)).json()) as FullTestRunVM;
    expect(stuck.status).toBe("in-progress");
    expect(stuck.currentSection).toBe("writing");

    const advanced = await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
    expect(advanced.status).toBe(200);
    const after = (await advanced.json()) as FullTestRunVM;
    expect(after.status).toBe("completed");
    expect(after.currentSection).toBeNull();
    expect(after.completedAt).not.toBeNull();
  });

  it("catches the cursor up past every finished section mid-run, not one step along", async () => {
    const h = harness();
    const run = await newRun(h);
    // Reading's handoff is lost and Listening is sat anyway. The next advance, whichever section's
    // runner fires it, lands on Writing rather than on the finished Listening.
    await sitSection(h, run.id, "reading");
    await sitSection(h, run.id, "listening");

    const advanced = await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
    expect(advanced.status).toBe(200);
    const after = (await advanced.json()) as FullTestRunVM;
    expect(after.status).toBe("in-progress");
    expect(after.currentSection).toBe("writing");
    expect(after.sections.filter((s) => s.launchable).map((s) => s.section)).toEqual(["writing"]);
  });

  // Abandoning mid-run is just leaving: the Run keeps its state, and the section it is waiting on is
  // derived from the Attempts rather than from anything the departing client managed to say.
  it("resumes an abandoned sitting at the section it was left on", async () => {
    const h = harness();
    const run = await newRun(h);
    await sitSection(h, run.id, "reading");
    await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
    // Listening is started and walked away from: no complete, no advance, no abort.
    const started = await startSection(h, run.id, "listening", LISTENING_SET_ID);

    // A brand-new app over the same database: everything the first one held in memory is gone.
    const restarted = new Hono().route("/full-tests", buildFullTestRoutes({ repo: sqliteStores(h.db), listSetBank: () => BANK }));
    const resumed = (await (await restarted.request(`/full-tests/${run.id}`)).json()) as FullTestRunVM;

    expect(resumed.status).toBe("in-progress");
    expect(resumed.sections.filter((s) => s.launchable).map((s) => s.section)).toEqual(["listening"]);
    expect(resumed.sections.find((s) => s.section === "listening")!.state).toBe("in-progress");
    expect(resumed.sections.find((s) => s.section === "listening")!.attemptId).toBe(started.body.attemptId);

    // Resuming re-enters the section's Simulation, which starts a fresh Attempt, and the Run follows
    // the one being sat.
    const again = await startSection(h, run.id, "listening", LISTENING_SET_ID);
    expect(again.status).toBe(201);
    expect(again.body.attemptId).not.toBe(started.body.attemptId);
    const afterResume = (await (await h.app.request(`/full-tests/${run.id}`)).json()) as FullTestRunVM;
    expect(afterResume.sections.find((s) => s.section === "listening")!.attemptId).toBe(again.body.attemptId);
  });
});

// A restarted section and an abandoned Run are the two ways a section's Attempt ends without being
// finished inside its Run. Each is discarded in the same step that leaves it behind, so it cannot be
// finished later through the Attempt lists, and an abandoned Run ends with its finished sections
// intact and no Overall.
describe("a section left behind: restarted, or its Run abandoned", () => {
  async function newRun(h: ReturnType<typeof harness>) {
    const { run } = await createRun(h.app, { sets: SECTION_SET_IDS });
    return run;
  }
  const getRun = async (h: ReturnType<typeof harness>, id: string) =>
    (await (await h.app.request(`/full-tests/${id}`)).json()) as FullTestRunVM;
  const abandon = (h: ReturnType<typeof harness>, id: string) =>
    h.app.request(`/full-tests/${id}/abandon`, { method: "POST" });

  it("discards the Attempt a restart replaces as the new one is linked, and keeps its Repeat tag", async () => {
    const h = harness();
    const run = await newRun(h);
    const first = await startSection(h, run.id, "reading", DISK_SET_ID);
    const replaced = first.body.attemptId!;
    // A scored Item makes the replaced Attempt a sitting of the Set (ATTEMPT_COUNTS_AS_SITTING_SQL),
    // discarded or not. The restart must still carry its tag rather than count it as a prior sitting.
    h.r.insertItemResult({ attemptId: replaced, itemId: "r-1", taskType: "complete_words" });
    h.r.updateItemScore({ attemptId: replaced, itemId: "r-1", score: 1, scoreJson: "{}", scoringStatus: "scored" });
    expect(h.r.getAttempt(replaced)!.is_repeat).toBe(0);

    const again = await startSection(h, run.id, "reading", DISK_SET_ID);
    expect(again.status).toBe(201);
    const restarted = again.body.attemptId!;

    expect(h.r.getAttempt(replaced)!.status).toBe("aborted");
    expect(h.r.getAttempt(restarted)!.status).toBe("in_progress");
    // Tagged as before this change: the replaced sitting's tag, not a recomputation.
    expect(h.r.getAttempt(restarted)!.is_repeat).toBe(0);
    expect((again.body as { isRepeat?: boolean }).isRepeat).toBe(false);
    // The replaced Attempt cannot be finished any more, so its review can never show the key of the
    // Set the Run is still sitting.
    const finish = await h.app.request(`/attempts/${replaced}/complete`, { method: "POST" });
    expect(finish.status).toBe(409);
    expect(h.r.getAttempt(replaced)!.status).toBe("aborted");
    expect((await getRun(h, run.id)).sections.find((s) => s.section === "reading")!.attemptId).toBe(restarted);
  });

  it("abandons a Run in progress: the live section discarded, the finished ones and their bands untouched", async () => {
    const h = harness();
    const run = await newRun(h);
    const readingId = await sitSection(h, run.id, "reading");
    await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
    const listening = await startSection(h, run.id, "listening", LISTENING_SET_ID);
    const listeningId = listening.body.attemptId!;
    const before = await getRun(h, run.id);
    const readingBefore = before.sections.find((s) => s.section === "reading")!;
    expect(readingBefore.estimate?.band).toEqual(expect.any(Number));

    const res = await abandon(h, run.id);
    expect(res.status).toBe(200);
    const after = (await res.json()) as FullTestRunVM;

    expect(after.status).toBe("abandoned");
    expect(after.currentSection).toBeNull();
    expect(after.completedAt).toBeNull();
    expect(after.sections.some((s) => s.launchable)).toBe(false);
    expect(h.r.getAttempt(listeningId)!.status).toBe("aborted");
    expect(after.sections.find((s) => s.section === "listening")!.state).toBe("aborted");
    // The finished section keeps its Attempt, its completion and its band.
    expect(h.r.getAttempt(readingId)!.status).toBe("completed");
    expect(after.sections.find((s) => s.section === "reading")).toEqual(readingBefore);
    // Four real Band Estimates or none: an abandoned Run has no Overall.
    expect(after.overall.band).toBeNull();

    // Idempotent: a second abandon answers the same Run and writes nothing.
    const second = await abandon(h, run.id);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(after);
    // Its sections can no longer be sat, and it is not listed with the Runs waiting to be resumed.
    expect((await startSection(h, run.id, "listening", LISTENING_SET_ID)).status).toBe(409);
    const waiting = (await (await h.app.request("/full-tests?status=in-progress")).json()) as FullTestRunVM[];
    expect(waiting.map((r) => r.id)).not.toContain(run.id);
    const abandonedRuns = (await (await h.app.request("/full-tests?status=abandoned")).json()) as FullTestRunVM[];
    expect(abandonedRuns.map((r) => r.id)).toEqual([run.id]);
  });

  it("abandons a Run nothing has been sat in yet, discarding nothing", async () => {
    const h = harness();
    const run = await newRun(h);
    const res = await abandon(h, run.id);
    expect(res.status).toBe(200);
    const after = (await res.json()) as FullTestRunVM;
    expect(after.status).toBe("abandoned");
    expect(after.sections.every((s) => s.state === "pending" && s.attemptId === null)).toBe(true);
  });

  it("refuses to abandon a completed Run, or one whose sections are all finished, and 404s an unknown one", async () => {
    const h = harness();
    const run = await newRun(h);
    for (const section of FULL_TEST_SECTION_ORDER) await sitSection(h, run.id, section);
    // Every hand-off lost: the Run is still in progress with nothing left to sit. It is finished,
    // not given up on, so it is refused, and its next advance completes it with its Overall. The
    // refusal reaches a User only from a stale tab, so it names the step the UI offers (opening the
    // Run), not the advance route.
    const finished = await abandon(h, run.id);
    expect(finished.status).toBe(409);
    const { error } = (await finished.json()) as { error: string };
    expect(error).toMatch(/Open the Run/);
    expect(error).not.toMatch(/advance/);
    expect(h.r.getFullTestRun(run.id)!.status).toBe("in-progress");

    await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
    const completed = await getRun(h, run.id);
    expect(completed.status).toBe("completed");
    const refused = await abandon(h, run.id);
    expect(refused.status).toBe(409);
    expect(await getRun(h, run.id)).toEqual(completed);

    expect((await abandon(h, "no-such-run")).status).toBe(404);
  });
});

// A finished sitting has an Overall band and a report to read it in. The rule and its refusals are
// unit-tested first, then asserted end to end over a real Run whose Speaking Judges have not landed:
// the state every sitting passes through, since a Run completes at Speaking's capture-finished
// marker rather than at its scores.
describe("deriveFullTestOverall", () => {
  const withBands = (bands: readonly (number | null)[]) =>
    FULL_TEST_SECTION_ORDER.map((section, i) => ({
      section,
      estimate: bands[i] === null ? null : { band: bands[i] as number },
    }));

  it("is the mean of the four section bands, rounded to the nearest half band", () => {
    // 4 + 4.5 + 5 + 5.5 = 19, /4 = 4.75 -> 5.
    expect(deriveFullTestOverall(withBands([4, 4.5, 5, 5.5])).band).toBe(5);
    // 4 + 4 + 4.5 + 5 = 17.5, /4 = 4.375 -> 4.5.
    expect(deriveFullTestOverall(withBands([4, 4, 4.5, 5])).band).toBe(4.5);
  });

  // This suite's own example of the mean-then-round rule: an average of 5.125 is reported as 5, the
  // nearest half band, where a helper that rounded up to the next half band would report 5.5.
  it("pins this suite's example: an average of 5.125 reports as 5", () => {
    const overall = deriveFullTestOverall(withBands([5.5, 5, 5, 5]));
    expect(overall.band).toBe(5);
    expect(overall.scoredSections).toBe(4);
    expect(overall.pendingSections).toEqual([]);
  });

  it("is null — never a partial mean — while any section is still without a band", () => {
    const overall = deriveFullTestOverall(withBands([6, 6, 6, null]));
    expect(overall.band).toBeNull();
    expect(overall.scoredSections).toBe(3);
    expect(overall.pendingSections).toEqual(["speaking"]);
  });

  it("names every section still missing a band, in ETS order", () => {
    const overall = deriveFullTestOverall(withBands([null, 5, null, null]));
    expect(overall.band).toBeNull();
    expect(overall.pendingSections).toEqual(["reading", "writing", "speaking"]);
    expect(overall.scoredSections).toBe(1);
  });

  it("reports no band at all for a sitting with no estimates", () => {
    const overall = deriveFullTestOverall(withBands([null, null, null, null]));
    expect(overall.band).toBeNull();
    expect(overall.scoredSections).toBe(0);
    expect(overall.pendingSections).toEqual([...FULL_TEST_SECTION_ORDER]);
  });

  it("carries a versioned method, so the report labels the overall like every other band surface", () => {
    expect(deriveFullTestOverall(withBands([5, 5, 5, 5])).method).toBe(FULL_TEST_OVERALL_METHOD);
    // Present even while the band is not: the label belongs to the rule, not to one answer.
    expect(deriveFullTestOverall(withBands([5, null, null, null])).method).toBe(FULL_TEST_OVERALL_METHOD);
  });
});

describe("a completed run reports the whole test", () => {
  const ETS_ORDER: FullTestSection[] = [...FULL_TEST_SECTION_ORDER];

  async function sitWholeTest(h: ReturnType<typeof harness>) {
    const { run } = await createRun(h.app, { sets: SECTION_SET_IDS });
    const attemptIds = {} as Record<FullTestSection, string>;
    for (const section of ETS_ORDER) {
      attemptIds[section] = await sitSection(h, run.id, section);
      await h.app.request(`/full-tests/${run.id}/advance`, { method: "POST" });
    }
    return { runId: run.id, attemptIds };
  }

  const readRun = async (h: ReturnType<typeof harness>, runId: string) =>
    (await (await h.app.request(`/full-tests/${runId}`)).json()) as FullTestRunVM;

  /**
   * Stands in for a section's Judges finally landing: every Item is scored, then the finalizer
   * completes the Attempt and writes its band — the one thing that turns the section's band on.
   */
  function landEstimate(h: ReturnType<typeof harness>, attemptId: string, section: FullTestSection, band: number) {
    const items = h.r.getAttempt(attemptId)!.items;
    if (items.length === 0) scoreEveryTaskType(h, attemptId, section, 4);
    for (const item of items) {
      if (item.scoring_status !== "scored") h.r.updateItemScore({ attemptId, itemId: item.item_id, score: 4, scoreJson: "{}", scoringStatus: "scored" });
    }
    h.r.completeAttempt(attemptId);
    h.r.saveSectionEstimate({
      attemptId,
      section,
      rawDetail: JSON.stringify({
        raw: (band - 1) / 5,
        coverage: requiredTaskTypes(section, null).map((taskType) => ({ taskType, itemCount: 4, skippedCount: 1 })),
      }),
      estimatedBand: band,
      method: "linear-v2",
    });
  }

  it("withholds the overall band while Speaking is still scoring, then reports the rounded mean once it lands", async () => {
    const h = harness();
    const { runId, attemptIds } = await sitWholeTest(h);

    const finished = await readRun(h, runId);
    expect(finished.status).toBe("completed");
    // The state every sitting passes through: Speaking is done as far as the User is concerned
    // (capture finished) and has no band yet.
    expect(finished.sections.find((s) => s.section === "speaking")!.state).toBe("completed");
    expect(finished.sections.find((s) => s.section === "speaking")!.estimate).toBeNull();
    expect(finished.overall.band).toBeNull();
    expect(finished.overall.scoredSections).toBe(3);
    expect(finished.overall.pendingSections).toEqual(["speaking"]);

    // The other three carry the bands their own /complete computed: Reading and Listening answered
    // every Item correctly on the Upper path (table3-v1 -> 6); Writing got its Build a Sentence
    // Item right and scored 1 of 5 on each essay (0.5 + 0.05 + 0.05 = 0.6, linear-v2 -> 4).
    expect(finished.sections.map((s) => s.estimate?.band ?? null)).toEqual([6, 6, 4, null]);

    landEstimate(h, attemptIds.speaking, "speaking", 4.5);

    const scored = await readRun(h, runId);
    // (6 + 6 + 4 + 4.5) / 4 = 5.125 -> 5, the nearest half band.
    expect(scored.overall.band).toBe(5);
    expect(scored.overall.method).toBe(FULL_TEST_OVERALL_METHOD);
    expect(scored.overall.scoredSections).toBe(4);
    expect(scored.overall.pendingSections).toEqual([]);
    // Nothing was stored: the same Run row, read again, simply saw a fourth estimate.
    expect(h.r.getFullTestRun(runId)?.status).toBe("completed");
  });

  it("gives each section the coverage and Module Path the report has to disclose", async () => {
    const h = harness();
    const { runId } = await sitWholeTest(h);
    const run = await readRun(h, runId);

    const reading = run.sections.find((s) => s.section === "reading")!;
    // One Item per Task Type of each Module taken: the Router's three, and the Upper Module's
    // Complete the Words and Academic Passage.
    expect(reading.estimate).toMatchObject({
      section: "reading",
      band: 6,
      method: "table3-v1",
      coverage: [
        { taskType: "complete_words", itemCount: 2, skippedCount: 0 },
        { taskType: "daily_life", itemCount: 1, skippedCount: 0 },
        { taskType: "academic_passage", itemCount: 2, skippedCount: 0 },
      ],
    });
    // Routed, so the report must say which Module and (on the lower path) that the band is capped.
    expect(reading.modulePath).toBe("upper");

    // Writing/Speaking never route — a Module Path disclosure there would be a claim about
    // machinery that does not exist for them.
    expect(run.sections.find((s) => s.section === "writing")!.modulePath).toBeNull();
    expect(run.sections.find((s) => s.section === "speaking")!.modulePath).toBeNull();
    expect(run.sections.find((s) => s.section === "writing")!.estimate).toMatchObject({
      section: "writing",
      method: "linear-v2",
      coverage: [
        { taskType: "build_sentence", itemCount: 1, skippedCount: 0 },
        { taskType: "email", itemCount: 1, skippedCount: 0 },
        { taskType: "discussion", itemCount: 1, skippedCount: 0 },
      ],
    });
  });

  it("reports an in-progress run's overall as fully pending rather than omitting it", async () => {
    const h = harness();
    const { run } = await createRun(h.app, { sets: SECTION_SET_IDS });
    const fresh = await readRun(h, run.id);
    expect(fresh.overall.band).toBeNull();
    expect(fresh.overall.pendingSections).toEqual([...FULL_TEST_SECTION_ORDER]);
  });

  // A Full-Test section's Attempt is a Simulation, and the Dashboard's latest estimate per section
  // treats it as one, so a later Drill cannot displace it. Each section is sat through its own
  // Simulation (mode 'simulation'); this pins that, so a change to how a Run creates its Attempts
  // cannot demote a whole sitting's results.
  it("a full-test section outranks a LATER drill of the same section in the dashboard's latest estimate", async () => {
    const h = harness();
    const { attemptIds } = await sitWholeTest(h);

    // A Writing Drill on a Set this sitting never touched (so not a Repeat), completed well after the
    // Full-Test Run: the strongest form of "more recent".
    const drill = await h.app.request("/attempts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "writing", mode: "drill", setId: WRITING_DRILL_SET_ID }),
    });
    const drillId = ((await drill.json()) as { attemptId: string }).attemptId;
    scoreEveryTaskType(h, drillId, "writing", 5);
    expect((await h.app.request(`/attempts/${drillId}/complete`, { method: "POST" })).status).toBe(200);
    h.db.prepare("UPDATE attempts SET completed_at=? WHERE id=?").run("2099-01-01 00:00:00", drillId);

    // The Drill's band is the higher one (every Item perfect -> 6), so a summary that took the most
    // recent estimate would show 6.
    expect(h.r.getSectionEstimate(drillId)?.estimatedBand).toBe(6);

    const summary = (await (await h.app.request("/stats/summary")).json()) as StatsSummaryVM;
    const writing = summary.sections.find((s) => s.section === "writing")!;
    expect(writing).toMatchObject({
      attemptId: attemptIds.writing,
      mode: "simulation",
      band: 4,
    });
  });
});

describe("pickFullTestSets", () => {
  const sets = [
    { id: "rd-1", kind: "reading" },
    { id: "rd-2", kind: "reading" },
    { id: "lsn-1", kind: "listening" },
  ];

  it("prefers a Set nothing has ever attempted", () => {
    const picked = pickFullTestSets({
      sets,
      lastAttemptedAt: new Map([["rd-1", "2026-08-01 00:00:00"]]),
      claimedSetIds: new Set(),
    });
    expect(picked.reading).toBe("rd-2");
  });

  it("falls back to the least-recently-attempted Set once every one has been sat", () => {
    const picked = pickFullTestSets({
      sets,
      lastAttemptedAt: new Map([
        ["rd-1", "2026-07-01 00:00:00"],
        ["rd-2", "2026-08-01 00:00:00"],
      ]),
      claimedSetIds: new Set(),
    });
    expect(picked.reading).toBe("rd-1");
  });

  it("avoids a Set another run already claimed, but reuses one once no alternative remains", () => {
    const avoided = pickFullTestSets({ sets, lastAttemptedAt: new Map(), claimedSetIds: new Set(["rd-1"]) });
    expect(avoided.reading).toBe("rd-2");

    const exhausted = pickFullTestSets({
      sets,
      lastAttemptedAt: new Map(),
      claimedSetIds: new Set(["rd-1", "rd-2"]),
    });
    expect(exhausted.reading).toBe("rd-1");
  });

  it("returns null for a section with no Set of its kind at all", () => {
    const picked = pickFullTestSets({ sets, lastAttemptedAt: new Map(), claimedSetIds: new Set() });
    expect(picked.writing).toBeNull();
    expect(picked.speaking).toBeNull();
    expect(picked.listening).toBe("lsn-1");
  });
});
