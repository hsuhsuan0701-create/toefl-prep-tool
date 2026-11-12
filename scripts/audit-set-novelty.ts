// Prints every overlap between Sets in the bank, using the same Catalog comparison generation uses
// (server/src/services/noveltyAudit.ts). Reads files only. Exits 1 when it finds any overlap, unless
// --allow-existing is given.
//
//   npm run audit:novelty -- [--allow-existing]
import { config } from "../server/src/lib/config.js";
import { runNoveltyAudit } from "../server/src/services/noveltyAudit.js";

const args = process.argv.slice(2);
if (args.some((argument) => argument !== "--allow-existing")) {
  console.error("usage: npm run audit:novelty -- [--allow-existing]");
  process.exitCode = 2;
} else {
  const result = runNoveltyAudit({
    dataDir: config.dataDir,
    allowExisting: args.includes("--allow-existing"),
  });
  for (const line of result.lines) console.log(line);
  process.exitCode = result.exitCode;
}
