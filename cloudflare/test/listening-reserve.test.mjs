import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readdirSync,readFileSync } from 'node:fs';
import { reserveStatus,setReserveAutoRelease,releaseOneReservedListeningSet }
  from '../src/listeningReserve.ts';
import { handleListeningRefill } from '../src/listeningRefill.ts';

const fixtureSet=JSON.parse(readFileSync(
  new URL('../../data/question-sets/listening/lsn-03948a55.json',import.meta.url),'utf8'));
const host='https://private.test',token='x'.repeat(48);

function fixture({missingAudio=false}={}){
  const sql=new Database(':memory:');
  const dir=new URL('../migrations/',import.meta.url);
  for(const file of readdirSync(dir).filter(n=>n.endsWith('.sql')).sort())
    sql.exec(readFileSync(new URL(file,dir),'utf8'));
  class Statement {
    constructor(query,args=[]){this.query=query;this.args=args;}
    bind(...args){return new Statement(this.query,args);}
    async first(){return sql.prepare(this.query).get(...this.args)??null;}
    async all(){return {results:sql.prepare(this.query).all(...this.args)};}
    async run(){return {meta:{changes:sql.prepare(this.query).run(...this.args).changes}};}
  }
  const DB={prepare:q=>new Statement(q),batch:async statements=>
    sql.transaction(()=>statements.map(x=>({
      meta:{changes:sql.prepare(x.query).run(...x.args).changes}
    })))()};
  const blobs=new Map();
  const LISTENING_AUDIO={
    head:async key=>blobs.has(key)?{size:blobs.get(key).length}:null,
  };
  const draft=structuredClone(fixtureSet);
  const setId=draft.id;
  sql.prepare("INSERT INTO listening_refill_drafts(id,content_json,state) VALUES(?,?,'rendering')")
    .run(setId,JSON.stringify(draft));
  const ids=[draft.router,draft.lowerModule,draft.upperModule].flatMap(m=>[
    ...m.listenChoose,...m.conversations,...m.announcements,...m.academicTalks
  ]).map(i=>i.id);
  assert.equal(ids.length,36);
  for(const [i,id] of ids.entries()){
    const key='stimuli/'+setId+'/'+id+'.mp3';
    const size=2048+i;
    if(!missingAudio||i!==13)blobs.set(key,new Uint8Array(size));
    sql.prepare("INSERT INTO listening_refill_clips(set_id,stimulus_id,ordinal,status,bytes,object_key) VALUES(?,?,?,'uploaded',?,?)")
      .run(setId,id,i,size,key);
  }
  // Legacy published Sets already have original JSON and are considered unused
  // until an actual scored item exists. Duplicate fixture payload is sufficient
  // here because the count SQL relies on D1 IDs, not on client parsing.
  for(let i=1;i<=4;i++)sql.prepare(
    "INSERT INTO listening_sets(id,content_json) VALUES(?,?)"
  ).run('lsn-old-reserve-'+i,JSON.stringify(fixtureSet));
  return {sql,env:{DB,LISTENING_AUDIO,TOEFL_MANUAL_TEST_TOKEN:token},blobs,setId};
}

test('complete reviewed Listening Set stays private until opt-in AND unused bank <=3',async()=>{
 const {sql,env,setId,blobs}=fixture();
 try {
   assert.deepEqual(await reserveStatus(env.DB),{
     enabled:false,unattemptedListeningSets:4,completeReservedSets:1,threshold:3
   });
   assert.equal((await releaseOneReservedListeningSet(env)).result,'disabled');
   assert.equal((await setReserveAutoRelease(env.DB,true)).enabled,true);
   assert.equal((await releaseOneReservedListeningSet(env)).result,'bank-not-low');
   assert.equal(sql.prepare('SELECT COUNT(*) n FROM listening_sets').get().n,4);
   assert.equal(sql.prepare('SELECT state FROM listening_refill_drafts WHERE id=?')
     .get(setId).state,'rendering');

   sql.prepare("DELETE FROM listening_sets WHERE id='lsn-old-reserve-4'").run();
   const before=blobs.size;
   const publish=await releaseOneReservedListeningSet(env);
   assert.equal(publish.result,'published-from-reserve');
   assert.equal(publish.setId,setId);
   assert.equal(sql.prepare('SELECT state FROM listening_refill_drafts WHERE id=?')
     .get(setId).state,'published');
   assert.equal(sql.prepare('SELECT COUNT(*) n FROM listening_sets').get().n,4);
   assert.equal(blobs.size,before,'no MP3 was regenerated, altered or removed');
   assert.equal((await releaseOneReservedListeningSet(env)).result,'bank-not-low',
     'the new unattempted Set brings the inventory back to four');
 }finally{sql.close();}
});

test('missing one private R2 object blocks reserve publication',async()=>{
 const {sql,env,setId}=fixture({missingAudio:true});
 try {
   await setReserveAutoRelease(env.DB,true);
   sql.prepare("DELETE FROM listening_sets WHERE id='lsn-old-reserve-4'").run();
   assert.equal((await releaseOneReservedListeningSet(env)).result,'r2-mismatch');
   assert.equal(sql.prepare('SELECT state FROM listening_refill_drafts WHERE id=?')
     .get(setId).state,'rendering');
   assert.equal(sql.prepare('SELECT COUNT(*) n FROM listening_sets').get().n,3);
 }finally{sql.close();}
});

test('reserve status and preference endpoints are admin-only and do not publish',async()=>{
 const {sql,env}=fixture();
 try {
   const get=(auth)=>handleListeningRefill(new Request(host+
      '/api/cloud/listening-refill/reserve-status',{
       headers:auth?{authorization:'Bearer '+token}:{} }),env);
   assert.equal((await get(false)).status,401);
   const status=await get(true);
   assert.equal(status.status,200);
   assert.equal((await status.json()).completeReservedSets,1);
   const post=await handleListeningRefill(new Request(host+
     '/api/cloud/listening-refill/reserve-settings',{
      method:'POST',headers:{origin:host,authorization:'Bearer '+token,
        'content-type':'application/json'},
      body:JSON.stringify({enabled:true,confirm:'SET_LISTENING_RESERVE_AUTO_RELEASE'})
     }),env);
   assert.equal(post.status,200);
   assert.equal((await post.json()).enabled,true);
   assert.equal(sql.prepare('SELECT COUNT(*) n FROM listening_sets').get().n,4);
 }finally{sql.close();}
});
