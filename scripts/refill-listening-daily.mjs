/**
 * Bounded DAILY Listening synthesizer for a pre-approved, complete original-format
 * Set in Cloudflare's durable draft queue.
 *
 * This is NOT a generator of question content. No AI quality-review API.
 * It shares original buildRenderPlan/deliveryNotes/accent/pace with native Node.
 * Default is read-only. --execute needs a same-day human Free Tier attestation.
 * Claims are consumed on failure; rerunning does NOT repeat a paid clip.
 *
 * Needs one Cloudflare R2 bucket binding, migrated D1, TOEFL admin token,
 * Cloudflare Access service token where enabled, local ffmpeg and Gemini key.
 */
import {spawnSync} from "node:child_process";
import {mkdirSync,writeFileSync,existsSync} from "node:fs";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {ListeningSetSchema} from "../shared/src/index.ts";
import {buildRenderPlan,deliveryNotes,spokenWordCount} from "../server/src/services/listeningAudioRenderer.ts";
import {ACCENT_DIRECTION,pacingDirection} from "../server/src/services/audioPrompt.ts";
import {inspectPcmWav,inspectExpectedDuration} from "./lib/listening-audio-sanity.mjs";

const root=resolve(fileURLToPath(new URL("..",import.meta.url)));
const enabled=process.argv.includes("--execute");
const maxArg=Number(process.argv.find(x=>x.startsWith("--max="))?.slice(6)??3);
if(!Number.isInteger(maxArg)||maxArg<1||maxArg>20)throw Error("Daily max must be between 1 and 20");
const ALLOWED_TTS_MODELS=new Set(["gemini-3.8-flash-lite-tts","gemini-3.8-flash-tts"]);
const MIN_MODEL_INTERVAL_MS=65000;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const base=process.env.TOEFL_WORKER_URL||"https://toefl-prep-private.ihsuan0701.workers.dev";
const origin=new URL(base).origin;
if(!/^https:\/\//.test(origin))throw Error("Worker URL must be HTTPS");
const token=process.env.TOEFL_MANUAL_TEST_TOKEN;
const key=process.env.GEMINI_API_KEY;
const accessId=process.env.CF_ACCESS_CLIENT_ID,accessSecret=process.env.CF_ACCESS_CLIENT_SECRET;
function headers(extra={}){
 return {
  ...(accessId&&accessSecret?{"CF-Access-Client-Id":accessId,"CF-Access-Client-Secret":accessSecret}:{}),
  ...(token?{"Authorization":"Bearer "+token}:{}),
  ...extra,
 };
}
async function api(path,method="GET",body) {
 const r=await fetch(origin+path,{method,headers:headers(method==="POST"?
  {"Origin":origin,"Content-Type":"application/json"}:{}),
  ...(body===undefined?{}:{body:JSON.stringify(body)}),
  signal:AbortSignal.timeout(25000)});
 const raw=await r.text();
 let data;try{data=JSON.parse(raw)}catch{throw Error("Worker did not return JSON (HTTP "+r.status+"); check Cloudflare Access");}
 if(!r.ok)throw Error("Worker returned HTTP "+r.status+" ("+(data.error||"unknown")+")");
 return data;
}
const status=async()=>api("/api/cloud/listening-refill/status");
if(!enabled){
 if(!token || token.length<32){
  console.log("Dry-run only: Listening daily runner is disabled. Admin token missing; no quota consumed.");
 }else {
  const s=await status();
  console.log(JSON.stringify({dryRun:true,enabled:s.enabled,day:s.day,limit:s.limit,claimed:s.claimed,queue:s.queue,geminiCalls:0},null,2));
 }
 process.exit(0);
}
if(process.env.LISTENING_DAILY_REFILL_ENABLED!=="true")
 throw Error("Feature flag LISTENING_DAILY_REFILL_ENABLED is not true; refusing paid generation");
if(!key || !token || token.length<32)
 throw Error("GEMINI_API_KEY and TOEFL_MANUAL_TEST_TOKEN must both be set before claiming quota");
const ff=spawnSync("ffmpeg",["-version"],{encoding:"utf8",timeout:10000});
if(ff.error||ff.status!==0)throw Error("ffmpeg is required to produce final MP3s before consuming a claim");
const s=await status();
console.log(JSON.stringify({phase:"preflight",enabled:s.enabled,day:s.day,claimed:s.claimed,limit:s.limit,
 models:s.models,queue:s.queue.map(x=>({id:x.id,state:x.state,clips:x.clips}))},null,2));
if(!s.enabled){console.log("Listening auto-generation has been stopped in the private manager. No Gemini request.");process.exit(0);}
if(!Array.isArray(s.models)||!s.models.some(m=>
  ALLOWED_TTS_MODELS.has(m.model)&&m.ready&&m.freeTierVerifiedToday&&m.remaining>0)){
 console.log("No TTS model has a same-day Free Tier attestation and remaining quota; no Gemini request.");
 process.exit(0);
}
if(s.claimed>=s.limit){console.log("Daily quota already exhausted. No Gemini request.");process.exit(0);}
if(!s.queue.some(x=>(x.state==="draft"||x.state==="rendering")&&(x.clips?.pending||0)>0)){
 console.log("No prepared Listening draft with pending audio. No Gemini request.");
 process.exit(0);
}
const count=Math.min(maxArg,s.limit-s.claimed);
const lastSentAt=new Map();
for(let i=0;i<count;i++){
 // Check the remote stop switch before each new paid claim (not only at job start).
 const live=await status();
 if(!live.enabled){console.log("Stop switch activated; no further Gemini requests.");break;}
 let claim;
 try{
  claim=await api("/api/cloud/listening-refill/claim","POST",{confirm:"CLAIM_LISTENING_TTS_ONCE"});
 }catch(err){console.error("Claim failed; no TTS requested: "+err.message);process.exitCode=1;break;}
 if(claim.result!=="claimed"){console.log("Queue: "+claim.result);break;}
 const id=claim.setId,stimulus=claim.stimulusId;
 // Never trust a remote response to choose an arbitrary billable model.
 const model=claim.model;
 const authorizedModel=live.models?.find(m=>m.model===model&&m.freeTierVerifiedToday&&
   m.ready&&m.remaining>0);
 if(!ALLOWED_TTS_MODELS.has(model)||claim.day!==live.day||!authorizedModel){
  console.error("Claimed model lacks same-day Free Tier authorization; no Gemini request.");
  process.exitCode=1;break;
 }
 const dir=join(root,"tmp","listening-daily",id);
 mkdirSync(dir,{recursive:true});
 const wavPath=join(dir,stimulus+".wav"),mp3Path=join(dir,stimulus+".mp3");
 try{
  if(existsSync(wavPath)||existsSync(mp3Path))
   throw Error("A prior local file exists; do not regenerate (quota already claimed)");
  const set=ListeningSetSchema.parse(claim.draft);
  const spec=buildRenderPlan(set).find(c=>c.stimulusId===stimulus);
  if(!spec)throw Error("Claimed stimulus missing from original Listening render plan");
  const notes=deliveryNotes(spec);
  const style=[notes.audioProfile,notes.scene,notes.style,ACCENT_DIRECTION[notes.accent],
    pacingDirection(notes.band),"Speak only the assigned spoken text, without extra words."].join(". ");
  const parts=spec.speakers?.length?
    spec.text.split("\n").map(line=>{
      const speaker=spec.speakers.find(x=>line.startsWith(x.speaker+": "));
      if(!speaker)throw Error("Bad original speaker label");
      return {text:line.slice(speaker.speaker.length+2),speechMetadata:{speaker:speaker.speaker,style}};
    }):[{text:spec.text,speechMetadata:{style}}];
  const speechConfig=spec.speakers?.length?
    {multiSpeakerVoiceConfig:{speakerVoiceConfigs:spec.speakers.map(s=>({
      speaker:s.speaker,voiceConfig:{voice:s.voice}
    }))}}:{voiceConfig:{voice:spec.voice}};
  // Conservative <=1 request per 65 s per model within this runner (never an API retry).
  const last=lastSentAt.get(model);
  if(last!==undefined&&Date.now()-last<MIN_MODEL_INTERVAL_MS)
    await sleep(MIN_MODEL_INTERVAL_MS-(Date.now()-last));
  lastSentAt.set(model,Date.now());
  const tts=await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent",
    {method:"POST",headers:{"Content-Type":"application/json","x-goog-api-key":key},
      body:JSON.stringify({contents:[{role:"user",parts}],generationConfig:{
        responseModalities:["AUDIO"],speechConfig}}),signal:AbortSignal.timeout(120000)});
  if(!tts.ok)throw Error("Gemini TTS HTTP "+tts.status+"; no retry will occur");
  const parsed=await tts.json();
  const audio=parsed.candidates?.[0]?.content?.parts?.find(p=>p.inlineData?.data)?.inlineData;
  if(!audio?.data)throw Error("Gemini returned no audio");
  const raw=Buffer.from(audio.data,"base64");
  // Free offline integrity, duration and silence checks. No transcription API.
  const checked=inspectPcmWav(raw);
  const expected=inspectExpectedDuration(checked,spokenWordCount(spec.text,spec.speakers),notes.band.targetWpm);
  writeFileSync(wavPath,raw,{flag:"wx"});
  if(!expected.durationPlausible)throw Error("Implausible speech duration; WAV quarantined for review");
  const converted=spawnSync("ffmpeg",["-hide_banner","-loglevel","error","-n","-i",wavPath,
    "-codec:a","libmp3lame","-qscale:a","3",mp3Path],{encoding:"utf8",timeout:90000});
  if(converted.error||converted.status!==0)throw Error("MP3 conversion failed; WAV kept, claim consumed");
  const mp3=(await import("node:fs")).readFileSync(mp3Path);
  if(mp3.length<1024||mp3.length>8*1024*1024)throw Error("Invalid MP3 size; claim consumed");
  const upload=await fetch(origin+"/api/cloud/listening-refill/upload?setId="+encodeURIComponent(id)+
    "&stimulusId="+encodeURIComponent(stimulus),{
      method:"POST",headers:headers({"Origin":origin,"Content-Type":"audio/mpeg",
        "Content-Length":String(mp3.length)}),body:mp3,signal:AbortSignal.timeout(45000)});
  if(!upload.ok)throw Error("MP3 upload uncertain (HTTP "+upload.status+"); do NOT regenerate");
  console.log(JSON.stringify({result:"uploaded",setId:id,stimulus,day:claim.day,slot:claim.slot,
    model,durationSec:checked.durationSec,roughWpm:expected.roughWpm,
    longSilences:checked.longSilences.length,
    manualListeningRequired:true,geminiApiCallsThisSlot:1}));
 }catch(e){
  console.error(JSON.stringify({result:"claimed-but-not-uploaded",setId:id,stimulus,
   error:e instanceof Error?e.message:"unknown",
   chargedSlotConsumed:true,autoRetry:false}));
  process.exitCode=1;
  break; // stop rather than spending another request when quality or upload uncertain
 }
}
