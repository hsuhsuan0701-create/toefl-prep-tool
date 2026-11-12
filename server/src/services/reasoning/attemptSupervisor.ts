import { spawn } from "node:child_process";
import { config } from "../../lib/config.js";

export const DEFAULT_ATTEMPT_KILL_GRACE_MS = 2_000;
/**
 * Caps how long the group leader defers its own teardown while the finished CLI's
 * output finishes crossing into the server's pipe. The legitimate drain is only the
 * bytes still buffered when the CLI exited — at most a few pipe buffers — so any
 * healthy attempt clears this in well under a millisecond. The cap exists purely for
 * the pathological case: a descendant that inherited the CLI's stdout and never exits
 * keeps that stream from ever reaching EOF, and an unbounded wait there would hold the
 * attempt (and its scheduler slot) open forever. Deliberately NOT the termination
 * grace: tuning how long a cancelled CLI gets to die politely must not be able to
 * switch off output correctness for successful calls.
 *
 * The symptom to look for if a future CLI does start leaving such a descendant is
 * every successful attempt taking about this long longer than its own work — the
 * healthy path never reaches the timer at all, so a uniform offset is the tell.
 */
export const DEFAULT_ATTEMPT_DRAIN_GRACE_MS = 5_000;
const SETTLEMENT_FALLBACK_MS = 1_000;
const metrics = { cancellations: 0, timeouts: 0, forcedKills: 0 };

export function attemptSupervisorMetrics(): Readonly<typeof metrics> {
  return Object.freeze({ ...metrics });
}

