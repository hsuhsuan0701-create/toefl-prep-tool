/**
 * Refill the EXISTING complete Reading Set bank, not a second question database.
 * Uses original schemas, C-test gap derivation, module difficulty and novelty
 * comparators. The original multi-round Claude/Codex verifier is Node-only;
 * this Cloudflare pipeline instead rejects any failed independent AI check.
 * No generated candidate is published before ALL gates pass.
 */
import {
  ReadingGenerationInputSchema, ReadingSetSchema,
  READING_MODULE_COMPOSITION, READING_MODULE_TIME_LIMITS_SEC,
  type ReadingModule, type ReadingSet,
} from "@toefl-prep/shared";
import { deriveCtwGaps } from "../../server/src/services/ctest.js";
import {
  compareReadingModuleDifficulty, readingModuleBandVerdict,
} from "../../server/src/services/moduleDifficulty.js";
import { entriesFromSet, compareCatalogEntries } from "../../server/src/services/generationCatalog.js";
import { indexDeterministicItems } from "../../server/src/services/deterministicScoring.js";
import { referencesOptionByPosition, wordCount } from "../../server/src/services/optionQuality.js";
import { geminiJson } from "./geminiJson.js";

export interface RefillEnv {
  DB: D1Database;
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  AI_READING_REFILL_ENABLED?: string;
}
export const MIN_UNATTEMPTED_READING_SETS = 3;
export type RefillOutcome = {
  result: "disabled" | "missing-key" | "already-attempted" | "skipped" | "published" | "failed";
  unused: number | null;
  setId?: string;
  reason?: string;
};
const moduleNames = ["router", "lowerModule", "upperModule"] as const;
type ModuleName = typeof moduleNames[number];
const CJK = /[\u3400-\u9fff]/u;
const normalize = (value: string): string => value.normalize("NFKC").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu," ").trim();
const overlap = (a: Set<string>, b: Set<string>): number => {
  let same=0;
  for (const word of a) if (b.has(word)) same++;
  return same/(a.size+b.size-same||1);
};
const words = (v:string) => normalize(v).split(/\s+/).filter(Boolean);
const shingles = (v:string) => {
  const w=words(v); const set=new Set<string>();
  for(let i=0;i+5<=w.length;i++) set.add(w.slice(i,i+5).join(" "));
  return set;
};
export function unusedSetCountSQL(): string {
  // Same definition as GET /api/sets: a set is attempted after at least
  // one scored response; an empty/unanswered start is not counted.
  return "SELECT COUNT(*) AS n FROM reading_sets s WHERE NOT EXISTS ("+
    "SELECT 1 FROM attempts a WHERE a.kind='reading' AND a.set_id=s.id AND EXISTS ("+
    "SELECT 1 FROM item_results i WHERE i.attempt_id=a.id AND i.scoring_status='scored'))";
}
export async function unusedReadingSets(db: D1Database): Promise<number> {
  const row=await db.prepare(unusedSetCountSQL()).first<{n:number}>();
  return row?.n ?? 0;
}
async function existingSets(db: D1Database): Promise<ReadingSet[]> {
  const rows=await db.prepare(
    "SELECT content_json FROM reading_sets ORDER BY created_at DESC,id DESC LIMIT 150"
  ).all<{content_json:string}>();
  return rows.results.map(r=>ReadingSetSchema.parse(JSON.parse(r.content_json)));
}
function modulePrompt(name:ModuleName, prior: readonly ReadingSet[], prefix:string):string {
  const count=READING_MODULE_COMPOSITION[name], seconds=READING_MODULE_TIME_LIMITS_SEC[name];
  const titles=prior.flatMap(set=>moduleNames.flatMap(m=>set[m].academic.map(p=>p.title))).slice(0,65);
  const already=prior.flatMap(set=>moduleNames.flatMap(m=>set[m].ctwPassages.map(p=>p.topic))).slice(0,35);
  return [
    "Create ONE ORIGINAL 2026-style TOEFL Reading MODULE as a strict JSON object. Do not copy ETS items or any published passage.",
    "Module: "+name+"; timeLimitSec MUST be "+seconds+".",
    "Return exactly "+count.ctw+" ctwPassages, "+count.dailyLife+" dailyLife, "+count.academic+" academic.",
    "The JSON has exactly these keys: timeLimitSec,ctwPassages,dailyLife,academic.",
    "Each ctwPassages item has ONLY id,taskType='complete_words',topic,sourceParagraph.",
    "The ctw sourceParagraph contains 70–100 English words; sentence one is complete; after it are at least 25 multi-letter tokens. Do not manually create gaps: the server derives the exact 10 C-test gaps.",
    "Each dailyLife item has id,taskType='daily_life',genre,text,questions (2 or 3); the text is 35–120 words, such as a campus notice, message exchange, schedule or practical policy.",
    "Each academic item has id,taskType='academic_passage',title,discipline,text,questions (exactly 5); the text is 175–235 words of original academically accurate prose.",
    "Every MCQ must have id,stem,skill,options (exactly four objects with id A/B/C/D and text),correctOptionId,explanationZh (30–140 Traditional Chinese characters).",
    "Allowed skill tags: main_idea,detail,inference,vocabulary,purpose,organization,figurative_language,grammatical_complexity,rhetorical_structure.",
    "Each academic passage has distinct main_idea,detail,inference,vocabulary,purpose skills. An inference must NOT simply restate one sentence.",
    "The sole correct answer must be textually defensible. Three wrong choices should be plausible, not absurd. Never mention option letters or ordinal positions in explanations.",
    "Topic coverage: different subjects for every passage and text, and different concrete premises from the prior bank.",
    "Avoid disputed scientific claims presented as settled fact. Qualify uncertainty when appropriate.",
    "Use unique IDs for all passages/questions with prefix "+prefix+"- and each id max 64 characters.",
    "Upper module should be clearly more challenging in vocabulary and conceptual connections than Lower.",
    "Past academic titles to AVOID: "+JSON.stringify(titles),
    "Past C-test topics to AVOID: "+JSON.stringify(already),
    "Return only a well-formed JSON object, no code fences."
  ].join("\n");
}
async function buildModule(
  key:string,model:string,name:ModuleName,prior:readonly ReadingSet[],prefix:string,
  doFetch:typeof fetch
):Promise<ReadingModule> {
  const parsed = await geminiJson(key,model,modulePrompt(name,prior,prefix),
    value=>ReadingGenerationInputSchema.shape[name].parse(value),
    doFetch,{maxOutputTokens:16000});
  const ctwPassages:ReadingModule["ctwPassages"]=[];
  for(const passage of parsed.ctwPassages) {
    const derived=deriveCtwGaps(passage.id,passage.sourceParagraph);
    const explanationPrompt=[
      "Explain exactly these TEN English C-test word completions in Traditional Chinese.",
      "Return ONLY JSON with key explanations: array of 10 objects {gapId, explanationZh}.",
      "Each explanation is 30–140 Traditional Chinese characters and describes the actual grammar or context; do not name option positions.",
      "Text: "+passage.sourceParagraph,
      "Gaps: "+JSON.stringify(derived.gaps.map(g=>({gapId:g.id,wholeWord:g.prefix+g.completion}))),
    ].join("\n");
    const explained=await geminiJson(key,model,explanationPrompt,value=>{
      if(!value||typeof value!=="object"||!Array.isArray((value as {explanations?:unknown}).explanations))
        throw Error("Invalid explanations");
      const rows=(value as {explanations:Array<{gapId?:string;explanationZh?:string}>}).explanations;
      if(rows.length!==10) throw Error("Wrong explanation count");
      const map=new Map(rows.map(x=>[x.gapId,x.explanationZh]));
      if(map.size!==10||derived.gaps.some(g=>typeof map.get(g.id)!=="string"))throw Error("Missing explanation");
      return map as Map<string,string>;
    },doFetch,{maxOutputTokens:3500});
    ctwPassages.push({
      id:passage.id,taskType:"complete_words",topic:passage.topic,
      sourceParagraph:passage.sourceParagraph,segments:derived.segments,
      gaps:derived.gaps.map(g=>({...g,explanationZh:explained.get(g.id)!}))
    });
  }
  return {timeLimitSec:parsed.timeLimitSec,ctwPassages,dailyLife:parsed.dailyLife,academic:parsed.academic};
}
function allParts(set:ReadingSet) {
  return moduleNames.flatMap(m=>[
    ...set[m].ctwPassages.map(p=>({title:p.topic,text:p.sourceParagraph,task:"ctw"})),
    ...set[m].dailyLife.map(p=>({title:p.genre,text:p.text,task:"daily"})),
    ...set[m].academic.map(p=>({title:p.title,text:p.text,task:"academic"})),
  ]);
}
export function checkReadingQuality(set:ReadingSet,previous:readonly ReadingSet[]):void {
  // The original schema and scoring index are authoritative; no alternative IDs
  // or scoring conventions are invented for the new questions.
  ReadingSetSchema.parse(set);
  indexDeterministicItems(set);
  for (const name of moduleNames) {
    const mod=set[name], expected=READING_MODULE_COMPOSITION[name];
    if(mod.ctwPassages.length!==expected.ctw||mod.dailyLife.length!==expected.dailyLife||
       mod.academic.length!==expected.academic) throw Error("Unexpected module composition");
    const band=readingModuleBandVerdict(name,mod);
    if(!band||band.placement!=="in-band") throw Error("Module reading difficulty outside target band");
    for(const p of mod.ctwPassages) {
      if(wordCount(p.sourceParagraph)<70||wordCount(p.sourceParagraph)>100)throw Error("C-test paragraph length out of range");
      const rederived=deriveCtwGaps(p.id,p.sourceParagraph);
      if(JSON.stringify(rederived.segments)!==JSON.stringify(p.segments)||
         p.gaps.length!==10||p.gaps.some((g,i)=>g.id!==rederived.gaps[i].id||
          g.prefix!==rederived.gaps[i].prefix||g.completion!==rederived.gaps[i].completion))
        throw Error("C-test gaps disagree with the original derivation");
      for(const g of p.gaps) if(!CJK.test(g.explanationZh)||[...g.explanationZh].length<25||
         [...g.explanationZh].length>200)throw Error("C-test explanation invalid");
    }
    for(const p of mod.dailyLife) {
      if(wordCount(p.text)<15||wordCount(p.text)>150)throw Error("Daily Life length invalid");
    }
    for(const p of mod.academic) {
      if(wordCount(p.text)<150||wordCount(p.text)>250)throw Error("Academic passage length invalid");
      const skills=p.questions.map(q=>q.skill);
      if(!["main_idea","detail","inference","vocabulary","purpose"].every(tag=>skills.includes(tag)))
        throw Error("Academic skill coverage missing");
    }
    for(const p of [...mod.dailyLife,...mod.academic]) for(const q of p.questions) {
      if(q.options.length!==4||new Set(q.options.map(o=>normalize(o.text))).size!==4)
        throw Error("MCQ options invalid");
      if(new Set(q.options.map(o=>o.id)).size!==4||
         !q.options.some(o=>o.id===q.correctOptionId))throw Error("MCQ key invalid");
      if(!CJK.test(q.explanationZh)||[...q.explanationZh].length<25||
         [...q.explanationZh].length>200||referencesOptionByPosition(q.explanationZh))
        throw Error("MCQ explanation invalid");
    }
  }
  const relative=compareReadingModuleDifficulty(set);
  if(!relative.upperIsHarder)throw Error("Upper module is not more difficult than Lower");
  // Original repository's catalog comparator across each stimulus kind.
  const candidateEntries=entriesFromSet(set);
  const priorEntries=previous.flatMap(s=>entriesFromSet(s));
  for(const entry of candidateEntries) for(const older of priorEntries) {
    if(compareCatalogEntries(entry,older).length)throw Error("Reading content duplicates an earlier Set");
  }
  // Separate literal/shingle guard catches passages copied from a prior Set,
  // including those whose catalog descriptor has a different normalized title.
  const candidates=allParts(set),old=previous.flatMap(allParts);
  const within=[...old,...candidates];
  for(let i=0;i<within.length;i++)for(let j=i+1;j<within.length;j++) {
    if(i<old.length&&j<old.length)continue;
    const a=within[i],b=within[j];
    if(a.task!==b.task)continue;
    if(normalize(a.title)===normalize(b.title)||
      (overlap(new Set(words(a.title)),new Set(words(b.title)))>=.83&&words(a.title).length>=3)||
      overlap(shingles(a.text),shingles(b.text))>=.35)
      throw Error("Repeated passage or near-duplicate content");
  }
}
/** Independent full-module review. Only unequivocal passes publish. */
async function reviewModule(key:string,model:string,name:ModuleName,set:ReadingSet,doFetch:typeof fetch):Promise<void> {
  const mod=set[name];
  const content={
    ctwPassages:mod.ctwPassages.map(p=>({id:p.id,sourceParagraph:p.sourceParagraph,
      gaps:p.gaps.map(g=>({id:g.id,wholeWord:g.prefix+g.completion,explanationZh:g.explanationZh}))})),
    dailyLife:mod.dailyLife,
    academic:mod.academic
  };
  const verdict=await geminiJson(key,model,[
    "Act as an INDEPENDENT STRICT TOEFL Reading examiner. Audit the complete module below.",
    "Do NOT automatically approve. Check every C-test gap's only plausible completion, all MCQ keys against the passage, plausible distractors, correct inference classification, traditional Chinese explanations, and factual accuracy.",
    "Check the passages for questionable scientific assertions or internal inconsistency. Treat uncertainty without a trustworthy source as a reason to fail.",
    "Return ONLY JSON: {passed:boolean,issues:[{id:string,reason:string}]}.",
    "passed may be true ONLY if EVERY item is supported and not ambiguous. issues MUST be [] on pass.",
    "Audit input: "+JSON.stringify(content)
  ].join("\n"),value=>{
    if(!value||typeof value!=="object")throw Error("Invalid review");
    const v=value as {passed?:unknown;issues?:unknown};
    if(typeof v.passed!=="boolean"||!Array.isArray(v.issues)||v.issues.length>100)throw Error("Invalid review");
    if(v.issues.some(x=>!x||typeof x!=="object"||typeof x.id!=="string"||
       typeof x.reason!=="string"))throw Error("Invalid review issues");
    return {passed:v.passed,issues:v.issues as Array<{id:string;reason:string}>};
  },doFetch,{maxOutputTokens:2800,temperature:0.15});
  if(!verdict.passed||verdict.issues.length>0)throw Error("AI quality review rejected "+name);
}
export async function produceFullReadingSet(
  env:RefillEnv,prior:readonly ReadingSet[],doFetch:typeof fetch=fetch
):Promise<ReadingSet> {
  const key=env.GEMINI_API_KEY;
  if(!key)throw Error("Gemini key is missing");
  const model=env.GEMINI_MODEL||"gemini-3.1-flash-lite";
  const id="rd-"+crypto.randomUUID().replace(/-/g,"").slice(0,12);
  const prefix=id.slice(3,11);
  const modules={} as Record<ModuleName,ReadingModule>;
  for(const name of moduleNames)modules[name]=await buildModule(key,model,name,prior,prefix+"-"+name.slice(0,2),doFetch);
  const candidate=ReadingSetSchema.parse({
    id,source:"generated",kind:"reading",createdAt:new Date().toISOString(),
    router:modules.router,lowerModule:modules.lowerModule,upperModule:modules.upperModule
  });
  checkReadingQuality(candidate,prior);
  // Fail closed on all independently reviewed modules. No repair loop and no
  // forced acceptance: this costs less than replacing an ambiguous published Set.
  for(const name of moduleNames)await reviewModule(key,model,name,candidate,doFetch);
  return candidate;
}
async function finish(db:D1Database,day:string,status:string,setId:string|null,reason:string|null):Promise<void> {
  await db.prepare(
    "UPDATE reading_refill_runs SET status=?,new_set_id=?,error_code=?,finished_at=datetime('now') WHERE day=?"
  ).bind(status,setId,reason,day).run();
}
export async function refillReadingBank(
  env:RefillEnv,time:number,doFetch:typeof fetch=fetch,
  opts:{manual?:boolean;produce?:typeof produceFullReadingSet}={}
):Promise<RefillOutcome> {
  if(env.AI_READING_REFILL_ENABLED!=="true"&&!opts.manual)return {result:"disabled",unused:null};
  if(!env.GEMINI_API_KEY)return {result:"missing-key",unused:null};
  const day=new Date(time).toISOString().slice(0,10);
  let unused:number|null=null;
  try {
    unused=await unusedReadingSets(env.DB);
    if(unused>=MIN_UNATTEMPTED_READING_SETS)return {result:"skipped",unused};
    const claim=await env.DB.prepare(
      "INSERT OR IGNORE INTO reading_refill_runs(day,status,unused_sets_at_start) VALUES (?,'started',?)"
    ).bind(day,unused).run();
    if(claim.meta.changes!==1)return {result:"already-attempted",unused};
    try {
      const previous=await existingSets(env.DB);
      const produce=opts.produce??produceFullReadingSet;
      const set=await produce(env,previous,doFetch);
      // Always validate even when injected tests provide an output.
      checkReadingQuality(set,previous);
      // Prevent duplicate IDs and concurrent refill/import races.
      const save=await env.DB.prepare(
        "INSERT OR IGNORE INTO reading_sets(id,content_json) VALUES(?,?)"
      ).bind(set.id,JSON.stringify(set)).run();
      if(save.meta.changes!==1)throw Error("Set ID already exists");
      await finish(env.DB,day,"published",set.id,null);
      return {result:"published",unused,setId:set.id};
    } catch(e) {
      const reason=e instanceof Error?e.message:"Unknown";
      const safe=/Gemini HTTP \d+/.exec(reason)?.[0] ??
        (/duplicate|repeated/i.test(reason)?"duplicate-content":
         /quality|review/i.test(reason)?"quality-review-failed":
         /schema|validation|gaps|difficulty|options|composition|length|coverage/i.test(reason)?"content-validation-failed":
         "generation-failed");
      await finish(env.DB,day,"failed",null,safe);
      return {result:"failed",unused,reason:safe};
    }
  } catch {
    return {result:"failed",unused,reason:"database-unavailable"};
  }
}
