import { afterAll, beforeAll } from "vitest";

/**
 * Pins the process timezone for one test file, restoring whatever was there afterwards.
 *
 * A missing timestamp conversion is invisible on a UTC machine: "2026-08-22 12:50:10" (read by
 * `new Date()` as local time) and "2026-08-22T12:50:10Z" name the same instant there, so an
 * unconverted value renders identically and every assertion about it passes anyway. A suite that
 * pins one of those conversions has to run with a real offset for the defect to be reachable at all.
 *
 * Scoped per-file rather than set globally in vitest.config.ts so no other suite silently inherits a
 * timezone it never asked for. Node honours a runtime `process.env.TZ` assignment, and vitest's
 * default forked, isolated pool runs one file at a time per worker, so the window is this file's own.
 *
 * Returns the expected `Date.prototype.getTimezoneOffset()` for the pinned zone: assert on it in the
 * suite's first test, so a future runtime that stops honouring the assignment fails loudly instead of
 * quietly degrading every other assertion to the UTC case that cannot fail.
 */
export function pinTimezone(tz = "Asia/Taipei", expectedOffsetMinutes = -480): number {
  let original: string | undefined;
  beforeAll(() => {
    original = process.env.TZ;
    process.env.TZ = tz;
  });
  afterAll(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });
  return expectedOffsetMinutes;
}
