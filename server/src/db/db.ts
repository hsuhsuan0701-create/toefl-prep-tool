import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { config } from "../lib/config.js";
import { migrateToCurrentVersion } from "./migrations.js";

/**
 * Opens the app's database (by default `<dataDir>/db.sqlite`) and brings its schema to the current
 * version — see migrations.ts. Throws, with the connection closed, if the file is a database this
 * checkout cannot adopt.
 */
export function openDb(dbPath?: string): Database.Database {
  const target = dbPath ?? path.join(config.dataDir, "db.sqlite");
  if (target !== ":memory:") fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new Database(target);
  try {
    // Lets diagnostic retention hand pruned pages back to the file system a few at a time
    // (PRAGMA incremental_vacuum) instead of only by a whole-file VACUUM. It takes effect only on a
    // database that has no tables yet, and only if set before the switch to WAL; an older database
    // is converted the first time a large prune compacts it (see modelCallLog.ts). Not set on an
    // existing database, where the statement would write to the file on every open.
    const isNew = db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get() === undefined;
    if (isNew) db.pragma("auto_vacuum = INCREMENTAL");
    db.pragma("journal_mode = WAL");
    // Both stated rather than inherited from however the bundled SQLite was compiled. Diagnostic
    // pruning deletes route_invocations and relies on ON DELETE CASCADE to clear model_attempts, the
    // largest table; FULL makes every committed transaction survive a power cut. Set outside any
    // transaction, where SQLite ignores a foreign_keys change.
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    migrateToCurrentVersion(db, target);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}
