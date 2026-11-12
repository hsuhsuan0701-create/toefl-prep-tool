// Turns material in a text file into a Speaking or Writing Set (`source: "imported"`) and publishes
// it through the same path as a generated Set. Needs no running server.
//
// Needs the Claude CLI or the Codex CLI signed in for the import call (and a Writing Set's Build a
// Sentence verification); a Speaking import also needs GEMINI_API_KEY for TTS and OPENAI_API_KEY
// for its scene image. Spends CLI quota, plus paid TTS calls and a paid image for Speaking. Writes
// into the data directory (TOEFL_DATA_DIR, or data/).
//
//   npx tsx --env-file=.env scripts/import-set.ts speaking|writing <textfile>
import fs from "node:fs";
import { openDb } from "../server/src/db/db.js";
import { createSqliteStores } from "../server/src/db/stores/index.js";
import {
  createRepoClipMeasurementSink,
  setClipMeasurementSink,
} from "../server/src/services/clipMeasurementLog.js";
import {
  createRepoModelCallSink,
  setModelCallSink,
} from "../server/src/services/modelCallLog.js";
import { importSet } from "../server/src/services/generator.js";

const [kind, file] = [process.argv[2], process.argv[3]];
if ((kind !== "speaking" && kind !== "writing") || !file) throw new Error("usage: import-set.ts speaking|writing <textfile>");

// Installs the server's two diagnostic sinks before importing, for the reasons and in the order
// generate-set.ts gives: the import's model call writes diagnostic rows (ADR 0004), and a Speaking
// import renders its thirteen clips through the same renderer generation uses.
const stores = createSqliteStores(openDb());
setModelCallSink(createRepoModelCallSink(stores.diagnostics));
setClipMeasurementSink(createRepoClipMeasurementSink(stores.clipMeasurements));

const { setId } = await importSet(kind, fs.readFileSync(file, "utf8"));
console.log("imported", setId);
