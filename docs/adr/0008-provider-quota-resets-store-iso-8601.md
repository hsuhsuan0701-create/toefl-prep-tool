# `provider_quota_resets` stores ISO-8601, not the space-form convention

## Status

Accepted (issue #110). A scoped, tested exception to the on-disk timestamp convention that issue #51 established and `server/src/db/timestamps.ts` owns. It changes nothing about that convention anywhere else.

## Context

Every other `*_at` column in this database holds space-form UTC ("YYYY-MM-DD HH:MM:SS"), minted by `sqliteTimestamp()`. The convention exists because so many statements string-compare timestamps — `execution_lease.expires_at > ?`, `transcription_jobs.next_retry_at <= ?`, every `ORDER BY created_at` — and a single ISO write silently makes a lock un-reclaimable or a row un-prunable, since 'T' sorts above ' '. The branded `SqliteTimestamp` type makes that rule a compile error rather than prose.

`provider_quota_resets` (issue #100) holds one row per CLI provider: when a hard-quota circuit is allowed to reopen, so a restart does not forget a window with hours left on it. Its two columns hold ISO-8601 instead. `reset_at` is read back with `Date.parse`, which reads an ISO value as UTC and the space form as **local** time — on this UTC+8 machine that is issue #51's eight-hour bug, aimed at a retry deadline instead of at a display.

The independent review of issue #101 examined the exception and found it sound today but latent: the table is only ever read by exact `provider` match, with no `ORDER BY` and no range predicate, so nothing depends on the stored format's sort order — but the first `WHERE reset_at > ?` anyone writes would break silently. Issue #110 found the compounding problem: the translation performing the conversion, `createRepoProviderCircuitPersistence`, had no test at all.

## Decision

**Keep the exception. Pin it with tests instead of prose.**

Keeping it, rather than converting to `sqliteTimestamp()`:

- Converting is not free in either direction. New writes would move every quota window by the machine's UTC offset (eight hours here, in the reopen-early direction — the circuit would reopen while the provider is still refusing work), and every row already on disk would be re-read as local time by the same `Date.parse`. A correct migration therefore needs both a reader that distinguishes the two forms and a rewrite of live rows.
- The value is an epoch-ms deadline, not a wall-clock record. `sqliteTimestamp()` truncates to whole seconds, so adopting it would make the round trip lossy for no gain.
- The convention buys its safety from string comparison, and this table performs none. Applying it here would be cargo cult, and the branded type is deliberately not used for the same reason.

The latency in "latent" is what the tests remove. `server/test/reasoning.providerQuotaPersistence.test.ts` runs the real translation over the real SQLite store and asserts:

1. The ISO ⟷ epoch round trip, to the millisecond.
2. That `reset_at` and `observed_at` are stored in ISO-8601 **deliberately** — matched against the exact form, and asserted *not* to be the space form. A future edit that "corrects" either writer fails here.
3. What that edit would actually cost: a space-form row restores a window eight hours early, with nothing thrown and nothing finite-guarded, under a pinned non-UTC timezone so the trap is reachable rather than invisible.
4. Both branches of the `Number.isFinite` guard — a parseable row restores an open circuit with the expected retry deadline; an unparseable one reports "no persisted circuit" rather than letting NaN reach a retry deadline.
5. The premise the exception rests on, read off the store's real source: no statement over `provider_quota_resets` orders by or compares either timestamp column, and every filter is on `provider` alone.

Assertion 5 is the one that converts the latent trap into a failing test. Anyone adding `WHERE reset_at > ?` or `ORDER BY reset_at` fails the suite and has to migrate the column first.

## Consequences

The exception stays exactly two columns wide and is now enforced rather than described. The comments at both sites (`server/src/services/reasoning/providerQuotaStore.ts`, `server/src/db/stores/providerQuota.ts`) point here instead of "awaiting its own issue".

If a future query does need to range over `reset_at`, the migration is: read through `parseSqliteTimestamp`, which already reads both forms correctly and so covers the rows on disk; write through `sqliteTimestamp()`, accepting the loss of sub-second precision; narrow the store port to `SqliteTimestamp`; and update the tests above, which will already be failing. Do not do half of it — a converted writer with an unconverted reader is the eight-hour bug.
