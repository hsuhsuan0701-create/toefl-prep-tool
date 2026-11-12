# The schema is versioned, migrated in order, and backed up before it changes

## Status

Accepted.

## Context

`db.sqlite` holds the User's only copy of their Attempts, scores and settings. Until this decision
the database recorded no schema version. `openDb` worked out what state a file was in by reading the
`CREATE` text SQLite had stored and patching what it found, with three table rebuilds copied by hand
from `schema.sql`, one of them already out of date. A change could not be applied in a known order,
a database written by a newer checkout could not be recognised, and nothing kept a copy of the file
before a change rewrote it.

## Decision

**The schema version is SQLite's own `PRAGMA user_version`, and `server/src/db/migrations.ts` holds
the ordered list of changes (`MIGRATIONS`).**

- A new, empty database is created from `schema.sql` and stamped with the current version in one
  transaction. `schema.sql` always describes the current version.
- A database at version 1 or later is taken forward by each later migration in turn. Each runs in
  its own write transaction, taken before anything is read (`BEGIN IMMEDIATE`), which also sets
  `user_version`, so a crash leaves the database at the last version that fully committed and a
  second process opening the same file waits rather than repeating the work.
- A migration that rebuilds a table other tables reference sets `foreignKeysOff`: the runner turns
  enforcement off around the transaction and runs `PRAGMA foreign_key_check` before it commits.
- A database from before versioning (version 0 with tables) is adopted as version 1 only when its
  shape equals `schemaV1.sql`. Anything else is refused, untouched, with a message listing what
  differs and two ways forward: start a new database, or run the server once at the last commit that
  still carried the old upgrade code (`LAST_COMMIT_WITH_LEGACY_UPGRADES`) and then this version.
- A database at a version above the newest this checkout knows was written by a newer checkout, and
  is refused rather than used.
- Boot prints a refusal's message alone and exits (`openDatabaseAtBoot` in `server/src/index.ts`).

**Before the first change to an existing database, the runner writes a snapshot of it.**

- The snapshot is a `VACUUM INTO` copy in `backups/` beside the database, which includes what is
  still only in the `-wal` file, as a copy of the `.sqlite` file would not. It is written under a
  temporary name, checked with `PRAGMA quick_check`, then renamed to
  `<name>-before-migration-from-v<version>-<UTC time>.sqlite`.
- The three newest snapshots are kept. Older ones of exactly that name pattern, and a temporary file
  a crash left more than an hour ago, are removed; nothing else in `backups/` is touched.
- No snapshot, no migration: if it cannot be written, the server stops with a message naming the
  directory and changes nothing.
- A new database, one already current, and one that is about to be refused get no snapshot.

The migrations so far: 2 drops the legacy `model_calls` table (ADR 0004); 3 and 5 take provider
names out of a failed arbitration's stored text and out of finished scoring jobs' progress, which
score-bearing state must not carry (ADR 0003); 4 drops two `transcription_jobs` columns nothing
reads; 6 drops `recording_publication_locks`, whose per-Item lock is now held in memory because the
execution lease makes the server the one process that publishes recordings, and rewrites scoring
jobs stored with the old status `superseded` as `cancelled` with reason `superseded`; 7 drops
`full_test_runs.paced`, which no section hand-off ever set.

## Considered Options

- **Keep detecting the state from the stored `CREATE` text**: rejected. It is how the rebuilds
  drifted, and it cannot tell a database from a newer checkout from a damaged one.
- **Copy the `.sqlite` file as the backup**: rejected. Under WAL a committed change can still be only
  in the `-wal` file, so the copy could miss it.

## Consequences

A schema change is one new entry at the end of `MIGRATIONS` plus the same change in `schema.sql`, in
one commit. `server/test/db.schemaVersion.test.ts` fails if the versions are not contiguous or if a
database migrated up from version 1 and a new one end in different shapes, and it covers the
refusals and the transaction rules. `server/test/migrationBackup.test.ts` pins the snapshot: taken
before the first change with WAL contents included, not taken where none is needed, required for a
migration, and pruned to three.

A database last opened by a version from before 2026-08-24 cannot be adopted directly; its owner has
to pass through the named commit once or start over. The snapshots cost disk space equal to the
database each time a migration runs, three times at most.
