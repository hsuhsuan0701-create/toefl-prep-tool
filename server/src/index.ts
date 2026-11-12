import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { config } from "./lib/config.js";
import { localRequestGuard } from "./lib/localRequestGuard.js";
import { reportSetLoadFailures, setAttemptedSetIdsReader, setsRoutes } from "./routes/sets.js";
import { buildGenerateRoutes } from "./routes/generate.js";
import { audioRoutes } from "./routes/audio.js";
import { imageRoutes } from "./routes/images.js";
import { buildAttemptsRoutes, type AttemptsRouteDeps } from "./routes/attempts.js";
import { buildFullTestRoutes } from "./routes/fullTests.js";
import { buildStatsRoutes } from "./routes/stats.js";
import { buildDrillLabRoutes } from "./routes/drillLab.js";
import { buildProviderRoutes } from "./routes/providers.js";
import type Database from "better-sqlite3";
import { openDb } from "./db/db.js";
import { DatabaseRefusedError } from "./db/migrations.js";
import {
  attemptsRouteStore,
  bootRecoveryStore,
  createSqliteStores,
  diagnosticRetentionStore,
  drillLabRouteStore,
  fullTestsRouteStore,
  generationStore,
  speakingCoordinatorStore,
  statsRouteStore,
  type SqliteStores,
} from "./db/stores/index.js";
import { wireBootRecoveryPasses, type BootRecoveryStore } from "./services/bootRecoveryRegistry.js";
import {
  createRepoModelCallSink,
  flushModelCallRecorder,
  setModelCallSink,
  startDiagnosticRetention,
} from "./services/modelCallLog.js";
import {
  createRepoClipMeasurementSink,
  setClipMeasurementSink,
} from "./services/clipMeasurementLog.js";
import {
  createRepoSupersededSetIdsReader,
  setSupersededSetIdsReader,
} from "./services/supersession.js";
import {
  createSpeakingCoordinators,
  type SpeakingCoordinators,
  type SpeakingFinalization,
} from "./services/speakingFinalization.js";
import type { BootRecoveryServer } from "./services/scoringJobs.js";
import { safeErrorDescriptor, type TranscriptionRecovery } from "./services/transcriptionRecovery.js";
import {
  buildReasoningStatus,
  preflightProviders,
  startProviderPreflight,
} from "./services/reasoning/preflight.js";
import { buildSetupStatusRoutes, createCliPreflightRecord, isOnPath } from "./routes/setupStatus.js";
import { rubricsSource } from "./services/skillReferences.js";
import {
  createExecutionOwner,
  EXECUTION_LEASE_EXPIRY_MS,
  EXECUTION_LEASE_HEARTBEAT_MS,
  ExecutionLeaseUnavailableError,
  ExecutionOwnerStoppedError,
  type ExecutionOwner,
} from "./services/executionOwner.js";
import { createRepoProviderCircuitPersistence } from "./services/reasoning/providerQuotaStore.js";
import {
  generationJobCancellations,
  scoringJobCancellations,
  setJobAdmissionReadiness,
  stopJobAdmissions,
} from "./services/jobCancellation.js";
import { runShutdownProtocol, type ShutdownProtocolInput } from "./services/shutdownCoordinator.js";
import { sqliteTimestamp } from "./db/timestamps.js";
import { providerState } from "./services/reasoning/providerState.js";

// The boot-recovery chain, exported so the suite can run it: the composition block below is guarded
// by `NODE_ENV !== "test"` and never runs under test. The order lives in bootRecoveryRegistry.ts's
// declared phases, not here. The finalizer is the process's own, so the last pass reconciles through
// the same instance the routes use; nothing in the chain spends money.
export function wireAllBootRecovery(
  server: BootRecoveryServer,
  appRepo: BootRecoveryStore,
  coordinators: { speakingFinalization: Pick<SpeakingFinalization, "reconcileAttempt"> },
): void {
  wireBootRecoveryPasses(server, { repo: appRepo, speakingFinalization: coordinators.speakingFinalization });
}

/**
 * Runs the same recovery chain after the execution lease has been acquired. Each pass is awaited
 * before the next starts, and the returned promise settles only once all of them have, so the
 * lease's readiness gate opens after recovery rather than during it.
 */
export async function runAllBootRecovery(
  appRepo: BootRecoveryStore,
  coordinators: { speakingFinalization: Pick<SpeakingFinalization, "reconcileAttempt"> },
): Promise<void> {
  const listeners: Array<() => unknown> = [];
  wireAllBootRecovery({ on: (_event, listener) => { listeners.push(listener); } }, appRepo, coordinators);
  for (const listener of listeners) await listener();
}

