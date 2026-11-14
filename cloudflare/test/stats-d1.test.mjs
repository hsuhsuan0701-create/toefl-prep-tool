import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {readFileSync,readdirSync} from "node:fs";
import worker from "../src/index.ts";
const host="https://private.test";
function setup(){
 const sql=new Database(":memory:");
 const dir=new URL("../migrations/",import.meta.url);
 for(const file of readdirSync(dir).filter(x=>x.endsWith(".sql")).sort())
  sql.exec(readFileSync(new URL(file,dir),"utf8"));
 class Q{
  constructor(query,args=[]){this.query=query;this.args=args;}
  bind(...args){return new Q(this.query,args);}
  first(){return Promise.resolve(sql.prepare(this.query).get(...this.args)??null);}
  all(){return Promise.resolve({results:sql.prepare(this.query).all(...this.args)});}
  run(){const result=sql.prepare(this.query).run(...this.args);return Promise.resolve({meta:{changes:result.changes}});}
 }
 const env={DB:{prepare(x){return new Q(x)},batch:async list=>list.map(x=>sql.prepare(x.query).run(...x.args))},ASSETS:{fetch:async()=>new Response("SPA")}};
 return {sql,env};
}
async function request(env,path,options={}){
 const r=await worker.fetch(new Request(host+path,options),env);
 const data=await r.json();
 return {status:r.status,data};
}
test("Practice summary and target GET work with zero attempts without imaginary bands",async()=>{
 const {sql,env}=setup();
 try{
  const summary=await request(env,"/api/stats/summary");
  assert.equal(summary.status,200,JSON.stringify(summary.data));
  assert.equal(summary.data.sections.length,0);
  assert.equal(summary.data.overall.band,null);
  assert.deepEqual(summary.data.overall.missingSections,["reading","listening","writing","speaking"]);
  assert.equal(summary.data.skillItems.length,0);
  const targets=await request(env,"/api/stats/settings");
  assert.equal(targets.status,200);
  assert.equal(targets.data.targets.reading,5.5);
 }finally{sql.close();}
});
test("target updates require same-origin JSON, and persist in existing D1 settings",async()=>{
 const {sql,env}=setup();
 try{
  const url="/api/stats/settings";
  const requestOptions={method:"PUT",headers:{origin:host,"content-type":"application/json"},
   body:JSON.stringify({targets:{reading:5,listening:4.5}})};
  assert.equal((await request(env,url,{...requestOptions,headers:{...requestOptions.headers,origin:"https://evil.test"}})).status,403);
  assert.equal((await request(env,url,requestOptions)).status,200);
  assert.equal((await request(env,url)).data.targets.listening,4.5);
  assert.equal(sql.prepare("SELECT value FROM settings WHERE key='target.reading'").get().value,"5");
 }finally{sql.close();}
});
test("completed Reading Simulation yields the original Stats VM, not an Overall with missing sections",async()=>{
 const {sql,env}=setup();
 try{
  sql.prepare("INSERT INTO attempts(id,kind,mode,set_id,status,module_path,is_repeat) VALUES('test-attempt','reading','simulation','rd-abc','in_progress',NULL,0)").run();
  const items=[
   ["complete_words","ctw1","router"],["daily_life","d1","router"],["academic_passage","a1","router"],
   ["complete_words","ctw2","upper"],["academic_passage","a2","upper"]
  ];
  const insert=sql.prepare(
   "INSERT INTO item_results(attempt_id,item_id,task_type,score,score_json,scoring_status,scored_at) VALUES(?,?,?,?,?,'scored',datetime('now'))"
  );
  for(const [task,id,module] of items.filter(x=>x[2]==="router"))
   insert.run("test-attempt",id,task,1,JSON.stringify({correct:true,module,skill:"detail"}));
  sql.prepare("UPDATE attempts SET module_path='upper' WHERE id='test-attempt'").run();
  for(const [task,id,module] of items.filter(x=>x[2]==="upper"))
   insert.run("test-attempt",id,task,1,JSON.stringify({correct:true,module,skill:"detail"}));
  sql.prepare("UPDATE attempts SET status=\'completed\',completed_at=datetime(\'now\') WHERE id=\'test-attempt\'").run();
  const coverage=items.map(([task])=>({taskType:task,itemCount:1,skippedCount:0}));
  sql.prepare(
   "INSERT INTO section_estimates(attempt_id,section,raw_detail,estimated_band,method) VALUES(?,'reading',?,?,?)"
  ).run("test-attempt",JSON.stringify({raw:1,coverage}),5,"table3-v1");
  const result=await request(env,"/api/stats/summary");
  assert.equal(result.status,200,JSON.stringify(result.data));
  assert.equal(result.data.overall.band,null);
  // All required Task Types exist for Router + Upper in this synthetic
  // fixture, so the canonical persisted-row guard accepts the Reading estimate.
  assert.equal(result.data.sections.length,1);
  assert.equal(result.data.sections[0].section,"reading");
  assert.equal(result.data.sections[0].band,5);
  assert.equal(result.data.overall.missingSections.length,3);
 }finally{sql.close();}
});
