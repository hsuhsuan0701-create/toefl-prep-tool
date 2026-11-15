/**
 * ONE original canonical Listening draft for the existing Cloudflare queue.
 * Never publishes the draft and never produces TTS; the separate daily
 * workflow can consume up to three MP3 claims only AFTER this draft exists.
 *
 * Dry run by default. --pilot --execute makes ONE Gemini TEXT request and
 * saves a single Router module locally for inspection; never sends it to D1.
 * Full --execute performs at most six sequential Gemini TEXT
 * requests (3 module generations + 3 independent reviews), NO retries, then
 * submits one validated draft to the private Cloudflare Worker. This is not
 * eligible for scheduled execution until it has passed a real manual pilot.
 *
 * Usage:
 *   node --import tsx scripts/generate-listening-draft.mjs
 *   LISTENING_DRAFT_GENERATION_ENABLED=true node --import tsx scripts/generate-listening-draft.mjs --pilot --execute
 *   LISTENING_DRAFT_GENERATION_ENABLED=true node --import tsx scripts/generate-listening-draft.mjs --execute
 */
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from "node:fs";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {listeningModuleJsonSchema,listeningSchemaSummary,structuralIssues} from "./lib/listening-module-json-schema.mjs";
import {
  ListeningGenerationInputSchema,ListeningSetSchema,
  LISTENING_MODULE_COMPOSITION,LISTENING_MODULE_TIME_LIMITS_SEC,
} from "../shared/src/index.ts";
import {
  assignSpeakerRendering,deterministicListeningPreChecks
} from "../server/src/services/listeningGenerator.ts";
import {compareListeningModuleDifficulty} from "../server/src/services/moduleDifficulty.ts";
import {indexDeterministicItems} from "../server/src/services/deterministicScoring.ts";
import {buildRenderPlan,listeningClipIdProblem} from "../server/src/services/listeningAudioRenderer.ts";
import {entriesFromSet,findCatalogCollisions} from "../server/src/services/generationCatalog.ts";

const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const execute=process.argv.includes("--execute");
const pilot=process.argv.includes("--pilot");
const structured=process.argv.includes("--structured");
const inspectSchema=process.argv.includes("--inspect-schema");
const inspectOption=process.argv.find(arg=>arg.startsWith("--inspect="));
const inspectPath=inspectOption?.slice("--inspect=".length)??null;
const origin=new URL(process.env.TOEFL_WORKER_URL||
  "https://toefl-prep-private.ihsuan0701.workers.dev").origin;
const token=process.env.TOEFL_MANUAL_TEST_TOKEN;
const key=process.env.GEMINI_API_KEY;
const model=process.env.GEMINI_MODEL||"gemini-3.1-flash-lite";
const accessId=process.env.CF_ACCESS_CLIENT_ID;
const accessSecret=process.env.CF_ACCESS_CLIENT_SECRET;
const moduleNames=["router","lowerModule","upperModule"];
const bankDir=join(root,"data","question-sets","listening");
const diagnosticDir=join(root,"tmp","listening-draft-pilots");
function saveDiagnostic(name,payload){
 mkdirSync(diagnosticDir,{recursive:true});
 const path=join(diagnosticDir,name+"-"+crypto.randomUUID().slice(0,12)+".json");
 writeFileSync(path,JSON.stringify(payload,null,2),{flag:"wx",mode:0o600});
 return path;
}
function validateModule(name,generated){
 const result=ListeningGenerationInputSchema.shape[name].safeParse(generated);
 if(!result.success){
  const errors=structuralIssues(result.error.issues);
  console.error("Original Listening "+name+" schema rejected; first "+errors.length+" structural issues:");
  console.error(JSON.stringify(errors,null,2));
  return {valid:false,issues:errors};
 }
 return {valid:true,module:result.data};
}
const existing=readdirSync(bankDir).filter(x=>/^lsn-[A-Za-z0-9_-]+\.json$/.test(x))
 .map(x=>ListeningSetSchema.parse(JSON.parse(readFileSync(join(bankDir,x),"utf8"))));
