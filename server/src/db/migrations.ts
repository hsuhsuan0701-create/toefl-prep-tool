import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describeSchema, diffSchemaShapes } from "./schemaShape.js";

// A database's schema version is SQLite's own `PRAGMA user_version`.
//
//   * A new, empty database is created from schema.sql and stamped SCHEMA_VERSION in one
//     transaction. schema.sql always describes the CURRENT version.
//   * A database at version 1 or later is taken forward by MIGRATIONS, in order. Each migration runs
//     in its own write transaction, which also sets user_version to that migration's version, so a
//     crash leaves the database at the last version that fully committed.
//   * A database at version 0 that already has tables predates versioning. It is stamped version 1
//     only if its shape equals schemaV1.sql's; anything else is refused (see
//     UnversionedDatabaseError).
//   * A database whose version is ABOVE SCHEMA_VERSION was written by a newer checkout and is
//     refused rather than used: this code does not know what that version changed.
//   * Before the first change to an existing database — the version-1 stamp included — the runner
//     writes a snapshot of it to backups/ beside the file, and does not migrate without one (see
//     "The backup taken before a migration" below).
//
// Every step re-reads the version inside a write transaction taken before it reads anything
// (`BEGIN IMMEDIATE`), because openDb runs before the execution lease: a dev server's successor and
// a script such as generate-set.ts can open the same file at the same moment, and the one that
// waits must see the other's work rather than repeat it.
//
// ADDING A MIGRATION: append `{ version: <last + 1>, description, up }` to MIGRATIONS, and change
// schema.sql in the same commit so a fresh database is born in the shape the migrations produce.
// db.schemaVersion.test.ts fails if the versions are not contiguous, or if a database migrated up
// from version 1 and a fresh one do not end with the same shape. A migration that rebuilds a table
// other tables reference sets `foreignKeysOff: true` (SQLite's documented rebuild procedure).

const here = path.dirname(fileURLToPath(import.meta.url));

export type Migration = {
  readonly version: number;
  /** What the migration changes, in one line. */
  readonly description: string;
  /** Runs inside the migration's write transaction; throwing rolls the whole migration back. */
  readonly up: (db: Database.Database) => void;
  /**
   * Switches foreign-key enforcement off around the transaction and runs `PRAGMA foreign_key_check`
   * before it commits. SQLite ignores a foreign_keys change made inside a transaction, so the runner
   * does this, not the migration.
   */
  readonly foreignKeysOff?: boolean;
};

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 2,
    description: "drop the legacy model_calls table, which has received no rows since 2026-08-11",
    up: (db) => db.exec("DROP TABLE model_calls"),
  },
  {
    version: 3,
    description: "rewrite failed-arbitration text that names a reasoning provider to the neutral text scoring writes",
    // Before scoreItems.ts wrote the neutral "arbitration failed", a failed arbitration stored the
    // error's String() — "Error: arbiter failed: claude timed out" — in the Item's score_json and in
    // the job's error, both of which the User sees. Matched on the arbiter's own prefix, never on a
    // provider name, which an essay can contain. The literal is this migration's own: a migration
    // records what was true when it was written, whatever scoring writes later.
    up: (db) => {
      db.exec(
        `UPDATE item_results SET score_json = json_set(score_json, '$.error', 'arbitration failed')
          WHERE json_valid(score_json) AND json_extract(score_json, '$.error') LIKE '%arbiter failed:%'`,
      );
      db.exec("UPDATE scoring_jobs SET error = 'arbitration failed' WHERE error LIKE '%arbiter failed:%'");
    },
  },
  {
    version: 4,
    description: "drop transcription_jobs.manual_run and transcription_jobs.resumptions, which nothing reads",
    up: (db) => {
      db.exec("ALTER TABLE transcription_jobs DROP COLUMN manual_run");
      db.exec("ALTER TABLE transcription_jobs DROP COLUMN resumptions");
    },
  },
  {
    version: 5,
    description: "remove the provider names from the progress of scoring jobs that have finished",
    // Live progress names the provider serving a job; a finished job's progress must not, because
    // GET /:id/score-jobs/:jobId serves it for as long as the row exists. Terminal writes drop the
    // fields now (db/stores/scoring.ts); this does the same for the rows finished before they did.
    // The field names are this migration's own, as of when it was written.
    up: (db) => {
      db.exec(
        `UPDATE scoring_jobs
            SET progress = json_remove(progress, '$.openaiJudgeProvider', '$.arbiterProvider', '$.fallbackFrom')
          WHERE status NOT IN ('queued', 'running') AND json_valid(progress)
            AND (json_type(progress, '$.openaiJudgeProvider') IS NOT NULL
              OR json_type(progress, '$.arbiterProvider') IS NOT NULL
              OR json_type(progress, '$.fallbackFrom') IS NOT NULL)`,
      );
    },
  },
  {
    version: 6,
    description: "drop recording_publication_locks, and rewrite 'superseded' scoring jobs as cancelled with reason 'superseded'",
    // The per-Item recording publication lock is held in memory now: the execution lease makes the
    // server the one process that publishes recordings, so the table only ever needed sweeping.
    //
    // A scoring job a newer request replaces is cancelled with cancellation_reason 'superseded'; a
    // job replaced before that was written with status 'superseded'. Rewritten to the same shape, its
    // cancellation and terminal times taken from the row's last update, so nothing reads the old
    // status any more. The CHECK still admits it, because changing a CHECK means rebuilding the table.
    up: (db) => {
      db.exec("DROP TABLE recording_publication_locks");
      db.exec(
        `UPDATE scoring_jobs
            SET status = 'cancelled', cancellation_reason = 'superseded',
                cancel_requested_at = COALESCE(cancel_requested_at, updated_at),
                cancelled_at = COALESCE(cancelled_at, updated_at),
                terminal_at = COALESCE(terminal_at, updated_at)
          WHERE status = 'superseded'`,
      );
    },
  },
  {
    version: 7,
    description: "drop full_test_runs.paced",
    // The column recorded whether a pause screen was used between a Full-Test Run's sections. No
    // hand-off ever reported one, so it held 0 on every Run and nothing reads it.
    up: (db) => {
      db.exec("ALTER TABLE full_test_runs DROP COLUMN paced");
    },
  },
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 1;

