import { sqliteTimestamp, type SqliteTimestamp } from "../../src/db/timestamps.js";

/**
 * A fixed instant in this project's on-disk timestamp form, for the suites that pin one. Takes the
 * space form the columns hold ("YYYY-MM-DD HH:MM:SS", always UTC) and mints it through
 * `sqliteTimestamp` itself.
 *
 * A minter, not a cast. The only way to produce a `SqliteTimestamp` is the one function that writes
 * the right format; a helper that asserted an arbitrary string into the brand would reopen the hole
 * the brand closes, letting a test pass an ISO value to a store that string-compares it. Parsing the
 * literal first means a malformed one throws here instead of making a silently wrong comparison.
 */
export function at(spaceFormUtc: string): SqliteTimestamp {
  const parsed = new Date(`${spaceFormUtc.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`at(): not a space-form UTC timestamp: ${spaceFormUtc}`);
  return sqliteTimestamp(parsed);
}
