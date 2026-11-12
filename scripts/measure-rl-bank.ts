// Measures every Reading and Listening Set in the data directory the server uses (data/, or
// TOEFL_DATA_DIR) against the current content gates by running them: it calls
// `readingContentViolations` and `listeningContentViolations`, the functions a live generation's
// content gate calls, so a retuned threshold changes the report with no edit here. Also prints each module's text difficulty and,
// for Reading, the option counts. Reads files only; spends nothing.
//
//   npx tsx scripts/measure-rl-bank.ts          # human-readable
//   npx tsx scripts/measure-rl-bank.ts --json   # machine-readable
import fs from "node:fs";
import path from "node:path";
import { readingContentViolations } from "../server/src/services/readingGenerator.js";
import { listeningContentViolations } from "../server/src/services/listeningGenerator.js";
import {
  readingModuleBandVerdict,
  textDifficulty,
  listeningModuleText,
} from "../server/src/services/moduleDifficulty.js";
import { countEnglishWords } from "../server/src/services/audioPace.js";
import { config } from "../server/src/lib/config.js";

const dataDir = path.join(config.dataDir, "question-sets");
const MODULES = ["router", "lowerModule", "upperModule"] as const;

function load(kind: "reading" | "listening"): { id: string; set: any }[] {
  const dir = path.join(dataDir, kind);
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({
    id: f.replace(/\.json$/, ""),
    set: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")),
  }));
}

const report: any = { reading: [], listening: [] };

for (const { id, set } of load("reading")) {
  let violations: any[] = [];
  try { violations = readingContentViolations(set); } catch (e) { violations = [{ kind: "THREW", detail: String(e) }]; }
  const bands = MODULES.map((m) => {
    const v = readingModuleBandVerdict(m, set[m]);
    return v && { module: m, grade: +v.difficulty.grade.toFixed(2), words: v.difficulty.words,
                  band: [v.band.min, v.band.max], placement: v.placement };
  }).filter(Boolean);
  // Every multiple-choice option count in the Set, by module.
  const optionCounts: Record<string, number[]> = {};
  for (const m of MODULES) {
    const counts: number[] = [];
    for (const dl of set[m].dailyLife ?? []) for (const q of dl.questions ?? []) counts.push(q.options.length);
    for (const ac of set[m].academic ?? []) for (const q of ac.questions ?? []) counts.push(q.options.length);
    optionCounts[m] = counts;
  }
  report.reading.push({ id, createdAt: set.createdAt, bands, optionCounts, violations });
}

for (const { id, set } of load("listening")) {
  let violations: any[] = [];
  try { violations = listeningContentViolations(set); } catch (e) { violations = [{ kind: "THREW", detail: String(e) }]; }
  const shapes: any[] = [];
  for (const m of MODULES) {
    for (const c of set[m].conversations ?? [])
      shapes.push({ module: m, kind: "conversation", id: c.id,
                    words: c.transcript.reduce((n: number, t: any) => n + countEnglishWords(t.text), 0) });
    for (const a of set[m].announcements ?? [])
      shapes.push({ module: m, kind: "announcement", id: a.id, words: countEnglishWords(a.transcript) });
    for (const t of set[m].academicTalks ?? [])
      shapes.push({ module: m, kind: "academicTalk", id: t.id, words: countEnglishWords(t.transcript) });
  }
  const fk = MODULES.map((m) => ({ module: m, grade: +textDifficulty(listeningModuleText(set[m])).grade.toFixed(2) }));
  report.listening.push({ id, createdAt: set.createdAt, fk, shapes, violations });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const kind of ["reading", "listening"] as const) {
    console.log(`\n########## ${kind.toUpperCase()} ##########`);
    for (const s of report[kind]) {
      console.log(`\n=== ${s.id}  (created ${s.createdAt})`);
      if (kind === "reading") {
        for (const b of s.bands) console.log(`  FK ${b.module}: ${b.grade} vs ${b.band[0]}-${b.band[1]} -> ${b.placement} (${b.words} words)`);
        for (const [m, c] of Object.entries(s.optionCounts)) console.log(`  options ${m}: [${(c as number[]).join(",")}]`);
      } else {
        console.log(`  FK: ${s.fk.map((f: any) => `${f.module} ${f.grade}`).join(", ")}`);
        for (const sh of s.shapes) console.log(`  ${sh.module}/${sh.kind} ${sh.id}: ${sh.words} words`);
      }
      console.log(`  violations (${s.violations.length}):`);
      for (const v of s.violations) console.log(`    - ${v.kind} ${v.label ?? ""} "${v.id ?? ""}": ${v.detail}`);
    }
  }
}
