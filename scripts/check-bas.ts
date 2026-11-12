// Checks Writing Sets against the Set schema and the Build a Sentence conformance checks generation
// is held to, printing a verdict per Set: a hand-edited Set that passes here is one the pipeline
// would have accepted. With no ids, every Set in question-sets/writing/ under the data directory the
// server uses (data/, or TOEFL_DATA_DIR). Exits 1 if any fails. Reads files only.
//
//   npx tsx scripts/check-bas.ts [setId ...]
import fs from "node:fs";
import path from "node:path";
import { AnySetSchema } from "@toefl-prep/shared";
import { config } from "../server/src/lib/config.js";
import { buildASentenceViolations } from "../server/src/services/buildASentenceConformance.js";

const dir = path.join(config.dataDir, "question-sets", "writing");
const ids = process.argv.slice(2);
const targets = ids.length > 0
  ? ids
  : fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));

let bad = 0;
for (const id of targets) {
  const file = path.join(dir, `${id}.json`);
  let set;
  try {
    set = AnySetSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (err) {
    bad++;
    console.log(`${id}  SCHEMA FAIL  ${err instanceof Error ? err.message.slice(0, 300) : err}`);
    continue;
  }
  if (set.kind !== "writing") { console.log(`${id}  (not a writing set, skipped)`); continue; }
  const violations = buildASentenceViolations(set);
  const items = set.buildASentence.items;
  const framed = items.filter((i) => typeof i.frame === "string").length;
  if (violations.length === 0) {
    console.log(`${id}  OK  ${framed}/${items.length} framed  tiles=${items.map((i) => i.tiles.length).join("-")}`);
  } else {
    bad++;
    console.log(`${id}  ${violations.length} VIOLATION(S)`);
    for (const v of violations.slice(0, 12)) console.log(`    ${v.label}  ${v.kind}  ${v.detail}`);
    if (violations.length > 12) console.log(`    …and ${violations.length - 12} more`);
  }
}
process.exit(bad > 0 ? 1 : 0);
