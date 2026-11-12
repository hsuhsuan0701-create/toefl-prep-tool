import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ETS_SAMPLE_FIXTURES_DIR,
  ETS_SPEAKING_SET_ID,
  ETS_WRITING_SET_ID,
  etsFixturePath,
  etsSetPath,
  missingEtsMaterial,
  missingEtsMaterialMessage,
} from "../../scripts/lib/etsLocal.js";
import { parseEssayScoreResult } from "../../scripts/lib/scoringJob.js";

// The calibration and smoke scripts read ETS's sample material from paths the public repository
// leaves empty. Before spending anything they check that it is there, and say what is missing.

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");

// Where ETS's material lives on a machine that holds it, relative to the repository root: the
// scored samples, the two sample Sets, and the Speaking Set's audio and scene image.
const ETS_MATERIAL_PATHS = [
  `${ETS_SAMPLE_FIXTURES_DIR}/`,
  etsSetPath("writing", ETS_WRITING_SET_ID),
  etsSetPath("speaking", ETS_SPEAKING_SET_ID),
  `data/audio/stimuli/${ETS_SPEAKING_SET_ID}/`,
  `data/images/scenarios/${ETS_SPEAKING_SET_ID}.webp`,
];

/** True when REPO_ROOT is the top of a git work tree, as global-setup.ts decides it. */
function isRepositoryCheckout(): boolean {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    return fs.realpathSync(top) === fs.realpathSync(REPO_ROOT);
  } catch {
    return false;
  }
}

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("missingEtsMaterial", () => {
  it("names exactly the paths that are absent", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ets-local-"));
    roots.push(root);
    const present = etsFixturePath("email-4-1.json");
    fs.mkdirSync(path.join(root, path.dirname(present)), { recursive: true });
    fs.writeFileSync(path.join(root, present), "{}");
    const wanted = [present, etsFixturePath("discussion-5-1.json"), etsSetPath("writing", ETS_WRITING_SET_ID)];
    expect(missingEtsMaterial(wanted, root)).toEqual([
      "server/test/fixtures/ets-samples/discussion-5-1.json",
      "data/question-sets/writing/wri-703ea6d7.json",
    ]);
  });

  it("explains where the material goes and that nothing was spent", () => {
    const message = missingEtsMaterialMessage([etsSetPath("speaking", ETS_SPEAKING_SET_ID)]);
    expect(message).toContain("missing: data/question-sets/speaking/spk-8d9ee619.json");
    expect(message).toContain("docs/official-rubrics.md");
    expect(message).toContain("Nothing was sent to any model.");
  });

  it("is never satisfied by the public tree, which holds none of it", () => {
    // These paths are ignored by git, so a fresh clone has none of them. Checked against .gitignore
    // rather than the disk, which may hold someone's own local copies.
    const ignore = fs.readFileSync(path.join(REPO_ROOT, ".gitignore"), "utf8").split("\n");
    for (const entry of ETS_MATERIAL_PATHS) {
      expect(ignore).toContain(`/${entry}`);
    }
  });

  // .gitignore keeps a new copy out, but not a file committed before the entry existed or added
  // with `git add -f`. Only the index says what a clone receives. Skipped outside a git checkout of
  // this repository (an extracted release archive), where there is no index to ask.
  it.runIf(isRepositoryCheckout())("is tracked by git nowhere, so a clone receives none of it", () => {
    const tracked = (paths: string[]) =>
      execFileSync("git", ["ls-files", "--", ...paths], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
    // The control: the same query names a file that is tracked, so an empty answer below is git's
    // and not a query that could never match.
    expect(tracked([".gitignore"])).toBe(".gitignore");
    expect(tracked(ETS_MATERIAL_PATHS)).toBe("");
  });
});

describe("parseEssayScoreResult", () => {
  const result = {
    taskType: "email",
    report: {
      taskType: "email",
      items: [{
        itemId: "email-1", ownScore: 4, finalScore: 4, maxScore: 5,
        dimensions: [{ name: "mechanics", note: "clean" }], deductions: [],
        reconciliationNote: "agreed", feedbackZh: "清楚。",
      }],
    },
    judges: [{ judge: "gemini", score: 4, dimensions: [], deductions: [] }],
    judgesFailed: ["openai"],
  };

  it("accepts a finished essay scoring job's result", () => {
    expect(parseEssayScoreResult(result)).toMatchObject({ taskType: "email", judgesFailed: ["openai"] });
  });

  it("rejects a result for another Task Type or with no single item", () => {
    expect(() => parseEssayScoreResult({ ...result, taskType: "discussion" })).toThrow("invalid result");
    expect(() => parseEssayScoreResult({ ...result, report: { ...result.report, items: [] } })).toThrow("invalid result");
  });
});
