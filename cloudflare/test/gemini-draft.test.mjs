import test from "node:test";
import assert from "node:assert/strict";
import { validateDraft, nearDuplicate, draftHash, geminiDraft } from "../src/geminiDraft.ts";

const passage = Array.from({ length: 210 }, (_, i) => ["Plants","interact","with","soil","organisms","through","complex","ecological","processes","daily"][i % 10]).join(" ");
const sample = {
  title: "Soil Ecosystems and Plants", discipline: "Biology", passage,
  questions: Array.from({length:5}, (_,i) => ({
    id: "q"+(i+1), stem: "What is a main point of the passage?", skill: ["main_idea","detail","inference","vocabulary","purpose"][i],
    options: ["plant ecosystems","bird migration","volcano activity","ocean salinity"].map((text,j)=>({id:["A","B","C","D"][j],text})),
    correctOptionId: "A",
    explanationZh: "正確答案對應植物與土壤生態系統主題，其他選項則偏離了題目所描述的背景與文章範圍。",
  }))
};
test("accept complete draft", () => assert.equal(validateDraft(sample).questions.length,5));
test("reject missing answer key", () => assert.throws(()=>validateDraft({...sample,questions:[{...sample.questions[0],correctOptionId:"Z"},...sample.questions.slice(1)]}), /Invalid answer/));
test("reject non-four-choice question", () => assert.throws(()=>validateDraft({...sample,questions:[{...sample.questions[0],options:sample.questions[0].options.slice(0,3)},...sample.questions.slice(1)]}), /four options/));
test("detect repeat", () => assert.equal(nearDuplicate(sample,[sample]),true));
test("stable fingerprint", async()=>assert.equal(await draftHash(sample),await draftHash({...sample})));
test("Gemini handles HTTP errors without printing keys", async()=>{
 await assert.rejects(geminiDraft("DUMMY_PRIVATE_KEY","example-model",[],async()=>new Response("provider error",{status:429})), /HTTP 429/);
});
test("Gemini validates response JSON before accepting draft",async()=>{
 const mock=async()=>Response.json({candidates:[{content:{parts:[{text:JSON.stringify(sample)}]}}]});
 assert.equal((await geminiDraft("DUMMY_PRIVATE_KEY","example-model",[],mock)).title,sample.title);
});
