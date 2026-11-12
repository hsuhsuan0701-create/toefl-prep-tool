import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validSpeakingSet, validWritingSet, framelessWritingSet } from "./helpers/setFixtures.js";
import { openDb } from "../src/db/db.js";
import { sqliteStores } from "./helpers/sqliteStores.js";
import { app } from "../src/index.js";
import { config } from "../src/lib/config.js";
import { buildGenerateRoutes } from "../src/routes/generate.js";
import { listSets } from "../src/routes/sets.js";
import { createSetStore } from "../src/services/setStore.js";
import { runGenerationJob } from "../src/services/generationJobs.js";
import { READING_FIXTURE } from "./fixtures/reading-set.fixture.js";
import { buildNoveltyCatalog } from "../src/services/generationCatalog.js";
import { createGenerationPlanner } from "../src/services/generationPlanner.js";
import {
  createRepoSupersededSetIdsReader,
  recordSupersessionOnPublication,
  setSupersededSetIdsReader,
  supersededSetIds,
  type SupersessionStore,
} from "../src/services/supersession.js";
import type { SkillTaskRequest } from "../src/services/reasoning/router.js";
import {
  speakingPlanFixture,
  speakingSetFixture,
  writingPlanFixture,
} from "./helpers/generationDiversityFixtures.js";

const scratchDirs: string[] = [];
/** Writing Sets a real generation run published into this file's data dir, removed after each. */
const publishedSetIds: string[] = [];
/** Speaking Sets likewise; a Speaking Set also leaves an audio directory to remove. */
const publishedSpeakingSetIds: string[] = [];

afterEach(() => {
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  for (const setId of publishedSetIds.splice(0)) {
    fs.rmSync(path.join(config.dataDir, "question-sets/writing", `${setId}.json`), { force: true });
  }
  for (const setId of publishedSpeakingSetIds.splice(0)) {
    fs.rmSync(path.join(config.dataDir, "question-sets/speaking", `${setId}.json`), { force: true });
    fs.rmSync(path.join(config.dataDir, "audio/stimuli", setId), { recursive: true, force: true });
  }
  setSupersededSetIdsReader(null);
  vi.restoreAllMocks();
});

/** A planner that admits a fixed Plan: these tests are about recording a supersession. */
function stubPlanner() {
  return {
    reserve: vi.fn(async (input: { ownerId: string }) => ({
      reservationId: `reservation-${input.ownerId}`,
      ownerId: input.ownerId,
      plan: writingPlanFixture(),
    })),
    validateCandidate: vi.fn().mockReturnValue([]),
    release: vi.fn(),
  } as never;
}

/** The same stub with a Speaking Plan, for the round-trip below. */
function stubSpeakingPlanner() {
  return {
    reserve: vi.fn(async (input: { ownerId: string }) => ({
      reservationId: `reservation-${input.ownerId}`,
      ownerId: input.ownerId,
      plan: speakingPlanFixture(),
    })),
    validateCandidate: vi.fn().mockReturnValue([]),
    release: vi.fn(),
  } as never;
}

/**
 * Both paid scene calls and TTS, stubbed: a Speaking generation run to completion would otherwise
 * reach the real image, vision and text-to-speech APIs.
 */
function speakingRenderDeps() {
  return {
    sceneImage: vi.fn().mockResolvedValue({ file: "images/scenarios/stub.webp", prompt: "p", model: "gpt-image-2" }),
    focusRegions: vi.fn().mockResolvedValue(Array.from({ length: 7 }, () => null)),
    probeDuration: vi.fn(async (filePath: string) =>
      filePath.includes("iq") || filePath.includes("int-intro") ? 0.4 : 0.35),
    tts: vi.fn(async (_request: unknown, outPath: string) => {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, "stub-audio");
    }),
  };
}

function scratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

/** Two saved Speaking Sets carrying the same stored Plan, so each overlaps the other on every
 * cross-Set measure: the case where a replacement collides with the Set it replaces. */
