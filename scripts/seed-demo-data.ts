/**
 * `npm run demo:seed -- <dir> [--today <date>] [--force]`
 *
 * Writes a demo data directory: a copy of this checkout's question bank and a database holding about
 * three weeks of believable practice across all four sections, so every screen of the app has
 * something to show without API keys or hours of practice. See docs/demo-data.md.
 *
 *   <dir>           where to write it: a new or empty directory, never the repository's data/
 *   --today <date>  the day the history leads up to (a date such as 2026-11-12, or an ISO-8601
 *                   instant); default now. The same date, time zone and ffmpeg give the same
 *                   database, which keeps screenshots reproducible.
 *   --force         replace a directory this command filled before
 *
 * Spends nothing and needs no .env. With ffmpeg on PATH it also writes the recordings' audio files
 * (demo/recordings.ts). Run `npm run demo` to seed a default directory and start the app.
 */
import { SeedTargetRefused } from "./demo/target.js";
import { describeSeed, parseToday, seedDemoDirectory } from "./demo/seedDirectory.js";

function parseArgs(argv: string[]): { dir: string; today: string | undefined; force: boolean } {
  let dir: string | undefined;
  let today: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") force = true;
    else if (arg === "--today") today = argv[++i];
    else if (arg.startsWith("--today=")) today = arg.slice("--today=".length);
    else if (!arg.startsWith("--") && dir === undefined) dir = arg;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!dir) throw new Error("usage: npm run demo:seed -- <dir> [--today <date>] [--force]");
  return { dir, today, force };
}

try {
  const args = parseArgs(process.argv.slice(2));
  const seeded = await seedDemoDirectory({ dir: args.dir, today: parseToday(args.today), force: args.force });
  console.log(describeSeed(seeded).join("\n"));
  console.log(`\nThis is demo data. To browse it: npm run demo -- --dir ${seeded.dataDir}`);
} catch (err) {
  console.error(err instanceof SeedTargetRefused || err instanceof Error ? err.message : String(err));
  process.exit(1);
}