const SYNTHETIC_REVIEWS=3;
const MAX_TEXT_API_CALLS=pilot?1:moduleNames.length+SYNTHETIC_REVIEWS;
function authHeaders(extra={}){
 return {
  ...(accessId&&accessSecret?{"CF-Access-Client-Id":accessId,"CF-Access-Client-Secret":accessSecret}:{}),
  ...(token?{Authorization:"Bearer "+token}:{}),...extra
 };
}
async function queueStatus(){
 const r=await fetch(origin+"/api/cloud/listening-refill/status",{headers:authHeaders(),
  signal:AbortSignal.timeout(20000)});
 const raw=await r.text();
 let v;try{v=JSON.parse(raw)}catch{throw Error("Private Worker status inaccessible (HTTP "+r.status+")");}
 if(!r.ok)throw Error("Private Worker status HTTP "+r.status);
 return v;
}
let used=0;
async function callGemini(prompt,maxOutputTokens,schema){
 if(used>=MAX_TEXT_API_CALLS)throw Error("Text API call safety ceiling reached");
 used+=1;
 const r=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+
  model+":generateContent",{
   method:"POST",headers:{"x-goog-api-key":key,"Content-Type":"application/json"},
   body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt}]}],
    generationConfig:{responseMimeType:"application/json",maxOutputTokens,temperature:0.4,
      ...(structured&&schema?{responseJsonSchema:schema}:{})}}),
   signal:AbortSignal.timeout(120000)
  });
 if(!r.ok){
  // Gemini error text is untrusted provider input and may contain request
  // excerpts. Only store a whitelisted diagnosis, never the raw response,
  // token, prompt, transcript or complete error message.
  let body;
  try{body=await r.json();}catch{body=null;}
  const message=typeof body?.error?.message==="string"?body.error.message:"";
  const causes=[
    ["empty-enum",/enum.{0,100}(empty|string value)/i],
    ["schema-complexity",/complex|too large|too deep|nesting|nest|depth|schema size|too many states|branching|constraints|maxItems|minItems/i],
    ["unsupported-schema-keyword",/unsupported|unknown name|not allowed|invalid json payload/i],
    ["response-json-schema",/responseJsonSchema|responseSchema/i],
    ["quota",/quota|resource.exhausted|rate limit/i],
    ["model",/model not found|model.*unsupported/i],
  ].filter(([,pattern])=>pattern.test(message)).map(([code])=>code);
  const issue={
    httpStatus:r.status,errorCode:typeof body?.error?.code==="number"?body.error.code:null,
    status:typeof body?.error?.status==="string"&&/^[A-Z_]{3,40}$/.test(body.error.status)?body.error.status:null,
    categories:causes.length?causes:["unclassified"],
    structured,model,geminiTextRequests:used,automaticRetry:false,
  };
  const saved=saveDiagnostic("gemini-http-error",issue);
  console.error("Gemini returned HTTP "+r.status+"; sanitized diagnostics: "+saved);
  console.error("Diagnostic categories: "+issue.categories.join(", ")+
    ". No automatic retry; API usage must be verified in AI Studio.");
  throw Error("Gemini text HTTP "+r.status+" (no automatic retry)");
 }
 const body=await r.json();
 const text=body.candidates?.[0]?.content?.parts?.map(p=>p.text||"").join("");
 if(!text)throw Error("Gemini returned no text");
 try{return JSON.parse(text);}catch{throw Error("Gemini generated invalid JSON");}
}
function makePrompt(name,prior,usedTopics,prefix){
 const num=LISTENING_MODULE_COMPOSITION[name];
 const secs=LISTENING_MODULE_TIME_LIMITS_SEC[name];
 return [
  "You are writing one ORIGINAL TOEFL 2026-style LISTENING module for private practice. Never copy ETS questions, official scripts or copyrighted articles.",
  "Return one JSON object with only timeLimitSec,listenChoose,conversations,announcements,academicTalks.",
  "This module is "+name+". timeLimitSec MUST equal "+secs+".",
  "Exact item counts: "+JSON.stringify(num)+". No missing or extra items.",
  "Audio MUST be the empty string for every item, the local system will fill it.",
  "Every ID must be unique across this complete Set, ASCII letters/numbers/dash/underscore only, <=64 chars.",
  "Prefix ALL stimulus IDs and question IDs with "+prefix+"-; avoid collisions within the module.",
  "ListenChoose fields: id,taskType='listen_choose',audio,speaker,utterance,options,correctOptionId,skill,explanationZh.",
  "ListenChoose utterance is a natural concise conversational question/statement (typically 4–8 English words, no more than 6 estimated stressed syllables), four distinct plausible responses. Do not print the utterance in any answer choice.",
  "Conversations fields: id,taskType='conversation',audio,setting,speakers,transcript,questions. Each is 80–150 spoken English words, 2 comprehension questions.",
  "Conversation speakers are EXACTLY one male and one female. Transcript is an array of {speakerId,text}; refer only to the two speaker IDs. At least 6 distinct turns; realistic campus everyday dialogue.",
  "Announcements fields: id,taskType='announcement',audio,setting,speaker,transcript,questions. Each is 40–85 English spoken words, 2 questions.",
  "AcademicTalks fields: id,taskType='academic_talk',audio,discipline,speaker,transcript,questions. Each is 175–250 English spoken words, 4 questions.",
  "Each speaker has id (ASCII),role (natural English),gender (male/female),accent ('north-american'),voice ('Puck'),provider ('gemini'). The app assigns real voices/accents later. Speaker IDs must be consistent in conversations.",
  "For every conversation/announcement/academic talk question, include id,stem,skill,options,correctOptionId,explanationZh.",
  "Question skill is one of gist/detail/inference/function/attitude. Use varied tested skills. Stem and options must be ENGLISH, explanations Traditional Chinese (roughly 40–120 Chinese characters).",
  "Each options array has exactly 4 distinct {id,text} choices with ids A,B,C,D, exactly one defensible correctOptionId from A,B,C,D.",
  "Correct options must be supported by the spoken content; incorrect options must be plausible yet falsifiable. Never reveal the answer by length or wording.",
  "Do not refer to A/B/C/D or first/second in Chinese explanations; describe by meaning. Never include more than the required items.",
  "Be scientifically and historically accurate; avoid unverified current claims, offensive stereotypes or copyrighted reproductions.",
  "Avoid these original-bank subjects or settings: "+JSON.stringify(prior.slice(0,24)),
  "Avoid these topics within the current candidate: "+JSON.stringify(usedTopics.slice(0,35)),
  name==="upperModule"?
   "UPPER: greater conceptual complexity, denser information and more advanced English than LOWER, without extending the recommended word-length bands.":
   name==="lowerModule"?"LOWER: relatively straightforward spoken English, concrete contexts and accessible vocabulary.":
   "ROUTER: balanced intermediate difficulty.",
  "Return ONLY well-formed JSON. No markdown or backticks."
 ].join("\n");
}
function synopsis(set){
 const blocks=[set.router,set.lowerModule,set.upperModule];
 return blocks.flatMap(m=>[
  ...m.listenChoose.map(x=>x.utterance.slice(0,90)),
  ...m.conversations.map(x=>x.setting.slice(0,90)),
  ...m.announcements.map(x=>x.setting.slice(0,90)),
  ...m.academicTalks.map(x=>x.discipline.slice(0,90))
 ]);
}
function questionSummaries(m){
 return [...m.listenChoose.map(x=>({
  id:x.id,spoken:x.utterance,answers:x.options,correct:x.correctOptionId,explanationZh:x.explanationZh
 })),...m.conversations.map(x=>({id:x.id,script:x.transcript,questions:x.questions})),
 ...m.announcements.map(x=>({id:x.id,script:x.transcript,questions:x.questions})),
 ...m.academicTalks.map(x=>({id:x.id,script:x.transcript,questions:x.questions}))];
}
async function independentReview(name,module){
 const v=await callGemini([
  "Be a STRICT independent TOEFL Listening item reviewer. This is NOT a creative writing task.",
  "Audit EVERY item and every correct answer against its spoken script. For each option verify that only its key is supported.",
  "Reject ambiguous distractors, incorrect keys, implausible speech, contradictory details, incoherent inference questions, obvious cultural assumptions, Chinese explanations that are wrong, and any scientific factual mistakes.",
  "Never approve without reviewing each audio script and all questions. Respond exactly as JSON object with passed:boolean and issues:[{id:string,reason:string}].",
  "passed MUST be false if there is ANY answer-key defect or unanswerable question. issues MUST be [] only on unequivocal pass.",
  "Module: "+name,
  "Content: "+JSON.stringify(questionSummaries(module))
 ].join("\n"),3500);
 if(!v||typeof v!=="object"||typeof v.passed!=="boolean"||!Array.isArray(v.issues)||
  v.issues.some(x=>!x||typeof x!=="object"||typeof x.id!=="string"||typeof x.reason!=="string"))
  throw Error("Independent review returned an invalid verdict");
 if(!v.passed||v.issues.length)throw Error("Independent review rejected "+name+"; no draft uploaded");
}
console.log(JSON.stringify({
 phase:inspectSchema?"offline schema inspection":inspectPath?"offline candidate inspection":
  execute?(pilot?"one-module text pilot requested":"text generation requested"):"dry-run only",
 existingLocalSets:existing.length,modules:pilot?["router"]:moduleNames,
 structuredOutput:structured,inspectOnly:!!inspectPath||inspectSchema,
 plannedTextRequests:inspectSchema||!!inspectPath?0:MAX_TEXT_API_CALLS,ttsRequests:0,
 publishes:false,schedules:false,
 caveat:"Model quota and billing must be checked separately in Google AI Studio"
},null,2));
if(inspectSchema){
 // No network, no keys, no private content; only a summary of the current
 // request schema. This can be run even if --execute is accidentally supplied.
 const schemas=Object.fromEntries((pilot?["router"]:moduleNames).map(name=>[
  name,listeningSchemaSummary(listeningModuleJsonSchema(
    LISTENING_MODULE_COMPOSITION[name],LISTENING_MODULE_TIME_LIMITS_SEC[name]))
 ]));
 if(Object.values(schemas).some(s=>s.boundedArrays||s.numericBounds||s.emptyEnums))
  throw Error("Unsafe Gemini schema constraints; refusing structured pilot");
 console.log(JSON.stringify({result:"offline-schema-inspection",apiRequests:0,
  uploadedToD1:false,structuredGenerationSupportedByLocalShape:true,schemas},null,2));
 process.exit(0);
}
if(inspectPath){
 // Offline-only inspection: no network, no API key, no D1, no audio output.
 const raw=JSON.parse(readFileSync(resolve(inspectPath),"utf8"));
 const candidate=raw?.response??raw;
 const checked=validateModule("router",candidate);
 console.log(JSON.stringify({result:"offline-router-validation",
  valid:checked.valid,apiRequests:0,uploadedToD1:false,
  ...(checked.valid?{stimuli:checked.module.listenChoose.length+
    checked.module.conversations.length+checked.module.announcements.length+
    checked.module.academicTalks.length}:{structuralIssues:checked.issues})},null,2));
 process.exitCode=checked.valid?0:1;
 process.exit();
}
if(!execute)process.exit(0);
if(process.env.LISTENING_DRAFT_GENERATION_ENABLED!=="true")
 throw Error("LISTENING_DRAFT_GENERATION_ENABLED must be explicitly true; no paid requests sent");
