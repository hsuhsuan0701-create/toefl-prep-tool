import type Database from "better-sqlite3";
import { config } from "../../lib/config.js";
import { supersessionManifestPath } from "../../services/supersessionManifest.js";
import type { AttemptsRouteStore } from "../../routes/attempts.js";
import type { FullTestStore } from "../../routes/fullTests.js";
import type { GenerateRouteStore } from "../../routes/generate.js";
import type { StatsStore } from "../../routes/stats.js";
import type { DrillLabStore } from "../../routes/drillLab.js";
import type { BootRecoveryStore } from "../../services/bootRecoveryRegistry.js";
import type { DiagnosticRetentionStore } from "../../services/modelCallLog.js";
import type { SpeakingCoordinatorStore } from "../../services/speakingFinalization.js";
import type { DatabaseIdentity } from "../../services/transcriptionRecovery.js";
import { createSqliteAttemptStore } from "./attempts.js";
import { createSqliteClipMeasurementStore, createSqliteDiagnosticStore } from "./diagnostics.js";
import { createSqliteEstimateStore } from "./estimates.js";
import { createSqliteExecutionLeaseStore } from "./executionLease.js";
import { createSqliteFullTestStore } from "./fullTests.js";
import { createSqliteDrillLabStore } from "./drillLab.js";
import { createSqliteGenerationStore } from "./generation.js";
import { createSqliteProviderQuotaStore } from "./providerQuota.js";
import { createSqlitePublicationStore } from "./publication.js";
import { createSqliteRecordingStore, createSqliteTranscriptionJobStore } from "./transcription.js";
import { createSqliteScoringJobStore } from "./scoring.js";
import { createSqliteSettingsStore } from "./settings.js";
import { createSqliteSupersessionStore } from "./supersession.js";

// ---------------------------------------------------------------------------------------------
// The SQLite adapters, and the store compositions production hands out
// ---------------------------------------------------------------------------------------------
//
// Nothing here produces an object whose type spans the whole database. `createSqliteStores` returns
// the aggregates side by side, under names, and each composition below narrows to a port its consumer
// declares, so a route that needs an Attempt and a scoring job is handed those and cannot reach a
// diagnostics writer or the execution lease by accident. The compositions live here rather than inline
// in index.ts so each is a named function whose return type the compiler checks.

/**
 * Every aggregate over one database, side by side: a record of stores rather than one merged object.
 * Merging happens below only where a consumer's own port asks for it.
 */
export type SqliteStores = {
  /**
   * Stable identity of the underlying database: better-sqlite3's `db.name`, the file path or
   * ":memory:". Not a store operation, hence a sibling of the stores. It is the key that keeps the
   * transcription coordinator one per database (the memo above createTranscriptionRecovery says
   * why), and object identity cannot do that alone, since a second `createSqliteStores(openDb())`
   * builds distinct objects over the same file.
   */
  identity: DatabaseIdentity;
  attempts: ReturnType<typeof createSqliteAttemptStore>;
  estimates: ReturnType<typeof createSqliteEstimateStore>;
  settings: ReturnType<typeof createSqliteSettingsStore>;
  transcription: ReturnType<typeof createSqliteTranscriptionJobStore>;
  recording: ReturnType<typeof createSqliteRecordingStore>;
  scoring: ReturnType<typeof createSqliteScoringJobStore>;
  generation: ReturnType<typeof createSqliteGenerationStore>;
  publication: ReturnType<typeof createSqlitePublicationStore>;
  supersession: ReturnType<typeof createSqliteSupersessionStore>;
  diagnostics: ReturnType<typeof createSqliteDiagnosticStore>;
  clipMeasurements: ReturnType<typeof createSqliteClipMeasurementStore>;
  executionLease: ReturnType<typeof createSqliteExecutionLeaseStore>;
  providerQuota: ReturnType<typeof createSqliteProviderQuotaStore>;
  fullTests: ReturnType<typeof createSqliteFullTestStore>;
  drillLab: ReturnType<typeof createSqliteDrillLabStore>;
};

