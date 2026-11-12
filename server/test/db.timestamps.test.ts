import { describe, it, expect } from "vitest";
import { sqliteTimestamp, parseSqliteTimestamp, sqliteTimestampToIso } from "../src/db/timestamps.js";
import { pinTimezone } from "./helpers/pinTimezone.js";

// On a UTC machine the space form and the ISO form name the same instant, so every assertion below
// would pass whether or not the conversion is right. pinTimezone runs this file at UTC+8.
const EXPECTED_OFFSET = pinTimezone();

describe("sqlite timestamp conversions", () => {
  it("runs under a non-UTC machine timezone, so the space-form trap is reachable", () => {
    expect(new Date("2026-08-22T12:50:10Z").getTimezoneOffset()).toBe(EXPECTED_OFFSET);
  });

  it("sqliteTimestamp writes space-form UTC regardless of machine timezone", () => {
    expect(sqliteTimestamp(new Date("2026-08-22T12:50:10.000Z"))).toBe("2026-08-22 12:50:10");
  });

  it("parseSqliteTimestamp reads space form back as the UTC instant it was written as", () => {
    // Stored 12:50:10 UTC is 20:50 local in the pinned timezone.
    expect(parseSqliteTimestamp("2026-08-22 12:50:10").getTime()).toBe(Date.UTC(2026, 7, 22, 12, 50, 10));
    expect(parseSqliteTimestamp("2026-08-22 12:50:10").getHours()).toBe(20);
  });

  it("parseSqliteTimestamp leaves an already-unambiguous legacy ISO value on its own instant", () => {
    // Its callers compare instants (the orphan-heal grace window, a transcription retry's due time).
    // Appending "Z" unconditionally would turn this value into "…ZZ", an Invalid Date whose NaN
    // comparisons are always false. Every writer uses sqliteTimestamp(), so the parser only has to
    // tolerate such a value, and this keeps it doing so.
    expect(parseSqliteTimestamp("2026-07-30T13:05:00.000Z").getTime()).toBe(Date.UTC(2026, 6, 30, 13, 5, 0));
  });

  it("sqliteTimestampToIso emits an unambiguous instant for the space form", () => {
    expect(sqliteTimestampToIso("2026-08-22 12:50:10")).toBe("2026-08-22T12:50:10.000Z");
  });

  it("sqliteTimestampToIso passes null through", () => {
    expect(sqliteTimestampToIso(null)).toBeNull();
  });

  it("sqliteTimestampToIso is idempotent, so no path can convert twice", () => {
    const once = sqliteTimestampToIso("2026-08-22 12:50:10");
    expect(sqliteTimestampToIso(once)).toBe(once);
  });

  it("sqliteTimestampToIso leaves an already-unambiguous legacy ISO value on its own instant", () => {
    // A timestamp column can hold an ISO "…T…Z" value an older install wrote. It must keep its own
    // instant, never be re-read as local time.
    expect(sqliteTimestampToIso("2026-07-30T13:05:00.000Z")).toBe("2026-07-30T13:05:00.000Z");
  });

  it("sqliteTimestampToIso degrades to the raw string rather than 'Invalid Date'", () => {
    expect(sqliteTimestampToIso("not a timestamp")).toBe("not a timestamp");
  });
});