/**
 * Opens the database for boot. A database this checkout refuses (DatabaseRefusedError) is reported
 * by its own message alone on stderr, and the process exits 1 once that line is written; the caller
 * gets undefined and composes nothing. Exiting from the write callback, as the lease and port
 * failures below do, because stderr is asynchronous when it is a pipe and an immediate exit can drop
 * the one line that says what to do. Any other failure is a bug and is thrown as it is.
 */
export function openDatabaseAtBoot(
  open: () => Database.Database,
  io: { writeStderr: (text: string, done: () => void) => void; exit: (code: number) => void },
): Database.Database | undefined {
  try {
    return open();
  } catch (err) {
    if (!(err instanceof DatabaseRefusedError)) throw err;
    io.writeStderr(`${err.message}\n`, () => io.exit(1));
    return undefined;
  }
}

/**
 * Mounts every route that reads or writes the database on `target`, each over the store composition
 * its port declares, and points the Set listing's `attempted` flag at the Attempt store. The boot
 * block below calls it once, with the process's own coordinators. `media` is the Attempts route's
 * ffmpeg seam: production passes none and gets the real binaries; the composed-app test passes
 * in-process fakes.
 */
export function mountDatabaseRoutes(
  target: Hono,
  stores: SqliteStores,
  coordinators: SpeakingCoordinators,
  media: Pick<AttemptsRouteDeps, "transcode" | "probeDurationSec"> = {},
): void {
  // GET /api/sets stamps each Set `attempted` from the Attempt store (ATTEMPT_COUNTS_AS_SITTING_SQL).
  setAttemptedSetIdsReader(() => new Set(stores.attempts.listSetIdsCountedAsAttempted()));
  target.route("/api/generate", buildGenerateRoutes({ repo: generationStore(stores) }));
  target.route("/api/attempts", buildAttemptsRoutes({ repo: attemptsRouteStore(stores), ...coordinators, ...media }));
  target.route("/api/stats", buildStatsRoutes({ repo: statsRouteStore(stores) }));
  target.route("/api/drill-lab", buildDrillLabRoutes({ repo: drillLabRouteStore(stores) }));
  target.route("/api/full-tests", buildFullTestRoutes({ repo: fullTestsRouteStore(stores) }));
}

/**
 * The job families' part of a graceful shutdown, as runShutdownProtocol takes it. Generation,
 * scoring and transcription take part alike: admissions close (which also stops transcription's
 * retry timer from starting a call), the drain waits for every family's active work within the one
 * grace period, and what is still running at its end is recorded and then aborted, so each row ends
 * in a state the User can act on rather than 'running'.
 */
export function jobFamilyShutdown(
  stores: Pick<SqliteStores, "generation" | "scoring">,
  transcription: Pick<TranscriptionRecovery, "activeCount" | "interruptForShutdown">,
): Pick<ShutdownProtocolInput, "stopAdmissions" | "activeCount" | "persistCancellation" | "abortRemaining"> {
  return {
    stopAdmissions: stopJobAdmissions,
    activeCount: () =>
      generationJobCancellations.activeCount + scoringJobCancellations.activeCount + (transcription.activeCount?.() ?? 0),
    persistCancellation: () => {
      const now = sqliteTimestamp();
      for (const job of stores.generation.listInterruptedGenerationJobs()) {
        stores.generation.requestGenerationJobCancellation({ id: job.id, reason: "shutdown", now });
      }
      for (const job of stores.scoring.listInterruptedJobs()) {
        stores.scoring.requestScoringJobCancellation({ id: job.id, reason: "shutdown", now });
      }
    },
    abortRemaining: () => {
      generationJobCancellations.cancelAll("shutdown");
      scoringJobCancellations.cancelAll("shutdown");
      transcription.interruptForShutdown?.();
    },
  };
}