/**
 * `dataDir` locates the supersession manifest (`<dataDir>/question-sets/supersessions.json`), which
 * the supersession store writes in the same transaction as its table. Production and the scripts
 * use `config.dataDir`; a test that retires a Set passes a scratch directory.
 */
export function createSqliteStores(
  db: Database.Database,
  options: { dataDir?: string } = {},
): SqliteStores {
  return {
    identity: { dbFile: db.name },
    attempts: createSqliteAttemptStore(db),
    estimates: createSqliteEstimateStore(db),
    settings: createSqliteSettingsStore(db),
    transcription: createSqliteTranscriptionJobStore(db),
    recording: createSqliteRecordingStore(db),
    scoring: createSqliteScoringJobStore(db),
    generation: createSqliteGenerationStore(db),
    publication: createSqlitePublicationStore(db),
    supersession: createSqliteSupersessionStore(db, supersessionManifestPath(options.dataDir ?? config.dataDir)),
    diagnostics: createSqliteDiagnosticStore(db),
    clipMeasurements: createSqliteClipMeasurementStore(db),
    executionLease: createSqliteExecutionLeaseStore(db),
    providerQuota: createSqliteProviderQuotaStore(db),
    fullTests: createSqliteFullTestStore(db),
    drillLab: createSqliteDrillLabStore(db),
  };
}

// ---------------------------------------------------------------------------------------------
// Spread versus pick
// ---------------------------------------------------------------------------------------------
//
// A return type narrows what a caller can see, not the object: `...s.x` puts every member of that
// aggregate on the value, where `(repo as any).member` still finds it. So:
//
//   * destructive or cross-aggregate authority is picked by name, so it is absent from the value and
//     not merely hidden from the type: the un-retire, opening an Attempt from a coordinator that only
//     finalizes one, and the whole Dashboard store;
//   * ordinary same-family reads and writes a consumer already legitimately holds are spread. The type
//     is the documentation there, and a by-name manifest would only drift from the ports.
//
// sqliteStoresComposition.test.ts asserts that the picked-out members are absent at runtime.

/**
 * The Attempts route's store. Only the Attempt aggregate implements `getAttempt`, so the port's `Omit`s
 * need no counterpart here. The Full-Test half is the three members this route uses.
 */
export function attemptsRouteStore(s: SqliteStores): AttemptsRouteStore {
  return {
    ...s.attempts,
    ...s.scoring,
    ...s.estimates,
    // The section Simulation names its Run when it opens its Attempt; that link is the ONLY thing
    // this route does with a Full-Test Run. It neither creates, advances nor completes one.
    linkFullTestAttempt: s.fullTests.linkFullTestAttempt,
    // Read on this route's behalf by `checkFullTestLink`, which refuses a link the Run's own rules
    // do not allow BEFORE the Attempt row exists.
    getFullTestRun: s.fullTests.getFullTestRun,
    // The Attempt log names the Run a section belongs to, and abort refuses the section a Run in
    // progress is sitting.
    getFullTestRunForAttempt: s.fullTests.getFullTestRunForAttempt,
    ...s.recording,
    getTranscriptionJob: s.transcription.getTranscriptionJob,
  };
}

/**
 * The Dashboard's store: the two settings members and the six whole-history reads, each picked by name,
 * so the Attempt write surface `...s.attempts` would bring (`createAttempt`, `updateItemScore`,
 * `deleteJudgeReports`, …) is absent from a route that only reads history. `setSetting` is its one
 * write.
 */
export function statsRouteStore(s: SqliteStores): StatsStore {
  return {
    getSetting: s.settings.getSetting,
    setSetting: s.settings.setSetting,
    trendPoints: s.attempts.trendPoints,
    recentScoredItemResults: s.attempts.recentScoredItemResults,
    recentScoredReadingListeningItemResults: s.attempts.recentScoredReadingListeningItemResults,
    listAllJudgeReports: s.attempts.listAllJudgeReports,
    getLatestEstimates: s.estimates.getLatestEstimates,
    recentSimulationBands: s.estimates.recentSimulationBands,
  };
}

