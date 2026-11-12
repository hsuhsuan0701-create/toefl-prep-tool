/**
 * Shows that the shipped rubric and sample files are this project's own writing and not ETS's text
 * reworded: for each shipped file that has an official ETS copy installed beside it
 * (`references/official/<same name>`, see docs/official-rubrics.md), it prints the longest run of
 * consecutive words the two share and the share of the shipped file's six-word sequences that also
 * occur in the official copy, and fails when either is over the limit scripts/lib/originality.ts
 * sets and explains.
 *
 * A local tool for whoever edits those files, and only meaningful on a machine with the official
 * text installed. It is deliberately not part of `npm test` or CI: a fresh clone has nothing to
 * compare against, and no build should need ETS's text to pass.
 *
 * Usage: npx tsx scripts/check-rubric-originality.ts
 */
import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../server/src/lib/config.js";
import { OFFICIAL_REFERENCE_FILES, officialReferencePath } from "../server/src/services/skillReferences.js";
import { MAX_SHARED_RUN, MAX_SIX_GRAM_SHARE, compareOriginality } from "./lib/originality.js";

const read = (relativePath: string) => fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
const installed = OFFICIAL_REFERENCE_FILES.filter((relativePath) =>
  fs.existsSync(path.join(projectRoot, officialReferencePath(relativePath))),
);

if (installed.length === 0) {
  console.log(
    "Nothing to compare: no official copy is installed under .claude/skills/*/references/official/.\n" +
      "Install ETS's text as docs/official-rubrics.md describes, then run this again.",
  );
  process.exit(0);
}

console.log(`Limits: shared run at most ${MAX_SHARED_RUN} words; six-word sequences shared at most ${(MAX_SIX_GRAM_SHARE * 100).toFixed(0)}%.\n`);
let failed = 0;
for (const relativePath of installed) {
  const result = compareOriginality(read(relativePath), read(officialReferencePath(relativePath)));
  if (!result.passes) failed += 1;
  console.log(`${result.passes ? "PASS" : "FAIL"}  ${relativePath}`);
  const run = result.sharedRun.length > 24 ? `${result.sharedRun.slice(0, 24).join(" ")} …` : result.sharedRun.join(" ");
  console.log(`      longest shared run: ${result.sharedRun.length} words — "${run}"`);
  console.log(`      six-word sequences shared: ${(result.sixGramShare * 100).toFixed(2)}%`);
}
const skipped = OFFICIAL_REFERENCE_FILES.length - installed.length;
if (skipped > 0) console.log(`\n${skipped} file(s) have no official copy installed and were not compared.`);
if (failed > 0) {
  console.error(`\n${failed} shipped file(s) share too much wording with ETS's text. Restructure them; do not swap synonyms.`);
  process.exit(1);
}