/**
 * A commit on main whose openDb still upgrades a database from before versioning to schemaV1.sql's
 * shape (its schema.sql builds exactly that shape). Named in the refusal message, so it must stay
 * reachable in the published history.
 */
export const LAST_COMMIT_WITH_LEGACY_UPGRADES = "fcc6028";

/** The date of the newest change in schemaV1.sql (the backward_buildup_reps table). */
const V1_SHAPE_SINCE = "2026-08-24";

/**
 * A database this checkout will not use as it stands. The message is written for the User and says
 * what to do; the boot path prints it alone and exits (index.ts, openDatabaseAtBoot).
 */
export class DatabaseRefusedError extends Error {}

export class UnversionedDatabaseError extends DatabaseRefusedError {
  constructor(readonly file: string, readonly differences: readonly string[]) {
    const shown = differences.slice(0, 8).map((d) => `  - ${d}`);
    if (differences.length > shown.length) shown.push(`  - …and ${differences.length - shown.length} more`);
    super(
      [
        `${file} has no schema version, and its tables are not the shape this app adopts as version 1:`,
        ...shown,
        `It was last opened by a version of this app from before ${V1_SHAPE_SINCE}. Either start a new database ` +
          `(stop the server and move ${path.basename(file)} and any ${path.basename(file)}-wal and ` +
          `${path.basename(file)}-shm beside it out of ${path.dirname(file)}; the question bank in that ` +
          `directory is not affected), or keep its history by running the server once at commit ` +
          `${LAST_COMMIT_WITH_LEGACY_UPGRADES} (check it out, \`npm ci\`, \`npm start\`, and stop it once it is ` +
          `listening), then starting this version again.`,
      ].join("\n"),
    );
    this.name = "UnversionedDatabaseError";
  }
}

export class DatabaseFromNewerVersionError extends DatabaseRefusedError {
  constructor(readonly file: string, readonly version: number, known: number) {
    super(
      `${file} is at schema version ${version}, but this checkout only knows versions up to ${known}. ` +
        "A newer version of this app has upgraded it; run that version (or a newer one) against it.",
    );
    this.name = "DatabaseFromNewerVersionError";
  }
}

