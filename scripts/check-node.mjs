// Refuses to start the app, the demo or the test suite under a Node.js major version other than the
// one in .nvmrc. Run by the root package.json's predev, prestart, pretest, predemo and
// predemo:seed scripts.
//
// Why it exists: better-sqlite3 is a native module, and the binary an install leaves is good for
// the Node.js version it was installed under. Under another major version the first import either
// fails with "was compiled against a different Node.js version using NODE_MODULE_VERSION ...", deep
// inside a stack trace that never says which version to use, or (under a version older than the
// driver supports) ends the process with no message at all. This turns both into one plain message
// before anything loads.
//
// Plain JavaScript with node: builtins only, so it runs before (and without) any install, and it
// reads one small file: on the right version it prints nothing and exits 0.
//
// TOEFL_SKIP_NODE_CHECK=1 lets a machine whose native modules were deliberately built for another
// version carry on; it prints a one-line warning instead of refusing.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pinned;
try {
  pinned = fs.readFileSync(path.join(repoRoot, ".nvmrc"), "utf8").trim();
} catch {
  // No .nvmrc means no pinned version to compare against.
  process.exit(0);
}

const wantedMajor = Number.parseInt(pinned.replace(/^v/, ""), 10);
const runningMajor = Number.parseInt(process.versions.node, 10);
if (!Number.isInteger(wantedMajor) || runningMajor === wantedMajor) process.exit(0);

if (process.env.TOEFL_SKIP_NODE_CHECK === "1") {
  process.stderr.write(
    `warning: running under Node.js ${process.versions.node}, not the ${wantedMajor} in .nvmrc ` +
      "(TOEFL_SKIP_NODE_CHECK=1). The native SQLite module must have been built for this version.\n",
  );
  process.exit(0);
}

process.stderr.write(
  [
    "",
    `This project runs on Node.js ${wantedMajor} (pinned in .nvmrc). You are running Node.js ${process.versions.node}.`,
    "",
    "Its SQLite driver (better-sqlite3) is a native module installed for one Node.js version. Under",
    "another it fails to load, with an error about NODE_MODULE_VERSION or with no message at all.",
    "",
    "To fix it:",
    `  nvm use            switches to Node.js ${wantedMajor} (or install it from https://nodejs.org)`,
    "  npm ci             only if you installed dependencies under a different version: rebuilds them",
    "",
    "To run anyway with native modules you built for this version yourself:",
    "  TOEFL_SKIP_NODE_CHECK=1 npm <command>",
    "",
  ].join("\n"),
);
process.exit(1);
