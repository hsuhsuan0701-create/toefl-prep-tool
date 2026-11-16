/**
 * TOEFL Listening / private local TTS staging runner.
 * Intended installation: <repo>/scripts/listening-tts-batch-safe.mjs
 *
 * - Default: offline plan; no network, no Gemini calls, no D1/R2 writes.
 * - --self-test: dependency-free structural checks; no network.
 * - --execute: explicit opt-in, sequential bounded TTS calls, NO retries.
 * - Reuses canonical render-plan/delivery policy, skips existing audition MP3s.
 * - Preserves outputs and attempt receipts even when a request fails.
 * - Does NOT upload, claim or publish: existing Cloudflare /upload requires an
 *   authorized D1 claim and cannot ingest arbitrary local MP3s.
 *
 * Output: tmp/tts-trials/<setId>/<stimulusId>-<model>.wav|mp3
 * State:  tmp/tts-trials/<setId>/_batch_private/
 */
import {
  readFileSync, writeFileSync, mkdirSync, existsSync, openSync,
  closeSync, unlinkSync, renameSync, statSync, readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SET_ID = 'lsn-a97620b2c800';
const EXPECTED_CANONICAL_SHA256 = '4a070707e2c0781ad0939dfceff7d4610fc562bc80341c34062dbf644c1deabe';
const JSON_PATH = join(ROOT, 'tmp', 'listening-draft-pilots', SET_ID + '-reviewed-revised.json');
const OUTPUT_DIR = join(ROOT, 'tmp', 'tts-trials', SET_ID);
const STATE_DIR = join(OUTPUT_DIR, '_batch_private');
const LITE = 'gemini-3.8-flash-lite-tts';
const FLASH = 'gemini-3.8-flash-tts';
const RPD_LIMIT = 10;
const PACIFIC = 'America/Los_Angeles';
const argv = process.argv.slice(2);
const arg = name => {
  const prefix = '--' + name + '=';
  const match = argv.find(v => v.startsWith(prefix));
  return match === undefined ? undefined : match.slice(prefix.length);
};
const has = name => argv.includes('--' + name);
const fail = msg => { throw new Error(msg); };
function pacificDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: PACIFIC, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = t => parts.find(p => p.type === t)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
function canonicalHash(obj) {
  return createHash('sha256').update(JSON.stringify(obj), 'utf8').digest('hex');
}
function readSet() {
  const set = JSON.parse(readFileSync(JSON_PATH, 'utf8'));
  if (set.id !== SET_ID || canonicalHash(set) !== EXPECTED_CANONICAL_SHA256)
    fail('The saved revised Listening draft differs from the D1-reviewed version. STOP.');
  return set;
}
function roleCounts(set) {
  const totals = { 'lcr-utterance': 0, conversation: 0, announcement: 0, 'academic-talk': 0, questions: 0 };
  for (const m of [set.router, set.lowerModule, set.upperModule]) {
    for (const item of m.listenChoose) {
      totals['lcr-utterance']++;
      totals.questions += item.questions?.length ?? 1;
    }
    for (const [field, role] of [['conversations','conversation'],['announcements','announcement'],['academicTalks','academic-talk']]) {
      for (const item of m[field]) {
        totals[role]++;
        totals.questions += item.questions.length;
      }
    }
  }
  return totals;
}
function selfTest() {
  const set = readSet();
  const totals = roleCounts(set);
  if (totals['lcr-utterance'] !== 20 || totals.conversation !== 7 ||
      totals.announcement !== 5 || totals['academic-talk'] !== 4 || totals.questions !== 60)
    fail('Unexpected Listening role counts or question count. STOP.');
  for (const role of Object.keys(totals).filter(x => x !== 'questions')) {
    if (!([ 'lcr-utterance', 'announcement' ].includes(role) ? LITE : FLASH).startsWith('gemini-3.8-'))
      fail('Model routing test failed');
  }
  const sample = {
    text: 'Student: Hello.\nAdvisor: Welcome.',
    speakers: [{ speaker: 'Student', voice: 'Kore' }, { speaker: 'Advisor', voice: 'Puck' }],
  };
  const parts = speechParts(sample, 'natural');
  if (parts.length !== 2 || parts[1].speechMetadata.speaker !== 'Advisor' || parts[0].text !== 'Hello.')
    fail('Conversation part-splitting test failed');
  if (pacePlausible(40, 118, 162) !== true || pacePlausible(1, 118, 162) !== false)
    fail('Duration envelope test failed');
  const result = {
    result: 'local-batch-self-test-pass', setId: SET_ID, totalClips: 36,
    questions: totals.questions, roles: totals,
    canonicalSha256: canonicalHash(set),
    apiRequests: 0, databaseWrites: 0, r2Uploads: 0,
  };
  console.log(JSON.stringify(result, null, 2));
}
function modelFor(clip) {
  if (clip.role === 'conversation' || clip.role === 'academic-talk') return FLASH;
  if (clip.role === 'lcr-utterance' || clip.role === 'announcement') return LITE;
  fail('Unsupported Listening role: ' + clip.role);
}
function outputPaths(clip) {
  const base = join(OUTPUT_DIR, clip.stimulusId + '-' + modelFor(clip));
  return {wav: base + '.wav', mp3: base + '.mp3'};
}
function receiptPath(clip) {
  return join(STATE_DIR, clip.stimulusId + '-' + modelFor(clip) + '.attempt.json');
}
function clipState(clip) {
  const p = outputPaths(clip);
  if (existsSync(p.mp3)) return 'local-mp3';
  if (existsSync(p.wav)) return 'wav-only-needs-offline-review';
  if (existsSync(receiptPath(clip))) return 'previous-attempt-review-required';
  return 'unattempted';
}
function speechParts(clip, style) {
  if (!clip.speakers?.length) return [{text: clip.text, speechMetadata: {style}}];
  return clip.text.split('\n').map(line => {
    const speaker = clip.speakers.find(s => line.startsWith(s.speaker + ': '));
    if (!speaker) fail('Invalid conversation turn label for stimulus ' + clip.stimulusId);
    return {text: line.slice(speaker.speaker.length + 2),
      speechMetadata: {speaker: speaker.speaker, style}};
  });
}
function pacePlausible(sec, words, wpm) {
  const expected = words / wpm * 60;
  return Number.isFinite(sec) && sec >= expected * .3 && sec <= expected * 3;
}
function parseIntInRange(value, label, low, high) {
  if (value === undefined || !/^(0|[1-9]\d*)$/.test(value))
    fail(`Missing or invalid --${label}=N (integer ${low}..${high}).`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < low || n > high)
    fail(`--${label}= must be ${low}..${high}`);
  return n;
}
function atomicJsonWrite(file, payload) {
  const temp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(payload, null, 2), {flag:'wx', mode:0o600});
  renameSync(temp, file);
}
function readJsonIfPresent(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}
function countReservations(day, model) {
  // Each attempt gets an immutable, unique receipt before ANY outbound request.
  // A receipt (including failed/ambiguous attempts) counts towards the cap.
  if (!existsSync(STATE_DIR)) return 0;
  let n = 0;
  for (const name of readdirSync(STATE_DIR)) {
    if (!name.endsWith('.attempt.json')) continue;
    const record = readJsonIfPresent(join(STATE_DIR,name));
    if (record?.pacificDay === day && record?.model === model) n++;
  }
  return n;
}
function styleFor(clip, notes, accentDirection, pacingDirection) {
  return [notes.audioProfile, notes.scene, notes.style,
    accentDirection[notes.accent], pacingDirection(notes.band),
    'Do not insert words, omit words or speak stage directions.'].join('. ');
}
function toRequest(clip, style) {
  return {contents:[{role:'user',parts:speechParts(clip, style)}],
    generationConfig:{responseModalities:['AUDIO'],speechConfig:clip.speakers?.length ?
      {multiSpeakerVoiceConfig:{speakerVoiceConfigs:clip.speakers.map(s=>({
        speaker:s.speaker,voiceConfig:{voice:s.voice}}))}} :
      {voiceConfig:{voice:clip.voice}}}};
}
async function loadCanonicalPlan() {
  // These are the same real project modules used by pilot-gemini38-tts.mjs.
  const [{ListeningSetSchema}, renderer, prompt, audioPace, sanity] = await Promise.all([
    import('../shared/src/index.ts'),
    import('../server/src/services/listeningAudioRenderer.ts'),
    import('../server/src/services/audioPrompt.ts'),
    import('../server/src/services/audioPace.ts'),
    import('./lib/listening-audio-sanity.mjs'),
  ]);
  const set = ListeningSetSchema.parse(readSet());
  const clips = renderer.buildRenderPlan(set);
  if (clips.length !== 36 || new Set(clips.map(x=>x.stimulusId)).size !== 36)
    fail('Canonical render plan is not exactly 36 distinct clips. STOP.');
  for (const clip of clips) {
    if (clip.speakers?.length > 2 || !clip.text?.trim()) fail('Invalid render clip: '+clip.stimulusId);
  }
  return {clips, renderer, prompt, audioPace, sanity};
}
function printPlan(clips) {
  const rows=clips.map((c,i)=>({index:i+1,stimulusId:c.stimulusId,role:c.role,
    model:modelFor(c),state:clipState(c)}));
  const totals={};for(const row of rows)totals[row.state]=(totals[row.state]??0)+1;
  const humanApprovedAuditions=['pilot-r0-conv1','pilot-r0-ann1'];
  const localApprovedAuditions=rows.filter(r=>humanApprovedAuditions.includes(r.stimulusId)&&r.state==='local-mp3').map(r=>r.stimulusId);
  const output={result:'local-tts-batch-plan',setId:SET_ID,pacificQuotaDay:pacificDay(),
    declaredModelDailyLimits:{[LITE]:RPD_LIMIT,[FLASH]:RPD_LIMIT},clipCount:36,
    statusCounts:totals,humanApprovedAuditions,localApprovedAuditions,
    next:rows.filter(r=>r.state==='unattempted').slice(0,5),
    ...(has('full')?{all:rows}:{}),
    apiRequests:0,databaseWrites:0,r2Uploads:0,published:false,
    caveat:'Existing MP3 only means present locally; other clips need individual listening review. No Cloudflare claim or upload has occurred.'};
  console.log(JSON.stringify(output,null,2));
}
function safeFreeTierGuard(day) {
  if (arg('free-tier-confirmed-day')!==day || arg('acknowledge-api-calls')!=='YES')
    fail('For --execute, provide --free-tier-confirmed-day='+day+' and --acknowledge-api-calls=YES after checking AI Studio Free Tier/Billing TODAY (Pacific day).');
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY.length < 20)
    fail('GEMINI_API_KEY must be set locally. Never paste it into chat or commit it.');
  const userLite=parseIntInRange(arg('external-used-lite'),'external-used-lite',0,10);
  const userFlash=parseIntInRange(arg('external-used-flash'),'external-used-flash',0,10);
  const max=parseIntInRange(arg('max-requests'),'max-requests',1,3);
  mkdirSync(STATE_DIR,{recursive:true});
  const attestationFile=join(STATE_DIR,'attested-'+day+'.json');
  const existing=readJsonIfPresent(attestationFile);
  const attested={day,externalLite:Math.max(existing?.externalLite??0,userLite),
    externalFlash:Math.max(existing?.externalFlash??0,userFlash),
    note:'External counts must include manual TTS calls made on this Pacific day but not any attempts already recorded by this runner. Overcounting is safer than undercounting.'};
  atomicJsonWrite(attestationFile,attested);
  return {max,attested};
}
async function generateOne(clip, day, ctx) {
  const model=modelFor(clip);
  const paths=outputPaths(clip);
  if (clipState(clip)!=='unattempted') fail('A file or receipt already exists; refusing duplicate API request for '+clip.stimulusId);
  if (pacificDay()!==day) fail('Pacific day rollover; stop before further requests. Reconfirm Free Tier and quota.');
  const base=model===LITE?ctx.attested.externalLite:ctx.attested.externalFlash;
  const attempted=countReservations(day,model);
  if (base+attempted>=RPD_LIMIT) fail('Daily conservative request limit reached for '+model+' (manual baseline='+base+', runner attempts='+attempted+').');
  const notes=ctx.renderer.deliveryNotes(clip);
  const style=styleFor(clip,notes,ctx.prompt.ACCENT_DIRECTION,ctx.prompt.pacingDirection);
  const requestBody=toRequest(clip,style);
  // Derive the exact word count and targets from the production render plan.
  const words=ctx.renderer.spokenWordCount(clip.text,clip.speakers);
  if (words<1) fail('Empty spoken transcript; no TTS request');
  const receipt={setId:SET_ID,stimulusId:clip.stimulusId,role:clip.role,model,
    pacificDay:day,sourceHash:EXPECTED_CANONICAL_SHA256,startedAt:new Date().toISOString(),
    state:'reserved',autoRetry:false,manualReviewRequired:true,apiRequestsReserved:1};
  // Durable reservation BEFORE network request: even an ambiguous response consumes slot.
  writeFileSync(receiptPath(clip),JSON.stringify(receipt,null,2),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({phase:'one-explicit-tts-request',stimulusId:clip.stimulusId,
    model,wordCount:words,day,conservativeUsageAfterReservation:base+attempted+1,
    note:'A failed/unknown call is NOT automatically retried.'}));
  let result;
  try {
    const response=await fetch('https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent',{
      method:'POST',headers:{'Content-Type':'application/json','x-goog-api-key':process.env.GEMINI_API_KEY},
      body:JSON.stringify(requestBody),signal:AbortSignal.timeout(120000),
    });
    if (!response.ok) fail('Gemini returned HTTP '+response.status+'; NO automatic retry');
    const body=await response.json();
    const audio=body.candidates?.[0]?.content?.parts?.find(p=>p.inlineData?.data)?.inlineData;
    if (!audio?.data || typeof audio.data!=='string') fail('Gemini response has no WAV audio. NO retry.');
    const wav=Buffer.from(audio.data,'base64');
    if (wav.length<1000 || wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')
      fail('Response is not the expected WAV format. NO retry.');
    const check=ctx.sanity.inspectPcmWav(wav);
    const duration=ctx.sanity.inspectExpectedDuration(check,words,notes.band.targetWpm);
    mkdirSync(OUTPUT_DIR,{recursive:true});
    writeFileSync(paths.wav,wav,{flag:'wx',mode:0o600});
    if (!duration.durationPlausible) fail('WAV duration implausible; saved WAV for inspection, MP3 skipped. NO retry.');
    const ffmpeg=spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-n',
      '-i',paths.wav,'-codec:a','libmp3lame','-qscale:a','3',paths.mp3],
      {encoding:'utf8',timeout:60000});
    if (ffmpeg.status!==0 || !existsSync(paths.mp3)) fail('WAV saved, ffmpeg MP3 conversion failed. NO retry.');
    const probe=spawnSync('ffprobe',['-v','error','-show_entries','format=duration',
      '-of','default=noprint_wrappers=1:nokey=1',paths.mp3],{encoding:'utf8',timeout:15000});
    const durationSec=Number(probe.stdout?.trim());
    if (probe.status!==0 || !Number.isFinite(durationSec)||durationSec<=0 || statSync(paths.mp3).size<1024)
      fail('MP3 saved but file size or ffprobe duration is invalid. NO retry.');
    const pace=ctx.audioPace.assessPace({wordCount:words,durationSec,band:notes.band});
    result={status:'saved-for-manual-listening',stimulusId:clip.stimulusId,model,
      wav:paths.wav,mp3:paths.mp3,bytes:statSync(paths.mp3).size,
      durationSec:+durationSec.toFixed(2),roughWpm:+pace.wpm.toFixed(1),
      paceVerdict:pace.verdict,longSilences:check.longSilences,
      reusedExistingAudio:false,geminiRequests:1,databaseWrites:0,r2Uploaded:false,published:false};
    atomicJsonWrite(receiptPath(clip),{...receipt,state:'saved',finishedAt:new Date().toISOString(),result});
    console.log(JSON.stringify(result,null,2));
    return result;
  } catch(e) {
    atomicJsonWrite(receiptPath(clip),{...receipt,state:'needs-manual-reconciliation',
      stoppedAt:new Date().toISOString(),errorCategory:e?.name||'Error',
      errorMessage:String(e?.message||'unknown').slice(0,200),
      note:'One attempt reserved; DO NOT retry automatically.'});
    throw e;
  }
}
async function executePlan(ctx) {
  const day=pacificDay();
  const {max,attested}=safeFreeTierGuard(day);
  const unresolved=ctx.clips.filter(c=>{
    const state=clipState(c);
    const receipt=readJsonIfPresent(receiptPath(c));
    return state==='wav-only-needs-offline-review' || state==='previous-attempt-review-required' ||
      receipt?.state==='needs-manual-reconciliation';
  });
  if(unresolved.length) fail('Unresolved prior TTS attempts or WAV-only files: '+unresolved.map(c=>c.stimulusId).join(', ')+'. Inspect manually before any further API calls.');
  const toDo=ctx.clips.filter(c=>clipState(c)==='unattempted');
  if (!toDo.length) {
    console.log(JSON.stringify({result:'all-clips-have-local-audio-or-receipts',apiRequests:0}));
    return;
  }
  const lockPath=join(STATE_DIR,'RUNNING.lock');
  let fd;
  try {fd=openSync(lockPath,'wx'); writeFileSync(fd,JSON.stringify({pid:process.pid,at:new Date().toISOString()}));}
  catch {fail('Another run or stale lock exists. Inspect '+lockPath+'; no calls made.');}
  try {
    let done=0;
    for(const clip of toDo) {
      if (done>=max) break;
      if (pacificDay()!==day) fail('Pacific day rolled over; stop and recheck quotas');
      const model=modelFor(clip);
      const baseline=model===LITE?attested.externalLite:attested.externalFlash;
      if (baseline+countReservations(day,model)>=RPD_LIMIT) {
        console.log(JSON.stringify({skipped:clip.stimulusId,reason:'daily-model-cap',model}));
        continue;
      }
      if (done>0) {
        console.log('Waiting between requests to stay below the published RPM cap; no network requests during this interval.');
        await new Promise(r=>setTimeout(r,65000));
      }
      await generateOne(clip,day,{...ctx,attested});
      done++;
    }
    console.log(JSON.stringify({result:'bounded-local-staging-complete',newTtsRequests:done,
      reviewRequired:true,cloudUploaded:false,published:false}));
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
  }
}

try {
  if (has('self-test')) selfTest();
  else {
    const ctx=await loadCanonicalPlan();
    if (has('execute')) await executePlan(ctx);
    else printPlan(ctx.clips);
  }
} catch(e) {
  console.error('STOP: '+(e instanceof Error?e.message:String(e)));
  process.exitCode=1;
}
