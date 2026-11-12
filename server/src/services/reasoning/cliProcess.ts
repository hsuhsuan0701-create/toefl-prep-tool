import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ReasoningFailureKind } from "@toefl-prep/shared";
import {
  superviseAttempt,
  type SupervisedAttemptResult,
} from "./attemptSupervisor.js";
import {
  createProviderDeadline,
  isProviderDeadlineExceeded,
  runBeforeDeadline,
  type ProviderDeadline,
} from "./deadline.js";

const RETAINED_DIAGNOSTIC_CHARS = 2_000;
/**
 * How much of the END of each stream a failed attempt keeps. A CLI states why it stopped last, after
 * a head that a startup banner, an echoed prompt or Claude's `init` event alone can fill, so the
 * tail is what failure classification and the failure transcript read.
 */
const RETAINED_TAIL_BYTES = 64 * 1024;
/**
 * TOEFL structured reports and generated sets are normally well below 100 KiB.
 * A 1 MiB ceiling leaves ample headroom for legitimate schemas while bounding
 * provider-controlled memory and private-disk use on every CLI attempt.
 */
export const MAX_STRUCTURED_OUTPUT_BYTES = 1024 * 1024;
export const PRIVATE_TEMP_CLEANUP_TIMEOUT_MS = 1_000;
const CLI_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "CODEX_HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
] as const;

export interface SpawnBoundedOptions {
  readonly bin: string;
  readonly args: readonly string[];
  readonly prompt: string;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly killGraceMs?: number;
  /**
   * Optional full-output sink for adapters that must parse stdout larger than the
   * bounded diagnostic excerpt. The caller owns permissions and cleanup.
   */
  readonly stdoutFilePath?: string;
}

export interface SpawnBoundedResult {
  readonly ok: boolean;
  /** The first 2,000 characters, enough for a probe's short status output. */
  readonly stdout: string;
  readonly stderr: string;
  /** The last 64 KiB, prefixed with the count of earlier bytes it omits. */
  readonly stdoutTail?: string;
  readonly stderrTail?: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled?: boolean;
  readonly structuredOutputOverflow: boolean;
  readonly spawnErrorCode?: string;
  readonly spawnErrorMessage?: string;
}

export function sanitizedCliEnv(
  source: Readonly<Record<string, string | undefined>> = process.env
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const name of CLI_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) sanitized[name] = value;
  }
  return sanitized;
}

function retain(current: string, chunk: Buffer | string): string {
  if (current.length >= RETAINED_DIAGNOSTIC_CHARS) return current;
  return (current + chunk.toString()).slice(0, RETAINED_DIAGNOSTIC_CHARS);
}

class StreamTail {
  private tail = Buffer.alloc(0);
  private total = 0;

  push(chunk: Buffer): void {
    this.total += chunk.byteLength;
    const joined = Buffer.concat([this.tail, chunk]);
    this.tail = joined.byteLength > RETAINED_TAIL_BYTES
      ? joined.subarray(joined.byteLength - RETAINED_TAIL_BYTES)
      : joined;
  }

  text(): string {
    // A cut can land inside a multi-byte character; drop its orphaned continuation bytes.
    const body = this.tail.toString("utf8").replace(/^\uFFFD+/u, "");
    const omitted = this.total - this.tail.byteLength;
    return omitted > 0 ? `[${omitted} earlier bytes omitted]\n${body}` : body;
  }
}

