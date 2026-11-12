import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    // This run's scratch directory. Everything a run writes lives under it, and teardown removes it.
    testRunDir: string;
    // The seeded bank, inside testRunDir. No test reads or writes it directly: setup-env.ts copies
    // it into a directory of each test file's own (helpers/privateDataDir.ts) and points
    // TOEFL_DATA_DIR at the copy before any test module imports config.ts.
    testDataTemplate: string;
    // The OS temp directory every worker sees, inside testRunDir. setup-env.ts points TMPDIR (TMP
    // and TEMP on Windows) at it, so whatever a test or the code under test creates through
    // os.tmpdir() is removed with the run instead of accumulating in the machine's temp dir.
    testTmpDir: string;
  }
}

// Runs once per `vitest run`, in the main process, before any worker starts (setupFiles, by
// contrast, run per test file inside each worker). It creates the run's own directory, seeds the
// bank template inside it, hands both paths to the workers, and deletes the directory when the run
// ends.
//
// Every run gets a fresh directory under the OS temp dir rather than one fixed path inside the
// checkout, because a fixed path is shared state between runs: the second `npm test` in the same
// checkout would wipe and re-seed the directory the first run's workers were still writing into.
// Every test file then gets its own copy of the template, for the same reason one level down: test
// files publish Sets, plant corrupt files and upload recordings into the bank, and a file that
// lists or picks from the bank must never see what another file wrote there.
//
// No test writes to the real bank: config.dataDir always points into this run's directory.
// config.ts's readDataDir refuses a TOEFL_DATA_DIR inside the repo's data/ while running under
// vitest, so even an invocation that bypasses this file (running vitest from the repo root without
// the workspace config) fails before a test can write anything. The checks that walk the whole bank
// read it through `config.dataDir`, so they see the committed Sets and nothing a contributor
// generated locally; routes.sets.test.ts is the one that still walks the checkout's data/ through
// `config.projectRoot`, and so also sees Sets that are not committed.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

// Fixtures the suite reads back by hardcoded id. Checked explicitly so a Set removed from the bank
// fails here, naming the file, instead of as an unexplained 404 deep inside a route test.
const BACKFILLED_SCENE_FIXTURE_IDS = ["spk-26132ac6", "spk-43ab8b09", "spk-e5b2b735"];
const REQUIRED_FIXTURES = [
  ...BACKFILLED_SCENE_FIXTURE_IDS.flatMap((id) => [
    `question-sets/speaking/${id}.json`,
    `images/scenarios/${id}.webp`,
  ]),
  // routes.sets.test.ts serves this clip through the audio route.
  "audio/stimuli/spk-e5b2b735/lr-1.mp3",
];

// What is seeded: the question bank itself (every Set the suite validates, lists or scores), and
// the few media files named above. The bank's other media (about 90 MB of stimulus audio and scene
// images) is read by no test: every test that renders or serves media writes its own into a
// temporary directory.
function isSeeded(rel: string): boolean {
  if (rel.startsWith("question-sets/.staging/")) return false;
  return (rel.startsWith("question-sets/") && rel.endsWith(".json")) || REQUIRED_FIXTURES.includes(rel);
}

// The bank as the commit has it, so a run's result does not depend on Sets that happen to sit
// untracked in the working tree (a freshly generated batch, a half-deleted one). Files come from
// the working tree, so an edited Set is tested as edited. Outside a git checkout (an extracted
// release archive) every file there is part of the release, so the directory itself is the list.
function bankFiles(): string[] {
  const bankDir = path.join(repoRoot, "data");
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: repoRoot, encoding: "utf8" }).trim();
    if (fs.realpathSync(top) === fs.realpathSync(repoRoot)) {
      return execFileSync("git", ["ls-files", "-z", "--", "data"], { cwd: repoRoot, encoding: "utf8" })
        .split("\0")
        .filter(Boolean)
        .map((file) => path.relative("data", file))
        .filter((rel) => fs.existsSync(path.join(bankDir, rel)));
    }
  } catch {
    // Not a git checkout, or no git on PATH: fall through to the directory listing.
  }
  if (!fs.existsSync(bankDir)) return [];
  return (fs.readdirSync(bankDir, { recursive: true, withFileTypes: true }) as fs.Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(bankDir, path.join(entry.parentPath, entry.name)));
}

function seed(testDataDir: string): void {
  const bankDir = path.join(repoRoot, "data");
  for (const rel of bankFiles().filter(isSeeded)) {
    const target = path.join(testDataDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(bankDir, rel), target);
  }
  for (const rel of REQUIRED_FIXTURES) {
    if (!fs.existsSync(path.join(testDataDir, rel))) {
      throw new Error(
        `Test fixture missing: data/${rel} is not in the question bank, so the suite cannot seed it. ` +
          `Restore it with: git checkout -- data/${rel}`
      );
    }
  }
}

export default function setup(project: TestProject): () => void {
  // realpath: on macOS the temp dir is reached through the /var -> /private/var symlink, and the
  // server's containment checks compare resolved paths against config.dataDir.
  const testRunDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "toefl-server-test-")));
  const testDataTemplate = path.join(testRunDir, "template");
  const testTmpDir = path.join(testRunDir, "tmp");
  try {
    seed(testDataTemplate);
    fs.mkdirSync(testTmpDir);
  } catch (error) {
    fs.rmSync(testRunDir, { recursive: true, force: true });
    throw error;
  }
  project.provide("testRunDir", testRunDir);
  project.provide("testDataTemplate", testDataTemplate);
  project.provide("testTmpDir", testTmpDir);
  return () => {
    fs.rmSync(testRunDir, { recursive: true, force: true });
  };
}
