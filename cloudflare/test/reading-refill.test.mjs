import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import Database from "better-sqlite3";
import worker from "../src/index.ts";
import {
  refillReadingBank, unusedReadingSets, checkReadingQuality,
  MIN_UNATTEMPTED_READING_SETS,
} from "../src/readingRefill.ts";
import { ReadingSetSchema } from "../../shared/src/index.ts";
const host="https://private.test", secret="x".repeat(48);
const fixture=ReadingSetSchema.parse(JSON.parse(readFileSync(
  new URL("../../data/question-sets/reading/rd-04b2ae46.json",import.meta.url),"utf8"
)));
function setup(){
  const sql=new Database(":memory:");
  const dir=new URL("../migrations/",import.meta.url);
  for(const name of readdirSync(dir).filter(x=>x.endsWith(".sql")).sort())
    sql.exec(readFileSync(new URL(name,dir),"utf8"));
  class Statement{
    constructor(query,args=[]){this.query=query;this.args=args;}
    bind(...args){return new Statement(this.query,args);}
    first(){return Promise.resolve(sql.prepare(this.query).get(...this.args)??null);}
    all(){return Promise.resolve({results:sql.prepare(this.query).all(...this.args)});}
    run(){const changes=sql.prepare(this.query).run(...this.args).changes;return Promise.resolve({meta:{changes}});}
  }
  const DB={prepare(query){return new Statement(query);}};
  const env={DB,GEMINI_API_KEY:"mock-key",GEMINI_MODEL:"test-model",
    AI_READING_REFILL_ENABLED:"false",TOEFL_MANUAL_TEST_TOKEN:secret,
    ASSETS:{fetch:async()=>new Response("app")}};
  return {sql,env};
}
test("existing complete bank stays unchanged when at or above low-inventory threshold",async()=>{
  const {sql,env}=setup();
  try{
    for(let i=0;i<MIN_UNATTEMPTED_READING_SETS;i++)
      sql.prepare("INSERT INTO reading_sets(id,content_json) VALUES(?,?)")
        .run("rd-sample"+i,JSON.stringify({...fixture,id:"rd-sample"+i}));
    assert.equal(await unusedReadingSets(env.DB),3);
    let called=0;
    const result=await refillReadingBank(env,Date.UTC(2026,10,14),undefined,{manual:true,produce:async()=>{
      called++;return fixture;
    }});
    assert.equal(result.result,"skipped");
    assert.equal(called,0);
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM reading_refill_runs").get().n,0);
  }finally{sql.close();}
});
test("scheduled refill stays switched off until explicit enablement",async()=>{
  const {sql,env}=setup();
  try{
    let calls=0;
    const result=await refillReadingBank(env,Date.UTC(2026,10,14),undefined,{
      produce:async()=>{calls++;return fixture;}
    });
    assert.equal(result.result,"disabled");
    assert.equal(calls,0);
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM reading_refill_runs").get().n,0);
  }finally{sql.close();}
});
test("daily cost guard prevents repeat generation after an upstream failure",async()=>{
  const {sql,env}=setup();
  try{
    let calls=0;
    const produce=async()=>{calls++;throw Error("Gemini HTTP 503");};
    const first=await refillReadingBank(env,Date.UTC(2026,10,14),undefined,{manual:true,produce});
    assert.equal(first.result,"failed");
    assert.equal(first.reason,"Gemini HTTP 503");
    const again=await refillReadingBank(env,Date.UTC(2026,10,14),undefined,{manual:true,produce});
    assert.equal(again.result,"already-attempted");
    assert.equal(calls,1);
    assert.equal(sql.prepare("SELECT status FROM reading_refill_runs").get().status,"failed");
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM reading_sets").get().n,0);
  }finally{sql.close();}
});
test("admin endpoint requires secret, origin and explicit cost confirmation",async()=>{
  const {sql,env}=setup();
  try{
    const path=host+"/api/cloud/reading-refill/run-once";
    const send=(auth,origin,confirm)=>worker.fetch(new Request(path,{
      method:"POST",headers:{"Content-Type":"application/json",origin,
        ...(auth?{Authorization:"Bearer "+auth}:{})},
      body:JSON.stringify({confirm})
    }),env);
    assert.equal((await send(null,host,"REFILL_READING_ONCE")).status,401);
    assert.equal((await send(secret,"https://attacker.test","REFILL_READING_ONCE")).status,403);
    assert.equal((await send(secret,host,"WRONG")).status,400);
    assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM reading_refill_runs").get().n,0);
    const status=await worker.fetch(new Request(host+"/api/cloud/reading-refill/status"),env);
    assert.equal(status.status,200);
    assert.equal((await status.json()).unused,0);
  }finally{sql.close();}
});
test("original Reading schema is still authoritative for a full Set",()=>{
  const set=ReadingSetSchema.parse(fixture);
  assert.equal(set.kind,"reading");
  assert.ok(set.router.ctwPassages.length>0);
  assert.ok(set.lowerModule.academic.length>0);
  assert.ok(set.upperModule.academic.length>0);
  assert.throws(()=>checkReadingQuality({...set,upperModule:{
    ...set.upperModule,academic:[]
  }},[]),/Unexpected module composition/);
});