export class MigrationBackupError extends DatabaseRefusedError {
  constructor(readonly file: string, readonly backupDir: string, readonly version: number, target: number, cause: unknown) {
    super(
      `${file} needs migrating from schema version ${version} to ${target}, and it was not migrated: its backup ` +
        `could not be written to ${backupDir} (${cause instanceof Error ? cause.message : String(cause)}). ` +
        `The database is unchanged. Make ${backupDir} a writable directory with room for a copy of the ` +
        "database, then start the server again.",
    );
    this.name = "MigrationBackupError";
  }
}

// ---------------------------------------------------------------------------------------------
// The backup taken before a migration
// ---------------------------------------------------------------------------------------------
//
// The runner changes a database the User has no other copy of, so before its first write to an
// existing database it snapshots it with VACUUM INTO: a consistent copy taken inside one read
// transaction, including whatever is still only in the -wal file, which a copy of the .sqlite file
// would miss. The snapshot goes to backups/ beside the database, as
// `<stem>-before-migration-from-v<version>-<UTC timestamp>.sqlite`, and only the three most recent
// files of exactly that pattern are kept: anything else in that directory (a backup the User made
// by hand, say) is never touched. No snapshot, no migration: a failure stops with
// MigrationBackupError before anything is written.

const SNAPSHOTS_KEPT = 3;
const STALE_PARTIAL_MS = 60 * 60 * 1000;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A finished snapshot of the database whose file name (without extension) is `stem`. */
function snapshotPattern(stem: string): RegExp {
  return new RegExp(`^${escapeRegExp(stem)}-before-migration-from-v(\\d+)-(\\d{8}T\\d{9}Z)\\.sqlite$`);
}

/** A snapshot still under its temporary name: being written, or left by a crash while it was. */
function partialPattern(stem: string): RegExp {
  return new RegExp(`^${escapeRegExp(stem)}-before-migration-\\d{8}T\\d{9}Z\\.partial$`);
}

/** 2026-11-12T01:34:00.123Z -> 20261112T013400123Z: sortable, and legal in every file system. */
function fileStamp(at: Date): string {
  return at.toISOString().replace(/[-:.]/g, "");
}

export type MigrationBackup = {
  /** Where snapshots go; null takes none (an in-memory database). */
  readonly dir: string | null;
  readonly log: (line: string) => void;
  readonly now: () => Date;
};

/** backups/ beside the database file, whichever directory that is. */
export function defaultMigrationBackup(db: Database.Database): MigrationBackup {
  return {
    dir: db.memory ? null : path.join(path.dirname(path.resolve(db.name)), "backups"),
    log: (line) => console.log(line),
    now: () => new Date(),
  };
}

function writeSnapshot(db: Database.Database, file: string, version: number, target: number, backup: MigrationBackup & { dir: string }): void {
  const stem = path.basename(db.name, path.extname(db.name));
  const stamp = fileStamp(backup.now());
  const partial = path.join(backup.dir, `${stem}-before-migration-${stamp}.partial`);
  let written: string;
  try {
    fs.mkdirSync(backup.dir, { recursive: true });
    fs.rmSync(partial, { force: true });
    db.prepare("VACUUM INTO ?").run(partial);
    // Named after the version the snapshot itself holds: another process can migrate the file
    // between the read that decided a backup was needed and the snapshot.
    const snapshot = new Database(partial, { readonly: true });
    let held: number;
    try {
      const check = snapshot.pragma("quick_check", { simple: true });
      if (check !== "ok") throw new Error(`the snapshot failed its integrity check: ${String(check)}`);
      held = userVersion(snapshot);
    } finally {
      snapshot.close();
    }
    written = path.join(backup.dir, `${stem}-before-migration-from-v${held}-${stamp}.sqlite`);
    fs.renameSync(partial, written);
  } catch (err) {
    try {
      fs.rmSync(partial, { force: true });
    } catch {
      // The refusal below already says the directory is unusable.
    }
    throw new MigrationBackupError(file, backup.dir, version, target, err);
  }
  backup.log(`[db] backed up ${file} at schema version ${version} to ${written} before migrating it to version ${target}`);
  pruneSnapshots(backup.dir, stem, backup.now(), backup.log);
}

