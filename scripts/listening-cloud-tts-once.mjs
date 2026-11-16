/**
 * One-clip, no-retry Listening TTS runner for GitHub Actions (or an equivalent Node host).
 * Uses the SAME buildRenderPlan / deliveryNotes / Gemini 3.8 request shape as
 * scripts/pilot-gemini38-tts.mjs. Cloudflare D1 claims a slot BEFORE any Gemini spend.
 *
 * --self-test and --dry-run: no network, no credentials.
 * --once: at most one Gemini request; stage in private R2 for human review only.
 * NEVER publish, repeat a failed/ambiguous API call or regenerate an existing clip.
 */
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { ListeningSetSchema } from '../shared/src/index.ts';
import { buildRenderPlan, deliveryNotes, spokenWordCount } from '../server/src/services/listeningAudioRenderer.ts';
import { ACCENT_DIRECTION, pacingDirection } from '../server/src/services/audioPrompt.ts';
import { inspectPcmWav, inspectExpectedDuration } from './lib/listening-audio-sanity.mjs';

const ORIGIN = 'https://toefl-prep-private.ihsuan0701.workers.dev';
const BASE = '/api/cloud/listening-refill/';
const LITE = 'gemini-3.8-flash-lite-tts';
const FLASH = 'gemini-3.8-flash-tts';
const args = process.argv.slice(2);

export function pacificDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = key => parts.find(p => p.type === key)?.value;
  return [part('year'), part('month'), part('day')].join('-');
}
export function ttsPayload(clip) {
  const notes = deliveryNotes(clip);
  const style = [notes.audioProfile, notes.scene, notes.style,
    ACCENT_DIRECTION[notes.accent], pacingDirection(notes.band),
    'Do not insert words, omit words or speak stage directions.'].join('. ');
  const parts = !clip.speakers?.length
    ? [{ text: clip.text, speechMetadata: { style } }]
    : clip.text.split('\n').map(line => {
      const speaker = clip.speakers.find(s => line.startsWith(s.speaker + ': '));
      if (!speaker) throw Error('Conversation transcript speaker mismatch');
      return { text: line.slice(speaker.speaker.length + 2),
        speechMetadata: { speaker: speaker.speaker, style } };
    });
  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: clip.speakers?.length ? {
        multiSpeakerVoiceConfig: {
          speakerVoiceConfigs: clip.speakers.map(s => ({
            speaker: s.speaker, voiceConfig: { voice: s.voice },
          })),
        },
      } : { voiceConfig: { voice: clip.voice } },
    },
  };
}

function runSelfTest() {
  const day = pacificDay(new Date('2026-11-16T20:00:00Z'));
  assert.equal(day, '2026-11-16');
  assert.equal(JSON.stringify(ttsPayload({
    role: 'lcr-utterance', text: 'Could you help me?',
    scene: 'a single speaker', voice: 'Kore', accent: 'north-american',
    stimulusId: 'test-1',
  })).includes('AUDIO'), true);
  console.log(JSON.stringify({ result: 'self-test-passed', geminiCalls: 0,
    cloudflareWrites: 0 }));
}

