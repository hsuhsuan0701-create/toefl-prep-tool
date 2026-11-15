import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {listeningModuleJsonSchema,listeningSchemaSummary,structuralIssues} from "../../scripts/lib/listening-module-json-schema.mjs";

const root=new URL("../../",import.meta.url);
const source=new URL("../../data/question-sets/listening/lsn-03948a55.json",import.meta.url);
const canonical=JSON.parse(readFileSync(source,"utf8")).router;

test("Google-compatible Router schema avoids bounded nested arrays that can trigger HTTP 400",()=>{
 const schema=listeningModuleJsonSchema({
  listenChoose:10,conversations:3,announcements:3,academicTalks:1,
 },1080);
 const summary=listeningSchemaSummary(schema);
 assert.ok(summary.arrays>=8);
 assert.equal(summary.boundedArrays,0);
 assert.equal(summary.numericBounds,0);
 assert.equal(summary.emptyEnums,0);
 assert.equal(schema.properties.listenChoose.type,"array");
 assert.equal(schema.properties.conversations.type,"array");
 assert.equal(schema.properties.announcements.type,"array");
 assert.equal(schema.properties.academicTalks.type,"array");
 assert.equal(schema.properties.timeLimitSec.type,"integer");
 assert.equal(schema.properties.listenChoose.items.properties.audio.type,"string");
 assert.equal("enum" in schema.properties.listenChoose.items.properties.audio,false);
 assert.equal(schema.properties.conversations.items.properties.audio.type,"string");
});
test("offline structured schema inspection never invokes Gemini, even with --execute",()=>{
 const res=spawnSync(process.execPath,["--import","tsx",
  "scripts/generate-listening-draft.mjs","--pilot","--structured","--inspect-schema","--execute"],{
   cwd:new URL("../../",import.meta.url),encoding:"utf8",timeout:30000,
   env:{...process.env,GEMINI_API_KEY:"",LISTENING_DRAFT_GENERATION_ENABLED:"false"}
  });
 assert.equal(res.status,0,res.stderr);
 assert.match(res.stdout,/"apiRequests": 0/);
 assert.match(res.stdout,/"boundedArrays": 0/);
 assert.match(res.stdout,/"emptyEnums": 0/);
});

