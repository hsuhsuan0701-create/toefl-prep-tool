import test from 'node:test';
import assert from 'node:assert/strict';
import { handleReviewedAudioImport } from '../src/listeningReviewedImport.ts';

const host='https://private.example';
const token='x'.repeat(48);

test('previously deployed reviewed-MP3 import endpoint remains independently protected', async () => {
  const env={TOEFL_MANUAL_TEST_TOKEN:token,LISTENING_AUDIO:{head:async()=>null}};
  const unauthorized=await handleReviewedAudioImport(
    new Request(host+'/api/cloud/listening-refill/import-reviewed?setId=lsn-a97620b2c800&stimulusId=pilot-r0-lc7'),env);
  assert.equal(unauthorized.status,401);
  const wrongTarget=await handleReviewedAudioImport(new Request(
    host+'/api/cloud/listening-refill/import-reviewed?setId=lsn-incorrect&stimulusId=pilot-r0-lc7',
    {headers:{Authorization:'Bearer '+token}}),env);
  assert.equal(wrongTarget.status,400);
  const wrongMethod=await handleReviewedAudioImport(new Request(
    host+'/api/cloud/listening-refill/import-reviewed?setId=lsn-a97620b2c800&stimulusId=pilot-r0-lc7',
    {method:'DELETE',headers:{Authorization:'Bearer '+token}}),env);
  assert.equal(wrongMethod.status,405);
  const otherRoute=await handleReviewedAudioImport(new Request(
    host+'/api/cloud/listening-refill/staged'),env);
  assert.equal(otherRoute,null,'new staging routes remain separate');
});

test('reviewed endpoint refuses missing R2; no claim, audio synthesis or write',async()=>{
  const env={TOEFL_MANUAL_TEST_TOKEN:token,DB:{prepare(){throw Error('must not read DB')} }};
  const r=await handleReviewedAudioImport(new Request(
    host+'/api/cloud/listening-refill/import-reviewed?setId=lsn-a97620b2c800&stimulusId=pilot-r0-lc7',
    {headers:{Authorization:'Bearer '+token}}),env);
  assert.equal(r.status,503);
  assert.equal((await r.json()).error,'Private R2 binding not configured');
});
