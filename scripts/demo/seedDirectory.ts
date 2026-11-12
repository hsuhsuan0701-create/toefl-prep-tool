/**
 * Fills a directory with demo data: checks it may be written (target.ts), copies the question bank,
 * synthesizes the recordings and seeds the database. Shared by `npm run demo:seed` and `npm run demo`.
 *
 * The server modules are imported only after TOEFL_DATA_DIR points at the target, because their
 * config resolves a data directory once, at import time, and defaults to the repository's data/.
 * Nothing in the seeder relies on that default, and this keeps it from ever mattering.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyQuestionBank } from "./bank.js";
import { synthesizeRecordings } from "./recordings.js";
import type { SeedSummary } from "./seed.js";
import { checkSeedTarget, prepareSeedTarget, writeDemoMarker } from "./target.js";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The `--today` argument: a date (that day at noon, local time) or a full ISO-8601 instant. Absent,
 * the history leads up to now.
 */
export function parseToday(value: string | undefined, now = new Date()): Date {
  if (value === undefined) return now;
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const parsed = dateOnly ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]), 12) : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`--today must be a date (2026-11-12) or an ISO-8601 instant, not "${value}"`);
  return parsed;
}

export type SeededDirectory = { dataDir: string; summary: SeedSummary; bankFiles: number; recordings: boolean };

export async function seedDemoDirectory(opts: { dir: string; today: Date; force: boolean }): Promise<SeededDirectory> {
  const target = checkSeedTarget(opts.dir, { repoRoot, force: opts.force });
  prepareSeedTarget(target);
  // Marked before anything else lands, so a seed that fails halfway can be retried with --force.
  writeDemoMarker(target.dataDir, opts.today);
  const bankFiles = copyQuestionBank(repoRoot, target.dataDir);
  process.env.TOEFL_DATA_DIR = target.dataDir;
  const { seedDemoData } = await import("./seed.js");
  const recordings = synthesizeRecordings();
  const summary = await seedDemoData({ dataDir: target.dataDir, today: opts.today, recordings });
  return { dataDir: target.dataDir, summary, bankFiles, recordings: recordings !== null };
}

/** The lines both entry points print about what was written. */
export function describeSeed(seeded: SeededDirectory): string[] {
  const { summary } = seeded;
  const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const sections = (["reading", "listening", "writing", "speaking"] as const).map((section) => {
    const { drill, simulation } = summary.attempts[section];
    return `${section[0].toUpperCase()}${section.slice(1)}: ${count(drill, "Drill")}, ${count(simulation, "Simulation")}`;
  });
  const bands = (["reading", "listening", "writing", "speaking"] as const)
    .map((section) => `${section} ${summary.headline[section] ?? "none"}`)
    .join(", ");
  return [
    `Demo data written to ${seeded.dataDir}`,
    `  Attempts      ${sections.join("; ")}`,
    `  Full-Test     ${summary.fullTestRuns.completed} completed, ${summary.fullTestRuns.inProgress} in progress`,
    `  Bands         ${bands} (unofficial estimates)`,
    seeded.recordings
      ? `  Recordings    ${summary.recordingFiles} audio files, synthesized with ffmpeg`
      : "  Recordings    none: ffmpeg was not found, so the review page's recording players have nothing to play",
    `  Question bank ${seeded.bankFiles} files copied from this checkout`,
  ];
}
