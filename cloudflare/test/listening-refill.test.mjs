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
  const ids=[];
  for(let i=0;i<3;i++){
    const c=await claim(env);
    assert.equal(c.status,200,JSON.stringify(c.data));
    assert.equal(c.data.result,"claimed");
    assert.equal(c.data.slot,i+1);
    ids.push(c.data.stimulusId);
    assert.equal((await upload(env,original.id,c.data.stimulusId)).status,201);
  }
  assert.equal(new Set(ids).size,3);
  const fourth=await claim(env);
  assert.equal(fourth.data.result,"daily-limit");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM listening_refill_daily_attempts").get().n,3);
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
 }finally{sql.close();}
});
