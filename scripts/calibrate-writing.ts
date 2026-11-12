/**
 * Full-pipeline Writing calibration: runs each of ETS's two officially scored Writing samples
 * through the real attempts API (POST /api/attempts for a Drill Attempt on ETS's sample Writing
 * Set, wri-703ea6d7; POST /api/attempts/:id/score with the sample's text; then polls the scoring
 * job) and compares the final score with ETS's official one. Nothing is mocked: the server runs its
 * Gemini and OpenAI Judges and its Arbiter (server/src/services/scoreItems.ts).
 *
 * ETS's material is not in the public repository (docs/official-rubrics.md). This script reads the
 * two scored samples from server/test/fixtures/ets-samples/, and the running server must serve the
 * ETS Set; both stay on the machine of whoever holds them, ignored by git. The script stops before
 * creating anything when either is missing.
 *
 * The fixture's own "materials" are not sent: the scorer reads the task from the Set
 * (set.email / set.academicDiscussion) and checks the request's itemId against that Set's item id.
 * So the script sends the Set's item id ("email-1" / "disc-1") with the fixture's responseText.
 * That is calibration only while the Set holds the same ETS task as the fixture, which the script
 * does not check.
 *
 * The rubric text scored against is whichever copy the server resolves (the shipped rewrite, or an
 * installed official copy); the script prints which, from GET /api/setup-status, before it starts.
 *
 * Needs a running server (`npm start` or `npm run dev`; CALIBRATE_BASE_URL, or PORT, replaces
 * http://localhost:8787) with its own keys and Claude and Codex CLIs. This process calls no model
 * itself; it leaves two Writing Drill Attempts in the server's database and names them when it ends.
 *
 * Cost, paid by the server: per sample, 2 Judge calls and 1 Arbiter call.
 *
 * Usage, from the repo root:
 *   npx tsx --env-file=.env scripts/calibrate-writing.ts
 *
 * Exits 2 if ETS's material is missing, 1 if either sample's |finalScore - officialScore| > 1.0.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ETS_WRITING_SET_ID,
  etsFixturePath,
  etsSetPath,
  missingEtsMaterialMessage,
  requireEtsMaterial,
} from "./lib/etsLocal.js";
import {
  parseAcceptedScoringJob,
  parseEssayScoreResult,
  pollScoringJobResult,
  type EssayScoreResponse,
} from "./lib/scoringJob.js";

const BASE_URL = process.env.CALIBRATE_BASE_URL ?? `http://localhost:${process.env.PORT ?? 8787}`;
const SET_ID = ETS_WRITING_SET_ID;
const TARGET_DELTA = 0.5;
const HARD_BOUND_DELTA = 1.0;

type TaskType = "email" | "discussion";

type Fixture = {
  taskType: TaskType;
  materials: unknown;
  responseText: string;
  officialScore: number;
  scoringComment: string;
};

// Maps each fixture's taskType to the matching item id on the ETS Set (its `email.id` /
// `academicDiscussion.id`).
const SET_ITEM_ID: Record<TaskType, string> = {
  email: "email-1",
  discussion: "disc-1",
};

const FIXTURES = ["email-4-1.json", "discussion-5-1.json"].map(etsFixturePath);

// The Set is checked on the running server instead (preflight), which may read another data directory.
requireEtsMaterial(FIXTURES);

async function preflight(): Promise<void> {
  const set = await fetch(`${BASE_URL}/api/sets/${SET_ID}`);
  if (set.status === 404) {
    console.error(missingEtsMaterialMessage([`${etsSetPath("writing", SET_ID)} (the running server does not serve it)`]));
    process.exit(2);
  }
  if (!set.ok) throw new Error(`GET /api/sets/${SET_ID} failed: ${set.status}`);
  const status = (await (await fetch(`${BASE_URL}/api/setup-status`)).json()) as { rubrics?: { source?: string } };
  console.log(`rubric source the server scores with: ${status.rubrics?.source ?? "unknown"}`);
}

// Every Attempt this run creates stays in the server's database; the run names them when it ends.
const attemptsCreated: string[] = [];

async function createAttempt(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/attempts`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: "writing", mode: "drill", setId: SET_ID }),
  });
  if (!res.ok) throw new Error(`POST /api/attempts failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { attemptId: string; isRepeat: boolean };
  attemptsCreated.push(body.attemptId);
  return body.attemptId;
}

function reportAttemptsLeft(): void {
  if (attemptsCreated.length === 0) return;
  console.log(
    `\nThis run left ${attemptsCreated.length} Writing Drill Attempt(s) on ${SET_ID} in the server's database, ` +
      `where they show in your Attempt history: ${attemptsCreated.join(", ")}`,
  );
}

async function scoreAttempt(attemptId: string, taskType: TaskType, itemId: string, text: string): Promise<EssayScoreResponse> {
  const res = await fetch(`${BASE_URL}/api/attempts/${attemptId}/score`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      taskType,
      items: [{ itemId, text, secondsUsed: 200 }],
    }),
  });
  if (!res.ok) throw new Error(`POST /api/attempts/${attemptId}/score failed: ${res.status} ${await res.text()}`);
  const jobId = parseAcceptedScoringJob(res.status, await res.json());
  console.log(`scoring job ${jobId}; polling up to 10 minutes...`);
  return pollScoringJobResult(BASE_URL, attemptId, jobId, parseEssayScoreResult);
}

async function runFixture(fixturePath: string): Promise<{ fixturePath: string; delta: number; pass: boolean }> {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as Fixture;
  const itemId = SET_ITEM_ID[fixture.taskType];

  console.log(`\n=== ${path.basename(fixturePath)} (${fixture.taskType}) ===`);
  console.log(
    `NOTE: materials shown to judges are the ETS Set's (${SET_ID}, item "${itemId}"); ` +
      `the response TEXT posted is the fixture's responseText.`,
  );

  const attemptId = await createAttempt();
  console.log(`attempt: ${attemptId}`);

  const started = Date.now();
  const result = await scoreAttempt(attemptId, fixture.taskType, itemId, fixture.responseText);
  const elapsedSec = Math.round((Date.now() - started) / 1000);

  const item = result.report.items[0];
  const delta = Math.abs(item.finalScore - fixture.officialScore);

  console.log(`official score:    ${fixture.officialScore}`);
  console.log(`official comment:  ${fixture.scoringComment}`);
  for (const j of result.judges) console.log(`judge ${j.judge}:${" ".repeat(Math.max(1, 8 - j.judge.length))}${j.score}`);
  if (result.judgesFailed.length > 0) console.log(`judges failed:     ${result.judgesFailed.join(", ")}`);
  console.log(`ownScore:          ${item.ownScore}`);
  console.log(`finalScore:        ${item.finalScore}`);
  console.log(`singleJudge:       ${item.singleJudge ?? false}`);
  console.log(`lowConfidence:     ${item.lowConfidence ?? false}`);
  console.log(`reconciliationNote: ${item.reconciliationNote}`);
  if (item.deductions.length > 0) {
    console.log(`deductions:`);
    for (const d of item.deductions) console.log(`  - [${d.category}] "${d.quote}" -> ${d.issue} (fix: ${d.fix})`);
  } else {
    console.log(`deductions:        (none)`);
  }
  console.log(`|final - official| = ${delta}  (elapsed ${elapsedSec}s)`);
  const pass = delta <= HARD_BOUND_DELTA;
  console.log(
    delta <= TARGET_DELTA
      ? `-> PASS (within target +/-${TARGET_DELTA})`
      : pass
        ? `-> PASS (within hard bound +/-${HARD_BOUND_DELTA}, outside target +/-${TARGET_DELTA})`
        : `-> FAIL (exceeds hard bound +/-${HARD_BOUND_DELTA})`,
  );

  return { fixturePath, delta, pass };
}

await preflight();
const results = [];
try {
  for (const fixturePath of FIXTURES) {
    results.push(await runFixture(fixturePath));
  }
} catch (error) {
  reportAttemptsLeft();
  throw error;
}

console.log(`\n=== summary ===`);
for (const r of results) {
  console.log(`${path.basename(r.fixturePath)}: delta=${r.delta} ${r.pass ? "PASS" : "FAIL"}`);
}
reportAttemptsLeft();

const anyFail = results.some((r) => !r.pass);
if (anyFail) {
  console.error(`\nFAIL: at least one fixture exceeded the hard bound of +/-${HARD_BOUND_DELTA}`);
  process.exit(1);
}
console.log(`\nAll fixtures within +/-${HARD_BOUND_DELTA} hard bound.`);