export const app = new Hono();
// First, so it runs in front of every route registered below.
app.use("/api/*", localRequestGuard());
app.get("/api/health", (c) => c.json({ ok: true }));
let executionOwner: ExecutionOwner | undefined;
app.get("/api/ready", (c) => {
  const readiness = executionOwner?.readiness() ?? { ready: true as const };
  return c.json(readiness, readiness.ready ? 200 : 503);
});
app.route("/api/sets", setsRoutes);
app.route("/api/audio", audioRoutes);
app.route("/api/images", imageRoutes);
app.route(
  "/api/providers",
  buildProviderRoutes({ snapshot: buildReasoningStatus }),
);
const cliPreflight = createCliPreflightRecord({
  activityVersion: (provider) => providerState.captureActivityToken(provider).version,
  runChecks: (onChecked) => preflightProviders({ onChecked }),
});
app.route(
  "/api/setup-status",
  buildSetupStatusRoutes({
    providers: () => providerState.snapshot(),
    preflight: cliPreflight.outcomes,
    rubricsSource: () => rubricsSource(),
    recheckClis: cliPreflight.run,
    settings: () => ({
      geminiApiKey: config.geminiKey,
      openaiApiKey: config.openaiKey,
      geminiJudgeModel: config.geminiJudgeModel,
      openaiJudgeModel: config.openaiJudgeModel,
      openaiTextPrimary: config.openaiTextPrimary,
    }),
    onPath: (bin) => isOnPath(bin),
  }),
);

const bootDb = process.env.NODE_ENV === "test"
  ? undefined
  : openDatabaseAtBoot(() => openDb(), {
      writeStderr: (text, done) => { process.stderr.write(text, done); },
      exit: (code) => process.exit(code),
    });

