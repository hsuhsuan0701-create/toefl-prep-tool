import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db/db.js";
import { at } from "./helpers/timestamps.js";
import {
  attemptsRouteStore,
  bootRecoveryStore,
  createSqliteStores,
  fullTestsRouteStore,
  generationStore,
  speakingCoordinatorStore,
  statsRouteStore,
} from "../src/db/stores/index.js";

// The suite for the store compositions production hands out (db/stores/index.ts). index.ts opens no
// database under test (`NODE_ENV === "test"`), because the route tests import `app` and an
// unguarded `openDb()` there would give every worker a write handle on the real database. The
// compositions therefore live in db/stores/index.ts as named functions whose return types can be
// asserted here, where an inline spread in index.ts could not.
//
// Thin on behaviour (sqliteStores.test.ts covers every statement these stores run) and thick on
// three claims:
//
//   1. Each composition answers its port. The return-type annotations prove that at compile time;
//      the runtime checks below catch a member that typechecks because it came from the right port
//      but is `undefined` because a spread was left out.
//   2. Each composition answers nothing else. The `@ts-expect-error` lines fail the build if a
//      route gains reach into an aggregate it has no business in.
//   3. Nothing else is on the object either. A `@ts-expect-error` narrows what a caller can see,
//      not what the value carries, and a composition that spreads a whole aggregate puts every
//      member of it on the value, one `as any` away. So a picked-out member is also checked absent
//      at runtime (`absent(...)` with `toBeUndefined()`, or an exact key list), which a cast cannot
//      get past.

/** The reachability check a cast cannot dodge: is the member actually on the value? */
const absent = (repo: object, member: string) => (repo as Record<string, unknown>)[member];

// A scratch data directory, so the supersession store's manifest never lands in config.dataDir.
const scratchDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stores-composition-"));
afterAll(() => fs.rmSync(scratchDataDir, { recursive: true, force: true }));
const stores = () => createSqliteStores(openDb(":memory:"), { dataDir: scratchDataDir });

describe("createSqliteStores", () => {
  it("carries a stable per-database identity that is a sibling of the stores, not a member of one", () => {
    const s = stores();
    // The key that keeps one transcription coordinator per database: two coordinators over one
    // database each treat the other's in-flight jobs as orphans and call Ears again, a paid call.
    // The coordinators' and boot passes' stores have to carry it or that guard stops working.
    expect(s.identity.dbFile).toBe(":memory:");
    expect(speakingCoordinatorStore(s).dbFile).toBe(":memory:");
    expect(bootRecoveryStore(s).dbFile).toBe(":memory:");

    // @ts-expect-error — identity is not a store member. A fake would otherwise look like it had to
    // answer it, which is the reason transcriptionRecovery.ts models it as its own type.
    void s.attempts.dbFile;
  });

  it("gives every aggregate its own live store over the one handle", () => {
    const s = stores();
    s.attempts.createAttempt({ id: "a", kind: "writing", mode: "drill", setId: "wri-1", isRepeat: false });
    s.attempts.insertItemResult({ attemptId: "a", itemId: "email-1", taskType: "email", responseText: "draft" });
    s.attempts.completeAttempt("a");
    s.settings.setSetting("target.speaking", "5.5");
    s.supersession.supersedeSet({ setId: "wri-0", supersededBy: "wri-1" });

    // Reads through another store see the writes: the stores are views of one handle, not separate
    // handles.
    expect(s.attempts.getAttempt("a")?.set_id).toBe("wri-1");
    expect(s.settings.getSetting("target.speaking")).toBe("5.5");
    expect([...s.supersession.listSupersededSetIds()]).toEqual(["wri-0"]);
    expect(s.fullTests.lastAttemptStartedAtBySetId().has("wri-1")).toBe(true);
  });
});

