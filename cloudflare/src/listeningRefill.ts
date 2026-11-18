/**
 * Original Listening Set queue: one private draft, daily model-scoped TTS
 * claims only with same-day Free Tier attestation, durable audio, manual publication.
 *
 * This Worker NEVER invokes Gemini, ffmpeg, speech transcription or an AI judge.
 * A separately scheduled Node runner may use a claim ONCE to synthesize, then
 * perform offline WAV checks + MP3 encoding and upload it here.
 *
 * Important: a claimed slot is consumed even if synthesis fails or process
 * crashes. Nothing silently recharges the API to replace it.
 */
import { ListeningSetSchema, type ListeningSet } from "@toefl-prep/shared";
import { indexDeterministicItems } from "../../server/src/services/deterministicScoring.js";
import { listeningClips } from "./listeningAudio.js";
import { authorizedAdmin, validPost } from "./academicPractice.js";
import { handleListeningStaging } from "./listeningStaging.js";
import { listeningStagingPage } from "./listeningStagingPage.js";
import { reserveStatus, setReserveAutoRelease } from "./listeningReserve.js";

export interface ListeningRefillEnv {
  DB: D1Database;
  TOEFL_MANUAL_TEST_TOKEN?: string;
  LISTENING_AUDIO?: R2Bucket;
}
const NO_CACHE={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};
const reply=(data:unknown,status=200)=>Response.json(data,{status,headers:NO_CACHE});
const SAFE=/^lsn-[A-Za-z0-9_-]{1,60}$/;
const SAFE_STIMULUS=/^[A-Za-z0-9_-]{1,64}$/;
const MAX_MP3_BYTES=8*1024*1024;
export const TTS_MODELS=[
  "gemini-3.8-flash-lite-tts",
  "gemini-3.8-flash-tts",
] as const;
type TtsModel=typeof TTS_MODELS[number];
type TtsPolicy={dailyLimit:number;confirmedDay:string};
type ModelState={model:TtsModel;dailyLimit:number;claimed:number;remaining:number;
  freeTierVerifiedToday:boolean;ready:boolean};
const MAX_MODEL_DAILY=10;
const policyKey=(model:TtsModel)=>"listening_tts_model_policy_"+model;
function isTtsModel(value:unknown):value is TtsModel{
 return typeof value==="string"&&(TTS_MODELS as readonly string[]).includes(value);
}
/** A human must re-confirm the project is unbilled, with actual AI Studio RPD, each Pacific day.
 * This is an explicit attestation, not a claim that Google billing status can be read by Worker.
 * All missing, malformed or stale policy rows fail closed. */
async function modelStates(db:D1Database,day:string):Promise<ModelState[]>{
 return Promise.all(TTS_MODELS.map(async model=>{
  const row=await db.prepare("SELECT value FROM settings WHERE key=?").bind(policyKey(model))
    .first<{value:string}>();
  let policy:Partial<TtsPolicy>|null=null;
  try{policy=row?JSON.parse(row.value) as Partial<TtsPolicy>:null;}catch{policy=null;}
  const confirmed=policy?.confirmedDay===day;
  const cap=confirmed&&Number.isInteger(policy?.dailyLimit)&&
    (policy?.dailyLimit??0)>=0&&(policy?.dailyLimit??0)<=MAX_MODEL_DAILY?
      policy!.dailyLimit!:0;
  const used=await db.prepare(
    "SELECT COUNT(*) AS n FROM listening_refill_model_attempts WHERE day=? AND model=?"
  ).bind(day,model).first<{n:number}>();
  const claimed=used?.n??0;
  return {model,dailyLimit:cap,claimed,remaining:Math.max(0,cap-claimed),
    freeTierVerifiedToday:confirmed,ready:confirmed&&cap>claimed};
 }));
}
function isLongSpeech(set:ListeningSet,stimulusId:string):boolean{
 const modules=[set.router,set.lowerModule,set.upperModule];
 return modules.some(m=>
  m.conversations.some(x=>x.id===stimulusId)||m.academicTalks.some(x=>x.id===stimulusId));
}