function bankWithTwoCollidingSets(): { dataDir: string; olderId: string; newerId: string } {
  const dataDir = scratchDir("supersession-bank-");
  fs.mkdirSync(path.join(dataDir, "question-sets/speaking"), { recursive: true });
  for (const [id, createdAt] of [
    ["spk-retired", "2026-01-01T00:00:00Z"],
    ["spk-current", "2026-02-01T00:00:00Z"],
  ] as const) {
    const saved = speakingSetFixture();
    saved.id = id;
    saved.createdAt = createdAt;
    saved.generationPlan = speakingPlanFixture();
    fs.writeFileSync(
      path.join(dataDir, `question-sets/speaking/${id}.json`),
      JSON.stringify(saved),
    );
  }
  return { dataDir, olderId: "spk-retired", newerId: "spk-current" };
}

describe("supersession — the database record", () => {
  it("records, reads back, and reverses by delete", () => {
    const r = sqliteStores(openDb(":memory:"));

    expect(r.listSupersededSetIds().size).toBe(0);
    expect(r.unsupersedeSet("lsn-14659f38")).toBe(false);

    r.supersedeSet({ setId: "lsn-14659f38", supersededBy: "lsn-new", at: "2026-08-12 00:00:00" });
    expect([...r.listSupersededSetIds()]).toEqual(["lsn-14659f38"]);
    expect(r.getSupersession("lsn-14659f38")).toEqual({
      set_id: "lsn-14659f38",
      superseded_by: "lsn-new",
      superseded_at: "2026-08-12 00:00:00",
    });

    // Superseding the same Set again re-points the row rather than throwing on the primary key.
    r.supersedeSet({ setId: "lsn-14659f38", supersededBy: "lsn-newer" });
    expect(r.getSupersession("lsn-14659f38")?.superseded_by).toBe("lsn-newer");

    // Reversible by deleting the row (ADR 0011).
    expect(r.unsupersedeSet("lsn-14659f38")).toBe(true);
    expect(r.listSupersededSetIds().size).toBe(0);
  });

  // The table is part of the first versioned schema (schemaV1.sql), so every database the runner
  // accepts already has it; what a later boot must not do is recreate it or lose its rows.
  it("keeps a recorded retirement when the same database file is opened again", () => {
    const dir = scratchDir("supersession-reopen-");
    const dbPath = path.join(dir, "db.sqlite");
    // A first boot creates the table; a second boot over the same file must be a clean no-op.
    sqliteStores(openDb(dbPath)).supersedeSet({ setId: "rd-old", supersededBy: "rd-new" });
    expect([...sqliteStores(openDb(dbPath)).listSupersededSetIds()]).toEqual(["rd-old"]);
  });
});

