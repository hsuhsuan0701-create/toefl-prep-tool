import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  attemptSupervisorMetrics,
  superviseAttempt,
} from "../src/services/reasoning/attemptSupervisor.js";
import { processIsAlive } from "./helpers/processLiveness.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const markerPaths: string[] = [];

afterEach(() => {
  for (const marker of markerPaths.splice(0)) {
    const pid = Number(fs.readFileSync(marker, "utf8").split("\n", 1)[0]);
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already reaped, which is what every teardown assertion here expects.
      }
    }
    fs.rmSync(marker, { force: true });
  }
});

function markerPath(label: string): string {
  const marker = path.join(
    os.tmpdir(),
    `toefl-attempt-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  markerPaths.push(marker);
  return marker;
}

const sleepLock = new Int32Array(new SharedArrayBuffer(4));
/**
 * Blocks the whole event loop, which is the pressure the real consumer puts
 * on this pipe: claudeRunner's onStdout does a synchronous fs.appendFileSync per
 * chunk while the server is also serving requests and running up to eight other
 * attempts. A consumer slower than the CLI's producer is what leaves bytes buffered
 * inside the supervisor at the moment the CLI exits.
 */
function stallEventLoop(ms: number): void {
  Atomics.wait(sleepLock, 0, 0, ms);
}

async function expectProcessStopped(marker: string, timeoutMs = 2_000): Promise<void> {
  const pid = Number(fs.readFileSync(marker, "utf8").split("\n", 1)[0]);
  expect(Number.isSafeInteger(pid) && pid > 0, `missing PID in ${marker}`).toBe(true);
  const deadline = Date.now() + timeoutMs;
  while (processIsAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(processIsAlive(pid), `descendant ${pid} survived teardown`).toBe(false);
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

/**
 * Payload comfortably past any plausible pipe buffer (macOS is typically 64 KiB), so
 * the reproduction does not depend on the host's exact buffer size. It also has to
 * stay under cliProcess's MAX_STRUCTURED_OUTPUT_BYTES so it stands for a *successful*
 * response rather than the already-covered overflow path.
 */
const LARGE_PAYLOAD_BYTES = 768 * 1024;
const TAIL_SENTINEL = "<<<END-OF-RESPONSE>>>";

/** A CLI that writes `LARGE_PAYLOAD_BYTES`, ending with the sentinel, then exits. */
function largeOutputTargetSource(extra = ""): string {
  return [
    `const fs = require("node:fs")`,
    `const cp = require("node:child_process")`,
    extra,
    `const tail = ${JSON.stringify(TAIL_SENTINEL)}`,
    `const body = ${LARGE_PAYLOAD_BYTES} - Buffer.byteLength(tail)`,
    `const chunk = Buffer.alloc(64 * 1024, 0x61)`,
    `let written = 0`,
    // writeSync blocks until the kernel accepts every byte, so the CLI itself never
    // drops output: anything missing was lost downstream, inside the supervisor.
    `while (written < body) { const n = Math.min(chunk.length, body - written); fs.writeSync(1, chunk, 0, n); written += n }`,
    `fs.writeSync(1, tail)`,
    `process.exit(0)`,
  ]
    .filter((line) => line.length > 0)
    .join(";\n");
}

/** Spawns a descendant that inherits the CLI's stdout and never exits on its own. */
function stdoutHoldingDescendant(marker: string): string {
  return [
    `const held = cp.spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 50)", ${JSON.stringify(marker)}], { stdio: ["ignore", "inherit", "ignore"] })`,
    `while (!(fs.existsSync(${JSON.stringify(marker)}) && fs.statSync(${JSON.stringify(marker)}).size > 0)) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) }`,
  ].join(";\n");
}

