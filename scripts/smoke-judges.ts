// Live smoke test for both essay Judges on ETS's officially scored email sample: prints each
// Judge's score beside the official one. Not part of `npm test`. The sample is ETS's and is not in
// the public repository (docs/official-rubrics.md); the script stops before any call when it is
// missing.
//
// Makes one paid Gemini call (GEMINI_API_KEY) and one OpenAI Judge call, which runs the Codex CLI
// and falls back to OpenAI HTTP (OPENAI_API_KEY). Needs no running server. From the repo root:
//   npx tsx --env-file=.env scripts/smoke-judges.ts
import fs from "node:fs";
import { judgeEssay } from "../server/src/services/judges/index.js";
import { etsFixturePath, requireEtsMaterial } from "./lib/etsLocal.js";

const fixturePath = etsFixturePath("email-4-1.json");
requireEtsMaterial([fixturePath]);
const fx = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
for (const judge of ["gemini", "openai"] as const) {
  const result = await judgeEssay(judge, { taskType: "email", materials: fx.materials, responseText: fx.responseText });
  console.log(
    judge,
    "provider:",
    result.provider,
    "score:",
    result.report.items[0].score,
    "official:",
    fx.officialScore
  );
}
