import test from "node:test";
import assert from "node:assert/strict";
import { stripAcademicAnswers, gradeAcademic, handleAcademicApi } from "../src/academicPractice.ts";

const passage = Array.from({length:210},(_,i)=>["Tree","roots","share","fungal","nutrients","under","specific","conditions","across","forests"][i%10]).join(" ");
const draft = {
  title:"Forest Soil Networks",discipline:"Biology",passage,
  questions:Array.from({length:5},(_,i)=>({
    id:"q"+(i+1),stem:"What does the passage indicate?",skill:["main_idea","detail","inference","vocabulary","purpose"][i],
    correctOptionId:"B",explanationZh:"正確答案與文章論點相符，其他三個選項涉及本文並未支持的內容，故不能作為正解。",
    options:["A","B","C","D"].map(id=>({id,text:"Option "+id+" for question "+(i+1)}))
  }))
};
const url = "https://private.example";
const post = (path, body, headers={})=>new Request(url+path, {
  method:"POST", headers:{origin:url,"content-type":"application/json",...headers},body:JSON.stringify(body)
});
test("pre-submit view never exposes answer key, skill or explanation",()=>{
  const shown=stripAcademicAnswers(draft);
  assert.equal(shown.questions.length,5);
  const text=JSON.stringify(shown);
  assert.ok(!text.includes("correctOptionId"));
  assert.ok(!text.includes("explanationZh"));
  assert.ok(!text.includes('"skill"'));
  assert.equal(shown.questions[0].options.length,4);
});
test("grading is deterministic and rejects missing or forged options",()=>{
  const answers=Object.fromEntries(draft.questions.map(q=>[q.id,"B"]));
  const result=gradeAcademic(draft,answers);
  assert.equal(result.correctCount,5);
  assert.equal(result.totalCount,5);
  assert.equal(result.review[0].correctOptionId,"B");
  assert.throws(()=>gradeAcademic(draft,{q1:"B"}),/all five/);
  assert.throws(()=>gradeAcademic(draft,{...answers,q1:"X"}),/Unknown answer/);
  assert.throws(()=>gradeAcademic(draft,{...answers,q6:"A"}),/all five/);
});
test("unapproved draft is never returned by practice passage API",async()=>{
  const db={prepare(sql){assert.match(sql,/status='approved'/);return{bind(){return this;},first:async()=>null};}};
  const res=await handleAcademicApi(new Request(url+"/api/cloud/academic/draft-2026-11-14"),{DB:db});
  assert.equal(res.status,404);
});
test("approved reading response omits answer keys",async()=>{
  const db={prepare(sql){assert.match(sql,/status='approved'/);return{bind(){return this;},first:async()=>({content_json:JSON.stringify(draft)})};}};
  const res=await handleAcademicApi(new Request(url+"/api/cloud/academic/draft-2026-11-14"),{DB:db});
  assert.equal(res.status,200);
  const text=await res.text();
  assert.ok(!text.includes("correctOptionId"));
  assert.ok(!text.includes("explanationZh"));
});
test("practice submit scores server-side and writes durable review",async()=>{
  const writes=[];
  const db={prepare(sql){const prepared={
    bind(...args){this.args=args;return this;},
    first:async()=>({content_json:JSON.stringify(draft)}),
    run:async()=>{writes.push({sql,args:prepared.args});return{meta:{changes:1}}}
  };return prepared;}};
  const answers=Object.fromEntries(draft.questions.map(q=>[q.id,"B"]));
  const res=await handleAcademicApi(post("/api/cloud/academic/draft-2026-11-14/submit",{answers}),{DB:db});
  assert.equal(res.status,201);
  const result=await res.json();
  assert.equal(result.correctCount,5);
  assert.match(result.attemptId,/^[0-9a-f-]{36}$/);
  assert.equal(writes.length,1);
  assert.match(writes[0].sql,/INSERT INTO academic_practice_attempts/);
  assert.equal(JSON.parse(writes[0].args[4]).length,5);
});
test("review decision refuses absent admin token, even with all checks",async()=>{
  const data={draftId:"draft-2026-11-14",decision:"approve",note:"I independently checked the source text and all answers.",confirm:"REVIEW_DECISION",
    checklist:{factChecked:true,answersChecked:true,originalityChecked:true}};
  const db={prepare(){throw Error("Must not query D1");}};
  const res=await handleAcademicApi(post("/api/cloud/academic/review/decision",data),{DB:db,TOEFL_MANUAL_TEST_TOKEN:"a".repeat(48)});
  assert.equal(res.status,401);
});
test("approval refuses incomplete editorial checklist",async()=>{
  const data={draftId:"draft-2026-11-14",decision:"approve",note:"I independently reviewed the scientific claims.",confirm:"REVIEW_DECISION",
    checklist:{factChecked:false,answersChecked:true,originalityChecked:true}};
  const db={prepare(){throw Error("Must not query D1");}};
  const res=await handleAcademicApi(post("/api/cloud/academic/review/decision",data,{authorization:"Bearer "+"a".repeat(48)}),
    {DB:db,TOEFL_MANUAL_TEST_TOKEN:"a".repeat(48)});
  assert.equal(res.status,400);
});
test("approved passage history is accessible only after submission",async()=>{
  const db={prepare(sql){assert.match(sql,/SELECT id,draft_id,title,correct_count/);return{all:async()=>({results:[{
    id:"attempt-1",draft_id:"draft-2026-11-14",title:"Forest Soil Networks",
    correct_count:3,total_count:5,completed_at:"2026-11-14 13:00:00"
  }]})};}};
  const res=await handleAcademicApi(new Request(url+"/api/cloud/academic/attempts"),{DB:db});
  assert.equal(res.status,200);
  const body=await res.json();
  assert.equal(body.attempts[0].correctCount,3);
  assert.ok(!JSON.stringify(body).includes("correctOptionId"));
});
