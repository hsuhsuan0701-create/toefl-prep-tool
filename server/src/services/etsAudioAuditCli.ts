// Argument parsing and output writing for scripts/audit-ets-speaking-audio.ts, kept here so they can
// be tested without running the script.
import fs from "node:fs";

export type EtsAuditArgs = { source: "practice-test-5" | "lesson-plan"; audioDir: string; out?: string; noWrite: boolean; force: boolean };
/**
 * Parses the script's argv, throwing on an unknown, repeated or valueless flag. `--audio-dir` must
 * be absolute. `lesson-plan` only prints (`--no-write`); `practice-test-5` needs `--out` unless
 * `--no-write`, and `--force` (overwrite) is accepted only with `--out`.
 */
export function parseEtsAuditArgs(args: string[]): EtsAuditArgs {
  const values = new Map<string, string>(); let noWrite = false; let force = false;
  for (let i = 0; i < args.length; i++) { const flag = args[i]; if (!["--source", "--audio-dir", "--out", "--no-write", "--force"].includes(flag)) throw new Error(`unknown argument: ${flag}`);
    if (flag === "--no-write" || flag === "--force") { if (flag === "--no-write" ? noWrite : force) throw new Error(`repeated argument: ${flag}`); flag === "--no-write" ? noWrite = true : force = true; continue; }
    const value = args[++i]; if (!value || value.startsWith("--") || values.has(flag)) throw new Error(`invalid value for ${flag}`); values.set(flag, value); }
  const source = values.get("--source"); const audioDir = values.get("--audio-dir"); const out = values.get("--out");
  if ((source !== "practice-test-5" && source !== "lesson-plan") || !audioDir || !audioDir.startsWith("/")) throw new Error("invalid --source or --audio-dir");
  if (noWrite && (out || force)) throw new Error("--no-write cannot be combined with --out or --force"); if (force && !out) throw new Error("--force requires --out");
  if (source === "lesson-plan" && !noWrite) throw new Error("lesson-plan requires --no-write"); if (source === "practice-test-5" && !noWrite && !out) throw new Error("practice-test-5 requires --out unless --no-write");
  return { source, audioDir, out, noWrite, force };
}
/** Writes `content` to `out`, refusing to replace an existing file unless `force` is set. */
export function writeAuditOutput(out: string, content: string, force: boolean): void { fs.writeFileSync(out, content, { flag: force ? "w" : "wx" }); }