test("offline inspector accepts existing original Router without API",()=>{
 const dir=mkdtempSync(join(tmpdir(),"toefl-listening-inspect-"));
 try{
  const file=join(dir,"router.json");
  writeFileSync(file,JSON.stringify({response:canonical}));
  const res=spawnSync(process.execPath,["--import","tsx",
   "scripts/generate-listening-draft.mjs","--inspect="+file],{
    cwd:new URL("../../",import.meta.url),encoding:"utf8",
    env:{...process.env,GEMINI_API_KEY:"",LISTENING_DRAFT_GENERATION_ENABLED:"false"},
    timeout:30000,
  });
  assert.equal(res.status,0,res.stderr);
  assert.match(res.stdout,/"valid": true/);
  assert.match(res.stdout,/"apiRequests": 0/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test("offline inspector reports sanitized failure paths without exposing transcript",()=>{
 const dir=mkdtempSync(join(tmpdir(),"toefl-listening-reject-"));
 try{
  const file=join(dir,"invalid-router.json");
  const corrupt=structuredClone(canonical);
  corrupt.timeLimitSec=999;
  corrupt.conversations[0].speakers[0].gender="robot";
  writeFileSync(file,JSON.stringify({response:corrupt}));
  const res=spawnSync(process.execPath,["--import","tsx",
   "scripts/generate-listening-draft.mjs","--inspect="+file],{
    cwd:new URL("../../",import.meta.url),encoding:"utf8",
    env:{...process.env,GEMINI_API_KEY:"",LISTENING_DRAFT_GENERATION_ENABLED:"false"},
    timeout:30000,
  });
  assert.equal(res.status,1);
  assert.match(res.stdout+res.stderr,/timeLimitSec/);
  assert.match(res.stdout+res.stderr,/conversations\.0\.speakers\.0\.gender/);
  assert.match(res.stdout,/"apiRequests": 0/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test("sanitized structural errors include only paths and codes",()=>{
 assert.deepEqual(structuralIssues([{path:["transcript",0,"text"],code:"invalid_type",
  message:"CONFIDENTIAL UNPUBLISHED SCRIPT",received:"secret"}]),[
  {path:"transcript.0.text",code:"invalid_type"}
 ]);
});

test("original local Zod gate still rejects a wrong stimulus count after Gemini schema simplification",()=>{
 const dir=mkdtempSync(join(tmpdir(),"toefl-listening-size-"));
 try{
  const file=join(dir,"router-minus-one.json");
  const invalid=structuredClone(canonical);
  invalid.listenChoose.pop();
  writeFileSync(file,JSON.stringify({response:invalid}));
  const res=spawnSync(process.execPath,["--import","tsx",
   "scripts/generate-listening-draft.mjs","--inspect="+file],{
   cwd:new URL("../../",import.meta.url),encoding:"utf8",
   env:{...process.env,GEMINI_API_KEY:"",LISTENING_DRAFT_GENERATION_ENABLED:"false"},
   timeout:30000,
  });
  assert.equal(res.status,1);
  assert.match(res.stdout+res.stderr,/listenChoose/);
  assert.match(res.stdout,/"apiRequests": 0/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test("reviewed Router file dry-run saves one Gemini text request without API access",()=>{
 const dir=mkdtempSync(join(tmpdir(),"toefl-reviewed-router-"));
 try{
  const file=join(dir,"router.json");
  writeFileSync(file,JSON.stringify({response:canonical}));
  const res=spawnSync(process.execPath,["--import","tsx","scripts/generate-listening-draft.mjs",
    "--structured","--router-file="+file],{
    cwd:root,encoding:"utf8",timeout:30000,
    env:{...process.env,GEMINI_API_KEY:"",LISTENING_DRAFT_GENERATION_ENABLED:"false"},
  });
  assert.equal(res.status,0,res.stderr);
  assert.match(res.stdout,/"routerReused": true/);
  assert.match(res.stdout,/"plannedTextRequests": 5/);
  assert.match(res.stdout,/"ttsRequests": 0/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test("full generation refuses saved Router without explicit human review before any API request",()=>{
 const dir=mkdtempSync(join(tmpdir(),"toefl-review-gate-"));
 try{
  const file=join(dir,"router.json");
  writeFileSync(file,JSON.stringify(canonical));
  const res=spawnSync(process.execPath,["--import","tsx","scripts/generate-listening-draft.mjs",
    "--structured","--router-file="+file,"--execute"],{
    cwd:root,encoding:"utf8",timeout:30000,
    env:{...process.env,GEMINI_API_KEY:"",LISTENING_DRAFT_GENERATION_ENABLED:"false"},
  });
  assert.notEqual(res.status,0);
  assert.match(res.stdout+res.stderr,/requires manual content review/);
  assert.match(res.stdout,/"plannedTextRequests": 5/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test("an invalid Router reuse file fails local Zod before any model request",()=>{
 const dir=mkdtempSync(join(tmpdir(),"toefl-invalid-resume-"));
 try{
  const file=join(dir,"invalid-router.json");
  const invalid=structuredClone(canonical);
  invalid.listenChoose.pop();
  writeFileSync(file,JSON.stringify(invalid));
  const res=spawnSync(process.execPath,["--import","tsx","scripts/generate-listening-draft.mjs",
    "--structured","--router-file="+file],{
    cwd:root,encoding:"utf8",timeout:30000,
    env:{...process.env,GEMINI_API_KEY:"",LISTENING_DRAFT_GENERATION_ENABLED:"false"},
  });
  assert.notEqual(res.status,0);
  assert.match(res.stdout+res.stderr,/Original Listening router schema rejected/);
  assert.doesNotMatch(res.stdout+res.stderr,/Gemini returned HTTP/);
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test("private Router manual review packet contains the exact transcript and answer keys, with no network",()=>{
 const dir=mkdtempSync(join(tmpdir(),"toefl-review-output-"));
 let outputPath=null;
 try{
  const file=join(dir,"router-"+process.pid+".json");
  writeFileSync(file,JSON.stringify(canonical));
  const res=spawnSync(process.execPath,["--import","tsx","scripts/review-listening-router.mjs",
    "--file="+file],{cwd:root,encoding:"utf8",timeout:30000,env:{...process.env,GEMINI_API_KEY:""}});
  assert.equal(res.status,0,res.stderr);
  const payload=JSON.parse(res.stdout);
  outputPath=payload.outputPath;
  assert.equal(payload.stimuli,17);
  assert.equal(payload.apiRequests,0);
  const markdown=readFileSync(outputPath,"utf8");
  assert.match(markdown,/人工內容審閱/);
  assert.match(markdown,/（正解）/);
  assert.ok(markdown.includes(canonical.conversations[0].transcript[0].text));
 }finally{
  if(outputPath)rmSync(outputPath,{force:true});
  rmSync(dir,{recursive:true,force:true});
 }
});
