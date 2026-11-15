/**
 * Private, OFFLINE manual review packet for a valid saved original Router.
 * No Gemini requests, no D1, no R2, no publication. Full transcripts and
 * answer keys are written ONLY to a local file under tmp/ (not logged).
 * Never commit/upload the generated review packet to a public repository.
 */
import {readFileSync,writeFileSync,mkdirSync,readdirSync} from "node:fs";
import {join,resolve,dirname,basename} from "node:path";
import {fileURLToPath} from "node:url";
import {ListeningGenerationInputSchema,ListeningSetSchema} from "../shared/src/index.ts";
const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const arg=process.argv.find(x=>x.startsWith("--file="));
if(!arg||!arg.slice(7))throw Error("Usage: node --import tsx scripts/review-listening-router.mjs --file=<private JSON path>");
const input=resolve(arg.slice(7));
const raw=JSON.parse(readFileSync(input,"utf8"));
const router=ListeningGenerationInputSchema.shape.router.parse(raw?.response??raw);
const outputDir=join(root,"tmp","listening-draft-pilots");
mkdirSync(outputDir,{recursive:true});
const safeName=basename(input).replace(/[^A-Za-z0-9._-]/g,"_").replace(/\.json$/i,"");
const output=join(outputDir,safeName+"-manual-review.md");
const wordCount=(s)=>s.trim().match(/\b[\w]+(?:['’-][\w]+)*\b/g)?.length??0;
const normalized=(s)=>String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu," ").trim();
const oldBank=new Set();
for(const name of readdirSync(join(root,"data","question-sets","listening"))){
 if(!/^lsn-[A-Za-z0-9_-]+\.json$/.test(name))continue;
 const s=ListeningSetSchema.parse(JSON.parse(readFileSync(join(root,"data","question-sets","listening",name),"utf8")));
 for(const m of [s.router,s.lowerModule,s.upperModule]){
  for(const x of m.listenChoose)oldBank.add(normalized(x.utterance));
  for(const x of m.conversations)oldBank.add(normalized(x.transcript.map(t=>t.text).join(" ")));
  for(const x of m.announcements)oldBank.add(normalized(x.transcript));
  for(const x of m.academicTalks)oldBank.add(normalized(x.transcript));
 }
}
const warnings=[];
const out=[
 "# TOEFL Listening Router｜人工內容審閱（私人，勿上傳 GitHub）",
 "",
 "本檔案從已生成的 Router JSON 離線建立，含未公開逐字稿與正確答案。",
 "**警告：Schema 通過只證明資料結構符合規格，不代表題目、正解或事實正確。**",
 "請逐題檢查是否真正只有一個正確答案、選項與逐字稿相符、語言自然、內容原創。",
 "此報告沒有呼叫 Gemini API、沒有寫入 D1、沒有產生音檔。",
 "",
 "## 統計",
 "",
 "| 題型 | 數量 |",
 "|---|---:|",
 `| Listen and Choose | ${router.listenChoose.length} |`,
 `| Conversation | ${router.conversations.length} |`,
 `| Announcement | ${router.announcements.length} |`,
 `| Academic Talk | ${router.academicTalks.length} |`,
 `| 合計 | ${router.listenChoose.length+router.conversations.length+router.announcements.length+router.academicTalks.length} |`,
 "",
 ];
const seen=new Set();
function note(id,reason){warnings.push(`${id}: ${reason}`);}
function record(id,spoken,low,high){
 const wc=wordCount(spoken);
 if(low!==null&&(wc<low||wc>high))note(id,`word count ${wc}，建議範圍 ${low}–${high}`);
 const norm=normalized(spoken);
 if(!norm)note(id,"逐字稿為空");
 if(oldBank.has(norm))note(id,"與原有題庫有完全相同的標準化逐字稿（僅偵測 exact match）");
 if(seen.has(id))note(id,"Router 內重複 stimulus ID");
 seen.add(id);
 return wc;
}
function showQuestions(x){
 if(Array.isArray(x.questions))for(let i=0;i<x.questions.length;i++){
  const q=x.questions[i];
  out.push(`**Question ${i+1}：${q.stem}**`,`Skill: ${q.skill}`, "");
  showOptions(q);
 }
 else showOptions(x);
}
function showOptions(q){
 const options=q.options.map(v=>normalized(v.text));
 if(new Set(options).size!==options.length)note(q.id,"選項文字重複");
 if(!q.options.some(v=>v.id===q.correctOptionId))note(q.id,"正解 ID 不存在於選項");
 for(const option of q.options){
  const correct=option.id===q.correctOptionId;
  out.push(`- ${correct?"**":""}${option.id}. ${option.text}${correct?"** （正解）":""}`);
 }
 out.push("",`解析（中文）：${q.explanationZh}`,"");
}
function start(id,title){
 out.push(`### ${title} — ${id}`,"","- [ ] **內容正確、題意清楚、正解唯一、與既有題庫無語意重複**","- [ ] **適合配音：發音自然、角色/語速/詞彙合適**","");
}
for(const [i,x] of router.listenChoose.entries()){
 start(x.id,`LCR ${i+1}`);
 const wc=record(x.id,x.utterance,4,8);
 out.push(`Speaker: ${x.speaker.role} / ${x.speaker.gender}`,`Utterance (${wc} words): ${x.utterance}`,"");
 showQuestions(x);
}
for(const [i,x] of router.conversations.entries()){
 start(x.id,`Conversation ${i+1}`);
 const script=x.transcript.map(t=>t.text).join(" ");
 const wc=record(x.id,script,80,150);
 if(x.transcript.length<6)note(x.id,`對話只有 ${x.transcript.length} 個 turns（建議 >=6）`);
 out.push(`Setting: ${x.setting} · ${wc} words · ${x.transcript.length} turns`,
  `Speakers: ${x.speakers.map(s=>s.id+" ("+s.role+", "+s.gender+")").join("; ")}`,"");
 for(const turn of x.transcript)out.push(`**${turn.speakerId}:** ${turn.text}`,"");
 showQuestions(x);
}
for(const [i,x] of router.announcements.entries()){
 start(x.id,`Announcement ${i+1}`);
 const wc=record(x.id,x.transcript,40,85);
 out.push(`Setting: ${x.setting} · Speaker: ${x.speaker.role} · ${wc} words`, "",x.transcript,"");
 showQuestions(x);
}
for(const [i,x] of router.academicTalks.entries()){
 start(x.id,`Academic Talk ${i+1}`);
 const wc=record(x.id,x.transcript,175,250);
 out.push(`Discipline: ${x.discipline} · Speaker: ${x.speaker.role} · ${wc} words`,"",x.transcript,"");
 showQuestions(x);
}
out.splice(out.indexOf("## 統計"),0,
  "## 自動提示（僅供人工複查）","",
  ...(warnings.length?warnings.map(w=>"- ⚠ "+w):["沒有找到此工具能檢出的格式／完全相同逐字稿問題；**仍須逐題人工檢查**。"]),
  "");
writeFileSync(output,out.join("\n"),{flag:"wx",mode:0o600});
console.log(JSON.stringify({result:"private-offline-review-packet",module:"router",
 stimuli:router.listenChoose.length+router.conversations.length+router.announcements.length+router.academicTalks.length,
 issuesForReview:warnings.length,outputPath:output,apiRequests:0,dbWrites:0,published:false,
 caveat:"Manual answer-key/novelty review required; no semantic or factual truth guarantee."},null,2));
