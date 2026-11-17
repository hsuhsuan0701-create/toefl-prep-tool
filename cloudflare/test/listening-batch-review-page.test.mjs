import test from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { listeningRefillPage } from '../src/listeningRefillPage.ts';

test('consolidated private management page has valid browser JavaScript', async () => {
  const response = listeningRefillPage();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const html = await response.text();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1, 'one in-page script; no remote script loads');
  assert.doesNotThrow(() => new Script(scripts[0][1]), 'all UI event handlers must parse');
  assert.match(html, /id="review-queue"/);
  assert.match(html, /id="review-load"/);
  assert.match(html, /id="token"/);
  assert.match(html, /I_LISTENED_AND_APPROVED_AUDIO/);
  assert.match(html, /REJECT_BAD_AUDIO/);
  assert.match(html, /staged-audio/);
  assert.match(html, /URL\.revokeObjectURL/);
  assert.doesNotMatch(html, /localStorage|sessionStorage/);
  assert.doesNotMatch(html, /document\.cookie/);
});

test('review still authenticates each API call using the existing token input', async () => {
  const html = await listeningRefillPage().text();
  assert.match(html, /const token=\$\("token"\)\.value\.trim\(\)/);
  assert.match(html, /Authorization:"Bearer "\+token/);
  assert.match(html, /credentials:"same-origin"/);
  assert.match(html, /stage-decision/);
  assert.match(html, /loadReview\(\)/);
});
