import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import Database from "better-sqlite3";
import worker from "../src/index.ts";
const host="https://private.test",secret="x".repeat(48);
const set=JSON.parse(readFileSync(new URL("../../data/question-sets/listening/lsn-03948a55.json",import.meta.url),"utf8"));
function fixture(audioReady=true){
 const sql=new Database(":memory:");
 const dir=new URL("../migrations/",import.meta.url);
 for(const f of readdirSync(dir).filter(x=>x.endsWith(".sql")).sort())
  sql.exec(readFileSync(new URL(f,dir),"utf8"));
 class S{
  constructor(query,args=[]){this.query=query;this.args=args;}
  bind(...args){return new S(this.query,args);}
  first(){return Promise.resolve(sql.prepare(this.query).get(...this.args)??null);}
  all(){return Promise.resolve({results:sql.prepare(this.query).all(...this.args)});}
  run(){return Promise.resolve({meta:{changes:sql.prepare(this.query).run(...this.args).changes}});}
 }
 const db={prepare(q){return new S(q)},batch(statements){
  return Promise.resolve(sql.transaction(()=>statements.map(s=>({meta:{changes:sql.prepare(s.query).run(...s.args).changes}})))());
 }};
 const ASSETS={fetch:async(req)=>{
  if(new URL(req.url).pathname.startsWith("/listening-audio/")&&audioReady)
   return new Response(req.method==="HEAD"?null:"MP3 bytes",{status:200,headers:{"Content-Type":"audio/mpeg"}});
  return new Response("SPA fallback",{status:200,headers:{"Content-Type":"text/html"}});
 }};
 return {sql,env:{DB:db,ASSETS,TOEFL_MANUAL_TEST_TOKEN:secret}};
}
async function api(env,path,method="GET",body,token=false){
 const r=await worker.fetch(new Request(host+path,{method,...(body?{headers:{"Content-Type":"application/json",origin:host,...(token?{authorization:"Bearer "+secret}:{})},body:JSON.stringify(body)}:{})}),env);
 return {status:r.status,body:await r.json()};
}
const requests=(m)=>[
 ...[["listen_choose",m.listenChoose.map(i=>({itemId:i.id,selectedOptionId:i.correctOptionId}))],
 ["conversation",m.conversations.flatMap(s=>s.questions.map(q=>({itemId:q.id,selectedOptionId:q.correctOptionId})))],
 ["announcement",m.announcements.flatMap(s=>s.questions.map(q=>({itemId:q.id,selectedOptionId:q.correctOptionId})))],
 ["academic_talk",m.academicTalks.flatMap(s=>s.questions.map(q=>({itemId:q.id,selectedOptionId:q.correctOptionId})))]]
 .filter(([,items])=>items.length).map(([taskType,items])=>({taskType,items}))
];
test("Listening Set cannot be imported without every audio asset",async()=>{
 const {sql,env}=fixture(false);
 try{
  assert.equal((await api(env,"/api/cloud/listening-sets/import","POST",set,false)).status,401);
  const res=await api(env,"/api/cloud/listening-sets/import","POST",set,true);
  assert.equal(res.status,409,JSON.stringify(res.body));
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM listening_sets").get().n,0);
 }finally{sql.close();}
});
test("Original Listening Drill and adaptive simulation share scoring and D1 attempts",async()=>{
 const {sql,env}=fixture();
 try{
  const imported=await api(env,"/api/cloud/listening-sets/import","POST",set,true);
  assert.equal(imported.status,201,JSON.stringify(imported.body));
  assert.equal((await api(env,"/api/sets?kind=listening")).body.length,1);
  const publicSet=await api(env,"/api/sets/"+set.id);
  assert.equal(publicSet.status,200);
  assert.equal(publicSet.body.kind,"listening");
  const wire=JSON.stringify(publicSet.body);
  assert.ok(!wire.includes('"correctOptionId"'));
  assert.ok(!wire.includes('"transcript"'));
  const audio=await worker.fetch(new Request(host+"/api/audio/stimuli/"+set.id+"/lcr-r1.mp3"),env);
  assert.equal(audio.status,200);
  assert.match(audio.headers.get("content-type"),/audio\/mpeg/);
  const started=await api(env,"/api/attempts","POST",{kind:"listening",mode:"drill",setId:set.id});
  assert.equal(started.status,201,JSON.stringify(started.body));
  const id=started.body.attemptId;
  const part=requests(set.router)[0];
  const scored=await api(env,"/api/attempts/"+id+"/score","POST",part);
  assert.equal(scored.status,200,JSON.stringify(scored.body));
  assert.ok(scored.body.items.every(i=>i.correct&&i.key));
  const finish=await api(env,"/api/attempts/"+id+"/complete","POST",{});
  assert.equal(finish.status,200);
  assert.equal(finish.body.estimate,null);
  const sim=await api(env,"/api/attempts","POST",{kind:"listening",mode:"simulation",setId:set.id});
  assert.equal(sim.status,201);
  const simId=sim.body.attemptId;
  for(const request of requests(set.router)){
   const r=await api(env,"/api/attempts/"+simId+"/score","POST",request);
   assert.equal(r.status,200,JSON.stringify(r.body));
   assert.ok(r.body.items.every(x=>!("key" in x)));
  }
  const route=await api(env,"/api/attempts/"+simId+"/route","POST",{});
  assert.equal(route.status,200,JSON.stringify(route.body));
  assert.equal(route.body.path,"upper");
  for(const request of requests(set.upperModule)){
   const r=await api(env,"/api/attempts/"+simId+"/score","POST",request);
   assert.equal(r.status,200,JSON.stringify(r.body));
  }
  const done=await api(env,"/api/attempts/"+simId+"/complete","POST",{});
  assert.equal(done.status,200,JSON.stringify(done.body));
  assert.equal(done.body.estimate?.method,"table3-v1");
  const detail=await api(env,"/api/attempts/"+simId);
  assert.equal(detail.status,200);
  assert.equal(detail.body.attempt.kind,"listening");
  assert.equal(detail.body.estimate?.method,"table3-v1");
 }finally{sql.close();}
});
