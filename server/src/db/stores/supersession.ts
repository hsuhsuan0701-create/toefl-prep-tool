import type Database from "better-sqlite3";
import type { Supersession } from "@toefl-prep/shared";
import { sqliteTimestamp } from "../timestamps.js";
import type { SupersessionStore } from "../../services/supersession.js";
import {
  readSupersessionManifest,
  writeSupersessionManifest,
  type SupersessionIndexStore,
} from "../../services/supersessionManifest.js";

// ---------------------------------------------------------------------------------------------
// The Set-supersession aggregate: the tracked manifest plus its SQLite index
// ---------------------------------------------------------------------------------------------
//
// `manifestPath` (data/question-sets/supersessions.json in production) is the record of which Sets
// are retired; `superseded_sets` is the index the listing and the Catalog read. Every write here
// changes both inside one SQLite transaction: the row first, then the manifest (temp file + rename).
// If the manifest write throws, the transaction rolls the row back, so the table never holds a
// retirement the file lacks. Doing the SQL statement first also means the manifest's
// read-modify-write runs while this connection holds SQLite's write lock, which serialises it
// against another process retiring a Set over the same database.
//
// A crash after the rename but before the commit leaves the manifest ahead of the table. For a
// retirement the next boot's manifest pass inserts the missing row. For an un-retirement the table
// keeps a row the manifest has dropped, until it is deleted again.
//
// `unsupersedeSet` and `insertSupersessionIfAbsent` are not on SupersessionStore, which is
// intersected into the generation runner's store: the runner may retire a Set, never un-retire one,
// and only the boot pass inserts from the manifest.

export function createSqliteSupersessionStore(db: Database.Database, manifestPath: string) {
  const supersede = db.transaction((pair: Supersession) => {
    db.prepare("INSERT OR REPLACE INTO superseded_sets (set_id, superseded_by, superseded_at) VALUES (?,?,?)")
      .run(pair.setId, pair.supersededBy, pair.supersededAt);
    const others = readSupersessionManifest(manifestPath).filter((p) => p.setId !== pair.setId);
    writeSupersessionManifest(manifestPath, [...others, pair]);
  });

  const unsupersede = db.transaction((setId: string): boolean => {
    const deleted = db.prepare("DELETE FROM superseded_sets WHERE set_id=?").run(setId).changes > 0;
    const pairs = readSupersessionManifest(manifestPath);
    const kept = pairs.filter((p) => p.setId !== setId);
    if (kept.length !== pairs.length) writeSupersessionManifest(manifestPath, kept);
    return deleted || kept.length !== pairs.length;
  });

  return {
    // Recorded only once a replacement Set has actually published (recordSupersessionOnPublication).
    // Retiring the same Set again re-points it at the newer replacement in both places.
    supersedeSet(input: { setId: string; supersededBy: string; at?: string }): void {
      supersede({ setId: input.setId, supersededBy: input.supersededBy, supersededAt: input.at ?? sqliteTimestamp() });
    },
    // Read as a whole: every caller (the Catalog builder, the Set picker) filters a list against the
    // complete set, and the table holds one row per retired Set.
    listSupersededSetIds(): Set<string> {
      const rows = db.prepare("SELECT set_id FROM superseded_sets").all() as { set_id: string }[];
      return new Set(rows.map((row) => row.set_id));
    },
    // Restores the Set to the Catalog and the picker. Returns whether either the table or the
    // manifest held a pair for it.
    unsupersedeSet(setId: string): boolean {
      return unsupersede(setId);
    },
    // The boot pass's insert: a row the table already has is never replaced.
    insertSupersessionIfAbsent(pair: Supersession): boolean {
      return db.prepare("INSERT OR IGNORE INTO superseded_sets (set_id, superseded_by, superseded_at) VALUES (?,?,?)")
        .run(pair.setId, pair.supersededBy, pair.supersededAt).changes > 0;
    },
  } satisfies SupersessionStore & SupersessionIndexStore & { unsupersedeSet(setId: string): boolean };
}
