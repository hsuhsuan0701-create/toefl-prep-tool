import fs from "node:fs";
import path from "node:path";

/**
 * A fresh copy of the seeded bank, under `parent`, that belongs to the one test file that asked for
 * it. setup-env.ts calls this once per test file and points TOEFL_DATA_DIR at the result, so a Set
 * one file publishes, a corrupt file it plants or a recording it uploads is invisible to every other
 * file, whatever order or parallelism the files run in.
 *
 * Copy-on-write where the filesystem supports it (APFS, btrfs), a plain copy elsewhere: the seeded
 * bank is a few MB of JSON, so even a plain copy costs tens of milliseconds per file.
 *
 * Resolved through realpath for the same reason global-setup.ts resolves the run directory: the
 * server's containment checks compare resolved paths against config.dataDir.
 */
export function privateDataDir(template: string, parent: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(parent, "file-")));
  copyTree(template, dir);
  return dir;
}

function copyTree(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(target);
      copyTree(source, target);
    } else {
      fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
    }
  }
}
