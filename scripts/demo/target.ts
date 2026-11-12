/**
 * Where demo data may be written, decided before anything is opened. Imports nothing from the
 * server: the seeder's entry point runs these checks first, and only then loads the server modules
 * (whose config resolves a data directory at import time).
 *
 * The rules, in the order they are checked:
 *   1. never the repository's own data/ (or anything inside it): that is the User's real practice
 *      history, and the question bank tracked in git;
 *   2. a directory this seeder created (it carries DEMO_MARKER) may be replaced with --force;
 *   3. otherwise the directory must be new or empty. A directory holding a database the seeder did
 *      not create is refused even with --force, because it is most likely someone's real data.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Written into every directory the seeder fills, so --force can tell demo data from real data. */
export const DEMO_MARKER = ".toefl-demo-data";

/** Where `npm run demo` keeps its data unless told otherwise. */
export function defaultDemoDir(): string {
  return path.join(os.tmpdir(), "toefl-prep-tool-demo");
}

export class SeedTargetRefused extends Error {}

/** `p` with every existing ancestor resolved through symlinks, so containment compares real paths. */
function realish(p: string): string {
  const absolute = path.resolve(p);
  const missing: string[] = [];
  let current = absolute;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(fs.realpathSync(current), ...missing);
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + path.sep);
}

export type SeedTarget = {
  /** The resolved directory to seed. */
  dataDir: string;
  /** True when it already holds demo data that --force asked to replace. */
  replace: boolean;
};

/** Decides whether `dir` may receive demo data. Throws SeedTargetRefused, with what to do, when not. */
export function checkSeedTarget(dir: string, opts: { repoRoot: string; force: boolean }): SeedTarget {
  const dataDir = realish(dir);
  const bank = realish(path.join(opts.repoRoot, "data"));
  if (isInside(dataDir, bank)) {
    throw new SeedTargetRefused(
      `${dataDir} is inside this repository's data/ directory, which holds the question bank and your own ` +
        "practice history. Demo data never goes there. Choose a directory outside the repository, or run " +
        "`npm run demo`, which uses one under your temp directory.",
    );
  }
  if (!fs.existsSync(dataDir)) return { dataDir, replace: false };
  if (!fs.statSync(dataDir).isDirectory()) throw new SeedTargetRefused(`${dataDir} exists and is not a directory.`);

  const isDemo = fs.existsSync(path.join(dataDir, DEMO_MARKER));
  if (isDemo) {
    if (!opts.force) {
      throw new SeedTargetRefused(
        `${dataDir} already holds demo data. Pass --force to replace it with a fresh copy.`,
      );
    }
    return { dataDir, replace: true };
  }
  if (fs.readdirSync(dataDir).length === 0) return { dataDir, replace: false };
  const hasDatabase = fs.existsSync(path.join(dataDir, "db.sqlite"));
  throw new SeedTargetRefused(
    hasDatabase
      ? `${dataDir} holds a database the demo seeder did not create, so it is left alone even with --force. ` +
          "Choose a new or empty directory."
      : `${dataDir} is not empty and was not created by the demo seeder. Choose a new or empty directory.`,
  );
}

/** Empties a directory checkSeedTarget allowed to be replaced, and recreates it. */
export function prepareSeedTarget(target: SeedTarget): void {
  if (target.replace) {
    if (!fs.existsSync(path.join(target.dataDir, DEMO_MARKER))) {
      throw new SeedTargetRefused(`${target.dataDir} lost its demo marker; refusing to remove it.`);
    }
    fs.rmSync(target.dataDir, { recursive: true, force: true });
  }
  fs.mkdirSync(target.dataDir, { recursive: true });
}

/** Marks a seeded directory as demo data, with a line for anyone who opens it. */
export function writeDemoMarker(dataDir: string, today: Date): void {
  fs.writeFileSync(
    path.join(dataDir, DEMO_MARKER),
    `Demo data written by scripts/seed-demo-data.ts, dated relative to ${today.toISOString()}.\n` +
      "Nothing here is real practice. Safe to delete.\n",
  );
}
