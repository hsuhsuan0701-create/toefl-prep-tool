import type { CliProvider } from "./contracts.js";
import type { ProviderCircuitPersistence } from "./providerState.js";

/**
 * The `provider_quota_resets` port: one row per CLI provider recording when a hard-quota circuit may
 * reopen, so a restart does not forget a quota window with hours left on it. db/stores/providerQuota.ts
 * is the SQLite adapter.
 *
 * ⚠️ Both columns hold ISO-8601, not the space form, deliberately: do not "correct" it. The decision is
 * docs/adr/0008, and server/test/reasoning.providerQuotaPersistence.test.ts fails if either writer
 * changes form or a query appears that would make the form load-bearing. `reset_at` is read back with
 * `Date.parse`, which reads an ISO value as UTC and the space form as local time, so rewriting the
 * writers to `sqliteTimestamp()` would shift every persisted quota window by the machine's UTC offset
 * and misread every row already on disk. Nothing string-compares either column (the table is read by
 * exact `provider` match only), so the project-wide convention buys nothing here and the branded
 * `SqliteTimestamp` is not used. A query that ranges over `reset_at` must migrate the column first.
 */
export type ProviderQuotaStore = {
  getProviderQuotaReset(provider: string): { provider: string; reset_at: string; observed_at: string } | undefined;
  setProviderQuotaReset(i: { provider: string; resetAt: string; observedAt: string }): void;
  clearProviderQuotaReset(provider: string): boolean;
};

/**
 * The provider-circuit persistence over a store: the translation between a persisted row and a
 * circuit state. A non-numeric or absent `reset_at` reads as "no persisted circuit" rather than
 * letting NaN into a retry deadline, which would reopen the circuit at once or never.
 */
export function createRepoProviderCircuitPersistence(store: ProviderQuotaStore): ProviderCircuitPersistence {
  return {
    load(provider: CliProvider) {
      const row = store.getProviderQuotaReset(provider);
      if (!row) return undefined;
      const resetAtMs = Date.parse(row.reset_at);
      return Number.isFinite(resetAtMs) ? { failureKind: "quota" as const, resetAtMs } : undefined;
    },
    save(provider: CliProvider, state) {
      store.setProviderQuotaReset({
        provider,
        resetAt: new Date(state.resetAtMs).toISOString(),
        observedAt: new Date().toISOString(),
      });
    },
    clear(provider: CliProvider) {
      store.clearProviderQuotaReset(provider);
    },
  };
}