if (bootDb) {
  // The database composition root. `createSqliteStores` hands back the aggregates side by side, and
  // every line below narrows to the port its consumer declared, so no route, sink or coordinator
  // receives a handle wider than its own aggregate.
  const stores = createSqliteStores(bootDb);
  const bootRepo = bootRecoveryStore(stores);
  // Keeps a hard-quota circuit across restarts; providerQuotaStore.ts translates the rows, which hold
  // ISO-8601 by decision (docs/adr/0008).
  providerState.configurePersistence(createRepoProviderCircuitPersistence(stores.providerQuota));

  // The transcript log's one write handle, installed here rather than defaulted inside the module:
  // a default that opened its own database would give this process a second writer to the same file
  // as a side effect of an import. Installed before any route is mounted so no call can slip past
  // it. Until this line runs the recorder is a no-op, which is exactly what the test suite wants.
  setModelCallSink(createRepoModelCallSink(stores.diagnostics));
  setClipMeasurementSink(createRepoClipMeasurementSink(stores.clipMeasurements));
  // The Set listing (routes/sets.ts) and the Catalog (generationPlanner.ts) need to know which Sets
  // are retired, and neither may open its own handle to this database. Until this runs, no Set reads
  // as retired.
  setSupersededSetIdsReader(createRepoSupersededSetIdsReader(stores.supersession));

  // Both Speaking coordinators, the cycle between them and the composed scoring-terminal callback come
  // from createSpeakingCoordinators. The coordinator is memoized per database, so this is the only
  // instance this process can have. The store is built once and held in a const so the memo's
  // object-identity key hits, as well as its `dbFile` fallback.
  const speakingCoordinatorRepo = speakingCoordinatorStore(stores);
  const coordinators = createSpeakingCoordinators({
    repo: speakingCoordinatorRepo,
    admissionReady: () => executionOwner?.readiness().ready === true,
  });

  mountDatabaseRoutes(app, stores, coordinators);

  // tsx watch (npm run dev) kills and restarts this process on every file change. The old
  // process can take a moment to fully release the port, so the new one can hit EADDRINUSE.
  // Left unhandled, that's an uncaught exception that kills the process — a crash loop that
  // (during dev-server churn) can strand an in-flight scoring request mid-drill. Retry instead.
  const MAX_LISTEN_ATTEMPTS = 10;
  const RETRY_DELAY_MS = 300;
  let listenAttempts = 0;

  const server = serve({ fetch: app.fetch, port: config.port, hostname: "127.0.0.1" });

  // The longest a graceful shutdown can take before it force-exits.
  const FORCE_EXIT_MS = config.shutdownDrainMs + config.shutdownRecorderFlushMs + config.shutdownProcessGraceMs + 1_000;
  let shuttingDown = false;
  const abandonLeaseWait = new AbortController();
  let stopDiagnosticRetention: (() => void) | undefined;

  executionOwner = createExecutionOwner(stores.executionLease, {
    onLeaseLost: () => {
      stopJobAdmissions();
      coordinators.transcriptionRecovery.abortActive?.();
      generationJobCancellations.cancelAll("shutdown");
      scoringJobCancellations.cancelAll("shutdown");
    },
    onWaitingForLease: () => {
      console.log(
        "[server] another server process holds this database's execution lease (or exited moments " +
          "ago without releasing it); waiting for it before starting jobs. /api/ready answers 503 until then.",
      );
    },
    // Long enough to outlast a predecessor that is still draining (it keeps heartbeating until it
    // force-exits) plus the expiry of a predecessor killed mid-drain.
    acquireTimeoutMs: FORCE_EXIT_MS + EXECUTION_LEASE_EXPIRY_MS + EXECUTION_LEASE_HEARTBEAT_MS,
  });
  setJobAdmissionReadiness(() => executionOwner?.readiness().ready === true);
  server.on("listening", () => {
    void executionOwner?.start(() => runAllBootRecovery(bootRepo, coordinators), {
      signal: abandonLeaseWait.signal,
    }).then(() => {
      // Boot recovery has pruned once already. From here a long-running server prunes daily, and
      // reclaims the freed space only while no job is running and this process owns the database.
      if (shuttingDown) return;
      stopDiagnosticRetention = startDiagnosticRetention({
        repo: diagnosticRetentionStore(stores),
        isIdle: () =>
          executionOwner?.readiness().ready === true &&
          generationJobCancellations.activeCount + scoringJobCancellations.activeCount === 0,
      });
    }).catch((err) => {
      if (shuttingDown || err instanceof ExecutionOwnerStoppedError) return;
      const message = err instanceof ExecutionLeaseUnavailableError
        ? `[server] another server process is still using ${path.join(config.dataDir, "db.sqlite")}: ` +
          `its execution lease stayed held for ${Math.round(err.waitedMs / 1000)}s. Stop that server ` +
          "(another `npm run dev` or `npm start`, possibly on a different PORT with the same " +
          "TOEFL_DATA_DIR) and start this one again, or point TOEFL_DATA_DIR at a different directory. Exiting."
        : `[server] boot recovery failed; exiting: ${safeErrorDescriptor(err)}`;
      // Exit from the write callback: stderr is asynchronous when it is a pipe (as under
      // `concurrently`), and an immediate exit can drop the one line that says what to do.
      process.stderr.write(`${message}\n`, () => process.exit(1));
    });
  });

  server.on("listening", () => {
    console.log(`server on :${config.port}`);
    // Name every Set file the bank cannot show, and why, once per boot. Outside the boot-recovery
    // chain because it heals nothing and touches no database; reportSetLoadFailures never throws, so it
    // cannot abort the rest of this listener.
    reportSetLoadFailures(config.dataDir);
    startProviderPreflight(cliPreflight.run);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code !== "EADDRINUSE") {
      throw err;
    }
    listenAttempts += 1;
    if (listenAttempts > MAX_LISTEN_ATTEMPTS) {
      // Exit from the write callback, as the lease path does: stderr is asynchronous when it is a
      // pipe, and an immediate exit can drop the one line that says why.
      process.stderr.write(
        `[server] port ${config.port} still in use after ${MAX_LISTEN_ATTEMPTS} attempts (EADDRINUSE) — giving up. Is another instance already running on this port?\n`,
        () => process.exit(1),
      );
      return;
    }
    console.error(
      `[server] port ${config.port} already in use (EADDRINUSE) — retrying in ${RETRY_DELAY_MS}ms (attempt ${listenAttempts}/${MAX_LISTEN_ATTEMPTS})`,
    );
    setTimeout(() => {
      server.listen(config.port, "127.0.0.1");
    }, RETRY_DELAY_MS);
  });

  // Graceful shutdown: release the port promptly on restart/interrupt instead of relying on
  // the OS to reclaim it, so the *next* process doesn't have to retry-loop into an open port.
  //
  // The execution lease is NOT released before the drain: jobs still run during it, and a successor
  // that took the lease would run boot recovery over them. It is released once they have settled,
  // or at the forced exit. A successor started meanwhile waits for it (see createExecutionOwner).
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[server] received ${signal}, shutting down...`);
    abandonLeaseWait.abort();
    stopDiagnosticRetention?.();
    const forceExit = setTimeout(() => {
      console.error("[server] graceful shutdown timed out, forcing exit");
      executionOwner?.stop();
      process.exit(1);
    }, FORCE_EXIT_MS);
    forceExit.unref();
    server.close();
    void runShutdownProtocol({
      ...jobFamilyShutdown(stores, coordinators.transcriptionRecovery),
      flushRecorder: async () => { await flushModelCallRecorder(config.shutdownRecorderFlushMs); },
      drainMs: config.shutdownDrainMs,
      recorderFlushMs: config.shutdownRecorderFlushMs,
    }).then(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, config.shutdownProcessGraceMs));
      executionOwner?.stop();
      clearTimeout(forceExit);
      process.exit(0);
    }).catch((err) => {
      console.error("[server] graceful shutdown failed:", safeErrorDescriptor(err));
      executionOwner?.stop();
      process.exit(1);
    });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
