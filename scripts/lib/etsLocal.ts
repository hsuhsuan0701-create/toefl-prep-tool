import fs from "node:fs";
import path from "node:path";

/**
 * Where the calibration and smoke scripts find ETS's own material on the machine that runs them.
 *
 * None of it is in the public repository: ETS licenses its sample responses, scoring comments and
 * sample tasks and does not allow them to be redistributed. A user who holds copies keeps them at
 * these paths, all ignored by git (.gitignore), and a script that needs one stops before spending
 * anything when it is missing. docs/official-rubrics.md says what each file is.
 */
export const ETS_SAMPLE_FIXTURES_DIR = "server/test/fixtures/ets-samples";

/** ETS's sample Writing task (one email, one academic discussion), as a Set the server can serve. */
export const ETS_WRITING_SET_ID = "wri-703ea6d7";
/** ETS's sample Speaking task (the Listen and Repeat scenario and the interview), as a Set. */
export const ETS_SPEAKING_SET_ID = "spk-8d9ee619";

export const etsSetPath = (kind: "writing" | "speaking", id: string) => `data/question-sets/${kind}/${id}.json`;
export const etsFixturePath = (name: string) => `${ETS_SAMPLE_FIXTURES_DIR}/${name}`;

/** The project-relative paths, of those given, that do not exist under `root`. */
export function missingEtsMaterial(relativePaths: readonly string[], root: string = process.cwd()): string[] {
  return relativePaths.filter((relativePath) => !fs.existsSync(path.join(root, relativePath)));
}

export function missingEtsMaterialMessage(missing: readonly string[]): string {
  return [
    "This script needs ETS's own sample material, which is not part of the public repository:",
    ...missing.map((relativePath) => `  missing: ${relativePath}`),
    "Place your own copies at those paths (they are ignored by git); see docs/official-rubrics.md.",
    "Nothing was sent to any model.",
  ].join("\n");
}

/** Exits with status 2, before any model call, unless every path exists under the working directory. */
export function requireEtsMaterial(relativePaths: readonly string[]): void {
  const missing = missingEtsMaterial(relativePaths);
  if (missing.length === 0) return;
  console.error(missingEtsMaterialMessage(missing));
  process.exit(2);
}
