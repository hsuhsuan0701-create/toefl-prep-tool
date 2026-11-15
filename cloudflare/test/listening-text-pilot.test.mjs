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
