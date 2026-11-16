/**
 * Separate unreviewed Cloudflare R2 audio staging workflow.
 *
 * Assumes handleListeningRefill has already checked the independent admin Bearer
 * token; Cloudflare Access must additionally protect the entire Worker.
 * No Gemini, publication, re-synthesis or automatic retries anywhere here.
 */
import type { ListeningRefillEnv } from './listeningRefill.js';
import { validPost } from './academicPractice.js';
import { ListeningSetSchema } from '@toefl-prep/shared';

const ROOT = '/api/cloud/listening-refill/';
const NO_CACHE = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: NO_CACHE });
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SET = /^lsn-[A-Za-z0-9_-]{1,60}$/;
const SHA = /^[a-f0-9]{64}$/;
const MP3_MAX = 8 * 1024 * 1024;
const stagingKey = (set: string, id: string) => 'staging/' + set + '/' + id + '.mp3';
const finalKey = (set: string, id: string) => 'stimuli/' + set + '/' + id + '.mp3';
type Staged = {
  set_id: string; stimulus_id: string; status: string; object_key: string;
  sha256: string; model: string; bytes: number; duration_sec: number; created_at: string;
};
const isMp3 = (b: Uint8Array) => b.length >= 1024 && (
  new TextDecoder().decode(b.subarray(0, 3)) === 'ID3' ||
  (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)
);
async function sha256(b: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', b));
  return Array.from(digest).map(x => x.toString(16).padStart(2, '0')).join('');
}
function stageTranscript(contentJson: string, id: string): string {
  const set = ListeningSetSchema.parse(JSON.parse(contentJson));
  for (const m of [set.router, set.lowerModule, set.upperModule]) {
    const lc = m.listenChoose.find(x => x.id === id);
    if (lc) return lc.utterance;
    const ann = m.announcements.find(x => x.id === id);
    if (ann) return ann.transcript;
    const talk = m.academicTalks.find(x => x.id === id);
    if (talk) return talk.transcript;
    const conv = m.conversations.find(x => x.id === id);
    if (conv) return conv.transcript.map(t => t.speakerId + ': ' + t.text).join('\n');
  }
  throw Error('Stimulus not in canonical draft');
}