/** Fail closed: no row or database error must never authorize new paid TTS. */
export async function listeningRefillEnabled(db:D1Database):Promise<boolean>{
  const row=await db.prepare("SELECT value FROM settings WHERE key='listening_refill_enabled'")
    .first<{value:string}>();
  return row?.value==="true";
}
export function ttsQuotaDay(now=new Date()):string{
  // Google rate limits renew midnight US Pacific. Use its civil date, not UTC.
  const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",
    year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
  const get=(type:string)=>parts.find(x=>x.type===type)?.value;
  return get("year")+"-"+get("month")+"-"+get("day");
}
function allIds(set:ListeningSet):string[]{
  return [set.router,set.lowerModule,set.upperModule].flatMap(m=>[
    ...m.listenChoose,...m.conversations,...m.announcements,...m.academicTalks
  ]).map(item=>item.id);
}
type DraftRow={id:string;content_json:string;state:string};
type ClipRow={stimulus_id:string;status:string;ordinal:number;claim_day:string|null;object_key:string|null};
async function getDraft(db:D1Database,id:string):Promise<DraftRow|null>{
  if(!SAFE.test(id))return null;
  return db.prepare("SELECT id,content_json,state FROM listening_refill_drafts WHERE id=?")
    .bind(id).first<DraftRow>();
}
async function getClip(db:D1Database,id:string,stimulus:string):Promise<ClipRow|null>{
  return db.prepare("SELECT stimulus_id,status,ordinal,claim_day,object_key FROM listening_refill_clips WHERE set_id=? AND stimulus_id=?")
    .bind(id,stimulus).first<ClipRow>();
}
const objectKey=(setId:string,stimulusId:string)=>"stimuli/"+setId+"/"+stimulusId+".mp3";
function isMp3(buf:Uint8Array):boolean{
  return buf.length>1024 && (new TextDecoder().decode(buf.subarray(0,3))==="ID3" ||
      (buf[0]===0xff && (buf[1]&0xe0)===0xe0));
}
export async function handleListeningRefill(req:Request,env:ListeningRefillEnv):Promise<Response|null>{
  const url=new URL(req.url),path=url.pathname,method=req.method;
  if(!path.startsWith("/api/cloud/listening-refill/"))return null;
  // The HTML shell contains no private data; every data/audio/decision request is authenticated.
  if(path==="/api/cloud/listening-refill/review" && method==="GET")return listeningStagingPage();
  if(!await authorizedAdmin(req,env.TOEFL_MANUAL_TEST_TOKEN))return reply({error:"Unauthorized"},401);
  if(path==="/api/cloud/listening-refill/status" && method==="GET"){
    try{
      const rows=await env.DB.prepare("SELECT id,state,created_at FROM listening_refill_drafts ORDER BY created_at DESC LIMIT 10")
        .all<{id:string;state:string;created_at:string}>();
      const day=ttsQuotaDay();
      const models=await modelStates(env.DB,day);
      const summary=await Promise.all(rows.results.map(async draft=>{
        const counts=await env.DB.prepare("SELECT status,COUNT(*) AS n FROM listening_refill_clips WHERE set_id=? GROUP BY status")
          .bind(draft.id).all<{status:string;n:number}>();
        return {...draft,clips:Object.fromEntries(counts.results.map(x=>[x.status,x.n]))};
      }));
      return reply({day,limit:models.reduce((n,x)=>n+x.dailyLimit,0),
        claimed:models.reduce((n,x)=>n+x.claimed,0),models,queue:summary,
        enabled:await listeningRefillEnabled(env.DB),r2Configured:!!env.LISTENING_AUDIO,
        ttsCallsByWorker:0,freeTierAttestationRequiredDaily:true});
    }catch{return reply({error:"Listening refill migrations not ready"},503);}
  }

  if(path==="/api/cloud/listening-refill/reserve-status" && method==="GET"){
    try{return reply(await reserveStatus(env.DB));}
    catch{return reply({error:"Unable to check Listening reserve"},503);}
  }
  if(path==="/api/cloud/listening-refill/reserve-settings" && method==="POST"){
    if(!validPost(req))return reply({error:"Same-origin JSON required"},403);
    const body=await req.json().catch(()=>null) as {enabled?:unknown;confirm?:unknown}|null;
    if(typeof body?.enabled!=="boolean"||body.confirm!=="SET_LISTENING_RESERVE_AUTO_RELEASE")
      return reply({error:"Explicit Listening reserve preference required"},400);
    try{return reply(await setReserveAutoRelease(env.DB,body.enabled));}
    catch{return reply({error:"Could not update Listening reserve setting"},503);}
  }

  // Private staging/API audition is independently safe and never invokes Gemini.
  const stageResponse=await handleListeningStaging(req,env);
  if(stageResponse)return stageResponse;
  if(method!=="POST")return reply({error:"Unsupported method"},405);
  if(path!=="/api/cloud/listening-refill/upload" && !validPost(req))
    return reply({error:"Same-origin JSON required"},403);
  if(path==="/api/cloud/listening-refill/upload" &&
      (req.headers.get("origin")!==url.origin || req.headers.get("content-type")?.split(";")[0].toLowerCase()!=="audio/mpeg"))
    return reply({error:"Same-origin audio/mpeg required"},403);

  if(path==="/api/cloud/listening-refill/settings"){
    const body=await req.json().catch(()=>null) as {enabled?:unknown;confirm?:string}|null;
    if(body?.confirm!=="SET_LISTENING_AUTO_REFILL"||typeof body.enabled!=="boolean")
      return reply({error:"Explicit enable/disable confirmation required"},400);
    if(body.enabled && !env.LISTENING_AUDIO)
      return reply({error:"R2 bucket is not configured; activation rejected"},503);
    try{
      await env.DB.prepare(
        "INSERT INTO settings(key,value) VALUES('listening_refill_enabled',?) "+
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      ).bind(body.enabled?"true":"false").run();
      return reply({enabled:body.enabled,stopped:!body.enabled,
        note:body.enabled?"Only manually attested model limits may claim clips; Google billing is not verified automatically":
          "No further TTS claims will be accepted. An already submitted upstream request may finish."});
    }catch{return reply({error:"Unable to update Listening refill setting"},503);}
  }
  if(path==="/api/cloud/listening-refill/model-policy"){
    const body=await req.json().catch(()=>null) as
      {model?:unknown;dailyLimit?:unknown;confirm?:unknown}|null;
    if(!isTtsModel(body?.model)||!Number.isInteger(body?.dailyLimit)||
       typeof body?.dailyLimit!=="number"||body.dailyLimit<0||body.dailyLimit>MAX_MODEL_DAILY||
       body.confirm!==(body.dailyLimit===0?"DISABLE_TTS_MODEL":"I_VERIFIED_FREE_TIER_TODAY"))
      return reply({error:"Only allowlisted TTS models, 0-10 daily calls and explicit free-tier verification are accepted"},400);
    const day=ttsQuotaDay();
    // The daily ceiling must be copied from AI Studio, not inferred from pricing pages.
    // A zero cap disables this model; a nonzero cap expires at next Pacific midnight.
    try{
      await env.DB.prepare("INSERT INTO settings(key,value) VALUES(?,?) "+
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .bind(policyKey(body.model),JSON.stringify({dailyLimit:body.dailyLimit,confirmedDay:day})).run();
      return reply({model:body.model,dailyLimit:body.dailyLimit,confirmedDay:day,
        attestedNotVerifiedByGoogle:true,expiresAtPacificMidnight:true});
    }catch{return reply({error:"Model policy could not be saved; refusing TTS"},503);}
  }
  if(path==="/api/cloud/listening-refill/draft"){
    const txt=await req.text().catch(()=>"");
    if(txt.length>450_000)return reply({error:"Listening draft too large"},413);
    let input:unknown;
    try{input=JSON.parse(txt);}catch{return reply({error:"Invalid JSON"},400);}
    const parsed=ListeningSetSchema.safeParse(input);
    if(!parsed.success || !SAFE.test(parsed.data?.id??""))return reply({error:"Invalid canonical Listening Set"},400);
    const set=parsed.data;
    try{
      indexDeterministicItems(set);
      const audio=listeningClips(set);
      const stimuli=allIds(set);
      if(audio.length!==36 || stimuli.length!==36 || new Set(stimuli).size!==36 ||
         !stimuli.every(SAFE_STIMULUS.test.bind(SAFE_STIMULUS)))
        return reply({error:"Expected a complete original-format 36-clip Listening Set"},400);
      const existing=await env.DB.prepare("SELECT id FROM listening_sets WHERE id=?")
        .bind(set.id).first();
      if(existing)return reply({error:"A published set already owns this ID"},409);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO listening_refill_drafts(id,content_json,state) VALUES(?,?,'draft')")
          .bind(set.id,JSON.stringify(set)),
        ...stimuli.map((id,ordinal)=>env.DB.prepare(
          "INSERT INTO listening_refill_clips(set_id,stimulus_id,ordinal) VALUES(?,?,?)"
        ).bind(set.id,id,ordinal)),
      ]);
      return reply({setId:set.id,status:"draft",clips:36,published:false},201);
    }catch{return reply({error:"Draft already exists or cannot be saved"},409);}
  }
  if(path==="/api/cloud/listening-refill/claim"){
    const body=await req.json().catch(()=>null) as {confirm?:string}|null;
    if(body?.confirm!=="CLAIM_LISTENING_TTS_ONCE")return reply({error:"Explicit claim confirmation required"},400);
    try{
      if(!await listeningRefillEnabled(env.DB))
        return reply({result:"disabled",enabled:false,ttsCalls:0});
    }catch{return reply({error:"Unable to verify stop switch; no TTS claim issued"},503);}
    if(!env.LISTENING_AUDIO)return reply({error:"R2 bucket not configured; refusing to spend TTS"},503);
    try{
      // A completed R2 staging upload remains "claimed" until a human reviews it.
      // Allow more clips to be staged for a nightly review, but NEVER proceed if
      // even one claimed clip lacks a durable pending_review ledger row.
      // This fails closed on interrupted, failed or ambiguous Gemini/R2 attempts.
      const awaiting=await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM listening_refill_clips c WHERE c.status='claimed' " +
        "AND NOT EXISTS (SELECT 1 FROM listening_auto_review_staged s " +
        "WHERE s.set_id=c.set_id AND s.stimulus_id=c.stimulus_id " +
        "AND s.status='pending_review')"
      ).first<{n:number}>();
      if((awaiting?.n??0)>0)return reply({result:"awaiting-review-or-reconciliation",
        awaiting:awaiting!.n,ttsCalls:0});
      const day=ttsQuotaDay();
      const models=await modelStates(env.DB,day);
      if(!models.some(m=>m.ready))return reply({
        result:models.some(m=>m.freeTierVerifiedToday)?"daily-limit":"free-tier-unverified",
        day,claimed:models.reduce((n,m)=>n+m.claimed,0),ttsCalls:0,
      });
      const active=await env.DB.prepare(
        "SELECT id,content_json,state FROM listening_refill_drafts WHERE state IN ('draft','rendering') ORDER BY created_at ASC,id ASC LIMIT 1"
      ).first<DraftRow>();
      if(!active)return reply({result:"no-draft"});
      const pending=await env.DB.prepare(
        "SELECT stimulus_id,status,ordinal,claim_day,object_key FROM listening_refill_clips WHERE set_id=? AND status='pending' ORDER BY ordinal"
      ).bind(active.id).all<ClipRow>();
      if(!pending.results.length)return reply({result:"no-pending",setId:active.id});
      const set=ListeningSetSchema.parse(JSON.parse(active.content_json));
      const lite=models.find(m=>m.model===TTS_MODELS[0]);
      const flash=models.find(m=>m.model===TTS_MODELS[1]);
      const longWaiting=pending.results.some(c=>isLongSpeech(set,c.stimulus_id));
      let chosen:{clip:ClipRow;candidate:ModelState}|null=null;
      for(const clip of pending.results){
        const long=isLongSpeech(set,clip.stimulus_id);
        // A prior Lite Conversation trial was unstable. Never use Lite for long audio.
        // Reserve Flash for all waiting long clips before allowing short-audio overflow.
        const candidate=long?(flash?.ready?flash:null):
          (lite?.ready?lite:flash?.ready&&!longWaiting?flash:null);
        if(candidate){chosen={clip,candidate};break;}
      }
      if(!chosen)return reply({result:"model-unavailable",ttsCalls:0});
      const {clip,candidate}=chosen;
      const {model,dailyLimit,claimed}=candidate;
      const slot=claimed+1;
      // Atomic, model-scoped ledger insertion is mandatory before a paid request.
      // Unique(day,set_id,stimulus_id) prevents a manual reset from reusing today's claim
      // even with a different model. Failed/aborted attempts never refund a slot.
      const writes=await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO listening_refill_model_attempts(day,model,slot,set_id,stimulus_id) "+
          "SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM listening_refill_model_attempts WHERE day=? AND model=?) < ? "+
          "AND NOT EXISTS(SELECT 1 FROM listening_refill_model_attempts WHERE day=? AND set_id=? AND stimulus_id=?)"
        ).bind(day,model,slot,active.id,clip.stimulus_id,
          day,model,dailyLimit,day,active.id,clip.stimulus_id),
        env.DB.prepare(
          "UPDATE listening_refill_clips SET status='claimed',claim_day=?,claimed_at=datetime('now') "+
          "WHERE set_id=? AND stimulus_id=? AND status='pending' "+
          "AND EXISTS(SELECT 1 FROM listening_refill_model_attempts "+
          "WHERE day=? AND model=? AND slot=? AND set_id=? AND stimulus_id=?)"
        ).bind(day,active.id,clip.stimulus_id,day,model,slot,active.id,clip.stimulus_id),
        env.DB.prepare(
          "UPDATE listening_refill_drafts SET state='rendering',updated_at=datetime('now') WHERE id=? AND state='draft'"
        ).bind(active.id),
      ]);
      // A conditional INSERT can affect zero rows without throwing on a losing
      // concurrent claim. Never return the other worker's paid claim as ours.
      if(writes[0]?.meta?.changes!==1||writes[1]?.meta?.changes!==1)
        return reply({result:"conflict-no-tts",ttsCalls:0},409);
      const confirmed=await getClip(env.DB,active.id,clip.stimulus_id);
      if(confirmed?.status!=="claimed"||confirmed.claim_day!==day)
        return reply({result:"conflict-no-tts"},409);
      return reply({result:"claimed",day,slot,model,setId:active.id,stimulusId:clip.stimulus_id,
        draft:set,quotaLimit:dailyLimit,autoRetry:false,freeTierAttestedToday:true});
    }catch{return reply({error:"Claim conflict; do not generate audio"},409);}
  }
  if(path==="/api/cloud/listening-refill/upload"){
    if(!env.LISTENING_AUDIO)return reply({error:"R2 bucket not configured"},503);
    const setId=url.searchParams.get("setId")??"",stimulus=url.searchParams.get("stimulusId")??"";
    if(!SAFE.test(setId)||!SAFE_STIMULUS.test(stimulus))return reply({error:"Invalid clip identifier"},400);
    const clip=await getClip(env.DB,setId,stimulus).catch(()=>null);
    if(!clip || clip.status!=="claimed")return reply({error:"Clip not claimed or already uploaded"},409);
    const declared=Number(req.headers.get("content-length"));
    if(!Number.isSafeInteger(declared)||declared<1024||declared>MAX_MP3_BYTES)
      return reply({error:"Invalid MP3 content length"},413);
    const buf=new Uint8Array(await req.arrayBuffer());
    if(buf.length!==declared||!isMp3(buf))return reply({error:"Malformed or incomplete MP3"},400);
    const key=objectKey(setId,stimulus);
    try{
      const attempt=await env.DB.prepare(
        "SELECT model FROM listening_refill_model_attempts WHERE day=? AND set_id=? AND stimulus_id=?"
      ).bind(clip.claim_day,setId,stimulus).first<{model:string}>();
      if(!isTtsModel(attempt?.model))return reply({error:"No attested claim model for clip"},409);
      if(await env.LISTENING_AUDIO.head(key))return reply({error:"Clip already exists; manual reconciliation required"},409);
      await env.LISTENING_AUDIO.put(key,buf,{httpMetadata:{contentType:"audio/mpeg"},
        customMetadata:{ttsModel:attempt.model}});
      await env.DB.batch([
        env.DB.prepare("UPDATE listening_refill_clips SET status='uploaded',object_key=?,bytes=?,uploaded_at=datetime('now') "+
          "WHERE set_id=? AND stimulus_id=? AND status='claimed'").bind(key,buf.length,setId,stimulus),
        env.DB.prepare("UPDATE listening_refill_model_attempts SET status='uploaded' "+
          "WHERE set_id=? AND stimulus_id=? AND status='claimed'").bind(setId,stimulus),
      ]);
      return reply({result:"uploaded",setId,stimulusId:stimulus,model:attempt.model,bytes:buf.length},201);
    }catch{return reply({error:"Upload status uncertain. Do not regenerate; inspect R2 and D1 manually."},503);}
  }
  if(path==="/api/cloud/listening-refill/flag"){
    const body=await req.json().catch(()=>null) as {setId?:string;stimulusId?:string;confirm?:string}|null;
    if(body?.confirm!=="FLAG_BAD_AUDIO"||!SAFE.test(body?.setId??"")||!SAFE_STIMULUS.test(body?.stimulusId??""))
      return reply({error:"Invalid flag confirmation"},400);
    const result=await env.DB.prepare("UPDATE listening_refill_clips SET status='flagged' "+
      "WHERE set_id=? AND stimulus_id=? AND status IN ('claimed','uploaded')")
      .bind(body!.setId,body!.stimulusId).run();
    if(result.meta.changes!==1)return reply({error:"Clip cannot be flagged"},409);
    await env.DB.prepare("UPDATE listening_refill_drafts SET state='blocked',updated_at=datetime('now') WHERE id=? AND state<>'published'")
      .bind(body!.setId).run();
    return reply({result:"blocked",setId:body!.setId,stimulusId:body!.stimulusId});
  }
  // Explicit recovery only: a human must flag and then authorize a fresh
  // attempt. The old daily slot remains consumed. Never automatic.
  if(path==="/api/cloud/listening-refill/reset-flagged"){
    if(!env.LISTENING_AUDIO)return reply({error:"R2 bucket not configured"},503);
    const body=await req.json().catch(()=>null) as {setId?:string;stimulusId?:string;confirm?:string}|null;
    if(body?.confirm!=="RESET_FLAGGED_NEXT_DAY"||!SAFE.test(body?.setId??"")||
        !SAFE_STIMULUS.test(body?.stimulusId??""))return reply({error:"Explicit recovery confirmation required"},400);
    const clip=await getClip(env.DB,body!.setId!,body!.stimulusId!);
    if(!clip||clip.status!=="flagged")return reply({error:"Only a flagged clip can be reset"},409);
    const draft=await getDraft(env.DB,body!.setId!);
    if(!draft||draft.state!=="blocked")return reply({error:"Draft not in blocked review state"},409);
    if(clip.object_key){
      // Remove the bad/overlapping audio before making a fresh claim eligible.
      // Failed deletion intentionally leaves the draft blocked.
      try{await env.LISTENING_AUDIO.delete(clip.object_key);}
      catch{return reply({error:"Unable to remove rejected audio from R2"},503);}
    }
    try{
      await env.DB.batch([
        env.DB.prepare("UPDATE listening_refill_clips SET status='pending',claim_day=NULL,"+
          "claimed_at=NULL,uploaded_at=NULL,object_key=NULL,bytes=NULL "+
          "WHERE set_id=? AND stimulus_id=? AND status='flagged'")
          .bind(body!.setId,body!.stimulusId),
        env.DB.prepare("UPDATE listening_refill_drafts SET state='rendering',updated_at=datetime('now') "+
          "WHERE id=? AND state='blocked' AND NOT EXISTS("+
          "SELECT 1 FROM listening_refill_clips WHERE set_id=? AND status='flagged' AND stimulus_id<>?)")
          .bind(body!.setId,body!.setId,body!.stimulusId),
      ]);
      return reply({result:"pending-manual-retry",setId:body!.setId,
        stimulusId:body!.stimulusId,autoRetry:false,previousSlotConsumed:true});
    }catch{return reply({error:"Recovery state uncertain; check R2 and D1"},503);}
  }
  if(path==="/api/cloud/listening-refill/publish"){
    if(!env.LISTENING_AUDIO)return reply({error:"R2 bucket not configured"},503);
    const body=await req.json().catch(()=>null) as {setId?:string;confirm?:string}|null;
    if(body?.confirm!=="PUBLISH_REVIEWED_LISTENING_SET"||!SAFE.test(body?.setId??""))
      return reply({error:"Explicit publication confirmation required"},400);
    const draft=await getDraft(env.DB,body!.setId!);
    if(!draft || draft.state==="blocked"||draft.state==="published")return reply({error:"Draft not publishable"},409);
    const clips=await env.DB.prepare(
      "SELECT stimulus_id,status,ordinal,claim_day,object_key FROM listening_refill_clips WHERE set_id=? ORDER BY ordinal"
    ).bind(draft.id).all<ClipRow>();
    if(clips.results.length!==36||clips.results.some(c=>c.status!=="uploaded"||c.object_key!==objectKey(draft.id,c.stimulus_id)))
      return reply({error:"All 36 MP3 clips must be uploaded before publication"},409);
    try{
      // Verify R2 objects, not simply D1 acknowledgements.
      for(const clip of clips.results){
        const head=await env.LISTENING_AUDIO.head(clip.object_key!);
        if(!head || head.size<1024)return reply({error:"Missing R2 MP3; publication blocked"},409);
      }
      const set=ListeningSetSchema.parse(JSON.parse(draft.content_json));
      indexDeterministicItems(set);
      if(listeningClips(set).length!==36)return reply({error:"Corrupted Listening draft"},409);
      await env.DB.batch([
        env.DB.prepare("INSERT INTO listening_sets(id,content_json) VALUES(?,?)").bind(set.id,JSON.stringify(set)),
        env.DB.prepare("UPDATE listening_refill_drafts SET state='published',updated_at=datetime('now') WHERE id=? AND state IN ('draft','rendering','ready')")
          .bind(set.id),
      ]);
      return reply({result:"published",setId:set.id,clips:36},201);
    }catch{return reply({error:"Publication failed or already exists"},409);}
  }
  return reply({error:"Unknown Listening queue endpoint"},404);
}

