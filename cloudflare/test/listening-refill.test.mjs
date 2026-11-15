import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {readdirSync,readFileSync} from "node:fs";
import {handleListeningRefill,servePublishedR2Audio,ttsQuotaDay} from "../src/listeningRefill.ts";

const host="https://private.test",token="x".repeat(48);
const original=JSON.parse(readFileSync(new URL("../../data/question-sets/listening/lsn-03948a55.json",import.meta.url),"utf8"));
function fixture(){
 const sql=new Database(":memory:");
 const migrations=new URL("../migrations/",import.meta.url);
 for(const f of readdirSync(migrations).filter(x=>x.endsWith(".sql")).sort())
   sql.exec(readFileSync(new URL(f,migrations),"utf8"));
 class S {
   constructor(query,args=[]){this.query=query;this.args=args;}
   bind(...args){return new S(this.query,args);}
   first(){return Promise.resolve(sql.prepare(this.query).get(...this.args)??null);}
   all(){return Promise.resolve({results:sql.prepare(this.query).all(...this.args)});}
   run(){return Promise.resolve({meta:{changes:sql.prepare(this.query).run(...this.args).changes}});}
 }
 const DB={prepare(q){return new S(q)},batch(statements){
   return Promise.resolve(sql.transaction(()=>statements.map(s=>({
     meta:{changes:sql.prepare(s.query).run(...s.args).changes}
   })))());
 }};
 const map=new Map();
 const LISTENING_AUDIO={
   head:async key=>map.has(key)?{size:map.get(key).length}:null,
   put:async (key,body)=>{map.set(key,new Uint8Array(body));return {key}},
   get:async key=>map.has(key)?{size:map.get(key).length,body:new Response(map.get(key)).body}:null
 };
 return {sql,env:{DB,LISTENING_AUDIO,TOEFL_MANUAL_TEST_TOKEN:token},map};
}
async function json(env,path,body){
 const res=await handleListeningRefill(new Request(host+path,{
  method:"POST",headers:{origin:host,authorization:"Bearer "+token,"content-type":"application/json"},
  body:JSON.stringify(body)
 }),env);
 return {status:res.status,data:await res.json()};
}
async function claim(env){return json(env,"/api/cloud/listening-refill/claim",{confirm:"CLAIM_LISTENING_TTS_ONCE"});}
async function changeEnabled(env,enabled){
 return json(env,"/api/cloud/listening-refill/settings",{enabled,confirm:"SET_LISTENING_AUTO_REFILL"});
}
const lite="gemini-3.8-flash-lite-tts",flash="gemini-3.8-flash-tts";
async function approveModel(env,model,dailyLimit){
 return json(env,"/api/cloud/listening-refill/model-policy",{
  model,dailyLimit,confirm:dailyLimit===0?"DISABLE_TTS_MODEL":"I_VERIFIED_FREE_TIER_TODAY"
 });
}
async function upload(env,setId,stimulusId){
 const mp3=Buffer.concat([Buffer.from("ID3"),Buffer.alloc(2048)]);
 const r=await handleListeningRefill(new Request(host+"/api/cloud/listening-refill/upload?setId="+setId+"&stimulusId="+stimulusId,{
  method:"POST",headers:{origin:host,authorization:"Bearer "+token,"content-type":"audio/mpeg","content-length":String(mp3.length)},
  body:mp3
 }),env);
 return {status:r.status,data:await r.json()};
}
test("Pacific quota day honors time-zone boundaries without consuming API",()=>{
 assert.equal(ttsQuotaDay(new Date("2026-11-15T07:59:00Z")),"2026-11-14");
 assert.equal(ttsQuotaDay(new Date("2026-11-15T08:01:00Z")),"2026-11-15");
});
test("private draft requires authorization, is immutable, cannot publish with missing MP3",async()=>{
 const {sql,env}=fixture();
 try{
  const unauthorized=await handleListeningRefill(new Request(host+"/api/cloud/listening-refill/status"),{...env,TOEFL_MANUAL_TEST_TOKEN:undefined});
  assert.equal(unauthorized.status,401);
  const created=await json(env,"/api/cloud/listening-refill/draft",original);
  assert.equal(created.status,201,JSON.stringify(created.data));
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM listening_refill_clips").get().n,36);
  assert.equal((await json(env,"/api/cloud/listening-refill/draft",original)).status,409);
  assert.equal((await json(env,"/api/cloud/listening-refill/publish",
   {setId:original.id,confirm:"PUBLISH_REVIEWED_LISTENING_SET"})).status,409);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM listening_sets WHERE id=?").get(original.id).n,0);
 }finally{sql.close();}
});
test("claims 3 total per Pacific day, MP3 upload idempotence, no automatic publication",async()=>{
 const {sql,env}=fixture();
 try{
  await json(env,"/api/cloud/listening-refill/draft",original);
  assert.equal((await claim(env)).data.result,"disabled","Default must refuse paid TTS");
  assert.equal((await changeEnabled(env,true)).status,200);
  assert.equal((await claim(env)).data.result,"free-tier-unverified",
   "An enabled stop switch never grants Free Tier clearance by itself");
  assert.equal((await approveModel(env,lite,3)).status,200);
  const ids=[];
  for(let i=0;i<3;i++){
    const c=await claim(env);
    assert.equal(c.status,200,JSON.stringify(c.data));
    assert.equal(c.data.result,"claimed");
    assert.equal(c.data.slot,i+1);
    assert.equal(c.data.model,lite);
    ids.push(c.data.stimulusId);
    assert.equal((await upload(env,original.id,c.data.stimulusId)).status,201);
  }
  assert.equal(new Set(ids).size,3);
  const fourth=await claim(env);
  assert.equal(fourth.data.result,"daily-limit");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM listening_refill_model_attempts").get().n,3);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM listening_refill_clips WHERE status='uploaded'").get().n,3);
  const repeated=await upload(env,original.id,ids[0]);
  assert.equal(repeated.status,409);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM listening_sets").get().n,0);
  const unpublished=await servePublishedR2Audio(new Request(host+"/api/audio/stimuli/"+original.id+"/"+ids[0]+".mp3"),env);
  assert.equal(unpublished,null);
 }finally{sql.close();}
});
test("flagged overlap blocks publication without using another AI API",async()=>{
 const {sql,env}=fixture();
 try{
  await json(env,"/api/cloud/listening-refill/draft",original);
  await changeEnabled(env,true);
  await approveModel(env,lite,3);
  const c=await claim(env);
  const flagged=await json(env,"/api/cloud/listening-refill/flag",
    {setId:original.id,stimulusId:c.data.stimulusId,confirm:"FLAG_BAD_AUDIO"});
  assert.equal(flagged.status,200);
  assert.equal(flagged.data.result,"blocked");
  const next=await claim(env);
  assert.equal(next.data.result,"no-draft");
  const publish=await json(env,"/api/cloud/listening-refill/publish",
   {setId:original.id,confirm:"PUBLISH_REVIEWED_LISTENING_SET"});
  assert.equal(publish.status,409);
  const repaired=await json(env,"/api/cloud/listening-refill/reset-flagged",
   {setId:original.id,stimulusId:c.data.stimulusId,confirm:"RESET_FLAGGED_NEXT_DAY"});
  assert.equal(repaired.status,200);
  assert.equal(repaired.data.result,"pending-manual-retry");
  assert.equal(sql.prepare("SELECT status FROM listening_refill_clips WHERE set_id=? AND stimulus_id=?")
    .get(original.id,c.data.stimulusId).status,"pending");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM listening_refill_model_attempts").get().n,1,
   "Flag reset must not refund any daily quota");
  assert.equal((await claim(env)).status,409,
   "Same clip cannot be regenerated twice within the same Pacific day");
 }finally{sql.close();}
});