export async function handleListeningStaging(
  req: Request, env: ListeningRefillEnv,
): Promise<Response | null> {
  const url = new URL(req.url), path = url.pathname, method = req.method;
  if (![ROOT+'stage-upload', ROOT+'staged', ROOT+'staged-audio', ROOT+'stage-decision'].includes(path))
    return null;
  if (!env.LISTENING_AUDIO) return json({ error: 'Private R2 is not configured' }, 503);
  const bucket = env.LISTENING_AUDIO;

  if (path === ROOT + 'staged' && method === 'GET') {
    try {
      const result = await env.DB.prepare(
        "SELECT set_id,stimulus_id,status,object_key,sha256,model,bytes,duration_sec,created_at " +
        "FROM listening_auto_review_staged WHERE status='pending_review' " +
        "ORDER BY created_at ASC,set_id,stimulus_id LIMIT 100"
      ).all<Staged>();
      const draftCache = new Map<string, string>();
      const queue = [];
      for (const row of result.results) {
        if (!draftCache.has(row.set_id)) {
          const draft = await env.DB.prepare('SELECT content_json FROM listening_refill_drafts WHERE id=?')
            .bind(row.set_id).first<{ content_json: string }>();
          if (!draft) throw Error('Staged draft missing');
          draftCache.set(row.set_id, draft.content_json);
        }
        queue.push({
          setId: row.set_id, stimulusId: row.stimulus_id, model: row.model,
          bytes: row.bytes, durationSec: row.duration_sec, sha256: row.sha256,
          createdAt: row.created_at,
          transcript: stageTranscript(draftCache.get(row.set_id)!, row.stimulus_id),
        });
      }
      return json({ result: 'pending-human-review', queue, geminiCalls: 0, published: false });
    } catch {
      return json({ error: 'Unable to list staged audio; migration may be missing' }, 503);
    }
  }

  if (path === ROOT + 'staged-audio' && method === 'GET') {
    const setId = url.searchParams.get('setId') ?? '';
    const id = url.searchParams.get('stimulusId') ?? '';
    if (!SET.test(setId) || !ID.test(id)) return json({ error: 'Invalid audio ID' }, 400);
    try {
      const row = await env.DB.prepare(
        "SELECT set_id,stimulus_id,status,object_key,sha256,model,bytes,duration_sec,created_at " +
        "FROM listening_auto_review_staged WHERE set_id=? AND stimulus_id=? AND status='pending_review'"
      ).bind(setId, id).first<Staged>();
      if (!row || row.object_key !== stagingKey(setId, id)) return json({ error: 'No pending review' }, 404);
      const object = await bucket.get(row.object_key);
      if (!object || object.size !== row.bytes) return json({ error: 'Staged audio missing' }, 503);
      return new Response(object.body, { status: 200, headers: {
        ...NO_CACHE, 'Content-Type': 'audio/mpeg', 'Content-Length': String(object.size),
      } });
    } catch { return json({ error: 'Unable to stream staged audio' }, 503); }
  }

  if (path === ROOT + 'stage-upload' && method === 'POST') {
    if (req.headers.get('origin') !== url.origin ||
        req.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'audio/mpeg')
      return json({ error: 'Same-origin audio/mpeg required' }, 403);
    const setId = url.searchParams.get('setId') ?? '', id = url.searchParams.get('stimulusId') ?? '';
    const model = req.headers.get('x-listening-model') ?? '';
    const duration = Number(req.headers.get('x-audio-duration-seconds'));
    const declared = Number(req.headers.get('content-length'));
    if (!SET.test(setId) || !ID.test(id) ||
        !['gemini-3.8-flash-lite-tts','gemini-3.8-flash-tts'].includes(model) ||
        !(duration > 0 && duration < 1200) || !Number.isSafeInteger(declared) ||
        declared < 1024 || declared > MP3_MAX)
      return json({ error: 'Invalid staged audio metadata' }, 400);
    try {
      const row = await env.DB.prepare(
        'SELECT c.status,c.claim_day,d.state FROM listening_refill_clips c ' +
        'JOIN listening_refill_drafts d ON d.id=c.set_id WHERE c.set_id=? AND c.stimulus_id=?'
      ).bind(setId, id).first<{status:string;claim_day:string|null;state:string}>();
      if (row?.status !== 'claimed' || !['draft','rendering'].includes(row.state) || !row.claim_day)
        return json({ error: 'Clip is not an active paid claim; refusing stage' }, 409);
      const attempt = await env.DB.prepare(
        'SELECT model FROM listening_refill_model_attempts WHERE day=? AND set_id=? AND stimulus_id=?'
      ).bind(row.claim_day,setId,id).first<{model:string}>();
      if (attempt?.model !== model) return json({ error: 'Claimed TTS model mismatch' }, 409);
      const previous = await env.DB.prepare(
        'SELECT status FROM listening_auto_review_staged WHERE set_id=? AND stimulus_id=?'
      ).bind(setId,id).first();
      if (previous) return json({ error: 'Already staged or reviewed; do not re-upload' }, 409);
      const body = new Uint8Array(await req.arrayBuffer());
      if (body.length !== declared || !isMp3(body))
        return json({ error: 'Malformed or incomplete MP3' }, 400);
      const key = stagingKey(setId,id);
      const hash = await sha256(body);
      // R2 conditional create-once is atomic. An existing staged MP3 cannot be overwritten.
      const put = await bucket.put(key,body,{ onlyIf: new Headers({'If-None-Match':'*'}),
        httpMetadata:{ contentType:'audio/mpeg' },
        customMetadata:{ model, sha256: hash } });
      if (!put) return json({ error: 'Staged R2 key already exists; manual reconciliation' }, 409);
      await env.DB.prepare(
        'INSERT INTO listening_auto_review_staged ' +
        '(set_id,stimulus_id,status,object_key,sha256,model,bytes,duration_sec) ' +
        "VALUES (?,?,'pending_review',?,?,?,?,?)"
      ).bind(setId,id,key,hash,model,body.length,duration).run();
      return json({result:'staged-for-review',setId,stimulusId:id,bytes:body.length,
        sha256:hash,published:false,manualReviewRequired:true},201);
    } catch {
      return json({ error:'Staging outcome uncertain: inspect R2 and D1; NEVER regenerate or retry blindly' },503);
    }
  }

  if (path === ROOT + 'stage-decision' && method === 'POST') {
    if (!validPost(req)) return json({ error: 'Same-origin JSON required' }, 403);
    const input = await req.json().catch(() => null) as
      {setId?:string;stimulusId?:string;decision?:string;confirm?:string;note?:string}|null;
    const setId = input?.setId ?? '', id = input?.stimulusId ?? '';
    const approved = input?.decision === 'approve', rejected = input?.decision === 'reject';
    const note = typeof input?.note === 'string' ? input.note.trim() : '';
    if (!SET.test(setId)||!ID.test(id)||(!approved&&!rejected)||
        input?.confirm !== (approved ? 'I_LISTENED_AND_APPROVED_AUDIO':'REJECT_BAD_AUDIO') ||
        note.length > 1500 || (rejected && note.length < 8))
      return json({ error: 'Explicit review decision and confirmation required' }, 400);
    try {
      const staged = await env.DB.prepare(
        "SELECT set_id,stimulus_id,status,object_key,sha256,model,bytes,duration_sec,created_at " +
        "FROM listening_auto_review_staged WHERE set_id=? AND stimulus_id=?"
      ).bind(setId,id).first<Staged>();
      const clip = await env.DB.prepare(
        'SELECT status,claim_day FROM listening_refill_clips WHERE set_id=? AND stimulus_id=?'
      ).bind(setId,id).first<{status:string;claim_day:string|null}>();
      if (!staged || staged.status !== 'pending_review' ||
          staged.object_key !== stagingKey(setId,id) || !SHA.test(staged.sha256) ||
          clip?.status !== 'claimed' || !clip.claim_day)
        return json({ error: 'Audio is not pending review; no overwrite or repeat decision' },409);
      const object = await bucket.get(staged.object_key);
      if (!object || object.size !== staged.bytes) return json({ error:'Staged R2 audio missing' },503);
      if (rejected) {
        const writes = await env.DB.batch([
          env.DB.prepare(
            "UPDATE listening_auto_review_staged SET status='rejected',decided_at=datetime('now'),reviewer_note=? " +
            "WHERE set_id=? AND stimulus_id=? AND status='pending_review'"
          ).bind(note,setId,id),
          env.DB.prepare(
            "UPDATE listening_refill_clips SET status='flagged' " +
            "WHERE set_id=? AND stimulus_id=? AND status='claimed'"
          ).bind(setId,id),
          env.DB.prepare(
            "UPDATE listening_refill_drafts SET state='blocked',updated_at=datetime('now') " +
            "WHERE id=? AND state IN ('draft','rendering','ready')"
          ).bind(setId),
        ]);
        if (writes.some(x => x.meta.changes !== 1))
          return json({ error:'Review reconciliation required; STOP' },503);
        return json({result:'rejected-blocked',setId,stimulusId:id,autoRetry:false},200);
      }
      const buf = new Uint8Array(await object.arrayBuffer());
      if (!isMp3(buf) || (await sha256(buf)) !== staged.sha256)
        return json({ error:'Staged SHA-256 check failed; cannot approve' },409);
      const publishedKey = finalKey(setId,id);
      // A reviewed take is copied ONLY if the canonical R2 MP3 does not already exist.
      const put = await bucket.put(publishedKey,buf,{onlyIf:new Headers({'If-None-Match':'*'}),
        httpMetadata:{ contentType:'audio/mpeg' },
        customMetadata:{ttsModel:staged.model,sha256:staged.sha256,manualReview:'true'}});
      if (!put) return json({ error:'Canonical MP3 exists; manual reconciliation; never overwrite' },409);
      const writes = await env.DB.batch([
        env.DB.prepare(
          "UPDATE listening_refill_clips SET status='uploaded',object_key=?,bytes=?,uploaded_at=datetime('now') " +
          "WHERE set_id=? AND stimulus_id=? AND status='claimed'"
        ).bind(publishedKey,staged.bytes,setId,id),
        env.DB.prepare(
          "UPDATE listening_refill_model_attempts SET status='uploaded' " +
          "WHERE day=? AND set_id=? AND stimulus_id=? AND status='claimed'"
        ).bind(clip.claim_day,setId,id),
        env.DB.prepare(
          "UPDATE listening_auto_review_staged SET status='approved',decided_at=datetime('now'),reviewer_note=? " +
          "WHERE set_id=? AND stimulus_id=? AND status='pending_review'"
        ).bind(note,setId,id),
      ]);
      if (writes.some(x => x.meta.changes !== 1))
        return json({ error:'Canonical MP3 may exist, but D1 reconciliation is required; DO NOT repeat approval' },503);
      // Retain staged R2 object for audit and deterministic incident recovery.
      return json({ result:'human-approved-and-imported',setId,stimulusId:id,
        sha256:staged.sha256,bytes:staged.bytes,published:false,geminiCalls:0 });
    } catch {
      return json({ error:'Review decision outcome uncertain. Inspect D1/R2 manually; no retry' },503);
    }
  }
  return json({error:'Unsupported staging operation'},405);
}