export async function spawnBounded(
  options: SpawnBoundedOptions
): Promise<SpawnBoundedResult> {
  if (options.timeoutMs <= 0) {
    return Promise.resolve({
      ok: false,
      stdout: "",
      stderr: "",
      code: null,
      signal: null,
      timedOut: true,
      cancelled: options.signal?.aborted ?? false,
      structuredOutputOverflow: false,
    });
  }
  let stdout = "";
  let stderr = "";
  const stdoutTail = new StreamTail();
  const stderrTail = new StreamTail();
  let structuredOutputBytes = 0;
  let structuredOutputOverflow = false;
  let spawnErrorCode: string | undefined;
  let spawnErrorMessage: string | undefined;
  const attemptController = new AbortController();
  const abortAttempt = () => attemptController.abort();
  options.signal?.addEventListener("abort", abortAttempt, { once: true });
  if (options.signal?.aborted) abortAttempt();
  let supervised: SupervisedAttemptResult;
  try {
    supervised = await superviseAttempt({
      bin: options.bin,
      args: options.args,
      prompt: options.prompt,
      cwd: options.cwd,
      env: options.env ?? sanitizedCliEnv(),
      timeoutMs: options.timeoutMs,
      signal: attemptController.signal,
      ...(options.killGraceMs === undefined
        ? {}
        : { killGraceMs: options.killGraceMs }),
      onStdout(_text, chunk) {
      stdout = retain(stdout, chunk);
      stdoutTail.push(chunk);
      if (options.stdoutFilePath && !structuredOutputOverflow) {
        if (
          structuredOutputBytes + chunk.byteLength >
          MAX_STRUCTURED_OUTPUT_BYTES
        ) {
          structuredOutputOverflow = true;
          abortAttempt();
          return;
        }
        try {
          fs.appendFileSync(options.stdoutFilePath, chunk);
          structuredOutputBytes += chunk.byteLength;
        } catch (error) {
          const sinkError = error as NodeJS.ErrnoException;
          spawnErrorCode = sinkError.code ?? "EIO";
          spawnErrorMessage = "failed to retain CLI structured output";
          abortAttempt();
        }
      }
      },
      onStderr(_text, chunk) {
        stderr = retain(stderr, chunk);
        stderrTail.push(chunk);
      },
    });
  } finally {
    options.signal?.removeEventListener("abort", abortAttempt);
  }
  return {
    ok:
      !supervised.timedOut &&
      !supervised.cancelled &&
      !structuredOutputOverflow &&
      spawnErrorCode === undefined &&
      supervised.spawnErrorCode === undefined &&
      supervised.code === 0 &&
      supervised.signal === null,
    stdout,
    stderr,
    stdoutTail: stdoutTail.text(),
    stderrTail: stderrTail.text(),
    code: supervised.code,
    signal: supervised.signal,
    timedOut: supervised.timedOut,
    cancelled:
      options.signal?.aborted === true ||
      (supervised.cancelled && !structuredOutputOverflow && spawnErrorCode === undefined),
    structuredOutputOverflow,
    ...(spawnErrorCode ?? supervised.spawnErrorCode
      ? { spawnErrorCode: spawnErrorCode ?? supervised.spawnErrorCode }
      : {}),
    ...(spawnErrorMessage ?? supervised.spawnErrorMessage
      ? { spawnErrorMessage: spawnErrorMessage ?? supervised.spawnErrorMessage }
      : {}),
  };
}

/**
 * Reads a failure kind out of CLI error text, or undefined when the text names none. Callers decide
 * WHICH text: the end of a stream, or a final error event, never a head that echoed the prompt.
 * "usage limit"/"hit your limit" is how both CLIs word a spent subscription window.
 */
export function classifyFailureText(text: string): ReasoningFailureKind | undefined {
  if (/\b(?:enoent|command not found|executable not found)\b/i.test(text)) return "missing-cli";
  if (
    /\b(?:authentication|authenticate|unauthenticated|unauthorized|invalid api key|api key invalid|log ?in|login|401)\b/i.test(text)
  ) {
    return "authentication";
  }
  if (
    /\b(?:quota|insufficient_quota|billing|credit balance|credits exhausted|usage limit|hit your (?:usage )?limit)\b/i.test(text)
  ) {
    return "quota";
  }
  if (/\b(?:rate[ _-]?limit(?:ed)?|too many requests|429)\b/i.test(text)) return "rate-limit";
  return undefined;
}

/** A failure the process itself explains — it timed out or never started — before any output is read. */
export function classifyProcessFailure(
  result: Pick<SpawnBoundedResult, "timedOut" | "spawnErrorCode" | "spawnErrorMessage">,
): ReasoningFailureKind | undefined {
  if (result.timedOut) return "timeout";
  if (result.spawnErrorCode === "ENOENT") return "missing-cli";
  if (result.spawnErrorCode === "EACCES") return "configuration";
  if (result.spawnErrorMessage && classifyFailureText(result.spawnErrorMessage) === "missing-cli") {
    return "missing-cli";
  }
  return undefined;
}

/** For short-lived commands (the auth-status probes) whose whole output fits the retained head. */
export function classifyCliFailure(
  result: Pick<
    SpawnBoundedResult,
    | "timedOut"
    | "stdout"
    | "stderr"
    | "spawnErrorCode"
    | "spawnErrorMessage"
  >
): ReasoningFailureKind {
  return classifyProcessFailure(result) ??
    classifyFailureText([result.stderr, result.stdout].join("\n")) ??
    "provider";
}

/**
 * The response a failed attempt records: what the CLI printed, stdout first, stderr after a marker.
 * Undefined when it printed nothing, so "no output" stays distinguishable from empty output.
 */
export function failureTranscriptResponse(parts: {
  readonly stdout?: string;
  readonly stderr?: string;
}): string | undefined {
  const stdout = parts.stdout?.trim() ? parts.stdout : undefined;
  const stderr = parts.stderr?.trim() ? parts.stderr : undefined;
  if (stdout === undefined && stderr === undefined) return undefined;
  return [stdout, stderr === undefined ? undefined : `[stderr]\n${stderr}`]
    .filter((part): part is string => part !== undefined)
    .join("\n");
}

export type BoundedOutputRead =
  | { ok: true; text: string }
  | { ok: false; kind: "oversize" | "read-error" };

