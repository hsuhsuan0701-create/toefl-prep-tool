/**
 * `npm run demo [-- --reset] [--dir <dir>] [--today <date>] [--port <n>] [--api-port <n>]`
 *
 * Seeds a demo data directory (under the OS temp directory unless --dir says otherwise), or reuses
 * the one an earlier run seeded, and starts the server and the client against it. See
 * docs/demo-data.md.
 *
 *   --reset         re-seed the directory, dated to --today (default now)
 *   --today <date>  with --reset or on the first run, the day the history leads up to
 *   --dir <dir>     a different demo directory
 *   --port <n>      the client's port (default 5190)
 *   --api-port <n>  the server's port (default 8790)
 *
 * Its own ports, so it can run beside your real instance (5173/8787). The server reads no .env and
 * is given no API keys and no Claude or Codex CLI: the demo works on a fresh clone, and nothing done
 * in it, such as a Re-score, can spend anyone's quota or write a real score into demo data.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describeSeed, parseToday, repoRoot, seedDemoDirectory } from "./seedDirectory.js";
import { DEMO_MARKER, SeedTargetRefused, defaultDemoDir } from "./target.js";

type Args = { dir: string; reset: boolean; today: string | undefined; port: number; apiPort: number };

function parseArgs(argv: string[]): Args {
  const args: Args = { dir: defaultDemoDir(), reset: false, today: undefined, port: 5190, apiPort: 8790 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    const port = (raw: string) => {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`${arg} must be a port number, not "${raw}"`);
      return n;
    };
    if (arg === "--reset") args.reset = true;
    else if (arg === "--dir") args.dir = value();
    else if (arg === "--today") args.today = value();
    else if (arg === "--port") args.port = port(value());
    else if (arg === "--api-port") args.apiPort = port(value());
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (args.port === args.apiPort) throw new Error("--port and --api-port must differ");
  return args;
}

/** True when `dir` holds a database an earlier demo:seed finished writing. */
function isSeeded(dir: string): boolean {
  return fs.existsSync(path.join(dir, DEMO_MARKER)) && fs.existsSync(path.join(dir, "db.sqlite"));
}

function prefixed(child: ChildProcess, name: string): void {
  for (const stream of [child.stdout, child.stderr]) {
    let pending = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.trim() !== "") process.stdout.write(`${name} | ${line}\n`);
    });
  }
}

async function waitFor(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let dataDir = path.resolve(args.dir);

  if (args.reset || !isSeeded(dataDir)) {
    console.log(args.reset ? `Re-seeding demo data in ${dataDir} ...` : `Seeding demo data in ${dataDir} ...`);
    const seeded = await seedDemoDirectory({ dir: dataDir, today: parseToday(args.today), force: true });
    console.log(describeSeed(seeded).join("\n"));
  } else if (args.today !== undefined) {
    console.log("--today applies when the demo is seeded; add --reset to re-seed with it.");
  }

  // The server compares resolved paths against its data directory, so it is handed the real one.
  dataDir = fs.realpathSync(dataDir);
  const noCli = path.join(dataDir, ".no-cli");
  const inherited = { ...process.env };
  delete inherited.NODE_ENV;
  delete inherited.VITEST;
  const serverEnv: NodeJS.ProcessEnv = {
    ...inherited,
    TOEFL_DATA_DIR: dataDir,
    PORT: String(args.apiPort),
    GEMINI_API_KEY: "",
    OPENAI_API_KEY: "",
    CLAUDE_BIN: path.join(noCli, "claude"),
    CODEX_BIN: path.join(noCli, "codex"),
  };
  const tsxCli = createRequire(path.join(repoRoot, "server", "package.json")).resolve("tsx/cli");
  const viteBin = [path.join(repoRoot, "client", "node_modules", "vite", "bin", "vite.js"), path.join(repoRoot, "node_modules", "vite", "bin", "vite.js")]
    .find((candidate) => fs.existsSync(candidate));
  if (!viteBin) throw new Error("vite is not installed; run `npm ci` first");

  const server = spawn(process.execPath, [tsxCli, "src/index.ts"], { cwd: path.join(repoRoot, "server"), env: serverEnv });
  // The client's dev server proxies /api to the port in PORT (client/vite.config.ts).
  const client = spawn(process.execPath, [viteBin, "--port", String(args.port), "--strictPort", "--clearScreen", "false"], {
    cwd: path.join(repoRoot, "client"),
    env: { ...inherited, PORT: String(args.apiPort) },
  });
  prefixed(server, "server");
  prefixed(client, "client");

  let stopping = false;
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    for (const child of [server, client]) if (child.exitCode === null) child.kill("SIGTERM");
    process.exitCode = code;
  };
  for (const [child, name] of [[server, "server"], [client, "client"]] as const) {
    child.on("exit", (code) => {
      if (!stopping) console.error(`The demo ${name} stopped (exit ${code}); stopping the demo.`);
      stop(code ?? 1);
    });
  }
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));

  const url = `http://localhost:${args.port}`;
  const ready = (await waitFor(`http://127.0.0.1:${args.apiPort}/api/ready`, 60_000)) && (await waitFor(url, 60_000));
  if (stopping) return;
  if (!ready) {
    console.error("The demo did not come up within a minute; see the server and client lines above.");
    stop(1);
    return;
  }
  console.log(`\nDemo running at ${url}`);
  console.log(`This is demo data, not anyone's practice history; it lives in ${dataDir}. Ctrl-C stops it; --reset re-seeds it.\n`);
}

main().catch((err) => {
  console.error(err instanceof SeedTargetRefused || err instanceof Error ? err.message : String(err));
  process.exit(1);
});