// The create-before-supersede ordering is covered end to end by "records the supersession only once
// the replacement has actually published" below. These cover the rules only this function holds,
// against a plain-object store.
describe("recordSupersessionOnPublication", () => {
  it("is the ONLY way to reach the retirement writer (a compile-time claim)", () => {
    const store: SupersessionStore = { supersedeSet: vi.fn(), listSupersededSetIds: () => new Set<string>() };
    // @ts-expect-error — `supersededBy` is a PublishedSetId, and this function is the one place that
    // mint happens. Calling the raw writer with a plain Set id is how a retirement could be recorded
    // before its replacement published, the unrecoverable direction: boot recovery deletes a swept
    // job's artifacts and the User is left with neither Set. Typecheck fails here if the port
    // loosens to `string`.
    store.supersedeSet({ setId: "rd-old", supersededBy: "rd-new" });
    expect(store.listSupersededSetIds().size).toBe(0);
  });

  it("writes nothing when the job replaced nothing", () => {
    const supersedeSet = vi.fn();
    recordSupersessionOnPublication(
      { supersedeSet, listSupersededSetIds: () => new Set<string>() },
      { jobId: "job-1", publishedSetId: "rd-new", supersedesSetId: undefined },
    );
    expect(supersedeSet).not.toHaveBeenCalled();
  });

  it("never throws when the retirement write fails — the Set is already published and immutable", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        recordSupersessionOnPublication(
          {
            supersedeSet: () => { throw new Error("database is locked"); },
            listSupersededSetIds: () => new Set<string>(),
          },
          { jobId: "job-2", publishedSetId: "rd-new", supersedesSetId: "rd-old" },
        ),
      ).not.toThrow();
      // Letting this reach the job's terminal write would flip a 'done' job to 'failed' and send
      // boot recovery after artifacts that are live. Logged as the error's name, never its value.
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("could not record supersession of rd-old"),
        "Error",
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("supersession — the Catalog", () => {
  it("drops a superseded Set's entries, and restores them when the row is deleted", () => {
    const { dataDir, olderId, newerId } = bankWithTwoCollidingSets();

    const full = buildNoveltyCatalog({ store: createSetStore(dataDir) });
    expect(full.some((entry) => entry.setId === olderId)).toBe(true);
    expect(full.some((entry) => entry.setId === newerId)).toBe(true);

    const filtered = buildNoveltyCatalog({
      store: createSetStore(dataDir),
      supersededSetIds: new Set([olderId]),
    });
    expect(filtered.some((entry) => entry.setId === olderId)).toBe(false);
    expect(filtered.some((entry) => entry.setId === newerId)).toBe(true);

    // Un-superseding takes effect on the very next build. No file on disk changed, so the Catalog's
    // fingerprint cache must not be what decides this.
    expect(
      buildNoveltyCatalog({ store: createSetStore(dataDir), supersededSetIds: new Set() })
        .some((entry) => entry.setId === olderId),
    ).toBe(true);
  });

  it("measures a plan against the bank minus the Set it replaces", async () => {
    const { dataDir, olderId } = bankWithTwoCollidingSets();
    fs.rmSync(path.join(dataDir, "question-sets/speaking/spk-current.json"));

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plan = async (request: SkillTaskRequest<unknown>) =>
      ({ ok: true as const, value: request.parse(speakingPlanFixture()), provider: "claude" as const, attempts: [] });
    // Without supersession the prior Set's overlap is recorded on the admitted plan.
    const collided = await createGenerationPlanner({ dataDir }).reserve({
      kind: "speaking",
      ownerId: "no-supersession",
      runSkillTask: plan as never,
    });
    expect(collided.advisoryNotes?.some((note) => note.conflictingSetIds?.includes(olderId))).toBe(true);

    // The same Plan against the same bank, with the one prior Set retired: nothing to record.
    const accepted: SkillTaskRequest<unknown>[] = [];
    const reservation = await createGenerationPlanner({ dataDir }).reserve({
      kind: "speaking",
      ownerId: "supersedes",
      supersedesSetId: olderId,
      runSkillTask: (async (request: SkillTaskRequest<unknown>) => {
        accepted.push(request);
        return plan(request);
      }) as never,
    });

    expect(accepted).toHaveLength(1);
    expect(reservation.advisoryNotes).toBeUndefined();
    // The retired Set is not even shown to the planner.
    const payload = JSON.parse(accepted[0].prompt.match(/```json\n([\s\S]*?)\n```/u)?.[1] ?? "{}") as {
      catalog: { setId: string }[];
    };
    expect(payload.catalog.some(({ setId }) => setId === olderId)).toBe(false);
  });

});

describe("supersession — the picker", () => {
  it("hides a superseded Set from listSets while readSet keeps loading it", () => {
    const { dataDir, olderId, newerId } = bankWithTwoCollidingSets();

    expect(listSets(dataDir).map((s) => s.id)).toEqual(expect.arrayContaining([olderId, newerId]));

    const visible = listSets(dataDir, new Set([olderId])).map((s) => s.id);
    expect(visible).not.toContain(olderId);
    expect(visible).toContain(newerId);

    // Still loadable — this is what keeps a past Attempt's review renderable.
    expect(createSetStore(dataDir).readSet(olderId)?.id).toBe(olderId);

    // Un-superseding restores it.
    expect(listSets(dataDir, new Set()).map((s) => s.id)).toContain(olderId);
  });

  it("GET /api/sets hides it and GET /api/sets/:id still returns it", async () => {
    const dir = path.join(config.dataDir, "question-sets/writing");
    fs.mkdirSync(dir, { recursive: true });
    const saved = framelessWritingSet("wri-supersession-canary");
    fs.writeFileSync(path.join(dir, "wri-supersession-canary.json"), JSON.stringify(saved));
    const db = openDb(":memory:");
    const r = sqliteStores(db);
    setSupersededSetIdsReader(createRepoSupersededSetIdsReader(r));

    try {
      const before = (await (await app.request("/api/sets?kind=writing")).json()) as { id: string }[];
      expect(before.some((s) => s.id === "wri-supersession-canary")).toBe(true);

      r.supersedeSet({ setId: "wri-supersession-canary", supersededBy: "wri-replacement" });
      const after = (await (await app.request("/api/sets?kind=writing")).json()) as { id: string }[];
      expect(after.some((s) => s.id === "wri-supersession-canary")).toBe(false);
      expect((await app.request("/api/sets/wri-supersession-canary")).status).toBe(200);

      r.unsupersedeSet("wri-supersession-canary");
      const restored = (await (await app.request("/api/sets?kind=writing")).json()) as { id: string }[];
      expect(restored.some((s) => s.id === "wri-supersession-canary")).toBe(true);
    } finally {
      fs.rmSync(path.join(dir, "wri-supersession-canary.json"), { force: true });
    }
  });

  it("records the supersession only once the replacement has actually published", async () => {
    const testRepo = sqliteStores(openDb(":memory:"));
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => ({
      ok: true as const,
      // Raw, unparsed — the generator injects the id/source/createdAt a candidate schema requires.
      value: request.task.task === "generate"
        ? validWritingSet()
        : { items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok", answers: null })) },
      provider: "claude" as const,
      attempts: [],
    }));
    const deps = { repo: testRepo, runSkillTask: runSkillTask as never, planner: stubPlanner() };

    // A run that fails leaves the Set it was replacing exactly where it was.
    testRepo.createGenerationJob({ id: "job-failed", kind: "writing" });
    await runGenerationJob(
      {
        ...deps,
        runSkillTask: (async () => ({
          ok: false as const,
          error: "Structured reasoning unavailable: Claude (quota) → Codex (timeout).",
          attempts: [],
        })) as never,
      },
      "job-failed",
      { kind: "writing", supersedesSetId: "wri-doomed-target" },
    );
    expect(testRepo.getGenerationJob("job-failed")?.status).toBe("failed");
    expect(testRepo.listSupersededSetIds().size).toBe(0);

    // A run that publishes retires its target, pointing at the Set that actually replaced it.
    testRepo.createGenerationJob({ id: "job-ok", kind: "writing" });
    await runGenerationJob(deps, "job-ok", { kind: "writing", supersedesSetId: "wri-old-target" });
    const done = testRepo.getGenerationJob("job-ok");
    expect(done?.status).toBe("done");
    publishedSetIds.push(done!.set_id!);
    expect(testRepo.getSupersession("wri-old-target")).toMatchObject({
      set_id: "wri-old-target",
      superseded_by: done!.set_id!,
    });
  });

  it("records no supersession when the publication could not be marked complete", async () => {
    const realRepo = sqliteStores(openDb(":memory:"));
    // The intent is abandoned between the publish and the job's commit, as reconciliation does when
    // the bytes it promised are missing. The completion writer then refuses it, through real SQL.
    const testRepo = {
      ...realRepo,
      markGenerationPublicationComplete: (i: { childId: string; now: string }) => {
        realRepo.abandonGenerationPublicationIntent({ childId: i.childId, error: "canonical bytes missing", now: i.now });
        return realRepo.markGenerationPublicationComplete(i as never);
      },
    };
    const runSkillTask = vi.fn(async (request: SkillTaskRequest<unknown>) => ({
      ok: true as const,
      value: request.task.task === "generate"
        ? validWritingSet()
        : { items: Array.from({ length: 10 }, (_, i) => ({ id: `bs${i + 1}`, verdict: "ok", answers: null })) },
      provider: "claude" as const,
      attempts: [],
    }));
    vi.spyOn(console, "error").mockImplementation(() => {});

    testRepo.createGenerationJob({ id: "job-unmarked", kind: "writing" });
    await runGenerationJob(
      { repo: testRepo as never, runSkillTask: runSkillTask as never, planner: stubPlanner() },
      "job-unmarked",
      { kind: "writing", supersedesSetId: "wri-kept-target" },
    );
    const row = realRepo.getGenerationJob("job-unmarked");
    if (row?.set_id) publishedSetIds.push(row.set_id);

    expect(row?.status).not.toBe("done");
    expect(realRepo.getSupersession("wri-kept-target")).toBeUndefined();
    expect(realRepo.listSupersededSetIds().size).toBe(0);
  });

  it("rejects a supersedesSetId the section, the bank, or the request shape cannot honour", async () => {
    const testRepo = sqliteStores(openDb(":memory:"));
    const routes = buildGenerateRoutes({ repo: testRepo, runSkillTask: vi.fn(), planner: stubPlanner() });
    const post = (body: unknown) => routes.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    // Writing is the one section the field is refused for; the Speaking round-trip below holds
    // Speaking open.
    expect((await post({ kind: "writing", supersedesSetId: "wri-test1" })).status).toBe(400);
    // Not a set id at all.
    expect((await post({ kind: "reading", supersedesSetId: "" })).status).toBe(400);
    expect((await post({ kind: "reading", supersedesSetId: 7 })).status).toBe(400);
    // A real Set, but of the other section.
    const readingDir = path.join(config.dataDir, "question-sets/reading");
    fs.mkdirSync(readingDir, { recursive: true });
    const readingId = "rd-supersession-target";
    fs.writeFileSync(
      path.join(readingDir, `${readingId}.json`),
      JSON.stringify({ ...READING_FIXTURE, id: readingId }),
    );
    try {
      expect((await post({ kind: "listening", supersedesSetId: readingId })).status).toBe(400);
      // …and accepted for its own section.
      expect((await post({ kind: "reading", supersedesSetId: readingId })).status).toBe(202);
    } finally {
      fs.rmSync(path.join(readingDir, `${readingId}.json`), { force: true });
    }
    // Nonexistent.
    expect((await post({ kind: "reading", supersedesSetId: "rd-never-existed" })).status).toBe(400);
    // Without the field, the request is a plain generate and queues a job.
    expect((await post({ kind: "reading" })).status).toBe(202);
  });

  // A replacement Speaking Set is a new Set with no link back to the one it replaces, so
  // `supersedesSetId` is the only thing that retires the original. End to end: a real Speaking
  // generation publishes, the original leaves the picker, and it stays readable so a past Attempt's
  // review still resolves its Set.
  it("round-trips a Speaking supersession: the replacement publishes, the original leaves the picker and stays readable", async () => {
    const speakingDir = path.join(config.dataDir, "question-sets/speaking");
    fs.mkdirSync(speakingDir, { recursive: true });
    const retiredId = "spk-supersession-canary";
    const retired = { ...speakingSetFixture(), id: retiredId, createdAt: "2026-01-01T00:00:00Z" };
    fs.writeFileSync(path.join(speakingDir, `${retiredId}.json`), JSON.stringify(retired));

    const testRepo = sqliteStores(openDb(":memory:"));
    setSupersededSetIdsReader(createRepoSupersededSetIdsReader(testRepo));
    const runSkillTask = vi.fn(async () => ({
      ok: true as const, value: validSpeakingSet(), provider: "claude" as const, attempts: [],
    }));

    try {
      // Visible before anything is retired, and the route accepts the field for Speaking.
      const before = (await (await app.request("/api/sets?kind=speaking")).json()) as { id: string }[];
      expect(before.some((s) => s.id === retiredId)).toBe(true);

      // The 202 starts a fire-and-forget job this test does not observe (the publication below runs
      // directly). Its render is given a TTS that fails at once, so that job ends before publishing
      // anything and never reaches a real TTS provider.
      const routes = buildGenerateRoutes({
        repo: testRepo, runSkillTask: runSkillTask as never, planner: stubSpeakingPlanner(),
        ...speakingRenderDeps(),
        tts: vi.fn().mockRejectedValue(new Error("the route's background render is not under test")),
      });
      const accepted = await routes.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "speaking", supersedesSetId: retiredId }),
      });
      expect(accepted.status).toBe(202);

      // …and still refuses a target from another section.
      const crossSection = await routes.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "listening", supersedesSetId: retiredId }),
      });
      expect(crossSection.status).toBe(400);

      // The publication itself, run directly so the assertion below waits on a finished render
      // rather than the route's fire-and-forget.
      testRepo.createGenerationJob({ id: "spk-supersede-job", kind: "speaking" });
      await runGenerationJob(
        {
          repo: testRepo,
          runSkillTask: runSkillTask as never,
          planner: stubSpeakingPlanner(),
          ...speakingRenderDeps(),
        },
        "spk-supersede-job",
        { kind: "speaking", supersedesSetId: retiredId },
      );

      const job = testRepo.getGenerationJob("spk-supersede-job")!;
      expect(job.status).toBe("done");
      const replacementId = job.set_id!;
      publishedSpeakingSetIds.push(replacementId);

      // The row points the retired Set at the Set that actually replaced it.
      expect(testRepo.getSupersession(retiredId)).toMatchObject({
        set_id: retiredId, superseded_by: replacementId,
      });

      // Out of the picker, and the replacement in it.
      const after = (await (await app.request("/api/sets?kind=speaking")).json()) as { id: string }[];
      expect(after.some((s) => s.id === retiredId)).toBe(false);
      expect(after.some((s) => s.id === replacementId)).toBe(true);

      // Still readable: the review page resolves a past Attempt's Set through GET /api/sets/:id
      // (getSet in client/src/hooks/useAttemptReview.ts), which reads through the Set store's readSet
      // and never consults supersession. Asserted on the body as well as the status, so an empty
      // body would fail here.
      const detail = await app.request(`/api/sets/${retiredId}`);
      expect(detail.status).toBe(200);
      const served = (await detail.json()) as { id: string; listenAndRepeat: { items: unknown[] } };
      expect(served.id).toBe(retiredId);
      expect(served.listenAndRepeat.items).toHaveLength(7);
      expect(createSetStore(config.dataDir).readSet(retiredId)?.id).toBe(retiredId);

      // The retired Set's file is neither edited nor deleted.
      expect(fs.existsSync(path.join(speakingDir, `${retiredId}.json`))).toBe(true);
      expect(JSON.parse(fs.readFileSync(path.join(speakingDir, `${retiredId}.json`), "utf8"))).toEqual(retired);
    } finally {
      fs.rmSync(path.join(speakingDir, `${retiredId}.json`), { force: true });
    }
  });

  it("never lets a failed read of the retirement table hide or break the picker", () => {
    setSupersededSetIdsReader(() => {
      throw new Error("database is locked");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(supersededSetIds().size).toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});
