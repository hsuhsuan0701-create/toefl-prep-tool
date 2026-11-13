import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { processIsAlive, procState } from "./helpers/processLiveness.js";

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

function track(child: ChildProcess): ChildProcess {
  children.push(child);
  return child;
}

async function firstLine(child: ChildProcess): Promise<string> {
  let out = "";
  for await (const chunk of child.stdout!) {
    out += String(chunk);
    if (out.includes("\n")) return out.split("\n", 1)[0]!;
  }
  throw new Error("child closed stdout before printing a line");
}

describe("processIsAlive", () => {
  it("reports a running process alive, even one whose name holds spaces and parentheses", async () => {
    const child = track(
      spawn(
        process.execPath,
        ["-e", `process.title = "a (b) c"; console.log("ready"); setInterval(() => {}, 1000)`],
        { stdio: ["ignore", "pipe", "ignore"] },
      ),
    );
    await firstLine(child);
    expect(processIsAlive(child.pid!)).toBe(true);
    if (process.platform === "linux") expect(procState(child.pid!)).toMatch(/^[RS]$/);
  });

  it.runIf(process.platform === "linux")(
    "reports a zombie stopped: it has exited and only waits for its parent to collect it",
    async () => {
      // Node collects an exited child only from its event loop, so while this test
      // holds the loop synchronously the child stays a zombie of this process: the
      // same state a killed descendant is in when PID 1 is slow to reap it.
      const child = track(spawn(process.execPath, ["-e", ""], { stdio: "ignore" }));
      const pid = child.pid!;
      const exited = once(child, "exit");
      const deadline = Date.now() + 5_000;
      while (procState(pid) !== "Z" && Date.now() < deadline) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      expect(procState(pid)).toBe("Z");
      // The signal probe the helper replaces still calls it alive.
      expect(() => process.kill(pid, 0)).not.toThrow();
      expect(processIsAlive(pid)).toBe(false);
      await exited;
    },
    10_000,
  );

  it("reports a reaped process stopped", async () => {
    const child = track(spawn(process.execPath, ["-e", ""], { stdio: "ignore" }));
    const pid = child.pid!;
    await once(child, "exit");
    expect(processIsAlive(pid)).toBe(false);
  });
});
