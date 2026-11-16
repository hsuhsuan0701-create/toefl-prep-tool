/**
 * Private TOEFL Listening: auditable import of ALREADY GENERATED and HUMAN REVIEWED local MP3s.
 * Never calls Gemini, never generates audio, never retries, never publishes.
 * Requires a deployed /api/cloud/listening-refill/import-reviewed Worker endpoint.
 *
 * node scripts/import-reviewed-listening-audio.mjs --self-test
 * node scripts/import-reviewed-listening-audio.mjs --plan
 * node scripts/import-reviewed-listening-audio.mjs --inspect --id=pilot-r0-conv1
 * node scripts/import-reviewed-listening-audio.mjs --apply --id=pilot-r0-conv1 --confirm=IMPORT_REVIEWED_EXISTING_MP3
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const ID='lsn-a97620b2c800';
const REVISION_SHA='4a070707e2c0781ad0939dfceff7d4610fc562bc80341c34062dbf644c1deabe';
const LITE='gemini-3.8-flash-lite-tts';
const FLASH='gemini-3.8-flash-tts';
const ROUTE='/api/cloud/listening-refill/import-reviewed';
const SOURCE=join(ROOT,'tmp','listening-draft-pilots',ID+'-reviewed-revised.json');
const AUDIO_DIR=join(ROOT,'tmp','tts-trials',ID);
const RECORD_DIR=join(AUDIO_DIR,'_batch_private','reviewed_imports');
// These three *specific MP3 bytes* were reported as human-listened and approved.
// A matching filename alone is NOT approval: replacing the file invalidates approval.
const ALREADY_HUMAN_APPROVED_SHA256=new Map([
  ['pilot-r0-lc1','10a03b0f2ff0ac2b0fbee97560838ce003f5806fb2c775c43b272f8d971d4609'],
  ['pilot-r0-conv1','ba01a48ec14117733a99f2c462bcd925b9a1fce8df7a80c3952913e913d28952'],
  ['pilot-r0-ann1','0fe6d0ecc0369364432014b20bd8d494232266a353373107f39dd152a57f4601'],
]);
const args=process.argv.slice(2);
const has=flag=>args.includes('--'+flag);
const opt=name=>args.find(x=>x.startsWith('--'+name+'='))?.slice(name.length+3);
function stop(message){throw Error(message)}
function sha(bytes){return createHash('sha256').update(bytes).digest('hex')}
function getSet(){
  const set=JSON.parse(readFileSync(SOURCE,'utf8'));
  if(set.id!==ID || sha(Buffer.from(JSON.stringify(set),'utf8'))!==REVISION_SHA)
    stop('Canonical Listening JSON changed; stop before uploading.');
  return set;
}
function getEntries(set){
  const rows=[];
  for(const mod of [set.router,set.lowerModule,set.upperModule]){
    for(const [kind,role,model] of [
      ['listenChoose','lcr-utterance',LITE],['conversations','conversation',FLASH],
      ['announcements','announcement',LITE],['academicTalks','academic-talk',FLASH]]){
      for(const s of mod[kind])rows.push({stimulusId:s.id,role,model});
    }
  }
  if(rows.length!==36 || new Set(rows.map(x=>x.stimulusId)).size!==36)stop('Expected 36 unique clips');
  return rows;
}
function approvalPath(id){return join(RECORD_DIR,id+'.human-approved.json')}
function receiptPath(id){return join(RECORD_DIR,id+'.import-attempt.json')}
function mp3Path(row){return join(AUDIO_DIR,row.stimulusId+'-'+row.model+'.mp3')}
function validMp3(file){
  const size=statSync(file).size;
  if(size<=1024 || size>8*1024*1024)stop('Invalid MP3 size: '+file);
  const header=Buffer.alloc(3);
  const f=readFileSync(file);
  f.copy(header,0,0,3);
  if(!(header.toString('ascii')==='ID3' ||
       (header[0]===0xff && (header[1]&0xe0)===0xe0)))stop('Invalid MP3 signature: '+file);
  const duration=spawnSync('ffprobe',['-v','error','-show_entries','format=duration',
    '-of','default=noprint_wrappers=1:nokey=1',file],{encoding:'utf8',timeout:15000});
  const seconds=Number(duration.stdout?.trim());
  if(duration.error || duration.status!==0 || !(seconds>0) || seconds>3600)
    stop('MP3 is unreadable by ffprobe: '+file);
  return {bytes:size,mp3Sha256:sha(f),durationSec:+seconds.toFixed(3)};
}
function audio(row){
  const file=mp3Path(row);
  return existsSync(file)?{file,...validMp3(file)}:null;
}
function approval(row,a){
  if(!a)return false;
  if(ALREADY_HUMAN_APPROVED_SHA256.get(row.stimulusId)===a.mp3Sha256)return true;
  if(!existsSync(approvalPath(row.stimulusId)))return false;
  const r=JSON.parse(readFileSync(approvalPath(row.stimulusId),'utf8'));
  return r.setId===ID && r.stimulusId===row.stimulusId &&
    r.sourceSha256===REVISION_SHA && r.mp3Sha256===a.mp3Sha256 &&
    r.confirm==='I_LISTENED_AND_APPROVED_LOCAL_MP3';
}
function show(x){process.stdout.write(JSON.stringify(x,null,2)+'\n')}
function checkBasic(){
  const set=getSet(),rows=getEntries(set),models={};
  for(const row of rows)models[row.role]=(models[row.role]??0)+1;
  if(models['lcr-utterance']!==20||models.conversation!==7||models.announcement!==5||models['academic-talk']!==4)
    stop('Clip role mix changed');
  return rows;
}
function plan(rows){
  let available=0,approved=0;
  const local=[];
  for(const row of rows){
    const a=audio(row);
    if(a){available++;if(approval(row,a))approved++;local.push({stimulusId:row.stimulusId,
      model:row.model,bytes:a.bytes,mp3Sha256:a.mp3Sha256,
      humanApproved:approval(row,a),priorImportAttempt:existsSync(receiptPath(row.stimulusId))});}
  }
  return {result:'reviewed-mp3-import-local-plan',setId:ID,totalClips:36,
    localMp3Files:available,humanApprovedLocalFiles:approved,remoteUploads:0,
    cloudflareWrites:0,geminiCalls:0,published:false,local};
}
function neededEnv(){
  const origin=new URL(process.env.TOEFL_WORKER_URL || 'https://toefl-prep-private.ihsuan0701.workers.dev').origin;
  const token=process.env.TOEFL_MANUAL_TEST_TOKEN;
  const accessId=process.env.CF_ACCESS_CLIENT_ID;
  const accessSecret=process.env.CF_ACCESS_CLIENT_SECRET;
  if(!token || token.length<32 || !accessId || !accessSecret)
    stop('Need TOEFL_MANUAL_TEST_TOKEN and Cloudflare Access Service Token env vars; never paste secrets into chat.');
  return {origin,headers:{Authorization:'Bearer '+token,
    'CF-Access-Client-Id':accessId,'CF-Access-Client-Secret':accessSecret}};
}
async function remoteInspect(ctx,row){
  const u=ctx.origin+ROUTE+'?setId='+ID+'&stimulusId='+row.stimulusId;
  let response;
  try{response=await fetch(u,{headers:ctx.headers,signal:AbortSignal.timeout(30000)})}
  catch(e){stop('Remote preflight request failed (no upload): '+e.name)}
  const raw=await response.text();
  let obj;try{obj=JSON.parse(raw)}catch{stop('Non-JSON Worker preflight response, HTTP '+response.status+'; check deployment/Access. No upload.')}
  if(!response.ok)stop('Worker preflight returned HTTP '+response.status+'; '+(obj.error||'no upload'));
  if(obj.result!=='reviewed-import-read-only-check'||obj.setId!==ID||obj.stimulusId!==row.stimulusId||
    obj.expectedModel!==row.model || obj.sourceHashMatches!==true)
    stop('Unexpected remote preflight data; stop before upload.');
  return obj;
}
function getTarget(rows){
  const id=opt('id');
  if(!id||!/^[A-Za-z0-9_-]{1,64}$/.test(id))stop('Provide --id=EXACT_STIMULUS_ID');
  const row=rows.find(x=>x.stimulusId===id);
  if(!row)stop('Stimulus not in canonical 36 clips: '+id);
  return row;
}
async function main(){
  const modes=['self-test','plan','approve-local','inspect','apply'].filter(has);
  if(modes.length!==1)stop('Choose exactly one: --self-test | --plan | --approve-local --id=... --confirm=I_LISTENED_AND_APPROVED_LOCAL_MP3 | --inspect --id=... | --apply --id=... --confirm=IMPORT_REVIEWED_EXISTING_MP3');
  const mode=modes[0];
  const rows=checkBasic();
  if(mode==='self-test'){
    const p=plan(rows);
    if(p.totalClips!==36)stop('Local import audit failed');
    show({result:'reviewed-import-local-self-test-pass',totalClips:36,
      localMp3Files:p.localMp3Files,humanApprovedLocalFiles:p.humanApprovedLocalFiles,
      sourceSha256:REVISION_SHA,geminiCalls:0,remoteCalls:0,cloudflareWrites:0});return;
  }
  if(mode==='plan'){show(plan(rows));return}
  const row=getTarget(rows),a=audio(row);
  if(!a)stop('No local MP3 for '+row.stimulusId);
  if(mode==='approve-local'){
    if(opt('confirm')!=='I_LISTENED_AND_APPROVED_LOCAL_MP3')stop('Human review confirmation required');
    if(existsSync(receiptPath(row.stimulusId)))stop('Import already attempted; investigate first');
    mkdirSync(RECORD_DIR,{recursive:true});
    const file=approvalPath(row.stimulusId);
    if(existsSync(file))stop('Existing human-approval receipt; refusing overwrite');
    writeFileSync(file,JSON.stringify({confirm:'I_LISTENED_AND_APPROVED_LOCAL_MP3',
      setId:ID,stimulusId:row.stimulusId,sourceSha256:REVISION_SHA,mp3Sha256:a.mp3Sha256,
      reviewedAt:new Date().toISOString()},null,2),{flag:'wx',mode:0o600});
    show({result:'local-human-approval-recorded',stimulusId:row.stimulusId,
      mp3Sha256:a.mp3Sha256,geminiCalls:0,remoteCalls:0,cloudflareWrites:0});return;
  }
  if(!approval(row,a))stop('Missing human listening approval for exact local MP3 hash. Use --approve-local after listening.');
  const ctx=neededEnv(),rem=await remoteInspect(ctx,row);
  if(mode==='inspect'){
    show({...rem,localMp3:{bytes:a.bytes,mp3Sha256:a.mp3Sha256,durationSec:a.durationSec},
      locallyApproved:true,priorImportAttempt:existsSync(receiptPath(row.stimulusId)),
      geminiCalls:0,databaseWrites:0});return;
  }
  if(opt('confirm')!=='IMPORT_REVIEWED_EXISTING_MP3')stop('Explicit --confirm=IMPORT_REVIEWED_EXISTING_MP3 required');
  if(!rem.readyForImport)stop('Remote clip not ready for import; no upload.');
  if(existsSync(receiptPath(row.stimulusId)))stop('Prior import attempt recorded; inspect remotely, do NOT retry.');
  const fresh=audio(row);
  if(!fresh || fresh.mp3Sha256!==a.mp3Sha256 || fresh.bytes!==a.bytes)
    stop('Local MP3 changed after hash check; no upload');
  mkdirSync(RECORD_DIR,{recursive:true});
  const receipt=receiptPath(row.stimulusId);
  const base={setId:ID,stimulusId:row.stimulusId,model:row.model,
    sourceSha256:REVISION_SHA,mp3Sha256:a.mp3Sha256,
    startedAt:new Date().toISOString(),state:'network-outcome-uncertain',autoRetry:false,
    geminiCalls:0,manualReviewRequired:true};
  // Durable receipt BEFORE outbound upload; an ambiguous response is never retried.
  writeFileSync(receipt,JSON.stringify(base,null,2),{flag:'wx',mode:0o600});
  const url=ctx.origin+ROUTE+'?setId='+ID+'&stimulusId='+row.stimulusId;
  const bytes=readFileSync(a.file);
  let response;
  try{
    response=await fetch(url,{method:'POST',signal:AbortSignal.timeout(90000),
      headers:{...ctx.headers,Origin:ctx.origin,'Content-Type':'audio/mpeg',
        'Content-Length':String(bytes.length),
        'X-Listening-Review-Confirm':'I_LISTENED_AND_APPROVED_LOCAL_MP3',
        'X-Listening-Source-Sha256':REVISION_SHA,
        'X-Listening-Mp3-Sha256':a.mp3Sha256,
        'X-Listening-Tts-Model':row.model},body:bytes});
  }catch(e){stop('Upload outcome uncertain; DO NOT RETRY. Use --inspect. Cause: '+e.name)}
  let obj;
  try{obj=await response.json()}
  catch{stop('Upload returned non-JSON HTTP '+response.status+'; outcome uncertain, DO NOT RETRY')}
  if(response.status!==201||obj.result!=='reviewed-local-mp3-import-verified'||
    obj.setId!==ID||obj.stimulusId!==row.stimulusId||obj.mp3Sha256!==a.mp3Sha256)
    stop('Upload HTTP '+response.status+': '+(obj.error||'unexpected response')+'; inspect before any retry');
  // An application-level success is backed by remote R2 & D1 check in the Worker.
  writeFileSync(receipt+'.success.json',JSON.stringify({...base,state:'verified-success',
    verifiedAt:new Date().toISOString(),cloudflareResponse:obj},null,2),{flag:'wx',mode:0o600});
  show({result:'reviewed-local-mp3-import-verified',stimulusId:row.stimulusId,
    mp3Sha256:a.mp3Sha256,bytes:a.bytes,geminiCalls:0,published:false,
    note:'Original attempt receipt retained permanently; do not re-import.'});
}
main().catch(e=>{console.error('STOP: '+e.message);process.exitCode=1});