/** Reads a CLI output file, refusing anything past the structured-output ceiling. */
export async function readBoundedOutput(filePath: string): Promise<BoundedOutputRead> {
  let file: fs.promises.FileHandle;
  try {
    file = await fs.promises.open(filePath, "r");
  } catch {
    return { ok: false, kind: "read-error" };
  }

  try {
    const before = await file.stat();
    if (!before.isFile()) return { ok: false, kind: "read-error" };
    if (before.size > MAX_STRUCTURED_OUTPUT_BYTES) {
      return { ok: false, kind: "oversize" };
    }

    // The fixed-size buffer makes a concurrent file growth race bounded too:
    // at most one byte beyond the accepted ceiling is ever read.
    const buffer = Buffer.allocUnsafe(MAX_STRUCTURED_OUTPUT_BYTES + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const { bytesRead } = await file.read(
        buffer,
        total,
        buffer.byteLength - total,
        total
      );
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const after = await file.stat();
    if (
      total > MAX_STRUCTURED_OUTPUT_BYTES ||
      after.size > MAX_STRUCTURED_OUTPUT_BYTES
    ) {
      return { ok: false, kind: "oversize" };
    }
    return {
      ok: true,
      text: buffer.subarray(0, total).toString("utf8"),
    };
  } catch {
    return { ok: false, kind: "read-error" };
  } finally {
    await file.close().catch(() => undefined);
  }
}

function validatePrivateTempDir(tempDir: string, prefix: string): string {
  const root = path.resolve(os.tmpdir());
  const resolved = path.resolve(tempDir);
  if (
    !resolved.startsWith(`${root}${path.sep}`) ||
    !path.basename(resolved).startsWith(prefix)
  ) {
    throw new Error("refusing unsafe private temp path");
  }
  return resolved;
}

export function privateTempFile(tempDir: string, fileName: string): string {
  if (fileName !== path.basename(fileName) || fileName.length === 0) {
    throw new Error("private temp file name must be a basename");
  }
  const resolvedDir = path.resolve(tempDir);
  const filePath = path.resolve(resolvedDir, fileName);
  if (path.dirname(filePath) !== resolvedDir) {
    throw new Error("private temp file escaped its directory");
  }
  return filePath;
}

export async function writePrivateFile(
  filePath: string,
  contents: string
): Promise<void> {
  await fs.promises.writeFile(filePath, contents, { mode: 0o600 });
  await fs.promises.chmod(filePath, 0o600);
}

export async function withPrivateTempDir<T>(
  prefix: string,
  fn: (tempDir: string) => Promise<T>,
  deadline?: ProviderDeadline,
): Promise<T> {
  if (
    prefix.length === 0 ||
    prefix.includes(path.sep) ||
    (path.sep !== "/" && prefix.includes("/"))
  ) {
    throw new Error("private temp prefix must not contain path separators");
  }
  const pendingMkdtemp = fs.promises.mkdtemp(
    path.join(os.tmpdir(), prefix),
  );
  let tempDir: string;
  try {
    tempDir = deadline
      ? await runBeforeDeadline(deadline, () => pendingMkdtemp)
      : await pendingMkdtemp;
  } catch (error) {
    // A filesystem implementation cannot be assumed to honor cancellation. If
    // creation settles after the route has timed out, remove that exact late
    // directory without holding the provider queue open.
    void pendingMkdtemp
      .then(async (created) => {
        const latePath = validatePrivateTempDir(created, prefix);
        await fs.promises.rm(latePath, {
          recursive: true,
          force: true,
        });
      })
      .catch(() => undefined);
    throw error;
  }
  const validated = validatePrivateTempDir(tempDir, prefix);
  try {
    const chmod = fs.promises.chmod(validated, 0o700);
    await (deadline
      ? runBeforeDeadline(deadline, () => chmod)
      : chmod);
    return await fn(validated);
  } finally {
    // Revalidate the exact mkdtemp result immediately before destructive cleanup.
    const cleanupPath = validatePrivateTempDir(validated, prefix);
    const cleanup = fs.promises.rm(cleanupPath, {
      recursive: true,
      force: true,
    });
    if (deadline) {
      try {
        await runBeforeDeadline(deadline, () => cleanup);
      } catch (error) {
        if (!isProviderDeadlineExceeded(error)) throw error;

        // Once the provider budget expires, a known private directory still
        // gets one small, independently bounded cleanup allowance before the
        // public operation settles. This preserves the privacy guarantee
        // without allowing a stuck filesystem to hold the provider queue
        // forever. The already-started removal remains observed if it outlives
        // that allowance.
        const cleanupDeadline = createProviderDeadline(
          PRIVATE_TEMP_CLEANUP_TIMEOUT_MS,
        );
        await runBeforeDeadline(
          cleanupDeadline,
          () => cleanup,
        ).catch(() => {
          void cleanup.catch(() => undefined);
        });
        throw error;
      }
    } else {
      await cleanup;
    }
  }
}