test("stop switch is persistent, rejects new claims, does not delete already uploaded MP3",async()=>{
 const {sql,env,map}=fixture();
 try{
  await json(env,"/api/cloud/listening-refill/draft",original);
  assert.equal((await claim(env)).data.result,"disabled");
  await changeEnabled(env,true);
  await approveModel(env,lite,3);
  const first=await claim(env);
  assert.equal(first.data.result,"claimed");
  await upload(env,original.id,first.data.stimulusId);
  assert.equal(map.size,1);
  const stopped=await changeEnabled(env,false);
  assert.equal(stopped.data.enabled,false);
  assert.equal(stopped.data.stopped,true);
  const next=await claim(env);
  assert.equal(next.data.result,"disabled");
  assert.equal(map.size,1);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM listening_refill_model_attempts").get().n,1);
  const status=await handleListeningRefill(new Request(host+"/api/cloud/listening-refill/status",{
    headers:{authorization:"Bearer "+token}}),env);
  assert.equal((await status.json()).enabled,false);
 }finally{sql.close();}
});

test("model policies are opt-in, bounded, and expire at the Pacific-day boundary",async()=>{
 const {sql,env}=fixture();
 try{
  await json(env,"/api/cloud/listening-refill/draft",original);
  await changeEnabled(env,true);
  assert.equal((await approveModel(env,"gemini-2.5-pro-preview-tts",10)).status,400,
   "Never authorize a non-allowlisted or potentially paid-only model");
  assert.equal((await approveModel(env,lite,11)).status,400);
  assert.equal((await approveModel(env,flash,0)).status,200);
  assert.equal((await claim(env)).data.result,"daily-limit");
  assert.equal((await approveModel(env,lite,2)).status,200);
  const status=await handleListeningRefill(new Request(host+"/api/cloud/listening-refill/status",{
   headers:{authorization:"Bearer "+token}}),env);
  const models=(await status.json()).models;
  assert.equal(models.find(m=>m.model===lite).freeTierVerifiedToday,true);
  assert.equal(models.find(m=>m.model===flash).ready,false);
  sql.prepare("UPDATE settings SET value=? WHERE key=?").run(
   JSON.stringify({dailyLimit:10,confirmedDay:"2000-01-01"}),
   "listening_tts_model_policy_"+lite);
  assert.equal((await claim(env)).data.result,"daily-limit",
   "A stale or disabled attestation permits no claims");
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM listening_refill_model_attempts").get().n,0);
 }finally{sql.close();}
});

