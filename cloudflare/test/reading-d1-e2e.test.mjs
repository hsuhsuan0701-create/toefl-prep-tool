import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import Database from "better-sqlite3";
import worker from "../src/index.ts";

const host = "https://toefl-private.test";
const token = "test-secret-with-at-least-32-random-characters";
const setPath = new URL("../../data/question-sets/reading/rd-04b2ae46.json",import.meta.url);
const originalSet = JSON.parse(readFileSync(setPath,"utf8"));

function d1Mock() {
  const sqlite=new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const dir=new URL("../migrations/",import.meta.url);
  for(const name of readdirSync(dir).filter(x=>/\.sql$/.test(x)).sort()) {
    sqlite.exec(readFileSync(new URL(name,dir),"utf8"));
  }
  class Bound {
    constructor(sql,args=[]) {this.sql=sql;this.args=args;}
    bind(...args){return new Bound(this.sql,args);}
    first(){return Promise.resolve(sqlite.prepare(this.sql).get(...this.args)??null);}
    all(){return Promise.resolve({results:sqlite.prepare(this.sql).all(...this.args)});}
    run(){const res=sqlite.prepare(this.sql).run(...this.args);
      return Promise.resolve({meta:{changes:res.changes}});}
  }
  const DB={
    prepare(sql){return new Bound(sql);},
    async batch(stmts){
      const commit=sqlite.transaction(()=>stmts.map(s=>{
        const result=sqlite.prepare(s.sql).run(...s.args);
        return {meta:{changes:result.changes}};
      }));
      return commit();
    },
  };
  return {DB,sqlite,ASSETS:{fetch:async()=>new Response("SPA")},TOEFL_MANUAL_TEST_TOKEN:token};
}
function req(path,method="GET",body,auth=false) {
  return new Request(host+path,{
    method,
    ...(body===undefined?{}:{
      headers:{origin:host,"content-type":"application/json",...(auth?{authorization:"Bearer "+token}:{})},
      body:JSON.stringify(body)
    })
  });
}
async function call(env,path,method="GET",body,auth=false) {
  const result=await worker.fetch(req(path,method,body,auth),env);
  const data=await result.json();
  return {status:result.status,data};
}
function requestsForModule(set,module) {
  const mod=module==="router"?set.router:module==="upper"?set.upperModule:set.lowerModule;
  const result=[];
  if(mod.ctwPassages.length) result.push({taskType:"complete_words",items:mod.ctwPassages.flatMap(p=>p.gaps.map(g=>({itemId:g.id,typed:g.completion})))});
  if(mod.dailyLife.length) result.push({taskType:"daily_life",items:mod.dailyLife.flatMap(p=>p.questions.map(q=>({itemId:q.id,selectedOptionId:q.correctOptionId})))});
  if(mod.academic.length) result.push({taskType:"academic_passage",items:mod.academic.flatMap(p=>p.questions.map(q=>({itemId:q.id,selectedOptionId:q.correctOptionId})))});
  return result;
}

test("Original full Reading Set imported privately and stripped before learner receives it",async()=>{
  const env=d1Mock();
  try{
    const noAuth=await call(env,"/api/cloud/reading-sets/import","POST",originalSet);
    assert.equal(noAuth.status,401);
    const uploaded=await call(env,"/api/cloud/reading-sets/import","POST",originalSet,true);
    assert.equal(uploaded.status,201,JSON.stringify(uploaded.data));
    const duplicate=await call(env,"/api/cloud/reading-sets/import","POST",originalSet,true);
    assert.equal(duplicate.status,409);
    const list=await call(env,"/api/sets?kind=reading");
    assert.equal(list.status,200);
    assert.equal(list.data.length,1);
    assert.equal(list.data[0].id,originalSet.id);
    assert.equal(list.data[0].attempted,false);
    const shown=await call(env,"/api/sets/"+originalSet.id);
    assert.equal(shown.status,200);
    assert.equal(shown.data.kind,"reading");
    const wire=JSON.stringify(shown.data);
    for(const key of ["correctOptionId","explanationZh","sourceParagraph","generationPlan","completion"]) {
      assert.ok(!wire.includes('"'+key+'"'),"Answer-bearing field escaped: "+key);
    }
  }finally{env.sqlite.close();}
});

