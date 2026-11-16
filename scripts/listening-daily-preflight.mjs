#!/usr/bin/env node
/**
 * Read-only, fail-closed GitHub Actions preflight for private TOEFL Listening.
 * There is NO Gemini API call, D1 write, R2 upload, or publication in this file.
 */
import { appendFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const ORIGIN = 'https://toefl-prep-private.ihsuan0701.workers.dev';
const STATUS_PATH = '/api/cloud/listening-refill/status';
const ALLOWED_MODELS = new Set(['gemini-3.8-flash-lite-tts', 'gemini-3.8-flash-tts']);
const integerInRange = (v, max = 100000) => Number.isInteger(v) && v >= 0 && v <= max;

export function summarizeStatus(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw Error('Invalid status payload');
  if (typeof data.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(data.day)) throw Error('Invalid Pacific day');
  if (typeof data.enabled !== 'boolean' || typeof data.r2Configured !== 'boolean')
    throw Error('Missing server safety switches');
  if (!Array.isArray(data.models) || data.models.length !== 2 ||
      new Set(data.models.map(m => m?.model)).size !== 2) throw Error('Incomplete TTS model states');
  const models = data.models.map(m => {
    if (!ALLOWED_MODELS.has(m.model) || !integerInRange(m.claimed) ||
        !integerInRange(m.dailyLimit, 10) || typeof m.freeTierVerifiedToday !== 'boolean')
      throw Error('Invalid TTS model safety state');
    return { model: m.model, claimed: m.claimed, dailyLimit: m.dailyLimit,
      verifiedToday: m.freeTierVerifiedToday,
      remaining: Math.max(0, m.dailyLimit - m.claimed) };
  });
  const queue = Array.isArray(data.queue) ? data.queue : [];
  const drafts = queue.map(d => {
    if (typeof d?.id !== 'string' || !/^lsn-[A-Za-z0-9_-]{1,60}$/.test(d.id) ||
        typeof d.state !== 'string' || !d.clips || typeof d.clips !== 'object')
      throw Error('Invalid draft summary');
    const counts = {};
    for (const [key, value] of Object.entries(d.clips)) {
      if (!/^[a-z_]{1,30}$/.test(key) || !integerInRange(value)) throw Error('Invalid clip count');
      counts[key] = value;
    }
    return { id: d.id, state: d.state.slice(0, 40), clips: counts };
  });
  return {
    day: data.day, enabled: data.enabled, r2Configured: data.r2Configured,
    models, queue: drafts,
    backendEligible: data.enabled && data.r2Configured &&
      models.some(m => m.verifiedToday && m.remaining > 0),
    operation: 'read-only-check', geminiCalls: 0, databaseWrites: 0,
    r2Writes: 0, published: false,
  };
}

function test() {
  const sample = {
    day: '2026-11-16', enabled: false, r2Configured: true,
    models: [
      { model: 'gemini-3.8-flash-lite-tts', claimed: 0, dailyLimit: 0, freeTierVerifiedToday: false },
      { model: 'gemini-3.8-flash-tts', claimed: 0, dailyLimit: 0, freeTierVerifiedToday: false },
    ], queue: [{ id: 'lsn-a97620b2c800', state: 'draft', clips: { uploaded: 8, pending: 28 } }],
  };
  const result = summarizeStatus(sample);
  assert.equal(result.geminiCalls, 0);
  assert.equal(result.databaseWrites, 0);
  assert.equal(result.backendEligible, false);
  assert.equal(result.queue[0].clips.uploaded, 8);
  assert.throws(() => summarizeStatus({ ...sample, day: 'invalid' }));
  assert.throws(() => summarizeStatus({ ...sample, models: [] }));
  assert.throws(() => summarizeStatus({ ...sample, models: [
    { ...sample.models[0], dailyLimit: 11 }, sample.models[1],
  ] }));
  console.log(JSON.stringify({ result: 'self-test-passed', networkCalls: 0,
    geminiCalls: 0, databaseWrites: 0 }));
}

function githubSummary(data) {
  const p = process.env.GITHUB_STEP_SUMMARY;
  if (!p) return;
  const lines = [
    '## Listening daily preflight', '',
    '- Pacific quota day: ' + data.day,
    '- Listening queue enabled: ' + data.enabled,
    '- Private R2 connected: ' + data.r2Configured,
    '- Backend eligibility: ' + data.backendEligible,
    '- **No Gemini calls; no uploads; no database writes; no publication.**',
    '', '| Model | Verified today | Used | Limit |', '|---|---|---:|---:|',
    ...data.models.map(m => '| ' + m.model + ' | ' + m.verifiedToday +
      ' | ' + m.claimed + ' | ' + m.dailyLimit + ' |'),
    '', 'This workflow does not synthesize audio. TTS runner requires separate review.', '',
  ];
  appendFileSync(p, lines.join('\n'), 'utf8');
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') return test();
  if (args.length === 1 && args[0] === '--dry-run') {
    console.log(JSON.stringify({ result: 'read-only-dry-run', networkCalls: 0,
      geminiCalls: 0, databaseWrites: 0, r2Writes: 0, published: false }));
    return;
  }
  if (args.length !== 1 || args[0] !== '--check') throw Error('Only --self-test, --dry-run, --check');
  const token = process.env.TOEFL_MANUAL_TEST_TOKEN || '';
  const accessId = process.env.CF_ACCESS_CLIENT_ID || '';
  const accessSecret = process.env.CF_ACCESS_CLIENT_SECRET || '';
  if (token.length < 32 || !accessId || !accessSecret) {
    console.log(JSON.stringify({ result: 'skipped-missing-credentials',
      networkCalls: 0, geminiCalls: 0, databaseWrites: 0,
      note: 'Add three GitHub Actions secrets for a READ-ONLY check.' }));
    return;
  }
  // Deliberately exactly one private GET. No POST, no automatic retry.
  const response = await fetch(ORIGIN + STATUS_PATH, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(12000),
    headers: {
      Accept: 'application/json', 'Cache-Control': 'no-store',
      Authorization: 'Bearer ' + token,
      'CF-Access-Client-Id': accessId,
      'CF-Access-Client-Secret': accessSecret,
    },
  });
  if (!response.ok) throw Error('Private read-only check failed: HTTP ' + response.status);
  const report = summarizeStatus(await response.json());
  githubSummary(report);
  console.log(JSON.stringify({ result: 'daily-read-only-preflight', ...report }));
}
main().catch(err => {
  console.error('STOP (never retry): ' + (err instanceof Error ? err.message : 'unknown error'));
  process.exitCode = 1;
});
