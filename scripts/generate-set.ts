// Generates one Set of the given kind and publishes it to the bank, with the same generateSet that
// a POST /api/generate job runs, but in this process and with no job row. Needs no running server.
//
// Needs the Claude CLI or the Codex CLI signed in (plan, generate and verify run Claude, then
// Codex). Speaking and Listening also need GEMINI_API_KEY in .env for TTS, and Speaking
// OPENAI_API_KEY for its scene image (checked by Gemini). Spends CLI quota on every run, plus paid
// TTS calls for Speaking and Listening and a paid image for Speaking. Writes the Set into the data
// directory (TOEFL_DATA_DIR, or data/) and its diagnostics into that directory's db.sqlite.
//
//   npx tsx --env-file=.env scripts/generate-set.ts speaking|writing|reading|listening
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
import { generateSet } from "../server/src/services/generator.js";

const kind = process.argv[2];
if (kind !== "speaking" && kind !== "writing" && kind !== "reading" && kind !== "listening") throw new Error("usage: generate-set.ts speaking|writing|reading|listening");

// Installs the two diagnostic sinks server/src/index.ts installs. Both recorders are no-ops until a
// sink is installed, so without this a run from this script writes no model-call rows
// (`route_invocations` -> `provider_executions` -> `model_attempts`, ADR 0004) and no
// `clip_measurements`. One database handle, opened here rather than by either recorder, so the
// process has a single writer.
//
// After the argv check, so a usage mistake is a usage error rather than a database error; before
// generateSet, so no call escapes the sinks (scriptObservability.test.ts pins both). A failure to
// open the database is not caught: nothing has been paid for yet, and catching it would publish a
// Set with no diagnostics. There is no NODE_ENV guard as in index.ts, which needs one only because
// the test suite imports it.
//
// The superseded-Set reader is not installed, so this run's novelty Catalog includes retired Sets.
const stores = createSqliteStores(openDb());
setModelCallSink(createRepoModelCallSink(stores.diagnostics));
setClipMeasurementSink(createRepoClipMeasurementSink(stores.clipMeasurements));

const { setId } = await generateSet(kind);
console.log("generated", setId);