test("Original Reading Drill → D1 atomic scoring → Attempt review",async()=>{
  const env=d1Mock();
  try{
    assert.equal((await call(env,"/api/cloud/reading-sets/import","POST",originalSet,true)).status,201);
    const start=await call(env,"/api/attempts","POST",{kind:"reading",mode:"drill",setId:originalSet.id});
    assert.equal(start.status,201);
    const attemptId=start.data.attemptId;
    const academic=requestsForModule(originalSet,"router").find(r=>r.taskType==="academic_passage");
    const scored=await call(env,"/api/attempts/"+attemptId+"/score","POST",academic);
    assert.equal(scored.status,200,JSON.stringify(scored.data));
    assert.equal(scored.data.items.length,academic.items.length);
    assert.ok(scored.data.items.every(x=>x.correct && typeof x.explanationZh==="string"));
    const replay=await call(env,"/api/attempts/"+attemptId+"/score","POST",academic);
    assert.equal(replay.status,409);
    assert.equal(replay.data.alreadyScored,true);
    const finished=await call(env,"/api/attempts/"+attemptId+"/complete","POST",{});
    assert.equal(finished.status,200);
    assert.equal(finished.data.estimate,null,"Reading Drills cannot receive routed bands");
    const detail=await call(env,"/api/attempts/"+attemptId);
    assert.equal(detail.status,200);
    assert.equal(detail.data.attempt.status,"completed");
    assert.equal(detail.data.bandStatus.status,"not-applicable");
    assert.equal(detail.data.items.length,academic.items.length);
    assert.ok(detail.data.deterministicReview.length>0);
    const listing=await call(env,"/api/sets?kind=reading");
    assert.equal(listing.data[0].attempted,true);
  }finally{env.sqlite.close();}
});

test("Original Reading Simulation → Router → Upper → full score → persisted Table 3 result",async()=>{
  const env=d1Mock();
  try{
    await call(env,"/api/cloud/reading-sets/import","POST",originalSet,true);
    const unfinishedStart=await call(env,"/api/attempts","POST",{kind:"reading",mode:"simulation",setId:originalSet.id});
    const unfinished=await call(env,"/api/attempts/"+unfinishedStart.data.attemptId+"/complete","POST",{});
    assert.equal(unfinished.status,200);
    assert.equal(unfinished.data.estimate,null,"Unrouted simulation can finish but has no band");
    const start=await call(env,"/api/attempts","POST",{kind:"reading",mode:"simulation",setId:originalSet.id});
    assert.equal(start.status,201);
    const id=start.data.attemptId;
    const premature=await call(env,"/api/attempts/"+id+"/route","POST",{});
    assert.equal(premature.status,409);
    const early=await call(env,"/api/attempts/"+id+"/score","POST",requestsForModule(originalSet,"upper")[0]);
    assert.equal(early.status,409);
    for(const submission of requestsForModule(originalSet,"router")) {
      const scored=await call(env,"/api/attempts/"+id+"/score","POST",submission);
      assert.equal(scored.status,200,JSON.stringify(scored.data));
      assert.ok(scored.data.items.every(i=>!("key" in i)&&!("explanationZh" in i)));
    }
    const before=await call(env,"/api/attempts/"+id);
    assert.equal(before.status,200);
    assert.equal(before.data.marksWithheld,"attempt-in-progress");
    assert.equal(before.data.deterministicReview,undefined);
    assert.ok(before.data.items.every(i=>i.score===null));
    const routed=await call(env,"/api/attempts/"+id+"/route","POST",{});
    assert.equal(routed.status,200,JSON.stringify(routed.data));
    assert.equal(routed.data.path,"upper");
    const reroute=await call(env,"/api/attempts/"+id+"/route","POST",{});
    assert.equal(reroute.data.path,"upper");
    const lateRouter=await call(env,"/api/attempts/"+id+"/score","POST",requestsForModule(originalSet,"router")[0]);
    assert.equal(lateRouter.status,409);
    const wrong=await call(env,"/api/attempts/"+id+"/score","POST",requestsForModule(originalSet,"lowerModule")[0]);
    assert.equal(wrong.status,409);
    for(const submission of requestsForModule(originalSet,"upper")) {
      const scored=await call(env,"/api/attempts/"+id+"/score","POST",submission);
      assert.equal(scored.status,200,JSON.stringify(scored.data));
    }
    const completed=await call(env,"/api/attempts/"+id+"/complete","POST",{});
    assert.equal(completed.status,200,JSON.stringify(completed.data));
    assert.equal(completed.data.estimate?.method,"table3-v1");
    const reopened=await call(env,"/api/attempts/"+id);
    assert.equal(reopened.status,200);
    assert.equal(reopened.data.attempt.modulePath,"upper");
    assert.equal(reopened.data.bandStatus.status,"estimated");
    assert.ok(reopened.data.deterministicReview.length>10);
    const count=env.sqlite.prepare("SELECT COUNT(*) as n FROM item_results WHERE attempt_id=?").get(id).n;
    assert.ok(count>15);
    const attemptList=await call(env,"/api/attempts?kind=reading");
    assert.equal(attemptList.status,200);
    assert.equal(attemptList.data.items.find(a => a.id === id)?.estimate?.method,"table3-v1");
  }finally{env.sqlite.close();}
});