if(!key)throw Error("GEMINI_API_KEY is required; never paste it into chat or GitHub");
if(!/^[A-Za-z0-9._-]+$/.test(model))throw Error("Unsafe Gemini model name");
// Limited-cost local pilot: one TEXT call, one ORIGINAL router module, no private
// Worker/admin-token dependency, no D1 write, no TTS, no publication.
if(pilot){
 const prior=existing.flatMap(synopsis);
 const generated=await callGemini(makePrompt("router",prior,[],"pilot-r0"),24000,
   listeningModuleJsonSchema(LISTENING_MODULE_COMPOSITION.router,LISTENING_MODULE_TIME_LIMITS_SEC.router));
 // Save the model's complete JSON response locally BEFORE schema checking.
 // This lets us inspect the first failed request at no extra API cost.
 const diagnosticPath=saveDiagnostic("router-response",{response:generated});
 const validated=validateModule("router",generated);
 if(!validated.valid){
  console.error("Full generated text saved locally (never published): "+diagnosticPath);
  console.error("No retries. Do not paste unpublished answers or API keys in chat.");
  process.exitCode=1;
  process.exit();
 }
 const parsed=validated.module;
 const outputPath=saveDiagnostic("router-validated",parsed);
 console.log(JSON.stringify({
  result:"router-pilot-saved",module:"router",schemaValid:true,
  stimuli:parsed.listenChoose.length+parsed.conversations.length+
    parsed.announcements.length+parsed.academicTalks.length,
  outputPath,geminiTextRequests:used,ttsRequests:0,uploadedToD1:false,
  published:false,manualContentReviewRequired:true
 },null,2));
 process.exit(0);
}
if(!token||token.length<32)throw Error("Private Worker admin token required");
const status=await queueStatus();
if(!status.r2Configured)throw Error("Cloudflare R2 not bound; no generation");
if(status.queue.some(x=>["draft","rendering","ready","blocked"].includes(x.state)))
 throw Error("A Listening draft already exists; refusing to generate duplicate content");