// fd 3 is owned only by the server process. If the server disappears, EOF reaches
// this tiny process-group leader and it reaps the actual CLI instead of orphaning it.
const CONTROLLED_CHILD_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const [bin, encodedArgs, encodedGrace, encodedDrainGrace] = process.argv.slice(1);
const args = JSON.parse(encodedArgs);
const grace = Number(encodedGrace);
const drainGrace = Number(encodedDrainGrace);
const target = spawn(bin, args, { cwd: process.cwd(), env: { ...process.env, TOEFL_ATTEMPT_OWNER_PID: String(process.ppid) }, stdio: ["pipe", "pipe", "pipe"] });
let stopping = false;
let killTimer;
let drainTimer;
let tornDown = false;
let targetExited = false;
let exitFallbackCode = 0;
let pendingForwards = 2;
let targetStatus;
function reportTarget(code, signal) {
  targetStatus = { code, signal };
  try { fs.writeSync(4, JSON.stringify(targetStatus)); } catch {}
}
// Teardown SIGKILLs this leader together with every descendant, so whatever is still
// buffered INSIDE this process dies with it, and the server would read a truncated
// output: the CLI's exit says nothing about the bytes still in flight between it and
// the server, and the CLI's output flows through here. Nothing on the success path may
// call this until every forwarded byte has reached the server's pipe.
function teardown() {
  if (tornDown) return;
  tornDown = true;
  if (drainTimer) clearTimeout(drainTimer);
  control.destroy();
  // A successful CLI may have detached logical work without creating a new OS
  // process group. Reap every such descendant before reporting completion.
  try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(exitFallbackCode); }
}
function maybeTeardown() {
  // Only the success path defers. On the stopping path the leader must instead stay
  // alive for the full termination grace so descendants still receive the mandated
  // later KILL, and a stream that will never end must never delay that.
  if (stopping || tornDown || !targetExited || pendingForwards > 0) return;
  teardown();
}
// Forwards one of the target's streams to this process's matching pipe. The stream
// counts as drained only once it has reached EOF AND every forwarded chunk's write
// callback has fired -- the callback is the moment those bytes actually reached the
// server's pipe, where they survive this process's death. pipe() is deliberately not
// used for this direction: Node never end()s process.stdout/process.stderr, so their
// "finish" would never arrive and there would be nothing to wait on.
function forward(source, sink) {
  let settled = false;
  let ended = false;
  let inFlight = 0;
  const settle = () => {
    if (settled) return;
    settled = true;
    pendingForwards -= 1;
    maybeTeardown();
  };
  const check = () => { if (ended && inFlight === 0) settle(); };
  source.on("data", (chunk) => {
    inFlight += 1;
    if (!sink.write(chunk, () => { inFlight -= 1; check(); })) source.pause();
  });
  sink.on("drain", () => source.resume());
  source.on("end", () => { ended = true; check(); });
  // A closed or errored stream can never deliver more bytes, so treat it as drained
  // instead of holding teardown open until the bounded grace expires.
  source.on("close", () => { ended = true; check(); });
  source.on("error", settle);
  sink.on("error", settle);
}
function stop(group = false) {
  if (stopping) return;
  stopping = true;
  if (group) {
    try { process.kill(-process.pid, "SIGTERM"); } catch { try { target.kill("SIGTERM"); } catch {} }
  } else {
    try { target.kill("SIGTERM"); } catch {}
  }
  killTimer = setTimeout(() => {
    if (group) {
      try { process.kill(-process.pid, "SIGKILL"); } catch { try { target.kill("SIGKILL"); } catch {} }
    } else {
      try { target.kill("SIGKILL"); } catch {}
    }
  }, grace);
}
process.on("SIGTERM", () => stop(false));
process.on("SIGINT", () => stop(false));
process.stdin.pipe(target.stdin);
forward(target.stdout, process.stdout);
forward(target.stderr, process.stderr);
const control = fs.createReadStream(null, { fd: 3, autoClose: false });
control.on("end", () => stop(true));
control.on("close", () => stop(true));
control.on("error", () => stop(true));
control.resume();
target.on("error", (error) => {
  reportTarget(127, null);
  exitFallbackCode = 127;
  // Same drain-before-teardown invariant as the success path: this one line is what
  // classifies the attempt as missing-cli, so it has to reach the server before the
  // group KILL. The grace bounds the wait if the write never completes.
  drainTimer = setTimeout(teardown, drainGrace);
  process.stderr.write(String(error && error.code || "spawn error") + " executable not found\n", () => teardown());
});
target.on("exit", (code, signal) => {
  reportTarget(code, signal);
  targetExited = true;
  exitFallbackCode = code ?? (signal ? 1 : 0);
  // During cancellation/EOF, keep the group leader alive for the full grace so
  // descendants receive the mandated later KILL even if the direct CLI exits.
  if (stopping) return;
  // Process exit does not mean the output drained. Defer teardown until both
  // forwards report every byte delivered, but cap the wait so a descendant holding
  // the CLI's stdout open cannot keep this attempt alive forever.
  drainTimer = setTimeout(teardown, drainGrace);
  maybeTeardown();
});
`;

export interface SuperviseAttemptOptions {
  readonly bin: string;
  readonly args: readonly string[];
  readonly prompt: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly killGraceMs?: number;
  /** Upper bound on the post-exit output drain; see DEFAULT_ATTEMPT_DRAIN_GRACE_MS. */
  readonly drainGraceMs?: number;
  readonly signal?: AbortSignal;
  readonly onStdout?: (text: string, chunk: Buffer) => void;
  readonly onStderr?: (text: string, chunk: Buffer) => void;
}

export interface SupervisedAttemptResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly spawnErrorCode?: string;
  readonly spawnErrorMessage?: string;
}

function signalGroup(
  processGroupId: number | undefined,
  signal: NodeJS.Signals,
): void {
  if (processGroupId === undefined) return;
  try {
    process.kill(-processGroupId, signal);
  } catch {
    // The captured group may already have settled. Never target a reused PID.
  }
}

export function superviseAttempt(
  options: SuperviseAttemptOptions,
): Promise<SupervisedAttemptResult> {
  if (options.timeoutMs <= 0 || options.signal?.aborted) {
    return Promise.resolve({
      code: null,
      signal: null,
      timedOut: options.timeoutMs <= 0,
      cancelled: options.signal?.aborted ?? false,
    });
  }

  return new Promise((resolve) => {
    const graceMs = Math.max(0, options.killGraceMs ?? config.attemptTerminationGraceMs ?? DEFAULT_ATTEMPT_KILL_GRACE_MS);
    const drainGraceMs = Math.max(
      0,
      options.drainGraceMs ?? DEFAULT_ATTEMPT_DRAIN_GRACE_MS,
    );
    const child = spawn(process.execPath, [
      "-e",
      CONTROLLED_CHILD_SOURCE,
      "--",
      options.bin,
      JSON.stringify(options.args),
      String(graceMs),
      String(drainGraceMs),
    ], {
      cwd: options.cwd,
      detached: true,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    });
    const processGroupId = child.pid;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let terminationStarted = false;
    let spawnErrorCode: string | undefined;
    let spawnErrorMessage: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let settleTimer: NodeJS.Timeout | undefined;
    let targetStatus: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let targetStatusText = "";
    const closeControl = (): void => {
      const control = child.stdio[3];
      if (control && "end" in control && typeof control.end === "function") {
        control.end();
      }
      control?.destroy();
    };

    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (settleTimer) clearTimeout(settleTimer);
      options.signal?.removeEventListener("abort", abort);
      closeControl();
      // A successful direct child can leave descendants in the dedicated group.
      signalGroup(processGroupId, "SIGKILL");
      resolve({
        code,
        signal,
        timedOut,
        cancelled,
        ...(spawnErrorCode ? { spawnErrorCode } : {}),
        ...(spawnErrorMessage ? { spawnErrorMessage } : {}),
      });
    };

    const terminate = (): void => {
      if (terminationStarted || settled) return;
      terminationStarted = true;
      signalGroup(processGroupId, "SIGTERM");
      killTimer = setTimeout(() => {
        metrics.forcedKills += 1;
        signalGroup(processGroupId, "SIGKILL");
        settleTimer = setTimeout(
          () => finish(null, "SIGKILL"),
          SETTLEMENT_FALLBACK_MS,
        );
      }, graceMs);
    };

    const abort = (): void => {
      cancelled = true;
      metrics.cancellations += 1;
      terminate();
    };
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      metrics.timeouts += 1;
      terminate();
    }, options.timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      options.onStdout?.(chunk.toString(), chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      options.onStderr?.(chunk.toString(), chunk);
    });
    child.stdin.on("error", () => undefined);
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnErrorCode = error.code;
      spawnErrorMessage = error.message;
      finish(null, null);
    });
    child.stdio[4]?.on("data", (chunk: Buffer) => {
      targetStatusText += chunk.toString();
      try {
        targetStatus = JSON.parse(targetStatusText) as typeof targetStatus;
      } catch {
        // A later chunk may complete the small status payload.
      }
    });
    child.once("close", (code, signal) => {
      finish(
        targetStatus ? targetStatus.code : code,
        targetStatus ? targetStatus.signal : signal,
      );
    });
    options.signal?.addEventListener("abort", abort, { once: true });
    child.stdin.end(options.prompt);
  });
}
