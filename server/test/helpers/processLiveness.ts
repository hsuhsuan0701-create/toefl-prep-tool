import fs from "node:fs";

/**
 * Whether a process can still run anything, for the tests that check a spawned CLI's
 * descendants are stopped.
 *
 * `process.kill(pid, 0)` succeeds for a zombie: a process that has exited but whose
 * parent has not yet collected it. A killed descendant whose parent already exited is
 * reparented to PID 1, and where PID 1 is not an init that reaps promptly (a container
 * started without `--init`, some sandboxes and CI runners) it stays a zombie for longer
 * than any test waits. So on Linux the probe reads the state from `/proc/<pid>/stat`
 * and counts a zombie (`Z`), a dead entry (`X`) or a missing entry as stopped. Other
 * platforms, and a Linux without `/proc`, keep the signal probe.
 */
export function processIsAlive(pid: number): boolean {
  if (procfsAvailable()) {
    const state = procState(pid);
    return state !== undefined && state !== "Z" && state !== "X";
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

let procfs: boolean | undefined;

function procfsAvailable(): boolean {
  procfs ??= process.platform === "linux" && fs.existsSync("/proc/self/stat");
  return procfs;
}

/** The one-letter state from `/proc/<pid>/stat`, or undefined once the entry is gone. */
export function procState(pid: number): string | undefined {
  let stat: string;
  try {
    stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // The format is `pid (comm) state ...`, and comm may itself hold spaces and
  // parentheses, so the state is the first field after the last `)`.
  const state = stat.slice(stat.lastIndexOf(")") + 1).trimStart()[0];
  if (state === undefined) throw new Error(`unparseable /proc/${pid}/stat: ${stat}`);
  return state;
}
