/**
 * Human-attested Free Tier Listening batch: up to 3 Lite + 3 Flash attempts.
 * Does NOT approve, publish, retry failed requests or recreate old clips.
 * --self-test / --dry-run are fully offline and never access secrets.
 */
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const ORIGIN='https://toefl-prep-private.ihsuan0701.workers.dev';
const PREFIX='/api/cloud/listening-refill/';
const LITE='gemini-3.8-flash-lite-tts', FLASH='gemini-3.8-flash-tts';
const LIMIT=3, MAX_BATCH=6;
const args=process.argv.slice(2);
const day=()=>{
  const parts=new Intl.DateTimeFormat('en-US',{
    timeZone:'America/Los_Angeles',year:'numeric',month:'2-digit',day:'2-digit',
  }).formatToParts(new Date());
  const value=k=>parts.find(p=>p.type===k)?.value;
  return [value('year'),value('month'),value('day')].join('-');
};

function valid(status,staged,expectedDay) {
  if(status?.day!==expectedDay || status.enabled!==true || status.r2Configured!==true ||
      !Array.isArray(status.queue) || !Array.isArray(status.models) ||
      status.models.length!==2 || staged?.result!=='pending-human-review' ||
      !Array.isArray(staged.queue)) return false;
  const models=status.models;
  const known=[LITE,FLASH].every(model=>models.some(m=>m.model===model));
  const caps=models.every(m=>Number.isInteger(m.dailyLimit) && m.dailyLimit>=0 &&
    m.dailyLimit<=LIMIT && Number.isInteger(m.claimed) && m.claimed>=0 &&
    m.claimed<=LIMIT && m.freeTierVerifiedToday===true &&
    m.ready===(m.dailyLimit>m.claimed));
  const claims=status.queue.reduce((n,q)=>n+Number(q.clips?.claimed||0),0);
  const inventory=status.queue.every(q=>q?.clips &&
    ['uploaded','pending','claimed','flagged'].every(k=>Number.isInteger(q.clips[k]??0)&&
      (q.clips[k]??0)>=0) &&
    Number(q.clips?.flagged||0)===0);
  return known && caps && inventory && claims===staged.queue.length;
}
function offlineTest(){
  const d='2026-11-17';
  const status={day:d,enabled:true,r2Configured:true,
    queue:[{clips:{uploaded:20,pending:13,claimed:3,flagged:0}}],
    models:[{model:LITE,dailyLimit:3,claimed:1,freeTierVerifiedToday:true,ready:true},
      {model:FLASH,dailyLimit:3,claimed:2,freeTierVerifiedToday:true,ready:true}]};
  const staged={result:'pending-human-review',queue:[{},{},{}]};
  assert.ok(valid(status,staged,d));
  assert.ok(!valid(status,{...staged,queue:[{},{}]},d));
  assert.ok(!valid({...status,models:status.models.map(m=>({...m,dailyLimit:10}))},staged,d));
  assert.ok(!valid({...status,day:'2026-11-16'},staged,d));
  assert.ok(!valid({...status,queue:[{clips:{...status.queue[0].clips,flagged:1}}]},staged,d));
  console.log(JSON.stringify({result:'batch-offline-tests-passed',geminiCalls:0,writes:0}));
}
async function main() {
  if(args.length===1 && args[0]==='--self-test')return offlineTest();
  if(args.length===1 && args[0]==='--dry-run'){
    console.log(JSON.stringify({result:'batch-dry-run',geminiCalls:0,writes:0,maxAttempts:MAX_BATCH}));
    return;
  }
  if(args.length!==1 || args[0]!=='--execute')throw Error('Only --execute, --self-test or --dry-run');
  if(process.env.LISTENING_BATCH_APPROVED!=='true')
    throw Error('Batch flag disabled; no Gemini request');
  const token=process.env.TOEFL_MANUAL_TEST_TOKEN||'';
  const id=process.env.CF_ACCESS_CLIENT_ID||'';
  const secret=process.env.CF_ACCESS_CLIENT_SECRET||'';
  if(token.length<32 || !id || !secret || !process.env.GEMINI_API_KEY)
    throw Error('Missing credentials; no Gemini request');
  const confirmedDay=day();
  const get=async(endpoint)=>{
    const res=await fetch(ORIGIN+PREFIX+endpoint,{
      method:'GET',redirect:'error',signal:AbortSignal.timeout(12000),
      headers:{Authorization:'Bearer '+token,'CF-Access-Client-Id':id,
        'CF-Access-Client-Secret':secret,Accept:'application/json','Cache-Control':'no-store'},
    });
    if(!res.ok)throw Error('Private '+endpoint+' returned HTTP '+res.status+'; STOP');
    return res.json();
  };
  let completed=0;
  while(completed<MAX_BATCH){
    if(day()!==confirmedDay)throw Error('Pacific day changed; stop without new claim');
    const status=await get('status'),staged=await get('staged');
    if(!valid(status,staged,confirmedDay))
      throw Error('Free Tier/model caps, unresolved claim or draft state invalid; STOP');
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
  console.log(JSON.stringify({result:'batch-complete-for-human-review',completed,
    published:false,manualReviewRequired:true}));
}
await main().catch(e=>{console.error('STOP, no retry: '+(e instanceof Error?e.message:'unknown'));process.exitCode=1;});