test("different TTS models get independent daily claims without automatic retries",async()=>{
 const {sql,env}=fixture();
 try{
  await json(env,"/api/cloud/listening-refill/draft",original);
  await changeEnabled(env,true);
  await approveModel(env,lite,1);
  await approveModel(env,flash,2);
  const attempts=[];
  for(let i=0;i<3;i++){
   const res=await claim(env);
   assert.equal(res.status,200,JSON.stringify(res.data));
   assert.equal(res.data.result,"claimed");
   attempts.push(res.data);
   await upload(env,original.id,res.data.stimulusId);
  }
  assert.deepEqual(attempts.map(x=>x.model),[lite,flash,flash]);
  assert.ok(original.router.conversations.some(item=>item.id===attempts[1].stimulusId),
   "Flash reserves its budget for pending long audio before short overflow");
  assert.deepEqual(attempts.map(x=>x.slot),[1,1,2]);
  assert.equal((await claim(env)).data.result,"daily-limit");
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM listening_refill_model_attempts").get().n,3);
  const s=await handleListeningRefill(new Request(host+"/api/cloud/listening-refill/status",{
   headers:{authorization:"Bearer "+token}}),env);
  assert.deepEqual((await s.json()).models.map(m=>m.remaining),[0,0]);
 }finally{sql.close();}
});