describe("the compositions production hands out", () => {
  it("builds the Attempts route's store out of the aggregates it names, and nothing else", () => {
    const repo = attemptsRouteStore(stores());
    // One implementation of `getAttempt`, the widest, from the aggregate that owns `attempts`.
    // Several ports declare it (routes/attempts.ts's port doc); the composition settles that once.
    repo.createAttempt({ id: "a", kind: "speaking", mode: "simulation", setId: "spk-1", isRepeat: false });
    expect(repo.getAttempt("a")?.items).toEqual([]);
    expect(repo.listActiveJobs("a")).toEqual([]);
    expect(repo.getSectionEstimate("a")).toBeUndefined();
    expect(repo.getTranscriptionJob("nope")).toBeUndefined();
    expect(repo.isSupersededTranscriptionHash({ attemptId: "a", itemId: "i", audioSha256: "a".repeat(64) })).toBe(false);

    // @ts-expect-error — a route may not write a TTS clip measurement.
    void repo.insertClipMeasurement;
    expect(absent(repo, "insertClipMeasurement")).toBeUndefined();
    // @ts-expect-error — nor claim the execution lease.
    void repo.acquireExecutionLease;
    expect(absent(repo, "acquireExecutionLease")).toBeUndefined();
    // @ts-expect-error — nor create a generation job.
    void repo.createGenerationJob;
    expect(absent(repo, "createGenerationJob")).toBeUndefined();

    // One Full-Test member, plus the read `checkFullTestLink` makes on this route's behalf and the
    // read that finds the Run an Attempt is a section of. A Run's lifecycle (create it, complete it,
    // move its section cursor, list every Run and every Run's Sets) belongs to routes/fullTests.ts
    // and is absent here.
    expect(typeof repo.openFullTestSectionAttempt).toBe("function");
    expect(typeof repo.getFullTestRun).toBe("function");
    expect(typeof repo.getFullTestRunForAttempt).toBe("function");
    for (const member of [
      "createFullTestRun", "completeFullTestRun", "abandonFullTestRun", "setFullTestCurrentSection", "linkFullTestAttempt",
      "listFullTestRuns", "listFullTestSetIds", "lastAttemptStartedAtBySetId",
    ]) {
      expect(absent(repo, member), `${member} must not be on the Attempts route's store`).toBeUndefined();
    }
  });

  it("builds the Dashboard's store from the settings pair plus the whole-history reads", () => {
    const repo = statsRouteStore(stores());
    expect(repo.getSetting("target.writing")).toBeNull();
    expect(repo.trendPoints("email")).toEqual([]);
    expect(repo.getLatestEstimates().speaking).toBeUndefined();
    expect(repo.listAllJudgeReports()).toEqual([]);

    // @ts-expect-error — the Dashboard reads; it does not create an Attempt.
    void repo.createAttempt;
    // @ts-expect-error — nor persist a Band Estimate.
    void repo.saveSectionEstimate;
    // Every member is picked by name, so the Attempt write surface a `...s.attempts` spread would
    // bring is off the object. StatsReadStore's doc says "Nothing here writes"; the settings pair is
    // the one exception, and the only writer this composition names.
    expect(Object.keys(repo).sort()).toEqual([
      "getLatestEstimates", "getSetting", "listAllJudgeReports", "recentScoredItemResults",
      "recentScoredReadingListeningItemResults", "recentSimulationBands", "setSetting", "trendPoints",
    ]);
  });

  it("builds a Full-Test Run's store from its own aggregate plus four READS", () => {
    const repo = fullTestsRouteStore(stores());
    expect(repo.listFullTestRuns()).toEqual([]);
    expect(repo.getAttempt("nope")).toBeUndefined();
    expect(repo.listActiveJobs("nope")).toEqual([]);
    expect(repo.getCurrentTranscriptionJobs("nope")).toEqual([]);
    expect(repo.getSectionEstimate("nope")).toBeUndefined();

    // @ts-expect-error — routes/fullTests.ts's own header says the route "never scores anything and
    // stores no band". EstimateReadStore is what makes that a fact about the type.
    void repo.saveSectionEstimate;
    // This composition picks the estimate read by name, so the writer is off the object too.
    expect(absent(repo, "saveSectionEstimate")).toBeUndefined();
  });

  it("builds the generation store the route and the runner share, with the ports keeping them apart", () => {
    const repo = generationStore(stores());
    repo.createGenerationJob({ id: "g", kind: "writing" });
    expect(repo.getGenerationJob("g")?.status).toBe("queued");
    expect(repo.listPendingCleanupDebt()).toEqual([]);
    expect([...repo.listSupersededSetIds()]).toEqual([]);

    // @ts-expect-error — generation cannot touch an Attempt's Items.
    void repo.updateItemScore;
    // @ts-expect-error — nor un-retire a Set: `unsupersedeSet` is on the concrete supersession store,
    // deliberately not on SupersessionStore, which this intersects.
    void repo.unsupersedeSet;
    expect(absent(repo, "unsupersedeSet")).toBeUndefined();
    expect(absent(repo, "updateItemScore")).toBeUndefined();
  });

  it("builds the Speaking coordinators' store across four aggregates plus the database identity", () => {
    const s = stores();
    // Seeded through the Attempt aggregate, because the coordinators' own store cannot create one
    // (the guard at the end of this test). A Speaking Simulation's Attempt is the route's to open.
    s.attempts.createAttempt({ id: "a", kind: "speaking", mode: "simulation", setId: "spk-1", isRepeat: false });
    const repo = speakingCoordinatorStore(s);
    repo.markCaptureFinishedWithMissingItemPlaceholders({ attemptId: "a", placeholders: [] });
    expect(repo.listCaptureFinishedInProgressAttempts().map((row) => row.id)).toEqual(["a"]);
    expect(repo.getCurrentTranscriptionJobs("a")).toEqual([]);
    expect(repo.listScoringJobsForAttempt("a")).toEqual([]);

    // @ts-expect-error — finalization never publishes a Set, so it cannot retire one either.
    void repo.supersedeSet;
    expect(absent(repo, "supersedeSet")).toBeUndefined();
    // @ts-expect-error — nor open an Attempt: it finalizes one the route already created.
    void repo.createAttempt;
    // The coordinators finalize an Attempt the route opened, so the Attempt lifecycle is off the
    // object as well as the type; a `...s.attempts` spread would put it back.
    for (const member of ["createAttempt", "abortAttempt", "flagAttempt", "setAttemptRouting", "listAttempts"]) {
      expect(absent(repo, member), `${member} must not be on the Speaking coordinators' store`).toBeUndefined();
    }
  });

  it("builds the boot passes' store", () => {
    const repo = bootRecoveryStore(stores());
    expect(repo.listInterruptedJobs()).toEqual([]);
    expect(repo.listInterruptedGenerationJobs()).toEqual([]);
    expect(repo.listInterruptedTranscriptionJobs()).toEqual([]);
    expect(repo.pruneClipMeasurements(sqliteCutoff())).toBe(0);
    expect(repo.pruneNormalizedModelCalls(sqliteCutoff())).toBe(0);
    // The manifest replay writes rows the boot chain did not measure itself.
    repo.insertClipMeasurement({
      id: "replayed", setId: "spk-1", role: "lr-item", file: "lr-1.mp3", wordCount: 7,
      durationSec: 2.1, wpm: 200, speed: 1, correctionCount: 0, inBand: true,
      takeDisposition: "published", createdAt: "2026-08-01 00:00:00",
    });

    // @ts-expect-error — the boot sweep does not acquire the lease it runs under; executionOwner.ts
    // owns that, and it is handed stores.executionLease directly.
    void repo.acquireExecutionLease;
    expect(absent(repo, "acquireExecutionLease")).toBeUndefined();
    // @ts-expect-error — nor may it promote a take: only the renderer that publishes one may say so.
    void repo.markClipMeasurementTake;
    expect(absent(repo, "markClipMeasurementTake")).toBeUndefined();
  });
});

// A cutoff in the on-disk form these deleters string-compare `created_at` against — see
// db/timestamps.ts. Minted through the real helper so a malformed literal throws rather than
// silently comparing wrong.
function sqliteCutoff() {
  return at("2026-01-01 00:00:00");
}
