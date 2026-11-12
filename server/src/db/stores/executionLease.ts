import type Database from "better-sqlite3";
import type { ExecutionLeaseStore } from "../../services/executionOwner.js";

// ---------------------------------------------------------------------------------------------
// The execution-lease aggregate, over SQLite
// ---------------------------------------------------------------------------------------------
//
// Table: `execution_lease` (one row, `singleton=1`). The single-writer guard for the whole process:
// acquire is a compare-and-write inside a transaction, and both the heartbeat and the release are
// token-guarded and report whether they won, so a process that has already lost the lease learns it
// from the answer instead of assuming.
//
// The expiry check compares timestamps as strings, which is why the port brands them
// (executionOwner.test.ts's `@ts-expect-error` guard): an ISO value sorts above every same-day
// space-form value, so a lease written that way would look live forever.

export function createSqliteExecutionLeaseStore(db: Database.Database) {
  return {

    acquireExecutionLease(i: { ownerToken: string; now: string; expiresAt: string }): boolean {
      return db.transaction(() => {
        const current = db.prepare("SELECT owner_token,expires_at FROM execution_lease WHERE singleton=1").get() as {owner_token:string;expires_at:string}|undefined;
        if (current && current.owner_token !== i.ownerToken && current.expires_at > i.now) return false;
        db.prepare(`INSERT INTO execution_lease(singleton,owner_token,heartbeat_at,expires_at) VALUES(1,?,?,?)
          ON CONFLICT(singleton) DO UPDATE SET owner_token=excluded.owner_token,heartbeat_at=excluded.heartbeat_at,expires_at=excluded.expires_at`).run(i.ownerToken,i.now,i.expiresAt);
        return true;
      })();
    },
    heartbeatExecutionLease(i: { ownerToken: string; now: string; expiresAt: string }): boolean {
      return db.prepare("UPDATE execution_lease SET heartbeat_at=?,expires_at=? WHERE singleton=1 AND owner_token=?").run(i.now,i.expiresAt,i.ownerToken).changes===1;
    },
    releaseExecutionLease(ownerToken: string): boolean {
      return db.prepare("DELETE FROM execution_lease WHERE singleton=1 AND owner_token=?").run(ownerToken).changes===1;
    },
  } satisfies ExecutionLeaseStore;
}
