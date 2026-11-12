import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

function isWithinBase(target: string, base: string): boolean {
  return target === base || target.startsWith(base + path.sep);
}

// Resolves a caller-supplied path while retaining the separator-aware lexical boundary check used
// by stored audio paths and file-serving routes. `path.resolve` normalizes both inputs first, so
// sibling-prefix paths (for example, scenarios-evil next to scenarios) cannot pass as descendants.
export function resolvePathWithinBase(candidatePath: string, baseDir: string): string {
  const base = path.resolve(baseDir);
  const resolved = path.isAbsolute(candidatePath) ? candidatePath : path.join(baseDir, candidatePath);
  const normalizedTarget = path.resolve(resolved);
  if (!isWithinBase(normalizedTarget, base)) {
    throw new Error(
      `resolvePathWithinBase: resolved path escapes dataDir/base: ${JSON.stringify(candidatePath)}`
    );
  }
  return resolved;
}

// Adds filesystem-aware containment for existing files. Both paths are canonicalized so a symlink
// cannot redirect the target outside the allowed directory. Requiring the canonical target to
// equal the path expected under the canonical base also rejects symlinks that happen to point back
// inside the base, rather than treating them as ordinary committed/generated files.
export function resolveRealPathWithinBase(candidatePath: string, baseDir: string): string {
  const base = path.resolve(baseDir);
  const target = path.resolve(resolvePathWithinBase(candidatePath, base));
  const realBase = fs.realpathSync(base);
  const realTarget = fs.realpathSync(target);
  const expectedRealTarget = path.resolve(realBase, path.relative(base, target));
  if (!isWithinBase(realTarget, realBase) || realTarget !== expectedRealTarget) {
    throw new Error(
      `resolveRealPathWithinBase: canonical path is unsafe: ${JSON.stringify(candidatePath)}`
    );
  }
  return realTarget;
}

// The write-side companion to resolveRealPathWithinBase. A final target often does not exist yet,
// so resolve its nearest existing ancestor and prove that neither it nor the lexical pathname can
// escape the canonical base through traversal, a sibling-prefix, or a symlink.
export function resolveIntendedPathWithinBase(candidatePath: string, baseDir: string): string {
  const base = path.resolve(baseDir);
  const target = path.resolve(resolvePathWithinBase(candidatePath, base));
  const realBase = fs.realpathSync(base);
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("resolveIntendedPathWithinBase: no existing ancestor");
    ancestor = parent;
  }
  const realAncestor = fs.realpathSync(ancestor);
  const expectedAncestor = path.resolve(realBase, path.relative(base, ancestor));
  if (!isWithinBase(realAncestor, realBase) || realAncestor !== expectedAncestor) {
    throw new Error(`resolveIntendedPathWithinBase: intended path escapes canonical base: ${JSON.stringify(candidatePath)}`);
  }
  return target;
}

// Mutation-time guard: create one component at a time, rejecting symlinks and non-directories
// before and after each step. This narrows (but cannot eliminate without openat-style APIs) races
// between pathname checks and mutations on platforms Node does not expose descriptor-relative I/O for.
export function ensureSafeDirectoryWithinBase(relativeDir: string, baseDir: string): string {
  const root = fs.realpathSync(baseDir); const target = resolveIntendedPathWithinBase(relativeDir, root); const rel = path.relative(root, target);
  let current = root;
  for (const part of rel.split(path.sep).filter(Boolean)) { current = path.join(current, part); if (!fs.existsSync(current)) fs.mkdirSync(current); const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`ensureSafeDirectoryWithinBase: unsafe directory component ${part}`); if (fs.realpathSync(current) !== current) throw new Error(`ensureSafeDirectoryWithinBase: non-canonical directory component ${part}`); }
  return target;
}

// Turns a stored item_results.response_audio_path into a filesystem path. New rows store it relative
// to the data directory ("audio/responses/<attemptId>/<itemId>.webm"), so it survives the directory
// moving; older rows hold an absolute path and nothing rewrites them, so both shapes resolve here.
// Read a stored recording path only through this function.
//
// Both shapes must resolve under dataDir: the result is read and sent to an external model API and to
// ffprobe, so a tampered value must not reach a file outside it. The check is resolvePathWithinBase's
// separator-aware one, because a plain prefix test would let a sibling such as "data-evil" through.
export function resolveAudioPath(storedPath: string, dataDir: string = config.dataDir): string {
  return resolvePathWithinBase(storedPath, dataDir);
}

// The inverse of resolveAudioPath for a new recording: the dataDir-relative form recordingIntake.ts
// persists. Kept beside resolveAudioPath so the two stay inverses.
export function toDataDirRelative(absolutePath: string, dataDir: string = config.dataDir): string {
  return path.relative(dataDir, absolutePath);
}