/** Fallback when a clip is not one of the ORIGINAL prepackaged ASSETS. */
export async function servePublishedR2Audio(req:Request,env:ListeningRefillEnv):Promise<Response|null>{
  const m=/^\/api\/audio\/stimuli\/(lsn-[A-Za-z0-9_-]{1,60})\/([A-Za-z0-9_-]{1,64})\.mp3$/.exec(new URL(req.url).pathname);
  if(!m || (req.method!=="GET"&&req.method!=="HEAD") || !env.LISTENING_AUDIO)return null;
  const row=await env.DB.prepare(
    "SELECT c.object_key FROM listening_refill_clips c "+
    "JOIN listening_refill_drafts d ON d.id=c.set_id "+
    "JOIN listening_sets s ON s.id=d.id "+
    "WHERE c.set_id=? AND c.stimulus_id=? AND c.status='uploaded' AND d.state='published'"
  ).bind(m[1],m[2]).first<{object_key:string}>();
  if(!row || row.object_key!==objectKey(m[1]!,m[2]!))return null;
  const object=await env.LISTENING_AUDIO.get(row.object_key);
  if(!object)return null;
  return new Response(req.method==="HEAD"?null:object.body,{status:200,headers:{
    "Content-Type":"audio/mpeg","Cache-Control":"private,max-age=1800","X-Content-Type-Options":"nosniff",
    "Content-Length":String(object.size)
  }});
}
