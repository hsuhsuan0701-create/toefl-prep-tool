import type Database from "better-sqlite3";
import type { ProviderQuotaStore } from "../../services/reasoning/providerQuotaStore.js";

// ---------------------------------------------------------------------------------------------
// The `provider_quota_resets` aggregate, over SQLite
// ---------------------------------------------------------------------------------------------
//
// ⚠️ These two columns hold ISO-8601, not the space form, deliberately: do not "correct" it. `reset_at`
// is read back with `Date.parse` and nothing string-compares either column, while rewriting these
// writers to `sqliteTimestamp()` would shift every persisted quota window by the machine's UTC offset
// and misread every row already on disk. docs/adr/0008 records the decision, and
// server/test/reasoning.providerQuotaPersistence.test.ts pins it: it reads this file's source and fails
// if a statement here gains an ORDER BY or a range predicate over `reset_at`/`observed_at`, since the
// format is safe only while nothing compares it. To add such a query, migrate the column first.

export function createSqliteProviderQuotaStore(db: Database.Database) {
  return {
    setProviderQuotaReset(i:{provider:string;resetAt:string;observedAt:string}):void {
      db.prepare(`INSERT INTO provider_quota_resets(provider,reset_at,observed_at) VALUES(?,?,?)
        ON CONFLICT(provider) DO UPDATE SET reset_at=excluded.reset_at,observed_at=excluded.observed_at`).run(i.provider,i.resetAt,i.observedAt);
    },
    getProviderQuotaReset(provider:string):{provider:string;reset_at:string;observed_at:string}|undefined {
      return db.prepare("SELECT * FROM provider_quota_resets WHERE provider=?").get(provider) as {provider:string;reset_at:string;observed_at:string}|undefined;
    },
    clearProviderQuotaReset(provider:string):boolean { return db.prepare("DELETE FROM provider_quota_resets WHERE provider=?").run(provider).changes===1; },
  } satisfies ProviderQuotaStore;
}
