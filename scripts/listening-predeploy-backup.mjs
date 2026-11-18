/**
 * Read-only production backup and audio integrity check. Run on your own
 * Cloudflare-authenticated computer; never in public GitHub Actions.
 *
 * node scripts/listening-predeploy-backup.mjs --self-test
 * node scripts/listening-predeploy-backup.mjs --execute --min-uploaded=24
 *
 * Writes private D1 SQL + known referenced R2 MP3s only to gitignored
 * data/backups/. Never performs DB writes, R2 writes, API calls to Gemini,
 * Worker deployment, or schedule activation.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASE = join(ROOT, 'data', 'backups');
const CONFIG = join(ROOT, 'cloudflare', 'wrangler.jsonc');
const D1 = 'toefl-prep-private', BUCKET = 'toefl-listening-audio';
const TARGET = 'lsn-a97620b2c800';
const VALID_KEY = /^(?:stimuli|staging)\/lsn-[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+\.mp3$/;
const args=process.argv.slice(2);
const die=s=>{throw Error(s)};
function cli(parts){
  const bin=process.platform==='win32'?'npx.cmd':'npx';
  // All dynamic R2 keys are validated before being passed to the subprocess.
  const p=spawnSync(bin,['--yes','wrangler@4.162.0',...parts],{
    cwd:ROOT,encoding:'utf8',stdio:'inherit',shell:process.platform==='win32',
    timeout:180000,
  });
  if(p.error || p.status!==0)die('Wrangler read-only operation failed (no deployment).');
}
function sha256(buf){return createHash('sha256').update(buf).digest('hex')}
function tableExists(db,table){
  return !!db.prepare('SELECT name FROM sqlite_master WHERE type=\'table\' AND name=?').get(table);
}
function rows(db,query){return db.prepare(query).all()}
function deriveManifest(db){
  for(const table of ['listening_refill_clips','listening_auto_review_staged',
    'listening_refill_audio_imports','listening_refill_drafts'])
    if(!tableExists(db,table))die('D1 export lacks required table '+table+'; stop deployment');
  const clips=rows(db,"SELECT set_id,stimulus_id,status,object_key,bytes FROM listening_refill_clips");
  const staged=rows(db,"SELECT set_id,stimulus_id,status,object_key,sha256,bytes FROM listening_auto_review_staged");
  const imported=rows(db,"SELECT set_id,stimulus_id,object_key,mp3_sha256,bytes FROM listening_refill_audio_imports");
  const expected=new Map();
  function record(key, size, hash,source) {
    if(!VALID_KEY.test(key))die('Unexpected R2 path in exported D1: '+String(key));
    if(!Number.isSafeInteger(size) || size<1024 || size>8388608)die('Invalid MP3 bytes for '+key);
    if(hash!==null && !/^[a-f0-9]{64}$/.test(hash))die('Invalid digest for '+key);
    const prev=expected.get(key);
    if(prev && (prev.size!==size || (prev.hash&&hash&&prev.hash!==hash)))
      die('Conflicting D1 R2 reference '+key);
    expected.set(key,{key,size,hash:hash||prev?.hash||null,sources:[...(prev?.sources||[]),source]});
  }
  for(const c of clips) {
    if(c.status==='uploaded') {
      if(!c.object_key)die('Uploaded clip missing object key: '+c.stimulus_id);
      record(c.object_key,c.bytes,null,'canonical:'+c.stimulus_id);
    } else if(c.object_key)die('Non-uploaded clip has canonical R2 reference: '+c.stimulus_id);
  }
  for(const s of staged){
    record(s.object_key,s.bytes,s.sha256,'stage:'+s.status+':'+s.stimulus_id);
    const canonical='stimuli/'+s.set_id+'/'+s.stimulus_id+'.mp3';
    if(s.status==='approved' && expected.has(canonical))
      record(canonical,s.bytes,s.sha256,'approved-stage-hash');
  }
  for(const a of imported)record(a.object_key,a.bytes,a.mp3_sha256,'manual-import:'+a.stimulus_id);
  const target=clips.filter(c=>c.set_id===TARGET);
  if(target.length!==36)die('Expected 36 target clips; found '+target.length);
  const summary=Object.fromEntries(['pending','claimed','uploaded','flagged'].map(s=>
    [s,target.filter(c=>c.status===s).length]));
  const stagedIds=new Set(staged.filter(x=>x.status==='pending_review')
    .map(x=>x.set_id+'/'+x.stimulus_id));
  const unsafe=target.filter(c=>c.status==='claimed' &&
    !stagedIds.has(c.set_id+'/'+c.stimulus_id));
  const blocked=target.some(c=>c.status==='flagged');
  return {objects:[...expected.values()].sort((a,b)=>a.key.localeCompare(b.key)),
    targetCounts:summary,totalR2References:expected.size,
    deploySafe:!unsafe.length&&!blocked,unreconciledClaims:unsafe.map(c=>c.stimulus_id),
    stagedPending:stagedIds.size};
}
function verifyMp3(file,expected){
  const buf=readFileSync(file);
  if(buf.byteLength!==expected.size)die('R2 size mismatch for '+expected.key);
  const mp3=buf.subarray(0,3).toString('ascii')==='ID3'||
    (buf[0]===0xff && (buf[1]&0xe0)===0xe0);
  if(!mp3)die('R2 MP3 signature invalid: '+expected.key);
  const got=sha256(buf);
  if(expected.hash && got!==expected.hash)die('R2 SHA mismatch: '+expected.key);
  return got;
}
function test(){
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE listening_refill_clips(set_id TEXT,stimulus_id TEXT,status TEXT,object_key TEXT,bytes INTEGER);
    CREATE TABLE listening_auto_review_staged(set_id TEXT,stimulus_id TEXT,status TEXT,object_key TEXT,sha256 TEXT,bytes INTEGER);
    CREATE TABLE listening_refill_audio_imports(set_id TEXT,stimulus_id TEXT,object_key TEXT,mp3_sha256 TEXT,bytes INTEGER);
    CREATE TABLE listening_refill_drafts(id TEXT);`);
  const insert=db.prepare('INSERT INTO listening_refill_clips VALUES(?,?,?,?,?)');
  for(let i=0;i<36;i++)insert.run(TARGET,'clip'+i,i<24?'uploaded':'pending',
    i<24?'stimuli/'+TARGET+'/clip'+i+'.mp3':null,i<24?2048:null);
  let result=deriveManifest(db);
  assert.equal(result.targetCounts.uploaded,24);
  assert.equal(result.totalR2References,24);
  assert.equal(result.deploySafe,true);
  db.prepare("UPDATE listening_refill_clips SET status='claimed' WHERE stimulus_id='clip24'").run();
  assert.equal(deriveManifest(db).deploySafe,false);
  db.prepare('INSERT INTO listening_auto_review_staged VALUES(?,?,?,?,?,?)')
    .run(TARGET,'clip24','pending_review','staging/'+TARGET+'/clip24.mp3','a'.repeat(64),2048);
  assert.equal(deriveManifest(db).deploySafe,true);
  db.close();
  console.log(JSON.stringify({result:'read-only-backup-offline-tests-passed',remoteCalls:0,writes:0}));
}
async function main(){
  if(args.length===1 && args[0]==='--self-test')return test();
  if(args[0]!=='--execute'||args.length!==2||!/^--min-uploaded=\d+$/.test(args[1]||''))
    die('Use --self-test or --execute --min-uploaded=24 (current known minimum)');
  const min=Number(args[1].slice('--min-uploaded='.length));
  if(!Number.isInteger(min)||min<1||min>36)die('Invalid minimum uploaded count');
  const tag=new Date().toISOString().replace(/[:.]/g,'-');
  const folder=join(BASE,'listening-predeploy-'+tag);
  if(existsSync(folder))die('Backup folder already exists; refusing overwrite');
  mkdirSync(folder,{recursive:true});
  const sqlFile=join(folder,'d1-remote.sql');
  console.log('Exporting read-only remote D1 to a PRIVATE, gitignored local folder.');
  cli(['d1','export',D1,'--remote','--config',CONFIG,'--output',sqlFile]);
  if(!existsSync(sqlFile)||statSync(sqlFile).size<1024)die('D1 export is missing/too small. STOP');
  const db=new DatabaseSync(':memory:');
  try{
    db.exec(readFileSync(sqlFile,'utf8'));
    const m=deriveManifest(db);
    if(m.targetCounts.uploaded<min)die('Live D1 uploaded count smaller than expected: '+
      m.targetCounts.uploaded+' < '+min);
    if(!m.deploySafe)die('Unreconciled/flagged D1 clips. SQL backup exists but deployment NOT safe');
    const hashes=[];
    for(const item of m.objects){
      const local=join(folder,'r2',...item.key.split('/'));
      mkdirSync(dirname(local),{recursive:true});
      cli(['r2','object','get',BUCKET+'/'+item.key,'--remote','--file',local]);
      hashes.push({key:item.key,size:item.size,sha256:verifyMp3(local,item)});
    }
    const report={completedAt:new Date().toISOString(),source:'remote Cloudflare D1/R2',
      bucket:BUCKET,database:D1,stage:'BACKED_UP_NOT_DEPLOYED',
      targetSet:TARGET,counts:m.targetCounts,stagedPending:m.stagedPending,
      verifiedObjects:hashes.length,allHashChecked:true,manifest:hashes,
      caveat:'This copies all D1-referenced listening MP3s, not any orphaned/unindexed R2 objects.'};
    writeFileSync(join(folder,'verification.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
    console.log(JSON.stringify({result:'backup-verified-locally',privateFolder:folder,
      uploaded:m.targetCounts.uploaded,stagedPending:m.stagedPending,
      verifiedObjects:hashes.length,geminiCalls:0,cloudWrites:0,deployments:0}));
  }finally{db.close();}
}
await main().catch(e=>{
  console.error('BACKUP/VERIFY STOP (no deploy): '+(e instanceof Error?e.message:'unknown'));
  process.exitCode=1;
});