function credentials() {
  const key = process.env.GEMINI_API_KEY ?? '';
  const token = process.env.TOEFL_MANUAL_TEST_TOKEN ?? '';
  const clientId = process.env.CF_ACCESS_CLIENT_ID ?? '';
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET ?? '';
  if (!key || token.length < 32 || !clientId || !clientSecret) return null;
  return { key, headers: {
    Authorization: 'Bearer ' + token, 'CF-Access-Client-Id': clientId,
    'CF-Access-Client-Secret': clientSecret,
  }};
}
async function worker(path, auth, { method = 'GET', json, bytes, headers = {} } = {}) {
  const res = await fetch(ORIGIN + BASE + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: {
      ...auth, Accept: 'application/json', 'Cache-Control': 'no-store',
      ...(method === 'POST' ? { Origin: ORIGIN } : {}),
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...(bytes ? { 'Content-Type': 'audio/mpeg', 'Content-Length': String(bytes.length) } : {}),
      ...headers,
    },
    ...(json ? { body: JSON.stringify(json) } : bytes ? { body: bytes } : {}),
  });
  if (!res.ok) throw Error('Worker ' + path.split('?')[0] + ' HTTP ' + res.status +
    '; STOP: do not retry automatically');
  return res.json();
}
function inspectWav(wav, clip) {
  const notes = deliveryNotes(clip);
  const wordCount = spokenWordCount(clip.text, clip.speakers);
  const info = inspectPcmWav(wav);
  const plausible = inspectExpectedDuration(info, wordCount, notes.band.targetWpm);
  if (!plausible.durationPlausible) throw Error('Implausible WAV duration; no retry');
  if (info.longSilences?.length) throw Error('Unusual silence; keep claim for manual investigation');
  return { wordCount, approxWpm: (wordCount * 60) / info.durationSec };
}
function transcode(wav) {
  const dir = mkdtempSync(join(tmpdir(), 'toefl-tts-once-'));
  const wavPath = join(dir, 'take.wav'), mp3Path = join(dir, 'take.mp3');
  try {
    writeFileSync(wavPath, wav, { flag: 'wx' });
    const result = spawnSync('ffmpeg', [
      '-hide_banner','-loglevel','error','-nostdin','-n',
      '-i',wavPath,'-codec:a','libmp3lame','-qscale:a','3',mp3Path,
    ], { timeout: 120000, encoding: 'utf8' });
    if (result.status !== 0) throw Error('ffmpeg failed; never regenerate automatically');
    const probe = spawnSync('ffprobe', [
      '-v','error','-show_entries','format=duration',
      '-of','default=noprint_wrappers=1:nokey=1',mp3Path,
    ], { timeout: 15000, encoding: 'utf8' });
    const duration = Number(probe.stdout.trim());
    if (probe.status !== 0 || !(duration > 0 && duration < 1200)) throw Error('MP3 probe failed');
    const bytes = readFileSync(mp3Path);
    if (bytes.length < 1024 || bytes.length > 8 * 1024 * 1024) throw Error('Unexpected MP3 size');
    return { bytes, duration };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function runOnce() {
  const creds = credentials();
  if (!creds) {
    console.log(JSON.stringify({ result: 'skipped-missing-secret', geminiCalls: 0 }));
    return;
  }
  const day = pacificDay();
  const status = await worker('status', creds.headers);
  if (status.day !== day) throw Error('Pacific date mismatch; no TTS claim');
  if (!status.enabled || !status.r2Configured ||
      !Array.isArray(status.models) ||
      !status.models.some(m => m.freeTierVerifiedToday && m.ready)) {
    console.log(JSON.stringify({ result: 'skipped-safety-gate', day, geminiCalls: 0 }));
    return;
  }
  if (status.queue?.some(q => Number(q.clips?.claimed || 0) > 0)) {
    console.log(JSON.stringify({ result: 'skipped-awaiting-human-review-or-reconciliation',
      geminiCalls: 0 }));
    return;
  }
  // The claim inserts a one-use D1 attempt ledger row BEFORE any paid API call.
  const claim = await worker('claim', creds.headers, {
    method: 'POST', json: { confirm: 'CLAIM_LISTENING_TTS_ONCE' },
  });
  if (claim.result !== 'claimed') {
    console.log(JSON.stringify({ result: 'no-claim', reason: claim.result, geminiCalls: 0 }));
    return;
  }
  if (claim.day !== day || pacificDay() !== day)
    throw Error('Quota day changed after D1 claim. STOP; claim remains consumed.');
  if (![LITE, FLASH].includes(claim.model) || typeof claim.stimulusId !== 'string')
    throw Error('Invalid claimed model/stimulus. STOP; claim remains consumed.');
  const set = ListeningSetSchema.parse(claim.draft);
  if (set.id !== claim.setId) throw Error('Claim set ID mismatch');
  const clip = buildRenderPlan(set).find(x => x.stimulusId === claim.stimulusId);
  if (!clip) throw Error('Claim stimulus absent from canonical render plan');
  const long = clip.role === 'conversation' || clip.role === 'academic-talk';
  if (long && claim.model !== FLASH) throw Error('Long clip must use Flash TTS');
  if (pacificDay() !== day) throw Error('Date changed before Gemini; no spend');
  if (!process.env.GEMINI_API_KEY) throw Error('Missing model key; claim consumed');
  console.log(JSON.stringify({ phase: 'one-explicit-cloud-tts-call', setId: set.id,
    stimulusId: clip.stimulusId, role: clip.role, model: claim.model,
    quotaDay: day, autoRetry: false }));
  // EXACTLY ONE Gemini invocation; no retry or fallback on any status/error.
  const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' +
      claim.model + ':generateContent', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': creds.key },
    body: JSON.stringify(ttsPayload(clip)),
  });
  if (!response.ok) throw Error('Gemini TTS HTTP ' + response.status +
    '; no retry, retained D1 claim');
  const output = await response.json();
  const encoded = output.candidates?.[0]?.content?.parts?.find(p => p.inlineData?.data)?.inlineData?.data;
  if (!encoded || typeof encoded !== 'string') throw Error('No TTS WAV returned');
  const wav = Buffer.from(encoded, 'base64');
  if (wav.length < 1000 || wav.toString('ascii', 0, 4) !== 'RIFF' ||
      wav.toString('ascii', 8, 12) !== 'WAVE') throw Error('Gemini did not return WAV');
  inspectWav(wav, clip);
  const { bytes, duration } = transcode(wav);
  if (pacificDay() !== day) throw Error('Date changed; MP3 not staged; manual reconciliation');
  const path = 'stage-upload?setId=' + encodeURIComponent(set.id) +
    '&stimulusId=' + encodeURIComponent(clip.stimulusId);
  const staged = await worker(path, creds.headers, {
    method: 'POST', bytes,
    headers: { 'x-listening-model': claim.model, 'x-audio-duration-seconds': String(duration) },
  });
  if (staged.result !== 'staged-for-review') throw Error('Cloud staging unverified; inspect manually');
  console.log(JSON.stringify({ result: 'one-clip-staged-for-human-review',
    stimulusId: clip.stimulusId, bytes: bytes.length, durationSec: duration,
    geminiCalls: 1, published: false, finalAudioImported: false }));
}
if (args.length === 1 && args[0] === '--self-test') runSelfTest();
else if (args.length === 1 && args[0] === '--dry-run')
  console.log(JSON.stringify({ result: 'dry-run', geminiCalls: 0,
    workerWrites: 0, r2Uploads: 0, published: false }));
else if (args.length === 1 && args[0] === '--once')
  await runOnce().catch(e => { console.error('STOP (no retries): ' +
    (e instanceof Error ? e.message : 'unknown error')); process.exitCode = 1; });
else { console.error('Usage: --self-test | --dry-run | --once'); process.exitCode = 2; }
