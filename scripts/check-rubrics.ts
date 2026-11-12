/**
 * `npm run rubrics:check` — which copy of each rubric and sample file scoring reads, and whether an
 * installed official copy is complete.
 *
 * For each of the four rubrics and two sample files, an installed `references/official/<same name>`
 * replaces the shipped file (server/src/services/skillReferences.ts; docs/official-rubrics.md). This
 * prints which one each resolves to and checks it: every band from 5 to 0 with text under it, and
 * every Judge dimension described (a sample file must anchor both of its Task Types). A copy that
 * fails is still the one scoring reads — the rule is existence, because the Claude CLI applies it by
 * reading files and cannot run a check — so a bad paste has to fail here, loudly, instead.
 *
 * Exits 1 when any file has a problem. Spends nothing and needs no .env.
 */
import { referenceSources, rubricsSource } from "../server/src/services/skillReferences.js";

const entries = referenceSources();
let problems = 0;
for (const entry of entries) {
  const where = entry.source === "official" ? `official copy, ${entry.resolvedPath}` : "shipped file (this project's own text)";
  console.log(`${entry.problems.length === 0 ? "ok  " : "FAIL"}  ${entry.relativePath}`);
  console.log(`      reads: ${where}`);
  for (const problem of entry.problems) console.log(`      problem: ${problem}`);
  problems += entry.problems.length;
}

const source = rubricsSource();
console.log(`\nGET /api/setup-status reports rubrics.source = "${source}".`);
if (source === "rewritten" && entries.some((entry) => entry.source === "official")) {
  console.log(
    "Scoring reads every installed official copy above in place of its shipped file, whether or not it\n" +
      "passed; \"official\" is reported only when all four rubrics are installed and pass. See\n" +
      "docs/official-rubrics.md.",
  );
}
if (problems > 0) {
  console.error(`\n${problems} problem(s) found. Fix the file(s) above, or remove an incomplete official copy.`);
  process.exit(1);
}
