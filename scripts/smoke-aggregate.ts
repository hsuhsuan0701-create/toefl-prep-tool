/**
 * Calibration smoke test for the Arbiter alone: runs one `AGGREGATE` skill call on an ETS
 * calibration fixture, with made-up Judge evidence, and reports how far the Arbiter's own score
 * (`ownScore`) lands from ETS's official score. Passes within 0.5. Not part of `npm test`.
 *
 * The fixtures are ETS's officially scored samples, which are not in the public repository
 * (docs/official-rubrics.md); the script stops before any call when the one named is missing.
 *
 * Runs through the production skill-task route (runSkillTask): the Claude CLI, then the Codex CLI.
 * Needs one of them signed in and spends one call of its quota; no API key and no running server.
 *
 * Usage, from the repo root:
 *   npx tsx --env-file=.env scripts/smoke-aggregate.ts server/test/fixtures/ets-samples/discussion-5-1.json
 *
 * Optional second argument: a JSON object overriding partB's Judge scores, e.g.
 *   npx tsx --env-file=.env scripts/smoke-aggregate.ts <fixture> '{"gemini":4,"openai":3.5}'
 * By default partB is derived from the fixture (`{gemini: officialScore, openai: officialScore -
 * 0.5}`), so a run where ownScore equals officialScore is equally consistent with the Arbiter
 * copying Gemini's partB score instead of scoring from partA. An override that disagrees with
 * officialScore separates the two: it shows whether the Arbiter's own score follows the rubric
 * anchors or partB.
 */
import fs from "node:fs";
import { ArbitrationReasoningSchema } from "../server/src/services/arbiter.js";
import { toProviderJsonSchema } from "../server/src/services/reasoning/jsonSchema.js";
import { runSkillTask } from "../server/src/services/reasoning/router.js";
import { requireEtsMaterial } from "./lib/etsLocal.js";

const SKILL_BY_TASK = {
  listen_repeat: "toefl-speaking",
  interview: "toefl-speaking",
  email: "toefl-writing",
  discussion: "toefl-writing",
} as const;

type TaskType = keyof typeof SKILL_BY_TASK;

const fixturePath = process.argv[2];
if (!fixturePath) {
  console.error(
    "usage: npx tsx --env-file=.env scripts/smoke-aggregate.ts <fixture.json> ['{\"gemini\":4,\"openai\":3.5}']",
  );
  process.exit(2);
}
requireEtsMaterial([fixturePath]);

const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as {
  taskType: TaskType;
  materials: object;
  responseText: string;
  officialScore: number;
  scoringComment: string;
};

const skill = SKILL_BY_TASK[fixture.taskType];
if (!skill) throw new Error(`unknown taskType: ${fixture.taskType}`);

const partBOverrideArg = process.argv[3];
let partBOverride: { gemini: number; openai: number } | undefined;
if (partBOverrideArg) {
  const parsed = JSON.parse(partBOverrideArg);
  if (typeof parsed.gemini !== "number" || typeof parsed.openai !== "number") {
    throw new Error(`partB override must be {"gemini": number, "openai": number}, got: ${partBOverrideArg}`);
  }
  partBOverride = parsed;
}

const itemId = "item-1";

// Judge evidence is deliberately generic and score-free: partA must never leak a number.
const evidenceByTask: Record<TaskType, [string, string]> = {
  listen_repeat: [
    "Transcript aligns with the prompt; no omitted or substituted content words detected.",
    "Repetition appears complete; delivery steady with no audible struggle over words.",
  ],
  interview: [
    "Answers the question with concrete detail; frequent fillers but meaning stays clear.",
    "On topic with relevant elaboration; some hesitation and minor agreement slips.",
  ],
  email: [
    "Covers the required points and the register is appropriate; some spelling errors.",
    "Communicative purpose achieved; one verb phrase is hard to parse.",
  ],
  discussion: [
    "Addresses the question with limited elaboration; several agreement errors.",
    "Relevant contribution; word-choice imprecision; some awkward phrasing.",
  ],
};

const payload = {
  partA: {
    taskType: fixture.taskType,
    itemId,
    materials: fixture.materials,
    responseText: fixture.responseText,
    judges: [
      { judge: "gemini", evidence: evidenceByTask[fixture.taskType][0], deductions: [] },
      { judge: "openai", evidence: evidenceByTask[fixture.taskType][1], deductions: [] },
    ],
  },
  partB: {
    scores: [
      { judge: "gemini", itemScore: partBOverride ? partBOverride.gemini : fixture.officialScore },
      { judge: "openai", itemScore: partBOverride ? partBOverride.openai : fixture.officialScore - 0.5 },
    ],
  },
};

const prompt = `/${skill}
AGGREGATE ${fixture.taskType}

Score the single item with itemId "${itemId}". Set taskType to "${fixture.taskType}".

\`\`\`json
${JSON.stringify(payload, null, 2)}
\`\`\``;

const started = Date.now();
const res = await runSkillTask({
  task: { task: "aggregate", context: fixture.taskType },
  prompt,
  // The schema production arbitration sends (arbiter.ts), rewritten as every structured reasoning
  // call's schema is, into the form both CLIs accept (reasoning/jsonSchema.ts).
  jsonSchema: toProviderJsonSchema(ArbitrationReasoningSchema),
  parse: (value) => ArbitrationReasoningSchema.parse(value),
});
if (!res.ok) {
  console.error("runSkillTask failed:", res.error);
  console.error("attempts:", res.attempts);
  process.exit(1);
}

const report = res.value;
const item = report.items[0];
console.log(JSON.stringify(item, null, 2));

const delta = Math.abs(item.ownScore - fixture.officialScore);
console.log(
  `\nfixture: ${fixturePath.split("/").pop()}  (${Math.round((Date.now() - started) / 1000)}s)`,
);
console.log("official:", fixture.officialScore, "own:", item.ownScore, "final:", item.finalScore);
console.log(`|own - official| = ${delta}  ->  ${delta <= 0.5 ? "PASS (within +/-0.5)" : "FAIL"}`);
if (delta > 0.5) process.exit(1);
