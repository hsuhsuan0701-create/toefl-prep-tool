import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { handleListeningRefill } from '../src/listeningRefill.ts';

const host = 'https://private.test';
const token = 'x'.repeat(48);
const lite = 'gemini-3.8-flash-lite-tts';
const original = JSON.parse(readFileSync(
  new URL('../../data/question-sets/listening/lsn-03948a55.json', import.meta.url), 'utf8'));

function fixture() {
  const sql = new Database(':memory:');
  const migrations = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(migrations).filter(f => f.endsWith('.sql')).sort())
    sql.exec(readFileSync(new URL(f, migrations), 'utf8'));
  class Statement {
    constructor(query, args = []) { this.query = query; this.args = args; }
    bind(...args) { return new Statement(this.query, args); }
    async first() { return sql.prepare(this.query).get(...this.args) ?? null; }
    async all() { return { results: sql.prepare(this.query).all(...this.args) }; }
    async run() { return { meta: { changes: sql.prepare(this.query).run(...this.args).changes } }; }
  }
  const DB = {
    prepare(q) { return new Statement(q); },
    async batch(items) {
      return sql.transaction(() => items.map(s => ({
        meta: { changes: sql.prepare(s.query).run(...s.args).changes },
      })))();
    },
  };
  const map = new Map();
  const LISTENING_AUDIO = {
    head: async key => map.has(key) ? { size: map.get(key).byteLength } : null,
    put: async (key, bytes, opts) => {
      if (opts?.onlyIf && map.has(key)) return null;
      const copy = new Uint8Array(bytes);
      map.set(key, copy);
      return { key, size: copy.length };
    },
    get: async key => {
      const bytes = map.get(key);
      if (!bytes) return null;
      return {
        size: bytes.length, body: new Response(bytes).body,
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),
      };
    },
  };
  return { sql, map, env: { DB, LISTENING_AUDIO, TOEFL_MANUAL_TEST_TOKEN: token } };
}
async function get(env, path, authed = true) {
  const req = new Request(host + path, {
    ...(authed ? { headers: { authorization: 'Bearer ' + token } } : {}),
  });
  return handleListeningRefill(req, env);
}
async function post(env, path, body) {
  const req = new Request(host + path, {
    method: 'POST', headers: {
      origin: host, authorization: 'Bearer ' + token, 'content-type': 'application/json',
    }, body: JSON.stringify(body),
  });
  return handleListeningRefill(req, env);
}
async function stage(env, setId, stimulusId) {
  const bytes = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2048)]);
  const req = new Request(host + '/api/cloud/listening-refill/stage-upload?setId=' +
    setId + '&stimulusId=' + stimulusId, {
    method: 'POST', headers: {
      origin:host, authorization:'Bearer ' + token, 'content-type':'audio/mpeg',
      'content-length':String(bytes.length), 'x-listening-model':lite,
      'x-audio-duration-seconds':'2.45',
    }, body: bytes,
  });
  return handleListeningRefill(req, env);
}
async function claimOne(env) {
  await post(env,'/api/cloud/listening-refill/draft',original);
  await post(env,'/api/cloud/listening-refill/settings',
    { enabled:true, confirm:'SET_LISTENING_AUTO_REFILL' });
  await post(env,'/api/cloud/listening-refill/model-policy',
    { model:lite,dailyLimit:1,confirm:'I_VERIFIED_FREE_TIER_TODAY' });
  const res = await post(env,'/api/cloud/listening-refill/claim',
    { confirm:'CLAIM_LISTENING_TTS_ONCE' });
  assert.equal(res.status,200);
  const data = await res.json();
  assert.equal(data.result,'claimed');
  return data.stimulusId;
}

test('review page shell and API remain independently protected', async () => {
  const { sql, env } = fixture();
  try {
    const page = await get(env,'/api/cloud/listening-refill/review',false);
    assert.equal(page.status,200);
    assert.match(await page.text(),/人工驗收/);
    const noToken = await get(env,'/api/cloud/listening-refill/staged',false);
    assert.equal(noToken.status,401);
    const empty = await get(env,'/api/cloud/listening-refill/staged');
    assert.equal((await empty.json()).queue.length,0);
  } finally { sql.close(); }
});