test("Conversation chooses Flash TTS when Flash has approved Free Tier budget",async()=>{
 const {sql,env}=fixture();
 try{
  await json(env,"/api/cloud/listening-refill/draft",original);
  const conversation=original.router.conversations[0].id;
  sql.prepare("UPDATE listening_refill_clips SET ordinal=ordinal+40 WHERE set_id=?").run(original.id);
  sql.prepare("UPDATE listening_refill_clips SET ordinal=0 WHERE set_id=? AND stimulus_id=?").run(original.id,conversation);
  await changeEnabled(env,true);
  await approveModel(env,lite,2);
  await approveModel(env,flash,2);
  const c=await claim(env);
  assert.equal(c.data.result,"claimed");
  assert.equal(c.data.stimulusId,conversation);
  assert.equal(c.data.model,flash);
  const uploaded=await upload(env,original.id,c.data.stimulusId);
  assert.equal(uploaded.data.model,flash);
  assert.equal(sql.prepare("SELECT model FROM listening_refill_model_attempts WHERE stimulus_id=?")
   .get(conversation).model,flash);
 }finally{sql.close();}
});

test("migration copies historical Lite claims without refunding their quota",()=>{
 const sql=new Database(":memory:");
 try{
  const migrations=new URL("../migrations/",import.meta.url);
  for(const f of readdirSync(migrations).filter(x=>x.endsWith(".sql")&&!x.startsWith("0009")).sort())
   sql.exec(readFileSync(new URL(f,migrations),"utf8"));
  sql.prepare("INSERT INTO listening_refill_daily_attempts(day,slot,set_id,stimulus_id,status) VALUES(?,?,?,?,?)")
   .run("2026-11-15",1,"lsn-historical","lcr-old","uploaded");
  sql.exec(readFileSync(new URL("0009_listening_tts_models.sql",migrations),"utf8"));
  const migrated=sql.prepare("SELECT model,slot,status FROM listening_refill_model_attempts WHERE day=?")
   .get("2026-11-15");
  assert.deepEqual(migrated,{model:lite,slot:1,status:"uploaded"});
 }finally{sql.close();}
});

test("a lost concurrent model claim never authorizes a paid TTS request",async()=>{
 const {sql,env}=fixture();
 try{
  await json(env,"/api/cloud/listening-refill/draft",original);
  await changeEnabled(env,true);
  await approveModel(env,lite,2);
  const realBatch=env.DB.batch.bind(env.DB);
  env.DB.batch=async statements=>{
   if(statements[0]?.query?.includes("INSERT INTO listening_refill_model_attempts"))
    return statements.map(()=>({meta:{changes:0}}));
   return realBatch(statements);
  };
  const result=await claim(env);
  assert.equal(result.status,409);
  assert.equal(result.data.result,"conflict-no-tts");
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM listening_refill_model_attempts").get().n,0);
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM listening_refill_clips WHERE status='claimed'").get().n,0);
 }finally{sql.close();}
});

test("Lite never renders long audio even when Flash is unverified",async()=>{
 const {sql,env}=fixture();
 try{
  await json(env,"/api/cloud/listening-refill/draft",original);
  const conv=original.router.conversations[0].id;
  sql.prepare("UPDATE listening_refill_clips SET status='uploaded' WHERE stimulus_id<>?").run(conv);
  await changeEnabled(env,true);
  await approveModel(env,lite,10);
  const res=await claim(env);
  assert.equal(res.data.result,"model-unavailable");
  assert.equal(sql.prepare("SELECT COUNT(*) n FROM listening_refill_model_attempts").get().n,0);
 }finally{sql.close();}
});

test("Flash may render short audio after no long clips remain pending",async()=>{
 const {sql,env}=fixture();
 try{
  await json(env,"/api/cloud/listening-refill/draft",original);
  const modules=[original.router,original.lowerModule,original.upperModule];
  const longIds=modules.flatMap(m=>[...m.conversations,...m.academicTalks].map(x=>x.id));
  for(const id of longIds)
   sql.prepare("UPDATE listening_refill_clips SET status='uploaded' WHERE stimulus_id=?").run(id);
  await changeEnabled(env,true);
  await approveModel(env,flash,1);
  const res=await claim(env);
  assert.equal(res.data.result,"claimed");
  assert.equal(res.data.model,flash);
  assert.ok(modules.flatMap(m=>[...m.listenChoose,...m.announcements].map(x=>x.id))
   .includes(res.data.stimulusId));
 }finally{sql.close();}
});
