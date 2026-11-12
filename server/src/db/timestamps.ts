// The on-disk timestamp convention and both of its inverses. Every value this project writes into a
// SQLite `*_at` column is UTC as "YYYY-MM-DD HH:MM:SS", matching schema.sql's `datetime('now')`
// defaults; no 'T', no 'Z', no fractional seconds.
//
// Stores compare timestamps as strings: the execution lease's expiry, a recording-publication lock's
// age, a transcription retry's due time, diagnostic retention's cutoff, and every ORDER BY or
// COALESCE(completed_at, started_at) over them. That works only because every writer uses this one
// form. An ISO-8601 value sorts above every same-day space-form value ('T' > ' '), so one
// `toISOString()` write would silently make a lock unreclaimable, a retry never due or a row
// unprunable. So every store port that string-compares its input takes `SqliteTimestamp`, which only
// this file can mint, and handing one an ISO string fails to compile. The SQLite stores under
// db/stores/ declare plain `string`, which still satisfies the narrower port.
//
// The one exception is provider_quota_resets, which holds ISO-8601 by decision (docs/adr/0008).
declare const sqliteTimestampBrand: unique symbol;

/** A timestamp in this project's on-disk format. Minted only by `sqliteTimestamp()` below. */
export type SqliteTimestamp = string & { readonly [sqliteTimestampBrand]: "sqlite" };

export function sqliteTimestamp(d: Date = new Date()): SqliteTimestamp {
  return d.toISOString().replace("T", " ").slice(0, 19) as SqliteTimestamp;
}

// What sqliteTimestamp() writes, and the one form `new Date(...)` misreads as local time. Exact rather
// than lenient: no writer (sqliteTimestamp's `slice(0, 19)`, schema.sql's `datetime('now')`) emits
// fractional seconds. Anything else, ISO-8601 included, is already an unambiguous instant and is
// parsed as written.
const SPACE_FORM = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

// The inverse of sqliteTimestamp(): the UTC Date a stored value denotes. The added 'T' and 'Z' are
// required, because `new Date` reads the bare space form as local time.
export function parseSqliteTimestamp(s: string): Date {
  return new Date(SPACE_FORM.test(s) ? `${s.replace(" ", "T")}Z` : s);
}

// Converts a value read from a timestamp column into an ISO-8601 instant for a client-facing view
// model. Every such field goes through this at the route boundary, and client code never converts.
// Idempotent (its output is not the space form), so a field normalised twice stays right. A value that
// parses as neither form is returned unchanged rather than as "Invalid Date".
export function sqliteTimestampToIso(value: string): string;
export function sqliteTimestampToIso(value: string | null): string | null;
export function sqliteTimestampToIso(value: string | null): string | null {
  if (value === null) return null;
  const parsed = parseSqliteTimestamp(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}