test('new take is staged once, auditioned, and imported only after human decision', async () => {
  const { sql, env, map } = fixture();
  try {
    const clip = await claimOne(env), setId = original.id;
    const first = await stage(env,setId,clip);
    assert.equal(first.status,201,await first.clone().text());
    assert.equal((await first.json()).result,'staged-for-review');
    assert.equal((await stage(env,setId,clip)).status,409,'staging never overwrites');
    assert.equal(map.has('stimuli/'+setId+'/'+clip+'.mp3'),false);
    assert.equal(sql.prepare('SELECT status FROM listening_refill_clips WHERE set_id=? AND stimulus_id=?')
      .get(setId,clip).status,'claimed');
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM listening_sets').get().n,0);
    const awaiting = await post(env,'/api/cloud/listening-refill/claim',
      {confirm:'CLAIM_LISTENING_TTS_ONCE'});
    assert.equal((await awaiting.json()).result,'awaiting-review-or-reconciliation');

    const listing = await get(env,'/api/cloud/listening-refill/staged');
    const queue = (await listing.json()).queue;
    assert.equal(queue.length,1);
    assert.equal(queue[0].stimulusId,clip);
    assert.ok(queue[0].transcript.length>0);
    const listen = await get(env,'/api/cloud/listening-refill/staged-audio?setId='+
      setId+'&stimulusId='+clip);
    assert.equal(listen.status,200);
    assert.equal(listen.headers.get('content-type'),'audio/mpeg');

    const decision = await post(env,'/api/cloud/listening-refill/stage-decision',{
      setId,stimulusId:clip,decision:'approve',confirm:'I_LISTENED_AND_APPROVED_AUDIO',note:'Audition passed',
    });
    assert.equal(decision.status,200,await decision.clone().text());
    assert.equal((await decision.json()).result,'human-approved-and-imported');
    assert.equal(sql.prepare('SELECT status FROM listening_refill_clips WHERE set_id=? AND stimulus_id=?')
      .get(setId,clip).status,'uploaded');
    assert.equal(sql.prepare('SELECT status FROM listening_auto_review_staged WHERE set_id=? AND stimulus_id=?')
      .get(setId,clip).status,'approved');
    assert.ok(map.has('stimuli/'+setId+'/'+clip+'.mp3'));
    assert.equal(sql.prepare('SELECT COUNT(*) AS n FROM listening_sets').get().n,0);
    assert.equal((await post(env,'/api/cloud/listening-refill/stage-decision',{
      setId,stimulusId:clip,decision:'approve',confirm:'I_LISTENED_AND_APPROVED_AUDIO',
    })).status,409,'a second approval can never overwrite MP3');
  } finally { sql.close(); }
});

test('rejection blocks draft without regenerating, uploading canonical MP3 or publishing', async () => {
  const { sql, env, map } = fixture();
  try {
    const clip = await claimOne(env), setId=original.id;
    assert.equal((await stage(env,setId,clip)).status,201);
    const rejected = await post(env,'/api/cloud/listening-refill/stage-decision',{
      setId,stimulusId:clip,decision:'reject',confirm:'REJECT_BAD_AUDIO',
      note:'Incorrect speaker and missing last sentence',
    });
    assert.equal(rejected.status,200,await rejected.clone().text());
    assert.equal((await rejected.json()).result,'rejected-blocked');
    assert.equal(map.has('stimuli/'+setId+'/'+clip+'.mp3'),false);
    assert.equal(sql.prepare('SELECT state FROM listening_refill_drafts WHERE id=?')
      .get(setId).state,'blocked');
    assert.equal(sql.prepare('SELECT status FROM listening_refill_clips WHERE set_id=? AND stimulus_id=?')
      .get(setId,clip).status,'flagged');
    assert.equal((await get(env,'/api/cloud/listening-refill/staged').then(r=>r.json())).queue.length,0);
  } finally { sql.close(); }
});
