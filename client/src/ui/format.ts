import { taskTypeLabel } from "../lib/taskTypes";

// Plain-language formatting for numbers, durations, dates, lists and coverage. Pure, so every page
// shows the same "7 min" and the same "Sep 2, 6:14 PM" — never "420s", never "9/2/2026, 6:14:49 PM".
//
// Timestamps arrive at the client already ISO-8601 (CLAUDE.md: the server converts at the route
// boundary). Nothing here converts time zones; it only formats a Date in the User's local zone.

/** A list in running text: "a", "a and b", "a, b and c". */
export function joinAnd(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** "45 s", "7 min", "1 h 14 min". Seconds are dropped once a duration reaches a minute. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "—";
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s} s`;
  const minutes = Math.round(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** A countdown clock: "12:04", or "1:02:09" past an hour. Tabular figures are the caller's job. */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

const TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
const DAY_THIS_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const DAY_OTHER_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * When something happened, for a list row: "Today, 6:14 PM", "Yesterday, 9:02 AM", "Sep 2, 6:14 PM",
 * or "Sep 2, 2025" for another year (the time stops mattering). `now` is injectable for tests.
 */
export function formatWhen(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, now)) return `Today, ${TIME.format(d)}`;
  if (sameDay(d, yesterday)) return `Yesterday, ${TIME.format(d)}`;
  if (d.getFullYear() === now.getFullYear()) return `${DAY_THIS_YEAR.format(d)}, ${TIME.format(d)}`;
  return DAY_OTHER_YEAR.format(d);
}

/** The time of day alone, "6:14 PM": the end of a range whose day formatWhen already gave. */
export function formatTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : TIME.format(d);
}

/**
 * When something ran, as one range: "Today, 5:51 PM – 6:14 PM", or with the end's own day when it
 * finished on another one. With no end, just the start.
 */
export function formatWhenRange(startIso: string, endIso: string | null, now: Date = new Date()): string {
  const start = formatWhen(startIso, now);
  if (!endIso) return start;
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(e.getTime())) return start;
  return `${start} – ${!Number.isNaN(s.getTime()) && sameDay(s, e) ? formatTime(endIso) : formatWhen(endIso, now)}`;
}

/** A calendar day without the time: "Sep 2" this year, "Sep 2, 2025" otherwise. */
export function formatDay(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.getFullYear() === now.getFullYear() ? DAY_THIS_YEAR.format(d) : DAY_OTHER_YEAR.format(d);
}

/** 0.86 → "86%". Accuracy is always a whole percent; 0.995 does not round up to a false 100%. */
export function formatPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "—";
  const pct = Math.floor(Math.max(0, Math.min(1, fraction)) * 100 + 1e-9);
  return `${pct}%`;
}

/** A band on the half-step grid: 5 → "5", 5.5 → "5.5". Never "5.0". */
export function formatBand(band: number): string {
  return Number.isInteger(band) ? String(band) : band.toFixed(1);
}

/** "1 Item", "30 Items". */
export function itemCount(n: number): string {
  return `${n} ${n === 1 ? "Item" : "Items"}`;
}

/**
 * The words for one entry of a Band Estimate's coverage: "Complete the Words · 30 Items (2 skipped)".
 */
export function coverageText(entry: { taskType: string; itemCount: number; skippedCount?: number }): string {
  const base = `${taskTypeLabel(entry.taskType)} · ${itemCount(entry.itemCount)}`;
  return entry.skippedCount ? `${base} (${entry.skippedCount} skipped)` : base;
}

/**
 * Distance from a Target, in words, so the comparison never rests on colour:
 * "At your Target", "1 band below your Target", "0.5 band above your Target".
 */
export function targetGapText(band: number, target: number): string {
  const gap = Math.round((band - target) * 2) / 2;
  if (gap === 0) return "At your Target";
  const size = Math.abs(gap);
  const amount = size === 1 ? "1 band" : `${formatBand(size)} ${size < 1 ? "band" : "bands"}`;
  return gap < 0 ? `${amount} below your Target` : `${amount} above your Target`;
}

/**
 * A server-written clause as a sentence: first letter capitalised, closed with a full stop unless it
 * already ends in one, a question mark or an exclamation mark. For job errors printed as they come.
 */
export function asSentence(text: string): string {
  const t = text.trim();
  if (t === "") return "";
  const capped = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.?!]$/.test(capped) ? capped : `${capped}.`;
}
