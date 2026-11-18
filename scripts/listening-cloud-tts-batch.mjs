/**
 * Human-attested Free Tier Listening batch: up to each model's verified daily D1 cap (max 10/model).
 * Does NOT approve, publish, retry failed requests or recreate old clips.
 * --self-test / --dry-run are fully offline and never access secrets.
 */
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const ORIGIN='https://toefl-prep-private.ihsuan0701.workers.dev';
const PREFIX='/api/cloud/listening-refill/';
const LITE='gemini-3.8-flash-lite-tts', FLASH='gemini-3.8-flash-tts';
const LIMIT=10, MAX_BATCH=20;
const args=process.argv.slice(2);
const PILOT=process.env.LISTENING_BATCH_PILOT==='true';
const maxAttempts=process.env.LISTENING_BATCH_MAX_ATTEMPTS
  ? Number(process.env.LISTENING_BATCH_MAX_ATTEMPTS):MAX_BATCH;
const expectedPilotDay=process.env.LISTENING_BATCH_EXPECTED_PACIFIC_DAY||'';
const expectedPilotUploaded=Number(process.env.LISTENING_BATCH_EXPECTED_UPLOADED);
if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>MAX_BATCH)
  throw Error('Invalid bounded maximum attempts; no Gemini request');

const day=()=>{
  const parts=new Intl.DateTimeFormat('en-US',{
    timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',
  }).formatToParts(new Date());
  const value=k=>parts.find(p=>p.type===k)?.value;
  return [value('year'),value('month'),value('day')].join('-');
};

