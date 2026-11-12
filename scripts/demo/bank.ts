/**
 * Copies the repository's question bank into a demo data directory, so every Set, its stimulus
 * audio and its scene image resolve there exactly as they do in a real checkout.
 *
 * Only the tracked bank is copied (`git ls-files data`), the same list the server suite seeds from:
 * the repository's data/ also holds the User's own database, recordings and backups, and none of that
 * may reach a demo. Outside a git checkout the directory is walked instead, keeping only the three
 * bank folders.
 *
 * Copied rather than linked: a Set generated or retired while the demo runs is written into the
 * demo's own bank, and through a link it would land in the repository's.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The bank's own folders. Anything else under data/ belongs to the User. */
function isBankFile(rel: string): boolean {
  const posix = rel.split(path.sep).join("/");
  if (posix.startsWith("question-sets/.staging/")) return false;
  return (
    (posix.startsWith("question-sets/") && posix.endsWith(".json")) ||
    posix.startsWith("audio/stimuli/") ||
    posix.startsWith("images/scenarios/")
  );
}

function trackedFiles(repoRoot: string, bankDir: string): string[] | null {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repoRoot, encoding: "utf8" }).trim();
    if (fs.realpathSync(top) !== fs.realpathSync(repoRoot)) return null;
    return execFileSync("git", ["ls-files", "-z", "--", "data"], { cwd: repoRoot, encoding: "utf8" })
      .split("\0")
      .filter(Boolean)
      .map((file) => path.relative("data", file))
      .filter((rel) => fs.existsSync(path.join(bankDir, rel)));
  } catch {
    return null;
  }
}

function walkedFiles(bankDir: string): string[] {
  if (!fs.existsSync(bankDir)) return [];
  return (fs.readdirSync(bankDir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(bankDir, path.join(entry.parentPath, entry.name)));
}

/** Copies the bank into `dataDir` and returns how many files it copied. */
export function copyQuestionBank(repoRoot: string, dataDir: string): number {
  const bankDir = path.join(repoRoot, "data");
  const files = (trackedFiles(repoRoot, bankDir) ?? walkedFiles(bankDir)).filter(isBankFile);
  for (const rel of files) {
    const target = path.join(dataDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // Copy-on-write where the filesystem supports it (APFS, btrfs), a plain copy elsewhere.
    fs.copyFileSync(path.join(bankDir, rel), target, fs.constants.COPYFILE_FICLONE);
  }
  return files.length;
}