describe("AttemptSupervisor", () => {
  it("reaps the CLI when the server process dies without cleaning up", async () => {
    const marker = markerPath("orphan");
    const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "toefl-supervisor-host-"));
    try {
      // A stand-in server: it starts one supervised CLI, then is killed outright, so none of its
      // own cleanup runs. Only the leader's fd 3 reaching EOF can stop the CLI.
      const hostScript = path.join(hostDir, "host.mts");
      const supervisor = pathToFileURL(path.resolve(here, "../src/services/reasoning/attemptSupervisor.ts")).href;
      const target = [
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid))`,
        `setInterval(() => {}, 1000)`,
      ].join(";");
      fs.writeFileSync(hostScript, [
        `import { superviseAttempt } from ${JSON.stringify(supervisor)};`,
        `void superviseAttempt({ bin: process.execPath, args: ["-e", ${JSON.stringify(target)}], cwd: process.cwd(), prompt: "", timeoutMs: 60_000 });`,
      ].join("\n"));
      const host = spawn(process.execPath, ["--import", "tsx", hostScript], {
        cwd: path.resolve(here, ".."),
        env: process.env,
        stdio: "ignore",
      });

      await waitForFile(marker, 15_000);
      const targetPid = Number(fs.readFileSync(marker, "utf8"));
      expect(processIsAlive(targetPid)).toBe(true);
      host.kill("SIGKILL");

      await expectProcessStopped(marker, 10_000);
    } finally {
      fs.rmSync(hostDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("cancels the exact process group with TERM before the KILL grace expires", async () => {
    const marker = markerPath("term");
    const controller = new AbortController();

    const running = superviseAttempt({
      bin: process.execPath,
      args: [
        "-e",
        [
          `const fs = require("node:fs")`,
          `process.on("SIGTERM", () => { fs.writeFileSync(${JSON.stringify(marker)}, "term"); process.exit(0) })`,
          `process.stdout.write("ready\\n")`,
          `setInterval(() => {}, 1000)`,
        ].join(";"),
      ],
      cwd: process.cwd(),
      prompt: "",
      timeoutMs: 10_000,
      killGraceMs: 2_000,
      signal: controller.signal,
      onStdout(text) {
        if (text.includes("ready")) controller.abort();
      },
    });

    const result = await running;
    expect(result.cancelled).toBe(true);
    expect(fs.readFileSync(marker, "utf8")).toBe("term");
    // The group leader remains until the fixed grace expires so descendants cannot
    // escape cleanup; the cooperative target still proves TERM arrived first.
    expect(result.signal).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  // The leader drains the CLI's stdout before it kills its process group. Killing the group
  // the instant the CLI exits would discard whatever is still buffered between the CLI and the
  // server, and the caller would parse a truncated response and treat a successful paid call
  // as invalid output.
  it("delivers every byte of a large successful response to a consumer slower than the CLI", async () => {
    let received = 0;
    let tail = "";
    const result = await superviseAttempt({
      bin: process.execPath,
      args: ["-e", largeOutputTargetSource()],
      cwd: process.cwd(),
      prompt: "",
      timeoutMs: 30_000,
      onStdout(text, chunk) {
        received += chunk.byteLength;
        tail = (tail + text).slice(-TAIL_SENTINEL.length);
        stallEventLoop(4);
      },
    });

    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false, cancelled: false });
    // Byte-exact: "most of it" is still a response the caller cannot parse.
    expect(received).toBe(LARGE_PAYLOAD_BYTES);
    expect(tail).toBe(TAIL_SENTINEL);
  }, 60_000);

  it("still reaps a descendant the CLI left behind while draining a large response", async () => {
    const marker = markerPath("drain-descendant");
    let received = 0;
    let tail = "";
    const result = await superviseAttempt({
      bin: process.execPath,
      args: [
        "-e",
        largeOutputTargetSource(
          [
            // Own stdio, so it does not hold the CLI's stdout open: this descendant
            // stands for detached logical work, not for a stalled drain.
            `const orphan = cp.spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 50)", ${JSON.stringify(marker)}], { stdio: "ignore" })`,
            `while (!(fs.existsSync(${JSON.stringify(marker)}) && fs.statSync(${JSON.stringify(marker)}).size > 0)) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10) }`,
          ].join(";\n"),
        ),
      ],
      cwd: process.cwd(),
      prompt: "",
      timeoutMs: 30_000,
      onStdout(text, chunk) {
        received += chunk.byteLength;
        tail = (tail + text).slice(-TAIL_SENTINEL.length);
        stallEventLoop(4);
      },
    });

    expect(result).toMatchObject({ code: 0, timedOut: false, cancelled: false });
    expect(received).toBe(LARGE_PAYLOAD_BYTES);
    expect(tail).toBe(TAIL_SENTINEL);
    // Deferring teardown does not weaken it: the group kill still runs, just later.
    await expectProcessStopped(marker);
  }, 60_000);

  it("caps the drain so a descendant holding stdout open cannot stall the attempt", async () => {
    const marker = markerPath("held-stdout");
    const drainGraceMs = 400;
    let received = 0;
    const startedAt = Date.now();
    const result = await superviseAttempt({
      bin: process.execPath,
      args: ["-e", largeOutputTargetSource(stdoutHoldingDescendant(marker))],
      cwd: process.cwd(),
      prompt: "",
      timeoutMs: 30_000,
      drainGraceMs,
      onStdout(_text, chunk) {
        received += chunk.byteLength;
      },
    });
    const elapsed = Date.now() - startedAt;

    expect(result).toMatchObject({ code: 0, timedOut: false, cancelled: false });
    // stdout never reaches EOF here, so the bounded grace — not the stream — ends it.
    expect(elapsed).toBeLessThan(drainGraceMs + 10_000);
    expect(received).toBe(LARGE_PAYLOAD_BYTES);
    await expectProcessStopped(marker);
  }, 60_000);

  it("tears down on cancellation without waiting out the drain grace", async () => {
    const marker = markerPath("cancel-held-stdout");
    const controller = new AbortController();
    const killGraceMs = 200;
    const startedAt = Date.now();
    const running = superviseAttempt({
      bin: process.execPath,
      args: [
        "-e",
        [
          `const fs = require("node:fs")`,
          `const cp = require("node:child_process")`,
          stdoutHoldingDescendant(marker),
          `fs.writeSync(1, "ready\\n")`,
          `setInterval(() => {}, 50)`,
        ].join(";\n"),
      ],
      cwd: process.cwd(),
      prompt: "",
      timeoutMs: 30_000,
      killGraceMs,
      // Long enough that a drain-grace wait would be unmistakable in the elapsed time.
      drainGraceMs: 60_000,
      signal: controller.signal,
      onStdout(text) {
        if (text.includes("ready")) controller.abort();
      },
    });
    await waitForFile(marker);
    const result = await running;
    const elapsed = Date.now() - startedAt;

    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
    // The kill path settles on the termination grace, unchanged by the drain deferral.
    expect(elapsed).toBeLessThan(20_000);
    await expectProcessStopped(marker);
  }, 60_000);

  it("times out and force-kills a group whose stdout will never end", async () => {
    const marker = markerPath("timeout-held-stdout");
    const before = attemptSupervisorMetrics();
    const startedAt = Date.now();
    const result = await superviseAttempt({
      bin: process.execPath,
      args: [
        "-e",
        [
          `const fs = require("node:fs")`,
          `const cp = require("node:child_process")`,
          // Ignoring SIGTERM forces the supervisor down its escalation path.
          `process.on("SIGTERM", () => {})`,
          stdoutHoldingDescendant(marker),
          `fs.writeSync(1, "ready\\n")`,
          `setInterval(() => {}, 50)`,
        ].join(";\n"),
      ],
      cwd: process.cwd(),
      prompt: "",
      timeoutMs: 400,
      killGraceMs: 200,
      drainGraceMs: 60_000,
    });
    const elapsed = Date.now() - startedAt;
    const after = attemptSupervisorMetrics();

    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(after.timeouts).toBe(before.timeouts + 1);
    expect(after.forcedKills).toBe(before.forcedKills + 1);
    expect(elapsed).toBeLessThan(20_000);
    await expectProcessStopped(marker);
  }, 60_000);
});
