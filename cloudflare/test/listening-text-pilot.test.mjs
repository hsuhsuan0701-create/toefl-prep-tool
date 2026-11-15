import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawnSync} from "node:child_process";
import {listeningModuleJsonSchema,structuralIssues} from "../../scripts/lib/listening-module-json-schema.mjs";

const root=new URL("../../",import.meta.url);
const source=new URL("../../data/question-sets/listening/lsn-03948a55.json",import.meta.url);
const canonical=JSON.parse(readFileSync(source,"utf8")).router;

test("one Router schema captures exact original 17-stimulus counts",()=>{
 const schema=listeningModuleJsonSchema({
  listenChoose:10,conversations:3,announcements:3,academicTalks:1,
 },1080);
 assert.equal(schema.properties.listenChoose.minItems,10);
 assert.equal(schema.properties.listenChoose.maxItems,10);
 assert.equal(schema.properties.conversations.minItems,3);
 assert.equal(schema.properties.announcements.minItems,3);
 assert.equal(schema.properties.academicTalks.minItems,1);
 assert.equal(schema.properties.timeLimitSec.minimum,1080);
 assert.equal(schema.properties.listenChoose.items.properties.audio.enum[0],"");
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