// No dependence on the AUDIO enabled switch: a draft can be safely queued while
// daily TTS remains stopped, but it can never be automatically published.
const id="lsn-"+crypto.randomUUID().replace(/-/g,"").slice(0,12);
const modules={};
const already=existing.flatMap(synopsis);
for(const name of moduleNames){
 const prefix=id.slice(4,10)+"-"+name.slice(0,2);
 const result=await callGemini(makePrompt(name,already,already,prefix),24000,
  listeningModuleJsonSchema(LISTENING_MODULE_COMPOSITION[name],LISTENING_MODULE_TIME_LIMITS_SEC[name]));
 const diagnosticPath=saveDiagnostic(name+"-response",{response:result});
 const validated=validateModule(name,result);
 if(!validated.valid){
  console.error("Incomplete text saved locally: "+diagnosticPath);
  throw Error("Generated "+name+" failed ORIGINAL module schema; no retry");
 }
 modules[name]=validated.module;
 already.push(...[
  ...modules[name].listenChoose.map(x=>x.utterance),
  ...modules[name].conversations.map(x=>x.setting),
  ...modules[name].announcements.map(x=>x.setting),
  ...modules[name].academicTalks.map(x=>x.discipline)
 ]);
}
const raw=ListeningGenerationInputSchema.parse({
 id,source:"generated",kind:"listening",createdAt:new Date().toISOString(),...modules
});
const assigned=assignSpeakerRendering(raw);
const fixed={};
for(const name of moduleNames){
 const m=assigned[name];
 fixed[name]={...m,
  listenChoose:m.listenChoose.map(x=>({...x,audio:"stimuli/"+id+"/"+x.id+".mp3"})),
  conversations:m.conversations.map(x=>({...x,audio:"stimuli/"+id+"/"+x.id+".mp3"})),
  announcements:m.announcements.map(x=>({...x,audio:"stimuli/"+id+"/"+x.id+".mp3"})),
  academicTalks:m.academicTalks.map(x=>({...x,audio:"stimuli/"+id+"/"+x.id+".mp3"}))
 };
}
const candidate=ListeningSetSchema.parse({
 ...assigned,...fixed,
 audioProfile:{version:"ets-2026-listening-v1",provider:"gemini",model:"gemini-3.8-flash-lite-tts"}
});
if(listeningClipIdProblem(candidate))throw Error("Duplicate stimulus identifiers");
indexDeterministicItems(candidate);
deterministicListeningPreChecks(candidate);
if(!compareListeningModuleDifficulty(candidate).upperIsHarder)
 throw Error("Upper module not harder than lower");
if(buildRenderPlan(candidate).length!==36)throw Error("Incorrect 36-clip render plan");
const entryRows=[...existing,candidate].flatMap(entriesFromSet);
const collisions=findCatalogCollisions(entryRows,{withinSet:true})
 .filter(x=>x.conflictingSetIds.includes(id));
if(collisions.length)throw Error("Novelty audit found repeated prior content; no upload");
// Only after all free deterministic gates pass do we spend further independent reviews.
for(const name of moduleNames)await independentReview(name,candidate[name]);
const res=await fetch(origin+"/api/cloud/listening-refill/draft",{
 method:"POST",
 headers:authHeaders({"Content-Type":"application/json",Origin:origin}),
 body:JSON.stringify(candidate),signal:AbortSignal.timeout(45000)
});
if(!res.ok)throw Error("Private draft import HTTP "+res.status+"; do not regenerate without checking D1");
const created=await res.json();
if(created.setId!==id||created.clips!==36||created.published!==false)
 throw Error("Unexpected queue acknowledgement; inspect D1 manually");
console.log(JSON.stringify({result:"queued-for-audio",setId:id,clips:36,
 geminiTextRequests:used,ttsRequests:0,published:false,manualReviewBeforePublication:true}));