function pruneSnapshots(dir: string, stem: string, now: Date, log: (line: string) => void): void {
  const pattern = snapshotPattern(stem);
  const partial = partialPattern(stem);
  try {
    const names = fs.readdirSync(dir);
    const stampOf = (name: string) => pattern.exec(name)![2]!;
    const ours = names.filter((name) => pattern.test(name)).sort((a, b) => stampOf(b).localeCompare(stampOf(a)));
    // A partial is left by a snapshot that crashed. One untouched for longer than any snapshot takes
    // is stale; a younger one may be another process's snapshot still being written.
    const stale = names.filter((name) => partial.test(name) && now.getTime() - fs.statSync(path.join(dir, name)).mtimeMs > STALE_PARTIAL_MS);
    for (const name of [...ours.slice(SNAPSHOTS_KEPT), ...stale]) fs.rmSync(path.join(dir, name), { force: true });
  } catch (err) {
    // The new snapshot is written, which is what the migration needed; an old one left behind is
    // only disk space.
    log(`[db] could not remove older backups in ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function readSql(file: string): string {
  return fs.readFileSync(path.join(here, file), "utf8");
}

export function userVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function setUserVersion(db: Database.Database, version: number): void {
  // Integer-checked before it is interpolated: PRAGMA takes no bound parameters.
  if (!Number.isSafeInteger(version) || version < 0) throw new Error(`invalid schema version ${version}`);
  db.pragma(`user_version = ${version}`);
}

function hasTables(db: Database.Database): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get() !== undefined;
}

/** schemaV1.sql's shape, built in a private in-memory database. */
function versionOneShape() {
  const reference = new Database(":memory:");
  try {
    reference.exec(readSql("schemaV1.sql"));
    return describeSchema(reference);
  } finally {
    reference.close();
  }
}

/**
 * Brings `db` to SCHEMA_VERSION, or throws without changing it. `file` names the database in error
 * messages. `migrations` is injectable for tests; openDb passes MIGRATIONS. An existing database is
 * snapshotted (`backup`) before the first change to it; a new one, one already current and one this
 * refuses are not.
 */
export function migrateToCurrentVersion(
  db: Database.Database,
  file: string,
  migrations: readonly Migration[] = MIGRATIONS,
  backup: MigrationBackup = defaultMigrationBackup(db),
): void {
  const target = migrations.at(-1)?.version ?? 1;

  // Decided outside a transaction, because VACUUM INTO cannot run inside one; each step below still
  // re-reads the version under its own write lock. The shape check is repeated here so a database
  // that is about to be refused gets no snapshot.
  const before = userVersion(db);
  if (before > target) throw new DatabaseFromNewerVersionError(file, before, target);
  if (before < target && (before !== 0 || hasTables(db)) && backup.dir !== null) {
    if (before === 0) {
      const differences = diffSchemaShapes(versionOneShape(), describeSchema(db));
      if (differences.length > 0) throw new UnversionedDatabaseError(file, differences);
    }
    writeSnapshot(db, file, before, target, { ...backup, dir: backup.dir });
  }

  db.transaction(() => {
    if (userVersion(db) !== 0) return;
    if (!hasTables(db)) {
      db.exec(readSql("schema.sql"));
      setUserVersion(db, target);
      return;
    }
    const differences = diffSchemaShapes(versionOneShape(), describeSchema(db));
    if (differences.length > 0) throw new UnversionedDatabaseError(file, differences);
    setUserVersion(db, 1);
  }).immediate();

  const version = userVersion(db);
  if (version > target) throw new DatabaseFromNewerVersionError(file, version, target);

  for (const migration of migrations) {
    if (migration.version > version) applyMigration(db, migration);
  }
}

function applyMigration(db: Database.Database, migration: Migration): void {
  const foreignKeysWereOn = db.pragma("foreign_keys", { simple: true }) === 1;
  if (migration.foreignKeysOff) db.pragma("foreign_keys = OFF");
  try {
    db.transaction(() => {
      const current = userVersion(db);
      if (current >= migration.version) return;
      if (current !== migration.version - 1) {
        throw new Error(`schema migration ${migration.version} needs version ${migration.version - 1}, found ${current}`);
      }
      migration.up(db);
      if (migration.foreignKeysOff) {
        const dangling = db.pragma("foreign_key_check") as unknown[];
        if (dangling.length > 0) {
          throw new Error(`schema migration ${migration.version} left dangling foreign keys: ${JSON.stringify(dangling)}`);
        }
      }
      setUserVersion(db, migration.version);
    }).immediate();
  } finally {
    if (migration.foreignKeysOff) db.pragma(`foreign_keys = ${foreignKeysWereOn ? "ON" : "OFF"}`);
  }
}