function valid(status,staged,expectedDay) {
  if(status?.day!==expectedDay || status.enabled!==true || status.r2Configured!==true ||
      !Array.isArray(status.queue) || status.queue.length<1 || status.queue.length>10 ||
      !Array.isArray(status.models) || status.models.length!==2 ||
      staged?.result!=='pending-human-review' || !Array.isArray(staged.queue))
    return false;
  const models=status.models;
  const known=[LITE,FLASH].every(name=>models.filter(m=>m.model===name).length===1);
  const caps=models.every(m=>Number.isInteger(m.dailyLimit) && m.dailyLimit>=0 &&
    m.dailyLimit<=LIMIT && Number.isInteger(m.claimed) && m.claimed>=0 &&
    m.claimed<=LIMIT && (m.dailyLimit===0 || m.freeTierVerifiedToday===true) &&
    m.ready===(m.freeTierVerifiedToday===true && m.dailyLimit>m.claimed));
  const drafts=status.queue;
  const inventory=drafts.every(d=>{
    const c=d?.clips||{};
    return /^lsn-[A-Za-z0-9_-]{1,60}$/.test(d?.id||'') &&
      ['draft','rendering','ready','published','blocked'].includes(d.state) &&
      ['uploaded','pending','claimed','flagged'].every(k=>
        Number.isInteger(c[k]??0)&&(c[k]??0)>=0) &&
      ['uploaded','pending','claimed','flagged'].reduce((n,k)=>n+(c[k]??0),0)===36 &&
      (c.flagged||0)===0;
  });
  const unfinished=drafts.filter(d=>
    ['draft','rendering'].includes(d.state)&&(d.clips?.pending||0)>0);
  const globalClaims=drafts.reduce((n,d)=>n+(d.clips?.claimed||0),0);
  const quarantined=status.verifiedQuarantinedClaims;
  const unquarantined=status.unresolvedUnquarantinedClaims;
  return known&&caps&&inventory&&unfinished.length===1&&
    Number.isSafeInteger(quarantined)&&quarantined>=0&&
    Number.isSafeInteger(unquarantined)&&unquarantined===0&&
    globalClaims===staged.queue.length+quarantined;
}
function pilotReady(status,staged,expectedDay,uploaded){
  if(!valid(status,staged,expectedDay)||staged.queue.length!==0||
     !Number.isInteger(uploaded)||uploaded<0||uploaded>=36)return false;
  const drafts=status.queue.filter(q=>q.id==='lsn-a97620b2c800');
  if(drafts.length!==1||status.queue.length!==1)return false;
  const clips=drafts[0].clips||{};
  if(clips.uploaded!==uploaded||clips.pending!==36-uploaded||
     Number(clips.claimed||0)!==0||Number(clips.flagged||0)!==0)return false;
  return [LITE,FLASH].every(name=>{
    const model=status.models.find(m=>m.model===name);
    return model?.ready===true&&model.freeTierVerifiedToday===true&&
      model.dailyLimit-model.claimed===1;
  });
}
function offlineTest(){
  const d='2026-11-17';
  const status={day:d,enabled:true,r2Configured:true,
    queue:[{id:'lsn-a97620b2c800',state:'rendering',clips:{uploaded:20,pending:13,claimed:3,flagged:0}}],
    verifiedQuarantinedClaims:0,unresolvedUnquarantinedClaims:0,
    models:[{model:LITE,dailyLimit:3,claimed:1,freeTierVerifiedToday:true,ready:true},
      {model:FLASH,dailyLimit:3,claimed:2,freeTierVerifiedToday:true,ready:true}]};
  const staged={result:'pending-human-review',queue:[{},{},{}]};
  assert.ok(valid(status,staged,d));
  const failureStatus={...status,queue:[{...status.queue[0],
    clips:{uploaded:20,pending:13,claimed:4,flagged:0}}],
    verifiedQuarantinedClaims:1,unresolvedUnquarantinedClaims:0};
  // The quarantine must be R2-verified by the authenticated Worker; it never
  // erases its model attempt or reclaims its daily Lite quota.
  assert.ok(valid(failureStatus,staged,d));
  assert.ok(!valid({...failureStatus,verifiedQuarantinedClaims:0,
    unresolvedUnquarantinedClaims:1},staged,d));
  assert.ok(!valid({...failureStatus,verifiedQuarantinedClaims:0},staged,d));
  assert.ok(!valid({...failureStatus,verifiedQuarantinedClaims:2},staged,d));

  assert.ok(!valid(status,{...staged,queue:[{},{}]},d));
  assert.ok(!valid({...status,models:status.models.map(m=>({...m,dailyLimit:11}))},staged,d));
  assert.ok(!valid({...status,day:'2026-11-16'},staged,d));
  assert.ok(!valid({...status,queue:[{clips:{...status.queue[0].clips,flagged:1}}]},staged,d));
  const partial={...status,queue:[{id:'lsn-a97620b2c800',state:'rendering',
    clips:{uploaded:28,pending:8,claimed:0,flagged:0}}],
    models:[{model:LITE,dailyLimit:3,claimed:2,freeTierVerifiedToday:true,ready:true},
      {model:FLASH,dailyLimit:3,claimed:1,freeTierVerifiedToday:true,ready:true}]};
  assert.ok(valid(partial,{result:'pending-human-review',queue:[]},d));
  const reserved={id:'lsn-previous-completed',state:'rendering',
    clips:{uploaded:36,pending:0,claimed:0,flagged:0}};
  assert.ok(valid({...partial,queue:[reserved,...partial.queue]},
    {result:'pending-human-review',queue:[]},d));
  assert.ok(!valid({...partial,queue:[reserved,...partial.queue,
    {id:'lsn-unexpected-two',state:'draft',
      clips:{uploaded:0,pending:36,claimed:0,flagged:0}}]},
    {result:'pending-human-review',queue:[]},d));

  assert.ok(!valid({...partial,queue:[{...partial.queue[0],
    clips:{uploaded:28,pending:7,claimed:0,flagged:0}}]},
    {result:'pending-human-review',queue:[]},d));
  assert.ok(valid({...partial,models:partial.models.map((m,i)=>i===0?
    {...m,dailyLimit:0,ready:false}:m)},{result:'pending-human-review',queue:[]},d));
  assert.ok(!valid({...partial,models:partial.models.map((m,i)=>i===0?
    {...m,dailyLimit:11}:m)},{result:'pending-human-review',queue:[]},d));

  const pilotStatus={...status,
    queue:[{id:'lsn-a97620b2c800',state:'rendering',clips:{uploaded:26,pending:10,claimed:0,flagged:0}}],
    models:status.models.map(m=>({...m,
      dailyLimit:m.claimed+1,remaining:1,ready:true}))};
  assert.ok(pilotReady(pilotStatus,{result:'pending-human-review',queue:[]},d,26));
  assert.ok(!pilotReady(pilotStatus,staged,d,26));
  assert.ok(!pilotReady(pilotStatus,{result:'pending-human-review',queue:[]},d,25));
  assert.ok(!pilotReady({...pilotStatus,models:pilotStatus.models.map(m=>({...m,dailyLimit:m.dailyLimit+1}))},
    {result:'pending-human-review',queue:[]},d,26));
  console.log(JSON.stringify({result:'batch-offline-tests-passed',geminiCalls:0,writes:0}));
}
async function main() {
  if(args.length===1 && args[0]==='--self-test')return offlineTest();
  if(args.length===1 && args[0]==='--dry-run'){
    console.log(JSON.stringify({result:'batch-dry-run',geminiCalls:0,writes:0,maxAttempts}));
    return;
  }
  if(args.length!==1 || !['--execute','--inspect-live'].includes(args[0]))
    throw Error('Only --execute, --inspect-live, --self-test or --dry-run');
  if(args[0]==='--execute' && process.env.LISTENING_BATCH_APPROVED!=='true')
    throw Error('Batch flag disabled; no Gemini request');
  const token=process.env.TOEFL_MANUAL_TEST_TOKEN||'';
  const id=process.env.CF_ACCESS_CLIENT_ID||'';
  const secret=process.env.CF_ACCESS_CLIENT_SECRET||'';
  if(token.length<32 || !id || !secret || !process.env.GEMINI_API_KEY)
    throw Error('Missing credentials; no Gemini request');
  const confirmedDay=day();
  if(PILOT&&(maxAttempts!==2||expectedPilotDay!==confirmedDay||
     !Number.isInteger(expectedPilotUploaded)||expectedPilotUploaded<0||
     expectedPilotUploaded>=36))
    throw Error('Pilot requires exactly two attempts and matching Pacific day/inventory; STOP');
  const get=async(endpoint)=>{
    const res=await fetch(ORIGIN+PREFIX+endpoint,{
      method:'GET',redirect:'error',signal:AbortSignal.timeout(12000),
      headers:{Authorization:'Bearer '+token,'CF-Access-Client-Id':id,
        'CF-Access-Client-Secret':secret,Accept:'application/json','Cache-Control':'no-store'},
    });
    if(!res.ok)throw Error('Private '+endpoint+' returned HTTP '+res.status+'; STOP');
    return res.json();
  };
  if(args.length===1 && args[0]==='--inspect-live'){
    const status=await get('status'),staged=await get('staged');
    const active=status?.queue?.find(q=>['draft','rendering'].includes(q.state)&&
      (q.clips?.pending||0)>0);
    const c=active?.clips||{};
    const models=Array.isArray(status?.models)?status.models:[];
    const remaining=models.map(m=>({model:m.model,claimed:m.claimed,
      cap:m.dailyLimit,available:Math.max(0,Math.min(LIMIT,m.dailyLimit)-m.claimed),
      confirmedToday:m.freeTierVerifiedToday===true}));
    console.log(JSON.stringify({result:'live-batch-inspection',pacificDay:confirmedDay,
      serverDay:status?.day,enabled:status?.enabled,r2Configured:status?.r2Configured,
      activeDraftId:active?.id||null,completedReserveCount:status?.queue?.filter(q=>(q.clips?.uploaded||0)===36).length||0,
      verifiedQuarantinedClaims:status?.verifiedQuarantinedClaims??null,
      unresolvedUnquarantinedClaims:status?.unresolvedUnquarantinedClaims??null,
      approved:c.uploaded??null,pending:c.pending??null,claimed:c.claimed??null,
      flagged:c.flagged??null,pendingReview:staged?.queue?.length??null,
      models:remaining,geminiCalls:0,published:false}));
    if(!valid(status,staged,confirmedDay))
      throw Error('Live status or review ledger unsafe: verify enabled switch, current model caps <=10 and review counts; NO Gemini');
    if(!models.some(m=>m.ready===true)||!(c.pending>0))
      throw Error('No remaining D1-attested quota or unfinished audio; set current permitted caps first; NO Gemini');
    return;
  }
  let completed=0;
  let initialClaims=null;
  while(completed<maxAttempts){
    if(day()!==confirmedDay)throw Error('Pacific day changed; stop without new claim');
    const status=await get('status'),staged=await get('staged');
    if(!valid(status,staged,confirmedDay))
      throw Error('Free Tier/model caps, unresolved claim or draft state invalid; STOP');
    if(PILOT&&completed===0){
      if(!pilotReady(status,staged,confirmedDay,expectedPilotUploaded))
        throw Error('Pilot requires exact inventory, zero pending reviews, one remaining Lite and one remaining Flash; STOP');
      initialClaims=Object.fromEntries(status.models.map(m=>[m.model,m.claimed]));
    }
    const allReady=status.models.some(m=>m.ready);
    const pending=status.queue.some(q=>Number(q.clips?.pending||0)>0);
    if(!allReady||!pending){
      console.log(JSON.stringify({result:'batch-safe-stop-no-available-model-or-pending',completed}));
      break;
    }
    if(completed>0)await new Promise(resolve=>setTimeout(resolve,65000));
    if(day()!==confirmedDay)throw Error('Pacific day changed before next request');
    // The one-take runner obtains a D1 atomic claim BEFORE the sole Gemini call.
    // It does not retry and stages MP3 in private R2 for later review.
    const child=spawnSync(process.execPath,
      ['--import','tsx','scripts/listening-cloud-tts-once.mjs','--once'],
      {encoding:'utf8',timeout:240000,env:process.env,maxBuffer:1024*1024});
    if(child.stdout)process.stdout.write(child.stdout);
    if(child.stderr)process.stderr.write(child.stderr);
    if(child.error||child.status!==0)
      throw Error('One-take failed or timed out; do not retry automatically');
    const newStatus=await get('status'),newStaged=await get('staged');
    if(!valid(newStatus,newStaged,confirmedDay)||
       newStaged.queue.length!==staged.queue.length+1)
      throw Error('Staging increase unverified; STOP without retry');
    const consumed=newStatus.models.reduce((n,m)=>n+m.claimed,0)-
      status.models.reduce((n,m)=>n+m.claimed,0);
    if(consumed!==1)throw Error('Unexpected claim ledger delta; STOP');
    completed++;
    console.log(JSON.stringify({result:'one-more-staged',completed,
      pendingHumanReview:newStaged.queue.length,apiAttempts:completed,published:false}));
  }
  if(PILOT){
    if(completed!==2||!initialClaims)
      throw Error('Pilot ended before two staged clips; inspect status, no automatic retry');
    const finished=await get('status'),review=await get('staged');
    if(!valid(finished,review,confirmedDay)||
       ![LITE,FLASH].every(name=>
         finished.models.find(m=>m.model===name)?.claimed===initialClaims[name]+1))
      throw Error('Expected exactly one Lite and one Flash claim; inspect and reconcile manually');
  }
  console.log(JSON.stringify({result:'batch-complete-for-human-review',completed,
    published:false,manualReviewRequired:true}));
}
await main().catch(e=>{console.error('STOP, no retry: '+(e instanceof Error?e.message:'unknown'));process.exitCode=1;});