/** A Full-Test Run's own aggregate plus the four READS that make a section's state and band status derivable. */
export function fullTestsRouteStore(s: SqliteStores): FullTestStore {
  return {
    ...s.fullTests,
    getAttempt: s.attempts.getAttempt,
    listActiveJobs: s.scoring.listActiveJobs,
    getCurrentTranscriptionJobs: s.transcription.getCurrentTranscriptionJobs,
    getSectionEstimate: s.estimates.getSectionEstimate,
  };
}

/**
 * The Drill Lab's port. One aggregate, so this is a straight pass-through — kept for symmetry with
 * every other route store above, and so routes/drillLab.ts depends on its own declared port rather
 * than on the shape of `SqliteStores`.
 */
export function drillLabRouteStore(s: SqliteStores): DrillLabStore {
  return s.drillLab;
}

/**
 * The generation route and the generation runner share one store; the ports keep them apart.
 *
 * The supersession half is picked by name: `unsupersedeSet` is deliberately not on
 * SupersessionStore, so spreading the aggregate would put an un-retire on the object of the one
 * subsystem whose whole job is retiring Sets.
 */
export function generationStore(s: SqliteStores): GenerateRouteStore {
  return {
    ...s.generation,
    ...s.publication,
    supersedeSet: s.supersession.supersedeSet,
    listSupersededSetIds: s.supersession.listSupersededSetIds,
  };
}

/**
 * The two Speaking coordinators' store. Carries `identity` because `dbFile` is what keeps the
 * transcription coordinator one per database file; see SqliteStores.identity.
 */
export function speakingCoordinatorStore(s: SqliteStores): SpeakingCoordinatorStore {
  return {
    ...s.identity,
    // Picked by name: the coordinators finalize an Attempt the route already opened, so the nine members
    // their two ports declare are named rather than spreading the whole Attempt aggregate.
    getAttempt: s.attempts.getAttempt,
    settleAttempt: s.attempts.settleAttempt,
    updateItemScore: s.attempts.updateItemScore,
    markCaptureFinishedWithMissingItemPlaceholders: s.attempts.markCaptureFinishedWithMissingItemPlaceholders,
    listCaptureFinishedInProgressAttempts: s.attempts.listCaptureFinishedInProgressAttempts,
    // The recovered-transcript handoff's own writes, required by TranscriptionStore: a recovered
    // item's result row and the Judge Reports the ensemble replaces on a rescore.
    insertItemResult: s.attempts.insertItemResult,
    insertJudgeReport: s.attempts.insertJudgeReport,
    deleteJudgeReports: s.attempts.deleteJudgeReports,
    getJudgeReports: s.attempts.getJudgeReports,
    ...s.scoring,
    ...s.transcription,
    ...s.estimates,
  };
}

/**
 * The running server's daily diagnostic retention: the two age prunes and the space they free,
 * picked by name — the timer has no business with any other diagnostic write.
 */
export function diagnosticRetentionStore(s: SqliteStores): DiagnosticRetentionStore {
  return {
    pruneNormalizedModelCalls: s.diagnostics.pruneNormalizedModelCalls,
    pruneClipMeasurements: s.clipMeasurements.pruneClipMeasurements,
    freeSpace: s.diagnostics.freeSpace,
    reclaimFreePages: s.diagnostics.reclaimFreePages,
    compactDatabase: s.diagnostics.compactDatabase,
    checkpointWal: s.diagnostics.checkpointWal,
  };
}

/** The boot passes' store. */
export function bootRecoveryStore(s: SqliteStores): BootRecoveryStore {
  return {
    ...s.identity,
    ...s.attempts,
    ...s.scoring,
    ...s.transcription,
    ...s.generation,
    ...s.publication,
    ...s.supersession,
    ...s.diagnostics,
    pruneClipMeasurements: s.clipMeasurements.pruneClipMeasurements,
    // The manifest-reconciliation pass's one write. The insert alone: promoting a take is for the
    // renderer that publishes it.
    insertClipMeasurement: s.clipMeasurements.insertClipMeasurement,
  };
}
