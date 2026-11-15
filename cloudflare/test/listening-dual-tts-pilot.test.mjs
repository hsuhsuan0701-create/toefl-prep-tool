import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";

/**
 * No API key, no --execute, no network, no D1/R2:
 * only verify the original Listening render planner can prepare BOTH
 * Free Tier model-specific trial roles before a human ever spends quota.
 */
const cases=[
 {model:"gemini-3.8-flash-lite-tts",role:"announcement",speakers:1},
 {model:"gemini-3.8-flash-tts",role:"conversation",speakers:2},
];
for(const {model,role,speakers} of cases){
 test(`safe offline TTS audition preflight: ${model} / ${role}`,()=>{
  const result=spawnSync(process.execPath,[
   "--import","tsx","scripts/pilot-gemini38-tts.mjs",
   "--set","lsn-03948a55","--role",role,"--model",model,
  ],{
   cwd:new URL("../../",import.meta.url),encoding:"utf8",timeout:30000,
   env:{...process.env,GEMINI_API_KEY:""},
  });
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/"phase": "dry-run \(no API calls\)"/);
  assert.match(result.stdout,/"model": "/);
  assert.match(result.stdout,new RegExp(model));
  assert.match(result.stdout,new RegExp(`"speakerCount": ${speakers}`));
  assert.match(result.stdout,/Nothing was generated, charged, uploaded or published/);
 });
}
